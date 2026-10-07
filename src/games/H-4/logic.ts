import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  AI_WAIT_TICKS,
  clamp01,
  DECISION_TIMEOUT,
  IDLE,
  otherSide,
  winnerByTotals,
} from '../_hearts/logic';

/**
 * H-4 比大小（小規格 `docs/cards/H-4.md`）。
 *
 * 兩個人輪流從「同一副有限的牌堆」猜下一張比桌上那張大還是小。救回這張牌的三個機制：
 * 1. 共用一副 26 張的牌堆，不洗回；公開的剩餘牌表（`counts`）讓「算機率」有真的資訊可算。
 * 2. 收手（或猜錯）時，桌上最後一張牌**蓋著**留給對方，只有留牌的人看得到；對方的第一猜是強迫的、對著看不見的牌猜。
 * 3. `stopBias`：AI 用公開紀錄（對方過去收手時桌上是什麼牌）估計「對方是不是在極端牌也收手」，
 *    決定要不要相信「收手 ＝ 桌上多半是中間牌」。玩家可以連續在極端牌收手騙它。
 *
 * 結算流程（等級曲線的來源，DESIGN-AI-FUN 5.1／9.5）：猜（`locked`，鎖定 2 個 tick）→ 第 3 步翻牌（`flip`）→ 入帳。
 * 搜尋型的 `depth` 只有 1 到 6 個 tick，所以深度 ≤ 2 只走到 `locked`（反射：只數牌、不推論蓋牌），
 * 深度 ≥ 3 走得到 `flip`（用後驗算猜中的機率）。收手是一個 tick 就生效，所以收手的後果在深度 1 就看得到——
 * 低等級 AI 因此很會「見好就收」、卻看不出繼續連的價值。
 *
 * 資訊限制：state 是完整資訊（含蓋著的 `table`、`turnCards`、翻出的 `flip`），
 * 但 `evaluate` 與 `actions` 只讀這一邊看得到的：
 * - `table` 只有在 `tableSeen[side]` 時才讀；
 * - 對方這個回合翻過的牌（`turnCards`）不讀（只讀公開的猜法與對錯）；
 * - `flip` 與 `rng`（下一張牌）永遠不讀。
 */

export const TARGET = 15;
export const CHAIN_PTS: readonly number[] = Object.freeze([0, 1, 3, 6, 10, 15, 21]);
/** 連對這麼多次自動收手。 */
export const MAX_CHAIN = 6;
export const MISS_PENALTY = 2;
/** 猜了之後鎖定幾個 tick 才翻牌（猜 1、鎖定第二步 2、第 3 步翻牌）。 */
export const LOCK_TICKS = 2;
/** 翻牌之後停幾個 tick 才入帳（讓人看清楚翻出什麼）。 */
export const RESULT_TICKS = 30;
export const RANK_COUNT = 13;
const COPIES = 2;

/** 極端牌：點數 ≤ 3 或 ≥ 11。 */
export const EXTREME_LOW = 3;
export const EXTREME_HIGH = 11;
/** stopBias 看最近幾次（已經公開了牌的）收手。 */
export const STOP_WINDOW = 4;
/** stopBias 的先驗：先驗比例 0.15、權重 2 次觀察（一次極端收手不足以讓 AI 改變看法，連續幾次才行）。 */
export const STOP_PRIOR = 0.15;
export const STOP_PRIOR_WEIGHT = 2;

/** 按鍵：↑ 猜大、↓ 猜小、b 收手。 */
export const UP: Buttons = Object.freeze({ ...IDLE, up: true });
export const DOWN: Buttons = Object.freeze({ ...IDLE, down: true });
export const STOP: Buttons = Object.freeze({ ...IDLE, b: true });

export type H4Phase = 'prep' | 'choose' | 'locked' | 'flip' | 'over';
/** 0 猜大、1 猜小。 */
export type Dir = 0 | 1;
export type H4Event = 'none' | 'guess' | 'flip' | 'hit' | 'miss' | 'stop' | 'timeout';

