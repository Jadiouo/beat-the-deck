import { describe, expect, it } from 'vitest';

import { hashState } from '../../core/hash';
import type { Buttons, GameConfig, Inputs } from '../../core/types';
import {
  COINS,
  DRIFT_EVERY,
  GRAVITY_FLIP,
  HEIGHT,
  MOVE_EVERY,
  NOTICE_TICKS,
  PHASE_TICKS,
  RAIN_COINS,
  SHOVE_CD,
  WIDTH,
  cell,
  cellX,
  cellY,
  evaluate,
  jkbGame,
  makeState,
} from './logic';
import type { JKBState, Rule } from './logic';

/**
 * JK-B 規則壞掉了的規則測試（小規格 `docs/cards/JK-B.md`「量測計畫與先寫的測試」）。
 * 用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 方向：0 上、1 右、2 下、3 左；`makeState` 的點預設放在不礙事的位置、金幣預設空的。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const KEY: readonly Buttons[] = [
  { ...NONE, up: true },
  { ...NONE, right: true },
  { ...NONE, down: true },
  { ...NONE, left: true },
];
/** 兩邊各按一個方向（undefined 是放開）。 */
const go = (a?: number, b?: number): Inputs => [
  a === undefined ? NONE : (KEY[a] as Buttons),
  b === undefined ? NONE : (KEY[b] as Buttons),
];
const IDLE = go();
const CONFIG: GameConfig = { maxTicks: 3600, params: {} };

const UP = 0;
const RIGHT = 1;
const DOWN = 2;
const LEFT = 3;

const step = jkbGame.step;
const at = (s: JKBState, side: 0 | 1): [number, number] => [s.avatars[side].x, s.avatars[side].y];

function run(state: JKBState, ticks: number, inputs: Inputs = IDLE): JKBState {
  let s = state;
  for (let i = 0; i < ticks; i += 1) {
    s = step(s, inputs);
  }
  return s;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** 一個規則段的開頭（ruleTick 0；tick 是 4 與 12 的倍數，所以第一個 step 就是走格的 tick）。 */
function phaseStart(rule: Rule, extra: Parameters<typeof makeState>[0] = {}): JKBState {
  return makeState({ phase: 1, ruleTick: 0, rule, ...extra });
}

describe('JK-B｜基底：init 與賽程', () => {
  it('起始：點在 (6,12) 與 (25,11)，分數 0，場上 5 個金幣不重疊也不在點上，第 0 段是正常', () => {
    const s = jkbGame.init(0, CONFIG);
    expect(at(s, 0)).toEqual([6, 12]);
    expect(at(s, 1)).toEqual([25, 11]);
    expect(s.scores).toEqual([0, 0]);
    expect(s.coins).toHaveLength(COINS);
    expect(new Set(s.coins).size).toBe(COINS);
    expect(s.coins).not.toContain(cell(6, 12));
    expect(s.coins).not.toContain(cell(25, 11));
    expect(s.extra).toEqual([]);
    expect(s.phase).toBe(0);
    expect(s.ruleTick).toBe(0);
    expect(s.rule).toBe('normal');
    expect(s.rainCell).toBe(-1);
    expect(s.avatars[0].shoveCd).toBe(0);
    expect(s.maxTicks).toBe(3600);
    expect(jkbGame.isOver(s)).toBe(false);
  });

  it('賽程：長度 6，第 0 條是 normal，其餘 5 條是規則池 6 條裡不重複的 5 條；next 是下一條', () => {
    const pool = new Set(['poison', 'gift', 'rain', 'gravity', 'rob', 'exchange']);
    for (let seed = 0; seed < 30; seed += 1) {
      const s = jkbGame.init(seed, CONFIG);
      expect(s.schedule).toHaveLength(6);
      expect(s.schedule[0]).toBe('normal');
      const rest = s.schedule.slice(1);
      expect(new Set(rest).size).toBe(5);
      for (const rule of rest) {
        expect(pool.has(rule)).toBe(true);
      }
      expect(s.rule).toBe(s.schedule[0]);
      expect(s.next).toBe(s.schedule[1]);
    }
  });

  it('賽程由種子決定：同種子相同，種子 0..9 不全相同，6 條規則都有出現過', () => {
    const a = jkbGame.init(3, CONFIG).schedule.join();
    expect(jkbGame.init(3, CONFIG).schedule.join()).toBe(a);
    const all = new Set<string>();
    const seen = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const schedule = jkbGame.init(seed, CONFIG).schedule;
      all.add(schedule.join());
      for (const rule of schedule) {
        seen.add(rule);
      }
    }
    expect(all.size).toBeGreaterThan(1);
    expect(seen.size).toBe(7);
  });

  it('maxTicks 小於 600 丟 RangeError；不是 600 的倍數時最後一段被截斷；超過 3600 以 3600 為準', () => {
    expect(() => jkbGame.init(0, { maxTicks: 599, params: {} })).toThrow(RangeError);
    const s = jkbGame.init(0, { maxTicks: 700, params: {} });
    expect(s.maxTicks).toBe(700);
    expect(jkbGame.isOver(run(s, 699))).toBe(false);
    expect(jkbGame.isOver(run(s, 700))).toBe(true);
    expect(jkbGame.init(0, { maxTicks: 9000, params: {} }).maxTicks).toBe(3600);
  });
});

