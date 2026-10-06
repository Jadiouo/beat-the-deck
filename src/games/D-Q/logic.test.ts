import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { copyButtons } from '../../core/match';
import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Controller, Inputs } from '../../core/types';
import { bfsDistances, cell, cellX, cellY, START_CELLS } from '../_diamonds/logic';
import {
  BEFORE_MOVE,
  CONFIG,
  deepFreeze,
  IDLE,
  NONE,
  PRESS_DOWN,
  PRESS_LEFT,
  PRESS_RIGHT,
  PRESS_UP,
  run,
} from '../_diamonds/shared-rules.test-helpers';
import {
  dQGame,
  hazardPermille,
  MAX_GAP,
  MIN_GAP,
  makeState,
  MINE_EVERY,
  SHARED_YIELD,
  SOLO_YIELD,
  zoneDistance,
  ZONE_RADIUS,
} from './logic';
import type { DQState } from './logic';

/**
 * D-Q 唯一的礦的規則測試。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 「塌不塌」是亂數：測試用 `rngWithRoll` 找出「下一次擲出來剛好是某個值」的 `RngState`，
 * 所以不用賭機率（決定第 5 條：擲出的值 < 塌的機率千分比 就塌）。
 */

const MINE = cell(15, 12);
const NEXT = cell(25, 20);
/** 離礦很遠、不會被礦坑範圍影響的格子。 */
const FAR_A = cell(2, 2);
const FAR_B = cell(28, 3);
/** 開挖的那個 tick 之前一個 tick（20 的倍數是開挖，也是走格）。 */
const BEFORE_EVENT = MINE_EVERY - 1;

/** 找一個 RngState，使 `intFrom(state, 1000)` 的第一個值滿足條件（找得到才回傳）。 */
function rngWithRoll(accept: (roll: number) => boolean): RngState {
  for (let i = 0; i < 200_000; i += 1) {
    const state = rngStateFor(i, 'roll');
    if (accept(intFrom(state, 1000)[0])) {
      return state;
    }
  }
  throw new Error('找不到符合的亂數狀態');
}
const NEVER_COLLAPSE = rngWithRoll((roll) => roll >= 999);
const ALWAYS_COLLAPSE = rngWithRoll((roll) => roll === 0);

/** 兩個人都在遠處，下一個 step 就是開挖。 */
function atEvent(overrides: Parameters<typeof makeState>[0] = {}): DQState {
  return makeState({
    tick: BEFORE_EVENT,
    mine: MINE,
    next: NEXT,
    players: [{ cell: FAR_A }, { cell: FAR_B }],
    rng: NEVER_COLLAPSE,
    ...overrides,
  });
}

describe('D-Q 唯一的礦｜初始', () => {
  it('開局：礦與下一個礦都不在牆上、也不在起點；兩個起點到礦的步數差不超過 1；下一個礦離礦 14 到 40 步（種子 0 到 59）', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const state = dQGame.init(seed, CONFIG);
      expect(state.walls[state.mine]).toBe(0);
      expect(state.walls[state.next]).toBe(0);
      expect(START_CELLS).not.toContain(state.mine);
      const d0 = bfsDistances(state.walls, START_CELLS[0])[state.mine] as number;
      const d1 = bfsDistances(state.walls, START_CELLS[1])[state.mine] as number;
      expect(Math.abs(d0 - d1)).toBeLessThanOrEqual(1);
      expect(Math.min(d0, d1)).toBeGreaterThanOrEqual(12);
      const gap = bfsDistances(state.walls, state.mine)[state.next] as number;
      expect(gap).toBeGreaterThanOrEqual(MIN_GAP);
      expect(gap).toBeLessThanOrEqual(MAX_GAP);
      expect(state.age).toBe(0);
      expect(state.carried).toEqual([0, 0]);
      expect(state.lost).toEqual([0, 0]);
      expect(state.collapses).toBe(0);
      expect(dQGame.score(state)).toEqual([0, 0]);
    }
  });

  it('種子有效：10 個不同的種子，開局的（礦，下一個礦）不全相同', () => {
    const layouts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const state = dQGame.init(seed, CONFIG);
      layouts.add(`${state.mine},${state.next}`);
    }
    expect(layouts.size).toBeGreaterThan(5);
  });
});

