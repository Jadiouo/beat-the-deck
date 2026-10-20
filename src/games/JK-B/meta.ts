import type { CardMeta } from '../types';

/**
 * JK-B 規則壞掉了的 meta（SPEC 第 9 節；小規格 `docs/cards/JK-B.md`）。
 * 鬼牌不跑 TEST_PLAN 第 5 節的 A1–A5（`runsAiChecks`），但這張牌有勝負，所以有預設性格（搜尋型）與基礎等級 4（比照 J、Q、K）。
 * 兩邊起始位置旋轉對稱、金幣共用、規則兩邊一樣：K12 會跑。
 */
export const jkbMeta: CardMeta = {
  id: 'JK-B',
  name: '規則壞掉了',
  description: '兩個點搶金幣，每 10 秒換一條壞掉的規則，下一條提早 3 秒亮出來；60 秒後分數高的贏。',
  controls:
    '方向鍵（或 WASD）走一格，按住連續走；走進對手就是推擠（推的人有冷卻，對手後面是牆就推不動）。畫面中央是現在的規則，換規則前 3 秒會亮出下一條。AI 看得到預告，也會先去布局，但它的布局方式是固定的習慣。',
  suit: 'JK',
  rank: 'B',
  defaultPolicy: 'pathfinder',
  baseLevel: 4,
  symmetric: true,
};
