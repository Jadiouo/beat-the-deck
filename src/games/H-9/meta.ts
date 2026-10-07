import type { CardMeta } from '../types';

/** H-9 吹牛骰的 meta（SPEC 第 9 節；小規格 `docs/cards/H-9.md`）。 */
export const h9Meta: CardMeta = {
  id: 'H-9',
  name: '吹牛骰',
  description:
    '兩人各藏兩顆骰子，輪流喊「四顆骰子的總和至少是多少」往上加，不信就抓：喊的是真的喊的人贏，是假的抓的人贏。先贏 3 回合的人獲勝。',
  controls:
    '← 加 1、↑ 加 2、→ 加 3（新喊價是「四顆總和至少是這個數」），b（X）抓（有人喊過才能抓）。只有你的兩顆骰看得到，AI 的骰子是背面，抓了才亮。每個決定最多想 5 秒，超時自動抓。AI 的喊價是線索：你要判斷它是老實喊、還是在虛張；它也會讀你過去幾回合亮出來的骰子，判斷你愛不愛虛報、愛不愛抓。畫面上方是雙方的勝場，中間是目前的喊價與這回合的喊價紀錄，下方是你的骰子。',
  suit: 'H',
  rank: '9',
  defaultPolicy: 'pathfinder',
  baseLevel: 3,
  symmetric: false,
  luckHeavy: true,
};
