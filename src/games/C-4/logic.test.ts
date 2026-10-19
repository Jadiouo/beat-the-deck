import { describe, expect, it } from 'vitest';

import { levelController, policyByName } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import type { Game } from '../../core/types';
import type { Buttons, Inputs, Side } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { cell, cellX, cellY, LEFT, MOVE_EVERY, RIGHT, UP } from '../_clubs/logic';
import {
  c4Game,
  DEATH_FREEZE_TICKS,
  explorationTarget,
  FOG_RADIUS,
  isVisible,
  makeState,
  radarOf,
  RADAR_CYCLE,
  RADAR_ON_TICKS,
  STALE_TICKS,
  viewingPoint,
} from './logic';
import type { C4State } from './logic';
import { c4Render } from './render';

/**
 * C-4 霧的規則測試（小規格 `docs/cards/C-4.md`）。
 * 全部用 `makeState` 直接構造局面。預設局面是 C-A 的起始局面：
 * 人 (5,12) 往右、AI (26,11) 往左、長度 3，食物 (15,3) 與 (15,20)（兩邊都在霧外）。
 * 「走格的那一次 step」：`tick` 是 5（step 之後是 6）。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_UP: Buttons = { ...NONE, up: true };
const PRESS_DOWN: Buttons = { ...NONE, down: true };
const IDLE: Inputs = [NONE, NONE];
const BEFORE_MOVE = MOVE_EVERY - 1;
const PERSONAS = ['pathfinder', 'precise', 'greedy', 'gambler'] as const;
const DEPTHS = [1, 3, 6] as const;

function body(...points: [number, number][]): number[] {
  return points.map(([x, y]) => cell(x, y));
}

function run(state: C4State, count: number, inputs: Inputs = IDLE): C4State {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = c4Game.step(current, inputs);
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

describe('C-4 霧｜視野與記憶', () => {
  it('1. 初始：C-A 的起始局面；每一邊的記憶是「起始位置掃視一次」：看得到的食物記著、範圍內的格子最後看見時間是 0、其他是 -1', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const state = c4Game.init(seed, CONFIG);
      expect(state.snakes[0].body).toEqual(body([5, 12], [4, 12], [3, 12]));
      expect(state.snakes[1].body).toEqual(body([26, 11], [27, 11], [28, 11]));
      expect(state.foods).toHaveLength(2);
      expect(state.endAt).toBe(-1);
      for (const side of [0, 1] as const) {
        const memory = state.memory[side];
        const head = state.snakes[side].body[0] as number;
        expect(memory.seen).toHaveLength(32 * 24);
        expect(memory.foods).toEqual(state.foods.filter((food) => isVisible(head, food)));
        for (let c = 0; c < 32 * 24; c += 1) {
          expect(memory.seen[c]).toBe(isVisible(head, c) ? 0 : -1);
        }
      }
    }
  });

  it('2. 邊界：視野是曼哈頓距離 ≤ FOG_RADIUS 的格子（41 格）；距離 4 看得到、距離 5 看不到', () => {
    expect(FOG_RADIUS).toBe(4);
    const head = cell(5, 12);
    expect(isVisible(head, cell(9, 12))).toBe(true);
    expect(isVisible(head, cell(10, 12))).toBe(false);
    expect(isVisible(head, cell(7, 10))).toBe(true);
    expect(isVisible(head, cell(8, 10))).toBe(false);
    expect(isVisible(head, head)).toBe(true);
    let count = 0;
    for (let c = 0; c < 32 * 24; c += 1) {
      if (isVisible(cell(15, 12), c)) {
        count += 1;
      }
    }
    expect(count).toBe(41);
  });

  it('3. 掃視只在走格的那個 tick、用「走格之前」的蛇頭位置：食物在霧外 5 格，走一步之後記憶還沒有它，再過一次走格才記下來', () => {
    const state = makeState({ tick: BEFORE_MOVE, foods: body([10, 12], [15, 20]) });
    expect(state.memory[0].foods).toEqual([]);
    const moved = c4Game.step(state, IDLE);
    expect(moved.snakes[0].body[0]).toBe(cell(6, 12));
    expect(moved.memory[0].foods).toEqual([]);
    // 不是走格的 tick：記憶不變
    const between = run(moved, MOVE_EVERY - 1);
    expect(between.memory[0].foods).toEqual([]);
    const next = c4Game.step(between, IDLE);
    expect(next.memory[0].foods).toEqual([cell(10, 12)]);
    expect(next.memory[0].seen[cell(10, 12)]).toBe(2 * MOVE_EVERY);
  });

  it('4. 記得的食物離開視野仍然記得（即使它其實已經不在了）；回到視野裡看到是空的才忘掉', () => {
    const base = makeState({
      tick: BEFORE_MOVE,
      foods: body([15, 3], [15, 20]),
      memory: [{ foods: body([20, 5], [7, 12]) }, {}],
    });
    // (20,5) 離人太遠、(7,12) 在視野內但其實沒有食物
    const next = c4Game.step(base, IDLE);
    expect(next.memory[0].foods).toContain(cell(20, 5));
    expect(next.memory[0].foods).not.toContain(cell(7, 12));
    // 對手（AI）的記憶沒有被人的掃視影響
    expect(next.memory[1].foods).toEqual([]);
  });

  it('5. 自己吃到的食物立刻忘掉；對手在霧裡吃掉的、我記得的食物，我不知道（記憶是錯的）', () => {
    const state = makeState({ tick: BEFORE_MOVE, foods: body([6, 12], [15, 20]) });
    expect(state.memory[0].foods).toEqual([cell(6, 12)]);
    const ate = c4Game.step(state, IDLE);
    expect(ate.snakes[0].score).toBe(1);
    expect(ate.memory[0].foods).not.toContain(cell(6, 12));
    // AI 的記憶裡有 (20,3)（離它很遠）、其實那個食物不在了：它不知道
    const stale = makeState({
      tick: BEFORE_MOVE,
      foods: body([15, 3], [15, 20]),
      memory: [{}, { foods: body([20, 3]) }],
    });
    expect(c4Game.step(stale, IDLE).memory[1].foods).toEqual([cell(20, 3)]);
  });

  it('6. 看到對手：範圍內的蛇身與蛇頭、行進方向記下來；範圍外清空', () => {
    const near = makeState({
      tick: BEFORE_MOVE,
      snakes: [{}, { body: body([8, 12], [9, 12], [10, 12]), dir: LEFT }],
    });
    const seen = c4Game.step(near, IDLE);
    expect(seen.memory[0].rivalHead).toBe(cell(8, 12));
    expect(seen.memory[0].rivalTurn).toBe(LEFT);
    expect(seen.memory[0].rival).toEqual(body([8, 12], [9, 12]));
    const far = c4Game.step(makeState({ tick: BEFORE_MOVE }), IDLE);
    expect(far.memory[0].rival).toEqual([]);
    expect(far.memory[0].rivalHead).toBe(-1);
  });
});

describe('C-4 霧｜C-A 的規則照舊，加上死亡停格', () => {
  it('7. 吃到食物：加 1 分、長一格、補一個新食物（亂數狀態寫回 state）', () => {
    const state = makeState({ tick: BEFORE_MOVE, foods: body([6, 12], [15, 20]) });
    const next = c4Game.step(state, IDLE);
    expect(next.snakes[0].body).toHaveLength(4);
    expect(next.snakes[0].score).toBe(1);
    expect(next.foods).toHaveLength(2);
    expect(JSON.stringify(next.rng)).not.toBe(JSON.stringify(state.rng));
  });

  it('8. 撞牆：死的那條輸；畫面停 DEATH_FREEZE_TICKS 個 tick 才結束（isOver 是 false、winner 是 null、蛇不動）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}],
    });
    let next = c4Game.step(state, IDLE);
    expect(next.snakes[0].alive).toBe(false);
    expect(next.over).toBe(false);
    expect(c4Game.isOver(next)).toBe(false);
    expect(c4Game.winner(next)).toBeNull();
    expect(next.endAt).toBe(next.tick + DEATH_FREEZE_TICKS);
    const aiBefore = next.snakes[1].body;
    next = run(next, DEATH_FREEZE_TICKS - 1);
    expect(next.over).toBe(false);
    expect(next.snakes[1].body).toEqual(aiBefore);
    next = c4Game.step(next, IDLE);
    expect(next.over).toBe(true);
    expect(c4Game.winner(next)).toBe(1);
  });

  it('9. 邊界：兩條同時死（頭對頭）：停格之後比分數；同分平手', () => {
    const head = (score: number): C4State =>
      makeState({
        tick: BEFORE_MOVE,
        snakes: [
          { body: body([15, 12], [14, 12], [13, 12]), dir: RIGHT, score },
          { body: body([17, 12], [18, 12], [19, 12]), dir: LEFT },
        ],
      });
    const tied = run(head(0), 1 + DEATH_FREEZE_TICKS);
    expect(tied.over).toBe(true);
    expect(c4Game.winner(tied)).toBeNull();
    const ahead = run(head(2), 1 + DEATH_FREEZE_TICKS);
    expect(c4Game.winner(ahead)).toBe(0);
  });

  it('10. 邊界：停格期間 maxTicks 到了：直接結束，贏家是已經決定的那個；結束之後 step 不再改變 state', () => {
    const state = makeState({
      tick: 3593,
      snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}],
    });
    const dead = c4Game.step(state, IDLE);
    expect(dead.tick).toBe(3594);
    expect(dead.over).toBe(false);
    const end = run(dead, 3600 - 3594);
    expect(end.over).toBe(true);
    expect(c4Game.winner(end)).toBe(1);
    expect(c4Game.step(end, [PRESS_UP, PRESS_DOWN])).toBe(end);
  });

  it('11. 時間到沒人死：分數高的贏（沿用 C-A）', () => {
    const state = makeState({
      tick: 3599,
      snakes: [{ score: 2 }, { score: 1 }],
    });
    const end = c4Game.step(state, IDLE);
    expect(end.over).toBe(true);
    expect(c4Game.winner(end)).toBe(0);
  });
});

describe('C-4 霧｜actions 與 evaluate 不偷看', () => {
  it('12. actions：還沒鎖定轉向時三個（順時針轉向、逆時針轉向、全放開）；已鎖定、自己死了、結束時只有「全放開」（停格期間還活著的蛇照樣有三個）', () => {
    const state = makeState({ tick: 1 });
    const actions = c4Game.actions(state, 0);
    expect(actions).toHaveLength(3);
    expect(actions[0]).toEqual({ ...NONE, down: true });
    expect(actions[1]).toEqual(PRESS_UP);
    expect(actions[2]).toEqual(NONE);
    const locked = c4Game.step(state, [PRESS_UP, NONE]);
    expect(c4Game.actions(locked, 0)).toEqual([NONE]);
    expect(c4Game.actions(makeState({ over: true }), 0)).toEqual([NONE]);
    // 停格期間還活著的蛇照樣可以鎖定轉向（見規格決定 4：不然模擬裡「對手撞牆」會讓我的動作變少，洩漏對手的位置）
    expect(c4Game.actions(makeState({ endAt: 100 }), 0)).toHaveLength(3);
    expect(c4Game.actions(makeState({ endAt: 100, snakes: [{ alive: false }, {}] }), 0)).toEqual([
      NONE,
    ]);
    // 順時針那一邊會直接走出地圖：逆時針排第一
    const edge = makeState({
      tick: 1,
      snakes: [{ body: body([5, 23], [4, 23], [3, 23]), dir: RIGHT }, {}],
    });
    expect(c4Game.actions(edge, 0)[0]).toEqual(PRESS_UP);
  });

  it('13. actions 不看食物：只有食物的位置不同（包括霧內的），兩邊的 actions 都一樣', () => {
    const a = makeState({ tick: 1, foods: body([15, 3], [15, 20]) });
    const b = makeState({ tick: 1, foods: body([5, 3], [9, 12]) });
    for (const side of [0, 1] as const) {
      expect(c4Game.actions(b, side)).toEqual(c4Game.actions(a, side));
    }
  });

  it('14. 偷看檢查（準則 4.3）：只有「霧外」的格子不同——食物、對手的位置、對手的記憶、對手的分數、對手死了——兩邊的 evaluate 與 actions 相等', () => {
    const base = makeState({ tick: 1 });
    // 人 (5,12) 的視野內沒有任何東西；AI (26,11) 的視野內也沒有。
    const variants: C4State[] = [
      makeState({ tick: 1, foods: body([25, 3], [25, 20]) }),
      makeState({ tick: 1, foods: body([15, 3], [10, 12]) }), // 人的霧外 5 格；AI 的霧外
      makeState({ tick: 1, snakes: [{}, { body: body([20, 3], [20, 4], [20, 5]), dir: UP }] }),
      makeState({ tick: 1, memory: [{}, { foods: body([30, 20]), rivalHead: -1 }] }),
      makeState({ tick: 1, snakes: [{}, { score: 7 }] }),
      makeState({ tick: 1, snakes: [{}, { alive: false }] }),
      // 對手的蛇頭離人 5 格（剛好在霧外）：貼近的扣分要看得到才會算
      makeState({ tick: 1, snakes: [{}, { body: body([10, 12], [11, 12], [12, 12]), dir: LEFT }] }),
    ];
    for (const variant of variants) {
      expect(c4Game.evaluate(variant, 0)).toEqual(c4Game.evaluate(base, 0));
      expect(c4Game.actions(variant, 0)).toEqual(c4Game.actions(base, 0));
    }
    const forAi: C4State[] = [
      makeState({ tick: 1, foods: body([15, 3], [10, 12]) }),
      makeState({ tick: 1, snakes: [{ body: body([5, 18], [4, 18], [3, 18]), dir: RIGHT }, {}] }),
      makeState({ tick: 1, memory: [{ foods: body([2, 2]) }, {}] }),
      makeState({ tick: 1, snakes: [{ score: 7 }, {}] }),
      makeState({ tick: 1, snakes: [{ alive: false }, {}] }),
    ];
    for (const variant of forAi) {
      expect(c4Game.evaluate(variant, 1)).toEqual(c4Game.evaluate(base, 1));
      expect(c4Game.actions(variant, 1)).toEqual(c4Game.actions(base, 1));
    }
  });

  it('15. 黑箱（準則 4.2）：只有霧外的格子不同的兩個 state，四個性格在深度 1、3、6 下 decide 按的鍵相同——兩邊、走格前後各個 tick', () => {
    interface Scenario {
      readonly a: C4State;
      readonly b: C4State;
      readonly sides: readonly Side[];
    }
    const scenarios: Scenario[] = [];
    for (const tick of [0, 1, 3, 5]) {
      // 食物在人的霧外 5 格、正前方（走一格之後就進入視野——模擬洩漏的典型情形）；兩邊都看不到
      scenarios.push({
        a: makeState({ tick, foods: body([10, 12], [15, 20]) }),
        b: makeState({ tick, foods: body([5, 20], [15, 20]) }),
        sides: [0, 1],
      });
      // 人看不到的對手：位置不同；其中一個正好離牆一步（模擬裡一走格就撞牆）
      scenarios.push({
        a: makeState({
          tick,
          snakes: [{}, { body: body([26, 11], [27, 11], [28, 11]), dir: LEFT }],
        }),
        b: makeState({
          tick,
          snakes: [{}, { body: body([31, 11], [30, 11], [29, 11]), dir: RIGHT }],
        }),
        sides: [0],
      });
      // 人看不到的對手：蛇頭離人 5 格（剛好在霧外、模擬一個走格之後會貼近）
      scenarios.push({
        a: makeState({ tick }),
        b: makeState({
          tick,
          snakes: [{}, { body: body([10, 12], [11, 12], [12, 12]), dir: LEFT }],
        }),
        sides: [0],
      });
      // 人看不到的對手：它的第一個動作（順時針轉向）會撞上自己的身體（模擬裡遊戲會結束）
      scenarios.push({
        a: makeState({
          tick,
          snakes: [{}, { body: body([20, 5], [20, 6], [21, 6], [21, 5], [22, 5]), dir: UP }],
        }),
        b: makeState({
          tick,
          snakes: [{}, { body: body([20, 5], [20, 6], [20, 7], [20, 8], [20, 9]), dir: UP }],
        }),
        sides: [0],
      });
      // 人看不到的：對手的分數、記憶
      scenarios.push({
        a: makeState({ tick }),
        b: makeState({ tick, snakes: [{}, { score: 4 }], memory: [{}, { foods: body([1, 1]) }] }),
        sides: [0],
      });
      // AI 看不到的：人的位置、食物、分數
      scenarios.push({
        a: makeState({ tick, foods: body([20, 11], [15, 3]) }),
        b: makeState({
          tick,
          foods: body([21, 17], [15, 3]),
          snakes: [{ body: body([5, 3], [4, 3], [3, 3]), dir: RIGHT, score: 3 }, {}],
        }),
        sides: [1],
      });
    }
    for (const name of PERSONAS) {
      const policy = policyByName(name);
      for (const depth of DEPTHS) {
        for (const { a, b, sides } of scenarios) {
          for (const side of sides) {
            const params = { depth, seed: 1 };
            expect(policy.decide(c4Game, a, side, a.tick, params)).toEqual(
              policy.decide(c4Game, b, side, b.tick, params),
            );
          }
        }
      }
    }
  });

  it('16. 這個黑箱測試有牙齒：把 evaluate 換成偷看 state.foods 的版本，同一組比較會抓到差異', () => {
    const leaky: Game<C4State> = {
      ...c4Game,
      evaluate(state, side) {
        const real = c4Game.evaluate(state, side);
        const head = state.snakes[side].body[0] as number;
        const nearest = Math.min(
          ...state.foods.map(
            (food) => Math.abs(cellX(food) - cellX(head)) + Math.abs(cellY(food) - cellY(head)),
          ),
        );
        return { gain: real.gain - 10 * nearest, danger: real.danger };
      },
    };
    // 在走格前一個 tick（BEFORE_MOVE）決定：這一個按鍵就決定下一格往哪走，偷看食物的差別一定會出現在第一步。
    // （原本用 tick 1：第一個按鍵之後還有好幾個 tick 可以改方向，偷看的影響會被後面的 tick 蓋掉，要靠平手時的取捨才看得出來。）
    const a = makeState({ tick: BEFORE_MOVE, foods: body([5, 20], [15, 20]) }); // 食物在下方
    const b = makeState({ tick: BEFORE_MOVE, foods: body([5, 4], [15, 3]) }); // 食物在上方
    const params = { depth: 6, seed: 1 };
    const differs = PERSONAS.some((name) => {
      const policy = policyByName(name);
      return (
        JSON.stringify(policy.decide(leaky, a, 0, BEFORE_MOVE, params)) !==
        JSON.stringify(policy.decide(leaky, b, 0, BEFORE_MOVE, params))
      );
    });
    expect(differs).toBe(true);
  });

  it('17. evaluate 用記憶：記得的食物在霧外，朝它走的轉向 gain 比背離它的高', () => {
    const toward = makeState({
      tick: 1,
      foods: body([15, 3], [15, 20]),
      memory: [{ foods: body([12, 12]) }, {}],
    });
    const away = {
      ...toward,
      snakes: [{ ...toward.snakes[0], turn: UP }, toward.snakes[1]] as C4State['snakes'],
    };
    expect(c4Game.evaluate(toward, 0).gain).toBeGreaterThan(c4Game.evaluate(away, 0).gain);
  });

  it('18. 探索：沒有記得的食物時，往「最近的很久沒看過的格子」走；超過 STALE_TICKS 沒看過才算；蛇頭背後的多算 4 格', () => {
    // 邊界：剛好 STALE_TICKS 前看過 → 不算很久（回傳地圖中心）；多 1 個 tick → 算
    const seen = Array.from({ length: 32 * 24 }, () => 1000);
    expect(explorationTarget(seen, cell(5, 12), RIGHT, 1000 + STALE_TICKS)).toBe(cell(16, 12));
    const stale = [...seen];
    stale[cell(24, 12)] = 999;
    expect(explorationTarget(stale, cell(16, 12), RIGHT, 1000 + STALE_TICKS)).toBe(cell(24, 12));
    // 兩個一樣遠的 stale 格子：蛇頭背後那個多算 4 格，前面的贏
    const two = Array.from({ length: 32 * 24 }, () => 5000);
    two[cell(12, 12)] = -1;
    two[cell(20, 12)] = -1;
    expect(explorationTarget(two, cell(16, 12), RIGHT, 5000)).toBe(cell(20, 12));
    expect(explorationTarget(two, cell(16, 12), LEFT, 5000)).toBe(cell(12, 12));
    // evaluate：東邊沒看過、其他地方剛看過：往東走的轉向 gain 比往西的高
    const unexplored = Array.from({ length: 32 * 24 }, (_zero, c) => (cellX(c) >= 24 ? -1 : 100));
    const state = makeState({
      tick: 100,
      snakes: [{ body: body([16, 12], [16, 13], [16, 14]), dir: UP }, {}],
      memory: [{ seen: unexplored, foods: [] }, {}],
    });
    const east = {
      ...state,
      snakes: [{ ...state.snakes[0], turn: RIGHT }, state.snakes[1]] as C4State['snakes'],
    };
    const west = {
      ...state,
      snakes: [{ ...state.snakes[0], turn: LEFT }, state.snakes[1]] as C4State['snakes'],
    };
    expect(c4Game.evaluate(east, 0).gain).toBeGreaterThan(c4Game.evaluate(west, 0).gain);
  });

  it('19. 自己的分數進 gain（每 1 分 100），對手的分數不進（沒有偷看、也沒有橡皮筋）', () => {
    const base = makeState({ tick: 1 });
    const mine = makeState({ tick: 1, snakes: [{ score: 3 }, {}] });
    expect(c4Game.evaluate(mine, 0).gain - c4Game.evaluate(base, 0).gain).toBe(300);
    const theirs = makeState({ tick: 1, snakes: [{}, { score: 3 }] });
    expect(c4Game.evaluate(theirs, 0)).toEqual(c4Game.evaluate(base, 0));
  });

  it('20. 自己死了：gain 很低、danger 是 1（有限的數）；看到的對手蛇頭貼近：gain 比沒有的低', () => {
    const dead = makeState({ tick: 1, snakes: [{ alive: false }, {}] });
    const result = c4Game.evaluate(dead, 0);
    expect(result.danger).toBe(1);
    expect(Number.isFinite(result.gain)).toBe(true);
    expect(result.gain).toBeLessThan(-100000);
    const blocked = makeState({
      tick: 1,
      snakes: [{}, { body: body([7, 12], [7, 13], [7, 14]), dir: UP }],
      memory: [
        { rival: body([7, 12], [7, 13], [7, 14]), rivalHead: cell(7, 12), rivalTurn: UP },
        {},
      ],
    });
    const open = makeState({ tick: 1 });
    expect(c4Game.evaluate(blocked, 0).gain).toBeLessThan(c4Game.evaluate(open, 0).gain);
  });
});

describe('C-4 霧｜隨機與純度', () => {
  it('21. 隨機事件在不同種子下不全相同：10 個種子的起始食物不可以全部一樣；連續兩次補食物也不同', () => {
    const states = Array.from({ length: 10 }, (_, seed) => c4Game.init(seed, CONFIG));
    expect(new Set(states.map((s) => s.foods.join(','))).size).toBeGreaterThan(1);
    // 連續兩次補食物（人連吃兩個）：補出來的位置不同，亂數狀態每次都寫回
    let state = makeState({ tick: BEFORE_MOVE, foods: body([6, 12], [15, 20]) });
    const refills: number[] = [];
    state = c4Game.step(state, IDLE);
    refills.push(state.foods.find((f) => f !== cell(15, 20)) as number);
    const second = makeState({
      tick: BEFORE_MOVE,
      foods: body([6, 12], [15, 20]),
      rng: state.rng,
    });
    const after = c4Game.step(second, IDLE);
    refills.push(after.foods.find((f) => f !== cell(15, 20)) as number);
    expect(refills[0]).not.toBe(refills[1]);
    expect(JSON.stringify(after.rng)).not.toBe(JSON.stringify(state.rng));
  });

  it('22. 同一個種子，初始 state 完全相同；JSON 來回之後不變', () => {
    expect(c4Game.init(3, CONFIG)).toEqual(c4Game.init(3, CONFIG));
    const state = run(c4Game.init(3, CONFIG), 20);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('23. step 不改動傳進來的 state（凍結之後照樣能 step，死亡停格與結束的 tick 也是）', () => {
    const dead = c4Game.step(
      makeState({
        tick: BEFORE_MOVE,
        snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}],
      }),
      IDLE,
    );
    for (const state of [
      c4Game.init(4, CONFIG),
      makeState({ tick: BEFORE_MOVE }),
      dead,
      makeState({ over: true }),
    ]) {
      const before = JSON.stringify(state);
      deepFreeze(state);
      expect(() => c4Game.step(state, [PRESS_UP, PRESS_DOWN])).not.toThrow();
      expect(JSON.stringify(state)).toBe(before);
    }
  });
});

describe('C-4 霧｜雷達與畫面', () => {
  it('24. 雷達：最近的食物的 8 個方位與三級距離；每 RADAR_CYCLE 個 tick 亮 RADAR_ON_TICKS 個 tick（邊界）', () => {
    // 方位：0 北、1 東北、2 東、3 東南、4 南、5 西南、6 西、7 西北
    const at = (food: [number, number], tick = 0): ReturnType<typeof radarOf> =>
      radarOf(makeState({ tick, foods: body(food, [0, 0]) }));
    expect(at([15, 12]).dir).toBe(2);
    expect(at([15, 11]).dir).toBe(2);
    expect(at([10, 7]).dir).toBe(1);
    expect(at([5, 2]).dir).toBe(0);
    expect(at([1, 7]).dir).toBe(7);
    expect(at([1, 12]).dir).toBe(6);
    expect(at([1, 16]).dir).toBe(5);
    expect(at([5, 22]).dir).toBe(4);
    expect(at([11, 18]).dir).toBe(3);
    // 距離：≤ 8 近、≤ 16 中、其餘遠（人的蛇頭 (5,12)）
    expect(at([13, 12]).band).toBe(0);
    expect(at([14, 12]).band).toBe(1);
    expect(at([21, 12]).band).toBe(1);
    expect(at([22, 12]).band).toBe(2);
    // 最近的那個
    const two = radarOf(makeState({ foods: body([25, 12], [9, 12]) }));
    expect(two.dir).toBe(2);
    expect(two.band).toBe(0);
    // 亮暗
    expect(radarOf(makeState({ tick: 0 })).lit).toBe(true);
    expect(radarOf(makeState({ tick: RADAR_ON_TICKS - 1 })).lit).toBe(true);
    expect(radarOf(makeState({ tick: RADAR_ON_TICKS })).lit).toBe(false);
    expect(radarOf(makeState({ tick: RADAR_CYCLE - 1 })).lit).toBe(false);
    expect(radarOf(makeState({ tick: RADAR_CYCLE })).lit).toBe(true);
  });

  it('25. render：霧外的食物與對手不畫、霧內的畫；記得但看不到的食物畫空心；座標都在畫布之內，不改 state', () => {
    const drawn = (state: C4State, x: number, y: number) => {
      const fake = createFakeContext();
      c4Render(asRenderingContext(fake), state);
      return fake.points.filter(
        (p) => p.x >= x * 10 && p.x <= x * 10 + 10 && p.y >= y * 10 && p.y <= y * 10 + 10,
      ).length;
    };
    const hidden = makeState({
      tick: 7,
      foods: body([20, 5], [15, 20]),
      snakes: [{}, { body: body([26, 11], [27, 11], [28, 11]), dir: LEFT }],
    });
    const visible = makeState({
      tick: 7,
      foods: body([8, 12], [15, 20]),
      snakes: [{}, { body: body([8, 13], [9, 13], [10, 13]), dir: LEFT }],
    });
    // 食物 (20,5) 在霧外：那一格附近沒有任何繪圖點（除了背景整面的矩形——背景 fillRect 的點在 (0,0) 與右下角）
    expect(drawn(hidden, 20, 5)).toBe(0);
    expect(drawn(visible, 8, 12)).toBeGreaterThan(0);
    // 對手的蛇頭 (26,11) 在霧外不畫；在視野內 (8,13) 要畫
    expect(drawn(hidden, 26, 11)).toBe(0);
    expect(drawn(visible, 8, 13)).toBeGreaterThan(0);
    // 記得但看不到的食物：畫空心記號
    const remembered = makeState({
      tick: 7,
      foods: body([15, 3], [15, 20]),
      memory: [{ foods: body([20, 5]) }, {}],
    });
    expect(drawn(remembered, 20, 5)).toBeGreaterThan(0);
    const before = JSON.stringify(visible);
    const fake = createFakeContext();
    c4Render(asRenderingContext(fake), visible);
    expect(JSON.stringify(visible)).toBe(before);
    for (const p of fake.points) {
      expect(p.x).toBeGreaterThanOrEqual(-8);
      expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
      expect(p.y).toBeGreaterThanOrEqual(-8);
      expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
    }
    // 死亡停格、結束的畫面也畫得出來
    const dead = c4Game.step(
      makeState({
        tick: BEFORE_MOVE,
        snakes: [{ body: body([31, 5], [30, 5], [29, 5]), dir: RIGHT }, {}],
      }),
      IDLE,
    );
    const frozen = createFakeContext();
    c4Render(asRenderingContext(frozen), dead);
    expect(frozen.points.length).toBeGreaterThan(0);
  });
});

/**
 * 霧裡的探索與吃牆邊的食物（docs/cards/C-4.md「探索的量測與修正」）。
 * 量到的缺陷：兩個等級 10 的 AI 對打時，其中一個會繞著一格食物轉上千個 tick 都不吃（C-4 放過率 68%）；
 * 以及探索目標每個終點各自重找，走成階梯。
 */
