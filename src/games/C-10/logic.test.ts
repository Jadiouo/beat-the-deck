import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import type { Buttons, Controller, Inputs } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { COLOR } from '../../shell/palette';
import { cell, cellX, cellY, DOWN, LEFT, MOVE_EVERY, RIGHT, UP } from '../_clubs/logic';
import type { Dir } from '../_clubs/logic';
import {
  AIM_EVERY,
  AIM_LEAD,
  AIM_MARGIN,
  c10Game,
  CHASER_LENGTH,
  createC10Game,
  edgeDistance,
  GRACE_TICKS,
  MIN_START_GAP,
  PAUSE_TICKS,
  RUNNER_LENGTH,
  START_MARGIN,
  straightModel,
  makeState,
} from './logic';
import type { C10State, RunnerModel } from './logic';
import { c10Render } from './render';

/**
 * C-10 追與逃的規則測試（小規格 `docs/cards/C-10.md`）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 預設局面：第一局、0 號邊（人）逃、`roundTick` 0（開局的不動時間已過）；
 * 逃的蛇頭在 (6,12) 往右、長度 4，追的蛇頭在 (25,12) 往左、長度 1。
 */

const CONFIG = { maxTicks: 3600, params: {} };
/** 每一局最多幾個 tick：(3600 − 60 − 2 × 30) / 2。 */
const ROUND_TICKS = 1740;

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_UP: Buttons = { ...NONE, up: true };
const PRESS_DOWN: Buttons = { ...NONE, down: true };
const PRESS_LEFT: Buttons = { ...NONE, left: true };
const IDLE: Inputs = [NONE, NONE];

/** 讓「下一次 step」剛好是走格的那一次（`roundTick` 加 1 之後是 6 的倍數）。 */
const BEFORE_MOVE = MOVE_EVERY - 1;

function body(...points: [number, number][]): number[] {
  return points.map(([x, y]) => cell(x, y));
}

function head(state: C10State, side: 0 | 1): [number, number] {
  const at = state.snakes[side].body[0] as number;
  return [cellX(at), cellY(at)];
}

function run(state: C10State, count: number, inputs: Inputs = IDLE): C10State {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = c10Game.step(current, inputs);
  }
  return current;
}

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

/** 逃的蛇在 (10,12) 往右、身體 (9,12)(8,12)(7,12)；追的蛇在 (9,11) 往下，下一步走進逃的蛇的身體。 */
function catchSetup(overrides: Parameters<typeof makeState>[0] = {}): C10State {
  return makeState({
    roundTick: BEFORE_MOVE,
    snakes: [
      { body: body([10, 12], [9, 12], [8, 12], [7, 12]), dir: RIGHT },
      { body: body([9, 11]), dir: DOWN },
    ],
    ...overrides,
  });
}

