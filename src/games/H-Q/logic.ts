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
 * H-Q 加碼（SPEC 第 9 節一行：「每回合賭注加倍的猜拳變體」；小規格 `docs/cards/H-Q.md`）。
 *
 * 兩邊同時出手：石頭、布、剪刀（可以加碼：按住 a 再出拳），或棄牌（不跟這回合的賭注）。
 * 賭注每回合加倍、上限 8，共 10 回合。只有一邊加碼時，另一邊在「回應期」看到加碼之後，可以跟或棄牌。
 * 這張牌驗證的路線：歷史存進 state，`evaluate` 用歷史做對手建模，通用性格只負責在 `actions` 之間挑；
 * AI 只在讀得準的時候加碼，是因為加碼要付費，而 `evaluate` 算出來只有讀得準才值得。
 */

/** 四種出手。0 石頭、1 布、2 剪刀、3 棄牌。贏 x 的那一手是 `(x + 1) % 3`。 */
export type Move = 0 | 1 | 2 | 3;
export const ROCK = 0 as const;
export const PAPER = 1 as const;
export const SCISSORS = 2 as const;
export const FOLD = 3 as const;

export const ROUNDS = 10;
export const CHIPS = 100;
/** 賭注每回合加倍，加到這個數為止。 */
export const MAX_STAKE = 8;
/** 兩邊都出手之後，鎖定幾個 tick 才開牌（看得到開牌需要的模擬深度：出手 1、鎖定 2、開牌 3）。 */
export const LOCK_TICKS = 2;
/**
 * 只有一邊加碼時，鎖定之後的回應期：先有幾個 tick 兩邊的輸入都被忽略（讓人看清楚「它加碼了」），
 * 之後沒加碼的那一邊才可以回應。要大於 3，模擬（最深 6 步）才不會走進「公開之後」的階段。
 */
export const RESPOND_PREP = 30;
/** 開牌之後停幾個 tick 才入帳、進下一回合。 */
export const RESULT_TICKS = 30;

/** 出手對應的按鍵：左石頭、上布、右剪刀、b 棄牌。 */
export const MOVE_BUTTONS: readonly Buttons[] = Object.freeze([
  Object.freeze({ ...IDLE, left: true }),
  Object.freeze({ ...IDLE, up: true }),
  Object.freeze({ ...IDLE, right: true }),
  Object.freeze({ ...IDLE, b: true }),
]);

/** 加碼的拳：按住 a 的同時出拳（同一個 tick 裡 a 與那個方向鍵都按著）。索引是 0 石頭、1 布、2 剪刀。 */
export const RAISE_BUTTONS: readonly Buttons[] = Object.freeze([
  Object.freeze({ ...IDLE, a: true, left: true }),
  Object.freeze({ ...IDLE, a: true, up: true }),
  Object.freeze({ ...IDLE, a: true, right: true }),
]);

/** 回應期的「跟」：按 a。回應期的「棄牌」是 b（`MOVE_BUTTONS[FOLD]`）。 */
export const CALL_BUTTONS: Buttons = Object.freeze({ ...IDLE, a: true });

export type HQPhase = 'prep' | 'choose' | 'locked' | 'respond' | 'result';
export type HQEvent = 'none' | 'lock' | 'raise' | 'open' | 'bank' | 'timeout';

/** 一回合開牌的結果。只在 `result` 階段存在，入帳之後進 `history`。 */
export interface HQLast {
  readonly moves: readonly [Move, Move];
  readonly delta: readonly [number, number];
  readonly timeout: readonly [boolean, boolean];
  /** 兩邊這回合有沒有加碼。 */
  readonly raised: readonly [boolean, boolean];
}

