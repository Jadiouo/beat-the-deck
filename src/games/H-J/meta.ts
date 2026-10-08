import type { CardMeta } from '../types';

/** H-J 三張牌撲克的 meta（SPEC 第 9 節；小規格 `docs/cards/H-J.md`）。 */
export const hJMeta: CardMeta = {
  id: 'H-J',
  name: '三張牌撲克',
  description:
    'Kuhn 撲克：J、Q、K 三張牌，每手各發一張暗牌、各放 1 個底注、一輪下注；大的贏。10 手、先後手交替，起始各 20 籌碼，籌碼多的贏。',
  controls:
    '只有兩個鍵：a（Z）＝ 下注／跟注（積極），b（X）＝ 過牌／棄牌（消極）。先手可以過牌或下注 1；過牌後後手也可以下注，先手再決定跟或棄；先手下注則後手跟或棄。棄牌的牌不亮，攤牌才亮。畫面下方的紀錄是 AI 讀你的原料（你下注、跟注的次數與攤牌亮出的牌），上方三格是 AI 對你的把握（只看攤牌的手數，不說它認為你是什麼樣的人）。等級低的 AI 打固定的混合策略，不讀你；等級高的 AI 會讀你的下注率、跟注率與詐唬比例。每個決定最多想 5 秒，超時自動過牌／棄牌。',
  suit: 'H',
  rank: 'J',
  defaultPolicy: 'pathfinder',
  baseLevel: 4,
  symmetric: true,
  luckHeavy: true,
  equilibriumCapped: true,
};
