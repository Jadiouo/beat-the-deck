import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { rngStateFor } from '../../core/rng';
import type { Buttons, Controller, Inputs } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { deepFreeze } from '../../../tests/contract/freeze';
import { COLOR } from '../../shell/palette';
import { CELLS, cell, cellX, cellY, DOWN, HEIGHT, LEFT, RIGHT, WIDTH } from '../_clubs/logic';
import {
  describeSharedSnakeAi,
  describeSharedSnakeRules,
} from '../_clubs/shared-rules.test-helpers';
import {
  BAIT_GROW,
  BAIT_POINTS,
  BAR_LEN,
  c5Game,
  createC5Game,
  crushDanger,
  landingTick,
  LANDING_TRIES,
  makeState,
  PAIR_OFFSET,
  PAIR_PERIOD,
  PREVIEW_TICKS,
  rotateCell,
} from './logic';
import type { C5State } from './logic';
import { avoider, playTracked, rusher, uniform } from './players.test-helpers';
import { c5Render } from './render';

/**
 * C-5 會動的牆的規則測試（小規格 `docs/cards/C-5.md`「實作時要先寫的測試」）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 預設局面：四面牆都還沒放（`bars` 是四個空陣列）、沒有預告、沒有誘餌；蛇與食物同 C-A。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_UP: Buttons = { ...NONE, up: true };
const PRESS_DOWN: Buttons = { ...NONE, down: true };
const IDLE: Inputs = [NONE, NONE];

function body(...points: [number, number][]): number[] {
  return points.map(([x, y]) => cell(x, y));
}

/** 橫的牆：從 (x, y) 往右 6 格。 */
function hBar(x: number, y: number): number[] {
  return Array.from({ length: BAR_LEN }, (_, i) => cell(x + i, y));
}

/** 直的牆：從 (x, y) 往下 6 格。 */
function vBar(x: number, y: number): number[] {
  return Array.from({ length: BAR_LEN }, (_, i) => cell(x, y + i));
}

/** 這一面牆的 180 度旋轉（由小到大）。 */
function rotated(bar: readonly number[]): number[] {
  return bar.map(rotateCell).sort((a, b) => a - b);
}

function run(state: C5State, count: number, inputs: Inputs = IDLE): C5State {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = c5Game.step(current, inputs);
  }
  return current;
}

function unionOf(bars: readonly (readonly number[])[]): Set<number> {
  return new Set(bars.flat());
}

/** 洪水填充：除了 `blocked` 以外的格子是不是四連通。 */
function connected(blocked: ReadonlySet<number>): boolean {
  let start = -1;
  let open = 0;
  for (let c = 0; c < CELLS; c += 1) {
    if (!blocked.has(c)) {
      open += 1;
      if (start < 0) {
        start = c;
      }
    }
  }
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.pop() as number;
    const x = cellX(current);
    const y = cellY(current);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) {
        continue;
      }
      const next = cell(nx, ny);
      if (!blocked.has(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.size === open;
}

// 共用的 C-A 規則（撞牆、撞身體、頭對頭、尾巴、計分……）在沒有牆、沒有預告的局面上全部成立。
const suite = { label: 'C-5 會動的牆', game: c5Game, makeState };
describeSharedSnakeRules(suite);
describeSharedSnakeAi(suite);

// 一組固定的牆：第 0 對（牆 0、牆 1）在最上方與它的旋轉，第 1 對在最左邊與它的旋轉。
const PAIR0_A = hBar(2, 1);
const PAIR1_A = vBar(1, 10);
const FIXED_BARS = [PAIR0_A, rotated(PAIR0_A), PAIR1_A, rotated(PAIR1_A)];

describe('C-5 會動的牆｜常數與時程', () => {
  it('常數是小規格的起始值', () => {
    expect(BAR_LEN).toBe(6);
    expect(PAIR_PERIOD).toBe(300);
    expect(PAIR_OFFSET).toBe(150);
    expect(PREVIEW_TICKS).toBe(60);
    expect(BAIT_POINTS).toBe(2);
    expect(BAIT_GROW).toBe(2);
    expect(LANDING_TRIES).toBe(50);
  });

  it('第 0 對在 300、600、900……落下；第 1 對在 450、750、1050……落下（每面牆每 5 秒一次，兩對錯開 2.5 秒）', () => {
    expect([1, 2, 3].map((n) => landingTick(0, n))).toEqual([300, 600, 900]);
    expect([1, 2, 3].map((n) => landingTick(1, n))).toEqual([450, 750, 1050]);
  });

  it('旋轉：(x, y) → (31−x, 23−y)，連續兩次回到原處', () => {
    expect(rotateCell(cell(0, 0))).toBe(cell(31, 23));
    expect(rotateCell(cell(5, 12))).toBe(cell(26, 11));
    for (const c of [0, 100, 383, 700]) {
      expect(rotateCell(rotateCell(c))).toBe(c);
    }
  });
});

describe('C-5 會動的牆｜初始', () => {
  it('開局：4 面牆各 6 格、沒有預告、沒有誘餌、沒人被壓過、一局 3600 tick', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const state = c5Game.init(seed, CONFIG);
      expect(state.bars).toHaveLength(4);
      for (const bar of state.bars) {
        expect(bar).toHaveLength(BAR_LEN);
        expect([...bar].sort((a, b) => a - b)).toEqual([...bar]);
      }
      expect(state.landing).toBeNull();
      expect(state.bait).toBeNull();
      expect(state.crushed).toEqual([0, 0]);
      expect(state.maxTicks).toBe(3600);
    }
  });

  it('7. 開局的牆：每面是一條 6 格的直線；成對的牆互為 180 度旋轉；4 面牆互不重疊；地圖四連通；不壓蛇、食物（種子 0 到 59）', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const state = c5Game.init(seed, CONFIG);
      for (const bar of state.bars) {
        const xs = new Set(bar.map(cellX));
        const ys = new Set(bar.map(cellY));
        expect(xs.size === 1 || ys.size === 1, `種子 ${seed}：不是直線`).toBe(true);
        const span = xs.size === 1 ? [...ys] : [...xs];
        expect(Math.max(...span) - Math.min(...span), `種子 ${seed}：不連續`).toBe(BAR_LEN - 1);
      }
      expect(state.bars[1], `種子 ${seed}`).toEqual(rotated(state.bars[0] as number[]));
      expect(state.bars[3], `種子 ${seed}`).toEqual(rotated(state.bars[2] as number[]));
      const all = state.bars.flat();
      expect(new Set(all).size, `種子 ${seed}：牆重疊`).toBe(4 * BAR_LEN);
      expect(connected(new Set(all)), `種子 ${seed}：地圖不連通`).toBe(true);
      const occupied = new Set([...state.snakes[0].body, ...state.snakes[1].body, ...state.foods]);
      for (const c of all) {
        expect(occupied.has(c), `種子 ${seed}：牆壓到蛇或食物`).toBe(false);
      }
    }
  });

  it('7. 開局牆的位置隨種子變：種子 0 到 9 不全相同', () => {
    const layouts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      layouts.add(c5Game.init(seed, CONFIG).bars.join('|'));
    }
    expect(layouts.size).toBeGreaterThanOrEqual(6);
  });

  it('同一個種子 init 兩次完全相同；maxTicks 小於 400 丟 RangeError', () => {
    expect(c5Game.init(3, CONFIG)).toEqual(c5Game.init(3, CONFIG));
    expect(() => c5Game.init(0, { maxTicks: 399, params: {} })).toThrow(RangeError);
    expect(() => c5Game.init(0, { maxTicks: 400, params: {} })).not.toThrow();
  });
});