describe('JK-B｜基底：走格', () => {
  it('每 4 個 tick 走一格：tick 0 走，1 到 3 不動，tick 4 再走；按住連續走', () => {
    let s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ],
    });
    const xs: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      s = step(s, go(RIGHT));
      xs.push(s.avatars[0].x);
    }
    expect(xs).toEqual([6, 6, 6, 6, 7, 7, 7, 7, 8]);
    expect(MOVE_EVERY).toBe(4);
  });

  it('不是走格的 tick 按方向不會走；下一個走格的 tick 還按著才走', () => {
    const s = makeState({
      tick: 1,
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ],
    });
    expect(at(step(s, go(RIGHT)), 0)).toEqual([5, 5]);
    expect(at(run(s, 3, go(RIGHT)), 0)).toEqual([6, 5]);
    // 走格那一刻放開了就不走
    expect(at(run(s, 3, go()), 0)).toEqual([5, 5]);
  });

  it('四個方向都能走，可以掉頭（沒有身體）', () => {
    const base = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ],
    });
    expect(at(step(base, go(UP)), 0)).toEqual([5, 4]);
    expect(at(step(base, go(DOWN)), 0)).toEqual([5, 6]);
    expect(at(step(base, go(LEFT)), 0)).toEqual([4, 5]);
    expect(at(step(base, go(RIGHT)), 0)).toEqual([6, 5]);
    const there = run(base, 4, go(RIGHT));
    expect(at(run(there, 4, go(LEFT)), 0)).toEqual([5, 5]);
  });

  it('邊界：走不出 32×24 的地圖，貼著邊按出去就留在原地', () => {
    const corner = makeState({
      avatars: [
        { x: 0, y: 0 },
        { x: 31, y: 23 },
      ],
    });
    expect(at(step(corner, go(LEFT, RIGHT)), 0)).toEqual([0, 0]);
    expect(at(step(corner, go(UP, DOWN)), 1)).toEqual([31, 23]);
    expect(WIDTH).toBe(32);
    expect(HEIGHT).toBe(24);
  });

  it('同時按兩個相反或相鄰的方向：相反的互相抵消；斜著按只取一個軸（上下優先）', () => {
    const s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ],
    });
    const both: Inputs = [{ ...NONE, left: true, right: true }, NONE];
    expect(at(step(s, both), 0)).toEqual([5, 5]);
    const diagonal: Inputs = [{ ...NONE, up: true, right: true }, NONE];
    expect(at(step(s, diagonal), 0)).toEqual([5, 4]);
  });

  it('兩個點同時算新位置，不分先後：同時走進同一格，兩個都不動', () => {
    const s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 7, y: 5 },
      ],
    });
    const n = step(s, go(RIGHT, LEFT));
    expect(at(n, 0)).toEqual([5, 5]);
    expect(at(n, 1)).toEqual([7, 5]);
    expect(n.avatars[0].shoveCd).toBe(0);
  });

  it('走進對方剛離開的格子：走進去的人成功，另一個人照常走，不算推擠', () => {
    const s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
      ],
    });
    const n = step(s, go(RIGHT, RIGHT));
    expect(at(n, 0)).toEqual([6, 5]);
    expect(at(n, 1)).toEqual([7, 5]);
    expect(n.avatars[0].shoveCd).toBe(0);
    expect(n.shoves).toEqual([0, 0]);
    const side = step(s, go(RIGHT, DOWN));
    expect(at(side, 0)).toEqual([6, 5]);
    expect(at(side, 1)).toEqual([6, 6]);
  });

  it('迎面對撞（互相走進對方的格子）：兩個都不動，沒有人推到人', () => {
    const s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
      ],
    });
    const n = step(s, go(RIGHT, LEFT));
    expect(at(n, 0)).toEqual([5, 5]);
    expect(at(n, 1)).toEqual([6, 5]);
    expect(n.shoves).toEqual([0, 0]);
  });
});

describe('JK-B｜基底：推擠與冷卻', () => {
  it('走進沒有在走的對手：對手被推到後面一格，自己前進，冷卻 30，推擠次數加 1，正常規則不改分數', () => {
    const s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
      ],
    });
    const n = step(s, go(RIGHT));
    expect(at(n, 0)).toEqual([6, 5]);
    expect(at(n, 1)).toEqual([7, 5]);
    expect(n.avatars[0].shoveCd).toBe(SHOVE_CD);
    expect(n.shoves).toEqual([1, 0]);
    expect(n.scores).toEqual([0, 0]);
    expect(SHOVE_CD).toBe(30);
  });

  it('四個方向都能推；對手被牆擋住（後面沒有格子）時推不動，也不算冷卻', () => {
    const down = step(
      makeState({
        avatars: [
          { x: 5, y: 5 },
          { x: 5, y: 6 },
        ],
      }),
      go(DOWN),
    );
    expect(at(down, 1)).toEqual([5, 7]);
    const left = step(
      makeState({
        avatars: [
          { x: 5, y: 5 },
          { x: 4, y: 5 },
        ],
      }),
      go(LEFT),
    );
    expect(at(left, 1)).toEqual([3, 5]);
    const up = step(
      makeState({
        avatars: [
          { x: 5, y: 5 },
          { x: 5, y: 4 },
        ],
      }),
      go(UP),
    );
    expect(at(up, 1)).toEqual([5, 3]);
    const wall = step(
      makeState({
        avatars: [
          { x: 30, y: 5 },
          { x: 31, y: 5 },
        ],
      }),
      go(RIGHT),
    );
    expect(at(wall, 0)).toEqual([30, 5]);
    expect(at(wall, 1)).toEqual([31, 5]);
    expect(wall.avatars[0].shoveCd).toBe(0);
    expect(wall.shoves).toEqual([0, 0]);
  });

  it('冷卻每個 tick 減 1；冷卻中走進對手就走不動；冷卻到 0 的下一個走格 tick 又推得動', () => {
    let s = step(
      makeState({
        avatars: [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ],
      }),
      go(RIGHT),
    );
    expect(s.avatars[0].shoveCd).toBe(30);
    s = step(s, IDLE);
    expect(s.avatars[0].shoveCd).toBe(29);
    // tick 4：冷卻中，走不動
    s = run(s, 3);
    const blocked = step(s, go(RIGHT));
    expect(at(blocked, 0)).toEqual([6, 5]);
    expect(at(blocked, 1)).toEqual([7, 5]);
    expect(blocked.shoves).toEqual([1, 0]);
    // tick 32（冷卻在 tick 30 回到 0）：推得動
    let t = run(s, 28);
    expect(t.tick).toBe(32);
    expect(t.avatars[0].shoveCd).toBe(0);
    t = step(t, go(RIGHT));
    expect(at(t, 0)).toEqual([7, 5]);
    expect(at(t, 1)).toEqual([8, 5]);
    expect(t.shoves).toEqual([2, 0]);
  });

  it('兩個點各自有冷卻：A 剛推完，B 的冷卻是 0，B 馬上可以推回去', () => {
    let s = step(
      makeState({
        avatars: [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ],
      }),
      go(RIGHT),
    );
    s = run(s, 3);
    const back = step(s, go(undefined, LEFT));
    expect(at(back, 1)).toEqual([6, 5]);
    expect(at(back, 0)).toEqual([5, 5]);
    expect(back.shoves).toEqual([1, 1]);
  });
});

