import type { CardMeta } from '../types';

/** S-A 落雨的 meta（SPEC 第 9、10 節）。 */
export const sAMeta: CardMeta = {
  id: 'S-A',
  name: '落雨',
  description: '各自在自己的場地裡躲同一場子彈雨，越下越密，六十秒內被打中次數少的贏。',
  controls: '方向鍵或 WASD 八方向移動，按住 Z 或空白鍵慢速移動；被打中後有一秒無敵。',
  suit: 'S',
  rank: 'A',
  defaultPolicy: 'precise',
  baseLevel: 1,
  symmetric: true,
};