describe('C-5 會動的牆｜牆是硬的', () => {
  it('蛇頭走進牆格就死（跟撞牆一樣），另一條贏，不看分數', () => {
    const state = makeState({
      tick: 5,
      bars: FIXED_BARS,
      snakes: [{ body: body([1, 9], [1, 8], [1, 7]), dir: DOWN, score: 0 }, { score: 5 }],
    });
    const next = c5Game.step(state, IDLE);
    expect(next.snakes[0].alive).toBe(false);
    expect(next.over).toBe(true);
    expect(next.winner).toBe(1);
    // 死掉的蛇停在原地，沒有走進牆裡。
    expect(next.snakes[0].body).toEqual(state.snakes[0].body);
  });

  it('食物不會生在牆上（種子 0 到 19，整局走完）', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      let state = c5Game.init(seed, CONFIG);
      for (let t = 0; t < 700 && !state.over; t += 1) {
        state = c5Game.step(state, IDLE);
        const walls = unionOf(state.bars);
        for (const food of state.foods) {
          expect(walls.has(food), `種子 ${seed} tick ${state.tick}`).toBe(false);
        }
      }
    }
  });
});

describe('C-5 會動的牆｜預告', () => {
  /** 兩條蛇都在中間偏左／右、各自往遠離落點的方向安全地走，60 個 tick 內不會撞到任何東西。 */
  function calm(overrides: Parameters<typeof makeState>[0] = {}): C5State {
    return makeState({
      tick: landingTick(0, 1) - PREVIEW_TICKS - 1,
      snakes: [
        { body: body([10, 12], [9, 12], [8, 12]), dir: RIGHT },
        { body: body([21, 11], [22, 11], [23, 11]), dir: LEFT },
      ],
      ...overrides,
    });
  }

  it('預告開始前一個 tick 沒有預告；開始的那個 tick（240）寫進 landing 與 bait', () => {
    const before = calm();
    expect(before.tick).toBe(239);
    expect(before.landing).toBeNull();
    const started = c5Game.step(before, IDLE);
    expect(started.tick).toBe(240);
    expect(started.landing).not.toBeNull();
    expect(started.landing?.pair).toBe(0);
    expect(started.landing?.at).toBe(300);
    expect(started.landing?.bars).toHaveLength(2);
    expect(started.bait).not.toBeNull();
    expect(started.bait?.until).toBe(300);
  });

  it('1. 落點在預告開始那個 tick 就決定，之後 60 個 tick 逐 tick 相等、誘餌的格子也不變', () => {
    for (const seed of [0, 1, 2, 3, 4]) {
      let state = c5Game.step(calm({ rng: rngStateFor(seed, 'preview') }), IDLE);
      const landing = state.landing;
      const bait = state.bait;
      expect(landing).not.toBeNull();
      for (let t = state.tick; t < 299; t += 1) {
        state = c5Game.step(state, IDLE);
        expect(state.landing, `種子 ${seed} tick ${state.tick}`).toEqual(landing);
        expect(state.bait, `種子 ${seed} tick ${state.tick}`).toEqual(bait);
        // 預告期間，牆還在舊位置（四個空陣列）。
        expect(state.bars).toEqual([[], [], [], []]);
      }
    }
  });

  it('2. 落點的合法條件：6 格直線、第二面是第一面的 180 度旋轉、不壓蛇、不和別的牆（含自己現在的位置）重疊、落下後地圖四連通（60 個亂數狀態）', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const state = c5Game.step(
        calm({
          rng: rngStateFor(seed, 'legal'),
          bars: FIXED_BARS,
          // 蛇身拉長一點，讓「落點不可以有蛇」真的有東西擋。
          snakes: [
            { body: body([10, 12], [9, 12], [8, 12], [7, 12], [6, 12], [5, 12]), dir: RIGHT },
            { body: body([21, 11], [22, 11], [23, 11], [24, 11], [25, 11], [26, 11]), dir: LEFT },
          ],
        }),
        IDLE,
      );
      const landing = state.landing;
      if (landing === null) {
        continue;
      }
      const [a, b] = landing.bars as [number[], number[]];
      expect(a).toHaveLength(BAR_LEN);
      expect(b).toEqual(rotated(a));
      const xs = new Set(a.map(cellX));
      const ys = new Set(a.map(cellY));
      expect(xs.size === 1 || ys.size === 1).toBe(true);
      const cells = new Set([...a, ...b]);
      expect(cells.size, `種子 ${seed}：兩面牆重疊`).toBe(2 * BAR_LEN);
      for (const snake of state.snakes) {
        for (const c of snake.body) {
          expect(cells.has(c), `種子 ${seed}：落點壓到蛇`).toBe(false);
        }
      }
      for (const c of FIXED_BARS.flat()) {
        expect(cells.has(c), `種子 ${seed}：落點和現有的牆重疊`).toBe(false);
      }
      // 落下之後：第 1 對的牆還在、第 0 對換成落點。
      const after = new Set([...PAIR1_A, ...rotated(PAIR1_A), ...cells]);
      expect(connected(after), `種子 ${seed}：落下之後不連通`).toBe(true);
    }
  });

  it('連續兩次落點不相同：同一對牆在 300 與 600 的落點（種子 0 到 19）', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const first = c5Game.step(calm({ rng: rngStateFor(seed, 'two') }), IDLE);
      expect(first.landing).not.toBeNull();
      // 直接把時間撥到 299 讓牆落下，再撥到第二次預告的前一個 tick。
      const landed = c5Game.step({ ...first, tick: 299 }, IDLE);
      expect(landed.bars[0]).toEqual(first.landing?.bars[0]);
      const second = c5Game.step(
        {
          ...landed,
          tick: 539,
          snakes: calm().snakes,
        },
        IDLE,
      );
      expect(second.landing, `種子 ${seed}`).not.toBeNull();
      expect(second.landing?.bars, `種子 ${seed}`).not.toEqual(first.landing?.bars);
    }
  });

  it('預告開始時沒有合法位置：這一對這一次不動（landing 與 bait 都是 null）', () => {
    // `LANDING_TRIES` 試完都不合法就不動；這裡用 tries = 0 直接走那條路。
    const game = createC5Game({ landingTries: 0 });
    const state = game.step(calm(), IDLE);
    expect(state.landing).toBeNull();
    expect(state.bait).toBeNull();
    expect(state.tick).toBe(240);
  });

  it('第 1 對的預告從 390 開始、450 落下；第 0 對的下一次預告從 540 開始、600 落下', () => {
    const one = c5Game.step(calm({ tick: 389 }), IDLE);
    expect(one.landing?.pair).toBe(1);
    expect(one.landing?.at).toBe(450);
    const two = c5Game.step(calm({ tick: 539 }), IDLE);
    expect(two.landing?.pair).toBe(0);
    expect(two.landing?.at).toBe(600);
  });

  it('8. 邊界：落下的 tick 剛好等於 maxTicks，或超過 maxTicks，就不開始預告', () => {
    // 600 落下、maxTicks 600：不預告（一場結束的那一刻才落的牆沒有意義）。
    expect(c5Game.step(calm({ tick: 539, maxTicks: 600 }), IDLE).landing).toBeNull();
    // maxTicks 601：預告。
    expect(c5Game.step(calm({ tick: 539, maxTicks: 601 }), IDLE).landing).not.toBeNull();
    // 開局的第一次預告：maxTicks 400 就有（落下在 300）。
    expect(c5Game.step(calm({ maxTicks: 400 }), IDLE).landing).not.toBeNull();
    expect(c5Game.step(calm({ maxTicks: 300 }), IDLE).landing).toBeNull();
  });

  it('預告開始時已經有預告在進行（不該發生）：不會再開第二個預告，原來的預告不被覆蓋', () => {
    const first = c5Game.step(calm(), IDLE);
    const forced = { ...first, tick: 389 };
    const next = c5Game.step(forced, IDLE);
    expect(next.landing).toEqual(first.landing);
  });
});

