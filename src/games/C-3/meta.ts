import type { CardMeta } from '../types';

/** C-3 紅藍食物的 meta（SPEC 第 9、10 節）。 */
export const c3Meta: CardMeta = {
  id: 'C-3',
  name: '紅藍食物',
  description: '場上有紅藍兩種食物，只有現在的正確顏色加分，吃錯會扣分，正確顏色每八秒換一次。',
  controls: '方向鍵或 WASD 轉向，不能直接掉頭；上方的指示燈是現在的正確顏色，閃爍代表快換色。',
  suit: 'C',
  rank: '3',
  defaultPolicy: 'pathfinder',
  baseLevel: 1,
  symmetric: true,
  // 撞牆、撞身體：死的那條輸，活著的贏，不看分數（SPEC 第 10 節）；而且分數可以是負的。
  winnerNotByScore: true,
};
