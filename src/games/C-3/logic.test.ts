import { describe, expect, it } from 'vitest';

import type { Buttons, Inputs } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { COLOR } from '../../shell/palette';
import { rngStateFor } from '../../core/rng';
import { cell, LEFT, MOVE_EVERY, RIGHT } from '../_clubs/logic';
import { describeSharedSnakeRules } from '../_clubs/shared-rules.test-helpers';
import { c3Game, makeState } from './logic';
import type { C3State } from './logic';
import { c3Render } from './render';

/**
 * C-3 紅藍食物的規則測試（TEST_PLAN 第 6 節 C-3 的 7 條）。
 * 第 7 條「撞擊規則與 C-A 相同（共用測試 6 到 9）」由 `_clubs/shared-rules.test-helpers.ts`
 * 的碰撞部分（`scope: 'collisions'`）跑；其餘是這個檔案。全部用 `makeState` 直接構造局面。
 */

const CONFIG = { maxTicks: 3600, params: {} };

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_UP: Buttons = { ...NONE, up: true };
const PRESS_DOWN: Buttons = { ...NONE, down: true };
const PRESS_LEFT: Buttons = { ...NONE, left: true };
const PRESS_RIGHT: Buttons = { ...NONE, right: true };
const IDLE: Inputs = [NONE, NONE];

const RED = 0;
const BLUE = 1;

/** 讓「下一次 step」剛好是走格的那一次。 */
const BEFORE_MOVE = MOVE_EVERY - 1;

function body(...points: [number, number][]): number[] {
  return points.map(([x, y]) => cell(x, y));
}

/** 人在 (10,5) 往右，前方 (11,5) 放一個食物，其餘食物遠遠的：下一個 step（走格）就會吃到它。 */
function eating(color: 0 | 1, overrides: Parameters<typeof makeState>[0] = {}): C3State {
  const others = [cell(20, 20), cell(25, 3), cell(3, 20)];
  return makeState({
    tick: BEFORE_MOVE,
    snakes: [{ body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT }, {}],
    foods: [cell(11, 5), ...others],
    foodColors: [color, ...(color === RED ? [RED, BLUE, BLUE] : [BLUE, RED, RED])] as (0 | 1)[],
    ...overrides,
  });
}

function countColor(state: C3State, color: 0 | 1): number {
  return state.foodColors.filter((c) => c === color).length;
}

/** 兩條蛇各繞一個 5×5 的方圈走，永遠不撞也不吃東西（食物都在圈外）。`t` 是即將進行的第 t 次 step。 */
function loopInputs(t: number): Inputs {
  if ((t - 1) % 30 !== 0 || t === 1) {
    return IDLE;
  }
  const n = (t - 1) / 30;
  const human = [PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT, PRESS_UP][n % 4] as Buttons;
  const ai = [PRESS_LEFT, PRESS_UP, PRESS_RIGHT, PRESS_DOWN][n % 4] as Buttons;
  return [human, ai];
}

// 第 7 條：撞擊規則與 C-A 相同，共用 C-A 測試的碰撞部分（6 到 9）。
describeSharedSnakeRules({ label: 'C-3 紅藍食物', game: c3Game, makeState }, 'collisions');

