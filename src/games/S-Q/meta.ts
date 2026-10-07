import type { CardMeta } from '../types';

/** S-Q 鏡像的 meta（SPEC 第 9 節，方向依 DESIGN-AI-FUN 7.4 改過；小規格 `docs/cards/S-Q.md`）。 */
export const sQMeta: CardMeta = {
  id: 'S-Q',
  name: '鏡像',
  description: '子彈同擦彈，但你擦到子彈，對方的左右操作就會反轉兩秒；AI 擦到子彈，反轉的是你。',
  controls:
    '方向鍵或 WASD 八方向移動，按住 Z 或空白鍵慢速。擦到子彈（不被打中）會讓對方的左右反轉：要不要冒險貼近子彈？邊框閃爍是反轉前的預告，橘色是正在反轉。',
  suit: 'S',
  rank: 'Q',
  defaultPolicy: 'precise',
  baseLevel: 4,
  symmetric: true,
};
