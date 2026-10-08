import { describe, expect, it } from 'vitest';

import type { Buttons, Game } from '../core/types';
import { counterGame } from '../../tests/fixtures/counter-game';
import type { CounterState } from '../../tests/fixtures/counter-game';
import { HUMAN_PARAMS } from './human-model';
import { effectiveLevel, globalLevel, levelController, levelParams, wrapPolicy } from './level';
import type { Policy } from './types';

/**
 * TEST_PLAN 3.7｜ai/level，與 SPEC 7.2 最後一段的等級推導（TEST_PLAN 3.6 最後兩條會用到）。
 */

const CONFIG = { maxTicks: 400, params: { length: 400 } };

/** 沿著 counter-game 走：第 t 個 state 就是 tick = t（兩邊都放開）。 */
function states(count: number): CounterState[] {
  const out: CounterState[] = [];
  let state = counterGame.init(1, CONFIG);
  for (let t = 0; t < count; t += 1) {
    out.push(state);
    const idle = counterGame.actions(state, 0)[0] as Buttons;
    state = counterGame.step(state, [idle, idle]);
  }
  return out;
}

/** 會記錄「收到什麼 state」的假性格。每次被問就回傳 actions 裡輪流的下一個，方便看出何時換動作。 */
function recordingPolicy(): { policy: Policy; seen: number[]; calls: () => number } {
  const seen: number[] = [];
  const policy: Policy = {
    name: 'recording',
    decide<S>(game: Game<S>, state: S, side: 0 | 1): Buttons {
      seen.push((state as unknown as CounterState).tick);
      const actions = game.actions(state, side);
      return actions[(seen.length - 1) % actions.length] as Buttons;
    },
  };
  return { policy, seen, calls: () => seen.length };
}

describe('levelParams：等級表（反應延遲固定在人類水準，差別來自決定頻率、失誤率與搜尋深度）', () => {
  it('等級 1 的四個參數', () => {
    expect(levelParams(1)).toEqual({ reactionTicks: 12, decideEvery: 12, depth: 1, epsilon: 0.25 });
  });

  it('等級 10 的四個參數', () => {
    expect(levelParams(10)).toEqual({ reactionTicks: 12, decideEvery: 1, depth: 6, epsilon: 0 });
  });

  it('所有等級的反應延遲都等於人類模型的（等級的差別不可以來自「看得比較快」）', () => {
    for (let level = 1; level <= 10; level += 1) {
      expect(levelParams(level).reactionTicks).toBe(HUMAN_PARAMS.reactionTicks);
    }
  });

  it('等級 1 到 10：reactionTicks、decideEvery、epsilon 單調不增，depth 單調不減', () => {
    for (let level = 1; level < 10; level += 1) {
      const a = levelParams(level);
      const b = levelParams(level + 1);
      expect(b.reactionTicks).toBeLessThanOrEqual(a.reactionTicks);
      expect(b.decideEvery).toBeLessThanOrEqual(a.decideEvery);
      expect(b.epsilon).toBeLessThanOrEqual(a.epsilon);
      expect(b.depth).toBeGreaterThanOrEqual(a.depth);
    }
  });

  it('中間等級是線性內插後取整（epsilon 不取整）', () => {
    // 等級 5：反應延遲固定 12；12 − 11·4/9 = 7.11 → 7；1 + 5·4/9 = 3.22 → 3
    const five = levelParams(5);
    expect(five.reactionTicks).toBe(12);
    expect(five.decideEvery).toBe(7);
    expect(five.depth).toBe(3);
    expect(five.epsilon).toBeCloseTo((0.25 * 5) / 9, 10);
    for (let level = 1; level <= 10; level += 1) {
      const p = levelParams(level);
      expect(Number.isInteger(p.reactionTicks)).toBe(true);
      expect(Number.isInteger(p.decideEvery)).toBe(true);
      expect(Number.isInteger(p.depth)).toBe(true);
    }
  });

  it('等級必須是 1 到 10 的整數，否則丟錯', () => {
    for (const bad of [0, 11, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => levelParams(bad)).toThrow(RangeError);
    }
  });
});

