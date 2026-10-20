import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import type { Buttons, Inputs, Side } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { deepFreeze } from '../../../tests/contract/freeze';
import { COLOR } from '../../shell/palette';
import { CELLS, cell, cellX, cellY } from '../_clubs/logic';
import {
  BRAID,
  DEATH_GAIN,
  DANGER_FAR,
  DANGER_NEAR,
  GAIN_PER_ROUND,
  GUARD,
  GUARD_CAP,
  KEY_MIN_DIFF,
  KEY_MIN_PATH,
  MAZE_H,
  MAZE_W,
  MIN_CYCLES,
  PAUSE,
  RESULT_BONUS,
  ROUND_FREEZE,
  SNAKE_LEN,
  WIN_GAIN,
  buildLayout,
  c9Game,
  distFrom,
  initC9State,
  layoutOf,
  makeState,
  mazeInfo,
  roundTicksFor,
} from './logic';
import type { C9State, Layout } from './logic';
import { c9Meta } from './meta';
import { c9Render } from './render';

/**
 * C-9 鑰匙與門的規則測試（小規格 `docs/cards/C-9.md`「量測計畫與先寫的測試」）。
 *
 * 物理與評估的測試用一座手工的小迷宮 `TEST_LAYOUT`（座標是格子 (x, y)）：
 *
 *     一個環：x 2 到 12、y 4 到 10 的外圈（32 格）
 *     門前的死路：(8,3) (8,2) (8,1)，門在 (8,0)，從環上的 (8,4) 往上進去
 *     環下面的死胡同：(8,11) 到 (8,15)，從環上的 (8,10) 往下進去
 *     鑰匙在 (12,8)（右邊那條邊的中間，節點）
 *     （座標的奇偶跟真的迷宮一樣：節點是 (偶, 偶)，兩個節點之間的通道格有一個座標是奇數）
 *
 * 預設：人 (4,4) 往右、AI (10,10) 往左，各 4 格，第 0 局、已過開局不動時間（`roundTick` 0）。
 * 蛇每 6 個 tick 走一格：`roundTick` 設成 5，下一次 step 就走格。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_UP: Buttons = { ...NONE, up: true };
const PRESS_RIGHT: Buttons = { ...NONE, right: true };
const PRESS_DOWN: Buttons = { ...NONE, down: true };
const PRESS_LEFT: Buttons = { ...NONE, left: true };
const IDLE: Inputs = [NONE, NONE];

const UP = 0;
const RIGHT = 1;
const DOWN = 2;
const LEFT = 3;

function line(x0: number, y0: number, x1: number, y1: number): number[] {
  const cells: number[] = [];
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  for (let x = x0, y = y0; ; x += dx, y += dy) {
    cells.push(cell(x, y));
    if (x === x1 && y === y1) {
      break;
    }
  }
  return cells;
}

const RING = [
  ...line(2, 4, 12, 4),
  ...line(12, 5, 12, 10),
  ...line(11, 10, 2, 10),
  ...line(2, 9, 2, 5),
];
const POCKET = line(8, 3, 8, 0);
const STUB = line(8, 11, 8, 15);
const DOOR = cell(8, 0);
const KEY = cell(12, 8);

function wallsOf(open: readonly number[]): string {
  const set = new Set(open);
  let text = '';
  for (let c = 0; c < CELLS; c += 1) {
    text += set.has(c) ? '.' : '#';
  }
  return text;
}

const TEST_LAYOUT: Layout = {
  walls: wallsOf([...RING, ...POCKET, ...STUB]),
  key: KEY,
  door: DOOR,
  starts: [
    [cell(4, 4), cell(3, 4), cell(2, 4), cell(2, 5)],
    [cell(10, 10), cell(11, 10), cell(12, 10), cell(12, 9)],
  ],
};

/** 頭在 (x, y)，身體沿著 `trail` 往後接（trail 是離頭由近到遠的三格）。 */
function snakeAt(head: [number, number], ...trail: [number, number][]): number[] {
  return [cell(head[0], head[1]), ...trail.map(([x, y]) => cell(x, y))];
}

function st(overrides: Parameters<typeof makeState>[0] = {}): C9State {
  return makeState({ layout: TEST_LAYOUT, ...overrides });
}
function step(state: C9State, inputs: Inputs = IDLE): C9State {
  return c9Game.step(state, inputs);
}
function run(state: C9State, ticks: number, inputs: Inputs = IDLE): C9State {
  let current = state;
  for (let i = 0; i < ticks; i += 1) {
    current = step(current, inputs);
  }
  return current;
}
function head(state: C9State, side: Side): number {
  return state.snakes[side].body[0] as number;
}

// ---------------------------------------------------------------------------
// 迷宮與佈局（真正的生成）
// ---------------------------------------------------------------------------

/** 獨立的廣度優先搜尋（不用 `distFrom`），只看牆的字串。 */
function bfsWalls(walls: string, from: number): number[] {
  const dist: number[] = new Array<number>(CELLS).fill(-1);
  dist[from] = 0;
  const queue = [from];
  for (let i = 0; i < queue.length; i += 1) {
    const c = queue[i] as number;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const x = cellX(c) + dx;
      const y = cellY(c) + dy;
      if (x < 0 || x >= 32 || y < 0 || y >= 24) {
        continue;
      }
      const n = cell(x, y);
      if (walls[n] === '.' && dist[n] === -1) {
        dist[n] = (dist[c] as number) + 1;
        queue.push(n);
      }
    }
  }
  return dist;
}

function openNeighbors(walls: string, c: number): number[] {
  return [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ]
    .map(([dx, dy]) => [cellX(c) + (dx as number), cellY(c) + (dy as number)] as const)
    .filter(([x, y]) => x >= 0 && x < 32 && y >= 0 && y < 24 && walls[cell(x, y)] === '.')
    .map(([x, y]) => cell(x, y));
}

