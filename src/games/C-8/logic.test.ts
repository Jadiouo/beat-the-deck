import { describe, expect, it } from 'vitest';

import { levelController, policyByName } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { copyButtons } from '../../core/match';
import type { Buttons, Inputs } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { COLOR } from '../../shell/palette';
import { cell, cellX, cellY, DOWN, LEFT, RIGHT, UP } from '../_clubs/logic';
import {
  c8Game,
  GRACE_TICKS,
  makeState,
  MIN_START_GAP,
  MOVE_TICKS,
  PAUSE_TICKS,
  ROOM_CAP,
  ROUND_TICKS,
  START_MARGIN,
  territoryOutcome,
  TURN_PENALTY,
} from './logic';
import type { C8State } from './logic';
import { c8Render } from './render';

/**
 * C-8 光軌的規則測試（小規格 `docs/cards/C-8.md`）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 預設局面：第一局、`roundTick` 0（開局的不動時間已過）、人的蛇頭 (8,12) 往右、AI 的蛇頭 (23,11) 往左，各只有 1 格。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_UP: Buttons = { ...NONE, up: true };
const PRESS_DOWN: Buttons = { ...NONE, down: true };
const PRESS_LEFT: Buttons = { ...NONE, left: true };
const IDLE: Inputs = [NONE, NONE];

/** 讓「下一次 step」剛好是走格的那一次（`roundTick` 加 1 之後是 6 的倍數）。 */
const BEFORE_MOVE = MOVE_TICKS - 1;

function body(...points: [number, number][]): number[] {
  return points.map(([x, y]) => cell(x, y));
}

function head(state: C8State, side: 0 | 1): [number, number] {
  const at = state.snakes[side].body[0] as number;
  return [cellX(at), cellY(at)];
}

