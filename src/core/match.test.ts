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

  // TEST_PLAN 3.3 寫的是「任一個 tick 的一顆按鍵」，但這個 fixture 依規格
  // （每個 tick 按著 a 的那一邊加 1 分）只有 a 鍵會進入 state：改 b、方向鍵不可能
  // 改變 finalHash，這是規格定義的必然結果，不是 bug，所以這裡只驗證 a 鍵，
  // 也不為了讓「任一顆按鍵」成立而改 fixture 的規則。
  // 真正的「任一顆按鍵都會改變雜湊」由契約測試 K1 對真的牌驗證。
  it('改掉 inputs 裡的 a 鍵（side 0 與 side 1、開頭／中段／結尾）：finalHash 都不同', () => {
    const base = playMatch(counterGame, 42, config, hold, idle);
    for (const side of [0, 1] as const) {
      for (const tick of [0, 50, 99]) {
        const tampered: Inputs[] = base.inputs.map((pair) => [{ ...pair[0] }, { ...pair[1] }]);
        tampered[tick][side].a = !tampered[tick][side].a;
        const replayed = replay(counterGame, 42, config, tampered);
        expect(replayed.finalHash, `side ${side} tick ${tick}`).not.toBe(base.finalHash);
      }
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

describe('core/match：壞的 maxTicks 要丟錯，不能無窮迴圈', () => {
  const bad: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-1', -1],
    ['0', 0],
    ['10.5', 10.5],
  ];
  for (const [name, value] of bad) {
    it(`playMatch：maxTicks 是 ${name} 時丟錯，訊息帶出收到的值`, () => {
      // 就算遊戲永遠不結束，也必須在進入迴圈之前就丟錯
      const endless: Game<CounterState> = { ...counterGame, isOver: () => false };
      expect(() => playMatch(endless, 1, { maxTicks: value, params: {} }, idle, idle)).toThrow(
        new RegExp(`maxTicks.*${name.replace('.', '\\.')}`, 's'),
      );
    });

    it(`replay：maxTicks 是 ${name} 時丟錯`, () => {
      expect(() => replay(counterGame, 1, { maxTicks: value, params: {} }, [])).toThrow(/maxTicks/);
    });
  }
});

describe('core/replay：與 playMatch 的 maxTicks 檢查等價', () => {
  const long: Game<CounterState> = {
    ...counterGame,
    init: (seed) => ({ seed, tick: 0, length: 80, scores: [0, 0] }),
  };

  it('遊戲 80 tick 才結束、maxTicks 是 50：playMatch 與 replay 都丟錯', () => {
    const small: GameConfig = { maxTicks: 50, params: {} };
    expect(() => playMatch(long, 1, small, idle, idle)).toThrow(/maxTicks/);
    const eighty: Inputs[] = Array.from({ length: 80 }, () => [NONE, NONE] as Inputs);
    expect(() => replay(long, 1, small, eighty)).toThrow(/maxTicks/);
  });

  it('inputs.length 剛好等於 maxTicks 時可以重播', () => {
    const exact: GameConfig = { maxTicks: 30, params: {} };
    const result = playMatch(counterGame, 1, exact, hold, idle);
    expect(replay(counterGame, 1, exact, result.inputs).ticks).toBe(30);
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

  it('任何合法 config 下都在 maxTicks 之內結束（含小數 length 與 maxTicks）', () => {
    const cases: Array<[number | undefined, number]> = [
      [10.5, 1000],
      [undefined, 10.5],
      [10.5, 10.5],
      [undefined, 1],
      [0, 5],
      [-3, 5],
      [1e9, 7],
    ];
    for (const [length, maxTicks] of cases) {
      const params: Record<string, number> = length === undefined ? {} : { length };
      const result = playMatch(
        counterGame,
        1,
        { maxTicks: Math.floor(maxTicks), params },
        hold,
        idle,
      );
      expect(result.ticks).toBeLessThanOrEqual(Math.floor(maxTicks));
    }
  });

  it('init 對壞的 config 或種子丟錯，而不是產生永不結束的遊戲', () => {
    for (const maxTicks of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 10.5]) {
      expect(() => counterGame.init(1, { maxTicks, params: {} })).toThrow(/maxTicks/);
    }
    expect(() => counterGame.init(1, { maxTicks: 50, params: { length: Number.NaN } })).toThrow(
      /length/,
    );
    expect(() =>
      counterGame.init(1, { maxTicks: 50, params: { length: Number.POSITIVE_INFINITY } }),
    ).toThrow(/length/);
    expect(() => counterGame.init(Number.NaN, config)).toThrow(/NaN/);
  });

  it('params.length 是小數時向下取整', () => {
    expect(counterGame.init(1, { maxTicks: 100, params: { length: 10.9 } }).length).toBe(10);
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
