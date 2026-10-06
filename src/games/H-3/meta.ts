import type { CardMeta } from '../types';

/** H-3 懸崖的 meta（SPEC 第 9、10 節）。 */
export const h3Meta: CardMeta = {
  id: 'H-3',
  name: '懸崖',
  description: '兩邊同時衝向懸崖，按下按鈕煞車，停得越靠近邊緣分數越高，衝出去就是零分。',
  controls: '按下 a（Z 或空白鍵）開始煞車，按下之後放開或再按都沒有作用；共五局。',
  suit: 'H',
  rank: '3',
  defaultPolicy: 'gambler',
  baseLevel: 1,
  symmetric: true,
  luckHeavy: true,
};
