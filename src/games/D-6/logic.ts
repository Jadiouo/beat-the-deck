import { intFrom, rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';

/**
 * D-6 市場（SPEC 第 9 節的一行方向；小規格 `docs/cards/D-6.md`）。
 *
 * 24 回合，每回合兩邊同時各選一個動作：買 1 件某種貨、賣 1 件某種貨、不動。價格 ＝ 公開的行情曲線 ＋ 雙方買賣
 * 留下的偏移。最後只算現金，沒賣掉的貨一毛不值。
 *
 * 結算流程（沿用 H-Q 的作法）：prep → choose（兩邊鎖定，超時自動不動）→ locked（2 tick）→ result（開牌）→ 入帳。
 * 鎖定到開牌只有 3 步，所以搜尋深度 ≥ 3 才走得到 `result`，等級曲線從這裡長出來（小規格「等級曲線」）。
 * 「一回合最短多久」放在開牌之後的 `result`，不放在 choose：否則鎖定到開牌超過 `depth` 的額度（DESIGN-AI-FUN 10.6）。
 *
 * 同時出手：對方的 `pending` 在 `result` 之前是祕密。`evaluate`、`actions` 都只讀自己的鎖定；對方這回合
 * 做了什麼，只能從公開的 `history` 與公開的存貨推測（4.1、4.2）。
 */

export const ROUNDS = 24;
export const GOODS = 3;
export const CASH = 60;
export const FEE = 1;
export const LOW = 6;
export const HIGH = 15;
export const WIDTH = 6;
/** 衝擊：每淨買（賣）一件，下一回合的偏移改變 `IMPACT / 2`（再往 0 無條件捨去）。 */
export const IMPACT = 2;
export const PRICE_MIN = 2;
export const PRICE_MAX = 20;
/** `predictOpponent` 只看對手最近這麼多回合。 */
export const WINDOW = 6;

/** 第一回合的準備期；其他回合是 `PREP_TICKS`。 */
export const FIRST_PREP_TICKS = 60;
export const PREP_TICKS = 30;
/** choose 最長多少 tick，超過的那一邊自動「不動」。 */
export const CHOOSE_TIMEOUT = 68;
/** 兩邊都鎖定之後等幾個 tick 開牌。 */
export const LOCK_TICKS = 2;
/** 開牌停幾個 tick 才入帳、進下一回合。 */
export const RESULT_TICKS = 48;

/** 動作編號：0 不動、1 到 3 買穀／布／鐵、4 到 6 賣穀／布／鐵。 */
export type Trade = number;
export const PASS: Trade = 0;
export const TRADES = 7;
export function BUY(good: number): Trade {
  return 1 + good;
}
export function SELL(good: number): Trade {
  return 4 + good;
}
function isBuy(trade: Trade): boolean {
  return trade >= 1 && trade <= 3;
}
function isSell(trade: Trade): boolean {
  return trade >= 4;
}
/** 動作碰的是哪一種貨；不動是 −1。 */
function goodOf(trade: Trade): number {
  return trade === PASS ? -1 : (trade - 1) % 3;
}

export const IDLE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});

/**
 * 動作對應的按鍵：下 ＝ 不動；按住 a 再按左／上／右 ＝ 買穀／布／鐵；按住 b 再按左／上／右 ＝ 賣。
 * 同一個 tick 同時按了 a 和 b 當作沒有動作；方向鍵單獨按也不鎖定。
 */
export const TRADE_BUTTONS: readonly Buttons[] = Object.freeze([
  Object.freeze({ ...IDLE, down: true }),
  Object.freeze({ ...IDLE, a: true, left: true }),
  Object.freeze({ ...IDLE, a: true, up: true }),
  Object.freeze({ ...IDLE, a: true, right: true }),
  Object.freeze({ ...IDLE, b: true, left: true }),
  Object.freeze({ ...IDLE, b: true, up: true }),
  Object.freeze({ ...IDLE, b: true, right: true }),
]);