describe('D-Q 唯一的礦｜開挖', () => {
  it('1. 一個人站在礦上：開挖那一次身上加 SOLO_YIELD（2），分數不動；礦的 age 加 1', () => {
    const next = dQGame.step(atEvent({ players: [{ cell: MINE }, { cell: FAR_B }] }), IDLE);
    expect(SOLO_YIELD).toBe(2);
    expect(next.carried).toEqual([2, 0]);
    expect(dQGame.score(next)).toEqual([0, 0]);
    expect(next.age).toBe(1);
  });

  it('1. 兩個人都站在礦上：各加 SHARED_YIELD（1）；兩個人都不在：誰也沒有，但礦還是老 1 次', () => {
    const both = dQGame.step(atEvent({ players: [{ cell: MINE }, { cell: MINE }] }), IDLE);
    expect(SHARED_YIELD).toBe(1);
    expect(both.carried).toEqual([1, 1]);
    const none = dQGame.step(atEvent(), IDLE);
    expect(none.carried).toEqual([0, 0]);
    expect(none.age).toBe(1);
  });

  it('1. 邊界：不是開挖的 tick 不挖（第 1 到 19 個 tick 都沒有），第 20 個才挖；第 40 個再挖一次', () => {
    let state = makeState({
      mine: MINE,
      next: NEXT,
      players: [{ cell: MINE }, { cell: FAR_B }],
      rng: NEVER_COLLAPSE,
    });
    state = run(dQGame, state, MINE_EVERY - 1);
    expect(state.carried).toEqual([0, 0]);
    expect(state.age).toBe(0);
    state = dQGame.step(state, IDLE);
    expect(state.carried).toEqual([2, 0]);
    state = run(dQGame, state, MINE_EVERY);
    expect(state.carried).toEqual([4, 0]);
    expect(state.age).toBe(2);
  });

  it('1. 邊界：同一個 tick 剛好走進礦那一格（開挖的 tick 也是走格的 tick）：先走格、再開挖，挖得到', () => {
    const state = atEvent({ players: [{ cell: cell(14, 12) }, { cell: FAR_B }] });
    const next = dQGame.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(MINE);
    expect(next.carried[0]).toBe(2);
  });
});

describe('D-Q 唯一的礦｜礦石變成分數', () => {
  /** 一格一格的距離：用曼哈頓距離，走進 4 以上才結算。 */
  it('2. 邊界：走完之後距離礦剛好是 3（還在範圍內）：礦石還在身上；距離是 4：礦石變成分數', () => {
    expect(ZONE_RADIUS).toBe(3);
    const inside = dQGame.step(
      makeState({
        tick: BEFORE_MOVE,
        mine: MINE,
        next: NEXT,
        players: [{ cell: cell(17, 12) }, { cell: FAR_B }],
        carried: [5, 0],
      }),
      [PRESS_LEFT, NONE],
    );
    // 17 → 16：距離 1，還在範圍內。
    expect(inside.carried[0]).toBe(5);
    const edge = dQGame.step(
      makeState({
        tick: BEFORE_MOVE,
        mine: MINE,
        next: NEXT,
        players: [{ cell: cell(18, 12) }, { cell: FAR_B }],
        carried: [5, 0],
      }),
      [PRESS_LEFT, NONE],
    );
    // 18 → 17 是在往礦走：距離 2。
    expect(edge.carried[0]).toBe(5);
    const stay = dQGame.step(
      makeState({
        tick: BEFORE_MOVE,
        mine: MINE,
        next: NEXT,
        players: [{ cell: cell(18, 12) }, { cell: FAR_B }],
        carried: [5, 0],
      }),
      IDLE,
    );
    // 距離 3 還在範圍內（走格的 tick 也一樣）。
    expect(zoneDistance(cell(18, 12), MINE)).toBe(3);
    expect(stay.carried[0]).toBe(5);
    const out = dQGame.step(
      makeState({
        tick: BEFORE_MOVE,
        mine: MINE,
        next: NEXT,
        players: [{ cell: cell(18, 12) }, { cell: FAR_B }],
        carried: [5, 0],
      }),
      [PRESS_RIGHT, NONE],
    );
    expect(zoneDistance(cell(19, 12), MINE)).toBe(4);
    expect(out.carried[0]).toBe(0);
    expect(dQGame.score(out)[0]).toBe(5);
  });

  it('2. 結算只在走格的那個 tick：不是走格的 tick，距離 4 以上也不結算；到了走格的 tick 才結算', () => {
    const far = makeState({
      tick: 0,
      mine: MINE,
      next: NEXT,
      players: [{ cell: cell(20, 12) }, { cell: FAR_B }],
      carried: [3, 0],
    });
    const early = run(dQGame, far, 4);
    expect(early.carried[0]).toBe(3);
    const later = dQGame.step(early, IDLE);
    expect(later.carried[0]).toBe(0);
    expect(dQGame.score(later)[0]).toBe(3);
  });

  it('2. 兩個人各自結算，互不影響（各自的身上與分數）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      mine: MINE,
      next: NEXT,
      players: [
        { cell: cell(20, 12), score: 1 },
        { cell: cell(9, 12), score: 2 },
      ],
      carried: [3, 4],
    });
    const next = dQGame.step(state, IDLE);
    expect(next.carried).toEqual([0, 0]);
    expect(dQGame.score(next)).toEqual([4, 6]);
  });
});

