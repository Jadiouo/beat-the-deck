import type { CardMeta } from '../types';

/** S-J 射手與靶的 meta（SPEC 第 9 節；小規格 `docs/cards/S-J.md`）。 */
export const sJMeta: CardMeta = {
  id: 'S-J',
  name: '射手與靶',
  description:
    '一邊在上緣射、一邊在場地裡躲，射手的彈藥有上限而且公開，兩局交換；射中得分，躲的人待在上半場也得分。',
  controls:
    '躲的時候：方向鍵或 WASD 八方向移動，按住 Z 或空白鍵慢速。射的時候：左右移動游標、按 Z 或空白鍵開火。左下角的小方塊是射手剩幾發：沒子彈的射手，是你衝進上半場的機會。',
  suit: 'S',
  rank: 'J',
  defaultPolicy: 'precise',
  baseLevel: 4,
  symmetric: true,
  reflexOnly: true,
};