describe('C-10 追與逃｜初始與時間', () => {
  it('1. 初始：第一局、0 號邊逃；逃的蛇長 4、追的蛇長 1；兩邊分數 0；沒有食物', () => {
    const state = c10Game.init(0, CONFIG);
    expect(state.round).toBe(0);
    expect(state.runner).toBe(0);
    expect(state.snakes[0].body).toHaveLength(RUNNER_LENGTH);
    expect(state.snakes[1].body).toHaveLength(CHASER_LENGTH);
    expect(RUNNER_LENGTH).toBe(4);
    expect(CHASER_LENGTH).toBe(1);
    expect(c10Game.score(state)).toEqual([0, 0]);
    expect(state.runnerTicks).toEqual([-1, -1]);
    expect(state.foods).toEqual([]);
    expect(state.snakes[0].alive && state.snakes[1].alive).toBe(true);
    expect(c10Game.isOver(state)).toBe(false);
    expect(c10Game.winner(state)).toBeNull();
    expect(state.outcome).toBeNull();
  });

  it('2. 起始位置：兩條蛇都離牆至少 6 格、蛇頭相距至少 14 格，30 個種子都成立', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const state = c10Game.init(seed, CONFIG);
      const runner = state.snakes[0].body[0] as number;
      const chaser = state.snakes[1].body[0] as number;
      expect(edgeDistance(runner)).toBeGreaterThanOrEqual(START_MARGIN);
      expect(edgeDistance(chaser)).toBeGreaterThanOrEqual(START_MARGIN);
      expect(manhattan(runner, chaser)).toBeGreaterThanOrEqual(MIN_START_GAP);
      // 逃的蛇的身體都在地圖裡（沒有被 -1 之類的值污染）
      for (const part of state.snakes[0].body) {
        expect(part).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('3. 開局先不動 30 個 tick（可以先轉向），之後兩條蛇一樣快：每 6 個 tick 同時走一格', () => {
    let state = c10Game.init(3, CONFIG);
    expect(state.roundTick).toBe(-GRACE_TICKS);
    const start = [state.snakes[0].body, state.snakes[1].body];
    // 不動時間內按方向鍵：蛇不動，但轉向被鎖定
    state = run(state, GRACE_TICKS, [PRESS_UP, PRESS_UP]);
    expect(state.roundTick).toBe(0);
    expect(state.snakes[0].body).toEqual(start[0]);
    expect(state.snakes[1].body).toEqual(start[1]);
    // 之後第 1 到 5 個 tick 不動，第 6 個 tick 兩條都走一格
    state = run(state, MOVE_EVERY - 1);
    expect(state.snakes[0].body).toEqual(start[0]);
    expect(state.snakes[1].body).toEqual(start[1]);
    state = c10Game.step(state, IDLE);
    expect(state.snakes[0].body[0]).not.toBe(start[0]?.[0]);
    expect(state.snakes[1].body[0]).not.toBe(start[1]?.[0]);
    expect(manhattan(state.snakes[0].body[0] as number, start[0]?.[0] as number)).toBe(1);
    expect(manhattan(state.snakes[1].body[0] as number, start[1]?.[0] as number)).toBe(1);
  });

  it('4. 一局最多 1740 個 tick，兩局加上開局不動與停頓剛好在 3600 之內', () => {
    const state = c10Game.init(0, CONFIG);
    expect(state.roundTicks).toBe(ROUND_TICKS);
    expect(2 * (state.roundTicks + GRACE_TICKS) + PAUSE_TICKS).toBeLessThanOrEqual(3600);
  });
});

describe('C-10 追與逃｜怎麼抓到、怎麼出局', () => {
  it('5. 追的蛇走進逃的蛇的身體：抓到。逃的人得 roundTick、追的人得一局剩下的；追的蛇沒死，停在那一格', () => {
    const state = c10Game.step(catchSetup(), IDLE);
    expect(state.outcome).toBe('runnerOut');
    expect(state.runnerTicks[0]).toBe(MOVE_EVERY);
    expect(c10Game.score(state)).toEqual([MOVE_EVERY, ROUND_TICKS - MOVE_EVERY]);
    expect(state.snakes[0].alive).toBe(false);
    expect(state.snakes[1].alive).toBe(true);
    expect(head(state, 1)).toEqual([9, 12]);
    expect(state.pause).toBe(PAUSE_TICKS);
    expect(c10Game.isOver(state)).toBe(false);
  });

  it('6. 逃的蛇自己撞牆：也算被抓（分數算法相同）', () => {
    const state = c10Game.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snakes: [{ body: body([31, 12], [30, 12], [29, 12], [28, 12]), dir: RIGHT }],
      }),
      IDLE,
    );
    expect(state.outcome).toBe('runnerOut');
    expect(state.snakes[0].alive).toBe(false);
    expect(state.snakes[1].alive).toBe(true);
    expect(c10Game.score(state)).toEqual([MOVE_EVERY, ROUND_TICKS - MOVE_EVERY]);
  });

  it('7. 逃的蛇撞到追的蛇的身體或蛇頭：被抓（逃的蛇是撞上去的那個）', () => {
    // 追的蛇停在 (11,12)（這一格它不走：它在 (12,12) 往左走，會與逃的蛇同時走到 (11,12)）
    const state = c10Game.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snakes: [
          { body: body([10, 12], [9, 12], [8, 12], [7, 12]), dir: RIGHT },
          { body: body([12, 12]), dir: LEFT },
        ],
      }),
      IDLE,
    );
    expect(state.outcome).toBe('runnerOut');
    expect(state.snakes[0].alive).toBe(false);
    expect(state.runnerTicks[0]).toBe(MOVE_EVERY);
  });

  it('8. 追的蛇自己撞牆：它出局，逃的人視為撐滿一局（得 1740），追的人 0 分', () => {
    const state = c10Game.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snakes: [{}, { body: body([0, 5]), dir: LEFT }],
      }),
      IDLE,
    );
    expect(state.outcome).toBe('chaserOut');
    expect(state.snakes[1].alive).toBe(false);
    expect(state.runnerTicks[0]).toBe(ROUND_TICKS);
    expect(c10Game.score(state)).toEqual([ROUND_TICKS, 0]);
  });

  it('9. 沒人出局、時間到：逃的人撐滿（得 1740），追的人 0 分', () => {
    const state = c10Game.step(makeState({ roundTick: ROUND_TICKS - 1 }), IDLE);
    expect(state.outcome).toBe('timeout');
    expect(state.runnerTicks[0]).toBe(ROUND_TICKS);
    expect(c10Game.score(state)).toEqual([ROUND_TICKS, 0]);
    expect(state.snakes[0].alive && state.snakes[1].alive).toBe(true);
  });

  it('10. 邊界：同一個 tick 逃的蛇與追的蛇都撞牆：逃的蛇先算（被抓），不是追的蛇出局', () => {
    const state = c10Game.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snakes: [
          { body: body([31, 12], [30, 12], [29, 12], [28, 12]), dir: RIGHT },
          { body: body([0, 5]), dir: LEFT },
        ],
      }),
      IDLE,
    );
    expect(state.outcome).toBe('runnerOut');
    expect(state.runnerTicks[0]).toBe(MOVE_EVERY);
    expect(state.snakes[0].alive).toBe(false);
    expect(state.snakes[1].alive).toBe(true);
  });

  it('11. 邊界：最後一個 tick（roundTick 剛好等於一局的上限）被抓：算被抓，不算時間到', () => {
    // roundTick 1739 → 1740，1740 是 6 的倍數，這一個 tick 兩條蛇都走格。
    const state = c10Game.step(catchSetup({ roundTick: ROUND_TICKS - 1 }), IDLE);
    expect(state.outcome).toBe('runnerOut');
    expect(state.runnerTicks[0]).toBe(ROUND_TICKS);
    expect(state.snakes[0].alive).toBe(false);
  });

  it('12. 邊界：還沒走格的 tick 不會抓到人；開局不動時間內即使貼在一起也不會出局', () => {
    const touching = makeState({
      roundTick: -GRACE_TICKS,
      snakes: [
        { body: body([10, 12], [9, 12], [8, 12], [7, 12]), dir: RIGHT },
        { body: body([9, 11]), dir: DOWN },
      ],
    });
    const state = run(touching, GRACE_TICKS + BEFORE_MOVE);
    expect(state.outcome).toBeNull();
    expect(state.snakes[0].alive && state.snakes[1].alive).toBe(true);
  });
});

