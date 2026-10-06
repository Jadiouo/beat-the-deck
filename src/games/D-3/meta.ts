import type { CardMeta } from '../types';

/** D-3 會貶值的寶石的 meta（SPEC 第 9、10 節）。 */
export const d3Meta: CardMeta = {
  id: 'D-3',
  name: '會貶值的寶石',
  description: '寶石出現時值九分，每秒鐘貶值一分，最後消失；搶到的當下值多少就得多少分。',
  controls: '方向鍵或 WASD 移動，每 0.08 秒走一格；又大又亮的寶石比較值錢。',
  suit: 'D',
  rank: '3',
  defaultPolicy: 'greedy',
  baseLevel: 1,
  symmetric: true,
};
