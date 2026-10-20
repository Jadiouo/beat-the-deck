import { intFrom, nextFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
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
 * H-8 加倍或歸零（SPEC 第 9 節；小規格 `docs/cards/H-8.md`，第三版：私有的梯子品質）。
 *
 * 兩個人各爬自己的梯子：6 層，每層成功率逐層下降（公開的基準 `BASE`），而且每個人這座梯子有一個
 * 只有自己知道的品質 `q`（實際成功率 `BASE + q`）。每一層還在爬的人同時選「爬」或「停」；
 * 爬成功賭注 ×2，爬失敗歸零出局，停下來保留賭注。兩邊都結束，這座梯子賭注高的贏。5 座梯子，總分高的贏。
 *
 * 同時出手：`pending`（對方這層的選擇）、對方的 `q`、骰子結果 `last` 對 AI 都是隱藏的，
 * `evaluate`、`actions` 不可以讀。AI 對對方的信念只從公開資訊算：賭注與狀態、這座梯子每層的爬或停與結果（`log`）、
 * 過去梯子公開的雙方 `q`（`past`）。
 */

// ---------------------------------------------------------------------------
// 常數與型別
// ---------------------------------------------------------------------------

/** 公開的基準成功率，第 `k` 層（0 起算）。 */
export const BASE: readonly number[] = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];
/** 私有的梯子品質，每個值等機率。 */
export const Q_VALUES: readonly number[] = [-0.2, -0.1, 0, 0.1, 0.2];
export const LEVELS = 6;
export const LADDERS = 5;
/** 兩邊都選好之後，鎖定幾個 tick 才揭示。 */
export const LOCK_TICKS = 2;
/** 揭示之後停幾個 tick 才入帳（讓人看清楚結果）。 */
export const RESULT_TICKS = 30;
/** 新的一座梯子開始之前多等幾個 tick（讓人看清楚上一座公開的雙方 q 與結果）。 */
export const LADDER_PAUSE = 90;
const MIN_P = 0.05;
const MAX_P = 0.95;

export const STOP = 0;
export const CLIMB = 1;
export type Act = 0 | 1;

export type H8Status = 'active' | 'stopped' | 'out';
export type H8Phase = 'prep' | 'choose' | 'locked' | 'resolve';

/** 一層的公開紀錄。`acts[s]` 是 `null`：這一邊那時已經不在爬；`ok[s]` 是 `null`：這一邊沒爬。 */
export interface H8Log {
  readonly level: number;
  readonly acts: readonly [Act | null, Act | null];
  readonly ok: readonly [boolean | null, boolean | null];
}

/** 揭示的結果。入帳之前只存在 `last`（`evaluate` 不可以讀）。 */
export interface H8Last {
  readonly acts: readonly [Act | null, Act | null];
  readonly ok: readonly [boolean | null, boolean | null];
}

/** 已結束的一座梯子（公開，包含雙方的 q）。 */
export interface H8Past {
  readonly q: readonly [number, number];
  readonly pots: readonly [number, number];
  readonly log: readonly H8Log[];
}

export interface H8State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 現在第幾座梯子（0 到 LADDERS − 1；結束後是 LADDERS）。 */
  readonly ladder: number;
  /** 兩邊各自成功爬了幾層（0 到 LEVELS）。還在爬的兩邊永遠同層。 */
  readonly level: readonly [number, number];
  readonly pot: readonly [number, number];
  readonly status: readonly [H8Status, H8Status];
  /** 每一邊這座梯子的私有品質（隱藏：對方的不可以讀）。 */
  readonly q: readonly [number, number];
  /** 已結束的梯子累計的分數。 */
  readonly scores: readonly [number, number];
  /** 兩邊這層選的（`null` 是還沒選或不在爬）。對手的是隱藏資訊。 */
  readonly pending: readonly [Act | null, Act | null];
  readonly phase: H8Phase;
  /** prep、locked、resolve 還剩幾個 tick。 */
  readonly wait: number;
  /** choose 階段已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  /** 這層揭示的結果（入帳之前）。 */
  readonly last: H8Last | null;
  /** 這座梯子已入帳的每一層（公開）。 */
  readonly log: readonly H8Log[];
  /** 已結束的梯子，最多 LADDERS 筆（公開）。 */
  readonly past: readonly H8Past[];
  /** 擲骰的亂數狀態。 */
  readonly rng: RngState;
  /** 兩邊各抽各的 q 用的亂數狀態。 */
  readonly qRng: readonly [RngState, RngState];
  /** 對手模型開關（消融實驗用 `config.params.model = 0` 關掉：不讀 log 與 past）。 */
  readonly model: boolean;
}

