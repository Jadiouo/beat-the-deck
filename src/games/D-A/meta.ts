import type { CardMeta } from '../types';

/** D-A 搶金幣的 meta（SPEC 第 9、10 節）。 */
export const dAMeta: CardMeta = {
  id: 'D-A',
  name: '搶金幣',
  description: '兩個角色在同一張有牆的地圖上搶金幣，走到就撿，六十秒內撿得多的贏。',
  controls: '方向鍵或 WASD 移動，每 0.08 秒走一格；朝牆走不動。',
  suit: 'D',
  rank: 'A',
  defaultPolicy: 'greedy',
  baseLevel: 1,
  symmetric: true,
};