function run(state: C8State, count: number, inputs: Inputs = IDLE): C8State {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = c8Game.step(current, inputs);
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

describe('C-8 光軌｜初始與時間', () => {
  it('1. 初始：第一局、兩條蛇各只有 1 格、沒有食物、分數 0；人的位置轉 180 度就是 AI 的位置', () => {
    const state = c8Game.init(0, CONFIG);
    expect(state.round).toBe(0);
    expect(state.snakes[0].body).toHaveLength(1);
    expect(state.snakes[1].body).toHaveLength(1);
    expect(state.foods).toEqual([]);
    expect(c8Game.score(state)).toEqual([0, 0]);
    expect(state.snakes[0].alive && state.snakes[1].alive).toBe(true);
    expect(c8Game.isOver(state)).toBe(false);
    expect(c8Game.winner(state)).toBeNull();
    expect(state.outcome).toBeNull();
    expect(state.roundTick).toBe(-GRACE_TICKS);
    const human = state.snakes[0].body[0] as number;
    const ai = state.snakes[1].body[0] as number;
    expect([cellX(ai), cellY(ai)]).toEqual([31 - cellX(human), 23 - cellY(human)]);
    expect(state.snakes[1].dir).toBe(((state.snakes[0].dir + 2) % 4) as 0 | 1 | 2 | 3);
  });

  it('2. 開局先不動 30 個 tick（可以先轉向），之後每 MOVE_TICKS 個 tick 兩條蛇同時走一格', () => {
    let state = c8Game.init(3, CONFIG);
    const start = [state.snakes[0].body, state.snakes[1].body];
    state = run(state, GRACE_TICKS + BEFORE_MOVE, [PRESS_UP, PRESS_UP]);
    expect(state.snakes[0].body).toEqual(start[0]);
    expect(state.snakes[1].body).toEqual(start[1]);
    state = c8Game.step(state, IDLE);
    expect(state.snakes[0].body).toHaveLength(2);
    expect(state.snakes[1].body).toHaveLength(2);
  });

  it('3. 蛇只會變長、走過的格子永遠留著（軌跡不會消失）', () => {
    let state = makeState();
    for (let move = 1; move <= 8; move += 1) {
      state = run(state, MOVE_TICKS);
      expect(state.snakes[0].body).toHaveLength(1 + move);
      expect(state.snakes[1].body).toHaveLength(1 + move);
    }
    expect(state.snakes[0].body).toEqual(
      body([16, 12], [15, 12], [14, 12], [13, 12], [12, 12], [11, 12], [10, 12], [9, 12], [8, 12]),
    );
    expect(state.snakes[1].body[0]).toBe(cell(15, 11));
    expect(state.snakes[1].body.at(-1)).toBe(cell(23, 11));
  });

  it('4. 一局最多 720 個 tick；maxTicks 小到 200 也能開始，小於 200 丟 RangeError；整場是 maxTicks', () => {
    expect(ROUND_TICKS).toBe(720);
    const state = c8Game.init(0, { maxTicks: 200, params: {} });
    expect(state.maxTicks).toBe(200);
    expect(state.roundTicks).toBe(ROUND_TICKS);
    expect(() => c8Game.init(0, { maxTicks: 199, params: {} })).toThrow(RangeError);
  });
});

describe('C-8 光軌｜轉向', () => {
  it('5. 往右走時按左：方向不變；按上：下一次走格改成往上', () => {
    const reverse = run(makeState(), MOVE_TICKS, [PRESS_LEFT, NONE]);
    expect(head(reverse, 0)).toEqual([9, 12]);
    let state = makeState();
    state = c8Game.step(state, [PRESS_UP, NONE]);
    state = run(state, MOVE_TICKS - 1);
    expect(head(state, 0)).toEqual([8, 11]);
    expect(state.snakes[0].dir).toBe(UP);
  });

  it('6. 邊界：一格之內連按上再按左（原本往右）：只採用第一個有效的轉向', () => {
    let state = makeState();
    state = c8Game.step(state, [PRESS_UP, NONE]);
    state = c8Game.step(state, [PRESS_LEFT, NONE]);
    state = run(state, MOVE_TICKS - 2);
    expect(head(state, 0)).toEqual([8, 11]);
  });
});

describe('C-8 光軌｜出局與一局的勝負', () => {
  it('7. 撞牆：那條蛇出局，另一條贏這一局得 1 分；整場還沒結束，畫面停住 40 個 tick', () => {
    const state = c8Game.step(
      makeState({ roundTick: BEFORE_MOVE, snakes: [{ body: body([31, 5]), dir: RIGHT }] }),
      IDLE,
    );
    expect(state.outcome).toBe('side1');
    expect(state.snakes[0].alive).toBe(false);
    expect(state.snakes[1].alive).toBe(true);
    expect(c8Game.score(state)).toEqual([0, 1]);
    expect(state.pause).toBe(PAUSE_TICKS);
    expect(c8Game.isOver(state)).toBe(false);
  });

  it('8. 撞自己的軌跡：出局', () => {
    // 蛇頭 (5,5) 往上，剛從下面 (5,6) 過來，軌跡繞了一圈：(4,6)、(4,5)。鎖定往左轉，下一步 (4,5) 是自己的軌跡。
    const state = c8Game.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snakes: [{ body: body([5, 5], [5, 6], [4, 6], [4, 5]), dir: UP, turn: LEFT }],
      }),
      IDLE,
    );
    expect(state.snakes[0].alive).toBe(false);
    expect(state.outcome).toBe('side1');
  });

  it('9. 撞對方的軌跡：撞上去的出局，對方（走離開的方向）贏這一局', () => {
    const state = c8Game.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snakes: [
          { body: body([10, 12]), dir: RIGHT },
          { body: body([11, 14], [11, 13], [11, 12], [11, 11], [11, 10]), dir: DOWN },
        ],
      }),
      IDLE,
    );
    expect(state.snakes[0].alive).toBe(false);
    expect(state.snakes[1].alive).toBe(true);
    expect(head(state, 1)).toEqual([11, 15]);
    expect(c8Game.score(state)).toEqual([0, 1]);
  });

  it('10. 邊界：沒有尾巴豁免。走進對方「最後一格」（軌跡的起點）也算撞', () => {
    // 對方的蛇只有兩格：頭 (11,11)、最後一格 (11,12)，往上走。C-A 的蛇尾會移走所以不算撞；光軌的軌跡永遠不縮，所以算。
    const state = c8Game.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snakes: [
          { body: body([10, 12]), dir: RIGHT },
          { body: body([11, 11], [11, 12]), dir: UP },
        ],
      }),
      IDLE,
    );
    expect(state.snakes[0].alive).toBe(false);
    expect(state.snakes[1].alive).toBe(true);
  });

  it('11. 邊界：頭對頭（兩個新蛇頭同一格）：兩條都出局，這一局平手，沒有人得分', () => {
    const state = c8Game.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snakes: [
          { body: body([10, 12]), dir: RIGHT },
          { body: body([12, 12]), dir: LEFT },
        ],
      }),
      IDLE,
    );
    expect(state.snakes[0].alive || state.snakes[1].alive).toBe(false);
    expect(state.outcome).toBe('draw');
    expect(c8Game.score(state)).toEqual([0, 0]);
  });

  it('12. 邊界：兩個蛇頭互換位置（頭穿過頭）：兩條都出局，平手', () => {
    const state = c8Game.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snakes: [
          { body: body([10, 12]), dir: RIGHT },
          { body: body([11, 12]), dir: LEFT },
        ],
      }),
      IDLE,
    );
    expect(state.outcome).toBe('draw');
    expect(state.snakes[0].alive || state.snakes[1].alive).toBe(false);
  });

  it('13. 邊界：開局不動的 tick 內，即使蛇頭正對著牆也不會出局', () => {
    const state = run(
      makeState({
        roundTick: -GRACE_TICKS,
        snakes: [{ body: body([31, 5]), dir: RIGHT }],
      }),
      GRACE_TICKS + BEFORE_MOVE - 1,
    );
    expect(state.outcome).toBeNull();
    expect(state.snakes[0].alive).toBe(true);
  });

  it('14. 邊界：時間到沒人出局，兩邊地盤一樣大（起始位置 180 度對稱）：這一局平手，沒有人得分', () => {
    const state = c8Game.step(makeState({ roundTick: ROUND_TICKS - 1 }), IDLE);
    expect(state.outcome).toBe('draw');
    expect(state.snakes[0].alive && state.snakes[1].alive).toBe(true);
    expect(c8Game.score(state)).toEqual([0, 0]);
  });

  it('14b. 時間到沒人出局：地盤（誰先到的格子比較多）大的贏這一局；被軌跡圍住的格子不算', () => {
    // 人在中間 (8,12)，AI 縮在右下角 (30,22) 往右：人的地盤大得多。
    const humanBigger = c8Game.step(
      makeState({
        roundTick: ROUND_TICKS - 1,
        snakes: [{}, { body: body([30, 22]), dir: RIGHT }],
      }),
      IDLE,
    );
    expect(humanBigger.outcome).toBe('side0');
    expect(c8Game.score(humanBigger)).toEqual([1, 0]);
    // 反過來：AI 在中間、人縮在左上角
    const aiBigger = c8Game.step(
      makeState({
        roundTick: ROUND_TICKS - 1,
        snakes: [
          { body: body([1, 1]), dir: DOWN },
          { body: body([23, 11]), dir: LEFT },
        ],
      }),
      IDLE,
    );
    expect(aiBigger.outcome).toBe('side1');
    // 人把自己圍在一圈軌跡裡（蛇頭 (4,5)，圈裡只有 (5,5) 一格）：地盤只剩 1 格，輸給開闊的 AI
    const boxed = territoryOutcome([
      {
        body: body([4, 5], [4, 6], [5, 6], [6, 6], [6, 5], [6, 4], [5, 4], [4, 4]),
        dir: UP,
        turn: UP,
        alive: true,
        score: 0,
      },
      { body: body([20, 12]), dir: LEFT, turn: LEFT, alive: true, score: 0 },
    ]);
    expect(boxed).toBe('side1');
  });
});

