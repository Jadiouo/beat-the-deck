import type { CardMeta } from '../types';

/** JK-R 一起亂畫的 meta（SPEC 第 9、11 節）。鬼牌不跑 AI 行為測試，所以不標 `defaultPolicy`。 */
export const jkrMeta: CardMeta = {
  id: 'JK-R',
  name: '一起亂畫',
  description: '沒有輸贏：你和三支 AI 筆在同一張畫布上一起亂畫，九十秒後看會出現什麼。',
  controls: '方向鍵移動筆，按住 A 下筆，B 換顏色；你停下來太久，AI 的筆也會慢慢停下來。',
  suit: 'JK',
  rank: 'R',
  defaultPolicy: null,
  baseLevel: 1,
  /** SPEC 第 11 節：90 秒（5400 tick），比共同設定的 60 秒長。 */
  defaultMaxTicks: 5400,
};
