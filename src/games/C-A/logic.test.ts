import { describe, expect, it } from 'vitest';

import { pathfinder } from '../../ai/policies/pathfinder';
import type { Buttons, Inputs } from '../../core/types';
import {
  CELLS,
  cell,
  cellX,
  cellY,
  DOWN,
  HEIGHT,
  LEFT,
  MOVE_EVERY,
  RIGHT,
  UP,
  WIDTH,
} from '../_clubs/logic';
import type { ClubsState } from '../_clubs/logic';
import { cAGame, makeState } from './logic';

/**
 * C-A 貪食蛇對決的規則測試（TEST_PLAN 第 6 節 C-A 的 11 條，外加邊界情況與種子）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 */

const CONFIG = { maxTicks: 3600, params: {} };

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_UP: Buttons = { ...NONE, up: true };
const PRESS_DOWN: Buttons = { ...NONE, down: true };
const PRESS_LEFT: Buttons = { ...NONE, left: true };
const PRESS_RIGHT: Buttons = { ...NONE, right: true };

const IDLE: Inputs = [NONE, NONE];

/** 走 n 個 tick，每個 tick 都給同一組輸入。 */
function run(state: ClubsState, count: number, inputs: Inputs = IDLE): ClubsState {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = cAGame.step(current, inputs);
  }
  return current;
}

/** 讓「下一次 step」剛好是走格的那一次。 */
const BEFORE_MOVE = MOVE_EVERY - 1;

function body(...points: [number, number][]): number[] {
  return points.map(([x, y]) => cell(x, y));
}

function headOf(state: ClubsState, side: 0 | 1): [number, number] {
  const head = state.snakes[side].body[0] as number;
  return [cellX(head), cellY(head)];
}

