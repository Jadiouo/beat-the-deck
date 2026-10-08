import { describe, expect, it } from 'vitest';

import { counterEntry, counterMeta } from '../fixtures/counter-entry';
import type { CardMeta, RegistryEntry } from '../../src/games/types';
import { defineEntry } from '../../src/games/types';
import { counterGame } from '../fixtures/counter-game';
import type { CounterState } from '../fixtures/counter-game';
import {
  AI_CHECKS,
  AI_SEEDS,
  CHECKS,
  CONTRACT_CONFIG,
  aiThresholds,
  contractController,
  notApplicableReason,
  measureA1,
  measureA2,
  measureA3,
  measureA4,
  measureA5,
  runCheck,
} from '../contract/checks';

/**
 * 替身牌沒有預設性格，所以 A1–A5 在 all-games.test.ts 對它全部被跳過（真牌 C-A 會跑）。
 * 這個檔案證明它們「會跑、會給數字、會抓到壞的」：把 counter-game 包成一個只存在於
 * 測試裡的、有預設性格的臨時登記項，直接對它跑 A1–A5 的檢查函式。
 * 第一張真牌進登記表時，all-games.test.ts 的迴圈會自動用同一份檢查去測它。
 */

function withMeta(overrides: Partial<CardMeta>): RegistryEntry {
  return defineEntry<CounterState>({
    id: counterEntry.id,
    kind: 'fixture',
    game: counterGame,
    render: counterEntry.render as (ctx: CanvasRenderingContext2D, state: CounterState) => void,
    meta: { ...counterMeta, ...overrides },
  });
}

const greedyEntry = withMeta({ defaultPolicy: 'greedy' });

const A_CODES = ['A1', 'A2', 'A3', 'A4', 'A5'] as const;

describe('A1–A5 接進了契約的檢查清單（AI_CHECKS）', () => {
  it('AI_CHECKS 裡有 A1 到 A5', () => {
    for (const code of A_CODES) {
      expect(AI_CHECKS.some((check) => check.code === code)).toBe(true);
    }
  });

  it('沒有預設性格的牌（替身牌）跳過；有預設性格的牌要跑', () => {
    for (const code of A_CODES) {
      const check = AI_CHECKS.find((c) => c.code === code);
      expect(check?.applies(counterEntry)).toBe(false);
      expect(check?.applies(greedyEntry)).toBe(true);
    }
  });

  it('鬼牌不跑 5.1，就算有預設性格', () => {
    const joker = withMeta({ defaultPolicy: 'gambler', suit: 'JK', rank: 'R' });
    for (const code of A_CODES) {
      expect(AI_CHECKS.find((c) => c.code === code)?.applies(joker)).toBe(false);
    }
  });

  it('種子清單是 0..N-1（N 只能是 200，或 TEST_PLAN 第 8 節授權的 100）', () => {
    expect([100, 200]).toContain(AI_SEEDS.length);
    expect(AI_SEEDS).toEqual(Array.from({ length: AI_SEEDS.length }, (_, i) => i));
  });
});

describe('門檻（TEST_PLAN 5.1）', () => {
  it('一般的牌：A1 75%、A2 60%、A3 45%、A4 35%', () => {
    expect(aiThresholds(counterMeta)).toEqual({ a1: 0.75, a2: 0.6, a3: 0.45, a4: 0.35 });
  });

  it('luckHeavy（紅心）：A1 降為 60%、A2 降為 55%，A3、A4 不變', () => {
    expect(aiThresholds({ ...counterMeta, luckHeavy: true })).toEqual({
      a1: 0.6,
      a2: 0.55,
      a3: 0.45,
      a4: 0.35,
    });
  });
});

