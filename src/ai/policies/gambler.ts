import type { Buttons, Game, Side } from '../../core/types';
import type { Policy, PolicyParams } from '../types';
import { argMax, lookOneStep, myActions, spreadOf } from './shared';

/** 風險偏好的基準值：領先或打平時，danger = 1 的動作效用加成 100%。 */
export const GAMBLER_R_BASE = 1;
/** 落後到「很多」時額外加上的偏好，r 的上限趨近 R_BASE + R_EXTRA = 4。 */
export const GAMBLER_R_EXTRA = 3;

/** danger 達到這個值就是「下一步必死」（SPEC 5.1：danger 0 到 1，1 是確定）。 */
export const CERTAIN_DEATH = 1;

/**
 * 賭徒型（SPEC 7.1，♥ 紅心）：用偏好風險的效用 `gain · (1 + r·danger)` 選動作，落後越多 r 越大。
 *
 * 三個 SPEC 沒寫、我補的做法（都寫在回報裡）：
 * 1. gain 可以是負的（落後時 gain < 0），直接相乘會變成「落後時反而怕危險」，與賭徒相反。
 *    所以先把候選動作的 gain 平移成正數：`g' = gain − 最小 gain + 範圍`（範圍 = 最大減最小，全部相同時用 1），
 *    最差的動作 g' = 範圍、最好的 g' = 2 × 範圍。效用 = g'·(1 + r·danger) 永遠為正。
 * 2. 「落後多少」要與這個遊戲的 gain 單位無關：behind = max(0, −目前的 gain)，
 *    r = R_BASE + R_EXTRA · behind / (behind + 範圍)。落後 0 時 r = 1；落後是候選動作差距的 9 倍時 r ≈ 3.7；趨近 4。
 * 3. 偏好風險只對「不確定」成立，對「確定會死」不成立（DESIGN-AI-FUN 10.46）。
 *    danger 同時裝了兩件事：結果不確定（0 到 1 之間）與下一步必死（= 1）。第 1 點讓 danger 永遠是加成，
 *    必死的動作於是拿到最大的加成，賭徒選的是牆（C-A 1.7 秒就撞死）。死亡不是風險，是確定的損失：
 *    只要還有一個不必死的動作，必死的動作就整個排除，再用上面的公式在剩下的動作裡選；
 *    所有動作都必死時沒有可賭的，直接選 gain 最高的。沒有必死動作時，結果與沒有這一條完全相同。
 *    （梅花的 `evaluateClubs` 因為搜尋型把 danger 限制在 0 到 1，改為在 gain 扣 10000，見 10.38；
 *    這裡是同一個概念在政策層的版本：直接排除，不靠 gain 的大小去壓。）
 *
 * 只看一步（與貪心型同樣的視野），平手取索引最小的。沒有任何計數器或外部狀態，同一個局面永遠同一個答案。
 */
export const gambler: Policy = {
  name: 'gambler',
  decide<S>(game: Game<S>, state: S, side: Side, _tick: number, _params: PolicyParams): Buttons {
    const all = lookOneStep(game, state, side);
    // 必死的動作不是風險，是確定的損失：還有活路就整個排除（全部必死時才一起比）。
    const alive = all.filter((s) => s.danger < CERTAIN_DEATH);
    const scored = alive.length > 0 ? alive : all;
    const gains = scored.map((s) => s.gain);
    const spread = spreadOf(gains);
    const scale = spread > 0 ? spread : 1;
    const floor = Math.min(...gains);
    const behind = Math.max(0, -game.evaluate(state, side).gain);
    const r = GAMBLER_R_BASE + (GAMBLER_R_EXTRA * behind) / (behind + scale);
    const utility = scored.map((s) =>
      alive.length > 0 ? (s.gain - floor + scale) * (1 + r * s.danger) : s.gain,
    );
    const chosen = scored[argMax(utility)] as { readonly index: number };
    return myActions(game, state, side)[chosen.index] as Buttons;
  },
};
