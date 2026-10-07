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
 * H-9 吹牛骰（小規格 `docs/cards/H-9.md`）。
 *
 * 兩邊各藏 2 顆骰子，輪流喊「四顆骰子的總和至少是 S」（每次加 1 到 3），不信就按 b 抓：
 * 抓之後亮骰，總和 ≥ 喊價 → 喊的人贏這一回合，否則抓的人贏；先贏 3 回合（最多 5 回合）。
 *
 * 結算流程（等級曲線的來源，DESIGN-AI-FUN 5.1／9.5）：
 * 動作（`locked`，鎖定 2 個 tick）→ 第 3 步：抓 → 亮骰（`reveal`）；加價 → 回合交給對方。
 * 搜尋型的 `depth` 只有 1 到 6 個 tick，所以深度 ≤ 2 只走到 `locked`（反射：誠實的新手，
 * 只喊自己的骰子撐得住的價、喊價離譜就抓，完全不讀對方的紀錄），
 * 深度 ≥ 3 走得到亮骰（用對手後驗算喊價是真的機率）與對方的回合（用「對方抓的紀錄」算對方會不會抓）。
 *
 * 資訊限制：state 是完整資訊（含雙方藏著的 `dice`、下一回合骰子所在的 `rng`），
 * 但 `evaluate` 與 `actions` 只讀這一邊看得到的：
 * - 自己的骰子（`dice[side]`）；
 * - 公開的喊價（`bids`）、已經結束的回合（`past`，抓了才亮骰，所以那些骰子是公開的）、勝場；
 * - `dice[對方]` 與 `rng` 永遠不讀（包括亮骰階段：結算只在 `step` 的第 33 步，在 AI 的模擬範圍之外）。
 */

export const DICE = 2;
export const WINS = 3;
export const MAX_ROUNDS = 5;
/** 動作之後鎖定幾個 tick 才結算（按 1、鎖定第二步 2、第 3 步結算）。 */
export const LOCK_TICKS = 2;
/** 亮骰之後停幾個 tick 才入帳（讓人看清楚亮出什麼）。 */
export const RESULT_TICKS = 30;
/** 喊價從 4 開始（四顆骰子的總和最少是 4，等於沒人喊）。 */
export const S0 = 4;
export const S_MAX = 24;
export const MAX_RAISE = 3;

/** 按鍵：← 加 1、↑ 加 2、→ 加 3、b 抓。 */
export const PLUS1: Buttons = Object.freeze({ ...IDLE, left: true });
export const PLUS2: Buttons = Object.freeze({ ...IDLE, up: true });
export const PLUS3: Buttons = Object.freeze({ ...IDLE, right: true });
export const CALL: Buttons = Object.freeze({ ...IDLE, b: true });

const RAISE_KEYS: readonly Buttons[] = Object.freeze([PLUS1, PLUS2, PLUS3]);

export type H9Phase = 'prep' | 'choose' | 'locked' | 'reveal';
/** `locked` 階段鎖定的是加價還是抓。 */
export type H9Lock = 'raise' | 'call';

/** 雙方的骰子：`[人的兩顆, AI 的兩顆]`。藏著，抓了才亮。 */
export type Dice = readonly [readonly [number, number], readonly [number, number]];

/** 公開的一次喊價。 */
export interface H9Bid {
  readonly side: Side;
  readonly S: number;
}

/** 已經結束的回合（抓了才寫入，所以骰子是公開的）。 */
export interface H9Past {
  readonly dice: Dice;
  readonly bids: readonly H9Bid[];
  readonly challenger: Side;
  readonly bidderWon: boolean;
}

