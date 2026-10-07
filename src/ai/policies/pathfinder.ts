import type { Buttons, Game, Side } from '../../core/types';
import type { Policy, PolicyParams } from '../types';
import { SEARCH_BEAM, lookAhead, spreadOf } from './shared';
import type { Leaf } from './shared';

/**
 * 危險的權重 w：一個 danger = 1 的終點，要扣掉「候選終點 gain 範圍」的 2 倍。
 *
 * SPEC 7.1 的 `gain − w·danger` 把 gain 與 danger 直接相減，但 gain 的單位是每個遊戲自己定的
 * （「單位自訂但要單調」），固定的 w 在不知道單位的性格裡沒有意義。
 * 所以 w 乘上「這一層候選終點的 gain 範圍」（最大減最小；全部相同時用 1）：
 * 懲罰永遠與「最好與最壞的差距」成比例。w = 2 的意思是：死路（danger = 1）比最差的 gain 還要糟，
 * 所以 danger 接近 1 的路徑幾乎一定輸給安全的，但 danger 只有 0.05 的路徑只被輕輕扣分。
 */
export const PATHFINDER_W = 2;

/** 每一層最多保留幾個節點（束搜尋）。第一層一定保留所有第一步，其他層至少保留這麼多。 */
export const PATHFINDER_BEAM = SEARCH_BEAM;

/** 一層節點的分數：gain − w·scale·danger，scale 是這一層 gain 的範圍。 */
function scoreLayer<S>(nodes: readonly Leaf<S>[]): number[] {
  const spread = spreadOf(nodes.map((n) => n.gain));
  const scale = spread > 0 ? spread : 1;
  return nodes.map((n) => n.gain - PATHFINDER_W * scale * n.danger);
}

/**
 * 搜尋型（SPEC 7.1，♣ 梅花）：往前模擬 depth 步，選模擬終點 `gain − w·danger` 最高的第一步。
 *
 * - 我方每一步從 `actions()` 裡選（這才叫搜尋），對手在模擬裡維持不動（見 `opponentAction`）。
 * - 完整展開是 b^d：b = 5、d = 6 就是一萬多個 state，等級 10 的 `decide` 要在 1 毫秒內回答，做不到。
 *   所以用束搜尋：每一層只留分數最高的 max(b, 4) 個節點，總成本約 b · max(b, 4) · d 次 `step`。
 *   第一層一定保留所有第一步，所以每個第一步都至少被看過一次。
 * - 模擬到一半遊戲結束（`isOver`），那個節點就不再展開，直接當終點。
 * - 平手取第一步索引最小的；排序是穩定的，所以整個過程是決定性的。
 */
export const pathfinder: Policy = {
  name: 'pathfinder',
  decide<S>(game: Game<S>, state: S, side: Side, _tick: number, params: PolicyParams): Buttons {
    return lookAhead(game, state, side, params.depth, scoreLayer, PATHFINDER_BEAM);
  },
};