/** 第 `level` 層、品質 `q` 的實際成功率。 */
export function successProb(level: number, q: number): number {
  return Math.min(MAX_P, Math.max(MIN_P, (BASE[level] as number) + q));
}

/** 一座梯子結束，兩邊各得幾分：賭注高的 2、一樣高各 1。 */
export function ladderPoints(pot0: number, pot1: number): readonly [number, number] {
  if (pot0 === pot1) {
    return [1, 1];
  }
  return pot0 > pot1 ? [2, 0] : [0, 2];
}

/** 反射規則的小加分：遠小於任何真正的期望值差。 */
export const HABIT = 0.01;
/** 反射規則：自己這層成功率超過這個數就爬（深度 1、2 與一步看的性格）。 */
export const REFLEX_P = 0.6;

// ---------------------------------------------------------------------------
// 對手模型（只讀公開資訊）
// ---------------------------------------------------------------------------

/** 對手門檻 `θ̂` 的先驗與看最近幾座梯子。 */
const THETA_PRIOR = 0.5;
const THETA_WINDOW = 3;
/** 只有爬（或只有停）的梯子，門檻比最低爬過的（最高停過的）再低（高）這麼多。 */
const THETA_ONE_SIDED = 0.1;
/** 後驗的似然用 `σ((p − θ̂) / SOFTNESS)`。 */
const SOFTNESS = 0.05;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * 站在 `side` 看：對手（`otherSide(side)`）的爬升門檻 `θ̂`。
 * 讀 `past`：每座梯子裡，雙方都還在爬的那些決定，對手實際成功率 `p = BASE + q_對手`（梯子結束後 q 公開），
 * 「停過的最高 p」與「爬過的最低 p」的中點；最近 3 座與先驗 0.5（權重 1 座）平均。
 * 對手單獨爬（我已經停了或出局）的決定不算：那是對我的賭注的反應，不是它的門檻。
 */
export function thetaHat(state: H8State, side: Side): number {
  if (!state.model) {
    return THETA_PRIOR;
  }
  const opp = otherSide(side);
  let total = THETA_PRIOR;
  let weight = 1;
  for (let i = Math.max(0, state.past.length - THETA_WINDOW); i < state.past.length; i += 1) {
    const past = state.past[i] as H8Past;
    let lowestClimb = Number.POSITIVE_INFINITY;
    let highestStop = Number.NEGATIVE_INFINITY;
    for (const entry of past.log) {
      const theirs = entry.acts[opp];
      if (theirs === null || entry.acts[side] === null) {
        continue;
      }
      const p = successProb(entry.level, past.q[opp]);
      if (theirs === CLIMB) {
        lowestClimb = Math.min(lowestClimb, p);
      } else {
        highestStop = Math.max(highestStop, p);
      }
    }
    const hasClimb = lowestClimb !== Number.POSITIVE_INFINITY;
    const hasStop = highestStop !== Number.NEGATIVE_INFINITY;
    if (!hasClimb && !hasStop) {
      continue;
    }
    const mid =
      hasClimb && hasStop
        ? (lowestClimb + highestStop) / 2
        : hasClimb
          ? lowestClimb - THETA_ONE_SIDED
          : highestStop + THETA_ONE_SIDED;
    total += mid;
    weight += 1;
  }
  return total / weight;
}

