import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { rngStateFor } from '../../core/rng';
import type { Buttons, Inputs } from '../../core/types';
import { cell, MOVE_EVERY, START_CELLS } from '../_diamonds/logic';
import {
  BEFORE_MOVE,
  CONFIG,
  describeSharedDiamondsRules,
  deepFreeze,
  IDLE,
  NONE,
  PRESS_DOWN,
  PRESS_LEFT,
  PRESS_RIGHT,
  PRESS_UP,
  run,
} from '../_diamonds/shared-rules.test-helpers';
import { dAGame, makeState } from './logic';
import type { DAState } from './logic';

/**
 * D-A 搶金幣的規則測試（TEST_PLAN 第 6 節 D-A 的 8 條）。
 * 1、2、3、6、7（牆、起點、走格、重疊、補東西）與種子有效寫在 `_diamonds/shared-rules.test-helpers.ts`，
 * D-2 與 D-3 共用同一組；這裡是 D-A 自己的 4、5、8，加上初始、評估、動作與整合。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 */

describeSharedDiamondsRules<DAState>({
  label: 'D-A 搶金幣',
  game: dAGame,
  makeState,
  pickupCells: (state) => state.coins,
  withPickups: (cells) => ({ coins: cells }),
  count: 6,
});

/** 兩個角色離得遠遠的、各有一組金幣的局面；下一次 step 是走格。 */
function arena(overrides: Parameters<typeof makeState>[0] = {}): DAState {
  return makeState({
    tick: BEFORE_MOVE,
    players: [{ cell: cell(5, 5) }, { cell: cell(25, 20) }],
    coins: [cell(6, 5), cell(15, 10), cell(16, 10), cell(17, 10), cell(18, 10), cell(19, 10)],
    ...overrides,
  });
}