describe('包上等級的控制器', () => {
  it('decideEvery = 12：連續 12 個 tick 回傳同一組按鍵，下一個 12 個才換', () => {
    const { policy } = recordingPolicy();
    const controller = wrapPolicy(
      counterGame,
      policy,
      { reactionTicks: 0, decideEvery: 12, depth: 1, epsilon: 0 },
      7,
    );
    const all = states(48);
    const out = all.map((state, t) => controller.decide(state, 0, t));
    for (let block = 0; block < 4; block += 1) {
      const first = out[block * 12] as Buttons;
      for (let i = 0; i < 12; i += 1) {
        expect(out[block * 12 + i]).toEqual(first);
      }
    }
    // 假性格每次問都換一個動作，所以相鄰的區塊一定不同：證明「有重新決定」而不是永遠不動。
    expect(out[0]).not.toEqual(out[12]);
    expect(out[12]).not.toEqual(out[24]);
  });

  it('decideEvery = 12 時，性格在這 12 個 tick 裡只被問一次', () => {
    const { policy, calls } = recordingPolicy();
    const controller = wrapPolicy(
      counterGame,
      policy,
      { reactionTicks: 0, decideEvery: 12, depth: 1, epsilon: 0 },
      7,
    );
    states(36).forEach((state, t) => controller.decide(state, 0, t));
    expect(calls()).toBe(3);
  });

  it('epsilon = 0：完全等於底層性格的決定', () => {
    const wrapped = recordingPolicy();
    const bare = recordingPolicy();
    const controller = wrapPolicy(
      counterGame,
      wrapped.policy,
      { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0 },
      11,
    );
    for (const [t, state] of states(50).entries()) {
      const expected = bare.policy.decide(counterGame, state, 0, t, { depth: 1, seed: 11 });
      expect(controller.decide(state, 0, t)).toEqual(expected);
    }
  });

  it('epsilon = 1：回傳的一定是 actions() 裡的某一個（就算性格回傳了不在清單裡的按鍵）', () => {
    const rogue: Policy = {
      name: 'rogue',
      decide(): Buttons {
        return { up: true, down: true, left: true, right: true, a: true, b: true };
      },
    };
    const controller = wrapPolicy(
      counterGame,
      rogue,
      { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 1 },
      5,
    );
    const seenA = new Set<boolean>();
    for (const [t, state] of states(200).entries()) {
      const result = controller.decide(state, 0, t);
      const legal = counterGame.actions(state, 0);
      expect(legal.some((action) => JSON.stringify(action) === JSON.stringify(result))).toBe(true);
      seenA.add(result.a);
    }
    // 兩個動作都真的出現過：不是永遠回傳同一個。
    expect(seenA.size).toBe(2);
  });

  it('epsilon 的機率大致正確（0.25 對 2000 次決定，亂選的那些裡一半是按 A）', () => {
    const alwaysA: Policy = {
      name: 'always-a',
      decide<S>(game: Game<S>, state: S, side: 0 | 1): Buttons {
        return game.actions(state, side).find((b) => b.a) as Buttons;
      },
    };
    const controller = wrapPolicy(
      counterGame,
      alwaysA,
      { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0.25 },
      9,
    );
    const long = { maxTicks: 3000, params: { length: 3000 } };
    let state = counterGame.init(1, long);
    let notA = 0;
    for (let t = 0; t < 2000; t += 1) {
      const pressed = controller.decide(state, 0, t);
      if (!pressed.a) {
        notA += 1;
      }
      state = counterGame.step(state, [pressed, pressed]);
    }
    // 期望值 0.25 × 0.5 × 2000 = 250
    expect(notA).toBeGreaterThan(190);
    expect(notA).toBeLessThan(310);
  });

  it('同一個種子、同一串呼叫，結果完全相同；tick 回到 0 就重新開始', () => {
    const run = (): Buttons[] => {
      const controller = levelController(counterGame, recordingPolicy().policy, 3, 21);
      return states(60).map((state, t) => controller.decide(state, 1, t));
    };
    expect(run()).toEqual(run());

    const byTick: Policy = {
      name: 'by-tick',
      decide<S>(game: Game<S>, state: S, side: 0 | 1, tick: number): Buttons {
        const actions = game.actions(state, side);
        return actions[tick % actions.length] as Buttons;
      },
    };
    const controller = levelController(counterGame, byTick, 3, 21);
    const first = states(40).map((state, t) => controller.decide(state, 1, t));
    const second = states(40).map((state, t) => controller.decide(state, 1, t));
    // 第二場的 tick 又從 0 開始：歷史與亂數都要重設，所以結果與第一場逐個相同。
    expect(second).toEqual(first);
  });

  it('wrapPolicy 檢查參數：reactionTicks 與 decideEvery 的範圍', () => {
    const { policy } = recordingPolicy();
    expect(() =>
      wrapPolicy(
        counterGame,
        policy,
        { reactionTicks: -1, decideEvery: 1, depth: 1, epsilon: 0 },
        1,
      ),
    ).toThrow(RangeError);
    expect(() =>
      wrapPolicy(
        counterGame,
        policy,
        { reactionTicks: 0, decideEvery: 0, depth: 1, epsilon: 0 },
        1,
      ),
    ).toThrow(RangeError);
    expect(() =>
      wrapPolicy(
        counterGame,
        policy,
        { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 1.5 },
        1,
      ),
    ).toThrow(RangeError);
  });
});

describe('等級推導（SPEC 7.2、TEST_PLAN 3.6）', () => {
  it('全域等級：翻開 0、1、2 張是 1；3 張是 2；27 張以上是 10', () => {
    expect([0, 1, 2].map(globalLevel)).toEqual([1, 1, 1]);
    expect(globalLevel(3)).toBe(2);
    expect(globalLevel(5)).toBe(2);
    expect(globalLevel(6)).toBe(3);
    expect(globalLevel(27)).toBe(10);
    expect(globalLevel(54)).toBe(10);
  });

  it('實際等級 ＝ 夾在 1 到 10 之間的（全域等級 ＋ 基礎等級 − 1）', () => {
    expect(effectiveLevel(1, 1)).toBe(1);
    expect(effectiveLevel(1, 4)).toBe(4);
    expect(effectiveLevel(5, 3)).toBe(7);
    expect(effectiveLevel(10, 4)).toBe(10);
    expect(effectiveLevel(9, 4)).toBe(10);
  });
});