export type D6Phase = 'prep' | 'choose' | 'locked' | 'result';

/** 開牌的結果：兩邊的動作，與各自這回合的現金變化。只在 `result` 階段存在，入帳之後進 `history`。 */
export interface D6Last {
  readonly trades: readonly [Trade, Trade];
  readonly delta: readonly [number, number];
}

export interface D6State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 現在第幾回合（0 到 ROUNDS − 1）。 */
  readonly round: number;
  readonly phase: D6Phase;
  /** prep、locked、result 還剩幾個 tick。 */
  readonly wait: number;
  /** choose 已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  /** 行情曲線：3 種貨 × 24 回合，公開、種子決定、整場不變。 */
  readonly base: readonly (readonly number[])[];
  /** 三種貨各自的偏移（雙方買賣留下的痕跡）。 */
  readonly dev: readonly number[];
  /** 已入帳的現金與存貨（`inv[邊][貨]`）。這回合的買賣要等 result 結束才入帳。 */
  readonly cash: readonly [number, number];
  readonly inv: readonly (readonly number[])[];
  /** 兩邊這回合的鎖定（`null` 是還沒鎖定）。鎖定之後不能改。 */
  readonly pending: readonly [Trade | null, Trade | null];
  readonly last: D6Last | null;
  /** 已入帳的每一回合 `[人, AI]` 的動作，最多 ROUNDS 筆。公開的。 */
  readonly history: readonly (readonly [Trade, Trade])[];
  /** 衝擊係數（預設 `IMPACT`；`config.params.impact` 可以改，量測用）。 */
  readonly impact: number;
  /** AI 的對手模型開關（消融用：`config.params.model = 0` 關掉）。 */
  readonly model: boolean;
}

// ---------------------------------------------------------------------------
// 行情曲線與價格
// ---------------------------------------------------------------------------

/**
 * 三個峰值回合 → 3 × 24 的曲線：`LOW + round((HIGH − LOW) × max(0, 1 − |r − peak| / WIDTH))`。
 * 用整數算四捨五入（0.5 進位）：浮點數的 `1 − 5/6` 乘 9 是 1.4999999999999998，會把 1.5 捨成 1，和小規格的數字差 1。
 */
export function curveFor(peaks: readonly number[]): number[][] {
  return peaks.map((peak) =>
    Array.from({ length: ROUNDS }, (_v, r) => {
      const near = Math.max(0, WIDTH - Math.abs(r - peak));
      return LOW + Math.floor((2 * (HIGH - LOW) * near + WIDTH) / (2 * WIDTH));
    }),
  );
}

/** 4 到 17 回合裡挑三個峰值、兩兩至少差 5 回合：從 6 個位置挑 3 個（20 種）均勻抽一種。 */
const PEAK_SETS: readonly (readonly [number, number, number])[] = (() => {
  const sets: [number, number, number][] = [];
  for (let a = 0; a < 6; a += 1) {
    for (let b = a + 1; b < 6; b += 1) {
      for (let c = b + 1; c < 6; c += 1) {
        sets.push([4 + a, 8 + b, 12 + c]);
      }
    }
  }
  return sets;
})();

const ORDERS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

function peaksFor(seed: number): number[] {
  const [setIndex, afterSet] = intFrom(rngStateFor(seed, 'curve'), PEAK_SETS.length);
  const [orderIndex] = intFrom(afterSet, ORDERS.length);
  const set = PEAK_SETS[setIndex] as readonly number[];
  const order = ORDERS[orderIndex] as readonly number[];
  return order.map((i) => set[i] as number);
}

function clampPrice(value: number): number {
  return Math.min(PRICE_MAX, Math.max(PRICE_MIN, value));
}

/** 這一回合第 g 種貨的價格（買賣都在這個價格成交）。 */
export function priceOf(state: D6State, good: number): number {
  return clampPrice(
    ((state.base[good] as readonly number[])[state.round] ?? LOW) + (state.dev[good] as number),
  );
}