describe('C-4 吃牆邊的食物與探索目標', () => {
  /** 站在 value 的位置的評估：gain − 200 × danger（搜尋型比較終點時大約這個量級）。 */
  function value(state: C4State): number {
    const result = c4Game.evaluate(state, 0);
    return result.gain - 200 * result.danger;
  }

  it('26. 吃到食物的終點，比「在食物旁邊轉彎不吃」的終點好很多（吃到之後記憶空了，探索目標很遠也一樣）', () => {
    const start = makeState({
      tick: BEFORE_MOVE,
      snakes: [{ body: body([27, 18], [26, 18], [25, 18]), dir: RIGHT }, {}],
      foods: body([28, 18], [15, 3]),
      memory: [{ foods: body([28, 18]) }, {}],
    });
    const ate = run(start, 1);
    const skipped = run(start, 1, [PRESS_UP, NONE]);
    expect(ate.snakes[0].score).toBe(1);
    expect(skipped.snakes[0].score).toBe(0);
    // 吃到的終點離探索目標（地圖另一頭）很遠，但吃到的 +100 要贏過不吃
    expect(value(ate)).toBeGreaterThan(value(skipped) + 50);
  });

  it('27. 吃到最上面一排的食物：終點的蛇頭正對著牆，也不能被當成必死（下一個 tick 可以轉向）', () => {
    const start = makeState({
      tick: BEFORE_MOVE,
      snakes: [{ body: body([21, 1], [21, 2], [21, 3]), dir: UP }, {}],
      foods: body([21, 0], [15, 20]),
      memory: [{ foods: body([21, 0]) }, {}],
    });
    const ate = run(start, 1);
    expect(ate.snakes[0].score).toBe(1);
    expect(ate.snakes[0].alive).toBe(true);
    const result = c4Game.evaluate(ate, 0);
    expect(result.gain).toBeGreaterThan(-1000);
    expect(result.danger).toBeLessThan(0.5);
    // 沒吃到、真的正對著牆而且已經鎖定的局面，仍然是死
    const locked = makeState({
      snakes: [{ body: body([21, 0], [21, 1], [21, 2]), dir: UP, turn: UP }, {}],
      memory: [{ foods: [] }, {}],
    });
    expect(c4Game.evaluate(locked, 0).danger).toBe(1);
  });

  it('28. 探索目標記在 memory.goal，被看見之前不變；被看見之後重選，而且在正前方的同一列', () => {
    const state = makeState();
    const goal = state.memory[0].goal;
    expect(goal).toBeGreaterThanOrEqual(0);
    expect(cellY(goal)).toBe(12);
    // 走一格（掃視用走格之前的位置 (5,12)；目標在 (10,12)，離 5 格，還沒看到）：目標不變
    const oneMove = run(state, MOVE_EVERY);
    expect(oneMove.memory[0].goal).toBe(goal);
    // 再走一格：目標被看到了，重選，仍在同一列、更遠
    const twoMoves = run(oneMove, MOVE_EVERY);
    expect(twoMoves.memory[0].goal).not.toBe(goal);
    expect(cellY(twoMoves.memory[0].goal)).toBe(12);
    expect(cellX(twoMoves.memory[0].goal)).toBeGreaterThan(cellX(goal));
    // 有記得的食物的時候不挑探索目標，食物被忘掉之後才重選
    const withFood = makeState({ memory: [{ foods: body([14, 12]), goal: -1 }, {}] });
    expect(run(withFood, MOVE_EVERY).memory[0].goal).toBe(-1);
  });

  it('29. 看牆邊的格子要站到離牆 4 格的位置；四個角落看不到的格子不當探索目標', () => {
    expect(viewingPoint(cell(3, 0))).toBe(cell(4, 4));
    expect(viewingPoint(cell(31, 23))).toBe(cell(27, 19));
    expect(viewingPoint(cell(16, 12))).toBe(cell(16, 12));
    expect(viewingPoint(cell(16, 0))).toBe(cell(16, 4));
    const never = Array.from({ length: 32 * 24 }, () => -1);
    for (const start of [cell(1, 1), cell(30, 1), cell(1, 22), cell(30, 22)]) {
      const target = explorationTarget(never, start, RIGHT, 100);
      expect(isVisible(viewingPoint(target), target)).toBe(true);
    }
    const corner = explorationTarget(never, cell(1, 1), LEFT, 100);
    expect(corner).not.toBe(cell(0, 0));
  });
});

