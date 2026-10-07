import type { CardMeta } from '../types';

/** D-7 挖礦的 meta（SPEC 第 9 節；小規格 `docs/cards/D-7.md`）。 */
export const d7Meta: CardMeta = {
  id: 'D-7',
  name: '挖礦',
  description: '整張地圖是岩石，鑿穿的路兩人共用，礦要背回自己的基地才算分，六十秒後分高的贏。',
  controls:
    '方向鍵或 WASD 移動，每 0.08 秒一格；朝岩石按住方向就是鑿，背包最多 4 塊，走進自己的基地存分。',
  suit: 'D',
  rank: '7',
  defaultPolicy: 'greedy',
  baseLevel: 3,
  symmetric: true,
};