/** 這個動作在這個價格下的現金變化（買付 `價格 + FEE`、賣得 `max(1, 價格 − FEE)`）。 */
function cashChange(state: D6State, trade: Trade): number {
  if (isBuy(trade)) {
    return -(priceOf(state, goodOf(trade)) + FEE);
  }
  if (isSell(trade)) {
    return Math.max(1, priceOf(state, goodOf(trade)) - FEE);
  }
  return 0;
}

function isLegal(state: D6State, side: Side, trade: Trade): boolean {
  if (isBuy(trade)) {
    return (state.cash[side] as number) >= priceOf(state, goodOf(trade)) + FEE;
  }
  if (isSell(trade)) {
    return ((state.inv[side] as readonly number[])[goodOf(trade)] as number) > 0;
  }
  return true;
}

/** 一個 tick 的按鍵是哪個動作；沒有動作回傳 `null`。 */
function tradeFromButtons(buttons: Buttons): Trade | null {
  if (buttons.a && buttons.b) {
    return null;
  }
  const dir = buttons.left ? 0 : buttons.up ? 1 : buttons.right ? 2 : -1;
  if (buttons.a) {
    return dir >= 0 ? BUY(dir) : null;
  }
  if (buttons.b) {
    return dir >= 0 ? SELL(dir) : null;
  }
  if (dir >= 0) {
    return null;
  }
  return buttons.down ? PASS : null;
}

