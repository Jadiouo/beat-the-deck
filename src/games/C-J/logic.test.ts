import { describe, expect, it } from 'vitest';

import { levelController, policyByName } from '../../ai/level';
import { copyButtons } from '../../core/match';
import type { Buttons, Inputs } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { COLOR } from '../../shell/palette';
import { cell, cellX, cellY, DOWN, LEFT, MOVE_EVERY, RIGHT, UP } from '../_clubs/logic';
import {
  cJGame,
  COOLDOWN_TICKS,
  FOODS_PER_ROUND,
  GRACE_TICKS,
  makeState,
  MIN_FOOD_GAP,
  FOOD_MARGIN,
  PAUSE_TICKS,
  pathMoves,
  PREVIEW_TICKS,
  RESPAWN_TICKS,
  RIPEN_TICKS,
  SAFE_RADIUS,
  SLACK_MOVES,
  START_MARGIN,
} from './logic';
import type { CJState } from './logic';
import { cJRender } from './render';

/**
 * C-J 關卡設計師的規則測試（小規格 `docs/cards/C-J.md`）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 預設局面：第 0 局（0 號邊是蛇、1 號邊是設計師）、`roundTick` 0、蛇頭 (8,12) 往右、長度 3，
 * 第一個食物 (22,12) 現身（時限用公式）、沒有牆、冷卻 0。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_UP: Buttons = { ...NONE, up: true };
const PRESS_RIGHT: Buttons = { ...NONE, right: true };
const PRESS_DOWN: Buttons = { ...NONE, down: true };
const PRESS_LEFT: Buttons = { ...NONE, left: true };
const IDLE: Inputs = [NONE, NONE];

/** 預設局面裡：0 號邊是蛇、1 號邊是設計師；`designer(button)` 組出只有設計師按鍵的輸入。 */
function designer(button: Buttons): Inputs {
  return [NONE, button];
}

/** 讓「下一次 step」剛好是走格的那一次（`roundTick` 加 1 之後是 6 的倍數）。 */
const BEFORE_MOVE = MOVE_EVERY - 1;

function body(...points: [number, number][]): number[] {
  return points.map(([x, y]) => cell(x, y));
}

function run(state: CJState, count: number, inputs: Inputs = IDLE): CJState {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = cJGame.step(current, inputs);
  }
  return current;
}

function deepFreeze(value: unknown): void {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
  }
}

function headOf(state: CJState): [number, number] {
  const at = state.snakes[state.snakeSide].body[0] as number;
  return [cellX(at), cellY(at)];
}

/** 預設食物 (22,12) 的右側牆：中心 (24,12)、三格寬。 */
const RIGHT_WALL = body([24, 11], [24, 12], [24, 13]);
const LEFT_WALL = body([20, 11], [20, 12], [20, 13]);
const UP_WALL = body([21, 10], [22, 10], [23, 10]);
const DOWN_WALL = body([21, 14], [22, 14], [23, 14]);

describe('C-J 關卡設計師｜初始與一局的結構', () => {
  it('1. 初始：第 0 局、0 號邊是蛇（長度 3）、1 號邊是設計師（沒有身體）；第一個食物在預覽；沒有牆；分數 0', () => {
    const state = cJGame.init(0, CONFIG);
    expect(state.round).toBe(0);
    expect(state.snakeSide).toBe(0);
    expect(state.snakes[0].body).toHaveLength(3);
    expect(state.snakes[1].body).toEqual([]);
    expect(state.foodSeq).toHaveLength(FOODS_PER_ROUND);
    expect(state.foodIndex).toBe(0);
    expect(state.phase).toBe('preview');
    expect(state.phaseLeft).toBe(PREVIEW_TICKS);
    expect(state.foods).toEqual([]);
    expect(state.walls).toEqual([]);
    expect(state.cooldown).toBe(0);
    expect(state.roundTick).toBe(-GRACE_TICKS);
    expect(cJGame.score(state)).toEqual([0, 0]);
    expect(cJGame.isOver(state)).toBe(false);
    expect(cJGame.winner(state)).toBeNull();
    expect(state.outcome).toBeNull();
  });

  it('2. 食物序列：離上一個（第一個離蛇頭）至少 MIN_FOOD_GAP 格、離地圖邊至少 FOOD_MARGIN 格；蛇頭離牆至少 START_MARGIN（30 個種子）', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const state = cJGame.init(seed, CONFIG);
      const start = state.snakes[0].body[0] as number;
      expect(
        Math.min(cellX(start), 31 - cellX(start), cellY(start), 23 - cellY(start)),
      ).toBeGreaterThanOrEqual(START_MARGIN);
      let previous = start;
      for (const food of state.foodSeq) {
        expect(
          Math.min(cellX(food), 31 - cellX(food), cellY(food), 23 - cellY(food)),
        ).toBeGreaterThanOrEqual(FOOD_MARGIN);
        expect(
          Math.abs(cellX(food) - cellX(previous)) + Math.abs(cellY(food) - cellY(previous)),
        ).toBeGreaterThanOrEqual(MIN_FOOD_GAP);
        previous = food;
      }
    }
  });

  it('3. 預覽：第一個食物開局 30 個 tick 之後再過 15 個 tick 才現身；現身前蛇走進那一格不算吃到', () => {
    let state = makeState({
      roundTick: -GRACE_TICKS,
      phase: 'preview',
      phaseLeft: PREVIEW_TICKS,
      snake: { body: body([21, 12], [20, 12], [19, 12]), dir: RIGHT },
    });
    expect(state.foods).toEqual([]);
    // 預覽期間蛇頭走進食物那一格：沒有分數、蛇沒變長
    const probe = makeState({
      roundTick: BEFORE_MOVE,
      phase: 'preview',
      phaseLeft: 20,
      snake: { body: body([21, 12], [20, 12], [19, 12]), dir: RIGHT },
    });
    const walked = cJGame.step(probe, IDLE);
    expect(headOf(walked)).toEqual([22, 12]);
    expect(walked.snakes[0].body).toHaveLength(3);
    expect(walked.snakes[0].score).toBe(0);
    expect(walked.eaten).toBe(0);
    // 預覽走完（PREVIEW_TICKS 個 tick）那一刻現身
    state = run(state, PREVIEW_TICKS - 1);
    expect(state.phase).toBe('preview');
    expect(state.foods).toEqual([]);
    state = cJGame.step(state, IDLE);
    expect(state.phase).toBe('live');
    expect(state.foods).toEqual([state.foodSeq[0]]);
    expect(state.roundTick).toBe(-GRACE_TICKS + PREVIEW_TICKS);
  });

  it('4. 現身的時限＝ MOVE_EVERY × (蛇頭到食物的曼哈頓距離 + SLACK_MOVES)；邊界：預覽剩 1 個 tick 時走一步就現身', () => {
    const state = makeState({
      roundTick: 0,
      phase: 'preview',
      phaseLeft: 1,
      snake: { body: body([8, 12], [7, 12], [6, 12]), dir: RIGHT },
    });
    const live = cJGame.step(state, IDLE);
    expect(live.phase).toBe('live');
    const distance = Math.abs(8 - 22) + Math.abs(12 - 12);
    expect(live.phaseLeft).toBe(MOVE_EVERY * (distance + SLACK_MOVES));
    // 現身那一刻蛇頭在哪就從哪量
    const moving = makeState({
      roundTick: BEFORE_MOVE,
      phase: 'preview',
      phaseLeft: 1,
      snake: { body: body([8, 12], [7, 12], [6, 12]), dir: RIGHT },
    });
    const after = cJGame.step(moving, IDLE);
    expect(headOf(after)).toEqual([9, 12]);
    expect(after.phaseLeft).toBe(MOVE_EVERY * (13 + SLACK_MOVES));
  });
});