describe('C-10 追與逃｜兩局與計分', () => {
  it('13. 兩局之間整個畫面停住 60 個 tick，然後第二局開始：換成 1 號邊逃，開局不動時間重新算，分數留著', () => {
    let state = c10Game.step(catchSetup(), IDLE);
    const frozen = state.snakes;
    for (let i = 0; i < PAUSE_TICKS - 1; i += 1) {
      state = c10Game.step(state, [PRESS_UP, PRESS_DOWN]);
      expect(state.snakes).toEqual(frozen);
      expect(state.round).toBe(0);
    }
    state = c10Game.step(state, IDLE);
    expect(state.round).toBe(1);
    expect(state.runner).toBe(1);
    expect(state.pause).toBe(0);
    expect(state.outcome).toBeNull();
    expect(state.roundTick).toBe(-GRACE_TICKS);
    expect(state.snakes[0].alive && state.snakes[1].alive).toBe(true);
    expect(state.snakes[1].body).toHaveLength(RUNNER_LENGTH);
    expect(state.snakes[0].body).toHaveLength(CHASER_LENGTH);
    expect(c10Game.score(state)).toEqual([MOVE_EVERY, ROUND_TICKS - MOVE_EVERY]);
    expect(state.runnerTicks).toEqual([MOVE_EVERY, -1]);
  });

  it('14. 第二局的起始位置是第一局轉 180 度：兩邊遇到的局面完全等價', () => {
    let state = c10Game.init(5, CONFIG);
    const first = { runner: state.snakes[0], chaser: state.snakes[1] };
    state = { ...state, pause: 1, outcome: 'runnerOut', runnerTicks: [100, -1] };
    state = c10Game.step(state, IDLE);
    expect(state.round).toBe(1);
    const second = { runner: state.snakes[1], chaser: state.snakes[0] };
    const rotate = (index: number): number => cell(31 - cellX(index), 23 - cellY(index));
    expect(second.runner.body).toEqual(first.runner.body.map(rotate));
    expect(second.chaser.body).toEqual(first.chaser.body.map(rotate));
    expect(second.runner.dir).toBe(((first.runner.dir + 2) % 4) as Dir);
    expect(second.chaser.dir).toBe(((first.chaser.dir + 2) % 4) as Dir);
    expect(manhattan(second.runner.body[0] as number, second.chaser.body[0] as number)).toBe(
      manhattan(first.runner.body[0] as number, first.chaser.body[0] as number),
    );
  });

  it('15. 兩局總分：每一邊 = 自己當逃的人撐的 + (一局 − 對方當逃的人撐的)；高的贏', () => {
    // 第一局 0 號邊逃了 300；第二局 1 號邊逃了 504 就被抓（503 → 504，504 是 6 的倍數，這個 tick 走格）。
    const caught = c10Game.step(
      catchSetup({
        round: 1,
        roundTick: 503,
        runnerTicks: [300, -1],
        snakes: [
          { body: body([9, 11]), dir: DOWN, score: 300 },
          { body: body([10, 12], [9, 12], [8, 12], [7, 12]), dir: RIGHT, score: ROUND_TICKS - 300 },
        ],
      }),
      IDLE,
    );
    expect(caught.outcome).toBe('runnerOut');
    expect(c10Game.isOver(caught)).toBe(true);
    expect(caught.runnerTicks).toEqual([300, 504]);
    // 0 號邊：300 + (1740 − 504)；1 號邊：(1740 − 300) + 504
    expect(c10Game.score(caught)).toEqual([300 + (ROUND_TICKS - 504), ROUND_TICKS - 300 + 504]);
    expect(c10Game.winner(caught)).toBe(1);
  });

  it('16. 邊界：兩局撐的一樣久：平手（winner 是 null）', () => {
    const caught = c10Game.step(
      catchSetup({
        round: 1,
        roundTick: 503,
        runnerTicks: [504, -1],
        snakes: [
          { body: body([9, 11]), dir: DOWN, score: 504 },
          { body: body([10, 12], [9, 12], [8, 12], [7, 12]), dir: RIGHT, score: ROUND_TICKS - 504 },
        ],
      }),
      IDLE,
    );
    expect(c10Game.isOver(caught)).toBe(true);
    const [a, b] = c10Game.score(caught);
    expect(a).toBe(b);
    expect(c10Game.winner(caught)).toBeNull();
  });

  it('17. 結束之後再 step：原樣不動（score 與 winner 都不變）', () => {
    const over = c10Game.step(
      catchSetup({
        round: 1,
        roundTick: 503,
        runnerTicks: [300, -1],
        snakes: [
          { body: body([9, 11]), dir: DOWN, score: 300 },
          { body: body([10, 12], [9, 12], [8, 12], [7, 12]), dir: RIGHT, score: ROUND_TICKS - 300 },
        ],
      }),
      IDLE,
    );
    expect(c10Game.isOver(over)).toBe(true);
    const again = run(over, 120, [PRESS_UP, PRESS_LEFT]);
    expect(again).toEqual(over);
  });

  it('18. 真的把兩局打完：對手一直放開，兩局都在 3600 個 tick 之內結束，並且總分加起來是兩局的長度', () => {
    let state = c10Game.init(2, CONFIG);
    let ticks = 0;
    while (!c10Game.isOver(state) && ticks < 3600) {
      state = c10Game.step(state, IDLE);
      ticks += 1;
    }
    expect(c10Game.isOver(state)).toBe(true);
    expect(ticks).toBeLessThanOrEqual(3600);
    const [a, b] = c10Game.score(state);
    expect(a + b).toBe(2 * ROUND_TICKS);
  });
});