export interface HQState {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 現在第幾回合（0 到 ROUNDS − 1）。 */
  readonly round: number;
  /** 這回合的賭注。 */
  readonly stake: number;
  readonly phase: HQPhase;
  /** prep、locked、respond（準備期）、result 還剩幾個 tick。 */
  readonly wait: number;
  /** choose 階段、回應期（開了之後）已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  /** 兩邊這回合的出手（`null` 是還沒出手）。出手之後不能改。 */
  readonly pending: readonly [Move | null, Move | null];
  /** 兩邊這回合有沒有加碼（只有出拳才可能加碼；棄牌不算）。出手之後不能改。 */
  readonly raised: readonly [boolean, boolean];
  /**
   * 加碼是不是已經公開（回應期開了）。只給 `evaluate` 用：公開之前，往前模擬走到的 state 裡
   * 對手有沒有加碼是對手的祕密（模擬用真的 `step`，會經過 respond 階段），所以那時 `evaluate` 要當作沒看到。
   */
  readonly revealed: boolean;
  /** 兩邊是不是因為超時被自動棄牌。 */
  readonly timedOut: readonly [boolean, boolean];
  /** 已經入帳的籌碼。這回合開牌的結果在 `last`，要等 result 結束才入帳。 */
  readonly chips: readonly [number, number];
  readonly last: HQLast | null;
  /** 已經入帳的每一回合的出手，`[人, AI]`。最多 ROUNDS 筆。 */
  readonly history: readonly (readonly [Move, Move])[];
  /** 已經入帳的每一回合兩邊有沒有加碼，和 `history` 一一對應（畫面用，AI 不讀）。 */
  readonly raises: readonly (readonly [boolean, boolean])[];
  /** 每回合開始抽一次：給 `evaluate` 在沒有資訊時做平手的隨機選擇。 */
  readonly salt: number;
  readonly rng: RngState;
  readonly lastEvent: HQEvent;
  readonly eventTick: number;
}

const SALT_RANGE = 1_000_003;

/** 習慣的小加分：看不到開牌的淺搜尋只剩這個（剋對方上一手）。 */
const HABIT = 0.01;
/** 沒有資訊時平手的隨機：占賭注的比例（遠小於任何真正的期望值差）。 */
const JITTER_SCALE = 0.02;
/** 結束的局，勝負加成（比任何分差都大）。 */
const END_BONUS = 1000;

/** 對手建模的常數（小規格「對手建模」）。 */
const DECAY = 0.6;
const HIT = 1;
const MISS = -1;
const BASE_MASS = 0.5;

/** 這回合的賭注：每回合加倍，加到上限為止。 */
export function stakeFor(round: number): number {
  return Math.min(MAX_STAKE, 2 ** Math.max(0, round));
}

/** 沒看到對方加碼就棄牌（出手時按 b、或超時）：付一整個賭注。 */
export function foldCost(stake: number): number {
  return stake;
}

/**
 * 看到對方加碼之後棄牌（回應期按 b、或回應期超時）：付賭注的四分之三，進位（1、2、3、6）。
 * 加碼把賭注翻倍，但棄牌永遠只付「原本的賭注」的一部分，所以被讀死的時候棄牌比硬跟便宜得多。
 */
export function respondFoldCost(stake: number): number {
  return Math.ceil((stake * 3) / 4);
}

/** 加碼費：加碼的人付給對方，賭注的一半，進位（1、1、2、4）。不管輸贏、對方跟不跟都付。 */
export function raiseFee(stake: number): number {
  return Math.ceil(stake / 2);
}

/** 贏 `move`（石頭、布、剪刀）的那一手。 */
export function beats(move: 0 | 1 | 2): Move {
  return ((move + 1) % 3) as Move;
}

function isThrow(move: Move | null): move is 0 | 1 | 2 {
  return move !== null && move < 3;
}

interface Press {
  readonly move: Move;
  readonly raised: boolean;
}

/**
 * 一個 tick 的按鍵是哪個出手：棄牌（b）最優先（保守），其次左、上、右；a 與下沒有單獨的作用，
 * a 與拳同時按著就是加碼的拳（b 勝過 a，所以 a＋b 是棄牌，不算加碼）。
 */
