import { describe, expect, it } from 'vitest';

import type { Buttons, Controller, Game, GameConfig, Inputs } from './types';
import { counterGame, type CounterState } from '../../tests/fixtures/counter-game';
import { playMatch } from './match';
import { replay } from './replay';

const NONE: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};
const PRESS_A: Buttons = { ...NONE, a: true };

const idle: Controller<CounterState> = { decide: () => NONE };
const hold: Controller<CounterState> = { decide: () => PRESS_A };

const config: GameConfig = { maxTicks: 3600, params: {} };

describe('core/match（TEST_PLAN 3.3）', () => {
  it('兩個都不按的控制器：分數 [0, 0]，winner 是 null，ticks 是 100', () => {
    const result = playMatch(counterGame, 1, config, idle, idle);
    expect(result.score).toEqual([0, 0]);
    expect(result.winner).toBeNull();
    expect(result.ticks).toBe(100);
  });

  it('一邊一直按 a：那一邊 100 分並且獲勝', () => {
    const left = playMatch(counterGame, 1, config, hold, idle);
    expect(left.score).toEqual([100, 0]);
    expect(left.winner).toBe(0);

    const right = playMatch(counterGame, 1, config, idle, hold);
    expect(right.score).toEqual([0, 100]);
    expect(right.winner).toBe(1);
  });

  it('playMatch 回傳的 inputs 長度等於 ticks', () => {
    const result = playMatch(counterGame, 1, config, hold, idle);
    expect(result.inputs).toHaveLength(result.ticks);
    expect(result.inputs[0]).toEqual([PRESS_A, NONE]);
  });

  it('控制器拿到正確的 side 與 tick', () => {
    const seen: Array<[number, number]> = [];
    const spy0: Controller<CounterState> = {
      decide: (_s, side, tick) => {
        seen.push([side, tick]);
        return NONE;
      },
    };
    const spy1: Controller<CounterState> = {
      decide: (_s, side, tick) => {
        seen.push([side, tick]);
        return NONE;
      },
    };
    playMatch(counterGame, 1, config, spy0, spy1);
    expect(seen).toHaveLength(200);
    expect(seen.slice(0, 4)).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(seen[seen.length - 1]).toEqual([1, 99]);
  });

  it('把回傳的 inputs 交給 replay：finalHash 與原本相同', () => {
    const flip: Controller<CounterState> = {
      decide: (_s, _side, tick) => (tick % 3 === 0 ? PRESS_A : NONE),
    };
    const result = playMatch(counterGame, 42, config, hold, flip);
    const replayed = replay(counterGame, 42, config, result.inputs);
    expect(replayed.finalHash).toBe(result.finalHash);
    expect(replayed.score).toEqual(result.score);
    expect(replayed.winner).toBe(result.winner);
    expect(replayed.ticks).toBe(result.ticks);
  });

  it('改掉 inputs 裡任一個 tick 的一顆按鍵：finalHash 不同', () => {
    const result = playMatch(counterGame, 42, config, hold, idle);
    for (const tick of [0, 37, 99]) {
      const tampered: Inputs[] = result.inputs.map((pair) => [{ ...pair[0] }, { ...pair[1] }]);
      tampered[tick] = [tampered[tick][0], { ...tampered[tick][1], a: true }];
      const replayed = replay(counterGame, 42, config, tampered);
      expect(replayed.finalHash).not.toBe(result.finalHash);
    }
  });

  it('遊戲在 maxTicks 之前就 isOver：playMatch 立刻停，不多走', () => {
    let stepCalls = 0;
    const counted: Game<CounterState> = {
      ...counterGame,
      step: (state, inputs) => {
        stepCalls += 1;
        return counterGame.step(state, inputs);
      },
    };
    const result = playMatch(counted, 1, { maxTicks: 5000, params: {} }, hold, hold);
    expect(result.ticks).toBe(100);
    expect(stepCalls).toBe(100);
    expect(result.inputs).toHaveLength(100);
  });

  it('遊戲到了 maxTicks 還沒 isOver：playMatch 丟出錯誤', () => {
    const endless: Game<CounterState> = { ...counterGame, isOver: () => false };
    expect(() => playMatch(endless, 1, { maxTicks: 50, params: {} }, idle, idle)).toThrow(
      /maxTicks/,
    );
  });
});

