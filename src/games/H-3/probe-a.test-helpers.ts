import { levelController, policyByName } from '../../ai/level';
import type { PolicyKey } from '../../ai/types';
import { playMatch } from '../../core/match';
import { intFrom, rngStateFor } from '../../core/rng';
import type { Buttons, Controller, GameConfig, Side } from '../../core/types';
import { outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { IsPoint, MatchOutcome, ProbeSpec } from '../../../tests/ai/probe-a.shared';
import { IDLE, PRESS_A } from '../_hearts/logic';
import { h3Game } from './logic';
import type { H3State } from './logic';
import { member, withDelay } from './probe-a.members.test-helpers';

/**
 * H-3 探針 A（完整版）的對局接線（`docs/cards/H-3.md`「探針 A（完整版）」）。
 * 成員在 `probe-a.members.test-helpers.ts`（那個檔案不准碰 AI）；這裡才把成員接上 AI 當對手。
 */

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };
/** AI 的種子 ＝ 玩家種子 ＋ 這個數（慣例同 D-10、S-10、D-Q、D-8、D-3）。 */
export const AI_SEED_OFFSET = 1_000_003;
/** 執行抖動的種子 ＝ 玩家種子 ＋ 這個數（(b)(c) 同一個種子吃同一串抖動）。 */
export const JITTER_SEED_OFFSET = 77;

/** 一格：AI 的性格、等級；玩家的反應延遲（tick）；玩家的執行抖動（0 ＝ 沒有，手永遠準）。 */
export interface Cell {
  readonly policy: PolicyKey;
  readonly level: number;
  readonly delay: number;
  readonly jitter: number;
}

/** 主格：AI 是 meta 的預設性格（賭徒型）等級 10；玩家延遲 12（和 AI 同一條線）；手永遠準。 */
export const MAIN_CELL: Cell = { policy: 'gambler', level: 10, delay: 12, jitter: 0 };

/**
 * 執行抖動：成員決定煞車之後，按鍵要晚 0 到 `jitter` 個 tick 才真的落下（每局抽一次，均勻），之後一直按著。
 * 這是敏感度分析用的玩家模型（人的手不是精準的）：沒有它，煞車點沒有任何不確定性，
 * 「精確煞在邊緣」永遠最佳，讀對手沒有可以改進的地方。抖動抽自 `rngStateFor(seed, 'jitter')`，決定性。
 */
export function withJitter(
  inner: Controller<H3State>,
  jitter: number,
  seed: number,
): Controller<H3State> {
  if (jitter <= 0) {
    return inner;
  }
  let dice = rngStateFor(seed, 'jitter');
  let round = -1;
  let due = -1;
  return {
    decide(state: H3State, side: Side, tick: number): Buttons {
      if (state.round !== round) {
        round = state.round;
        due = -1;
      }
      const wants = inner.decide(state, side, tick).a;
      if (due < 0 && wants) {
        const [lag, next] = intFrom(dice, jitter + 1);
        dice = next;
        due = tick + lag;
      }
      return due >= 0 && tick >= due ? PRESS_A : IDLE;
    },
  };
}

/** 玩家（`ctl`）對 AI 跑一場；偶數種子玩家坐 0 號邊，奇數種子坐 1 號邊。 */
export function playWith(seed: number, ctl: Controller<H3State>, at: Cell): MatchOutcome {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const ai = levelController(h3Game, policyByName(at.policy), at.level, seed + AI_SEED_OFFSET);
  const mine = withDelay(withJitter(ctl, at.jitter, seed + JITTER_SEED_OFFSET), at.delay);
  const result =
    side === 0
      ? playMatch(h3Game, seed, CONFIG, mine, ai)
      : playMatch(h3Game, seed, CONFIG, ai, mine);
  return outcomeOf(result, side);
}

/** H-3 的「一次決策」：我這一邊還在跑的每一個 tick，都是一次「現在煞車或再等」。 */
export const isPoint: IsPoint<H3State> = (state, side) =>
  !state.over && state.phase === 'run' && state.runners[side].status === 'running';

/** 把兩個成員接成一份 `ProbeSpec`。 */
export function spec(
  b: string,
  c: string,
  seeds: readonly number[],
  at: Cell,
  withPoint = true,
): ProbeSpec<H3State> {
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