describe('D-Q 唯一的礦｜塌', () => {
  it('3. 擲出的值剛好等於塌的機率（千分比）：不塌；小於：塌（age 0 → 1，機率 70）', () => {
    expect(hazardPermille(1)).toBe(70);
    const equal = rngWithRoll((roll) => roll === 70);
    const less = rngWithRoll((roll) => roll === 69);
    const kept = dQGame.step(
      atEvent({ rng: equal, players: [{ cell: MINE }, { cell: FAR_B }] }),
      IDLE,
    );
    expect(kept.mine).toBe(MINE);
    expect(kept.collapses).toBe(0);
    expect(kept.carried[0]).toBe(2);
    const fell = dQGame.step(
      atEvent({ rng: less, players: [{ cell: MINE }, { cell: FAR_B }] }),
      IDLE,
    );
    expect(fell.collapses).toBe(1);
    expect(fell.mine).toBe(NEXT);
  });

  it('3. 機率隨 age 上升：7% 乘 age，上限 100%；第 15 次開挖一定塌（擲出最大值 999 也塌）', () => {
    expect(hazardPermille(2)).toBe(140);
    expect(hazardPermille(10)).toBe(700);
    expect(hazardPermille(15)).toBe(1000);
    expect(hazardPermille(40)).toBe(1000);
    const state = atEvent({ age: 14, rng: NEVER_COLLAPSE });
    expect(dQGame.step(state, IDLE).collapses).toBe(1);
  });

  it('3. 塌了：範圍內的人身上的礦石作廢（記進 lost），範圍外的人不受影響；age 歸 0，礦移到下一個，下一個重挑', () => {
    const state = atEvent({
      age: 14,
      players: [{ cell: cell(16, 13) }, { cell: cell(2, 2) }],
      carried: [4, 3],
    });
    const next = dQGame.step(state, IDLE);
    expect(next.collapses).toBe(1);
    expect(next.mine).toBe(NEXT);
    expect(next.age).toBe(0);
    expect(next.next).not.toBe(NEXT);
    expect(next.walls[next.next]).toBe(0);
    expect(next.carried[0]).toBe(0);
    expect(next.lost[0]).toBe(4);
    // 另一個人離礦很遠（身上的 3 塊照理早就結算了，這裡是故意構造的）：不在範圍內，不受影響。
    expect(next.carried[1]).toBe(3);
    expect(next.lost[1]).toBe(0);
    expect(dQGame.score(next)).toEqual([0, 0]);
  });

  it('3. 邊界：礦坑範圍的邊上（距離 3）會丟礦石；同一個 tick 剛好走出去（距離 4）的人先結算，不丟', () => {
    const inEdge = dQGame.step(
      atEvent({ age: 14, players: [{ cell: cell(18, 12) }, { cell: FAR_B }], carried: [6, 0] }),
      IDLE,
    );
    expect(inEdge.lost[0]).toBe(6);
    const justOut = dQGame.step(
      atEvent({ age: 14, players: [{ cell: cell(18, 12) }, { cell: FAR_B }], carried: [6, 0] }),
      [PRESS_RIGHT, NONE],
    );
    expect(justOut.collapses).toBe(1);
    expect(justOut.lost[0]).toBe(0);
    expect(dQGame.score(justOut)[0]).toBe(6);
  });

  it('3. 同一個 tick 開挖又塌：剛挖到的那 2 塊也一起作廢', () => {
    const next = dQGame.step(
      atEvent({ age: 14, players: [{ cell: MINE }, { cell: FAR_B }], carried: [4, 0] }),
      IDLE,
    );
    expect(next.lost[0]).toBe(6);
    expect(next.carried[0]).toBe(0);
  });

  it('3. 沒有人在礦上也會老、也會塌（不會有永遠不塌的僵局）', () => {
    const next = dQGame.step(atEvent({ age: 14 }), IDLE);
    expect(next.collapses).toBe(1);
    expect(next.age).toBe(0);
  });

  it('3. 只有開挖的 tick 才擲骰：其他 tick 的 rng 原樣不動；開挖的 tick 一定換新的 rng', () => {
    const rest = dQGame.step(makeState({ mine: MINE, next: NEXT, rng: NEVER_COLLAPSE }), IDLE);
    expect(rest.rng).toBe(NEVER_COLLAPSE);
    const event = dQGame.step(atEvent(), IDLE);
    expect(event.rng).not.toBe(NEVER_COLLAPSE);
  });
});