describe('C-5 會動的牆｜誘餌', () => {
  function started(seed = 0): C5State {
    return c5Game.step(
      makeState({
        tick: 239,
        rng: rngStateFor(seed, 'bait'),
        snakes: [
          { body: body([10, 12], [9, 12], [8, 12]), dir: RIGHT },
          { body: body([21, 11], [22, 11], [23, 11]), dir: LEFT },
        ],
      }),
      IDLE,
    );
  }

  it('4. 誘餌在落點格子裡，挑的是兩個蛇頭距離之差 |d0 − d1| 最小的格子（同值取格子編號小的）（種子 0 到 29）', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const state = started(seed);
      const landing = state.landing;
      const bait = state.bait;
      expect(landing).not.toBeNull();
      expect(bait).not.toBeNull();
      const cells = [...(landing?.bars.flat() ?? [])].sort((a, b) => a - b);
      expect(cells).toContain(bait?.cell);
      const h0 = state.snakes[0].body[0] as number;
      const h1 = state.snakes[1].body[0] as number;
      const dist = (a: number, b: number): number =>
        Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
      let best = cells[0] as number;
      for (const c of cells) {
        if (Math.abs(dist(c, h0) - dist(c, h1)) < Math.abs(dist(best, h0) - dist(best, h1))) {
          best = c;
        }
      }
      expect(bait?.cell, `種子 ${seed}`).toBe(best);
    }
  });

  it('誘餌是額外的第三顆食物：場上的普通食物還是 2 顆', () => {
    const state = started();
    expect(state.foods).toHaveLength(2);
    expect(state.foods).not.toContain(state.bait?.cell);
  });

  it('4. 吃到誘餌：分數 +2、身體長 2 格（走格的那一刻 +1，再多 1 格在下一步補上）、誘餌消失、不影響普通食物', () => {
    const state = makeState({
      tick: 53,
      snakes: [{ body: body([11, 5], [10, 5], [9, 5]), dir: RIGHT }, {}],
      foods: [cell(15, 3), cell(15, 20)],
      bars: FIXED_BARS,
      landing: { pair: 0, bars: [hBar(12, 5), rotated(hBar(12, 5))], at: 300 },
      bait: { cell: cell(12, 5), until: 300 },
    });
    const next = c5Game.step(state, IDLE);
    expect(next.tick).toBe(54);
    expect(next.snakes[0].score).toBe(BAIT_POINTS);
    expect(next.snakes[0].body[0]).toBe(cell(12, 5));
    expect(next.snakes[0].body).toHaveLength(3 + BAIT_GROW);
    expect(next.bait).toBeNull();
    expect(next.foods).toEqual(state.foods);
    // 再走兩格之後：身體不同的格子數是 5（長了 2 格）。
    const later = run(next, 12);
    expect(new Set(later.snakes[0].body).size).toBe(3 + BAIT_GROW);
  });

  it('4. 沒被吃到的誘餌在落下那個 tick 消失（不補）', () => {
    const state = makeState({
      tick: 299,
      bars: FIXED_BARS,
      landing: { pair: 0, bars: [hBar(12, 5), rotated(hBar(12, 5))], at: 300 },
      bait: { cell: cell(12, 5), until: 300 },
    });
    const next = c5Game.step(state, IDLE);
    expect(next.bait).toBeNull();
    expect(next.landing).toBeNull();
    expect(next.snakes[0].score).toBe(0);
    expect(next.snakes[1].score).toBe(0);
  });

  it('兩條蛇頭對頭搶同一顆誘餌：兩條都死（頭對頭），沒有人得到誘餌的分', () => {
    const state = makeState({
      tick: 53,
      snakes: [
        { body: body([11, 5], [10, 5], [9, 5]), dir: RIGHT, score: 1 },
        { body: body([13, 5], [14, 5], [15, 5]), dir: LEFT, score: 1 },
      ],
      landing: { pair: 0, bars: [hBar(12, 5), rotated(hBar(12, 5))], at: 300 },
      bait: { cell: cell(12, 5), until: 300 },
    });
    const next = c5Game.step(state, IDLE);
    expect(next.snakes[0].alive).toBe(false);
    expect(next.snakes[1].alive).toBe(false);
    expect(next.over).toBe(true);
    expect(next.winner).toBeNull();
  });
});