describe('C-3 紅藍食物｜TEST_PLAN 第 6 節', () => {
  it('1. 初始：紅、藍各 2 個，不重疊、不在蛇身上；正確顏色是紅；沒有警告', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      const state = c3Game.init(seed, CONFIG);
      expect(state.foods).toHaveLength(4);
      expect(state.foodColors).toHaveLength(4);
      expect(countColor(state, RED)).toBe(2);
      expect(countColor(state, BLUE)).toBe(2);
      expect(new Set(state.foods).size).toBe(4);
      const occupied = new Set([...state.snakes[0].body, ...state.snakes[1].body]);
      for (const food of state.foods) {
        expect(occupied.has(food)).toBe(false);
      }
      expect(state.correct).toBe(RED);
      expect(state.warning).toBe(false);
      expect(c3Game.score(state)).toEqual([0, 0]);
      expect(c3Game.isOver(state)).toBe(false);
    }
  });

  it('2. 吃到正確顏色：加 1 分、長度加 1（紅是正確顏色吃紅、藍是正確顏色吃藍）', () => {
    const red = c3Game.step(eating(RED, { correct: RED }), IDLE);
    expect(c3Game.score(red)).toEqual([1, 0]);
    expect(red.snakes[0].body).toEqual(body([11, 5], [10, 5], [9, 5], [8, 5]));

    const blue = c3Game.step(eating(BLUE, { correct: BLUE }), IDLE);
    expect(c3Game.score(blue)).toEqual([1, 0]);
    expect(blue.snakes[0].body).toHaveLength(4);
  });

  it('3. 吃到錯誤顏色：扣 2 分、長度不變；分數可以是負的，也可以繼續往下扣', () => {
    const wrong = c3Game.step(eating(BLUE, { correct: RED }), IDLE);
    expect(c3Game.score(wrong)).toEqual([-2, 0]);
    expect(wrong.snakes[0].body).toEqual(body([11, 5], [10, 5], [9, 5]));
    expect(c3Game.isOver(wrong)).toBe(false);
    expect(wrong.snakes[0].alive).toBe(true);

    const wrongRed = c3Game.step(eating(RED, { correct: BLUE }), IDLE);
    expect(c3Game.score(wrongRed)).toEqual([-2, 0]);

    // 本來就有分數：1 分吃錯變 −1；−3 分再吃錯變 −5。
    const fromOne = c3Game.step(
      eating(BLUE, {
        correct: RED,
        snakes: [{ body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT, score: 1 }, {}],
      }),
      IDLE,
    );
    expect(c3Game.score(fromOne)).toEqual([-1, 0]);
    const fromNegative = c3Game.step(
      eating(BLUE, {
        correct: RED,
        snakes: [{ body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT, score: -3 }, {}],
      }),
      IDLE,
    );
    expect(c3Game.score(fromNegative)).toEqual([-5, 0]);
  });

  it('4. 吃掉之後補的是同一種顏色，場上維持紅、藍各 2 個（吃對與吃錯都一樣）', () => {
    for (const [eaten, correct] of [
      [RED, RED],
      [RED, BLUE],
      [BLUE, RED],
      [BLUE, BLUE],
    ] as const) {
      const before = eating(eaten, { correct });
      const after = c3Game.step(before, IDLE);
      expect(after.foods).toHaveLength(4);
      expect(countColor(after, RED)).toBe(2);
      expect(countColor(after, BLUE)).toBe(2);
      expect(new Set(after.foods).size).toBe(4);
      // 吃掉的那一格不在場上（被蛇頭佔著），沒被吃的三個食物原封不動、顏色也沒變。
      expect(after.foods).not.toContain(cell(11, 5));
      for (const index of [1, 2, 3]) {
        const at = after.foods.indexOf(before.foods[index] as number);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(after.foodColors[at]).toBe(before.foodColors[index]);
      }
      const occupied = new Set([...after.snakes[0].body, ...after.snakes[1].body]);
      for (const food of after.foods) {
        expect(occupied.has(food)).toBe(false);
      }
    }
  });

  it('4b. 補食物用到亂數：新的 RngState 有寫回 state', () => {
    const before = eating(RED, { correct: RED });
    const after = c3Game.step(before, IDLE);
    expect(after.rng).not.toBe(before.rng);
  });

  it('5. 正確顏色每 480 tick 換一次（第 480、960、1440…個 tick）', () => {
    // 從「上一個 tick」的局面 step 一次，得到「tick = t」的 state；蛇與食物都不會被碰到。
    const correctAt = (t: number, before: 0 | 1): number =>
      c3Game.step(makeState({ tick: t - 1, maxTicks: 100000, correct: before }), IDLE).correct;
    expect(correctAt(479, RED)).toBe(RED);
    expect(correctAt(480, RED)).toBe(BLUE);
    expect(correctAt(481, BLUE)).toBe(BLUE);
    expect(correctAt(959, BLUE)).toBe(BLUE);
    expect(correctAt(960, BLUE)).toBe(RED);
    expect(correctAt(1440, RED)).toBe(BLUE);
  });

  it('5b. 一個 tick 一個 tick 走：正確顏色恰好在第 480、960、1440 個 tick 換', () => {
    let state = makeState({ maxTicks: 100000 });
    const changes: [number, number][] = [];
    let previous = state.correct;
    for (let t = 1; t <= 1500; t += 1) {
      state = c3Game.step(state, loopInputs(t));
      if (state.correct !== previous) {
        changes.push([t, state.correct]);
        previous = state.correct;
      }
    }
    expect(state.over).toBe(false);
    expect(changes).toEqual([
      [480, BLUE],
      [960, RED],
      [1440, BLUE],
    ]);
  });

  it('5c. 換之前 90 tick（每個週期的第 390–479 tick）warning 是 true，其餘是 false', () => {
    const warningAt = (t: number): boolean =>
      c3Game.step(makeState({ tick: t - 1, maxTicks: 100000 }), IDLE).warning;
    expect(warningAt(389)).toBe(false);
    expect(warningAt(390)).toBe(true);
    expect(warningAt(479)).toBe(true);
    expect(warningAt(480)).toBe(false);
    expect(warningAt(481)).toBe(false);
    for (const base of [0, 480, 960]) {
      let count = 0;
      for (let t = base + 1; t <= base + 480; t += 1) {
        if (warningAt(t)) {
          count += 1;
        }
      }
      expect(count).toBe(90);
    }
    expect(warningAt(870)).toBe(true);
    expect(warningAt(869)).toBe(false);
  });

  it('6. 邊界：在換顏色的同一個 tick 吃到食物，用換之前的顏色判定', () => {
    // 第 480 個 tick：正確顏色從紅換成藍。吃紅色的（換之前是對的）：加 1 分、變長。
    const redAtSwap = c3Game.step(eating(RED, { tick: 479, correct: RED }), IDLE);
    expect(redAtSwap.tick).toBe(480);
    expect(c3Game.score(redAtSwap)).toEqual([1, 0]);
    expect(redAtSwap.snakes[0].body).toHaveLength(4);
    expect(redAtSwap.correct).toBe(BLUE);

    // 吃藍色的（換之後才是對的，但判定用換之前的）：扣 2 分、不變長。
    const blueAtSwap = c3Game.step(eating(BLUE, { tick: 479, correct: RED }), IDLE);
    expect(blueAtSwap.tick).toBe(480);
    expect(c3Game.score(blueAtSwap)).toEqual([-2, 0]);
    expect(blueAtSwap.snakes[0].body).toHaveLength(3);
    expect(blueAtSwap.correct).toBe(BLUE);

    // 換回去的那一次（第 960 個 tick，藍換成紅）同理。
    const backAtSwap = c3Game.step(eating(BLUE, { tick: 959, correct: BLUE }), IDLE);
    expect(c3Game.score(backAtSwap)).toEqual([1, 0]);
    expect(backAtSwap.correct).toBe(RED);
  });

  it('6b. 邊界：換色之後的下一次走格（第 486 個 tick）才用新的顏色', () => {
    const after = eating(BLUE, { tick: 485, correct: BLUE });
    const next = c3Game.step(after, IDLE);
    expect(next.tick).toBe(486);
    expect(c3Game.score(next)).toEqual([1, 0]);
    // 換色之前的最後一次走格（第 474 個 tick）仍用舊顏色：藍色是錯的。
    const before = c3Game.step(eating(BLUE, { tick: 473, correct: RED }), IDLE);
    expect(before.tick).toBe(474);
    expect(c3Game.score(before)).toEqual([-2, 0]);
  });

  it('8. 兩條蛇同一個 tick 各吃一個：各自依顏色算分，互不影響', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [
        { body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT },
        { body: body([20, 15], [21, 15], [22, 15]), dir: LEFT },
      ],
      foods: [cell(11, 5), cell(19, 15), cell(3, 20), cell(25, 3)],
      foodColors: [RED, BLUE, RED, BLUE],
      correct: RED,
    });
    const next = c3Game.step(state, IDLE);
    expect(c3Game.score(next)).toEqual([1, -2]);
    expect(next.snakes[0].body).toHaveLength(4);
    expect(next.snakes[1].body).toHaveLength(3);
    expect(countColor(next, RED)).toBe(2);
    expect(countColor(next, BLUE)).toBe(2);
  });

  it('9. 時間到、分數是負的：比大小（−1 贏 −3），同分（−2 對 −2）平手', () => {
    const at = (human: number, ai: number): C3State =>
      c3Game.step(makeState({ tick: 3599, snakes: [{ score: human }, { score: ai }] }), IDLE);
    expect(c3Game.isOver(at(-1, -3))).toBe(true);
    expect(c3Game.winner(at(-1, -3))).toBe(0);
    expect(c3Game.winner(at(-3, -1))).toBe(1);
    expect(c3Game.winner(at(-2, -2))).toBeNull();
    expect(c3Game.winner(at(-2, 0))).toBe(1);
  });

  it('10. 邊界：吃錯的蛇沒有變長，尾巴照常移走：另一條蛇走進那一格不算撞（吃對的話算撞，見共用的 9c）', () => {
    const state = (color: 0 | 1): C3State =>
      makeState({
        tick: BEFORE_MOVE,
        snakes: [
          { body: body([5, 5], [4, 5], [3, 5]), dir: RIGHT },
          { body: body([8, 5], [7, 5], [6, 5]), dir: RIGHT },
        ],
        foods: [cell(9, 5), cell(25, 3), cell(3, 20), cell(25, 20)],
        foodColors: [color, RED, RED, BLUE],
        correct: RED,
      });
    // AI（頭 (8,5)，尾巴 (6,5)）吃錯誤顏色的食物 (9,5)：不變長，尾巴移走；人走進 (6,5) 沒事。
    const wrong = c3Game.step(state(BLUE), IDLE);
    expect(c3Game.score(wrong)).toEqual([0, -2]);
    expect(wrong.snakes[0].alive).toBe(true);
    expect(c3Game.isOver(wrong)).toBe(false);
    // 吃正確顏色：變長，尾巴留著，人走進 (6,5) 就撞死。
    const right = c3Game.step(state(RED), IDLE);
    expect(c3Game.score(right)).toEqual([0, 1]);
    expect(right.snakes[0].alive).toBe(false);
    expect(c3Game.winner(right)).toBe(1);
  });

  it('step 不改動傳進來的 state（吃錯、補食物、換色的那一次，凍結之後照樣能 step）', () => {
    const state = eating(BLUE, { tick: 479, correct: RED });
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
    expect(() => c3Game.step(state, [PRESS_UP, PRESS_DOWN])).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('C-3 紅藍食物｜種子', () => {
  it('隨機事件在不同種子下不全相同：10 個種子的初始食物位置不可以全部一樣', () => {
    const layouts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const state = c3Game.init(seed, CONFIG);
      layouts.add(state.foods.map((food, i) => `${state.foodColors[i]}:${food}`).join(','));
    }
    expect(layouts.size).toBeGreaterThan(1);
  });

  it('補食物的位置由 state 裡的亂數決定：10 個不同的亂數狀態，吃掉之後補的位置不全相同', () => {
    const spots = new Set<number>();
    for (let seed = 0; seed < 10; seed += 1) {
      const after = c3Game.step(
        eating(RED, { correct: RED, rng: rngStateFor(seed, 'food') }),
        IDLE,
      );
      const fresh = after.foods.filter(
        (food) => ![cell(11, 5), cell(20, 20), cell(25, 3), cell(3, 20)].includes(food),
      );
      expect(fresh).toHaveLength(1);
      spots.add(fresh[0] as number);
    }
    expect(spots.size).toBeGreaterThan(1);
  });

  it('同一個種子，初始 state 完全相同', () => {
    expect(c3Game.init(7, CONFIG)).toEqual(c3Game.init(7, CONFIG));
  });

  it('K13 的另一半：不同種子玩完一段，終局 state 不全相同', () => {
    const finals = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      let state = c3Game.init(seed, CONFIG);
      for (let t = 1; t <= 90 && !state.over; t += 1) {
        state = c3Game.step(state, loopInputs(t));
      }
      finals.add(JSON.stringify(state.foods));
    }
    expect(finals.size).toBeGreaterThan(1);
  });
});

