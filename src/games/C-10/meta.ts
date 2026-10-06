import type { CardMeta } from '../types';

/** C-10 追與逃的 meta（SPEC 第 9 節；小規格 `docs/cards/C-10.md`）。 */
export const c10Meta: CardMeta = {
  id: 'C-10',
  name: '追與逃',
  description: '一條蛇逃、一條蛇追，兩條一樣快，兩局交換角色；逃得越久、抓得越快，分數越高。',
  controls:
    '方向鍵或 WASD 轉向，不能直接掉頭。追的蛇每 0.4 秒瞄準一個點，畫面上有橘色記號：看看它瞄準的是哪裡。',
  suit: 'C',
  rank: '10',
  defaultPolicy: 'pathfinder',
  baseLevel: 3,
  // 第二局把第一局的起始位置轉 180 度，兩邊遇到的局面等價（K12）。
  symmetric: true,
};