describe('core/match（補充：TEST_PLAN 沒列）', () => {
  it('錯誤訊息帶出遊戲 id 與 maxTicks', () => {
    const endless: Game<CounterState> = { ...counterGame, isOver: () => false };
    expect(() => playMatch(endless, 1, { maxTicks: 50, params: {} }, idle, idle)).toThrow(
      /counter.*50|50.*counter/s,
    );
  });

  it('init 就已經 isOver：ticks 是 0，inputs 是空的', () => {
    const over: Game<CounterState> = { ...counterGame, isOver: () => true };
    const result = playMatch(over, 1, config, hold, hold);
    expect(result.ticks).toBe(0);
    expect(result.inputs).toEqual([]);
  });

  it('控制器之後改動它回傳的按鍵物件，不會污染 inputs 紀錄', () => {
    const shared: Buttons = { ...NONE, a: true };
    const mutating: Controller<CounterState> = {
      decide: () => {
        const copy = shared;
        return copy;
      },
    };
    const result = playMatch(counterGame, 1, config, mutating, idle);
    shared.a = false;
    expect(result.inputs[0][0].a).toBe(true);
  });

  it('同樣的種子與控制器，兩次結果（含 finalHash）完全相同', () => {
    const a = playMatch(counterGame, 9, config, hold, idle);
    const b = playMatch(counterGame, 9, config, hold, idle);
    expect(b).toEqual(a);
  });

  it('不同的最終狀態有不同的 finalHash', () => {
    const a = playMatch(counterGame, 9, config, hold, idle);
    const b = playMatch(counterGame, 9, config, idle, hold);
    expect(a.finalHash).not.toBe(b.finalHash);
  });
});

describe('core/replay（補充：TEST_PLAN 沒列）', () => {
  it('不同的種子重播得到不同的 finalHash（種子有進 state）', () => {
    const result = playMatch(counterGame, 1, config, hold, idle);
    const replayed = replay(counterGame, 2, config, result.inputs);
    expect(replayed.finalHash).not.toBe(result.finalHash);
  });

  it('inputs 比遊戲長（遊戲已結束還有輸入）：丟出錯誤', () => {
    const result = playMatch(counterGame, 1, config, hold, idle);
    const extra: Inputs[] = [...result.inputs, [NONE, NONE]];
    expect(() => replay(counterGame, 1, config, extra)).toThrow();
  });

  it('inputs 比遊戲短（遊戲沒結束）：丟出錯誤，不假裝重播完成', () => {
    const result = playMatch(counterGame, 1, config, hold, idle);
    expect(() => replay(counterGame, 1, config, result.inputs.slice(0, 50))).toThrow();
  });

  it('不會改動傳進去的 inputs', () => {
    const result = playMatch(counterGame, 1, config, hold, idle);
    const snapshot = JSON.stringify(result.inputs);
    replay(counterGame, 1, config, result.inputs);
    expect(JSON.stringify(result.inputs)).toBe(snapshot);
  });
});

describe('counter-game 本身', () => {
  it('step 不改動傳進來的 state', () => {
    const state = counterGame.init(1, config);
    const before = JSON.stringify(state);
    const next = counterGame.step(state, [PRESS_A, PRESS_A]);
    expect(JSON.stringify(state)).toBe(before);
    expect(next).not.toBe(state);
  });

  it('被 maxTicks 驅動：maxTicks 小於 100 時，在 maxTicks 結束', () => {
    const result = playMatch(counterGame, 1, { maxTicks: 30, params: {} }, hold, idle);
    expect(result.ticks).toBe(30);
    expect(result.score).toEqual([30, 0]);
  });

  it('actions 兩邊都至少有「全放開」與「按 a」', () => {
    const state = counterGame.init(1, config);
    for (const side of [0, 1] as const) {
      const actions = counterGame.actions(state, side);
      expect(actions).toContainEqual(NONE);
      expect(actions).toContainEqual(PRESS_A);
    }
  });

  it('evaluate：領先越多 gain 越大，danger 在 0 到 1', () => {
    let state = counterGame.init(1, config);
    for (let i = 0; i < 10; i += 1) {
      state = counterGame.step(state, [PRESS_A, NONE]);
    }
    const ahead = counterGame.evaluate(state, 0);
    const behind = counterGame.evaluate(state, 1);
    expect(ahead.gain).toBeGreaterThan(behind.gain);
    expect(ahead.danger).toBeGreaterThanOrEqual(0);
    expect(behind.danger).toBeLessThanOrEqual(1);
  });
});
