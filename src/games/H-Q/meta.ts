import type { CardMeta } from '../types';

/** H-Q 加碼的 meta（SPEC 第 9 節）。 */
export const hQMeta: CardMeta = {
  id: 'H-Q',
  name: '加碼',
  description:
    '十回合猜拳，賭注加倍；每人只有 2 次加碼，AI 讀你的習慣與你被加碼後的反應，讀準了才加碼。',
  controls:
    '左 石頭、上 布、右 剪刀（按住 a〔Z〕再出拳是加碼，每人每局 2 次）、b（X）棄牌；出手就不能改。AI 加碼時（人的牌位被橘框瞄準）按 a 跟、按 b 棄牌。畫面上方的小十字是雙方剩幾次加碼；下方左邊的三格訊號是 AI 對你的把握（不說它認為你出哪一手，你要自己推論），右邊是每回合 AI 的預測有沒有中與雙方出的拳。',
  suit: 'H',
  rank: 'Q',
  defaultPolicy: 'pathfinder',
  baseLevel: 4,
  symmetric: true,
  luckHeavy: true,
};