export interface H9State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 第幾回合（1 到 5）。 */
  readonly round: number;
  /** 這回合先喊的人（第 1 回合人先，之後交替）。 */
  readonly first: Side;
  /** 輪到誰（在 `locked`、`reveal`：剛動作的人，抓的時候就是抓的人）。 */
  readonly turn: Side;
  /** 目前的喊價：「四顆骰子的總和至少是 S」。 */
  readonly S: number;
  /** 最後一次喊價的人；還沒有人喊過是 null。 */
  readonly bidder: Side | null;
  /** 隱藏。 */
  readonly dice: Dice;
  readonly phase: H9Phase;
  readonly lock: H9Lock | null;
  readonly wait: number;
  readonly idle: number;
  readonly wins: readonly [number, number];
  /** 這回合所有喊價（公開）。 */
  readonly bids: readonly H9Bid[];
  /** 已結束的回合（公開），最多 5 筆。 */
  readonly past: readonly H9Past[];
  /** 下一回合骰子的亂數（隱藏；evaluate 不讀）。 */
  readonly rng: RngState;
}

/** 測試用：一個「剛開始、人先喊」的局面，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<H9State> = {}): H9State {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    round: 1,
    first: 0,
    turn: 0,
    S: S0,
    bidder: null,
    dice: [
      [3, 4],
      [2, 5],
    ],
    phase: 'choose',
    lock: null,
    wait: 0,
    idle: 0,
    wins: [0, 0],
    bids: [],
    past: [],
    rng: rngStateFor(0, 'dice'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 骰子的算術
// ---------------------------------------------------------------------------

/** 兩顆骰子的總和（2 到 12）各有幾種擲法（共 36）。索引是總和。 */
const WAYS: readonly number[] = Object.freeze([0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]);
const PRIOR: readonly number[] = Object.freeze(WAYS.map((w) => w / 36));
const SUM_LO = 2;
const SUM_HI = 12;
/** 兩顆骰子的平均：「對方骰子取平均」就是 7。 */
const AVG_PAIR = 7;

/** 兩顆骰子的總和的先驗分佈（長度 13，索引是總和；索引 0、1 是 0）。 */
export function priorSums(): number[] {
  return [...PRIOR];
}

function pairSum(pair: readonly [number, number]): number {
  return pair[0] + pair[1];
}

/** 這一邊自己的兩顆骰子的總和。只讀 `dice[side]`。 */
function ownSum(state: H9State, side: Side): number {
  return pairSum(state.dice[side]);
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total;
}