/**
 * 公開紀錄的一筆（不含點數）：誰、猜大／猜小／收手（0、1、2）、對錯、猜完之後的連對數。
 * `card` 只有收手或猜錯那一筆才有意義：那是留給對方的蓋牌，等對方的回合結束、牌公開之後才補上（之前是 0）。
 */
export interface H4Entry {
  readonly side: Side;
  readonly act: 0 | 1 | 2;
  readonly ok: boolean;
  readonly c: number;
  readonly card: number;
}

export interface H4State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 還沒公開的牌各點數的張數（牌堆＋桌上牌＋這個回合換下來的牌）。長度 13，索引是點數 − 1。入帳前不扣。 */
  readonly counts: readonly number[];
  /** 桌上牌（蓋著）。 */
  readonly table: number;
  /** 這一邊看過桌上牌嗎。 */
  readonly tableSeen: readonly [boolean, boolean];
  readonly turn: Side;
  /** 這個回合目前的連對數。 */
  readonly c: number;
  readonly totals: readonly [number, number];
  /** 這個回合換下來、還沒公開的牌（只有翻牌的人看得到；不含桌上牌）。 */
  readonly turnCards: readonly number[];
  readonly phase: H4Phase;
  readonly wait: number;
  readonly idle: number;
  readonly guess: Dir | null;
  /** 翻出來的牌：只在 `flip` 階段有值，入帳前不進任何 evaluate。 */
  readonly flip: number;
  readonly history: readonly H4Entry[];
  readonly rng: RngState;
  readonly lastEvent: H4Event;
  readonly eventTick: number;
}

/** 測試用：一個「準備剛開始」的局面，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<H4State> = {}): H4State {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    counts: Array.from({ length: RANK_COUNT }, () => COPIES),
    table: 7,
    tableSeen: [false, false],
    turn: 0,
    c: 0,
    totals: [0, 0],
    turnCards: [],
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    guess: null,
    flip: 0,
    history: [],
    rng: rngStateFor(0, 'deck'),
    lastEvent: 'none',
    eventTick: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 牌的算術
// ---------------------------------------------------------------------------

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total;
}

/** 點數 `t` 以上（不含）的張數。 */
function above(u: readonly number[], t: number): number {
  let total = 0;
  for (let r = t + 1; r <= RANK_COUNT; r += 1) {
    total += u[r - 1] as number;
  }
  return total;
}

/** 點數 `t` 以下（不含）的張數。 */
function below(u: readonly number[], t: number): number {
  let total = 0;
  for (let r = 1; r < t; r += 1) {
    total += u[r - 1] as number;
  }
  return total;
}

function normalized(values: readonly number[]): number[] {
  const total = sum(values);
  if (total <= 0) {
    return values.map(() => 1 / RANK_COUNT);
  }
  return values.map((v) => v / total);
}

function delta(rank: number): number[] {
  return Array.from({ length: RANK_COUNT }, (_, i) => (i === rank - 1 ? 1 : 0));
}

export function isExtreme(card: number): boolean {
  return card <= EXTREME_LOW || card >= EXTREME_HIGH;
}

/** 真的牌堆（只有規則用，不給 evaluate）：未公開的牌，扣掉桌上牌與這個回合換下來的牌。 */
export function deckOf(state: H4State): number[] {
  const deck = [...state.counts];
  for (const r of state.turnCards) {
    deck[r - 1] = (deck[r - 1] as number) - 1;
  }
  deck[state.table - 1] = (deck[state.table - 1] as number) - 1;
  return deck;
}

export function deckSize(state: H4State): number {
  return sum(deckOf(state));
}

