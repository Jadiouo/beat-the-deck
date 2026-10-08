import type { CardMeta } from '../types';

/** C-5 會動的牆的 meta（SPEC 第 9 節；小規格 `docs/cards/C-5.md`）。 */
export const c5Meta: CardMeta = {
  id: 'C-5',
  name: '會動的牆',
  description:
    '規則和貪食蛇對決一樣，但場上有四面會換位置的牆：換位置前一秒先閃出落點，落點裡有一顆金色誘餌，牆落下時還在裡面的蛇會被壓死。',
  controls:
    '方向鍵或 WASD 轉向，不能直接掉頭。閃爍的方框是一秒後會有牆落下的地方，金色菱形是誘餌（吃到加 2 分、長 2 格）；牆落下時身體還在方框裡就輸了。',
  suit: 'C',
  rank: '5',
  defaultPolicy: 'pathfinder',
  baseLevel: 2,
  symmetric: true,
  // 撞牆、撞身體、被壓死：死的那條輸，活著的贏，不看分數（沿用 C-A）。
  winnerNotByScore: true,
};