describe('D-Q 唯一的礦｜隨機與種子', () => {
  it('K13 補強：連續兩次塌，下一個礦的位置會變（新的亂數狀態有寫回 state），而且種子 0 到 9 不全相同', () => {
    const chains = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const start = dQGame.init(seed, CONFIG);
      let state: DQState = { ...start, tick: BEFORE_EVENT, age: 14 };
      state = dQGame.step(state, IDLE);
      const first = state.next;
      expect(state.collapses).toBe(1);
      state = { ...state, tick: BEFORE_EVENT, age: 14 };
      state = dQGame.step(state, IDLE);
      expect(state.collapses).toBe(2);
      expect(state.mine).toBe(first);
      chains.add(`${start.mine},${start.next},${first},${state.next}`);
      // 連續兩次的新位置不可以相同（同一個亂數狀態會挑出同一格）。
      expect(state.next).not.toBe(first);
    }
    expect(chains.size).toBeGreaterThan(5);
  });

  it('同一個種子、同一串輸入，跑兩次結果相同', () => {
    const run1 = run(dQGame, dQGame.init(3, CONFIG), 400, [PRESS_RIGHT, PRESS_LEFT]);
    const run2 = run(dQGame, dQGame.init(3, CONFIG), 400, [PRESS_RIGHT, PRESS_LEFT]);
    expect(run1).toEqual(run2);
  });
});