describe('C-5 會動的牆｜落下', () => {
  const ZONE_A = hBar(10, 5); // (10..15, 5)
  const ZONE_B = rotated(ZONE_A); // (16..21, 18)
  const OLD_A = hBar(2, 20);
  const OLD_B = rotated(OLD_A);
  const LANDING = { pair: 0 as const, bars: [ZONE_A, ZONE_B], at: 300 };
  const BARS = [OLD_A, OLD_B, PAIR1_A, rotated(PAIR1_A)];

  function atLanding(overrides: Parameters<typeof makeState>[0] = {}): C5State {
    return makeState({
      tick: 299,
      bars: BARS,
      landing: LANDING,
      bait: { cell: cell(12, 5), until: 300 },
      ...overrides,
    });
  }

  it('落下：這一對的牆從舊位置移到落點，舊位置變回空格，另一對不動，預告與誘餌清掉', () => {
    const next = c5Game.step(atLanding(), IDLE);
    expect(next.tick).toBe(300);
    expect(next.bars[0]).toEqual(ZONE_A);
    expect(next.bars[1]).toEqual(ZONE_B);
    expect(next.bars[2]).toEqual(BARS[2]);
    expect(next.bars[3]).toEqual(BARS[3]);
    const walls = unionOf(next.bars);
    for (const c of [...OLD_A, ...OLD_B]) {
      expect(walls.has(c)).toBe(false);
    }
    expect(next.landing).toBeNull();
    expect(next.bait).toBeNull();
  });

  it('3. 先走格、再落牆：落下那個 tick 剛好走進落點的蛇死（被壓扁），沒有被壓的蛇活著', () => {
    const next = c5Game.step(
      atLanding({
        snakes: [{ body: body([9, 5], [8, 5], [7, 5]), dir: RIGHT }, {}],
      }),
      IDLE,
    );
    expect(next.snakes[0].alive).toBe(false);
    expect(next.snakes[1].alive).toBe(true);
    expect(next.over).toBe(true);
    expect(next.winner).toBe(1);
    expect(next.crushed).toEqual([1, 0]);
  });

  it('3. 先走格、再落牆：落下那個 tick 尾巴剛好走出落點的蛇活下來', () => {
    const next = c5Game.step(
      atLanding({
        snakes: [{ body: body([17, 5], [16, 5], [15, 5]), dir: RIGHT }, {}],
      }),
      IDLE,
    );
    expect(next.snakes[0].alive).toBe(true);
    expect(next.snakes[0].body).toEqual(body([18, 5], [17, 5], [16, 5]));
    expect(next.over).toBe(false);
    expect(next.crushed).toEqual([0, 0]);
  });

  it('3. 只要有一格身體還在落點裡就死（不只蛇頭）', () => {
    const next = c5Game.step(
      atLanding({
        // 蛇頭已經在落點外面，身體的第二節還在落點裡。
        snakes: [{ body: body([16, 5], [15, 5], [14, 5]), dir: RIGHT }, {}],
      }),
      IDLE,
    );
    expect(next.snakes[0].alive).toBe(false);
    expect(next.winner).toBe(1);
  });

  it('3. 兩條都被壓到：兩條都死，分數高的贏、同分平手', () => {
    const base = {
      snakes: [
        { body: body([9, 5], [8, 5], [7, 5]), dir: RIGHT, score: 4 },
        { body: body([15, 18], [14, 18], [13, 18]), dir: RIGHT, score: 2 },
      ] as const,
    };
    const a = c5Game.step(atLanding({ snakes: base.snakes }), IDLE);
    expect(a.snakes[0].alive || a.snakes[1].alive).toBe(false);
    expect(a.over).toBe(true);
    expect(a.winner).toBe(0);
    expect(a.crushed).toEqual([1, 1]);
    const tie = c5Game.step(
      atLanding({
        snakes: [
          { body: body([9, 5], [8, 5], [7, 5]), dir: RIGHT, score: 3 },
          { body: body([15, 18], [14, 18], [13, 18]), dir: RIGHT, score: 3 },
        ],
      }),
      IDLE,
    );
    expect(tie.winner).toBeNull();
  });

  it('3. 蛇可以在牆落下之前走進落點、吃誘餌、走出來：牆落下時身體已經全在落點外面', () => {
    // 落點 (10..15, 5)，落下在 tick 90。蛇頭 (11,5) 往右，誘餌在 (12,5)：tick 54 吃到，之後一路往下走出落點。
    let state = makeState({
      tick: 53,
      bars: BARS,
      snakes: [{ body: body([11, 5], [10, 5], [9, 5]), dir: RIGHT }, {}],
      landing: { ...LANDING, at: 90 },
      bait: { cell: cell(12, 5), until: 90 },
    });
    state = c5Game.step(state, IDLE);
    expect(state.snakes[0].score).toBe(2);
    state = c5Game.step(state, [PRESS_DOWN, NONE]);
    while (state.tick < 89) {
      state = c5Game.step(state, IDLE);
    }
    expect(state.snakes[0].alive).toBe(true);
    expect(state.over).toBe(false);
    const after = c5Game.step(state, IDLE);
    expect(after.tick).toBe(90);
    expect(after.snakes[0].alive).toBe(true);
    expect(after.over).toBe(false);
    expect(after.crushed).toEqual([0, 0]);
    expect(after.bars[0]).toEqual(ZONE_A);
  });

  it('落點上的普通食物被壓掉，之後補到 2 個，補的位置不在牆上也不在蛇身上', () => {
    const next = c5Game.step(
      atLanding({ foods: [cell(12, 5), cell(15, 20)], rng: rngStateFor(1, 'refill') }),
      IDLE,
    );
    expect(next.foods).toHaveLength(2);
    expect(next.foods).not.toContain(cell(12, 5));
    const walls = unionOf(next.bars);
    const bodies = new Set([...next.snakes[0].body, ...next.snakes[1].body]);
    for (const food of next.foods) {
      expect(walls.has(food)).toBe(false);
      expect(bodies.has(food)).toBe(false);
    }
  });

  it('同一個 tick 有人撞牆死、另一條被壓死：兩條都死，比分數', () => {
    const next = c5Game.step(
      atLanding({
        snakes: [
          { body: body([1, 9], [1, 8], [1, 7]), dir: DOWN, score: 2 },
          { body: body([15, 18], [14, 18], [13, 18]), dir: RIGHT, score: 1 },
        ],
      }),
      IDLE,
    );
    expect(next.snakes[0].alive).toBe(false);
    expect(next.snakes[1].alive).toBe(false);
    expect(next.winner).toBe(0);
  });

  it('關掉壓死（消融用）：牆照樣落下，蛇不死', () => {
    const game = createC5Game({ crush: false });
    const next = game.step(
      atLanding({ snakes: [{ body: body([9, 5], [8, 5], [7, 5]), dir: RIGHT }, {}] }),
      IDLE,
    );
    expect(next.snakes[0].alive).toBe(true);
    expect(next.bars[0]).toEqual(ZONE_A);
  });

  it('關掉誘餌（消融用）：預告照樣有，但沒有誘餌', () => {
    const game = createC5Game({ bait: false });
    const state = game.step(
      makeState({
        tick: 239,
        snakes: [
          { body: body([10, 12], [9, 12], [8, 12]), dir: RIGHT },
          { body: body([21, 11], [22, 11], [23, 11]), dir: LEFT },
        ],
      }),
      IDLE,
    );
    expect(state.landing).not.toBeNull();
    expect(state.bait).toBeNull();
  });
});

