import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { greedy } from '../../ai/policies/greedy';
import { rngStateFor } from '../../core/rng';
import type { Inputs } from '../../core/types';
import { cell, MOVE_EVERY, START_CELLS } from '../_diamonds/logic';
import {
  BEFORE_MOVE,
  CONFIG,
  describeSharedDiamondsRules,
  IDLE,
  NONE,
  PRESS_DOWN,
  PRESS_LEFT,
  PRESS_RIGHT,
  PRESS_UP,
  run,
  wallsExcept,
} from '../_diamonds/shared-rules.test-helpers';
import { BAG_LIMIT, d2Game, makeState } from './logic';
import type { D2State } from './logic';

/**
 * D-2 背包上限的規則測試（TEST_PLAN 第 6 節 D-2 的 7 條）。
 * 第 7 條「D-A 的 1 到 3、6、7 成立」：用 `_diamonds/shared-rules.test-helpers.ts` 與 D-A 共用同一組測試。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 */

describeSharedDiamondsRules<D2State>({
  label: 'D-2 背包上限',
  game: d2Game,
  makeState,
  pickupCells: (state) => state.coins,
  withPickups: (cells) => ({ coins: cells }),
  count: 6,
});

const FAR_COINS = [cell(15, 10), cell(16, 10), cell(17, 10), cell(18, 10), cell(19, 10)];

/** 兩個角色離得遠遠的；下一次 step 是走格。 */
function arena(overrides: Parameters<typeof makeState>[0] = {}): D2State {
  return makeState({
    tick: BEFORE_MOVE,
    players: [{ cell: cell(5, 5) }, { cell: cell(25, 20) }],
    coins: [cell(6, 5), ...FAR_COINS],
    ...overrides,
  });
}

