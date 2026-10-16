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
import { CELLS, cell, DOWN, LEFT, RIGHT, UP } from '../_clubs/logic';
import {
  c6Game,
  evaluateC6,
  facingOf,
  isWall,
  makeState,
  partnerOf,
  pdist,
  PORTALS,
  TRANSIT_TICKS,
  WALL_CELLS,
} from './logic';
import type { C6State } from './logic';
import { c6Render } from './render';

/**
 * C-6 傳送門的規則測試（小規格 `docs/cards/C-6.md`「量測計畫與先寫的測試」）。
 * 全部用 `makeState` 直接構造局面。預設：人 (5,12) 往右、AI (26,11) 往左，各 3 格，食物 (8,3) 與 (23,20)。
 * 門口：第 1 對 左 (12,6) ↔ 右 (19,17)；第 2 對 左 (12,17) ↔ 右 (19,6)；左邊的門朝左、右邊的朝右。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_UP: Buttons = { ...NONE, up: true };
const IDLE: Inputs = [NONE, NONE];

const L1 = cell(12, 6);
const R1 = cell(19, 17);
const L2 = cell(12, 17);
const R2 = cell(19, 6);

function row(x: number, y: number, dx: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => cell(x + dx * i, y));
}
function col(x: number, y: number, dy: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => cell(x, y + dy * i));
}
function step(state: C6State, inputs: Inputs = IDLE): C6State {
  return c6Game.step(state, inputs);
}
/** 人 (11,6) 往右，下一次走格（tick 5 → 6）就踩進 L1。 */
function humanAtL1(extra: Parameters<typeof makeState>[0] = {}): C6State {
  return makeState({
    tick: 5,
    snakes: [{ body: row(11, 6, -1, 3), dir: RIGHT }, {}],
    ...extra,
  });
}
/** 人已經在傳送中：從 L1 到 R1，tick 5 時 `until` 是 `until`。 */
function humanInTransit(until: number, extra: Parameters<typeof makeState>[0] = {}): C6State {
  return makeState({
    tick: 5,
    snakes: [{ body: [L1, cell(11, 6), cell(10, 6)], dir: RIGHT }, {}],
    transit: [{ from: L1, to: R1, until }, null],
    ...extra,
  });
}

describe('C-6 傳送門｜地圖', () => {
  it('牆是 x=15、16 兩欄、y=2 到 21；上下各留 2 格寬的缺口', () => {
    expect(WALL_CELLS).toHaveLength(40);
    for (let y = 0; y < 24; y += 1) {
      for (const x of [14, 15, 16, 17]) {
        expect(isWall(cell(x, y))).toBe((x === 15 || x === 16) && y >= 2 && y <= 21);
      }
    }
  });

  it('四個門口：座標、配對、朝向如規格；配對互相對稱', () => {
    expect(PORTALS).toHaveLength(4);
    expect(partnerOf(L1)).toBe(R1);
    expect(partnerOf(R1)).toBe(L1);
    expect(partnerOf(L2)).toBe(R2);
    expect(partnerOf(R2)).toBe(L2);
    expect(partnerOf(cell(5, 5))).toBe(-1);
    expect(facingOf(L1)).toBe(LEFT);
    expect(facingOf(L2)).toBe(LEFT);
    expect(facingOf(R1)).toBe(RIGHT);
    expect(facingOf(R2)).toBe(RIGHT);
    for (const p of PORTALS) {
      expect(isWall(p.cell)).toBe(false);
    }
  });

  it('整張地圖 180 度對稱：牆、門口、朝向', () => {
    for (let c = 0; c < CELLS; c += 1) {
      const r = CELLS - 1 - c;
      expect(isWall(c)).toBe(isWall(r));
      expect(partnerOf(c) === -1).toBe(partnerOf(r) === -1);
      if (partnerOf(c) >= 0) {
        expect(partnerOf(r)).toBe(CELLS - 1 - partnerOf(c));
        expect(facingOf(r)).toBe((facingOf(c) + 2) % 4);
      }
    }
  });
});

