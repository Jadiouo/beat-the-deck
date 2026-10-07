import type { CardMeta } from '../types';

/** S-5 乒乓的 meta（SPEC 第 9 節；小規格 `docs/cards/S-5.md`）。 */
export const s5Meta: CardMeta = {
  id: 'S-5',
  name: '乒乓',
  description:
    '兩塊有慣性的板子隔著球場對打，板子移動中擊球會給球加旋，球越打越快，先得 6 分的贏。',
  controls:
    '左右鍵（或 A、D）移動板子，按住 Z 或空白鍵慢速微調。板子有慣性：換方向要花一點時間。球落在板子的哪裡決定角度（中間直、邊緣斜）；板子正在移動時擊球，球會帶旋、彎向你移動的方向。對手的板子歪向哪邊，是它在猜你下一球打哪裡；底線旁的小點是雙方最近幾次回球的落點。',
  suit: 'S',
  rank: '5',
  defaultPolicy: 'precise',
  baseLevel: 2,
  symmetric: true,
  defaultMaxTicks: 5400,
};