/**
 * 這一邊「還沒看過」的牌（各點數的張數）：公開的未公開牌表，扣掉自己看過的——
 * 自己的回合：自己換下來的牌；看過桌上牌：桌上牌。對方的 turnCards 與沒看過的桌上牌不扣（讀不到）。
 * 看不到桌上牌時，結果包含那張蓋著的桌上牌。
 */
export function unseenCounts(state: H4State, side: Side): number[] {
  const u = [...state.counts];
  if (state.turn === side) {
    for (const r of state.turnCards) {
      u[r - 1] = (u[r - 1] as number) - 1;
    }
  }
  if (state.tableSeen[side]) {
    u[state.table - 1] = (u[state.table - 1] as number) - 1;
  }
  return u;
}

// ---------------------------------------------------------------------------
// 對方的收手紀錄：stopBias
// ---------------------------------------------------------------------------

/**
 * `side` 最近 `STOP_WINDOW` 次（牌已經公開了的）收手之中，收在極端牌的比例，加上先驗：
 * `(極端次數 + 0.15·2) / (次數 + 2)`。沒有紀錄是 0.15。
 * 只讀公開的 `history`；還蓋著的收手（`card === 0`）不算。
 */
export function stopBias(history: readonly H4Entry[], side: Side): number {
  let seen = 0;
  let extreme = 0;
  for (let i = history.length - 1; i >= 0 && seen < STOP_WINDOW; i -= 1) {
    const e = history[i] as H4Entry;
    if (e.side === side && e.act === 2 && e.card > 0) {
      seen += 1;
      extreme += isExtreme(e.card) ? 1 : 0;
    }
  }
  return (extreme + STOP_PRIOR * STOP_PRIOR_WEIGHT) / (seen + STOP_PRIOR_WEIGHT);
}

/** stopBias 換成「不再相信收手 ＝ 中間牌」的程度 β（0 到 1）：0.2 以下完全相信，0.6 以上完全不信。 */
function distrust(bias: number): number {
  return clamp01((bias - 0.2) / 0.4);
}

/** 完全相信「收手」時，收手的機率下限／上限的形狀：猜中機率越高越不會收手。 */
const STOP_SLOPE = 3;
const STOP_FLOOR = 0.05;
/** 完全不信時，收手與牌無關。 */
const STOP_FLAT = 0.5;
/** 完全相信時，對方在知道牌的時候選比較可能中的那一邊的機率。 */
const DIR_RIGHT = 0.85;
const DIR_WRONG = 0.15;

// ---------------------------------------------------------------------------
// 後驗：對蓋著的桌上牌
// ---------------------------------------------------------------------------

/**
 * 這一邊對「桌上那張牌」的後驗（長度 13，加起來是 1）。
 * - 看過桌上牌：就是那一張。
 * - 沒看過：先驗是還沒看過的牌（`unseenCounts`）；乘上對方上一個回合的公開猜法與對錯的似然
 *   （從起點牌——對方開始這個回合時桌上的牌，公開之後就知道——一路推：猜大猜對 → 新牌比舊牌大……）；
 *   最後如果對方是收手結束，再乘上「收手的人在這張牌上收手的機率」：
 *   相信對方會收手最佳停止時，收手 ＝ 中間牌；`stopBias` 高（對方常在極端牌收手）時，這項被攤平。
 */