describe('C-A 貪食蛇對決｜TEST_PLAN 第 6 節', () => {
  it('1. 初始：兩條蛇長度 3、位置與方向如規格；場上 2 個食物，不在蛇身上', () => {
    const state = cAGame.init(0, CONFIG);
    const [human, ai] = state.snakes;
    expect(human.body).toHaveLength(3);
    expect(ai.body).toHaveLength(3);
    expect(human.body).toEqual(body([5, 12], [4, 12], [3, 12]));
    expect(ai.body).toEqual(body([26, 11], [27, 11], [28, 11]));
    expect(human.dir).toBe(RIGHT);
    expect(ai.dir).toBe(LEFT);
    expect(human.alive && ai.alive).toBe(true);
    expect(cAGame.score(state)).toEqual([0, 0]);
    expect(state.foods).toHaveLength(2);
    expect(new Set(state.foods).size).toBe(2);
    const occupied = new Set([...human.body, ...ai.body]);
    for (const food of state.foods) {
      expect(occupied.has(food)).toBe(false);
      expect(food).toBeGreaterThanOrEqual(0);
      expect(food).toBeLessThan(CELLS);
    }
    expect(cAGame.isOver(state)).toBe(false);
  });

  it('1b. 格子是 32×24，兩條蛇起始位置對地圖中心 180 度對稱', () => {
    expect([WIDTH, HEIGHT]).toEqual([32, 24]);
    const state = cAGame.init(3, CONFIG);
    const mirrored = state.snakes[0].body.map((c) =>
      cell(WIDTH - 1 - cellX(c), HEIGHT - 1 - cellY(c)),
    );
    expect(mirrored).toEqual(state.snakes[1].body);
  });

  it('2. 6 個 tick 後蛇頭前進一格；第 1 到 5 個 tick 不動', () => {
    let state = cAGame.init(0, CONFIG);
    const start = state.snakes.map((snake) => [...snake.body]);
    for (let t = 1; t <= 5; t += 1) {
      state = cAGame.step(state, IDLE);
      expect(state.snakes[0].body).toEqual(start[0]);
      expect(state.snakes[1].body).toEqual(start[1]);
    }
    state = cAGame.step(state, IDLE);
    expect(state.tick).toBe(6);
    expect(headOf(state, 0)).toEqual([6, 12]);
    expect(headOf(state, 1)).toEqual([25, 11]);
    expect(state.snakes[0].body).toHaveLength(3);
    expect(state.snakes[0].body).toEqual(body([6, 12], [5, 12], [4, 12]));
  });

  it('3. 往右走時按左：方向不變；按上：下一次移動改成往上', () => {
    const reverse = run(cAGame.init(0, CONFIG), MOVE_EVERY, [PRESS_LEFT, NONE]);
    expect(reverse.snakes[0].dir).toBe(RIGHT);
    expect(headOf(reverse, 0)).toEqual([6, 12]);

    let state = cAGame.init(0, CONFIG);
    state = cAGame.step(state, [PRESS_UP, NONE]);
    state = run(state, MOVE_EVERY - 1);
    expect(state.snakes[0].dir).toBe(UP);
    expect(headOf(state, 0)).toEqual([5, 11]);
  });

  it('4. 一格之內連按上再按左（原本往右）：只採用第一個有效的轉向，不會變成掉頭', () => {
    let state = cAGame.init(0, CONFIG);
    state = cAGame.step(state, [PRESS_UP, NONE]);
    state = cAGame.step(state, [PRESS_LEFT, NONE]);
    state = run(state, MOVE_EVERY - 2);
    expect(state.snakes[0].dir).toBe(UP);
    expect(headOf(state, 0)).toEqual([5, 11]);
    expect(state.snakes[0].alive).toBe(true);
    // 下一格的週期裡，左對「往上」來說是有效的轉向，可以採用。
    state = run(state, MOVE_EVERY, [PRESS_LEFT, NONE]);
    expect(state.snakes[0].dir).toBe(LEFT);
    expect(headOf(state, 0)).toEqual([4, 11]);
  });

  it('4b. 按與行進方向相同的鍵不算轉向，不會鎖住之後的真轉向', () => {
    let state = cAGame.init(0, CONFIG);
    state = cAGame.step(state, [PRESS_RIGHT, NONE]);
    expect(state.snakes[0].turn).toBe(RIGHT);
    state = cAGame.step(state, [PRESS_DOWN, NONE]);
    state = run(state, MOVE_EVERY - 2);
    expect(headOf(state, 0)).toEqual([5, 13]);
  });

  it('5. 蛇頭走進食物：分數加 1、長度加 1、食物消失並在空格補一個，場上仍是 2 個', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [{ body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT }, {}],
      foods: [cell(11, 5), cell(20, 20)],
    });
    const next = cAGame.step(state, IDLE);
    expect(cAGame.score(next)).toEqual([1, 0]);
    expect(next.snakes[0].body).toHaveLength(4);
    expect(next.snakes[0].body).toEqual(body([11, 5], [10, 5], [9, 5], [8, 5]));
    expect(next.foods).toHaveLength(2);
    expect(next.foods).toContain(cell(20, 20));
    expect(next.foods).not.toContain(cell(11, 5));
    const occupied = new Set([...next.snakes[0].body, ...next.snakes[1].body]);
    for (const food of next.foods) {
      expect(occupied.has(food)).toBe(false);
    }
    expect(new Set(next.foods).size).toBe(2);
    expect(cAGame.isOver(next)).toBe(false);
  });

  it('5b. 補食物用到亂數：新的 RngState 有寫回 state（否則每次補的位置會被鎖死）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [{ body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT }, {}],
      foods: [cell(11, 5), cell(20, 20)],
    });
    const next = cAGame.step(state, IDLE);
    expect(next.rng).not.toBe(state.rng);
  });

  it('6. 撞牆：那條蛇死亡，isOver，另一邊是 winner', () => {
    const right = makeState({
      tick: BEFORE_MOVE,
      snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}],
    });
    const hitRight = cAGame.step(right, IDLE);
    expect(cAGame.isOver(hitRight)).toBe(true);
    expect(hitRight.snakes[0].alive).toBe(false);
    expect(hitRight.snakes[1].alive).toBe(true);
    expect(cAGame.winner(hitRight)).toBe(1);

    const top = makeState({
      tick: BEFORE_MOVE,
      snakes: [{}, { body: body([10, 0], [10, 1], [10, 2]), dir: UP }],
    });
    const hitTop = cAGame.step(top, IDLE);
    expect(cAGame.isOver(hitTop)).toBe(true);
    expect(hitTop.snakes[1].alive).toBe(false);
    expect(cAGame.winner(hitTop)).toBe(0);
  });

  it('7. 撞自己的身體、撞對方的身體：同上', () => {
    // 人往右，頭 (5,5)，前方 (6,5) 是自己的身體（不是尾巴）。
    const self = makeState({
      tick: BEFORE_MOVE,
      snakes: [
        {
          body: body([5, 5], [4, 5], [4, 6], [5, 6], [6, 6], [6, 5], [7, 5]),
          dir: RIGHT,
        },
        {},
      ],
    });
    const hitSelf = cAGame.step(self, IDLE);
    expect(cAGame.isOver(hitSelf)).toBe(true);
    expect(hitSelf.snakes[0].alive).toBe(false);
    expect(cAGame.winner(hitSelf)).toBe(1);

    // 人往右，頭 (5,5)，前方 (6,5) 是 AI 的身體；AI 往下走一格之後 (6,5) 還是它的身體。
    const other = makeState({
      tick: BEFORE_MOVE,
      snakes: [
        { body: body([5, 5], [4, 5], [3, 5]), dir: RIGHT },
        { body: body([6, 6], [6, 5], [6, 4]), dir: DOWN },
      ],
    });
    const hitOther = cAGame.step(other, IDLE);
    expect(cAGame.isOver(hitOther)).toBe(true);
    expect(hitOther.snakes[0].alive).toBe(false);
    expect(hitOther.snakes[1].alive).toBe(true);
    expect(cAGame.winner(hitOther)).toBe(1);

    // 反過來：AI 撞人。
    const reverse = makeState({
      tick: BEFORE_MOVE,
      snakes: [
        { body: body([10, 5], [10, 6], [10, 7]), dir: UP },
        { body: body([11, 5], [12, 5], [13, 5]), dir: LEFT },
      ],
    });
    // AI 往左走進 (10,5)：人往上走到 (10,4)，人的身體走完之後是 (10,4),(10,5),(10,6)，(10,5) 仍被佔用。
    const aiHits = cAGame.step(reverse, IDLE);
    expect(aiHits.snakes[1].alive).toBe(false);
    expect(cAGame.winner(aiHits)).toBe(0);
  });

  it('8. 兩條蛇同一個 tick 頭對頭：都死，分數高的贏；同分 winner 是 null', () => {
    const head = (scoreHuman: number, scoreAi: number): ClubsState =>
      makeState({
        tick: BEFORE_MOVE,
        snakes: [
          { body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT, score: scoreHuman },
          { body: body([12, 5], [13, 5], [14, 5]), dir: LEFT, score: scoreAi },
        ],
      });
    const humanAhead = cAGame.step(head(3, 1), IDLE);
    expect(cAGame.isOver(humanAhead)).toBe(true);
    expect(humanAhead.snakes[0].alive).toBe(false);
    expect(humanAhead.snakes[1].alive).toBe(false);
    expect(cAGame.winner(humanAhead)).toBe(0);

    const aiAhead = cAGame.step(head(0, 2), IDLE);
    expect(cAGame.winner(aiAhead)).toBe(1);

    const tied = cAGame.step(head(2, 2), IDLE);
    expect(cAGame.isOver(tied)).toBe(true);
    expect(cAGame.winner(tied)).toBeNull();
  });

  it('8b. 邊界：兩個蛇頭互相穿過（交換位置）也是兩邊都死', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [
        { body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT, score: 1 },
        { body: body([11, 5], [12, 5], [13, 5]), dir: LEFT, score: 0 },
      ],
    });
    const next = cAGame.step(state, IDLE);
    expect(next.snakes[0].alive).toBe(false);
    expect(next.snakes[1].alive).toBe(false);
    expect(cAGame.winner(next)).toBe(0);
  });

  it('9. 走進對方剛離開的尾巴那一格：不算撞（尾巴已經移走）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [
        { body: body([5, 5], [4, 5], [3, 5]), dir: RIGHT },
        { body: body([8, 5], [7, 5], [6, 5]), dir: RIGHT },
      ],
      foods: [cell(20, 20), cell(25, 3)],
    });
    const next = cAGame.step(state, IDLE);
    expect(cAGame.isOver(next)).toBe(false);
    expect(next.snakes[0].alive).toBe(true);
    expect(headOf(next, 0)).toEqual([6, 5]);
  });

  it('9b. 邊界：走進自己剛離開的尾巴那一格也不算撞', () => {
    // 2×2 的方塊形，蛇頭 (5,5)、尾巴 (5,6)，往下走一格會進到自己的尾巴格。
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [{ body: body([5, 5], [6, 5], [6, 6], [5, 6]), dir: LEFT, turn: DOWN }, {}],
      foods: [cell(20, 20), cell(25, 3)],
    });
    const next = cAGame.step(state, IDLE);
    expect(next.snakes[0].alive).toBe(true);
    expect(headOf(next, 0)).toEqual([5, 6]);
  });

  it('9c. 邊界：對方同一個 tick 剛吃到食物（尾巴沒移走），走進它的尾巴格算撞', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [
        { body: body([5, 5], [4, 5], [3, 5]), dir: RIGHT },
        { body: body([8, 5], [7, 5], [6, 5]), dir: RIGHT },
      ],
      foods: [cell(9, 5), cell(25, 3)],
    });
    const next = cAGame.step(state, IDLE);
    expect(next.snakes[1].alive).toBe(true);
    expect(cAGame.score(next)).toEqual([0, 1]);
    expect(next.snakes[0].alive).toBe(false);
    expect(cAGame.winner(next)).toBe(1);
  });

  it('10. 3600 tick 到：isOver，分數高的贏', () => {
    const humanAhead = makeState({ tick: 3599, snakes: [{ score: 2 }, { score: 1 }] });
    expect(cAGame.isOver(humanAhead)).toBe(false);
    expect(cAGame.winner(humanAhead)).toBeNull();
    const done = cAGame.step(humanAhead, IDLE);
    expect(done.tick).toBe(3600);
    expect(cAGame.isOver(done)).toBe(true);
    expect(cAGame.score(done)).toEqual([2, 1]);
    expect(cAGame.winner(done)).toBe(0);

    const aiAhead = cAGame.step(
      makeState({ tick: 3599, snakes: [{ score: 0 }, { score: 4 }] }),
      IDLE,
    );
    expect(cAGame.winner(aiAhead)).toBe(1);

    const tie = cAGame.step(makeState({ tick: 3599, snakes: [{ score: 3 }, { score: 3 }] }), IDLE);
    expect(cAGame.isOver(tie)).toBe(true);
    expect(cAGame.winner(tie)).toBeNull();
  });

  it('10b. 邊界：用 init 開的局，不動的兩邊在 maxTicks 之前 isOver 是 false，到了才是 true', () => {
    // 兩條蛇都直直往前走，會在 3600 tick 之前撞牆；這裡只確認 maxTicks 比較短時以時間到結束。
    let state = makeState({ maxTicks: 60, foods: [cell(0, 0), cell(0, 23)] });
    for (let t = 0; t < 59; t += 1) {
      state = cAGame.step(state, IDLE);
      expect(cAGame.isOver(state)).toBe(false);
    }
    state = cAGame.step(state, IDLE);
    expect(cAGame.isOver(state)).toBe(true);
    expect(cAGame.winner(state)).toBeNull();
  });

  it('11. 場地滿到沒有空格可以放食物：不當掉，場上食物數可以少於 2', () => {
    // 所有格子都被佔滿，只剩 (1,0) 放著食物。人 (0,0) 往右吃掉它；AI 的下一格是自己的尾巴格。
    const all: number[] = [];
    for (let c = 0; c < CELLS; c += 1) {
      all.push(c);
    }
    const reserved = new Set([cell(0, 0), cell(1, 0), cell(31, 23), cell(30, 23)]);
    const humanBody = [cell(0, 0), ...all.filter((c) => !reserved.has(c))];
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [
        { body: humanBody, dir: RIGHT },
        { body: [cell(31, 23), cell(30, 23)], dir: LEFT },
      ],
      foods: [cell(1, 0)],
    });
    const next = cAGame.step(state, IDLE);
    expect(cAGame.isOver(next)).toBe(false);
    expect(cAGame.score(next)).toEqual([1, 0]);
    expect(next.foods.length).toBeLessThan(2);
    expect(next.foods).toHaveLength(0);
    // 之後繼續走也不會當掉。
    expect(() => run(next, 12)).not.toThrow();
  });

  it('11b. 食物不足 2 個、而且有空格時，下一次走格會補回 2 個', () => {
    const state = makeState({ tick: BEFORE_MOVE, foods: [] });
    const next = cAGame.step(state, IDLE);
    expect(next.foods).toHaveLength(2);
    expect(new Set(next.foods).size).toBe(2);
  });
});

