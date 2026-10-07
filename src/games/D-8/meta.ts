import type { CardMeta } from '../types';

/** D-8 塗地的 meta（SPEC 第 9 節；小規格 `docs/cards/D-8.md`）。 */
export const d8Meta: CardMeta = {
  id: 'D-8',
  name: '塗地',
  description:
    '走過的格子變成你的顏色，對手塗過的也能塗回來，圍起一小塊空地整塊歸你，六十秒後顏色多的贏。',
  controls: '方向鍵或 WASD 移動，每 0.08 秒走一格；走過的格子變成你的顏色，剛塗的一秒內塗不掉。',
  suit: 'D',
  rank: '8',
  defaultPolicy: 'greedy',
  baseLevel: 3,
  symmetric: true,
};
