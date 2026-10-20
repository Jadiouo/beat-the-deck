import type { CardMeta } from '../types';

/**
 * S-K 黑桃馬拉松的 meta（SPEC 第 9 節；小規格 `docs/cards/S-K.md`）。
 *
 * 這張牌是變化牌（DESIGN-AI-FUN 10.27）：互動借自被包的牌，選牌層沒有自己的 AI 互動，也不宣稱有。
 * 量測數字見小規格「實作與量測」（`CardMeta` 沒有放探針數字的欄位，而那是共用檔案）。
 */
export const skMeta: CardMeta = {
  id: 'S-K',
  name: '黑桃馬拉松',
  description:
    '連打 5 段黑桃：前 4 段雙方輪流從 4 張候選牌挑一張來打，第 5 段固定是乒乓、分數加倍。互動來自被包的牌，選牌本身沒有自己的 AI 互動。',
  controls:
    '挑牌階段：方向鍵 ↑ ↓ ← → 對應畫面上的四張候選牌（輪到對方挑的時候你不能動）。打的時候：用被包的那張牌自己的操作。',
  suit: 'S',
  rank: 'K',
  defaultPolicy: 'precise',
  baseLevel: 4,
  symmetric: true,
  // 最壞 5130 tick；預設 5400（90 秒）。契約測試用 3600，各階段與衝刺按比例縮短（見 `SKState.pace`）。
  defaultMaxTicks: 5400,
};
