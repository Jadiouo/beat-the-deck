import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { lookOneStep } from '../../ai/policies/shared';
import type { Policy } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import {
  CELLS,
  cell,
  cellX,
  cellY,
  generateWalls,
  MOVE_EVERY,
  START_CELLS,
} from '../_diamonds/logic';
import {
  BEFORE_MOVE,
  CONFIG,
  deepFreeze,
  IDLE,
  NONE,
  openCellsConnected,
  PRESS_LEFT,
  PRESS_RIGHT,
  PRESS_UP,
  run,
} from '../_diamonds/shared-rules.test-helpers';
import {
  BELT_STEP,
  buildRing,
  CAP,
  catchTable,
  d10Game,
  LIFETIME,
  makeGood,
  makeState,
  NOTICE,
  RING,
  SHIP_TICKS,
  SPAWN_EVERY,
  TIE_PENALTY,
} from './logic';
import type { D10State, Good } from './logic';
import { center, dense, probe, upcomingChaser, watchBag } from './players.test-helpers';

/**
 * D-10 輸送帶的規則測試。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * `makeState` 預設：沒有牆、空的帶子、沒有預告、兩邊背包空、兩個角色在起點 (0,23) 與 (31,0)。
 * 圈上編號：0 是 (6,6)，順時針；`at(i)` 是第 i 格的格子編號。
 */

const RING_CELLS = buildRing();
const at = (i: number): number => RING_CELLS[i] as number;
const FAR_HUMAN = START_CELLS[0];
const FAR_AI = START_CELLS[1];
const SHIP_BUTTON: Buttons = { ...NONE, b: true };

/** 離走格的結算只差一個 tick 的局面，加上 overrides。 */
function atMove(overrides: Parameters<typeof makeState>[0] = {}): D10State {
  return makeState({ tick: BEFORE_MOVE, ...overrides });
}

// ---------------------------------------------------------------------------
// 帶子的形狀與開局
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜帶子的形狀與開局', () => {
  it('帶子：60 格、互不相同、剛好是 x 6 到 25、y 6 到 17 的外圍；0 號是左上角 (6,6)，順時針；相鄰兩格在地圖上相鄰', () => {
    expect(RING).toBe(60);
    expect(RING_CELLS).toHaveLength(60);
    expect(new Set(RING_CELLS).size).toBe(60);
    expect(RING_CELLS[0]).toBe(cell(6, 6));
    for (const c of RING_CELLS) {
      const x = cellX(c);
      const y = cellY(c);
      expect(x >= 6 && x <= 25 && y >= 6 && y <= 17).toBe(true);
      expect(x === 6 || x === 25 || y === 6 || y === 17).toBe(true);
    }
    // 順時針：上緣往右、右緣往下、下緣往左、左緣往上。
    expect(RING_CELLS[1]).toBe(cell(7, 6));
    expect(RING_CELLS[19]).toBe(cell(25, 6));
    expect(RING_CELLS[20]).toBe(cell(25, 7));
    expect(RING_CELLS[30]).toBe(cell(25, 17));
    expect(RING_CELLS[31]).toBe(cell(24, 17));
    expect(RING_CELLS[49]).toBe(cell(6, 17));
    expect(RING_CELLS[50]).toBe(cell(6, 16));
    expect(RING_CELLS[59]).toBe(cell(6, 7));
    for (let i = 0; i < RING; i += 1) {
      const a = RING_CELLS[i] as number;
      const b = RING_CELLS[(i + 1) % RING] as number;
      expect(Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b))).toBe(1);
    }
  });

  it('帶子 180 度旋轉對稱：第 i 格轉 180 度就是第 i + 30 格（兩個起點也互為 180 度）', () => {
    for (let i = 0; i < RING; i += 1) {
      const c = RING_CELLS[i] as number;
      const rotated = cell(31 - cellX(c), 23 - cellY(c));
      expect(rotated).toBe(RING_CELLS[(i + 30) % RING]);
    }
    expect(cell(31 - cellX(START_CELLS[0]), 23 - cellY(START_CELLS[0]))).toBe(START_CELLS[1]);
  });

  it('開局：兩邊在起點、背包空、不在出貨、分數 0、沒有貨、有一件預告（60 tick 後出現）、一局固定 3600 tick', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const state = d10Game.init(seed, CONFIG);
      expect(state.players[0].cell).toBe(FAR_HUMAN);
      expect(state.players[1].cell).toBe(FAR_AI);
      expect(state.bag).toEqual([[], []]);
      expect(state.ship).toEqual([0, 0]);
      expect(state.belt).toEqual([]);
      expect(state.taken).toEqual([0, 0]);
      expect(state.broken).toBe(0);
      expect(state.ships).toEqual([0, 0]);
      expect(d10Game.score(state)).toEqual([0, 0]);
      expect(state.maxTicks).toBe(3600);
      expect(state.ring).toEqual(RING_CELLS);
      const up = state.upcoming;
      expect(up).not.toBeNull();
      expect(up?.at).toBe(NOTICE);
      expect(up?.w).toBeGreaterThanOrEqual(1);
      expect(up?.w).toBeLessThanOrEqual(4);
      expect(up?.v).toBeGreaterThanOrEqual(1);
      expect(up?.v).toBeLessThanOrEqual(9);
      expect(up?.idx).toBeGreaterThanOrEqual(0);
      expect(up?.idx).toBeLessThan(RING);
    }
    expect(SPAWN_EVERY).toBe(90);
    expect(NOTICE).toBe(60);
    expect(BELT_STEP).toBe(10);
    expect(LIFETIME).toBe(600);
    expect(CAP).toBe(8);
    expect(SHIP_TICKS).toBe(60);
  });

  it('牆：帶子壓過的牆拿掉（帶子上一格牆也沒有），其他的牆跟 generateWalls 一樣，所有空格仍然連通（種子 0 到 99）', () => {
    let seedsWithRingWalls = 0;
    for (let seed = 0; seed < 100; seed += 1) {
      const state = d10Game.init(seed, CONFIG);
      const original = generateWalls(seed).walls;
      let hadRingWall = false;
      for (const c of RING_CELLS) {
        expect(state.walls[c], `種子 ${seed}：帶子上的格子 ${c} 是牆`).toBe(0);
        if (original[c] === 1) {
          hadRingWall = true;
        }
      }
      if (hadRingWall) {
        seedsWithRingWalls += 1;
      }
      const onRing = new Set(RING_CELLS);
      for (let c = 0; c < CELLS; c += 1) {
        if (!onRing.has(c)) {
          expect(state.walls[c], `種子 ${seed}：格子 ${c}`).toBe(original[c]);
        }
      }
      expect(openCellsConnected(state.walls), `種子 ${seed}：空格不連通`).toBe(true);
    }
    // 這條規則真的被用到：大部分種子在帶子上本來有牆。
    expect(seedsWithRingWalls).toBeGreaterThan(50);
  });

  it('同一個種子 init 兩次完全相同；不同的種子不全相同', () => {
    for (const seed of [0, 3, 41]) {
      expect(d10Game.init(seed, CONFIG)).toEqual(d10Game.init(seed, CONFIG));
    }
    const layouts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      layouts.add(JSON.stringify(d10Game.init(seed, CONFIG).upcoming));
    }
    expect(layouts.size).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// 走格（沿用方塊共同設定）
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜走格', () => {
  it('5 個 tick 才走一格：前 4 個 tick 不動，第 5 個 tick 走；朝牆走不動；兩個角色可以重疊', () => {
    let s = makeState({ players: [{ cell: cell(10, 10) }, { cell: FAR_AI }] });
    for (let i = 0; i < 4; i += 1) {
      s = d10Game.step(s, [PRESS_RIGHT, NONE]);
      expect(s.players[0].cell).toBe(cell(10, 10));
    }
    s = d10Game.step(s, [PRESS_RIGHT, NONE]);
    expect(s.players[0].cell).toBe(cell(11, 10));
    expect(MOVE_EVERY).toBe(5);
    const walled = atMove({
      walls: [cell(11, 10)],
      players: [{ cell: cell(10, 10) }, { cell: FAR_AI }],
    });
    expect(d10Game.step(walled, [PRESS_RIGHT, NONE]).players[0].cell).toBe(cell(10, 10));
    const stacked = atMove({ players: [{ cell: cell(10, 10) }, { cell: cell(11, 10) }] });
    expect(d10Game.step(stacked, [PRESS_RIGHT, NONE]).players.map((p) => p.cell)).toEqual([
      cell(11, 10),
      cell(11, 10),
    ]);
  });
});