describe('C-5 會動的牆｜danger 的時間算術', () => {
  it('5. margin 為 3、0、−1：danger 分別是 0、1、1；中間線性', () => {
    // clearSteps = exitSteps + inZone − 1（蛇頭在落點裡）；margin = stepsLeft − clearSteps。
    // exitSteps 2、inZone 3 → clearSteps 4。
    expect(crushDanger(7, 2, 3, true)).toBe(0); // margin 3
    expect(crushDanger(4, 2, 3, true)).toBe(1); // margin 0
    expect(crushDanger(3, 2, 3, true)).toBe(1); // margin −1
    expect(crushDanger(0, 2, 3, true)).toBe(1);
    expect(crushDanger(5, 2, 3, true)).toBeCloseTo(1 - 1 / 3, 10); // margin 1
    expect(crushDanger(6, 2, 3, true)).toBeCloseTo(1 - 2 / 3, 10); // margin 2
    expect(crushDanger(100, 2, 3, true)).toBe(0);
  });

  it('5. 沒有任何一格在落點裡：danger 是 0（不管還剩幾步）', () => {
    expect(crushDanger(0, 12, 0, false)).toBe(0);
    expect(crushDanger(5, 0, 0, true)).toBe(0);
  });

  it('5. 蛇頭已經在落點外面、只剩尾巴在裡面：要等 inZone 格都出去（比蛇頭在裡面多 1 步）', () => {
    // 蛇頭在外面：exitSteps 0、inZone 2 → clearSteps 2；蛇頭在裡面：exitSteps 0、inZone 2 → clearSteps 1。
    expect(crushDanger(2, 0, 2, false)).toBe(1); // margin 0
    expect(crushDanger(2, 0, 2, true)).toBeCloseTo(1 - 1 / 3, 10); // margin 1
  });

  /** 預告進行中：落點在 (12..17, 6) 與旋轉，蛇頭在 (11, 6) 往右一格就進落點，旁邊一格 (11, 5) 就是出口。 */
  function nearZone(tick: number): C5State {
    const zone = hBar(12, 6);
    return makeState({
      tick,
      landing: { pair: 0, bars: [zone, rotated(zone)], at: 300 },
      bait: { cell: cell(14, 6), until: 300 },
      snakes: [{ body: body([11, 6], [10, 6], [9, 6]), dir: RIGHT }, {}],
      foods: [cell(14, 6 - 5), cell(25, 20)],
    });
  }

  it('5. 整合：離落下還有很多步 danger 是 0；剩 1 到 2 步時變成 1（下一步進落點，來不及出來）', () => {
    const early = c5Game.evaluate(nearZone(250), 0);
    const late = c5Game.evaluate(nearZone(293), 0);
    expect(early.danger).toBe(0);
    expect(late.danger).toBe(1);
    // 同一個局面，下一步不進落點（鎖定往上轉）：沒有任何一格在落點裡 → 沒有壓死的 danger。
    const turned = c5Game.step(nearZone(292), [PRESS_UP, NONE]);
    expect(c5Game.evaluate(turned, 0).danger).toBeLessThan(1);
  });

  it('5. danger 隨離落下的時間單調不降（同一個局面，tick 越晚越危險）', () => {
    let last = -1;
    for (const tick of [200, 240, 270, 280, 288, 294, 297]) {
      const { danger } = c5Game.evaluate(nearZone(tick), 0);
      expect(danger, `tick ${tick}`).toBeGreaterThanOrEqual(last);
      last = danger;
    }
    expect(last).toBe(1);
  });

  it('關掉壓死（消融用）：evaluate 不再算壓死的 danger', () => {
    const game = createC5Game({ crush: false });
    expect(game.evaluate(nearZone(293), 0).danger).toBeLessThan(1);
  });

  it('牆格算障礙：前方一格就是牆，danger 是 1', () => {
    const state = makeState({
      bars: [hBar(12, 6), rotated(hBar(12, 6)), [], []],
      snakes: [{ body: body([11, 6], [10, 6], [9, 6]), dir: RIGHT }, {}],
    });
    expect(c5Game.evaluate(state, 0).danger).toBe(1);
  });
});

