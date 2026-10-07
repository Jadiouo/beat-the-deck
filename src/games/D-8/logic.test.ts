import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { greedy } from '../../ai/policies/greedy';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import { copyButtons } from '../../core/match';
import type { Buttons, Inputs } from '../../core/types';
import { CELLS, cell, cellX, cellY, generateWalls, START_CELLS } from '../_diamonds/logic';
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
import { d8Game, makeState, POCKET_MAX, PROTECT_TICKS } from './logic';
import type { D8State } from './logic';

/**
 * D-8 塗地的規則測試。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 圈地用「一個只有一個門的房間」構造：房間的牆是房間四周的格子，門是唯一沒有牆的那一格，
 * 站在門外的人走進門，那一步把門塗成自己的顏色、房間裡的空地整塊歸他。
 */

const NEAR_A = cell(5, 5);
const FAR_B = cell(25, 18);

/** 房間：內部格子（`interior`）、門（`door`）與四周的牆（`walls`）。 */
function room(interior: readonly number[], door: number): { walls: number[]; door: number } {
  const inside = new Set(interior);
  const walls = new Set<number>();
  for (const c of interior) {
    const x = cellX(c);
    const y = cellY(c);
    for (const [nx, ny] of [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ] as const) {
      const n = cell(nx, ny);
      if (!inside.has(n) && n !== door) {
        walls.add(n);
      }
    }
  }
  return { walls: [...walls], door };
}

/** 5 × 8 = 40 格的房間，門在下方 (12, 13)。 */
function rectangle(): number[] {
  const out: number[] = [];
  for (let y = 5; y <= 12; y += 1) {
    for (let x = 10; x <= 14; x += 1) {
      out.push(cell(x, y));
    }
  }
  return out;
}
const DOOR = cell(12, 13);
const OUTSIDE = cell(12, 14);

/** 0 號站在門外、下一個走格就走進門；1 號在遠處（不在房間裡）。 */
function atDoor(
  interior: readonly number[],
  overrides: Parameters<typeof makeState>[0] = {},
): D8State {
  const { walls } = room(interior, DOOR);
  return makeState({
    tick: BEFORE_MOVE,
    walls,
    players: [{ cell: OUTSIDE }, { cell: FAR_B }],
    paint0: [OUTSIDE],
    paint1: [FAR_B],
    ...overrides,
  });
}