describe('D-Q 唯一的礦｜結束與純度', () => {
  it('時間到：身上沒走出去的礦石不算分；分數高的贏；同分平手', () => {
    const over = dQGame.step(
      makeState({
        tick: 3599,
        mine: MINE,
        next: NEXT,
        players: [
          { cell: MINE, score: 3 },
          { cell: FAR_B, score: 5 },
        ],
        carried: [9, 0],
        rng: NEVER_COLLAPSE,
      }),
      IDLE,
    );
    expect(dQGame.isOver(over)).toBe(true);
    expect(dQGame.score(over)).toEqual([3, 5]);
    expect(dQGame.winner(over)).toBe(1);
    const tie = dQGame.step(makeState({ tick: 3599, rng: NEVER_COLLAPSE }), IDLE);
    expect(dQGame.winner(tie)).toBeNull();
  });

  it('結束之後再 step：state 原樣不變', () => {
    const over = dQGame.step(makeState({ tick: 3599, rng: NEVER_COLLAPSE }), IDLE);
    expect(dQGame.step(over, [PRESS_RIGHT, PRESS_LEFT])).toEqual(over);
  });

  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，包含塌的那一次）', () => {
    const calm = deepFreeze(atEvent({ players: [{ cell: MINE }, { cell: MINE }] }));
    expect(() => dQGame.step(calm, [PRESS_UP, PRESS_DOWN])).not.toThrow();
    const fall = deepFreeze(atEvent({ age: 14, carried: [2, 2] }));
    expect(() => dQGame.step(fall, IDLE)).not.toThrow();
    expect(fall.mine).toBe(MINE);
  });

  it('走格同其他方塊牌：5 個 tick 走一格、朝牆不動、兩人可以重疊', () => {
    const state = makeState({
      players: [{ cell: cell(5, 5) }, { cell: cell(7, 5) }],
      rng: NEVER_COLLAPSE,
    });
    const four = run(dQGame, state, 4, [PRESS_RIGHT, PRESS_LEFT]);
    expect(four.players[0].cell).toBe(cell(5, 5));
    const five = dQGame.step(four, [PRESS_RIGHT, PRESS_LEFT]);
    expect(five.players[0].cell).toBe(cell(6, 5));
    expect(five.players[1].cell).toBe(cell(6, 5));
    const wall = makeState({
      tick: BEFORE_MOVE,
      walls: [cell(6, 5)],
      players: [{ cell: cell(5, 5) }, {}],
    });
    expect(dQGame.step(wall, [PRESS_RIGHT, NONE]).players[0].cell).toBe(cell(5, 5));
  });
});

describe('D-Q 唯一的礦｜動作與評估', () => {
  const ACTIONS: readonly Buttons[] = [PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT, NONE];
  const gainsOf = (state: DQState, side: 0 | 1): number[] =>
    ACTIONS.map((action) => {
      const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
      return dQGame.evaluate(dQGame.step(state, inputs), side).gain;
    });
  const dangersOf = (state: DQState, side: 0 | 1): number[] =>
    ACTIONS.map((action) => {
      const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
      return dQGame.evaluate(dQGame.step(state, inputs), side).danger;
    });

  it('actions：五個不同的動作，往礦靠近得越多的方向排最前面，全放開排最後', () => {
    const state = makeState({ players: [{ cell: cell(10, 12) }, { cell: FAR_B }] });
    const actions = dQGame.actions(state, 0);
    expect(actions).toHaveLength(5);
    expect(new Set(actions.map((a) => JSON.stringify(a))).size).toBe(5);
    expect(actions[0]).toEqual(PRESS_RIGHT);
    expect(actions[4]).toEqual(NONE);
    expect(dQGame.actions(state, 1)[4]).toEqual(NONE);
  });

  it('gain：站在礦上比走開高（貪心型一直待著）；離礦越近越高', () => {
    const on = makeState({ tick: 1, players: [{ cell: MINE }, { cell: FAR_B }] });
    const gains = gainsOf(on, 0);
    expect(gains[4]).toBe(Math.max(...gains));
    const away = makeState({ tick: 1, players: [{ cell: cell(8, 12) }, { cell: FAR_B }] });
    const toward = gainsOf(away, 0);
    expect(toward.indexOf(Math.max(...toward))).toBe(1);
  });

  it('gain：身上的礦石算進去（比存起來的少），分數更高；對 1 號邊相反', () => {
    const none = makeState();
    const carried = makeState({ carried: [2, 0] });
    const scored = makeState({ players: [{ score: 2 }, {}] });
    expect(dQGame.evaluate(carried, 0).gain).toBeGreaterThan(dQGame.evaluate(none, 0).gain);
    expect(dQGame.evaluate(scored, 0).gain).toBeGreaterThan(dQGame.evaluate(carried, 0).gain);
    expect(dQGame.evaluate(carried, 1).gain).toBeLessThan(dQGame.evaluate(none, 1).gain);
  });

  it('gain：下一步就會走出範圍而且身上有礦石，當作已經存進去（比留在範圍裡高）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      mine: MINE,
      next: NEXT,
      players: [{ cell: cell(18, 12) }, { cell: FAR_B }],
      carried: [5, 0],
    });
    const gains = gainsOf(state, 0);
    // 往右走（走出範圍）比待著高很多：差大約 (100 − CARRY_WEIGHT) × 5。
    expect(gains[1]).toBeGreaterThan((gains[4] as number) + 100);
  });

  it('danger：永遠在 0 到 1；age 越大越高；身上越多越高；走出去（exit 越小）越低；身上是空的而且不在礦上是 0；已結束的局是 0', () => {
    const base = {
      tick: 1,
      players: [{ cell: MINE }, { cell: FAR_B }] as const,
      carried: [4, 0] as const,
    };
    const young = dQGame.evaluate(makeState({ ...base, age: 1 }), 0).danger;
    const old = dQGame.evaluate(makeState({ ...base, age: 9 }), 0).danger;
    expect(young).toBeGreaterThanOrEqual(0);
    expect(old).toBeLessThanOrEqual(1);
    expect(old).toBeGreaterThan(young);
    const heavy = dQGame.evaluate(makeState({ ...base, age: 9, carried: [10, 0] }), 0).danger;
    expect(heavy).toBeGreaterThan(old);
    const outer = dQGame.evaluate(
      makeState({ ...base, age: 9, players: [{ cell: cell(18, 12) }, { cell: FAR_B }] }),
      0,
    ).danger;
    expect(outer).toBeLessThan(old);
    const safe = dQGame.evaluate(
      makeState({ tick: 1, age: 9, players: [{ cell: cell(2, 2) }, { cell: FAR_B }] }),
      0,
    ).danger;
    expect(safe).toBe(0);
    const over = dQGame.step(makeState({ tick: 3599, rng: NEVER_COLLAPSE }), IDLE);
    expect(dQGame.evaluate(over, 0).danger).toBe(0);
  });

  it('danger：往外走一步會比待著低（精準型才有方向退出）', () => {
    const state = makeState({
      tick: 1,
      age: 10,
      players: [{ cell: MINE }, { cell: FAR_B }],
      carried: [8, 0],
    });
    const dangers = dangersOf(state, 0);
    expect(dangers[1]).toBeLessThan(dangers[4] as number);
  });

  it('已經結束的局：贏的一邊 gain 比輸的高很多', () => {
    const won = dQGame.step(
      makeState({ tick: 3599, players: [{ score: 40 }, { score: 1 }], rng: NEVER_COLLAPSE }),
      IDLE,
    );
    expect(dQGame.evaluate(won, 0).gain).toBeGreaterThan(dQGame.evaluate(won, 1).gain);
  });
});

