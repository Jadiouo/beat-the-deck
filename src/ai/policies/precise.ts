import type { Buttons, Game, Side } from '../../core/types';
import type { Policy, PolicyParams } from '../types';
import { lookAhead, ranksFrom } from './shared';
import type { Leaf } from './shared';

/**
 * 危險門檻。danger 是 0 到 1 的「接下來會不會死或被扣大分」，0.3 是「有三成以上的機會出事就不碰」。
 * 精準型是閃避專家，寧可保守：門檻太高它就變成貪心型。
 * 取 0.3 而不是 0.5，是因為多數遊戲的 danger 估計偏低（只算看得到的威脅）。
 */
export const PRECISE_DANGER_LIMIT = 0.3;

/**
 * 精準型的偏好：路徑上 danger 從頭到尾都沒超過門檻的（安全的）排在前面，安全的之間 gain 高的優先；
 * 全部都不安全時，最不危險的優先，一樣危險就看 gain。
 * 用路徑上的最大 danger（`peak`）而不是只看終點：深一點看的時候，半路撞上的也算撞上。
 * 一步時 `peak` 就是下一個 tick 的 danger，與只看一步的舊版完全相同。
 */
function preciseRanks<S>(leaves: readonly Leaf<S>[]): number[] {
  return ranksFrom(leaves, (a, b) => {
    const safeA = a.peak <= PRECISE_DANGER_LIMIT;
    const safeB = b.peak <= PRECISE_DANGER_LIMIT;
    if (safeA !== safeB) {
      return safeA ? -1 : 1;
    }
    if (!safeA && a.peak !== b.peak) {
      return a.peak - b.peak;
    }
    return b.gain - a.gain;
  });
}

/**
 * 精準型（SPEC 7.1，♠ 黑桃）：每個 tick 都重新決定（要多久換一次由等級的 decideEvery 管）。
 * 往前看 depth 步（束搜尋，見 `lookAhead`），先排除路徑上 danger 超過門檻的，剩下的選終點 gain 最高；
 * 如果每條路都超過門檻，退而選最不危險的（平手時 gain 高的優先）。
 * 平手一律取第一步索引最小的。depth 只改看多遠，不改「避險」這個偏好。
 */
export const precise: Policy = {
  name: 'precise',
  decide<S>(game: Game<S>, state: S, side: Side, _tick: number, params: PolicyParams): Buttons {
    return lookAhead(game, state, side, params.depth, preciseRanks);
  },
};
