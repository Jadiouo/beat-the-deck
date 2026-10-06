import type { Buttons, Game, Side } from '../../core/types';
import type { Policy, PolicyParams } from '../types';
import { argMax, lookOneStep, myActions } from './shared';

/**
 * 貪心型（SPEC 7.1，♦ 方塊）：只看一步，選下一個 tick gain 最高的動作，完全不看 danger。
 * 平手取 `actions()` 裡索引最小的。
 */
export const greedy: Policy = {
  name: 'greedy',
  decide<S>(game: Game<S>, state: S, side: Side, _tick: number, _params: PolicyParams): Buttons {
    const scored = lookOneStep(game, state, side);
    return myActions(game, state, side)[argMax(scored.map((s) => s.gain))] as Buttons;
  },
};