function pressFromButtons(buttons: Buttons): Press | null {
  if (buttons.b) {
    return { move: FOLD, raised: false };
  }
  const move: Move | null = buttons.left
    ? ROCK
    : buttons.up
      ? PAPER
      : buttons.right
        ? SCISSORS
        : null;
  return move === null ? null : { move, raised: buttons.a };
}

/**
 * `mine` 對 `theirs` 這回合的籌碼變化（零和）。
 * 兩邊都出拳：贏輸的是 `stake × (1 + 加碼的人數)`，平手 0；一邊棄牌：棄牌的人付 `foldCost(stake)`；
 * 兩邊都棄牌：0。另外，每個加碼的人付 `raiseFee(stake)` 給對方（兩邊都加碼就互相抵銷）。
 */
function payoff(
  mine: Move,
  theirs: Move,
  stake: number,
  mineRaised: boolean,
  theirsRaised: boolean,
  revealed: boolean,
): number {
  const fee = (theirsRaised ? raiseFee(stake) : 0) - (mineRaised ? raiseFee(stake) : 0);
  // 回應期（加碼公開之後）棄牌付的比較少；沒看到加碼就棄牌是整個賭注。
  const cost = revealed ? respondFoldCost(stake) : foldCost(stake);
  if (mine === FOLD) {
    return fee + (theirs === FOLD ? 0 : -cost);
  }
  if (theirs === FOLD) {
    return fee + cost;
  }
  if (mine === theirs) {
    return fee;
  }
  const at = stake * (1 + (mineRaised ? 1 : 0) + (theirsRaised ? 1 : 0));
  return fee + (mine === beats(theirs as 0 | 1 | 2) ? at : -at);
}

const NOT_RAISED: readonly [boolean, boolean] = [false, false];

const RELEASED_FLAGS: readonly [boolean, boolean] = [false, false];

/** 測試用：從「第 0 回合、準備剛開始、籌碼各 100」出發，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<HQState> = {}): HQState {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    round: 0,
    stake: 1,
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    pending: [null, null],
    raised: NOT_RAISED,
    revealed: false,
    timedOut: RELEASED_FLAGS,
    chips: [CHIPS, CHIPS],
    last: null,
    history: [],
    raises: [],
    salt: 12345,
    rng: rngStateFor(0, 'salt'),
    lastEvent: 'none',
    eventTick: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 對手建模：只讀 history。evaluate 與畫面共用，所以畫面上看到的就是 AI 相信的。
// ---------------------------------------------------------------------------

export interface Prediction {
  /** 對手下一回合出 石頭、布、剪刀、棄牌 的機率，加起來是 1。 */
  readonly probs: readonly [number, number, number, number];
  /** 機率最高的那一手；沒有明顯規律（最高的不比平均高、或並列）時是 `null`。 */
  readonly top: Move | null;
}

/** 六個專家對「第 n + 1 回合對手出什麼」的點預測（只用前 n 回合）；沒有預測是 `null`。 */
function expertGuesses(mine: readonly Move[], theirs: readonly Move[], n: number): (Move | null)[] {
  const lastTheirs = theirs[n - 1] as Move;
  const lastMine = mine[n - 1] as Move;
  const counts = [0, 0, 0, 0];
  for (let t = 0; t < n; t += 1) {
    counts[theirs[t] as number] = (counts[theirs[t] as number] as number) + 1;
  }
  let mode: Move | null = null;
  let best = 0;
  let tied = false;
  for (let m = 0; m < 4; m += 1) {
    const c = counts[m] as number;
    if (c > best) {
      best = c;
      mode = m as Move;
      tied = false;
    } else if (c === best && c > 0) {
      tied = true;
    }
  }
  return [
    lastTheirs, // 重複
    isThrow(lastTheirs) ? beats(lastTheirs) : null, // 往上輪
    isThrow(lastTheirs) ? (((lastTheirs + 2) % 3) as Move) : null, // 往下輪
    isThrow(lastMine) ? beats(lastMine) : null, // 追我：對手剋我上一手
    isThrow(lastMine) ? lastMine : null, // 學我：對手抄我上一手
    tied ? null : mode, // 頻率
  ];
}