describe('D-2 背包上限｜TEST_PLAN 第 6 節', () => {
  it('初始：背包都是空的、分數 0；6 枚金幣不在牆上、不在兩個基地上', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const state = d2Game.init(seed, CONFIG);
      expect(state.bags).toEqual([0, 0]);
      expect(d2Game.score(state)).toEqual([0, 0]);
      expect(state.coins).toHaveLength(6);
      for (const c of state.coins) {
        expect(state.walls[c]).toBe(0);
        expect(START_CELLS).not.toContain(c);
      }
    }
  });

  it('1. 撿金幣：背包加 1，分數不變，補一枚（場上維持 6 枚，補的不在腳下）', () => {
    const next = d2Game.step(arena(), [PRESS_RIGHT, NONE]);
    expect(next.bags).toEqual([1, 0]);
    expect(d2Game.score(next)).toEqual([0, 0]);
    expect(next.coins).toHaveLength(6);
    expect(next.coins).not.toContain(cell(6, 5));
  });

  it('1. 連續撿三枚：背包 1、2、3，分數一直是 0', () => {
    let state = arena({
      coins: [cell(6, 5), cell(7, 5), cell(8, 5), ...FAR_COINS.slice(0, 3)],
    });
    for (let i = 1; i <= 3; i += 1) {
      state = d2Game.step({ ...state, tick: BEFORE_MOVE }, [PRESS_RIGHT, NONE]);
      expect(state.bags[0]).toBe(i);
      expect(d2Game.score(state)[0]).toBe(0);
    }
  });

  it('2. 背包已經 3 枚時走到金幣格：金幣留在原地，背包還是 3，不補、不得分', () => {
    const state = arena({ bags: [BAG_LIMIT, 0] });
    const next = d2Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(cell(6, 5));
    expect(next.bags).toEqual([3, 0]);
    expect(next.coins).toEqual(state.coins);
    expect(next.rng).toBe(state.rng);
    expect(d2Game.score(next)).toEqual([0, 0]);
  });

  it('2. 邊界：背包 2 枚還撿得起來（變 3），背包 3 枚撿不起來', () => {
    const two = d2Game.step(arena({ bags: [2, 0] }), [PRESS_RIGHT, NONE]);
    expect(two.bags[0]).toBe(3);
    const three = d2Game.step(arena({ bags: [3, 0] }), [PRESS_RIGHT, NONE]);
    expect(three.bags[0]).toBe(3);
    expect(three.coins).toContain(cell(6, 5));
  });

  it('2. 邊界：兩人同一個 tick 走到同一枚，一個滿了一個沒滿：只有沒滿的撿到，金幣被移除；兩個都滿：金幣留著', () => {
    const base = {
      players: [{ cell: cell(5, 5) }, { cell: cell(7, 5) }] as const,
    };
    const one = d2Game.step(arena({ ...base, bags: [3, 1] }), [PRESS_RIGHT, PRESS_LEFT]);
    expect(one.bags).toEqual([3, 2]);
    expect(one.coins).not.toContain(cell(6, 5));
    expect(one.coins).toHaveLength(6);
    const both = d2Game.step(arena({ ...base, bags: [3, 3] }), [PRESS_RIGHT, PRESS_LEFT]);
    expect(both.bags).toEqual([3, 3]);
    expect(both.coins).toContain(cell(6, 5));
  });

  it('2. 兩人同一個 tick 走到同一枚、都有空位：各撿 1 枚（背包各加 1），只補一枚', () => {
    const state = arena({ players: [{ cell: cell(5, 5) }, { cell: cell(7, 5) }] });
    const next = d2Game.step(state, [PRESS_RIGHT, PRESS_LEFT]);
    expect(next.bags).toEqual([1, 1]);
    expect(next.coins).toHaveLength(6);
    expect(state.coins.filter((c) => next.coins.includes(c))).toHaveLength(5);
  });

  it('3. 走到自己的基地：分數加上背包的數量，背包歸零（人的基地在左下角）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(1, 23), score: 4 }, { cell: cell(25, 20) }],
      bags: [3, 0],
    });
    const next = d2Game.step(state, [PRESS_LEFT, NONE]);
    expect(next.players[0].cell).toBe(cell(0, 23));
    expect(d2Game.score(next)).toEqual([7, 0]);
    expect(next.bags).toEqual([0, 0]);
  });

  it('3. 走到自己的基地：AI 的基地在右上角，背包 2 枚存進 2 分', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(5, 5) }, { cell: cell(31, 1) }],
      bags: [0, 2],
    });
    const next = d2Game.step(state, [NONE, PRESS_UP]);
    expect(next.players[1].cell).toBe(cell(31, 0));
    expect(d2Game.score(next)).toEqual([0, 2]);
    expect(next.bags).toEqual([0, 0]);
  });

  it('3. 存分不補金幣、不動亂數；站在基地上不動，背包空了也不會再得分', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(1, 23) }, { cell: cell(25, 20) }],
      bags: [2, 0],
    });
    const next = d2Game.step(state, [PRESS_LEFT, NONE]);
    expect(next.coins).toEqual(state.coins);
    expect(next.rng).toBe(state.rng);
    const later = run(d2Game, next, MOVE_EVERY * 4, IDLE);
    expect(d2Game.score(later)).toEqual([2, 0]);
  });

  it('4. 走到對方的基地：什麼都不發生（背包、分數都不變）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(30, 0) }, { cell: cell(25, 20) }],
      bags: [2, 0],
    });
    const next = d2Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(START_CELLS[1]);
    expect(next.bags).toEqual([2, 0]);
    expect(d2Game.score(next)).toEqual([0, 0]);
    // AI 走進人的基地同理。
    const mirror = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(10, 10) }, { cell: cell(0, 22) }],
      bags: [0, 3],
    });
    const next2 = d2Game.step(mirror, [NONE, PRESS_DOWN]);
    expect(next2.players[1].cell).toBe(START_CELLS[0]);
    expect(next2.bags).toEqual([0, 3]);
    expect(d2Game.score(next2)).toEqual([0, 0]);
  });

  it('5. 背包是空的走到基地：什麼都不發生（分數不變、金幣不變）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(1, 23), score: 3 }, { cell: cell(25, 20) }],
    });
    const next = d2Game.step(state, [PRESS_LEFT, NONE]);
    expect(next.players[0].cell).toBe(cell(0, 23));
    expect(d2Game.score(next)).toEqual([3, 0]);
    expect(next.bags).toEqual([0, 0]);
    expect(next.coins).toEqual(state.coins);
  });

  it('6. 時間到時背包裡有 2 枚：不算分（分數只算存進基地的）', () => {
    const end = d2Game.step(
      makeState({
        tick: 3599,
        players: [
          { cell: cell(5, 5), score: 1 },
          { cell: cell(25, 20), score: 2 },
        ],
        bags: [2, 0],
      }),
      IDLE,
    );
    expect(d2Game.isOver(end)).toBe(true);
    expect(d2Game.score(end)).toEqual([1, 2]);
    expect(d2Game.winner(end)).toBe(1);
  });

  it('6. 邊界：最後一個 tick（3600）走進基地存進去的算分；最後一個 tick 撿到的不算', () => {
    const deposit = d2Game.step(
      makeState({
        tick: 3599,
        players: [
          { cell: cell(1, 23), score: 1 },
          { cell: cell(25, 20), score: 2 },
        ],
        bags: [2, 0],
      }),
      [PRESS_LEFT, NONE],
    );
    expect(d2Game.score(deposit)).toEqual([3, 2]);
    expect(d2Game.winner(deposit)).toBe(0);
    const pickup = d2Game.step(
      arena({
        tick: 3599,
        players: [
          { cell: cell(5, 5), score: 1 },
          { cell: cell(25, 20), score: 2 },
        ],
      }),
      [PRESS_RIGHT, NONE],
    );
    expect(pickup.bags[0]).toBe(1);
    expect(d2Game.score(pickup)).toEqual([1, 2]);
    expect(d2Game.winner(pickup)).toBe(1);
  });

  it('6. 邊界：同分平手（背包再滿也不算）', () => {
    const end = d2Game.step(
      makeState({ tick: 3599, players: [{ score: 2 }, { score: 2 }], bags: [3, 0] }),
      IDLE,
    );
    expect(d2Game.winner(end)).toBeNull();
  });

  it('金幣不會補在基地上：基地在走廊裡，補了 6 枚也沒有一枚在 (0, 23)（10 個亂數狀態）', () => {
    const row = Array.from({ length: 14 }, (_v, x) => cell(x, 23));
    for (let seed = 0; seed < 10; seed += 1) {
      const state = makeState({
        tick: BEFORE_MOVE,
        rng: rngStateFor(seed, 'base-test'),
        walls: wallsExcept(row),
        players: [{ cell: cell(0, 23) }, { cell: cell(13, 23) }],
        coins: [cell(1, 23)],
      });
      const next = d2Game.step(state, [PRESS_RIGHT, NONE]);
      expect(next.coins).toHaveLength(6);
      expect(next.coins).not.toContain(cell(0, 23));
      expect(next.coins).not.toContain(cell(1, 23));
      expect(next.coins).not.toContain(cell(13, 23));
    }
  });

  it('結束之後再 step：state 原樣不變', () => {
    const over = d2Game.step(makeState({ tick: 3599, bags: [1, 1] }), IDLE);
    expect(d2Game.step(over, [PRESS_RIGHT, PRESS_LEFT])).toEqual(over);
  });
});