describe('C-8 光軌｜60 秒內一局接一局', () => {
  /** 人撞牆（AI 贏這一局）／AI 撞牆（人贏這一局）；`scores` 是這一局開始前兩邊贏的局數。 */
  const humanCrash = (
    scores: [number, number] = [0, 0],
    overrides: Parameters<typeof makeState>[0] = {},
  ): C8State =>
    makeState({
      roundTick: BEFORE_MOVE,
      snakes: [{ body: body([31, 5]), dir: RIGHT, score: scores[0] }, { score: scores[1] }],
      ...overrides,
    });
  const aiCrash = (
    scores: [number, number] = [0, 0],
    overrides: Parameters<typeof makeState>[0] = {},
  ): C8State =>
    makeState({
      roundTick: BEFORE_MOVE,
      snakes: [{ score: scores[0] }, { body: body([0, 5]), dir: LEFT, score: scores[1] }],
      ...overrides,
    });

  it('15. 一局結束停 40 個 tick（畫面凍結），然後下一局：軌跡清掉、重新抽起始位置、分數留著、開局不動時間重新算', () => {
    let state = c8Game.step(aiCrash(), IDLE);
    const frozen = state.snakes;
    for (let i = 0; i < PAUSE_TICKS - 1; i += 1) {
      state = c8Game.step(state, [PRESS_UP, PRESS_DOWN]);
      expect(state.snakes).toEqual(frozen);
      expect(state.round).toBe(0);
    }
    state = c8Game.step(state, IDLE);
    expect(state.round).toBe(1);
    expect(state.pause).toBe(0);
    expect(state.outcome).toBeNull();
    expect(state.roundTick).toBe(-GRACE_TICKS);
    expect(state.snakes[0].body).toHaveLength(1);
    expect(state.snakes[1].body).toHaveLength(1);
    expect(state.snakes[0].alive && state.snakes[1].alive).toBe(true);
    expect(c8Game.score(state)).toEqual([1, 0]);
    expect(c8Game.isOver(state)).toBe(false);
  });

  it('16. 贏了很多局也不會提早結束：整場只有時間到才結束（局數沒有上限）', () => {
    const state = c8Game.step(aiCrash([5, 0], { tick: 1000, round: 5 }), IDLE);
    expect(c8Game.score(state)).toEqual([6, 0]);
    expect(c8Game.isOver(state)).toBe(false);
    expect(state.pause).toBe(PAUSE_TICKS);
  });

  it('17. 時間到（第 maxTicks 個 tick）：整場結束，贏的局數多的贏；進行到一半的那一局不算分', () => {
    const state = c8Game.step(
      makeState({ tick: 3599, round: 7, roundTick: 100, snakes: [{ score: 4 }, { score: 3 }] }),
      IDLE,
    );
    expect(state.tick).toBe(3600);
    expect(c8Game.isOver(state)).toBe(true);
    expect(c8Game.score(state)).toEqual([4, 3]);
    expect(c8Game.winner(state)).toBe(0);
    const behind = c8Game.step(
      makeState({ tick: 3599, snakes: [{ score: 2 }, { score: 5 }] }),
      IDLE,
    );
    expect(c8Game.winner(behind)).toBe(1);
  });

  it('18. 邊界：最後一個 tick 剛好有人撞牆：這一局先算分，再算時間到', () => {
    const state = c8Game.step(humanCrash([3, 3], { tick: 3599 }), IDLE);
    expect(c8Game.isOver(state)).toBe(true);
    expect(c8Game.score(state)).toEqual([3, 4]);
    expect(c8Game.winner(state)).toBe(1);
  });

  it('19. 邊界：時間到時同分：平手（winner 是 null）；時間到之後再 step 狀態不變', () => {
    const state = c8Game.step(
      makeState({ tick: 3599, snakes: [{ score: 2 }, { score: 2 }] }),
      IDLE,
    );
    expect(c8Game.isOver(state)).toBe(true);
    expect(c8Game.winner(state)).toBeNull();
    expect(c8Game.step(state, [PRESS_UP, PRESS_DOWN])).toEqual(state);
  });

  it('20. 打完整場：兩個照固定規律亂按的控制器，整場剛好 3600 個 tick，局數不止一局，分數是各自贏的局數', () => {
    for (let seed = 0; seed < 6; seed += 1) {
      let state = c8Game.init(seed, CONFIG);
      let tick = 0;
      while (!c8Game.isOver(state) && tick < 3700) {
        const pick = (side: 0 | 1): Buttons => {
          const actions = c8Game.actions(state, side);
          return copyButtons(actions[(tick * 7 + seed + side * 3) % actions.length] as Buttons);
        };
        state = c8Game.step(state, [pick(0), pick(1)]);
        tick += 1;
      }
      expect(state.tick).toBe(3600);
      expect(c8Game.isOver(state)).toBe(true);
      expect(state.round).toBeGreaterThan(1);
      const [a, b] = c8Game.score(state);
      expect(a + b).toBeLessThanOrEqual(state.round + 1);
    }
  });
});