describe('D-8 塗地｜開局與塗色', () => {
  it('開局：兩個起點各是自己的顏色，分數 1 比 1；牆不在起點上；其他格子沒人塗過（種子 0 到 29）', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const state = d8Game.init(seed, CONFIG);
      expect(state.paint).toHaveLength(CELLS);
      expect(state.paint[START_CELLS[0]]).toBe(1);
      expect(state.paint[START_CELLS[1]]).toBe(2);
      expect(state.paint.filter((p) => p !== 0)).toHaveLength(2);
      expect(d8Game.score(state)).toEqual([1, 1]);
      expect(state.walls[START_CELLS[0]]).toBe(0);
      expect(state.walls[START_CELLS[1]]).toBe(0);
    }
  });

  it('種子有效：種子 0 到 9 的牆不全相同（這張牌唯一的隨機是地圖）', () => {
    const layouts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      layouts.add(d8Game.init(seed, CONFIG).walls.join(''));
      expect(d8Game.init(seed, CONFIG).walls).toEqual(generateWalls(seed).walls);
    }
    expect(layouts.size).toBeGreaterThan(5);
  });

  it('1. 走進沒人塗過的格子：變成我的顏色，我的分數 +1，對手不變', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: NEAR_A }, { cell: FAR_B }],
      paint0: [NEAR_A],
      paint1: [FAR_B],
    });
    const next = d8Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(cell(6, 5));
    expect(next.paint[cell(6, 5)]).toBe(1);
    expect(d8Game.score(next)).toEqual([2, 1]);
  });

  it('2. 走進對手塗過的格子：塗回來，我 +1、對手 −1（差 2）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: NEAR_A }, { cell: FAR_B }],
      paint0: [NEAR_A],
      paint1: [FAR_B, cell(6, 5), cell(7, 5)],
    });
    const next = d8Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.paint[cell(6, 5)]).toBe(1);
    expect(next.paint[cell(7, 5)]).toBe(2);
    expect(d8Game.score(next)).toEqual([2, 2]);
  });

  it('2. 走進自己塗過的格子：什麼都沒變；站著不動，走格結算時重塗自己腳下也沒有效果', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: NEAR_A }, { cell: FAR_B }],
      paint0: [NEAR_A, cell(6, 5)],
      paint1: [FAR_B],
    });
    expect(d8Game.score(d8Game.step(state, [PRESS_RIGHT, NONE]))).toEqual([2, 1]);
    expect(d8Game.score(d8Game.step(state, IDLE))).toEqual([2, 1]);
  });

  it('3. 剛塗上去的顏色在保護期內塗不掉：邊界是 PROTECT_TICKS（差 1 個 tick 還在保護，剛好滿就塗得掉）；自己的顏色不重新計時', () => {
    expect(PROTECT_TICKS).toBe(60);
    // 下一個 step 是第 5 個 tick。格子在第 −55 個 tick 塗的 → 年齡 60，塗得掉；−54 → 年齡 59，還在保護。
    const make = (stampedAt: number): D8State =>
      makeState({
        tick: BEFORE_MOVE,
        players: [{ cell: NEAR_A }, { cell: FAR_B }],
        paint0: [NEAR_A],
        paint1: [FAR_B, cell(6, 5)],
        stamps: [[cell(6, 5), stampedAt]],
      });
    const ok = d8Game.step(make(5 - PROTECT_TICKS), [PRESS_RIGHT, NONE]);
    expect(ok.paint[cell(6, 5)]).toBe(1);
    expect(ok.stamp[cell(6, 5)]).toBe(5);
    const guarded = d8Game.step(make(5 - PROTECT_TICKS + 1), [PRESS_RIGHT, NONE]);
    expect(guarded.paint[cell(6, 5)]).toBe(2);
    expect(guarded.players[0].cell).toBe(cell(6, 5));
    expect(d8Game.score(guarded)).toEqual([1, 2]);
    // 走進自己的顏色：不換顏色、時間戳也不動。
    const own = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: NEAR_A }, { cell: FAR_B }],
      paint0: [NEAR_A, cell(6, 5)],
      paint1: [FAR_B],
      stamps: [[cell(6, 5), -3]],
    });
    expect(d8Game.step(own, [PRESS_RIGHT, NONE]).stamp[cell(6, 5)]).toBe(-3);
  });

  it('3. 塗回來之後對手不能馬上塗回去（兩個人在相鄰的格子不會互相塗來塗去）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(5, 5) }, { cell: cell(7, 5) }],
      paint0: [cell(5, 5)],
      paint1: [cell(7, 5), cell(6, 5)],
    });
    // 0 號走進 (6, 5) 塗回來；下一次走格 1 號走進同一格，被保護，塗不回去。
    const first = d8Game.step(state, [PRESS_RIGHT, NONE]);
    expect(first.paint[cell(6, 5)]).toBe(1);
    const second = run(
      d8Game,
      { ...first, players: [{ ...first.players[0], cell: cell(5, 5) }, first.players[1]] },
      5,
      [NONE, PRESS_LEFT],
    );
    expect(second.players[1].cell).toBe(cell(6, 5));
    expect(second.paint[cell(6, 5)]).toBe(1);
  });

  it('3. 邊界：不是走格的 tick 不塗（第 1 到 4 個 tick 都沒有），第 5 個才塗', () => {
    const state = makeState({
      players: [{ cell: NEAR_A }, { cell: FAR_B }],
      paint0: [NEAR_A],
      paint1: [FAR_B],
    });
    const four = run(d8Game, state, 4, [PRESS_RIGHT, NONE]);
    expect(four.paint[cell(6, 5)]).toBe(0);
    const five = d8Game.step(four, [PRESS_RIGHT, NONE]);
    expect(five.paint[cell(6, 5)]).toBe(1);
  });

  it('4. 邊界：兩個人這次走格結算後站在同一格：那一格誰也不塗（沒人塗過的維持沒人塗過；有顏色的維持原來的顏色）', () => {
    const empty = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(5, 5) }, { cell: cell(7, 5) }],
      paint0: [cell(5, 5)],
      paint1: [cell(7, 5)],
    });
    const meet = d8Game.step(empty, [PRESS_RIGHT, PRESS_LEFT]);
    expect(meet.players[0].cell).toBe(cell(6, 5));
    expect(meet.players[1].cell).toBe(cell(6, 5));
    expect(meet.paint[cell(6, 5)]).toBe(0);
    const owned = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(5, 5) }, { cell: cell(6, 5) }],
      paint0: [cell(5, 5)],
      paint1: [cell(6, 5)],
    });
    // 1 號站著不動、0 號走進它的格子：同一格，維持 1 號的顏色。
    const stay = d8Game.step(owned, [PRESS_RIGHT, NONE]);
    expect(stay.paint[cell(6, 5)]).toBe(2);
    expect(d8Game.score(stay)).toEqual([1, 1]);
  });

  it('朝牆走不動、不塗牆；兩個人可以互換位置（各塗對方原來的格子）', () => {
    const wall = makeState({
      tick: BEFORE_MOVE,
      walls: [cell(6, 5)],
      players: [{ cell: NEAR_A }, { cell: FAR_B }],
      paint0: [NEAR_A],
      paint1: [FAR_B],
    });
    const bump = d8Game.step(wall, [PRESS_RIGHT, NONE]);
    expect(bump.players[0].cell).toBe(NEAR_A);
    expect(bump.paint[cell(6, 5)]).toBe(0);
    const swap = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(5, 5) }, { cell: cell(6, 5) }],
      paint0: [cell(5, 5)],
      paint1: [cell(6, 5)],
    });
    const swapped = d8Game.step(swap, [PRESS_RIGHT, PRESS_LEFT]);
    expect(swapped.players[0].cell).toBe(cell(6, 5));
    expect(swapped.players[1].cell).toBe(cell(5, 5));
    expect(swapped.paint[cell(6, 5)]).toBe(1);
    expect(swapped.paint[cell(5, 5)]).toBe(2);
  });
});

