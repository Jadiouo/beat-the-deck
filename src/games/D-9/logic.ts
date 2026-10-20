import { intFrom, rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';

/**
 * D-9 擺放（SPEC 第 9 節的一行方向；小規格 `docs/cards/D-9.md`）。
 *
 * 每一輪兩邊同時各挑一個礦脈、擺一個採集器（挑好就鎖定，看不到對方挑哪個）；揭曉之後跑 240 tick，
 * 每 30 tick 每個採集器向它的礦脈抽 1 單位。礦脈存量有限、最多 2 個採集器；抽到的單位就是分數。
 *
 * 回合流程（沿用 H-Q、D-6 的作法）：prep → place（游標在礦脈之間跳，鎖定或超時）→ locked（2 tick）→
 * run（揭曉，跑 240 tick）→ 下一輪的 place；最後一輪跑完進 end，再 60 tick 結束。
 * 鎖定到揭曉只有 3 步，搜尋深度 ≥ 3 走得到 `run`（10.6 陷阱一）；`actions()[0]` 是「不擺」，會推進結算（陷阱二）。
 *
 * 同時出手：對方這一輪的 `sel`、`pending` 在揭曉之前是祕密。`evaluate`、`actions` 都只讀自己的鎖定與游標；
 * 揭曉之後的 `run` 階段，`evaluate` 讀的是「揭曉前」的公開局面（`last` 存的存量與已得分、加上更早輪的採集器），
 * 不讀這一輪揭曉出來的對手採集器，也不讀 run 裡抽了多少：模擬從 place 走進 run 時，對手真正的鎖定不能漏進評價。
 */

export const DEPOSITS = 10;
/** 預設的容量（`config.params.cap` 可給 1：獨佔，見小規格十）。 */
export const CAP = 2;
/** 預設：搶同一個空位不夠的礦脈時兩邊都作廢（`config.params.contest = 1`：優先權的一邊拿到）。 */
export const DEFAULT_CONTEST = 0;
export const STOCKS: readonly number[] = [6, 8, 8, 10, 10, 12, 12, 14, 16, 20];
export const JUMP_EVERY = 6;
/** place 最長多少 tick，超過的那一邊自動不擺。 */
export const PLACE_TIMEOUT = 180;
export const LOCK_TICKS = 2;
export const RUN_TICKS = 240;
export const DRAW_EVERY = 30;
export const PREP_TICKS = 60;
export const END_TICKS = 60;
export const MAX_ROUNDS = 8;
/** 預設輪數（SPEC 原文 5；老闆授權改 8，量測見小規格）。 */
export const DEFAULT_ROUNDS = 8;
/**
 * 對手收成的權重：0 ＝ 只算自己的期望收成（小規格原文：量到被「一直挑最肥」打 100%）；
 * 1 ＝ 算兩邊的差（零和，預設）。見小規格「我做的決定」。
 */
export const DEFAULT_ZS = 1;
/** `predictOpponent` 只看對手最近這麼多輪。 */
export const WINDOW = 4;
/** 先驗占幾次觀察：先驗是「名次 1 0.55、名次 2 0.30、其他 0.15」。 */
export const PRIOR_N = 2;

/** 沒擺（不擺或超時）。 */
export const PASS = -1;

const GRID_W = 32;
const GRID_H = 24;
const MIN_DISTANCE = 4;
const DRAWS_PER_ROUND = RUN_TICKS / DRAW_EVERY;

export const IDLE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});
export const KEY_LEFT: Buttons = Object.freeze({ ...IDLE, left: true });
export const KEY_RIGHT: Buttons = Object.freeze({ ...IDLE, right: true });
export const KEY_LOCK: Buttons = Object.freeze({ ...IDLE, a: true });
export const KEY_PASS: Buttons = Object.freeze({ ...IDLE, b: true });

export type D9Phase = 'prep' | 'place' | 'locked' | 'run' | 'end';

export interface Deposit {
  readonly cell: number;
  readonly stock: number;
}