describe('C-10 追與逃｜追的蛇的瞄準（aim）', () => {
  it('19. 預設的 aim 是逃的蛇再直走 4 步的位置；每 24 個 tick 才重新瞄準，兩次之間不變', () => {
    expect(AIM_EVERY).toBe(24);
    expect(AIM_LEAD).toBe(4);
    let state = makeState({
      snakes: [{ body: body([6, 12], [5, 12], [4, 12], [3, 12]), dir: RIGHT }],
    });
    expect(state.aim).toBe(cell(10, 12));
    // 逃的蛇第 1 個 tick 就轉向上：24 個 tick 之內瞄準點一個格子也不動
    state = c10Game.step(state, [PRESS_UP, NONE]);
    for (let i = 1; i < AIM_EVERY - 1; i += 1) {
      state = c10Game.step(state, IDLE);
      expect(state.aim).toBe(cell(10, 12));
    }
    // 第 24 個 tick：重新瞄準
    state = c10Game.step(state, IDLE);
    expect(state.roundTick).toBe(AIM_EVERY);
    // 它的轉向在第 1 個 tick 就鎖定了，所以 4 步都往上：(6,11)(6,10)(6,9)(6,8)；再直走 4 步是 (6,4)
    expect(head(state, 0)).toEqual([6, 8]);
    expect(state.aim).toBe(cell(6, 4));
  });

  it('20. 邊界：預測的路徑走到離牆 2 格就停（逃的蛇一定會在牆前轉彎）', () => {
    expect(AIM_MARGIN).toBe(2);
    const near = makeState({
      snakes: [{ body: body([27, 12], [26, 12], [25, 12], [24, 12]), dir: RIGHT }],
    });
    // (28,12) 離牆 3、(29,12) 離牆 2，再往前 (30,12) 離牆 1 就不走了
    expect(straightModel(near, 4)).toBe(cell(29, 12));
    expect(near.aim).toBe(cell(29, 12));
    // 已經貼著牆往旁邊走：照走（離牆的距離沒有更小）
    const along = makeState({
      snakes: [{ body: body([5, 1], [4, 1], [3, 1], [2, 1]), dir: RIGHT }],
    });
    expect(straightModel(along, 4)).toBe(cell(9, 1));
  });

  it('21. 追的蛇的決定受 aim 影響：只有 aim 不同的兩個局面，等級 10 的搜尋型走不同的方向', () => {
    const base = makeState({
      snakes: [{}, { body: body([20, 12]), dir: LEFT }],
    });
    const up = { ...base, aim: cell(14, 4) };
    const down = { ...base, aim: cell(14, 20) };
    const decide = (state: C10State): Buttons =>
      pathfinder.decide(c10Game, state, 1, 0, { depth: 6, seed: 1 });
    // 往左走的蛇：aim 在上面就要往上（右手邊……向上轉），在下面就要往下轉
    expect(decide(up).up).toBe(true);
    expect(decide(down).down).toBe(true);
  });
});

