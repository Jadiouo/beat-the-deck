import type { CardMeta } from '../types';

/** D-2 背包上限的 meta（SPEC 第 9、10 節）。 */
export const d2Meta: CardMeta = {
  id: 'D-2',
  name: '背包上限',
  description: '撿到的金幣要放進背包，最多三枚，走回自己的基地才變成分數；時間到還在背包裡的不算。',
  controls: '方向鍵或 WASD 移動，每 0.08 秒走一格；背包滿了撿不起來，走回基地存分數。',
  suit: 'D',
  rank: '2',
  defaultPolicy: 'greedy',
  baseLevel: 1,
  symmetric: true,
};
