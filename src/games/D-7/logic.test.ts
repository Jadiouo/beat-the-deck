import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import { CELLS, cell, cellX, cellY, START_CELLS } from '../_diamonds/logic';
import {
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
  BAG,
  bandOf,
  BAND_WIDTH,
  CAVE_RADIUS,
  d7Game,
  depthOf,
  HARD,
  isCave,
  makeState,
  ORE_RATE,
  VALUE,
} from './logic';
import type { D7State } from './logic';

/**
 * D-7 挖礦的規則測試。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣；這張牌沒有任何隨機事件。
 * `makeState` 預設：沒有牆、全岩石（hp 1）、沒有礦、兩個基地周圍的洞穴；
 * `rock`、`ore`、`opened` 給「[格子編號, 值]」的清單覆蓋。
 * 走格結算在 `tick % 5 === 0`，所以 `BEFORE_MOVE`（4）加上 IDLE 的下一次 `step` 就是結算那一次。
 */

const BEFORE_MOVE = 4;
const UP = 0;
const RIGHT = 1;
const DOWN = 2;
const LEFT = 3;

/** 地圖中段、離洞穴與牆都遠的格子。 */
const HERE = cell(10, 10);
const EAST = cell(11, 10);
const FAR_AI = cell(25, 5);

/** 下一次 step 就是走格結算：人在 (10,10) 鎖定往右，AI 在遠處不動。 */
function atMove(overrides: Parameters<typeof makeState>[0] = {}): D7State {
  return makeState({
    tick: BEFORE_MOVE,
    players: [{ cell: HERE, pending: RIGHT }, { cell: FAR_AI }],
    ...overrides,
  });
}

function stepIdle(state: D7State): D7State {
  return d7Game.step(state, IDLE);
}

describe('D-7 挖礦｜初始與地形', () => {
  it('開局：768 格；牆是鑿不開的（hp 0）；兩個基地周圍曼哈頓距離 2 以內是洞穴（hp 0）；其他非牆格是岩石，hp 依深度帶', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const state = d7Game.init(seed, CONFIG);
      expect(state.rock).toHaveLength(CELLS);
      expect(state.ore).toHaveLength(CELLS);
      expect(state.opened).toHaveLength(CELLS);
      expect(state.players.map((p) => p.cell)).toEqual([...START_CELLS]);
      for (let c = 0; c < CELLS; c += 1) {
        if (state.walls[c] === 1) {
          expect(state.rock[c]).toBe(0);
          expect(state.ore[c]).toBe(0);
        } else if (isCave(c)) {
          expect(state.rock[c]).toBe(0);
          expect(state.ore[c]).toBe(0);
        } else {
          expect(state.rock[c]).toBe(HARD[bandOf(c)]);
        }
        expect(state.opened[c]).toBe(-1);
      }
      expect(state.bag).toEqual([[], []]);
      expect(state.dug).toEqual([0, 0]);
      expect(state.rode).toEqual([0, 0]);
      expect(d7Game.score(state)).toEqual([0, 0]);
      expect(state.maxTicks).toBe(3600);
    }
  });

  it('洞穴：只有兩個基地周圍曼哈頓距離 ≤ 2 的 6 + 6 格', () => {
    const caves: number[] = [];
    for (let c = 0; c < CELLS; c += 1) {
      if (isCave(c)) {
        caves.push(c);
      }
    }
    expect(CAVE_RADIUS).toBe(2);
    expect(caves).toHaveLength(12);
    expect(caves).toContain(START_CELLS[0]);
    expect(caves).toContain(START_CELLS[1]);
    expect(isCave(cell(3, 23))).toBe(false);
    expect(isCave(cell(2, 23))).toBe(true);
    expect(isCave(cell(1, 22))).toBe(true);
    expect(isCave(cell(0, 20))).toBe(false);
  });

  it('深度帶邊界：深度 6 是帶 0、7 是帶 1、13 是帶 1、14 是帶 2、20 是帶 2、21 起是帶 3（上限 3）', () => {
    expect(BAND_WIDTH).toBe(7);
    // 沿著人的基地往右：(x, 23) 的深度就是 x（x ≤ 15 時最近的基地是人的）。
    expect(depthOf(cell(6, 23))).toBe(6);
    expect(bandOf(cell(6, 23))).toBe(0);
    expect(depthOf(cell(7, 23))).toBe(7);
    expect(bandOf(cell(7, 23))).toBe(1);
    expect(bandOf(cell(13, 23))).toBe(1);
    expect(bandOf(cell(14, 23))).toBe(2);
    // 地圖正中央最深，帶不超過 3。
    expect(bandOf(cell(15, 12))).toBe(3);
    expect(bandOf(cell(16, 11))).toBe(3);
    let maxBand = 0;
    for (let c = 0; c < CELLS; c += 1) {
      maxBand = Math.max(maxBand, bandOf(c));
    }
    expect(maxBand).toBe(3);
  });

  it('深度是到最近基地的曼哈頓距離，兩個基地 180 度旋轉對稱：每一格與它的旋轉對應格深度相同，各深度帶的格數對稱', () => {
    const perBand = [0, 0, 0, 0];
    const perBandRotated = [0, 0, 0, 0];
    for (let c = 0; c < CELLS; c += 1) {
      const rotated = CELLS - 1 - c;
      expect(depthOf(c)).toBe(depthOf(rotated));
      const near0 = Math.abs(cellX(c) - 0) + Math.abs(cellY(c) - 23);
      const near1 = Math.abs(cellX(c) - 31) + Math.abs(cellY(c) - 0);
      expect(depthOf(c)).toBe(Math.min(near0, near1));
      perBand[bandOf(c)] = (perBand[bandOf(c)] as number) + 1;
      perBandRotated[bandOf(rotated)] = (perBandRotated[bandOf(rotated)] as number) + 1;
    }
    expect(perBand).toEqual(perBandRotated);
  });

  it('硬度與價值：HARD = [1, 2, 4, 6]、VALUE = [1, 3, 6, 10]、背包 4、礦的機率 25%', () => {
    expect([...HARD]).toEqual([1, 2, 4, 6]);
    expect([...VALUE]).toEqual([1, 3, 6, 10]);
    expect(BAG).toBe(4);
    expect(ORE_RATE).toBe(25);
  });

  it('礦：只在岩石格裡（不在牆、不在洞穴）、價值依深度帶、比例約 25%（種子 0 到 9）', () => {
    let rockCells = 0;
    let oreCells = 0;
    for (let seed = 0; seed < 10; seed += 1) {
      const state = d7Game.init(seed, CONFIG);
      for (let c = 0; c < CELLS; c += 1) {
        if ((state.rock[c] as number) > 0) {
          rockCells += 1;
        }
        const value = state.ore[c] as number;
        if (value > 0) {
          oreCells += 1;
          expect(state.rock[c]).toBeGreaterThan(0);
          expect(value).toBe(VALUE[bandOf(c)]);
        }
      }
    }
    const rate = oreCells / rockCells;
    expect(rate).toBeGreaterThan(0.2);
    expect(rate).toBeLessThan(0.3);
  });

  it('種子有效：礦的分布與 hp 對種子 0 到 9 不全相同（牆不同，所以 hp 的分布也不同）；礦的分布 180 度對稱（兩邊旋轉對應的格子都是岩石時，礦的有無與價值一定相同）', () => {
    const layouts = new Set<string>();
    const rockLayouts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const state = d7Game.init(seed, CONFIG);
      layouts.add(state.ore.join(','));
      rockLayouts.add(state.rock.join(','));
      // 旋轉對應的格子也是岩石的話（不是牆、不是洞穴），礦的有無與價值一定相同。
      for (let c = 0; c < CELLS; c += 1) {
        const twin = CELLS - 1 - c;
        if ((state.rock[c] as number) > 0 && (state.rock[twin] as number) > 0) {
          expect(state.ore[twin]).toBe(state.ore[c]);
        }
      }
    }
    expect(layouts.size).toBeGreaterThan(5);
    expect(rockLayouts.size).toBeGreaterThan(5);
  });

  it('同一個種子 init 兩次完全相同；rng 開局後不再變（這張牌沒有隨機事件）', () => {
    const a = d7Game.init(3, CONFIG);
    const b = d7Game.init(3, CONFIG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const after = run(d7Game, a, 400, [PRESS_RIGHT, PRESS_LEFT]);
    expect(after.rng).toBe(a.rng);
  });
});