/**
 * 從歷史算「`side` 的對手」下一回合的出手分佈。
 * 六個專家各自對每一回合做預測，命中 +1、沒中 −1，越近的回合權重越大（每早一回合乘 0.6），負分當 0；
 * 分佈是「0.5 份均勻攤在三種拳上」加上「每個專家的分數放在它對下一回合預測的那一手」，再正規化。
 */
export function predictOpponent(
  history: readonly (readonly [Move, Move])[],
  side: Side,
): Prediction {
  const them = otherSide(side);
  const mine = history.map((pair) => pair[side]);
  const theirs = history.map((pair) => pair[them]);
  const n = history.length;
  const mass = [BASE_MASS / 3, BASE_MASS / 3, BASE_MASS / 3, 0];
  if (n > 0) {
    const scores = [0, 0, 0, 0, 0, 0];
    for (let t = 1; t < n; t += 1) {
      const guesses = expertGuesses(mine, theirs, t);
      const weight = DECAY ** (n - 1 - t);
      for (let j = 0; j < 6; j += 1) {
        const guess = guesses[j] ?? null;
        if (guess !== null) {
          scores[j] = (scores[j] as number) + weight * (guess === theirs[t] ? HIT : MISS);
        }
      }
    }
    const next = expertGuesses(mine, theirs, n);
    for (let j = 0; j < 6; j += 1) {
      const guess = next[j] ?? null;
      const score = Math.max(0, scores[j] as number);
      if (guess !== null && score > 0) {
        mass[guess] = (mass[guess] as number) + score;
      }
    }
  }
  const total = mass[0]! + mass[1]! + mass[2]! + mass[3]!;
  const probs: [number, number, number, number] = [
    (mass[0] as number) / total,
    (mass[1] as number) / total,
    (mass[2] as number) / total,
    (mass[3] as number) / total,
  ];
  let top: Move | null = null;
  let high = 1 / 3 + 1e-9;
  let tied = false;
  for (let m = 0; m < 4; m += 1) {
    const p = probs[m] as number;
    if (p > high) {
      high = p;
      top = m as Move;
      tied = false;
    } else if (top !== null && Math.abs(p - high) < 1e-12) {
      tied = true;
    }
  }
  return { probs, top: tied ? null : top };
}

/**
 * 這個 AI 對 `side` 的對手，到目前為止「事先預測有沒有中」的命中率（拉普拉斯平滑，從三分之一起算）。
 * 每一回合用「當時的歷史」算一次預測（和畫面下方那一排小格是同一件事），有把握（`top` 不是 `null`）
 * 的才算一次嘗試，`top` 等於對手真的出的拳才算中：`(中 + 1) / (嘗試 + 3)`。
 * `predictOpponent` 的機率只看歷史的形狀（幾個專家連中就很集中，亂出的歷史偶爾也會碰巧連中），
 * 命中率是「它在這個對手身上實際讀得多準」，`evaluate` 兩者取小，AI 才不會對亂出的人過度自信。
 */
export function readAccuracy(history: readonly (readonly [Move, Move])[], side: Side): number {
  const them = otherSide(side);
  let trials = 0;
  let hits = 0;
  for (let t = 1; t < history.length; t += 1) {
    const top = predictOpponent(history.slice(0, t), side).top;
    if (top !== null) {
      trials += 1;
      if (top === (history[t] as readonly [Move, Move])[them]) {
        hits += 1;
      }
    }
  }
  return (hits + 2 / 3) / (trials + 2);
}

