import { describe, expect, it } from 'vitest';

import { counterEntry, counterMeta } from '../../src/games/registry';
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
  measureA1,
  measureA2,
  measureA3,
  measureA4,
  measureA5,
  runCheck,
} from '../contract/checks';

/**
 * 登記表裡現在只有替身牌（沒有預設性格），所以 A1–A5 在 all-games.test.ts 裡全部被跳過。
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

  it('種子清單是 0..199，共 200 個', () => {
    expect(AI_SEEDS).toHaveLength(200);
    expect(AI_SEEDS[0]).toBe(0);
    expect(AI_SEEDS[199]).toBe(199);
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
    for (const value of [a1, a2, a3, a4, a5.meanMs, a5.maxMs]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(a1).toBeGreaterThanOrEqual(0.75);
    expect(a2).toBeGreaterThanOrEqual(0.6);
    expect(a3).toBeGreaterThanOrEqual(0.45);
    expect(a4).toBeLessThanOrEqual(0.35);
    expect(a5.samples).toBeGreaterThan(0);
    expect(a5.meanMs).toBeLessThan(1);
    expect(a5.maxMs).toBeLessThan(8);
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