describe('C-6 傳送門｜初始', () => {
  it('兩條蛇長 3、分數 0、180 度對稱、人往右 AI 往左；兩顆食物不在蛇身、牆、門口上；沒有傳送', () => {
    const s = c6Game.init(3, CONFIG);
    expect(s.snakes[0].body).toHaveLength(3);
    expect(s.snakes[1].body).toEqual(s.snakes[0].body.map((c) => CELLS - 1 - c));
    expect(s.snakes[0].dir).toBe(RIGHT);
    expect(s.snakes[1].dir).toBe(LEFT);
    expect(s.snakes[0].score).toBe(0);
    expect(s.foods).toHaveLength(2);
    expect(s.transit).toEqual([null, null]);
    expect(s.portalUses).toEqual([0, 0]);
    expect(s.exitDeaths).toEqual([0, 0]);
    expect(s.blocks).toBe(0);
  });

  it('種子 0..9 的食物不全相同；種子 0..99 的食物都不在牆與門口上', () => {
    const keys = new Set<string>();
    for (let seed = 0; seed < 100; seed += 1) {
      const s = c6Game.init(seed, CONFIG);
      if (seed < 10) {
        keys.add(s.foods.join(','));
      }
      for (const f of s.foods) {
        expect(isWall(f)).toBe(false);
        expect(partnerOf(f)).toBe(-1);
      }
    }
    expect(keys.size).toBeGreaterThan(1);
  });

  it('config.maxTicks 不是正整數：丟 RangeError', () => {
    expect(() => c6Game.init(0, { maxTicks: 0, params: {} })).toThrow(RangeError);
  });
});

describe('C-6 傳送門｜牆與一般走格', () => {
  it('撞中間的牆：那條蛇死、另一條贏；缺口走得過去', () => {
    const hit = step(
      makeState({ tick: 5, snakes: [{ body: row(14, 10, -1, 3), dir: RIGHT }, {}] }),
    );
    expect(hit.over).toBe(true);
    expect(hit.snakes[0].alive).toBe(false);
    expect(hit.winner).toBe(1);
    const gap = step(makeState({ tick: 5, snakes: [{ body: row(14, 1, -1, 3), dir: RIGHT }, {}] }));
    expect(gap.over).toBe(false);
    expect(gap.snakes[0].body[0]).toBe(cell(15, 1));
  });

  it('吃到食物：分數加 1、長度加 1、補一顆新的（不在牆與門口上）；時間到比分數', () => {
    const s = step(
      makeState({
        tick: 5,
        snakes: [{ body: row(7, 3, -1, 3), dir: RIGHT }, {}],
        foods: [cell(8, 3), cell(23, 20)],
      }),
    );
    expect(s.snakes[0].score).toBe(1);
    expect(s.snakes[0].body).toHaveLength(4);
    expect(s.foods).toHaveLength(2);
    expect(s.foods).not.toContain(cell(8, 3));
    const end = step(
      makeState({
        tick: 5,
        maxTicks: 6,
        snakes: [{ body: row(7, 3, -1, 3), dir: RIGHT }, {}],
        foods: [cell(8, 3), cell(23, 20)],
      }),
    );
    expect(end.over).toBe(true);
    expect(end.winner).toBe(0);
  });
});

