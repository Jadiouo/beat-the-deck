import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  GAIN_PER_POINT,
  MOVE_EVERY,
  START_CELLS,
  WIN_BONUS,
  actionsToward,
  bfsDistances,
  cell,
  clamp01,
  generateWalls,
  makeBase,
  moveWalker,
  nextCell,
  steerWalker,
  winnerByScore,
} from '../_diamonds/logic';
import type { BaseOverrides, DiamondsBase, Walker } from '../_diamonds/logic';

/**
 * D-10 輸送帶（SPEC 第 9 節一行方向；小規格 `docs/cards/D-10.md`）。
 * 地圖中央一圈輸送帶，貨（有重量、有價值）沿著帶子慢慢流；兩個人在格子上自由走動去攔，
 * 誰先站到貨所在的那一格誰拿走，同時到就摔壞；背包有重量上限，滿了要原地停 1 秒出貨。
 * 地圖、牆、走格、距離沿用 `_diamonds/logic.ts`（不改它）。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 帶子上的格數：x 6 到 25、y 6 到 17 的矩形外圍。 */
export const RING = 60;
/** 每幾個 tick 貨前進一格（走路的一半快）。 */
export const BELT_STEP = 10;
/** 每幾個 tick 出現一件貨。 */
export const SPAWN_EVERY = 90;
/** 貨出現前幾個 tick 就在畫面上預告。 */
export const NOTICE = 60;
/** 一件貨最多流幾個 tick（一圈）就消失。 */
export const LIFETIME = 600;
/** 背包重量上限。 */
export const CAP = 8;
/** 出貨要原地停幾個 tick。 */
export const SHIP_TICKS = 60;
export const RING_X: readonly [number, number] = [6, 25];
export const RING_Y: readonly [number, number] = [6, 17];
/** 貨的重量 1 到 `MAX_W`、價值 1 到 `MAX_V`。 */
export const MAX_W = 4;
export const MAX_V = 9;

/**
 * AI 用的常數（量過之後的結果與改動理由寫在 `docs/cards/D-10.md`「我做的決定（實作時補充）」）。
 * gain 的單位：得一分 ＝ `GAIN_PER_POINT` ＝ 100；背包裡的價值按 `BAG_DISCOUNT` 折（還沒出貨）。
 */
export const BAG_DISCOUNT = 0.6;
/** 攔得到的貨的潛力是 `CATCH_WEIGHT × v ÷ (步數 + 2)`。小規格寫 30，改 60（互動強度測試 14.7% → 25.1%）。 */
export const CATCH_WEIGHT = 60;
/** 我先到、對手也拿得下的貨，多算對手的損失乘上這個比例。 */
export const DENIAL = 0.5;
/** 對手先到的貨，我還留這個比例的梯度（0.3 太高，AI 的位置不太改變人的最好動作）。 */
export const CONSOLATION = 0.1;
/** 價值密度（v ÷ w）的平均，占空間的 danger 與出貨的固定成本都拿它當尺。 */
export const AVG_DENSITY = 2;

export const TIE_PENALTY = 0.5;
/** 同時到的 danger：這麼近（tick）以內全額，越遠越淡，`TIE_HORIZON` 以外是 0。 */
export const TIE_NEAR = 30;
export const TIE_HORIZON = 150;
/** 「就要拿到了」的門檻（tick）：占空間的 danger 只看這麼近的貨。 */
export const IMMINENT = 15;
/** 來不及出貨的 danger 提早這麼多 tick 開始升。 */
export const LATE_MARGIN = 60;
/**
 * 出貨的固定成本：停這 1 秒不管什麼時候都要付，所以背包還有很多空位就出貨是浪費。
 * 空位每 1 格算 `AVG_DENSITY` 分的價值，乘上這個比例（比例 < 1 因為空位不一定填得滿）。
 */
export const SHIP_SLACK = 0.5;
/** 離結束還有這麼多 tick（扣掉出貨本身）以上，出貨的固定成本全額；越接近結束越不算（空位填不滿了）。 */
export const SHIP_TAIL = 300;
/** 到目標的每一步扣多少 gain。 */
export const DIST_WEIGHT = 1;
/** 預告之外、規則已經決定位置的那一件（第二件）在 AI 眼中的重量與價值。 */
const PHANTOM_W = 2;
const PHANTOM_V = 5;
const INF = 1_000_000;

