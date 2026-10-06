import type { CardMeta } from '../types';

/** S-3 擦彈的 meta（SPEC 第 9、10 節）。 */
export const s3Meta: CardMeta = {
  id: 'S-3',
  name: '擦彈',
  description: '子彈同瞄準彈，擦身而過每顆得一分、被打中扣五分，六十秒內分數高的贏。',
  controls: '方向鍵或 WASD 八方向移動，按住 Z 或空白鍵慢速移動：靠近子彈但別被打到。',
  suit: 'S',
  rank: '3',
  defaultPolicy: 'precise',
  baseLevel: 1,
  symmetric: true,
};
