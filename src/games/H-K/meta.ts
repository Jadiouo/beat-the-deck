import type { CardMeta } from '../types';

/**
 * H-K 紅心馬拉松的 meta（SPEC 第 9 節；小規格 `docs/cards/H-K.md`）。
 *
 * 這張牌是變化牌（DESIGN-AI-FUN 10.27）：加倍層整場只有 4 次決定，沒有自己的 AI 互動，
 * 互動借自被包的那些紅心牌；不要拿它和一般牌的互動強度比。量測數字見小規格
 * （`CardMeta` 沒有放探針數字的欄位，而那是共用檔案）。
 * `symmetric`：池裡每一張牌都對稱（H-A 的先後手不對稱，所以不收；見小規格「場次池」），兩邊的加倍牌與籌碼也對稱，K12 會跑。
 */
export const hkMeta: CardMeta = {
  id: 'H-K',
  name: '紅心馬拉松',
  description:
    '帶著同一筆籌碼連打四場縮短版的紅心牌，每場開打前暗中決定要不要用掉唯一的加倍牌，籌碼多的贏。這一層沒有自己的 AI 互動，互動借自被包的那幾張牌。',
  controls:
    '每場開打前：a（Z 或空白鍵）用掉加倍牌（這一場賭注加倍，兩邊都用變 3 倍）、b（X）不用；兩邊都選好才一起公開，最多想 2 秒，超時自動不用。每人整場只有一張加倍牌，用過就沒了，剩幾張是公開的。打牌時的操作就是那張牌自己的操作（畫面上方的小方塊是四場，亮的是現在這一場）；贏的人從輸的人手上拿走賭注。',
  suit: 'H',
  rank: 'K',
  defaultPolicy: 'pathfinder',
  baseLevel: 4,
  symmetric: true,
};