describe('JK-B｜基底：撿金幣與補金幣', () => {
  it('走進金幣：加 1 分，金幣消失並在別的空格補一個，場上仍是 5 個', () => {
    const coins = [cell(6, 5), cell(20, 3), cell(10, 18), cell(3, 20), cell(28, 9)];
    const s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ],
      coins,
    });
    const n = step(s, go(RIGHT));
    expect(n.scores).toEqual([1, 0]);
    expect(n.coins).toHaveLength(COINS);
    expect(new Set(n.coins).size).toBe(COINS);
    expect(n.coins).not.toContain(cell(6, 5));
    for (const c of n.coins) {
      expect(c).not.toBe(cell(6, 5));
      expect(c).not.toBe(cell(25, 20));
    }
    expect(n.coins.filter((c) => coins.includes(c))).toHaveLength(4);
  });

  it('補金幣的位置由 state 裡的亂數決定：連續兩次補的位置不同，同樣的局面補同樣的位置', () => {
    const coins = [cell(6, 5), cell(7, 5), cell(20, 3), cell(10, 18), cell(3, 20)];
    const s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ],
      coins,
    });
    const one = run(s, 1, go(RIGHT));
    const two = run(one, 4, go(RIGHT));
    const fresh = [one.coins, two.coins].map((cs) => cs.filter((c) => !coins.includes(c)));
    expect(fresh[0]).toHaveLength(1);
    expect(fresh[1]).toHaveLength(2);
    expect(fresh[1]).toContain(fresh[0]?.[0]);
    expect(fresh[1]?.[0] === fresh[1]?.[1]).toBe(false);
    expect(hashState(run(s, 1, go(RIGHT)))).toBe(hashState(one));
    expect(two.rng).not.toBe(one.rng);
  });

  it('兩邊同一個 tick 各撿一個金幣：兩邊各加 1', () => {
    const coins = [cell(6, 5), cell(24, 20), cell(3, 3), cell(12, 12), cell(15, 15)];
    const s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ],
      coins,
    });
    const n = step(s, go(RIGHT, LEFT));
    expect(n.scores).toEqual([1, 1]);
    expect(n.coins).toHaveLength(COINS);
  });

  it('被推到金幣的格子也算撿（被推的人拿到那一分）', () => {
    const coins = [cell(7, 5), cell(20, 3), cell(10, 18), cell(3, 20), cell(28, 9)];
    const s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
      ],
      coins,
    });
    const n = step(s, go(RIGHT));
    expect(at(n, 1)).toEqual([7, 5]);
    expect(n.scores).toEqual([0, 1]);
    expect(n.coins).not.toContain(cell(7, 5));
  });

  it('補的金幣不會落在點的格子上，也不會和別的金幣重疊（地圖幾乎滿時也一樣）', () => {
    // 只留 3 個空格：兩個點、一個空格；金幣被撿掉之後只能補在還空著的格子
    const every = Array.from({ length: WIDTH * HEIGHT }, (_v, i) => i);
    const a = cell(5, 5);
    const b = cell(25, 20);
    const free = [cell(0, 0), cell(1, 0)];
    const coins = every.filter((c) => c !== a && c !== b && c !== cell(6, 5) && !free.includes(c));
    const s = makeState({
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ],
      coins,
    });
    expect(coins.length).toBeGreaterThan(COINS);
    const n = step(s, go(RIGHT));
    expect(n.coins).toHaveLength(coins.length);
    expect(new Set(n.coins).size).toBe(n.coins.length);
    expect(n.coins).not.toContain(cell(6, 5));
  });
});

describe('JK-B｜段與預告', () => {
  it('每 600 個 tick 換一段：tick 600、1200…進下一段，ruleTick 歸零，rule 與 next 跟著換', () => {
    const base = jkbGame.init(2, CONFIG);
    let s = run(base, 599);
    expect(s.phase).toBe(0);
    expect(s.ruleTick).toBe(599);
    s = step(s, IDLE);
    expect(s.tick).toBe(600);
    expect(s.phase).toBe(1);
    expect(s.ruleTick).toBe(0);
    expect(s.rule).toBe(base.schedule[1]);
    expect(s.next).toBe(base.schedule[2]);
    s = run(s, 600);
    expect(s.phase).toBe(2);
    expect(s.rule).toBe(base.schedule[2]);
    expect(PHASE_TICKS).toBe(600);
  });

  it('最後一段的 next 是 none；3600 結束，結束後再 step 一個 tick 都不變', () => {
    const base = jkbGame.init(5, CONFIG);
    const late = run(base, 3000);
    expect(late.phase).toBe(5);
    expect(late.next).toBe('none');
    const end = run(late, 600);
    expect(jkbGame.isOver(end)).toBe(true);
    expect(end.tick).toBe(3600);
    expect(hashState(step(end, go(RIGHT, LEFT)))).toBe(hashState(end));
  });

  it('贏家是分數高的；同分平手（null）；沒結束之前是 null', () => {
    const over = (scores: [number, number]): JKBState =>
      makeState({ tick: 3600, phase: 5, ruleTick: 599, scores });
    expect(jkbGame.winner(over([3, 1]))).toBe(0);
    expect(jkbGame.winner(over([1, 3]))).toBe(1);
    expect(jkbGame.winner(over([2, 2]))).toBeNull();
    expect(jkbGame.winner(over([-2, -5]))).toBe(0);
    expect(jkbGame.winner(makeState({ scores: [9, 0] }))).toBeNull();
    expect(jkbGame.score(over([3, -1]))).toEqual([3, -1]);
  });

  it('段內的規則用 state 的 phase 那一段：同一個撿金幣的動作，在 normal 是 +1，在 poison 是 −1', () => {
    const coins = [cell(6, 5), cell(20, 3), cell(10, 18), cell(3, 20), cell(28, 9)];
    const av = {
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ] as const,
      coins,
    };
    const normal = step(phaseStart('normal', { avatars: [...av.avatars], coins }), go(RIGHT));
    const poison = step(phaseStart('poison', { avatars: [...av.avatars], coins }), go(RIGHT));
    expect(normal.scores).toEqual([1, 0]);
    expect(poison.scores).toEqual([-1, 0]);
  });
});