export function tablePosterior(state: H4State, side: Side): number[] {
  if (state.tableSeen[side]) {
    return delta(state.table);
  }
  const u = unseenCounts(state, side);
  const prior = normalized(u);
  const them = otherSide(side);
  const history = state.history;
  let start = history.length;
  while (start > 0 && (history[start - 1] as H4Entry).side === them) {
    start -= 1;
  }
  if (start === history.length) {
    return prior;
  }
  const previous = start > 0 ? (history[start - 1] as H4Entry) : undefined;
  let dist = previous !== undefined && previous.card > 0 ? delta(previous.card) : prior;

  // 對方在每一張牌上「繼續還是收手」「猜哪邊」的似然：相信對方是照機率打的最佳停止時，
  // 收手 ＝ 中間牌（猜中把握低）、繼續 ＝ 極端牌、猜的那一邊 ＝ 比較可能中的那一邊。
  // `stopBias` 高（對方常在極端牌收手）時，這三項都被攤平：不再把對方的選擇當線索。
  const beta = distrust(stopBias(history, them));
  const total = sum(u);
  const n = total - 1;
  const stopAt = new Array<number>(RANK_COUNT).fill(STOP_FLAT);
  const dirAt: number[][] = [];
  let low = 0;
  for (let r = 1; r <= RANK_COUNT; r += 1) {
    const count = u[r - 1] as number;
    const high = total - low - count;
    const best = n > 0 ? Math.max(low, high) / n : 0;
    const rational = Math.max(STOP_FLOOR, Math.min(1, STOP_SLOPE * (1 - best)));
    stopAt[r - 1] = (1 - beta) * rational + beta * STOP_FLAT;
    const up = high > low ? DIR_RIGHT : high < low ? DIR_WRONG : 0.5;
    dirAt.push([(1 - beta) * up + beta * 0.5, (1 - beta) * (1 - up) + beta * 0.5]);
    low += count;
  }

  for (let i = start; i < history.length; i += 1) {
    const e = history[i] as H4Entry;
    const next = new Array<number>(RANK_COUNT).fill(0);
    if (e.act === 2) {
      for (let r = 1; r <= RANK_COUNT; r += 1) {
        next[r - 1] = (dist[r - 1] as number) * (stopAt[r - 1] as number);
      }
    } else {
      const here = new Array<number>(RANK_COUNT).fill(0);
      for (let r = 1; r <= RANK_COUNT; r += 1) {
        // 第一猜是對著看不見的起點牌猜的（沒有資訊）；之後每一猜都是在知道牌的時候「選了繼續、選了這一邊」
        here[r - 1] =
          i === start
            ? (dist[r - 1] as number)
            : (dist[r - 1] as number) *
              (1 - (stopAt[r - 1] as number)) *
              ((dirAt[r - 1] as number[])[e.act] as number);
      }
      let running = 0;
      if (e.ok) {
        // 猜對：新牌（翻出的）比舊牌大（猜大）或小（猜小）
        if (e.act === 0) {
          for (let r = 1; r <= RANK_COUNT; r += 1) {
            next[r - 1] = (u[r - 1] as number) * running;
            running += here[r - 1] as number;
          }
        } else {
          for (let r = RANK_COUNT; r >= 1; r -= 1) {
            next[r - 1] = (u[r - 1] as number) * running;
            running += here[r - 1] as number;
          }
        }
      } else if (e.act === 0) {
        // 猜錯：新牌（留在桌上的）不比舊牌大（猜大）或不比舊牌小（猜小）
        for (let r = RANK_COUNT; r >= 1; r -= 1) {
          running += here[r - 1] as number;
          next[r - 1] = (u[r - 1] as number) * running;
        }
      } else {
        for (let r = 1; r <= RANK_COUNT; r += 1) {
          running += here[r - 1] as number;
          next[r - 1] = (u[r - 1] as number) * running;
        }
      }
    }
    if (sum(next) <= 0) {
      return prior;
    }
    dist = normalized(next);
  }
  return dist;
}

function chance(u: readonly number[], post: readonly number[], hidden: boolean, dir: Dir): number {
  const total = sum(u);
  const n = hidden ? total - 1 : total;
  if (n <= 0) {
    return 0;
  }
  let p = 0;
  for (let t = 1; t <= RANK_COUNT; t += 1) {
    const w = post[t - 1] as number;
    if (w > 0) {
      p += w * (dir === 0 ? above(u, t) : below(u, t));
    }
  }
  return p / n;
}