export function otherSide(side: Side): Side {
  return side === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 測試用的建構
// ---------------------------------------------------------------------------

const TEST_PEAKS = [5, 10, 15] as const;

/** 測試用：第 0 回合、準備剛開始、現金各 60、峰值在 5、10、15，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<D6State> = {}): D6State {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    round: 0,
    phase: 'prep',
    wait: FIRST_PREP_TICKS,
    idle: 0,
    base: curveFor(TEST_PEAKS),
    dev: [0, 0, 0],
    cash: [CASH, CASH],
    inv: [
      [0, 0, 0],
      [0, 0, 0],
    ],
    pending: [null, null],
    last: null,
    history: [],
    impact: IMPACT,
    model: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function winnerByCash(cash: readonly [number, number]): Side | null {
  return cash[0] === cash[1] ? null : cash[0] > cash[1] ? 0 : 1;
}

/** 開牌：算出這回合的結果，現金與存貨都還沒動。 */
function settle(state: D6State): D6State {
  const trades = state.pending as readonly [Trade, Trade];
  return {
    ...state,
    phase: 'result',
    wait: RESULT_TICKS,
    last: { trades, delta: [cashChange(state, trades[0]), cashChange(state, trades[1])] },
  };
}

/** 偏移更新：dev ← trunc((dev + impact × 淨買賣) / 2)；不出現 −0。 */
function nextDev(state: D6State, trades: readonly [Trade, Trade]): number[] {
  const net = [0, 0, 0];
  for (const trade of trades) {
    if (isBuy(trade)) {
      net[goodOf(trade)] = (net[goodOf(trade)] as number) + 1;
    } else if (isSell(trade)) {
      net[goodOf(trade)] = (net[goodOf(trade)] as number) - 1;
    }
  }
  return net.map((n, g) => Math.trunc(((state.dev[g] as number) + state.impact * n) / 2) || 0);
}

function applyToInventory(inv: readonly number[], trade: Trade): number[] {
  const next = [...inv];
  if (isBuy(trade)) {
    next[goodOf(trade)] = (next[goodOf(trade)] as number) + 1;
  } else if (isSell(trade)) {
    next[goodOf(trade)] = (next[goodOf(trade)] as number) - 1;
  }
  return next;
}

/** 入帳：現金、存貨、偏移、歷史；回合數加一。 */
function bank(state: D6State): D6State {
  const last = state.last;
  if (last === null) {
    return state;
  }
  return {
    ...state,
    cash: [state.cash[0] + last.delta[0], state.cash[1] + last.delta[1]],
    inv: [
      applyToInventory(state.inv[0] as readonly number[], last.trades[0]),
      applyToInventory(state.inv[1] as readonly number[], last.trades[1]),
    ],
    dev: nextDev(state, last.trades),
    history: [...state.history, [last.trades[0], last.trades[1]] as const],
    round: state.round + 1,
    last: null,
  };
}

function finish(state: D6State): D6State {
  return { ...state, over: true, winner: winnerByCash(state.cash) };
}

function nextRound(state: D6State): D6State {
  return { ...state, phase: 'prep', wait: PREP_TICKS, idle: 0, pending: [null, null] };
}

function stepChoose(state: D6State, inputs: Inputs, tick: number): D6State {
  const timeout = state.idle + 1 >= CHOOSE_TIMEOUT;
  const pending: (Trade | null)[] = [state.pending[0], state.pending[1]];
  for (const side of [0, 1] as const) {
    if (pending[side] !== null) {
      continue;
    }
    const pressed = tradeFromButtons(inputs[side]);
    if (pressed !== null && isLegal(state, side, pressed)) {
      pending[side] = pressed;
    } else if (timeout) {
      pending[side] = PASS;
    }
  }
  const moved: D6State = {
    ...state,
    tick,
    pending: pending as [Trade | null, Trade | null],
    idle: state.idle + 1,
  };
  if (pending[0] !== null && pending[1] !== null) {
    return { ...moved, phase: 'locked', wait: LOCK_TICKS };
  }
  return moved;
}

function stepD6(state: D6State, inputs: Inputs): D6State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: D6State;
  if (state.phase === 'prep') {
    after =
      state.wait <= 1
        ? { ...state, tick, phase: 'choose', wait: 0, idle: 0 }
        : { ...state, tick, wait: state.wait - 1 };
  } else if (state.phase === 'choose') {
    after = stepChoose(state, inputs, tick);
  } else if (state.phase === 'locked') {
    after = state.wait <= 1 ? settle({ ...state, tick }) : { ...state, tick, wait: state.wait - 1 };
  } else if (state.wait <= 1) {
    const banked = bank({ ...state, tick });
    after = banked.round >= ROUNDS ? finish(banked) : nextRound(banked);
  } else {
    after = { ...state, tick, wait: state.wait - 1 };
  }
  if (!after.over && tick >= state.maxTicks) {
    // 時間到：已經開牌的回合先入帳；還在 choose 或 locked 的回合不算。
    return finish(after.phase === 'result' ? bank(after) : after);
  }
  return after;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);

/**
 * choose 而且自己還沒鎖定：不動排第一（它一定合法、一定會推進結算：10.6 陷阱二），再來是賣（有存貨的）、買（買得起的）。
 * 排序和 `evaluate` 的平手偏好一致：同分時寧可不動（不付手續費），其次賣（回收現金）。只看自己的現金與存貨。
 */