describe('C-8 光軌｜起始位置與隨機', () => {
  /** 打到下一局開始：人撞牆、停頓走完。 */
  function nextRound(state: C8State): C8State {
    const crashing: C8State = {
      ...state,
      roundTick: BEFORE_MOVE,
      snakes: [
        { ...state.snakes[0], body: body([31, 5]), dir: RIGHT, turn: RIGHT },
        state.snakes[1],
      ],
    };
    return run(crashing, 1 + PAUSE_TICKS);
  }

  it('21. 起始位置：離牆至少 5 格、蛇頭相距至少 12 格；AI 是把人轉 180 度；每一局都成立（30 個種子）', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      let state = c8Game.init(seed, CONFIG);
      for (const round of [0, 1]) {
        expect(state.round).toBe(round);
        const human = state.snakes[0].body[0] as number;
        const ai = state.snakes[1].body[0] as number;
        for (const at of [human, ai]) {
          expect(
            Math.min(cellX(at), 31 - cellX(at), cellY(at), 23 - cellY(at)),
          ).toBeGreaterThanOrEqual(START_MARGIN);
        }
        expect(
          Math.abs(cellX(human) - cellX(ai)) + Math.abs(cellY(human) - cellY(ai)),
        ).toBeGreaterThanOrEqual(MIN_START_GAP);
        expect([cellX(ai), cellY(ai)]).toEqual([31 - cellX(human), 23 - cellY(human)]);
        expect(state.snakes[1].dir).toBe(((state.snakes[0].dir + 2) % 4) as 0 | 1 | 2 | 3);
        state = nextRound(state);
      }
    }
  });

  it('22. 隨機事件在不同種子下不全相同：10 個種子的第一局起始位置與方向都不可以全部一樣', () => {
    const layouts = new Set<string>();
    const dirs = new Set<number>();
    for (let seed = 0; seed < 10; seed += 1) {
      const state = c8Game.init(seed, CONFIG);
      layouts.add(String(state.snakes[0].body[0]));
      dirs.add(state.snakes[0].dir);
    }
    expect(layouts.size).toBeGreaterThan(1);
    expect(dirs.size).toBeGreaterThan(1);
  });

  it('23. 連續兩個隨機事件也不可以相同：第二局的起始位置與第一局不全相同，而且亂數狀態有寫回 state', () => {
    let differ = 0;
    const seconds = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const first = c8Game.init(seed, CONFIG);
      const second = nextRound(first);
      expect(second.rng).not.toBe(first.rng);
      if (second.snakes[0].body[0] !== first.snakes[0].body[0]) {
        differ += 1;
      }
      seconds.add(String(second.snakes[0].body[0]));
    }
    expect(differ).toBeGreaterThan(0);
    expect(seconds.size).toBeGreaterThan(1);
  });

  it('24. 同一個種子，初始 state 完全相同', () => {
    expect(c8Game.init(7, CONFIG)).toEqual(c8Game.init(7, CONFIG));
  });
});