const SEEDS = Array.from({ length: 25 }, (_, i) => i);

describe('C-9 鑰匙與門｜迷宮與佈局', () => {
  it('每座迷宮：通道只在偶數節點與其間的格子、最右一欄與最下一列是牆、全部連通、至少 10 個環', () => {
    for (const seed of SEEDS) {
      for (const index of [0, 1] as const) {
        const { walls } = buildLayout(seed, index);
        expect(walls).toHaveLength(CELLS);
        let openCount = 0;
        for (let c = 0; c < CELLS; c += 1) {
          if (walls[c] === '.') {
            openCount += 1;
            expect(!(cellX(c) % 2 === 1 && cellY(c) % 2 === 1), `(奇,奇) 不該是通道 ${seed}`).toBe(
              true,
            );
            expect(cellX(c), '最右一欄是牆').toBeLessThan(31);
            expect(cellY(c), '最下一列是牆').toBeLessThan(23);
          }
        }
        const nodes = MAZE_W * MAZE_H;
        for (let j = 0; j < MAZE_H; j += 1) {
          for (let i = 0; i < MAZE_W; i += 1) {
            expect(walls[cell(2 * i, 2 * j)], `節點 (${2 * i},${2 * j}) 必須是通道`).toBe('.');
          }
        }
        // 通道格 ＝ 節點 ＋ 打通的邊；邊數 − 節點數 ＋ 1 ＝ 環的個數
        const edges = openCount - nodes;
        expect(edges - nodes + 1, `${seed}/${index} 的環`).toBeGreaterThanOrEqual(MIN_CYCLES);
        const dist = bfsWalls(walls, cell(0, 0));
        for (let c = 0; c < CELLS; c += 1) {
          if (walls[c] === '.') {
            expect(dist[c], `${seed}/${index} 有通道連不到`).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it('編織型：打通額外的牆的比例落在 BRAID 附近（平均環數遠多於最低要求）', () => {
    let cycles = 0;
    let count = 0;
    for (const seed of SEEDS) {
      const walls = buildLayout(seed, 0).walls;
      const open = [...walls].filter((ch) => ch === '.').length;
      cycles += open - MAZE_W * MAZE_H - MAZE_W * MAZE_H + 1;
      count += 1;
    }
    // 不是樹的邊（共約 165 條）× BRAID ≈ 20 個環
    expect(cycles / count).toBeGreaterThan(MIN_CYCLES);
    expect(cycles / count).toBeLessThan(BRAID * 400);
  });

  it('門是死胡同（只有一條通道），門前 6 步內有一個環', () => {
    for (const seed of SEEDS) {
      for (const index of [0, 1] as const) {
        const { walls, door } = buildLayout(seed, index);
        expect(openNeighbors(walls, door), `${seed}/${index}`).toHaveLength(1);
        const dist = bfsWalls(walls, door);
        let cells = 0;
        let edges = 0;
        for (let c = 0; c < CELLS; c += 1) {
          if ((dist[c] as number) >= 0 && (dist[c] as number) <= 6) {
            cells += 1;
            for (const n of openNeighbors(walls, c)) {
              if ((dist[n] as number) >= 0 && (dist[n] as number) <= 6 && n > c) {
                edges += 1;
              }
            }
          }
        }
        // 連通的圖：邊數 ≥ 格數 ⇔ 有環
        expect(edges, `${seed}/${index} 門前 6 步內沒有環`).toBeGreaterThanOrEqual(cells);
      }
    }
  });

  it('鑰匙離門最短路至少 35 步，而且不在死胡同裡（至少兩條通道）', () => {
    for (const seed of SEEDS) {
      for (const index of [0, 1] as const) {
        const { walls, door, key } = buildLayout(seed, index);
        expect((bfsWalls(walls, door)[key] as number) >= KEY_MIN_PATH, `${seed}/${index}`).toBe(
          true,
        );
        expect(openNeighbors(walls, key).length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('起點：蛇頭曼哈頓距離至少 30、各離門與鑰匙至少 12 步、蛇長 4、身體是相連的通道', () => {
    for (const seed of SEEDS) {
      for (const index of [0, 1] as const) {
        const layout = buildLayout(seed, index);
        const [a, b] = layout.starts;
        const ha = a[0] as number;
        const hb = b[0] as number;
        expect(a).toHaveLength(SNAKE_LEN);
        expect(b).toHaveLength(SNAKE_LEN);
        expect(
          Math.abs(cellX(ha) - cellX(hb)) + Math.abs(cellY(ha) - cellY(hb)),
        ).toBeGreaterThanOrEqual(30);
        for (const body of [a, b]) {
          for (let k = 0; k < body.length; k += 1) {
            expect(layout.walls[body[k] as number]).toBe('.');
            if (k > 0) {
              const gap =
                Math.abs(cellX(body[k] as number) - cellX(body[k - 1] as number)) +
                Math.abs(cellY(body[k] as number) - cellY(body[k - 1] as number));
              expect(gap).toBe(1);
            }
          }
        }
        expect(new Set([...a, ...b]).size, '兩條蛇的身體不重疊').toBe(2 * SNAKE_LEN);
        for (const target of [layout.door, layout.key]) {
          const dist = bfsWalls(layout.walls, target);
          expect(dist[ha] as number).toBeGreaterThanOrEqual(12);
          expect(dist[hb] as number).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it('鑰匙到兩個起點的最短路步數相差至少 KEY_MIN_DIFF（不會兩邊同時抵達同一格）', () => {
    for (const seed of SEEDS) {
      for (const index of [0, 1] as const) {
        const layout = buildLayout(seed, index);
        const dist = bfsWalls(layout.walls, layout.key);
        const gap = Math.abs(
          (dist[layout.starts[0][0] as number] as number) -
            (dist[layout.starts[1][0] as number] as number),
        );
        expect(gap, `${seed}/${index}`).toBeGreaterThanOrEqual(KEY_MIN_DIFF);
      }
    }
  });

  it('同一個種子產生同一座迷宮；兩座迷宮不同；種子 0 到 9 的迷宮不全相同', () => {
    expect(buildLayout(3, 0)).toEqual(buildLayout(3, 0));
    const firsts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      firsts.add(buildLayout(seed, 0).walls);
      expect(buildLayout(seed, 0).walls).not.toBe(buildLayout(seed, 1).walls);
    }
    expect(firsts.size).toBeGreaterThan(1);
    const state = initC9State(5, CONFIG);
    expect(state.layouts[0].walls).not.toBe(state.layouts[1].walls);
  });

  it('最短路表與獨立的廣度優先一致（門、鑰匙、任意格子）', () => {
    for (const seed of [0, 1, 2, 3, 4]) {
      const layout = buildLayout(seed, 0);
      const info = mazeInfo(layout);
      for (const target of [layout.door, layout.key, layout.starts[0][0] as number]) {
        const table = distFrom(info, target);
        const expected = bfsWalls(layout.walls, target);
        for (let c = 0; c < CELLS; c += 1) {
          expect(table[c]).toBe(expected[c]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 一場的結構
// ---------------------------------------------------------------------------

describe('C-9 鑰匙與門｜一場的結構', () => {
  it('maxTicks 小於 400 時 init 丟 RangeError；一局上限是 floor((maxTicks − 3×40 − 4×30) / 4)', () => {
    expect(() => c9Game.init(0, { maxTicks: 399, params: {} })).toThrow(RangeError);
    expect(() => c9Game.init(0, { maxTicks: 0, params: {} })).toThrow(RangeError);
    expect(roundTicksFor(3600)).toBe(840);
    expect(roundTicksFor(400)).toBe(40);
    expect(4 * (ROUND_FREEZE + 840) + 3 * PAUSE).toBe(3600);
    expect(c9Game.init(0, CONFIG).roundTicks).toBe(840);
  });

  it('init：第 0 局、開局不動 30 tick、兩條蛇各長 4、分數 0、鑰匙在地上、沒有食物', () => {
    for (const seed of [0, 1, 2]) {
      const state = c9Game.init(seed, CONFIG);
      expect(state.round).toBe(0);
      expect(state.roundTick).toBe(-ROUND_FREEZE);
      expect(state.pause).toBe(0);
      expect(state.over).toBe(false);
      expect(state.keyHolder).toBeNull();
      expect(state.foods).toEqual([]);
      expect(state.stalemates).toBe(0);
      expect(state.snakes[0].body).toHaveLength(SNAKE_LEN);
      expect(state.snakes[1].body).toHaveLength(SNAKE_LEN);
      expect(c9Game.score(state)).toEqual([0, 0]);
      expect(state.key).toBe(layoutOf(state).key);
    }
  });

  it('公平：第 0、1 局是同一座迷宮、起點交換；第 2、3 局是第二座迷宮、同樣交換', () => {
    const state = c9Game.init(7, CONFIG);
    const [first, second] = state.layouts;
    const at = (round: 0 | 1 | 2 | 3): C9State =>
      makeState({ layout: round < 2 ? first : second, round });
    expect(at(0).snakes[0].body).toEqual(first.starts[0]);
    expect(at(0).snakes[1].body).toEqual(first.starts[1]);
    expect(at(1).snakes[0].body).toEqual(first.starts[1]);
    expect(at(1).snakes[1].body).toEqual(first.starts[0]);
    expect(at(3).snakes[0].body).toEqual(second.starts[1]);
    expect(layoutOf({ ...state, round: 1 })).toBe(first);
    expect(layoutOf({ ...state, round: 2 })).toBe(second);
    expect(layoutOf({ ...state, round: 3 })).toBe(second);
  });

  it('一局結束後停頓 40 tick，之後下一局開始：起點交換、分數保留、鑰匙與轉向重置', () => {
    const base = st({
      round: 0,
      pause: 1,
      outcome: 'side0',
      snakes: [{ score: 1 }, {}],
      keyHolder: 0,
      wants: [UP, DOWN],
    });
    const next = step(base);
    expect(next.round).toBe(1);
    expect(next.roundTick).toBe(-ROUND_FREEZE);
    expect(next.pause).toBe(0);
    expect(next.outcome).toBeNull();
    expect(next.keyHolder).toBeNull();
    expect(next.key).toBe(KEY);
    expect(next.wants).toEqual([-1, -1]);
    expect(next.snakes[0].body).toEqual(TEST_LAYOUT.starts[1]);
    expect(next.snakes[1].body).toEqual(TEST_LAYOUT.starts[0]);
    expect(next.snakes[0].score).toBe(1);
    expect(next.snakes[0].alive).toBe(true);
  });

  it('停頓中誰都不動、輸入被忽略；一局結束時 pause 設成 40', () => {
    const paused = st({ pause: 5, outcome: 'draw' });
    const after = step(paused, [PRESS_UP, PRESS_DOWN]);
    expect(after.pause).toBe(4);
    expect(after.snakes[0].body).toEqual(paused.snakes[0].body);
    expect(after.wants).toEqual([-1, -1]);
    const ended = step(
      st({ roundTick: 5, snakes: [{}, { body: snakeAt([8, 15], [8, 14], [8, 13], [8, 12]) }] }),
    );
    expect(ended.pause).toBe(PAUSE);
  });
});

// ---------------------------------------------------------------------------
// 轉向
// ---------------------------------------------------------------------------

describe('C-9 鑰匙與門｜轉向（按了就記著，走到能轉的路口才轉）', () => {
  it('按方向鍵：下一次走格能轉就轉；按住與只點一下的結果一樣', () => {
    const state = st({
      snakes: [{ body: snakeAt([8, 4], [7, 4], [6, 4], [5, 4]) }, {}],
      roundTick: 0,
    });
    const held = run(state, 6, [PRESS_UP, NONE]);
    expect(head(held, 0)).toBe(cell(8, 3));
    expect(held.snakes[0].dir).toBe(UP);
    const tapped = run(step(state, [PRESS_UP, NONE]), 5);
    expect(head(tapped, 0)).toBe(cell(8, 3));
    expect(tapped.snakes[0].dir).toBe(UP);
    expect(tapped.wants[0]).toBe(-1);
  });

  it('現在轉不了的方向會記著，走到能轉的路口才轉（記著的方向在轉過之後清掉）', () => {
    // 人在 (4,4) 往右；上面是牆。只在第一個 tick 按上，之後放開。
    let state = st({ roundTick: 0 });
    state = step(state, [PRESS_UP, NONE]);
    expect(state.wants[0]).toBe(UP);
    expect(state.snakes[0].turn).toBe(RIGHT);
    state = run(state, 5);
    expect(head(state, 0)).toBe(cell(5, 4));
    expect(state.wants[0]).toBe(UP);
    state = run(state, 18);
    expect(head(state, 0)).toBe(cell(8, 4));
    // 到了 (8,4)，上面是門前的死路：下一次走格就轉進去
    expect(state.snakes[0].turn).toBe(UP);
    state = run(state, 6);
    expect(head(state, 0)).toBe(cell(8, 3));
    expect(state.snakes[0].dir).toBe(UP);
    expect(state.wants[0]).toBe(-1);
  });

  it('前面是牆就自動沿著通道轉彎：只有一個出口就轉進去，兩個出口時順時針那一個在前', () => {
    // 往右到右上角 (12,4)：直走是牆，唯一的出口往下
    let state = st({
      snakes: [{ body: snakeAt([11, 4], [10, 4], [9, 4], [8, 4]) }, {}],
      roundTick: 5,
    });
    state = step(state);
    expect(head(state, 0)).toBe(cell(12, 4));
    expect(state.snakes[0].turn).toBe(DOWN);
    state = run(state, 6);
    expect(head(state, 0)).toBe(cell(12, 5));
    expect(state.snakes[0].dir).toBe(DOWN);
    // 往左到左上角 (2,4)：順時針（往上）是牆，逆時針（往下）是通道
    let left = st({
      snakes: [{ body: snakeAt([3, 4], [4, 4], [5, 4], [6, 4]) }, {}],
      roundTick: 5,
    });
    left = step(left);
    expect(head(left, 0)).toBe(cell(2, 4));
    expect(left.snakes[0].turn).toBe(DOWN);
    // 直走走得通的時候不會自動轉：往右走到 (8,10)（下面是死胡同的入口），仍然直走
    const through = st({
      snakes: [{ body: snakeAt([7, 10], [6, 10], [5, 10], [4, 10]) }, {}],
      roundTick: 5,
    });
    const after = step(through);
    expect(head(after, 0)).toBe(cell(8, 10));
    expect(after.snakes[0].turn).toBe(RIGHT);
  });

  it('不能掉頭：按反方向沒有用；按原本的前進方向會取消記著的轉向', () => {
    let state = st({ roundTick: 0 });
    state = step(state, [PRESS_LEFT, NONE]);
    expect(state.wants[0]).toBe(-1);
    expect(state.snakes[0].turn).toBe(RIGHT);
    state = step(state, [PRESS_UP, NONE]);
    expect(state.wants[0]).toBe(UP);
    state = step(state, [PRESS_RIGHT, NONE]);
    expect(state.wants[0]).toBe(-1);
    // 沒按任何鍵不會取消
    state = step(state, [PRESS_DOWN, NONE]);
    state = step(state, IDLE);
    expect(state.wants[0]).toBe(DOWN);
  });

  it('開局不動的 30 tick 裡可以先轉向，但不走格；第 31 到 36 個 tick 之間才第一次走格', () => {
    let state = st({ roundTick: -ROUND_FREEZE });
    state = step(state, [PRESS_UP, NONE]);
    const start = head(state, 0);
    state = run(state, 34);
    expect(state.roundTick).toBe(5);
    expect(head(state, 0)).toBe(start);
    expect(state.wants[0]).toBe(UP);
    state = step(state);
    expect(state.roundTick).toBe(6);
    expect(head(state, 0)).not.toBe(start);
  });
});

// ---------------------------------------------------------------------------
// 物理與勝負
// ---------------------------------------------------------------------------

describe('C-9 鑰匙與門｜走格與勝負', () => {
  it('蛇每 6 個 tick 走一格，兩條同時走', () => {
    const state = st({ roundTick: 4 });
    const idle = step(state);
    expect(head(idle, 0)).toBe(head(state, 0));
    expect(head(idle, 1)).toBe(head(state, 1));
    const moved = step(idle);
    expect(head(moved, 0)).toBe(cell(5, 4));
    expect(head(moved, 1)).toBe(cell(9, 10));
    expect(moved.snakes[0].body).toHaveLength(SNAKE_LEN);
  });

  it('撞進死胡同的盡頭：那條蛇死，活著的得 1 分，局結束進入停頓', () => {
    const state = st({
      roundTick: 5,
      snakes: [{}, { body: snakeAt([8, 15], [8, 14], [8, 13], [8, 12]) }],
    });
    const after = step(state);
    expect(after.snakes[1].alive).toBe(false);
    expect(after.snakes[0].alive).toBe(true);
    expect(after.outcome).toBe('side0');
    expect(after.snakes[0].score).toBe(1);
    expect(after.snakes[1].score).toBe(0);
    expect(after.pause).toBe(PAUSE);
    expect(after.over).toBe(false);
  });

  it('撞到別條蛇的身體：撞的那條死', () => {
    // 人走在下面那條邊 (9,10) 往右，身體經過 (8,10)；AI 從死胡同 (8,11) 往上走，下一格就是 (8,10)
    const state = st({
      roundTick: 5,
      snakes: [
        { body: snakeAt([9, 10], [8, 10], [7, 10], [6, 10]) },
        { body: snakeAt([8, 11], [8, 12], [8, 13], [8, 14]) },
      ],
    });
    const after = step(state);
    expect(after.snakes[1].alive).toBe(false);
    expect(after.snakes[0].alive).toBe(true);
    expect(after.outcome).toBe('side0');
  });

  it('尾巴豁免：走進對手這一格剛離開的尾巴不算撞（邊界：同一個 tick 尾巴離開、頭走進來）', () => {
    const state = st({
      roundTick: 5,
      snakes: [
        { body: snakeAt([5, 4], [4, 4], [3, 4], [2, 4]) },
        { body: snakeAt([2, 5], [2, 6], [2, 7], [2, 8]) },
      ],
    });
    // AI 要往上走進 (2,4)，那是人的尾巴
    const after = step(state, [NONE, PRESS_UP]);
    expect(after.snakes[0].alive).toBe(true);
    expect(after.snakes[1].alive).toBe(true);
    expect(head(after, 1)).toBe(cell(2, 4));
    expect(after.outcome).toBeNull();
  });

  it('頭對頭走進同一格：兩條都死，這一局平手，沒人得分（邊界：同一個 tick 兩件事）', () => {
    const state = st({
      roundTick: 5,
      snakes: [
        { body: snakeAt([5, 4], [4, 4], [3, 4], [2, 4]) },
        { body: snakeAt([7, 4], [8, 4], [9, 4], [10, 4]), dir: LEFT },
      ],
    });
    const after = step(state);
    expect(after.snakes[0].alive).toBe(false);
    expect(after.snakes[1].alive).toBe(false);
    expect(after.outcome).toBe('draw');
    expect(c9Game.score(after)).toEqual([0, 0]);
    expect(after.pause).toBe(PAUSE);
  });

  it('頭對頭互換位置（相鄰、面對面）：也是兩條都死', () => {
    const state = st({
      roundTick: 5,
      snakes: [
        { body: snakeAt([5, 4], [4, 4], [3, 4], [2, 4]) },
        { body: snakeAt([6, 4], [7, 4], [8, 4], [9, 4]), dir: LEFT },
      ],
    });
    const after = step(state);
    expect(after.snakes[0].alive).toBe(false);
    expect(after.snakes[1].alive).toBe(false);
    expect(after.outcome).toBe('draw');
  });

  it('蛇頭走進鑰匙的格子就叼起來，並記下 roundTick；之後對手走進同一格不會再拿', () => {
    const state = st({
      roundTick: 5,
      snakes: [{ body: snakeAt([12, 7], [12, 6], [12, 5], [12, 4]), dir: DOWN }, {}],
    });
    const after = step(state);
    expect(head(after, 0)).toBe(KEY);
    expect(after.keyHolder).toBe(0);
    expect(after.keyTicks).toEqual([6, -1]);
    expect(after.outcome).toBeNull();
  });

  it('沒有鑰匙走進門：死（門當牆），對手得 1 分', () => {
    const state = st({
      roundTick: 5,
      snakes: [{ body: snakeAt([8, 1], [8, 2], [8, 3], [8, 4]), dir: UP }, {}],
    });
    const after = step(state);
    expect(after.snakes[0].alive).toBe(false);
    expect(after.outcome).toBe('side1');
    expect(after.snakes[1].score).toBe(1);
  });

  it('叼著鑰匙走進門：這一條得 1 分，局結束，自己還活著', () => {
    const state = st({
      roundTick: 5,
      keyHolder: 0,
      snakes: [{ body: snakeAt([8, 1], [8, 2], [8, 3], [8, 4]), dir: UP }, {}],
    });
    const after = step(state);
    expect(head(after, 0)).toBe(DOOR);
    expect(after.snakes[0].alive).toBe(true);
    expect(after.outcome).toBe('side0');
    expect(after.snakes[0].score).toBe(1);
    expect(after.pause).toBe(PAUSE);
    expect(after.over).toBe(false);
  });

  it('叼著鑰匙進門的同一個 tick 對手撞死：只算進門的一分，不算兩分（邊界）', () => {
    const state = st({
      roundTick: 5,
      keyHolder: 0,
      snakes: [
        { body: snakeAt([8, 1], [8, 2], [8, 3], [8, 4]), dir: UP },
        { body: snakeAt([8, 15], [8, 14], [8, 13], [8, 12]) },
      ],
    });
    const after = step(state);
    expect(after.outcome).toBe('side0');
    expect(after.snakes[0].score).toBe(1);
    expect(after.snakes[1].alive).toBe(false);
  });

  it('時間到沒人進門也沒人死：僵局，這一局平手，記一次 stalemates', () => {
    const state = st({ roundTick: 839 });
    const after = step(state);
    expect(after.roundTick).toBe(840);
    expect(after.outcome).toBe('stalemate');
    expect(after.stalemates).toBe(1);
    expect(c9Game.score(after)).toEqual([0, 0]);
    expect(after.pause).toBe(PAUSE);
    expect(after.snakes[0].alive).toBe(true);
    expect(after.snakes[1].alive).toBe(true);
  });

  it('最後一局結束：整場結束，分數高的贏；同分平手', () => {
    const win = step(
      st({
        round: 3,
        roundTick: 5,
        keyHolder: 0,
        snakes: [
          { body: snakeAt([8, 1], [8, 2], [8, 3], [8, 4]), dir: UP, score: 1 },
          { score: 1 },
        ],
      }),
    );
    expect(win.over).toBe(true);
    expect(win.winner).toBe(0);
    expect(c9Game.score(win)).toEqual([2, 1]);
    expect(c9Game.winner(win)).toBe(0);
    const tie = step(st({ round: 3, roundTick: 839, snakes: [{ score: 1 }, { score: 1 }] }));
    expect(tie.over).toBe(true);
    expect(tie.winner).toBeNull();
    expect(c9Game.winner(tie)).toBeNull();
    // over 之後 step 原樣回傳
    expect(step(win)).toBe(win);
  });

  it('最後一局之前 isOver 是 false，winner 回傳 null', () => {
    const state = st({ round: 2, outcome: 'side0', pause: 5 });
    expect(c9Game.isOver(state)).toBe(false);
    expect(c9Game.winner(state)).toBeNull();
  });
});

describe('C-9 鑰匙與門｜鑰匙漂移（實驗用，預設關閉）', () => {
  const info = mazeInfo(TEST_LAYOUT);
  const toDoor = distFrom(info, DOOR);

  it('預設鑰匙不動', () => {
    const after = run(st({ roundTick: 290 }), 20);
    expect(after.key).toBe(KEY);
  });

  it('開啟後，鑰匙在地上時每 driftEvery tick 往門的方向走 driftCells 格', () => {
    const state = st({ driftCells: 3, driftEvery: 300, roundTick: 299 });
    const after = step(state);
    expect(after.roundTick).toBe(300);
    expect(toDoor[after.key]).toBe((toDoor[KEY] as number) - 3);
  });

  it('沒有人叼著鑰匙才漂；漂到門前死路之前停下來（不會漂進死路）', () => {
    const held = step(st({ driftCells: 3, driftEvery: 300, roundTick: 299, keyHolder: 1 }));
    expect(held.key).toBe(KEY);
    const far = step(st({ driftCells: 50, driftEvery: 300, roundTick: 299 }));
    expect(far.key).toBe(cell(8, 4));
  });
});

// ---------------------------------------------------------------------------
// step 是純的
// ---------------------------------------------------------------------------

describe('C-9 鑰匙與門｜step', () => {
  it('不改動傳進來的 state（深度凍結後呼叫不丟錯，前後雜湊相同）', () => {
    const state = deepFreeze(c9Game.init(3, CONFIG));
    const before = JSON.stringify(state);
    let current: C9State = state;
    for (let i = 0; i < 200; i += 1) {
      current = step(current, i % 7 === 0 ? [PRESS_DOWN, PRESS_LEFT] : IDLE);
    }
    expect(JSON.stringify(state)).toBe(before);
    const frozen = deepFreeze(st({ roundTick: 5 }));
    expect(() => step(frozen)).not.toThrow();
  });

  it('state 可以序列化：JSON 來回之後繼續走，結果相同', () => {
    let a = c9Game.init(4, CONFIG);
    let b = JSON.parse(JSON.stringify(a)) as C9State;
    for (let i = 0; i < 400; i += 1) {
      const inputs: Inputs = i % 11 === 0 ? [PRESS_UP, PRESS_RIGHT] : IDLE;
      a = step(a, inputs);
      b = step(b, inputs);
      if (i % 100 === 99) {
        b = JSON.parse(JSON.stringify(b)) as C9State;
      }
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

describe('C-9 鑰匙與門｜actions 與 evaluate', () => {
  it('停頓、局結束、整場結束：只有「全放開」一個動作', () => {
    for (const state of [
      st({ pause: 5, outcome: 'draw' }),
      st({ outcome: 'side0' }),
      st({ over: true }),
    ]) {
      expect(c9Game.actions(state, 0)).toEqual([NONE]);
      expect(c9Game.actions(state, 1)).toEqual([NONE]);
    }
  });

  it('在門前路口 (8,4)：沒鑰匙時進死路排最後（確定會死）；叼著鑰匙時往門的方向排最前', () => {
    const body = snakeAt([8, 4], [7, 4], [6, 4], [5, 4]);
    const plain = st({ snakes: [{ body }, {}] });
    expect(c9Game.actions(plain, 0)).toEqual([PRESS_RIGHT, PRESS_UP]);
    const holder = st({ snakes: [{ body }, {}], keyHolder: 0 });
    expect(c9Game.actions(holder, 0)).toEqual([PRESS_UP, PRESS_RIGHT]);
  });

  it('蛇頭在通道上時往前多看一格：按的方向在下一個節點生效，評估與排序看的是節點之後的出口', () => {
    // 人在通道 (7,4) 往右，下一個節點是 (8,4)（門前路口）。叼著鑰匙時往上走的出口比直走好。
    const body = snakeAt([7, 4], [6, 4], [5, 4], [4, 4]);
    const info = mazeInfo(TEST_LAYOUT);
    const toDoor = distFrom(info, DOOR);
    const holder = st({ snakes: [{ body }, {}], keyHolder: 0 });
    expect(c9Game.actions(holder, 0)).toEqual([PRESS_UP, PRESS_RIGHT]);
    const pressedUp = step(holder, [PRESS_UP, NONE]);
    expect(pressedUp.snakes[0].turn).toBe(RIGHT); // 通道上沒得選，這一步還是直走
    expect(c9Game.evaluate(pressedUp, 0).gain).toBe(-(toDoor[cell(8, 3)] as number));
    const straight = step(holder, [PRESS_RIGHT, NONE]);
    expect(c9Game.evaluate(straight, 0).gain).toBe(-(toDoor[cell(9, 4)] as number));
    // 沒有鑰匙：往上是死路，排最後，評估是確定會死
    const plain = st({ snakes: [{ body }, {}] });
    expect(c9Game.actions(plain, 0)).toEqual([PRESS_RIGHT, PRESS_UP]);
    expect(c9Game.evaluate(step(plain, [PRESS_UP, NONE]), 0).danger).toBe(1);
    // 真的走到節點之後，記著的往上就生效
    const arrived = run(pressedUp, 6);
    expect(head(arrived, 0)).toBe(cell(8, 4));
    expect(arrived.snakes[0].turn).toBe(UP);
  });

  it('actions 的排序與 evaluate 的 gain 同一個標準：照 actions 的順序，套用後的 gain 不會變大', () => {
    // 從幾場對局裡每 7 tick 取一個局面（避開下一個 tick 就走格的），兩邊都驗
    let checked = 0;
    for (let seed = 0; seed < 8; seed += 1) {
      let state = c9Game.init(seed, CONFIG);
      const a = levelController(c9Game, pathfinder, 6, seed);
      const b = levelController(c9Game, pathfinder, 6, seed + 1000003);
      for (let tick = 0; tick < 1500 && !state.over; tick += 1) {
        const usable =
          tick % 7 === 0 &&
          state.pause === 0 &&
          state.outcome === null &&
          (state.roundTick + 1) % 6 !== 0;
        if (usable) {
          for (const side of [0, 1] as const) {
            const actions = c9Game.actions(state, side);
            const gains = actions.map((action) => {
              const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
              return c9Game.evaluate(step(state, inputs), side).gain;
            });
            for (let i = 1; i < gains.length; i += 1) {
              expect(
                gains[i] as number,
                `種子 ${seed} tick ${tick} 邊 ${side}`,
              ).toBeLessThanOrEqual((gains[i - 1] as number) + 1e-9);
            }
            checked += 1;
          }
        }
        state = step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('確定會死的動作 gain 扣 DEATH_GAIN（比任何距離梯度大），而且 danger 是 1', () => {
    const body = snakeAt([8, 4], [7, 4], [6, 4], [5, 4]);
    const state = st({ snakes: [{ body }, {}] });
    const safe = c9Game.evaluate(step(state, [PRESS_RIGHT, NONE]), 0);
    const deadly = c9Game.evaluate(step(state, [PRESS_UP, NONE]), 0);
    expect(deadly.danger).toBe(1);
    expect(safe.gain - deadly.gain).toBeGreaterThan(DEATH_GAIN - 40);
  });

  it('沒有領先者懲罰：兩邊的總分差只出現在 100 × 差 這一項', () => {
    const level = st();
    const ahead = st({ snakes: [{ score: 3 }, {}] });
    const behind = st({ snakes: [{}, { score: 2 }] });
    for (const side of [0, 1] as const) {
      expect(c9Game.evaluate(ahead, side).danger).toBe(c9Game.evaluate(level, side).danger);
    }
    expect(c9Game.evaluate(ahead, 0).gain - c9Game.evaluate(level, 0).gain).toBe(
      3 * GAIN_PER_ROUND,
    );
    expect(c9Game.evaluate(ahead, 1).gain - c9Game.evaluate(level, 1).gain).toBe(
      -3 * GAIN_PER_ROUND,
    );
    expect(c9Game.evaluate(behind, 0).gain - c9Game.evaluate(level, 0).gain).toBe(
      -2 * GAIN_PER_ROUND,
    );
  });

  it('叼著鑰匙：下一步是門的 gain 大於 WIN_GAIN；沒有鑰匙下一步是門 danger 為 1', () => {
    const body = snakeAt([8, 1], [8, 2], [8, 3], [8, 4]);
    const holder = st({ snakes: [{ body, dir: UP }, {}], keyHolder: 0 });
    const win = c9Game.evaluate(holder, 0);
    expect(win.gain).toBeGreaterThanOrEqual(WIN_GAIN);
    expect(win.danger).toBe(0);
    const keyless = st({ snakes: [{ body, dir: UP }, {}] });
    expect(c9Game.evaluate(keyless, 0).danger).toBe(1);
    expect(c9Game.evaluate(keyless, 0).gain).toBeLessThan(0);
  });

  it('對手叼著鑰匙：gain ＝ GUARD × clamp(對手到門 − 我到門, ±GUARD_CAP)（守位）', () => {
    const info = mazeInfo(TEST_LAYOUT);
    const toDoor = distFrom(info, DOOR);
    const state = st({
      snakes: [{}, { body: snakeAt([12, 8], [12, 7], [12, 6], [12, 5]), dir: DOWN }],
      keyHolder: 1,
    });
    // 人 (4,4) 往右：下一格 (5,4)；AI (12,8) 往下：下一格 (12,9)
    const md = toDoor[cell(5, 4)] as number;
    const od = toDoor[cell(12, 9)] as number;
    const expected = GUARD * Math.max(-GUARD_CAP, Math.min(GUARD_CAP, od - md));
    expect(c9Game.evaluate(state, 0).gain).toBe(expected);
    // 離門比對手更遠 → 同一個公式變小
    const far = st({
      snakes: [
        { body: snakeAt([10, 10], [11, 10], [12, 10], [12, 9]) },
        { body: snakeAt([8, 4], [9, 4], [10, 4], [11, 4]), dir: LEFT },
      ],
      keyHolder: 1,
    });
    expect(c9Game.evaluate(far, 0).gain).toBe(-GUARD * GUARD_CAP);
  });

  it('鑰匙在地上：離鑰匙比較近的去拿（gain ＝ −到鑰匙的步數），比較遠而且對手正走向鑰匙的去守門', () => {
    const info = mazeInfo(TEST_LAYOUT);
    const toKey = distFrom(info, KEY);
    const toDoor = distFrom(info, DOOR);
    // 人比較近：(12,5) 在通道上往下，下一格是節點 (12,6)，再走一格到 (12,7)（離鑰匙 1）；評估看的是 (12,7)
    const favorite = st({
      snakes: [
        { body: snakeAt([12, 5], [12, 4], [11, 4], [10, 4]), dir: DOWN },
        { body: snakeAt([2, 10], [3, 10], [4, 10], [5, 10]), dir: LEFT },
      ],
    });
    expect(c9Game.evaluate(favorite, 0).gain).toBe(-(toKey[cell(12, 7)] as number));
    // 人比較遠：(4,4) 往右；AI (12,5) 往下走向鑰匙
    const underdog = st({
      snakes: [{}, { body: snakeAt([12, 5], [12, 4], [11, 4], [10, 4]), dir: DOWN }],
    });
    const md = toDoor[cell(5, 4)] as number;
    const od = toDoor[cell(12, 6)] as number;
    expect(c9Game.evaluate(underdog, 0).gain).toBe(
      GUARD * Math.max(-GUARD_CAP, Math.min(GUARD_CAP, od - md)),
    );
    // 對手雖然比較近，但正在遠離鑰匙（往上）：不等它，我去拿
    const leaving = st({
      snakes: [{}, { body: snakeAt([12, 5], [12, 6], [12, 7], [12, 8]), dir: UP }],
    });
    expect(c9Game.evaluate(leaving, 0).gain).toBe(-(toKey[cell(5, 4)] as number));
  });

  it('對手靠近我的下一格（頭對頭的可能）：danger 大於 0；同一格是 DANGER_NEAR（0.4）', () => {
    const headOn = st({
      snakes: [{}, { body: snakeAt([6, 4], [7, 4], [8, 4], [9, 4]), dir: LEFT }],
    });
    expect(c9Game.evaluate(headOn, 0).danger).toBe(DANGER_NEAR);
    // 精準型的門檻是 0.3：所有真的有威脅的 danger 都要超過它（否則精準型把弱一點的威脅當安全）
    expect(DANGER_NEAR).toBe(0.4);
    expect(DANGER_FAR).toBe(0.31);
    const apart = st();
    expect(c9Game.evaluate(apart, 0).danger).toBe(0);
  });

  it('一局結束或整場結束的 evaluate：只剩分差（整場結束加減 RESULT_BONUS），死了 danger 是 1', () => {
    const ended = st({ pause: 5, outcome: 'side0', snakes: [{ score: 1 }, { alive: false }] });
    expect(c9Game.evaluate(ended, 0)).toEqual({ gain: GAIN_PER_ROUND, danger: 0 });
    expect(c9Game.evaluate(ended, 1)).toEqual({ gain: -GAIN_PER_ROUND, danger: 1 });
    const over = st({ over: true, winner: 0, snakes: [{ score: 2 }, { score: 1 }] });
    expect(c9Game.evaluate(over, 0).gain).toBe(GAIN_PER_ROUND + RESULT_BONUS);
    expect(c9Game.evaluate(over, 1).gain).toBe(-GAIN_PER_ROUND - RESULT_BONUS);
    const tied = st({ over: true, winner: null });
    expect(c9Game.evaluate(tied, 0).gain).toBe(0);
  });

  it('評估可用：打一場對局，兩邊每個 tick 的 gain 有限、danger 在 0 到 1 之間，actions 至少一個', () => {
    let state = c9Game.init(2, CONFIG);
    const a = levelController(c9Game, pathfinder, 4, 1);
    const b = levelController(c9Game, pathfinder, 4, 2);
    for (let tick = 0; tick < 1200 && !state.over; tick += 1) {
      for (const side of [0, 1] as const) {
        const e = c9Game.evaluate(state, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
        expect(c9Game.actions(state, side).length).toBeGreaterThanOrEqual(1);
      }
      state = step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
    }
  });
});

// ---------------------------------------------------------------------------
// meta 與畫面
// ---------------------------------------------------------------------------

describe('C-9 鑰匙與門｜meta 與畫面', () => {
  it('meta：C-9、梅花 9、搜尋型、基礎等級 3、對稱', () => {
    expect(c9Meta.id).toBe('C-9');
    expect(c9Meta.suit).toBe('C');
    expect(c9Meta.rank).toBe('9');
    expect(c9Meta.defaultPolicy).toBe('pathfinder');
    expect(c9Meta.baseLevel).toBe(3);
    expect(c9Meta.symmetric).toBe(true);
    expect(c9Meta.winnerNotByScore).not.toBe(true);
  });

  it('畫面：不改 state、只用色盤顏色、座標都在 320×240 之內，鑰匙與兩條蛇都畫出來', () => {
    const state = deepFreeze(step(run(c9Game.init(1, CONFIG), 100)));
    const before = JSON.stringify(state);
    const fake = createFakeContext();
    c9Render(asRenderingContext(fake), state);
    expect(JSON.stringify(state)).toBe(before);
    const used = fake.colors.filter((c) => c.via === 'set').map((c) => String(c.value));
    expect(used).toContain(COLOR.clubs);
    expect(used).toContain(COLOR.accent);
    expect(used).toContain(COLOR.diamonds);
    for (const p of fake.points) {
      expect(p.x).toBeGreaterThanOrEqual(-8);
      expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
      expect(p.y).toBeGreaterThanOrEqual(-8);
      expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
    }
  });

  it('局結束、停頓、整場結束、叼著鑰匙、死掉的蛇：都畫得出來，不丟錯', () => {
    const states = [
      st({ pause: 20, outcome: 'draw', snakes: [{ alive: false }, { alive: false }] }),
      st({ keyHolder: 1 }),
      st({ over: true, winner: 1, round: 3, snakes: [{ score: 1 }, { score: 3 }] }),
      st({ round: 2, roundTick: 400 }),
    ];
    for (const state of states) {
      expect(() => c9Render(asRenderingContext(createFakeContext()), state)).not.toThrow();
    }
  });
});