describe('C-J 關卡設計師｜吃到與時限', () => {
  it('5. 蛇吃到現身的食物：蛇的分數加 1、長度加 1、牆全部消失、下一個食物進入預覽', () => {
    const state = makeState({
      roundTick: BEFORE_MOVE,
      snake: { body: body([21, 12], [20, 12], [19, 12]), dir: RIGHT },
      walls: [{ side: UP, cells: UP_WALL, ripe: 10 }],
      cooldown: 17,
    });
    const next = cJGame.step(state, IDLE);
    expect(headOf(next)).toEqual([22, 12]);
    expect(next.snakes[0].body).toHaveLength(4);
    expect(next.snakes[0].score).toBe(1);
    expect(next.eaten).toBe(1);
    expect(next.foodIndex).toBe(1);
    expect(next.phase).toBe('preview');
    expect(next.phaseLeft).toBe(PREVIEW_TICKS);
    expect(next.foods).toEqual([]);
    expect(next.walls).toEqual([]);
    expect(next.snakes[1].score).toBe(0);
  });

  it('6. 時限到了還沒吃到：設計師的分數加 1、牆全部消失、下一個食物進入預覽；蛇的分數不變', () => {
    const state = makeState({
      roundTick: 10,
      phaseLeft: 1,
      walls: [{ side: UP, cells: UP_WALL, ripe: 0 }],
    });
    const next = cJGame.step(state, IDLE);
    expect(next.snakes[1].score).toBe(1);
    expect(next.snakes[0].score).toBe(0);
    expect(next.lost).toBe(1);
    expect(next.foodIndex).toBe(1);
    expect(next.phase).toBe('preview');
    expect(next.walls).toEqual([]);
    expect(next.foods).toEqual([]);
  });

  it('7. 邊界：時限剩 1 個 tick、而且這個 tick 蛇剛好走進食物：算蛇吃到（吃到優先於時限）', () => {
    const state = makeState({
      roundTick: BEFORE_MOVE,
      phaseLeft: 1,
      snake: { body: body([21, 12], [20, 12], [19, 12]), dir: RIGHT },
    });
    const next = cJGame.step(state, IDLE);
    expect(next.snakes[0].score).toBe(1);
    expect(next.snakes[1].score).toBe(0);
    expect(next.eaten).toBe(1);
    expect(next.lost).toBe(0);
  });

  it('8. 這一局的最後一個食物結算：一局結束（finished），畫面停住；蛇吃到加設計師拿到合計 FOODS_PER_ROUND', () => {
    const state = makeState({
      roundTick: BEFORE_MOVE,
      foodSeq: [...makeState().foodSeq.slice(0, FOODS_PER_ROUND - 1), cell(22, 12)],
      foodIndex: FOODS_PER_ROUND - 1,
      eaten: 6,
      lost: 3,
      scores: [6, 3],
      snake: { body: body([21, 12], [20, 12], [19, 12]), dir: RIGHT },
    });
    const next = cJGame.step(state, IDLE);
    expect(next.outcome).toBe('finished');
    expect(next.eaten + next.lost).toBe(FOODS_PER_ROUND);
    expect(next.pause).toBe(PAUSE_TICKS);
    expect(cJGame.score(next)).toEqual([7, 3]);
    expect(cJGame.isOver(next)).toBe(false);
    // 停頓期間蛇不動、設計師按什麼都沒用
    const paused = run(next, 5, [PRESS_RIGHT, PRESS_UP]);
    expect(paused.snakes[0].body).toEqual(next.snakes[0].body);
    expect(paused.walls).toEqual([]);
  });
});