describe('C-8 光軌｜actions 與 evaluate', () => {
  it('25. actions：還沒鎖定轉向時三個動作（兩個轉向與全放開）；已鎖定、局結束、停頓時只有「全放開」', () => {
    const open = makeState();
    for (const side of [0, 1] as const) {
      const actions = c8Game.actions(open, side);
      expect(actions).toHaveLength(3);
      expect(new Set(actions.map((a) => JSON.stringify(a))).size).toBe(3);
      expect(actions).toContainEqual(NONE);
    }
    const locked = c8Game.step(open, [PRESS_UP, NONE]);
    expect(c8Game.actions(locked, 0)).toEqual([NONE]);
    const ended = c8Game.step(
      makeState({ roundTick: BEFORE_MOVE, snakes: [{ body: body([31, 5]), dir: RIGHT }] }),
      IDLE,
    );
    expect(c8Game.actions(ended, 0)).toEqual([NONE]);
    expect(c8Game.actions(ended, 1)).toEqual([NONE]);
  });

  it('26. actions 的順序：較空的那一邊的轉向排第一、另一邊第二、全放開最後', () => {
    // 人在 (8,3) 往右：往上只有 3 格就是牆，往下有 20 格。
    const nearTop = makeState({ snakes: [{ body: body([8, 3]), dir: RIGHT }] });
    expect(c8Game.actions(nearTop, 0)).toEqual([PRESS_DOWN, PRESS_UP, NONE]);
    const nearBottom = makeState({ snakes: [{ body: body([8, 20]), dir: RIGHT }] });
    expect(c8Game.actions(nearBottom, 0)).toEqual([PRESS_UP, PRESS_DOWN, NONE]);
  });

  it('27. danger：下一步走出地圖或走進軌跡是 1（gain 很低但有限）；開闊的地方接近 0', () => {
    const wall = makeState({ snakes: [{ body: body([31, 12]), dir: RIGHT }] });
    expect(c8Game.evaluate(wall, 0).danger).toBe(1);
    expect(Number.isFinite(c8Game.evaluate(wall, 0).gain)).toBe(true);
    const trail = makeState({
      snakes: [
        { body: body([10, 12]), dir: RIGHT },
        { body: body([11, 13], [11, 12]), dir: UP },
      ],
    });
    expect(c8Game.evaluate(trail, 0).danger).toBe(1);
    expect(c8Game.evaluate(makeState(), 0).danger).toBeLessThan(0.1);
  });

  it('28. danger：往一個只剩 2 格的口袋走，介於 0 與 1 之間而且很高；往開闊處走是 0', () => {
    // 人在 (10,10) 往右。對方的軌跡圍出 U 形口袋：(11,11) (12,11) (13,11) (13,10) (13,9) (12,9) (11,9)，它的蛇頭在 (11,11) 往下走，口袋裡是 (11,10)、(12,10)。
    const pocket = [
      cell(11, 11),
      cell(12, 11),
      cell(13, 11),
      cell(13, 10),
      cell(13, 9),
      cell(12, 9),
      cell(11, 9),
    ];
    const state = makeState({
      snakes: [
        { body: body([10, 10]), dir: RIGHT },
        { body: pocket, dir: DOWN },
      ],
    });
    const into = c8Game.evaluate(state, 0);
    expect(into.danger).toBeGreaterThan(0.5);
    expect(into.danger).toBeLessThan(1);
    const away = c8Game.evaluate(c8Game.step(state, [PRESS_UP, NONE]), 0);
    expect(away.danger).toBeLessThan(0.1);
    expect(ROOM_CAP).toBeGreaterThan(2);
  });

  it('28b. danger：前方 10 格內有牆越近越高，10 格以上是 0；對方蛇頭離我的下一步越近越高', () => {
    const ahead = (x: number): number =>
      c8Game.evaluate(makeState({ snakes: [{ body: body([x, 12]), dir: RIGHT }] }), 0).danger;
    expect(ahead(10)).toBe(0);
    expect(ahead(24)).toBeGreaterThan(0);
    expect(ahead(28)).toBeGreaterThan(ahead(24));
    expect(ahead(30)).toBeGreaterThan(ahead(28));
    expect(ahead(31)).toBe(1);
    // 我在 (10,12) 往右，下一步 (11,12)。對方在 (x,13) 往上，下一步在 (x,12)：x = 12、13、15 離我 1、2、4 格。
    const near = (aiHeadX: number): number =>
      c8Game.evaluate(
        makeState({
          snakes: [
            { body: body([10, 12]), dir: RIGHT },
            { body: body([aiHeadX, 13]), dir: UP },
          ],
        }),
        0,
      ).danger;
    expect(near(12)).toBeGreaterThan(near(13));
    expect(near(13)).toBeGreaterThan(near(15));
    expect(near(15)).toBe(0);
  });

  it('28d. 打平時優先直走：兩個局面的下一步一樣，只有「最後一步是不是轉了彎」不同，轉彎的 gain 低（扣 TURN_PENALTY 左右）', () => {
    const straight = makeState({
      snakes: [
        { body: body([10, 10], [9, 10], [8, 10]), dir: RIGHT },
        { body: body([25, 5]), dir: LEFT },
      ],
    });
    const turned = makeState({
      snakes: [
        { body: body([10, 10], [10, 11], [9, 11]), dir: RIGHT },
        { body: body([25, 5]), dir: LEFT },
      ],
    });
    const gap = c8Game.evaluate(straight, 0).gain - c8Game.evaluate(turned, 0).gain;
    expect(TURN_PENALTY).toBeGreaterThan(0);
    expect(gap).toBeGreaterThan(TURN_PENALTY / 2);
    expect(gap).toBeLessThan(TURN_PENALTY * 2);
  });

  it('28c. 性格的習慣：下一步就是牆時，搜尋型、精準型、貪心型都轉向；賭徒型（落後就偏好高 danger）會直接撞上去', () => {
    // 人在 (31,12) 往右，下一步走出地圖：直走的 gain 是 −500、danger 是 1。賭徒型的效用是 gain 平移之後乘上 (1 + r·danger)，
    // 落後（這個局面的 gain 是負的）時 r 大，danger 1 的動作效用最高。這是 SPEC 7.1 的賭徒型，不是這張牌的錯；它是性格可以辨認的地方。
    const state = makeState({ snakes: [{ body: body([31, 12]), dir: RIGHT }] });
    const turns = (name: 'pathfinder' | 'precise' | 'greedy' | 'gambler'): boolean => {
      const pressed = policyByName(name).decide(c8Game, state, 0, 0, { depth: 6, seed: 1 });
      return pressed.up || pressed.down;
    };
    expect(turns('pathfinder')).toBe(true);
    expect(turns('precise')).toBe(true);
    expect(turns('greedy')).toBe(true);
    expect(turns('gambler')).toBe(false);
  });

  it('29. gain：領地差。離牆越遠越高；對方的蛇頭離得越近（搶走越多格）越低', () => {
    const at = (x: number, y: number, other: [number, number]): number =>
      c8Game.evaluate(
        makeState({
          snakes: [
            { body: body([x, y]), dir: RIGHT },
            { body: body(other), dir: LEFT },
          ],
        }),
        0,
      ).gain;
    expect(at(14, 12, [28, 12])).toBeGreaterThan(at(14, 1, [28, 12]));
    expect(at(14, 12, [28, 12])).toBeGreaterThan(at(14, 12, [18, 12]));
    expect(at(14, 12, [28, 22])).toBeGreaterThan(at(14, 12, [20, 14]));
  });

  it('30. 一局結束：贏的 gain 為正、輸的為負、平手為 0；出局的 danger 是 1', () => {
    const won = c8Game.step(
      makeState({ roundTick: BEFORE_MOVE, snakes: [{ body: body([31, 5]), dir: RIGHT }] }),
      IDLE,
    );
    expect(c8Game.evaluate(won, 1).gain).toBeGreaterThan(0);
    expect(c8Game.evaluate(won, 0).gain).toBeLessThan(0);
    expect(c8Game.evaluate(won, 0).danger).toBe(1);
    expect(c8Game.evaluate(won, 1).danger).toBe(0);
    const drawn = c8Game.step(
      makeState({
        roundTick: BEFORE_MOVE,
        snakes: [
          { body: body([10, 12]), dir: RIGHT },
          { body: body([12, 12]), dir: LEFT },
        ],
      }),
      IDLE,
    );
    expect(c8Game.evaluate(drawn, 0).gain).toBe(0);
  });

  it('31. 沒有橡皮筋：兩邊贏的局數不同的兩個局面，evaluate 與 actions 完全相同', () => {
    const a = makeState({ round: 1, snakes: [{ score: 0 }, { score: 0 }] });
    const b = makeState({ round: 1, snakes: [{ score: 1 }, { score: 0 }] });
    const c = makeState({ round: 1, snakes: [{ score: 0 }, { score: 1 }] });
    for (const side of [0, 1] as const) {
      expect(c8Game.evaluate(a, side)).toEqual(c8Game.evaluate(b, side));
      expect(c8Game.evaluate(a, side)).toEqual(c8Game.evaluate(c, side));
      expect(c8Game.actions(a, side)).toEqual(c8Game.actions(b, side));
    }
  });

  it('32. 搜尋型（往前看 6 個 tick）面對牆會轉向，不會直直撞上去', () => {
    const state = makeState({ snakes: [{ body: body([30, 12]), dir: RIGHT }] });
    for (const depth of [1, 3, 6]) {
      const pressed = pathfinder.decide(c8Game, state, 0, 0, { depth, seed: 0 });
      expect(pressed.up || pressed.down).toBe(true);
    }
  });

  it('33. 互動強度（準則 2.5）：把 AI 的位置換成另一個合法的位置，人這一邊最好的動作至少 20% 的局面會因此改變', () => {
    // 從搜尋型對搜尋型的對局裡，每 18 個 tick 取一個還在進行的局面（24 個種子）；
    // 對每個局面，把 AI 的蛇頭往上下左右各搬 3 格（搬到空格才算合法的位置），用 1 步的 evaluate 算人這一邊最好的動作。
    let sampled = 0;
    let changed = 0;
    for (let seed = 0; seed < 24; seed += 1) {
      const players = [0, 1].map((side) => levelController(c8Game, pathfinder, 5, seed * 2 + side));
      let state = c8Game.init(seed, CONFIG);
      for (let tick = 0; tick < 3600 && !c8Game.isOver(state); tick += 1) {
        const inputs: Inputs = [
          copyButtons(players[0]?.decide(state, 0, tick) as Buttons),
          copyButtons(players[1]?.decide(state, 1, tick) as Buttons),
        ];
        if (tick % 18 === 0 && state.roundTick > 0 && state.outcome === null) {
          const mine = c8Game.actions(state, 0);
          const taken = new Set([...state.snakes[0].body, ...state.snakes[1].body]);
          const aiHead = state.snakes[1].body[0] as number;
          const bestWith = (moved: C8State): number => {
            let best = 0;
            let bestGain = Number.NEGATIVE_INFINITY;
            mine.forEach((action, index) => {
              const { gain } = c8Game.evaluate(c8Game.step(moved, [action, NONE]), 0);
              if (gain > bestGain) {
                bestGain = gain;
                best = index;
              }
            });
            return best;
          };
          const picks = new Set<number>([bestWith(state)]);
          for (const [dx, dy] of [
            [3, 0],
            [-3, 0],
            [0, 3],
            [0, -3],
          ] as const) {
            const x = cellX(aiHead) + dx;
            const y = cellY(aiHead) + dy;
            if (x < 0 || x > 31 || y < 0 || y > 23 || taken.has(cell(x, y))) {
              continue;
            }
            const ai = state.snakes[1];
            picks.add(
              bestWith({
                ...state,
                snakes: [state.snakes[0], { ...ai, body: [cell(x, y), ...ai.body.slice(1)] }],
              }),
            );
          }
          if (mine.length > 1) {
            sampled += 1;
            if (picks.size > 1) {
              changed += 1;
            }
          }
        }
        state = c8Game.step(state, inputs);
      }
    }
    expect(sampled).toBeGreaterThan(100);
    expect(changed / sampled).toBeGreaterThanOrEqual(0.2);
  }, 60_000);
});

