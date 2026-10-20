import type { CardSpec } from './engine';
import { setAt } from './engine';
import { defineSpec } from './specs.shared';

/**
 * 鬼牌。
 *
 * JK-R 一起亂畫（meta 宣告 `noWinner`）：沒有勝負、沒有 AI 控制器。三支 AI 筆（跟隨者、填充者、唱反調的）
 * 是寫在 `step` 裡的反應腳本，直接讀人的筆（位置、顏色、歷史）；`registry` 裡 side 1 只有一個動作。
 * 沒有「AI 的動作」可以比較，也沒有分數或領先可以反轉；人的筆對 AI 筆的影響是 `step` 的定義，不是 AI 的決策。
 * 所以這張牌不屬於這個篩檢能回答的問題：宣告 notScreenable。規格存在只是讓它也走同一套帳（comp 為空）。
 */
interface JkrWorld {
  readonly canvas: readonly string[];
}
export const JK_R: CardSpec = defineSpec<JkrWorld>('JK-R', {
  comp: () => [],
  legal: (s: JkrWorld) => (s.canvas.length === 240 ? null : '畫布列數不對'),
  teeth: (s: JkrWorld) => [{ name: '畫布列數不對', state: setAt(s, 'canvas', [] as string[]) }],
  notScreenable:
    '宣告 noWinner：沒有勝負也沒有 AI 控制器，三支 AI 筆是 step 裡寫死的反應腳本（直接讀人的筆），沒有「AI 的動作」可以比較',
});

export const JOKERS_SPECS: readonly CardSpec[] = [JK_R];