describe('C-J 關卡設計師｜牆', () => {
  it('9. 設計師按方向鍵：在食物那一側蓋一面三格寬的牆（右側中心 (24,12)），預告 RIPEN_TICKS，冷卻 COOLDOWN_TICKS', () => {
    const state = makeState({ roundTick: 2 });
    const right = cJGame.step(state, designer(PRESS_RIGHT));
    expect(right.walls).toEqual([{ side: RIGHT, cells: RIGHT_WALL, ripe: RIPEN_TICKS }]);
    expect(right.cooldown).toBe(COOLDOWN_TICKS);
    const left = cJGame.step(state, designer(PRESS_LEFT));
    expect(left.walls[0]?.cells).toEqual(LEFT_WALL);
    expect(cJGame.step(state, designer(PRESS_UP)).walls[0]?.cells).toEqual(UP_WALL);
    expect(cJGame.step(state, designer(PRESS_DOWN)).walls[0]?.cells).toEqual(DOWN_WALL);
    // 預覽期間也可以蓋
    const preview = makeState({ roundTick: -10, phase: 'preview', phaseLeft: 30 });
    expect(cJGame.step(preview, designer(PRESS_RIGHT)).walls).toHaveLength(1);
  });

  it('10. 預告中的牆：蛇可以走過去；剩下的 tick 每個 tick 減 1，到 0 才變硬', () => {
    let state = cJGame.step(makeState({ roundTick: 2 }), designer(PRESS_RIGHT));
    state = run(state, RIPEN_TICKS - 1);
    expect(state.walls[0]?.ripe).toBe(1);
    state = cJGame.step(state, IDLE);
    expect(state.walls[0]?.ripe).toBe(0);
    // 預告中：蛇頭走進牆的格子沒事
    const ghost = makeState({
      roundTick: BEFORE_MOVE,
      snake: { body: body([23, 12], [22, 12], [21, 12]), dir: RIGHT },
      foodSeq: [cell(15, 3), ...makeState().foodSeq.slice(1)],
      walls: [{ side: RIGHT, cells: RIGHT_WALL, ripe: 20 }],
    });
    const through = cJGame.step(ghost, IDLE);
    expect(through.snakes[0].alive).toBe(true);
    expect(headOf(through)).toEqual([24, 12]);
  });

  it('11. 變硬的牆：蛇撞上就死；這個食物算設計師的，蛇停在原地等重生，下一個食物預覽 RESPAWN_TICKS 個 tick，牆全部消失', () => {
    const state = makeState({
      roundTick: BEFORE_MOVE,
      foodIndex: 2,
      eaten: 1,
      lost: 1,
      scores: [1, 1],
      snake: { body: body([23, 12], [22, 12], [21, 12]), dir: RIGHT },
      walls: [{ side: RIGHT, cells: RIGHT_WALL, ripe: 0 }],
      foodSeq: [cell(22, 12), cell(5, 5), cell(15, 3), ...makeState().foodSeq.slice(3)],
      phaseLeft: 100,
    });
    const next = cJGame.step(state, IDLE);
    expect(next.snakes[0].alive).toBe(false);
    expect(next.snakes[0].body).toEqual(state.snakes[0].body);
    expect(next.outcome).toBeNull();
    expect(next.snakes[1].score).toBe(2);
    expect(next.snakes[0].score).toBe(1);
    expect(next.lost).toBe(2);
    expect(next.crashes).toBe(1);
    expect(next.foodIndex).toBe(3);
    expect(next.phase).toBe('preview');
    expect(next.phaseLeft).toBe(RESPAWN_TICKS);
    expect(next.walls).toEqual([]);
    expect(next.foods).toEqual([]);
  });

  it('12. 變硬的那一刻蛇身壓著的格子不算牆（留洞）：蛇不會被夾死', () => {
    const state = makeState({
      roundTick: 2,
      snake: { body: body([24, 12], [23, 12], [22, 12]), dir: RIGHT },
      foodSeq: [cell(15, 3), ...makeState().foodSeq.slice(1)],
      walls: [{ side: RIGHT, cells: RIGHT_WALL, ripe: 1 }],
    });
    const next = cJGame.step(state, IDLE);
    expect(next.walls[0]?.ripe).toBe(0);
    expect(next.walls[0]?.cells).toEqual(body([24, 11], [24, 13]));
  });

  it('13. 冷卻：蓋完之後 COOLDOWN_TICKS − 1 個 tick 內再按沒有效果；第 COOLDOWN_TICKS 個 tick 才能再蓋（不同的一側）', () => {
    let state = cJGame.step(makeState({ roundTick: 2 }), designer(PRESS_RIGHT));
    state = run(state, COOLDOWN_TICKS - 1, designer(PRESS_UP));
    expect(state.walls).toHaveLength(1);
    expect(state.cooldown).toBe(1);
    state = cJGame.step(state, designer(PRESS_UP));
    expect(state.walls.map((w) => w.side)).toEqual([RIGHT, UP]);
    expect(state.cooldown).toBe(COOLDOWN_TICKS);
  });

  it('14. 邊界：牆離蛇頭 SAFE_RADIUS 格（曼哈頓）以內不能蓋，SAFE_RADIUS + 1 格可以', () => {
    // 食物 (22,12) 的左側牆是 x = 20、y = 11..13。蛇頭在 (20 - 3, 12) → 離牆最近的格子 (20,12) 剛好 3 格。
    const near = makeState({
      roundTick: 2,
      snake: { body: body([17, 12], [16, 12], [15, 12]), dir: RIGHT },
    });
    expect(Math.abs(20 - 17)).toBe(SAFE_RADIUS);
    expect(cJGame.step(near, designer(PRESS_LEFT)).walls).toEqual([]);
    expect(cJGame.actions(near, 1).some((a) => a.left)).toBe(false);
    const far = makeState({
      roundTick: 2,
      snake: { body: body([16, 12], [15, 12], [14, 12]), dir: RIGHT },
    });
    expect(cJGame.step(far, designer(PRESS_LEFT)).walls).toHaveLength(1);
    expect(cJGame.actions(far, 1).some((a) => a.left)).toBe(true);
  });

  it('15. 邊界：同一側已經有牆就不能再蓋；牆的中心走出地圖的那一側不能蓋（動作也不列出）', () => {
    const state = makeState({
      roundTick: 2,
      walls: [{ side: RIGHT, cells: RIGHT_WALL, ripe: 30 }],
    });
    expect(cJGame.step(state, designer(PRESS_RIGHT)).walls).toHaveLength(1);
    expect(cJGame.actions(state, 1).some((a) => a.right)).toBe(false);
    // 食物在 (29,12)：右側牆的中心 x = 31，在地圖內（最外圈）；食物在 (30,12) 時 x = 32 走出地圖
    const edge = makeState({
      roundTick: 2,
      foodSeq: [cell(30, 12), ...makeState().foodSeq.slice(1)],
    });
    expect(cJGame.step(edge, designer(PRESS_RIGHT)).walls).toEqual([]);
    expect(cJGame.actions(edge, 1).some((a) => a.right)).toBe(false);
    const inside = makeState({
      roundTick: 2,
      foodSeq: [cell(29, 12), ...makeState().foodSeq.slice(1)],
    });
    expect(cJGame.step(inside, designer(PRESS_RIGHT)).walls).toHaveLength(1);
  });

  it('16. 邊界：永遠留一條路——三面牆之後第四面（把食物整個封死）不能蓋', () => {
    const state = makeState({
      roundTick: 2,
      walls: [
        { side: UP, cells: UP_WALL, ripe: 0 },
        { side: RIGHT, cells: RIGHT_WALL, ripe: 0 },
        { side: DOWN, cells: DOWN_WALL, ripe: 0 },
      ],
    });
    expect(cJGame.step(state, designer(PRESS_LEFT)).walls).toHaveLength(3);
    expect(cJGame.actions(state, 1).some((a) => a.left)).toBe(false);
    // 只有兩面牆時，第三面可以蓋
    const two = makeState({
      roundTick: 2,
      walls: [
        { side: UP, cells: UP_WALL, ripe: 0 },
        { side: RIGHT, cells: RIGHT_WALL, ripe: 0 },
      ],
    });
    expect(cJGame.step(two, designer(PRESS_DOWN)).walls).toHaveLength(3);
  });

  it('17. 輸入只管自己的角色：蛇那一邊按牆的方向鍵只會轉向、設計師那一邊按方向鍵不會讓蛇轉向', () => {
    const state = makeState({ roundTick: 2 });
    const bySnake = cJGame.step(state, [PRESS_UP, NONE]);
    expect(bySnake.walls).toEqual([]);
    expect(bySnake.snakes[0].turn).toBe(UP);
    const byDesigner = cJGame.step(state, [NONE, PRESS_UP]);
    expect(byDesigner.snakes[0].turn).toBe(RIGHT);
    expect(byDesigner.walls).toHaveLength(1);
  });
});

