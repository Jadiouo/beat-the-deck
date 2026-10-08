import type { CardMeta } from '../types';

/** D-4 電池的 meta（SPEC 第 9 節；小規格 `docs/cards/D-4.md`）。 */
export const d4Meta: CardMeta = {
  id: 'D-4',
  name: '電池',
  description:
    '搶金幣，但每走一格耗 1 電、沒電就動不了；場上有 4 個充電站，一次只有一個人能充，你站著的站對手就用不了。',
  controls: '方向鍵或 WASD 移動，每 0.08 秒走一格，每走一格耗 1 電；走到充電站上會自動充電。',
  suit: 'D',
  rank: '4',
  defaultPolicy: 'greedy',
  baseLevel: 2,
  symmetric: true,
};