describe('D-A 搶金幣｜TEST_PLAN 第 6 節', () => {
  it('初始：6 枚金幣，不重複、不在牆上、不在兩個起點；分數 0；人在左下、AI 在右上', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const state = dAGame.init(seed, CONFIG);
      expect(state.coins).toHaveLength(6);
      expect(new Set(state.coins).size).toBe(6);
      for (const c of state.coins) {
        expect(state.walls[c]).toBe(0);
        expect(START_CELLS).not.toContain(c);
      }
      expect(dAGame.score(state)).toEqual([0, 0]);
      expect(dAGame.winner(state)).toBeNull();
    }
  });

  it('4. 走到金幣格：分數加 1，在隨機空格補一枚，場上維持 6 枚（補的不在腳下、不在原來那格）', () => {
    const state = arena();
    const next = dAGame.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(cell(6, 5));
    expect(dAGame.score(next)).toEqual([1, 0]);
    expect(next.coins).toHaveLength(6);
    expect(new Set(next.coins).size).toBe(6);
    expect(next.coins).not.toContain(cell(6, 5));
    // 另外 5 枚原封不動。
    for (const c of state.coins.slice(1)) {
      expect(next.coins).toContain(c);
    }
  });

  it('4. 沒走到金幣：分數不變、金幣不變、亂數狀態不變', () => {
    const state = arena();
    const next = dAGame.step(state, [PRESS_DOWN, NONE]);
    expect(dAGame.score(next)).toEqual([0, 0]);
    expect(next.coins).toEqual(state.coins);
    expect(next.rng).toBe(state.rng);
  });

  it('4. 只在「走進」金幣格的那個 tick 撿：站在金幣上不動不會再得分', () => {
    const state = arena();
    let next = dAGame.step(state, [PRESS_RIGHT, NONE]);
    next = run(dAGame, next, MOVE_EVERY * 3, IDLE);
    expect(dAGame.score(next)).toEqual([1, 0]);
  });

  it('5. 兩個角色同一個 tick 走到同一枚：各加 1 分，只補一枚', () => {
    const state = arena({ players: [{ cell: cell(5, 5) }, { cell: cell(7, 5) }] });
    const next = dAGame.step(state, [PRESS_RIGHT, PRESS_LEFT]);
    expect(next.players[0].cell).toBe(cell(6, 5));
    expect(next.players[1].cell).toBe(cell(6, 5));
    expect(dAGame.score(next)).toEqual([1, 1]);
    expect(next.coins).toHaveLength(6);
    expect(next.coins).not.toContain(cell(6, 5));
    // 只補了一枚：原來 6 枚減一枚，加一枚新的，其餘 5 枚都在。
    const kept = state.coins.filter((c) => next.coins.includes(c));
    expect(kept).toHaveLength(5);
  });

  it('5. 兩個角色同一個 tick 各走到不同的金幣：各加 1 分，補兩枚（場上還是 6 枚）', () => {
    const state = arena({
      players: [{ cell: cell(5, 5) }, { cell: cell(10, 12) }],
      coins: [cell(6, 5), cell(9, 12), cell(15, 10), cell(16, 10), cell(17, 10), cell(18, 10)],
    });
    const next = dAGame.step(state, [PRESS_RIGHT, PRESS_LEFT]);
    expect(dAGame.score(next)).toEqual([1, 1]);
    expect(next.coins).toHaveLength(6);
    expect(new Set(next.coins).size).toBe(6);
    expect(next.coins).not.toContain(cell(6, 5));
    expect(next.coins).not.toContain(cell(9, 12));
  });

  it('5. 走格的那個 tick 兩人互換位置、各踩到對方原來的位置上的金幣：都算撿到', () => {
    const state = arena({
      players: [{ cell: cell(5, 5) }, { cell: cell(6, 5) }],
      coins: [cell(5, 5), cell(6, 5), cell(15, 10), cell(16, 10), cell(17, 10), cell(18, 10)],
    });
    const next = dAGame.step(state, [PRESS_RIGHT, PRESS_LEFT]);
    expect(dAGame.score(next)).toEqual([1, 1]);
    expect(next.coins).toHaveLength(6);
  });

  it('8. 3600 tick 到：分數高的贏（人領先 → 0，AI 領先 → 1）', () => {
    const base = { tick: 3599, players: [{ score: 5 }, { score: 3 }] } as const;
    const human = dAGame.step(makeState(base), IDLE);
    expect(dAGame.isOver(human)).toBe(true);
    expect(dAGame.winner(human)).toBe(0);
    const ai = dAGame.step(makeState({ tick: 3599, players: [{ score: 2 }, { score: 3 }] }), IDLE);
    expect(dAGame.isOver(ai)).toBe(true);
    expect(dAGame.winner(ai)).toBe(1);
  });

  it('8. 邊界：第 3599 個 tick 還沒結束；同分平手（winner 是 null）', () => {
    const before = dAGame.step(makeState({ tick: 3598 }), IDLE);
    expect(before.tick).toBe(3599);
    expect(dAGame.isOver(before)).toBe(false);
    expect(dAGame.winner(before)).toBeNull();
    const tie = dAGame.step(before, IDLE);
    expect(dAGame.isOver(tie)).toBe(true);
    expect(dAGame.winner(tie)).toBeNull();
  });

  it('8. 邊界：最後一個 tick（3600，同時是走格的 tick）撿到的金幣算分，而且因此翻盤', () => {
    const state = makeState({
      tick: 3599,
      players: [
        { cell: cell(5, 5), score: 4 },
        { cell: cell(25, 20), score: 5 },
      ],
      coins: [cell(6, 5), cell(15, 10), cell(16, 10), cell(17, 10), cell(18, 10), cell(19, 10)],
    });
    const next = dAGame.step(state, [PRESS_RIGHT, NONE]);
    expect(dAGame.score(next)).toEqual([5, 5]);
    expect(dAGame.winner(next)).toBeNull();
    const win = dAGame.step(
      makeState({
        tick: 3599,
        players: [
          { cell: cell(5, 5), score: 5 },
          { cell: cell(25, 20), score: 5 },
        ],
        coins: [cell(6, 5), cell(15, 10), cell(16, 10), cell(17, 10), cell(18, 10), cell(19, 10)],
      }),
      [PRESS_RIGHT, NONE],
    );
    expect(dAGame.winner(win)).toBe(0);
  });

  it('結束之後再 step：state 原樣不變（分數與贏家不會再動）', () => {
    const over = dAGame.step(
      makeState({ tick: 3599, players: [{ score: 2 }, { score: 1 }] }),
      IDLE,
    );
    expect(dAGame.step(over, [PRESS_RIGHT, PRESS_LEFT])).toEqual(over);
  });

  it('局還沒結束時 winner 是 null，分數不是結果', () => {
    const state = makeState({ players: [{ score: 9 }, { score: 0 }] });
    expect(dAGame.winner(state)).toBeNull();
  });

  it('種子有效：補金幣會推進亂數狀態；連續撿兩枚的兩次補位不是同一個位置', () => {
    const state = arena({ rng: rngStateFor(3, 'coins') });
    const once = dAGame.step(state, [PRESS_RIGHT, NONE]);
    expect(once.rng).not.toBe(state.rng);
    let twice = run(dAGame, once, MOVE_EVERY - 1, IDLE);
    twice = dAGame.step({ ...twice, coins: [cell(7, 5), ...twice.coins.slice(1)] }, [
      PRESS_RIGHT,
      NONE,
    ]);
    expect(twice.rng).not.toBe(once.rng);
    expect(dAGame.score(twice)[0]).toBe(2);
  });
});