/** 只用先驗：我的兩顆骰子總和是 `a`，喊價 `S` 是真的機率（對方的骰子取先驗）。 */
function priorTrue(a: number, S: number): number {
  let p = 0;
  for (let b = SUM_LO; b <= SUM_HI; b += 1) {
    if (a + b >= S) {
      p += PRIOR[b] as number;
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// 對手模型：虛報量、後驗、對方抓的習慣
// ---------------------------------------------------------------------------

/** 虛報量的先驗：每一回合一票，先驗也算一票。 */
export const DELTA_PRIOR = 1.5;
/** 看最近幾個已結束的回合。 */
export const RECENT_ROUNDS = 3;
/** 後驗的高斯寬度，與先驗混合的權重（後驗 7、先驗 3）。 */
const SIGMA = 1.5;
const POSTERIOR_WEIGHT = 0.7;
/** 對方抓的機率的先驗（三個區間：喊價離「對方自己的骰子 + 7」≤ 0、1 到 2、≥ 3），與先驗的權重（次數）。 */
const CALL_PRIOR: readonly [number, number, number] = [0.05, 0.3, 0.75];
const CALL_PRIOR_WEIGHT = 2;

/** 某一邊在這回合（或過去某回合）的最後一次喊價。沒喊過是 null。 */
function lastBidOf(bids: readonly H9Bid[], side: Side): number | null {
  for (let i = bids.length - 1; i >= 0; i -= 1) {
    const b = bids[i] as H9Bid;
    if (b.side === side) {
      return b.S;
    }
  }
  return null;
}

/**
 * `opp` 的虛報量 δ̂：他最後一次喊價比「自己的骰子總和 + 7」多多少，取最近 `RECENT_ROUNDS` 個已結束的回合
 * （沒喊過價的回合不算），先驗 +1.5 算一票。只讀公開的 `past`（骰子在抓了之後是公開的）。
 */
export function bluffMargin(past: readonly H9Past[], opp: Side): number {
  let votes = 1;
  let total = DELTA_PRIOR;
  let seen = 0;
  for (let i = past.length - 1; i >= 0 && seen < RECENT_ROUNDS; i -= 1) {
    const round = past[i] as H9Past;
    seen += 1;
    const last = lastBidOf(round.bids, opp);
    if (last === null) {
      continue;
    }
    total += last - AVG_PAIR - pairSum(round.dice[opp]);
    votes += 1;
  }
  return total / votes;
}

/** 喊價 `S` 離「對方自己的骰子 + 7」的差，換成三個區間：0（≤ 0）、1（1 到 2）、2（≥ 3）。 */
function gapBucket(gap: number): 0 | 1 | 2 {
  if (gap <= 0) {
    return 0;
  }
  return gap <= 2 ? 1 : 2;
}

/**
 * 對方（`me` 的對手）收到 `me` 的喊價時，在三個區間各自會抓的機率（用過去的回合學：
 * 每個過去的回合重建「對方每次回應我的喊價時，是加價還是抓」，離他自己的 `骰子 + 7` 有多遠），
 * 最近 `RECENT_ROUNDS` 個回合，先驗權重 2 次。只讀 `past`。
 */
export function callRates(past: readonly H9Past[], me: Side): readonly [number, number, number] {
  const opp = otherSide(me);
  const calls = [0, 0, 0];
  const total = [0, 0, 0];
  let seen = 0;
  for (let r = past.length - 1; r >= 0 && seen < RECENT_ROUNDS; r -= 1) {
    seen += 1;
    const round = past[r] as H9Past;
    const mark = pairSum(round.dice[opp]) + AVG_PAIR;
    for (let i = 0; i < round.bids.length; i += 1) {
      const b = round.bids[i] as H9Bid;
      if (b.side !== me) {
        continue;
      }
      const next = round.bids[i + 1];
      let called: boolean;
      if (next !== undefined) {
        if (next.side !== opp) {
          continue;
        }
        called = false;
      } else if (round.challenger === opp) {
        called = true;
      } else {
        continue;
      }
      const bucket = gapBucket(b.S - mark);
      total[bucket] = (total[bucket] as number) + 1;
      calls[bucket] = (calls[bucket] as number) + (called ? 1 : 0);
    }
  }
  const rate = (k: 0 | 1 | 2): number =>
    ((calls[k] as number) + CALL_PRIOR_WEIGHT * (CALL_PRIOR[k] as number)) /
    ((total[k] as number) + CALL_PRIOR_WEIGHT);
  return [rate(0), rate(1), rate(2)];
}

/**
 * `me` 對對手兩顆骰子總和的後驗（長度 13，索引是總和，加起來是 1）。
 * 對手這回合最後一次喊價 `S_opp`：他不會喊自己撐不住的價（`b ≥ S_opp − 7 − δ̂`，δ̂ 是虛報量），
 * 所以 `b* = S_opp − 7 − δ̂` 是下界：低於下界的總和按高斯（σ = 1.5）打折，下界以上不動，
 * 再與先驗 7:3 混合。對手這回合還沒喊過價：就是先驗。只讀 `bids` 與 `past`，不讀 `dice[對手]`。
 */
export function oppPosterior(state: H9State, me: Side): number[] {
  const opp = otherSide(me);
  const last = lastBidOf(state.bids, opp);
  if (last === null) {
    return [...PRIOR];
  }
  const floor = last - AVG_PAIR - bluffMargin(state.past, opp);
  const weights = new Array<number>(SUM_HI + 1).fill(0);
  for (let b = SUM_LO; b <= SUM_HI; b += 1) {
    const below = floor - b;
    const likelihood = below > 0 ? Math.exp(-(below * below) / (2 * SIGMA * SIGMA)) : 1;
    weights[b] = (PRIOR[b] as number) * likelihood;
  }
  const norm = sum(weights);
  return weights.map(
    (w, b) => POSTERIOR_WEIGHT * (w / norm) + (1 - POSTERIOR_WEIGHT) * (PRIOR[b] as number),
  );
}

function trueFrom(a: number, post: readonly number[], S: number): number {
  let p = 0;
  for (let b = SUM_LO; b <= SUM_HI; b += 1) {
    if (a + b >= S) {
      p += post[b] as number;
    }
  }
  return p;
}

/** 喊價 `S` 是真的（四顆骰子總和 ≥ S）的機率：我的骰子已知，對手的用後驗。 */
export function trueChance(state: H9State, me: Side, S: number): number {
  return trueFrom(ownSum(state, me), oppPosterior(state, me), S);
}

/** 對手在收到 `me` 的喊價 `S` 時會抓的機率：對他的骰子的後驗展開，每一種骰子用那一區間學到的抓的機率。 */
export function callChance(state: H9State, me: Side, S: number): number {
  if (S >= S_MAX) {
    return 1;
  }
  const post = oppPosterior(state, me);
  const rates = callRates(state.past, me);
  let p = 0;
  for (let b = SUM_LO; b <= SUM_HI; b += 1) {
    p += (post[b] as number) * (rates[gapBucket(S - (b + AVG_PAIR))] as number);
  }
  return p;
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function rollDice(rng: RngState): { dice: Dice; rng: RngState } {
  const faces: number[] = [];
  let state = rng;
  for (let i = 0; i < 2 * DICE; i += 1) {
    const [face, next] = intFrom(state, 6);
    faces.push(face + 1);
    state = next;
  }
  return {
    dice: [
      [faces[0] as number, faces[1] as number],
      [faces[2] as number, faces[3] as number],
    ],
    rng: state,
  };
}

/** 輪到 `side`：AI 先等 AI_WAIT_TICKS（人直接可以決定）。 */
function startTurn(state: H9State, side: Side): H9State {
  return side === 1
    ? { ...state, turn: side, phase: 'prep', wait: AI_WAIT_TICKS, idle: 0, lock: null }
    : { ...state, turn: side, phase: 'choose', wait: 0, idle: 0, lock: null };
}

function finish(state: H9State): H9State {
  return { ...state, over: true, winner: winnerByTotals(state.wins) };
}

type Act = { readonly kind: 'call' } | { readonly kind: 'raise'; readonly by: number };

/** 這個 tick 的按鍵對應的動作：b 最優先（要有人喊過），其次 ←、↑、→（不能超過 24）。沒有有效的鍵是 null。 */
function pressedAct(buttons: Buttons, S: number): Act | null {
  if (buttons.b && S > S0) {
    return { kind: 'call' };
  }
  const keys = [buttons.left, buttons.up, buttons.right];
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] === true && S + i + 1 <= S_MAX) {
      return { kind: 'raise', by: i + 1 };
    }
  }
  return null;
}

function applyAct(state: H9State, act: Act, tick: number): H9State {
  if (act.kind === 'call') {
    return { ...state, tick, phase: 'locked', lock: 'call', wait: LOCK_TICKS, idle: 0 };
  }
  const S = state.S + act.by;
  return {
    ...state,
    tick,
    S,
    bidder: state.turn,
    bids: [...state.bids, { side: state.turn, S }],
    phase: 'locked',
    lock: 'raise',
    wait: LOCK_TICKS,
    idle: 0,
  };
}

function stepChoose(state: H9State, inputs: Inputs, tick: number): H9State {
  const act = pressedAct(inputs[state.turn], state.S);
  if (act !== null) {
    return applyAct(state, act, tick);
  }
  if (state.idle + 1 >= DECISION_TIMEOUT) {
    // 超時自動選保守的：已經有人喊過就抓；沒人喊過只能加 1
    return applyAct(state, state.S > S0 ? { kind: 'call' } : { kind: 'raise', by: 1 }, tick);
  }
  return { ...state, tick, idle: state.idle + 1 };
}

/** 亮骰之後入帳：總和 ≥ 喊價，喊的人贏，否則抓的人贏；先贏 3 回合，否則下一回合。 */
function bank(state: H9State, tick: number): H9State {
  const caller = state.turn;
  const bidder = state.bidder ?? otherSide(caller);
  const total = ownSum(state, 0) + ownSum(state, 1);
  const bidderWon = total >= state.S;
  const roundWinner: Side = bidderWon ? bidder : caller;
  const wins: [number, number] = [state.wins[0], state.wins[1]];
  wins[roundWinner] += 1;
  const record: H9Past = {
    dice: state.dice,
    bids: state.bids,
    challenger: caller,
    bidderWon,
  };
  const settled: H9State = {
    ...state,
    tick,
    wins,
    past: [...state.past, record],
    lock: null,
  };
  if (wins[roundWinner] >= WINS || state.round >= MAX_ROUNDS) {
    return finish(settled);
  }
  const rolled = rollDice(state.rng);
  const first = otherSide(state.first);
  return startTurn(
    {
      ...settled,
      round: state.round + 1,
      first,
      S: S0,
      bidder: null,
      bids: [],
      dice: rolled.dice,
      rng: rolled.rng,
    },
    first,
  );
}

function stepH9(state: H9State, inputs: Inputs): H9State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: H9State;
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
      if (state.wait > 1) {
        after = { ...state, tick, wait: state.wait - 1 };
      } else if (state.lock === 'call') {
        after = { ...state, tick, phase: 'reveal', wait: RESULT_TICKS };
      } else {
        after = { ...startTurn(state, otherSide(state.turn)), tick };
      }
      break;
    default:
      after = state.wait <= 1 ? bank(state, tick) : { ...state, tick, wait: state.wait - 1 };
      break;
  }
  if (!after.over && tick >= state.maxTicks) {
    // 時間到：比目前的勝場
    return finish(after);
  }
  return after;
}

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);