describe('JK-B｜規則 1 毒藥與規則 2 送禮', () => {
  const coins = [cell(6, 5), cell(20, 3), cell(10, 18), cell(3, 20), cell(28, 9)];
  const avatars = [
    { x: 5, y: 5 },
    { x: 25, y: 20 },
  ] as const;

  it('毒藥：撿到金幣 −1（分數可以是負的），金幣照樣補', () => {
    const n = step(phaseStart('poison', { avatars: [...avatars], coins }), go(RIGHT));
    expect(n.scores).toEqual([-1, 0]);
    expect(n.coins).toHaveLength(COINS);
    expect(n.coins).not.toContain(cell(6, 5));
  });

  it('毒藥：把對手推到金幣上，對手 −1', () => {
    const c = [cell(7, 5), ...coins.slice(1)];
    const s = phaseStart('poison', {
      avatars: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
      ],
      coins: c,
    });
    const n = step(s, go(RIGHT));
    expect(n.scores).toEqual([0, -1]);
  });

  it('送禮：撿到的人得 0 分，對手 +1；兩邊在同一個 tick 各撿一個＝各 +1', () => {
    const one = step(phaseStart('gift', { avatars: [...avatars], coins }), go(RIGHT));
    expect(one.scores).toEqual([0, 1]);
    const c = [cell(6, 5), cell(24, 20), cell(3, 3), cell(12, 12), cell(15, 15)];
    const both = step(phaseStart('gift', { avatars: [...avatars], coins: c }), go(RIGHT, LEFT));
    expect(both.scores).toEqual([1, 1]);
  });

  it('送禮：把對手推到金幣上，對手送你 1 分', () => {
    const c = [cell(7, 5), ...coins.slice(1)];
    const s = phaseStart('gift', {
      avatars: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
      ],
      coins: c,
    });
    expect(step(s, go(RIGHT)).scores).toEqual([1, 0]);
  });
});

describe('JK-B｜規則 3 金幣雨', () => {
  const fixedSchedule: readonly Rule[] = ['normal', 'rain', 'normal', 'poison', 'gift', 'rob'];

  it('預告開始（上一段的 ruleTick 420）時決定標記格：整個 5×5 在地圖內、兩個點到它的曼哈頓距離差最小，之後到雨開始之前不變', () => {
    const s0 = makeState({
      schedule: fixedSchedule,
      phase: 0,
      ruleTick: 418,
      avatars: [
        { x: 6, y: 12 },
        { x: 25, y: 11 },
      ],
    });
    let s = step(s0, IDLE);
    expect(s.ruleTick).toBe(419);
    expect(s.rainCell).toBe(-1);
    s = step(s, IDLE);
    expect(s.ruleTick).toBe(420);
    expect(s.rainCell).toBeGreaterThanOrEqual(0);
    const x = cellX(s.rainCell);
    const y = cellY(s.rainCell);
    expect(x).toBeGreaterThanOrEqual(2);
    expect(x).toBeLessThanOrEqual(WIDTH - 3);
    expect(y).toBeGreaterThanOrEqual(2);
    expect(y).toBeLessThanOrEqual(HEIGHT - 3);
    const d0 = Math.abs(x - 6) + Math.abs(y - 12);
    const d1 = Math.abs(x - 25) + Math.abs(y - 11);
    expect(Math.abs(d0 - d1)).toBeLessThanOrEqual(1);
    const fixed = s.rainCell;
    const later = run(s, 179, go(RIGHT, LEFT));
    expect(later.phase).toBe(0);
    expect(later.rainCell).toBe(fixed);
    expect(NOTICE_TICKS).toBe(180);
  });

  it('沒有金幣雨的預告時 rainCell 是 −1（預告別的規則不會亮標記格）', () => {
    const s = run(makeState({ schedule: fixedSchedule, phase: 1, ruleTick: 0 }), 500);
    expect(s.phase).toBe(1);
    expect(s.rainCell).toBe(-1);
  });

  it('雨開始的那一刻：標記格 5×5 內多出 8 顆額外金幣，不在點上、不和金幣重疊', () => {
    const s0 = makeState({
      schedule: fixedSchedule,
      phase: 0,
      ruleTick: 599,
      rainCell: cell(15, 12),
      avatars: [
        { x: 15, y: 12 },
        { x: 16, y: 12 },
      ],
      coins: [cell(14, 12), cell(3, 3), cell(28, 20), cell(2, 20), cell(29, 3)],
    });
    const n = step(s0, IDLE);
    expect(n.phase).toBe(1);
    expect(n.rule).toBe('rain');
    expect(n.extra).toHaveLength(RAIN_COINS);
    expect(new Set(n.extra).size).toBe(RAIN_COINS);
    for (const e of n.extra) {
      expect(Math.abs(cellX(e) - 15)).toBeLessThanOrEqual(2);
      expect(Math.abs(cellY(e) - 12)).toBeLessThanOrEqual(2);
      expect(e).not.toBe(cell(15, 12));
      expect(e).not.toBe(cell(16, 12));
      expect(n.coins).not.toContain(e);
    }
    expect(n.coins).toHaveLength(COINS);
  });

  it('額外金幣 +1、撿了不補；一般金幣照樣補', () => {
    const s = phaseStart('rain', {
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ],
      extra: [cell(6, 5), cell(7, 5)],
      coins: [cell(20, 3), cell(10, 18), cell(3, 20), cell(28, 9), cell(15, 15)],
      rainCell: cell(7, 5),
    });
    const n = step(s, go(RIGHT));
    expect(n.scores).toEqual([1, 0]);
    expect(n.extra).toEqual([cell(7, 5)]);
    expect(n.coins).toHaveLength(COINS);
    const m = step(
      phaseStart('rain', {
        ...{},
        avatars: [
          { x: 5, y: 5 },
          { x: 25, y: 20 },
        ],
        coins: [cell(6, 5), cell(20, 3), cell(10, 18), cell(3, 20), cell(28, 9)],
        extra: [cell(9, 9)],
      }),
      go(RIGHT),
    );
    expect(m.scores).toEqual([1, 0]);
    expect(m.extra).toEqual([cell(9, 9)]);
    expect(m.coins).toHaveLength(COINS);
  });

  it('雨這一段結束：沒撿完的額外金幣消失，rainCell 回到 −1', () => {
    const s = makeState({
      schedule: fixedSchedule,
      phase: 1,
      ruleTick: 599,
      extra: [cell(9, 9), cell(10, 10)],
      rainCell: cell(10, 10),
    });
    const n = step(s, IDLE);
    expect(n.phase).toBe(2);
    expect(n.extra).toEqual([]);
    expect(n.rainCell).toBe(-1);
  });
});

