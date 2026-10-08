import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import type { Buttons, Inputs } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { deepFreeze } from '../../../tests/contract/freeze';
import { COLOR } from '../../shell/palette';
import { cell, cellX, cellY, DOWN, HEIGHT, LEFT, RIGHT, UP, WIDTH } from '../_clubs/logic';
import {
  c7Game,
  createC7Game,
  FOOD_COUNT,
  FOOD_GAIN,
  makeState,
  MIN_MAX_TICKS,
  SHRINK_EVERY,
  SPRINT_CD,
  SPRINT_COST,
  SPRINT_MIN_LEN,
  START_LENGTH,
  startBody,
} from './logic';
import type { C7State } from './logic';
import { c7Render } from './render';

/**
 * C-7 縮水的規則測試（小規格 `docs/cards/C-7.md`「量測計畫與先寫的測試」）。
 * 全部用 `makeState` 直接構造局面。預設局面：人 (9,12) 往右、AI (22,11) 往左，各 16 格，食物 (15,3) 與 (15,20)。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const SPRINT: Buttons = { ...NONE, a: true };
const PRESS_UP: Buttons = { ...NONE, up: true };
const PRESS_DOWN: Buttons = { ...NONE, down: true };
const IDLE: Inputs = [NONE, NONE];

function body(...points: [number, number][]): number[] {
  return points.map(([x, y]) => cell(x, y));
}

/** 從 (x, y) 往左排 `length` 格的直線身體（蛇頭在最右邊）。 */
function rowLeft(x: number, y: number, length: number): number[] {
  return Array.from({ length }, (_, i) => cell(x - i, y));
}

/** 單獨的一步；`tick` 是步之前的 tick。 */
function stepAt(state: C7State, inputs: Inputs = IDLE): C7State {
  return c7Game.step(state, inputs);
}

/** 讓人在走格那一步（tick 5 → 6）的局面：人往右，頭 (10,10)，身體 `length` 格。 */
function humanAt(length: number, extra: Partial<Parameters<typeof makeState>[0]> = {}): C7State {
  return makeState({
    tick: 5,
    snakes: [{ body: rowLeft(10, 10, length), dir: RIGHT }, {}],
    ...extra,
  });
}

// ---------------------------------------------------------------------------

describe('C-7 縮水｜常數', () => {
  it('常數是小規格的值（K=2、起始 16、每 40 tick 縮一格、吃一顆 +5、衝刺花 2 冷卻 30 長度至少 5）', () => {
    expect(FOOD_COUNT).toBe(2);
    expect(START_LENGTH).toBe(16);
    expect(SHRINK_EVERY).toBe(40);
    expect(FOOD_GAIN).toBe(5);
    expect(SPRINT_COST).toBe(2);
    expect(SPRINT_CD).toBe(30);
    expect(SPRINT_MIN_LEN).toBe(5);
  });
});

