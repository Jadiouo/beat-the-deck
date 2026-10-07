import type { CardMeta } from '../types';

/** C-4 霧的 meta（SPEC 第 9 節；小規格 `docs/cards/C-4.md`）。 */
export const c4Meta: CardMeta = {
  id: 'C-4',
  name: '霧',
  description:
    '規則和貪食蛇對決一樣，但兩條蛇都只看得到蛇頭附近 4 格；你有一個小雷達，AI 有好記性。',
  controls:
    '方向鍵或 WASD 轉向，不能直接掉頭。亮的那一圈是你看得到的範圍；右上角的雷達亮的時候，箭頭指向最近的食物。',
  suit: 'C',
  rank: '4',
  defaultPolicy: 'pathfinder',
  baseLevel: 2,
  symmetric: true,
  // 撞牆、撞身體：死的那條輸，活著的贏，不看分數（沿用 C-2）。
  winnerNotByScore: true,
};
