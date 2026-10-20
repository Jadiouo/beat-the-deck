import type { CardMeta } from '../types';

/** D-6 市場的 meta（SPEC 第 9 節；小規格 `docs/cards/D-6.md`）。 */
export const d6Meta: CardMeta = {
  id: 'D-6',
  name: '市場',
  description:
    '24 回合，每回合你和 AI 同時各買或賣一件貨；三種貨各有一條公開的行情曲線，但雙方的買賣會把價格推高或壓低；最後只算現金，沒賣掉的貨一毛不值。',
  controls:
    '按住 A（Z）再按 左／上／右：買 穀／布／鐵；按住 B（X）再按 左／上／右：賣 穀／布／鐵；按 下：這回合不動。鎖定了就不能改，超過時間自動不動。畫面中間是三條行情曲線與現在的價格，兩邊的現金與存貨、過去每一回合雙方做了什麼都是公開的；對方這回合選了什麼，開牌前只看得到「已鎖定」。',
  suit: 'D',
  rank: '6',
  defaultPolicy: 'pathfinder',
  baseLevel: 2,
  symmetric: true,
};