/** 逃的蛇的腳本：第 `at` 步起一直走 `then`，之前往右。 */
function scriptDir(at: number, then: Dir): (move: number) => Dir {
  return (move) => (move >= at ? then : RIGHT);
}

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === UP, right: dir === RIGHT, down: dir === DOWN, left: dir === LEFT };
}

function scriptController(script: (move: number) => Dir): Controller<C10State> {
  return {
    decide(state, side) {
      const me = state.snakes[side];
      const dir = script(Math.floor(Math.max(0, state.roundTick) / MOVE_EVERY));
      return dir === me.dir || (dir + 2) % 4 === me.dir ? NONE : press(dir);
    },
  };
}

/** 「知道逃的蛇會照腳本走」的預測模型：把腳本往前跑 `moves` 步。 */
function scriptModel(script: (move: number) => Dir): RunnerModel {
  const dx = [0, 1, 0, -1];
  const dy = [-1, 0, 1, 0];
  return (state, moves) => {
    let at = state.snakes[state.runner]?.body[0] as number;
    let move = Math.floor(Math.max(0, state.roundTick) / MOVE_EVERY);
    for (let i = 0; i < moves; i += 1) {
      const dir = script(move);
      const x = cellX(at) + (dx[dir] as number);
      const y = cellY(at) + (dy[dir] as number);
      if (x < 0 || x > 31 || y < 0 || y > 23) {
        break;
      }
      at = cell(x, y);
      move += 1;
    }
    return at;
  };
}

/** 一個固定的局面：逃的蛇在 (8,12) 往右，追的蛇在 `chaser` 往 `dir`。 */
function chaseScenario(chaser: [number, number], dir: Dir): C10State {
  return makeState({
    snakes: [
      { body: body([8, 12], [7, 12], [6, 12], [5, 12]), dir: RIGHT },
      { body: body(chaser), dir },
    ],
  });
}