describe('用臨時登記項（counter-game ＋ 預設性格 greedy）實際跑 A1–A5', () => {
  it('每一條都跑得起來、給出數字、通過', () => {
    const a1 = measureA1(greedyEntry);
    const a2 = measureA2(greedyEntry);
    const a3 = measureA3(greedyEntry);
    const a4 = measureA4(greedyEntry);
    const a5 = measureA5(greedyEntry);
    for (const value of [a1, a2, a3, a4, a5.meanMs, a5.p999Ms, a5.maxMs]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(a1).toBeGreaterThanOrEqual(0.75);
    expect(a2).toBeGreaterThanOrEqual(0.6);
    expect(a3).toBeGreaterThanOrEqual(0.45);
    expect(a4).toBeLessThanOrEqual(0.35);
    expect(a5.samples).toBeGreaterThan(0);
    expect(a5.meanMs).toBeLessThan(1);
    expect(a5.p999Ms).toBeLessThan(8);
    expect(a5.maxMs).toBeGreaterThanOrEqual(a5.p999Ms);
    for (const code of A_CODES) {
      const check = AI_CHECKS.find((c) => c.code === code);
      expect(check).toBeDefined();
      expect(runCheck(check as NonNullable<typeof check>, greedyEntry)).toBe('pass');
    }
  });

  it('抓得到壞的：gain 被反過來的遊戲（性格會努力輸）過不了 A1', () => {
    const inverted = defineEntry<CounterState>({
      id: 'counter',
      kind: 'fixture',
      game: {
        ...counterGame,
        evaluate: (state, side) => {
          const { gain } = counterGame.evaluate(state, side);
          return { gain: -gain, danger: 0 };
        },
      },
      render: counterEntry.render as (ctx: CanvasRenderingContext2D, state: CounterState) => void,
      meta: { ...counterMeta, defaultPolicy: 'greedy' },
    });
    expect(measureA1(inverted)).toBeLessThan(0.75);
    const a1 = AI_CHECKS.find((c) => c.code === 'A1');
    const outcome = runCheck(a1 as NonNullable<typeof a1>, inverted);
    expect(typeof outcome).toBe('object');
    expect(JSON.stringify(outcome)).toContain('A1');
  });
});

describe('K11、K12 用預設性格', () => {
  it('有預設性格時，契約用的控制器是那個性格（等級 5，在 counter-game 上幾乎都按 A）', () => {
    let state = counterGame.init(0, CONTRACT_CONFIG);
    const controller = contractController(greedyEntry, 3, 0, 5);
    let pressed = 0;
    for (let t = 0; t < 100; t += 1) {
      const buttons = controller.decide(state, 0, t);
      pressed += buttons.a ? 1 : 0;
      state = counterGame.step(state, [buttons, buttons]);
    }
    // 隨機控制器大約 50；等級 5 的貪心型 ε≈0.14、每 7 個 tick 才決定，幾乎都是 A。
    expect(pressed).toBeGreaterThan(70);
  });

  it('沒有預設性格時退回隨機控制器（行為與 T2 相同）', () => {
    let state = counterGame.init(0, CONTRACT_CONFIG);
    const controller = contractController(counterEntry, 3, 0, 5);
    let pressed = 0;
    for (let t = 0; t < 100; t += 1) {
      const buttons = controller.decide(state, 0, t);
      pressed += buttons.a ? 1 : 0;
      state = counterGame.step(state, [buttons, buttons]);
    }
    expect(pressed).toBeGreaterThan(20);
    expect(pressed).toBeLessThan(80);
  });

  it('K11、K12 在臨時登記項上照樣通過', () => {
    const symmetric = withMeta({ defaultPolicy: 'greedy', symmetric: true });
    for (const code of ['K11', 'K12'] as const) {
      const check = CHECKS.find((c) => c.code === code);
      expect(runCheck(check as NonNullable<typeof check>, symmetric)).toBe('pass');
    }
  });
});

describe('reflexOnly：A4 明確「不適用」，不是通過', () => {
  const reflexEntry = withMeta({ defaultPolicy: 'greedy', reflexOnly: true });
  const a4 = AI_CHECKS.find((c) => c.code === 'A4') as NonNullable<
    ReturnType<typeof AI_CHECKS.find>
  >;

  it('A4 對 reflexOnly 的牌不適用，runCheck 回 skip（絕對不是 pass）', () => {
    expect(a4.applies(reflexEntry)).toBe(false);
    expect(runCheck(a4, reflexEntry)).toBe('skip');
  });

  it('不適用要說明理由：理由提到 reflexOnly、反射與劇本玩家', () => {
    const reason = notApplicableReason(a4, reflexEntry);
    expect(reason).not.toBeNull();
    expect(reason).toContain('reflexOnly');
    expect(reason).toContain('反射');
    expect(reason).toContain('劇本玩家');
  });

  it('一般的牌 A4 照跑，沒有理由', () => {
    expect(a4.applies(greedyEntry)).toBe(true);
    expect(notApplicableReason(a4, greedyEntry)).toBeNull();
  });

  it('只有 A4 被跳過：A1、A2、A3、A5 對 reflexOnly 的牌照樣適用', () => {
    for (const code of ['A1', 'A2', 'A3', 'A5'] as const) {
      const check = AI_CHECKS.find((c) => c.code === code) as NonNullable<typeof a4>;
      expect(check.applies(reflexEntry), code).toBe(true);
      expect(notApplicableReason(check, reflexEntry), code).toBeNull();
    }
  });

  it('門檻不變：reflexOnly 不影響 A1 到 A4 的數字門檻', () => {
    expect(aiThresholds({ ...counterMeta, reflexOnly: true })).toEqual({
      a1: 0.75,
      a2: 0.6,
      a3: 0.45,
      a4: 0.35,
    });
  });

  it('沒有預設性格的牌，理由是「沒有預設性格」，不是 reflexOnly', () => {
    const reason = notApplicableReason(a4, counterEntry);
    expect(reason).not.toBeNull();
    expect(reason).not.toContain('reflexOnly');
  });
});
