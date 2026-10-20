import { describe, expect, it } from 'vitest';

import { defineEntry } from '../../src/games/types';
import { counterEntry, counterMeta } from '../fixtures/counter-entry';
import { counterGame } from '../fixtures/counter-game';
import type { CounterState } from '../fixtures/counter-game';
import {
  AI_CHECKS,
  AI_CHUNKS,
  AI_SEEDS,
  CHECKS,
  CONTRACT_SEEDS,
  ContractViolation,
  K4_CHUNKS,
  aiChunkPoints,
  judgeAiPoints,
  measureA1,
  measureA2,
  measureA3,
  measureA4,
  runCheck,
  splitSeeds,
} from '../contract/checks';

/**
 * A1–A4 與 K4 分段（為什麼要有它）：CI 的硬體約比本機慢 3 倍，C-8 的 A4（100 場，本機約 45 秒）
 * 在 CI 要 134 秒，超過單一測試案例的 120 秒；D-7 的 K4（20 個種子，本機約 50 秒）在 CI 要 61 秒，
 * 超過 60 秒。做法同 K12 的 `SYMMETRY_CHUNKS`：種子切成幾段、每段各自一個測試案例，
 * 最後一個案例把各段加總、用同一個判準判一次。種子數與門檻都沒動。
 * 這裡證明：切法不漏不重，加總之後和一次跑完得到同樣的數字與同樣的錯誤訊息。
 */

const greedyEntry = defineEntry<CounterState>({
  id: counterEntry.id,
  kind: 'fixture',
  game: counterGame,
  render: counterEntry.render as (ctx: CanvasRenderingContext2D, state: CounterState) => void,
  meta: { ...counterMeta, defaultPolicy: 'greedy' },
});

describe('splitSeeds', () => {
  it('連續、不漏不重，段長相差不超過 1（除不盡也一樣）', () => {
    for (const [n, count] of [[100, 4], [20, 4], [10, 3], [7, 4], [3, 5]] as const) {
      const seeds = Array.from({ length: n }, (_, i) => i);
      const parts = splitSeeds(seeds, count);
      expect(parts.flat()).toEqual(seeds);
      const sizes = parts.map((p) => p.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });
});

describe('A1–A4 分段', () => {
  it('各段合起來恰好是 AI_SEEDS，不漏不重，而且不只一段', () => {
    expect(AI_CHUNKS.flat()).toEqual([...AI_SEEDS]);
    expect(AI_CHUNKS.length).toBeGreaterThan(1);
  });

  it('單一案例的場數至多是全部的一半（才不會再跨過 120 秒）', () => {
    for (const chunk of AI_CHUNKS) {
      expect(chunk.length * 2).toBeLessThanOrEqual(AI_SEEDS.length);
    }
  });

  it('各段得分加總 ÷ 場數 ＝ 一次跑完的勝率（逐位元相同）', () => {
    const measures = { A1: measureA1, A2: measureA2, A3: measureA3, A4: measureA4 } as const;
    for (const code of ['A1', 'A2', 'A3', 'A4'] as const) {
      const parts = AI_CHUNKS.map((chunk) => aiChunkPoints(code, greedyEntry, chunk));
      const points = parts.reduce((sum, p) => sum + p, 0);
      expect(points / AI_SEEDS.length, code).toBe(measures[code](greedyEntry));
    }
  });

  it('judgeAiPoints：門檻邊界與原本相同，超出就丟帶編號、場數、勝率的 ContractViolation', () => {
    expect(() => judgeAiPoints('A1', greedyEntry, 75, 100)).not.toThrow();
    expect(() => judgeAiPoints('A1', greedyEntry, 74.5, 100)).toThrow(
      /\[A1\] 100 場，勝率 74\.5%，至少要 75\.0%（等級 5 對 random）/,
    );
    expect(() => judgeAiPoints('A2', greedyEntry, 60, 100)).not.toThrow();
    expect(() => judgeAiPoints('A2', greedyEntry, 59, 100)).toThrow(ContractViolation);
    expect(() => judgeAiPoints('A3', greedyEntry, 45, 100)).not.toThrow();
    expect(() => judgeAiPoints('A3', greedyEntry, 44.5, 100)).toThrow(ContractViolation);
    expect(() => judgeAiPoints('A4', greedyEntry, 35, 100)).not.toThrow();
    expect(() => judgeAiPoints('A4', greedyEntry, 35.5, 100)).toThrow(
      /\[A4\] 100 場，human-model 的勝率 35\.5%，最多只能 35\.0%（對等級 10）/,
    );
  });

  it('遊戲在某一段丟錯：包成 ContractViolation，帶編號', () => {
    const broken = defineEntry<CounterState>({
      id: counterEntry.id,
      kind: 'fixture',
      game: {
        ...counterGame,
        step: () => {
          throw new Error('爆了');
        },
      },
      render: counterEntry.render as (ctx: CanvasRenderingContext2D, state: CounterState) => void,
      meta: { ...counterMeta, defaultPolicy: 'greedy' },
    });
    expect(() => aiChunkPoints('A4', broken, AI_CHUNKS[0] as number[])).toThrow(
      /\[A4\] 遊戲丟出錯誤：.*爆了/,
    );
  });

  it('A1–A4 的 AI_CHECKS 仍然可以一次跑完（舊呼叫端不用改）', () => {
    for (const code of ['A1', 'A2', 'A3', 'A4']) {
      const check = AI_CHECKS.find((c) => c.code === code);
      expect(runCheck(check as NonNullable<typeof check>, greedyEntry)).toBe('pass');
    }
  });
});

describe('K4 分段', () => {
  it('各段合起來恰好是 CONTRACT_SEEDS，不漏不重，而且不只一段', () => {
    expect(K4_CHUNKS.flat()).toEqual([...CONTRACT_SEEDS]);
    expect(K4_CHUNKS.length).toBeGreaterThan(1);
  });

  it('K4 對任何一段種子都能跑（run 吃的是呼叫者給的種子）', () => {
    const k4 = CHECKS.find((c) => c.code === 'K4');
    for (const chunk of K4_CHUNKS) {
      expect(runCheck(k4 as NonNullable<typeof k4>, counterEntry, chunk)).toBe('pass');
    }
  });
});
