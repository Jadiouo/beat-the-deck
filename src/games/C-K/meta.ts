import type { CardMeta } from '../types';

/**
 * C-K 梅花馬拉松的 meta（SPEC 第 9 節；小規格 `docs/cards/C-K.md`）。
 *
 * 這張牌是變化牌（DESIGN-AI-FUN 10.27）：互動借自被包的牌（C-A、C-2、C-3、C-4），這一層沒有自己的 AI 互動。
 * 量測數字見小規格「實作與量測」（`CardMeta` 沒有放探針數字的欄位，而那是共用檔案）。
 */
export const ckMeta: CardMeta = {
  id: 'C-K',
  name: '梅花馬拉松',
  description:
    '一條蛇、一個分數跑完 60 秒：每 15 秒換一條疊加的規則（轉畫面、紅藍食物、霧），下一條在換之前 5 秒先亮出來。',
  controls:
    '方向鍵或 WASD 轉向，不能直接掉頭。上方四個小方塊是四段（亮的是現在、填滿的是跑完的）；快換段時中間亮出下一段的圖示與倒數條。轉畫面那一段，方向鍵照畫面上看到的方向。',
  suit: 'C',
  rank: 'K',
  defaultPolicy: 'pathfinder',
  baseLevel: 4,
  symmetric: true,
  // 撞牆、撞身體：死的那條輸，活著的贏，不看分數（沿用 C-A）。
  winnerNotByScore: true,
};
