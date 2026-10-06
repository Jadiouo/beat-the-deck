import { describe, expect, it } from 'vitest';

import type { Buttons, Inputs } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { cell, cellX, cellY, DOWN, LEFT, MOVE_EVERY, RIGHT, UP } from '../_clubs/logic';
import {
  describeSharedSnakeAi,
  describeSharedSnakeRules,
} from '../_clubs/shared-rules.test-helpers';
import { c2Game, makeState } from './logic';
import type { C2State } from './logic';
import { c2Render } from './render';

/**
 * C-2 旋轉的房間的規則測試（TEST_PLAN 第 6 節 C-2 的 5 條）。
 * 第 1 條「C-A 的 11 條全部成立」由 `_clubs/shared-rules.test-helpers.ts` 的同一組測試跑；
 * 這個檔案是 2 到 5 條，與旋轉的邊界情況。全部用 `makeState` 直接構造局面。
 */

const CONFIG = { maxTicks: 3600, params: {} };

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_UP: Buttons = { ...NONE, up: true };
const PRESS_DOWN: Buttons = { ...NONE, down: true };
const IDLE: Inputs = [NONE, NONE];

const ROTATIONS = [0, 1, 2, 3] as const;

function body(...points: [number, number][]): number[] {
  return points.map(([x, y]) => cell(x, y));
}

/** 不會撞到任何東西的局面，tick 是 `tick`：兩條蛇都在中間、直直走很遠才到牆。 */
function calm(tick: number, overrides: Partial<Parameters<typeof makeState>[0]> = {}): C2State {
  return makeState({ tick, maxTicks: 100000, ...overrides });
}

const suite = { label: 'C-2 旋轉的房間', game: c2Game, makeState };

// 第 1 條：C-A 的 11 條（與邊界情況、種子）在這張牌上全部成立，共用同一組測試。
describeSharedSnakeRules(suite);
describeSharedSnakeAi(suite);

