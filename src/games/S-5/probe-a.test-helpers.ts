import { HUMAN_PARAMS } from '../../ai/human-model';
import { wrapPolicy } from '../../ai/level';
import type { Policy, PolicyParams, LevelParams } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import { outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { IsPoint, MatchOutcome, ProbeSpec } from '../../../tests/ai/probe-a.shared';
import {
  ACCEL,
  HIT_REACH,
  MAX_V,
  PADDLE_MAX_X,
  PADDLE_MIN_X,
  SLOW_V,
  START_X,
  predictArrival,
  s5Game,
  struck,
} from './logic';
import type { S5State } from './logic';
import { makeAi } from './probe-a.rival.test-helpers';

/**
 * S-5 乒乓的完整探針 A：(b) 族、(c) 族、格子、決策點（`docs/cards/S-5.md`「完整探針 A」；
 * DESIGN-AI-FUN 10.35、10.54、10.59、10.61）。這個檔案只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。
 *
 * 所有成員共用同一個「板子核心」（看球的落點、把板子移過去），只差一件事：**這一球要把球打到對方底線的哪裡**。
 * - (b)：知道對手存在（會讀我的回球習慣、會預先靠位），但**不讀對手的任何公開狀態**：
 *   板子位置、速度、按鍵、對手的回球習慣、對手的分數。只讀球、自己的板子、自己的回球習慣、自己的分數。
 * - (c)：讀對手板子的位置與速度（畫面上看得到的東西）。
 * 不 import 評估函式與對手預測函式，也不拿 AI 控制器當成員（來源掃描在 `probe-a.test.ts`）。
 * 核心用的物理（`predictArrival`、`struck`）是規則本身，不是 AI 的判斷。
 */

export const CONFIG = { maxTicks: 5400, params: {} };

/** 訓練種子與量測種子的起點。量測 0..N−1、訓練 TRAIN_FROM..；兩段不重疊（測試檢查）。 */
export const MEASURE_FROM = 0;
export const TRAIN_FROM = 20_000;

export const B_FAMILY = [
  'b-straight',
  'b-mid',
  'b-left',
  'b-right',
  'b-alt',
  'b-bait3',
  'b-rand',
  'b-speed-edge',
] as const;

export const C_FAMILY = ['c-away', 'c-stop', 'c-stop-wide', 'c-wrongfoot', 'c-lean-flip'] as const;

export type MemberName = (typeof B_FAMILY)[number] | (typeof C_FAMILY)[number];

// ---------------------------------------------------------------------------
// 格子（節奏 × 等級）
// ---------------------------------------------------------------------------

export type TempoName = 'T0' | 'G12' | 'T12';

/**
 * 玩家的節奏。T0＝零延遲（每個 tick 都決定、不亂按）；T12＝人類模型的參數（`HUMAN_PARAMS`：延遲 12、
 * 每 6 tick 決定、8% 亂按）；G12＝延遲 12 但勤快（每 3 tick 決定、2% 亂按，S-J 小規格的「好人類」）。
 */
export const TEMPOS: Readonly<Record<TempoName, LevelParams>> = {
  T0: { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0 },
  G12: { reactionTicks: 12, decideEvery: 3, depth: 1, epsilon: 0.02 },
  T12: HUMAN_PARAMS,
};

export interface Cell {
  readonly id: string;
  readonly tempo: TempoName;
  /** 被測的 AI（預設性格＝精準型）的等級。 */
  readonly level: number;
}

/** 掃描（只用 (b) 族）後選出的格子；選的理由在小規格。第一個是主格。 */
export const CELLS: readonly Cell[] = [
  { id: 'T12-L5', tempo: 'T12', level: 5 },
  { id: 'G12-L7', tempo: 'G12', level: 7 },
  { id: 'T0-L10', tempo: 'T0', level: 10 },
];

// ---------------------------------------------------------------------------
// 板子核心
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const other = (side: Side): Side => (side === 0 ? 1 : 0);

const R: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const KEYS: readonly Buttons[] = [
  R,
  { ...R, left: true },
  { ...R, right: true },
  { ...R, left: true, a: true },
  { ...R, right: true, a: true },
  { ...R, a: true },
];
const KEY_TARGET = [0, -MAX_V, MAX_V, -SLOW_V, SLOW_V, 0] as const;
const HOLDS = [3, 8, 16, 40] as const;

/** 板子照 `target` 按 `hold` 個 tick 然後放開，`ticks` 個 tick 之後的位置（與 `step` 的移動同一套算法）。 */
function paddleAfter(
  x0: number,
  v0: number,
  target: number,
  hold: number,
  ticks: number,
): { x: number; v: number } {
  let x = x0;
  let v = v0;
  for (let t = 1; t <= ticks; t += 1) {
    v += clamp((t <= hold ? target : 0) - v, -ACCEL, ACCEL);
    x += v;
    if (x < PADDLE_MIN_X) {
      x = PADDLE_MIN_X;
      v = 0;
    } else if (x > PADDLE_MAX_X) {
      x = PADDLE_MAX_X;
      v = 0;
    }
  }
  return { x, v };
}

/** 在 `ticks` 個 tick 內，板子最左、最右能到哪。 */
function reach(me: { x: number; vx: number }, ticks: number): { lo: number; hi: number } {
  return {
    lo: paddleAfter(me.x, me.vx, -MAX_V, ticks, ticks).x,
    hi: paddleAfter(me.x, me.vx, MAX_V, ticks, ticks).x,
  };
}

/** 六個按鍵裡挑一個、按一陣子（3、8、16、40 tick）之後放開，`ticks` 個 tick 後離 `goal` 最近的。 */
function moveTo(me: { x: number; vx: number }, goal: number, ticks: number): Buttons {
  let best = 0;
  let bestErr = Number.POSITIVE_INFINITY;
  for (let i = 0; i < KEYS.length; i += 1) {
    for (const hold of HOLDS) {
      const r = paddleAfter(me.x, me.vx, KEY_TARGET[i] ?? 0, hold, ticks);
      const err = Math.abs(r.x - goal);
      if (err < bestErr - 1e-9) {
        bestErr = err;
        best = i;
      }
    }
  }
  return KEYS[best] ?? R;
}

const LANDINGS = Array.from({ length: 19 }, (_v, i) => -0.9 + 0.1 * i);

/**
 * 要讓回球落在對方底線的 `target`，球該落在板子的哪個位置（−1 到 1）。
 * 用規則本身的物理（擊球角度、側牆反彈）掃一遍，取落點最接近的；板速當 0。
 */
function offsetFor(s: S5State, side: Side, hitX: number, target: number): number {
  let best = 0;
  let bestErr = Number.POSITIVE_INFINITY;
  for (const o of LANDINGS) {
    const back = struck(side, hitX, o * HIT_REACH, 0, s.ball.hits + 1);
    const a = predictArrival(back, other(side));
    if (a === null) {
      continue;
    }
    const err = Math.abs(a.x - target) + 0.001 * Math.abs(o);
    if (err < bestErr) {
      bestErr = err;
      best = o;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 成員：這一球要把球打到對方底線的哪個 x（null＝直接打回去，不特別選）
// ---------------------------------------------------------------------------

const LEFT_X = 20;
const RIGHT_X = 130;

/** 0 到 1 的雜湊亂數，由整數鍵決定（沒有時鐘、沒有 Math 的亂數）。 */
function hash01(...keys: number[]): number {
  let h = 0x811c9dc5;
  for (const k of keys) {
    h = Math.imul(h ^ (Math.round(k * 16) | 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
  }
  return ((h >>> 0) % 100_000) / 100_000;
}

const lastOf = (list: readonly number[]): number | undefined => list[list.length - 1];
const sideX = (lastLanding: number | undefined, defaultX: number): number =>
  lastLanding === undefined ? defaultX : lastLanding < START_X ? RIGHT_X : LEFT_X;

/** 對手板子「放開鍵之後會停在哪」（目前位置加上慣性的滑行）。 */
function stopPoint(p: { x: number; vx: number }): number {
  return clamp(p.x + (p.vx * Math.abs(p.vx)) / (2 * ACCEL), PADDLE_MIN_X, PADDLE_MAX_X);
}

/**
 * 成員想把這一球落在對方底線的哪個 x。回傳 null ＝ 直打。
 * (b) 成員只讀：球、自己的板子、自己的回球習慣 `habit[side]`、自己的分數。
 * (c) 成員另外讀對手板子的位置與速度。對手板子的 `target`（按鍵）畫面上看不到，成員不讀。
 */
export function chooseLanding(
  name: MemberName,
  s: S5State,
  side: Side,
  seed: number,
): number | null {
  const mine = s.habit[side];
  const last = lastOf(mine);
  switch (name) {
    case 'b-straight':
      return null;
    case 'b-mid':
      return START_X;
    case 'b-left':
      return LEFT_X;
    case 'b-right':
      return RIGHT_X;
    case 'b-alt':
      return sideX(last, RIGHT_X);
    case 'b-bait3': {
      // 連三球落左，第四球落右，再連三球落左……（看自己最近三次的落點）
      const lastThree = mine.slice(-3);
      return lastThree.length === 3 && lastThree.every((x) => x < START_X) ? RIGHT_X : LEFT_X;
    }
    case 'b-rand':
      return LEFT_X + (RIGHT_X - LEFT_X) * hash01(seed, last ?? -1, s.points[side], s.ball.hits);
    case 'b-speed-edge':
      return s.ball.hits < 4 ? null : sideX(last, RIGHT_X);
    case 'c-away': {
      const opp = s.paddles[other(side)];
      return opp.x < START_X ? RIGHT_X : LEFT_X;
    }
    case 'c-stop': {
      const stop = stopPoint(s.paddles[other(side)]);
      return stop < START_X ? RIGHT_X : LEFT_X;
    }
    case 'c-stop-wide': {
      const stop = stopPoint(s.paddles[other(side)]);
      return Math.abs(stop - START_X) < 10 ? null : stop < START_X ? RIGHT_X : LEFT_X;
    }
    case 'c-wrongfoot': {
      const opp = s.paddles[other(side)];
      return Math.abs(opp.vx) < 0.8 ? null : opp.vx > 0 ? LEFT_X : RIGHT_X;
    }
    case 'c-lean-flip': {
      // 對手板子歪離中央 18 以上就打到它的反側（它在猜我的習慣）；沒歪就照我上一球的那一側繼續養習慣。
      const opp = s.paddles[other(side)];
      if (Math.abs(opp.x - START_X) >= 18) {
        return opp.x < START_X ? RIGHT_X : LEFT_X;
      }
      return last === undefined ? LEFT_X : last < START_X ? LEFT_X : RIGHT_X;
    }
  }
}

/** 成員做成性格（給 `wrapPolicy`）。 */
export function memberPolicy(name: MemberName): Policy {
  return {
    name,
    decide<S>(_game: Game<S>, state: S, side: Side, _tick: number, params: PolicyParams): Buttons {
      const s = state as unknown as S5State;
      const me = s.paddles[side];
      if (s.phase !== 'play') {
        return moveTo(me, START_X, 30);
      }
      const toward = side === 0 ? s.ball.vy > 0 : s.ball.vy < 0;
      const arrival = toward ? predictArrival(s.ball, side) : null;
      if (arrival === null) {
        return moveTo(me, START_X, 30);
      }
      const landing = chooseLanding(name, s, side, params.seed);
      const o = landing === null ? 0 : offsetFor(s, side, arrival.x, landing);
      const span = reach(me, arrival.ticks);
      const lo = Math.max(span.lo, arrival.x - 0.95 * HIT_REACH);
      const hi = Math.min(span.hi, arrival.x + 0.95 * HIT_REACH);
      const wanted = arrival.x - o * HIT_REACH;
      const goal = lo <= hi ? clamp(wanted, lo, hi) : clamp(arrival.x, span.lo, span.hi);
      return moveTo(me, goal, arrival.ticks);
    },
  };
}

export function makePlayer(name: MemberName, tempo: TempoName, seed: number): Controller<S5State> {
  return wrapPolicy(s5Game, memberPolicy(name), TEMPOS[tempo], seed);
}

// ---------------------------------------------------------------------------
// 對局與探針規格
// ---------------------------------------------------------------------------

/** 玩家邊由種子奇偶輪流；AI 種子 ＝ 玩家種子 ＋ 1,000,003；回傳玩家這一邊的勝負與分差。 */
export function playCell(seed: number, ctl: Controller<S5State>, cell: Cell): MatchOutcome {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const ai = makeAi(cell.level, seed + 1_000_003);
  const result =
    side === 0
      ? playMatch(s5Game, seed, CONFIG, ctl, ai)
      : playMatch(s5Game, seed, CONFIG, ai, ctl);
  return outcomeOf(result, side);
}

/**
 * 決策點：球飛向我、還有 14 個 tick 到線（一次接球一個點）。
 * 這是「這一球要打哪裡」已經影響到板子該去哪裡的時刻；點級分歧率比的是這一刻的按鍵。
 */
export const isPoint: IsPoint<S5State> = (state, side) => {
  if (state.phase !== 'play') {
    return false;
  }
  const toward = side === 0 ? state.ball.vy > 0 : state.ball.vy < 0;
  return toward && predictArrival(state.ball, side)?.ticks === 14;
};

export function s5Spec(
  b: MemberName,
  c: MemberName,
  cell: Cell,
  seeds: readonly number[],
): ProbeSpec<S5State> {
  return {
    makeB: (seed) => makePlayer(b, cell.tempo, seed),
    makeC: (seed) => makePlayer(c, cell.tempo, seed),
    seeds,
    play: (seed, ctl) => playCell(seed, ctl, cell),
    isPoint,
  };
}

// ---------------------------------------------------------------------------
// 訓練與選法（10.54、10.61：(b\*)、(c\*) 在訓練種子上選，量測種子不碰）
// ---------------------------------------------------------------------------

export interface TrainingRow {
  readonly name: string;
  /** 勝率，百分點（和局算半場）。 */
  readonly win: number;
  /** 分差（我方 − 對方）的平均。 */
  readonly margin: number;
}

/** 每個成員單獨當玩家打這一格，在給定的種子上的勝率與分差。 */
export function trainTable(
  names: readonly MemberName[],
  cell: Cell,
  seeds: readonly number[],
): TrainingRow[] {
  return names.map((name) => {
    const outcomes = seeds.map((seed) => playCell(seed, makePlayer(name, cell.tempo, seed), cell));
    const n = Math.max(1, outcomes.length);
    return {
      name,
      win: (100 * outcomes.reduce((p, o) => p + o.win, 0)) / n,
      margin: outcomes.reduce((p, o) => p + o.margin, 0) / n,
    };
  });
}

/** 勝率高者；同勝率取分差高；再同取排在前面的。 */
export function selectBest(rows: readonly TrainingRow[]): string {
  let best = rows[0];
  if (best === undefined) {
    throw new Error('selectBest：沒有任何成員');
  }
  for (const row of rows.slice(1)) {
    const dw = row.win - best.win;
    if (dw > 1e-9 || (Math.abs(dw) <= 1e-9 && row.margin - best.margin > 1e-9)) {
      best = row;
    }
  }
  return best.name;
}
