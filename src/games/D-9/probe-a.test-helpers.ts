import type { Controller, GameConfig, Side } from '../../core/types';
import { DEPOSITS, IDLE, PASS, d9Game, otherSide, projectDraws } from './logic';
import type { D9State, Round } from './logic';
import * as P from './players.test-helpers';

/**
 * D-9 探針 A（小規格十，10.2）。**(b)、(c) 兩族與選法在量之前固定**，量完不改。
 *
 * 這裡的玩家都只用公開資訊與自己的算術，不 import AI 的 `evaluate`、`predictOpponent`、`aiChoice`
 * （只有 `P.oracleBest` 用了 AI 的引擎，它是 (d) 上限，不進互動強度）。
 *
 * - (a) 不知道有對手：`q = 0`。
 * - (b) 知道有對手、不讀它的狀態：B1 到 B8（固定信念或不看對手的劇本），訓練種子上最強的是 (b*)。
 * - (c) 讀它的狀態：C1 到 C6（用對手的歷史），訓練種子上最強的是 (c*)。
 */

export type Belief = (state: D9State, side: Side) => number[];
export type Objective = 'own' | 'net';
export type Weights = readonly [number, number, number];

const EPS = 1e-9;
const FLAT: Weights = [1, 1, 1];

/** 我擺在 d 的邊際價值（我 − 對手的單位數），和「不擺、對手照信念擺」比；`q` 是對手挑每個礦脈的機率。 */
export function netScore(state: D9State, side: Side, d: number, q: readonly number[]): number {
  const stock = state.deposits[d]?.stock ?? 0;
  const ex = state.coll.filter((c) => c.dep === d).map((c) => ({ owner: c.owner, round: c.round }));
  const free = state.cap - ex.length;
  if (free < 1 || stock <= 0) {
    return 0;
  }
  const opp = otherSide(side);
  const me = { owner: side, round: state.round };
  const them = { owner: opp, round: state.round };
  const h = (240 / 30) * Math.max(0, state.rounds - state.round);
  const net = (set: readonly { owner: Side; round: number }[]): number => {
    const got = projectDraws(stock, set, h);
    return got[side] - got[opp];
  };
  const v0 = net(ex);
  const a = net([...ex, me]) - v0;
  const b = net([...ex, them]) - v0;
  let c = 0;
  if (free >= 2) {
    c = net([...ex, me, them]) - v0;
  } else if (state.contest === 1) {
    c = state.round % 2 === side ? a : b;
  }
  const qd = q[d] ?? 0;
  return (1 - qd) * a + qd * c - qd * b;
}

/** 決策規則：在還能擺的礦脈裡挑 `objective` 最大的；沒有正的就不擺。 */
export function planFrom(objective: Objective, belief: Belief): P.Plan {
  return (state, side) => {
    const q = belief(state, side);
    let best = PASS;
    let bestValue = 0;
    for (const d of P.livePool(state)) {
      const v = objective === 'own' ? P.ownEv(state, side, d, q) : netScore(state, side, d, q);
      if (v > bestValue + EPS) {
        best = d;
        bestValue = v;
      }
    }
    return best;
  };
}

export const aloneBelief: Belief = () => new Array<number>(DEPOSITS).fill(0);
export const priorBelief =
  (w: Weights): Belief =>
  (state) =>
    P.qFromRankWeights(state, w);
/** 數對手最近 `window` 輪各挑第幾名（1、2、3+ 三類），先驗權重 × 2 當平滑。 */
export const readingBelief =
  (window: number): Belief =>
  (state, side) => {
    const opp = otherSide(side);
    const w: [number, number, number] = [
      P.PRIOR_WEIGHTS[0] * 2,
      P.PRIOR_WEIGHTS[1] * 2,
      P.PRIOR_WEIGHTS[2] * 2,
    ];
    for (const h of state.history.slice(-window)) {
      const r = (h as Round).ranks[opp];
      if (r >= 1) {
        w[Math.min(r, 3) - 1] += 1;
      }
    }
    return P.qFromRankWeights(state, w);
  };

/** B8：名次 1 與名次 2 輪流亂挑（確定的偽亂數；不看對手）。 */
export const mixRank12: P.Plan = (state, side) => {
  const x = Math.imul(state.round * 2654435761 + side * 40503 + 977, 2246822519) >>> 0;
  return P.depositAtRank(state, (x >>> 7) % 2 === 0 ? 1 : 2);
};
/** C5：對手上一輪挑名次 1 就挑名次 2，否則挑名次 1（反著打）。 */
export const counterLast: P.Plan = (state, side) => {
  const last = state.history[state.history.length - 1];
  const r = last === undefined ? 0 : last.ranks[otherSide(side)];
  return P.depositAtRank(state, r === 1 ? 2 : 1);
};