function actionsH9(state: H9State, side: Side): readonly Buttons[] {
  if (state.over || state.phase !== 'choose' || state.turn !== side) {
    return ONLY_IDLE;
  }
  const keys: Buttons[] = [];
  for (let i = 0; i < RAISE_KEYS.length; i += 1) {
    if (state.S + i + 1 <= S_MAX) {
      keys.push(RAISE_KEYS[i] as Buttons);
    }
  }
  if (state.S > S0) {
    keys.push(CALL);
  }
  return keys;
}

/** 結束的局，勝負加成（比任何勝場差都大）。 */
const END_BONUS = 1000;
/** 反射：誠實的小加分。 */
const HABIT = 0.01;
/** 反射：喊價撐得住的上限是「自己的骰子 + 7」（對方骰子取平均），超過「+ 9」就抓。 */
const REFLEX_RAISE = 7;
const REFLEX_CALL = 9;

function lockedValue(state: H9State, me: Side, diff: number): { gain: number; danger: number } {
  if (state.turn !== me) {
    return { gain: diff, danger: 0 };
  }
  // 反射：完全不用後驗與紀錄，只看自己的骰子與喊價。
  const a = ownSum(state, me);
  const pTrue = priorTrue(a, state.S);
  if (state.lock === 'call') {
    return {
      gain: diff + (state.S > a + REFLEX_CALL ? HABIT : 0),
      danger: clamp01(pTrue),
    };
  }
  return {
    gain: diff + (state.S <= a + REFLEX_RAISE ? HABIT : 0),
    danger: clamp01(1 - pTrue),
  };
}