describe('D-7 挖礦｜鑿', () => {
  it('1. 鎖定的方向指向岩石、走格結算：不移動，那一格 hp −1，鎖定歸零', () => {
    const state = atMove({ rock: [[EAST, 3]] });
    const next = stepIdle(state);
    expect(next.rock[EAST]).toBe(2);
    expect(next.players[0].cell).toBe(HERE);
    expect(next.players[0].pending).toBe(-1);
    expect(next.dug).toEqual([0, 0]);
    expect(next.opened[EAST]).toBe(-1);
  });

  it('1. 不是走格的 tick 不鑿：第 1 到 4 個 tick 什麼都沒發生，第 5 個才鑿', () => {
    let state = makeState({
      players: [{ cell: HERE }, { cell: FAR_AI }],
      rock: [[EAST, 3]],
    });
    state = run(d7Game, state, 4, [PRESS_RIGHT, NONE]);
    expect(state.rock[EAST]).toBe(3);
    state = d7Game.step(state, [PRESS_RIGHT, NONE]);
    expect(state.rock[EAST]).toBe(2);
    state = run(d7Game, state, 5, [PRESS_RIGHT, NONE]);
    expect(state.rock[EAST]).toBe(1);
  });

  it('1. 邊界：hp 剛好是 1 → 鑿穿（變 0、永久是路、記錄是誰鑿的、dug +1），這一次走格不會走進去', () => {
    const next = stepIdle(atMove());
    expect(next.rock[EAST]).toBe(0);
    expect(next.players[0].cell).toBe(HERE);
    expect(next.opened[EAST]).toBe(0);
    expect(next.dug).toEqual([1, 0]);
  });

  it('1. 邊界：hp 剛好是 2 → 鑿一次還剩 1，再鑿一次才穿；穿了以後下一次走格才走進去，而且路永久是路', () => {
    let state = atMove({
      rock: [
        [HERE, 0],
        [EAST, 2],
      ],
    });
    state = stepIdle(state);
    expect(state.rock[EAST]).toBe(1);
    expect(state.dug).toEqual([0, 0]);
    state = run(d7Game, state, 5, [PRESS_RIGHT, NONE]);
    expect(state.rock[EAST]).toBe(0);
    expect(state.players[0].cell).toBe(HERE);
    expect(state.dug).toEqual([1, 0]);
    state = run(d7Game, state, 5, [PRESS_RIGHT, NONE]);
    expect(state.players[0].cell).toBe(EAST);
    // 走過去、走回來，那一格仍然是空的。
    state = run(d7Game, state, 5, [PRESS_LEFT, NONE]);
    expect(state.players[0].cell).toBe(HERE);
    expect(state.rock[EAST]).toBe(0);
  });

  it('2. 兩個人同鑿同一格：hp −2', () => {
    const state = atMove({
      rock: [[EAST, 4]],
      players: [
        { cell: HERE, pending: RIGHT },
        { cell: cell(12, 10), pending: LEFT },
      ],
    });
    const next = stepIdle(state);
    expect(next.rock[EAST]).toBe(2);
    expect(next.players[0].cell).toBe(HERE);
    expect(next.players[1].cell).toBe(cell(12, 10));
  });

  it('2. 邊界：同鑿一格 hp 剛好 2 → 同時鑿穿（兩人都算鑿穿，opened 記 2）；hp 是 1 也只扣到 0 不會變負', () => {
    const players: readonly [
      { cell: number; pending: 0 | 1 | 2 | 3 },
      { cell: number; pending: 0 | 1 | 2 | 3 },
    ] = [
      { cell: HERE, pending: RIGHT },
      { cell: cell(12, 10), pending: LEFT },
    ];
    const two = stepIdle(atMove({ rock: [[EAST, 2]], players }));
    expect(two.rock[EAST]).toBe(0);
    expect(two.opened[EAST]).toBe(2);
    expect(two.dug).toEqual([1, 1]);
    const one = stepIdle(atMove({ players }));
    expect(one.rock[EAST]).toBe(0);
    expect(one.dug).toEqual([1, 1]);
  });

  it('2. 兩個人鑿不同的格子：各自 hp −1，互不影響', () => {
    const state = atMove({
      rock: [
        [EAST, 3],
        [cell(25, 6), 3],
      ],
      players: [
        { cell: HERE, pending: RIGHT },
        { cell: FAR_AI, pending: DOWN },
      ],
    });
    const next = stepIdle(state);
    expect(next.rock[EAST]).toBe(2);
    expect(next.rock[cell(25, 6)]).toBe(2);
  });

  it('3. 牆（鑿不開的石柱）：朝牆走不動也鑿不開；出界同樣不動', () => {
    const wall = atMove({ walls: [EAST] });
    const afterWall = stepIdle(wall);
    expect(afterWall.rock[EAST]).toBe(0);
    expect(afterWall.players[0].cell).toBe(HERE);
    expect(afterWall.dug).toEqual([0, 0]);
    const edge = atMove({ players: [{ cell: cell(10, 0), pending: UP }, {}] });
    const afterEdge = stepIdle(edge);
    expect(afterEdge.players[0].cell).toBe(cell(10, 0));
    expect(afterEdge.dug).toEqual([0, 0]);
  });

  it('4. 走進空格：移動一格；走格同其他方塊牌，朝著空格按住每 5 個 tick 走一格', () => {
    const state = makeState({
      players: [{ cell: HERE }, { cell: FAR_AI }],
      rock: [
        [EAST, 0],
        [cell(12, 10), 0],
      ],
    });
    const after = run(d7Game, state, 10, [PRESS_RIGHT, NONE]);
    expect(after.players[0].cell).toBe(cell(12, 10));
  });
});

