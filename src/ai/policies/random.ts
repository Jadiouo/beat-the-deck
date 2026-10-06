import { intFrom, rngStateFor } from '../../core/rng';
import type { Buttons, Game, Side } from '../../core/types';
import type { Policy, PolicyParams } from '../types';
import { myActions } from './shared';

/**
 * 亂按（測試的基準線）：從 `actions()` 裡均勻亂挑一個。
 * 亂數由「種子＋邊＋tick」推導（`rngStateFor`），不存任何狀態，所以仍然是純的：
 * 同樣的種子、邊、tick 一定同一個答案，重播與 K1 的決定性都不會被它破壞。
 */
export const random: Policy = {
  name: 'random',
  decide<S>(game: Game<S>, state: S, side: Side, tick: number, params: PolicyParams): Buttons {
    const actions = myActions(game, state, side);
    const [index] = intFrom(rngStateFor(params.seed, `random-${side}-${tick}`), actions.length);
    return actions[index] as Buttons;
  },
};
