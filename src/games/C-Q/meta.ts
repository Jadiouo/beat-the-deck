import type { CardMeta } from '../types';

/**
 * C-Q 兩條蛇的 meta（SPEC 第 9 節；小規格 `docs/cards/C-Q.md`）。
 *
 * 探針 A 與其他量測的數字見小規格「實作與量測」（`CardMeta` 沒有放探針數字的欄位，而那是共用檔案）。
 */
export const cqMeta: CardMeta = {
  id: 'C-Q',
  name: '兩條蛇',
  description:
    '貪食蛇對決，每邊多一台僚機：按 A 放出，它慢慢飛向對手前方，碰到對手的蛇就鎖住牠的轉向 3 次走格。',
  controls:
    '方向鍵或 WASD 轉向，不能直接掉頭。按 A（Z／空白鍵）放出僚機，放完要等 8 秒；僚機會飛向橘色 X 記號（對手蛇頭直走 4 格之後的位置），碰到對手的蛇就鎖住牠的轉向。被鎖住時蛇會閃爍，只能直走。',
  suit: 'C',
  rank: 'Q',
  defaultPolicy: 'pathfinder',
  baseLevel: 4,
  symmetric: true,
  // 撞死的那條輸，活著的贏，不看分數（沿用 C-A）。
  winnerNotByScore: true,
};
