import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  AI_WAIT_TICKS,
  DECISION_TIMEOUT,
  IDLE,
  PRESS_A,
  PRESS_B,
  otherSide,
} from '../_hearts/logic';

/**
 * H-5 二十一點（SPEC 第 9 節；小規格 `docs/cards/H-5.md`）。
 *
 * 沒有莊家的兩人對打：牌是 1 到 10 各 4 張（沒有 A 與人頭牌），每人 1 張只有自己知道的暗牌加 1 張明牌，
 * 每一輪兩邊**同時**選要牌（a）或停牌（b），要牌的人從**同一副牌**領 1 張明牌。停牌是這一手的最終決定；
 * 爆牌（超過 21）或滿 4 張牌自動停牌，對手看到的與「自己選停」一樣。沒爆、點數大的贏 +1，爆牌的人 −1。
 *
 * 等級曲線從結算流程長出來（DESIGN-AI-FUN 5.1）：選擇 → 鎖定 2 tick → 第 3 步公開並領牌。
 * 深度 1 到 2 走不到公開，`evaluate` 在 `locked` 只剩「反射規則」（總點數 < 16 就要牌）的小加分，不讀你；
 * 深度 3 以上走得到公開（`deal`），`evaluate` 用「對手暗牌的後驗」與「沒看到的牌」算這一手的期望，
 * 其中對手「在總點數幾停牌」的門檻 θ 從它最近 3 手攤牌後的紀錄估出來，一手就會讓估計大幅移動。
 */

/** 動作：0 = 要牌（a）、1 = 停牌（b）。 */
export type Move = 0 | 1;
export const HIT: Move = 0;
export const STOP: Move = 1;

export const HANDS = 9;
/** 每人最多幾張牌（1 暗 ＋ 3 明）；滿了自動停牌。 */
export const MAX_CARDS = 4;
/** 兩邊都選好之後，鎖定幾個 tick 才公開（選 1、鎖定 2、公開 3：深度 3 以上走得到公開）。 */
export const LOCK_TICKS = 2;
/** 公開並領牌之後、攤牌之後各停幾個 tick。 */
export const RESULT_TICKS = 30;
/** 爆牌的人多扣幾分（贏的人 +1，爆牌的人 −BUST_EXTRA）。 */
export const BUST_EXTRA = 2;
/** 對手模型只看最近幾手（攤牌之後才寫入）。 */
export const WINDOW = 3;
/** 反射規則的小加分（遠小於任何真正的期望值差）。 */
export const HABIT = 0.01;
/** 反射規則：總點數小於這個數就要牌，否則停牌。 */
export const REFLEX_LIMIT = 16;
/** 對手停牌門檻 θ 的先驗中心、先驗的寬度、停牌機率的羅吉斯溫度。 */
export const THETA_PRIOR = 15.5;
export const PRIOR_SD = 2;
export const TEMPERATURE = 1.5;
/** θ 估計的格點範圍與間隔。 */
const THETA_MIN = 6;
const THETA_MAX = 26;
const THETA_STEP = 0.25;

const END_BONUS = 1000;
const BUST = 22;
const RANKS = 10;

export type H5Phase = 'prep' | 'choose' | 'locked' | 'deal' | 'showdown';

/** 一次決定的觀察：做決定時的總點數（含暗牌）與選擇。攤牌之後才公開。 */
export interface PastObs {
  readonly total: number;
  readonly move: Move;
}

/** 這一手的結果（攤牌階段，入帳之前）。`evaluate` 不可以讀。 */
export interface H5Last {
  readonly totals: readonly [number, number];
  readonly delta: readonly [number, number];
  readonly busted: readonly [boolean, boolean];
}

