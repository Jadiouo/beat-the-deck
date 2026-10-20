import { describe, expect, it } from 'vitest';

import type { Buttons, Inputs } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { deepFreeze } from '../../../tests/contract/freeze';
import { COLOR } from '../../shell/palette';
import { cell, cellX, cellY } from '../_clubs/logic';
import {
  AIM_EVERY,
  AIM_LEAD,
  DRONE_EVERY,
  DRONE_TTL,
  IMMUNE_TICKS,
  LOCK_MOVES,
  RELOAD,
  START_RELOAD,
  aimPoint,
  createCQGame,
  cqGame,
  makeState,
} from './logic';
import type { CQState } from './logic';
import { cqMeta } from './meta';
import { cqRender } from './render';

/**
 * C-Q 兩條蛇的規則測試（小規格 `docs/cards/C-Q.md`「量測計畫與先寫的測試」）。
 *
 * 座標是格子 (x, y)。蛇每 6 個 tick 走一格：`tick: 5` 表示下一次 step 就走格。
 * `makeState` 的預設：兩邊 `reload = 0`（可以放）、沒有僚機、沒有鎖定，方便測試；
 * 真正的開局 `reload = START_RELOAD` 由 `init` 測。
 * 預設的蛇：人 (5,12) 往右、AI (26,11) 往左，各 3 格；食物在 (15,3) 與 (15,20)。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const A: Buttons = { ...NONE, a: true };
const UP_KEY: Buttons = { ...NONE, up: true };
const DOWN_KEY: Buttons = { ...NONE, down: true };
const IDLE: Inputs = [NONE, NONE];

const UP = 0;
const RIGHT = 1;
const DOWN = 2;
const LEFT = 3;

function run(game: typeof cqGame, state: CQState, ticks: number, inputs: Inputs = IDLE): CQState {
  let current = state;
  for (let i = 0; i < ticks; i += 1) {
    current = game.step(current, inputs);
  }
  return current;
}

describe('C-Q 兩條蛇｜init', () => {
  it('開局：兩邊 reload = 300、沒有僚機、沒有鎖定與免疫、計數為 0、aHeld 為 false', () => {
    const state = cqGame.init(0, CONFIG);
    expect(START_RELOAD).toBe(300);
    expect(state.reload).toEqual([300, 300]);
    expect(state.drone).toEqual([null, null]);
    expect(state.lock).toEqual([0, 0]);
    expect(state.immune).toEqual([0, 0]);
    expect(state.hits).toEqual([0, 0]);
    expect(state.launches).toEqual([0, 0]);
    expect(state.aHeld).toEqual([false, false]);
    expect(state.snakes[0].body).toHaveLength(3);
    expect(state.foods).toHaveLength(2);
  });

  it('種子 0..9 的食物位置不全相同', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      seen.add(cqGame.init(seed, CONFIG).foods.join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('常數是小規格的起始值', () => {
    expect([RELOAD, DRONE_EVERY, AIM_EVERY, AIM_LEAD, DRONE_TTL, LOCK_MOVES, IMMUNE_TICKS]).toEqual(
      [480, 9, 24, 4, 300, 3, 60],
    );
  });
});

describe('C-Q 兩條蛇｜放出', () => {
  it('reload = 0、待命、這個 tick 按 a：僚機從主蛇尾端那一格出發，reload = 480，launches = 1', () => {
    const state = makeState({ tick: 0 });
    const tailBefore = state.snakes[0].body[2] as number;
    const next = cqGame.step(state, [A, NONE]);
    expect(next.drone[0]).not.toBeNull();
    expect((next.drone[0] as { cell: number }).cell).toBe(tailBefore);
    expect(next.reload).toEqual([RELOAD, 0]);
    expect(next.launches).toEqual([1, 0]);
    expect(next.aHeld).toEqual([true, false]);
    expect(next.drone[1]).toBeNull();
  });

  it('放出的那個 tick 就算好 aim：對手蛇頭沿行進方向再走 4 格', () => {
    const next = cqGame.step(makeState({ tick: 0 }), [A, NONE]);
    // AI 蛇頭 (26,11) 往左 → (22,11)
    expect((next.drone[0] as { aim: number }).aim).toBe(cell(22, 11));
  });

  it('reload > 0 時按 a 沒有效果', () => {
    const next = cqGame.step(makeState({ tick: 0, reload: [10, 0] }), [A, NONE]);
    expect(next.drone[0]).toBeNull();
    expect(next.launches).toEqual([0, 0]);
    expect(next.reload).toEqual([9, 0]);
  });

  it('僚機已經在場上時按 a 沒有效果（不會再放第二台）', () => {
    const state = makeState({
      tick: 0,
      drone: [{ cell: cell(10, 5), tail: [], aim: cell(20, 5), ttl: 200, nextAim: 100 }, null],
    });
    const next = cqGame.step(state, [A, NONE]);
    expect(next.launches).toEqual([0, 0]);
    expect(next.reload).toEqual([0, 0]);
  });

  it('邊緣觸發：上一個 tick 就按著 a（aHeld）時不會放；放開再按才放', () => {
    const held = makeState({ tick: 0, aHeld: [true, false] });
    expect(cqGame.step(held, [A, NONE]).drone[0]).toBeNull();
    const released = cqGame.step(held, [NONE, NONE]);
    expect(released.aHeld).toEqual([false, false]);
    expect(cqGame.step(released, [A, NONE]).drone[0]).not.toBeNull();
  });

  it('按住 a 整個冷卻期都不會連放（放出後 reload = 480 擋住）', () => {
    const state = run(cqGame, makeState({ tick: 0 }), 100, [A, NONE]);
    expect(state.launches).toEqual([1, 0]);
  });

  it('兩邊對稱：AI 那一邊按 a 同樣可以放（從它的尾端出發，瞄準人的蛇頭往右 4 格）', () => {
    const state = makeState({ tick: 0 });
    const next = cqGame.step(state, [NONE, A]);
    expect(next.launches).toEqual([0, 1]);
    expect((next.drone[1] as { cell: number }).cell).toBe(state.snakes[1].body[2]);
    expect((next.drone[1] as { aim: number }).aim).toBe(cell(9, 12));
  });

  it('死掉的蛇、結束的局不能放', () => {
    const dead = makeState({ tick: 0, snakes: [{ alive: false }, {}] });
    expect(cqGame.step(dead, [A, NONE]).launches).toEqual([0, 0]);
    const over = makeState({ tick: 0, over: true });
    expect(cqGame.step(over, [A, NONE])).toBe(over);
  });
});

describe('C-Q 兩條蛇｜瞄準', () => {
  it('aimPoint：蛇頭沿 dir 走 AIM_LEAD 格；用 dir 不用 turn', () => {
    const snake = makeState({
      snakes: [{ body: [cell(10, 10), cell(9, 10), cell(8, 10)], dir: RIGHT, turn: UP }, {}],
    }).snakes[0];
    expect(aimPoint(snake)).toBe(cell(14, 10));
  });

  it('aimPoint：走到地圖邊界就停在邊界內的最後一格', () => {
    const right = makeState({
      snakes: [{ body: [cell(30, 10), cell(29, 10), cell(28, 10)], dir: RIGHT }, {}],
    }).snakes[0];
    expect(aimPoint(right)).toBe(cell(31, 10));
    const up = makeState({
      snakes: [{ body: [cell(10, 2), cell(10, 3), cell(10, 4)], dir: UP }, {}],
    }).snakes[0];
    expect(aimPoint(up)).toBe(cell(10, 0));
    const down = makeState({
      snakes: [{ body: [cell(10, 22), cell(10, 21), cell(10, 20)], dir: DOWN }, {}],
    }).snakes[0];
    expect(aimPoint(down)).toBe(cell(10, 23));
    const left = makeState({
      snakes: [{ body: [cell(1, 10), cell(2, 10), cell(3, 10)], dir: LEFT }, {}],
    }).snakes[0];
    expect(aimPoint(left)).toBe(cell(0, 10));
  });

  it('aim 每 AIM_EVERY（24）tick 才更新一次：沒到更新的 tick，蛇轉彎了 aim 也不動；到了就更新', () => {
    // AI 蛇頭 (26,11) 往左；僚機瞄準 (22,11)，下一次更新在 tick 24
    let state = cqGame.step(makeState({ tick: 0 }), [A, NONE]);
    const first = (state.drone[0] as { aim: number }).aim;
    expect((state.drone[0] as { nextAim: number }).nextAim).toBe(1 + AIM_EVERY);
    // 讓 AI 的蛇轉向上（在第 6 個 tick 走格時轉）：aim 在 tick 25 之前都不該變
    for (let i = 0; i < 22; i += 1) {
      state = cqGame.step(state, [NONE, i === 3 ? UP_KEY : NONE]);
      expect((state.drone[0] as { aim: number }).aim).toBe(first);
    }
    expect(state.tick).toBe(23);
    state = cqGame.step(state, IDLE);
    state = cqGame.step(state, IDLE);
    expect(state.tick).toBe(25);
    const updated = state.drone[0] as { aim: number };
    const head = state.snakes[1].body[0] as number;
    expect(state.snakes[1].dir).toBe(UP);
    expect(updated.aim).toBe(cell(cellX(head), Math.max(0, cellY(head) - AIM_LEAD)));
  });
});

describe('C-Q 兩條蛇｜飛行', () => {
  const drone = (x: number, y: number, ax: number, ay: number, ttl = DRONE_TTL) => ({
    cell: cell(x, y),
    tail: [] as number[],
    aim: cell(ax, ay),
    ttl,
    nextAim: 100000,
  });

  it('每 9 個 tick 才走一格（前 8 個 tick 不動，第 9 個 tick 動）', () => {
    let state = makeState({ tick: 1, drone: [drone(10, 5, 20, 5), null] });
    for (let i = 0; i < 8; i += 1) {
      state = cqGame.step(state, IDLE);
      expect((state.drone[0] as { cell: number }).cell).toBe(cell(10, 5));
    }
    state = cqGame.step(state, IDLE);
    expect((state.drone[0] as { cell: number }).cell).toBe(cell(11, 5));
  });

  it('橫向與縱向差距比較大的軸先走；相等時橫向先', () => {
    const step9 = (d: ReturnType<typeof drone>): number =>
      (run(cqGame, makeState({ tick: 1, drone: [d, null] }), 9).drone[0] as { cell: number }).cell;
    expect(step9(drone(10, 5, 12, 12))).toBe(cell(10, 6)); // dx=2 dy=7 → 縱向
    expect(step9(drone(10, 5, 18, 7))).toBe(cell(11, 5)); // dx=8 dy=2 → 橫向
    expect(step9(drone(10, 5, 13, 8))).toBe(cell(11, 5)); // 3 對 3 → 橫向
    expect(step9(drone(10, 5, 7, 8))).toBe(cell(9, 5)); // 往左
    expect(step9(drone(10, 5, 10, 2))).toBe(cell(10, 4)); // 往上
  });

  it('已經在 aim 上就停著', () => {
    const state = run(cqGame, makeState({ tick: 1, drone: [drone(10, 5, 10, 5), null] }), 9);
    expect((state.drone[0] as { cell: number }).cell).toBe(cell(10, 5));
  });

  it('尾巴記前兩個位置（只給畫面用）', () => {
    const state = run(cqGame, makeState({ tick: 1, drone: [drone(10, 5, 20, 5), null] }), 18);
    const d = state.drone[0] as { cell: number; tail: readonly number[] };
    expect(d.cell).toBe(cell(12, 5));
    expect(d.tail).toEqual([cell(11, 5), cell(10, 5)]);
  });

  it('是幽靈：穿過自己的主蛇、對手的蛇身以外的東西都沒有反應，自己的主蛇不會被鎖', () => {
    // 人的僚機停在人自己的蛇身上
    const state = makeState({
      tick: 0,
      drone: [drone(4, 12, 4, 12), null],
    });
    const next = run(cqGame, state, 12);
    expect(next.lock).toEqual([0, 0]);
    expect(next.drone[0]).not.toBeNull();
    expect(next.hits).toEqual([0, 0]);
  });

  it('壽命到了消失，不補冷卻（reload 照 8 秒算）', () => {
    const launched = cqGame.step(makeState({ tick: 0, snakes: [{}, { alive: true }] }), [A, NONE]);
    expect(launched.reload[0]).toBe(RELOAD);
    // 把 AI 的蛇移到僚機碰不到的地方：直接拿 ttl 快到的狀態測
    const dying = makeState({
      tick: 0,
      reload: [123, 0],
      drone: [{ ...drone(2, 2, 2, 2), ttl: 2 }, null],
    });
    const one = cqGame.step(dying, IDLE);
    expect(one.drone[0]).not.toBeNull();
    const two = cqGame.step(one, IDLE);
    expect(two.drone[0]).toBeNull();
    expect(two.reload[0]).toBe(121);
  });
});

describe('C-Q 兩條蛇｜命中、鎖定、免疫', () => {
  /** AI 蛇頭在 (20,10) 往左，身體 (21,10)(22,10)；人遠在左邊。僚機是人的。 */
  const target = (extra: Partial<Parameters<typeof makeState>[0]> = {}) =>
    makeState({
      tick: 0,
      snakes: [
        { body: [cell(5, 20), cell(4, 20), cell(3, 20)], dir: RIGHT },
        { body: [cell(20, 10), cell(21, 10), cell(22, 10)], dir: LEFT },
      ],
      ...extra,
    });

  const dr = (x: number, y: number, ttl = 100) => ({
    cell: cell(x, y),
    tail: [] as number[],
    aim: cell(x, y),
    ttl,
    nextAim: 100000,
  });

  it('僚機所在格子與對手任何一格（蛇身也算）相同：對手 lock = 3，僚機消失，hits + 1', () => {
    const next = cqGame.step(target({ drone: [dr(21, 10), null] }), IDLE);
    expect(next.lock).toEqual([0, LOCK_MOVES]);
    expect(next.drone[0]).toBeNull();
    expect(next.hits).toEqual([1, 0]);
  });

  it('對手蛇走進僚機的格子也算命中（先走主蛇、再用走完之後的位置判）', () => {
    const state = target({ tick: 5, drone: [dr(19, 10), null] });
    const next = cqGame.step(state, IDLE);
    expect(next.snakes[1].body[0]).toBe(cell(19, 10));
    expect(next.lock).toEqual([0, LOCK_MOVES]);
    expect(next.drone[0]).toBeNull();
  });

  it('同一個 tick：蛇尾離開的格子不算（先走主蛇，僚機落在已經空出來的尾巴格上沒有命中）', () => {
    // 走格時尾巴 (22,10) 空出來；僚機停在 (22,10)
    const next = cqGame.step(target({ tick: 5, drone: [dr(22, 10), null] }), IDLE);
    expect(next.lock).toEqual([0, 0]);
    expect(next.drone[0]).not.toBeNull();
  });

  it('鎖定中：轉向輸入被忽略，連續 3 次走格都直走；之後可以轉', () => {
    let state = target({ lock: [0, LOCK_MOVES] });
    // 第 1 次走格（tick 6）按上
    state = run(cqGame, state, 6, [NONE, UP_KEY]);
    expect(state.snakes[1].body[0]).toBe(cell(19, 10));
    expect(state.lock[1]).toBe(2);
    state = run(cqGame, state, 6, [NONE, DOWN_KEY]);
    expect(state.snakes[1].body[0]).toBe(cell(18, 10));
    expect(state.lock[1]).toBe(1);
    state = run(cqGame, state, 6, [NONE, UP_KEY]);
    expect(state.snakes[1].body[0]).toBe(cell(17, 10));
    expect(state.lock[1]).toBe(0);
    expect(state.immune[1]).toBe(IMMUNE_TICKS);
    // 第 4 次可以轉
    state = run(cqGame, state, 6, [NONE, UP_KEY]);
    expect(state.snakes[1].body[0]).toBe(cell(17, 9));
  });

  it('鎖定開始時已經按好、還沒走出去的轉向也作廢', () => {
    const state = target({
      tick: 3,
      snakes: [
        { body: [cell(5, 20), cell(4, 20), cell(3, 20)], dir: RIGHT },
        { body: [cell(20, 10), cell(21, 10), cell(22, 10)], dir: LEFT, turn: UP },
      ],
      drone: [dr(21, 10), null],
    });
    const hit = cqGame.step(state, IDLE);
    expect(hit.lock[1]).toBe(LOCK_MOVES);
    expect(hit.snakes[1].turn).toBe(hit.snakes[1].dir);
  });

  it('鎖定本身不致命，致命的是前面有牆：被鎖定的蛇直直撞上牆就死，對手贏', () => {
    const state = makeState({
      tick: 5,
      lock: [0, 2],
      snakes: [
        { body: [cell(5, 20), cell(4, 20), cell(3, 20)], dir: RIGHT },
        { body: [cell(0, 10), cell(1, 10), cell(2, 10)], dir: LEFT },
      ],
    });
    const next = cqGame.step(state, [NONE, UP_KEY]);
    expect(next.over).toBe(true);
    expect(next.snakes[1].alive).toBe(false);
    expect(next.winner).toBe(0);
  });

  it('免疫：lock 結束後 60 個 tick 內被碰到，僚機消失但沒有效果', () => {
    const state = target({ immune: [0, 30], drone: [dr(21, 10), null] });
    const next = cqGame.step(state, IDLE);
    expect(next.drone[0]).toBeNull();
    expect(next.lock).toEqual([0, 0]);
    expect(next.hits).toEqual([0, 0]);
    expect(next.immune[1]).toBe(29);
  });

  it('免疫剛好是 1 的那個 tick 還擋得住；歸 0 之後的下一個 tick 就擋不住（邊界）', () => {
    const blocked = cqGame.step(target({ immune: [0, 2], drone: [dr(21, 10), null] }), IDLE);
    expect(blocked.lock).toEqual([0, 0]);
    const open = cqGame.step(target({ immune: [0, 1], drone: [dr(21, 10), null] }), IDLE);
    expect(open.lock).toEqual([0, LOCK_MOVES]);
  });

  it('已經在鎖定中又被碰到：僚機消失，沒有效果（lock 不重設）', () => {
    const next = cqGame.step(target({ lock: [0, 2], drone: [dr(21, 10), null] }), IDLE);
    expect(next.drone[0]).toBeNull();
    expect(next.lock).toEqual([0, 2]);
    expect(next.hits).toEqual([0, 0]);
  });

  it('免疫只在沒有鎖定時倒數，且每 tick 減 1', () => {
    const next = run(cqGame, target({ immune: [0, 10] }), 3);
    expect(next.immune[1]).toBe(7);
  });

  it('兩邊的僚機在同一個 tick 同一格：兩台都消失，沒有人被鎖（互相擊落）', () => {
    const state = target({
      snakes: [
        { body: [cell(5, 20), cell(4, 20), cell(3, 20)], dir: RIGHT },
        { body: [cell(20, 10), cell(21, 10), cell(22, 10)], dir: LEFT },
      ],
      drone: [dr(10, 10), dr(10, 10)],
    });
    const next = cqGame.step(state, IDLE);
    expect(next.drone).toEqual([null, null]);
    expect(next.lock).toEqual([0, 0]);
    expect(next.hits).toEqual([0, 0]);
  });

  it('互相擊落優先於命中：兩台疊在對手的蛇身上，也是互相擊落、沒人被鎖', () => {
    const state = makeState({
      tick: 0,
      snakes: [
        { body: [cell(5, 20), cell(4, 20), cell(3, 20)], dir: RIGHT },
        { body: [cell(20, 10), cell(21, 10), cell(22, 10)], dir: LEFT },
      ],
      drone: [dr(21, 10), dr(21, 10)],
    });
    const next = cqGame.step(state, IDLE);
    expect(next.drone).toEqual([null, null]);
    expect(next.lock).toEqual([0, 0]);
  });

  it('兩台同一個 tick 互換位置：兩台都消失', () => {
    // 兩台都在 ttl = DRONE_TTL − 9 的下一個 tick 走格（age 9）；人的往右、AI 的往左，互換 (10,10) 與 (11,10)
    const a = {
      cell: cell(10, 10),
      tail: [] as number[],
      aim: cell(11, 10),
      ttl: DRONE_TTL - 8,
      nextAim: 100000,
    };
    const b = {
      cell: cell(11, 10),
      tail: [] as number[],
      aim: cell(10, 10),
      ttl: DRONE_TTL - 8,
      nextAim: 100000,
    };
    const next = cqGame.step(makeState({ tick: 1, drone: [a, b] }), IDLE);
    expect(next.drone).toEqual([null, null]);
  });
});