export interface Coll {
  readonly dep: number;
  readonly owner: Side;
  readonly round: number;
}

/** 已經結束的一輪（公開）。`ranks` 是揭曉當時挑的礦脈的名次（1 最肥，0 是沒擺）。 */
export interface Round {
  readonly picks: readonly [number, number];
  readonly ranks: readonly [number, number];
  readonly voided: readonly [boolean, boolean];
  readonly gained: readonly [number, number];
}

/** 揭曉的結果，與揭曉前的公開局面（`evaluate` 在 run 階段讀這些，不讀揭曉之後的變化）。 */
export interface D9Last {
  readonly picks: readonly [number, number];
  readonly voided: readonly [boolean, boolean];
  readonly ranks: readonly [number, number];
  readonly drawn0: readonly [number, number];
  readonly stock0: readonly number[];
}

export interface D9State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  readonly rounds: number;
  /** 現在第幾輪（0 起算）。 */
  readonly round: number;
  readonly phase: D9Phase;
  /** prep、locked、end 還剩幾個 tick。 */
  readonly wait: number;
  /** place 已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  readonly deposits: readonly Deposit[];
  /** 已擺成的採集器（揭曉之後才加進來）。 */
  readonly coll: readonly Coll[];
  /** 游標：指著第幾個礦脈（依格子編號排好）。 */
  readonly sel: readonly [number, number];
  /** 跳的冷卻（還要幾個 tick 才能再跳）。 */
  readonly jump: readonly [number, number];
  /** 上一個 tick 按的方向（−1 左／上、1 右／下、0 沒按）：一次按下只跳一次。 */
  readonly dir: readonly [number, number];
  /** 這一輪鎖定的礦脈（`null` 還沒鎖定；`PASS` 不擺）。 */
  readonly pending: readonly [number | null, number | null];
  /** 累計抽到的單位數（就是分數）。 */
  readonly drawn: readonly [number, number];
  readonly last: D9Last | null;
  readonly history: readonly Round[];
  /** 對手收成的權重（`config.params.zs`，量測用）。 */
  readonly zs: number;
  /** 每個礦脈最多幾個採集器（`config.params.cap`；預設 2，1 ＝ 獨佔）。 */
  readonly cap: number;
  /** 搶同一個空位不夠的礦脈：0 ＝ 兩邊作廢；1 ＝ 優先權（第 r 輪在 r % 2 號邊）的一邊拿到。 */
  readonly contest: number;
  /** AI 的對手模型開關（消融用：`config.params.model = 0` 就不讀歷史，只用先驗）。 */
  readonly model: boolean;
}

export function otherSide(side: Side): Side {
  return side === 0 ? 1 : 0;
}