export interface H5State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 現在第幾手（0 到 HANDS − 1）。 */
  readonly hand: number;
  /** 這一手的第幾輪（0 起算）。 */
  readonly round: number;
  /** 這一手誰先從牌堆領牌（每手交替）。 */
  readonly dealer: Side;
  /** 牌堆各點數（1 到 10，索引 0 到 9）還剩幾張；領到的牌在併牌時才扣。 */
  readonly pool: readonly number[];
  /** 兩邊的暗牌（對方的是隱藏資訊）。 */
  readonly hole: readonly [number, number];
  /** 兩邊的明牌（公開）。 */
  readonly up: readonly [readonly number[], readonly number[]];
  /** 已經停牌的人（自己選停、爆牌、滿 4 張）；公開，但分不出是哪一種。 */
  readonly stood: readonly [boolean, boolean];
  /** 這一輪兩邊的選擇；停牌的人預先填 STOP。對方的是隱藏資訊。 */
  readonly pending: readonly [Move | null, Move | null];
  /** 這一輪領到的牌（公開之後、併牌之前）。`evaluate` 不可以讀。 */
  readonly incoming: readonly [number | null, number | null];
  readonly phase: H5Phase;
  /** prep、locked、deal、showdown 還剩幾個 tick。 */
  readonly wait: number;
  /** choose 階段已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  readonly scores: readonly [number, number];
  /** 這一手已經結束的每一輪兩邊的選擇；那一輪已經停牌的人是 null。 */
  readonly log: readonly (readonly [Move | null, Move | null])[];
  /** 這一手的結果（攤牌階段，入帳之前）。 */
  readonly last: H5Last | null;
  /** 最近 WINDOW 手攤牌後的觀察，每邊一串（`past[s]` 是 s 的紀錄，公開）。 */
  readonly past: readonly [readonly (readonly PastObs[])[], readonly (readonly PastObs[])[]];
  readonly rng: RngState;
  /** 對手模型開關（消融實驗用 `config.params.model = 0` 關掉）。 */
  readonly model: boolean;
}

// ---------------------------------------------------------------------------
// 點數與結算
// ---------------------------------------------------------------------------

export function totalOf(hole: number, up: readonly number[]): number {
  let total = hole;
  for (const card of up) {
    total += card;
  }
  return total;
}

/** 兩邊的總點數（超過 21 就是爆牌）→ 兩邊這一手的得分變化。 */
export function settle(a: number, b: number): readonly [number, number] {
  const busted: readonly [boolean, boolean] = [a > 21, b > 21];
  if (busted[0] && busted[1]) {
    return [-BUST_EXTRA, -BUST_EXTRA];
  }
  if (busted[0]) {
    return [-BUST_EXTRA, 1];
  }
  if (busted[1]) {
    return [1, -BUST_EXTRA];
  }
  if (a === b) {
    return [0, 0];
  }
  return a > b ? [1, 0] : [0, 1];
}

function reflexMove(total: number): Move {
  return total < REFLEX_LIMIT ? HIT : STOP;
}

// ---------------------------------------------------------------------------
// 牌堆
// ---------------------------------------------------------------------------

function fullPool(): number[] {
  return new Array<number>(RANKS).fill(4);
}

/** 從點數計數抽一張（均勻抽「張」）。`counts` 會被改動，呼叫端傳自己的副本。 */
function drawFrom(counts: number[], rng: RngState): readonly [number, RngState] {
  const total = counts.reduce((a, b) => a + b, 0);
  const [k, next] = intFrom(rng, total);
  let left = k;
  for (let rank = 1; rank <= RANKS; rank += 1) {
    const n = counts[rank - 1] as number;
    if (left < n) {
      counts[rank - 1] = n - 1;
      return [rank, next];
    }
    left -= n;
  }
  throw new Error('牌堆是空的');
}

interface Dealt {
  readonly hole: readonly [number, number];
  readonly up: readonly [readonly number[], readonly number[]];
  readonly pool: readonly number[];
  readonly rng: RngState;
}

/** 新的一手：重洗一副 40 張牌，每人先發 1 張暗牌與 1 張明牌。 */
function dealHand(rng: RngState): Dealt {
  const counts = fullPool();
  const [h0, r1] = drawFrom(counts, rng);
  const [u0, r2] = drawFrom(counts, r1);
  const [h1, r3] = drawFrom(counts, r2);
  const [u1, r4] = drawFrom(counts, r3);
  return { hole: [h0, h1], up: [[u0], [u1]], pool: counts, rng: r4 };
}