function revealValue(state: H9State, me: Side, diff: number): { gain: number; danger: number } {
  // 不讀亮出來的骰子：猜中的機率用後驗。
  const pTrue = trueChance(state, me, state.S);
  const pWin = state.turn === me ? 1 - pTrue : pTrue;
  return { gain: diff + 2 * pWin - 1, danger: clamp01(1 - pWin) };
}

/**
 * 我剛喊了 `S`、輪到對方：這個喊價的價值（勝 +1、負 −1 的期望）。
 *
 * 對方的行為用「抓的習慣」`rates`（離他自己的骰子 + 7 有多遠、抓不抓）描述：
 * - 他抓：喊價是真的我贏，是假的我輸（我的骰子已知，他的骰子用後驗 `post`）；
 * - 他不抓（加價 +1）：他沒抓這件事本身是證據（總和低到會抓的那些，機率被打掉），後驗跟著更新；
 *   然後輪到我：抓他（他的價是假的我才贏），或我再加價 +1，取比較好的；
 *   我之後的加價一律當 +1（一條路徑），所以整個推演只有 `S_MAX − S` 層、每層 11 種骰子。
 * 這就是小規格的 `V_續`：對方愛抓時保持誠實（喊高被抓價值很低），從不抓時喊高（對方被逼著加價，
 * 加到他自己撐不住的價，我再抓）。
 */