function winnerOf(drawn: readonly [number, number]): Side | null {
  return drawn[0] === drawn[1] ? null : drawn[0] > drawn[1] ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 建構
// ---------------------------------------------------------------------------

/** 測試用的礦脈位置（格子編號 ＝ y × 32 + x，已排好）。 */
const TEST_CELLS: readonly number[] = [
  [4, 4],
  [12, 4],
  [20, 4],
  [28, 4],
  [8, 12],
  [16, 12],
  [24, 12],
  [6, 19],
  [16, 19],
  [26, 19],
].map(([x, y]) => (y as number) * GRID_W + (x as number));

/** 測試用：準備期剛開始、10 個礦脈在固定位置、存量照 `STOCKS` 原順序、沒有採集器，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<D9State> = {}): D9State {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    rounds: DEFAULT_ROUNDS,
    round: 0,
    phase: 'prep',
    wait: PREP_TICKS,
    idle: 0,
    deposits: TEST_CELLS.map((cell, i) => ({ cell, stock: STOCKS[i] as number })),
    coll: [],
    sel: [0, 0],
    jump: [0, 0],
    dir: [0, 0],
    pending: [null, null],
    drawn: [0, 0],
    last: null,
    history: [],
    zs: DEFAULT_ZS,
    cap: CAP,
    contest: DEFAULT_CONTEST,
    model: true,
    ...overrides,
  };
}

function manhattan(a: number, b: number): number {
  return (
    Math.abs((a % GRID_W) - (b % GRID_W)) +
    Math.abs(Math.floor(a / GRID_W) - Math.floor(b / GRID_W))
  );
}

/** 10 個礦脈的位置：邊緣留 2 格、兩兩曼哈頓距離 ≥ 4；種子決定，排成格子編號由小到大。 */
function placeDeposits(seed: number): number[] {
  let state = rngStateFor(seed, 'deposits');
  const cells: number[] = [];
  for (let tries = 0; cells.length < DEPOSITS && tries < 5000; tries += 1) {
    const [x, afterX] = intFrom(state, GRID_W - 4);
    const [y, afterY] = intFrom(afterX, GRID_H - 4);
    state = afterY;
    const cell = (y + 2) * GRID_W + (x + 2);
    if (cells.every((c) => manhattan(c, cell) >= MIN_DISTANCE)) {
      cells.push(cell);
    }
  }
  // 5000 次內湊不滿（實際上不會發生）：用固定的位置補齊，仍然是確定的。
  for (const cell of TEST_CELLS) {
    if (cells.length >= DEPOSITS) {
      break;
    }
    if (!cells.includes(cell) && cells.every((c) => manhattan(c, cell) >= MIN_DISTANCE)) {
      cells.push(cell);
    }
  }
  return cells.sort((a, b) => a - b);
}

/** 把 `STOCKS` 洗牌（Fisher–Yates）。 */
function shuffledStocks(seed: number): number[] {
  let state = rngStateFor(seed, 'stocks');
  const out = [...STOCKS];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const [j, next] = intFrom(state, i + 1);
    state = next;
    const tmp = out[i] as number;
    out[i] = out[j] as number;
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 抽取（step 與 evaluate 共用同一套規則）
// ---------------------------------------------------------------------------

export interface Collector {
  readonly owner: Side;
  readonly round: number;
}

/** 依輪數由小到大分組（同一輪擺的一組）。 */
function groupByRound(collectors: readonly Collector[]): Collector[][] {
  const sorted = [...collectors].sort((a, b) => a.round - b.round);
  const groups: Collector[][] = [];
  for (const c of sorted) {
    const last = groups[groups.length - 1];
    if (last !== undefined && (last[0] as Collector).round === c.round) {
      last.push(c);
    } else {
      groups.push([c]);
    }
  }
  return groups;
}

/**
 * 存量 `stock` 的礦脈抽一次：存量夠，每個採集器各得 1；不夠，剩下的給比較早擺的，
 * 同一輪擺的對半、餘下的 1 單位作廢（存量清 0）。回傳每個人得到的單位數與新的存量。
 */
function drawOnce(
  stock: number,
  collectors: readonly Collector[],
): { readonly got: readonly [number, number]; readonly stock: number } {
  const got: [number, number] = [0, 0];
  if (stock <= 0 || collectors.length === 0) {
    return { got, stock: Math.max(0, stock) };
  }
  if (stock >= collectors.length) {
    for (const c of collectors) {
      got[c.owner] += 1;
    }
    return { got, stock: stock - collectors.length };
  }
  let left = stock;
  for (const group of groupByRound(collectors)) {
    if (left < group.length) {
      break; // 這一組分不了（兩個人分 1 單位）：作廢
    }
    for (const c of group) {
      got[c.owner] += 1;
    }
    left -= group.length;
  }
  return { got, stock: 0 };
}

/**
 * 閉式解：存量 `stock` 的礦脈、這些採集器，再抽 `horizon` 次，兩邊各得多少單位。
 * 和 `drawOnce` 重複 `horizon` 次完全一樣（測試逐一比對）；`evaluate` 用它，不模擬。
 */
export function projectDraws(
  stock: number,
  collectors: readonly Collector[],
  horizon: number,
): [number, number] {
  const out: [number, number] = [0, 0];
  const c = collectors.length;
  if (c === 0 || stock <= 0 || horizon <= 0) {
    return out;
  }
  const full = Math.floor(stock / c);
  const k = Math.min(full, horizon);
  for (const x of collectors) {
    out[x.owner] += k;
  }
  if (full >= horizon) {
    return out;
  }
  const part = drawOnce(stock - full * c, collectors).got;
  out[0] += part[0];
  out[1] += part[1];
  return out;
}

// ---------------------------------------------------------------------------
// 名次與對手建模（只讀公開資訊）
// ---------------------------------------------------------------------------

/** 「揭曉前的公開局面」：place、locked 是現在的 state；run 是揭曉前存下來的（見檔頭）。 */
interface View {
  readonly stocks: readonly number[];
  readonly coll: readonly Coll[];
  readonly drawn: readonly [number, number];
  readonly round: number;
  readonly rounds: number;
  readonly cap: number;
  readonly contest: number;
}

function viewOf(state: D9State): View {
  if (state.phase === 'run' && state.last !== null) {
    return {
      stocks: state.last.stock0,
      coll: state.coll.filter((c) => c.round < state.round),
      drawn: state.last.drawn0,
      round: state.round,
      rounds: state.rounds,
      cap: state.cap,
      contest: state.contest,
    };
  }
  return {
    stocks: state.deposits.map((d) => d.stock),
    coll: state.coll,
    drawn: state.drawn,
    round: state.round,
    rounds: state.rounds,
    cap: state.cap,
    contest: state.contest,
  };
}

function countAt(coll: readonly Coll[], dep: number): number {
  let n = 0;
  for (const c of coll) {
    if (c.dep === dep) {
      n += 1;
    }
  }
  return n;
}

/** 還能擺（有空位而且還有存量）的礦脈，依「剩餘價值 ÷（1 + 已有採集器）」由肥到瘦排，同分索引小的在前。 */
function liveOrder(view: View): number[] {
  const live: { dep: number; key: number }[] = [];
  for (let d = 0; d < DEPOSITS; d += 1) {
    const n = countAt(view.coll, d);
    const stock = view.stocks[d] as number;
    if (n < view.cap && stock > 0) {
      live.push({ dep: d, key: stock / (1 + n) });
    }
  }
  live.sort((a, b) => b.key - a.key || a.dep - b.dep);
  return live.map((x) => x.dep);
}

function ranksFromView(view: View): number[] {
  const order = liveOrder(view);
  const ranks = new Array<number>(DEPOSITS).fill(0);
  order.forEach((dep, i) => {
    ranks[dep] = i + 1;
  });
  // 不能擺的礦脈排在後面（依剩餘價值，同分索引小的在前）。
  const rest: { dep: number; key: number }[] = [];
  for (let d = 0; d < DEPOSITS; d += 1) {
    if (ranks[d] === 0) {
      rest.push({ dep: d, key: (view.stocks[d] as number) / (1 + countAt(view.coll, d)) });
    }
  }
  rest.sort((a, b) => b.key - a.key || a.dep - b.dep);
  rest.forEach((x, i) => {
    ranks[x.dep] = order.length + i + 1;
  });
  return ranks;
}

/** 每個礦脈的名次（1 ＝ 最肥）；不能擺的（滿了或沒存量）排在能擺的後面。 */
export function ranksOf(state: D9State): number[] {
  return ranksFromView(viewOf(state));
}

const PRIOR_SHARE: readonly [number, number, number] = [0.55, 0.3, 0.15];

function predictFrom(view: View, history: readonly Round[], model: boolean, side: Side): number[] {
  const q = new Array<number>(DEPOSITS).fill(0);
  const order = liveOrder(view);
  if (order.length === 0) {
    return q;
  }
  const w: [number, number, number] = [
    PRIOR_N * PRIOR_SHARE[0],
    PRIOR_N * PRIOR_SHARE[1],
    PRIOR_N * PRIOR_SHARE[2],
  ];
  if (model) {
    const opp = otherSide(side);
    const from = Math.max(0, history.length - WINDOW);
    for (let i = from; i < history.length; i += 1) {
      const rank = (history[i] as Round).ranks[opp];
      if (rank >= 1) {
        const k = Math.min(rank, 3) - 1;
        w[k] = (w[k] as number) + 1;
      }
    }
  }
  const others = order.length - 2;
  const total = w[0] + (order.length >= 2 ? w[1] : 0) + (others > 0 ? w[2] : 0);
  q[order[0] as number] = w[0] / total;
  if (order.length >= 2) {
    q[order[1] as number] = w[1] / total;
  }
  for (let i = 2; i < order.length; i += 1) {
    q[order[i] as number] = w[2] / total / others;
  }
  return q;
}

/**
 * `side` 的對手這一輪挑每個礦脈的機率（長度 `DEPOSITS`，加起來是 1；沒有礦脈能擺時全是 0）。
 * 最近 `WINDOW` 輪對手挑的名次（1、2、3 以上三類）加上先驗，再把「名次」用現在的名次映射到礦脈上。
 * 只讀公開紀錄，不讀任何鎖定或游標；沒有依等級分支。`model = false` 時不看歷史。
 */
export function predictOpponent(history: readonly Round[], state: D9State, side: Side): number[] {
  return predictFrom(viewOf(state), history, state.model, side);
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function dirOf(buttons: Buttons): number {
  const leftish = buttons.left || buttons.up;
  const rightish = buttons.right || buttons.down;
  if (leftish === rightish) {
    return 0;
  }
  return leftish ? -1 : 1;
}

function stepPlace(state: D9State, inputs: Inputs, tick: number): D9State {
  const timeout = state.idle + 1 >= PLACE_TIMEOUT;
  const pending: (number | null)[] = [state.pending[0], state.pending[1]];
  const sel: number[] = [state.sel[0], state.sel[1]];
  const jump: number[] = [state.jump[0], state.jump[1]];
  const dir: number[] = [state.dir[0], state.dir[1]];
  for (const side of [0, 1] as const) {
    if (pending[side] !== null) {
      continue;
    }
    const buttons = inputs[side];
    const both = buttons.a && buttons.b;
    if (buttons.a && !both) {
      pending[side] = sel[side] as number;
      continue;
    }
    if (buttons.b && !both) {
      pending[side] = PASS;
      continue;
    }
    const now = dirOf(buttons);
    if (now !== 0 && now !== dir[side] && jump[side] === 0) {
      sel[side] = ((((sel[side] as number) + now) % DEPOSITS) + DEPOSITS) % DEPOSITS;
      jump[side] = JUMP_EVERY - 1;
    } else {
      jump[side] = Math.max(0, (jump[side] as number) - 1);
    }
    dir[side] = now;
    if (timeout) {
      pending[side] = PASS;
    }
  }
  const moved: D9State = {
    ...state,
    tick,
    idle: state.idle + 1,
    sel: sel as unknown as readonly [number, number],
    jump: jump as unknown as readonly [number, number],
    dir: dir as unknown as readonly [number, number],
    pending: pending as unknown as readonly [number | null, number | null],
  };
  if (pending[0] !== null && pending[1] !== null) {
    return { ...moved, phase: 'locked', wait: LOCK_TICKS };
  }
  return moved;
}

/** 揭曉：兩邊的要求同時生效；`req > free` 的礦脈，這一輪對它的要求全部作廢（採集器不退還）。 */
function reveal(state: D9State): D9State {
  const picks = [state.pending[0] ?? PASS, state.pending[1] ?? PASS] as const;
  const ranks = ranksOf(state);
  const req = new Array<number>(DEPOSITS).fill(0);
  for (const p of picks) {
    if (p >= 0) {
      req[p] = (req[p] as number) + 1;
    }
  }
  const added: Coll[] = [];
  const voided: [boolean, boolean] = [false, false];
  for (const side of [0, 1] as const) {
    const p = picks[side];
    if (p < 0) {
      continue;
    }
    const free = state.cap - countAt(state.coll, p);
    const wanted = req[p] as number;
    // 搶同一個空位不夠的礦脈：contest = 1 時優先權（第 r 輪在 r % 2 號邊）的一邊拿到，其餘作廢。
    const wins = wanted <= free || (state.contest === 1 && free >= 1 && side === state.round % 2);
    if (wins) {
      added.push({ dep: p, owner: side, round: state.round });
    } else {
      voided[side] = true;
    }
  }
  return {
    ...state,
    phase: 'run',
    wait: RUN_TICKS,
    coll: [...state.coll, ...added],
    last: {
      picks: [picks[0], picks[1]],
      voided,
      ranks: [
        picks[0] < 0 ? 0 : (ranks[picks[0]] as number),
        picks[1] < 0 ? 0 : (ranks[picks[1]] as number),
      ],
      drawn0: [state.drawn[0], state.drawn[1]],
      stock0: state.deposits.map((d) => d.stock),
    },
  };
}

function drawAll(state: D9State): D9State {
  const drawn: [number, number] = [state.drawn[0], state.drawn[1]];
  const deposits = state.deposits.map((deposit, dep) => {
    const here = state.coll.filter((c) => c.dep === dep);
    const result = drawOnce(deposit.stock, here);
    drawn[0] += result.got[0];
    drawn[1] += result.got[1];
    return result.stock === deposit.stock ? deposit : { cell: deposit.cell, stock: result.stock };
  });
  return { ...state, deposits, drawn };
}

/** run 的最後一個 tick 之後：這一輪進歷史，下一輪的 place（或最後一輪之後的 end）。 */
function bank(state: D9State): D9State {
  const last = state.last;
  const picks: readonly [number, number] = last?.picks ?? [PASS, PASS];
  const entry: Round = {
    picks,
    ranks: last?.ranks ?? [0, 0],
    voided: last?.voided ?? [false, false],
    gained: [
      state.drawn[0] - (last?.drawn0[0] ?? state.drawn[0]),
      state.drawn[1] - (last?.drawn0[1] ?? state.drawn[1]),
    ],
  };
  const history = [...state.history, entry];
  const round = state.round + 1;
  if (round >= state.rounds) {
    return {
      ...state,
      history,
      round,
      phase: 'end',
      wait: END_TICKS,
      pending: [null, null],
      last: null,
    };
  }
  return {
    ...state,
    history,
    round,
    phase: 'place',
    wait: 0,
    idle: 0,
    jump: [0, 0],
    dir: [0, 0],
    pending: [null, null],
    last: null,
  };
}

function stepRun(state: D9State, tick: number): D9State {
  const wait = state.wait - 1;
  let next: D9State = { ...state, tick, wait };
  if ((RUN_TICKS - wait) % DRAW_EVERY === 0) {
    next = drawAll(next);
  }
  return wait <= 0 ? bank(next) : next;
}

function stepD9(state: D9State, inputs: Inputs): D9State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: D9State;
  switch (state.phase) {
    case 'prep':
      after =
        state.wait <= 1
          ? { ...state, tick, phase: 'place', wait: 0, idle: 0 }
          : { ...state, tick, wait: state.wait - 1 };
      break;
    case 'place':
      after = stepPlace(state, inputs, tick);
      break;
    case 'locked':
      after =
        state.wait <= 1 ? reveal({ ...state, tick }) : { ...state, tick, wait: state.wait - 1 };
      break;
    case 'run':
      after = stepRun(state, tick);
      break;
    case 'end':
      after =
        state.wait <= 1
          ? { ...state, tick, wait: 0, over: true, winner: winnerOf(state.drawn) }
          : { ...state, tick, wait: state.wait - 1 };
      break;
  }
  if (!after.over && tick >= state.maxTicks) {
    return { ...after, over: true, winner: winnerOf(after.drawn) };
  }
  return after;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);
const PLACE_KEYS: readonly Buttons[] = Object.freeze([
  KEY_PASS,
  IDLE,
  KEY_LEFT,
  KEY_RIGHT,
  KEY_LOCK,
]);

/**
 * place 而且自己還沒鎖定：[不擺, 全放開, 左, 右, 擺下]。不擺排第一：它一定合法、一定會推進結算
 * （模擬裡的對手做 `actions()[0]`，要會鎖定，不然 `step` 永遠走不到揭曉：10.6 陷阱二）；
 * 平手時寧可不擺（沒有東西值得擺的時候，不擺就是對的），所以排序和 `evaluate` 的平手偏好一致。
 * 只看自己的鎖定，不看對手的。
 */
function actionsD9(state: D9State, side: Side): readonly Buttons[] {
  if (state.over || state.phase !== 'place' || state.pending[side] !== null) {
    return ONLY_IDLE;
  }
  return PLACE_KEYS;
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/** 結束的局，勝負加成（比任何分差都大）。 */
const END_BONUS = 1000;
/** 游標每多跳一格的成本（單位：一單位收成）：只用來在「價值一樣」的礦脈之間選近的。 */
const JUMP_COST = 0.05;
/** 還沒鎖定的局面比「現在就鎖定同一個礦脈」差一點點：有目標就鎖定，不閒晃。 */
const UNLOCK_COST = 0.02;
/** danger 的安全線：和精準型的門檻（`PRECISE_DANGER_LIMIT`）一樣。 */
const SAFE_LIMIT = 0.3;

function ringDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, DEPOSITS - d);
}

interface Valuation {
  /** 已經抽到的差（我 − 對手）加上現有採集器往後的期望差（所有行動共用）。 */
  readonly base: number;
  /** 擺在礦脈 d 的價值（相對於不擺且對手照預測擺）。 */
  readonly lock: readonly number[];
  /** 不擺的價值。 */
  readonly pass: number;
  readonly danger: readonly number[];
}

/**
 * 價值（公開資訊，不讀對手的游標與鎖定）。把「對手這一輪挑哪個」當成機率 `q`，對每個礦脈 d：
 * 我擺在 d 的價值 ＝ (1 − q_d)·（我單獨擺在 d）＋ q_d·（兩邊都擺在 d；空位不夠就都作廢）＋ Σ_{j≠d} q_j·（對手擺在 j 對我的影響）。
 * 「收成」用 `projectDraws`（閉式解，不模擬）算往後所有輪的抽取：我的單位 − zs × 對手的單位。
 */
function valuate(
  view: View,
  history: readonly Round[],
  model: boolean,
  zs: number,
  side: Side,
): Valuation {
  const opp = otherSide(side);
  const q = predictFrom(view, history, model, side);
  const horizon = DRAWS_PER_ROUND * Math.max(0, view.rounds - view.round);
  const me: Collector = { owner: side, round: view.round };
  const them: Collector = { owner: opp, round: view.round };
  const net = (stock: number, set: readonly Collector[]): number => {
    const got = projectDraws(stock, set, horizon);
    return got[side] - zs * got[opp];
  };

  const free: number[] = [];
  const f0: number[] = [];
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  let base = view.drawn[side] - view.drawn[opp];
  let sb = 0;
  for (let d = 0; d < DEPOSITS; d += 1) {
    const stock = view.stocks[d] as number;
    const ex: Collector[] = view.coll.filter((x) => x.dep === d);
    free.push(view.cap - ex.length);
    const v0 = net(stock, ex);
    f0.push(v0);
    base += v0;
    a.push(free[d] >= 1 ? net(stock, [...ex, me]) - v0 : 0);
    b.push(free[d] >= 1 ? net(stock, [...ex, them]) - v0 : 0);
    if (free[d] >= 2) {
      c.push(net(stock, [...ex, me, them]) - v0);
    } else if (view.contest === 1 && free[d] >= 1) {
      // 搶最後一個空位：優先權（這一輪在 round % 2 號邊）的一邊拿到。
      c.push(view.round % 2 === side ? (a[d] as number) : (b[d] as number));
    } else {
      c.push(0);
    }
    sb += (q[d] as number) * (b[d] as number);
  }
  const lock: number[] = [];
  const danger: number[] = [];
  for (let d = 0; d < DEPOSITS; d += 1) {
    const qd = q[d] as number;
    lock.push((1 - qd) * (a[d] as number) + qd * (c[d] as number) + sb - qd * (b[d] as number));
    const dead = (free[d] as number) < 1 || (view.stocks[d] as number) <= 0;
    const safe = (free[d] as number) >= 2 || (view.contest === 1 && view.round % 2 === side);
    danger.push(dead ? 1 : safe ? 0 : qd);
  }
  return { base, lock, pass: sb, danger };
}

function evaluateD9(state: D9State, side: Side): { gain: number; danger: number } {
  const opp = otherSide(side);
  if (state.over) {
    const diff = (state.drawn[side] as number) - (state.drawn[opp] as number);
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: diff + sign * END_BONUS, danger: 0 };
  }
  if (state.phase === 'end') {
    return { gain: (state.drawn[side] as number) - (state.drawn[opp] as number), danger: 0 };
  }
  const view = viewOf(state);
  const v = valuate(view, state.history, state.model, state.zs, side);
  const mine = state.pending[side];
  if (mine === null && (state.phase === 'place' || state.phase === 'prep')) {
    // 還沒鎖定：價值是「從游標出發，走到最好的（又不太危險的）礦脈再擺」，每多跳一格扣一點點。
    const from = state.sel[side] as number;
    let best = -1;
    let bestValue = Number.NEGATIVE_INFINITY;
    let anySafe = false;
    for (let d = 0; d < DEPOSITS; d += 1) {
      if ((v.danger[d] as number) <= SAFE_LIMIT) {
        anySafe = true;
      }
    }
    for (let d = 0; d < DEPOSITS; d += 1) {
      if (anySafe && (v.danger[d] as number) > SAFE_LIMIT) {
        continue;
      }
      const value = (v.lock[d] as number) - JUMP_COST * ringDistance(from, d);
      if (value > bestValue) {
        best = d;
        bestValue = value;
      }
    }
    return { gain: v.base + bestValue - UNLOCK_COST, danger: v.danger[best] as number };
  }
  if (mine === null || mine < 0) {
    return { gain: v.base + v.pass, danger: 0 };
  }
  return { gain: v.base + (v.lock[mine] as number), danger: v.danger[mine] as number };
}