describe('C-6 傳送門｜傳送', () => {
  it('蛇頭踩進門口：進入傳送中，transit 記下 from、to、until = tick + 30；蛇頭在門口，身體跟著走一格', () => {
    const s = step(humanAtL1());
    expect(TRANSIT_TICKS).toBe(30);
    expect(s.tick).toBe(6);
    expect(s.snakes[0].alive).toBe(true);
    expect(s.snakes[0].body).toEqual([L1, cell(11, 6), cell(10, 6)]);
    expect(s.transit[0]).toEqual({ from: L1, to: R1, until: 36 });
    expect(s.portalUses).toEqual([1, 0]);
    expect(s.blocks).toBe(0);
  });

  it('傳送中蛇不動、轉向輸入忽略（直到 until 之前）', () => {
    let s = humanInTransit(36, { tick: 6 });
    const before = s.snakes[0];
    for (let t = 0; t < 29; t += 1) {
      s = step(s, [t % 2 === 0 ? PRESS_UP : NONE, NONE]);
      expect(s.snakes[0].body).toEqual(before.body);
      expect(s.snakes[0].turn).toBe(before.turn);
      expect(s.transit[0]).not.toBeNull();
    }
    expect(s.tick).toBe(35);
  });

  it('until 那個 tick 冒出來：蛇頭在出口、方向是出口的朝向、M 變成頸、長度不變、transit 清空', () => {
    const s = step(humanInTransit(36, { tick: 35 }));
    expect(s.tick).toBe(36);
    expect(s.snakes[0].body).toEqual([R1, L1, cell(11, 6)]);
    expect(s.snakes[0].dir).toBe(RIGHT);
    expect(s.snakes[0].turn).toBe(RIGHT);
    expect(s.transit[0]).toBeNull();
    expect(s.snakes[0].alive).toBe(true);
    // 反方向：從右邊的門進、左邊的門冒出來，朝左。
    const back = step(
      makeState({
        tick: 35,
        snakes: [{ body: [R1, cell(20, 17), cell(21, 17)], dir: LEFT }, {}],
        transit: [{ from: R1, to: L1, until: 36 }, null],
      }),
    );
    expect(back.snakes[0].body[0]).toBe(L1);
    expect(back.snakes[0].dir).toBe(LEFT);
  });

  it('從上面踩進門口也可以；出來一律朝配對門口的朝向', () => {
    const s = step(makeState({ tick: 5, snakes: [{ body: col(12, 5, -1, 3), dir: DOWN }, {}] }));
    expect(s.transit[0]).toEqual({ from: L1, to: R1, until: 36 });
    const out = step({ ...s, tick: 35 });
    expect(out.snakes[0].dir).toBe(RIGHT);
  });

  it('冒出之後下一個走格週期照常可以轉向', () => {
    let s = step(humanInTransit(36, { tick: 35 }));
    s = step(s, [PRESS_UP, NONE]);
    expect(s.snakes[0].turn).toBe(UP);
  });

  it('傳送中的蛇是一堵不動的牆：別人撞上去就死', () => {
    const s = step(
      humanInTransit(36, {
        snakes: [
          { body: [L1, cell(11, 6), cell(10, 6)], dir: RIGHT },
          { body: row(11, 7, -1, 3), dir: UP },
        ],
      }),
    );
    // AI (11,7) 往上走進 (11,6)：人的頸。
    expect(s.snakes[1].alive).toBe(false);
    expect(s.winner).toBe(0);
  });
});

describe('C-6 傳送門｜出口被佔用', () => {
  it('傳送中別人踩進出口（會被傳到有傳送中蛇頭的那邊）：踩進去的那條死，記一次堵門', () => {
    const s = step(
      humanInTransit(36, {
        snakes: [
          { body: [L1, cell(11, 6), cell(10, 6)], dir: RIGHT },
          { body: row(20, 17, 1, 3), dir: LEFT },
        ],
      }),
    );
    expect(s.snakes[1].alive).toBe(false);
    expect(s.snakes[0].alive).toBe(true);
    expect(s.winner).toBe(0);
    expect(s.blocks).toBe(1);
    expect(s.exitDeaths).toEqual([0, 1]);
  });

  it('進門時出口被對方的身體佔著：進門的死', () => {
    const s = step(
      humanAtL1({
        snakes: [
          { body: row(11, 6, -1, 3), dir: RIGHT },
          { body: col(19, 19, -1, 4), dir: DOWN },
        ],
      }),
    );
    // AI 往下走一格，(19,17) 仍是它的身體（不是尾巴）。
    expect(s.snakes[0].alive).toBe(false);
    expect(s.snakes[1].alive).toBe(true);
    expect(s.winner).toBe(1);
    expect(s.blocks).toBe(1);
    expect(s.exitDeaths).toEqual([1, 0]);
    expect(s.transit[0]).toBeNull();
  });

  it('冒出時出口被佔用：冒出的死；出口剛好是對方會移走的尾巴格：不死', () => {
    const blocked = step(
      humanInTransit(6, {
        snakes: [
          { body: [L1, cell(11, 6), cell(10, 6)], dir: RIGHT },
          { body: col(19, 20, -1, 5), dir: DOWN },
        ],
      }),
    );
    expect(blocked.snakes[0].alive).toBe(false);
    expect(blocked.exitDeaths).toEqual([1, 0]);
    expect(blocked.blocks).toBe(1);
    expect(blocked.winner).toBe(1);
    const tail = step(
      humanInTransit(6, {
        snakes: [
          { body: [L1, cell(11, 6), cell(10, 6)], dir: RIGHT },
          { body: col(19, 19, -1, 3), dir: DOWN },
        ],
      }),
    );
    expect(tail.snakes[0].alive).toBe(true);
    expect(tail.snakes[0].body[0]).toBe(R1);
    expect(tail.blocks).toBe(0);
  });

  it('同一個 tick 兩條蛇各踩進同一對的兩端：兩條都死（同分平手）', () => {
    const s = step(
      humanAtL1({
        snakes: [
          { body: row(11, 6, -1, 3), dir: RIGHT },
          { body: row(20, 17, 1, 3), dir: LEFT },
        ],
      }),
    );
    expect(s.snakes[0].alive).toBe(false);
    expect(s.snakes[1].alive).toBe(false);
    expect(s.over).toBe(true);
    expect(s.winner).toBeNull();
    expect(s.blocks).toBe(2);
  });

  it('同一個 tick 兩條蛇都踩進同一個門口：頭對頭，兩條都死，分數高的贏', () => {
    const s = step(
      makeState({
        tick: 5,
        snakes: [
          { body: row(11, 6, -1, 3), dir: RIGHT, score: 2 },
          { body: [cell(13, 6), cell(13, 5), cell(13, 4)], dir: LEFT, score: 0 },
        ],
      }),
    );
    expect(s.snakes[0].alive).toBe(false);
    expect(s.snakes[1].alive).toBe(false);
    expect(s.winner).toBe(0);
  });

  it('身體穿過門之後，那一對門被堵：另一條蛇從另一端進去就死；另一對照常能用', () => {
    const blocker = { body: [cell(20, 17), R1, cell(18, 17), cell(17, 17)], dir: RIGHT } as const;
    const dead = step(
      makeState({
        tick: 5,
        snakes: [{ ...blocker }, { body: row(11, 6, -1, 3), dir: RIGHT }],
      }),
    );
    expect(dead.snakes[1].alive).toBe(false);
    expect(dead.winner).toBe(0);
    const ok = step(
      makeState({
        tick: 5,
        snakes: [{ ...blocker }, { body: row(11, 17, -1, 3), dir: RIGHT }],
      }),
    );
    expect(ok.snakes[1].alive).toBe(true);
    expect(ok.transit[1]).toEqual({ from: L2, to: R2, until: 36 });
  });
});

