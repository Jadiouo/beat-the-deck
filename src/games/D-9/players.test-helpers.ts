import { humanModel } from '../../ai/human-model';
import { levelController, wrapPolicy } from '../../ai/level';
import type { WrappedController } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { precise } from '../../ai/policies/precise';
import { pathfinder } from '../../ai/policies/pathfinder';
import { copyButtons, playMatch } from '../../core/match';
import type { Buttons, Controller, GameConfig, Side } from '../../core/types';
import {
  CAP,
  DEPOSITS,
  DRAW_EVERY,
  IDLE,
  KEY_LEFT,
  KEY_LOCK,
  KEY_PASS,
  KEY_RIGHT,
  PASS,
  RUN_TICKS,
  d9Game,
  otherSide,
  predictOpponent,
  projectDraws,
  ranksOf,
} from './logic';
import type { D9State, Round } from './logic';

/**
 * D-9 的劇本玩家與量測工具（DESIGN-AI-FUN 5.2、10.35、10.40、10.54）。都不是 `logic.ts`，不在純度掃描範圍。
 *
 * 劇本玩家是固定規則的 Controller：只看公開資訊（礦脈、採集器、歷史、自己的游標），place 一開始就出手
 * （沒有反應延遲，游標用跳的走過去）。除了明說是「同一個引擎」的 `engine`、`oracleBest`，都不用 AI 的 `evaluate`。
 *
 * 探針 A 的三組（對等級 10 的精準型，**定義在量之前固定**）。三組用同一條決策規則「挑自己期望收成最大的礦脈」
 * （`ownEv`：單位是自己往後抽到的單位數，對手的收成不算；與 AI 在 `zs = 0` 的評價同一個算術，但不是 AI 的程式），
 * 只差「怎麼想對手這一輪挑哪個」：
 * - (a) 不知道有對手：`planAlone`——把對手當作不存在（q = 0）。
 * - (b) 知道有對手、不讀它的狀態：`planKnowing`——用固定的先驗（名次 1 0.55、名次 2 0.30、其他 0.15），不看歷史。
 * - (c) 讀它的狀態：`planReading`——用「對手最近三輪各挑了第幾名」自己算頻率（人腦做得到：數一數），
 *   不是 AI 的 `predictOpponent`（AI 的版本有先驗與窗口），所以 (c) 不是鏡像。
 * 另外 (d) `oracleBest`：跑 AI 自己的引擎，算出 AI 這一輪會挑哪個，再回應（上限，不是玩家做得到的事）。
 */

export type Make = (seed: number) => Controller<D9State>;
export type Plan = (state: D9State, side: Side) => number;

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };

export function sameButtons(a: Buttons, b: Buttons): boolean {
  return (
    a.up === b.up &&
    a.down === b.down &&
    a.left === b.left &&
    a.right === b.right &&
    a.a === b.a &&
    a.b === b.b
  );
}

/** 游標走到目標再按 a；放開再按才算下一次跳，所以走的時候一個 tick 按、一個 tick 放。 */
function navigate(state: D9State, side: Side, target: number): Buttons {
  if (target === PASS) {
    return KEY_PASS;
  }
  const from = state.sel[side] as number;
  if (from === target) {
    return KEY_LOCK;
  }
  if ((state.jump[side] as number) > 0 || (state.dir[side] as number) !== 0) {
    return IDLE;
  }
  const forward = (target - from + DEPOSITS) % DEPOSITS;
  return forward <= DEPOSITS - forward ? KEY_RIGHT : KEY_LEFT;
}

/** 把計畫變成控制器：place 階段、自己還沒鎖定時往目標走。計畫只在還沒鎖定時問。 */
export function scripted(plan: Plan): Controller<D9State> {
  return {
    decide(state, side) {
      if (state.over || state.phase !== 'place' || state.pending[side] !== null) {
        return IDLE;
      }
      return navigate(state, side, plan(state, side));
    },
  };
}

export const S =
  (plan: Plan): Make =>
  () =>
    scripted(plan);

// ---------------------------------------------------------------------------
// 公開資訊的小工具
// ---------------------------------------------------------------------------