describe('C-7 縮水｜初始', () => {
  it('開局：兩條蛇各 16 格、身體相連且在地圖內、互不重疊、180 度對稱；兩顆食物；沒有冷卻、沒人餓死', () => {
    const state = c7Game.init(3, CONFIG);
    expect(state.snakes[0].body).toHaveLength(START_LENGTH);
    expect(state.snakes[1].body).toHaveLength(START_LENGTH);
    expect(state.snakes[0].score).toBe(START_LENGTH);
    for (const snake of state.snakes) {
      for (let i = 1; i < snake.body.length; i += 1) {
        const a = snake.body[i - 1] as number;
        const b = snake.body[i] as number;
        expect(Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b))).toBe(1);
      }
      for (const c of snake.body) {
        expect(cellX(c)).toBeGreaterThanOrEqual(0);
        expect(cellX(c)).toBeLessThan(WIDTH);
        expect(cellY(c)).toBeLessThan(HEIGHT);
      }
    }
    const all = [...state.snakes[0].body, ...state.snakes[1].body];
    expect(new Set(all).size).toBe(all.length);
    expect(state.snakes[1].body).toEqual(state.snakes[0].body.map((c) => WIDTH * HEIGHT - 1 - c));
    expect(state.snakes[0].dir).toBe(RIGHT);
    expect(state.snakes[1].dir).toBe(LEFT);
    expect(state.foods).toHaveLength(FOOD_COUNT);
    expect(new Set(state.foods).size).toBe(FOOD_COUNT);
    for (const f of state.foods) {
      expect(all).not.toContain(f);
    }
    expect(state.sprintCd).toEqual([0, 0]);
    expect(state.sprints).toEqual([0, 0]);
    expect(state.starved).toEqual([false, false]);
    expect(state.maxTicks).toBe(3600);
  });

  it('startBody：長度 3 到 20 都相連、都從 (9,12) 開始', () => {
    for (let n = 3; n <= 20; n += 1) {
      const b = startBody(0, n);
      expect(b).toHaveLength(n);
      expect(b[0]).toBe(cell(9, 12));
    }
  });

  it('食物位置隨種子變（種子 0 到 9 不全相同）；同一個種子 init 兩次完全相同；maxTicks 太小丟 RangeError', () => {
    const foods = new Set(
      Array.from({ length: 10 }, (_, s) => JSON.stringify(c7Game.init(s, CONFIG).foods)),
    );
    expect(foods.size).toBeGreaterThan(1);
    expect(c7Game.init(5, CONFIG)).toEqual(c7Game.init(5, CONFIG));
    expect(() => c7Game.init(0, { maxTicks: MIN_MAX_TICKS - 1, params: {} })).toThrow(RangeError);
  });
});

describe('C-7 縮水｜縮水', () => {
  it('恰在 tick % 40 === 0 縮：39 → 40 兩邊各少一格，38 → 39 不縮', () => {
    const at39 = stepAt(makeState({ tick: 38 }));
    expect(at39.snakes[0].body).toHaveLength(START_LENGTH);
    const at40 = stepAt(makeState({ tick: 39 }));
    expect(at40.tick).toBe(40);
    expect(at40.snakes[0].body).toHaveLength(START_LENGTH - 1);
    expect(at40.snakes[1].body).toHaveLength(START_LENGTH - 1);
    expect(at40.snakes[0].score).toBe(START_LENGTH - 1);
  });

  it('縮的是尾端（頭不動）', () => {
    const before = makeState({ tick: 39 });
    const after = stepAt(before);
    expect(after.snakes[0].body).toEqual(before.snakes[0].body.slice(0, -1));
  });

  it('長度 1 縮到 0：那條蛇餓死，另一條贏（不看長度）', () => {
    const state = makeState({
      tick: 39,
      snakes: [{ body: body([10, 10]), dir: RIGHT }, {}],
    });
    const after = stepAt(state);
    expect(after.over).toBe(true);
    expect(after.starved).toEqual([true, false]);
    expect(after.snakes[0].alive).toBe(false);
    expect(after.winner).toBe(1);
  });

  it('兩條同一個 tick 餓死：長度都是 0，平手', () => {
    const state = makeState({
      tick: 39,
      snakes: [{ body: body([10, 10]), dir: RIGHT }, { body: body([20, 10]), dir: LEFT }],
    });
    const after = stepAt(state);
    expect(after.starved).toEqual([true, true]);
    expect(after.winner).toBeNull();
  });

  it('同一個 tick 走格又縮水：先走格再縮水，長度 1 的蛇這一格吃到食物不會餓死（淨 +4）', () => {
    const state = makeState({
      tick: 119,
      snakes: [{ body: body([10, 10]), dir: RIGHT }, {}],
      foods: [cell(11, 10), cell(15, 20)],
    });
    const after = stepAt(state);
    expect(after.over).toBe(false);
    expect(after.starved).toEqual([false, false]);
    expect(after.snakes[0].body).toHaveLength(1 + FOOD_GAIN - 1);
  });
});