describe('D-7 挖礦｜礦與背包', () => {
  const OPEN_ORE = [[EAST, 0]] as const;

  it('5. 走進有礦的空格、背包有空位：礦放進背包，那一格的礦歸 0', () => {
    const next = stepIdle(atMove({ rock: OPEN_ORE, ore: [[EAST, 6]] }));
    expect(next.players[0].cell).toBe(EAST);
    expect(next.bag[0]).toEqual([6]);
    expect(next.ore[EAST]).toBe(0);
  });

  it('5. 邊界：背包剛好 3 塊 → 撿了變 4 塊（滿）；剛好 4 塊 → 礦留在原地，人還是走進去', () => {
    const three = stepIdle(atMove({ rock: OPEN_ORE, ore: [[EAST, 6]], bag: [[1, 1, 1], []] }));
    expect(three.bag[0]).toEqual([1, 1, 1, 6]);
    expect(three.ore[EAST]).toBe(0);
    const four = stepIdle(atMove({ rock: OPEN_ORE, ore: [[EAST, 6]], bag: [[1, 1, 1, 1], []] }));
    expect(four.players[0].cell).toBe(EAST);
    expect(four.bag[0]).toEqual([1, 1, 1, 1]);
    expect(four.ore[EAST]).toBe(6);
  });

  it('5. 背包滿了礦留在原地（沒有消失），之後有空位的人（包含對手）踩進去就撿走', () => {
    const left = stepIdle(atMove({ rock: OPEN_ORE, ore: [[EAST, 6]], bag: [[1, 1, 1, 1], []] }));
    expect(left.ore[EAST]).toBe(6);
    // 對手（有空位）從另一邊走進去。
    const taken = d7Game.step(
      makeState({
        tick: BEFORE_MOVE,
        rock: OPEN_ORE,
        ore: [[EAST, 6]],
        players: [{ cell: cell(25, 5) }, { cell: cell(12, 10), pending: LEFT }],
        bag: [[], []],
      }),
      IDLE,
    );
    expect(taken.bag[1]).toEqual([6]);
    expect(taken.ore[EAST]).toBe(0);
  });

  it('6. 兩個人同一次走格走進同一格有礦的空格：各撿一份（複製），那一格歸 0', () => {
    const state = atMove({
      rock: OPEN_ORE,
      ore: [[EAST, 6]],
      players: [
        { cell: HERE, pending: RIGHT },
        { cell: cell(12, 10), pending: LEFT },
      ],
    });
    const next = stepIdle(state);
    expect(next.players[0].cell).toBe(EAST);
    expect(next.players[1].cell).toBe(EAST);
    expect(next.bag).toEqual([[6], [6]]);
    expect(next.ore[EAST]).toBe(0);
  });

  it('6. 邊界：一個人背包滿了、另一個有空位，同時走進去：只有有空位的撿到，礦歸 0；兩個都滿：礦留著', () => {
    const players = [
      { cell: HERE, pending: RIGHT },
      { cell: cell(12, 10), pending: LEFT },
    ] as const;
    const oneFull = stepIdle(
      atMove({ rock: OPEN_ORE, ore: [[EAST, 6]], players, bag: [[1, 1, 1, 1], []] }),
    );
    expect(oneFull.bag).toEqual([[1, 1, 1, 1], [6]]);
    expect(oneFull.ore[EAST]).toBe(0);
    const bothFull = stepIdle(
      atMove({
        rock: OPEN_ORE,
        ore: [[EAST, 6]],
        players,
        bag: [
          [1, 1, 1, 1],
          [2, 2, 2, 2],
        ],
      }),
    );
    expect(bothFull.ore[EAST]).toBe(6);
  });

  it('7. 鑿穿一個有礦的岩石格：礦還在那一格（鑿穿不會自動進背包），下一次有人走進去才撿', () => {
    const next = stepIdle(atMove({ ore: [[EAST, 3]] }));
    expect(next.rock[EAST]).toBe(0);
    expect(next.ore[EAST]).toBe(3);
    expect(next.bag[0]).toEqual([]);
    const taken = run(d7Game, next, 5, [PRESS_RIGHT, NONE]);
    expect(taken.bag[0]).toEqual([3]);
  });
});

