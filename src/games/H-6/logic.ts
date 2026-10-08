import { intFrom, rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  AI_WAIT_TICKS,
  DECISION_TIMEOUT,
  IDLE,
  PRESS_A,
  PRESS_B,
  otherSide,
  winnerByTotals,
} from '../_hearts/logic';

/**
 * H-6 地雷區（SPEC 第 9 節；小規格 `docs/cards/H-6.md`）。
 *
 * 兩個人在同一張暗雷圖（4 欄 × 6 排，第 r 排藏 ceil(r / 2) 顆雷）上同時選動作：往下一排的某一欄踏（← ↑ → ↓）、
 * 存分（a）、等（b）。踏上安全格：前進一排，這一排的獎勵（r 分）進手上的分；踏上雷：手上的分丟掉、回起點。
 * 踏過的格子與踩到的雷都公開，所以領頭的人替對方付學費。一排的獎勵只給「回合開始時還沒有人到過」的人全額，
 * 對手先到過的就只拿一半（向上取整）；同一回合同時到的兩人都拿全額。沒有前進也沒有存分的回合，手上的分少 1。
 *
 * 等級曲線從結算流程長出來（DESIGN-AI-FUN 5.1）：選擇 → 鎖定 2 tick → 第 3 步公開（resolve，入帳要再等 30 tick）。
 * 深度 1 到 2 走不到公開，`evaluate` 在 `locked` 以前只剩分差、手上的分與「反射」的小加分（不讀你）；
 * 深度 3 以上走得到 `resolve`，`evaluate` 用公開的 `known`、`claimed` 與對手最近 4 回合的動作紀錄算這回合的期望。
 * 雷圖 `mines`、對手這回合的 `pending`、這回合的結果 `last` 都在 state 裡，但 `evaluate`、`actions` 一律不讀。
 */

/** 動作：0 到 3 是欄（← ↑ → ↓），4 存分（a），5 等（b）。 */
export type Move = 0 | 1 | 2 | 3 | 4 | 5;
export const BANK = 4 as const;
export const WAIT = 5 as const;

/** 一回合的動作類型（公開，供讀對手用）：領頭 ＝ 踏上沒公開的格；跟隨 ＝ 踏上已公開的安全格。 */
export type Act = 'lead' | 'follow' | 'wait' | 'bank';

export const COLS = 4;
export const ROWS = 6;
export const ROUNDS = 12;
/** 等一回合手上的分少幾分（起始值；小規格寫「僵持太多就調成 2」）。 */
export const DECAY = 1;
/** 兩邊都選好之後，鎖定幾個 tick 才公開（選 1、鎖定 2、公開 3：深度 3 以上走得到公開）。 */
export const LOCK_TICKS = 2;
/** 公開之後停幾個 tick 才入帳。 */
export const RESULT_TICKS = 30;
/** 對手模型只看最近幾回合。 */
export const WINDOW = 4;
/** 反射規則的小加分（遠小於任何真正的期望值差）。 */
export const HABIT = 0.01;
/** 反射規則：手上的分達到這個數就存。 */
export const REFLEX_BANK = 5;

/** 公開之前的局面（準備、選擇、鎖定）的位置價值：手上的分算半價、每前進一排值 PROG_W。三個階段的動作只差反射的小加分。 */
export const CARRY_W = 0.5;
export const PROG_W = 0.4;

/** 同分的欄輪流挑的加分：遠小於任何真正的期望值差。 */
const TIE_BREAK = 1e-4;
const END_BONUS = 1000;
const CELLS = COLS * ROWS;

export type H6Phase = 'prep' | 'choose' | 'locked' | 'resolve';

/** 一邊這一回合發生的事（公開之後畫面要看；`evaluate` 不可以讀）。 */
export interface H6Event {
  readonly kind: 'safe' | 'mine' | 'bank' | 'wait';
  /** 踏的欄（存分與等是 −1）。 */
  readonly col: number;
  /** 這一步拿到的獎勵（安全格）。 */
  readonly reward: number;
  /** 踩雷丟掉的分。 */
  readonly lost: number;
  /** 存進總分的分。 */
  readonly banked: number;
}