describe('D-8 塗地｜不能直接掉頭', () => {
  const start = (): D8State =>
    makeState({
      players: [{ cell: cell(5, 5) }, { cell: cell(25, 18) }],
      paint0: [cell(5, 5)],
      paint1: [cell(25, 18)],
    });

  it('10. 走格之後 heading 是剛走的方向；撞牆沒走成是 -1', () => {
    const moved = run(d8Game, start(), 5, [PRESS_RIGHT, NONE]);
    expect(moved.heading[0]).toBe(1);
    expect(moved.heading[1]).toBe(-1);
    const bumped = run(
      d8Game,
      makeState({
        walls: [cell(6, 5)],
        players: [{ cell: cell(5, 5) }, { cell: FAR_B }],
        paint0: [cell(5, 5)],
        paint1: [FAR_B],
      }),
      5,
      [PRESS_RIGHT, NONE],
    );
    expect(bumped.heading[0]).toBe(-1);
  });

  it('10. 往右走了一格之後按左（直接掉頭）：當作沒按，下一次走格不動；按上就轉彎走得動', () => {
    const moved = run(d8Game, start(), 5, [PRESS_RIGHT, NONE]);
    expect(moved.players[0].cell).toBe(cell(6, 5));
    const back = run(d8Game, moved, 5, [PRESS_LEFT, NONE]);
    expect(back.players[0].cell).toBe(cell(6, 5));
    expect(back.players[0].pending).toBe(-1);
    const turn = run(d8Game, moved, 5, [PRESS_UP, NONE]);
    expect(turn.players[0].cell).toBe(cell(6, 4));
  });

  it('10. 邊界：同一個週期裡先按掉頭、再按轉彎：轉彎算（掉頭沒有清掉也沒有鎖定）；先按轉彎再按掉頭：轉彎留著', () => {
    const moved = run(d8Game, start(), 5, [PRESS_RIGHT, NONE]);
    const first = d8Game.step(d8Game.step(moved, [PRESS_LEFT, NONE]), [PRESS_UP, NONE]);
    expect(first.players[0].pending).toBe(0);
    const second = d8Game.step(d8Game.step(moved, [PRESS_UP, NONE]), [PRESS_LEFT, NONE]);
    expect(second.players[0].pending).toBe(0);
  });

  it('10. 撞牆沒走成之後可以掉頭（死巷走得出來）', () => {
    const state = makeState({
      walls: [cell(6, 5)],
      players: [{ cell: cell(5, 5) }, { cell: FAR_B }],
      paint0: [cell(5, 5)],
      paint1: [FAR_B],
    });
    const bumped = run(d8Game, state, 5, [PRESS_RIGHT, NONE]);
    expect(bumped.players[0].cell).toBe(cell(5, 5));
    const back = run(d8Game, bumped, 5, [PRESS_LEFT, NONE]);
    expect(back.players[0].cell).toBe(cell(4, 5));
  });
});