/**
 * 這一邊猜 `dir`（0 猜大、1 猜小）猜中的機率（同點算猜錯）：對後驗取期望。
 * 翻出的牌從這一邊還沒看過的牌裡抽（看不到桌上牌時，桌上牌那一張要先拿掉）。
 */
export function winChance(state: H4State, side: Side, dir: Dir): number {
  const u = unseenCounts(state, side);
  const seen = state.tableSeen[side];
  return chance(u, tablePosterior(state, side), !seen, dir);
}

/** 粗略數牌的猜中機率：只看牌堆，不看對方的猜法與收手（反射用）。 */
export function crudeWinChance(state: H4State, side: Side, dir: Dir): number {
  const u = unseenCounts(state, side);
  const seen = state.tableSeen[side];
  const post = seen ? delta(state.table) : normalized(u);
  return chance(u, post, !seen, dir);
}

/** 兩個機率相差不到這個數就當一樣（浮點誤差不可以決定方向）。 */
const TIE = 1e-9;

/**
 * 猜哪一邊比較有機會（只數牌；一樣時猜大）。
 * 注意：看不到桌上牌時，桌上牌與翻出的牌來自同一堆牌（兩者可以交換），所以牌表再偏也是五五波；
 * 牌表的偏斜只在「看過桌上牌」（連對中）時有用。
 */
