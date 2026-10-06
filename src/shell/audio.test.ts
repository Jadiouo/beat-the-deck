import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_VOICES, SOUNDS, SOUND_NAMES, createAudio } from './audio';
import type { AudioContextLike } from './audio';

/** 假的 Web Audio：記錄建立了哪些節點、型別、頻率、什麼時候開始與停止、有沒有接上輸出。 */
class FakeParam {
  value = 0;
  readonly calls: Array<{ kind: string; value: number; time: number }> = [];
  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.calls.push({ kind: 'set', value, time });
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push({ kind: 'linear', value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.calls.push({ kind: 'exp', value, time });
  }
}

class FakeNode {
  connected = true;
  connect(): void {
    this.connected = true;
  }
  disconnect(): void {
    this.connected = false;
  }
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam();
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  start(time: number): void {
    this.startedAt = time;
  }
  stop(time: number): void {
    this.stoppedAt = time;
  }
}

class FakeBufferSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  start(time: number): void {
    this.startedAt = time;
  }
  stop(time: number): void {
    this.stoppedAt = time;
  }
}

class FakeBuffer {
  readonly data: Float32Array;
  constructor(length: number) {
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeContext {
  currentTime = 0;
  sampleRate = 8000;
  state: 'suspended' | 'running' = 'suspended';
  resumeCalls = 0;
  readonly destination = new FakeNode();
  readonly oscillators: FakeOscillator[] = [];
  readonly sources: FakeBufferSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly buffers: FakeBuffer[] = [];
  decodeCalls = 0;
  rejectResume = false;

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.rejectResume) {
      return Promise.reject(new Error('blocked'));
    }
    this.state = 'running';
    return Promise.resolve();
  }
  decodeAudioData(): Promise<never> {
    this.decodeCalls += 1;
    return Promise.reject(new Error('不該載入音檔'));
  }
  createOscillator(): FakeOscillator {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }
  createBufferSource(): FakeBufferSource {
    const node = new FakeBufferSource();
    this.sources.push(node);
    return node;
  }
  createBuffer(_channels: number, length: number): FakeBuffer {
    const buffer = new FakeBuffer(length);
    this.buffers.push(buffer);
    return buffer;
  }
  createGain(): FakeGain {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
  nodeCount(): number {
    return this.oscillators.length + this.sources.length + this.gains.length;
  }
}

function setup(): {
  ctx: FakeContext;
  create: ReturnType<typeof vi.fn>;
  audio: ReturnType<typeof createAudio>;
} {
  const ctx = new FakeContext();
  const create = vi.fn(() => ctx as unknown as AudioContextLike);
  return { ctx, create, audio: createAudio({ createContext: create }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shell/audio：預設靜音，要玩家互動過才啟動（SPEC 8.4）', () => {
  it('預設是靜音：什麼都播不出來，連 AudioContext 都不建立', () => {
    const { ctx, create, audio } = setup();
    expect(audio.isEnabled()).toBe(false);
    for (const name of SOUND_NAMES) {
      audio.play(name);
    }
    expect(create).not.toHaveBeenCalled();
    expect(ctx.nodeCount()).toBe(0);
  });

  it('開關打開了但玩家還沒互動過：仍然不發聲，不建立 AudioContext', () => {
    const { ctx, create, audio } = setup();
    audio.setEnabled(true);
    audio.play('menuMove');
    expect(create).not.toHaveBeenCalled();
    expect(ctx.nodeCount()).toBe(0);
  });

  it('第一次互動（unlock）才建立 AudioContext 並 resume 一次；之後重複互動不再 resume', () => {
    const { ctx, create, audio } = setup();
    audio.unlock();
    expect(create).toHaveBeenCalledTimes(1);
    expect(ctx.resumeCalls).toBe(1);
    audio.unlock();
    audio.unlock();
    expect(create).toHaveBeenCalledTimes(1);
    expect(ctx.resumeCalls).toBe(1);
  });

  it('互動過但開關是關的：不發聲（連 unlock 之後也一樣）', () => {
    const { ctx, audio } = setup();
    audio.unlock();
    audio.play('score');
    expect(ctx.nodeCount()).toBe(0);
  });

  it('互動過、開關打開：發聲；再關掉：又安靜', () => {
    const { ctx, audio } = setup();
    audio.unlock();
    audio.setEnabled(true);
    audio.play('menuConfirm');
    const after = ctx.nodeCount();
    expect(after).toBeGreaterThan(0);
    audio.setEnabled(false);
    audio.play('menuConfirm');
    expect(ctx.nodeCount()).toBe(after);
  });

  it('瀏覽器不支援 Web Audio（createContext 回傳 null）或 resume 被拒絕：不丟錯，保持靜音', async () => {
    const none = createAudio({ createContext: () => null });
    none.setEnabled(true);
    expect(() => {
      none.unlock();
      none.play('win');
    }).not.toThrow();

    const { ctx, audio } = setup();
    ctx.rejectResume = true;
    audio.setEnabled(true);
    expect(() => {
      audio.unlock();
      audio.play('win');
    }).not.toThrow();
    await Promise.resolve();
  });
});

describe('shell/audio：音效的內容', () => {
  it('至少 6 種，涵蓋選單移動、確認、對局開始、得分、被扣分、結束（贏／輸／平手）、AI 進化', () => {
    expect(SOUND_NAMES.length).toBeGreaterThanOrEqual(6);
    for (const name of [
      'menuMove',
      'menuConfirm',
      'matchStart',
      'score',
      'hit',
      'win',
      'lose',
      'draw',
      'evolve',
    ]) {
      expect(SOUND_NAMES).toContain(name);
    }
  });

  it.each(SOUND_NAMES)('%s：只用方波或雜訊，有頻率、有開始與停止、很短', (name) => {
    const { ctx, audio } = setup();
    audio.unlock();
    audio.setEnabled(true);
    audio.play(name);

    expect(ctx.oscillators.length + ctx.sources.length).toBeGreaterThan(0);
    for (const osc of ctx.oscillators) {
      expect(osc.type).toBe('square');
      const frequencies = osc.frequency.calls.map((call) => call.value);
      expect(frequencies.length).toBeGreaterThan(0);
      for (const hz of frequencies) {
        expect(hz).toBeGreaterThanOrEqual(30);
        expect(hz).toBeLessThanOrEqual(8000);
      }
      expect(osc.startedAt).not.toBeNull();
      expect(osc.stoppedAt).not.toBeNull();
      expect((osc.stoppedAt as number) - (osc.startedAt as number)).toBeGreaterThan(0);
      expect((osc.stoppedAt as number) - (osc.startedAt as number)).toBeLessThanOrEqual(1);
    }
    for (const source of ctx.sources) {
      expect(source.buffer).not.toBeNull();
      expect(source.startedAt).not.toBeNull();
      expect(source.stoppedAt).not.toBeNull();
      expect((source.stoppedAt as number) - (source.startedAt as number)).toBeLessThanOrEqual(1);
    }
    // 整個音效不超過 1.5 秒。
    const ends = [...ctx.oscillators, ...ctx.sources].map((node) => node.stoppedAt as number);
    expect(Math.max(...ends)).toBeLessThanOrEqual(1.5);
  });

  it('各種音效的資料表：每一種都至少有一個音符，種類只有方波與雜訊', () => {
    for (const name of SOUND_NAMES) {
      const notes = SOUNDS[name];
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) {
        expect(['square', 'noise']).toContain(note.wave);
      }
    }
  });

  it('至少有一種用到雜訊，雜訊是真的白雜訊（不是常數）', () => {
    const { ctx, audio } = setup();
    audio.unlock();
    audio.setEnabled(true);
    audio.play('hit');
    expect(ctx.sources.length).toBeGreaterThan(0);
    const data = ctx.buffers[0]?.data as Float32Array;
    expect(new Set(data).size).toBeGreaterThan(100);
    for (const value of data) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('沒有任何地方載入音檔：不呼叫 decodeAudioData、不建立 Audio 元素、不 fetch', () => {
    const audioElement = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal('Audio', audioElement);
    vi.stubGlobal('fetch', fetchSpy);
    const { ctx, audio } = setup();
    audio.unlock();
    audio.setEnabled(true);
    for (const name of SOUND_NAMES) {
      audio.play(name);
    }
    expect(ctx.decodeCalls).toBe(0);
    expect(audioElement).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('原始碼裡沒有音檔：沒有 decodeAudioData、new Audio(、fetch(、音檔副檔名', () => {
    const source = readFileSync(new URL('./audio.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/decodeAudioData|new Audio\(|fetch\(|XMLHttpRequest/);
    expect(source).not.toMatch(/\.(mp3|wav|ogg|m4a|flac|aac)\b/i);
  });
});

describe('shell/audio：節點會清理，不洩漏', () => {
  it('同一個事件連發兩次：每個節點都有 start 與 stop，播完（ended）之後全部拆掉', () => {
    const { ctx, audio } = setup();
    audio.unlock();
    audio.setEnabled(true);
    audio.play('score');
    audio.play('score');
    expect(audio.activeVoices()).toBeGreaterThan(0);

    for (const node of [...ctx.oscillators, ...ctx.sources]) {
      expect(node.startedAt).not.toBeNull();
      expect(node.stoppedAt).not.toBeNull();
      node.onended?.();
    }
    expect(audio.activeVoices()).toBe(0);
    // 第一個 GainNode 是總音量，一直留著；其餘每個音符的包絡都要拆掉。
    for (const node of [...ctx.oscillators, ...ctx.sources, ...ctx.gains.slice(1)]) {
      expect(node.connected).toBe(false);
    }
  });

  it('狂按（同一幀 200 次）也不爆：同時發聲的節點有上限', () => {
    const { ctx, audio } = setup();
    audio.unlock();
    audio.setEnabled(true);
    for (let i = 0; i < 200; i += 1) {
      audio.play('menuMove');
    }
    expect(audio.activeVoices()).toBeLessThanOrEqual(MAX_VOICES);
    expect(ctx.oscillators.length + ctx.sources.length).toBeLessThanOrEqual(MAX_VOICES);
  });

  it('播完之後可以再播（上限不會卡死）', () => {
    const { ctx, audio } = setup();
    audio.unlock();
    audio.setEnabled(true);
    for (let i = 0; i < 200; i += 1) {
      audio.play('menuMove');
    }
    for (const node of [...ctx.oscillators, ...ctx.sources]) {
      node.onended?.();
    }
    expect(audio.activeVoices()).toBe(0);
    const before = ctx.oscillators.length;
    audio.play('menuMove');
    expect(ctx.oscillators.length).toBeGreaterThan(before);
  });
});
