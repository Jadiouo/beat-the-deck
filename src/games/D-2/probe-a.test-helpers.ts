import { levelController, policyByName } from '../../ai/level';
import type { PolicyKey } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { Controller, GameConfig, Side } from '../../core/types';
import { outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { IsPoint, MatchOutcome, ProbeSpec } from '../../../tests/ai/probe-a.shared';
import { MOVE_EVERY } from '../_diamonds/logic';
import { d2Game } from './logic';
import type { D2State } from './logic';
import { member, withDelay } from './probe-a.members.test-helpers';

/**
 * D-2 探針 A（完整版）的對局接線（`docs/cards/D-2.md`「探針 A（完整版）」）。
 * 成員在 `probe-a.members.test-helpers.ts`（那個檔案不准碰 AI）；這裡才把成員接上 AI 當對手。
 */

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };
/** AI 的種子 ＝ 玩家種子 ＋ 這個數（慣例同 D-10、S-10、D-Q、D-8）。 */
export const AI_SEED_OFFSET = 1_000_003;

/** 一格：AI 的性格、等級；玩家的反應延遲（tick）。 */
export interface Cell {
  readonly policy: PolicyKey;
  readonly level: number;
  readonly delay: number;
}

export const MAIN_CELL: Cell = { policy: 'precise', level: 10, delay: 12 };

/** 玩家（`ctl`）對 AI 跑一場；偶數種子玩家坐 0 號邊，奇數種子坐 1 號邊。 */
export function playWith(seed: number, ctl: Controller<D2State>, at: Cell): MatchOutcome {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const ai = levelController(d2Game, policyByName(at.policy), at.level, seed + AI_SEED_OFFSET);
  const mine = withDelay(ctl, at.delay);
  const result =
    side === 0
      ? playMatch(d2Game, seed, CONFIG, mine, ai)
      : playMatch(d2Game, seed, CONFIG, ai, mine);
  return outcomeOf(result, side);
}

/**
 * D-2 的「一次決策」：每個走格週期的最後一個 tick（`tick % 5 === 4`）。
 * 玩家每個 tick 都按方向，「最後按的算」，所以這一個 tick 按的鍵決定這一次走哪格；前 4 個 tick 只是同一個決定的預備。
 */
export const isPoint: IsPoint<D2State> = (state) => state.tick % MOVE_EVERY === MOVE_EVERY - 1;

/** 把兩個成員接成一份 `ProbeSpec`。 */
export function spec(
  b: string,
  c: string,
  seeds: readonly number[],
  at: Cell,
  withPoint = true,
): ProbeSpec<D2State> {
  return {
    makeB: () => member(b),
    makeC: () => member(c),
    seeds,
    play: (seed, ctl) => playWith(seed, ctl, at),
    isPoint: withPoint ? isPoint : undefined,
  };
}

export interface Row {
  readonly name: string;
  /** 勝率（0 到 1，和局 0.5）。 */
  readonly win: number;
  /** 平均分差（我方 − AI）。 */
  readonly margin: number;
}

/** 一個成員在一組種子上的勝率與平均分差。 */
export function score(name: string, seeds: readonly number[], at: Cell): Row {
  let win = 0;
  let margin = 0;
  for (const seed of seeds) {
    const o = playWith(seed, member(name), at);
    win += o.win;
    margin += o.margin;
  }
  return { name, win: win / seeds.length, margin: margin / seeds.length };
}

/**
 * 選最強的（量之前固定的規則）：勝率最高；同勝率取平均分差高的；再同就取表中靠前的。
 * 「同」比較的是 1e-9 以內，免得浮點誤差破平。
 */
export function selectBest(rows: readonly Row[]): Row {
  let best = rows[0] as Row;
  const eq = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
  for (const row of rows.slice(1)) {
    if (row.win > best.win + 1e-9 || (eq(row.win, best.win) && row.margin > best.margin + 1e-9)) {
      best = row;
    }
  }
  return best;
}