describe('D-8 塗地｜圈地', () => {
  it('5. 把只有一個門的房間（40 格）的門塗成自己的顏色：房間整塊歸我（40 格 + 門）', () => {
    expect(POCKET_MAX).toBe(40);
    const interior = rectangle();
    expect(interior).toHaveLength(40);
    const next = d8Game.step(atDoor(interior), [PRESS_UP, NONE]);
    expect(next.players[0].cell).toBe(DOOR);
    for (const c of interior) {
      expect(next.paint[c]).toBe(1);
    }
    // 起始的 OUTSIDE 與 DOOR 各 1，加上房間 40 格。
    expect(d8Game.score(next)[0]).toBe(1 + 1 + 40);
  });

  it('5. 邊界：房間 41 格就不算（超過 POCKET_MAX）；只塗到門，房間維持沒人塗過', () => {
    const interior = [...rectangle(), cell(15, 12)];
    expect(interior).toHaveLength(41);
    const next = d8Game.step(atDoor(interior), [PRESS_UP, NONE]);
    expect(next.paint[DOOR]).toBe(1);
    for (const c of interior) {
      expect(next.paint[c]).toBe(0);
    }
    expect(d8Game.score(next)[0]).toBe(2);
  });

  it('6. 切斷：房間裡有對手塗過的格子，也一起歸我（對手 −N、我 +N）', () => {
    const interior = rectangle();
    const theirs = [cell(10, 5), cell(11, 5), cell(12, 6)];
    const next = d8Game.step(atDoor(interior, { paint1: [FAR_B, ...theirs] }), [PRESS_UP, NONE]);
    for (const c of theirs) {
      expect(next.paint[c]).toBe(1);
    }
    expect(d8Game.score(next)).toEqual([1 + 1 + 40, 1]);
  });

  it('7. 對手本人在房間裡就不算：房間維持原樣（它隨時可以走出來）', () => {
    const interior = rectangle();
    const next = d8Game.step(
      atDoor(interior, {
        players: [{ cell: OUTSIDE }, { cell: cell(12, 8) }],
        paint1: [cell(12, 8)],
      }),
      [PRESS_UP, NONE],
    );
    expect(next.paint[cell(11, 8)]).toBe(0);
    expect(next.paint[cell(12, 8)]).toBe(2);
    expect(next.paint[DOOR]).toBe(1);
  });

  it('8. 不在走格的 tick 不圈地（圈地只在走格結算時）', () => {
    const interior = rectangle();
    const early = d8Game.step({ ...atDoor(interior), tick: 0 }, [PRESS_UP, NONE]);
    expect(early.paint[cell(12, 12)]).toBe(0);
  });
});

