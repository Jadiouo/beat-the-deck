import type { CardMeta } from '../types';

/** C-A 貪食蛇對決的 meta（SPEC 第 9、10 節）。 */
export const cAMeta: CardMeta = {
  id: 'C-A',
  name: '貪食蛇對決',
  description: '兩條蛇在同一張地圖上搶食物，撞牆或撞到身體就輸，六十秒內分數高的贏。',
  controls: '方向鍵或 WASD 轉向，不能直接掉頭。',
  suit: 'C',
  rank: 'A',
  defaultPolicy: 'pathfinder',
  baseLevel: 1,
  symmetric: true,
  // 撞牆、撞身體：死的那條輸，活著的贏，不看分數（SPEC 第 10 節）。
  winnerNotByScore: true,
};
