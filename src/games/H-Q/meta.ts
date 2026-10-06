import type { CardMeta } from '../types';

/** H-Q 加碼的 meta（SPEC 第 9 節）。 */
export const hQMeta: CardMeta = {
  id: 'H-Q',
  name: '加碼',
  description:
    '十回合猜拳，賭注每回合加倍到 8，可以出拳也可以棄牌；AI 會讀你的習慣，你也可以騙它。',
  controls:
    '左 石頭、上 布、右 剪刀、b（X）棄牌（付四分之三賭注）；出手就不能改，畫面下方是 AI 對你下一手的預測。',
  suit: 'H',
  rank: 'Q',
  defaultPolicy: 'pathfinder',
  baseLevel: 4,
  symmetric: true,
  luckHeavy: true,
};