export type Named = readonly [string, P.Plan];

export function familyB(fitted: Weights): Named[] {
  return [
    ['B1 自己收成·先驗.55/.30/.15（舊的 (b)）', planFrom('own', priorBelief(P.PRIOR_WEIGHTS))],
    ['B2 兩邊差·先驗.55/.30/.15', planFrom('net', priorBelief(P.PRIOR_WEIGHTS))],
    ['B3 兩邊差·平的信念', planFrom('net', priorBelief(FLAT))],
    ['B4 兩邊差·擬合的信念', planFrom('net', priorBelief(fitted))],
    ['B5 一直挑名次1', P.alwaysRank(1)],
    ['B6 一直挑名次2', P.alwaysRank(2)],
    ['B7 一直挑名次3', P.alwaysRank(3)],
    ['B8 名次1／2輪流亂挑', mixRank12],
    // B9：事後補上（第一輪量完才發現 B1 的先驗是錯的，B4 與讀的人目標不同）：和 C1 同一個目標（自己收成）、信念擬合。
    ['B9 自己收成·擬合的信念', planFrom('own', priorBelief(fitted))],
  ];
}
export function familyC(): Named[] {
  return [
    ['C1 自己收成·讀最近3輪（舊的 (c)）', planFrom('own', readingBelief(3))],
    ['C2 兩邊差·讀最近3輪', planFrom('net', readingBelief(3))],
    ['C3 兩邊差·讀最近1輪', planFrom('net', readingBelief(1))],
    ['C4 兩邊差·讀最近6輪', planFrom('net', readingBelief(6))],
    ['C5 反著打', counterLast],
    ['C6 跟風', P.copyLast],
  ];
}
export const PLAN_A: Named = ['(a) 不知道有對手（自己收成）', planFrom('own', aloneBelief)];
export const PLAN_A_NET: Named = ['(a) 不知道有對手（兩邊差）', planFrom('net', aloneBelief)];

/** place 開始後先閒置 `n` tick 才動（反應延遲）。 */
export function withDelay(inner: Controller<D9State>, n: number): Controller<D9State> {
  if (n <= 0) {
    return inner;
  }
  return {
    decide(state, side, tick) {
      if (state.phase === 'place' && state.idle < n) {
        return IDLE;
      }
      return inner.decide(state, side, tick);
    },
  };
}

export interface Played {
  /** 每場得分（我方）：1 贏、0.5 平、0 輸。 */
  readonly points: number[];
  /** 我方坐幾號邊。 */
  readonly seats: Side[];
  /** AI 每場作廢幾次、我方作廢幾次、兩邊都不擺的輪數。 */
  readonly aiVoids: number[];
  readonly myVoids: number[];
  readonly deadRounds: number[];
  readonly ticks: number[];
  /** AI 挑的名次平均。 */
  readonly aiRank: number[];
  /** 每場最後的分差（我 − AI，單位數）。 */
  readonly margins: number[];
}

export function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}
export function se(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) {
    return 0;
  }
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (n - 1);
  return Math.sqrt(v / n);
}

/** 跑一場：我方（劇本玩家）對 AI，回傳最後的 state；偶數種子我方坐 0 號邊。 */
export function runGame(
  plan: P.Plan,
  seed: number,
  config: GameConfig,
  delay = 0,
  opponent: P.Make = P.L10,
  observe?: (state: D9State, mine: Side) => void,
): { final: D9State; mine: Side } {
  const mine: Side = seed % 2 === 0 ? 0 : 1;
  const ai = opponent(seed + 1_000_003);
  const me = withDelay(P.scripted(plan), delay);
  let s = d9Game.init(seed, config);
  let t = 0;
  while (!s.over) {
    if (observe !== undefined && s.phase === 'place' && s.idle === 0 && s.pending[mine] === null) {
      observe(s, mine);
    }
    const km = P.copyButtons(me.decide(s, mine, t));
    const ka = P.copyButtons(ai.decide(s, otherSide(mine), t));
    s = d9Game.step(s, mine === 0 ? [km, ka] : [ka, km]);
    t += 1;
  }
  return { final: s, mine };
}

