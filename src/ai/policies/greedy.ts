import type { Buttons, Game, Side } from '../../core/types';
import type { Policy, PolicyParams } from '../types';
import { lookAhead } from './shared';
import type { Leaf } from './shared';

function gains<S>(leaves: readonly Leaf<S>[]): number[] {
  return leaves.map((leaf) => leaf.gain);
}

/**
 * 貪心型（SPEC 7.1，♦ 方塊）：往前看 depth 步（束搜尋，見 `lookAhead`），選終點 gain 最高的第一步，
 * 完全不看 danger。depth 1 就是只看下一個 tick。
 * 平手取 `actions()` 裡索引最小的。depth 只改看多遠，不改「貪分」這個偏好。
 */
export const greedy: Policy = {
  name: 'greedy',
  decide<S>(game: Game<S>, state: S, side: Side, _tick: number, params: PolicyParams): Buttons {
    return lookAhead(game, state, side, params.depth, gains);
  },
};