/**
 * 站在 `side` 看：對手這座梯子的 q 的後驗（對 `Q_VALUES` 每個值的機率）。
 * 先驗均勻；這座梯子每一個已經公開的決定（雙方都還在爬的爬或停）各乘一個似然
 * （爬：`σ((p − θ̂) / 0.05)`，停：補數），每一個公開的骰子結果乘 p 或 1 − p。`model = false` 時回傳先驗。
 */
export function posteriorOf(state: H8State, side: Side): readonly number[] {
  const n = Q_VALUES.length;
  const weights = new Array<number>(n).fill(1 / n);
  if (!state.model) {
    return weights;
  }
  const opp = otherSide(side);
  const theta = thetaHat(state, side);
  for (const entry of state.log) {
    const theirs = entry.acts[opp];
    if (theirs === null) {
      continue;
    }
    const simultaneous = entry.acts[side] !== null;
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const p = successProb(entry.level, Q_VALUES[i] as number);
      let like = 1;
      if (simultaneous) {
        const climb = sigmoid((p - theta) / SOFTNESS);
        like *= theirs === CLIMB ? climb : 1 - climb;
      }
      const ok = entry.ok[opp];
      if (ok !== null) {
        like *= ok ? p : 1 - p;
      }
      weights[i] = (weights[i] as number) * like;
      sum += weights[i] as number;
    }
    if (sum <= 0) {
      return new Array<number>(n).fill(1 / n);
    }
    for (let i = 0; i < n; i += 1) {
      weights[i] = (weights[i] as number) / sum;
    }
  }
  return weights;
}

/** 對手（品質 q）在門檻 `theta` 之下會爬到哪一層才停（從 `from` 層起算；到頂是 LEVELS）。 */
function stopLevel(from: number, q: number, theta: number): number {
  for (let k = from; k < LEVELS; k += 1) {
    if (successProb(k, q) < theta) {
      return k;
    }
  }
  return LEVELS;
}

function scoreOf(mine: number, theirs: number): number {
  return mine === theirs ? 1 : mine > theirs ? 2 : 0;
}

/**
 * 對手已經不在爬（賭注 `O` 公開）：我這層做 `act`，之後單獨決定要爬到哪一層的最好期望得分（0 到 2）。
 * 沒有新資訊，所以「爬到第 M 層就停」的最好的 M 就是最好的玩法。
 */
function loneValue(level: number, q: number, pot: number, O: number, act: Act): number {
  if (act === STOP) {
    return scoreOf(pot, O);
  }
  let best = Number.NEGATIVE_INFINITY;
  let reach = 1;
  for (let m = level + 1; m <= LEVELS; m += 1) {
    reach *= successProb(m - 1, q);
    const value = reach * scoreOf(pot * 2 ** (m - level), O) + (1 - reach) * scoreOf(0, O);
    best = Math.max(best, value);
  }
  return best;
}

/**
 * 兩邊都還在爬（同在第 `j` 層）：我的最好期望得分。對手每個可能的 q 對應一個確定的玩法
 * （p ≥ θ̂ 就爬，到第 `stops[q]` 層停）；我每一層都看得到上一層的公開結果，所以是一個沿著「雙方都成功」
 * 往下走的遞迴（其他三種結果都是閉式）。`forced`：這一層我已經選了。
 */