describe('C-Q 兩條蛇｜結算順序與其他規則', () => {
  it('死亡照 C-A：撞牆的蛇死、另一條贏，不看分數', () => {
    const state = makeState({
      tick: 5,
      snakes: [{ body: [cell(0, 5), cell(1, 5), cell(2, 5)], dir: LEFT, score: 9 }, {}],
    });
    const next = cqGame.step(state, IDLE);
    expect(next.over).toBe(true);
    expect(next.winner).toBe(1);
  });

  it('吃食物 +1 分、長 1 格（沿用 C-A）', () => {
    const state = makeState({ tick: 5, foods: [cell(6, 12), cell(15, 20)] });
    const next = cqGame.step(state, IDLE);
    expect(next.snakes[0].score).toBe(1);
    expect(next.snakes[0].body).toHaveLength(4);
    expect(next.foods).toHaveLength(2);
  });

  it('時間到：分數高的贏', () => {
    const state = makeState({
      tick: 3599,
      snakes: [{ score: 2 }, { score: 1 }],
    });
    const next = cqGame.step(state, IDLE);
    expect(next.over).toBe(true);
    expect(next.winner).toBe(0);
  });

  it('step 不改動傳進來的 state（深度凍結）', () => {
    let state = deepFreeze(cqGame.init(2, CONFIG));
    for (let i = 0; i < 700; i += 1) {
      const inputs: Inputs = [
        i % 97 === 0 ? A : i % 31 === 0 ? UP_KEY : NONE,
        i % 89 === 0 ? A : NONE,
      ];
      state = deepFreeze(cqGame.step(state, inputs));
    }
    expect(state.tick).toBeGreaterThan(0);
  });

  it('可序列化：跑一段之後 JSON 往返不變（含 drone 為 null 與不為 null 兩種）', () => {
    let state = makeState({ tick: 0 });
    let sawDrone = false;
    for (let i = 0; i < 400; i += 1) {
      state = cqGame.step(state, [i === 5 ? A : NONE, i === 40 ? A : NONE]);
      sawDrone = sawDrone || state.drone[0] !== null;
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
      if (state.over) {
        break;
      }
    }
    expect(sawDrone).toBe(true);
  });

  it('決定性：同樣的種子與輸入，兩次結果完全相同', () => {
    const play = (): CQState => {
      let state = cqGame.init(5, CONFIG);
      for (let i = 0; i < 900; i += 1) {
        state = cqGame.step(state, [i % 50 === 0 ? A : NONE, i % 70 === 0 ? A : NONE]);
      }
      return state;
    };
    expect(play()).toEqual(play());
  });

  it('結束後 step 回傳同一個 state；score／winner 穩定', () => {
    const over = makeState({ over: true, winner: 1 });
    expect(cqGame.step(over, IDLE)).toBe(over);
    expect(cqGame.isOver(over)).toBe(true);
    expect(cqGame.winner(over)).toBe(1);
    expect(cqGame.winner(makeState())).toBeNull();
  });
});

