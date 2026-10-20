import { levelController, policyByName } from '../../ai/level';
import type { PolicyKey } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { MatchResult } from '../../core/match';
import type { Controller, Side } from '../../core/types';
import { outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { IsPoint, MatchOutcome, ProbeSpec } from '../../../tests/ai/probe-a.shared';
import { FAKE_TICKS, FEINTS, TWITCH_AFTER, TWITCH_PER_ROUND, s7Game } from './logic';
import type { S7State } from './logic';
import { makeMember } from './probe-a.members.test-helpers';

/**
 * S-7 探針 A（完整版）的量測工具（`docs/cards/S-7.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.54、10.59、10.61）。
 * 只給測試與量測腳本用。族的成員在 `probe-a.members.test-helpers.ts`（不 import AI 的引擎）；
 * 這個檔案把成員接上真實的 AI 對局（AI 的引擎只在這裡出現，用來當對手與當 (d) 上限）。
 * 影子、分歧率、配對標準誤全部來自 `tests/ai/probe-a.shared.ts`，這裡不重寫。
 */

export interface Cell {
  readonly policy: PolicyKey;
  /** AI 的等級（1 到 10）。 */
  readonly level: number;
  /** 玩家看舊畫面的 tick 數。 */
  readonly delay: 0 | 12;
}

/** 12 格：貪心 L3／L5／L7／L10 × 延遲 0／12，精準 L5／L10 × 延遲 0／12。 */
export const CELLS: readonly Cell[] = [
  ...([3, 5, 7, 10] as const).flatMap((level) =>
    ([0, 12] as const).map((delay): Cell => ({ policy: 'greedy', level, delay })),
  ),
  ...([5, 10] as const).flatMap((level) =>
    ([0, 12] as const).map((delay): Cell => ({ policy: 'precise', level, delay })),
  ),
];

/** 主格（量之前定）：預設性格貪心型 L5、玩家延遲 12（人類的處境）。 */
export const PRIMARY_CELL: Cell = { policy: 'greedy', level: 5, delay: 12 };

export const cellLabel = (c: Cell): string => `${c.policy} L${String(c.level)} D${String(c.delay)}`;

const CONFIG = { maxTicks: 3600, params: {} };
const AI_SEED_OFFSET = 1_000_003;
const ENGINE_SEED_OFFSET = 2_000_003;

/** 偶數種子玩家坐 0 號邊。 */
export const sideOf = (seed: number): Side => (seed % 2 === 0 ? 0 : 1);

/** 按或等的決策點：等待階段、光亮著、我還沒按、這道光不是我自己還沒亮滿的假光。 */
export const isPressPoint: IsPoint<S7State> = (state, side) =>
  state.phase === 'wait' &&
  state.press[side] === null &&
  state.flash !== null &&
  !(state.flash.makers[side] && state.flash.age < FAKE_TICKS);

/** 假動作的決策點：可以抽假動作的 tick（等待階段、沒有光、我還沒按、過了 90 tick、額度還有）。 */
export const isFeintPoint: IsPoint<S7State> = (state, side) =>
  state.phase === 'wait' &&
  state.press[side] === null &&
  state.flash === null &&
  state.elapsed >= TWITCH_AFTER &&
  state.twitches[side] < TWITCH_PER_ROUND &&
  state.spent[side] + state.twitches[side] < FEINTS;

/** (d) 上限：該格 AI 的同一個引擎當玩家（不是 (c)，只看上限與鏡像陷阱）。 */
export function engineController(cell: Cell, seed: number): Controller<S7State> {
  return levelController(s7Game, policyByName(cell.policy), cell.level, seed + ENGINE_SEED_OFFSET);
}

/** 名字 → 控制器：族的成員，或 `d-engine`。 */
export function controllerFor(name: string, seed: number, cell: Cell): Controller<S7State> {
  return name === 'd-engine' ? engineController(cell, seed) : makeMember(name, seed, cell.delay);
}

export interface PlayedWith extends MatchOutcome {
  readonly side: Side;
  readonly match: MatchResult;
}

/**
 * 用 `ctl` 當玩家跑一場。偶數種子坐 0 號邊；AI 是 `cell` 指定的性格與等級，種子是玩家種子 ＋ 1,000,003。
 */
export function playWith(seed: number, ctl: Controller<S7State>, cell: Cell): PlayedWith {
  const side = sideOf(seed);
  const ai = levelController(s7Game, policyByName(cell.policy), cell.level, seed + AI_SEED_OFFSET);
  const match =
    side === 0
      ? playMatch(s7Game, seed, CONFIG, ctl, ai)
      : playMatch(s7Game, seed, CONFIG, ai, ctl);
  return { side, match, ...outcomeOf(match, side) };
}

export type PointKind = 'press' | 'feint';

/** 探針 A 的規格（給 `compareBC`／`divergence`）：(b)、(c) 是成員的名字。 */
export function s7Spec(
  b: string,
  c: string,
  seeds: readonly number[],
  cell: Cell,
  point: PointKind = 'press',
): ProbeSpec<S7State> {
  return {
    makeB: (seed) => controllerFor(b, seed, cell),
    makeC: (seed) => controllerFor(c, seed, cell),
    seeds,
    play: (seed, ctl) => playWith(seed, ctl, cell),
    isPoint: point === 'press' ? isPressPoint : isFeintPoint,
  };
}

export interface TrainingRow {
  readonly name: string;
  readonly win: number;
  readonly margin: number;
}

/** 勝率高者；同勝率取分差高；再同取排在前面的。 */
export function selectBest(rows: readonly TrainingRow[]): string {
  let best = rows[0] as TrainingRow;
  for (const row of rows.slice(1)) {
    const dw = row.win - best.win;
    if (dw > 1e-9 || (Math.abs(dw) <= 1e-9 && row.margin - best.margin > 1e-9)) {
      best = row;
    }
  }
  return best.name;
}

/** 在訓練種子上跑每個成員（對該格的 AI），回傳勝率（百分點）與平均分差。 */
export function trainFamily(
  names: readonly string[],
  cell: Cell,
  seeds: readonly number[],
): TrainingRow[] {
  return names.map((name) => {
    const rs = seeds.map((seed) => playWith(seed, controllerFor(name, seed, cell), cell));
    const n = Math.max(1, rs.length);
    return {
      name,
      win: (100 * rs.reduce((a, r) => a + r.win, 0)) / n,
      margin: rs.reduce((a, r) => a + r.margin, 0) / n,
    };
  });
}
