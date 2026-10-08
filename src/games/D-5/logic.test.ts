import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import { rngStateFor } from '../../core/rng';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import { bfsDistances, CELLS, cell, cellX, START_CELLS } from '../_diamonds/logic';
import {
  BEFORE_MOVE,
  CONFIG,
  deepFreeze,
  describeSharedDiamondsRules,
  IDLE,
  NONE,
  PRESS_DOWN,
  PRESS_LEFT,
  PRESS_RIGHT,
  PRESS_UP,
  run,
} from '../_diamonds/shared-rules.test-helpers';
import {
  COOL,
  d5Game,
  DEPOT_COUNT,
  DEPOT_GAP,
  makeState,
  PARCEL_COUNT,
  WORTH_STEP,
  worthOf,
} from './logic';
import type { D5State, Parcel } from './logic';

/**
 * D-5 送貨的規則測試。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * `makeState` 預設：沒有牆、三個倉庫 紅 (8,6)、綠 (23,17)、藍 (23,6)，五件包裹
 * 紅 (12,4)、綠 (20,4)、藍 (12,19)、紅 (20,19)、綠 (16,12)，兩邊空手、`cool` 全 0。
 * 方向是絕對方向（上 = y 減少）。
 */

const RED = 0;
const GREEN = 1;
const BLUE = 2;

const DEPOT_RED = cell(8, 6);
const DEPOT_GREEN = cell(23, 17);
const DEPOT_BLUE = cell(23, 6);
const FAR_AI = cell(25, 20);

describeSharedDiamondsRules<D5State>({
  label: 'D-5 送貨',
  game: d5Game,
  makeState,
  pickupCells: (state) => state.parcels.map((p) => p.cell),
  withPickups: (cells) => ({
    parcels: cells.map((c, i): Parcel => ({ cell: c, colour: i % 3 })),
  }),
  count: PARCEL_COUNT,
});

/** 下一次 step 就是走格結算：兩個角色預設離所有倉庫與包裹都很遠。 */
function atMove(overrides: Parameters<typeof makeState>[0] = {}): D5State {
  return makeState({
    tick: BEFORE_MOVE,
    players: [{ cell: cell(5, 5) }, { cell: FAR_AI }],
    ...overrides,
  });
}

/** 場上五件包裹，除了指定的幾件之外其餘放在很遠的角落（不會干擾這一步）。 */
function parcelsWith(first: readonly Parcel[]): Parcel[] {
  const fillers: Parcel[] = [
    { cell: cell(14, 21), colour: RED },
    { cell: cell(16, 21), colour: GREEN },
    { cell: cell(18, 21), colour: BLUE },
    { cell: cell(20, 21), colour: RED },
    { cell: cell(22, 21), colour: GREEN },
  ];
  return [...first, ...fillers.slice(0, PARCEL_COUNT - first.length)];
}

const colourCounts = (parcels: readonly Parcel[]): number[] => {
  const counts = [0, 0, 0];
  for (const p of parcels) {
    counts[p.colour] = (counts[p.colour] as number) + 1;
  }
  return counts;
};

// ---------------------------------------------------------------------------
// 初始
// ---------------------------------------------------------------------------

describe('D-5 送貨｜初始', () => {
  it('開局：兩邊空手、倉庫都沒在休息、送達與等待是 0、分數 0、一局固定 3600 tick', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const state = d5Game.init(seed, CONFIG);
      expect(state.carry).toEqual([null, null]);
      expect(state.cool).toEqual([0, 0, 0]);
      expect(state.delivered).toEqual([0, 0]);
      expect(state.waited).toEqual([0, 0]);
      expect(state.depots).toHaveLength(DEPOT_COUNT);
      expect(state.parcels).toHaveLength(PARCEL_COUNT);
      expect(d5Game.score(state)).toEqual([0, 0]);
      expect(state.maxTicks).toBe(3600);
      expect(COOL).toBe(150);
      expect(PARCEL_COUNT).toBe(5);
      expect(DEPOT_COUNT).toBe(3);
    }
  });

  it('倉庫：三個不同的格子、不在牆上、不在起點；兩兩至少 8 步；到兩個起點的步數差 ≤ 2（種子 0 到 49）', () => {
    expect(DEPOT_GAP).toBe(8);
    for (let seed = 0; seed < 50; seed += 1) {
      const state = d5Game.init(seed, CONFIG);
      expect(new Set(state.depots).size, `種子 ${seed}`).toBe(3);
      const fromHuman = bfsDistances(state.walls, START_CELLS[0]);
      const fromAi = bfsDistances(state.walls, START_CELLS[1]);
      for (const d of state.depots) {
        expect(state.walls[d], `種子 ${seed}：倉庫在牆上`).toBe(0);
        expect(START_CELLS, `種子 ${seed}：倉庫在起點上`).not.toContain(d);
        expect(
          Math.abs((fromHuman[d] as number) - (fromAi[d] as number)),
          `種子 ${seed}：倉庫 ${d} 到兩個起點的步數差`,
        ).toBeLessThanOrEqual(2);
      }
      for (let i = 0; i < 3; i += 1) {
        const field = bfsDistances(state.walls, state.depots[i] as number);
        for (let j = i + 1; j < 3; j += 1) {
          expect(
            field[state.depots[j] as number] as number,
            `種子 ${seed}：倉庫 ${i} 與 ${j} 太近`,
          ).toBeGreaterThanOrEqual(DEPOT_GAP);
        }
      }
    }
  });

  it('倉庫的位置隨種子變：種子 0 到 9 至少 6 種不同的排法', () => {
    const layouts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      layouts.add(d5Game.init(seed, CONFIG).depots.join(','));
    }
    expect(layouts.size).toBeGreaterThanOrEqual(6);
  });

  it('開局的包裹：五件、不在牆／倉庫／起點上、不重疊；顏色是「最少的那種」補出來的（2、2、1）', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const state = d5Game.init(seed, CONFIG);
      const cells = state.parcels.map((p) => p.cell);
      expect(new Set(cells).size, `種子 ${seed}`).toBe(PARCEL_COUNT);
      for (const c of cells) {
        expect(state.walls[c], `種子 ${seed}：包裹在牆上`).toBe(0);
        expect(state.depots, `種子 ${seed}：包裹在倉庫上`).not.toContain(c);
        expect(START_CELLS, `種子 ${seed}：包裹在起點上`).not.toContain(c);
      }
      expect([...colourCounts(state.parcels)].sort(), `種子 ${seed}`).toEqual([1, 2, 2]);
    }
  });

  it('同一個種子 init 兩次完全相同', () => {
    for (const seed of [0, 3, 41]) {
      expect(d5Game.init(seed, CONFIG)).toEqual(d5Game.init(seed, CONFIG));
    }
  });
});

