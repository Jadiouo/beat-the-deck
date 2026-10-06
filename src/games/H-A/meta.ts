import type { CardMeta } from '../types';

/** H-A 貪心骰的 meta（SPEC 第 9、10 節）。 */
export const hAMeta: CardMeta = {
  id: 'H-A',
  name: '貪心骰',
  description: '輪流擲骰累積分數，擲到 1 這回合歸零，隨時可以存分，先到 50 分的贏。',
  controls: 'a（Z 或空白鍵）擲骰，b（X）存分；按住 a 只擲一次，放開再按才擲下一次。',
  suit: 'H',
  rank: 'A',
  defaultPolicy: 'gambler',
  baseLevel: 1,
  luckHeavy: true,
};
