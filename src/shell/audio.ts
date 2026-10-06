/**
 * 音效（SPEC 8.4）：用 Web Audio 即時合成的方波與雜訊，不放音檔。
 *
 * - SPEC 8.4 原文：「預設靜音，要玩家按過一次鍵才啟動」。字面解讀：「靜音」是第一次互動之前（瀏覽器不准沒互動
 *   就發聲，所以一個節點都不建立）；「按過一次鍵才啟動」是第一次按鍵、點擊或觸控之後音效就是開的。
 *   所以開關（`isEnabled()`）預設是 true，標題選單的開關讓玩家關掉；開關存在 `progress.settings.sound`，由外殼讀寫。
 * - 瀏覽器要求使用者互動過才能啟動 `AudioContext`：外殼在第一次按鍵、點擊、觸控時呼叫 `unlock()`，
 *   那時才建立 context 並 `resume()`。在這之前，不管開關是什麼，都不建立任何節點。
 * - 可測：`AudioContext` 是注入的依賴（`createContext`），測試用假的記錄節點。
 * - 不載入任何音檔：沒有解碼任何檔案、沒有 HTML 的音訊元素、沒有網路請求。雜訊是程式填的白雜訊緩衝。
 * - 節點用完就清：每個音符一個 `OscillatorNode`（或 `AudioBufferSourceNode`）加一個 `GainNode`，
 *   排好 `start`／`stop`，`ended` 時拆掉；同時發聲的音符有上限（`MAX_VOICES`），狂按也不會堆積。
 *
 * 這個檔案在 `src/shell/`，不受模擬層純度掃描限制（需要 `globalThis.AudioContext`）。
 */

export type SoundName =
  'menuMove' | 'menuConfirm' | 'matchStart' | 'score' | 'hit' | 'win' | 'lose' | 'draw' | 'evolve';

export const SOUND_NAMES: readonly SoundName[] = [
  'menuMove',
  'menuConfirm',
  'matchStart',
  'score',
  'hit',
  'win',
  'lose',
  'draw',
  'evolve',
];

/** 一個音符：方波（可以從 `freq` 滑到 `freqEnd`）或白雜訊。`at`、`dur` 單位是秒。 */
export interface Note {
  readonly wave: 'square' | 'noise';
  /** 方波的起始頻率（Hz）；雜訊忽略。 */
  readonly freq: number;
  /** 方波的結束頻率；省略就是不滑音。 */
  readonly freqEnd?: number;
  /** 從音效開始算起幾秒後開始。 */
  readonly at: number;
  readonly dur: number;
  /** 音量（0 到 1，乘上總音量）。 */
  readonly gain: number;
}

const sq = (freq: number, at: number, dur: number, gain = 0.5, freqEnd?: number): Note =>
  freqEnd === undefined
    ? { wave: 'square', freq, at, dur, gain }
    : { wave: 'square', freq, freqEnd, at, dur, gain };
const noise = (at: number, dur: number, gain = 0.5): Note => ({
  wave: 'noise',
  freq: 0,
  at,
  dur,
  gain,
});

/**
 * 九種音效。音高是 C 大調附近的整數頻率，長度都在 0.5 秒以內（結束、進化稍長），像 8 位元街機。
 *
 * - menuMove：880 Hz 方波 40 毫秒（短促的「嗒」）
 * - menuConfirm：660 Hz 50 毫秒 → 990 Hz 80 毫秒（上揚兩音）
 * - matchStart：523、659、784 Hz 各 70 毫秒，再一個 1047 Hz 200 毫秒（倒數後的「開始」）
 * - score：988 Hz 60 毫秒 → 1319 Hz 150 毫秒（吃到金幣的聲音）
 * - hit：120 毫秒白雜訊，疊一個從 220 Hz 滑到 110 Hz 的方波 150 毫秒（被打中的悶響）
 * - win：523、659、784 Hz 各 100 毫秒，再 1047 Hz 300 毫秒（上行琶音）
 * - lose：392、330、262 Hz 各 120 毫秒，再從 196 Hz 滑到 98 Hz 的方波 350 毫秒（下行、拖長）
 * - draw：440 Hz 兩個 120 毫秒的音，中間隔 60 毫秒（平平的「噠噠」）
 * - evolve：262、330、392、523、659、784、1047 Hz 各 70 毫秒的上行琶音，最後 1319 Hz 250 毫秒
 */
export const SOUNDS: Readonly<Record<SoundName, readonly Note[]>> = {
  menuMove: [sq(880, 0, 0.04, 0.4)],
  menuConfirm: [sq(660, 0, 0.05), sq(990, 0.05, 0.08)],
  matchStart: [sq(523, 0, 0.07), sq(659, 0.08, 0.07), sq(784, 0.16, 0.07), sq(1047, 0.24, 0.2)],
  score: [sq(988, 0, 0.06), sq(1319, 0.06, 0.15)],
  hit: [noise(0, 0.12, 0.7), sq(220, 0, 0.15, 0.5, 110)],
  win: [sq(523, 0, 0.1), sq(659, 0.11, 0.1), sq(784, 0.22, 0.1), sq(1047, 0.33, 0.3)],
  lose: [sq(392, 0, 0.12), sq(330, 0.13, 0.12), sq(262, 0.26, 0.12), sq(196, 0.39, 0.35, 0.5, 98)],
  draw: [sq(440, 0, 0.12), sq(440, 0.18, 0.12)],
  evolve: [
    sq(262, 0, 0.07),
    sq(330, 0.08, 0.07),
    sq(392, 0.16, 0.07),
    sq(523, 0.24, 0.07),
    sq(659, 0.32, 0.07),
    sq(784, 0.4, 0.07),
    sq(1047, 0.48, 0.07),
    sq(1319, 0.56, 0.25),
  ],
};