// ---------------------------------------------------------------------------
// 價值
// ---------------------------------------------------------------------------

describe('D-5 送貨｜價值（worth = 1 + ⌊繞牆步數 / 8⌋）', () => {
  const state = makeState();

  it('邊界：距離 7 是 1 分、距離 8 跳到 2 分；距離 15 還是 2、16 跳到 3', () => {
    expect(WORTH_STEP).toBe(8);
    expect(worthOf(state.walls, DEPOT_RED, cell(15, 6))).toBe(1); // 距離 7
    expect(worthOf(state.walls, DEPOT_RED, cell(16, 6))).toBe(2); // 距離 8
    expect(worthOf(state.walls, DEPOT_RED, cell(23, 6))).toBe(2); // 距離 15
    expect(worthOf(state.walls, DEPOT_RED, cell(24, 6))).toBe(3); // 距離 16
    expect(worthOf(state.walls, DEPOT_RED, cell(9, 6))).toBe(1); // 距離 1
  });

  it('算的是繞牆的步數，不是直線距離', () => {
    // 倉庫 (8,6) 與包裹 (10,6) 之間隔一道牆 (9,5)(9,6)(9,7)：直線 2，繞過去要 6 步。
    const walled = makeState({ walls: [cell(9, 5), cell(9, 6), cell(9, 7)] });
    expect(bfsDistances(walled.walls, DEPOT_RED)[cell(10, 6)]).toBe(6);
    expect(worthOf(walled.walls, DEPOT_RED, cell(10, 6))).toBe(1);
    // 牆高到要繞 10 步：(9,2) 到 (9,10) 全是牆 → 繞過去 (9,1) 或 (9,11)。
    const tall = makeState({
      walls: Array.from({ length: 9 }, (_v, i) => cell(9, 2 + i)),
    });
    const around = bfsDistances(tall.walls, DEPOT_RED)[cell(10, 6)] as number;
    expect(around).toBeGreaterThanOrEqual(8);
    expect(worthOf(tall.walls, DEPOT_RED, cell(10, 6))).toBe(1 + Math.floor(around / 8));
  });

  it('撿起來那一刻把價值記進 carry，之後怎麼走都不變', () => {
    // 包裹 (15,6) 離紅倉庫 7 步：1 分。人撿了之後往離倉庫更遠的方向走，worth 仍是 1。
    let s = atMove({
      players: [{ cell: cell(14, 6) }, { cell: FAR_AI }],
      parcels: parcelsWith([{ cell: cell(15, 6), colour: RED }]),
    });
    s = d5Game.step(s, [PRESS_RIGHT, NONE]);
    expect(s.carry[0]).toEqual({ colour: RED, worth: 1 });
    s = run(d5Game, s, 20, [PRESS_RIGHT, NONE]);
    expect(s.carry[0]).toEqual({ colour: RED, worth: 1 });
    // 包裹 (16,6) 離紅倉庫 8 步：2 分。
    const far = d5Game.step(
      atMove({
        players: [{ cell: cell(15, 6) }, { cell: FAR_AI }],
        parcels: parcelsWith([{ cell: cell(16, 6), colour: RED }]),
      }),
      [PRESS_RIGHT, NONE],
    );
    expect(far.carry[0]).toEqual({ colour: RED, worth: 2 });
  });
});

// ---------------------------------------------------------------------------
// 撿貨
// ---------------------------------------------------------------------------

