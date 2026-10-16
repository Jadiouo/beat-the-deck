import type { CardMeta } from '../types';

/**
 * C-6 傳送門的 meta（SPEC 第 9 節；小規格 `docs/cards/C-6.md`）。
 * 探針 A 與其他量測數字寫在小規格；`CardMeta` 沒有放數字的欄位，而那是共用檔案。
 */
export const c6Meta: CardMeta = {
  id: 'C-6',
  name: '傳送門',
  description:
    '貪食蛇對決，但地圖中間隔著一道牆，兩對傳送門把兩邊接起來：蛇頭踩進門要在原地等半秒，出口先亮著倒數，然後從另一端冒出來；身體穿過門的時候，那一對門是堵住的。',
  controls:
    '方向鍵或 WASD 轉向，不能直接掉頭。圓環與菱形環是傳送門，形狀相同的兩個是一對；踩進去之後蛇停住半秒，閃爍的出口就是你冒出來的地方。出口被別人的身體占著，冒出來或進去的人就輸了。',
  suit: 'C',
  rank: '6',
  defaultPolicy: 'pathfinder',
  baseLevel: 2,
  symmetric: true,
  // 撞牆、撞身體、卡在出口：死的那條輸，活著的贏，不看分數（沿用 C-A）；時間到才比分數。
  winnerNotByScore: true,
};