describe('D-8 塗地｜結束與純度', () => {
  it('時間到：顏色格子多的贏；一樣多平手', () => {
    const win = d8Game.step(
      makeState({
        tick: 3599,
        players: [{ cell: NEAR_A }, { cell: FAR_B }],
        paint0: [NEAR_A, cell(1, 1), cell(2, 2)],
        paint1: [FAR_B],
      }),
      IDLE,
    );
    expect(d8Game.isOver(win)).toBe(true);
    expect(d8Game.score(win)).toEqual([3, 1]);
    expect(d8Game.winner(win)).toBe(0);
    const tie = d8Game.step(
      makeState({
        tick: 3599,
        players: [{ cell: NEAR_A }, { cell: FAR_B }],
        paint0: [NEAR_A],
        paint1: [FAR_B],
      }),
      IDLE,
    );
    expect(d8Game.winner(tie)).toBeNull();
  });

  it('時間到的那一步（也是走格的 tick）撿到的格子算分；結束之後再 step：state 原樣不變', () => {
    const last = d8Game.step(
      makeState({
        tick: 3599,
        players: [{ cell: NEAR_A }, { cell: FAR_B }],
        paint0: [NEAR_A],
        paint1: [FAR_B],
      }),
      [PRESS_RIGHT, NONE],
    );
    expect(d8Game.score(last)).toEqual([2, 1]);
    expect(d8Game.step(last, [PRESS_LEFT, PRESS_DOWN])).toEqual(last);
  });

  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，包含圈地的那一次）', () => {
    const frozen = deepFreeze(atDoor(rectangle()));
    expect(() => d8Game.step(frozen, [PRESS_UP, NONE])).not.toThrow();
    expect(frozen.paint[DOOR]).toBe(0);
    const walk = deepFreeze(makeState({ tick: BEFORE_MOVE, paint0: [START_CELLS[0]] }));
    expect(() => d8Game.step(walk, [PRESS_UP, PRESS_DOWN])).not.toThrow();
  });

  it('走格同其他方塊牌：5 個 tick 走一格、四個方向都走得動、兩人可以重疊', () => {
    const state = makeState({
      players: [{ cell: cell(10, 10) }, { cell: cell(20, 20) }],
      paint0: [cell(10, 10)],
      paint1: [cell(20, 20)],
    });
    for (const [button, expected] of [
      [PRESS_UP, cell(10, 9)],
      [PRESS_RIGHT, cell(11, 10)],
      [PRESS_DOWN, cell(10, 11)],
      [PRESS_LEFT, cell(9, 10)],
    ] as [Buttons, number][]) {
      expect(run(d8Game, state, 5, [button, NONE]).players[0].cell).toBe(expected);
    }
    expect(run(d8Game, state, 4, [PRESS_RIGHT, NONE]).players[0].cell).toBe(cell(10, 10));
  });
});