/** 走 24 個 tick（瞄準之後到下一次瞄準之前）：0 號邊照腳本，1 號邊是等級 10 的搜尋型。 */
function playWindow(
  game: ReturnType<typeof createC10Game>,
  start: C10State,
  script: (move: number) => Dir,
): C10State {
  const runner = scriptController(script);
  const chaser = levelController(game, pathfinder, 10, 1);
  let state = start;
  for (let tick = 0; tick < AIM_EVERY && state.pause === 0; tick += 1) {
    state = game.step(state, [runner.decide(state, 0, tick), chaser.decide(state, 1, tick)]);
  }
  return state;
}

describe('C-10 追與逃｜搜尋型的破綻：追的蛇只相信「你會一直直走」', () => {
  const straight = scriptDir(Number.POSITIVE_INFINITY, RIGHT);
  const jink = scriptDir(1, UP);
  const aware = createC10Game(scriptModel(jink));

  it('22. 預測的誤差：逃的蛇一直直走，瞄準點一格不差；它在瞄準之後轉彎，下一次瞄準之前瞄準點偏 6 格', () => {
    const start = chaseScenario([14, 20], UP);
    expect(start.aim).toBe(cell(12, 12));
    const straightEnd = playWindow(c10Game, start, straight);
    const jinkEnd = playWindow(c10Game, start, jink);
    // 下一次瞄準之前，逃的蛇在哪裡
    expect(manhattan(start.aim, straightEnd.snakes[0].body[0] as number)).toBe(0);
    expect(manhattan(start.aim, jinkEnd.snakes[0].body[0] as number)).toBe(6);
  });

  it('23. 追的蛇撲空：一批追方位置（不是挑好的幾個）上，知道逃的蛇會轉彎的追法比較近，而且被騙從來不會比較好', () => {
    // 這條要證明的是「急轉騙得到搜尋型」這個機制，不是某一個局面的某一個差距。
    // 所以掃一整片追方位置（x 9..16、y 13..21 每隔 2 格，各 3 個朝向，共 120 個局面），
    // 每個局面各走 24 個 tick（瞄準之後到下一次瞄準之前），比兩種追法最後離逃的蛇幾格。
    // gap = 被騙的追法的距離 − 知道會轉彎的追法的距離（正的 = 被騙的比較遠）。
    // 實測（等級 10 搜尋型）：三個朝向的 gap > 0 各占 30%、30%、37.5%，gap < 0 是 0 個；
    // gap > 0 的局面平均差 2.9 到 3.2 格；全部 120 個的平均 0.9 到 1.1 格。
    // 破綻只在追方靠近、又得轉向去追瞄準點時才傷人，離得遠的位置兩種追法走一樣的路（gap 0），所以平均數不拿來當主要門檻。
    // 門檻（都留了餘裕）：
    //   被騙從來不會比較好：gap < 0 的局面不超過 5%（實測 0%）。
    //   破綻確實在發生：gap > 0 的局面至少 20%（實測至少 30%）。
    //   發生的時候是實在的差距：gap > 0 的局面平均至少 2 格（實測 2.9 以上；逃的蛇一步一格，等於白白落後 2 步）。
    const gaps: number[] = [];
    for (const dir of [RIGHT, UP, DOWN] as Dir[]) {
      for (let cx = 9; cx <= 16; cx += 1) {
        for (let cy = 13; cy <= 21; cy += 2) {
          const start = chaseScenario([cx, cy], dir);
          const awareStart = { ...start, aim: scriptModel(jink)(start, AIM_LEAD) };
          const naiveEnd = playWindow(c10Game, start, jink);
          const awareEnd = playWindow(aware, awareStart, jink);
          const gapOf = (end: C10State): number =>
            manhattan(end.snakes[0].body[0] as number, end.snakes[1].body[0] as number);
          gaps.push(gapOf(naiveEnd) - gapOf(awareEnd));
        }
      }
    }
    const fooled = gaps.filter((g) => g > 0);
    const backfired = gaps.filter((g) => g < 0);
    expect(gaps).toHaveLength(120);
    expect(backfired.length / gaps.length).toBeLessThanOrEqual(0.05);
    expect(fooled.length / gaps.length).toBeGreaterThanOrEqual(0.2);
    expect(fooled.reduce((a, b) => a + b, 0) / fooled.length).toBeGreaterThanOrEqual(2);
  });

  it('24. 對照組：逃的蛇一直直走時，兩種追法完全一樣（差別只在「預測會不會被騙」）', () => {
    for (const [cx, cy, dir] of [
      [10, 14, RIGHT],
      [12, 14, RIGHT],
    ] as [number, number, Dir][]) {
      const start = chaseScenario([cx, cy], dir);
      const straightAware = createC10Game(scriptModel(straight));
      const a = playWindow(c10Game, start, straight);
      const b = playWindow(straightAware, start, straight);
      expect(b.snakes).toEqual(a.snakes);
    }
  });
});

