import type { CardMeta } from '../types';

/** D-J 小偷的 meta（SPEC 第 9 節；小規格 `docs/cards/D-J.md`）。 */
export const dJMeta: CardMeta = {
  id: 'D-J',
  name: '小偷',
  description:
    '撿金幣放進背包、走回基地才算分；貼近對手的基地待上半秒，就能偷走它已經存的 1 分，它在家就偷不了。',
  controls:
    '方向鍵或 WASD 移動，每 0.08 秒走一格；貼著對手的基地待著偷，它在自己基地附近就偷不到。',
  suit: 'D',
  rank: 'J',
  defaultPolicy: 'greedy',
  baseLevel: 4,
  symmetric: true,
};