describe('C-6 傳送門｜pdist（門口感知距離）', () => {
  it('同一個房間沒有牆：就是曼哈頓距離', () => {
    expect(pdist(cell(5, 12), cell(5, 10))).toBe(2);
    expect(pdist(cell(3, 3), cell(8, 7))).toBe(9);
    expect(pdist(cell(5, 12), cell(5, 12))).toBe(0);
  });

  it('走門比繞路近：(11,6) 到 (20,17) 是 1 + 5 + 1 = 7', () => {
    expect(pdist(cell(11, 6), cell(20, 17))).toBe(7);
  });

  it('繞缺口比走門近：牆邊 (14,2) 到 (17,2) 是 5', () => {
    expect(pdist(cell(14, 2), cell(17, 2))).toBe(5);
    expect(pdist(cell(14, 1), cell(17, 1))).toBe(3);
  });

  it('剛從門口冒出來的那格不會再傳送；牆格走不到', () => {
    expect(pdist(R1, cell(21, 17))).toBe(2);
    expect(pdist(cell(16, 10), cell(20, 10))).toBe(99);
  });

  it('180 度對稱的兩對格子距離相同', () => {
    const pairs: [[number, number], [number, number]][] = [
      [
        [2, 3],
        [27, 20],
      ],
      [
        [11, 8],
        [20, 15],
      ],
      [
        [10, 17],
        [21, 5],
      ],
    ];
    for (const [a, b] of pairs) {
      expect(pdist(cell(...a), cell(...b))).toBe(
        pdist(CELLS - 1 - cell(...a), CELLS - 1 - cell(...b)),
      );
    }
  });
});