describe('D-A 搶金幣｜動作與評估（給貪心型用）', () => {
  const stepWith = (state: DAState, side: 0 | 1, action: Buttons): DAState => {
    const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
    return dAGame.step(state, inputs);
  };

  it('actions：兩邊都是 5 個不同的動作，全放開排最後；沒有目標時 0 號邊是上、右、下、左，1 號邊轉 180 度（下、左、上、右）', () => {
    const state = makeState({ coins: [] });
    for (const side of [0, 1] as const) {
      const actions = dAGame.actions(state, side);
      expect(actions).toHaveLength(5);
      expect(new Set(actions.map((a) => JSON.stringify(a))).size).toBe(5);
      expect(actions[4]).toEqual(NONE);
    }
    expect(dAGame.actions(state, 0)).toEqual([PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT, NONE]);
    expect(dAGame.actions(state, 1)).toEqual([PRESS_DOWN, PRESS_LEFT, PRESS_UP, PRESS_RIGHT, NONE]);
  });

  it('actions：有目標時，最靠近目標的方向排最前面（搜尋型平手取排最前面的，才不會「再等一下」或往錯的方向）；全放開還是最後', () => {
    const right = makeState({
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      coins: [cell(14, 10)],
    });
    expect(dAGame.actions(right, 0)[0]).toEqual(PRESS_RIGHT);
    expect(dAGame.actions(right, 0)[4]).toEqual(NONE);
    const up = makeState({
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      coins: [cell(10, 4)],
    });
    expect(dAGame.actions(up, 0)[0]).toEqual(PRESS_UP);
    expect(dAGame.actions(up, 1)[4]).toEqual(NONE);
    // 1 號邊（右上角）：金幣在牠的下方 → 下排最前面。
    const down = makeState({
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      coins: [cell(30, 8)],
    });
    expect(dAGame.actions(down, 1)[0]).toEqual(PRESS_DOWN);
  });

  it('gain：往最近的金幣走一步（只看下一個 tick），比別的方向、比不動都高', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      coins: [cell(14, 10), cell(2, 20), cell(2, 21), cell(2, 22), cell(3, 20), cell(3, 21)],
    });
    const gains = [NONE, PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT].map(
      (a) => dAGame.evaluate(stepWith(state, 0, a), 0).gain,
    );
    const best = Math.max(...gains);
    expect(gains[2]).toBe(best);
    expect(gains.filter((g) => g === best)).toHaveLength(1);
  });

  it('gain：繞牆的最短路徑才算距離（金幣就在牆的另一邊，直走沒有比較近）', () => {
    // 牆立在 x=12，y 從 5 到 15；金幣在 (14, 10)。人在 (10, 10)：往右走一步靠牆，沒有變近；往上走才是繞出去的路。
    const wall = Array.from({ length: 11 }, (_v, i) => cell(12, 5 + i));
    const state = makeState({
      tick: 1,
      walls: wall,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      coins: [cell(14, 10)],
    });
    const right = dAGame.evaluate(stepWith(state, 0, PRESS_RIGHT), 0).gain;
    const up = dAGame.evaluate(stepWith(state, 0, PRESS_UP), 0).gain;
    const left = dAGame.evaluate(stepWith(state, 0, PRESS_LEFT), 0).gain;
    // 往右、往上都是「離繞路的最短路徑一步」：直走 (11,10) 到 (12,x) 的牆前，距離是繞到 y=4 或 y=16 再回來。
    expect(up).toBeGreaterThanOrEqual(right);
    expect(up).toBeGreaterThan(left);
  });

  it('gain：撿到一枚比任何靠近都重要（100 分），而且走格前後連續', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      coins: [cell(11, 10), cell(20, 10), cell(21, 10), cell(22, 10), cell(23, 10), cell(24, 10)],
    });
    const pending = dAGame.evaluate(stepWith(state, 0, PRESS_RIGHT), 0).gain;
    const idle = dAGame.evaluate(stepWith(state, 0, NONE), 0).gain;
    expect(pending - idle).toBeGreaterThan(80); // 100 分減掉下一枚金幣離得更遠的幾步
    // 真的走了格、撿到了：gain 與「還沒走格但已鎖定方向」差不多（差在遠處距離的幾格之內）。
    const moved = dAGame.evaluate(
      run(dAGame, stepWith(state, 0, PRESS_RIGHT), MOVE_EVERY - 1, IDLE),
      0,
    ).gain;
    expect(Math.abs(moved - pending)).toBeLessThan(50);
  });

  it('gain：對手比我更靠近的那一枚，gain 比較低（共用場地，搶不到的別去）', () => {
    const mine = {
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }] as const,
      coins: [cell(16, 10)],
    };
    const contested = {
      ...mine,
      players: [{ cell: cell(10, 10) }, { cell: cell(17, 10) }] as const,
    };
    const free = dAGame.evaluate(makeState(mine), 0).gain;
    const lost = dAGame.evaluate(makeState(contested), 0).gain;
    expect(lost).toBeLessThan(free);
  });

  it('gain：分數領先越多越高；對 1 號邊則相反', () => {
    const ahead = makeState({ players: [{ score: 5 }, { score: 2 }] });
    const behind = makeState({ players: [{ score: 2 }, { score: 5 }] });
    expect(dAGame.evaluate(ahead, 0).gain).toBeGreaterThan(dAGame.evaluate(behind, 0).gain);
    expect(dAGame.evaluate(ahead, 1).gain).toBeLessThan(dAGame.evaluate(behind, 1).gain);
  });

  it('danger：永遠在 0 到 1 之間；對手搶先時比較高；已結束的局是 0', () => {
    const safe = makeState({
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      coins: [cell(12, 10)],
    });
    const risky = makeState({
      players: [{ cell: cell(10, 10) }, { cell: cell(13, 10) }],
      coins: [cell(12, 10)],
    });
    const s = dAGame.evaluate(safe, 0).danger;
    const r = dAGame.evaluate(risky, 0).danger;
    expect(s).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
    expect(r).toBeGreaterThan(s);
    const over = dAGame.step(makeState({ tick: 3599 }), IDLE);
    expect(dAGame.evaluate(over, 0).danger).toBe(0);
    expect(dAGame.evaluate(makeState({ coins: [] }), 0).danger).toBe(0);
  });

  it('已經結束的局：贏的一邊 gain 比輸的高很多（不管分差多大）', () => {
    const won = dAGame.step(
      makeState({ tick: 3599, players: [{ score: 300 }, { score: 1 }] }),
      IDLE,
    );
    expect(dAGame.evaluate(won, 0).gain).toBeGreaterThan(dAGame.evaluate(won, 1).gain);
    expect(dAGame.evaluate(won, 0).gain).toBeGreaterThan(30_000);
  });

  it('評估函式不改動 state（凍結的 state 也能評估）', () => {
    const state = deepFreeze(makeState({ players: [{ cell: cell(10, 10), pending: 1 }, {}] }));
    expect(() => dAGame.evaluate(state, 0)).not.toThrow();
    expect(() => dAGame.evaluate(state, 1)).not.toThrow();
  });
});

describe('D-A 搶金幣｜AI 在這張牌上會動腦', () => {
  it('搜尋型（等級 5，往前看 3 步）自己一個人跑 3600 個 tick（對手不動）：至少撿 15 枚（不會一直「等一下再按」而不動）', () => {
    const seed = 4;
    const ai = levelController(dAGame, pathfinder, 5, seed);
    let state = dAGame.init(seed, CONFIG);
    for (let tick = 0; !dAGame.isOver(state); tick += 1) {
      state = dAGame.step(state, [ai.decide(state, 0, tick), NONE]);
    }
    expect(dAGame.score(state)[0]).toBeGreaterThanOrEqual(15);
  });

  it('貪心型（等級 10）自己一個人跑 3600 個 tick（對手不動）：至少撿 40 枚金幣', () => {
    const seed = 4;
    const ai = levelController(dAGame, greedy, 10, seed);
    let state = dAGame.init(seed, CONFIG);
    for (let tick = 0; !dAGame.isOver(state); tick += 1) {
      state = dAGame.step(state, [ai.decide(state, 0, tick), NONE]);
    }
    expect(dAGame.score(state)[0]).toBeGreaterThanOrEqual(40);
    expect(dAGame.score(state)[1]).toBe(0);
  });
});