export interface H6Last {
  readonly events: readonly [H6Event, H6Event];
}

export interface H6State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 現在第幾回合（0 到 ROUNDS − 1）。 */
  readonly round: number;
  readonly phase: H6Phase;
  /** prep、locked、resolve 還剩幾個 tick。 */
  readonly wait: number;
  /** choose 階段已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  /** 雷圖（第 r 排第 c 欄在 (r − 1) * COLS + c；1 是雷）。隱藏資訊。 */
  readonly mines: readonly number[];
  /** 公開的格子：0 不知道、1 安全、2 雷。 */
  readonly known: readonly number[];
  /** 每一排有哪一邊到過（安全地踏上去過）；公開。 */
  readonly claimed: readonly (readonly [boolean, boolean])[];
  /** 兩邊目前在第幾排（0 是起點）。 */
  readonly row: readonly [number, number];
  /** 兩邊手上還沒存的分。 */
  readonly carry: readonly [number, number];
  readonly totals: readonly [number, number];
  /** 這回合兩邊的選擇。對方的是隱藏資訊。 */
  readonly pending: readonly [Move | null, Move | null];
  /** 這回合的結果（公開之後、入帳之前）。 */
  readonly last: H6Last | null;
  /** 每個已經結束的回合兩邊的動作類型（公開）。 */
  readonly history: readonly (readonly [Act, Act])[];
  /** 「後到拿一半」規則（消融實驗用 `config.params.half = 0` 關掉）。 */
  readonly half: boolean;
  /** 等一回合手上的分少幾分（消融用 `config.params.decay = 0` 關掉）。 */
  readonly decay: number;
  /** 讀對手的模型開關（消融用 `config.params.model = 0` 關掉）。 */
  readonly model: boolean;
}

// ---------------------------------------------------------------------------
// 地圖
// ---------------------------------------------------------------------------

export function cellIndex(row: number, col: number): number {
  return (row - 1) * COLS + col;
}

export function minesInRow(row: number): number {
  return Math.ceil(row / 2);
}

/** 第 `row` 排的獎勵：先到（或同時到）拿 row；後到且「後到拿一半」規則開著，拿 ceil(row / 2)。 */
export function rewardOf(row: number, second: boolean, half = true): number {
  return second && half ? Math.ceil(row / 2) : row;
}

/** 測試用的固定雷圖：1：欄 0；2：欄 1；3：欄 0、3；4：欄 1、2；5：欄 0、1、2；6：欄 1、2、3。 */
export const DEFAULT_MINES: readonly number[] = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 0, 1, 1, 1,
]);

function layMines(seed: number): number[] {
  let rng = rngStateFor(seed, 'mines');
  const mines = new Array<number>(CELLS).fill(0);
  for (let row = 1; row <= ROWS; row += 1) {
    const cols = [0, 1, 2, 3];
    for (let k = 0; k < minesInRow(row); k += 1) {
      const [pick, next] = intFrom(rng, cols.length);
      rng = next;
      const col = cols[pick] as number;
      mines[cellIndex(row, col)] = 1;
      cols.splice(pick, 1);
    }
  }
  return mines;
}

// ---------------------------------------------------------------------------
// 公開資訊推出來的：安全率、對手領頭的比例
// ---------------------------------------------------------------------------

/**
 * 第 `row` 排第 `col` 欄的安全率：已知安全 1、已知雷 0；沒公開的格子用
 * 「(這排雷數 − 已公開的雷) / 這排還沒公開的格數」的補數。只讀 `known`，不讀 `mines`。
 */