describe('C-6 傳送門｜evaluate 與 actions', () => {
  it('分數領先的 gain 較高（每分 100），而且沒有領先者懲罰：領先與落後對稱', () => {
    const lead = evaluateC6(makeState({ snakes: [{ score: 3 }, {}] }), 0);
    const level = evaluateC6(makeState(), 0);
    const behind = evaluateC6(makeState({ snakes: [{}, { score: 3 }] }), 0);
    expect(lead.gain - level.gain).toBeCloseTo(300, 5);
    expect(level.gain - behind.gain).toBeCloseTo(300, 5);
  });

  it('下一步踩進門口、出口被身體佔著：danger 1；出口空著：小於 1', () => {
    const blocked = makeState({
      tick: 5,
      snakes: [
        { body: row(11, 6, -1, 3), dir: RIGHT },
        { body: col(19, 19, -1, 4), dir: DOWN },
      ],
    });
    expect(evaluateC6(blocked, 0).danger).toBe(1);
    const free = humanAtL1();
    const e = evaluateC6(free, 0);
    expect(e.danger).toBeLessThan(1);
    expect(e.danger).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(e.gain)).toBe(true);
  });

  it('下一步踩進門口，對手蛇頭貼在出口旁：danger 至少 0.48；離出口 6 格以上：沒有埋伏的風險', () => {
    const ambush = humanAtL1({
      snakes: [
        { body: row(11, 6, -1, 3), dir: RIGHT },
        { body: row(20, 17, 1, 3), dir: LEFT },
      ],
    });
    expect(evaluateC6(ambush, 0).danger).toBeGreaterThanOrEqual(0.48);
    const far = humanAtL1({
      snakes: [
        { body: row(11, 6, -1, 3), dir: RIGHT },
        { body: row(27, 4, 1, 3), dir: LEFT },
      ],
    });
    expect(evaluateC6(far, 0).danger).toBeLessThan(0.3);
  });

  it('出口前方 2 格內有牆或身體：danger 至少 0.8', () => {
    const s = humanAtL1({
      snakes: [
        { body: row(11, 6, -1, 3), dir: RIGHT },
        { body: col(21, 19, -1, 4), dir: UP },
      ],
    });
    // 出口 (19,17) 朝右，(21,17) 是 AI 的身體。
    expect(evaluateC6(s, 0).danger).toBeGreaterThanOrEqual(0.8);
  });

  it('傳送中而出口被佔用：danger 1；每一個局面 danger 在 0..1、gain 有限', () => {
    const s = humanInTransit(36, {
      snakes: [
        { body: [L1, cell(11, 6), cell(10, 6)], dir: RIGHT },
        { body: col(19, 20, -1, 5), dir: DOWN },
      ],
    });
    expect(evaluateC6(s, 0).danger).toBe(1);
    let state = c6Game.init(5, CONFIG);
    for (let t = 0; t < 300 && !state.over; t += 1) {
      for (const side of [0, 1] as const) {
        const e = evaluateC6(state, side);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
        expect(Number.isFinite(e.gain)).toBe(true);
      }
      state = step(state);
    }
  });

  it('actions：傳送中只有「全放開」一個；平常至少一個', () => {
    expect(c6Game.actions(humanInTransit(36), 0)).toHaveLength(1);
    expect(c6Game.actions(c6Game.init(1, CONFIG), 0).length).toBeGreaterThanOrEqual(1);
    expect(c6Game.actions(c6Game.init(1, CONFIG), 1).length).toBeGreaterThanOrEqual(1);
  });
});

describe('C-6 傳送門｜純度與契約', () => {
  it('step 不改動傳進來的 state（深度凍結後整局亂按，含傳送中）', () => {
    let state = deepFreeze(humanAtL1());
    for (let t = 0; t < 60 && !state.over; t += 1) {
      state = deepFreeze(step(state, [t % 7 === 0 ? PRESS_UP : NONE, NONE]));
    }
    expect(state.tick).toBeGreaterThan(5);
  });

  it('state 可序列化：傳送中也一樣，JSON 來回之後相同', () => {
    const s = step(humanAtL1());
    expect(s.transit[0]).not.toBeNull();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('C-6 傳送門｜畫面', () => {
  it('只用色盤顏色、全部在 320×240 之內、不改 state；傳送中也畫得出來', () => {
    const state = deepFreeze(
      step(humanAtL1({ snakes: [{ body: row(11, 6, -1, 3), dir: RIGHT }, {}] })),
    );
    const before = JSON.stringify(state);
    const fake = createFakeContext();
    c6Render(asRenderingContext(fake), state);
    expect(JSON.stringify(state)).toBe(before);
    const used = fake.colors.filter((c) => c.via === 'set').map((c) => String(c.value));
    expect(used).toContain(COLOR.clubs);
    expect(used).toContain(COLOR.accent);
    for (const p of fake.points) {
      expect(p.x).toBeGreaterThanOrEqual(-8);
      expect(p.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
      expect(p.y).toBeGreaterThanOrEqual(-8);
      expect(p.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
    }
  });

  it('結束後也畫得出來，不丟錯', () => {
    const over = makeState({ over: true, winner: 1, snakes: [{ alive: false }, {}] });
    expect(() => c6Render(asRenderingContext(createFakeContext()), over)).not.toThrow();
  });
});