/** 牌堆 ＝ 40 張扣掉已經發出的（兩邊的暗牌與明牌）。測試用。 */
function poolFromVisible(
  hole: readonly [number, number],
  up: readonly [readonly number[], readonly number[]],
): number[] {
  const counts = fullPool();
  for (const card of [hole[0], hole[1], ...up[0], ...up[1]]) {
    if (card >= 1 && card <= RANKS) {
      counts[card - 1] = Math.max(0, (counts[card - 1] as number) - 1);
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 對手的停牌門檻 θ：從最近 WINDOW 手攤牌後的紀錄估
// ---------------------------------------------------------------------------

/** 對手在總點數 `total` 停牌的機率：羅吉斯，θ 是五五波的點數；超過 21 沒得選，一定是停。 */
export function stopProb(total: number, theta: number): number {
  if (total > 21) {
    return 1;
  }
  return 1 / (1 + Math.exp(-(total - theta) / TEMPERATURE));
}

/**
 * 從對手最近 WINDOW 手的紀錄估它的停牌門檻 θ：先驗是 N(15.5, 2²)，每一次決定乘上
 * 「在那個總點數做出那個選擇」的羅吉斯似然，取格點上的後驗平均。
 * 沒有紀錄是 15.5；`enabled = false`（消融）永遠是 15.5。
 * 先驗只有兩個點寬，所以一手的紀錄就讓估計移動一點以上：這是刻意的（過度反應是這張牌的互動）。
 */
export function estimateTheta(past: readonly (readonly PastObs[])[], enabled: boolean): number {
  if (!enabled) {
    return THETA_PRIOR;
  }
  const recent = past.slice(-WINDOW);
  const obs: PastObs[] = [];
  for (const hand of recent) {
    for (const o of hand) {
      obs.push(o);
    }
  }
  if (obs.length === 0) {
    return THETA_PRIOR;
  }
  let weightSum = 0;
  let thetaSum = 0;
  for (let theta = THETA_MIN; theta <= THETA_MAX + 1e-9; theta += THETA_STEP) {
    const z = (theta - THETA_PRIOR) / PRIOR_SD;
    let weight = Math.exp(-0.5 * z * z);
    for (const o of obs) {
      const stop = stopProb(o.total, theta);
      weight *= o.move === STOP ? stop : 1 - stop;
    }
    weightSum += weight;
    thetaSum += weight * theta;
  }
  return weightSum > 0 ? thetaSum / weightSum : THETA_PRIOR;
}

/** 畫面上「AI 對你的把握」：你的紀錄在窗口裡有幾手，0 到 3 格。不說它認為你的門檻是多少。 */
export function confidenceLevel(state: H5State, side: Side): 0 | 1 | 2 | 3 {
  if (!state.model) {
    return 0;
  }
  const n = Math.min(WINDOW, state.past[otherSide(side)].length);
  return n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : 3;
}

// ---------------------------------------------------------------------------
// 公開資訊推出來的：沒看到的牌、對手暗牌的後驗
// ---------------------------------------------------------------------------

/**
 * 沒看到的牌（點數 1 到 10 各剩幾張）＝ 4 − 我看得到的張數（我的暗牌、雙方的明牌）。
 * 對手的暗牌混在裡面，所以這不是牌堆；只讀我自己的牌與公開的明牌，不讀牌堆、不讀 `incoming`。
 */
export function unseenCounts(state: H5State, side: Side): number[] {
  const counts = fullPool();
  const seen = [state.hole[side], ...state.up[0], ...state.up[1]];
  for (const card of seen) {
    if (card >= 1 && card <= RANKS) {
      counts[card - 1] = Math.max(0, (counts[card - 1] as number) - 1);
    }
  }
  return counts;
}

interface Replay {
  /** 假設對手的暗牌是 h，它這一手已經結束的每一輪選擇的似然。 */
  readonly likelihood: number;
  /** 這一輪開始時的總點數與張數。 */
  readonly total: number;
  readonly cards: number;
  readonly stood: boolean;
}

/** 假設對手暗牌是 `hole`，沿著公開的 log 走一遍。 */
function replayOpponent(state: H5State, opp: Side, hole: number, theta: number): Replay {
  const ups = state.up[opp];
  let total = hole + (ups[0] ?? 0);
  let cards = 2;
  let hits = 0;
  let stopped = false;
  let likelihood = 1;
  for (const round of state.log) {
    const move = round[opp];
    const forced = stopped || total > 21 || cards >= MAX_CARDS;
    if (forced) {
      if (move !== null) {
        return { likelihood: 0, total, cards, stood: true };
      }
      stopped = true;
      continue;
    }
    if (move === null) {
      return { likelihood: 0, total, cards, stood: false };
    }
    if (move === STOP) {
      likelihood *= stopProb(total, theta);
      stopped = true;
    } else {
      likelihood *= 1 - stopProb(total, theta);
      hits += 1;
      const drawn = ups[hits];
      if (drawn === undefined) {
        return { likelihood: 0, total, cards, stood: false };
      }
      total += drawn;
      cards += 1;
    }
  }
  const stood = stopped || total > 21 || cards >= MAX_CARDS;
  if (stood !== state.stood[opp]) {
    return { likelihood: 0, total, cards, stood };
  }
  return { likelihood, total, cards, stood };
}

/** 對手暗牌（點數 1 到 10）的後驗：先驗正比於沒看到的張數，再乘上它每一輪選擇的似然。只讀公開的資訊與我自己的牌。 */
export function holePosterior(state: H5State, side: Side): number[] {
  return posteriorWith(state, side, estimateTheta(state.past[otherSide(side)], state.model));
}

function posteriorWith(state: H5State, side: Side, theta: number): number[] {
  const opp = otherSide(side);
  const unseen = unseenCounts(state, side);
  const weights = unseen.map((n, i) =>
    n > 0 ? n * replayOpponent(state, opp, i + 1, theta).likelihood : 0,
  );
  let total = weights.reduce((a, b) => a + b, 0);
  if (total > 0) {
    return weights.map((w) => w / total);
  }
  // 不可能的紀錄（模型說機率 0）：退回只看沒看到的牌
  total = unseen.reduce((a, b) => a + b, 0);
  if (total > 0) {
    return unseen.map((n) => n / total);
  }
  return new Array<number>(RANKS).fill(1 / RANKS);
}

// ---------------------------------------------------------------------------
// 這一手的期望
// ---------------------------------------------------------------------------

/** 我最終總點數 `t`（超過 21 傳 22 以上）對上對手最終總點數分布 `final`（索引 22 是爆牌）的期望得分差。 */
function payoffAgainst(t: number, final: readonly number[]): number {
  const mine = t > 21 ? BUST : t;
  let expected = 0;
  for (let f = 0; f <= BUST; f += 1) {
    const p = final[f] as number;
    if (p === 0) {
      continue;
    }
    const [a, b] = settle(mine, f);
    expected += p * (a - b);
  }
  return expected;
}

/**
 * 我現在有 `cards` 張牌、總點數 `total`，對手的最終點數分布是 `final`（長度 23，索引 22 是爆牌），沒看到的牌是 `unseen`：
 * 現在停牌 `stop` 與現在要牌 `hit` 的期望得分差（要牌之後我取最好的：停或再要，直到滿 4 張）。
 * 對手的分布當作不受我之後的選擇影響（同時出手，之後的資訊忽略）。
 */
export function continuation(
  final: readonly number[],
  unseen: readonly number[],
  cards: number,
  total: number,
): { stop: number; hit: number } {
  const stopTable: number[] = [];
  for (let t = 0; t <= 21; t += 1) {
    stopTable.push(payoffAgainst(t, final));
  }
  const bustValue = payoffAgainst(BUST, final);
  const stopAt = (t: number): number => (t > 21 ? bustValue : (stopTable[t] as number));
  const counts = unseen.slice();

  const hitValue = (c: number, t: number): number => {
    const sum = counts.reduce((a, b) => a + b, 0);
    if (sum <= 0) {
      return stopAt(t);
    }
    let expected = 0;
    for (let v = 1; v <= RANKS; v += 1) {
      const n = counts[v - 1] as number;
      if (n <= 0) {
        continue;
      }
      const t2 = t + v;
      let value: number;
      if (t2 > 21) {
        value = bustValue;
      } else if (c + 1 >= MAX_CARDS) {
        value = stopAt(t2);
      } else {
        counts[v - 1] = n - 1;
        value = Math.max(stopAt(t2), hitValue(c + 1, t2));
        counts[v - 1] = n;
      }
      expected += (n / sum) * value;
    }
    return expected;
  };

  return {
    stop: stopAt(total),
    hit: total > 21 || cards >= MAX_CARDS ? stopAt(total) : hitValue(cards, total),
  };
}

/**
 * 對手最終總點數的分布（索引 22 是爆牌）。對手暗牌用後驗，它這一輪（還沒公開）要不要牌用門檻 `theta` 預測，
 * 之後的牌從沒看到的牌抽（忽略我同時抽走的）。
 */
function opponentFinal(state: H5State, side: Side, theta: number): number[] {
  const opp = otherSide(side);
  const unseen = unseenCounts(state, side);
  const unseenTotal = unseen.reduce((a, b) => a + b, 0);
  const draw = unseen.map((n) => (unseenTotal > 0 ? n / unseenTotal : 1 / RANKS));
  const posterior = posteriorWith(state, side, theta);

  // dist[cards][t]：對手有 cards 張牌、總點數 t（≤ 21）、現在要做決定時，最終點數的分布
  const memo = new Map<number, number[]>();
  const distFrom = (cards: number, t: number): number[] => {
    const key = cards * 100 + t;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const out = new Array<number>(BUST + 1).fill(0);
    const stop = stopProb(t, theta);
    out[t] = stop;
    const go = 1 - stop;
    for (let v = 1; v <= RANKS; v += 1) {
      const p = go * (draw[v - 1] as number);
      if (p === 0) {
        continue;
      }
      const t2 = t + v;
      if (t2 > 21) {
        out[BUST] = (out[BUST] as number) + p;
      } else if (cards + 1 >= MAX_CARDS) {
        out[t2] = (out[t2] as number) + p;
      } else {
        const next = distFrom(cards + 1, t2);
        for (let f = 0; f <= BUST; f += 1) {
          out[f] = (out[f] as number) + p * (next[f] as number);
        }
      }
    }
    memo.set(key, out);
    return out;
  };

  const final = new Array<number>(BUST + 1).fill(0);
  for (let h = 1; h <= RANKS; h += 1) {
    const weight = posterior[h - 1] as number;
    if (weight === 0) {
      continue;
    }
    const replay = replayOpponent(state, opp, h, theta);
    if (replay.stood || replay.likelihood === 0) {
      const f = replay.total > 21 ? BUST : replay.total;
      final[f] = (final[f] as number) + weight;
    } else {
      const dist = distFrom(replay.cards, replay.total);
      for (let f = 0; f <= BUST; f += 1) {
        final[f] = (final[f] as number) + weight * (dist[f] as number);
      }
    }
  }
  return final;
}

/**
 * 這一手的期望得分差（我減對手）：我這一輪選 `move`（停牌的人一律當作停牌），之後的選擇取最好；
 * 對手的暗牌用後驗、它的停牌門檻用 `theta`（預設是從它最近 3 手的紀錄估的）。
 * 只讀我自己的牌、公開的明牌與紀錄；不讀對手的暗牌、`pending`、`incoming`、牌堆。
 */
export function handValue(state: H5State, side: Side, move: Move, theta?: number): number {
  const opp = otherSide(side);
  const th = theta ?? estimateTheta(state.past[opp], state.model);
  const final = opponentFinal(state, side, th);
  const mine = state.up[side];
  const cards = 1 + mine.length;
  const total = totalOf(state.hole[side], mine);
  const values = continuation(final, unseenCounts(state, side), cards, total);
  return state.stood[side] || move === STOP ? values.stop : values.hit;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** 測試用：從「第 0 手、準備剛開始、比分 0:0」出發，用 overrides 覆蓋；牌堆預設依看得到的牌算出來。 */
export function makeState(overrides: Partial<H5State> = {}): H5State {
  const hole: readonly [number, number] = overrides.hole ?? [6, 7];
  const up: readonly [readonly number[], readonly number[]] = overrides.up ?? [[4], [5]];
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    hand: 0,
    round: 0,
    dealer: 0,
    pool: poolFromVisible(hole, up),
    hole,
    up,
    stood: [false, false],
    pending: [null, null],
    incoming: [null, null],
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    scores: [0, 0],
    log: [],
    last: null,
    past: [[], []],
    rng: 12345,
    model: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function winnerByScores(scores: readonly [number, number]): Side | null {
  if (scores[0] === scores[1]) {
    return null;
  }
  return scores[0] > scores[1] ? 0 : 1;
}

/** 按鍵 → 動作：b（停牌）優先，其次 a（要牌）；都沒按是 null。 */
function moveFromButtons(buttons: Buttons): Move | null {
  if (buttons.b) {
    return STOP;
  }
  return buttons.a ? HIT : null;
}

function stepChoose(state: H5State, inputs: Inputs, tick: number): H5State {
  const timeout = state.idle + 1 >= DECISION_TIMEOUT;
  const pending: (Move | null)[] = [state.pending[0], state.pending[1]];
  for (const side of [0, 1] as const) {
    if (state.stood[side]) {
      pending[side] = STOP;
    } else if (pending[side] === null) {
      const pressed = moveFromButtons(inputs[side]);
      if (pressed !== null) {
        pending[side] = pressed;
      } else if (timeout) {
        pending[side] = STOP;
      }
    }
  }
  const moved: H5State = {
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

/** 第 3 步：公開兩邊的選擇，要牌的人從共用牌堆領 1 張（領牌順序每手交替）。牌堆這時還不扣。 */
function reveal(state: H5State): H5State {
  const counts = state.pool.slice();
  let rng = state.rng;
  const incoming: (number | null)[] = [null, null];
  const order: readonly Side[] = state.dealer === 0 ? [0, 1] : [1, 0];
  for (const side of order) {
    if (state.pending[side] === HIT && !state.stood[side]) {
      if (counts.reduce((a, b) => a + b, 0) > 0) {
        const [card, next] = drawFrom(counts, rng);
        rng = next;
        incoming[side] = card;
      }
    }
  }
  return {
    ...state,
    phase: 'deal',
    wait: RESULT_TICKS,
    incoming: incoming as [number | null, number | null],
    rng,
  };
}

/** 公開後 30 tick：領到的牌併進明牌、牌堆扣掉；有人停牌、爆牌、滿 4 張就停牌；兩邊都停就攤牌，否則下一輪。 */
function merge(state: H5State): H5State {
  const up: [number[], number[]] = [state.up[0].slice(), state.up[1].slice()];
  const pool = state.pool.slice();
  for (const side of [0, 1] as const) {
    const card = state.incoming[side];
    if (card !== null) {
      up[side].push(card);
      pool[card - 1] = Math.max(0, (pool[card - 1] as number) - 1);
    }
  }
  const stood: [boolean, boolean] = [false, false];
  const moves: [Move | null, Move | null] = [null, null];
  for (const side of [0, 1] as const) {
    moves[side] = state.stood[side] ? null : state.pending[side];
    stood[side] =
      state.stood[side] ||
      state.pending[side] === STOP ||
      totalOf(state.hole[side], up[side]) > 21 ||
      1 + up[side].length >= MAX_CARDS;
  }
  const log = [...state.log, moves];
  const next: H5State = { ...state, up, pool, stood, log, incoming: [null, null] };
  if (stood[0] && stood[1]) {
    const totals: [number, number] = [totalOf(state.hole[0], up[0]), totalOf(state.hole[1], up[1])];
    return {
      ...next,
      phase: 'showdown',
      wait: RESULT_TICKS,
      pending: [STOP, STOP],
      last: {
        totals,
        delta: settle(totals[0], totals[1]),
        busted: [totals[0] > 21, totals[1] > 21],
      },
    };
  }
  return {
    ...next,
    round: state.round + 1,
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    pending: [stood[0] ? STOP : null, stood[1] ? STOP : null],
  };
}

/** 這一手 `side` 每一次決定時的總點數與選擇（攤牌之後才公開）。 */
function observationsOf(state: H5State, side: Side): PastObs[] {
  const out: PastObs[] = [];
  let hits = 0;
  for (const round of state.log) {
    const move = round[side];
    if (move === null) {
      continue;
    }
    out.push({ total: totalOf(state.hole[side], state.up[side].slice(0, 1 + hits)), move });
    if (move === HIT) {
      hits += 1;
    }
  }
  return out;
}

/** 入帳：比分更新、紀錄寫進 past、hand + 1。還沒進下一手。 */
function bankHand(state: H5State): H5State {
  const last = state.last;
  if (last === null) {
    return state;
  }
  const past: [readonly (readonly PastObs[])[], readonly (readonly PastObs[])[]] = [
    [...state.past[0], observationsOf(state, 0)].slice(-WINDOW),
    [...state.past[1], observationsOf(state, 1)].slice(-WINDOW),
  ];
  return {
    ...state,
    scores: [state.scores[0] + last.delta[0], state.scores[1] + last.delta[1]],
    past,
    hand: state.hand + 1,
    last: null,
  };
}

function finish(state: H5State): H5State {
  return { ...state, over: true, winner: winnerByScores(state.scores) };
}

/** 進下一手：領牌順序對調、重洗、重新發牌。 */
function startNextHand(state: H5State): H5State {
  const dealt = dealHand(state.rng);
  return {
    ...state,
    round: 0,
    dealer: otherSide(state.dealer),
    pool: dealt.pool,
    hole: dealt.hole,
    up: dealt.up,
    stood: [false, false],
    pending: [null, null],
    incoming: [null, null],
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    log: [],
    last: null,
    rng: dealt.rng,
  };
}

function stepH5(state: H5State, inputs: Inputs): H5State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: H5State;

  if (state.phase === 'prep') {
    after =
      state.wait <= 1
        ? { ...state, tick, phase: 'choose', wait: 0, idle: 0 }
        : { ...state, tick, wait: state.wait - 1 };
  } else if (state.phase === 'choose') {
    after = stepChoose(state, inputs, tick);
  } else if (state.phase === 'locked') {
    after = state.wait <= 1 ? reveal({ ...state, tick }) : { ...state, tick, wait: state.wait - 1 };
  } else if (state.phase === 'deal') {
    after = state.wait <= 1 ? merge({ ...state, tick }) : { ...state, tick, wait: state.wait - 1 };
  } else if (state.wait <= 1) {
    const banked = bankHand({ ...state, tick });
    after = banked.hand >= HANDS ? finish(banked) : startNextHand(banked);
  } else {
    after = { ...state, tick, wait: state.wait - 1 };
  }

  if (!after.over && tick >= state.maxTicks) {
    // 時間到：已經攤牌的先入帳；還在 choose、locked、deal 的這手不算。
    return finish(after.phase === 'showdown' ? bankHand(after) : after);
  }
  return after;
}

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);
/** 停牌（b）排第一：搜尋時模擬的對手按第一個，它是會推進結算的動作。 */
const CHOOSE_ACTIONS: readonly Buttons[] = Object.freeze([PRESS_B, PRESS_A]);

function actionsH5(state: H5State, side: Side): readonly Buttons[] {
  // 只看自己有沒有選、自己有沒有停牌，不看對手的 pending（不偷看）。
  if (
    !state.over &&
    state.phase === 'choose' &&
    !state.stood[side] &&
    state.pending[side] === null
  ) {
    return CHOOSE_ACTIONS;
  }
  return ONLY_IDLE;
}

/** 反射規則的小加分：我選的和「總點數 < 16 就要牌」一樣就加 HABIT。只讀我自己的牌與 pending。 */
function habitBonus(state: H5State, side: Side): number {
  const mine = state.pending[side];
  if (mine === null || state.stood[side]) {
    return 0;
  }
  return mine === reflexMove(totalOf(state.hole[side], state.up[side])) ? HABIT : 0;
}

function evaluateH5(state: H5State, side: Side): { gain: number; danger: number } {
  const diff = state.scores[side] - state.scores[otherSide(side)];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: diff + sign * END_BONUS, danger: 0 };
  }
  switch (state.phase) {
    case 'prep':
      return { gain: diff, danger: 0 };
    case 'choose':
    case 'locked':
      // 淺搜尋（深度 1、2）只走到這裡：不讀對手，只剩反射規則。
      return { gain: diff + habitBonus(state, side), danger: 0 };
    case 'deal':
    case 'showdown': {
      // 深度 3 以上走得到這裡。對「對手真的選了什麼、領到什麼牌、暗牌是什麼」目盲：
      // 不讀對手的 pending、不讀 incoming、不讀 last、不讀牌堆。
      const move = state.pending[side] ?? STOP;
      return { gain: diff + handValue(state, side, move), danger: 0 };
    }
  }
}

export const h5Game: Game<H5State> = {
  id: 'H-5',

  init(seed: number, config: GameConfig): H5State {
    const dealt = dealHand(rngStateFor(seed, 'deal'));
    return makeState({
      maxTicks: config.maxTicks,
      pool: dealt.pool,
      hole: dealt.hole,
      up: dealt.up,
      rng: dealt.rng,
      model: config.params['model'] !== 0,
    });
  },

  step(state: H5State, inputs: Inputs): H5State {
    return stepH5(state, inputs);
  },

  isOver(state: H5State): boolean {
    return state.over;
  },

  score(state: H5State): readonly [number, number] {
    return [state.scores[0], state.scores[1]];
  },

  winner(state: H5State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: H5State, side: Side): readonly Buttons[] {
    return actionsH5(state, side);
  },

  evaluate(state: H5State, side: Side): { gain: number; danger: number } {
    return evaluateH5(state, side);
  },
};