describe('D-7 挖礦｜存進基地與結束', () => {
  const BASE0 = START_CELLS[0];
  const BASE1 = START_CELLS[1];

  it('8. 走進自己的基地：背包裡的礦全部變成分數（價值總和），背包歸零', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(1, 23), pending: LEFT }, { cell: FAR_AI }],
      bag: [[3, 6, 10], []],
    });
    const next = stepIdle(state);
    expect(next.players[0].cell).toBe(BASE0);
    expect(next.players[0].score).toBe(19);
    expect(next.bag[0]).toEqual([]);
    expect(d7Game.score(next)).toEqual([19, 0]);
  });

  it('8. 對 1 號邊同樣：走進 (31, 0) 才算分', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 0), pending: RIGHT }],
      bag: [[], [6, 6]],
    });
    const next = stepIdle(state);
    expect(next.players[1].cell).toBe(BASE1);
    expect(next.players[1].score).toBe(12);
    expect(next.bag[1]).toEqual([]);
  });

  it('8. 走進對手的基地什麼都不發生（背包原樣）；站在自己的基地不動也不會重複算分', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(30, 0), pending: RIGHT }, { cell: FAR_AI }],
      bag: [[3, 3], []],
    });
    const next = stepIdle(state);
    expect(next.players[0].cell).toBe(BASE1);
    expect(next.players[0].score).toBe(0);
    expect(next.bag[0]).toEqual([3, 3]);
    const home = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: BASE0 }, { cell: FAR_AI }],
      bag: [[3, 3], []],
    });
    expect(stepIdle(home).players[0].score).toBe(0);
  });

  it('9. 時間到：背包裡的不算分；分數高的贏、同分平手', () => {
    const base = {
      tick: 3599,
      players: [
        { cell: HERE, score: 5 },
        { cell: FAR_AI, score: 4 },
      ],
      bag: [[10, 10], [6]],
    } as const;
    const over = stepIdle(makeState(base as Parameters<typeof makeState>[0]));
    expect(over.over).toBe(true);
    expect(d7Game.isOver(over)).toBe(true);
    expect(d7Game.score(over)).toEqual([5, 4]);
    expect(d7Game.winner(over)).toBe(0);
    const tie = stepIdle(
      makeState({
        ...base,
        players: [
          { cell: HERE, score: 4 },
          { cell: FAR_AI, score: 4 },
        ],
      } as Parameters<typeof makeState>[0]),
    );
    expect(d7Game.winner(tie)).toBeNull();
    const second = stepIdle(
      makeState({
        ...base,
        players: [
          { cell: HERE, score: 1 },
          { cell: FAR_AI, score: 2 },
        ],
      } as Parameters<typeof makeState>[0]),
    );
    expect(d7Game.winner(second)).toBe(1);
  });

  it('結束之後再 step：state 原樣不變；一局固定 3600 tick', () => {
    const over = stepIdle(makeState({ tick: 3599 }));
    expect(stepIdle(over)).toBe(over);
    let state = d7Game.init(1, CONFIG);
    let ticks = 0;
    while (!d7Game.isOver(state)) {
      state = d7Game.step(state, IDLE);
      ticks += 1;
    }
    expect(ticks).toBe(3600);
  });
});

describe('D-7 挖礦｜搭便車（指紋 rode）', () => {
  it('10. 走進一格「對手鑿穿的空格」：rode +1；自己鑿穿的、開局洞穴、兩人一起鑿穿的都不算', () => {
    const rodeAfter = (opened: number): number =>
      stepIdle(atMove({ rock: [[EAST, 0]], opened: [[EAST, opened]] })).rode[0];
    expect(rodeAfter(1)).toBe(1);
    expect(rodeAfter(0)).toBe(0);
    expect(rodeAfter(-1)).toBe(0);
    expect(rodeAfter(2)).toBe(0);
  });

  it('10. 對 1 號邊相反：走進人鑿穿的格子才算；沒有走進去（原地鑿）不算', () => {
    const state = atMove({
      rock: [[EAST, 0]],
      opened: [[EAST, 0]],
      players: [{ cell: cell(25, 5) }, { cell: cell(12, 10), pending: LEFT }],
    });
    const next = stepIdle(state);
    expect(next.rode).toEqual([0, 1]);
    const dig = stepIdle(atMove());
    expect(dig.rode).toEqual([0, 0]);
  });

  it('10. 在隧道裡來回走，每走進一次對手鑿的格子就算一次', () => {
    let state = makeState({
      players: [{ cell: HERE }, { cell: FAR_AI }],
      rock: [
        [EAST, 0],
        [cell(12, 10), 0],
      ],
      opened: [
        [EAST, 1],
        [cell(12, 10), 1],
      ],
    });
    state = run(d7Game, state, 10, [PRESS_RIGHT, NONE]);
    expect(state.rode[0]).toBe(2);
    state = run(d7Game, state, 5, [PRESS_LEFT, NONE]);
    expect(state.rode[0]).toBe(3);
  });

  it('10. 兩個人在同一條隧道上，對方鑿的路自己走是搭便車、自己鑿的路對方走也是：兩邊獨立計', () => {
    const state = atMove({
      rock: [
        [EAST, 0],
        [cell(12, 10), 0],
      ],
      opened: [
        [EAST, 1],
        [cell(12, 10), 0],
      ],
      players: [
        { cell: HERE, pending: RIGHT },
        { cell: cell(13, 10), pending: LEFT },
      ],
    });
    const next = stepIdle(state);
    expect(next.rode).toEqual([1, 1]);
  });
});

