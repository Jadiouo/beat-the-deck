import type { CardMeta } from '../types';

/** S-2 瞄準彈的 meta（SPEC 第 9、10 節）。 */
export const s2Meta: CardMeta = {
  id: 'S-2',
  name: '瞄準彈',
  description: '落雨之外，每 0.75 秒有一顆子彈瞄準你當下的位置飛來，被打中次數少的贏。',
  controls: '方向鍵或 WASD 八方向移動，按住 Z 或空白鍵慢速移動；瞄準彈只瞄準出現那一刻的位置。',
  suit: 'S',
  rank: '2',
  defaultPolicy: 'precise',
  baseLevel: 1,
  symmetric: true,
};
