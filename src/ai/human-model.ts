import type { Game } from '../core/types';
import { wrapPolicy } from './level';
import type { WrappedController } from './level';
import { pathfinder } from './policies/pathfinder';
import type { LevelParams, Policy } from './types';

/**
 * 人類模型（SPEC 7.3）：測試裡代替真人的控制器，不出現在遊戲裡。
 *
 * - 0.2 秒反應延遲：12 個 tick（60 tick 每秒）。
 * - 每 6 個 tick 才能換動作。
 * - 8% 的機率按錯：決定的時候有 8% 會改按「不是本來要按的」另一個動作。
 * - 只看一步：深度 1。
 *
 * 一個人在不知道這張牌「該怎麼玩」的時候，仍然會「抓高分、閃危險」，
 * 所以底層是搜尋型的一步版（`gain − w·danger` 選一步），而不是亂按。
 * 亂數由種子決定，同樣的種子每次都按出一樣的錯。
 */

export const HUMAN_PARAMS: LevelParams = {
  reactionTicks: 12,
  decideEvery: 6,
  depth: 1,
  epsilon: 0.08,
};

/** 人類模型底層用的決策方式。 */
export const humanPolicy: Policy = pathfinder;

export function humanModel<S>(game: Game<S>, seed: number): WrappedController<S> {
  return wrapPolicy(game, humanPolicy, HUMAN_PARAMS, seed, { avoidIntended: true });
}
