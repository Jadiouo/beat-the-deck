import type { CardMeta } from '../types';

/** D-10 輸送帶的 meta（SPEC 第 9 節；小規格 `docs/cards/D-10.md`）。 */
export const d10Meta: CardMeta = {
  id: 'D-10',
  name: '輸送帶',
  description:
    '地圖中央一圈輸送帶，貨沿著帶子慢慢流；你和 AI 在格子上搶著攔，誰先站到貨那一格誰拿走，同時到就摔壞；背包滿了要原地停一秒出貨。',
  controls:
    '方向鍵或 WASD 移動，每 0.08 秒走一格；站上貨所在的格子自動拿（背包重量上限 8）。按 X（b）原地出貨，停一秒不能動也不能拿。貨出現前一秒會先標出位置、重量與價值。',
  suit: 'D',
  rank: '10',
  defaultPolicy: 'precise',
  baseLevel: 3,
  symmetric: true,
};