describe('D-Q 唯一的礦｜性格（黑箱：用 decide 看四個性格真的做出不同的事）', () => {
  const params = { depth: 6, seed: 1 };
  /** 站在礦上、身上 8 塊、礦已經開挖 11 次（下一次塌的機率 84%）：該走了。 */
  const old = makeState({
    tick: 1,
    age: 11,
    mine: MINE,
    next: NEXT,
    players: [{ cell: MINE }, { cell: FAR_B }],
    carried: [8, 0],
  });
  /** 站在礦上、身上 2 塊、礦才開挖 1 次：該留下。 */
  const young = makeState({
    tick: 1,
    age: 1,
    mine: MINE,
    next: NEXT,
    players: [{ cell: MINE }, { cell: FAR_B }],
    carried: [2, 0],
  });

  it('貪心型：老礦、身上很多也不走（留到塌）', () => {
    expect(greedy.decide(dQGame, old, 0, 1, params)).toEqual(NONE);
  });

  it('精準型：老礦、身上很多就退出（不是全放開）；年輕的礦還會留', () => {
    expect(precise.decide(dQGame, old, 0, 1, params)).not.toEqual(NONE);
    expect(precise.decide(dQGame, young, 0, 1, params)).toEqual(NONE);
  });

  it('搜尋型：老礦、身上很多也會退出；年輕的礦還會留', () => {
    expect(pathfinder.decide(dQGame, old, 0, 1, params)).not.toEqual(NONE);
    expect(pathfinder.decide(dQGame, young, 0, 1, params)).toEqual(NONE);
  });

  it('賭徒型：領先時像精準型保守（老礦會退出）；大幅落後時反而留下', () => {
    const ahead = makeState({
      ...old,
      players: [
        { cell: MINE, score: 30 },
        { cell: FAR_B, score: 0 },
      ],
    });
    const behind = makeState({
      ...old,
      players: [
        { cell: MINE, score: 0 },
        { cell: FAR_B, score: 60 },
      ],
    });
    expect(gambler.decide(dQGame, ahead, 0, 1, params)).not.toEqual(NONE);
    expect(gambler.decide(dQGame, behind, 0, 1, params)).toEqual(NONE);
  });
});