describe('C-J 關卡設計師｜蛇的死亡、計時、兩局交換', () => {
  it('18. 蛇走出地圖或撞自己：和撞硬牆一樣——這個食物算設計師的，蛇停在原地等重生', () => {
    const wall = makeState({
      roundTick: BEFORE_MOVE,
      snake: { body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT },
      phaseLeft: 100,
    });
    const hit = cJGame.step(wall, IDLE);
    expect(hit.snakes[0].alive).toBe(false);
    expect(hit.snakes[1].score).toBe(1);
    expect(hit.crashes).toBe(1);
    const self = makeState({
      roundTick: BEFORE_MOVE,
      snake: { body: body([10, 10], [10, 11], [11, 11], [11, 10], [11, 9]), dir: UP, turn: RIGHT },
      phaseLeft: 100,
    });
    const bit = cJGame.step(self, IDLE);
    expect(bit.snakes[0].alive).toBe(false);
    expect(bit.crashes).toBe(1);
    // 邊界：走進自己的尾巴（這一格會移走）不算撞
    const tail = makeState({
      roundTick: BEFORE_MOVE,
      snake: { body: body([10, 10], [10, 11], [11, 11], [11, 10]), dir: UP, turn: RIGHT },
      phaseLeft: 100,
    });
    expect(cJGame.step(tail, IDLE).snakes[0].alive).toBe(true);
  });

  it('18b. 重生：等 RESPAWN_TICKS 個 tick 之後蛇在這一局的起始位置重生（長度 3、分數保留），下一個食物現身、時限用重生位置算', () => {
    const first = cJGame.init(5, CONFIG);
    const crashing: CJState = {
      ...first,
      roundTick: BEFORE_MOVE,
      phase: 'live',
      phaseLeft: 200,
      snakes: [
        {
          body: body([31, 5], [30, 5], [29, 5], [28, 5]),
          dir: RIGHT,
          turn: RIGHT,
          alive: true,
          score: 3,
        },
        first.snakes[1],
      ],
    };
    let state = cJGame.step(crashing, IDLE);
    expect(state.snakes[0].alive).toBe(false);
    state = run(state, RESPAWN_TICKS - 1);
    expect(state.snakes[0].alive).toBe(false);
    expect(state.phase).toBe('preview');
    state = cJGame.step(state, IDLE);
    expect(state.snakes[0].alive).toBe(true);
    expect(state.snakes[0].body).toHaveLength(3);
    expect(state.snakes[0].body[0]).toBe(first.layout.head);
    expect(state.snakes[0].dir).toBe(first.layout.dir);
    expect(state.snakes[0].score).toBe(3);
    expect(state.phase).toBe('live');
    const food = state.foodSeq[state.foodIndex] as number;
    const head = first.layout.head;
    const distance = Math.abs(cellX(head) - cellX(food)) + Math.abs(cellY(head) - cellY(food));
    expect(state.phaseLeft).toBe(MOVE_EVERY * (distance + SLACK_MOVES));
    expect(state.foods).toEqual([food]);
  });

  it('18c. 邊界：最後一個食物的時候撞死：這個食物算設計師的，這一局結束（finished），不再重生；等重生的時候牆不能蓋在重生位置附近', () => {
    const last = makeState({
      roundTick: BEFORE_MOVE,
      foodIndex: FOODS_PER_ROUND - 1,
      eaten: 6,
      lost: 3,
      scores: [6, 3],
      snake: { body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT },
      phaseLeft: 100,
    });
    const ended = cJGame.step(last, IDLE);
    expect(ended.outcome).toBe('finished');
    expect(ended.eaten + ended.lost).toBe(FOODS_PER_ROUND);
    expect(cJGame.score(ended)).toEqual([6, 4]);
    // 重生位置是 (8,12)：食物 (22,12) 的左側牆 (20,11..13) 離它 12 格，可以蓋；食物 (10,12) 的左側牆 (8,11..13) 壓在重生位置上，不行
    const waiting = makeState({
      roundTick: 20,
      phase: 'preview',
      phaseLeft: 30,
      snake: { body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT, alive: false },
    });
    expect(cJGame.step(waiting, designer(PRESS_LEFT)).walls).toHaveLength(1);
    const onSpawn = makeState({
      roundTick: 20,
      phase: 'preview',
      phaseLeft: 30,
      foodSeq: [cell(10, 12), ...makeState().foodSeq.slice(1)],
      snake: { body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT, alive: false },
    });
    expect(cJGame.step(onSpawn, designer(PRESS_LEFT)).walls).toEqual([]);
    expect(cJGame.actions(onSpawn, 1).some((a) => a.left)).toBe(false);
  });

  it('19. 邊界：開局不動的 tick 內蛇不走（即使正對著牆也不會死）；之後每 MOVE_EVERY 個 tick 走一格', () => {
    let state = makeState({
      roundTick: -GRACE_TICKS,
      phase: 'preview',
      phaseLeft: PREVIEW_TICKS,
      snake: { body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT },
    });
    state = run(state, GRACE_TICKS);
    expect(state.snakes[0].alive).toBe(true);
    expect(headOf(state)).toEqual([31, 5]);
    const open = makeState({ roundTick: 0 });
    expect(headOf(run(open, MOVE_EVERY - 1))).toEqual([8, 12]);
    expect(headOf(run(open, MOVE_EVERY))).toEqual([9, 12]);
  });

  it('20. 邊界：一局最多 roundTicks 個 tick；到了還沒結算完：timeout，沒結算的食物不算任何人', () => {
    const state = makeState({
      roundTick: makeState().roundTicks - 1,
      phaseLeft: 100,
      scores: [2, 3],
      eaten: 2,
      lost: 3,
      foodIndex: 5,
    });
    const next = cJGame.step(state, IDLE);
    expect(next.outcome).toBe('timeout');
    expect(cJGame.score(next)).toEqual([2, 3]);
    expect(next.pause).toBe(PAUSE_TICKS);
  });

  it('21. 停頓走完：第 1 局開始，角色交換（1 號邊是蛇），分數保留，蛇與食物是第 0 局轉 180 度', () => {
    const first = cJGame.init(5, CONFIG);
    const ended: CJState = {
      ...first,
      round: 0,
      roundTick: 100,
      outcome: 'finished',
      pause: 1,
      eaten: 6,
      lost: 4,
      snakes: [
        { ...first.snakes[0], score: 6 },
        { ...first.snakes[1], score: 4 },
      ],
    };
    const next = cJGame.step(ended, IDLE);
    expect(next.round).toBe(1);
    expect(next.snakeSide).toBe(1);
    expect(next.pause).toBe(0);
    expect(next.outcome).toBeNull();
    expect(next.eaten).toBe(0);
    expect(next.lost).toBe(0);
    expect(next.roundTick).toBe(-GRACE_TICKS);
    expect(cJGame.score(next)).toEqual([6, 4]);
    expect(next.snakes[0].body).toEqual([]);
    const startHead = first.snakes[0].body[0] as number;
    const rotated = next.snakes[1].body[0] as number;
    expect([cellX(rotated), cellY(rotated)]).toEqual([
      31 - cellX(startHead),
      23 - cellY(startHead),
    ]);
    expect(next.snakes[1].dir).toBe(((first.snakes[0].dir + 2) % 4) as 0 | 1 | 2 | 3);
    expect(next.foodSeq).toEqual(first.foodSeq.map((food) => 32 * 24 - 1 - food));
    expect(next.phase).toBe('preview');
    expect(next.walls).toEqual([]);
  });

  it('22. 第 1 局結束就是整場結束：總分高的贏、同分平手；結束之後 step 不再改變 state', () => {
    const fillers = makeState({ round: 1 }).foodSeq.slice(0, FOODS_PER_ROUND - 1);
    // 第 1 局：1 號邊是蛇；最後一個食物剛好被吃到，吃到之後兩邊的總分是 `scores`
    const finish = (scores: [number, number]): CJState =>
      cJGame.step(
        makeState({
          round: 1,
          roundTick: BEFORE_MOVE,
          foodSeq: [...fillers, cell(11, 12)],
          foodIndex: FOODS_PER_ROUND - 1,
          eaten: 5,
          lost: 4,
          scores: [scores[0], scores[1] - 1],
          snake: { body: body([10, 12], [9, 12], [8, 12]), dir: RIGHT },
        }),
        IDLE,
      );
    const won = finish([4, 7]);
    expect(won.round).toBe(1);
    expect(won.over).toBe(true);
    expect(cJGame.isOver(won)).toBe(true);
    expect(cJGame.winner(won)).toBe(1);
    expect(cJGame.score(won)).toEqual([4, 7]);
    const tied = finish([6, 6]);
    expect(tied.over).toBe(true);
    expect(cJGame.winner(tied)).toBeNull();
    const lost = finish([9, 2]);
    expect(cJGame.winner(lost)).toBe(0);
    expect(cJGame.step(lost, [PRESS_UP, PRESS_DOWN])).toBe(lost);
  });
});