describe('C-Q 兩條蛇｜tailCost 版本（DESIGN-AI-FUN 10.19 的改法：放出要割下 1 格尾巴，命中才還給你）', () => {
  const game = createCQGame({ tailCost: true });
  const dr = (x: number, y: number, ttl = 100) => ({
    cell: cell(x, y),
    tail: [] as number[],
    aim: cell(x, y),
    ttl,
    nextAim: 100000,
  });
  const long = (): number[] => [cell(5, 12), cell(4, 12), cell(3, 12), cell(2, 12)];

  it('放出：主蛇少 1 格尾巴、分數 −1，僚機從被割下的那一格出發', () => {
    const state = makeState({ tick: 0, snakes: [{ body: long() }, {}] });
    const next = game.step(state, [A, NONE]);
    expect(next.snakes[0].body).toEqual([cell(5, 12), cell(4, 12), cell(3, 12)]);
    expect(next.snakes[0].score).toBe(-1);
    expect((next.drone[0] as { cell: number }).cell).toBe(cell(2, 12));
  });

  it('長度不到 4 格不能放（至少留 3 格）', () => {
    const next = game.step(makeState({ tick: 0 }), [A, NONE]);
    expect(next.drone[0]).toBeNull();
    expect(next.launches).toEqual([0, 0]);
    expect(next.snakes[0].score).toBe(0);
  });

  it('命中才還給你：尾巴長回 1 格、分數 +1', () => {
    const state = makeState({
      tick: 0,
      snakes: [
        { body: [cell(5, 20), cell(4, 20), cell(3, 20)], dir: RIGHT, score: -1 },
        { body: [cell(20, 10), cell(21, 10), cell(22, 10)], dir: LEFT },
      ],
      drone: [dr(21, 10), null],
    });
    const next = game.step(state, IDLE);
    expect(next.hits).toEqual([1, 0]);
    expect(next.snakes[0].score).toBe(0);
    expect(next.snakes[0].body).toHaveLength(4);
  });

  it('撲空（壽命到了）不還：淨 −1 分；免疫中被碰到也不還', () => {
    const miss = makeState({
      tick: 0,
      snakes: [{ score: -1 }, {}],
      drone: [dr(2, 2, 1), null],
    });
    const gone = game.step(miss, IDLE);
    expect(gone.drone[0]).toBeNull();
    expect(gone.snakes[0].score).toBe(-1);
    const immune = makeState({
      tick: 0,
      snakes: [
        { body: [cell(5, 20), cell(4, 20), cell(3, 20)], dir: RIGHT, score: -1 },
        { body: [cell(20, 10), cell(21, 10), cell(22, 10)], dir: LEFT },
      ],
      immune: [0, 20],
      drone: [dr(21, 10), null],
    });
    const blocked = game.step(immune, IDLE);
    expect(blocked.snakes[0].score).toBe(-1);
    expect(blocked.snakes[0].body).toHaveLength(3);
  });

  it('互相擊落：兩邊都不還', () => {
    const state = makeState({
      tick: 0,
      snakes: [{ score: -1 }, { score: -1 }],
      drone: [dr(10, 10), dr(10, 10)],
    });
    const next = game.step(state, IDLE);
    expect(next.snakes[0].score).toBe(-1);
    expect(next.snakes[1].score).toBe(-1);
  });
});