function contestValue(
  j: number,
  qMe: number,
  weights: readonly number[],
  stops: readonly number[],
  forced: Act | null,
): number {
  const n = weights.length;
  const p = successProb(j, qMe);
  let stopEV = 0;
  let climbEV = 0;
  let bothMass = 0;
  const next = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const w = weights[i] as number;
    if (w <= 0) {
      continue;
    }
    const q = Q_VALUES[i] as number;
    const L = stops[i] as number;
    if (j >= L) {
      // 對手這層停：我停是平手；我爬，成功就贏、失敗就輸
      stopEV += w * 1;
      climbEV += w * 2 * p;
      continue;
    }
    const r = successProb(j, q);
    let rest = 1; // 對手之後（j + 1 到 L − 1 層）都成功的機率
    for (let k = j + 1; k < L; k += 1) {
      rest *= successProb(k, q);
    }
    const allPass = r * rest;
    stopEV += w * 2 * (1 - allPass);
    climbEV += w * (p * (1 - r) * 2 + (1 - p) * (1 - r) + (1 - p) * r * (1 - rest));
    next[i] = w * r;
    bothMass += w * r;
  }
  if (bothMass > 0) {
    const cont =
      j + 1 >= LEVELS
        ? 1
        : contestValue(
            j + 1,
            qMe,
            next.map((v) => v / bothMass),
            stops,
            null,
          );
    climbEV += p * bothMass * cont;
  }
  if (forced === STOP) {
    return stopEV;
  }
  if (forced === CLIMB) {
    return climbEV;
  }
  return Math.max(stopEV, climbEV);
}

/**
 * 我（`side`，還在爬）這一層做 `act` 的最好期望得分（這座梯子，0 到 2）。
 * `readOpp = true`：讀對手的公開狀態（賭注與狀態、這座梯子的紀錄、過去梯子的公開 q）；
 * `readOpp = false`：只知道「有一個對手，它的 q 均勻、門檻 0.5」，不讀它的任何狀態（探針 A 的 (b)）。
 * 只用自己的 q、公開資訊；不讀對方的 q、pending、骰子結果。
 */
export function ladderValue(state: H8State, side: Side, act: Act, readOpp: boolean): number {
  const opp = otherSide(side);
  const level = state.level[side];
  const qMe = state.q[side];
  if (state.status[side] !== 'active') {
    return ladderPoints(state.pot[side], state.pot[opp])[side];
  }
  if (readOpp && state.status[opp] !== 'active') {
    return loneValue(level, qMe, state.pot[side], state.pot[opp], act);
  }
  const reading = readOpp && state.model;
  const weights = reading
    ? posteriorOf(state, side)
    : new Array<number>(Q_VALUES.length).fill(1 / Q_VALUES.length);
  const theta = reading ? thetaHat(state, side) : THETA_PRIOR;
  const stops = Q_VALUES.map((q) => Math.max(level, stopLevel(level, q, theta)));
  return contestValue(level, qMe, weights, stops, act);
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** 測試用：從「第 0 座、準備剛開始、兩邊 q = 0」出發，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<H8State> = {}): H8State {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    ladder: 0,
    level: [0, 0],
    pot: [1, 1],
    status: ['active', 'active'],
    q: [0, 0],
    scores: [0, 0],
    pending: [null, null],
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    last: null,
    log: [],
    past: [],
    rng: rngStateFor(0, 'dice'),
    qRng: [rngStateFor(0, 'q0'), rngStateFor(0, 'q1')],
    model: true,
    ...overrides,
  };
}