describe('D-8 塗地｜動作與評估', () => {
  const ACTIONS: readonly Buttons[] = [PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT, NONE];
  const gainsOf = (state: D8State, side: 0 | 1): number[] =>
    ACTIONS.map((action) => {
      const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
      return d8Game.evaluate(d8Game.step(state, inputs), side).gain;
    });
  const dangersOf = (state: D8State, side: 0 | 1): number[] =>
    ACTIONS.map((action) => {
      const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
      return d8Game.evaluate(d8Game.step(state, inputs), side).danger;
    });
  const [ACT_UP, ACT_RIGHT, ACT_DOWN, ACT_LEFT, ACT_NONE] = [0, 1, 2, 3, 4];
  void ACT_UP;
  void ACT_DOWN;

  it('actions：五個不同的動作，全放開排最後', () => {
    const state = makeState();
    for (const side of [0, 1] as const) {
      const actions = d8Game.actions(state, side);
      expect(actions).toHaveLength(5);
      expect(new Set(actions.map((a) => JSON.stringify(a))).size).toBe(5);
      expect(actions[4]).toEqual(NONE);
    }
  });

  it('gain：旁邊一格沒人塗過、另一格是對手的：走進對手的那一格最高（差 2 比 +1 值錢）', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      paint0: [cell(10, 10), cell(10, 9), cell(10, 11)],
      paint1: [cell(30, 1), cell(11, 10)],
    });
    const gains = gainsOf(state, 0);
    expect(gains.indexOf(Math.max(...gains))).toBe(ACT_RIGHT);
    expect(gains[ACT_LEFT]).toBeGreaterThan(gains[ACT_NONE] as number);
  });

  it('gain：走進自己塗過的格子沒有好處，往最近的沒塗過的格子靠近才有（自己的地盤裡不會原地打轉）', () => {
    const own: number[] = [];
    for (let x = 4; x <= 12; x += 1) {
      own.push(cell(x, 10));
    }
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(8, 10) }, { cell: cell(30, 1) }],
      paint0: own,
      paint1: [cell(30, 1)],
    });
    // 最近的沒塗過的格子在上、下（距離 1）：走進自己的左右沒有好處。
    const gains = gainsOf(state, 0);
    expect([ACT_UP, ACT_DOWN]).toContain(gains.indexOf(Math.max(...gains)));
  });

  it('gain：圈地的那一步算進去（走進門比待著高很多）', () => {
    const gains = gainsOf(atDoor(rectangle(), { tick: 1 }), 0);
    expect(gains[ACT_UP]).toBeGreaterThan((gains[ACT_NONE] as number) + 3000);
  });

  it('gain：我的分數比較高比較好；對 1 號邊相反', () => {
    const base = { players: [{ cell: NEAR_A }, { cell: FAR_B }] as const };
    const small = makeState({ ...base, paint0: [NEAR_A], paint1: [FAR_B] });
    const big = makeState({ ...base, paint0: [NEAR_A, cell(1, 1), cell(2, 2)], paint1: [FAR_B] });
    expect(d8Game.evaluate(big, 0).gain).toBeGreaterThan(d8Game.evaluate(small, 0).gain);
    expect(d8Game.evaluate(big, 1).gain).toBeLessThan(d8Game.evaluate(small, 1).gain);
  });

  it('danger：永遠在 0 到 1；離對手越近越高（精準型因此避開接觸）；已結束的局是 0', () => {
    const near = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(12, 10) }],
      paint0: [cell(10, 10)],
      paint1: [cell(12, 10)],
    });
    const far = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(25, 20) }],
      paint0: [cell(10, 10)],
      paint1: [cell(25, 20)],
    });
    const n = d8Game.evaluate(near, 0).danger;
    const f = d8Game.evaluate(far, 0).danger;
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1);
    expect(n).toBeGreaterThan(f);
    expect(f).toBe(0);
    // 往對手靠近的那一步，danger 比往反方向走高。
    const dangers = dangersOf(near, 0);
    expect(dangers[ACT_RIGHT]).toBeGreaterThan(dangers[ACT_LEFT] as number);
    const over = d8Game.step(makeState({ tick: 3599 }), IDLE);
    expect(d8Game.evaluate(over, 0).danger).toBe(0);
  });

  it('已經結束的局：贏的一邊 gain 比輸的高很多', () => {
    const won = d8Game.step(
      makeState({
        tick: 3599,
        players: [{ cell: NEAR_A }, { cell: FAR_B }],
        paint0: [NEAR_A, cell(1, 1), cell(2, 2), cell(3, 3)],
        paint1: [FAR_B],
      }),
      IDLE,
    );
    expect(d8Game.evaluate(won, 0).gain).toBeGreaterThan(d8Game.evaluate(won, 1).gain);
  });
});

describe('D-8 塗地｜性格（黑箱：用 decide 看性格真的做出不同的事）', () => {
  const params = { depth: 6, seed: 1 };
  /** 這一步按下去之後，鎖定的下一格。 */
  function target(state: D8State, pressed: Buttons): number {
    const after = d8Game.step(state, [pressed, NONE]);
    const pending = after.players[0].pending;
    if (pending < 0) {
      return after.players[0].cell;
    }
    const dx = [0, 1, 0, -1][pending] as number;
    const dy = [-1, 0, 1, 0][pending] as number;
    return cell(cellX(after.players[0].cell) + dx, cellY(after.players[0].cell) + dy);
  }
  /** 對手就在右邊兩格（它的地盤在它腳下與右邊），我的左邊與上下都是沒人塗過的空地。 */
  const contact = makeState({
    tick: 1,
    players: [{ cell: cell(10, 10) }, { cell: cell(13, 10) }],
    paint0: [cell(10, 10), cell(9, 10), cell(8, 10)],
    paint1: [cell(13, 10), cell(12, 10), cell(11, 10)],
  });

  it('貪心型：看得到 +2，往對手的地盤走（接觸）；它不看 danger', () => {
    expect(target(contact, greedy.decide(d8Game, contact, 0, 1, params))).toBe(cell(11, 10));
  });

  it('精準型：同一個局面，避開接觸，往離對手遠的方向擴張（左邊與上下的空地）', () => {
    const picked = target(contact, precise.decide(d8Game, contact, 0, 1, params));
    expect(picked).not.toBe(cell(11, 10));
    expect(picked).not.toBe(cell(10, 10));
  });
});