/** 我方（劇本玩家）對 L10 AI，種子 `seeds`，偶數種子我方坐 0 號邊。 */
export function play(
  plan: P.Plan,
  seeds: readonly number[],
  config: GameConfig,
  delay = 0,
  opponent: P.Make = P.L10,
): Played {
  const out: Played = {
    points: [],
    seats: [],
    aiVoids: [],
    myVoids: [],
    deadRounds: [],
    ticks: [],
    aiRank: [],
    margins: [],
  };
  for (const seed of seeds) {
    const { final: fin, mine } = runGame(plan, seed, config, delay, opponent);
    const ais = otherSide(mine);
    out.points.push(fin.winner === null ? 0.5 : fin.winner === mine ? 1 : 0);
    out.seats.push(mine);
    out.ticks.push(fin.tick);
    out.margins.push(fin.drawn[mine] - fin.drawn[ais]);
    out.aiVoids.push(fin.history.filter((h) => h.voided[ais]).length);
    out.myVoids.push(fin.history.filter((h) => h.voided[mine]).length);
    out.deadRounds.push(fin.history.filter((h) => h.picks[0] < 0 && h.picks[1] < 0).length);
    const rs = fin.history.map((h) => h.ranks[ais]).filter((x) => x >= 1);
    out.aiRank.push(rs.length === 0 ? 0 : mean(rs));
  }
  return out;
}

export interface Rate {
  readonly rate: number;
  readonly se: number;
  readonly n: number;
}
export const rateOf = (points: readonly number[]): Rate => ({
  rate: 100 * mean(points),
  se: 100 * se(points),
  n: points.length,
});
export const pick = (xs: readonly number[], seats: readonly Side[], seat: Side): number[] =>
  xs.filter((_x, i) => seats[i] === seat);

export interface Diff {
  readonly diff: number;
  readonly se: number;
  readonly z: number;
}
/** 兩個獨立勝率之差（保守：不用配對）。 */
export function diffOf(c: Rate, b: Rate): Diff {
  const d = c.rate - b.rate;
  const s = Math.sqrt(c.se * c.se + b.se * b.se);
  return { diff: d, se: s, z: s === 0 ? (d === 0 ? 0 : Infinity) : d / s };
}

/** 用 `plan` 打 AI，數 AI 挑的名次（1、2、3+）分佈；擬合 (b) 的信念用。 */
export function aiRankShare(
  plan: P.Plan,
  seeds: readonly number[],
  config: GameConfig,
  opponent: P.Make = P.L10,
): Weights {
  const count: [number, number, number] = [0, 0, 0];
  for (const seed of seeds) {
    const { final, mine } = runGame(plan, seed, config, 0, opponent);
    for (const h of final.history) {
      const r = h.ranks[otherSide(mine)];
      if (r >= 1) {
        const k = Math.min(r, 3) - 1;
        count[k] = (count[k] as number) + 1;
      }
    }
  }
  const total = count[0] + count[1] + count[2];
  return total === 0 ? P.PRIOR_WEIGHTS : [count[0] / total, count[1] / total, count[2] / total];
}

export interface Divergence {
  /** 對局數；其中 (b)、(c) 在同一個局面做出不同決定的場數。 */
  readonly games: number;
  readonly gamesDiffer: number;
  /** 決策點（每輪擺放開始一個）總數、有選項（至少一個能擺的礦脈）的決策點數、其中決定不同的數。 */
  readonly points: number;
  readonly livePoints: number;
  readonly pointsDiffer: number;
}

/**
 * 決策分歧率（前置檢查，S-6 紅方帶來的第四個陷阱）：在 (b)、(c) 兩邊各自對局時走到的每一個局面上，
 * 同時問 (b) 與 (c) 的計畫「你會挑哪個」，數不同的。局面相同，所以差別只來自策略有沒有用到對手的狀態。
 */
export function divergence(
  planB: P.Plan,
  planC: P.Plan,
  seeds: readonly number[],
  config: GameConfig,
  opponent: P.Make = P.L10,
): Divergence {
  let gamesDiffer = 0;
  let points = 0;
  let livePoints = 0;
  let pointsDiffer = 0;
  for (const seed of seeds) {
    let differ = false;
    for (const driver of [planB, planC]) {
      runGame(driver, seed, config, 0, opponent, (s, mine) => {
        points += 1;
        if (P.livePool(s).length > 0) {
          livePoints += 1;
        }
        if (planB(s, mine) !== planC(s, mine)) {
          pointsDiffer += 1;
          differ = true;
        }
      });
    }
    if (differ) {
      gamesDiffer += 1;
    }
  }
  return { games: seeds.length, gamesDiffer, points, livePoints, pointsDiffer };
}

/** 同種子配對的分差 (c) − (b)：平均與配對標準誤。 */
export function pairedMargin(
  c: readonly number[],
  b: readonly number[],
): { mean: number; se: number } {
  const d = c.map((x, i) => x - (b[i] as number));
  return { mean: mean(d), se: se(d) };
}