describe('C-4 霧｜牆的遠距離 danger 不擋路、直走優先、不繞圈', () => {
  const DOWN = 2;

  /** 左邊那條蛇（0 號）由等級 10 的搜尋型控制，右邊那條往上走、一直在遠處，不影響結果。 */
  function playAlone(start: C4State, ticks: number): C4State {
    const controller = levelController(c4Game, pathfinder, 10, 7);
    let state = start;
    for (let i = 0; i < ticks && !c4Game.isOver(state); i += 1) {
      state = c4Game.step(state, [controller.decide(state, 0, state.tick), NONE]);
    }
    return state;
  }
  const FAR_RIVAL = { body: body([16, 18], [16, 19], [16, 20]), dir: UP } as const;

  it('30. 牆離 4 到 5 格的前方不再扣 danger（蛇隨時能轉彎）；下一格就是牆、或走進死胡同，仍然是 danger', () => {
    // 蛇頭 (26,12) 往右，下一格 (27,12) 空著，前方 (28..31,12) 之後是牆。食物在別列（不是直線上的食物，沒有豁免）。
    const open = makeState({
      tick: 1,
      snakes: [{ body: body([26, 12], [25, 12], [24, 12]), dir: RIGHT }, {}],
      memory: [{ foods: body([30, 6]) }, {}],
    });
    expect(c4Game.evaluate(open, 0).danger).toBeLessThan(0.05);
    // 下一格就是牆：danger 1，gain 比同樣局面往空格走的低好幾千
    const wall = makeState({
      tick: 1,
      snakes: [{ body: body([31, 12], [30, 12], [29, 12]), dir: RIGHT }, {}],
      memory: [{ foods: body([30, 6]) }, {}],
    });
    expect(c4Game.evaluate(wall, 0).danger).toBe(1);
    expect(c4Game.evaluate(wall, 0).gain).toBeLessThan(c4Game.evaluate(open, 0).gain - 5000);
    // 死胡同（下一格進去只剩 2 格空間，蛇長 3）：danger 仍然高（被困住的判斷沒有拿掉）
    const pocket = makeState({
      tick: 1,
      snakes: [{ body: body([2, 0], [1, 0], [0, 0]), dir: RIGHT }, {}],
      foods: body([15, 20], [25, 20]),
      memory: [
        {
          foods: body([30, 6]),
          rival: body([4, 0], [4, 1], [3, 2], [2, 2], [2, 1], [10, 10]),
          rivalHead: cell(4, 0),
          rivalTurn: DOWN,
        },
        {},
      ],
    });
    expect(c4Game.evaluate(pocket, 0).danger).toBeGreaterThan(0.3);
  });

  it('31. prevDir：走格的那個 tick 記下「走格之前的行進方向」，其他 tick 不變', () => {
    const start = makeState({
      tick: BEFORE_MOVE,
      snakes: [{ body: body([5, 12], [4, 12], [3, 12]), dir: RIGHT }, {}],
    });
    expect(start.prevDir).toEqual([RIGHT, LEFT]);
    const turned = c4Game.step(start, [PRESS_UP, NONE]);
    expect(turned.snakes[0].dir).toBe(UP);
    expect(turned.prevDir[0]).toBe(RIGHT);
    // 下一次走格，上一格的方向（UP）變成 prevDir；中間的 tick 不動它
    const mid = run(turned, MOVE_EVERY - 1);
    expect(mid.prevDir[0]).toBe(RIGHT);
    expect(run(mid, 1).prevDir[0]).toBe(UP);
  });

  it('32. 記得的食物在牆邊、離牆 4 格以內：蛇不會繞著它轉圈，150 個 tick 內吃到（舊版在 (5,4) 附近繞 2×2 的圈上千個 tick）', () => {
    const start = makeState({
      tick: 0,
      snakes: [{ body: body([5, 4], [5, 5], [5, 6]), dir: UP }, FAR_RIVAL],
      foods: body([1, 3], [25, 20]),
      memory: [{ foods: body([1, 3]) }, {}],
    });
    const end = playAlone(start, 150);
    expect(end.snakes[0].score).toBeGreaterThanOrEqual(1);
    expect(end.snakes[0].alive).toBe(true);
  });

  it('33. 直走優先：目標在斜前方、走階梯與先直走一樣近的時候，蛇先直走（12 次走格裡轉彎不超過 3 次）', () => {
    const seen = Array.from({ length: 32 * 24 }, (_zero, c) => (cellX(c) >= 12 ? -1 : 0));
    const start = makeState({
      tick: 0,
      snakes: [{ body: body([8, 8], [7, 8], [6, 8]), dir: RIGHT }, FAR_RIVAL],
      foods: body([15, 20], [25, 21]),
      memory: [{ foods: [], seen, goal: cell(24, 14) }, {}],
    });
    const controller = levelController(c4Game, pathfinder, 10, 7);
    let state = start;
    let turns = 0;
    let last: number = state.snakes[0].dir;
    for (let i = 0; i < 12 * MOVE_EVERY; i += 1) {
      state = c4Game.step(state, [controller.decide(state, 0, state.tick), NONE]);
      if (state.snakes[0].dir !== last) {
        turns += 1;
        last = state.snakes[0].dir;
      }
    }
    expect(state.snakes[0].alive).toBe(true);
    expect(turns).toBeLessThanOrEqual(3);
  });
});