function habitDir(state: H4State, side: Side): Dir {
  return crudeWinChance(state, side, 0) >= crudeWinChance(state, side, 1) - TIE ? 0 : 1;
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function finish(state: H4State): H4State {
  return { ...state, over: true, winner: winnerByTotals(state.totals), phase: 'over' };
}

/** 把一個回合換下來的牌公開：counts 扣掉，並補上對方上一個回合最後那筆（蓋牌）的點數。 */
function publish(
  counts: readonly number[],
  history: readonly H4Entry[],
  turn: Side,
  cards: readonly number[],
): { counts: number[]; history: H4Entry[] } {
  const nextCounts = [...counts];
  for (const r of cards) {
    nextCounts[r - 1] = (nextCounts[r - 1] as number) - 1;
  }
  const nextHistory = [...history];
  const first = cards[0];
  if (first !== undefined) {
    for (let i = nextHistory.length - 1; i >= 0; i -= 1) {
      const e = nextHistory[i] as H4Entry;
      if (e.side !== turn) {
        if (e.card === 0 && (e.act === 2 || !e.ok)) {
          nextHistory[i] = { ...e, card: first };
        }
        break;
      }
    }
  }
  return { counts: nextCounts, history: nextHistory };
}

/** 收手：存分、這個回合換下來的牌公開、換對方（桌上牌蓋著留給對方）。一個 tick 就生效。 */
function stopTurn(state: H4State, tick: number, event: H4Event = 'stop'): H4State {
  const me = state.turn;
  const pts = CHAIN_PTS[state.c] as number;
  const totals: [number, number] = [state.totals[0], state.totals[1]];
  totals[me] += pts;
  const entry: H4Entry = { side: me, act: 2, ok: true, c: state.c, card: 0 };
  const published = publish(state.counts, state.history, me, state.turnCards);
  const after: H4State = {
    ...state,
    tick,
    counts: published.counts,
    history: [...published.history, entry],
    totals,
    turnCards: [],
    turn: otherSide(me),
    c: 0,
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    guess: null,
    flip: 0,
    lastEvent: event,
    eventTick: tick,
  };
  return totals[me] >= TARGET ? finish(after) : after;
}

/** 在 `choose` 階段：這一邊猜了（`dir`）。 */
function lockGuess(state: H4State, dir: Dir, tick: number, event: H4Event): H4State {
  return {
    ...state,
    tick,
    phase: 'locked',
    wait: LOCK_TICKS,
    guess: dir,
    idle: 0,
    lastEvent: event,
    eventTick: tick,
  };
}

function stepChoose(state: H4State, inputs: Inputs, tick: number): H4State {
  const me = state.turn;
  const buttons = inputs[me];
  const timeout = state.idle + 1 >= DECISION_TIMEOUT;
  if (buttons.b && state.c >= 1) {
    return stopTurn(state, tick);
  }
  if (buttons.up) {
    return lockGuess(state, 0, tick, 'guess');
  }
  if (buttons.down) {
    return lockGuess(state, 1, tick, 'guess');
  }
  if (timeout) {
    // 超時自動選保守的：有連對就收手；第一猜選未公開張數多的那一邊
    return state.c >= 1
      ? stopTurn(state, tick, 'timeout')
      : lockGuess(state, habitDir(state, me), tick, 'timeout');
  }
  return { ...state, tick, idle: state.idle + 1 };
}

/** 鎖定結束：從牌堆翻一張（只有猜的人看得到，入帳前不動任何帳）。 */
function drawFlip(state: H4State, tick: number): H4State {
  const deck = deckOf(state);
  const size = sum(deck);
  if (size <= 0) {
    return finish({ ...state, tick });
  }
  const [pick, rng] = intFrom(state.rng, size);
  let remaining = pick;
  let rank = 1;
  for (let r = 1; r <= RANK_COUNT; r += 1) {
    const n = deck[r - 1] as number;
    if (remaining < n) {
      rank = r;
      break;
    }
    remaining -= n;
  }
  return {
    ...state,
    tick,
    phase: 'flip',
    wait: RESULT_TICKS,
    flip: rank,
    rng,
    lastEvent: 'flip',
    eventTick: tick,
  };
}

/** 入帳：翻出的牌與桌上牌比，猜對連對加一（繼續）、猜錯扣分換人。 */
function bankFlip(state: H4State, tick: number): H4State {
  const me = state.turn;
  const dir = state.guess ?? 0;
  const flip = state.flip;
  const ok = dir === 0 ? flip > state.table : flip < state.table;
  const seen: [boolean, boolean] = me === 0 ? [true, false] : [false, true];
  if (ok) {
    const c = state.c + 1;
    const entry: H4Entry = { side: me, act: dir, ok: true, c, card: 0 };
    const hit: H4State = {
      ...state,
      tick,
      table: flip,
      tableSeen: seen,
      turnCards: [...state.turnCards, state.table],
      c,
      history: [...state.history, entry],
      phase: 'prep',
      wait: AI_WAIT_TICKS,
      idle: 0,
      guess: null,
      flip: 0,
      lastEvent: 'hit',
      eventTick: tick,
    };
    if (c >= MAX_CHAIN || deckSize(hit) <= 0) {
      // 連對滿了、或牌堆翻完：進行中的連對自動收手
      const totals: [number, number] = [hit.totals[0], hit.totals[1]];
      totals[me] += CHAIN_PTS[c] as number;
      return finish({ ...hit, totals, c: 0 });
    }
    return hit;
  }
  const cards = [...state.turnCards, state.table];
  const published = publish(state.counts, state.history, me, cards);
  const totals: [number, number] = [state.totals[0], state.totals[1]];
  totals[me] -= MISS_PENALTY;
  const entry: H4Entry = { side: me, act: dir, ok: false, c: 0, card: 0 };
  const missed: H4State = {
    ...state,
    tick,
    counts: published.counts,
    table: flip,
    tableSeen: seen,
    turnCards: [],
    totals,
    c: 0,
    turn: otherSide(me),
    history: [...published.history, entry],
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    guess: null,
    flip: 0,
    lastEvent: 'miss',
    eventTick: tick,
  };
  return deckSize(missed) <= 0 ? finish(missed) : missed;
}

function stepH4(state: H4State, inputs: Inputs): H4State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: H4State;
  switch (state.phase) {
    case 'prep':
      after =
        state.wait <= 1
          ? { ...state, tick, phase: 'choose', wait: 0, idle: 0 }
          : { ...state, tick, wait: state.wait - 1 };
      break;
    case 'choose':
      after = stepChoose(state, inputs, tick);
      break;
    case 'locked':
      after = state.wait <= 1 ? drawFlip(state, tick) : { ...state, tick, wait: state.wait - 1 };
      break;
    case 'flip':
      after = state.wait <= 1 ? bankFlip(state, tick) : { ...state, tick, wait: state.wait - 1 };
      break;
    default:
      return state;
  }
  if (!after.over && tick >= state.maxTicks) {
    // 時間到：比目前的總分，進行中的連對不算
    return finish(after);
  }
  return after;
}

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);
const FIRST_GUESS: readonly Buttons[] = Object.freeze([UP, DOWN]);
const CHAINING: readonly Buttons[] = Object.freeze([STOP, UP, DOWN]);