export function safeProb(state: H6State, row: number, col: number): number {
  const known = state.known[cellIndex(row, col)] as number;
  if (known === 1) {
    return 1;
  }
  if (known === 2) {
    return 0;
  }
  let revealedMines = 0;
  let unknown = 0;
  for (let c = 0; c < COLS; c += 1) {
    const v = state.known[cellIndex(row, c)] as number;
    if (v === 2) {
      revealedMines += 1;
    } else if (v === 0) {
      unknown += 1;
    }
  }
  if (unknown <= 0) {
    return 0;
  }
  const mineRate = Math.min(1, Math.max(0, (minesInRow(row) - revealedMines) / unknown));
  return 1 - mineRate;
}

/** 對手（`who`）最近 WINDOW 回合領頭的比例：(領頭 + 1) / (回合 + 3)。模型關掉（消融）永遠是先驗 1/3。 */
export function leadRate(state: H6State, who: Side): number {
  if (!state.model) {
    return 1 / 3;
  }
  const recent = state.history.slice(-WINDOW);
  let leads = 0;
  for (const round of recent) {
    if (round[who] === 'lead') {
      leads += 1;
    }
  }
  return (leads + 1) / (recent.length + 3);
}

/** 畫面上「AI 對你的把握」：你的紀錄有幾回合，0 到 3 格。不說它認為你會不會領頭。 */
export function confidenceLevel(state: H6State, _side: Side): 0 | 1 | 2 | 3 {
  if (!state.model) {
    return 0;
  }
  const n = Math.min(3, state.history.length);
  return n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : 3;
}

/** `side` 現在可以踏的欄：不在最上排、不是已公開的雷。 */
export function legalCols(state: H6State, side: Side): number[] {
  const row = state.row[side];
  const cols: number[] = [];
  if (row >= ROWS) {
    return cols;
  }
  for (let c = 0; c < COLS; c += 1) {
    if (state.known[cellIndex(row + 1, c)] !== 2) {
      cols.push(c);
    }
  }
  return cols;
}

/** 反射：手上的分 ≥ 5 就存；否則往安全率最高的格走（同分取最左）；最上排只能存或等。不等、不讀對手。 */
export function reflexMove(state: H6State, side: Side): Move {
  const carry = state.carry[side];
  if (carry >= REFLEX_BANK) {
    return BANK;
  }
  const cols = legalCols(state, side);
  if (cols.length === 0) {
    return carry > 0 ? BANK : WAIT;
  }
  const row = state.row[side] + 1;
  let best = cols[0] as number;
  let bestP = safeProb(state, row, best);
  for (const c of cols) {
    const p = safeProb(state, row, c);
    if (p > bestP) {
      best = c;
      bestP = p;
    }
  }
  return best as Move;
}

// ---------------------------------------------------------------------------
// 這回合的期望（evaluate 在公開之後用）
// ---------------------------------------------------------------------------

/** 手上的分在動態規劃表裡的上限（超過的當作上限；獎勵加起來最多 21）。 */
const CARRY_MAX = 24;

/** 動態規劃用的前線：第 1 到 6 排各自「最好的一格」的安全率與我先踏上去的獎勵。索引 0 不用。 */
interface Frontier {
  readonly p: readonly number[];
  readonly reward: readonly number[];
}

/** 公開資訊算出來的前線：只讀 `known`、`claimed`、`half`。 */
function frontierOf(state: H6State, side: Side): Frontier {
  const opp = otherSide(side);
  const p: number[] = [0];
  const reward: number[] = [0];
  for (let row = 1; row <= ROWS; row += 1) {
    let best = 0;
    for (let c = 0; c < COLS; c += 1) {
      if (state.known[cellIndex(row, c)] !== 2) {
        best = Math.max(best, safeProb(state, row, c));
      }
    }
    p.push(best);
    reward.push(rewardOf(row, state.claimed[row - 1]?.[opp] === true, state.half));
  }
  return { p, reward };
}