describe('D-Q 唯一的礦｜四個性格互打（整場，種子 0 到 11）', () => {
  /** 兩邊用同一個性格、等級 10，跑 12 場，回傳整場被作廢的礦石總數與進入又離開礦坑範圍的次數。 */
  function fingerprint(policy: typeof greedy): { lostPerMatch: number; carriedScore: number } {
    let lost = 0;
    let scored = 0;
    const seeds = 12;
    for (let seed = 0; seed < seeds; seed += 1) {
      const a = levelController(dQGame, policy, 10, seed);
      const b = levelController(dQGame, policy, 10, seed + 1_000_003);
      let state = dQGame.init(seed, CONFIG);
      for (let tick = 0; !dQGame.isOver(state); tick += 1) {
        const inputs: Inputs = [
          copyButtons((a as Controller<DQState>).decide(state, 0, tick)),
          copyButtons((b as Controller<DQState>).decide(state, 1, tick)),
        ];
        state = dQGame.step(state, inputs);
      }
      lost += state.lost[0] + state.lost[1];
      scored += state.players[0].score + state.players[1].score;
    }
    return { lostPerMatch: lost / (2 * seeds), carriedScore: scored / (2 * seeds) };
  }

  it('貪心型每場被埋掉的礦石，至少是精準型的 2 倍（指紋：留太久 vs 準時退出）', () => {
    const greedyPrint = fingerprint(greedy);
    const precisePrint = fingerprint(precise);
    expect(greedyPrint.lostPerMatch).toBeGreaterThanOrEqual(2 * precisePrint.lostPerMatch);
    expect(precisePrint.carriedScore).toBeGreaterThan(0);
  });
});

describe('D-Q 唯一的礦｜互動強度（DESIGN-AI-FUN 2.5）', () => {
  it('把 AI 換到另一個合法位置，人這一邊 1 步 evaluate 的最好動作會跟著改變的局面，至少 20%', () => {
    const ACTIONS: readonly Buttons[] = [PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT, NONE];
    const bestFor = (state: DQState): number => {
      let best = 0;
      let bestValue = Number.NEGATIVE_INFINITY;
      ACTIONS.forEach((action, index) => {
        const value = dQGame.evaluate(dQGame.step(state, [action, NONE]), 0).gain;
        if (value > bestValue) {
          bestValue = value;
          best = index;
        }
      });
      return best;
    };
    // 抽 200 個局面：兩個貪心型打（等級 10）、每隔一段時間抽一個；
    // 對每個局面，把 AI 換到「礦上」與「離礦很遠」各一次，看人的最好動作有沒有因此不同。
    const samples: DQState[] = [];
    for (let seed = 0; seed < 20 && samples.length < 200; seed += 1) {
      const a = levelController(dQGame, precise, 10, seed);
      const b = levelController(dQGame, precise, 10, seed + 1_000_003);
      let state = dQGame.init(seed, CONFIG);
      for (let tick = 0; !dQGame.isOver(state); tick += 1) {
        if (tick % 18 === 9 && samples.length < 200) {
          samples.push(state);
        }
        state = dQGame.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    let changed = 0;
    for (const sample of samples) {
      const onMine = {
        ...sample,
        players: [
          sample.players[0],
          { ...sample.players[1], cell: sample.mine, pending: -1 as const },
        ] as const,
      };
      const away = {
        ...sample,
        players: [
          sample.players[0],
          {
            ...sample.players[1],
            cell: cell(cellX(sample.mine) > 16 ? 1 : 30, cellY(sample.mine) > 11 ? 1 : 22),
            pending: -1 as const,
          },
        ] as const,
      };
      if (bestFor(onMine as DQState) !== bestFor(away as DQState)) {
        changed += 1;
      }
    }
    expect(samples.length).toBeGreaterThanOrEqual(150);
    expect(changed / samples.length).toBeGreaterThanOrEqual(0.2);
  });
});