describe('C-5 會動的牆｜evaluate 與 actions', () => {
  function sampleStates(): C5State[] {
    const out: C5State[] = [];
    for (let seed = 0; seed < 6; seed += 1) {
      const a = levelController(c5Game, pathfinder, 5, seed);
      const b = levelController(c5Game, pathfinder, 5, seed + 1_000_003);
      let state = c5Game.init(seed, CONFIG);
      for (let t = 0; t < 900 && !state.over; t += 1) {
        if (state.landing !== null && t % 13 === 0) {
          out.push(state);
        }
        state = c5Game.step(state, [a.decide(state, 0, t), b.decide(state, 1, t)]);
      }
    }
    return out;
  }

  it('6. 分數對調（兩邊各加同一個常數）不改變任何動作之間的相對 gain：沒有橡皮筋', () => {
    const states = sampleStates();
    expect(states.length).toBeGreaterThan(5);
    for (const state of states) {
      for (const side of [0, 1] as const) {
        const shifted: C5State = {
          ...state,
          snakes: [
            { ...state.snakes[0], score: state.snakes[0].score + 7 },
            { ...state.snakes[1], score: state.snakes[1].score + 7 },
          ],
        };
        const a = c5Game
          .actions(state, side)
          .map((m) => c5Game.step(state, side === 0 ? [m, NONE] : [NONE, m]));
        const b = c5Game
          .actions(shifted, side)
          .map((m) => c5Game.step(shifted, side === 0 ? [m, NONE] : [NONE, m]));
        const gainsA = a.map((s) => c5Game.evaluate(s, side).gain);
        const gainsB = b.map((s) => c5Game.evaluate(s, side).gain);
        expect(gainsB).toEqual(gainsA);
        expect(c5Game.actions(shifted, side)).toEqual(c5Game.actions(state, side));
      }
    }
  });

  it('actions 不看牆的落點：落點換位置，排序不變', () => {
    const base = makeState({
      snakes: [{ body: body([15, 12], [14, 12], [13, 12]), dir: RIGHT }, {}],
      foods: [cell(15, 3), cell(30, 20)],
    });
    const withLanding = makeState({
      snakes: [{ body: body([15, 12], [14, 12], [13, 12]), dir: RIGHT }, {}],
      foods: [cell(15, 3), cell(30, 20)],
      landing: { pair: 0, bars: [hBar(15, 8), rotated(hBar(15, 8))], at: 300 },
    });
    expect(c5Game.actions(withLanding, 0)).toEqual(c5Game.actions(base, 0));
  });

  it('誘餌算食物：誘餌比普通食物近時，actions 排最前面的轉向往誘餌的方向', () => {
    const state = makeState({
      snakes: [{ body: body([15, 12], [14, 12], [13, 12]), dir: RIGHT }, {}],
      foods: [cell(15, 3), cell(30, 20)],
      landing: { pair: 0, bars: [hBar(15, 15), rotated(hBar(15, 15))], at: 300 },
      bait: { cell: cell(16, 15), until: 300 },
    });
    expect(c5Game.actions(state, 0)[0]).toEqual(PRESS_DOWN);
  });

  it('吃到誘餌的 gain 是 200 分差（普通食物是 100）', () => {
    const bait = makeState({
      tick: 53,
      snakes: [{ body: body([11, 5], [10, 5], [9, 5]), dir: RIGHT }, {}],
      landing: { pair: 0, bars: [hBar(12, 5), rotated(hBar(12, 5))], at: 300 },
      bait: { cell: cell(12, 5), until: 300 },
    });
    const plain = makeState({
      tick: 53,
      snakes: [{ body: body([11, 5], [10, 5], [9, 5]), dir: RIGHT }, {}],
      foods: [cell(12, 5), cell(15, 20)],
    });
    const gainOf = (state: C5State): number => c5Game.evaluate(c5Game.step(state, IDLE), 0).gain;
    expect(gainOf(bait) - gainOf(plain)).toBeGreaterThan(80);
    expect(gainOf(bait)).toBeGreaterThan(150);
  });

  it('已結束的局：贏的 gain 很大、輸的很小；自己死了 danger 是 1', () => {
    const won = c5Game.step(
      makeState({
        tick: 5,
        bars: FIXED_BARS,
        snakes: [{ body: body([1, 9], [1, 8], [1, 7]), dir: DOWN }, {}],
      }),
      IDLE,
    );
    expect(c5Game.evaluate(won, 0).danger).toBe(1);
    expect(c5Game.evaluate(won, 1).gain).toBeGreaterThan(c5Game.evaluate(won, 0).gain);
  });
});