function bidValue(
  a: number,
  post: readonly number[],
  S: number,
  rates: readonly [number, number, number],
): number {
  let callPart = 0;
  let mass = 0;
  const kept = new Array<number>(SUM_HI + 1).fill(0);
  for (let b = SUM_LO; b <= SUM_HI; b += 1) {
    const w = post[b] as number;
    const pCall = S >= S_MAX ? 1 : (rates[gapBucket(S - (b + AVG_PAIR))] as number);
    callPart += w * pCall * (a + b >= S ? 1 : -1);
    kept[b] = w * (1 - pCall);
    mass += kept[b] as number;
  }
  if (mass <= 1e-9 || S >= S_MAX) {
    return callPart;
  }
  const next = new Array<number>(SUM_HI + 1).fill(0);
  let callNext = 0;
  const opened = S + 1;
  for (let b = SUM_LO; b <= SUM_HI; b += 1) {
    const w = (kept[b] as number) / mass;
    next[b] = w;
    callNext += w * (a + b < opened ? 1 : -1);
  }
  const best =
    opened + 1 <= S_MAX ? Math.max(callNext, bidValue(a, next, opened + 1, rates)) : callNext;
  return callPart + mass * best;
}

/** 輪到對方、剛喊過價的是我。 */
function opponentValue(state: H9State, me: Side, diff: number): { gain: number; danger: number } {
  if (state.bidder !== me) {
    return { gain: diff, danger: 0 };
  }
  const post = oppPosterior(state, me);
  const rates = callRates(state.past, me);
  const a = ownSum(state, me);
  const pTrue = trueFrom(a, post, state.S);
  return {
    gain: diff + bidValue(a, post, state.S, rates),
    danger: clamp01(1 - pTrue),
  };
}

/** 輪到我（對方剛加價）的價值打幾折：見 `myTurnValue`。 */
const MY_TURN_DISCOUNT = 0.9;

function myTurnValue(state: H9State, me: Side, diff: number): { gain: number; danger: number } {
  if (state.S <= S0 || state.bidder === me) {
    return { gain: diff, danger: 0 };
  }
  const callGain = 1 - 2 * trueChance(state, me, state.S);
  // 打折：搜尋型在模擬裡會讓對方「維持 actions 的第一個」（加 1），走到這裡的路是假設對方一定繼續加；
  // 現在就抓（亮骰）是已經到手的，所以同樣的把握下，現在抓要嚴格勝過「等對方再加一次」。
  return { gain: diff + MY_TURN_DISCOUNT * Math.max(0, callGain), danger: 0 };
}

function evaluateH9(state: H9State, me: Side): { gain: number; danger: number } {
  const diff = state.wins[me] - state.wins[otherSide(me)];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === me ? 1 : -1;
    return { gain: diff + sign * END_BONUS, danger: 0 };
  }
  switch (state.phase) {
    case 'locked':
      return lockedValue(state, me, diff);
    case 'reveal':
      return revealValue(state, me, diff);
    default:
      return state.turn === me ? myTurnValue(state, me, diff) : opponentValue(state, me, diff);
  }
}

export const h9Game: Game<H9State> = {
  id: 'H-9',

  init(seed: number, config: GameConfig): H9State {
    const rolled = rollDice(rngStateFor(seed, 'dice'));
    return makeState({
      maxTicks: config.maxTicks,
      dice: rolled.dice,
      rng: rolled.rng,
    });
  },

  step(state: H9State, inputs: Inputs): H9State {
    return stepH9(state, inputs);
  },

  isOver(state: H9State): boolean {
    return state.over;
  },

  score(state: H9State): readonly [number, number] {
    return [state.wins[0], state.wins[1]];
  },

  winner(state: H9State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: H9State, side: Side): readonly Buttons[] {
    return actionsH9(state, side);
  },

  evaluate(state: H9State, side: Side): { gain: number; danger: number } {
    return evaluateH9(state, side);
  },
};
