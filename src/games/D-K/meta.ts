import type { CardMeta } from '../types';

/**
 * D-K 方塊馬拉松的 meta（SPEC 第 9 節；小規格 `docs/cards/D-K.md`）。
 *
 * 這張牌是變化牌（DESIGN-AI-FUN 10.27）：互動借自被包的三張牌（D-8、D-3、D-J），
 * 但三條連結把段與段綁成同一個計分，所以它要過自己的原型關卡（見小規格）。
 * 量測數字見小規格「實作與量測」（`CardMeta` 沒有放探針數字的欄位，而那是共用檔案）。
 */
export const dKMeta: CardMeta = {
  id: 'D-K',
  name: '方塊馬拉松',
  description:
    '同一張地圖、同一個分數跑完 60 秒：先圈地，再搶會貶值的寶石，最後存金幣、偷對手的分。圈下的地盤在後兩段是寶石的紅利和不被偷的安全區。',
  controls:
    '方向鍵或 WASD 移動，每 0.08 秒走一格。上方是現在這一段的名稱與倒數，段與段之間有一秒過場、不能動。第一段走過的格子變成你的顏色；第二段站在自己顏色上撿寶石多得一半；第三段撿金幣走回基地存、貼著對手的基地待上一秒偷它的分，它站在自己顏色上就偷不到。',
  suit: 'D',
  rank: 'K',
  defaultPolicy: 'precise',
  baseLevel: 4,
  symmetric: true,
};