describe('C-10 追與逃｜actions 與 evaluate', () => {
  it('25. actions：局進行中兩邊都有 5 個不同的動作；一局結束後只剩「全放開」', () => {
    const state = makeState();
    for (const side of [0, 1] as const) {
      const actions = c10Game.actions(state, side);
      expect(actions).toHaveLength(5);
      expect(new Set(actions.map((a) => JSON.stringify(a))).size).toBe(5);
    }
    const ended = c10Game.step(catchSetup(), IDLE);
    expect(c10Game.actions(ended, 0)).toEqual([NONE]);
    expect(c10Game.actions(ended, 1)).toEqual([NONE]);
  });

  it('26. 追的蛇的 actions 順序：轉向「離 aim 比較近」的那邊排第一', () => {
    // 追的蛇在 (20,12) 往左；aim 在上面 → 往上轉排第一；aim 在下面 → 往下轉排第一
    const base = makeState({ snakes: [{}, { body: body([20, 12]), dir: LEFT }] });
    expect(c10Game.actions({ ...base, aim: cell(14, 4) }, 1)[0]).toEqual(PRESS_UP);
    expect(c10Game.actions({ ...base, aim: cell(14, 20) }, 1)[0]).toEqual(PRESS_DOWN);
  });

  it('27. 追的蛇的 evaluate：下一步離 aim 越近 gain 越高；下一步走出地圖 danger 是 1；走進逃的蛇的身體不危險', () => {
    const base = makeState({
      aim: cell(12, 12),
      snakes: [
        { body: body([10, 12], [9, 12], [8, 12], [7, 12]), dir: RIGHT },
        { body: body([20, 12]), dir: LEFT },
      ],
    });
    const near = c10Game.evaluate(base, 1);
    const far = c10Game.evaluate(
      makeState({
        aim: cell(12, 12),
        snakes: [
          { body: body([10, 12], [9, 12], [8, 12], [7, 12]), dir: RIGHT },
          { body: body([28, 12]), dir: LEFT },
        ],
      }),
      1,
    );
    expect(near.gain).toBeGreaterThan(far.gain);
    expect(near.danger).toBe(0);
    const outside = c10Game.evaluate(
      makeState({ snakes: [{}, { body: body([0, 5]), dir: LEFT }] }),
      1,
    );
    expect(outside.danger).toBe(1);
    // 下一步就是逃的蛇的身體
    const onBody = c10Game.evaluate(catchSetup({ roundTick: 0 }), 1);
    expect(onBody.danger).toBe(0);
  });

  it('28. 逃的蛇的 evaluate：離追的蛇越遠 gain 越高；下一步撞牆 danger 是 1', () => {
    const closeChaser = makeState({
      snakes: [
        { body: body([12, 12], [11, 12], [10, 12], [9, 12]), dir: RIGHT },
        { body: body([16, 12]), dir: LEFT },
      ],
    });
    const farChaser = makeState({
      snakes: [
        { body: body([12, 12], [11, 12], [10, 12], [9, 12]), dir: RIGHT },
        { body: body([28, 18]), dir: LEFT },
      ],
    });
    expect(c10Game.evaluate(farChaser, 0).gain).toBeGreaterThan(
      c10Game.evaluate(closeChaser, 0).gain,
    );
    const wall = makeState({
      snakes: [{ body: body([31, 12], [30, 12], [29, 12], [28, 12]), dir: RIGHT }],
    });
    expect(c10Game.evaluate(wall, 0).danger).toBe(1);
  });

  it('29. 一局結束的 evaluate：抓到的追方最高、被抓的逃方最低；越早抓到對追方越好、撐越久對逃方越好', () => {
    const early = c10Game.step(catchSetup({ roundTick: 11 }), IDLE);
    const late = c10Game.step(catchSetup({ roundTick: 599 }), IDLE);
    expect(early.outcome).toBe('runnerOut');
    expect(late.outcome).toBe('runnerOut');
    expect(c10Game.evaluate(early, 1).gain).toBeGreaterThan(0);
    expect(c10Game.evaluate(early, 0).gain).toBeLessThan(0);
    expect(c10Game.evaluate(early, 1).gain).toBeGreaterThan(c10Game.evaluate(late, 1).gain);
    expect(c10Game.evaluate(late, 0).gain).toBeGreaterThan(c10Game.evaluate(early, 0).gain);
    // 追的蛇自己撞牆：逃的蛇贏
    const out = c10Game.step(
      makeState({ roundTick: BEFORE_MOVE, snakes: [{}, { body: body([0, 5]), dir: LEFT }] }),
      IDLE,
    );
    expect(c10Game.evaluate(out, 0).gain).toBeGreaterThan(0);
    expect(c10Game.evaluate(out, 1).gain).toBeLessThan(0);
    expect(c10Game.evaluate(out, 1).danger).toBe(1);
  });

  it('30. evaluate 與 actions 不受兩邊累積分數影響（沒有橡皮筋：領先的人不會被懲罰）', () => {
    const a = makeState({ round: 1, snakes: [{ score: 0 }, { score: 0 }] });
    const b = makeState({ round: 1, snakes: [{ score: 1500 }, { score: 40 }] });
    for (const side of [0, 1] as const) {
      expect(c10Game.evaluate(a, side)).toEqual(c10Game.evaluate(b, side));
      expect(c10Game.actions(a, side)).toEqual(c10Game.actions(b, side));
    }
  });
});

