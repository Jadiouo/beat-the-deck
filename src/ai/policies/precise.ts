import type { Buttons, Game, Side } from '../../core/types';
import type { Policy, PolicyParams } from '../types';
import { argMax, lookOneStep, myActions } from './shared';

/**
 * 危險門檻。danger 是 0 到 1 的「接下來會不會死或被扣大分」，0.3 是「有三成以上的機會出事就不碰」。
 * 精準型是閃避專家，寧可保守：門檻太高它就變成貪心型。
 * 取 0.3 而不是 0.5，是因為多數遊戲的 danger 估計偏低（只算看得到的威脅）。
 */
export const PRECISE_DANGER_LIMIT = 0.3;

/**
 * 精準型（SPEC 7.1，♠ 黑桃）：每個 tick 都重新決定（要多久換一次由等級的 decideEvery 管）。
 * 先排除下一個 tick danger 超過門檻的動作，剩下的選 gain 最高的；
 * 如果每個動作都超過門檻，退而選 danger 最低的（平手時 gain 高的優先）。
 * 平手一律取索引最小的。
 */
export const precise: Policy = {
  name: 'precise',
  decide<S>(game: Game<S>, state: S, side: Side, _tick: number, _params: PolicyParams): Buttons {
    const scored = lookOneStep(game, state, side);
    const actions = myActions(game, state, side);
    const safe = scored.filter((s) => s.danger <= PRECISE_DANGER_LIMIT);
    if (safe.length > 0) {
      const best = safe[argMax(safe.map((s) => s.gain))];
      return actions[(best as (typeof safe)[number]).index] as Buttons;
    }
    // 全部都危險：最不危險的；一樣危險就看 gain。用「−danger」當主鍵，gain 當次鍵。
    let pick = scored[0] as (typeof scored)[number];
    for (const s of scored) {
      if (s.danger < pick.danger || (s.danger === pick.danger && s.gain > pick.gain)) {
        pick = s;
      }
    }
    return actions[pick.index] as Buttons;
  },
};
