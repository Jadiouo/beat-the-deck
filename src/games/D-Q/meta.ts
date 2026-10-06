import type { CardMeta } from '../types';

/** D-Q 唯一的礦的 meta（SPEC 第 9 節；小規格 `docs/cards/D-Q.md`）。 */
export const dQMeta: CardMeta = {
  id: 'D-Q',
  name: '唯一的礦',
  description:
    '場上只有一個礦，站著挖、走出礦坑才算分，礦越挖越容易塌，塌的時候還在裡面的礦石全部作廢。',
  controls: '方向鍵或 WASD 移動，每 0.08 秒走一格；站在礦上挖，走出 4 格外才算分。',
  suit: 'D',
  rank: 'Q',
  defaultPolicy: 'precise',
  baseLevel: 4,
  symmetric: true,
};