/** 名次 k（1 起算）的礦脈；不夠 k 個能擺的，取最後一個能擺的；一個都沒有回傳 `PASS`。 */
export function depositAtRank(state: D9State, k: number): number {
  const ranks = ranksOf(state);
  const live: number[] = [];
  for (let d = 0; d < DEPOSITS; d += 1) {
    const full = state.coll.filter((c) => c.dep === d).length >= CAP;
    if (!full && (state.deposits[d]?.stock ?? 0) > 0) {
      live.push(d);
    }
  }
  if (live.length === 0) {
    return PASS;
  }
  live.sort((a, b) => (ranks[a] as number) - (ranks[b] as number));
  return live[Math.min(k, live.length) - 1] as number;
}

function livePool(state: D9State): number[] {
  const live: number[] = [];
  for (let d = 0; d < DEPOSITS; d += 1) {
    const full = state.coll.filter((c) => c.dep === d).length >= CAP;
    if (!full && (state.deposits[d]?.stock ?? 0) > 0) {
      live.push(d);
    }
  }
  return live;
}

/** 剩下的抽取次數（從這一輪起）。 */
function horizonOf(state: D9State): number {
  return (RUN_TICKS / DRAW_EVERY) * Math.max(0, state.rounds - state.round);
}

/**
 * 我擺在 d 的期望收成（只算自己往後抽到的單位）：對手這一輪挑每個礦脈的機率是 q；
 * 對手也擺在 d 且空位夠 → 兩個一起採；空位只剩 1 → 兩個都作廢（0）。
 */
export function ownEv(state: D9State, side: Side, d: number, q: readonly number[]): number {
  const stock = state.deposits[d]?.stock ?? 0;
  const ex = state.coll.filter((c) => c.dep === d).map((c) => ({ owner: c.owner, round: c.round }));
  const free = CAP - ex.length;
  if (free < 1 || stock <= 0) {
    return 0;
  }
  const me = { owner: side, round: state.round };
  const them = { owner: otherSide(side), round: state.round };
  const h = horizonOf(state);
  const alone = projectDraws(stock, [...ex, me], h)[side];
  const shared = free >= 2 ? projectDraws(stock, [...ex, me, them], h)[side] : 0;
  const qd = q[d] ?? 0;
  return (1 - qd) * alone + qd * shared;
}

/** 對手挑每個礦脈的機率，用「名次的機率」映射到現在的礦脈上（rank1、rank2、其他三類）。 */
function qFromRankWeights(state: D9State, w: readonly [number, number, number]): number[] {
  const q = new Array<number>(DEPOSITS).fill(0);
  const live = livePool(state);
  if (live.length === 0) {
    return q;
  }
  const ranks = ranksOf(state);
  live.sort((a, b) => (ranks[a] as number) - (ranks[b] as number));
  const rest = live.length - 2;
  const total = w[0] + (live.length >= 2 ? w[1] : 0) + (rest > 0 ? w[2] : 0);
  q[live[0] as number] = w[0] / total;
  if (live.length >= 2) {
    q[live[1] as number] = w[1] / total;
  }
  for (let i = 2; i < live.length; i += 1) {
    q[live[i] as number] = w[2] / total / rest;
  }
  return q;
}

function argmaxEv(state: D9State, side: Side, q: readonly number[]): number {
  let best = PASS;
  let bestValue = 0;
  for (const d of livePool(state)) {
    const v = ownEv(state, side, d, q);
    if (v > bestValue + 1e-9) {
      best = d;
      bestValue = v;
    }
  }
  return best;
}

export const PRIOR_WEIGHTS: readonly [number, number, number] = [0.55, 0.3, 0.15];

/** (a) 不知道有對手：q = 0。 */
export const planAlone: Plan = (state, side) =>
  argmaxEv(state, side, new Array<number>(DEPOSITS).fill(0));
/** (b) 知道有對手、不讀它的狀態：固定先驗。 */
export const planKnowing: Plan = (state, side) =>
  argmaxEv(state, side, qFromRankWeights(state, PRIOR_WEIGHTS));
/** (c) 讀它的狀態：最近三輪對手各挑第幾名，數次數（各加先驗的 1 次當平滑）。 */
export const planReading: Plan = (state, side) => {
  const opp = otherSide(side);
  const w: [number, number, number] = [
    PRIOR_WEIGHTS[0] * 2,
    PRIOR_WEIGHTS[1] * 2,
    PRIOR_WEIGHTS[2] * 2,
  ];
  for (const h of state.history.slice(-3)) {
    const r = (h as Round).ranks[opp];
    if (r >= 1) {
      w[Math.min(r, 3) - 1] += 1;
    }
  }
  return argmaxEv(state, side, qFromRankWeights(state, w));
};