describe('D-7 挖礦｜純度與契約', () => {
  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，包含鑿、撿、存的那一次）', () => {
    const cases: D7State[] = [
      atMove({ rock: [[EAST, 3]] }),
      atMove({ rock: [[EAST, 0]], ore: [[EAST, 6]] }),
      makeState({
        tick: BEFORE_MOVE,
        players: [{ cell: cell(1, 23), pending: LEFT }, { cell: FAR_AI }],
        bag: [[3, 6], [1]],
      }),
      d7Game.init(2, CONFIG),
    ];
    for (const state of cases) {
      const before = JSON.stringify(state);
      const frozen = deepFreeze(JSON.parse(before) as D7State);
      expect(() => d7Game.step(frozen, [PRESS_RIGHT, PRESS_LEFT])).not.toThrow();
      expect(() =>
        d7Game.step({ ...frozen, tick: BEFORE_MOVE }, [PRESS_RIGHT, PRESS_LEFT]),
      ).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(before);
    }
  });

  it('沒有鑿與撿的時候，rock／ore／opened 不會被複製（同一個陣列物件，A5 的距離場才能快取）', () => {
    const state = makeState({ players: [{ cell: HERE }, { cell: FAR_AI }] });
    const next = d7Game.step(state, IDLE);
    expect(next.rock).toBe(state.rock);
    expect(next.ore).toBe(state.ore);
  });

  it('K1：同一個種子、同一串輸入跑兩次結果相同', () => {
    const play = (): string => {
      let state = d7Game.init(5, CONFIG);
      for (let t = 0; t < 600; t += 1) {
        const pick = (offset: number): Buttons =>
          [PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT, NONE][(t + offset) % 5] as Buttons;
        state = d7Game.step(state, [pick(Math.floor(t / 40)), pick(Math.floor(t / 55) + 2)]);
      }
      return JSON.stringify(state);
    };
    expect(play()).toBe(play());
  });
});

// ---------------------------------------------------------------------------
// 動作與評估
// ---------------------------------------------------------------------------

const ACTIONS: readonly Buttons[] = [PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT, NONE];

function gainsOf(state: D7State, side: Side): number[] {
  return ACTIONS.map((action) => {
    const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
    return d7Game.evaluate(d7Game.step(state, inputs), side).gain;
  });
}
function dangersOf(state: D7State, side: Side): number[] {
  return ACTIONS.map((action) => {
    const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
    return d7Game.evaluate(d7Game.step(state, inputs), side).danger;
  });
}
function dirName(buttons: Buttons): 'up' | 'right' | 'down' | 'left' | 'none' {
  if (buttons.up) {
    return 'up';
  }
  if (buttons.right) {
    return 'right';
  }
  if (buttons.down) {
    return 'down';
  }
  if (buttons.left) {
    return 'left';
  }
  return 'none';
}
const PARAMS = { depth: 6, seed: 1 };
function choose(policy: Policy, state: D7State, side: Side = 0, depth = 6): string {
  return dirName(policy.decide(d7Game, state, side, 1, { ...PARAMS, depth }));
}

/** 一條全部打通的橫向走道：(from..to, y)，讓測試不用管岩石。 */
function corridor(y: number, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = from; x <= to; x += 1) {
    out.push([cell(x, y), 0]);
  }
  return out;
}