function actionsH4(state: H4State, side: Side): readonly Buttons[] {
  if (state.over || state.phase !== 'choose' || state.turn !== side) {
    return ONLY_IDLE;
  }
  return state.c >= 1 ? CHAINING : FIRST_GUESS;
}

/** 結束的局，勝負加成（比任何分差都大）。 */
const END_BONUS = 1000;
/** 反射：習慣的小加分（猜未公開張數多的那一邊）。 */
const HABIT = 0.01;
/** 反射：連對分只當一半。 */
const REFLEX_HALF = 0.5;
/** 對方的強迫第一猜：猜中時值多少（1 分加上一點繼續的選擇權）；猜錯扣 `MISS_PENALTY`。 */
const FORCED_HIT = 1.5;
/** 猜對之後手上有連對、桌上有張新的蓋牌：繼續下去的選擇權。 */
const HIT_OPTION = 0.3;
/** 對方（人）猜牌：兩邊「以為猜中的機率」差 1，猜大的機率變動這麼多（0.5 為中心，飽和在 0 與 1）。 */
const HUMAN_SLOPE = 4;
/** 猜對剛好贏下整場的價值（以分為單位）。 */
const WIN_VALUE = 12;

function forcedEV(p: number): number {
  return p * FORCED_HIT - (1 - p) * MISS_PENALTY;
}

/** 對方在完全沒資訊（五五波）的強迫第一猜的期望值。 */
const BASE_FORCED = forcedEV(0.5);

/**
 * 我（`me`）知道桌上牌 N、輪到對方、對方要對著蓋著的 N 做強迫的第一猜：對方的期望值。
 * 對方猜哪邊由「對方的後驗」決定（公開的猜法與對錯、收手紀錄、`stopBias`），猜中的機率是 N 的真實機率。
 * 所以我越能利用「你以為我留的是中間牌」，這個值越小。只在我看過桌上牌時才讀 `table`。
 */
function forcedValue(state: H4State, me: Side): number {
  if (!state.tableSeen[me]) {
    return BASE_FORCED;
  }
  const opp = otherSide(me);
  const believedUp = winChance(state, opp, 0);
  const believedDown = winChance(state, opp, 1);
  const u = unseenCounts(state, me);
  const total = sum(u);
  if (total <= 0) {
    return BASE_FORCED;
  }
  const t = state.table;
  const pUp = above(u, t) / total;
  const pDown = below(u, t) / total;
  // 對方猜哪一邊：把握越大越會猜對的那一邊；把握小（讀不出線索）就接近亂猜。
  const lean = clamp01(0.5 + HUMAN_SLOPE * (believedUp - believedDown));
  return lean * forcedEV(pUp) + (1 - lean) * forcedEV(pDown);
}

/** 輪到對方時，對我而言「對方這個回合」的價值（負的是對我好）。 */
function opponentValue(state: H4State, me: Side): number {
  if (state.c > 0) {
    return -(REFLEX_HALF * (CHAIN_PTS[state.c] as number));
  }
  return -forcedValue(state, me);
}

