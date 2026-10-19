import type { CardMeta } from '../types';

/** H-7 血換分的 meta（SPEC 第 9 節；小規格 `docs/cards/H-7.md`）。 */
export const h7Meta: CardMeta = {
  id: 'H-7',
  name: '血換分',
  description:
    '每回合桌上有紅球（高分但扣血）、白球（1 分免費）、綠球（補血），兩人同時選一顆搶，搶同一顆誰都拿不到；血歸零分數全沒，12 回合後分數高的贏。',
  controls:
    '← 搶紅球（得分、扣血）、↑ 搶白球（1 分）、→ 搶綠球（補 2 血，上限 6）、b（X）或 ↓ 不搶。選了不能改，兩邊都選好才揭示。搶同一顆就彈開，誰都拿不到、也不扣血。血歸零就昏倒、分數立刻歸零，要靠綠球補回血才能再搶紅球。血量、分數與每回合誰搶了什麼都是公開的：AI 的血很少，它多半要搶綠球；它落後很多、血又滿，它多半衝紅球。AI 也看你的血、你的分數與你過去怎麼搶。每個決定最多想 5 秒，超時自動不搶。',
  suit: 'H',
  rank: '7',
  defaultPolicy: 'pathfinder',
  baseLevel: 3,
  symmetric: true,
};