describe('D-2 背包上限｜動作與評估（給貪心型用）', () => {
  const gainsOf = (state: D2State, side: 0 | 1): number[] =>
    d2Game.actions(state, side).map((action) => {
      const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
      return d2Game.evaluate(d2Game.step(state, inputs), side).gain;
    });
  const best = (values: readonly number[]): number => values.indexOf(Math.max(...values));
  const [ACT_NONE, , ACT_RIGHT, ACT_DOWN, ACT_LEFT] = [0, 1, 2, 3, 4];

  it('actions：同 D-A（5 個不同的動作，1 號邊的順序轉 180 度）', () => {
    const state = makeState();
    expect(d2Game.actions(state, 0)).toEqual([NONE, PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT]);
    expect(d2Game.actions(state, 1)).toEqual([NONE, PRESS_DOWN, PRESS_LEFT, PRESS_UP, PRESS_RIGHT]);
  });

  it('gain：背包空的時候往最近的金幣走一步最高', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      coins: [cell(14, 10), cell(2, 20), cell(2, 21), cell(2, 22), cell(3, 20), cell(3, 21)],
    });
    expect(best(gainsOf(state, 0))).toBe(ACT_RIGHT);
  });

  it('gain：背包滿了（3 枚）的時候，即使金幣就在旁邊，也往基地走（左下角）', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(10, 20) }, { cell: cell(30, 1) }],
      bags: [3, 0],
      coins: [cell(12, 20), cell(13, 20), cell(14, 20), cell(15, 20), cell(16, 20), cell(17, 20)],
    });
    const gains = gainsOf(state, 0);
    // 基地在 (0, 23)：往左或往下都比往右（靠近金幣、遠離基地）好。
    expect(gains[ACT_LEFT]).toBeGreaterThan(gains[ACT_RIGHT] as number);
    expect([ACT_LEFT, ACT_DOWN]).toContain(best(gains));
  });

  it('gain：背包滿了就算金幣在腳邊，也不再為了撿金幣繞路；背包有空位時才會去撿', () => {
    const near = {
      tick: 1,
      players: [{ cell: cell(10, 20) }, { cell: cell(30, 1) }] as const,
      coins: [cell(11, 20), cell(25, 5), cell(26, 5), cell(27, 5), cell(28, 5), cell(29, 5)],
    };
    const full = gainsOf(makeState({ ...near, bags: [3, 0] }), 0);
    const room = gainsOf(makeState({ ...near, bags: [1, 0] }), 0);
    expect(best(room)).toBe(ACT_RIGHT);
    expect(best(full)).not.toBe(ACT_RIGHT);
  });

  it('gain：背包裡有金幣時存進基地比留在背包裡好（分數 100 > 背包 BAG_WEIGHT）', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(1, 23) }, { cell: cell(30, 1) }],
      bags: [2, 0],
    });
    const gains = gainsOf(state, 0);
    expect(best(gains)).toBe(ACT_LEFT);
    expect(gains[ACT_LEFT]).toBeGreaterThan((gains[ACT_NONE] as number) + 50);
  });

  it('gain：時間快到了而且背包裡有金幣：往基地走，不去撿別的金幣', () => {
    const state = makeState({
      tick: 3560,
      players: [{ cell: cell(10, 20) }, { cell: cell(30, 1) }],
      bags: [1, 0],
      coins: [cell(11, 20), cell(25, 5), cell(26, 5), cell(27, 5), cell(28, 5), cell(29, 5)],
    });
    expect([ACT_LEFT, ACT_DOWN]).toContain(best(gainsOf(state, 0)));
  });

  it('gain：背包領先越多越高；分數領先更高；對 1 號邊相反', () => {
    const bag = makeState({ bags: [2, 0] });
    const score = makeState({ players: [{ score: 1 }, {}] });
    const none = makeState();
    expect(d2Game.evaluate(bag, 0).gain).toBeGreaterThan(d2Game.evaluate(none, 0).gain);
    expect(d2Game.evaluate(score, 0).gain).toBeGreaterThan(d2Game.evaluate(bag, 0).gain);
    expect(d2Game.evaluate(bag, 1).gain).toBeLessThan(d2Game.evaluate(none, 1).gain);
  });

  it('danger：永遠在 0 到 1 之間；時間快到了而背包裡有東西時比較高；已結束的局是 0', () => {
    const early = makeState({
      tick: 100,
      players: [{ cell: cell(1, 20) }, { cell: cell(30, 1) }],
      bags: [3, 0],
    });
    const late = makeState({
      tick: 3590,
      players: [{ cell: cell(20, 3) }, { cell: cell(30, 1) }],
      bags: [3, 0],
    });
    const e = d2Game.evaluate(early, 0).danger;
    const l = d2Game.evaluate(late, 0).danger;
    expect(e).toBeGreaterThanOrEqual(0);
    expect(l).toBeLessThanOrEqual(1);
    expect(l).toBeGreaterThan(e);
    expect(d2Game.evaluate(d2Game.step(makeState({ tick: 3599 }), IDLE), 0).danger).toBe(0);
  });

  it('已經結束的局：贏的一邊 gain 比輸的高很多', () => {
    const won = d2Game.step(
      makeState({ tick: 3599, players: [{ score: 40 }, { score: 1 }], bags: [0, 3] }),
      IDLE,
    );
    expect(d2Game.evaluate(won, 0).gain).toBeGreaterThan(d2Game.evaluate(won, 1).gain);
  });
});

describe('D-2 背包上限｜AI 在這張牌上會動腦', () => {
  it('貪心型（等級 10）自己一個人跑 3600 個 tick（對手不動）：至少存進 15 枚（光撿不存是 0 分）', () => {
    const seed = 4;
    const ai = levelController(d2Game, greedy, 10, seed);
    let state = d2Game.init(seed, CONFIG);
    for (let tick = 0; !d2Game.isOver(state); tick += 1) {
      state = d2Game.step(state, [ai.decide(state, 0, tick), NONE]);
    }
    expect(d2Game.score(state)[0]).toBeGreaterThanOrEqual(15);
    expect(d2Game.score(state)[1]).toBe(0);
  });
});