describe('C-J 關卡設計師｜隨機', () => {
  it('23. 隨機事件在不同種子下不全相同：10 個種子的蛇起始位置、方向與食物序列都不可以全部一樣；連續兩個食物不同', () => {
    const states = Array.from({ length: 10 }, (_, seed) => cJGame.init(seed, CONFIG));
    expect(new Set(states.map((s) => s.snakes[0].body[0])).size).toBeGreaterThan(1);
    expect(new Set(states.map((s) => s.snakes[0].dir)).size).toBeGreaterThan(1);
    expect(new Set(states.map((s) => s.foodSeq[0])).size).toBeGreaterThan(1);
    expect(new Set(states.map((s) => s.foodSeq.join(','))).size).toBeGreaterThan(5);
    for (const state of states) {
      expect(new Set(state.foodSeq).size).toBeGreaterThan(5);
      expect(state.foodSeq[0]).not.toBe(state.foodSeq[1]);
      // 抽完的亂數狀態有寫回 state（同一個種子一樣、不同種子不同）
    }
    expect(JSON.stringify(states[0]?.rng)).not.toBe(JSON.stringify(states[1]?.rng));
  });

  it('24. 同一個種子，初始 state 完全相同', () => {
    expect(cJGame.init(7, CONFIG)).toEqual(cJGame.init(7, CONFIG));
  });
});