// ---------------------------------------------------------------------------
// 帶子的形狀
// ---------------------------------------------------------------------------

/** 60 個格子編號，順時針，0 是左上角。 */
export function buildRing(): readonly number[] {
  const [x0, x1] = RING_X;
  const [y0, y1] = RING_Y;
  const out: number[] = [];
  for (let x = x0; x <= x1; x += 1) {
    out.push(cell(x, y0));
  }
  for (let y = y0 + 1; y <= y1; y += 1) {
    out.push(cell(x1, y));
  }
  for (let x = x1 - 1; x >= x0; x -= 1) {
    out.push(cell(x, y1));
  }
  for (let y = y1 - 1; y > y0; y -= 1) {
    out.push(cell(x0, y));
  }
  return out;
}

const RING_CELLS: readonly number[] = buildRing();

/** 這個種子的牆，帶子壓過的牆拿掉（拿掉牆只會多出空格，不會破壞連通）。 */
export function beltWalls(seed: number): readonly number[] {
  const walls = [...generateWalls(seed).walls];
  for (const c of RING_CELLS) {
    walls[c] = 0;
  }
  return walls;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface Good {
  /** 所在的格子編號（= `ring[idx]`）。 */
  readonly cell: number;
  /** 在圈上的編號 0 到 59。 */
  readonly idx: number;
  readonly w: number;
  readonly v: number;
  /** 已經流動幾個 tick；到 `LIFETIME` 消失。 */
  readonly age: number;
}

export interface Item {
  readonly w: number;
  readonly v: number;
}

export interface Upcoming {
  readonly idx: number;
  readonly w: number;
  readonly v: number;
  /** 它出現的 tick。 */
  readonly at: number;
}

export interface D10State extends DiamondsBase {
  readonly ring: readonly number[];
  readonly belt: readonly Good[];
  readonly upcoming: Upcoming | null;
  /** 1：下一件要擲的是一對的第二件（位置在 `pairIdx` 的對面）；0：下一件是新的一對。 */
  readonly pairLeft: number;
  /** 這一對第一件的編號（`pairLeft` 是 1 時有意義）。 */
  readonly pairIdx: number;
  readonly bag: readonly [readonly Item[], readonly Item[]];
  /** 出貨倒數（0 是沒有在出貨）。 */
  readonly ship: readonly [number, number];
  /** 累計（指紋量測用，AI 不看）：拿了幾件、拿的重量與價值總和、摔壞幾件（共用）、出貨幾次。 */
  readonly taken: readonly [number, number];
  readonly takenW: readonly [number, number];
  readonly takenV: readonly [number, number];
  readonly broken: number;
  readonly ships: readonly [number, number];
}

export interface StateOverrides extends BaseOverrides {
  readonly belt?: readonly Good[];
  readonly upcoming?: Upcoming | null;
  readonly pairLeft?: number;
  readonly pairIdx?: number;
  readonly bag?: readonly [readonly Item[], readonly Item[]];
  readonly ship?: readonly [number, number];
  readonly taken?: readonly [number, number];
  readonly takenW?: readonly [number, number];
  readonly takenV?: readonly [number, number];
  readonly broken?: number;
  readonly ships?: readonly [number, number];
}

/** 測試輔助：一件貨（位置由圈上編號算出）。 */
export function makeGood(idx: number, w: number, v: number, age = 0): Good {
  return { cell: RING_CELLS[idx] as number, idx, w, v, age };
}

/** 測試輔助：預設局面（沒有牆、空的帶子、兩邊背包空、沒有預告）加上 overrides。 */
export function makeState(overrides: StateOverrides = {}): D10State {
  return {
    ...makeBase(overrides),
    ring: RING_CELLS,
    belt: overrides.belt ?? [],
    upcoming: overrides.upcoming ?? null,
    pairLeft: overrides.pairLeft ?? 0,
    pairIdx: overrides.pairIdx ?? 0,
    bag: overrides.bag ?? [[], []],
    ship: overrides.ship ?? [0, 0],
    taken: overrides.taken ?? [0, 0],
    takenW: overrides.takenW ?? [0, 0],
    takenV: overrides.takenV ?? [0, 0],
    broken: overrides.broken ?? 0,
    ships: overrides.ships ?? [0, 0],
  };
}

export function bagWeight(items: readonly Item[]): number {
  let total = 0;
  for (const item of items) {
    total += item.w;
  }
  return total;
}

export function bagValue(items: readonly Item[]): number {
  let total = 0;
  for (const item of items) {
    total += item.v;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 擲新的一件
// ---------------------------------------------------------------------------

interface Rolled {
  readonly upcoming: Upcoming;
  readonly pairLeft: number;
  readonly pairIdx: number;
  readonly rng: RngState;
}

/** 在預告的那個 tick 才擲：位置（一對的第二件在第一件的對面）、重量、價值。 */
function roll(rng: RngState, tick: number, pairLeft: number, pairIdx: number): Rolled {
  let state = rng;
  let idx: number;
  let nextPairLeft: number;
  let nextPairIdx: number;
  if (pairLeft === 1) {
    idx = (pairIdx + RING / 2) % RING;
    nextPairLeft = 0;
    nextPairIdx = pairIdx;
  } else {
    [idx, state] = intFrom(state, RING);
    nextPairLeft = 1;
    nextPairIdx = idx;
  }
  const [w, afterW] = intFrom(state, MAX_W);
  const [v, afterV] = intFrom(afterW, MAX_V);
  state = afterV;
  return {
    upcoming: { idx, w: w + 1, v: v + 1, at: tick + NOTICE },
    pairLeft: nextPairLeft,
    pairIdx: nextPairIdx,
    rng: state,
  };
}

// ---------------------------------------------------------------------------
// 給 AI 的看法：誰最早能站到貨所在的格子上
// ---------------------------------------------------------------------------

/** 一個角色「多久以後能站到某一格」的算法。 */
interface Reach {
  /** 現在的格子。 */
  readonly here: number;
  readonly shipLeft: number;
  /** 已經鎖定了一個走得動的方向。 */
  readonly moving: boolean;
  /** 第一次可以走格的是幾個 tick 以後（出貨中要先等倒數）。 */
  readonly delay: number;
  /** 從下一步的格子出發的距離場。 */
  readonly field: Int32Array;
}

function reachOf(state: D10State, side: Side): Reach {
  const me = state.players[side];
  const shipLeft = state.ship[side] as number;
  const p0 = shipLeft > 0 ? me.cell : nextCell(state.walls, me);
  const first = state.tick + shipLeft + 1;
  const move = first + ((MOVE_EVERY - (first % MOVE_EVERY)) % MOVE_EVERY);
  return {
    here: me.cell,
    shipLeft,
    moving: p0 !== me.cell,
    delay: move - state.tick,
    field: bfsDistances(state.walls, p0),
  };
}

/** 站到 `c` 要幾個 tick（站在上面等的話，出貨倒數一結束就算）。 */
function arrival(reach: Reach, c: number): number {
  if (c === reach.here && !reach.moving) {
    return reach.shipLeft;
  }
  return reach.delay + MOVE_EVERY * (reach.field[c] as number);
}

/** 一件貨（含預告中的、規則已經決定位置的）在 AI 眼中的樣子。 */
interface Seen {
  /** 場上的貨、預告中的一件、規則已經決定位置的下一件（第二件）。 */
  readonly kind: 'belt' | 'upcoming' | 'partner';
  readonly idx: number;
  readonly w: number;
  readonly v: number;
  /** 它在 `idx` 這一格的時刻（幾個 tick 以後）。 */
  readonly first: number;
  /** 它第一次前進的時刻。 */
  readonly next: number;
  /** 最多還能前進幾格。 */
  readonly kMax: number;
}

interface Catch {
  /** 最早站得到的時刻（tick 以後），站不到是 `INF`。 */
  readonly tau: number;
  /** 在哪一格攔到。 */
  readonly at: number;
}
const NO_CATCH: Catch = { tau: INF, at: -1 };

/**
 * 這個角色最早能站在貨所在的格子上的時刻。
 * 貨第 k 次前進後到圈上第 `idx + k` 格；到達時間減貨到達時間（slack）每前進一格至少少 5，
 * 所以 slack 為正時可以一次跳過 ⌈slack / 15⌉ 格。
 */
function catchOf(ring: readonly number[], reach: Reach, seen: Seen): Catch {
  let k = 0;
  while (k <= seen.kMax) {
    const c = ring[(seen.idx + k) % RING] as number;
    const tau = k === 0 ? seen.first : seen.next + BELT_STEP * (k - 1);
    const slack = arrival(reach, c) - tau;
    if (slack <= 0) {
      return { tau, at: c };
    }
    k += Math.ceil(slack / 15);
  }
  return NO_CATCH;
}

/** 場上與預告中的貨，加上「規則已經決定位置」的下一件（第二件，重量與價值用平均）。 */
function seenGoods(state: D10State): Seen[] {
  const out: Seen[] = [];
  for (const g of state.belt) {
    out.push({
      kind: 'belt',
      idx: g.idx,
      w: g.w,
      v: g.v,
      first: 0,
      next: BELT_STEP - (g.age % BELT_STEP),
      kMax: Math.floor((LIFETIME - 1) / BELT_STEP) - Math.floor(g.age / BELT_STEP),
    });
  }
  const up = state.upcoming;
  if (up !== null) {
    const first = Math.max(0, up.at - state.tick);
    out.push({
      kind: 'upcoming',
      idx: up.idx,
      w: up.w,
      v: up.v,
      first,
      next: first + BELT_STEP,
      kMax: RING - 1,
    });
    if (state.pairLeft === 1) {
      const partner = up.at + SPAWN_EVERY - state.tick;
      out.push({
        kind: 'partner',
        idx: (up.idx + RING / 2) % RING,
        w: PHANTOM_W,
        v: PHANTOM_V,
        first: partner,
        next: partner + BELT_STEP,
        kMax: RING - 1,
      });
    }
  } else if (state.pairLeft === 1) {
    const rollAt = state.tick + SPAWN_EVERY - (state.tick % SPAWN_EVERY);
    const partner = rollAt + NOTICE - state.tick;
    out.push({
      kind: 'partner',
      idx: (state.pairIdx + RING / 2) % RING,
      w: PHANTOM_W,
      v: PHANTOM_V,
      first: partner,
      next: partner + BELT_STEP,
      kMax: RING - 1,
    });
  }
  return out;
}

const STEP_TICKS = MOVE_EVERY;

/** 一件貨對攔到它的人值多少（越早攔到越值錢）。 */
function potential(v: number, tau: number): number {
  return (CATCH_WEIGHT * v) / (tau / STEP_TICKS + 2);
}

function canFit(state: D10State, side: Side, w: number): boolean {
  return (state.ship[side] as number) > 0 || bagWeight(state.bag[side]) + w <= CAP;
}

/** 還來得及出貨：現在按（下一個 tick 開始）到結束之前倒數走得完。 */
function canShipInTime(state: D10State, extra: number): boolean {
  return state.tick + 1 + extra + SHIP_TICKS <= state.maxTicks;
}

interface Plan {
  /** 要走去攔的那一格（沒有貨可攔時是最近的一格帶子）。 */
  readonly target: number;
  readonly value: number;
}

interface View {
  readonly goods: Seen[];
  readonly mine: Reach;
  readonly theirs: Reach;
  readonly catchMine: Catch[];
  readonly catchTheirs: Catch[];
  readonly fitMine: boolean[];
  readonly fitTheirs: boolean[];
}

function viewOf(state: D10State, side: Side, atCurrent: boolean): View {
  const other: Side = side === 0 ? 1 : 0;
  const goods = seenGoods(state);
  const mine = atCurrent ? reachAtCurrent(state, side) : reachOf(state, side);
  const theirs = reachOf(state, other);
  const catchMine: Catch[] = [];
  const catchTheirs: Catch[] = [];
  const fitMine: boolean[] = [];
  const fitTheirs: boolean[] = [];
  for (const g of goods) {
    const fm = canFit(state, side, g.w);
    const ft = canFit(state, other, g.w);
    fitMine.push(fm);
    fitTheirs.push(ft);
    catchMine.push(fm ? catchOf(state.ring, mine, g) : NO_CATCH);
    catchTheirs.push(ft ? catchOf(state.ring, theirs, g) : NO_CATCH);
  }
  return { goods, mine, theirs, catchMine, catchTheirs, fitMine, fitTheirs };
}

/** `actions` 用：用現在的位置（不看鎖定的方向）。 */
function reachAtCurrent(state: D10State, side: Side): Reach {
  const me = state.players[side];
  const shipLeft = state.ship[side] as number;
  const first = state.tick + shipLeft + 1;
  const move = first + ((MOVE_EVERY - (first % MOVE_EVERY)) % MOVE_EVERY);
  return {
    here: me.cell,
    shipLeft,
    moving: false,
    delay: move - state.tick,
    field: bfsDistances(state.walls, me.cell),
  };
}

export interface CatchRow {
  readonly kind: 'belt' | 'upcoming' | 'partner';
  readonly idx: number;
  readonly w: number;
  readonly v: number;
  /** 我、對手最早站得到的時刻（tick 以後）與格子；放不下或站不到是 `Infinity`。 */
  readonly mineTau: number;
  readonly mineAt: number;
  readonly theirsTau: number;
  readonly theirsAt: number;
}

/**
 * 每件貨（含預告中的與規則已經決定位置的下一件）兩邊最早能站在它所在的格子上的時刻。
 * 公開資訊的純函式；`evaluate` 用它，劇本玩家也用它（幾何不是策略）。用現在的位置，不看鎖定的方向。
 */
export function catchTable(state: D10State, side: Side): CatchRow[] {
  const view = viewOf(state, side, true);
  return view.goods.map((g, i) => {
    const mine = view.catchMine[i] as Catch;
    const theirs = view.catchTheirs[i] as Catch;
    return {
      kind: g.kind,
      idx: g.idx,
      w: g.w,
      v: g.v,
      mineTau: mine.tau >= INF ? Number.POSITIVE_INFINITY : mine.tau,
      mineAt: mine.at,
      theirsTau: theirs.tau >= INF ? Number.POSITIVE_INFINITY : theirs.tau,
      theirsAt: theirs.at,
    };
  });
}

/** 我最想去的那一格：我拿得到的貨裡 `potential` 最大的（對手先到的只算 `CONSOLATION`）。 */
function bestPlan(view: View): Plan | null {
  let best: Plan | null = null;
  for (let i = 0; i < view.goods.length; i += 1) {
    const g = view.goods[i] as Seen;
    const mine = view.catchMine[i] as Catch;
    if (mine.tau >= INF) {
      continue;
    }
    const theirs = view.catchTheirs[i] as Catch;
    const first = mine.tau < theirs.tau;
    const value = potential(g.v, mine.tau) * (first ? 1 : CONSOLATION);
    if (best === null || value > best.value) {
      best = { target: mine.at, value };
    }
  }
  return best;
}

/** 最近的一格帶子（沒有貨可攔時往那裡走）。 */
function nearestRing(state: D10State, field: Int32Array): number {
  let best = state.ring[0] as number;
  let bestDistance = field[best] as number;
  for (const c of state.ring) {
    if ((field[c] as number) < bestDistance) {
      best = c;
      bestDistance = field[c] as number;
    }
  }
  return best;
}

function focusOf(state: D10State, side: Side): number | null {
  if ((state.ship[side] as number) > 0) {
    return null;
  }
  const view = viewOf(state, side, true);
  const plan = bestPlan(view);
  return plan === null ? nearestRing(state, view.mine.field) : plan.target;
}

// ---------------------------------------------------------------------------
// 遊戲
// ---------------------------------------------------------------------------

const NONE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});
const SHIP_BUTTON: Buttons = Object.freeze({ ...NONE, b: true });

export const d10Game: Game<D10State> = {
  id: 'D-10',

  init(seed: number, config: GameConfig): D10State {
    const walls = beltWalls(seed);
    const rolled = roll(rngStateFor(seed, 'belt'), 0, 0, 0);
    return {
      tick: 0,
      maxTicks: config.maxTicks,
      walls,
      players: [
        { cell: START_CELLS[0], pending: -1, score: 0 },
        { cell: START_CELLS[1], pending: -1, score: 0 },
      ],
      rng: rolled.rng,
      over: false,
      winner: null,
      ring: RING_CELLS,
      belt: [],
      upcoming: rolled.upcoming,
      pairLeft: rolled.pairLeft,
      pairIdx: rolled.pairIdx,
      bag: [[], []],
      ship: [0, 0],
      taken: [0, 0],
      takenW: [0, 0],
      takenV: [0, 0],
      broken: 0,
      ships: [0, 0],
    };
  },

  step(state: D10State, inputs: Inputs): D10State {
    if (state.over) {
      return state;
    }
    const tick = state.tick + 1;
    const ring = state.ring;

    // 1. 按鍵：出貨中的人什麼都不能做；按 b（背包不空）開始出貨；否則方向鍵鎖定待走方向。
    const ship: [number, number] = [state.ship[0], state.ship[1]];
    const started: [boolean, boolean] = [false, false];
    const steered: Walker[] = [];
    for (const side of [0, 1] as const) {
      const walker = state.players[side];
      if (ship[side] > 0) {
        steered.push(walker);
      } else if (inputs[side].b && (state.bag[side] as readonly Item[]).length > 0) {
        ship[side] = SHIP_TICKS;
        started[side] = true;
        steered.push({ ...walker, pending: -1 });
      } else {
        steered.push(steerWalker(walker, inputs[side]));
      }
    }
    let players: readonly [Walker, Walker] = [steered[0] as Walker, steered[1] as Walker];

    // 2. 走格（出貨中的人 pending 是 -1，不會動）。
    if (tick % MOVE_EVERY === 0) {
      players = [moveWalker(state.walls, players[0]), moveWalker(state.walls, players[1])];
    }

    // 3. 出貨倒數：這個 tick 才開始的不減；倒數到 0 的入帳、清空背包。
    const bag: [readonly Item[], readonly Item[]] = [state.bag[0], state.bag[1]];
    const scores: [number, number] = [players[0].score, players[1].score];
    const ships: [number, number] = [state.ships[0], state.ships[1]];
    for (const side of [0, 1] as const) {
      if (!started[side] && ship[side] > 0) {
        ship[side] -= 1;
        if (ship[side] === 0) {
          scores[side] += bagValue(bag[side]);
          bag[side] = [];
          ships[side] += 1;
        }
      }
    }
    players = [
      { ...players[0], score: scores[0] },
      { ...players[1], score: scores[1] },
    ];

    // 4. 帶子：每件貨老一個 tick，每 BELT_STEP 個 tick 前進一格，到 LIFETIME 消失。
    let belt: Good[] = [];
    for (const g of state.belt) {
      const age = g.age + 1;
      if (age >= LIFETIME) {
        continue;
      }
      if (age % BELT_STEP === 0) {
        const idx = (g.idx + 1) % RING;
        belt.push({ cell: ring[idx] as number, idx, w: g.w, v: g.v, age });
      } else {
        belt.push({ cell: g.cell, idx: g.idx, w: g.w, v: g.v, age });
      }
    }

    // 5. 出現與預告。
    let upcoming = state.upcoming;
    let pairLeft = state.pairLeft;
    let pairIdx = state.pairIdx;
    let rng = state.rng;
    if (upcoming !== null && upcoming.at <= tick) {
      belt.push({
        cell: ring[upcoming.idx] as number,
        idx: upcoming.idx,
        w: upcoming.w,
        v: upcoming.v,
        age: 0,
      });
      upcoming = null;
    }
    if (upcoming === null && tick % SPAWN_EVERY === 0) {
      const rolled = roll(rng, tick, pairLeft, pairIdx);
      upcoming = rolled.upcoming;
      pairLeft = rolled.pairLeft;
      pairIdx = rolled.pairIdx;
      rng = rolled.rng;
    }

    // 6. 拿：這個 tick 結束時貨所在的格子上有人、不在出貨、放得下。兩個人都符合：摔壞。
    const weight: [number, number] = [bagWeight(bag[0]), bagWeight(bag[1])];
    const taken: [number, number] = [state.taken[0], state.taken[1]];
    const takenW: [number, number] = [state.takenW[0], state.takenW[1]];
    const takenV: [number, number] = [state.takenV[0], state.takenV[1]];
    let broken = state.broken;
    const remaining: Good[] = [];
    for (const g of belt) {
      const can0 =
        ship[0] === 0 && players[0].cell === g.cell && (weight[0] as number) + g.w <= CAP;
      const can1 =
        ship[1] === 0 && players[1].cell === g.cell && (weight[1] as number) + g.w <= CAP;
      if (can0 && can1) {
        broken += 1;
        continue;
      }
      const winner = can0 ? 0 : can1 ? 1 : -1;
      if (winner < 0) {
        remaining.push(g);
        continue;
      }
      const side = winner as Side;
      bag[side] = [...bag[side], { w: g.w, v: g.v }];
      weight[side] += g.w;
      taken[side] += 1;
      takenW[side] += g.w;
      takenV[side] += g.v;
    }
    belt = remaining;

    const over = tick >= state.maxTicks;
    return {
      ...state,
      tick,
      players,
      rng,
      belt,
      upcoming,
      pairLeft,
      pairIdx,
      bag,
      ship,
      taken,
      takenW,
      takenV,
      broken,
      ships,
      over,
      winner: over ? winnerByScore(players) : null,
    };
  },

  isOver(state: D10State): boolean {
    return state.over;
  },

  score(state: D10State): readonly [number, number] {
    return [state.players[0].score, state.players[1].score];
  },

  winner(state: D10State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: D10State, side: Side): readonly Buttons[] {
    if ((state.ship[side] as number) > 0) {
      return [NONE];
    }
    const moves = actionsToward(state.walls, state.players[side], side, focusOf(state, side));
    return (state.bag[side] as readonly Item[]).length > 0 ? [...moves, SHIP_BUTTON] : moves;
  },

  evaluate(state: D10State, side: Side): { gain: number; danger: number } {
    const other: Side = side === 0 ? 1 : 0;
    const difference = state.players[side].score - state.players[other].score;
    if (state.over) {
      const sign = difference === 0 ? 0 : difference > 0 ? 1 : -1;
      return { gain: GAIN_PER_POINT * difference + sign * WIN_BONUS, danger: 0 };
    }
    const view = viewOf(state, side, false);
    const myShip = state.ship[side] as number;
    const theirShip = state.ship[other] as number;

    // 背包：出貨中的算「入帳」（來得及的話），沒出貨的打折（來不及出的不算）。
    const bagOf = (who: Side, shipLeft: number): number => {
      const value = bagValue(state.bag[who]);
      if (shipLeft > 0) {
        return state.tick + shipLeft <= state.maxTicks ? GAIN_PER_POINT * value : 0;
      }
      return canShipInTime(state, 0) ? GAIN_PER_POINT * BAG_DISCOUNT * value : 0;
    };
    let gain = GAIN_PER_POINT * difference + bagOf(side, myShip) - bagOf(other, theirShip);

    // 貨：我先到的，我拿；對手先到的，它拿；同時到的摔壞。
    let target: Plan | null = null;
    for (let i = 0; i < view.goods.length; i += 1) {
      const g = view.goods[i] as Seen;
      const mine = view.catchMine[i] as Catch;
      const theirs = view.catchTheirs[i] as Catch;
      if (mine.tau < theirs.tau) {
        const value = potential(g.v, mine.tau);
        gain += value;
        if (theirs.tau < INF) {
          gain += DENIAL * potential(g.v, theirs.tau);
        }
        if (target === null || value > target.value) {
          target = { target: mine.at, value };
        }
      } else if (theirs.tau < mine.tau) {
        gain -= DENIAL * potential(g.v, theirs.tau);
        if (mine.tau < INF) {
          const value = CONSOLATION * potential(g.v, mine.tau);
          gain += value;
          if (target === null || value > target.value) {
            target = { target: mine.at, value };
          }
        }
      } else if (mine.tau < INF) {
        // 同時到：摔壞，誰也得不到。
        gain += CONSOLATION * potential(g.v, mine.tau);
        if (target === null) {
          target = { target: mine.at, value: 0 };
        }
      }
    }

    // 出貨中：先扣固定成本（背包還有多少空位沒用到），再扣這段時間我原本拿得到的貨（被對手拿得下的多算一倍）。
    if (myShip > 0) {
      gain -=
        GAIN_PER_POINT *
        BAG_DISCOUNT *
        AVG_DENSITY *
        SHIP_SLACK *
        Math.max(0, CAP - bagWeight(state.bag[side])) *
        clamp01((state.maxTicks - state.tick - SHIP_TICKS) / SHIP_TAIL);
      const free = viewOfFree(state, side);
      for (let i = 0; i < view.goods.length; i += 1) {
        const g = view.goods[i] as Seen;
        const mine = catchOf(state.ring, free, g);
        if (!canFitUnfrozen(state, side, g.w) || mine.tau > myShip) {
          continue;
        }
        const theirs = view.catchTheirs[i] as Catch;
        if (mine.tau <= theirs.tau) {
          gain -= GAIN_PER_POINT * BAG_DISCOUNT * g.v * (theirs.tau < INF ? 2 : 1);
        }
      }
    }

    // danger：摔壞與占掉空間。出貨中的人用「沒被凍住」的位置算，不然出貨會變成躲開 danger 的避風港。
    let tieDanger = 0;
    let spaceDanger = 0;
    const myWeight = bagWeight(state.bag[side]);
    const free = myShip > 0 ? viewOfFree(state, side) : null;
    for (let i = 0; i < view.goods.length; i += 1) {
      const g = view.goods[i] as Seen;
      const mine =
        free === null
          ? (view.catchMine[i] as Catch)
          : canFitUnfrozen(state, side, g.w)
            ? catchOf(state.ring, free, g)
            : NO_CATCH;
      const theirs = view.catchTheirs[i] as Catch;
      if (mine.tau < theirs.tau) {
        if (mine.tau <= IMMINENT) {
          const density = clamp01((AVG_DENSITY - g.v / g.w) / AVG_DENSITY);
          spaceDanger = Math.max(spaceDanger, density * ((myWeight + g.w) / CAP));
        }
      } else if (mine.tau === theirs.tau && mine.tau < INF) {
        const near = clamp01((TIE_HORIZON - mine.tau) / (TIE_HORIZON - TIE_NEAR));
        tieDanger = Math.max(tieDanger, TIE_PENALTY * Math.min(1, g.v / 5) * near);
      }
    }

    // 走向目標的距離。
    const fromHere = view.mine.field;
    if (target !== null) {
      gain -= DIST_WEIGHT * Math.min(200, fromHere[target.target] as number);
    } else {
      gain -= DIST_WEIGHT * Math.min(200, fromHere[nearestRing(state, fromHere)] as number);
    }

    // 來不及出貨：背包裡有價值、又快沒時間了。
    let lateDanger = 0;
    if (myShip === 0) {
      const remaining = state.maxTicks - state.tick;
      const walk =
        target === null ? 0 : MOVE_EVERY * Math.min(60, fromHere[target.target] as number);
      lateDanger =
        clamp01((SHIP_TICKS + LATE_MARGIN + walk - remaining) / 120) *
        Math.min(1, bagValue(state.bag[side]) / 20);
    }

    return { gain, danger: Math.max(tieDanger, spaceDanger, lateDanger) };
  },
};

/** 出貨中的人「如果沒被凍住」的 Reach（算他停這 1 秒的代價）。 */
function viewOfFree(state: D10State, side: Side): Reach {
  const me = state.players[side];
  const first = state.tick + 1;
  const move = first + ((MOVE_EVERY - (first % MOVE_EVERY)) % MOVE_EVERY);
  return {
    here: me.cell,
    shipLeft: 0,
    moving: false,
    delay: move - state.tick,
    field: bfsDistances(state.walls, me.cell),
  };
}

function canFitUnfrozen(state: D10State, side: Side, w: number): boolean {
  return bagWeight(state.bag[side]) + w <= CAP;
}