describe('D-5 送貨｜撿貨', () => {
  it('1. 空手走到包裹：撿起來（顏色與價值），包裹從場上拿掉，另補一件，分數不變', () => {
    const state = atMove({
      players: [{ cell: cell(11, 4) }, { cell: FAR_AI }],
      parcels: parcelsWith([{ cell: cell(12, 4), colour: BLUE }]),
    });
    const next = d5Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(cell(12, 4));
    expect(next.carry[0]).toEqual({
      colour: BLUE,
      worth: worthOf(state.walls, DEPOT_BLUE, cell(12, 4)),
    });
    expect(next.parcels).toHaveLength(PARCEL_COUNT);
    expect(next.parcels.some((p) => p.cell === cell(12, 4) && state.parcels.includes(p))).toBe(
      false,
    );
    expect(next.players[0].score).toBe(0);
    expect(next.carry[1]).toBeNull();
  });

  it('2. 一次只能背一件：背著貨走過別的包裹什麼都不會發生（包裹還在，carry 不變）', () => {
    const state = atMove({
      players: [{ cell: cell(11, 4) }, { cell: FAR_AI }],
      carry: [{ colour: GREEN, worth: 4 }, null],
      parcels: parcelsWith([{ cell: cell(12, 4), colour: BLUE }]),
    });
    const next = d5Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(cell(12, 4));
    expect(next.carry[0]).toEqual({ colour: GREEN, worth: 4 });
    expect(next.parcels).toEqual(state.parcels);
  });

  it('3. 兩個空手的人同一次走格走到同一件：各撿一件，只補一件新的', () => {
    const state = atMove({
      players: [{ cell: cell(11, 4) }, { cell: cell(13, 4) }],
      parcels: parcelsWith([{ cell: cell(12, 4), colour: GREEN }]),
    });
    const next = d5Game.step(state, [PRESS_RIGHT, PRESS_LEFT]);
    const worth = worthOf(state.walls, DEPOT_GREEN, cell(12, 4));
    expect(next.carry[0]).toEqual({ colour: GREEN, worth });
    expect(next.carry[1]).toEqual({ colour: GREEN, worth });
    expect(next.parcels).toHaveLength(PARCEL_COUNT);
    expect(next.parcels.filter((p) => p.cell === cell(12, 4))).toHaveLength(0);
  });

  it('3. 一個空手、一個背著貨同時走到同一件：只有空手的撿', () => {
    const state = atMove({
      players: [{ cell: cell(11, 4) }, { cell: cell(13, 4) }],
      carry: [null, { colour: RED, worth: 2 }],
      parcels: parcelsWith([{ cell: cell(12, 4), colour: GREEN }]),
    });
    const next = d5Game.step(state, [PRESS_RIGHT, PRESS_LEFT]);
    expect(next.carry[0]?.colour).toBe(GREEN);
    expect(next.carry[1]).toEqual({ colour: RED, worth: 2 });
    expect(next.parcels).toHaveLength(PARCEL_COUNT);
  });

  it('4. 補包裹的顏色挑場上最少的：撿走唯一的藍色之後，新的一件是藍色', () => {
    // 紅 2、綠 2、藍 1；人撿走藍色 → 紅 2、綠 2、藍 0 → 新的一件一定是藍色。
    const base: Parcel[] = [
      { cell: cell(6, 5), colour: BLUE },
      { cell: cell(14, 21), colour: RED },
      { cell: cell(16, 21), colour: RED },
      { cell: cell(18, 21), colour: GREEN },
      { cell: cell(20, 21), colour: GREEN },
    ];
    for (let seed = 0; seed < 12; seed += 1) {
      const state = atMove({ parcels: base, rng: rngStateFor(seed, 'refill-colour') });
      const next = d5Game.step(state, [PRESS_RIGHT, NONE]);
      expect(colourCounts(next.parcels), `種子 ${seed}`).toEqual([2, 2, 1]);
      expect(next.carry[0]?.colour).toBe(BLUE);
    }
  });

  it('4. 最少的有平手時用 rng 挑：兩種都會出現、最多的那種不會被補；rng 狀態有往前走', () => {
    // 紅 2、綠 2、藍 1；人撿走紅色 → 紅 1、綠 2、藍 1 → 補紅或藍，不會補綠。
    const base: Parcel[] = [
      { cell: cell(6, 5), colour: RED },
      { cell: cell(14, 21), colour: RED },
      { cell: cell(16, 21), colour: GREEN },
      { cell: cell(18, 21), colour: GREEN },
      { cell: cell(20, 21), colour: BLUE },
    ];
    const seen = new Set<number>();
    for (let seed = 0; seed < 40; seed += 1) {
      const rng = rngStateFor(seed, 'refill-tie');
      const next = d5Game.step(atMove({ parcels: base, rng }), [PRESS_RIGHT, NONE]);
      const fresh = next.parcels.filter((p) => !base.some((b) => b.cell === p.cell));
      expect(fresh).toHaveLength(1);
      seen.add((fresh[0] as Parcel).colour);
      expect(next.rng, `種子 ${seed}`).not.toBe(rng);
    }
    expect(seen.has(GREEN)).toBe(false);
    expect(seen.has(RED)).toBe(true);
    expect(seen.has(BLUE)).toBe(true);
  });

  it('5. 補的包裹不在牆、倉庫、別的包裹或兩個角色的格子上（種子 0 到 30 各撿一次）', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const state = atMove({
        players: [{ cell: cell(11, 4) }, { cell: cell(13, 4) }],
        parcels: parcelsWith([{ cell: cell(12, 4), colour: RED }]),
        walls: [cell(30, 12), cell(30, 13)],
        rng: rngStateFor(seed, 'refill-place'),
      });
      const next = d5Game.step(state, [PRESS_RIGHT, PRESS_LEFT]);
      const cells = next.parcels.map((p) => p.cell);
      expect(new Set(cells).size).toBe(PARCEL_COUNT);
      for (const c of cells) {
        expect(next.walls[c]).toBe(0);
        expect(next.depots).not.toContain(c);
        expect(c).not.toBe(next.players[0].cell);
        expect(c).not.toBe(next.players[1].cell);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 送貨與倉庫休息
// ---------------------------------------------------------------------------

describe('D-5 送貨｜送貨', () => {
  /** 人在紅倉庫旁邊 (7,6)，背著紅貨 3 分；下一次 step 是結算。 */
  const nextToRed = (overrides: Parameters<typeof makeState>[0] = {}): D5State =>
    atMove({
      players: [{ cell: cell(7, 6) }, { cell: FAR_AI }],
      carry: [{ colour: RED, worth: 3 }, null],
      ...overrides,
    });

  it('6. 背著貨走到同色倉庫（沒在休息）：得到那件貨的價值，carry 清空，倉庫休息 COOL，送達 +1', () => {
    const next = d5Game.step(nextToRed(), [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(DEPOT_RED);
    expect(next.players[0].score).toBe(3);
    expect(next.carry[0]).toBeNull();
    expect(next.cool).toEqual([COOL, 0, 0]);
    expect(next.delivered).toEqual([1, 0]);
  });

  it('6. 價值是撿起來時記下的 worth，不是現在的位置算出來的', () => {
    const next = d5Game.step(nextToRed({ carry: [{ colour: RED, worth: 6 }, null] }), [
      PRESS_RIGHT,
      NONE,
    ]);
    expect(next.players[0].score).toBe(6);
  });

  it('7. 走到別種顏色的倉庫：什麼都不發生（貨留在身上、倉庫不休息）', () => {
    const state = atMove({
      players: [{ cell: cell(7, 6) }, { cell: FAR_AI }],
      carry: [{ colour: GREEN, worth: 3 }, null],
    });
    const next = d5Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(DEPOT_RED);
    expect(next.players[0].score).toBe(0);
    expect(next.carry[0]).toEqual({ colour: GREEN, worth: 3 });
    expect(next.cool).toEqual([0, 0, 0]);
  });

  it('7. 空手站在倉庫上什麼都不發生', () => {
    const state = atMove({ players: [{ cell: DEPOT_RED }, { cell: FAR_AI }] });
    const next = d5Game.step(state, IDLE);
    expect(next.players[0].score).toBe(0);
    expect(next.cool).toEqual([0, 0, 0]);
  });

  it('8. 倉庫在休息：送不進去，貨留在身上；休息倒數每個 tick 減 1', () => {
    const next = d5Game.step(nextToRed({ cool: [100, 0, 0] }), [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(DEPOT_RED);
    expect(next.players[0].score).toBe(0);
    expect(next.carry[0]).toEqual({ colour: RED, worth: 3 });
    expect(next.cool).toEqual([99, 0, 0]);
  });

  it('8. 邊界：休息剩 1 tick 的那個結算可以送進去（先減 1 變 0）；剩 2 tick 還不行', () => {
    const open = d5Game.step(nextToRed({ cool: [1, 0, 0] }), [PRESS_RIGHT, NONE]);
    expect(open.players[0].score).toBe(3);
    expect(open.cool).toEqual([COOL, 0, 0]);
    const closed = d5Game.step(nextToRed({ cool: [2, 0, 0] }), [PRESS_RIGHT, NONE]);
    expect(closed.players[0].score).toBe(0);
    expect(closed.carry[0]).not.toBeNull();
    expect(closed.cool).toEqual([1, 0, 0]);
    const zero = d5Game.step(nextToRed({ cool: [0, 0, 0] }), [PRESS_RIGHT, NONE]);
    expect(zero.players[0].score).toBe(3);
  });

  it('8. 休息倒數每個 tick 都減（不只走格的那一次），到 0 為止不會變負', () => {
    let s = makeState({ cool: [7, 0, 2], players: [{ cell: cell(5, 5) }, { cell: FAR_AI }] });
    s = d5Game.step(s, IDLE);
    expect(s.cool).toEqual([6, 0, 1]);
    s = run(d5Game, s, 3);
    expect(s.cool).toEqual([3, 0, 0]);
    s = run(d5Game, s, 10);
    expect(s.cool).toEqual([0, 0, 0]);
  });

  it('9. 站著不動也會送：等在休息中倉庫上的人，在休息結束後的第一次結算送進去', () => {
    // tick 4（下一個 tick 是結算）；cool 8 → 結算時 7，不送。下個結算（tick 10）cool 2，不送；tick 15 cool 0 送。
    let s = atMove({
      players: [{ cell: DEPOT_RED }, { cell: FAR_AI }],
      carry: [{ colour: RED, worth: 2 }, null],
      cool: [8, 0, 0],
    });
    s = d5Game.step(s, IDLE); // tick 5
    expect(s.players[0].score).toBe(0);
    s = run(d5Game, s, 5); // tick 10
    expect(s.players[0].score).toBe(0);
    expect(s.cool[0]).toBe(2);
    s = run(d5Game, s, 4); // tick 14：cool 已經是 0，但不是結算的 tick
    expect(s.cool[0]).toBe(0);
    expect(s.players[0].score).toBe(0);
    s = d5Game.step(s, IDLE); // tick 15：結算
    expect(s.players[0].score).toBe(2);
    expect(s.carry[0]).toBeNull();
    expect(s.cool[0]).toBe(COOL);
  });

  it('10. 兩個人同一次結算站到同一個沒在休息的同色倉庫：各自都送（各得價值），倉庫只休息一次', () => {
    const state = atMove({
      players: [{ cell: cell(7, 6) }, { cell: cell(9, 6) }],
      carry: [
        { colour: RED, worth: 3 },
        { colour: RED, worth: 5 },
      ],
    });
    const next = d5Game.step(state, [PRESS_RIGHT, PRESS_LEFT]);
    expect(d5Game.score(next)).toEqual([3, 5]);
    expect(next.carry).toEqual([null, null]);
    expect(next.cool).toEqual([COOL, 0, 0]);
    expect(next.delivered).toEqual([1, 1]);
  });

  it('10. 先到的人送完讓倉庫休息，後到的人（下一次結算）就送不進去、要等 COOL', () => {
    let state = atMove({
      players: [{ cell: cell(7, 6) }, { cell: cell(12, 6) }],
      carry: [
        { colour: RED, worth: 3 },
        { colour: RED, worth: 5 },
      ],
    });
    state = d5Game.step(state, [PRESS_RIGHT, PRESS_LEFT]); // 人送進去；AI 在 (11,6)
    expect(state.players[0].score).toBe(3);
    state = run(d5Game, state, 15, [NONE, PRESS_LEFT]); // 又走 3 格：(8,6)
    expect(state.players[1].cell).toBe(DEPOT_RED);
    expect(state.players[1].score).toBe(0);
    expect(state.carry[1]).toEqual({ colour: RED, worth: 5 });
    expect(state.cool[0]).toBe(COOL - 15);
    // 繼續站著等：剛好在休息結束後的第一次結算送進去（總共休息 COOL tick）。
    state = run(d5Game, state, COOL - 15);
    expect(state.players[1].score).toBe(5);
    expect(state.cool[0]).toBe(COOL);
  });

  it('11. 三個倉庫各自獨立：送進紅倉庫不影響綠、藍的休息', () => {
    const state = nextToRed({ cool: [0, 40, 90] });
    const next = d5Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.cool).toEqual([COOL, 39, 89]);
  });

  it('12. waited：背著貨站在「休息中的同色倉庫」上每個 tick +1；倉庫沒在休息、別種顏色、不在上面都不算', () => {
    const waiting = makeState({
      players: [{ cell: DEPOT_RED }, { cell: FAR_AI }],
      carry: [{ colour: RED, worth: 2 }, null],
      cool: [40, 0, 0],
    });
    expect(run(d5Game, waiting, 10).waited).toEqual([10, 0]);
    // 休息到 0 之後不再算。
    expect(run(d5Game, { ...waiting, cool: [3, 0, 0] }, 10).waited[0]).toBe(2);
    const otherColour = {
      ...waiting,
      carry: [{ colour: GREEN, worth: 2 }, null] as D5State['carry'],
    };
    expect(run(d5Game, otherColour, 10).waited).toEqual([0, 0]);
    const offDepot = {
      ...waiting,
      players: [
        { ...waiting.players[0], cell: cell(5, 5) },
        waiting.players[1],
      ] as D5State['players'],
    };
    expect(run(d5Game, offDepot, 10).waited).toEqual([0, 0]);
    const empty = { ...waiting, carry: [null, null] as D5State['carry'] };
    expect(run(d5Game, empty, 10).waited).toEqual([0, 0]);
  });

  it('13. 沒有「丟貨」或「換貨」的動作：按 a、b 什麼都不改變', () => {
    const state = atMove({
      players: [{ cell: cell(5, 5) }, { cell: FAR_AI }],
      carry: [{ colour: GREEN, worth: 2 }, null],
    });
    const press: Buttons = { ...NONE, a: true, b: true };
    const next = run(d5Game, state, 12, [press, press]);
    expect(next.carry[0]).toEqual({ colour: GREEN, worth: 2 });
    expect(next.players[0].cell).toBe(cell(5, 5));
  });
});

// ---------------------------------------------------------------------------
// 結束與純度
// ---------------------------------------------------------------------------

describe('D-5 送貨｜結束與契約', () => {
  it('時間到：分數高的贏、同分平手；背在身上沒送的不算；結束之後再 step，state 原樣不變', () => {
    const base = makeState({
      tick: 3599,
      players: [{ score: 3 }, { score: 2 }],
      carry: [null, { colour: RED, worth: 7 }],
    });
    const end = d5Game.step(base, IDLE);
    expect(d5Game.isOver(end)).toBe(true);
    expect(d5Game.winner(end)).toBe(0);
    expect(d5Game.score(end)).toEqual([3, 2]);
    expect(d5Game.step(end, [PRESS_RIGHT, PRESS_LEFT])).toBe(end);
    const tie = d5Game.step(makeState({ tick: 3599, players: [{ score: 2 }, { score: 2 }] }), IDLE);
    expect(d5Game.winner(tie)).toBeNull();
    const second = d5Game.step(
      makeState({ tick: 3599, players: [{ score: 1 }, { score: 2 }] }),
      IDLE,
    );
    expect(d5Game.winner(second)).toBe(1);
  });

  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，包含撿、送、休息、補包裹的那一次）', () => {
    const cases: D5State[] = [
      atMove({
        players: [{ cell: cell(11, 4) }, { cell: cell(13, 4) }],
        parcels: parcelsWith([{ cell: cell(12, 4), colour: RED }]),
      }),
      atMove({
        players: [{ cell: cell(7, 6) }, { cell: cell(9, 6) }],
        carry: [
          { colour: RED, worth: 3 },
          { colour: RED, worth: 5 },
        ],
      }),
      atMove({
        players: [{ cell: DEPOT_RED }, { cell: DEPOT_GREEN }],
        carry: [
          { colour: RED, worth: 3 },
          { colour: GREEN, worth: 1 },
        ],
        cool: [10, 3, 0],
      }),
      makeState({ tick: 3599 }),
    ];
    for (const state of cases) {
      const before = JSON.stringify(state);
      const frozen = deepFreeze(JSON.parse(before) as D5State);
      expect(() => d5Game.step(frozen, [PRESS_RIGHT, PRESS_LEFT])).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(before);
    }
  });

  it('沒有牆、倉庫變動時，walls 與 depots 是同一個陣列物件（距離場才能快取）', () => {
    const state = d5Game.init(3, CONFIG);
    const next = run(d5Game, state, 40, [PRESS_UP, PRESS_DOWN]);
    expect(next.walls).toBe(state.walls);
    expect(next.depots).toBe(state.depots);
  });

  it('K1：同一個種子、同一串輸入跑兩次結果相同', () => {
    const play = (): D5State => {
      const a = levelController(d5Game, greedy, 6, 1);
      const b = levelController(d5Game, greedy, 6, 2);
      let state = d5Game.init(5, CONFIG);
      for (let tick = 0; tick < 900; tick += 1) {
        state = d5Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
      return state;
    };
    expect(play()).toEqual(play());
  });

  it('兩個貪心型等級 10 打一整局：真的有送貨、倉庫真的休息過（規則走得到）', () => {
    const a = levelController(d5Game, greedy, 10, 1);
    const b = levelController(d5Game, greedy, 10, 2);
    let state = d5Game.init(2, CONFIG);
    let restingTicks = 0;
    for (let tick = 0; !d5Game.isOver(state); tick += 1) {
      state = d5Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      restingTicks += state.cool.filter((c) => c > 0).length;
    }
    expect(state.delivered[0] + state.delivered[1]).toBeGreaterThan(20);
    expect(restingTicks).toBeGreaterThan(1000);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ACTIONS: readonly Buttons[] = [PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT, NONE];
const UP_I = 0;
const RIGHT_I = 1;
const DOWN_I = 2;
const LEFT_I = 3;
const NONE_I = 4;

function evalAfter(state: D5State, side: Side, action: Buttons): { gain: number; danger: number } {
  const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
  return d5Game.evaluate(d5Game.step(state, inputs), side);
}
function gainsOf(state: D5State, side: Side = 0): number[] {
  return ACTIONS.map((action) => evalAfter(state, side, action).gain);
}
function dangersOf(state: D5State, side: Side = 0): number[] {
  return ACTIONS.map((action) => evalAfter(state, side, action).danger);
}
function bestIndex(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] as number) > (values[best] as number)) {
      best = i;
    }
  }
  return best;
}
function dirName(buttons: Buttons): 'up' | 'right' | 'down' | 'left' | 'none' {
  if (buttons.up) {
    return 'up';
  }
  if (buttons.right) {
    return 'right';
  }
  if (buttons.down) {
    return 'down';
  }
  if (buttons.left) {
    return 'left';
  }
  return 'none';
}

/** 評估用的局面：tick 1（還沒到走格），人在 (12,6)，AI 在對角很遠的地方，包裹都在遠處。 */
function calm(overrides: Parameters<typeof makeState>[0] = {}): D5State {
  return makeState({
    tick: 1,
    players: [{ cell: cell(12, 6) }, { cell: cell(31, 0) }],
    parcels: parcelsWith([]),
    ...overrides,
  });
}

/** 一個左右對稱的局面：紅倉庫 (15,4)、藍倉庫 (15,20)、綠倉庫 (3,12)；紅包裹在人上方 4 格、藍包裹在下方 4 格。 */
function fork(overrides: Parameters<typeof makeState>[0] = {}): D5State {
  return makeState({
    tick: 1,
    players: [{ cell: cell(15, 12) }, { cell: cell(31, 0) }],
    depots: [cell(15, 4), cell(3, 12), cell(15, 20)],
    parcels: [
      { cell: cell(15, 8), colour: RED },
      { cell: cell(15, 16), colour: BLUE },
      { cell: cell(28, 22), colour: GREEN },
      { cell: cell(28, 20), colour: GREEN },
      { cell: cell(30, 22), colour: GREEN },
    ],
    ...overrides,
  });
}

describe('D-5 送貨｜actions', () => {
  it('五個不同的動作，全放開排最後', () => {
    for (const state of [
      calm(),
      calm({ carry: [{ colour: RED, worth: 2 }, null] }),
      d5Game.init(7, CONFIG),
    ]) {
      for (const side of [0, 1] as const) {
        const actions = d5Game.actions(state, side);
        expect(actions).toHaveLength(5);
        expect(new Set(actions.map(dirName)).size).toBe(5);
        expect(dirName(actions[4] as Buttons)).toBe('none');
      }
    }
  });

  it('背著貨：排最前面的動作往同色倉庫走', () => {
    const red = calm({ carry: [{ colour: RED, worth: 2 }, null] }); // 紅倉庫在 (8,6)，人在 (12,6)
    expect(dirName(d5Game.actions(red, 0)[0] as Buttons)).toBe('left');
    const green = calm({ carry: [{ colour: GREEN, worth: 2 }, null] }); // 綠倉庫在 (23,17)
    expect(['right', 'down']).toContain(dirName(d5Game.actions(green, 0)[0] as Buttons));
  });

  it('空手：排最前面的動作往最吸引的包裹走', () => {
    const state = calm({
      parcels: parcelsWith([{ cell: cell(12, 2), colour: RED }]),
    });
    expect(dirName(d5Game.actions(state, 0)[0] as Buttons)).toBe('up');
  });

  it('1 號邊的預設順序是 0 號邊轉 180 度（沒有目標時）', () => {
    const none = calm({ parcels: [] });
    const a = d5Game.actions(none, 0).map(dirName);
    const b = d5Game.actions(none, 1).map(dirName);
    expect(a.slice(0, 4)).toEqual(['up', 'right', 'down', 'left']);
    expect(b.slice(0, 4)).toEqual(['down', 'left', 'up', 'right']);
  });
});

describe('D-5 送貨｜evaluate', () => {
  it('撿到包裹（下一步踩上去）比別的方向高很多', () => {
    const state = calm({
      players: [{ cell: cell(5, 5) }, { cell: cell(31, 0) }],
      parcels: parcelsWith([{ cell: cell(6, 5), colour: RED }]),
    });
    const gains = gainsOf(state);
    expect(bestIndex(gains)).toBe(RIGHT_I);
    expect((gains[RIGHT_I] as number) - (gains[NONE_I] as number)).toBeGreaterThan(25);
  });

  it('背著貨：往同色倉庫走最好；下一步踩進沒在休息的同色倉庫，比別的動作高上一整分以上', () => {
    const far = calm({ carry: [{ colour: RED, worth: 2 }, null] });
    expect(bestIndex(gainsOf(far))).toBe(LEFT_I);
    const near = calm({
      players: [{ cell: cell(9, 6) }, { cell: cell(31, 0) }],
      carry: [{ colour: RED, worth: 3 }, null],
    });
    const gains = gainsOf(near);
    expect(bestIndex(gains)).toBe(LEFT_I);
    expect((gains[LEFT_I] as number) - (gains[NONE_I] as number)).toBeGreaterThan(100);
  });

  it('走到別種顏色的倉庫不算送達（沒有那一分）', () => {
    const state = calm({
      players: [{ cell: cell(9, 6) }, { cell: cell(31, 0) }],
      carry: [{ colour: GREEN, worth: 3 }, null],
    });
    const gains = gainsOf(state);
    expect((gains[LEFT_I] as number) - (gains[NONE_I] as number)).toBeLessThan(20);
    expect([RIGHT_I, DOWN_I]).toContain(bestIndex(gains));
  });

  it('同色倉庫正在休息：踩進去也不算送達（只看這一刻，不算要等多久以外的東西）', () => {
    const state = calm({
      players: [{ cell: cell(9, 6) }, { cell: cell(31, 0) }],
      carry: [{ colour: RED, worth: 3 }, null],
      cool: [100, 0, 0],
    });
    const gains = gainsOf(state);
    expect((gains[LEFT_I] as number) - (gains[NONE_I] as number)).toBeLessThan(30);
  });

  it('看顏色：兩件一樣近、一樣值錢的包裹，哪個顏色的倉庫在休息就不撿那個', () => {
    // fork：紅包裹 (15,8) 在上、藍包裹 (15,16) 在下，各離自己的倉庫 4 步，人離兩件都是 4 步。
    expect(gainsOf(fork()).map((_g, i) => i)).toHaveLength(5);
    expect(bestIndex(gainsOf(fork({ cool: [COOL, 0, 0] })))).toBe(DOWN_I);
    expect(bestIndex(gainsOf(fork({ cool: [0, 0, COOL] })))).toBe(UP_I);
  });

  it('來不及送就不算目標：剩下的時間走不到倉庫，背著的貨不再加分', () => {
    const early = calm({ carry: [{ colour: RED, worth: 3 }, null] });
    const late = calm({ tick: 3580, carry: [{ colour: RED, worth: 3 }, null] });
    expect(d5Game.evaluate(late, 0).gain).toBeLessThan(d5Game.evaluate(early, 0).gain - 50);
  });

  it('不看分差：兩邊分數對調，每個動作相對「全放開」的 gain 差一模一樣（不是橡皮筋）', () => {
    const build = (scores: [number, number]): D5State =>
      calm({
        players: [
          { cell: cell(12, 6), score: scores[0] },
          { cell: cell(10, 7), score: scores[1] },
        ],
        parcels: parcelsWith([{ cell: cell(12, 2), colour: GREEN }]),
        carry: [null, { colour: RED, worth: 2 }],
      });
    for (const side of [0, 1] as const) {
      const a = gainsOf(build([4, 0]), side);
      const b = gainsOf(build([0, 4]), side);
      const c = gainsOf(build([9, 9]), side);
      for (let i = 0; i < 5; i += 1) {
        expect((a[i] as number) - (a[NONE_I] as number)).toBeCloseTo(
          (b[i] as number) - (b[NONE_I] as number),
          9,
        );
        expect((a[i] as number) - (a[NONE_I] as number)).toBeCloseTo(
          (c[i] as number) - (c[NONE_I] as number),
          9,
        );
      }
    }
  });

  it('gain：我的分數越高越好、對方越高越差；已結束的局，贏的一邊高很多、danger 是 0', () => {
    const lead = calm({ players: [{ score: 3 }, { score: 1 }] });
    expect(d5Game.evaluate(lead, 0).gain).toBeGreaterThan(d5Game.evaluate(lead, 1).gain);
    const over = makeState({ over: true, players: [{ score: 3 }, { score: 1 }] });
    expect(d5Game.evaluate(over, 0).gain).toBeGreaterThan(900_000);
    expect(d5Game.evaluate(over, 1).gain).toBeLessThan(-900_000);
    expect(d5Game.evaluate(over, 0).danger).toBe(0);
  });

  it('gain 與 danger 對兩邊對稱：把整個局面轉 180 度、兩邊對調，同一組數字', () => {
    const mirror = (c: number): number => CELLS - 1 - c;
    const rotatePending = (p: -1 | 0 | 1 | 2 | 3): -1 | 0 | 1 | 2 | 3 =>
      p < 0 ? -1 : (((p + 2) % 4) as 0 | 1 | 2 | 3);
    const rotate = (s: D5State): D5State => ({
      ...s,
      players: [
        {
          ...s.players[1],
          cell: mirror(s.players[1].cell),
          pending: rotatePending(s.players[1].pending),
        },
        {
          ...s.players[0],
          cell: mirror(s.players[0].cell),
          pending: rotatePending(s.players[0].pending),
        },
      ],
      parcels: s.parcels.map((p) => ({ ...p, cell: mirror(p.cell) })),
      depots: s.depots.map(mirror),
      carry: [s.carry[1], s.carry[0]],
      delivered: [s.delivered[1], s.delivered[0]],
      waited: [s.waited[1], s.waited[0]],
    });
    const cases: D5State[] = [
      calm({ carry: [{ colour: RED, worth: 2 }, null] }),
      fork({ cool: [COOL, 0, 40] }),
      fork({
        players: [
          { cell: cell(15, 12), pending: 1 },
          { cell: cell(15, 6), pending: 2 },
        ],
        carry: [null, { colour: RED, worth: 2 }],
      }),
      calm({
        players: [
          { cell: cell(9, 6), score: 2 },
          { cell: cell(20, 17), score: 1 },
        ],
        carry: [
          { colour: RED, worth: 3 },
          { colour: GREEN, worth: 1 },
        ],
        cool: [60, 0, 0],
      }),
    ];
    for (const state of cases) {
      const flipped = rotate(state);
      for (const side of [0, 1] as const) {
        const a = d5Game.evaluate(state, side);
        const b = d5Game.evaluate(flipped, side === 0 ? 1 : 0);
        expect(a.gain).toBeCloseTo(b.gain, 9);
        expect(a.danger).toBeCloseTo(b.danger, 9);
      }
    }
  });

  it('danger：沒有人搶、倉庫沒在休息，是 0；永遠在 0 到 1', () => {
    expect(dangersOf(fork())).toEqual([0, 0, 0, 0, 0]);
    for (const state of [
      fork({ cool: [COOL, COOL, COOL] }),
      calm({ carry: [{ colour: RED, worth: 2 }, null], cool: [COOL, 0, 0] }),
      d5Game.init(4, CONFIG),
    ]) {
      for (const d of dangersOf(state)) {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
      }
    }
  });

  it('danger：撿起來的倉庫剛休息（要白等很久）高，休息快結束或另一個顏色是 0', () => {
    // 人往上走，下一步要撿紅貨：紅倉庫剛休息 → 高；剛好快好 → 低。
    const pick = (cool: number): D5State =>
      fork({
        players: [{ cell: cell(15, 9) }, { cell: cell(31, 0) }],
        cool: [cool, 0, 0],
      });
    const high = dangersOf(pick(COOL))[UP_I] as number;
    const low = dangersOf(pick(10))[UP_I] as number;
    expect(high).toBeGreaterThan(0.3);
    expect(low).toBeLessThan(high);
    expect(dangersOf(pick(COOL))[DOWN_I] as number).toBeLessThan(high);
  });

  it('danger：對手背著同色貨而且比我先到倉庫，我撿同色貨會白等；我比它先到就沒事', () => {
    // 人在 (15,9)，往上一步撿紅貨 (15,8)，紅倉庫 (15,4)：我還要走 4 步 + 撿 = 約 5 步到倉庫。
    // AI 背著紅貨站在 (15,6)，離紅倉庫 2 步：比我先到，倉庫會休息。
    const aiFirst = fork({
      players: [{ cell: cell(15, 9) }, { cell: cell(15, 6) }],
      carry: [null, { colour: RED, worth: 2 }],
    });
    const aiLate = fork({
      players: [{ cell: cell(15, 9) }, { cell: cell(31, 0) }],
      carry: [null, { colour: RED, worth: 2 }],
    });
    expect(dangersOf(aiFirst)[UP_I] as number).toBeGreaterThan(0.3);
    expect(dangersOf(aiLate)[UP_I] as number).toBe(0);
    // 同樣的局面，如果倉庫不會休息（ablation 用的 COOL = 0 版本在量測檔案裡），就沒有這個差別。
  });

  it('背在身上之後 danger 是 0（已經下注了，沒有別的動作可選）', () => {
    const state = fork({
      players: [{ cell: cell(15, 6) }, { cell: cell(15, 9) }],
      carry: [
        { colour: RED, worth: 2 },
        { colour: RED, worth: 2 },
      ],
      cool: [COOL, 0, 0],
    });
    expect(dangersOf(state, 0)).toEqual([0, 0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// decide 層盲測：完整資訊的牌，AI 不可以偷看 rng 與指紋計數（10.9：decide、evaluate、actions 都要測）
// ---------------------------------------------------------------------------

describe('D-5 送貨｜盲測（decide、evaluate、actions）', () => {
  const NAMES = ['precise', 'greedy', 'gambler', 'pathfinder'] as const;
  const POLICIES: Record<(typeof NAMES)[number], Policy> = { precise, greedy, gambler, pathfinder };
  const DEPTHS = [1, 3, 6] as const;

  function snapshots(): D5State[] {
    const out: D5State[] = [];
    for (const seed of [1, 2]) {
      const a = levelController(d5Game, precise, 10, seed);
      const b = levelController(d5Game, gambler, 10, seed + 5);
      let state = d5Game.init(seed, CONFIG);
      for (let tick = 0; tick < 2400 && !d5Game.isOver(state); tick += 1) {
        if (tick % 97 === 3) {
          out.push(state);
        }
        state = d5Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    return out;
  }

  /** 只改 rng 與 waited、delivered（指紋用的累計）：這幾個欄位對規則沒有影響，AI 不該受影響。 */
  const scramble = (s: D5State, n: number): D5State => ({
    ...s,
    rng: (s.rng + 977 * (n + 1)) >>> 0,
    waited: [s.waited[0] + 3 * n, s.waited[1] + 7 * n],
    delivered: [s.delivered[0] + n, s.delivered[1] + 2 * n],
  });

  function decideLeaks(game: Game<D5State>, states: readonly D5State[]): string[] {
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

  /** 相等性：evaluate 與 actions 在隱藏欄位不同時必須「完全相等」（對所有動作加同一個常數的洩漏不會改變排序）。 */
  function equalityLeaks(game: Game<D5State>, states: readonly D5State[]): string[] {
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
          for (const action of ACTIONS) {
            const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
            const afterS = game.step(s, inputs);
            const afterT = game.step(t, inputs);
            // 撿了包裹的那一步，補的位置與顏色本來就由 rng 決定（規則的一部分，不是洩漏）：包裹不同的就不比。
            if (JSON.stringify(afterS.parcels) !== JSON.stringify(afterT.parcels)) {
              continue;
            }
            const p = game.evaluate(afterS, side);
            const q = game.evaluate(afterT, side);
            if (p.gain !== q.gain || p.danger !== q.danger) {
              leaks.push(`evaluate-after-step/tick ${s.tick}/side ${side}`);
            }
          }
        }
      }
    }
    return leaks;
  }

  /** 四種故意的洩漏。 */
  function leaky(kind: 'rng-const' | 'rng-position' | 'waited' | 'actions-order'): Game<D5State> {
    return {
      ...d5Game,
      actions(s: D5State, side: Side) {
        const base = d5Game.actions(s, side);
        if (kind !== 'actions-order') {
          return base;
        }
        const k = s.rng % 4;
        return [
          ...base.slice(0, 4).map((_a, i) => base[(i + k) % 4] as Buttons),
          base[4] as Buttons,
        ];
      },
      evaluate(s: D5State, side: Side) {
        const base = d5Game.evaluate(s, side);
        if (kind === 'actions-order') {
          return base;
        }
        if (kind === 'rng-const') {
          return { gain: base.gain + ((s.rng % 7) - 3) * 30, danger: base.danger };
        }
        const me = s.players[side];
        const bias = kind === 'rng-position' ? ((s.rng % 7) - 3) * 30 : s.waited[side] * 30;
        return { gain: base.gain + bias * ((cellX(me.cell) - 15) / 15), danger: base.danger };
      },
    };
  }

  const states = snapshots();

  it('取樣到的局面涵蓋開局、背著貨、倉庫休息中等各種時候', () => {
    expect(states.length).toBeGreaterThan(40);
    expect(states.some((s) => s.carry[0] !== null || s.carry[1] !== null)).toBe(true);
    expect(states.some((s) => s.cool.some((c) => c > 0))).toBe(true);
    expect(states.some((s) => s.carry[0] === null && s.carry[1] === null)).toBe(true);
  });

  it('真的遊戲：只改 rng、waited、delivered，四個性格 × depth 1／3／6 × 兩邊的 decide 完全不變', () => {
    expect(decideLeaks(d5Game, states)).toEqual([]);
  }, 120_000);

  it('真的遊戲：evaluate（含 step 之後）與 actions 在 rng、waited、delivered 不同時完全相等', () => {
    expect(equalityLeaks(d5Game, states)).toEqual([]);
  }, 60_000);

  it('注入「偷看 rng、位置相關」的 evaluate：decide 層與相等性都抓得到（必須是紅的）', () => {
    expect(decideLeaks(leaky('rng-position'), states).length).toBeGreaterThan(0);
    expect(equalityLeaks(leaky('rng-position'), states).length).toBeGreaterThan(0);
  }, 120_000);

  it('注入「對所有動作加同一個常數」的 evaluate：相等性抓得到（這一型 decide 層抓不到，所以一定要有相等性）', () => {
    expect(equalityLeaks(leaky('rng-const'), states).length).toBeGreaterThan(0);
  }, 60_000);

  it('注入「偷看 waited」的 evaluate：decide 層與相等性都抓得到', () => {
    expect(decideLeaks(leaky('waited'), states).length).toBeGreaterThan(0);
    expect(equalityLeaks(leaky('waited'), states).length).toBeGreaterThan(0);
  }, 120_000);

  it('注入「actions 的順序依 rng 轉動」：相等性抓得到', () => {
    expect(equalityLeaks(leaky('actions-order'), states).length).toBeGreaterThan(0);
  }, 60_000);
});