describe('C-3 紅藍食物｜actions 與 evaluate', () => {
  it('actions 兩邊都是五個不同的動作；轉向的排序只看正確顏色的食物', () => {
    const state = makeState({
      foods: [cell(5, 3), cell(5, 20), cell(30, 3), cell(30, 20)],
      foodColors: [RED, BLUE, RED, BLUE],
      correct: RED,
    });
    for (const side of [0, 1] as const) {
      const actions = c3Game.actions(state, side);
      expect(actions).toHaveLength(5);
      expect(new Set(actions.map((a) => JSON.stringify(a))).size).toBe(5);
    }
    // 人在 (5,12) 往右。紅色（正確）在正上方 (5,3)，藍色在正下方 (5,20)：往上轉排第一。
    expect(c3Game.actions(state, 0)[0]).toEqual(PRESS_UP);
    // 顏色換了，藍色變成正確的：往下轉排第一。
    expect(c3Game.actions({ ...state, correct: BLUE }, 0)[0]).toEqual(PRESS_DOWN);
  });

  it('gain：距離只算正確顏色的食物（錯誤顏色的食物再近也不算）', () => {
    // 人在 (5,12) 往右，下一步 (6,12)。紅色（正確）在 (20,12)，藍色在 (8,12)（比較近）。
    const state = makeState({
      foods: [cell(20, 12), cell(8, 12), cell(30, 1), cell(30, 22)],
      foodColors: [RED, BLUE, RED, BLUE],
      correct: RED,
    });
    const farBlue = makeState({
      foods: [cell(20, 12), cell(8, 1), cell(30, 1), cell(30, 22)],
      foodColors: [RED, BLUE, RED, BLUE],
      correct: RED,
    });
    // 距離都是 (20,12) 到 (6,12) = 14，藍色的位置不影響 gain。
    expect(c3Game.evaluate(state, 0).gain).toBe(-14);
    expect(c3Game.evaluate(farBlue, 0).gain).toBe(-14);
    // 正確顏色換成藍：最近的正確食物變成 (8,12)，距離 2。
    expect(c3Game.evaluate({ ...state, correct: BLUE }, 0).gain).toBe(-2);
  });

  it('gain：下一步正好是錯誤顏色的食物，扣 200（2 分）；是正確顏色的食物就不扣', () => {
    const base = {
      foods: [cell(6, 12), cell(25, 3), cell(3, 20), cell(25, 20)],
      correct: RED,
    } as const;
    const wrongNext = makeState({ ...base, foodColors: [BLUE, RED, RED, BLUE] });
    const rightNext = makeState({ ...base, foodColors: [RED, RED, BLUE, BLUE] });
    // 兩個局面，最近的正確食物離下一步 (6,12) 的距離不同，所以比較「扣了多少」：
    // 錯誤的情況 = 沒有懲罰時的 gain − 200。
    const withoutPenalty = makeState({
      ...base,
      foods: [cell(7, 20), cell(25, 3), cell(3, 20), cell(25, 20)],
      foodColors: [BLUE, RED, RED, BLUE],
    });
    const wrongGain = c3Game.evaluate(wrongNext, 0).gain;
    const sameDistance = c3Game.evaluate(withoutPenalty, 0).gain;
    expect(sameDistance - wrongGain).toBe(200);
    expect(c3Game.evaluate(rightNext, 0).gain).toBe(0);
  });

  it('gain：多 1 分多 100；負分是負的；永遠是有限的數', () => {
    const base = makeState({});
    const plusOne = makeState({ snakes: [{ score: 1 }, {}] });
    const negative = makeState({ snakes: [{ score: -3 }, {}] });
    expect(c3Game.evaluate(plusOne, 0).gain - c3Game.evaluate(base, 0).gain).toBe(100);
    expect(c3Game.evaluate(negative, 0).gain).toBeLessThan(-299);
    expect(c3Game.evaluate(negative, 1).gain).toBeGreaterThan(250);
    for (const state of [base, plusOne, negative]) {
      for (const side of [0, 1] as const) {
        const { gain, danger } = c3Game.evaluate(state, side);
        expect(Number.isFinite(gain)).toBe(true);
        expect(danger).toBeGreaterThanOrEqual(0);
        expect(danger).toBeLessThanOrEqual(1);
      }
    }
  });

  it('danger：與 C-A 一樣（牆是 1、開闊是 0）；吃錯食物不算 danger', () => {
    const wall = makeState({ snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}] });
    expect(c3Game.evaluate(wall, 0).danger).toBe(1);
    expect(c3Game.evaluate(makeState({}), 0).danger).toBe(0);
    const wrongNext = makeState({
      foods: [cell(6, 12), cell(25, 3), cell(3, 20), cell(25, 20)],
      foodColors: [BLUE, RED, RED, BLUE],
      correct: RED,
    });
    expect(c3Game.evaluate(wrongNext, 0).danger).toBe(0);
  });

  it('局結束：贏的 gain 為正、輸的為負；死掉的 danger 是 1（分數是負的也一樣）', () => {
    const over = c3Game.step(
      makeState({
        tick: BEFORE_MOVE,
        snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT, score: 2 }, { score: -4 }],
      }),
      IDLE,
    );
    expect(c3Game.evaluate(over, 0).danger).toBe(1);
    expect(c3Game.evaluate(over, 1).danger).toBe(0);
    // 贏家是 AI（分數 −4，比人的 2 低）：勝負加成比任何分差都大，所以贏的那邊 gain 為正、輸的為負。
    expect(c3Game.evaluate(over, 1).gain).toBeGreaterThan(0);
    expect(c3Game.evaluate(over, 0).gain).toBeLessThan(0);
  });

  it('局結束的排序：「分差 10 但自己撞死」的 gain 比「落後 5 但活著贏」低', () => {
    const diedAhead = makeState({
      over: true,
      winner: 1,
      snakes: [{ alive: false, score: 10 }, { score: 0 }],
    });
    const wonBehind = makeState({
      over: true,
      winner: 0,
      snakes: [{ score: 0 }, { alive: false, score: 5 }],
    });
    expect(c3Game.evaluate(wonBehind, 0).gain).toBeGreaterThan(c3Game.evaluate(diedAhead, 0).gain);
  });
});