// ---------------------------------------------------------------------------
// 貨的流動與消失
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜貨的流動', () => {
  it('1. 每 10 個 tick 前進一格：第 9 個 tick 還在原地，第 10 個 tick 到下一格；格子編號跟著變', () => {
    const s0 = makeState({ belt: [makeGood(5, 2, 5, 0)] });
    const s9 = run(d10Game, s0, 9);
    expect(s9.belt[0]).toMatchObject({ idx: 5, cell: at(5), age: 9 });
    const s10 = d10Game.step(s9, IDLE);
    expect(s10.belt[0]).toMatchObject({ idx: 6, cell: at(6), age: 10 });
    expect(run(d10Game, s0, 60).belt[0]).toMatchObject({ idx: 11, cell: at(11), age: 60 });
  });

  it('1. 流到 59 號之後接回 0 號（一圈）', () => {
    const s = run(d10Game, makeState({ belt: [makeGood(59, 1, 1, 0)] }), 10);
    expect(s.belt[0]).toMatchObject({ idx: 0, cell: at(0), age: 10 });
  });

  it('2. 邊界：age 599 還在，age 600 消失（最多流 600 個 tick）', () => {
    const s598 = makeState({ belt: [makeGood(10, 1, 1, 598)] });
    const s599 = d10Game.step(s598, IDLE);
    expect(s599.belt).toHaveLength(1);
    expect(s599.belt[0]?.age).toBe(599);
    expect(d10Game.step(s599, IDLE).belt).toEqual([]);
  });

  it('2. 邊界：age 599 的貨還拿得到；age 600 的那一步它已經消失，站在它「下一格」的人什麼都拿不到', () => {
    // age 598 → 599：貨還在 (idx 10)，站在 idx 10 的人拿得到。
    const stand = makeState({
      belt: [makeGood(10, 1, 4, 598)],
      players: [{ cell: at(10) }, { cell: FAR_AI }],
    });
    expect(d10Game.step(stand, IDLE).bag[0]).toEqual([{ w: 1, v: 4 }]);
    // age 599 → 600：本來這一步要前進到 idx 11，但它在這一步消失，所以 idx 11 的人拿不到。
    const gone = makeState({
      belt: [makeGood(10, 1, 4, 599)],
      players: [{ cell: at(11) }, { cell: FAR_AI }],
    });
    const after = d10Game.step(gone, IDLE);
    expect(after.belt).toEqual([]);
    expect(after.bag[0]).toEqual([]);
    expect(after.taken).toEqual([0, 0]);
    // 對照：age 589 → 590 前進到 idx 11，站在那裡的人拿得到。
    const flow = makeState({
      belt: [makeGood(10, 1, 4, 589)],
      players: [{ cell: at(11) }, { cell: FAR_AI }],
    });
    expect(d10Game.step(flow, IDLE).bag[0]).toEqual([{ w: 1, v: 4 }]);
  });

  it('3. 預告：開局的預告 60 個 tick 後在預告的格子出現（重量、價值、位置都與預告一樣），預告消失', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const s0 = d10Game.init(seed, CONFIG);
      const up = s0.upcoming;
      expect(up).not.toBeNull();
      const s59 = run(d10Game, s0, 59);
      expect(s59.belt).toEqual([]);
      expect(s59.upcoming).toEqual(up);
      const s60 = d10Game.step(s59, IDLE);
      expect(s60.belt).toEqual([
        { cell: at(up?.idx as number), idx: up?.idx, w: up?.w, v: up?.v, age: 0 },
      ]);
      expect(s60.upcoming).toBeNull();
    }
  });

  it('3. 第二件在第一件的對面（編號差 30）：第 90 個 tick 擲出預告，第 150 個 tick 出現；每一對都是這樣', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const spawned: Good[] = [];
      let s = d10Game.init(seed, CONFIG);
      for (let t = 0; t < 3600; t += 1) {
        s = d10Game.step(s, IDLE);
        spawned.push(...s.belt.filter((g) => g.age === 0));
        if (t === 89) {
          expect(s.upcoming?.at, `種子 ${seed}`).toBe(150);
          expect(s.upcoming?.idx, `種子 ${seed}`).toBe(((spawned[0] as Good).idx + 30) % RING);
        }
      }
      expect(spawned, `種子 ${seed}：一局出現的貨`).toHaveLength(40);
      for (let j = 0; j < 40; j += 2) {
        expect((spawned[j + 1] as Good).idx, `種子 ${seed} 第 ${j / 2} 對`).toBe(
          ((spawned[j] as Good).idx + 30) % RING,
        );
      }
    }
  });

  it('3. 預告在出現前 60 個 tick 才擲（亂數狀態在擲之前不變、之後往前走）', () => {
    const s0 = d10Game.init(4, CONFIG);
    const s89 = run(d10Game, s0, 89);
    expect(s89.rng).toBe(s0.rng);
    const s90 = d10Game.step(s89, IDLE);
    expect(s90.rng).not.toBe(s0.rng);
    expect(s90.upcoming?.at).toBe(90 + NOTICE);
  });

  it('4. 亂數：種子 0 到 9 的第一件貨（位置、重量、價值）不全相同；每個種子的連續兩件貨不相同', () => {
    const firsts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const s0 = d10Game.init(seed, CONFIG);
      const first = s0.upcoming;
      firsts.add(`${first?.idx}/${first?.w}/${first?.v}`);
      const second = run(d10Game, s0, 90).upcoming;
      expect(`${second?.idx}/${second?.w}/${second?.v}`, `種子 ${seed}`).not.toBe(
        `${first?.idx}/${first?.w}/${first?.v}`,
      );
    }
    expect(firsts.size).toBeGreaterThanOrEqual(6);
    // 重量 1 到 4、價值 1 到 9 都會出現（一局 40 件）。
    const weights = new Set<number>();
    const values = new Set<number>();
    for (let seed = 0; seed < 5; seed += 1) {
      let s = d10Game.init(seed, CONFIG);
      for (let t = 0; t < 3600; t += 1) {
        s = d10Game.step(s, IDLE);
        for (const g of s.belt) {
          weights.add(g.w);
          values.add(g.v);
        }
      }
    }
    expect([...weights].sort()).toEqual([1, 2, 3, 4]);
    expect([...values].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// ---------------------------------------------------------------------------
// 拿與摔壞
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜拿', () => {
  it('5. 站著不動，貨流到你這一格就拿：進背包、離開帶子、拿的件數與重量價值累計', () => {
    const s = makeState({
      belt: [makeGood(5, 2, 5, 9)],
      players: [{ cell: at(6) }, { cell: FAR_AI }],
    });
    const after = d10Game.step(s, IDLE);
    expect(after.belt).toEqual([]);
    expect(after.bag[0]).toEqual([{ w: 2, v: 5 }]);
    expect(after.bag[1]).toEqual([]);
    expect(after.taken).toEqual([1, 0]);
    expect(after.takenW).toEqual([2, 0]);
    expect(after.takenV).toEqual([5, 0]);
    expect(after.players[0].score).toBe(0);
  });

  it('5. 對 AI 那一邊也一樣（站著等貨流進來）', () => {
    const s = makeState({
      belt: [makeGood(35, 3, 7, 9)],
      players: [{ cell: FAR_HUMAN }, { cell: at(36) }],
    });
    const after = d10Game.step(s, IDLE);
    expect(after.bag[1]).toEqual([{ w: 3, v: 7 }]);
    expect(after.taken).toEqual([0, 1]);
  });

  it('6. 走到貨那一格就拿；不是走格的那個 tick 人沒動，就沒拿', () => {
    const s = atMove({
      belt: [makeGood(5, 2, 5, 0)],
      players: [{ cell: at(4) }, { cell: FAR_AI }],
    });
    const after = d10Game.step(s, [PRESS_RIGHT, NONE]);
    expect(after.players[0].cell).toBe(at(5));
    expect(after.bag[0]).toEqual([{ w: 2, v: 5 }]);
    expect(after.belt).toEqual([]);
    const early = makeState({
      belt: [makeGood(5, 2, 5, 0)],
      players: [{ cell: at(4) }, { cell: FAR_AI }],
    });
    const notYet = d10Game.step(early, [PRESS_RIGHT, NONE]);
    expect(notYet.bag[0]).toEqual([]);
    expect(notYet.belt).toHaveLength(1);
  });

  it('7. 放不下就不拿，貨繼續流：背包 6、貨重 3（9 > 8）', () => {
    const bag: D10State['bag'] = [
      [
        { w: 3, v: 1 },
        { w: 3, v: 1 },
      ],
      [],
    ];
    const s = makeState({
      bag,
      belt: [makeGood(5, 3, 9, 9)],
      players: [{ cell: at(6) }, { cell: FAR_AI }],
    });
    const after = d10Game.step(s, IDLE);
    expect(after.bag[0]).toEqual(bag[0]);
    expect(after.belt).toHaveLength(1);
    expect(after.belt[0]).toMatchObject({ idx: 6, w: 3, v: 9 });
    expect(after.taken).toEqual([0, 0]);
    expect(after.broken).toBe(0);
    // 貨繼續流：10 個 tick 之後到下一格，人還站在原地（什麼都沒發生）。
    const later = run(d10Game, after, 10);
    expect(later.belt[0]).toMatchObject({ idx: 7 });
  });

  it('7. 邊界：背包剛好 8 放得下，9 放不下', () => {
    const six: D10State['bag'] = [
      [
        { w: 3, v: 1 },
        { w: 3, v: 1 },
      ],
      [],
    ];
    const fits = d10Game.step(
      makeState({
        bag: six,
        belt: [makeGood(5, 2, 9, 9)],
        players: [{ cell: at(6) }, { cell: FAR_AI }],
      }),
      IDLE,
    );
    expect(fits.bag[0]).toHaveLength(3);
    const full: D10State['bag'] = [
      [
        { w: 4, v: 1 },
        { w: 4, v: 1 },
      ],
      [],
    ];
    const over = d10Game.step(
      makeState({
        bag: full,
        belt: [makeGood(5, 1, 9, 9)],
        players: [{ cell: at(6) }, { cell: FAR_AI }],
      }),
      IDLE,
    );
    expect(over.bag[0]).toHaveLength(2);
    expect(over.belt).toHaveLength(1);
  });

  it('8. 兩個人同時符合（同一個 tick 結束時都站在那格、都放得下）：貨摔壞，誰也得不到', () => {
    const s = makeState({
      belt: [makeGood(5, 2, 9, 9)],
      players: [{ cell: at(6) }, { cell: at(6) }],
    });
    const after = d10Game.step(s, IDLE);
    expect(after.belt).toEqual([]);
    expect(after.bag).toEqual([[], []]);
    expect(after.broken).toBe(1);
    expect(after.taken).toEqual([0, 0]);
  });

  it('8. 同一個 tick：一個人走進那一格、另一個人本來就站在那裡等貨流進來 → 三者在同一格，摔壞', () => {
    // 貨 age 9 → 10 在這一步流進 at(5)；人 0 在這一步從 at(4) 走進 at(5)；人 1 本來就站在 at(5)。
    const s = atMove({
      belt: [makeGood(4, 2, 9, 9)],
      players: [{ cell: at(4) }, { cell: at(5) }],
    });
    const after = d10Game.step(s, [PRESS_RIGHT, NONE]);
    expect(after.players[0].cell).toBe(at(5));
    expect(after.belt).toEqual([]);
    expect(after.broken).toBe(1);
    expect(after.bag).toEqual([[], []]);
  });

  it('8. 只有一個人放得下：他拿走，不摔壞', () => {
    const heavy: D10State['bag'] = [[{ w: 7, v: 1 }], []];
    const after = d10Game.step(
      makeState({
        bag: heavy,
        belt: [makeGood(5, 2, 9, 9)],
        players: [{ cell: at(6) }, { cell: at(6) }],
      }),
      IDLE,
    );
    expect(after.bag[1]).toEqual([{ w: 2, v: 9 }]);
    expect(after.bag[0]).toEqual([{ w: 7, v: 1 }]);
    expect(after.broken).toBe(0);
    expect(after.taken).toEqual([0, 1]);
  });

  it('8. 兩個人都放不下：什麼都不發生，貨繼續流，不摔壞', () => {
    const heavy: D10State['bag'] = [[{ w: 7, v: 1 }], [{ w: 7, v: 1 }]];
    const after = d10Game.step(
      makeState({
        bag: heavy,
        belt: [makeGood(5, 2, 9, 9)],
        players: [{ cell: at(6) }, { cell: at(6) }],
      }),
      IDLE,
    );
    expect(after.belt).toHaveLength(1);
    expect(after.broken).toBe(0);
    expect(after.bag).toEqual(heavy);
  });

  it('8. 出貨中的人不算「符合」：另一個人站在同一格，不摔壞，他拿走', () => {
    const after = d10Game.step(
      makeState({
        bag: [[{ w: 1, v: 1 }], []],
        ship: [30, 0],
        belt: [makeGood(5, 2, 9, 9)],
        players: [{ cell: at(6) }, { cell: at(6) }],
      }),
      IDLE,
    );
    expect(after.bag[1]).toEqual([{ w: 2, v: 9 }]);
    expect(after.broken).toBe(0);
  });

  it('9. 摔壞數是兩邊共用的累計，每摔一件加 1', () => {
    let s = makeState({
      belt: [makeGood(5, 2, 9, 9), makeGood(35, 1, 4, 9)],
      players: [{ cell: at(6) }, { cell: at(6) }],
    });
    s = d10Game.step(s, IDLE);
    expect(s.broken).toBe(1);
    expect(s.belt).toHaveLength(1);
    expect(s.belt[0]).toMatchObject({ idx: 36 });
  });
});