function hitValue(state: H4State, me: Side, c: number): number {
  const pts = CHAIN_PTS[Math.min(c, MAX_CHAIN)] as number;
  if (c >= MAX_CHAIN || state.totals[me] + pts >= TARGET) {
    return WIN_VALUE;
  }
  return pts + HIT_OPTION - BASE_FORCED;
}

const MISS_VALUE = -MISS_PENALTY - BASE_FORCED;

function guessValue(state: H4State, me: Side, dir: Dir): number {
  const p = winChance(state, me, dir);
  return p * hitValue(state, me, state.c + 1) + (1 - p) * MISS_VALUE;
}

/** 我的回合、還沒猜：能做的最好的事的價值（收手或猜大猜小）。 */
function myTurnValue(state: H4State, me: Side): number {
  let best = Math.max(guessValue(state, me, 0), guessValue(state, me, 1));
  if (state.c >= 1 && state.tableSeen[me]) {
    const after = stopTurn(state, state.tick);
    const gain = evaluateH4(after, me).gain;
    const diff = state.totals[me] - state.totals[otherSide(me)];
    best = Math.max(best, gain - diff);
  }
  return best;
}

function evaluateH4(state: H4State, me: Side): { gain: number; danger: number } {
  const them = otherSide(me);
  const diff = state.totals[me] - state.totals[them];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === me ? 1 : -1;
    return { gain: diff + sign * END_BONUS, danger: 0 };
  }
  if (state.turn !== me) {
    return { gain: diff + opponentValue(state, me), danger: 0 };
  }
  switch (state.phase) {
    case 'prep':
    case 'choose':
      return { gain: diff + myTurnValue(state, me), danger: 0 };
    case 'locked': {
      // 反射：粗略數牌，連對只當一半，見好就收；完全不用後驗。
      const dir: Dir = state.guess ?? 0;
      const held = CHAIN_PTS[state.c] as number;
      const habit = dir === habitDir(state, me) ? HABIT : 0;
      return {
        gain: diff + REFLEX_HALF * held + habit,
        danger: clamp01(1 - crudeWinChance(state, me, dir)),
      };
    }
    case 'flip': {
      // 不讀 flip、不讀入帳後的任何東西：猜中的機率用後驗與入帳前的牌表。
      const dir: Dir = state.guess ?? 0;
      const p = winChance(state, me, dir);
      return {
        gain: diff + p * hitValue(state, me, state.c + 1) + (1 - p) * MISS_VALUE,
        danger: clamp01(1 - p),
      };
    }
    default:
      return { gain: diff, danger: 0 };
  }
}

export const h4Game: Game<H4State> = {
  id: 'H-4',

  init(seed: number, config: GameConfig): H4State {
    const counts = Array.from({ length: RANK_COUNT }, () => COPIES);
    const [pick, afterTable] = intFrom(rngStateFor(seed, 'deck'), sum(counts));
    let remaining = pick;
    let table = 1;
    for (let r = 1; r <= RANK_COUNT; r += 1) {
      if (remaining < COPIES) {
        table = r;
        break;
      }
      remaining -= COPIES;
    }
    const [first] = intFrom(rngStateFor(seed, 'start'), 2);
    return makeState({
      maxTicks: config.maxTicks,
      counts,
      table,
      turn: first === 0 ? 0 : 1,
      rng: afterTable,
    });
  },

  step(state: H4State, inputs: Inputs): H4State {
    return stepH4(state, inputs);
  },

  isOver(state: H4State): boolean {
    return state.over;
  },

  score(state: H4State): readonly [number, number] {
    return [state.totals[0], state.totals[1]];
  },

  winner(state: H4State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: H4State, side: Side): readonly Buttons[] {
    return actionsH4(state, side);
  },

  evaluate(state: H4State, side: Side): { gain: number; danger: number } {
    return evaluateH4(state, side);
  },
};
