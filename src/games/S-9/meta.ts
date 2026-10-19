import type { CardMeta } from '../types';

/** S-9 縮小的場地的 meta（SPEC 第 9 節；小規格 `docs/cards/S-9.md`）。 */
export const s9Meta: CardMeta = {
  id: 'S-9',
  name: '縮小的場地',
  description:
    '兩個人站在同一片地板上，踩過的格子 0.75 秒後掉下去，腳下的格子掉了就輸這一回合，三戰兩勝。',
  controls:
    '方向鍵或 WASD 八方向移動，按住 Z 或空白鍵慢走。站著不動格子也會掉：一格最多撐 0.75 秒，要一直走向還沒踩過的格子，並且把對手隔到比較小的一塊。',
  suit: 'S',
  rank: '9',
  defaultPolicy: 'precise',
  baseLevel: 3,
  // 起點與地板都轉 180 度對稱，動作順序也跟著轉：K12 會跑。
  symmetric: true,
  defaultMaxTicks: 4500,
};
