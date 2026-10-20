import type { CardMeta } from '../types';

/** H-8 加倍或歸零的 meta（SPEC 第 9 節；小規格 `docs/cards/H-8.md`）。 */
export const h8Meta: CardMeta = {
  id: 'H-8',
  name: '加倍或歸零',
  description:
    '兩個人各爬自己的梯子，每爬一層賭注加倍、成功率下降，爬失敗就歸零；每個人的梯子有只有自己知道的好壞。停下來比誰的賭注高，5 座梯子後分數高的贏。',
  controls:
    'a（Z 或空白鍵）爬、b（X）停。選了不能改，兩邊都選好才一起公開結果。畫面直接顯示你這層的實際成功率（你的梯子好壞只有你知道）；AI 爬到哪一層、停在哪裡、賭注多大都是公開的，這也是你猜它的梯子好不好的唯一線索。一座梯子結束後，雙方的梯子好壞才會公開。AI 也在讀你爬或停的紀錄。每個決定最多想 5 秒，超時自動停。',
  suit: 'H',
  rank: '8',
  defaultPolicy: 'pathfinder',
  baseLevel: 3,
  symmetric: true,
  luckHeavy: true,
};
