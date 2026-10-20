import type { CardMeta } from '../types';

/** S-6 節拍的 meta（SPEC 第 9 節；小規格 `docs/cards/S-6.md`）。 */
export const s6Meta: CardMeta = {
  id: 'S-6',
  name: '節拍',
  description:
    '對奏：雙方同時編一段 2 到 4 個音的節奏給對方，再各打對方的曲子；你出的曲子對方打得越爛你越得分，十回合。',
  controls:
    '方向鍵或 WASD 對應四條軌道。編曲時在游標經過的那一格按一下放一個音（至少隔一格）；對打時音符到線的 24 個 tick 內按住該軌。按住沒有音符的軌道會被扣分。',
  suit: 'S',
  rank: '6',
  defaultPolicy: 'precise',
  baseLevel: 2,
  // 兩邊的規則完全對稱：K12 會跑。
  symmetric: true,
  defaultMaxTicks: 3300,
};
