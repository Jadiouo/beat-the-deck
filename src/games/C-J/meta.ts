import type { CardMeta } from '../types';

/** C-J 關卡設計師的 meta（SPEC 第 9 節；小規格 `docs/cards/C-J.md`）。 */
export const cJMeta: CardMeta = {
  id: 'C-J',
  name: '關卡設計師',
  description: '一個人控蛇、一個人在食物旁邊蓋牆，兩局交換；蛇吃到算蛇的分，時限到了算設計師的分。',
  controls:
    '當蛇：方向鍵或 WASD 轉向，不能直接掉頭，在時限內吃到食物。當設計師：上右下左＝在食物的上、右、下、左側蓋牆（閃爍的牆 0.75 秒後變硬，每次蓋完要等 1 秒）。',
  suit: 'C',
  rank: 'J',
  defaultPolicy: 'pathfinder',
  baseLevel: 4,
  // 第二局把蛇與食物轉 180 度、角色交換，兩邊遇到的局面等價（K12）。
  symmetric: true,
};