describe('C-7 縮水｜吃食物', () => {
  it('吃到食物長 5 格（吃到的那次走格不縮尾，所以淨 +5），分數等於長度，補到 2 顆', () => {
    const state = humanAt(8, { foods: [cell(11, 10), cell(15, 20)] });
    const after = stepAt(state);
    expect(after.snakes[0].body).toHaveLength(8 + FOOD_GAIN);
    expect(after.snakes[0].score).toBe(8 + FOOD_GAIN);
    expect(after.snakes[0].body[0]).toBe(cell(11, 10));
    expect(after.foods).toHaveLength(FOOD_COUNT);
    expect(after.foods).not.toContain(cell(11, 10));
  });

  it('場上永遠 2 顆：整局亂按（種子 0 到 4），沒結束的每個 tick 都是 2 顆，不重疊、不在蛇身上', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      let state = c7Game.init(seed, CONFIG);
      let t = 0;
      while (!state.over && t < 1500) {
        const press = [NONE, PRESS_UP, PRESS_DOWN, SPRINT][(t >> 3) % 4] as Buttons;
        state = stepAt(state, [press, t % 70 < 35 ? press : NONE]);
        t += 1;
        if (!state.over) {
          expect(state.foods).toHaveLength(FOOD_COUNT);
          expect(new Set(state.foods).size).toBe(FOOD_COUNT);
          const occupied = new Set([...state.snakes[0].body, ...state.snakes[1].body]);
          for (const f of state.foods) {
            expect(occupied.has(f)).toBe(false);
          }
        }
      }
    }
  });

  it('foodCount 旋鈕：1 顆與 3 顆（消融用）', () => {
    expect(createC7Game({ foodCount: 1 }).init(0, CONFIG).foods).toHaveLength(1);
    expect(createC7Game({ foodCount: 3 }).init(0, CONFIG).foods).toHaveLength(3);
  });
});