describe('D-7 挖礦｜actions 與 evaluate', () => {
  it('actions：五個不同的動作，全放開排最後，往目標（最划算的礦）走的方向排最前面', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: HERE }, { cell: FAR_AI }],
      rock: corridor(10, 10, 16),
      ore: [[cell(16, 10), 6]],
    });
    const actions = d7Game.actions(state, 0);
    expect(actions).toHaveLength(5);
    expect(new Set(actions.map((a) => JSON.stringify(a))).size).toBe(5);
    expect(actions[0]).toEqual(PRESS_RIGHT);
    expect(actions[4]).toEqual(NONE);
    expect(d7Game.actions(state, 1)[4]).toEqual(NONE);
  });

  it('gain：朝著礦的方向鑿（這一鑿在通往礦的路上）比別的方向、比放開高', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: HERE }, { cell: FAR_AI }],
      rock: [...corridor(10, 14, 14)],
      ore: [[cell(14, 10), 3]],
    });
    const gains = gainsOf(state, 0);
    const best = gains.indexOf(Math.max(...gains));
    expect(best).toBe(1); // 右
    expect(gains[1]).toBeGreaterThan(gains[4] as number);
  });

  it('gain：走進有礦的空格（撿起來）比不撿高很多；存進基地的那一步每 1 分高 40 以上（存起來 100，背包裡 60）', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: HERE }, { cell: FAR_AI }],
      rock: [[EAST, 0]],
      ore: [[EAST, 6]],
    });
    const gains = gainsOf(state, 0);
    expect(gains[1]).toBeGreaterThan((gains[4] as number) + 6 * 40);
    const home = makeState({
      tick: 1,
      players: [{ cell: cell(1, 23) }, { cell: FAR_AI }],
      bag: [[6], []],
    });
    const homeGains = gainsOf(home, 0);
    expect(homeGains[3]).toBeGreaterThan((homeGains[4] as number) + 6 * 30);
  });

  it('gain：我的分數越高越好、對方越高越差；背包的價值也算（比存起來的少）', () => {
    const base = makeState({ tick: 1, players: [{ cell: HERE }, { cell: FAR_AI }] });
    const mine = makeState({ tick: 1, players: [{ cell: HERE, score: 5 }, { cell: FAR_AI }] });
    const theirs = makeState({ tick: 1, players: [{ cell: HERE }, { cell: FAR_AI, score: 5 }] });
    const bagged = makeState({
      tick: 1,
      players: [{ cell: HERE }, { cell: FAR_AI }],
      bag: [[5], []],
    });
    const g = (s: D7State): number => d7Game.evaluate(s, 0).gain;
    expect(g(mine)).toBeGreaterThan(g(bagged));
    expect(g(bagged)).toBeGreaterThan(g(base));
    expect(g(theirs)).toBeLessThan(g(base));
  });

  it('gain：已結束的局，贏的一邊比輸的高很多，danger 是 0', () => {
    const won = makeState({
      tick: 3600,
      over: true,
      players: [{ score: 10 }, { score: 4 }],
    });
    expect(d7Game.evaluate(won, 0).gain).toBeGreaterThan(d7Game.evaluate(won, 1).gain + 100000);
    expect(d7Game.evaluate(won, 0).danger).toBe(0);
  });

  it('danger：永遠在 0 到 1；背包是空的是 0；背包越值錢、離基地越遠越高；回家的方向比往外走低', () => {
    const empty = makeState({ tick: 1, players: [{ cell: cell(20, 12) }, { cell: FAR_AI }] });
    expect(d7Game.evaluate(empty, 0).danger).toBe(0);
    const at = (x: number, y: number, bag: number[]): number =>
      d7Game.evaluate(
        makeState({
          tick: 1,
          players: [{ cell: cell(x, y) }, { cell: FAR_AI }],
          bag: [bag, []],
          rock: [...corridor(y, 0, 31)],
        }),
        0,
      ).danger;
    const far = at(16, 23, [10, 10, 10]);
    const near = at(4, 23, [10, 10, 10]);
    expect(far).toBeGreaterThan(near);
    expect(at(16, 23, [10, 10, 10])).toBeGreaterThan(at(16, 23, [1]));
    for (const d of [far, near, at(16, 23, [1]), at(30, 23, [10, 10, 10, 10])]) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(16, 23) }, { cell: FAR_AI }],
      bag: [[10, 10, 10], []],
      rock: corridor(23, 0, 31),
    });
    const dangers = dangersOf(state, 0);
    expect(dangers[3]).toBeLessThan(dangers[1] as number);
  });

  it('danger：時間快到了、背著礦又離基地遠，比時間還很多時高', () => {
    const late = (tick: number): number =>
      d7Game.evaluate(
        makeState({
          tick,
          players: [{ cell: cell(16, 23) }, { cell: FAR_AI }],
          bag: [[10, 10], []],
          rock: corridor(23, 0, 31),
        }),
        0,
      ).danger;
    // 離基地 16 格（走回去要 80 tick）；剩 40 tick 才真的趕不及（小規格的公式：(走回去的 tick − 剩餘 × 0.8) / 300）。
    expect(late(3560)).toBeGreaterThan(late(500));
  });

  it('gain 與 danger 對兩邊對稱：把整個局面轉 180 度、兩邊對調，同一組數字（不是橡皮筋、也不偏袒任何一邊）', () => {
    const samples: D7State[] = [];
    for (const seed of [0, 1, 2]) {
      const a = levelController(d7Game, precise, 10, seed);
      const b = levelController(d7Game, greedy, 10, seed + 77);
      let state = d7Game.init(seed, CONFIG);
      for (let tick = 0; tick < 1500; tick += 1) {
        if (tick % 60 === 7) {
          samples.push(state);
        }
        state = d7Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    expect(samples.length).toBeGreaterThan(60);
    for (const state of samples) {
      const turned = rotated(state);
      const mine = d7Game.evaluate(state, 0);
      const theirs = d7Game.evaluate(turned, 1);
      expect(theirs.gain).toBeCloseTo(mine.gain, 6);
      expect(theirs.danger).toBeCloseTo(mine.danger, 9);
      const mine1 = d7Game.evaluate(state, 1);
      const theirs0 = d7Game.evaluate(turned, 0);
      expect(theirs0.gain).toBeCloseTo(mine1.gain, 6);
    }
  }, 30_000);

  it('搭便車：同樣長的路，對手鑿穿的那一段比自己鑿穿的略高（FREE_RIDE_BONUS），不是更低', () => {
    const open = [...corridor(10, 11, 13)];
    const target = cell(14, 10);
    const make = (who: number): D7State =>
      makeState({
        tick: 1,
        players: [{ cell: HERE }, { cell: FAR_AI }],
        rock: [...open, [target, 0]],
        ore: [[target, 6]],
        opened: open.map(([c]) => [c as number, who] as [number, number]),
      });
    const ride = gainsOf(make(1), 0)[1] as number;
    const own = gainsOf(make(0), 0)[1] as number;
    expect(ride).toBeGreaterThan(own);
  });

  it('搶礦（互動）：路旁有一顆躺在空格裡的礦，對手背包有空位而且離它比我近，我就不去搶；對手遠或背包滿了，我就去', () => {
    const ore6 = cell(10, 6);
    const ore1 = cell(14, 10);
    const base = {
      tick: 1,
      rock: [
        [ore6, 0],
        [ore1, 0],
        ...corridor(10, 11, 13),
        ...corridor(7, 10, 10),
        ...corridor(8, 10, 10),
        ...corridor(9, 10, 10),
      ] as [number, number][],
      ore: [
        [ore6, 6],
        [ore1, 1],
      ] as [number, number][],
    };
    const closeRival = makeState({ ...base, players: [{ cell: HERE }, { cell: cell(10, 5) }] });
    const farRival = makeState({ ...base, players: [{ cell: HERE }, { cell: FAR_AI }] });
    const fullRival = makeState({
      ...base,
      players: [{ cell: HERE }, { cell: cell(10, 5) }],
      bag: [[], [1, 1, 1, 1]],
    });
    expect(dirName(d7Game.actions(closeRival, 0)[0] as Buttons)).toBe('right');
    expect(dirName(d7Game.actions(farRival, 0)[0] as Buttons)).toBe('up');
    expect(dirName(d7Game.actions(fullRival, 0)[0] as Buttons)).toBe('up');
  });

  it('回家的時機（actions 的目標）：背包滿了、或快沒時間了而且背著礦，目標是自己的基地；否則是礦', () => {
    const mk = (extra: Parameters<typeof makeState>[0]): D7State =>
      makeState({
        tick: 1,
        players: [{ cell: cell(12, 23) }, { cell: FAR_AI }],
        rock: [...corridor(23, 0, 31), ...corridor(22, 14, 14), [cell(14, 21), 0]],
        ore: [[cell(14, 21), 3]],
        ...extra,
      });
    expect(dirName(d7Game.actions(mk({}), 0)[0] as Buttons)).toBe('right');
    expect(dirName(d7Game.actions(mk({ bag: [[1, 1, 1, 1], []] }), 0)[0] as Buttons)).toBe('left');
    expect(dirName(d7Game.actions(mk({ bag: [[1], []] }), 0)[0] as Buttons)).toBe('right');
    expect(dirName(d7Game.actions(mk({ bag: [[1], []], tick: 3400 }), 0)[0] as Buttons)).toBe(
      'left',
    );
    // 背包是空的、時間快到：回家沒有意義，照樣挖。
    expect(dirName(d7Game.actions(mk({ tick: 3400 }), 0)[0] as Buttons)).toBe('right');
  });
});