/**
 * 單人的價值表 W[k][row][carry]：還剩 k 回合、在第 row 排、手上有 carry 分，之後最好的打法預期還能存進幾分
 * （最後一回合之後沒存的作廢）。每一回合三個選擇：存分、等（手上的分少 DECAY）、往前踏（安全率與獎勵取前線的值；
 * 踩雷回到起點、分歸零）。對手的行動只透過 `claimed`（後到只拿一半）與 `known` 進來。
 */
function valueTable(front: Frontier, decay: number, rounds: number): Float64Array {
  const stride = CARRY_MAX + 1;
  const table = new Float64Array((rounds + 1) * (ROWS + 1) * stride);
  const at = (k: number, row: number, carry: number): number =>
    table[(k * (ROWS + 1) + row) * stride + carry] as number;
  for (let k = 1; k <= rounds; k += 1) {
    for (let row = 0; row <= ROWS; row += 1) {
      for (let carry = 0; carry <= CARRY_MAX; carry += 1) {
        let best = at(k - 1, row, Math.max(0, carry - decay));
        if (carry > 0) {
          best = Math.max(best, carry + at(k - 1, row, 0));
        }
        if (row < ROWS) {
          const target = row + 1;
          const p = front.p[target] as number;
          const won = at(
            k - 1,
            target,
            Math.min(CARRY_MAX, carry + (front.reward[target] as number)),
          );
          best = Math.max(best, p * won + (1 - p) * at(k - 1, 0, 0));
        }
        table[(k * (ROWS + 1) + row) * stride + carry] = best;
      }
    }
  }
  return table;
}

/** 價值表只依賴公開的前線、規則與還剩幾回合，同一個 decide 裡會重複用到，所以記住最近一張。 */
let memoKey = '';
let memoTable: Float64Array = new Float64Array(0);

function tableFor(state: H6State, side: Side, front: Frontier, tag: string): Float64Array {
  const key = `${tag}|${side}|${state.round}|${state.decay}|${state.half ? 1 : 0}|${front.p.join(',')}|${front.reward.join(',')}`;
  if (key !== memoKey) {
    memoKey = key;
    memoTable = valueTable(front, state.decay, ROUNDS - state.round - 1);
  }
  return memoTable;
}

function lookup(table: Float64Array, k: number, row: number, carry: number): number {
  return table[
    (k * (ROWS + 1) + row) * (CARRY_MAX + 1) + Math.min(CARRY_MAX, Math.max(0, carry))
  ] as number;
}

/**
 * 等的資訊價值：對手跟我在同一排、而且它可能領頭 → 它有機會替我踩出一格安全的路（下一回合我跟隨，沒有風險，只是只拿一半）。
 * 機率 ＝ 它最近 4 回合領頭的比例 × 這排沒公開的格子的平均安全率。回傳那種情況下的前線，沒有這種可能時回傳 null。
 */
function informedFrontier(
  state: H6State,
  side: Side,
  front: Frontier,
): { front: Frontier; chance: number } | null {
  const opp = otherSide(side);
  const row = state.row[side];
  if (row >= ROWS || state.row[opp] !== row) {
    return null;
  }
  const target = row + 1;
  let open = 0;
  let pSum = 0;
  for (let c = 0; c < COLS; c += 1) {
    const v = state.known[cellIndex(target, c)] as number;
    if (v === 1) {
      return null;
    }
    if (v === 0) {
      open += 1;
      pSum += safeProb(state, target, c);
    }
  }
  if (open === 0) {
    return null;
  }
  const p = front.p.slice();
  const reward = front.reward.slice();
  p[target] = 1;
  reward[target] = rewardOf(target, true, state.half);
  return { front: { p, reward }, chance: leadRate(state, opp) * (pSum / open) };
}

