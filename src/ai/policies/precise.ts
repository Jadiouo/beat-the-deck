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
 * 例外：`params.stalled`（世界連續一陣子沒變）時不看門檻，直接選 gain 最高的，免得兩個精準型在
 * 「往前的那一步剛好超過門檻、其他都是不動」的局面互相僵持。
 */
export const precise: Policy = {
  name: 'precise',
  decide<S>(game: Game<S>, state: S, side: Side, _tick: number, params: PolicyParams): Buttons {
    const scored = lookOneStep(game, state, side);
    const actions = myActions(game, state, side);
    if (params.stalled === true) {
      // 僵局：世界已經好一陣子完全沒變。這時候 danger 門檻只會讓「安全」的選項全是原地不動，
      // 世界不變、決定不變，兩邊就永遠僵持。放下門檻，選 gain 最高的（平手取索引最小）。
      return actions[argMax(scored.map((s) => s.gain))] as Buttons;
    }
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