// ---------------------------------------------------------------------------
// 簡單劇本（找支配策略用）
// ---------------------------------------------------------------------------

export const alwaysRank =
  (k: number): Plan =>
  (state) =>
    depositAtRank(state, k);
export const alwaysFattest: Plan = alwaysRank(1);
export const alwaysSecond: Plan = alwaysRank(2);
export const alwaysThird: Plan = alwaysRank(3);
/** 一直挑能擺的礦脈裡存量最大的（不管有沒有採集器佔位）。 */
export const fattestStock: Plan = (state) => {
  let best = PASS;
  let value = 0;
  for (const d of livePool(state)) {
    const s = state.deposits[d]?.stock ?? 0;
    if (s > value) {
      best = d;
      value = s;
    }
  }
  return best;
};
/** 優先挑還沒有採集器的礦脈（不用分），裡面挑最肥的；沒有就挑最肥的。 */
export const emptyFirst: Plan = (state) => {
  const live = livePool(state).filter((d) => !state.coll.some((c) => c.dep === d));
  if (live.length === 0) {
    return depositAtRank(state, 1);
  }
  let best = live[0] as number;
  for (const d of live) {
    if ((state.deposits[d]?.stock ?? 0) > (state.deposits[best]?.stock ?? 0)) {
      best = d;
    }
  }
  return best;
};
/** 前 k 輪挑最肥（養習慣），之後一直挑第二肥（反打）。 */
export const habitThenSecond =
  (k: number): Plan =>
  (state) =>
    depositAtRank(state, state.round < k ? 1 : 2);
/** 前 k 輪挑第二肥，之後一直挑最肥。 */
export const secondThenFattest =
  (k: number): Plan =>
  (state) =>
    depositAtRank(state, state.round < k ? 2 : 1);
/** 跟風：這一輪挑對手上一輪挑的名次；第一輪挑最肥。 */
export const copyLast: Plan = (state, side) => {
  const last = state.history[state.history.length - 1];
  const r = last === undefined ? 1 : Math.max(1, last.ranks[otherSide(side)]);
  return depositAtRank(state, r);
};
/** 均勻亂選能擺的礦脈（確定的偽亂數：種子由輪數與已擺數決定）。 */
export const uniformLive: Plan = (state, side) => {
  const live = livePool(state);
  if (live.length === 0) {
    return PASS;
  }
  const x =
    Math.imul(
      state.round * 2654435761 + state.coll.length * 40503 + side * 977 + 12345,
      2246822519,
    ) >>> 0;
  return live[x % live.length] as number;
};
export const alwaysPass: Plan = () => PASS;

// ---------------------------------------------------------------------------
// AI 與消融（同一個引擎）
// ---------------------------------------------------------------------------

type Tweak = (state: D9State, side: Side) => D9State;

function withEvaluate(tweak: Tweak): typeof d9Game {
  return { ...d9Game, evaluate: (s, side) => d9Game.evaluate(tweak(s, side), side) };
}

const GAMES = {
  reads: d9Game,
  /** (b)：不讀對手的歷史（`model` 關掉，用先驗）。 */
  noModel: withEvaluate((s) => ({ ...s, model: false })),
  /** 拿掉歷史。 */
  hideHistory: withEvaluate((s) => ({ ...s, history: [] })),
} as const;

export type EngineKind = keyof typeof GAMES;

export type PolicyKind = 'precise' | 'pathfinder' | 'greedy' | 'gambler';
const POLICY_OF = { precise, pathfinder, greedy, gambler } as const;

export function engine(kind: EngineKind, level = 10, policy: PolicyKind = 'precise'): Make {
  return (seed) => levelController(GAMES[kind], POLICY_OF[policy], level, seed);
}

export const L10 = engine('reads', 10);
export const HUMAN: Make = (seed) => humanModel(d9Game, seed);

/** 沒有反應延遲、沒有失誤的 AI（量「決定」用）。 */
export function instantAi(
  seed: number,
  name: 'precise' | 'pathfinder' = 'precise',
): WrappedController<D9State> {
  return wrapPolicy(
    d9Game,
    name === 'precise' ? precise : pathfinder,
    { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0 },
    seed,
  );
}