/**
 * 我這回合選 `move` 的期望值（越大越好）：分差 ＋ 這回合存進的分 ＋ 之後單人最好的打法預期還能存幾分（`valueTable`）。
 * 踩雷用安全率（只讀 `known`）。對手同一排而且常領頭時，等的價值多一項：它替我踩出安全格的機率（`informedFrontier`）。
 * 只讀公開資訊與我自己的選擇：不讀 `mines`、對手的 `pending`、`last`。
 */
export function moveValue(state: H6State, side: Side, move: Move): number {
  const opp = otherSide(side);
  const diff = state.totals[side] - state.totals[opp];
  const carry = state.carry[side];
  const row = state.row[side];
  const k = ROUNDS - state.round - 1;
  const front = frontierOf(state, side);
  const table = tableFor(state, side, front, 'base');
  if (move === BANK && carry > 0) {
    return diff + carry + lookup(table, k, row, 0);
  }
  if (move < BANK && row < ROWS && state.known[cellIndex(row + 1, move)] !== 2) {
    const target = row + 1;
    const p = safeProb(state, target, move);
    const reward = front.reward[target] as number;
    // 同分的欄輪流挑（只看公開的回合與排數）：不然兩邊永遠都挑最左邊那一欄，踩同一格、同生同死。
    const rotate = ((move + state.round + row) % COLS) * TIE_BREAK;
    return (
      diff +
      p * lookup(table, k, target, carry + reward) +
      (1 - p) * lookup(table, k, 0, 0) +
      rotate
    );
  }
  const carryAfter = Math.max(0, carry - state.decay);
  const plain = lookup(table, k, row, carryAfter);
  const informed = informedFrontier(state, side, front);
  if (informed === null) {
    return diff + plain;
  }
  const better = lookup(tableFor(state, side, informed.front, `info${row}`), k, row, carryAfter);
  return diff + (1 - informed.chance) * plain + informed.chance * Math.max(plain, better);
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** 測試用：從「第 0 回合、準備剛開始、比分 0:0、兩邊在起點」出發，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<H6State> = {}): H6State {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    round: 0,
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    mines: DEFAULT_MINES,
    known: new Array<number>(CELLS).fill(0),
    claimed: new Array<readonly [boolean, boolean]>(ROWS).fill([false, false]),
    row: [0, 0],
    carry: [0, 0],
    totals: [0, 0],
    pending: [null, null],
    last: null,
    history: [],
    half: true,
    decay: DECAY,
    model: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

/** 按鍵 → 動作：b（等）優先，其次 a（存分，沒東西可存就不算），再來是方向（左、上、右、下；踏不了的不算）。 */
function moveFromButtons(state: H6State, side: Side, buttons: Buttons): Move | null {
  if (buttons.b) {
    return WAIT;
  }
  if (buttons.a && state.carry[side] > 0) {
    return BANK;
  }
  const legal = legalCols(state, side);
  const pressed: readonly boolean[] = [buttons.left, buttons.up, buttons.right, buttons.down];
  for (let c = 0; c < COLS; c += 1) {
    if (pressed[c] === true && legal.includes(c)) {
      return c as Move;
    }
  }
  return null;
}

function stepChoose(state: H6State, inputs: Inputs, tick: number): H6State {
  const timeout = state.idle + 1 >= DECISION_TIMEOUT;
  const pending: (Move | null)[] = [state.pending[0], state.pending[1]];
  for (const side of [0, 1] as const) {
    if (pending[side] === null) {
      const pressed = moveFromButtons(state, side, inputs[side]);
      if (pressed !== null) {
        pending[side] = pressed;
      } else if (timeout) {
        pending[side] = WAIT;
      }
    }
  }
  const moved: H6State = {
    ...state,
    tick,
    pending: pending as [Move | null, Move | null],
    idle: state.idle + 1,
  };
  if (pending[0] !== null && pending[1] !== null) {
    return { ...moved, phase: 'locked', wait: LOCK_TICKS };
  }
  return moved;
}

interface Resolved {
  readonly row: [number, number];
  readonly carry: [number, number];
  readonly totals: [number, number];
  readonly known: number[];
  readonly claimed: [boolean, boolean][];
  readonly acts: [Act, Act];
  readonly events: [H6Event, H6Event];
}

/** 兩邊的選擇套用到真實的雷圖上。先到與否看的是回合開始時的 `claimed`，所以同一回合同時到的兩人都拿全額。 */
function resolveRound(state: H6State): Resolved {
  const row: [number, number] = [state.row[0], state.row[1]];
  const carry: [number, number] = [state.carry[0], state.carry[1]];
  const totals: [number, number] = [state.totals[0], state.totals[1]];
  const known = state.known.slice();
  const claimed = state.claimed.map((c) => [c[0], c[1]] as [boolean, boolean]);
  const acts: [Act, Act] = ['wait', 'wait'];
  const events: [H6Event, H6Event] = [
    { kind: 'wait', col: -1, reward: 0, lost: 0, banked: 0 },
    { kind: 'wait', col: -1, reward: 0, lost: 0, banked: 0 },
  ];
  for (const side of [0, 1] as const) {
    const move = state.pending[side] ?? WAIT;
    if (move === BANK && state.carry[side] > 0) {
      acts[side] = 'bank';
      events[side] = { kind: 'bank', col: -1, reward: 0, lost: 0, banked: state.carry[side] };
      totals[side] += state.carry[side];
      carry[side] = 0;
    } else if (move < BANK && state.row[side] < ROWS) {
      const target = state.row[side] + 1;
      const idx = cellIndex(target, move);
      acts[side] = state.known[idx] === 1 ? 'follow' : 'lead';
      if (state.mines[idx] === 1) {
        events[side] = { kind: 'mine', col: move, reward: 0, lost: state.carry[side], banked: 0 };
        known[idx] = 2;
        row[side] = 0;
        carry[side] = 0;
      } else {
        const second = state.claimed[target - 1]?.[otherSide(side)] === true;
        const reward = rewardOf(target, second, state.half);
        events[side] = { kind: 'safe', col: move, reward, lost: 0, banked: 0 };
        known[idx] = 1;
        row[side] = target;
        carry[side] = state.carry[side] + reward;
        (claimed[target - 1] as [boolean, boolean])[side] = true;
      }
    } else {
      carry[side] = Math.max(0, state.carry[side] - state.decay);
    }
  }
  return { row, carry, totals, known, claimed, acts, events };
}

/** 第 3 步：公開兩邊的選擇與結果（寫進 last），入帳要再等 RESULT_TICKS。row、carry、known 這時還沒動。 */
function reveal(state: H6State): H6State {
  const resolved = resolveRound(state);
  return { ...state, phase: 'resolve', wait: RESULT_TICKS, last: { events: resolved.events } };
}

/** 入帳：套用這回合的結果、history 寫進這回合的動作類型、round + 1。還沒決定是下一回合還是結束。 */
function bankRound(state: H6State): H6State {
  const resolved = resolveRound(state);
  return {
    ...state,
    row: resolved.row,
    carry: resolved.carry,
    totals: resolved.totals,
    known: resolved.known,
    claimed: resolved.claimed,
    history: [...state.history, resolved.acts],
    round: state.round + 1,
    pending: [null, null],
    last: null,
  };
}

function finish(state: H6State): H6State {
  return { ...state, over: true, winner: winnerByTotals(state.totals) };
}

function nextRound(state: H6State): H6State {
  return { ...state, phase: 'prep', wait: AI_WAIT_TICKS, idle: 0 };
}

function stepH6(state: H6State, inputs: Inputs): H6State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: H6State;

  if (state.phase === 'prep') {
    after =
      state.wait <= 1
        ? { ...state, tick, phase: 'choose', wait: 0, idle: 0 }
        : { ...state, tick, wait: state.wait - 1 };
  } else if (state.phase === 'choose') {
    after = stepChoose(state, inputs, tick);
  } else if (state.phase === 'locked') {
    after = state.wait <= 1 ? reveal({ ...state, tick }) : { ...state, tick, wait: state.wait - 1 };
  } else if (state.wait <= 1) {
    const banked = bankRound({ ...state, tick });
    after = banked.round >= ROUNDS ? finish(banked) : nextRound(banked);
  } else {
    after = { ...state, tick, wait: state.wait - 1 };
  }

  if (!after.over && tick >= state.maxTicks) {
    // 時間到：已經公開的回合先入帳；還在 choose、locked 的這回合不算。
    return finish(after.phase === 'resolve' ? bankRound(after) : after);
  }
  return after;
}

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);
const COL_BUTTONS: readonly Buttons[] = Object.freeze([
  Object.freeze({ ...IDLE, left: true }),
  Object.freeze({ ...IDLE, up: true }),
  Object.freeze({ ...IDLE, right: true }),
  Object.freeze({ ...IDLE, down: true }),
]);