describe('C-2 旋轉的房間｜TEST_PLAN 第 6 節', () => {
  it('初始：viewRotation 是 0、warning 是 false', () => {
    const state = c2Game.init(0, CONFIG);
    expect(state.viewRotation).toBe(0);
    expect(state.warning).toBe(false);
    expect(state.tick).toBe(0);
  });

  it('2. viewRotation：0–599 是 0、600–1199 是 1、1200–1799 是 2、1800–2399 是 3、每 2400 tick 循環', () => {
    // 從「上一個 tick」的局面 step 一次，得到「tick = t」的 state。
    const at = (t: number): number => c2Game.step(calm(t - 1), IDLE).viewRotation;
    expect([1, 2, 300, 599].map(at)).toEqual([0, 0, 0, 0]);
    expect([600, 601, 900, 1199].map(at)).toEqual([1, 1, 1, 1]);
    expect([1200, 1500, 1799].map(at)).toEqual([2, 2, 2]);
    expect([1800, 2100, 2399].map(at)).toEqual([3, 3, 3]);
    expect([2400, 2401, 2999].map(at)).toEqual([0, 0, 0]);
    expect([3000, 3599].map(at)).toEqual([1, 1]);
    expect([4800, 5400, 6000, 7199, 7200].map(at)).toEqual([0, 1, 2, 3, 0]);
  });

  it('2b. 用 step 一個 tick 一個 tick 走：viewRotation 只在第 600、1200、1800、2400 個 tick 變', () => {
    let state = calm(0);
    const changes: [number, number][] = [];
    let previous = state.viewRotation;
    for (let t = 1; t <= 2500; t += 1) {
      state = c2Game.step(state, IDLE);
      expect(state.tick).toBe(t);
      if (state.viewRotation !== previous) {
        changes.push([t, state.viewRotation]);
        previous = state.viewRotation;
      }
      if (state.over) {
        break;
      }
    }
    expect(state.over).toBe(false);
    expect(changes).toEqual([
      [600, 1],
      [1200, 2],
      [1800, 3],
      [2400, 0],
    ]);
  });

  it('3. 旋轉前 60 tick（每個週期的第 540–599 tick）warning 是 true，其餘是 false', () => {
    const warningAt = (t: number): boolean => c2Game.step(calm(t - 1), IDLE).warning;
    expect(warningAt(539)).toBe(false);
    expect(warningAt(540)).toBe(true);
    expect(warningAt(599)).toBe(true);
    expect(warningAt(600)).toBe(false);
    expect(warningAt(601)).toBe(false);
    // 每個週期恰好 60 個 tick 是 true。
    for (const base of [0, 600, 1200, 1800, 2400]) {
      let count = 0;
      for (let t = base + 1; t <= base + 600; t += 1) {
        if (warningAt(t)) {
          count += 1;
        }
      }
      expect(count).toBe(60);
    }
    expect(warningAt(1139)).toBe(false);
    expect(warningAt(1140)).toBe(true);
    expect(warningAt(2399)).toBe(true);
    expect(warningAt(2400)).toBe(false);
  });

  it('4. 給 step 的輸入是世界方向：不管 viewRotation 是多少，輸入「上」蛇就往世界的上走', () => {
    for (const viewRotation of ROTATIONS) {
      let state = calm(0, { viewRotation });
      state = c2Game.step(state, [PRESS_UP, NONE]);
      for (let i = 1; i < MOVE_EVERY; i += 1) {
        state = c2Game.step(state, IDLE);
      }
      const head = state.snakes[0].body[0] as number;
      expect([cellX(head), cellY(head)]).toEqual([5, 11]);
      expect(state.snakes[0].dir).toBe(UP);
      expect(state.viewRotation).toBe(viewRotation);
    }
    // 往下也一樣（原本往右，按下 = 世界的下）。
    for (const viewRotation of ROTATIONS) {
      const state = c2Game.step(calm(0, { viewRotation }), [PRESS_DOWN, NONE]);
      expect(state.snakes[0].turn).toBe(DOWN);
    }
  });

  it('4b. 四種 viewRotation 下，同一串輸入走出來的蛇與食物完全相同（只差 viewRotation 與 warning 兩個欄位）', () => {
    const inputs: Inputs[] = [];
    for (let t = 0; t < 120; t += 1) {
      inputs.push(t % 30 === 0 ? [PRESS_UP, PRESS_DOWN] : IDLE);
    }
    const results = ROTATIONS.map((viewRotation) => {
      let state = calm(0, { viewRotation, warning: viewRotation % 2 === 1 });
      for (const input of inputs) {
        state = c2Game.step(state, input);
      }
      const { snakes, foods, rng, over, winner } = state;
      return JSON.stringify({ snakes, foods, rng, over, winner });
    });
    expect(new Set(results).size).toBe(1);
  });

  it('5. AI 的 evaluate 與 actions 不受 viewRotation（與 warning）影響', () => {
    const states: C2State[] = [
      makeState({}),
      makeState({ foods: [cell(5, 3), cell(30, 20)] }),
      makeState({ snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}] }),
      makeState({
        snakes: [
          { body: body([5, 5], [4, 5], [3, 5]), dir: RIGHT, score: 2 },
          { body: body([6, 6], [6, 5], [6, 4]), dir: DOWN },
        ],
      }),
      makeState({
        snakes: [{ body: body([10, 10], [9, 10], [8, 10]), dir: RIGHT, turn: UP }, {}],
      }),
    ];
    for (const base of states) {
      for (const side of [0, 1] as const) {
        const expectedEval = c2Game.evaluate({ ...base, viewRotation: 0, warning: false }, side);
        const expectedActions = c2Game.actions({ ...base, viewRotation: 0, warning: false }, side);
        for (const viewRotation of ROTATIONS) {
          for (const warning of [false, true]) {
            const variant: C2State = { ...base, viewRotation, warning };
            expect(c2Game.evaluate(variant, side)).toEqual(expectedEval);
            expect(c2Game.actions(variant, side)).toEqual(expectedActions);
          }
        }
      }
    }
  });
});