// ---------------------------------------------------------------------------
// 出貨
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜出貨', () => {
  const BAG: D10State['bag'] = [
    [
      { w: 2, v: 5 },
      { w: 1, v: 3 },
    ],
    [],
  ];

  it('10. 按 b（背包不空）：開始出貨，倒數 60；原地不能動，方向鍵沒有作用，pending 不累積', () => {
    const start = makeState({ bag: BAG, players: [{ cell: cell(10, 10) }, { cell: FAR_AI }] });
    let s = d10Game.step(start, [SHIP_BUTTON, NONE]);
    expect(s.ship).toEqual([60, 0]);
    expect(s.players[0].score).toBe(0);
    for (let i = 0; i < 59; i += 1) {
      s = d10Game.step(s, [PRESS_RIGHT, NONE]);
      expect(s.players[0].cell).toBe(cell(10, 10));
      expect(s.players[0].pending).toBe(-1);
    }
    expect(s.ship).toEqual([1, 0]);
  });

  it('10. 邊界：按 b 之後第 59 個 tick 還沒入帳，第 60 個 tick 入帳（價值 8）、背包清空、出貨次數 +1', () => {
    let s = d10Game.step(makeState({ bag: BAG }), [SHIP_BUTTON, NONE]);
    s = run(d10Game, s, 59);
    expect(s.ship).toEqual([1, 0]);
    expect(s.players[0].score).toBe(0);
    expect(s.bag[0]).toHaveLength(2);
    s = d10Game.step(s, IDLE);
    expect(s.ship).toEqual([0, 0]);
    expect(s.players[0].score).toBe(8);
    expect(s.bag[0]).toEqual([]);
    expect(s.ships).toEqual([1, 0]);
  });

  it('10. 出貨完可以走了：pending 從 -1 開始，按方向鍵又有作用', () => {
    let s = d10Game.step(
      makeState({ bag: BAG, players: [{ cell: cell(10, 10) }, { cell: FAR_AI }] }),
      [SHIP_BUTTON, NONE],
    );
    s = run(d10Game, s, 60, [PRESS_RIGHT, NONE]);
    expect(s.ship).toEqual([0, 0]);
    expect(s.players[0].cell).toBe(cell(10, 10));
    s = run(d10Game, s, 5, [PRESS_RIGHT, NONE]);
    expect(s.players[0].cell).not.toBe(cell(10, 10));
  });

  it('11. 背包是空的按 b：什麼都不發生；出貨中再按 b：倒數照常減，不重新開始', () => {
    const empty = d10Game.step(makeState(), [SHIP_BUTTON, NONE]);
    expect(empty.ship).toEqual([0, 0]);
    const shipping = d10Game.step(makeState({ bag: BAG, ship: [30, 0] }), [SHIP_BUTTON, NONE]);
    expect(shipping.ship).toEqual([29, 0]);
  });

  it('11. 同時按 b 與方向鍵：先出貨，這一步不走格', () => {
    const s = atMove({ bag: BAG, players: [{ cell: cell(10, 10) }, { cell: FAR_AI }] });
    const after = d10Game.step(s, [{ ...PRESS_RIGHT, b: true }, NONE]);
    expect(after.ship).toEqual([60, 0]);
    expect(after.players[0].cell).toBe(cell(10, 10));
  });

  it('12. 出貨期間不能拿：貨流到出貨中的人的格子，什麼都不發生，貨繼續流', () => {
    const s = makeState({
      bag: BAG,
      ship: [30, 0],
      belt: [makeGood(5, 1, 9, 9)],
      players: [{ cell: at(6) }, { cell: FAR_AI }],
    });
    const after = d10Game.step(s, IDLE);
    expect(after.bag[0]).toEqual(BAG[0]);
    expect(after.belt).toHaveLength(1);
  });

  it('12. 邊界：倒數到 0 的那一個 tick 已經可以拿（先入帳、背包先清空，再拿）；倒數剩 2 的那一步還不行', () => {
    const full: D10State['bag'] = [
      [
        { w: 4, v: 2 },
        { w: 4, v: 2 },
      ],
      [],
    ];
    const open = d10Game.step(
      makeState({
        bag: full,
        ship: [1, 0],
        belt: [makeGood(5, 3, 9, 9)],
        players: [{ cell: at(6) }, { cell: FAR_AI }],
      }),
      IDLE,
    );
    expect(open.players[0].score).toBe(4);
    expect(open.bag[0]).toEqual([{ w: 3, v: 9 }]);
    const closed = d10Game.step(
      makeState({
        bag: full,
        ship: [2, 0],
        belt: [makeGood(5, 3, 9, 9)],
        players: [{ cell: at(6) }, { cell: FAR_AI }],
      }),
      IDLE,
    );
    expect(closed.ship).toEqual([1, 0]);
    expect(closed.bag[0]).toEqual(full[0]);
    expect(closed.belt).toHaveLength(1);
  });

  it('13. 沒有「丟貨」或「換貨」的動作：按 a 什麼都不改變', () => {
    const s = makeState({ bag: BAG, players: [{ cell: cell(10, 10) }, { cell: FAR_AI }] });
    const after = d10Game.step(s, [{ ...NONE, a: true }, NONE]);
    expect(after.bag).toEqual(s.bag);
    expect(after.ship).toEqual([0, 0]);
    expect(after.players[0].score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 結束
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜結束與契約', () => {
  const LAST = 3599;

  it('時間到：分數高的贏、同分平手；背包裡沒出貨的不算分', () => {
    const win = d10Game.step(
      makeState({
        tick: LAST,
        bag: [[{ w: 4, v: 9 }], []],
        players: [{ score: 0 }, { score: 1 }],
      }),
      IDLE,
    );
    expect(win.over).toBe(true);
    expect(d10Game.isOver(win)).toBe(true);
    expect(d10Game.score(win)).toEqual([0, 1]);
    expect(d10Game.winner(win)).toBe(1);
    const draw = d10Game.step(makeState({ tick: LAST, bag: [[{ w: 4, v: 9 }], []] }), IDLE);
    expect(d10Game.winner(draw)).toBeNull();
    expect(d10Game.score(draw)).toEqual([0, 0]);
  });

  it('時間到：出到一半的不算分；剛好在最後一個 tick 倒數到 0 的算分', () => {
    const half = d10Game.step(
      makeState({ tick: LAST, bag: [[{ w: 4, v: 9 }], []], ship: [2, 0] }),
      IDLE,
    );
    expect(d10Game.score(half)).toEqual([0, 0]);
    const exact = d10Game.step(
      makeState({ tick: LAST, bag: [[{ w: 4, v: 9 }], []], ship: [1, 0] }),
      IDLE,
    );
    expect(d10Game.score(exact)).toEqual([9, 0]);
    expect(d10Game.winner(exact)).toBe(0);
  });

  it('結束之後再 step，state 原樣不變', () => {
    const over = d10Game.step(makeState({ tick: LAST }), IDLE);
    expect(d10Game.step(over, [PRESS_UP, SHIP_BUTTON])).toEqual(over);
  });

  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，包含拿、摔壞、出貨、出現、擲預告、消失的那一次）', () => {
    const cases: D10State[] = [
      makeState({
        belt: [makeGood(5, 2, 5, 9), makeGood(40, 1, 1, 599)],
        players: [{ cell: at(6) }, { cell: FAR_AI }],
      }),
      makeState({
        belt: [makeGood(5, 2, 5, 9)],
        players: [{ cell: at(6) }, { cell: at(6) }],
      }),
      makeState({ bag: [[{ w: 2, v: 5 }], [{ w: 1, v: 1 }]], ship: [1, 0] }),
      makeState({
        tick: 59,
        upcoming: { idx: 3, w: 2, v: 4, at: 60 },
      }),
      makeState({ tick: 89 }),
    ];
    for (const s of cases) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(s)) as D10State);
      const snapshot = JSON.stringify(frozen);
      expect(() => d10Game.step(frozen, [SHIP_BUTTON, PRESS_LEFT])).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(snapshot);
    }
  });

  it('沒有牆時，walls 與 ring 在 step 之間是同一個陣列物件（距離場才能快取）', () => {
    const s = d10Game.init(3, CONFIG);
    const after = run(d10Game, s, 20);
    expect(after.walls).toBe(s.walls);
    expect(after.ring).toBe(s.ring);
  });

  it('K1：同一個種子、同一串輸入跑兩次結果相同；兩個貪心型等級 10 打一整局：真的有拿、有出貨、貨真的摔壞過', () => {
    const play = (seed: number): D10State => {
      const a = levelController(d10Game, greedy, 10, seed);
      const b = levelController(d10Game, greedy, 10, seed + 1_000_003);
      let state = d10Game.init(seed, CONFIG);
      for (let tick = 0; !d10Game.isOver(state); tick += 1) {
        state = d10Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
      return state;
    };
    expect(play(2)).toEqual(play(2));
    let taken = 0;
    let ships = 0;
    let broken = 0;
    let scored = 0;
    for (let seed = 0; seed < 6; seed += 1) {
      const end = play(seed);
      taken += end.taken[0] + end.taken[1];
      ships += end.ships[0] + end.ships[1];
      broken += end.broken;
      scored += end.players[0].score + end.players[1].score;
    }
    expect(taken).toBeGreaterThan(30);
    expect(ships).toBeGreaterThan(6);
    expect(scored).toBeGreaterThan(30);
    expect(broken).toBeGreaterThan(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜actions', () => {
  const same = (a: Buttons, b: Buttons): boolean => JSON.stringify(a) === JSON.stringify(b);

  it('背包空：五個動作（四方向與全放開），全放開排最後，沒有出貨', () => {
    const actions = d10Game.actions(makeState(), 0);
    expect(actions).toHaveLength(5);
    expect(same(actions[4] as Buttons, NONE)).toBe(true);
    expect(actions.some((a) => a.b)).toBe(false);
    const dirs = actions.slice(0, 4).map((a) => [a.up, a.right, a.down, a.left].indexOf(true));
    expect([...dirs].sort()).toEqual([0, 1, 2, 3]);
  });

  it('背包不空、沒在出貨：多一個出貨（只按 b）排最後；出貨中：只有全放開', () => {
    const bag: D10State['bag'] = [[{ w: 1, v: 1 }], []];
    const actions = d10Game.actions(makeState({ bag }), 0);
    expect(actions).toHaveLength(6);
    expect(same(actions[5] as Buttons, SHIP_BUTTON)).toBe(true);
    expect(same(actions[4] as Buttons, NONE)).toBe(true);
    const shipping = d10Game.actions(makeState({ bag, ship: [20, 0] }), 0);
    expect(shipping).toHaveLength(1);
    expect(same(shipping[0] as Buttons, NONE)).toBe(true);
    // 對手出貨中不影響我
    expect(d10Game.actions(makeState({ bag, ship: [0, 20] }), 0)).toHaveLength(6);
  });

  it('排最前面的動作往目標靠近：預告的貨出現在上緣時，從左下角出發的人往上或往右', () => {
    const s = makeState({ upcoming: { idx: 10, w: 2, v: 6, at: 40 } });
    const first = d10Game.actions(s, 0)[0] as Buttons;
    expect(first.up || first.right).toBe(true);
    // 1 號邊（右上）的預設順序是 0 號邊轉 180 度：沒有任何貨時第一個動作往左下（下或左）。
    const none = d10Game.actions(makeState(), 1)[0] as Buttons;
    expect(none.down || none.left).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜evaluate', () => {
  /** 這一邊（0 號）每個動作往前走一個 tick 之後的 gain；對手維持它 actions 的第一個。 */
  const gains = (s: D10State): number[] => lookOneStep(d10Game, s, 0).map((x) => x.gain);
  const decide = (s: D10State, side: Side = 0): Buttons =>
    greedy.decide(d10Game, s, side, s.tick, { depth: 1, seed: 1 });
  const pressed = (b: Buttons): string =>
    b.b ? 'b' : ['up', 'right', 'down', 'left'].filter((k) => b[k as 'up']).join('') || 'none';

  it('已結束的局：贏的一邊 gain 高很多、輸的低很多，平手 0，danger 都是 0', () => {
    const win = makeState({ over: true, players: [{ score: 5 }, { score: 2 }] });
    expect(d10Game.evaluate(win, 0).gain).toBeGreaterThan(900_000);
    expect(d10Game.evaluate(win, 1).gain).toBeLessThan(-900_000);
    expect(d10Game.evaluate(win, 0).danger).toBe(0);
    expect(d10Game.evaluate(makeState({ over: true }), 0).gain).toBe(0);
  });

  it('gain 是有限的數、danger 在 0 到 1 之間（沿著真的對局取樣 200 個局面）', () => {
    const a = levelController(d10Game, precise, 10, 5);
    const b = levelController(d10Game, gambler, 10, 6);
    let state = d10Game.init(3, CONFIG);
    let count = 0;
    for (let tick = 0; !d10Game.isOver(state); tick += 1) {
      if (tick % 17 === 0) {
        for (const side of [0, 1] as const) {
          const { gain, danger } = d10Game.evaluate(state, side);
          expect(Number.isFinite(gain)).toBe(true);
          expect(danger).toBeGreaterThanOrEqual(0);
          expect(danger).toBeLessThanOrEqual(1);
        }
        count += 1;
      }
      state = d10Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
    }
    expect(count).toBeGreaterThanOrEqual(200);
  }, 60_000);

  it('單位一致（10.23）：貨就在隔壁、沒有人跟我搶時，走上去拿比停在旁邊值錢（AI 會去撿，不會站在旁邊吊著）', () => {
    const s = atMove({
      belt: [makeGood(5, 2, 9, 0)],
      players: [{ cell: at(4) }, { cell: FAR_AI }],
    });
    expect(pressed(decide(s))).toBe('right');
    // 走上去拿到手（背包 +9）比拿之前高。
    const before = d10Game.evaluate(s, 0).gain;
    const taken = d10Game.evaluate(d10Game.step(s, [PRESS_RIGHT, NONE]), 0).gain;
    expect(taken).toBeGreaterThan(before);
  });

  it('單位一致：貨比我晚到不了、對手離每件貨都比我近時，五個動作的 gain 也不全相同（AI 不會整個停住）', () => {
    const s = makeState({
      belt: [makeGood(20, 2, 8, 0), makeGood(21, 2, 6, 0), makeGood(22, 1, 7, 0)],
      players: [{ cell: FAR_HUMAN }, { cell: at(21) }],
    });
    const g = gains(s);
    expect(new Set(g.map((x) => Math.round(x * 1000))).size).toBeGreaterThan(1);
    expect(pressed(decide(s))).not.toBe('none');
  });

  it('出貨：背包滿了、貨都放不下，按 b 最好；背包只有一件小東西、有高價值的貨就要到手，不按 b', () => {
    const fullBag: D10State['bag'] = [
      [
        { w: 4, v: 5 },
        { w: 4, v: 5 },
      ],
      [],
    ];
    const full = atMove({
      bag: fullBag,
      belt: [makeGood(5, 2, 9, 0)],
      players: [{ cell: at(4) }, { cell: FAR_AI }],
    });
    expect(pressed(decide(full))).toBe('b');
    const small = atMove({
      bag: [[{ w: 1, v: 1 }], []],
      belt: [makeGood(5, 2, 9, 0)],
      players: [{ cell: at(4) }, { cell: FAR_AI }],
    });
    expect(pressed(decide(small))).toBe('right');
  });

  it('出貨：快結束了，背包有價值的話貪心型會在來不及之前出貨（整局的分數有入帳）；出不完的時間不算背包的價值', () => {
    const bag: D10State['bag'] = [[{ w: 2, v: 9 }], []];
    // 還剩 100 tick、場上沒有貨、沒有預告：貪心型自己決定什麼時候按 b，最後這 9 分一定要入帳。
    let s = makeState({ tick: 3600 - 100, bag, upcoming: null });
    const controller = levelController(d10Game, greedy, 10, 1);
    for (let tick = s.tick; !d10Game.isOver(s); tick += 1) {
      s = d10Game.step(s, [controller.decide(s, 0, tick), NONE]);
    }
    expect(d10Game.score(s)[0]).toBe(9);
    // 剩下的時間已經出不完：背包的價值不算（跟背包是空的一樣）。
    const tooLate = makeState({ tick: 3600 - 40, bag });
    const empty = makeState({ tick: 3600 - 40 });
    expect(d10Game.evaluate(tooLate, 0).gain).toBeCloseTo(d10Game.evaluate(empty, 0).gain, 6);
  });

  it('danger（摔壞）：兩個人同時到同一件價值高的貨，danger 至少 TIE_PENALTY × 0.8；對手夠遠就是 0', () => {
    const tie = makeState({
      belt: [makeGood(5, 2, 9, 5)],
      players: [{ cell: at(6) }, { cell: at(6) }],
    });
    expect(d10Game.evaluate(tie, 0).danger).toBeGreaterThanOrEqual(TIE_PENALTY * 0.8);
    expect(d10Game.evaluate(tie, 1).danger).toBeGreaterThanOrEqual(TIE_PENALTY * 0.8);
    const alone = makeState({
      belt: [makeGood(5, 2, 9, 5)],
      players: [{ cell: at(6) }, { cell: FAR_AI }],
    });
    expect(d10Game.evaluate(alone, 0).danger).toBe(0);
  });

  it('danger（占掉空間）：背包快滿了，低密度的重貨就要到手 → danger 高；同樣的背包，高密度的貨 → 0', () => {
    const bag: D10State['bag'] = [[{ w: 5, v: 8 }], []];
    const junk = makeState({
      bag,
      belt: [makeGood(5, 3, 1, 5)],
      players: [{ cell: at(6) }, { cell: FAR_AI }],
    });
    expect(d10Game.evaluate(junk, 0).danger).toBeGreaterThan(0.4);
    const gem = makeState({
      bag,
      belt: [makeGood(5, 1, 9, 5)],
      players: [{ cell: at(6) }, { cell: FAR_AI }],
    });
    expect(d10Game.evaluate(gem, 0).danger).toBe(0);
  });

  it('danger（來不及出貨）：快結束了背包還有價值 → 有 danger；已經在出貨中 → 0', () => {
    const bag: D10State['bag'] = [
      [
        { w: 4, v: 9 },
        { w: 4, v: 9 },
      ],
      [],
    ];
    const left = makeState({ tick: 3600 - 61, bag });
    expect(d10Game.evaluate(left, 0).danger).toBeGreaterThan(0.1);
    const shipping = makeState({ tick: 3600 - 61, bag, ship: [30, 0] });
    expect(d10Game.evaluate(shipping, 0).danger).toBe(0);
    expect(d10Game.evaluate(makeState({ tick: 100, bag }), 0).danger).toBe(0);
  });

  it('不是橡皮筋：兩邊分數對調（領先變落後），五個動作相對第一個動作的 gain 差一模一樣', () => {
    const base = {
      belt: [makeGood(5, 2, 9, 0), makeGood(35, 1, 4, 0)],
      players: [{ cell: at(3) }, { cell: at(33) }] as const,
    };
    const lead = gains(
      makeState({
        ...base,
        players: [
          { cell: at(3), score: 7 },
          { cell: at(33), score: 1 },
        ],
      }),
    );
    const trail = gains(
      makeState({
        ...base,
        players: [
          { cell: at(3), score: 1 },
          { cell: at(33), score: 7 },
        ],
      }),
    );
    const rel = (g: number[]): number[] => g.map((x) => x - (g[0] as number));
    rel(lead).forEach((x, i) => expect(x).toBeCloseTo(rel(trail)[i] as number, 6));
  });

  it('對稱：局面轉 180 度、兩邊對調，同一組 gain 與 danger', () => {
    const rotateCell = (c: number): number => cell(31 - cellX(c), 23 - cellY(c));
    const rotate = (s: D10State): D10State => ({
      ...s,
      players: [
        { ...s.players[1], cell: rotateCell(s.players[1].cell) },
        { ...s.players[0], cell: rotateCell(s.players[0].cell) },
      ],
      belt: s.belt.map((g) => ({ ...g, idx: (g.idx + 30) % RING, cell: at((g.idx + 30) % RING) })),
      upcoming: s.upcoming === null ? null : { ...s.upcoming, idx: (s.upcoming.idx + 30) % RING },
      pairIdx: (s.pairIdx + 30) % RING,
      bag: [s.bag[1], s.bag[0]],
      ship: [s.ship[1], s.ship[0]],
    });
    const samples = [
      makeState({
        belt: [makeGood(5, 2, 9, 3), makeGood(37, 3, 4, 120)],
        players: [
          { cell: cell(9, 9), score: 2 },
          { cell: cell(20, 14), score: 5 },
        ],
        bag: [[{ w: 3, v: 2 }], [{ w: 5, v: 6 }]],
        upcoming: { idx: 44, w: 2, v: 7, at: 30 },
        pairLeft: 1,
        pairIdx: 14,
        tick: 17,
      }),
      makeState({
        belt: [makeGood(12, 4, 2, 77)],
        players: [{ cell: at(11) }, { cell: at(41) }],
        ship: [0, 25],
        bag: [[], [{ w: 2, v: 5 }]],
        tick: 301,
      }),
    ];
    for (const s of samples) {
      for (const side of [0, 1] as const) {
        const a = d10Game.evaluate(s, side);
        const b = d10Game.evaluate(rotate(s), side === 0 ? 1 : 0);
        expect(a.gain).toBeCloseTo(b.gain, 6);
        expect(a.danger).toBeCloseTo(b.danger, 6);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 盲測：AI 不可以偷看隱藏資訊（rng），也不看只為量測存在的累計欄位
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜盲測（decide、evaluate、actions）', () => {
  const NAMES = ['precise', 'greedy', 'gambler', 'pathfinder'] as const;
  const POLICIES: Record<(typeof NAMES)[number], Policy> = { precise, greedy, gambler, pathfinder };
  const DEPTHS = [1, 3] as const;

  function snapshots(): D10State[] {
    const out: D10State[] = [];
    for (const seed of [1, 2]) {
      const a = levelController(d10Game, precise, 10, seed);
      const b = levelController(d10Game, gambler, 10, seed + 5);
      let state = d10Game.init(seed, CONFIG);
      for (let tick = 0; tick < 2400 && !d10Game.isOver(state); tick += 1) {
        if (tick % 97 === 3) {
          out.push(state);
        }
        state = d10Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    return out;
  }

  /** 只改 rng 與累計欄位：這幾個欄位對 AI 能看到的東西沒有影響，AI 不該受影響。 */
  const scramble = (s: D10State, n: number): D10State => ({
    ...s,
    rng: (s.rng + 977 * (n + 1)) >>> 0,
    taken: [s.taken[0] + n, s.taken[1] + 2 * n],
    takenW: [s.takenW[0] + 3 * n, s.takenW[1] + n],
    takenV: [s.takenV[0] + 7 * n, s.takenV[1] + 5 * n],
    broken: s.broken + 2 * n,
    ships: [s.ships[0] + n, s.ships[1] + 3 * n],
  });

  function decideLeaks(game: Game<D10State>, states: readonly D10State[]): string[] {
    const leaks: string[] = [];
    for (const s of states) {
      for (const side of [0, 1] as const) {
        for (const name of NAMES) {
          for (const depth of DEPTHS) {
            const params = { depth, seed: 1 };
            const seen = POLICIES[name].decide(game, s, side, 1, params);
            const other = POLICIES[name].decide(game, scramble(s, 1 + depth), side, 1, params);
            if (JSON.stringify(seen) !== JSON.stringify(other)) {
              leaks.push(`${name}/${depth}/tick ${s.tick}`);
            }
          }
        }
      }
    }
    return leaks;
  }

  function equalityLeaks(game: Game<D10State>, states: readonly D10State[]): string[] {
    const leaks: string[] = [];
    for (const s of states) {
      for (const n of [2, 5]) {
        const t = scramble(s, n);
        for (const side of [0, 1] as const) {
          if (JSON.stringify(game.actions(s, side)) !== JSON.stringify(game.actions(t, side))) {
            leaks.push(`actions/tick ${s.tick}/side ${side}`);
          }
          const x = game.evaluate(s, side);
          const y = game.evaluate(t, side);
          if (x.gain !== y.gain || x.danger !== y.danger) {
            leaks.push(`evaluate/tick ${s.tick}/side ${side}`);
          }
        }
      }
    }
    return leaks;
  }

  function leaky(kind: 'rng' | 'takenV'): Game<D10State> {
    return {
      ...d10Game,
      evaluate(s: D10State, side: Side) {
        const base = d10Game.evaluate(s, side);
        const bias = kind === 'rng' ? (s.rng % 7) - 3 : s.takenV[side];
        return {
          gain: base.gain + bias * 30 * (cellX(s.players[side].cell) - 15),
          danger: base.danger,
        };
      },
    };
  }

  const states = snapshots();

  it('取樣到的局面涵蓋有貨、有預告、背包不空、出貨中等各種時候', () => {
    expect(states.length).toBeGreaterThan(40);
    expect(states.some((s) => s.belt.length > 0)).toBe(true);
    expect(states.some((s) => s.upcoming !== null)).toBe(true);
    expect(states.some((s) => s.bag[0].length > 0 || s.bag[1].length > 0)).toBe(true);
    expect(states.some((s) => s.ship[0] > 0 || s.ship[1] > 0)).toBe(true);
  });

  it('真的遊戲：只改 rng 與累計欄位，四個性格 × depth 1／3 × 兩邊的 decide 完全不變', () => {
    expect(decideLeaks(d10Game, states)).toEqual([]);
  }, 120_000);

  it('真的遊戲：evaluate 與 actions 在 rng 與累計欄位不同時完全相等', () => {
    expect(equalityLeaks(d10Game, states)).toEqual([]);
  }, 60_000);

  it('注入「偷看 rng」或「偷看累計」的 evaluate：抓得到（必須是紅的）', () => {
    expect(equalityLeaks(leaky('rng'), states).length).toBeGreaterThan(0);
    expect(equalityLeaks(leaky('takenV'), states).length).toBeGreaterThan(0);
    expect(decideLeaks(leaky('rng'), states).length).toBeGreaterThan(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 互動強度（2.5）
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜互動強度（DESIGN-AI-FUN 2.5）', () => {
  it('200 個局面：把 AI 換到「在人最想攔的那件貨的下游等」vs「在遠處」，人這一邊 1 步 evaluate 的最好動作改變的局面至少 20%', () => {
    const samples: D10State[] = [];
    for (let seed = 0; seed < 10 && samples.length < 200; seed += 1) {
      const a = levelController(d10Game, greedy, 10, seed);
      const b = levelController(d10Game, greedy, 10, seed + 1_000_003);
      let state = d10Game.init(seed, CONFIG);
      for (let tick = 0; !d10Game.isOver(state); tick += 1) {
        // 只取人沒在出貨、場上有貨的局面（變因只有 AI 的位置）。
        if (
          tick % 40 === 21 &&
          samples.length < 200 &&
          state.ship[0] === 0 &&
          state.belt.length > 0
        ) {
          samples.push(state);
        }
        state = d10Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    let changed = 0;
    for (const sample of samples) {
      // 人最想攔的那件：人最早站得到的那件（幾何，用公開的攔截時刻）。
      const rows = catchTable(sample, 0).filter((r) => r.kind === 'belt');
      const nearest = rows.reduce(
        (x, y) => (y.mineTau < x.mineTau ? y : x),
        rows[0] as (typeof rows)[number],
      );
      const target = sample.belt.find((g) => g.idx === nearest.idx) as Good;
      const downstream: D10State = {
        ...sample,
        players: [
          sample.players[0],
          { ...sample.players[1], cell: at((target.idx + 3) % RING), pending: -1 },
        ],
        bag: [sample.bag[0], []],
        ship: [sample.ship[0], 0],
      };
      const far: D10State = {
        ...sample,
        players: [sample.players[0], { ...sample.players[1], cell: FAR_AI, pending: -1 }],
        bag: [sample.bag[0], []],
        ship: [sample.ship[0], 0],
      };
      const best = (s: D10State): string => {
        const g = lookOneStep(d10Game, s, 0).map((x) => x.gain);
        return String(g.indexOf(Math.max(...g)));
      };
      if (best(downstream) !== best(far)) {
        changed += 1;
      }
    }
    expect(samples.length).toBeGreaterThanOrEqual(150);
    expect(changed / samples.length).toBeGreaterThanOrEqual(0.2);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 劇本玩家（小規格「實作前要驗證的事」第 3 條）
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜劇本玩家與探針 A（真實規則、真實 AI）', () => {
  /** 劇本玩家對 AI（性格 policy 的等級 10），偶數種子坐 0 號邊；回傳勝率（平手半場）。 */
  function winRate(
    make: () => Controller<D10State>,
    policy: Policy,
    seeds: number,
    level = 10,
  ): number {
    let points = 0;
    for (let seed = 0; seed < seeds; seed += 1) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const me = make();
      const ai = levelController(d10Game, policy, level, seed + 1_000_003);
      const result =
        side === 0
          ? playMatch(d10Game, seed, CONFIG, me, ai)
          : playMatch(d10Game, seed, CONFIG, ai, me);
      points += result.winner === null ? 0.5 : result.winner === side ? 1 : 0;
    }
    return points / seeds;
  }

  const SEEDS = 60;

  it('四個劇本玩家各打貪心型與精準型等級 10（種子 0 到 59）：「盯對手背包」勝過「站在圈中央」', () => {
    for (const policy of [greedy, precise]) {
      const watching = winRate(() => watchBag(), policy, SEEDS);
      const centered = winRate(() => center(), policy, SEEDS);
      expect(watching, `盯對手背包 ${policy.name}`).toBeGreaterThan(centered);
    }
  }, 900_000);

  it('四個劇本玩家：「盯對手背包」勝過「只攔密度 ≥ 2」與「追預告的下一件」（對貪心型與對精準型都是）', () => {
    for (const policy of [greedy, precise]) {
      const watching = winRate(() => watchBag(), policy, SEEDS);
      expect(watching, `盯對手背包 vs 只攔密度 ${policy.name}`).toBeGreaterThan(
        winRate(() => dense(), policy, SEEDS),
      );
      expect(watching, `盯對手背包 vs 追預告 ${policy.name}`).toBeGreaterThan(
        winRate(() => upcomingChaser(), policy, SEEDS),
      );
    }
  }, 1_800_000);

  it('探針 A 的三組玩家都打得起來（有拿、有出貨）：不知道有對手、知道但不讀、讀', () => {
    for (const kind of ['unaware', 'aware', 'reads'] as const) {
      const me = probe(kind);
      const ai = levelController(d10Game, precise, 10, 1_000_003);
      const result = playMatch(d10Game, 0, CONFIG, me, ai);
      expect(result.score[0], kind).toBeGreaterThan(0);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 四性格指紋（2.3）：測機制，不測症狀（DESIGN-AI-FUN 10.48）
// ---------------------------------------------------------------------------

describe('D-10 輸送帶｜四性格指紋', () => {
  interface Print {
    /** 拿到的貨的平均價值密度（Σv ÷ Σw）。 */
    density: number;
    /** 每場出貨次數。 */
    ships: number;
    /** 每場摔壞幾件（共用，所以是這個性格對上貪心型的那一場）。 */
    broken: number;
    /** 機制：每個決定選到的動作的 danger 平均。 */
    chosenDanger: number;
  }

  /** 各性格等級 10 對貪心型等級 10，40 場。 */
  function fingerprint(policy: Policy): Print {
    let takenW = 0;
    let takenV = 0;
    let ships = 0;
    let broken = 0;
    let dangerSum = 0;
    let decisions = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const other: Side = side === 0 ? 1 : 0;
      const me = levelController(d10Game, policy, 10, seed);
      const ai = levelController(d10Game, greedy, 10, seed + 1_000_003);
      let state = d10Game.init(seed, CONFIG);
      for (let tick = 0; !d10Game.isOver(state); tick += 1) {
        const mine = me.decide(state, side, tick);
        const theirs = ai.decide(state, other, tick);
        if (tick % 5 === 0) {
          const after = d10Game.step(state, side === 0 ? [mine, theirs] : [theirs, mine]);
          dangerSum += d10Game.evaluate(after, side).danger;
          decisions += 1;
        }
        state = d10Game.step(state, side === 0 ? [mine, theirs] : [theirs, mine]);
      }
      takenW += state.takenW[side] as number;
      takenV += state.takenV[side] as number;
      ships += state.ships[side] as number;
      broken += state.broken;
    }
    return {
      density: takenV / Math.max(1, takenW),
      ships: ships / 40,
      broken: broken / 40,
      chosenDanger: dangerSum / Math.max(1, decisions),
    };
  }

  /** 四個性格的指紋，第一次用到才算（打 160 場），之後共用。 */
  let cached: Record<'greedy' | 'precise' | 'gambler' | 'pathfinder', Print> | null = null;
  const getPrints = (): Record<'greedy' | 'precise' | 'gambler' | 'pathfinder', Print> => {
    cached ??= {
      greedy: fingerprint(greedy),
      precise: fingerprint(precise),
      gambler: fingerprint(gambler),
      pathfinder: fingerprint(pathfinder),
    };
    return cached;
  };

  it('機制：賭徒型選到的動作的 danger 平均比精準型高（它被 danger 吸引，精準型躲它）', () => {
    expect(getPrints().gambler.chosenDanger).toBeGreaterThan(
      getPrints().precise.chosenDanger * 1.5,
    );
    expect(getPrints().greedy.chosenDanger).toBeGreaterThan(getPrints().precise.chosenDanger);
  }, 900_000);

  it('預測：平均密度 精準／貪心 ≥ 1.3', () => {
    expect(getPrints().precise.density / getPrints().greedy.density).toBeGreaterThanOrEqual(1.3);
  }, 900_000);

  it('預測：摔壞 貪心／精準 ≥ 1.5', () => {
    expect(
      getPrints().greedy.broken / Math.max(getPrints().precise.broken, 0.01),
    ).toBeGreaterThanOrEqual(1.5);
  }, 900_000);

  it('預測：出貨次數 貪心／賭徒 ≥ 1.5', () => {
    expect(
      getPrints().greedy.ships / Math.max(getPrints().gambler.ships, 0.01),
    ).toBeGreaterThanOrEqual(1.5);
  }, 900_000);
});
