import type { CardMeta } from '../types';

/**
 * C-9 鑰匙與門的 meta（SPEC 第 9 節；小規格 `docs/cards/C-9.md`）。
 *
 * 探針 A 的數字與標籤見小規格「實作與量測」（`CardMeta` 沒有放探針數字的欄位，而那是共用檔案）。
 */
export const c9Meta: CardMeta = {
  id: 'C-9',
  name: '鑰匙與門',
  description:
    '迷宮裡有一把鑰匙、一扇門：叼著鑰匙走進門的得這一局 1 分，對手撞死也得 1 分；兩座迷宮各打兩次、交換起點，四局得分多的贏。',
  controls:
    '方向鍵或 WASD 轉向，不能直接掉頭。按了方向就記著，走到能轉的路口才轉；前面是牆會沿著通道自己轉彎。金色菱形是鑰匙，有框的方塊是門：叼著鑰匙才進得去門，沒有鑰匙進門會死。',
  suit: 'C',
  rank: '9',
  defaultPolicy: 'pathfinder',
  baseLevel: 3,
  // 每座迷宮打兩次、交換起點：兩邊遇到的局面等價（K12）。
  symmetric: true,
};
