import { levelController, wrapPolicy } from '../../ai/level';
import { precise } from '../../ai/policies/precise';
import type { WrappedController } from '../../ai/level';
import type { LevelParams } from '../../ai/types';
import { s5Game } from './logic';
import type { S5State } from './logic';

/**
 * S-5 探針 A 裡「被測的 AI」與「(d) 上限」（`docs/cards/S-5.md`「完整探針 A」）。
 *
 * 這個檔案故意和成員檔（`probe-a.test-helpers.ts`）分開：成員檔有來源掃描，不准出現 AI 的評估、
 * 對手預測與 AI 控制器（10.61 第二個陷阱）；而「被測的 AI」本來就是 AI 控制器，(d) 也是。
 * (d)＝用 AI 的引擎（精準型，與被測的 AI 同一個性格）當玩家，只當「如果 (c) 就是 AI 自己會到哪裡」的上限，
 * 不是 (c)，不進 (c) 族，也不用來選 (c\*)。
 */

/** 被測的 AI：預設性格（精準型）的某個等級。 */
export function makeAi(level: number, seed: number): WrappedController<S5State> {
  return levelController(s5Game, precise, level, seed);
}

/** (d)：AI 的引擎（精準型）照玩家的節奏（反應延遲、決定頻率、亂按）打。 */
export function makeUpperBound(params: LevelParams, seed: number): WrappedController<S5State> {
  return wrapPolicy(s5Game, precise, params, seed);
}
