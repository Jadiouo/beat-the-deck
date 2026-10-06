import type { CardMeta } from '../types';

/** H-Q 加碼的 meta（SPEC 第 9 節）。 */
export const hQMeta: CardMeta = {
  id: 'H-Q',
  name: '加碼',
  description:
    '十回合猜拳，賭注每回合加倍到 8，可以出拳、加碼或棄牌；AI 會讀你的習慣，讀準了才加碼，你可以跟、棄牌，或換一手騙它。',
  controls:
    '左 石頭、上 布、右 剪刀（按住 a〔Z〕再出拳是加碼）、b（X）棄牌；出手就不能改。AI 加碼時（人的牌位被橘框瞄準）按 a 跟、按 b 棄牌；畫面下方是 AI 對你下一手的預測與它的命中率。',
  suit: 'H',
  rank: 'Q',
  defaultPolicy: 'pathfinder',
  baseLevel: 4,
  symmetric: true,
  luckHeavy: true,
};