describe('C-5 會動的牆｜純度與契約', () => {
  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯；含預告開始、走格、落下、壓死那幾個 tick）', () => {
    let state = deepFreeze(c5Game.init(2, CONFIG));
    for (let t = 0; t < 320; t += 1) {
      state = deepFreeze(
        c5Game.step(state, t % 40 < 20 ? [PRESS_UP, PRESS_DOWN] : [PRESS_DOWN, PRESS_UP]),
      );
      if (state.over) {
        break;
      }
    }
    expect(state.tick).toBeGreaterThan(0);
    const landing = deepFreeze(
      makeState({
        tick: 299,
        bars: FIXED_BARS,
        landing: { pair: 0, bars: [hBar(10, 5), rotated(hBar(10, 5))], at: 300 },
        bait: { cell: cell(12, 5), until: 300 },
        snakes: [{ body: body([9, 5], [8, 5], [7, 5]), dir: RIGHT }, {}],
      }),
    );
    expect(() => c5Game.step(landing, IDLE)).not.toThrow();
  });

  it('state 可序列化：JSON 來回之後一樣，大小不隨 tick 成長', () => {
    let state = c5Game.init(1, CONFIG);
    const sizes: number[] = [];
    for (let t = 0; t < 400 && !state.over; t += 1) {
      state = c5Game.step(state, IDLE);
      if (t % 100 === 0) {
        sizes.push(JSON.stringify(state).length);
      }
    }
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(Math.max(...sizes)).toBeLessThan(Math.min(...sizes) * 1.5 + 200);
  });

  it('時間到：沒有人死，分數高的贏；maxTicks 400 的一局在 400 結束', () => {
    let state = makeState({
      tick: 399,
      maxTicks: 400,
      snakes: [{ score: 3 }, { score: 1 }],
    });
    state = c5Game.step(state, IDLE);
    expect(state.over).toBe(true);
    expect(state.winner).toBe(0);
  });
});

describe('C-5 會動的牆｜畫面', () => {
  it('只用色盤顏色、全部在 320×240 之內、不改 state；牆、預告的方框、誘餌都畫得出來', () => {
    const zone = hBar(12, 6);
    const state = deepFreeze(
      makeState({
        tick: 280,
        bars: FIXED_BARS,
        landing: { pair: 0, bars: [zone, rotated(zone)], at: 300 },
        bait: { cell: cell(14, 6), until: 300 },
      }),
    );
    const before = JSON.stringify(state);
    const fake = createFakeContext();
    c5Render(asRenderingContext(fake), state);
    expect(JSON.stringify(state)).toBe(before);
    const used = fake.colors.filter((c) => c.via === 'set').map((c) => String(c.value));
    expect(used).toContain(COLOR.clubs);
    expect(used).toContain(COLOR.accent);
    expect(used).toContain(COLOR.diamonds);
    // 牆（深灰實心）：第 0 對在 (2..7, 1)。
    for (let x = 2; x <= 7; x += 1) {
      const near = fake.points.filter(
        (p) => p.x >= x * 10 - 1 && p.x <= x * 10 + 11 && p.y >= 9 && p.y <= 21,
      );
      expect(near.length, `牆 x=${x}`).toBeGreaterThan(0);
    }
    // 落點 (12..17, 6) 附近有繪圖。
    expect(
      fake.points.filter((p) => p.x >= 119 && p.x <= 181 && p.y >= 59 && p.y <= 71).length,
    ).toBeGreaterThan(0);
    for (const p of fake.points) {
      expect(p.x).toBeGreaterThanOrEqual(-8);
      expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
      expect(p.y).toBeGreaterThanOrEqual(-8);
      expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
    }
  });
});