describe('C-8 光軌｜純度與畫面', () => {
  it('34. step 不改動傳進來的 state（凍結之後照樣能 step，連停頓與結束的 tick 也是）', () => {
    const ended = c8Game.step(
      makeState({ roundTick: BEFORE_MOVE, snakes: [{ body: body([31, 5]), dir: RIGHT }] }),
      IDLE,
    );
    for (const state of [
      c8Game.init(4, CONFIG),
      makeState({ roundTick: BEFORE_MOVE }),
      ended,
      makeState({
        round: 1,
        roundTick: BEFORE_MOVE,
        snakes: [{ score: 1 }, { body: body([0, 5]), dir: LEFT }],
      }),
    ]) {
      const before = JSON.stringify(state);
      deepFreeze(state);
      expect(() => c8Game.step(state, [PRESS_UP, PRESS_DOWN])).not.toThrow();
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it('35. render：畫得出來、不改 state、座標都在畫布之內；軌跡的每一格都有畫', () => {
    const state = run(makeState(), MOVE_TICKS * 5);
    const before = JSON.stringify(state);
    const fake = createFakeContext();
    c8Render(asRenderingContext(fake), state);
    expect(JSON.stringify(state)).toBe(before);
    const used = fake.colors.filter((c) => c.via === 'set').map((c) => String(c.value));
    expect(used).toContain(COLOR.clubs);
    expect(used).toContain(COLOR.accent);
    // 人的軌跡 (8..13,12)：每一格附近都有繪圖點
    for (let x = 8; x <= 13; x += 1) {
      const near = fake.points.filter(
        (p) => p.x >= x * 10 - 1 && p.x <= x * 10 + 11 && p.y >= 119 && p.y <= 131,
      );
      expect(near.length).toBeGreaterThan(0);
    }
    for (const p of fake.points) {
      expect(p.x).toBeGreaterThanOrEqual(-8);
      expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
      expect(p.y).toBeGreaterThanOrEqual(-8);
      expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
    }
  });
});
