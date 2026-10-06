import type { CardMeta } from '../types';

/** H-2 引信的 meta（SPEC 第 9、10 節）。 */
export const h2Meta: CardMeta = {
  id: 'H-2',
  name: '引信',
  description: '兩邊同時按住按鈕累積分數，放開入袋；引信長度看不見，燒完就歸零，共五局。',
  controls: '按住 a 或 b（Z、X 或空白鍵）累積，放開入袋；每局開始後一秒內要先按下，否則這局 0 分。',
  suit: 'H',
  rank: '2',
  defaultPolicy: 'gambler',
  baseLevel: 1,
  symmetric: true,
  luckHeavy: true,
};