// ---------------------------------------------------------------------------
// danger：身體全長（接手時發現的缺口）
// ---------------------------------------------------------------------------

describe('C-5 會動的牆｜danger 要把整條身體算進去', () => {
  /** 蛇頭在 (11, 6) 往右，下一步進落點 (12..17, 6)；身體往左排成一條 `length` 格的直線。 */
  function entering(length: number, tick: number): C5State {
    const zone = hBar(12, 6);
    return makeState({
      tick,
      landing: { pair: 0, bars: [zone, rotated(zone)], at: 300 },
      bait: { cell: cell(14, 6), until: 300 },
      snakes: [
        {
          body: Array.from({ length }, (_, i) => cell(11 - i, 6)),
          dir: RIGHT,
        },
        {},
      ],
      foods: [cell(14, 1), cell(25, 20)],
    });
  }

  it('蛇頭剛進落點時身體還全在外面，但整條身體都還要走過這一段：長的蛇來不及、短的蛇來得及（同一個 tick）', () => {
    // tick 258：離落下還有 6 次走格。出口 1 步；清空要 1 + 長度 − 1 步。
    expect(c5Game.evaluate(entering(3, 258), 0).danger).toBe(0); // 清空 3 步，餘裕 3
    expect(c5Game.evaluate(entering(6, 258), 0).danger).toBe(1); // 清空 6 步，餘裕 0
  });

  it('長度越長，同一個局面的 danger 不會下降', () => {
    let last = -1;
    for (const length of [3, 4, 5, 6, 7, 8]) {
      const { danger } = c5Game.evaluate(entering(length, 258), 0);
      expect(danger, `長度 ${length}`).toBeGreaterThanOrEqual(last);
      last = danger;
    }
  });
});

// ---------------------------------------------------------------------------
// 四列證據與消融（DESIGN-AI-FUN 10.4）
// ---------------------------------------------------------------------------

describe('C-5 會動的牆｜劇本玩家與消融（對搜尋型等級 10，種子 0 到 9，玩家在 0 號邊）', () => {
  const SEEDS = Array.from({ length: 10 }, (_, i) => i);

  /** 劇本玩家對搜尋型等級 10 的勝率（平手算一半）、每場進預告區與被壓死的平均次數。 */
  function rate(
    options: Parameters<typeof createC5Game>[0],
    make: (seed: number) => Controller<C5State>,
  ): { win: number; entries: number; crushed: number; baits: number } {
    const game = createC5Game(options);
    let points = 0;
    let entries = 0;
    let crushed = 0;
    let baits = 0;
    for (const seed of SEEDS) {
      const t = playTracked(
        game,
        seed,
        3600,
        make(seed),
        levelController(game, pathfinder, 10, seed + 1_000_003),
      );
      points += t.winner === 0 ? 1 : t.winner === null ? 0.5 : 0;
      entries += t.entries[0];
      crushed += t.crushed[0];
      baits += t.baits[0];
    }
    const n = SEEDS.length;
    return { win: points / n, entries: entries / n, crushed: crushed / n, baits: baits / n };
  }

  const full = {
    avoider: rate({}, () => avoider()),
    rusher: rate({}, () => rusher()),
    uniform: rate({}, (seed) => uniform(seed, 0)),
  };
  const noCrush = {
    avoider: rate({ crush: false }, () => avoider()),
    rusher: rate({ crush: false }, () => rusher()),
  };
  const noBait = { rusher: rate({ bait: false }, () => rusher()) };

  it('照習慣打（只吃普通食物、不碰落點）：基準線，贏過搜尋型等級 10', () => {
    expect(full.avoider.win).toBeGreaterThanOrEqual(0.7);
    expect(full.avoider.entries).toBe(0);
  }, 180_000);

  it('每個誘餌都衝：明顯輸給「不碰誘餌」，而且大多是被壓死的（技術有報酬）', () => {
    expect(full.rusher.entries).toBeGreaterThan(0.5);
    expect(full.rusher.crushed).toBeGreaterThanOrEqual(0.6);
    expect(full.avoider.win - full.rusher.win).toBeGreaterThanOrEqual(0.5);
  }, 180_000);

  it('均勻亂決定：明顯輸（證明技術有報酬）', () => {
    expect(full.uniform.win).toBeLessThanOrEqual(0.15);
  }, 180_000);

  it('消融一：關掉壓死，「衝」與「不衝」的差距消失（壓死是這張牌互動強度的來源）', () => {
    const spreadFull = full.avoider.win - full.rusher.win;
    const spreadOff = noCrush.avoider.win - noCrush.rusher.win;
    expect(noCrush.rusher.crushed).toBe(0);
    expect(spreadOff).toBeLessThanOrEqual(0.2);
    expect(spreadFull - spreadOff).toBeGreaterThanOrEqual(0.4);
  }, 180_000);

  it('消融二：關掉誘餌，衝誘餌的玩家沒東西可衝，被壓死的次數掉下來（誘餌是把人騙進落點的餌）', () => {
    expect(noBait.rusher.baits).toBe(0);
    expect(noBait.rusher.crushed).toBeLessThan(full.rusher.crushed);
  }, 180_000);
});