/** 兩邊各抽各的 q。 */
function drawQ(qRng: readonly [RngState, RngState]): {
  q: readonly [number, number];
  qRng: readonly [RngState, RngState];
} {
  const [i0, r0] = intFrom(qRng[0], Q_VALUES.length);
  const [i1, r1] = intFrom(qRng[1], Q_VALUES.length);
  return { q: [Q_VALUES[i0] as number, Q_VALUES[i1] as number], qRng: [r0, r1] };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function isActive(state: H8State, side: Side): boolean {
  return state.status[side] === 'active';
}

/** 這個 tick 的按鍵是哪個選擇：b 最優先（同按算停），其次 a；其他鍵沒有作用。 */
function actFromButtons(buttons: Buttons): Act | null {
  if (buttons.b) {
    return STOP;
  }
  return buttons.a ? CLIMB : null;
}

/** 揭示：各擲各的骰（兩邊的骰子永遠各抽一次，抽幾次與誰在爬無關）。 */
function reveal(state: H8State): H8State {
  const [u0, r0] = nextFrom(state.rng);
  const [u1, r1] = nextFrom(r0);
  const us = [u0, u1] as const;
  const acts: [Act | null, Act | null] = [null, null];
  const ok: [boolean | null, boolean | null] = [null, null];
  for (const side of [0, 1] as const) {
    if (!isActive(state, side)) {
      continue;
    }
    const act = state.pending[side];
    acts[side] = act;
    if (act === CLIMB) {
      ok[side] = (us[side] as number) < successProb(state.level[side], state.q[side]);
    }
  }
  return { ...state, phase: 'resolve', wait: RESULT_TICKS, rng: r1, last: { acts, ok } };
}

/** 這座梯子結束：算分、記下過去；最後一座就結束整場，否則開始下一座。 */
function endLadder(state: H8State): H8State {
  const pts = ladderPoints(state.pot[0], state.pot[1]);
  const scores: [number, number] = [state.scores[0] + pts[0], state.scores[1] + pts[1]];
  const past = [...state.past, { q: state.q, pots: state.pot, log: state.log }];
  if (state.ladder + 1 >= LADDERS) {
    return {
      ...state,
      scores,
      past,
      ladder: LADDERS,
      over: true,
      winner: winnerByTotals(scores),
      pending: [null, null],
      last: null,
    };
  }
  const drawn = drawQ(state.qRng);
  return {
    ...state,
    scores,
    past,
    ladder: state.ladder + 1,
    level: [0, 0],
    pot: [1, 1],
    status: ['active', 'active'],
    q: drawn.q,
    qRng: drawn.qRng,
    pending: [null, null],
    phase: 'prep',
    wait: AI_WAIT_TICKS + LADDER_PAUSE,
    idle: 0,
    last: null,
    log: [],
  };
}

/** 入帳：骰子結果落地、記進 log；沒有人還在爬就結束這座梯子，否則進下一層的準備階段。 */
function bank(state: H8State): H8State {
  const last = (state.last ?? {
    acts: [state.pending[0], state.pending[1]],
    ok: [null, null],
  }) as H8Last;
  const level: [number, number] = [state.level[0], state.level[1]];
  const pot: [number, number] = [state.pot[0], state.pot[1]];
  const status: [H8Status, H8Status] = [state.status[0], state.status[1]];
  let logged = -1;
  for (const side of [0, 1] as const) {
    const act = last.acts[side];
    if (act === null) {
      continue;
    }
    if (logged < 0) {
      logged = state.level[side];
    }
    if (act === STOP) {
      status[side] = 'stopped';
    } else if (last.ok[side] === true) {
      level[side] += 1;
      pot[side] *= 2;
      if (level[side] >= LEVELS) {
        status[side] = 'stopped';
      }
    } else {
      pot[side] = 0;
      status[side] = 'out';
    }
  }
  const log = [...state.log, { level: logged, acts: last.acts, ok: last.ok }];
  const banked: H8State = {
    ...state,
    level,
    pot,
    status,
    log,
    pending: [null, null],
    last: null,
  };
  if (status[0] === 'active' || status[1] === 'active') {
    return { ...banked, phase: 'prep', wait: AI_WAIT_TICKS, idle: 0 };
  }
  return endLadder(banked);
}

function stepChoose(state: H8State, inputs: Inputs, tick: number): H8State {
  const timeout = state.idle + 1 >= DECISION_TIMEOUT;
  const pending: (Act | null)[] = [state.pending[0], state.pending[1]];
  for (const side of [0, 1] as const) {
    if (!isActive(state, side) || pending[side] !== null) {
      continue;
    }
    const pressed = actFromButtons(inputs[side]);
    if (pressed !== null) {
      pending[side] = pressed;
    } else if (timeout) {
      pending[side] = STOP;
    }
  }
  const moved: H8State = {
    ...state,
    tick,
    pending: pending as [Act | null, Act | null],
    idle: state.idle + 1,
  };
  const waiting = ([0, 1] as const).some((side) => isActive(state, side) && pending[side] === null);
  return waiting ? moved : { ...moved, phase: 'locked', wait: LOCK_TICKS };
}

/** 時間到：進行中的梯子用現在的賭注比（剛開始、還沒有任何一層入帳的新梯子不算）。 */
function timeUp(state: H8State): H8State {
  let s = state.phase === 'resolve' ? bank(state) : state;
  if (!s.over) {
    const fresh = s.log.length === 0 && s.level[0] === 0 && s.level[1] === 0;
    if (!fresh) {
      s = endLadder(s);
    }
    s = { ...s, over: true, winner: winnerByTotals(s.scores) };
  }
  return s;
}

function stepH8(state: H8State, inputs: Inputs): H8State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: H8State;

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
    after = bank({ ...state, tick });
  } else {
    after = { ...state, tick, wait: state.wait - 1 };
  }

  if (!after.over && tick >= state.maxTicks) {
    return timeUp(after);
  }
  return after;
}

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);
/** 停排第一（搜尋時模擬的對手按第一個：它會推進結算）。 */
const CHOOSE_ACTIONS: readonly Buttons[] = Object.freeze([PRESS_B, PRESS_A]);