describe('C-Q 兩條蛇｜actions', () => {
  it('可以放：6 個動作，不放的在前（轉向在前、全放開，然後同樣三個帶 a）', () => {
    const actions = cqGame.actions(makeState(), 0);
    expect(actions).toHaveLength(6);
    expect(actions.slice(0, 3).every((b) => !b.a)).toBe(true);
    expect(actions.slice(3).every((b) => b.a)).toBe(true);
    // 前三個裡兩個是轉向、一個是全放開
    const turns = actions.slice(0, 3).filter((b) => b.up || b.down || b.left || b.right);
    expect(turns).toHaveLength(2);
    expect(actions[0]?.left || actions[0]?.right).toBe(false);
  });

  it('冷卻中、僚機在場上、aHeld、死亡、結束：沒有帶 a 的動作', () => {
    const d = { cell: cell(10, 5), tail: [] as number[], aim: cell(10, 5), ttl: 100, nextAim: 999 };
    for (const state of [
      makeState({ reload: [5, 0] }),
      makeState({ drone: [d, null] }),
      makeState({ aHeld: [true, false] }),
    ]) {
      expect(cqGame.actions(state, 0).some((b) => b.a)).toBe(false);
      expect(cqGame.actions(state, 0).length).toBeGreaterThan(0);
    }
    const dead = makeState({ snakes: [{ alive: false }, {}] });
    expect(cqGame.actions(dead, 0)).toHaveLength(1);
    const over = makeState({ over: true });
    expect(cqGame.actions(over, 0)).toHaveLength(1);
    expect(cqGame.actions(over, 1)).toHaveLength(1);
  });

  it('被鎖定：只有全放開（可放時再加全放開＋a）', () => {
    const locked = makeState({ lock: [2, 0] });
    const actions = cqGame.actions(locked, 0);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual(NONE);
    expect(actions[1]?.a).toBe(true);
    const lockedCool = makeState({ lock: [2, 0], reload: [9, 0] });
    expect(cqGame.actions(lockedCool, 0)).toEqual([NONE]);
  });

  it('tailCost 版本：長度不到 4 時沒有帶 a 的動作', () => {
    const game = createCQGame({ tailCost: true });
    expect(game.actions(makeState(), 0).some((b) => b.a)).toBe(false);
    const long = makeState({
      snakes: [{ body: [cell(5, 12), cell(4, 12), cell(3, 12), cell(2, 12)] }, {}],
    });
    expect(game.actions(long, 0).some((b) => b.a)).toBe(true);
  });
});