describe('C-A 貪食蛇對決｜同一個 tick 發生兩件事、剛好在門檻上', () => {
  it('邊界：吃到食物的同一個 tick，對手撞牆死了：活著的照樣得分，並且贏', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [
        { body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT },
        { body: body([0, 8], [1, 8], [2, 8]), dir: LEFT },
      ],
      foods: [cell(11, 5), cell(20, 20)],
    });
    const next = cAGame.step(state, IDLE);
    expect(cAGame.isOver(next)).toBe(true);
    expect(next.snakes[1].alive).toBe(false);
    expect(cAGame.score(next)).toEqual([1, 0]);
    expect(cAGame.winner(next)).toBe(0);
  });

  it('邊界：兩條蛇的頭同時進到同一格食物（頭對頭）：兩邊都死，誰都不得分', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [
        { body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT, score: 2 },
        { body: body([12, 5], [13, 5], [14, 5]), dir: LEFT, score: 2 },
      ],
      foods: [cell(11, 5), cell(20, 20)],
    });
    const next = cAGame.step(state, IDLE);
    expect(cAGame.score(next)).toEqual([2, 2]);
    expect(cAGame.winner(next)).toBeNull();
  });

  it('邊界：最後一個 tick（第 3600 個）撞牆：死亡優先於時間到，分數高的那條死了照樣輸', () => {
    const state = makeState({
      tick: 3599,
      snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT, score: 5 }, { score: 0 }],
    });
    // 3599 → 3600 剛好是走格的 tick。
    const next = cAGame.step(state, IDLE);
    expect(next.tick).toBe(3600);
    expect(cAGame.isOver(next)).toBe(true);
    expect(cAGame.winner(next)).toBe(1);
  });

  it('邊界：只有一條死、另一條分數比較低：活著的那條贏（不看分數）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT, score: 9 }, { score: 0 }],
    });
    const next = cAGame.step(state, IDLE);
    expect(cAGame.score(next)).toEqual([9, 0]);
    expect(cAGame.winner(next)).toBe(1);
  });

  it('結束之後再 step：原樣不動', () => {
    const over = cAGame.step(
      makeState({
        tick: BEFORE_MOVE,
        snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}],
      }),
      IDLE,
    );
    expect(cAGame.isOver(over)).toBe(true);
    const later = run(over, 30, [PRESS_UP, PRESS_DOWN]);
    expect(later).toEqual(over);
  });

  it('step 不改動傳進來的 state（凍結之後照樣能 step）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [{ body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT }, {}],
      foods: [cell(11, 5), cell(20, 20)],
    });
    const before = JSON.stringify(state);
    const deepFreeze = (value: unknown): void => {
      if (typeof value === 'object' && value !== null) {
        Object.freeze(value);
        for (const inner of Object.values(value)) {
          deepFreeze(inner);
        }
      }
    };
    deepFreeze(state);
    expect(() => cAGame.step(state, [PRESS_UP, PRESS_DOWN])).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('C-A 貪食蛇對決｜種子', () => {
  it('隨機事件在不同種子下不全相同：10 個種子的初始食物位置不可以全部一樣', () => {
    const layouts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const foods = [...cAGame.init(seed, CONFIG).foods].sort((a, b) => a - b);
      layouts.add(foods.join(','));
    }
    expect(layouts.size).toBeGreaterThan(1);
  });

  it('同一個種子，初始 state 完全相同', () => {
    expect(cAGame.init(7, CONFIG)).toEqual(cAGame.init(7, CONFIG));
  });
});