function actionsD6(state: D6State, side: Side): readonly Buttons[] {
  if (state.over || state.phase !== 'choose' || state.pending[side] !== null) {
    return ONLY_IDLE;
  }
  const list: Buttons[] = [TRADE_BUTTONS[PASS] as Buttons];
  for (let g = 0; g < GOODS; g += 1) {
    if (isLegal(state, side, SELL(g))) {
      list.push(TRADE_BUTTONS[SELL(g)] as Buttons);
    }
  }
  for (let g = 0; g < GOODS; g += 1) {
    if (isLegal(state, side, BUY(g))) {
      list.push(TRADE_BUTTONS[BUY(g)] as Buttons);
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// 對手建模（只讀 history）
// ---------------------------------------------------------------------------

/**
 * `side` 的對手下一回合做每一種動作的機率（7 個，加起來是 1，全部為正）：
 * 最近 `WINDOW` 回合每種動作出現的次數，各加 1 次平滑。只讀 `history`（公開的紀錄），不讀任何鎖定。
 */
export function predictOpponent(
  history: readonly (readonly [Trade, Trade])[],
  side: Side,
): number[] {
  const them = otherSide(side);
  const counts = new Array<number>(TRADES).fill(1);
  const from = Math.max(0, history.length - WINDOW);
  for (let i = from; i < history.length; i += 1) {
    const trade = (history[i] as readonly [Trade, Trade])[them];
    counts[trade] = (counts[trade] as number) + 1;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((c) => c / total);
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/** 結束的局，勝負加成（比任何分差都大）。 */
const END_BONUS = 1000;
/** 對手往後的習慣（最近的買賣）每早一回合還剩多少影響。 */
const HABIT_DECAY = 0.7;
/** 預測對手時，「它大概會做眼前最賺的那一手」的先驗占多少。 */
const REFLEX_PRIOR = 0.5;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 把 `inv` 的每一件貨分配到未來不同的回合（一回合只能賣一件），貪心取最高的賣價；分配不到的貨一毛不值。
 * `price(g, t)` 是第 t 回合第 g 種貨的預期價格。回傳每一件被分配到的貨 `[貨, 回合, 賣價（已扣手續費）]`。
 */
function exitPlan(
  inv: readonly number[],
  from: number,
  price: (good: number, round: number) => number,
): [number, number, number][] {
  const cand: [number, number, number][] = [];
  for (let g = 0; g < GOODS; g += 1) {
    if ((inv[g] as number) > 0) {
      for (let t = from; t < ROUNDS; t += 1) {
        cand.push([g, t, Math.max(1, price(g, t) - FEE)]);
      }
    }
  }
  cand.sort((x, y) => y[2] - x[2] || x[1] - y[1] || x[0] - y[0]);
  const used = new Set<number>();
  const left = [inv[0] as number, inv[1] as number, inv[2] as number];
  const plan: [number, number, number][] = [];
  for (const slot of cand) {
    if ((left[slot[0]] as number) === 0 || used.has(slot[1])) {
      continue;
    }
    used.add(slot[1]);
    left[slot[0]] = (left[slot[0]] as number) - 1;
    plan.push(slot);
  }
  return plan;
}

function exitValue(
  inv: readonly number[],
  from: number,
  price: (good: number, round: number) => number,
): number {
  let sum = 0;
  for (const slot of exitPlan(inv, from, price)) {
    sum += slot[2];
  }
  return sum;
}

/** 反射式的標價：還沒到的回合裡曲線最高的賣價（不看偏移、不看一回合只能賣一件）。 */
function peakAhead(state: D6State, good: number): number {
  let best = 0;
  const row = state.base[good] as readonly number[];
  for (let t = state.round + 1; t < ROUNDS; t += 1) {
    best = Math.max(best, (row[t] as number) - FEE);
  }
  return best;
}

function markValue(state: D6State, inv: readonly number[]): number {
  let sum = 0;
  for (let g = 0; g < GOODS; g += 1) {
    sum += (inv[g] as number) * peakAhead(state, g);
  }
  return sum;
}

/** 反射式評價：現金 ＋ 存貨按「還沒到的最高賣價」標價。看不到一回合只能賣一件，也看不到對方的買賣。 */
function reflexValue(state: D6State, side: Side, trade: Trade): number {
  const inv = applyToInventory(state.inv[side] as readonly number[], trade);
  return (state.cash[side] as number) + cashChange(state, trade) + markValue(state, inv);
}

/** 反射式的動作：合法的動作裡 `reflexValue` 最高的（平手取編號小的）。用來預測對手的先驗。 */
function reflexTrade(state: D6State, side: Side): Trade {
  let best = PASS;
  let bestValue = reflexValue(state, side, PASS);
  for (let trade = 1; trade < TRADES; trade += 1) {
    if (!isLegal(state, side, trade)) {
      continue;
    }
    const value = reflexValue(state, side, trade);
    if (value > bestValue) {
      best = trade;
      bestValue = value;
    }
  }
  return best;
}

/** 「好價回合」的門檻：曲線在 LOW 與 HIGH 的中點以上（旺季的上半段，每個峰值約 7 個回合）。 */
const GOOD_PRICE = (LOW + HIGH) / 2;

/** 第 g 種貨還沒到的回合裡，曲線在好價門檻以上的回合數。 */
function goodRoundsLeft(state: D6State, good: number): number {
  let n = 0;
  const row = state.base[good] as readonly number[];
  for (let t = state.round + 1; t < ROUNDS; t += 1) {
    if ((row[t] as number) >= GOOD_PRICE) {
      n += 1;
    }
  }
  return n;
}

/**
 * 賣不掉的風險（0 到 1）：存貨超過「還沒到的好價回合」能吸收的件數（每種貨各算，總數也不能超過剩下的回合數），
 * 加上對手手上同一種貨的擠壓。貪心型不看它；精準型排除超過 0.3 的動作（多一件賣不掉就排除）；賭徒型被它吸引。
 * 深度 ≥ 3 的評價已經用「一回合只能賣一件」把這件事算進 gain，所以 `result` 階段的 danger 是 0，不重複扣。
 */
function hoardDanger(state: D6State, side: Side, inv: readonly number[]): number {
  const oppInv = state.inv[otherSide(side)] as readonly number[];
  let total = 0;
  let weak = 0;
  let crowd = 0;
  for (let g = 0; g < GOODS; g += 1) {
    const mine = inv[g] as number;
    const room = goodRoundsLeft(state, g);
    total += mine;
    weak += Math.max(0, mine - room);
    if (mine > 0) {
      crowd = Math.max(crowd, (oppInv[g] as number) / (room + 1));
    }
  }
  weak += Math.max(0, total - weak - (ROUNDS - 1 - state.round));
  return clamp01(weak / 3 + crowd / 4);
}

/** 沒看到結算（choose、locked）：只剩反射式的評價，淺搜尋（深度 1、2）和三個一步看的性格只走到這裡。 */
function evaluateShallow(state: D6State, side: Side): { gain: number; danger: number } {
  const opp = otherSide(side);
  const mine = state.pending[side] ?? PASS;
  const mineValue = reflexValue(state, side, mine);
  const theirs =
    (state.cash[opp] as number) + markValue(state, state.inv[opp] as readonly number[]);
  const inv = applyToInventory(state.inv[side] as readonly number[], mine);
  return { gain: mineValue - theirs, danger: hoardDanger(state, side, inv) };
}

/**
 * 預測對手這一回合的動作分佈：歷史（`predictOpponent`）與「它大概做眼前最賺的反射式那一手」各占一半，
 * 非法的動作（沒存貨的賣、買不起的買）拿掉再正規化。只讀公開的資訊。
 */
function opponentDistribution(state: D6State, side: Side): number[] {
  const opp = otherSide(side);
  const habit = predictOpponent(state.history, side);
  const reflex = reflexTrade(state, opp);
  const dist = habit.map((p, t) => (1 - REFLEX_PRIOR) * p + (t === reflex ? REFLEX_PRIOR : 0));
  let total = 0;
  for (let t = 0; t < TRADES; t += 1) {
    if (!isLegal(state, opp, t)) {
      dist[t] = 0;
    }
    total += dist[t] as number;
  }
  return dist.map((p) => p / total);
}

/**
 * 看得到結算（result）：用「我的動作 ＋ 預測的對手」推出入帳之後的現金、存貨與下一回合起的偏移，
 * 再把兩邊的存貨按預期價格出清（一回合只能賣一件）。對手這回合真的做了什麼不讀（`pending[對手]`、`last` 的對手那一半）。
 */
function evaluateDeep(state: D6State, side: Side): { gain: number; danger: number } {
  const opp = otherSide(side);
  const mine = state.pending[side] ?? PASS;
  const r = state.round;
  const myInv = applyToInventory(state.inv[side] as readonly number[], mine);
  const myCash = (state.cash[side] as number) + cashChange(state, mine);
  const oppInv = state.inv[opp] as readonly number[];

  // 這回合各種貨的淨買賣：我的 ＋ 對手的期望（模型關掉就當對手不動）。
  const net = [0, 0, 0];
  if (isBuy(mine)) {
    net[goodOf(mine)] = 1;
  } else if (isSell(mine)) {
    net[goodOf(mine)] = -1;
  }
  const habit = [0, 0, 0];
  if (state.model) {
    const dist = opponentDistribution(state, side);
    for (let t = 1; t < TRADES; t += 1) {
      habit[goodOf(t)] = (habit[goodOf(t)] as number) + (isBuy(t) ? 1 : -1) * (dist[t] as number);
    }
    for (let g = 0; g < GOODS; g += 1) {
      net[g] = (net[g] as number) + (habit[g] as number);
    }
  }

  // 對手手上的存貨會在它的好價回合倒出來：預期的賣壓（公開的存貨，讀的是「它在囤什麼」）。
  const dump: number[][] = [[], [], []];
  if (state.model) {
    const flat = (g: number, t: number): number =>
      clampPrice((state.base[g] as readonly number[])[t] as number);
    // 用曲線（不看偏移）排出對手每一件貨最可能賣在哪個回合。
    for (const [g, t] of exitPlan(oppInv, r + 1, flat)) {
      dump[g]![t] = (dump[g]![t] ?? 0) + 1;
    }
  }

  // 預期偏移：d[t] 是第 t 回合的偏移。
  const dev: number[][] = [[], [], []];
  for (let g = 0; g < GOODS; g += 1) {
    let d = ((state.dev[g] as number) + state.impact * (net[g] as number)) / 2;
    for (let t = r + 1; t < ROUNDS; t += 1) {
      (dev[g] as number[])[t] = d;
      const future =
        (habit[g] as number) * HABIT_DECAY ** (t - r) - ((dump[g] as number[])[t] ?? 0);
      d = (d + state.impact * future) / 2;
    }
  }
  const price = (g: number, t: number): number =>
    clampPrice(
      ((state.base[g] as readonly number[])[t] as number) + ((dev[g] as number[])[t] as number),
    );

  const mineValue = myCash + exitValue(myInv, r + 1, price);
  // 對手的存貨價值只在讀對手的時候算（不讀就只管自己的現金與存貨）。
  const theirValue =
    (state.cash[opp] as number) + (state.model ? exitValue(oppInv, r + 1, price) : 0);
  return { gain: mineValue - theirValue, danger: 0 };
}

function evaluateD6(state: D6State, side: Side): { gain: number; danger: number } {
  const diff = (state.cash[side] as number) - (state.cash[otherSide(side)] as number);
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: diff + sign * END_BONUS, danger: 0 };
  }
  switch (state.phase) {
    case 'prep':
      return { gain: diff, danger: 0 };
    case 'choose':
    case 'locked':
      return evaluateShallow(state, side);
    case 'result':
      return evaluateDeep(state, side);
  }
}

export const d6Game: Game<D6State> = {
  id: 'D-6',

  init(seed: number, config: GameConfig): D6State {
    return makeState({
      maxTicks: config.maxTicks,
      base: curveFor(peaksFor(seed)),
      impact: config.params['impact'] ?? IMPACT,
      model: config.params['model'] !== 0,
    });
  },

  step(state: D6State, inputs: Inputs): D6State {
    return stepD6(state, inputs);
  },

  isOver(state: D6State): boolean {
    return state.over;
  },

  score(state: D6State): readonly [number, number] {
    return [state.cash[0], state.cash[1]];
  },

  winner(state: D6State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: D6State, side: Side): readonly Buttons[] {
    return actionsD6(state, side);
  },

  evaluate(state: D6State, side: Side): { gain: number; danger: number } {
    return evaluateD6(state, side);
  },
};
