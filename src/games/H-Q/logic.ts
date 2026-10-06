import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { AI_WAIT_TICKS, DECISION_TIMEOUT, IDLE, otherSide, winnerByTotals } from '../_hearts/logic';

/**
 * H-Q 加碼（SPEC 第 9 節一行：「每回合賭注加倍的猜拳變體」；小規格 `docs/cards/H-Q.md`）。
 *
 * 兩邊同時出手：石頭、布、剪刀，或棄牌（不跟這回合的賭注，付四分之三）。賭注每回合加倍、上限 8，共 10 回合。
 * 這張牌驗證的路線：歷史存進 state，`evaluate` 用歷史做對手建模，通用性格只負責在 `actions` 之間挑。
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
/** 開牌之後停幾個 tick 才入帳、進下一回合。 */
export const RESULT_TICKS = 30;

/** 出手對應的按鍵：左石頭、上布、右剪刀、b 棄牌。 */
export const MOVE_BUTTONS: readonly Buttons[] = Object.freeze([
  Object.freeze({ ...IDLE, left: true }),
  Object.freeze({ ...IDLE, up: true }),
  Object.freeze({ ...IDLE, right: true }),
  Object.freeze({ ...IDLE, b: true }),
]);

export type HQPhase = 'prep' | 'choose' | 'locked' | 'result';
export type HQEvent = 'none' | 'lock' | 'open' | 'bank' | 'timeout';

/** 一回合開牌的結果。只在 `result` 階段存在，入帳之後進 `history`。 */
export interface HQLast {
  readonly moves: readonly [Move, Move];
  readonly delta: readonly [number, number];
  readonly timeout: readonly [boolean, boolean];
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
  /** prep、locked、result 還剩幾個 tick。 */
  readonly wait: number;
  /** choose 階段已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  /** 兩邊這回合的出手（`null` 是還沒出手）。出手之後不能改。 */
  readonly pending: readonly [Move | null, Move | null];
  /** 兩邊是不是因為超時被自動棄牌。 */
  readonly timedOut: readonly [boolean, boolean];
  /** 已經入帳的籌碼。這回合開牌的結果在 `last`，要等 result 結束才入帳。 */
  readonly chips: readonly [number, number];
  readonly last: HQLast | null;
  /** 已經入帳的每一回合的出手，`[人, AI]`。最多 ROUNDS 筆。 */
  readonly history: readonly (readonly [Move, Move])[];
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

/** 棄牌付給對方的籌碼：賭注的四分之三，進位（1、2、3、6）。 */
export function foldCost(stake: number): number {
  return Math.ceil((stake * 3) / 4);
}

/** 贏 `move`（石頭、布、剪刀）的那一手。 */
export function beats(move: 0 | 1 | 2): Move {
  return ((move + 1) % 3) as Move;
}

function isThrow(move: Move | null): move is 0 | 1 | 2 {
  return move !== null && move < 3;
}

/** 一個 tick 的按鍵是哪個出手：棄牌最優先（保守），其次左、上、右；a 與下沒有作用。 */
function moveFromButtons(buttons: Buttons): Move | null {
  if (buttons.b) {
    return FOLD;
  }
  if (buttons.left) {
    return ROCK;
  }
  if (buttons.up) {
    return PAPER;
  }
  if (buttons.right) {
    return SCISSORS;
  }
  return null;
}

/** `mine` 對 `theirs` 這回合的籌碼變化（零和）。 */
function payoff(mine: Move, theirs: Move, stake: number): number {
  const cost = foldCost(stake);
  if (mine === FOLD) {
    return theirs === FOLD ? 0 : -cost;
  }
  if (theirs === FOLD) {
    return cost;
  }
  if (mine === theirs) {
    return 0;
  }
  return mine === beats(theirs as 0 | 1 | 2) ? stake : -stake;
}

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
    timedOut: RELEASED_FLAGS,
    chips: [CHIPS, CHIPS],
    last: null,
    history: [],
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
  const delta: readonly [number, number] = [
    payoff(moves[0], moves[1], state.stake),
    payoff(moves[1], moves[0], state.stake),
  ];
  return {
    ...state,
    phase: 'result',
    wait: RESULT_TICKS,
    last: { moves, delta, timeout: state.timedOut },
    lastEvent: 'open',
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
  const timedOut: [boolean, boolean] = [state.timedOut[0], state.timedOut[1]];
  for (const side of [0, 1] as const) {
    if (pending[side] !== null) {
      continue;
    }
    const pressed = moveFromButtons(inputs[side]);
    if (pressed !== null) {
      pending[side] = pressed;
    } else if (timeout) {
      pending[side] = FOLD;
      timedOut[side] = true;
    }
  }
  const moved: HQState = {
    ...state,
    tick,
    pending: pending as [Move | null, Move | null],
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
      state.wait <= 1 ? settle({ ...state, tick }, tick) : { ...state, tick, wait: state.wait - 1 };
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

function actionsHQ(state: HQState, side: Side): readonly Buttons[] {
  // 只看自己有沒有出手，不看對手的 pending（不偷看）。
  if (state.over || state.phase !== 'choose' || state.pending[side] !== null) {
    return ONLY_IDLE;
  }
  return MOVE_BUTTONS;
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
    case 'result': {
      // 開牌：模擬走得到這裡（深度 3 以上）。對「對手真的出了什麼、這回合的結果」目盲：
      // 用還沒入帳的籌碼與歷史，只讀自己的出手，對手由歷史建模。
      const mine = state.last === null ? state.pending[side] : state.last.moves[side];
      if (mine === null) {
        return { gain: diff, danger: 0 };
      }
      const { probs } = predictOpponent(state.history, side);
      let expected = 0;
      for (let o = 0; o < 4; o += 1) {
        expected += (probs[o] as number) * payoff(mine, o as Move, state.stake);
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