describe('C-J 關卡設計師｜actions 與 evaluate', () => {
  it('25. 設計師的 actions：冷卻中只有「全放開」；冷卻結束「全放開」排第一，後面是蓋得下去的方向', () => {
    const cooling = makeState({ roundTick: 2, cooldown: 5 });
    expect(cJGame.actions(cooling, 1)).toEqual([NONE]);
    const ready = cJGame.actions(makeState({ roundTick: 2 }), 1);
    expect(ready[0]).toEqual(NONE);
    expect(ready).toHaveLength(5);
    // 蛇從左邊來，食物左側（面對蛇的那一側）的方向排在最前面
    expect(ready[1]).toEqual(PRESS_LEFT);
    // 局結束與停頓：只有「全放開」
    expect(cJGame.actions(makeState({ pause: 10, outcome: 'finished' }), 1)).toEqual([NONE]);
    expect(cJGame.actions(makeState({ over: true }), 1)).toEqual([NONE]);
  });

  it('26. 蛇的 actions：還沒鎖定轉向時三個（兩個轉向與全放開，較靠近食物那一側的轉向在前）；已鎖定、局結束時只有「全放開」', () => {
    const state = makeState({
      roundTick: 2,
      snake: { body: body([8, 12], [7, 12], [6, 12]), dir: RIGHT },
      foodSeq: [cell(10, 3), ...makeState().foodSeq.slice(1)],
    });
    const actions = cJGame.actions(state, 0);
    expect(actions).toHaveLength(3);
    expect(actions[0]).toEqual(PRESS_UP);
    expect(actions[2]).toEqual(NONE);
    const locked = cJGame.step(state, [PRESS_UP, NONE]);
    expect(cJGame.actions(locked, 0)).toEqual([NONE]);
    expect(cJGame.actions(makeState({ over: true }), 0)).toEqual([NONE]);
    expect(cJGame.actions(makeState({ pause: 3, outcome: 'timeout' }), 0)).toEqual([NONE]);
  });

  it('27. pathMoves：預告中的牆「蛇到達那一格時已經變硬」才算障礙；來不及變硬的牆不影響最短路', () => {
    // 蛇頭 (14,12)，食物 (22,12)，右側牆 x = 24 不在路上；左側牆 x = 20 擋在路上。
    const snake = { body: body([14, 12], [13, 12], [12, 12]), dir: RIGHT } as const;
    const open = makeState({ roundTick: 2, snake });
    expect(pathMoves(open)).toBe(8);
    // 左牆 ripe 100：走到那一格要 6 步 = 36 個 tick < 100，來不及變硬，不算障礙
    const late = makeState({
      roundTick: 2,
      snake,
      walls: [{ side: LEFT, cells: LEFT_WALL, ripe: 100 }],
    });
    expect(pathMoves(late)).toBe(8);
    // 左牆 ripe 30：走到那一格要 6 步 = 36 個 tick ≥ 30，已經硬了，要繞
    const ripe = makeState({
      roundTick: 2,
      snake,
      walls: [{ side: LEFT, cells: LEFT_WALL, ripe: 30 }],
    });
    expect(pathMoves(ripe)).toBeGreaterThan(8);
    // 硬牆一定算
    const hard = makeState({
      roundTick: 2,
      snake,
      walls: [{ side: LEFT, cells: LEFT_WALL, ripe: 0 }],
    });
    expect(pathMoves(hard)).toBe(pathMoves(ripe));
  });

  it('28. 設計師的 evaluate：蓋在蛇的路上的牆（蛇會繞）比什麼都不蓋的 gain 高；蓋在蛇不經過的一側，沒有價值', () => {
    const state = makeState({
      roundTick: 2,
      snake: { body: body([8, 12], [7, 12], [6, 12]), dir: RIGHT },
    });
    const none = cJGame.evaluate(run(state, 1), 1).gain;
    const onPath = cJGame.evaluate(run(state, 1, designer(PRESS_LEFT)), 1).gain;
    const offPath = cJGame.evaluate(run(state, 1, designer(PRESS_RIGHT)), 1).gain;
    expect(onPath).toBeGreaterThan(none);
    expect(offPath).toBe(none);
  });

  it('29. 設計師的 evaluate：蛇已經很近（牆來不及變硬）時，蓋牆沒有價值、danger 高', () => {
    const state = makeState({
      roundTick: 2,
      snake: { body: body([16, 12], [15, 12], [14, 12]), dir: RIGHT },
    });
    const none = cJGame.evaluate(run(state, 1), 1);
    const placed = cJGame.evaluate(run(state, 1, designer(PRESS_LEFT)), 1);
    expect(placed.gain).toBe(none.gain);
    expect(placed.danger).toBeGreaterThanOrEqual(0.6);
  });

  it('30. 蛇的 evaluate：下一格是硬牆、身體或地圖外：danger 1、gain 很低但有限；離食物越近 gain 越高；吃到的下一格 gain 很高', () => {
    const wall = makeState({
      roundTick: 2,
      snake: { body: body([23, 12], [22, 12], [21, 12]), dir: RIGHT },
      foodSeq: [cell(15, 3), ...makeState().foodSeq.slice(1)],
      walls: [{ side: RIGHT, cells: RIGHT_WALL, ripe: 0 }],
    });
    const hit = cJGame.evaluate(wall, 0);
    expect(hit.danger).toBe(1);
    expect(Number.isFinite(hit.gain)).toBe(true);
    const out = makeState({
      roundTick: 2,
      snake: { body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT },
    });
    expect(cJGame.evaluate(out, 0).danger).toBe(1);
    const far = cJGame.evaluate(makeState({ roundTick: 2 }), 0);
    const near = cJGame.evaluate(
      makeState({ roundTick: 2, snake: { body: body([14, 12], [13, 12], [12, 12]), dir: RIGHT } }),
      0,
    );
    expect(near.gain).toBeGreaterThan(far.gain);
    expect(far.danger).toBe(0);
    const eating = cJGame.evaluate(
      makeState({ roundTick: 2, snake: { body: body([21, 12], [20, 12], [19, 12]), dir: RIGHT } }),
      0,
    );
    expect(eating.gain).toBeGreaterThanOrEqual(1000);
  });

  it('31. 一局結束：這一局我拿到的食物比對方多 gain 為正、少為負、一樣為 0；整場結束 ±10000', () => {
    const ended = (eaten: number, lost: number): CJState =>
      makeState({ outcome: 'finished', pause: 30, eaten, lost, scores: [eaten, lost] });
    expect(cJGame.evaluate(ended(7, 3), 0).gain).toBeGreaterThan(0);
    expect(cJGame.evaluate(ended(7, 3), 1).gain).toBeLessThan(0);
    expect(cJGame.evaluate(ended(5, 5), 0).gain).toBe(0);
    const over = makeState({ over: true, winner: 1, scores: [3, 9] });
    expect(cJGame.evaluate(over, 1).gain).toBeGreaterThan(5000);
    expect(cJGame.evaluate(over, 0).gain).toBeLessThan(-5000);
  });

  it('32. 沒有橡皮筋：只有累積分數不同的兩個局面，兩邊的 evaluate 與 actions 完全相同', () => {
    const a = makeState({ roundTick: 2, scores: [0, 0] });
    const b = makeState({ roundTick: 2, scores: [9, 1] });
    const c = makeState({ roundTick: 2, scores: [1, 9] });
    for (const side of [0, 1] as const) {
      expect(cJGame.evaluate(b, side)).toEqual(cJGame.evaluate(a, side));
      expect(cJGame.evaluate(c, side)).toEqual(cJGame.evaluate(a, side));
      expect(cJGame.actions(b, side)).toEqual(cJGame.actions(a, side));
      expect(cJGame.actions(c, side)).toEqual(cJGame.actions(a, side));
    }
    // 把蛇一側的 snakes[].score 與整體對調也一樣（0 號邊是蛇時蛇的累積分數不同）
    const lead = makeState({ roundTick: 2, scores: [7, 0] });
    expect(cJGame.evaluate(lead, 0)).toEqual(cJGame.evaluate(a, 0));
    expect(cJGame.evaluate(lead, 1)).toEqual(cJGame.evaluate(a, 1));
  });

  it('33. 搜尋型當蛇：正前方有硬牆時會提早轉向，不會直直撞上去；當設計師：蛇還遠、牆能變硬時會蓋', () => {
    const wall = makeState({
      roundTick: 2,
      snake: { body: body([17, 12], [16, 12], [15, 12]), dir: RIGHT },
      foodSeq: [cell(15, 3), ...makeState().foodSeq.slice(1)],
      walls: [
        {
          side: LEFT,
          cells: body([20, 8], [20, 9], [20, 10], [20, 11], [20, 12], [20, 13]),
          ripe: 0,
        },
      ],
    });
    const snakeCtl = levelController(cJGame, policyByName('pathfinder'), 10, 1);
    const pressed = snakeCtl.decide(wall, 0, 0);
    expect(pressed.up || pressed.down).toBe(true);
    // 設計師：蛇在 (8,12)，食物 (22,12)，離食物還有 14 格，左側牆來得及變硬
    const far = makeState({
      roundTick: 2,
      snake: { body: body([8, 12], [7, 12], [6, 12]), dir: RIGHT },
    });
    const designerCtl = levelController(cJGame, policyByName('pathfinder'), 10, 1);
    const key = designerCtl.decide(far, 1, 0);
    expect(key.left).toBe(true);
  });

  it('34. 兩個預設性格（搜尋型等級 10）打完整場：結束、兩局都打完、分數合計不超過 2 × FOODS_PER_ROUND', () => {
    const c0 = levelController(cJGame, policyByName('pathfinder'), 10, 11);
    const c1 = levelController(cJGame, policyByName('pathfinder'), 10, 12);
    let state = cJGame.init(3, CONFIG);
    let ticks = 0;
    while (!cJGame.isOver(state) && ticks < 3600) {
      state = cJGame.step(state, [
        copyButtons(c0.decide(state, 0, ticks)),
        copyButtons(c1.decide(state, 1, ticks)),
      ]);
      ticks += 1;
    }
    expect(cJGame.isOver(state)).toBe(true);
    expect(state.round).toBe(1);
    const [a, b] = cJGame.score(state);
    expect(a + b).toBeLessThanOrEqual(2 * FOODS_PER_ROUND);
    expect(a + b).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(1000);
  }, 60_000);
});

