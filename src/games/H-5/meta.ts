import type { CardMeta } from '../types';

/** H-5 二十一點的 meta（SPEC 第 9 節；小規格 `docs/cards/H-5.md`）。 */
export const h5Meta: CardMeta = {
  id: 'H-5',
  name: '二十一點',
  description:
    '沒有莊家的兩人二十一點：牌是 1 到 10、共用一副牌、每輪同時選要牌或停牌，爆牌多扣 1 分；7 手，總分高的贏。',
  controls:
    '每一輪兩邊同時選，選了不能改：a（Z）要牌、b（X）停牌。停牌是這一手的最終決定；爆牌（超過 21）或滿 4 張牌自動停牌，對手分不出你是爆了還是自己停的。你領的牌 AI 領不到。畫面右邊是 AI 的牌（暗牌是牌背，攤牌才翻開），下方的紀錄是你最近幾手在幾點時要或停，那是 AI 估計你停牌門檻的原料；畫面上方的三格是 AI 對你的把握（只看紀錄的手數，不說它認為你的門檻是幾點）。等級低的 AI 只看自己的點數（不到 16 就要）；等級高的 AI 會算牌、推你的暗牌，而且你的最近一手就會讓它改變看法。每個決定最多想 5 秒，超時自動停牌。',
  suit: 'H',
  rank: '5',
  defaultPolicy: 'pathfinder',
  baseLevel: 2,
  symmetric: true,
  luckHeavy: true,
};
