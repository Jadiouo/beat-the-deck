import type { Buttons, Game, Side } from '../../core/types';
import type { Policy, PolicyParams } from '../types';
import { lookAhead, spreadOf } from './shared';

/** 風險偏好的基準值：領先或打平時，danger = 1 的動作效用加成 100%。 */
export const GAMBLER_R_BASE = 1;
/** 落後到「很多」時額外加上的偏好，r 的上限趨近 R_BASE + R_EXTRA = 4。 */
export const GAMBLER_R_EXTRA = 3;

/**
 * 賭徒型（SPEC 7.1，♥ 紅心）：用偏好風險的效用 `gain · (1 + r·danger)` 選動作，落後越多 r 越大。
 *
 * 兩個 SPEC 沒寫、我補的做法（都寫在回報裡）：
 * 1. gain 可以是負的（落後時 gain < 0），直接相乘會變成「落後時反而怕危險」，與賭徒相反。
 *    所以先把候選動作的 gain 平移成正數：`g' = gain − 最小 gain + 範圍`（範圍 = 最大減最小，全部相同時用 1），
 *    最差的動作 g' = 範圍、最好的 g' = 2 × 範圍。效用 = g'·(1 + r·danger) 永遠為正，danger 一定是加成。
 * 2. 「落後多少」要與這個遊戲的 gain 單位無關：behind = max(0, −目前的 gain)，
 *    r = R_BASE + R_EXTRA · behind / (behind + 範圍)。落後 0 時 r = 1；落後是候選動作差距的 9 倍時 r ≈ 3.7；趨近 4。
 *
 * 往前看 depth 步（束搜尋，見 `lookAhead`），在終點上用同樣的效用選第一步；depth 1 就是只看一步。
 * 「落後多少」永遠用現在這個 state 的 gain，不是終點的。平手取索引最小的。
 * depth 只改看多遠，不改「落後越多越敢賭」這個偏好。
 */
export const gambler: Policy = {
  name: 'gambler',
  decide<S>(game: Game<S>, state: S, side: Side, _tick: number, params: PolicyParams): Buttons {
    const behind = Math.max(0, -game.evaluate(state, side).gain);
    return lookAhead(game, state, side, params.depth, (leaves) => {
      const gains = leaves.map((leaf) => leaf.gain);
      const spread = spreadOf(gains);
      const scale = spread > 0 ? spread : 1;
      const floor = Math.min(...gains);
      const r = GAMBLER_R_BASE + (GAMBLER_R_EXTRA * behind) / (behind + scale);
      return leaves.map((leaf) => (leaf.gain - floor + scale) * (1 + r * leaf.danger));
    });
  },
};