describe('C-7 縮水｜衝刺', () => {
  it('按住 a、冷卻 0、長度夠：這一次走格連走兩格，長度 −2，冷卻 30，累計 1 次', () => {
    const after = stepAt(humanAt(10), [SPRINT, NONE]);
    expect(after.snakes[0].body[0]).toBe(cell(12, 10));
    expect(after.snakes[0].body[1]).toBe(cell(11, 10));
    expect(after.snakes[0].body).toHaveLength(10 - SPRINT_COST);
    expect(after.snakes[0].score).toBe(10 - SPRINT_COST);
    expect(after.sprintCd[0]).toBe(SPRINT_CD);
    expect(after.sprints).toEqual([1, 0]);
    // 對手沒按 a：只走一格。
    expect(after.snakes[1].body[0]).toBe(cell(21, 11));
  });

  it('沒按 a 就只走一格', () => {
    const after = stepAt(humanAt(10));
    expect(after.snakes[0].body[0]).toBe(cell(11, 10));
    expect(after.sprints).toEqual([0, 0]);
  });

  it('長度 < 5 按 a 沒有效果；長度剛好 5 可以（衝完剩 3）', () => {
    const short = stepAt(humanAt(4), [SPRINT, NONE]);
    expect(short.snakes[0].body[0]).toBe(cell(11, 10));
    expect(short.snakes[0].body).toHaveLength(4);
    expect(short.sprints[0]).toBe(0);
    const exact = stepAt(humanAt(5), [SPRINT, NONE]);
    expect(exact.snakes[0].body[0]).toBe(cell(12, 10));
    expect(exact.snakes[0].body).toHaveLength(3);
  });

  it('冷卻中按 a 沒有效果：冷卻 2 還不行，冷卻 1（下一步就歸零）可以', () => {
    const cooling = stepAt(humanAt(10, { sprintCd: [2, 0] }), [SPRINT, NONE]);
    expect(cooling.snakes[0].body[0]).toBe(cell(11, 10));
    expect(cooling.sprintCd[0]).toBe(1);
    const ready = stepAt(humanAt(10, { sprintCd: [1, 0] }), [SPRINT, NONE]);
    expect(ready.snakes[0].body[0]).toBe(cell(12, 10));
  });

  it('衝完 30 個 tick 之後可以再衝（冷卻每 tick 減 1）', () => {
    let state = stepAt(humanAt(14), [SPRINT, NONE]);
    expect(state.sprintCd[0]).toBe(30);
    state = { ...state, snakes: [{ ...state.snakes[0], body: rowLeft(10, 10, 12) }, state.snakes[1]] };
    for (let i = 0; i < 29; i += 1) {
      state = stepAt(state);
    }
    expect(state.sprintCd[0]).toBe(1);
  });

  it('兩格都沿著這個週期鎖定的方向：轉向只在第一格套用，第二格直走', () => {
    const locked = stepAt(humanAt(10, { tick: 4 }), [PRESS_UP, NONE]);
    const after = stepAt(stepAt(locked, [PRESS_UP, NONE]), [SPRINT, NONE]);
    expect(after.snakes[0].body[0]).toBe(cell(10, 8));
    expect(after.snakes[0].body[1]).toBe(cell(10, 9));
  });

  it('中間那格有食物也吃到：+5，然後走第二格，再付 2 格成本', () => {
    const after = stepAt(humanAt(10, { foods: [cell(11, 10), cell(15, 20)] }), [SPRINT, NONE]);
    expect(after.snakes[0].body[0]).toBe(cell(12, 10));
    expect(after.snakes[0].body).toHaveLength(10 + FOOD_GAIN - SPRINT_COST);
    expect(after.foods).not.toContain(cell(11, 10));
    expect(after.foods).toHaveLength(FOOD_COUNT);
  });

  it('第二格有食物也吃到', () => {
    const after = stepAt(humanAt(10, { foods: [cell(12, 10), cell(15, 20)] }), [SPRINT, NONE]);
    expect(after.snakes[0].body).toHaveLength(10 + FOOD_GAIN - SPRINT_COST);
  });

  it('中間那格撞到對手身體：死在原地（還在第一格之前），對手贏', () => {
    const state = humanAt(10, {
      snakes: [{ body: rowLeft(10, 10, 10), dir: RIGHT }, { body: body([11, 10], [11, 9], [11, 8], [11, 7]), dir: UP }],
    });
    const after = stepAt(state, [SPRINT, NONE]);
    expect(after.over).toBe(true);
    expect(after.snakes[0].alive).toBe(false);
    expect(after.winner).toBe(1);
  });

  it('第二格撞到身體：死，另一條贏，不看長度', () => {
    const state = humanAt(10, {
      snakes: [{ body: rowLeft(10, 10, 10), dir: RIGHT }, { body: body([12, 10], [12, 9], [12, 8], [12, 7]), dir: UP }],
    });
    const after = stepAt(state, [SPRINT, NONE]);
    expect(after.over).toBe(true);
    expect(after.snakes[0].alive).toBe(false);
    expect(after.winner).toBe(1);
  });

  it('第二格走出地圖：死', () => {
    const state = makeState({
      tick: 5,
      snakes: [{ body: rowLeft(30, 10, 10), dir: RIGHT }, {}],
    });
    const after = stepAt(state, [SPRINT, NONE]);
    expect(after.snakes[0].alive).toBe(false);
    expect(after.winner).toBe(1);
  });

  it('兩條同一格頭對頭：兩條都死，比長度（長的贏，同長平手）', () => {
    const base = {
      tick: 5,
    };
    const longer = makeState({
      ...base,
      snakes: [
        { body: rowLeft(14, 10, 12), dir: RIGHT },
        { body: [cell(16, 10), ...rowLeft(17, 11, 6).slice(0, 0), cell(17, 10), cell(18, 10), cell(19, 10)], dir: LEFT },
      ],
    });
    const out = stepAt(longer);
    expect(out.snakes[0].alive).toBe(false);
    expect(out.snakes[1].alive).toBe(false);
    expect(out.winner).toBe(0);
    const equal = makeState({
      ...base,
      snakes: [
        { body: rowLeft(14, 10, 4), dir: RIGHT },
        { body: body([16, 10], [17, 10], [18, 10], [19, 10]), dir: LEFT },
      ],
    });
    expect(stepAt(equal).winner).toBeNull();
  });

  it('衝刺關掉（消融）：按 a 沒效果，actions 也沒有帶 a 的動作', () => {
    const off = createC7Game({ sprint: false });
    const state = humanAt(10);
    const after = off.step(state, [SPRINT, NONE]);
    expect(after.snakes[0].body[0]).toBe(cell(11, 10));
    expect(off.actions(state, 0).some((b) => b.a)).toBe(false);
    expect(c7Game.actions(state, 0).some((b) => b.a)).toBe(true);
  });
});