describe('JK-B｜規則 4 重力反轉', () => {
  it('每 12 個 tick 兩個點都被強迫往重力方向（起始是下）走一格，不需要按鍵', () => {
    const s = phaseStart('gravity', {
      avatars: [
        { x: 5, y: 5 },
        { x: 20, y: 8 },
      ],
      gravity: 'down',
    });
    const a = run(s, 1);
    expect(at(a, 0)).toEqual([5, 6]);
    expect(at(a, 1)).toEqual([20, 9]);
    expect(at(run(s, 12), 0)).toEqual([5, 6]);
    expect(at(run(s, 13), 0)).toEqual([5, 7]);
    expect(DRIFT_EVERY).toBe(12);
  });

  it('每 180 個 tick 反轉一次：0 到 179 往下，180 到 359 往上，360 起又往下', () => {
    const s = phaseStart('gravity', {
      avatars: [
        { x: 5, y: 5 },
        { x: 20, y: 8 },
      ],
    });
    expect(s.gravity).toBe('down');
    expect(run(s, 179).gravity).toBe('down');
    expect(run(s, 180).gravity).toBe('up');
    expect(run(s, 359).gravity).toBe('up');
    expect(run(s, 360).gravity).toBe('down');
    expect(GRAVITY_FLIP).toBe(180);
    // 反轉之後的飄移往上
    const flipped = makeState({
      phase: 1,
      rule: 'gravity',
      ruleTick: 180,
      gravity: 'up',
      avatars: [
        { x: 5, y: 10 },
        { x: 20, y: 8 },
      ],
    });
    expect(at(step(flipped, IDLE), 0)).toEqual([5, 9]);
  });

  it('飄移撞到牆就留在原地；逆風走：按著往上，淨速度比往下慢', () => {
    const wall = phaseStart('gravity', {
      avatars: [
        { x: 5, y: 23 },
        { x: 20, y: 22 },
      ],
      gravity: 'down',
    });
    const n = step(wall, IDLE);
    expect(at(n, 0)).toEqual([5, 23]);
    expect(at(n, 1)).toEqual([20, 23]);
    const up = run(
      phaseStart('gravity', {
        avatars: [
          { x: 5, y: 12 },
          { x: 20, y: 12 },
        ],
      }),
      24,
      go(UP, DOWN),
    );
    expect(12 - at(up, 0)[1]).toBeLessThan(at(up, 1)[1] - 12);
  });

  it('被重力送到金幣的格子也算撿', () => {
    const s = phaseStart('gravity', {
      avatars: [
        { x: 5, y: 5 },
        { x: 20, y: 15 },
      ],
      coins: [cell(5, 6), cell(10, 18), cell(3, 20), cell(28, 9), cell(15, 2)],
    });
    const n = step(s, IDLE);
    expect(n.scores).toEqual([1, 0]);
  });

  it('同一個 tick 既走格又飄移：先走格、再飄移（按下往下走一格再被飄一格）', () => {
    const s = phaseStart('gravity', {
      avatars: [
        { x: 5, y: 5 },
        { x: 20, y: 15 },
      ],
    });
    const n = step(s, go(DOWN));
    expect(at(n, 0)).toEqual([5, 7]);
  });
});