/** 同時發聲的音符上限（超過就丟掉新的那個音效）。 */
export const MAX_VOICES = 24;
/** 總音量（方波很刺耳，壓低）。 */
const MASTER_GAIN = 0.12;
/** 排程領先現在多久（秒），避免剛建立的節點被排到過去。 */
const LEAD = 0.005;
const NOISE_SECONDS = 0.25;

// ---- 注入用的最小形狀（真正的 AudioContext 滿足它；測試用假的） ----

export interface ParamLike {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}

export interface NodeLike {
  connect(destination: NodeLike): unknown;
  disconnect(): unknown;
}

export interface SourceLike extends NodeLike {
  onended: (() => void) | null;
  start(when: number): void;
  stop(when: number): void;
}

export interface OscillatorLike extends SourceLike {
  type: OscillatorType;
  readonly frequency: ParamLike;
}

export interface BufferSourceLike extends SourceLike {
  buffer: unknown;
  loop: boolean;
}

export interface GainLike extends NodeLike {
  readonly gain: ParamLike;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: NodeLike;
  resume(): Promise<void>;
  createOscillator(): OscillatorLike;
  createBufferSource(): BufferSourceLike;
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): { getChannelData(channel: number): Float32Array };
  createGain(): GainLike;
}

export interface AudioDeps {
  /** 建立 AudioContext；瀏覽器不支援就回傳 null。只會在第一次 `unlock()` 時呼叫。 */
  createContext(): AudioContextLike | null;
}

export interface Audio {
  /** 玩家互動過了（按鍵、點擊、觸控）：建立 AudioContext 並 resume。可以重複呼叫。 */
  unlock(): void;
  isUnlocked(): boolean;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  /** 播一個音效。靜音、沒互動過、不支援時什麼都不做。 */
  play(name: SoundName): void;
  /** 還沒播完的音符數（測試用）。 */
  activeVoices(): number;
}

export function createAudio(deps: AudioDeps): Audio {
  let enabled = true;
  let unlocked = false;
  let ctx: AudioContextLike | null = null;
  let master: GainLike | null = null;
  let noiseBuffer: unknown = null;
  let active = 0;

  const makeNoise = (context: AudioContextLike): unknown => {
    const length = Math.max(1, Math.floor(context.sampleRate * NOISE_SECONDS));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    // 固定種子的線性同餘亂數：白雜訊不需要真的隨機，這樣每次聽起來一樣。
    let seed = 12345;
    for (let i = 0; i < length; i += 1) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      data[i] = seed / 0x80000000 - 1;
    }
    return buffer;
  };

  const playNote = (context: AudioContextLike, out: NodeLike, note: Note, base: number): void => {
    const start = base + note.at;
    const end = start + note.dur;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(note.gain, start);
    envelope.gain.linearRampToValueAtTime(0, end);
    envelope.connect(out);

    let source: SourceLike;
    if (note.wave === 'square') {
      const osc = context.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(note.freq, start);
      if (note.freqEnd !== undefined) {
        osc.frequency.linearRampToValueAtTime(note.freqEnd, end);
      }
      source = osc;
    } else {
      noiseBuffer ??= makeNoise(context);
      const noiseSource = context.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      noiseSource.loop = false;
      source = noiseSource;
    }
    source.connect(envelope);
    active += 1;
    source.onended = (): void => {
      source.onended = null;
      source.disconnect();
      envelope.disconnect();
      active = Math.max(0, active - 1);
    };
    source.start(start);
    source.stop(end);
  };

  return {
    unlock(): void {
      if (unlocked) {
        return;
      }
      try {
        ctx = deps.createContext();
      } catch {
        ctx = null;
      }
      unlocked = true;
      if (ctx !== null && ctx.state !== 'running') {
        try {
          ctx.resume().catch(() => undefined);
        } catch {
          // 忽略：還是靜音。
        }
      }
    },
    isUnlocked: () => unlocked,
    setEnabled(next: boolean): void {
      enabled = next;
    },
    isEnabled: () => enabled,
    play(name: SoundName): void {
      if (!enabled || !unlocked || ctx === null) {
        return;
      }
      const notes = SOUNDS[name];
      if (active + notes.length > MAX_VOICES) {
        return;
      }
      try {
        if (master === null) {
          master = ctx.createGain();
          master.gain.setValueAtTime(MASTER_GAIN, ctx.currentTime);
          master.connect(ctx.destination);
        }
        const base = ctx.currentTime + LEAD;
        for (const note of notes) {
          playNote(ctx, master, note, base);
        }
      } catch {
        // 音效壞了不該讓遊戲當掉。
      }
    },
    activeVoices: () => active,
  };
}

interface WindowWithWebkitAudio {
  AudioContext?: new () => unknown;
  webkitAudioContext?: new () => unknown;
}

/** 瀏覽器用的實例：讀 `globalThis.AudioContext`（舊 Safari 是 `webkitAudioContext`）。 */
export function createBrowserAudio(): Audio {
  return createAudio({
    createContext(): AudioContextLike | null {
      const scope = globalThis as unknown as WindowWithWebkitAudio;
      const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
      return Ctor === undefined ? null : (new Ctor() as AudioContextLike);
    },
  });
}
