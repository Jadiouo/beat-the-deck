import type { CardMeta } from '../types';

/** C-8 光軌的 meta（SPEC 第 9 節；小規格 `docs/cards/C-8.md`）。 */
export const c8Meta: CardMeta = {
  id: 'C-8',
  name: '光軌',
  description: '兩條蛇都在身後留下永遠不消失的牆，先撞到的輸這一局；60 秒內一局接一局，贏的局數多的贏。',
  controls:
    '方向鍵或 WASD 轉向，不能直接掉頭。走過的地方永遠是牆：把對手逼進死路，別讓自己被關起來。',
  suit: 'C',
  rank: '8',
  defaultPolicy: 'pathfinder',
  baseLevel: 3,
  // 每一局人的起始位置隨機、AI 是把它轉 180 度：兩邊遇到的局面等價（K12）。
  symmetric: true,
};