describe('C-Q 兩條蛇｜evaluate', () => {
  const target = {
    body: [cell(20, 10), cell(21, 10), cell(22, 10)],
    dir: LEFT as 3,
  };
  const dr = (x: number, y: number) => ({
    cell: cell(x, y),
    tail: [] as number[],
    aim: cell(x, y),
    ttl: 100,
    nextAim: 100000,
  });

  it('K9：gain 有限、danger 在 0 到 1（開局、有僚機、被鎖、結束）', () => {
    const states = [
      cqGame.init(0, CONFIG),
      makeState({ snakes: [{}, target], drone: [dr(12, 10), dr(12, 12)] }),
      makeState({ lock: [3, 0] }),
      makeState({ over: true, winner: 0 }),
    ];
    for (const state of states) {
      for (const side of [0, 1] as const) {
        const e = cqGame.evaluate(state, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
  });

  it('我的僚機離對手越近，gain 越高（hope）', () => {
    const near = cqGame.evaluate(makeState({ snakes: [{}, target], drone: [dr(18, 10), null] }), 0);
    const far = cqGame.evaluate(makeState({ snakes: [{}, target], drone: [dr(5, 2), null] }), 0);
    expect(near.gain).toBeGreaterThan(far.gain);
  });

  it('對手的僚機 2 次走格內會碰到我：danger 至少 0.6', () => {
    const e = cqGame.evaluate(
      makeState({
        snakes: [{ body: [cell(10, 10), cell(9, 10), cell(8, 10)], dir: RIGHT }, {}],
        // 從 (11,11) 往 aim (10,10) 飛：第一步橫向到 (10,11)，第二步縱向到 (10,10)＝我的蛇頭
        drone: [null, { ...dr(11, 11), aim: cell(10, 10) }],
      }),
      0,
    );
    expect(e.danger).toBeGreaterThanOrEqual(0.6);
    const away = cqGame.evaluate(
      makeState({
        snakes: [{ body: [cell(10, 10), cell(9, 10), cell(8, 10)], dir: RIGHT }, {}],
        drone: [null, { ...dr(25, 20), aim: cell(25, 20) }],
      }),
      0,
    );
    expect(away.danger).toBeLessThan(0.6);
  });

  it('我被鎖定而且前方 lock 格內有牆：danger = 1', () => {
    const e = cqGame.evaluate(
      makeState({
        lock: [3, 0],
        snakes: [{ body: [cell(2, 10), cell(3, 10), cell(4, 10)], dir: LEFT }, {}],
      }),
      0,
    );
    expect(e.danger).toBe(1);
  });

  it('評估沒有「領先者」懲罰：分差只有 100 × 差，對稱', () => {
    const base = makeState({ foods: [cell(15, 3), cell(15, 20)] });
    const ahead = makeState({
      foods: [cell(15, 3), cell(15, 20)],
      snakes: [{ score: 3 }, { score: 0 }],
    });
    const gainDiff = cqGame.evaluate(ahead, 0).gain - cqGame.evaluate(base, 0).gain;
    expect(gainDiff).toBeCloseTo(300, 5);
    const behindDiff = cqGame.evaluate(ahead, 1).gain - cqGame.evaluate(base, 1).gain;
    expect(behindDiff).toBeCloseTo(-300, 5);
  });

  it('結束的局：贏的一邊 gain 大、輸的一邊小；自己死了 danger = 1', () => {
    const over = makeState({ over: true, winner: 0, snakes: [{}, { alive: false }] });
    expect(cqGame.evaluate(over, 0).gain).toBeGreaterThan(cqGame.evaluate(over, 1).gain);
    expect(cqGame.evaluate(over, 1).danger).toBe(1);
  });
});

describe('C-Q 兩條蛇｜selfFromPresent（反應延遲的重播重現不出「被僚機鎖定」這個外力）', () => {
  const hook = (
    cqGame as unknown as {
      selfFromPresent: (replayed: CQState, present: CQState, side: 0 | 1) => CQState;
    }
  ).selfFromPresent;

  it('宣告了 hook；自己的主蛇、鎖定、免疫、僚機、冷卻取現在的，對手的與食物維持重播的樣子', () => {
    expect(typeof hook).toBe('function');
    const replayed = makeState({ tick: 50, foods: [cell(1, 1), cell(2, 2)], reload: [7, 8] });
    const present = makeState({
      tick: 62,
      foods: [cell(9, 9), cell(8, 8)],
      reload: [1, 2],
      lock: [2, 3],
      immune: [4, 5],
      snakes: [{ body: [cell(9, 12), cell(8, 12), cell(7, 12)], score: 3 }, { score: 5 }],
      drone: [{ cell: cell(3, 3), tail: [], aim: cell(4, 4), ttl: 100, nextAim: 70 }, null],
      hits: [1, 2],
      launches: [3, 4],
    });
    const believed = hook(replayed, present, 0);
    expect(believed.snakes[0]).toEqual(present.snakes[0]);
    expect(believed.lock[0]).toBe(2);
    expect(believed.immune[0]).toBe(4);
    expect(believed.reload[0]).toBe(1);
    expect(believed.drone[0]).toEqual(present.drone[0]);
    expect(believed.hits[0]).toBe(1);
    expect(believed.launches[0]).toBe(3);
    // 對手與世界是重播（舊）的
    expect(believed.snakes[1]).toEqual(replayed.snakes[1]);
    expect(believed.lock[1]).toBe(0);
    expect(believed.reload[1]).toBe(8);
    expect(believed.foods).toEqual(replayed.foods);
    expect(believed.tick).toBe(50);
  });

  it('不改動傳進來的兩個 state', () => {
    const replayed = deepFreeze(makeState({ tick: 50 }));
    const present = deepFreeze(makeState({ tick: 62, lock: [2, 0] }));
    expect(() => hook(replayed, present, 1)).not.toThrow();
  });
});

describe('C-Q 兩條蛇｜meta 與畫面', () => {
  it('meta：id、花色、點數、預設性格、對稱、死亡優先', () => {
    expect(cqMeta.id).toBe('C-Q');
    expect(cqMeta.suit).toBe('C');
    expect(cqMeta.rank).toBe('Q');
    expect(cqMeta.defaultPolicy).toBe('pathfinder');
    expect(cqMeta.baseLevel).toBe(4);
    expect(cqMeta.symmetric).toBe(true);
    expect(cqMeta.winnerNotByScore).toBe(true);
    expect(cqMeta.controls.length).toBeGreaterThan(5);
  });

  it('render：凍結的 state 不丟錯、只用色盤、座標在畫布內（有僚機、被鎖定、結束三種）', () => {
    const palette = new Set<string>(Object.values(COLOR));
    const dr = (x: number, y: number) => ({
      cell: cell(x, y),
      tail: [cell(x - 1, y), cell(x - 2, y)],
      aim: cell(x + 4, y),
      ttl: 100,
      nextAim: 30,
    });
    const states = [
      makeState({ tick: 20, drone: [dr(10, 5), dr(20, 8)], reload: [100, 480] }),
      makeState({ tick: 20, lock: [2, 0], immune: [0, 30], reload: [0, 5] }),
      makeState({ over: true, winner: 0, snakes: [{}, { alive: false }] }),
    ];
    for (const state of states) {
      const fake = createFakeContext();
      expect(() => cqRender(asRenderingContext(fake), deepFreeze(state))).not.toThrow();
      const used = fake.colors.filter((c) => c.via === 'set').map((c) => String(c.value));
      expect(used.length).toBeGreaterThan(0);
      for (const color of used) {
        expect(palette.has(color), color).toBe(true);
      }
      for (const p of fake.points) {
        expect(p.x).toBeGreaterThanOrEqual(-8);
        expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
        expect(p.y).toBeGreaterThanOrEqual(-8);
        expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
      }
    }
  });
});