describe('C-A 貪食蛇對決｜actions 與 evaluate', () => {
  it('actions 兩邊都固定五個不同的動作：全放開與四個方向', () => {
    const state = cAGame.init(0, CONFIG);
    for (const side of [0, 1] as const) {
      const actions = cAGame.actions(state, side);
      expect(actions).toHaveLength(5);
      const names = actions.map((a) => JSON.stringify(a));
      expect(new Set(names).size).toBe(5);
      expect(actions).toContainEqual(NONE);
      for (const press of [PRESS_UP, PRESS_DOWN, PRESS_LEFT, PRESS_RIGHT]) {
        expect(actions).toContainEqual(press);
      }
    }
  });

  it('actions 的順序：沒有鎖定轉向時，兩個有效的轉向排前面，讓蛇頭更靠近食物的那個排第一；不改變方向的動作排後面', () => {
    // 人在 (5,12) 往右。食物在正上方 (5,3)：往上轉最靠近。
    const above = makeState({ foods: [cell(5, 3), cell(30, 20)] });
    const first = cAGame.actions(above, 0);
    expect(first[0]).toEqual(PRESS_UP);
    expect(first[1]).toEqual(PRESS_DOWN);
    expect(first.slice(2)).toContainEqual(NONE);
    // 食物在正下方：往下轉排第一。
    const below = makeState({ foods: [cell(5, 20), cell(30, 3)] });
    expect(cAGame.actions(below, 0)[0]).toEqual(PRESS_DOWN);
    // 往右、往左（同向、反向）都不會改變方向，不能排在兩個轉向前面。
    for (const state of [above, below]) {
      const [a, b] = cAGame.actions(state, 0);
      expect([a, b]).not.toContainEqual(PRESS_RIGHT);
      expect([a, b]).not.toContainEqual(PRESS_LEFT);
      expect([a, b]).not.toContainEqual(NONE);
    }
  });

  it('actions 的順序：已經鎖定轉向、或局已經結束時，用固定順序（全放開排第一）', () => {
    const locked = cAGame.step(makeState({ foods: [cell(5, 3), cell(30, 20)] }), [PRESS_UP, NONE]);
    expect(cAGame.actions(locked, 0)[0]).toEqual(NONE);
  });

  it('搜尋型（往前看 6 個 tick）不會拖延：食物在正上方，現在就轉向，而不是等到走格前最後一刻', () => {
    const state = makeState({ foods: [cell(5, 3), cell(30, 20)] });
    for (const depth of [1, 3, 6]) {
      const pressed = pathfinder.decide(cAGame, state, 0, 0, { depth, seed: 0 });
      expect(pressed).toEqual(PRESS_UP);
    }
  });

  it('danger：下一步是牆是 1，開闊的地方是 0；下一步是蛇身也是 1', () => {
    const wall = makeState({ snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}] });
    expect(cAGame.evaluate(wall, 0).danger).toBe(1);
    expect(cAGame.evaluate(makeState({}), 0).danger).toBe(0);
    const blocked = makeState({
      snakes: [
        { body: body([5, 5], [4, 5], [3, 5]), dir: RIGHT },
        { body: body([6, 6], [6, 5], [6, 4]), dir: DOWN },
      ],
    });
    expect(cAGame.evaluate(blocked, 0).danger).toBe(1);
  });

  it('danger：往牆走越近越危險（前方 10 格內有牆開始算），貼著牆也有一點危險', () => {
    const at = (x: number): number =>
      cAGame.evaluate(
        makeState({ snakes: [{ body: body([x, 12], [x - 1, 12], [x - 2, 12]), dir: RIGHT }, {}] }),
        0,
      ).danger;
    expect(at(10)).toBe(0);
    expect(at(22)).toBeGreaterThan(0);
    expect(at(26)).toBeGreaterThan(at(22));
    expect(at(29)).toBeGreaterThan(at(26));
    expect(at(30)).toBeGreaterThan(at(29));
    expect(at(30)).toBeLessThan(1);
    expect(at(31)).toBe(1);
  });

  it('danger：快被困死的格子介於 0 與 1 之間', () => {
    // 往右走進一條只有 1 格深的死巷：右、上、下都是蛇身或牆。
    const trap = makeState({
      snakes: [
        {
          body: body([30, 5], [29, 5], [29, 4], [30, 4], [31, 4], [31, 6], [30, 6], [29, 6]),
          dir: RIGHT,
        },
        {},
      ],
    });
    const { danger } = cAGame.evaluate(trap, 0);
    expect(danger).toBeGreaterThan(0);
    expect(danger).toBeLessThan(1);
  });

  it('gain：多 1 分多 100；往食物的方向轉比較高；對方領先時是負的', () => {
    const base = makeState({ foods: [cell(20, 12), cell(20, 20)] });
    const ahead = makeState({ foods: [cell(20, 12), cell(20, 20)], snakes: [{ score: 1 }, {}] });
    expect(cAGame.evaluate(ahead, 0).gain - cAGame.evaluate(base, 0).gain).toBe(100);
    expect(cAGame.evaluate(ahead, 1).gain - cAGame.evaluate(base, 1).gain).toBe(-100);

    // 人在 (5,12) 往右，食物在右下方：鎖定「下」比維持「右」更靠近最近的食物嗎？
    // 食物 (6,14)：維持右下一步 (6,12) 距離 2；轉下 (5,13) 距離 2；轉到更近的食物才有差別，這裡用 (5,16)。
    const food = makeState({ foods: [cell(5, 16), cell(30, 1)] });
    const keep = food;
    const turnedDown = cAGame.step(food, [PRESS_DOWN, NONE]);
    expect(cAGame.evaluate(turnedDown, 0).gain).toBeGreaterThan(cAGame.evaluate(keep, 0).gain);
  });

  it('局結束：贏的 gain 為正、輸的為負；死掉的 danger 是 1', () => {
    const over = cAGame.step(
      makeState({
        tick: BEFORE_MOVE,
        snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}],
      }),
      IDLE,
    );
    expect(cAGame.evaluate(over, 0).danger).toBe(1);
    expect(cAGame.evaluate(over, 1).danger).toBe(0);
    expect(cAGame.evaluate(over, 1).gain).toBeGreaterThan(0);
    expect(cAGame.evaluate(over, 0).gain).toBeLessThan(0);
  });
});