describe('D-8 塗地｜整場（種子 0 到 5）', () => {
  /** 兩邊用同一個性格、等級 10，跑 6 場，回傳每人每場的接觸時間（兩人距離 ≤ 3）占比與最後的面積。 */
  function play(policy: Policy): { contact: number; area: number } {
    let near = 0;
    let ticks = 0;
    let area = 0;
    const seeds = 6;
    for (let seed = 0; seed < seeds; seed += 1) {
      const a = levelController(d8Game, policy, 10, seed);
      const b = levelController(d8Game, policy, 10, seed + 1_000_003);
      let state = d8Game.init(seed, CONFIG);
      for (let tick = 0; !d8Game.isOver(state); tick += 1) {
        state = d8Game.step(state, [
          copyButtons(a.decide(state, 0, tick)),
          copyButtons(b.decide(state, 1, tick)),
        ]);
        const dx = Math.abs(cellX(state.players[0].cell) - cellX(state.players[1].cell));
        const dy = Math.abs(cellY(state.players[0].cell) - cellY(state.players[1].cell));
        if (dx + dy <= 3) {
          near += 1;
        }
        ticks += 1;
      }
      area += state.players[0].score + state.players[1].score;
    }
    return { contact: near / ticks, area: area / (2 * seeds) };
  }

  it(
    '貪心型的接觸時間占比至少是精準型的 1.5 倍（指紋：衝向對手的地盤 vs 避開接觸）；兩邊都真的塗了地（每人超過 100 格）',
    { timeout: 120_000 },
    () => {
      const g = play(greedy);
      const p = play(precise);
      expect(g.contact).toBeGreaterThanOrEqual(1.5 * p.contact);
      expect(g.area).toBeGreaterThan(100);
      expect(p.area).toBeGreaterThan(100);
    },
  );
});

describe('D-8 塗地｜互動強度（DESIGN-AI-FUN 2.5）', () => {
  it('把 AI 換到另一個合法位置（在自己的起點 vs 離人 2 格），人這一邊 1 步 evaluate（gain 與 danger，用精準型的選法）的最好動作會跟著改變的局面，至少 20%', () => {
    const params = { depth: 1, seed: 1 };
    const bestFor = (state: D8State): string =>
      JSON.stringify(precise.decide(d8Game, state, 0, 1, params));
    const samples: D8State[] = [];
    for (let seed = 0; seed < 8 && samples.length < 200; seed += 1) {
      const a = levelController(d8Game, greedy, 10, seed);
      const b = levelController(d8Game, greedy, 10, seed + 1_000_003);
      let state = d8Game.init(seed, CONFIG);
      for (let tick = 0; !d8Game.isOver(state); tick += 1) {
        if (tick % 18 === 9 && samples.length < 200) {
          samples.push(state);
        }
        state = d8Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    let changed = 0;
    let used = 0;
    for (const sample of samples) {
      const me = sample.players[0].cell;
      const x = cellX(me);
      const y = cellY(me);
      // 離人 2 格的合法位置（曼哈頓距離 2、不是牆）；找不到就略過這個局面。
      const spots = [cell(x + 2, y), cell(x - 2, y), cell(x, y + 2), cell(x, y - 2)].filter(
        (c, i) =>
          [x + 2 < 32, x - 2 >= 0, y + 2 < 24, y - 2 >= 0][i] === true && sample.walls[c] === 0,
      );
      const near = spots[0];
      if (near === undefined) {
        continue;
      }
      used += 1;
      const at = (spot: number): D8State => ({
        ...sample,
        players: [
          sample.players[0],
          { ...sample.players[1], cell: spot, pending: -1 as const },
        ] as const,
      });
      if (bestFor(at(START_CELLS[1])) !== bestFor(at(near))) {
        changed += 1;
      }
    }
    expect(used).toBeGreaterThanOrEqual(150);
    expect(changed / used).toBeGreaterThanOrEqual(0.2);
  }, 60_000);
});