describe('C-7 縮水｜勝負', () => {
  it('score 恆等於蛇身長度（亂按整局，每個 tick 都檢查；餓死的是 0）', () => {
    let state = c7Game.init(4, CONFIG);
    let t = 0;
    while (!state.over && t < 1200) {
      state = stepAt(state, [t % 50 < 25 ? SPRINT : PRESS_DOWN, t % 90 < 45 ? PRESS_UP : SPRINT]);
      t += 1;
      for (const i of [0, 1] as const) {
        const snake = state.snakes[i];
        expect(snake.score).toBe(state.starved[i] ? 0 : snake.body.length);
      }
    }
    expect(t).toBeGreaterThan(30);
  });

  it('時間到：沒人死，長度長的贏；同長平手', () => {
    const base = makeState({
      tick: 59,
      maxTicks: 60,
      snakes: [{ body: rowLeft(14, 12, 20), dir: RIGHT }, {}],
    });
    expect(stepAt(base).over).toBe(true);
    expect(stepAt(base).winner).toBe(0);
    const tie = makeState({ tick: 59, maxTicks: 60 });
    expect(stepAt(tie).winner).toBeNull();
  });

  it('死亡優先於時間到：最後一個 tick 才撞死的人輸，即使長度比較長', () => {
    const state = makeState({
      tick: 5,
      maxTicks: 6,
      snakes: [{ body: rowLeft(31, 10, 25), dir: RIGHT }, {}],
    });
    const after = stepAt(state);
    expect(after.snakes[0].alive).toBe(false);
    expect(after.winner).toBe(1);
  });

  it('已結束的 state：step 原樣回傳', () => {
    const done = makeState({ over: true, winner: 0 });
    expect(stepAt(done)).toBe(done);
  });
});

