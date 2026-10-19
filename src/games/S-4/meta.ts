import type { CardMeta } from '../types';

/** S-4 打磚塊對決的 meta（SPEC 第 9 節；小規格 `docs/cards/S-4.md`）。 */
export const s4Meta: CardMeta = {
  id: 'S-4',
  name: '打磚塊對決',
  description:
    '兩塊板子隔著一面共用的磚牆，各打一顆球；磚算最後碰到球的那塊板子的分，炸彈磚整片消失，牆挖通之後球可以穿過去攻擊對方的底線。',
  controls:
    '左右鍵（或 A、D）移動板子，按住 Z 或空白鍵慢速微調。球落在板子的哪裡決定角度（中間直、邊緣斜）：邊緣擊球可以搶炸彈，但容易漏接。球穿過你的底線扣 2 分並重發；牆挖通一欄之後球會穿到對方那一半，被對方板子接住的球就歸對方。對手的球正往哪一欄飛，看球的直線就知道。',
  suit: 'S',
  rank: '4',
  defaultPolicy: 'precise',
  baseLevel: 2,
  symmetric: true,
  defaultMaxTicks: 3000,
};