describe('JK-B｜規則 5 搶劫', () => {
  it('撿金幣沒有分數但照樣補', () => {
    const s = phaseStart('rob', {
      avatars: [
        { x: 5, y: 5 },
        { x: 25, y: 20 },
      ],
      coins: [cell(6, 5), cell(20, 3), cell(10, 18), cell(3, 20), cell(28, 9)],
    });
    const n = step(s, go(RIGHT));
    expect(n.scores).toEqual([0, 0]);
    expect(n.coins).toHaveLength(COINS);
    expect(n.coins).not.toContain(cell(6, 5));
  });

  it('推擠成功：推的人 +1、被推的人 −1（可以變負），累計偷分；冷卻照舊', () => {
    const s = phaseStart('rob', {
      avatars: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
      ],
    });
    const n = step(s, go(RIGHT));
    expect(n.scores).toEqual([1, -1]);
    expect(n.stolen).toEqual([1, 0]);
    expect(n.avatars[0].shoveCd).toBe(SHOVE_CD);
    const again = run(n, 4, go(RIGHT));
    expect(again.scores).toEqual([1, -1]);
    const back = step(run(n, 3), go(undefined, LEFT));
    expect(back.scores).toEqual([0, 0]);
    expect(back.stolen).toEqual([1, 1]);
  });

  it('推不動（對手後面是牆）或對方跟著走開，都沒有偷到分', () => {
    const wall = step(
      phaseStart('rob', {
        avatars: [
          { x: 30, y: 5 },
          { x: 31, y: 5 },
        ],
      }),
      go(RIGHT),
    );
    expect(wall.scores).toEqual([0, 0]);
    const away = step(
      phaseStart('rob', {
        avatars: [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ],
      }),
      go(RIGHT, RIGHT),
    );
    expect(away.scores).toEqual([0, 0]);
    expect(away.stolen).toEqual([0, 0]);
  });

  it('不是搶劫的段，推擠不改分數', () => {
    for (const rule of ['normal', 'poison', 'gift', 'rain', 'gravity', 'exchange'] as const) {
      const n = step(
        phaseStart(rule, {
          avatars: [
            { x: 5, y: 5 },
            { x: 6, y: 5 },
          ],
        }),
        go(RIGHT),
      );
      expect(n.scores, rule).toEqual([0, 0]);
      expect(n.shoves[0], rule).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('JK-B｜規則 6 分數互換', () => {
  const coins = [cell(6, 5), cell(20, 3), cell(10, 18), cell(3, 20), cell(28, 9)];
  const avatars = [
    { x: 5, y: 5 },
    { x: 25, y: 20 },
  ] as const;

  it('先 +1 給撿的人，然後兩邊總分互換：落後的人撿了會變領先', () => {
    const behind = step(
      phaseStart('exchange', { avatars: [...avatars], coins, scores: [3, 5] }),
      go(RIGHT),
    );
    expect(behind.scores).toEqual([5, 4]);
  });

  it('領先的人撿了反而變落後；平手時撿的人變落後 1 分', () => {
    const ahead = step(
      phaseStart('exchange', { avatars: [...avatars], coins, scores: [5, 3] }),
      go(RIGHT),
    );
    expect(ahead.scores).toEqual([3, 6]);
    const tied = step(
      phaseStart('exchange', { avatars: [...avatars], coins, scores: [0, 0] }),
      go(RIGHT),
    );
    expect(tied.scores).toEqual([0, 1]);
  });

  it('兩邊同一個 tick 各撿一個：各 +1 之後只互換一次，沒有先後之分', () => {
    const c = [cell(6, 5), cell(24, 20), cell(3, 3), cell(12, 12), cell(15, 15)];
    const n = step(
      phaseStart('exchange', { avatars: [...avatars], coins: c, scores: [3, 0] }),
      go(RIGHT, LEFT),
    );
    expect(n.scores).toEqual([1, 4]);
    const m = step(
      phaseStart('exchange', { avatars: [...avatars], coins: c, scores: [0, 3] }),
      go(RIGHT, LEFT),
    );
    expect(m.scores).toEqual([4, 1]);
  });

  it('被推到金幣上也算撿：被推的人 +1 之後互換', () => {
    const s = phaseStart('exchange', {
      avatars: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
      ],
      coins: [cell(7, 5), cell(20, 3), cell(10, 18), cell(3, 20), cell(28, 9)],
      scores: [4, 1],
    });
    const n = step(s, go(RIGHT));
    expect(n.scores).toEqual([2, 4]);
  });
});

describe('JK-B｜step 與契約', () => {
  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，雜湊不變），回傳新物件', () => {
    const states: JKBState[] = [
      jkbGame.init(1, CONFIG),
      phaseStart('gravity', {
        avatars: [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ],
      }),
      phaseStart('exchange', {
        avatars: [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ],
        coins: [cell(7, 5)],
      }),
      makeState({ schedule: ['normal', 'rain', 'normal', 'poison', 'gift', 'rob'], ruleTick: 599 }),
    ];
    for (const s of states) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(s)) as JKBState);
      const before = hashState(frozen);
      const n = step(frozen, go(RIGHT, LEFT));
      expect(hashState(frozen)).toBe(before);
      expect(n).not.toBe(frozen);
    }
  });

  it('同樣的種子與輸入，每一步都得到逐位元相同的 state（可序列化，JSON 來回不變）', () => {
    let a = jkbGame.init(7, CONFIG);
    let b = jkbGame.init(7, CONFIG);
    for (let t = 0; t < 1500; t += 1) {
      const inputs = go(
        (t >> 3) % 5 === 4 ? undefined : (t >> 3) % 4,
        (t >> 4) % 5 === 4 ? undefined : (t >> 4) % 4,
      );
      a = step(a, inputs);
      b = step(b, inputs);
      if (t % 100 === 0) {
        expect(hashState(a)).toBe(hashState(b));
        expect(hashState(JSON.parse(JSON.stringify(a)) as JKBState)).toBe(hashState(a));
      }
    }
  });

  it('隨機走 3600 tick：場上金幣數永遠是 5，沒有重疊、沒有疊在點上，兩個點不在同一格，點都在地圖內', () => {
    let s = jkbGame.init(11, CONFIG);
    for (let t = 0; t < 3600; t += 1) {
      s = step(
        s,
        go(
          (t * 7 + (t >> 2)) % 5 === 4 ? undefined : (t * 7 + (t >> 2)) % 4,
          (t * 5 + (t >> 3)) % 5 === 4 ? undefined : (t * 5 + (t >> 3)) % 4,
        ),
      );
      expect(s.coins).toHaveLength(COINS);
      expect(new Set(s.coins).size).toBe(COINS);
      const cells = [cell(s.avatars[0].x, s.avatars[0].y), cell(s.avatars[1].x, s.avatars[1].y)];
      expect(cells[0]).not.toBe(cells[1]);
      for (const side of [0, 1] as const) {
        const av = s.avatars[side];
        expect(av.x).toBeGreaterThanOrEqual(0);
        expect(av.x).toBeLessThan(WIDTH);
        expect(av.y).toBeGreaterThanOrEqual(0);
        expect(av.y).toBeLessThan(HEIGHT);
      }
      expect(s.scores[0] + s.scores[1]).toBeGreaterThan(-3000);
    }
    expect(jkbGame.isOver(s)).toBe(true);
  });

  it('actions：兩邊都是 5 個（全放開排第一，再來上右下左），每個最多按一個方向鍵，沒有 a、b', () => {
    const s = jkbGame.init(0, CONFIG);
    for (const side of [0, 1] as const) {
      const actions = jkbGame.actions(s, side);
      expect(actions).toHaveLength(5);
      expect(actions[0]).toEqual(NONE);
      for (const a of actions) {
        expect(a.a || a.b).toBe(false);
        expect([a.up, a.down, a.left, a.right].filter(Boolean).length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('JK-B｜evaluate：基本性質', () => {
  const rules: readonly Rule[] = ['normal', 'poison', 'gift', 'rain', 'gravity', 'rob', 'exchange'];

  it('danger 在 0 到 1，gain 是有限的數（每一種規則、預告期與否）', () => {
    for (const rule of rules) {
      for (const ruleTick of [10, 450]) {
        const s = makeState({
          phase: 1,
          rule,
          next: 'rob',
          ruleTick,
          rainCell: cell(15, 12),
          avatars: [
            { x: 10, y: 10 },
            { x: 11, y: 10 },
          ],
          coins: [cell(12, 10), cell(3, 3), cell(20, 20), cell(25, 5), cell(9, 18)],
        });
        for (const side of [0, 1] as const) {
          const e = evaluate(s, side);
          expect(Number.isFinite(e.gain)).toBe(true);
          expect(e.danger).toBeGreaterThanOrEqual(0);
          expect(e.danger).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('沒有領先者懲罰：其他都一樣，自己的分數越高 gain 越高（每一種規則）', () => {
    for (const rule of rules) {
      const gains = [-3, 0, 3].map(
        (lead) =>
          evaluate(
            makeState({
              phase: 1,
              rule,
              ruleTick: 450,
              next: 'rain',
              rainCell: cell(15, 12),
              scores: [lead, 0],
              avatars: [
                { x: 10, y: 10 },
                { x: 20, y: 18 },
              ],
              coins: [cell(12, 10), cell(3, 3), cell(20, 20), cell(25, 5), cell(9, 18)],
            }),
            0,
          ).gain,
      );
      expect(gains[1], rule).toBeGreaterThan(gains[0] as number);
      expect(gains[2], rule).toBeGreaterThan(gains[1] as number);
    }
  });

  it('兩邊對稱：把兩個點與兩邊分數對調、換成另一邊看，evaluate 一樣', () => {
    for (const rule of rules) {
      const base = {
        phase: 1,
        rule,
        ruleTick: 450,
        next: 'gravity' as const,
        coins: [cell(12, 10), cell(3, 3), cell(20, 20), cell(25, 5), cell(9, 18)],
      };
      const a = makeState({
        ...base,
        scores: [2, 5],
        avatars: [
          { x: 10, y: 10, shoveCd: 0 },
          { x: 14, y: 12, shoveCd: 7 },
        ],
      });
      const b = makeState({
        ...base,
        scores: [5, 2],
        avatars: [
          { x: 14, y: 12, shoveCd: 7 },
          { x: 10, y: 10, shoveCd: 0 },
        ],
      });
      expect(evaluate(a, 0), rule).toEqual(evaluate(b, 1));
      expect(evaluate(a, 1), rule).toEqual(evaluate(b, 0));
    }
  });

  it('有價值的金幣越近 gain 越高；毒藥與送禮的金幣沒有價值（靠近它沒有加分）', () => {
    const near = (rule: Rule, x: number): number =>
      evaluate(
        makeState({
          phase: 1,
          rule,
          ruleTick: 100,
          avatars: [
            { x, y: 10 },
            { x: 28, y: 20 },
          ],
          coins: [cell(15, 10)],
        }),
        0,
      ).gain;
    expect(near('normal', 12)).toBeGreaterThan(near('normal', 8));
    expect(near('gravity', 12)).toBeGreaterThan(near('gravity', 8));
    expect(near('poison', 12)).toBe(near('poison', 8));
    expect(near('gift', 12)).toBe(near('gift', 8));
  });
});

describe('JK-B｜evaluate：準備項（只在預告期、寫死的習慣）', () => {
  const lone = (side: 0 | 1, x: number, y: number) =>
    side === 0
      ? [
          { x, y },
          { x: 28, y: 22 },
        ]
      : [
          { x: 3, y: 1 },
          { x, y },
        ];

  it('next = rain：預告期離標記格較遠的點，往標記格靠近的 gain 較高；預告期之前不受影響', () => {
    const g = (x: number, ruleTick: number, next: Rule = 'rain'): number =>
      evaluate(
        makeState({
          phase: 0,
          rule: 'normal',
          next,
          ruleTick,
          rainCell: cell(16, 12),
          avatars: lone(0, x, 12) as never,
          coins: [],
        }),
        0,
      ).gain;
    expect(g(14, 450)).toBeGreaterThan(g(12, 450));
    expect(g(12, 450)).toBeGreaterThan(g(8, 450));
    expect(g(8, 300)).toBe(g(14, 300));
    expect(g(8, 419)).toBe(g(14, 419));
    expect(g(8, 420)).toBeLessThan(g(14, 420));
  });

  it('預告期之前，evaluate 不讀 next、rainCell：只有 next 不同，結果一樣', () => {
    const g = (next: Rule): { gain: number; danger: number } =>
      evaluate(
        makeState({
          phase: 0,
          rule: 'normal',
          next,
          ruleTick: 100,
          avatars: [
            { x: 10, y: 10 },
            { x: 14, y: 10 },
          ],
          coins: [cell(12, 14)],
        }),
        0,
      );
    expect(g('rob')).toEqual(g('rain'));
    expect(g('gravity')).toEqual(g('poison'));
  });

  it('毒藥與送禮快結束（預告期）：往 5×5 內金幣最多的格子走；預告期之前不走', () => {
    const cluster = [cell(8, 8), cell(9, 8), cell(8, 9), cell(10, 10), cell(28, 3)];
    for (const rule of ['poison', 'gift'] as const) {
      const g = (x: number, ruleTick: number): number =>
        evaluate(
          makeState({
            phase: 1,
            rule,
            next: 'normal',
            ruleTick,
            avatars: [
              { x, y: 8 },
              { x: 28, y: 20 },
            ],
            coins: cluster,
          }),
          0,
        ).gain;
      expect(g(11, 450), rule).toBeGreaterThan(g(16, 450));
      expect(g(16, 450), rule).toBeGreaterThan(g(22, 450));
      expect(g(11, 100), rule).toBe(g(22, 100));
    }
  });

  it('next = rob：離對手不到 6 格就扣分（越近越多）；6 格以上沒有差別；預告期之前不扣', () => {
    const g = (dist: number, ruleTick: number): number =>
      evaluate(
        makeState({
          phase: 0,
          rule: 'normal',
          next: 'rob',
          ruleTick,
          avatars: [
            { x: 4, y: 10 },
            { x: 4 + dist, y: 10 },
          ],
          coins: [],
        }),
        0,
      ).gain;
    expect(g(8, 450)).toBeGreaterThan(g(3, 450));
    expect(g(3, 450)).toBeGreaterThan(g(2, 450));
    expect(g(6, 450)).toBe(g(9, 450));
    expect(g(2, 300)).toBe(g(9, 300));
  });

  it('next = gravity：預告期站在上半場（y < 12）的 gain 較高；預告期之前沒差', () => {
    const g = (y: number, ruleTick: number): number =>
      evaluate(
        makeState({
          phase: 0,
          rule: 'normal',
          next: 'gravity',
          ruleTick,
          avatars: [
            { x: 10, y },
            { x: 28, y: 12 },
          ],
          coins: [],
        }),
        0,
      ).gain;
    expect(g(4, 450)).toBeGreaterThan(g(18, 450));
    expect(g(4, 450)).toBeGreaterThan(g(11, 450));
    expect(g(4, 300)).toBe(g(18, 300));
  });

  it('分數互換的時間項只看最後 1 秒（ruleTick ≥ 540）：之前沒有，之後對手搆不到金幣時，領先才算數', () => {
    const lead = (ruleTick: number, oppX: number): number =>
      evaluate(
        makeState({
          phase: 1,
          rule: 'exchange',
          next: 'normal',
          ruleTick,
          scores: [2, 0],
          avatars: [
            { x: 5, y: 5 },
            { x: oppX, y: 20 },
          ],
          coins: [cell(28, 4)],
        }),
        0,
      ).gain;
    // 最後 1 秒、對手離金幣太遠（搆不到）：比對手搆得到時 gain 高
    expect(lead(560, 3)).toBeGreaterThan(lead(560, 27));
    // 最後 1 秒之前，對手離金幣多遠都一樣（除了「離金幣的距離」本身不會被這一項改變）
    expect(lead(500, 3) - lead(500, 27)).toBe(lead(539, 3) - lead(539, 27));
  });
});

describe('JK-B｜evaluate：danger', () => {
  it('搶劫期間相鄰、對手可以推而且我後面有格子：danger = 1；對手在冷卻、或我背後是牆：0', () => {
    const d = (opp: object, me: object = { x: 10, y: 10 }, dist = 1): number =>
      evaluate(
        makeState({
          phase: 1,
          rule: 'rob',
          ruleTick: 100,
          avatars: [me, { x: 10 + dist, y: 10, ...opp }],
          coins: [],
        }),
        0,
      ).danger;
    expect(d({ shoveCd: 0 })).toBe(1);
    expect(d({ shoveCd: 12 })).toBe(0);
    expect(d({ shoveCd: 0 }, { x: 10, y: 10 }, 3)).toBe(0);
    // 我在牆邊：對手要把我往牆裡推，推不動
    const wall = evaluate(
      makeState({
        phase: 1,
        rule: 'rob',
        ruleTick: 100,
        avatars: [
          { x: 0, y: 10 },
          { x: 1, y: 10 },
        ],
        coins: [],
      }),
      0,
    ).danger;
    expect(wall).toBe(0);
  });

  it('毒藥與送禮：對手能把我推到金幣上才危險；沒有金幣在我後面就不危險', () => {
    for (const rule of ['poison', 'gift'] as const) {
      const d = (coin: number): number =>
        evaluate(
          makeState({
            phase: 1,
            rule,
            ruleTick: 100,
            avatars: [
              { x: 10, y: 10 },
              { x: 11, y: 10 },
            ],
            coins: [coin],
          }),
          0,
        ).danger;
      expect(d(cell(9, 10)), rule).toBeGreaterThanOrEqual(0.8);
      expect(d(cell(9, 12)), rule).toBeLessThan(0.5);
    }
  });
});
