import type { CardMeta } from '../types';

/** S-10 彈幕的 meta（SPEC 第 9、10 節；小規格 `docs/cards/S-10.md`）。 */
export const s10Meta: CardMeta = {
  id: 'S-10',
  name: '彈幕',
  description:
    '兩個人站在同一個彈幕裡，全場三次清場共用、先按先得，場上至少 8 顆子彈才清得動，清掉幾顆就得幾分，被打中扣十分。',
  controls:
    '方向鍵或 WASD 八方向移動，按住 Z 或空白鍵慢速；X 或 Shift 清場（全場只有三次，兩人共用，第 5 秒起才能按，場上要有 8 顆以上的子彈才有效；子彈不夠就按會被鎖住 2 秒）。子彈越多清場越值錢，但等太久對手會先按。',
  suit: 'S',
  rank: '10',
  defaultPolicy: 'precise',
  baseLevel: 3,
  symmetric: true,
  defaultMaxTicks: 2700,
  /** A4 豁免（DESIGN-AI-FUN 10.14，老闆 2026-10-19 裁示）：子彈 ≥ 8 才按清場的簡單策略 39.0%，等於人類模型。前提由 tests/ai/simple-strategy-premise.s10.test.ts 看守。 */
  simpleStrategyViable: true,
};