/**
 * AI 實際採信的對手分佈：把 `predictOpponent` 的分佈往「三種拳各 1/3」收，收到
 * 「最高的那一手的機率 ＝ min(模型的機率, 實際命中率)」為止（命中率不高於 1/3 就完全不採信）。
 */
function trustedProbs(
  history: readonly (readonly [Move, Move])[],
  side: Side,
): readonly [number, number, number, number] {
  const { probs } = predictOpponent(history, side);
  const peak = Math.max(probs[0], probs[1], probs[2]);
  const spread = peak - 1 / 3;
  const weight = spread > 1e-9 ? clamp01((readAccuracy(history, side) - 1 / 3) / spread) : 0;
  const mix = (p: number, uniform: number): number => (1 - weight) * uniform + weight * p;
  return [mix(probs[0], 1 / 3), mix(probs[1], 1 / 3), mix(probs[2], 1 / 3), mix(probs[3], 0)];
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function drawSalt(rng: RngState): { salt: number; rng: RngState } {
  const [salt, next] = intFrom(rng, SALT_RANGE);
  return { salt, rng: next };
}

/** 開牌：算出這回合的結果，籌碼與歷史都還沒動。 */
function settle(state: HQState, tick: number): HQState {
  const moves = state.pending as readonly [Move, Move];
  const [r0, r1] = state.raised;
  const delta: readonly [number, number] = [
    payoff(moves[0], moves[1], state.stake, r0, r1, state.revealed),
    payoff(moves[1], moves[0], state.stake, r1, r0, state.revealed),
  ];
  return {
    ...state,
    phase: 'result',
    wait: RESULT_TICKS,
    last: { moves, delta, timeout: state.timedOut, raised: state.raised },
    lastEvent: 'open',
    eventTick: tick,
  };
}

/** 鎖定結束：只有一邊加碼、另一邊出了拳 → 進回應期；其他組合直接開牌。 */
function settleOrRespond(state: HQState, tick: number): HQState {
  const [p0, p1] = state.pending;
  const needsResponse = state.raised[0] !== state.raised[1] && isThrow(p0) && isThrow(p1);
  if (!needsResponse) {
    return settle(state, tick);
  }
  return {
    ...state,
    phase: 'respond',
    wait: RESPOND_PREP,
    idle: 0,
    revealed: false,
    lastEvent: 'raise',
    eventTick: tick,
  };
}

/** 入帳：籌碼加上開牌的結果、歷史加一筆。回合數加一，不換階段。 */
function bank(state: HQState): HQState {
  const last = state.last;
  if (last === null) {
    return state;
  }
  return {
    ...state,
    chips: [state.chips[0] + last.delta[0], state.chips[1] + last.delta[1]],
    history: [...state.history, [last.moves[0], last.moves[1]] as const],
    raises: [...state.raises, [last.raised[0], last.raised[1]] as const],
    round: state.round + 1,
    last: null,
  };
}

function finish(state: HQState): HQState {
  return { ...state, over: true, winner: winnerByTotals(state.chips) };
}

function nextRound(state: HQState, tick: number): HQState {
  const { salt, rng } = drawSalt(state.rng);
  return {
    ...state,
    stake: stakeFor(state.round),
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    pending: [null, null],
    raised: NOT_RAISED,
    revealed: false,
    timedOut: RELEASED_FLAGS,
    salt,
    rng,
    lastEvent: 'bank',
    eventTick: tick,
  };
}

function stepChoose(state: HQState, inputs: Inputs, tick: number): HQState {
  const timeout = state.idle + 1 >= DECISION_TIMEOUT;
  const pending: (Move | null)[] = [state.pending[0], state.pending[1]];
  const raised: [boolean, boolean] = [state.raised[0], state.raised[1]];
  const timedOut: [boolean, boolean] = [state.timedOut[0], state.timedOut[1]];
  for (const side of [0, 1] as const) {
    if (pending[side] !== null) {
      continue;
    }
    const pressed = pressFromButtons(inputs[side]);
    if (pressed !== null) {
      pending[side] = pressed.move;
      raised[side] = pressed.raised;
    } else if (timeout) {
      pending[side] = FOLD;
      timedOut[side] = true;
    }
  }
  const moved: HQState = {
    ...state,
    tick,
    pending: pending as [Move | null, Move | null],
    raised,
    timedOut,
    idle: state.idle + 1,
  };
  if (pending[0] !== null && pending[1] !== null) {
    return {
      ...moved,
      phase: 'locked',
      wait: LOCK_TICKS,
      lastEvent: timedOut[0] || timedOut[1] ? 'timeout' : 'lock',
      eventTick: tick,
    };
  }
  return moved;
}

/**
 * 回應期：先 `RESPOND_PREP` 個 tick 兩邊的輸入都被忽略（加碼公開之前），之後沒加碼的那一邊可以回應：
 * a 跟（照原本出的拳開牌）、b 棄牌（b 勝過 a）；超時（第 300 個 tick）還沒回應就自動棄牌。加碼的那一邊按什麼都沒用。
 */
function stepRespond(state: HQState, inputs: Inputs, tick: number): HQState {
  if (!state.revealed) {
    return state.wait <= 1
      ? { ...state, tick, wait: 0, idle: 0, revealed: true }
      : { ...state, tick, wait: state.wait - 1 };
  }
  const responder: Side = state.raised[0] ? 1 : 0;
  const buttons = inputs[responder];
  const timeout = state.idle + 1 >= DECISION_TIMEOUT;
  if (buttons.b || (timeout && !buttons.a)) {
    const pending: [Move | null, Move | null] = [state.pending[0], state.pending[1]];
    pending[responder] = FOLD;
    const timedOut: [boolean, boolean] = [state.timedOut[0], state.timedOut[1]];
    timedOut[responder] = !buttons.b;
    return settle({ ...state, tick, pending, timedOut }, tick);
  }
  if (buttons.a) {
    return settle({ ...state, tick }, tick);
  }
  return { ...state, tick, idle: state.idle + 1 };
}

function stepHQ(state: HQState, inputs: Inputs): HQState {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: HQState;

  if (state.phase === 'prep') {
    after =
      state.wait <= 1
        ? { ...state, tick, phase: 'choose', wait: 0, idle: 0 }
        : { ...state, tick, wait: state.wait - 1 };
  } else if (state.phase === 'choose') {
    after = stepChoose(state, inputs, tick);
  } else if (state.phase === 'locked') {
    after =
      state.wait <= 1
        ? settleOrRespond({ ...state, tick }, tick)
        : { ...state, tick, wait: state.wait - 1 };
  } else if (state.phase === 'respond') {
    after = stepRespond(state, inputs, tick);
  } else if (state.wait <= 1) {
    const banked = bank({ ...state, tick });
    after = banked.round >= ROUNDS ? finish(banked) : nextRound(banked, tick);
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
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);
/** 出手：石頭、布、剪刀、棄牌（石頭排第一，見小規格「等級 1」），再來是加碼的石頭、布、剪刀。 */
const CHOOSE_ACTIONS: readonly Buttons[] = Object.freeze([...MOVE_BUTTONS, ...RAISE_BUTTONS]);
const RESPOND_ACTIONS: readonly Buttons[] = Object.freeze([
  CALL_BUTTONS,
  MOVE_BUTTONS[FOLD] as Buttons,
]);

function actionsHQ(state: HQState, side: Side): readonly Buttons[] {
  if (state.over) {
    return ONLY_IDLE;
  }
  // 出手：只看自己有沒有出手，不看對手的 pending（不偷看）。
  if (state.phase === 'choose') {
    return state.pending[side] === null ? CHOOSE_ACTIONS : ONLY_IDLE;
  }
  // 回應期：加碼公開之後，沒加碼的那一邊才有得選（公開之前是祕密，所以兩邊都只有全放開）。
  if (state.phase === 'respond' && state.revealed && !state.raised[side]) {
    return RESPOND_ACTIONS;
  }
  return ONLY_IDLE;
}

/** 習慣：這一手是不是贏對方上一手（歷史裡最後一筆）。 */
function habitBonus(state: HQState, side: Side, mine: Move | null): number {
  const lastRound = state.history[state.history.length - 1];
  if (lastRound === undefined || mine === null) {
    return 0;
  }
  const theirLast = lastRound[otherSide(side)];
  return isThrow(theirLast) && mine === beats(theirLast) ? HABIT : 0;
}

/** 平手的隨機：由 salt、邊、出手雜湊出 [0, 1)，只在開牌階段用。 */
function jitterOf(salt: number, side: Side, move: Move): number {
  let h =
    Math.imul(salt | 0, 0x9e3779b1) ^
    Math.imul(side + 1, 0x85ebca6b) ^
    Math.imul(move + 1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function evaluateHQ(state: HQState, side: Side): { gain: number; danger: number } {
  const diff = state.chips[side] - state.chips[otherSide(side)];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: diff + sign * END_BONUS, danger: 0 };
  }
  switch (state.phase) {
    case 'prep':
      return { gain: diff, danger: 0 };
    case 'choose':
    case 'locked':
      // 只讀自己的 pending；淺搜尋（深度 1、2）只走到這裡，所以只剩習慣的小加分。
      return { gain: diff + habitBonus(state, side, state.pending[side]), danger: 0 };
    case 'respond':
    case 'result': {
      // 回應期與開牌：模擬走得到這裡（深度 3 以上）。對「對手真的出了什麼、這回合的結果」目盲：
      // 用還沒入帳的籌碼與歷史，只讀自己的出手與加碼，對手由歷史建模。
      // 對手有沒有加碼：公開之前（`revealed` 為 false）當作沒加碼；公開之後（回應期開了）才讀。
      const mine = state.last === null ? state.pending[side] : state.last.moves[side];
      if (mine === null) {
        return { gain: diff, danger: 0 };
      }
      const mineRaised = state.raised[side];
      const theirsRaised = state.revealed && state.raised[otherSide(side)];
      const probs = trustedProbs(state.history, side);
      // 對手加碼了就一定是出拳，不會是棄牌：把棄牌的機率拿掉重新正規化。
      const throwMass = probs[0] + probs[1] + probs[2];
      let expected = 0;
      for (let o = 0; o < 4; o += 1) {
        const p = theirsRaised
          ? o < 3
            ? (probs[o] as number) / throwMass
            : 0
          : (probs[o] as number);
        expected +=
          p * payoff(mine, o as Move, state.stake, mineRaised, theirsRaised, state.revealed);
      }
      const jitter = JITTER_SCALE * state.stake * jitterOf(state.salt, side, mine);
      return { gain: diff + expected + jitter, danger: 0 };
    }
  }
}

export const hQGame: Game<HQState> = {
  id: 'H-Q',

  init(seed: number, config: GameConfig): HQState {
    const { salt, rng } = drawSalt(rngStateFor(seed, 'salt'));
    return makeState({ maxTicks: config.maxTicks, salt, rng });
  },

  step(state: HQState, inputs: Inputs): HQState {
    return stepHQ(state, inputs);
  },

  isOver(state: HQState): boolean {
    return state.over;
  },

  score(state: HQState): readonly [number, number] {
    return [state.chips[0], state.chips[1]];
  },

  winner(state: HQState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: HQState, side: Side): readonly Buttons[] {
    return actionsHQ(state, side);
  },

  evaluate(state: HQState, side: Side): { gain: number; danger: number } {
    return evaluateHQ(state, side);
  },
};