function actionsH8(state: H8State, side: Side): readonly Buttons[] {
  // 只看自己有沒有選、自己還在不在爬，不看對手的 pending（不偷看）。
  if (
    !state.over &&
    state.phase === 'choose' &&
    isActive(state, side) &&
    state.pending[side] === null
  ) {
    return CHOOSE_ACTIONS;
  }
  return ONLY_IDLE;
}

function evaluateH8(state: H8State, side: Side): { gain: number; danger: number } {
  const opp = otherSide(side);
  const diff = state.scores[side] - state.scores[opp];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: diff + sign * 1000, danger: 0 };
  }
  const mine = state.pending[side];
  if (state.phase === 'prep' || mine === null) {
    return { gain: diff, danger: 0 };
  }
  if (state.phase === 'choose' || state.phase === 'locked') {
    // 淺搜尋（深度 1、2）只走到這裡，所以只剩反射規則：自己這層 p > 0.5 就爬，不管對方是誰、爬到哪。
    const p = successProb(state.level[side], state.q[side]);
    const reflex: Act = p > REFLEX_P ? CLIMB : STOP;
    return {
      gain: diff + (mine === reflex ? HABIT : 0),
      danger: mine === CLIMB ? 1 - p : 0,
    };
  }
  // resolve：深度 3 以上走得到。對「對手這層真的選了什麼、骰子結果」目盲：不讀 `last`、不讀對方的 pending，
  // 對手由後驗與門檻建模。失敗已經算在期望得分裡，danger 給 0（不重複扣：DESIGN-AI-FUN 10.54）。
  return { gain: diff + 2 * ladderValue(state, side, mine, true) - 2, danger: 0 };
}

export const h8Game: Game<H8State> = {
  id: 'H-8',

  init(seed: number, config: GameConfig): H8State {
    const drawn = drawQ([rngStateFor(seed, 'q0'), rngStateFor(seed, 'q1')]);
    return makeState({
      maxTicks: config.maxTicks,
      rng: rngStateFor(seed, 'dice'),
      q: drawn.q,
      qRng: drawn.qRng,
      model: config.params['model'] !== 0,
    });
  },

  step(state: H8State, inputs: Inputs): H8State {
    return stepH8(state, inputs);
  },

  isOver(state: H8State): boolean {
    return state.over;
  },

  score(state: H8State): readonly [number, number] {
    return [state.scores[0], state.scores[1]];
  },

  winner(state: H8State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: H8State, side: Side): readonly Buttons[] {
    return actionsH8(state, side);
  },

  evaluate(state: H8State, side: Side): { gain: number; danger: number } {
    return evaluateH8(state, side);
  },
};