describe('C-2 旋轉的房間｜同一個 tick 發生兩件事、剛好在門檻上', () => {
  it('邊界：第 600 個 tick 既是旋轉的 tick、也是走格的 tick：撞牆照樣死，旋轉照樣記下', () => {
    const state = makeState({
      tick: 599,
      snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}],
    });
    const next = c2Game.step(state, IDLE);
    expect(next.tick).toBe(600);
    expect(c2Game.isOver(next)).toBe(true);
    expect(c2Game.winner(next)).toBe(1);
    expect(next.snakes[0].alive).toBe(false);
    expect(next.viewRotation).toBe(1);
    expect(next.warning).toBe(false);
  });

  it('邊界：旋轉的那個 tick 吃到食物：照常得分、長度加 1（旋轉不改任何規則）', () => {
    const state = makeState({
      tick: 599,
      snakes: [{ body: body([10, 5], [9, 5], [8, 5]), dir: RIGHT }, {}],
      foods: [cell(11, 5), cell(20, 20)],
    });
    const next = c2Game.step(state, IDLE);
    expect(c2Game.score(next)).toEqual([1, 0]);
    expect(next.snakes[0].body).toHaveLength(4);
    expect(next.viewRotation).toBe(1);
  });

  it('邊界：maxTicks = 600 的短局：第 600 個 tick 時間到結束，viewRotation 是 1', () => {
    let state = makeState({ maxTicks: 600, foods: [cell(0, 0), cell(0, 23)], tick: 598 });
    state = c2Game.step(state, IDLE);
    expect(c2Game.isOver(state)).toBe(false);
    state = c2Game.step(state, IDLE);
    expect(c2Game.isOver(state)).toBe(true);
    expect(state.viewRotation).toBe(1);
    // 結束之後 step 原樣不動。
    expect(c2Game.step(state, [PRESS_UP, PRESS_DOWN])).toBe(state);
  });

  it('邊界：第 2400 個 tick 轉回 0（一整圈）', () => {
    const next = c2Game.step(calm(2399, { viewRotation: 3, warning: true }), IDLE);
    expect(next.viewRotation).toBe(0);
    expect(next.warning).toBe(false);
  });
});

describe('C-2 旋轉的房間｜state 與畫面', () => {
  it('state 可以 JSON 來回，viewRotation 與 warning 都是純資料', () => {
    const state = calm(560);
    const copy = JSON.parse(JSON.stringify(state)) as C2State;
    expect(copy).toEqual(state);
    expect(copy.viewRotation).toBe(0);
    expect(copy.warning).toBe(true);
  });

  it('render：viewRotation 是 0 時不旋轉，是 1、2、3 時畫面轉 90、180、270 度，而且都畫在 320×240 之內', () => {
    for (const viewRotation of ROTATIONS) {
      const fake = createFakeContext();
      c2Render(asRenderingContext(fake), calm(viewRotation * 600, { viewRotation }));
      expect(fake.calls.includes('rotate')).toBe(viewRotation !== 0);
      for (const p of fake.points) {
        expect(p.x).toBeGreaterThanOrEqual(-8);
        expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
        expect(p.y).toBeGreaterThanOrEqual(-8);
        expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
      }
    }
  });

  it('render：warning 時邊框閃爍（亮與暗的 tick 畫出來的東西不同），沒有 warning 時不閃', () => {
    const draw = (state: C2State): string[] => {
      const fake = createFakeContext();
      c2Render(asRenderingContext(fake), state);
      return fake.points.map((p) => `${p.method}:${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    };
    const on = draw(calm(540));
    const off = draw(calm(550));
    expect(on).not.toEqual(off);
    // 沒有警告時，相差 10 個 tick 畫面不變（兩條蛇都沒動）。
    expect(draw(calm(100))).toEqual(draw(calm(110)));
  });

  it('render 不改 state（凍結之後照樣能畫）', () => {
    const state = calm(560, { viewRotation: 1 });
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
    expect(() => c2Render(asRenderingContext(createFakeContext()), state)).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
});

// 輸入永遠是世界方向，AI 那一側（往左走）也一樣。
describe('C-2 旋轉的房間｜AI 那一側也是世界方向', () => {
  it('AI（往左走）在任何 viewRotation 下按「上」都是世界的上', () => {
    for (const viewRotation of ROTATIONS) {
      let state = calm(0, { viewRotation });
      state = c2Game.step(state, [NONE, PRESS_UP]);
      for (let i = 1; i < MOVE_EVERY; i += 1) {
        state = c2Game.step(state, IDLE);
      }
      expect(state.snakes[1].dir).toBe(UP);
      expect(state.snakes[1].dir).not.toBe(LEFT);
    }
  });
});
