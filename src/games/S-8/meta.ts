import type { CardMeta } from '../types';

/** S-8 掃射的 meta（SPEC 第 9、10 節；小規格 `docs/cards/S-8.md`）。 */
export const s8Meta: CardMeta = {
  id: 'S-8',
  name: '掃射',
  description:
    '光幕繞中心越轉越快，幕上只有一道窄縫；站在縫裡才安全、才得分，離中心越遠分越高，縫裡擠不下兩個人。',
  controls:
    '方向鍵或 WASD 八方向移動，按住 Z 或空白鍵慢速。站在縫裡每個瞬間都得分，離中心越遠分越高；縫轉走你就被打中扣分。兩個人互相是實心的，縫只容得下一前一後，外側的位置比較值錢。',
  suit: 'S',
  rank: '8',
  defaultPolicy: 'precise',
  baseLevel: 3,
  symmetric: true,
  defaultMaxTicks: 2700,
};