describe('C-J 關卡設計師｜純度與畫面', () => {
  it('35. step 不改動傳進來的 state（凍結之後照樣能 step，撞死、停頓、結束的 tick 也是）', () => {
    const crashed = cJGame.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snake: { body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT },
      }),
      IDLE,
    );
    const placed = cJGame.step(makeState({ roundTick: 2 }), designer(PRESS_LEFT));
    for (const state of [
      cJGame.init(4, CONFIG),
      makeState({ roundTick: BEFORE_MOVE }),
      placed,
      crashed,
      makeState({ round: 1, roundTick: BEFORE_MOVE }),
      makeState({ over: true }),
    ]) {
      const before = JSON.stringify(state);
      deepFreeze(state);
      expect(() => cJGame.step(state, [PRESS_UP, PRESS_DOWN])).not.toThrow();
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it('36. render：畫得出來、不改 state、座標都在畫布之內；有牆與食物時用到橘色（食物）', () => {
    const state = cJGame.step(makeState({ roundTick: 2 }), designer(PRESS_LEFT));
    const before = JSON.stringify(state);
    const fake = createFakeContext();
    cJRender(asRenderingContext(fake), state);
    expect(JSON.stringify(state)).toBe(before);
    const used = fake.colors.filter((c) => c.via === 'set').map((c) => String(c.value));
    expect(used).toContain(COLOR.clubs);
    expect(used).toContain(COLOR.warning);
    for (const p of fake.points) {
      expect(p.x).toBeGreaterThanOrEqual(-8);
      expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
      expect(p.y).toBeGreaterThanOrEqual(-8);
      expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
    }
    // 第二局（人是設計師）也畫得出來
    const second = createFakeContext();
    cJRender(asRenderingContext(second), makeState({ round: 1, roundTick: 20 }));
    expect(second.points.length).toBeGreaterThan(0);
  });
});