describe('C-10 追與逃｜種子、純度與畫面', () => {
  it('31. 隨機事件在不同種子下不全相同：10 個種子的起始位置不可以全部一樣', () => {
    const layouts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const state = c10Game.init(seed, CONFIG);
      layouts.add(JSON.stringify([state.snakes[0].body, state.snakes[1].body]));
    }
    expect(layouts.size).toBeGreaterThan(1);
    // 方向也要隨種子變（不能只有位置變）
    const dirs = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const state = c10Game.init(seed, CONFIG);
      dirs.add(`${state.snakes[0].dir}${state.snakes[1].dir}`);
    }
    expect(dirs.size).toBeGreaterThan(1);
  });

  it('32. 同一個種子，初始 state 完全相同', () => {
    expect(c10Game.init(7, CONFIG)).toEqual(c10Game.init(7, CONFIG));
  });

  it('33. step 不改動傳進來的 state（凍結之後照樣能 step，連兩局之間與結束的 tick 也是）', () => {
    const deepFreeze = (value: unknown): void => {
      if (typeof value === 'object' && value !== null) {
        Object.freeze(value);
        for (const inner of Object.values(value)) {
          deepFreeze(inner);
        }
      }
    };
    for (const state of [
      c10Game.init(4, CONFIG),
      catchSetup(),
      c10Game.step(catchSetup(), IDLE),
      makeState({ pause: 1, outcome: 'runnerOut', runnerTicks: [300, -1] }),
    ]) {
      const before = JSON.stringify(state);
      deepFreeze(state);
      expect(() => c10Game.step(state, [PRESS_UP, PRESS_DOWN])).not.toThrow();
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it('34. render：畫得出來、不改 state；人在逃的時候畫出追的蛇的瞄準記號，且記號在 aim 那一格', () => {
    const state = makeState({ aim: cell(15, 8) });
    const before = JSON.stringify(state);
    const fake = createFakeContext();
    c10Render(asRenderingContext(fake), state);
    expect(JSON.stringify(state)).toBe(before);
    const used = fake.colors.filter((c) => c.via === 'set').map((c) => String(c.value));
    expect(used).toContain(COLOR.warning);
    // 瞄準記號在 (15,8) 那一格附近：畫在 x 150..160、y 80..90 範圍內的繪圖點
    const near = fake.points.filter((p) => p.x >= 148 && p.x <= 162 && p.y >= 78 && p.y <= 92);
    expect(near.length).toBeGreaterThan(0);
    for (const p of fake.points) {
      expect(p.x).toBeGreaterThanOrEqual(-8);
      expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
      expect(p.y).toBeGreaterThanOrEqual(-8);
      expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
    }
  });
});