export const d9Game: Game<D9State> = {
  id: 'D-9',

  init(seed: number, config: GameConfig): D9State {
    const cells = placeDeposits(seed);
    const stocks = shuffledStocks(seed);
    const rounds = Math.min(
      MAX_ROUNDS,
      Math.max(1, Math.round(config.params['rounds'] ?? DEFAULT_ROUNDS)),
    );
    return makeState({
      maxTicks: config.maxTicks,
      rounds,
      deposits: cells.map((cell, i) => ({ cell, stock: stocks[i] as number })),
      zs: config.params['zs'] ?? DEFAULT_ZS,
      cap: Math.min(CAP, Math.max(1, Math.round(config.params['cap'] ?? CAP))),
      contest: Math.min(1, Math.max(0, Math.round(config.params['contest'] ?? DEFAULT_CONTEST))),
      model: config.params['model'] !== 0,
    });
  },

  step(state: D9State, inputs: Inputs): D9State {
    return stepD9(state, inputs);
  },

  isOver(state: D9State): boolean {
    return state.over;
  },

  score(state: D9State): readonly [number, number] {
    return [state.drawn[0], state.drawn[1]];
  },

  winner(state: D9State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: D9State, side: Side): readonly Buttons[] {
    return actionsD9(state, side);
  },

  evaluate(state: D9State, side: Side): { gain: number; danger: number } {
    return evaluateD9(state, side);
  },
};