describe('C-7 縮水｜actions 與 evaluate', () => {
  it('沒有鎖定轉向、衝刺可用：兩個轉向、全放開，各自不帶 a 在前、帶 a 在後，共 6 個', () => {
    const acts = c7Game.actions(makeState(), 0);
    expect(acts).toHaveLength(6);
    expect(acts.slice(0, 3).every((b) => !b.a)).toBe(true);
    expect(acts.slice(3).every((b) => b.a)).toBe(true);
    expect(acts[2]).toEqual(NONE);
  });

  it('已鎖定轉向：全放開、全放開＋a；冷卻中或太短只有全放開；結束只有全放開', () => {
    const locked = makeState({ snakes: [{ turn: UP, dir: RIGHT }, {}] });
    expect(c7Game.actions(locked, 0)).toEqual([NONE, SPRINT]);
    const cooling = makeState({ sprintCd: [5, 0] });
    expect(c7Game.actions(cooling, 0).some((b) => b.a)).toBe(false);
    const short = makeState({ snakes: [{ body: rowLeft(9, 12, 4), dir: RIGHT }, {}] });
    expect(c7Game.actions(short, 0).some((b) => b.a)).toBe(false);
    expect(c7Game.actions(makeState({ over: true }), 0)).toEqual([NONE]);
  });

  it('actions 的第一個動作會推進世界（排在前面的是轉向，不是不動）', () => {
    const acts = c7Game.actions(makeState(), 0);
    const first = acts[0] as Buttons;
    expect(first.up || first.down || first.left || first.right).toBe(true);
  });

  it('沒有領先者懲罰：長度差每多 1 格，gain 剛好多 100（其他不變）', () => {
    const a = makeState({ snakes: [{ body: rowLeft(9, 12, 12), dir: RIGHT }, {}] });
    const b = makeState({ snakes: [{ body: rowLeft(9, 12, 14), dir: RIGHT }, {}] });
    const diff = c7Game.evaluate(b, 0).gain - c7Game.evaluate(a, 0).gain;
    expect(diff).toBeCloseTo(200, 6);
    const lead = c7Game.evaluate(b, 0).gain - c7Game.evaluate(b, 1).gain;
    expect(lead).toBeGreaterThan(0);
  });

  it('對稱：同一個局面轉 180 度，兩邊的 evaluate 互換', () => {
    const state = c7Game.init(7, CONFIG);
    const e0 = c7Game.evaluate(state, 0);
    const mirrored: C7State = {
      ...state,
      snakes: [state.snakes[1], state.snakes[0]],
      foods: state.foods.map((c) => WIDTH * HEIGHT - 1 - c),
      sprintCd: [state.sprintCd[1], state.sprintCd[0]],
      sprints: [state.sprints[1], state.sprints[0]],
      starved: [state.starved[1], state.starved[0]],
    };
    const rotated: C7State = {
      ...mirrored,
      snakes: [
        { ...mirrored.snakes[0], body: mirrored.snakes[0].body.map((c) => WIDTH * HEIGHT - 1 - c), dir: ((mirrored.snakes[0].dir + 2) % 4) as 0 },
        { ...mirrored.snakes[1], body: mirrored.snakes[1].body.map((c) => WIDTH * HEIGHT - 1 - c), dir: ((mirrored.snakes[1].dir + 2) % 4) as 0 },
      ],
    };
    const r = c7Game.evaluate({ ...rotated, snakes: [{ ...rotated.snakes[0], turn: rotated.snakes[0].dir }, { ...rotated.snakes[1], turn: rotated.snakes[1].dir }] }, 0);
    expect(r.gain).toBeCloseTo(e0.gain, 6);
    expect(r.danger).toBeCloseTo(e0.danger, 6);
  });

  it('餓死風險：長度 2、最近的食物來不及走到 → danger 1；食物就在旁邊 → danger < 1；長度夠長 → 這一項是 0', () => {
    const far = makeState({
      tick: 0,
      snakes: [{ body: body([5, 12], [4, 12]), dir: RIGHT }, {}],
      foods: [cell(28, 20), cell(30, 2)],
    });
    expect(c7Game.evaluate(far, 0).danger).toBe(1);
    const near = makeState({
      snakes: [{ body: body([5, 12], [4, 12]), dir: RIGHT }, {}],
      foods: [cell(7, 12), cell(30, 2)],
    });
    expect(c7Game.evaluate(near, 0).danger).toBeLessThan(1);
    const fine = makeState({ foods: [cell(28, 20), cell(30, 2)] });
    expect(c7Game.evaluate(fine, 0).danger).toBe(0);
  });

  it('已結束的局：贏的 gain 很大、輸的很小；自己死了 danger 是 1', () => {
    const won = makeState({
      over: true,
      winner: 0,
      snakes: [{}, { alive: false }],
    });
    expect(c7Game.evaluate(won, 0).gain).toBeGreaterThan(100_000);
    expect(c7Game.evaluate(won, 1).gain).toBeLessThan(-100_000);
    expect(c7Game.evaluate(won, 1).danger).toBe(1);
  });
});