function phi(diff: number, carry: number, row: number): number {
  return diff + CARRY_W * carry + PROG_W * row;
}

function actionsH6(state: H6State, side: Side): readonly Buttons[] {
  // 只看自己有沒有選、自己的位置與公開的 known，不看對手的 pending，也不看 mines。
  if (state.over || state.phase !== 'choose' || state.pending[side] !== null) {
    return ONLY_IDLE;
  }
  // 等（b）排第一：搜尋時模擬的對手按第一個，它是會推進結算的動作。
  const list: Buttons[] = [PRESS_B];
  for (const c of legalCols(state, side)) {
    list.push(COL_BUTTONS[c] as Buttons);
  }
  if (state.carry[side] > 0) {
    list.push(PRESS_A);
  }
  return list;
}

function habitBonus(state: H6State, side: Side): number {
  const mine = state.pending[side];
  if (mine === null) {
    return 0;
  }
  return mine === reflexMove(state, side) ? HABIT : 0;
}

function evaluateH6(state: H6State, side: Side): { gain: number; danger: number } {
  const diff = state.totals[side] - state.totals[otherSide(side)];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: diff + sign * END_BONUS, danger: 0 };
  }
  switch (state.phase) {
    case 'prep':
      return { gain: phi(diff, state.carry[side], state.row[side]), danger: 0 };
    case 'choose':
    case 'locked':
      // 淺搜尋（深度 1、2）只走到這裡：不讀對手，只剩反射的小加分。
      return {
        gain: phi(diff, state.carry[side], state.row[side]) + habitBonus(state, side),
        danger: 0,
      };
    case 'resolve': {
      // 深度 3 以上走得到這裡。對「對手真的選了什麼、雷在哪裡、這回合的結果」目盲：
      // 不讀對手的 pending、不讀 mines、不讀 last。
      const move = state.pending[side] ?? WAIT;
      return { gain: moveValue(state, side, move), danger: 0 };
    }
  }
}

export const h6Game: Game<H6State> = {
  id: 'H-6',

  init(seed: number, config: GameConfig): H6State {
    const params = config.params;
    const decay = params['decay'];
    return makeState({
      maxTicks: config.maxTicks,
      mines: layMines(seed),
      half: params['half'] !== 0,
      decay: decay === undefined ? DECAY : decay,
      model: params['model'] !== 0,
    });
  },

  step(state: H6State, inputs: Inputs): H6State {
    return stepH6(state, inputs);
  },

  isOver(state: H6State): boolean {
    return state.over;
  },

  score(state: H6State): readonly [number, number] {
    return [state.totals[0], state.totals[1]];
  },

  winner(state: H6State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: H6State, side: Side): readonly Buttons[] {
    return actionsH6(state, side);
  },

  evaluate(state: H6State, side: Side): { gain: number; danger: number } {
    return evaluateH6(state, side);
  },
};
