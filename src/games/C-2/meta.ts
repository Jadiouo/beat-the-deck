import type { CardMeta } from '../types';

/** C-2 旋轉的房間的 meta（SPEC 第 9、10 節）。 */
export const c2Meta: CardMeta = {
  id: 'C-2',
  name: '旋轉的房間',
  description: '規則和貪食蛇對決一樣，但你的畫面每十秒轉 90 度，轉之前邊框會閃。',
  controls: '方向鍵或 WASD 對應畫面上的上下左右（畫面轉了也一樣），不能直接掉頭。',
  suit: 'C',
  rank: '2',
  defaultPolicy: 'pathfinder',
  baseLevel: 1,
  symmetric: true,
  // 撞牆、撞身體：死的那條輸，活著的贏，不看分數（SPEC 第 10 節）。
  winnerNotByScore: true,
};