describe('C-7 縮水｜AI 對衝刺的決定（搜尋型等級 10，在走格前的最後一個 tick 決定）', () => {
  function decideSprint(state: C7State): boolean {
    const controller = levelController(c7Game, pathfinder, 10, 1);
    // 餵幾個 tick 讓反應延遲的歷史有東西。
    let s = state;
    let result: Buttons = NONE;
    for (let i = 0; i < 13; i += 1) {
      result = controller.decide(s, 1, s.tick);
    }
    return result.a;
  }

  it('沒有人跟它搶的食物（對手遠遠落後）：不白衝', () => {
    const state = makeState({
      tick: 5,
      snakes: [{ body: rowLeft(3, 20, 12), dir: RIGHT }, { body: [cell(20, 10), cell(21, 10), cell(22, 10), cell(23, 10), cell(24, 10), cell(25, 10)], dir: LEFT }],
      foods: [cell(17, 10), cell(3, 2)],
    });
    expect(decideSprint(state)).toBe(false);
  });

  it('剛好同時到、衝刺能先到的食物：衝', () => {
    const state = makeState({
      tick: 5,
      snakes: [
        { body: [cell(12, 10), cell(11, 10), cell(10, 10), cell(9, 10), cell(8, 10), cell(7, 10), cell(6, 10), cell(5, 10)], dir: RIGHT },
        { body: [cell(20, 10), cell(21, 10), cell(22, 10), cell(23, 10), cell(24, 10), cell(25, 10), cell(26, 10), cell(27, 10)], dir: LEFT },
      ],
      foods: [cell(16, 10), cell(3, 2)],
    });
    expect(decideSprint(state)).toBe(true);
  });
});

describe('C-7 縮水｜純度與契約', () => {
  it('step 不改動傳進來的 state（深度凍結後整局亂按，含衝刺、縮水、吃食物）', () => {
    let state = deepFreeze(c7Game.init(2, CONFIG));
    for (let t = 0; t < 400 && !state.over; t += 1) {
      state = deepFreeze(stepAt(state, [t % 30 < 15 ? SPRINT : PRESS_DOWN, t % 40 < 20 ? PRESS_UP : SPRINT]));
    }
    expect(state.tick).toBeGreaterThan(0);
  });

  it('state 可序列化：JSON 來回之後一樣，大小不隨 tick 成長', () => {
    let state = c7Game.init(1, CONFIG);
    const sizes: number[] = [];
    for (let t = 0; t < 600 && !state.over; t += 1) {
      state = stepAt(state, [t % 60 < 30 ? PRESS_DOWN : PRESS_UP, NONE]);
      if (t % 100 === 0) {
        sizes.push(JSON.stringify(state).length);
      }
    }
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(Math.max(...sizes)).toBeLessThan(Math.min(...sizes) * 2 + 300);
  });
});

describe('C-7 縮水｜畫面', () => {
  it('只用色盤顏色、全部在 320×240 之內、不改 state；兩條長度條與衝刺冷卻的小點畫得出來', () => {
    const state = deepFreeze(
      makeState({ tick: 100, sprintCd: [0, 18], snakes: [{ body: rowLeft(10, 10, 12), dir: RIGHT }, {}] }),
    );
    const before = JSON.stringify(state);
    const fake = createFakeContext();
    c7Render(asRenderingContext(fake), state);
    expect(JSON.stringify(state)).toBe(before);
    const used = fake.colors.filter((c) => c.via === 'set').map((c) => String(c.value));
    expect(used).toContain(COLOR.clubs);
    expect(used).toContain(COLOR.accent);
    expect(used).toContain(COLOR.warning);
    for (const p of fake.points) {
      expect(p.x).toBeGreaterThanOrEqual(-8);
      expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
      expect(p.y).toBeGreaterThanOrEqual(-8);
      expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
    }
  });

  it('結束後（有人餓死）也畫得出來，不丟錯', () => {
    const over = makeState({ over: true, winner: 1, starved: [true, false], snakes: [{ alive: false, body: body([10, 10]), score: 0 }, {}] });
    const fake = createFakeContext();
    expect(() => c7Render(asRenderingContext(fake), over)).not.toThrow();
    void DOWN;
  });
});
