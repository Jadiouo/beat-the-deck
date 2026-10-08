import type { CardMeta } from '../types';

/** D-5 送貨的 meta（SPEC 第 9 節；小規格 `docs/cards/D-5.md`）。 */
export const d5Meta: CardMeta = {
  id: 'D-5',
  name: '送貨',
  description:
    '三種顏色的包裹與三個同色的倉庫，一次背一件、送到同色倉庫得分（越遠越值錢）；倉庫收一件貨要休息 2.5 秒，休息中誰都送不進去。',
  controls:
    '方向鍵或 WASD 移動，每 0.08 秒走一格；走到包裹自動撿起（一次只能背一件，不能丟），走到同色倉庫自動送達。倉庫變灰、顯示倒數表示正在休息。',
  suit: 'D',
  rank: '5',
  defaultPolicy: 'greedy',
  baseLevel: 2,
  symmetric: true,
};