describe('C-3 紅藍食物｜畫面', () => {
  it('render：紅色食物與藍色食物用不同的顏色畫出來；全部在 320×240 之內；只用色盤', () => {
    const fake = createFakeContext();
    c3Render(
      asRenderingContext(fake),
      makeState({
        foods: [cell(15, 3), cell(15, 20), cell(20, 3), cell(20, 20)],
        foodColors: [RED, RED, BLUE, BLUE],
      }),
    );
    const used = fake.colors.filter((c) => c.via === 'set').map((c) => String(c.value));
    expect(used).toContain(COLOR.hearts);
    expect(used).toContain(COLOR.spades);
    for (const p of fake.points) {
      expect(p.x).toBeGreaterThanOrEqual(-8);
      expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
      expect(p.y).toBeGreaterThanOrEqual(-8);
      expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
    }
  });

  it('render：警告時指示燈閃爍（亮與暗的 tick 畫出的顏色不同），沒有警告時不閃', () => {
    const colorsAt = (tick: number): string[] => {
      const fake = createFakeContext();
      c3Render(asRenderingContext(fake), makeState({ tick }));
      return fake.colors.map((c) => String(c.value));
    };
    expect(colorsAt(400)).not.toEqual(colorsAt(410));
    expect(colorsAt(100)).toEqual(colorsAt(110));
  });

  it('render 不改 state（凍結之後照樣能畫）', () => {
    const state = makeState({ tick: 400 });
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
    expect(() => c3Render(asRenderingContext(createFakeContext()), state)).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
});
