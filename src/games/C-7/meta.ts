import type { CardMeta } from '../types';

/** C-7 縮水的 meta（SPEC 第 9 節；小規格 `docs/cards/C-7.md`）。 */
export const c7Meta: CardMeta = {
  id: 'C-7',
  name: '縮水',
  description:
    '貪食蛇對決，但蛇身每 0.67 秒縮短一格，短到 0 就餓死；場上永遠有兩顆食物，吃一顆長 5 格；按住 A 燒掉 2 格長度，這一次多走一格。',
  controls:
    '方向鍵或 WASD 轉向，不能直接掉頭。按住 A 衝刺：這一次多走一格、花 2 格長度，之後要等 0.5 秒。畫面上方的長條是長度，旁邊的小點亮著表示衝刺可用。',
  suit: 'C',
  rank: '7',
  defaultPolicy: 'pathfinder',
  baseLevel: 3,
  symmetric: true,
  // 撞死或餓死的那條輸，活著的贏，不看長度（沿用 C-A）；時間到才比長度。
  winnerNotByScore: true,
};
