import { levelController, policyByName } from '../../ai/level';
import type { PolicyKey } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { MatchResult } from '../../core/match';
import type { Controller, Side } from '../../core/types';
import { outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { IsPoint, MatchOutcome, ProbeSpec } from '../../../tests/ai/probe-a.shared';
import { MOVE_EVERY } from '../_diamonds/logic';
import { d4Game } from './logic';
import type { D4State } from './logic';
import { makeMember } from './probe-a.members.test-helpers';

/**
 * D-4 探針 A（完整版）的量測工具（`docs/cards/D-4.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.54、10.59、10.61）。
 * 只給測試與量測腳本用。族的成員在 `probe-a.members.test-helpers.ts`（不 import AI 的引擎）；
 * 這個檔案把成員接上真實的 AI 對局（AI 的引擎只在這裡出現，用來當對手與當 (d) 上限）。
 * 影子、分歧率、配對標準誤全部來自 `tests/ai/probe-a.shared.ts`，這裡不重寫。
 */

export interface Cell {
  readonly policy: PolicyKey;
  /** AI 的等級（1 到 10）。 */
  readonly level: number;
  /** 玩家讀對手的狀態時看舊畫面的 tick 數。 */
  readonly delay: 0 | 12;
}

/** 9 格：貪心／精準 × L7／L10 × 延遲 0／12，加貪心 L5 延遲 12（勝率貼頂、看分差）。 */
export const CELLS: readonly Cell[] = [
  ...(['greedy', 'precise'] as const).flatMap((policy) =>
    ([7, 10] as const).flatMap((level) =>
      ([0, 12] as const).map((delay): Cell => ({ policy, level, delay })),
    ),
  ),
  { policy: 'greedy', level: 5, delay: 12 },
];

/** 主格（量之前定）：預設性格貪心型 L7、延遲 12。 */
export const PRIMARY_CELL: Cell = { policy: 'greedy', level: 7, delay: 12 };

export const cellLabel = (c: Cell): string => `${c.policy} L${String(c.level)} D${String(c.delay)}`;

const CONFIG = { maxTicks: 3600, params: {} };
const AI_SEED_OFFSET = 1_000_003;
const ENGINE_SEED_OFFSET = 2_000_003;

/** 偶數種子玩家坐 0 號邊。 */
export const sideOf = (seed: number): Side => (seed % 2 === 0 ? 0 : 1);

/** 決策點：走格結算前的那個 tick（這一拍的方向鍵決定這一步往哪走）。 */
export const isSettlePoint: IsPoint<D4State> = (state) => (state.tick + 1) % MOVE_EVERY === 0;

/** (d) 上限：該格 AI 的同一個引擎當玩家（不是 (c)，只看上限與鏡像陷阱）。 */
export function engineController(cell: Cell, seed: number): Controller<D4State> {
  return levelController(d4Game, policyByName(cell.policy), cell.level, seed + ENGINE_SEED_OFFSET);
}

/** 名字 → 控制器：族的成員，或 `d-engine`。 */
export function controllerFor(name: string, seed: number, cell: Cell): Controller<D4State> {
  return name === 'd-engine' ? engineController(cell, seed) : makeMember(name, seed, cell.delay);
}

export interface PlayedWith extends MatchOutcome {
  readonly side: Side;
  readonly match: MatchResult;
}

/**
 * 用 `ctl` 當玩家跑一場。偶數種子坐 0 號邊；AI 是 `cell` 指定的性格與等級，種子是玩家種子 ＋ 1,000,003。
 */
export function playWith(seed: number, ctl: Controller<D4State>, cell: Cell): PlayedWith {
  const side = sideOf(seed);
  const ai = levelController(d4Game, policyByName(cell.policy), cell.level, seed + AI_SEED_OFFSET);
  const match =
    side === 0
      ? playMatch(d4Game, seed, CONFIG, ctl, ai)
      : playMatch(d4Game, seed, CONFIG, ai, ctl);
  return { side, match, ...outcomeOf(match, side) };
}

/** 探針 A 的規格（給 `compareBC`／`divergence`）：(b)、(c) 是成員的名字。 */
export function d4Spec(
  b: string,
  c: string,
  seeds: readonly number[],
  cell: Cell,
): ProbeSpec<D4State> {
  return {
    makeB: (seed) => controllerFor(b, seed, cell),
    makeC: (seed) => controllerFor(c, seed, cell),
    seeds,
    play: (seed, ctl) => playWith(seed, ctl, cell),
    isPoint: isSettlePoint,
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
