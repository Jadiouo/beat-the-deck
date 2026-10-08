import type { CardMeta } from '../types';

/** H-10 暗標的 meta（SPEC 第 9 節；小規格 `docs/cards/H-10.md`）。 */
export const h10Meta: CardMeta = {
  id: 'H-10',
  name: '暗標',
  description:
    '十件物品價值 1 到 10、順序公開，兩人預算各 100，每件同時暗中選一個出價檔位，出得高的拿走並付自己的出價，一樣高就作廢；價值多的贏。',
  controls:
    '每件選一個檔位，選了不能改：b（X）棄標、← 保守（公平價 ×0.5）、↓ 省（×0.8）、a（Z）公平價、→ 加價（×1.3）、↑ 重壓（×1.8）。公平價是「把剩下的預算按價值比例分」，畫面中間六格顯示每個檔位這件的實際出價。揭示後雙方出價都公開，下方的紀錄是 AI 讀你的原料：它看最近四件你選的檔位，選一個剛好夠高的檔位；你餵它一個習慣再破掉它，它丟的是整件物品。畫面上方的三格是 AI 對你的把握（不說是哪個檔位）。每個決定最多想 5 秒，超時自動棄標。',
  suit: 'H',
  rank: '10',
  defaultPolicy: 'pathfinder',
  baseLevel: 3,
  symmetric: true,
};