/**
 * AI（`side`）在這個局面會鎖定哪個礦脈（`PASS` 是不擺）：用真的控制器（沒有延遲、沒有失誤）一個 tick 一個 tick 跑，
 * 對手不動，直到它鎖定。局面必須是 place 而且 `side` 還沒鎖定。
 */
export function aiChoice(
  state: D9State,
  side: Side = 1,
  name: PolicyKind = 'precise',
  game: typeof d9Game = d9Game,
): number {
  const c = wrapPolicy(
    game,
    POLICY_OF[name],
    { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0 },
    7,
  );
  let s = state;
  for (let t = 0; t < 200 && s.phase === 'place'; t += 1) {
    const key = c.decide(s, side, t);
    s = d9Game.step(s, side === 1 ? [IDLE, key] : [key, IDLE]);
    const p = s.pending[side];
    if (p !== null) {
      return p;
    }
  }
  return PASS;
}

/** (d) 上限：算出 AI 這一輪會挑哪個，再挑「對這個挑法」收成差最大的礦脈。 */
export const oracleBest: Plan = (state, side) => {
  const opp = otherSide(side);
  const theirs = aiChoice(state, opp);
  const h = horizonOf(state);
  const me = { owner: side, round: state.round };
  const them = { owner: opp, round: state.round };
  const exOf = (j: number) =>
    state.coll.filter((c) => c.dep === j).map((c) => ({ owner: c.owner, round: c.round }));
  const ranks = ranksOf(state);
  const candidates = livePool(state).sort((a, b) => (ranks[a] as number) - (ranks[b] as number));
  let best = PASS;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const d of candidates) {
    // 淨收成（我 − 對手）：我擺在 d；對手擺在 theirs（空位不夠就作廢）。
    let net = 0;
    for (let j = 0; j < DEPOSITS; j += 1) {
      const sj = state.deposits[j]?.stock ?? 0;
      const exj = exOf(j);
      const free = CAP - exj.length;
      const wantMe = j === d;
      const wantThem = j === theirs;
      const req = (wantMe ? 1 : 0) + (wantThem ? 1 : 0);
      const set = [...exj];
      if (req > 0 && req <= free) {
        if (wantMe) {
          set.push(me);
        }
        if (wantThem) {
          set.push(them);
        }
      }
      const before = projectDraws(sj, exj, h);
      const after = projectDraws(sj, set, h);
      net += after[side] - before[side] - (after[opp] - before[opp]);
    }
    if (net > bestValue + 1e-9) {
      best = d;
      bestValue = net;
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// 對打
// ---------------------------------------------------------------------------

export interface Batch {
  /** A 的勝率（平手算半場）。 */
  readonly rate: number;
  /** A 平均分數 − B 平均分數。 */
  readonly diff: number;
  readonly scoreA: number;
  readonly scoreB: number;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  /** 每場的 tick 數。 */
  readonly ticks: readonly number[];
}

/** A 對 B，種子 `seeds`；偶數種子 A 坐 0 號邊（邊輪流）。 */
export function batch(
  a: Make,
  b: Make,
  seeds: readonly number[],
  config: GameConfig = CONFIG,
): Batch {
  let points = 0;
  let scoreA = 0;
  let scoreB = 0;
  let wins = 0;
  let ties = 0;
  let losses = 0;
  const ticks: number[] = [];
  for (const seed of seeds) {
    const sideA: Side = seed % 2 === 0 ? 0 : 1;
    const ca = a(seed);
    const cb = b(seed + 1_000_003);
    const r =
      sideA === 0
        ? playMatch(d9Game, seed, config, ca, cb)
        : playMatch(d9Game, seed, config, cb, ca);
    const point = r.winner === null ? 0.5 : r.winner === sideA ? 1 : 0;
    points += point;
    scoreA += r.score[sideA];
    scoreB += r.score[otherSide(sideA)];
    ticks.push(r.ticks);
    if (point === 1) {
      wins += 1;
    } else if (point === 0) {
      losses += 1;
    } else {
      ties += 1;
    }
  }
  const n = seeds.length;
  return {
    rate: points / n,
    diff: (scoreA - scoreB) / n,
    scoreA: scoreA / n,
    scoreB: scoreB / n,
    wins,
    ties,
    losses,
    ticks,
  };
}

export const seeds = (n: number, from = 0): number[] =>
  Array.from({ length: n }, (_v, i) => from + i);

export { copyButtons, predictOpponent };