/** 測試用：整個局面轉 180 度、兩邊對調（格子 c ↔ 767 − c，鎖定方向轉 180 度）。 */
function rotated(state: D7State): D7State {
  const flip = <T>(values: readonly T[]): T[] => [...values].reverse();
  const turn = (pending: number): -1 | 0 | 1 | 2 | 3 =>
    (pending < 0 ? -1 : (pending + 2) % 4) as -1 | 0 | 1 | 2 | 3;
  const who = (v: number): number => (v === 0 ? 1 : v === 1 ? 0 : v);
  const [a, b] = state.players;
  return {
    ...state,
    walls: flip(state.walls),
    rock: flip(state.rock),
    ore: flip(state.ore),
    opened: flip(state.opened).map(who),
    players: [
      { ...b, cell: CELLS - 1 - b.cell, pending: turn(b.pending) },
      { ...a, cell: CELLS - 1 - a.cell, pending: turn(a.pending) },
    ],
    bag: [state.bag[1], state.bag[0]],
    dug: [state.dug[1], state.dug[0]],
    rode: [state.rode[1], state.rode[0]],
  };
}

// ---------------------------------------------------------------------------
// 性格（黑箱：用 decide 看性格真的做出不同的事）
// ---------------------------------------------------------------------------

describe('D-7 挖礦｜性格（黑箱）', () => {
  /** 人在自己的隧道裡離基地 16 格，背著 3 塊價值 10 的深礦；前面一格有一顆價值 3 的礦（再撿就滿了）。 */
  const carrying = (bag: number[]): D7State =>
    makeState({
      tick: 1,
      players: [{ cell: cell(16, 23) }, { cell: FAR_AI }],
      rock: [...corridor(23, 0, 18)],
      ore: [[cell(18, 23), 3]],
      bag: [bag, []],
    });

  it('貪心型：背包還有空位就繼續去撿礦，不看危險（背著 30 分的深礦、離家 16 格也一樣）；背包滿了才回家', () => {
    expect(choose(greedy, carrying([10, 10, 10]))).toBe('right');
    expect(choose(greedy, carrying([10, 10, 10, 10]))).toBe('left');
  });

  it('精準型：背包值錢又離基地遠（danger 超過 0.3）就回家，背包空空或不值錢時照常去撿', () => {
    expect(choose(precise, carrying([10, 10, 10]))).toBe('left');
    expect(choose(precise, carrying([1]))).toBe('right');
    expect(choose(precise, carrying([]))).toBe('right');
  });

  it('賭徒型：被 danger 吸引，同樣的局面精準型回家了、它還往礦走', () => {
    expect(choose(precise, carrying([10, 10, 10]))).toBe('left');
    expect(choose(gambler, carrying([10, 10, 10]))).toBe('right');
  });

  it('搜尋型：看得到「這一步以後 6 個 tick 會怎樣」，背包滿了（40 分、離家 16 格）它回家，空包時去撿礦；時間還很多、背著 30 分時，它拿前面那顆價值 3 的礦（填滿背包再回家）', () => {
    expect(choose(pathfinder, carrying([10, 10, 10, 10]), 0, 6)).toBe('left');
    expect(choose(pathfinder, carrying([]), 0, 6)).toBe('right');
    // 剩 3500 tick、走回去只要 80 tick：多走 2 格撿 3 分是划算的，這一步的 danger 差（約 0.2）也不夠把它拉回頭。
    expect(choose(pathfinder, carrying([10, 10, 10]), 0, 6)).toBe('right');
  });

  it('同一個局面，貪心型與精準型的 decide 不同（性格看得出來）；四個性格在另一個局面（鑿深礦還是淺礦）至少分成兩種決定', () => {
    expect(choose(greedy, carrying([10, 10, 10]))).not.toBe(
      choose(precise, carrying([10, 10, 10])),
    );
    const picks = new Set<string>();
    for (const policy of [greedy, precise, gambler, pathfinder]) {
      picks.add(choose(policy, carrying([10, 10, 10])));
    }
    expect(picks.size).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 互動強度（DESIGN-AI-FUN 2.5）
// ---------------------------------------------------------------------------

describe('D-7 挖礦｜互動強度（DESIGN-AI-FUN 2.5）', () => {
  it('把 AI 換到另一個合法位置（離人最近的空格 vs 它自己的基地），人這一邊 1 步 evaluate 的最好動作會跟著改變的局面，至少 20%', () => {
    const bestFor = (state: D7State): number => {
      let best = 0;
      let bestValue = Number.NEGATIVE_INFINITY;
      ACTIONS.forEach((action, index) => {
        const value = d7Game.evaluate(d7Game.step(state, [action, NONE]), 0).gain;
        if (value > bestValue) {
          bestValue = value;
          best = index;
        }
      });
      return best;
    };
    const samples: D7State[] = [];
    for (let seed = 0; seed < 8 && samples.length < 200; seed += 1) {
      const a = levelController(d7Game, precise, 10, seed);
      const b = levelController(d7Game, precise, 10, seed + 1_000_003);
      let state = d7Game.init(seed, CONFIG);
      for (let tick = 0; !d7Game.isOver(state); tick += 1) {
        if (tick % 36 === 17 && samples.length < 200) {
          samples.push(state);
        }
        state = d7Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    let changed = 0;
    for (const sample of samples) {
      const me = sample.players[0].cell;
      // 離人最近的空格（不是人腳下、不是牆）。
      let near = START_CELLS[1];
      let nearDistance = Number.POSITIVE_INFINITY;
      for (let c = 0; c < CELLS; c += 1) {
        if (sample.walls[c] === 0 && sample.rock[c] === 0 && c !== me) {
          const d = Math.abs(cellX(c) - cellX(me)) + Math.abs(cellY(c) - cellY(me));
          if (d < nearDistance) {
            nearDistance = d;
            near = c;
          }
        }
      }
      const place = (c: number): D7State => ({
        ...sample,
        players: [sample.players[0], { ...sample.players[1], cell: c, pending: -1 as const }],
      });
      if (bestFor(place(near)) !== bestFor(place(START_CELLS[1]))) {
        changed += 1;
      }
    }
    expect(samples.length).toBeGreaterThanOrEqual(150);
    expect(changed / samples.length).toBeGreaterThanOrEqual(0.2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// decide 層盲測：完整資訊的牌，AI 也不可以偷看 rng 與指紋計數
// ---------------------------------------------------------------------------

/**
 * 這張牌沒有隱藏資訊（礦、hp、背包全部公開），所以 AI 唯一「不該看」的是：
 * `rng`（開局之後不用，但 state 裡有）、`dug`／`rode`（只給指紋用的累計）。
 * 做法：同一個局面只改這三個欄位，四個性格 × depth 1／3／6 × 兩邊的 `decide` 必須完全一樣；
 * 為了確定這個測試測得出來，另外注入一個偷看它們的 evaluate，必須被抓到。
 */
describe('D-7 挖礦｜decide 層盲測', () => {
  const NAMES = ['precise', 'greedy', 'gambler', 'pathfinder'] as const;
  const POLICIES: Record<(typeof NAMES)[number], Policy> = { precise, greedy, gambler, pathfinder };
  const DEPTHS = [1, 3, 6] as const;

  function snapshots(): D7State[] {
    const out: D7State[] = [];
    for (const seed of [1, 2]) {
      const a = levelController(d7Game, precise, 10, seed);
      const b = levelController(d7Game, gambler, 10, seed + 5);
      let state = d7Game.init(seed, CONFIG);
      for (let tick = 0; tick < 1800 && !d7Game.isOver(state); tick += 1) {
        if (tick % 97 === 3) {
          out.push(state);
        }
        state = d7Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    return out;
  }

  const scramble = (s: D7State, n: number): D7State => ({
    ...s,
    rng: (s.rng + 977 * (n + 1)) >>> 0,
    dug: [s.dug[0] + 3 * n, s.dug[1] + 7 * n],
    rode: [s.rode[0] + 5 * n, s.rode[1] + 11 * n],
  });

  function findLeaks(game: Game<D7State>, states: readonly D7State[]): string[] {
    const leaks: string[] = [];
    for (const s of states) {
      for (const side of [0, 1] as const) {
        for (const name of NAMES) {
          for (const depth of DEPTHS) {
            const params = { depth, seed: 1 };
            const seen = POLICIES[name].decide(game, s, side, 1, params);
            const other = POLICIES[name].decide(game, scramble(s, 1 + depth), side, 1, params);
            if (JSON.stringify(seen) !== JSON.stringify(other)) {
              leaks.push(`${name}/${depth}/tick ${s.tick}`);
            }
          }
        }
      }
    }
    return leaks;
  }

  /** 偷看 rng 與 rode 的 evaluate：把它們換成 gain 的一項，足以改變選擇。 */
  function leaky(peek: 'rng' | 'rode'): Game<D7State> {
    return {
      ...d7Game,
      evaluate(s: D7State, side: Side) {
        const base = d7Game.evaluate(s, side);
        const me = s.players[side];
        const bias = peek === 'rng' ? ((s.rng % 7) - 3) * 30 : s.rode[side] * 30;
        return { gain: base.gain + bias * ((cellX(me.cell) - 15) / 15), danger: base.danger };
      },
    };
  }

  const states = snapshots();

  it('取樣到的局面涵蓋開局、鑿到一半、背著礦等各種時候', () => {
    expect(states.length).toBeGreaterThan(30);
    expect(states.some((s) => s.bag[0].length > 0 || s.bag[1].length > 0)).toBe(true);
    expect(states.some((s) => s.dug[0] > 0)).toBe(true);
  });

  it('真的遊戲：只改 rng、dug、rode，四個性格 × depth 1／3／6 × 兩邊的 decide 完全不變', () => {
    expect(findLeaks(d7Game, states)).toEqual([]);
  }, 60_000);

  it('把偷看 rng 的 evaluate 注入進去：測試抓得到（必須是紅的）', () => {
    expect(findLeaks(leaky('rng'), states).length).toBeGreaterThan(0);
  }, 60_000);

  it('把偷看 rode 的 evaluate 注入進去：測試抓得到', () => {
    expect(findLeaks(leaky('rode'), states).length).toBeGreaterThan(0);
  }, 60_000);
});
