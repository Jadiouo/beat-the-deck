import { counterGame } from '../../tests/fixtures/counter-game';
import type { CounterState } from '../../tests/fixtures/counter-game';
import { COLOR } from '../shell/palette';
import type { CardMeta, RegistryEntry } from './types';
import { defineEntry } from './types';

/**
 * 54 張牌的登記表（SPEC 第 4 節）。
 *
 * 新增一張牌：在 `registry` 加一行 `defineEntry({ ... })`，不用改契約測試
 * （`tests/contract/all-games.test.ts` 用 `describe.each(registry)`）。
 */

const SUIT_LETTERS = ['C', 'S', 'D', 'H'] as const;
const RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;

/**
 * 54 張牌的 id：`C-A`…`C-K`、`S-*`、`D-*`、`H-*`，加上 `JK-R`、`JK-B`。
 * 順序是梅花、黑桃、方塊、紅心，各 A 到 K，最後紅鬼、黑鬼。
 * 登記表裡只有實際做好的牌；這份清單給牌桌畫面排 54 個格子用。
 */
export const CARD_IDS: readonly string[] = [
  ...SUIT_LETTERS.flatMap((suit) => RANK_LABELS.map((rank) => `${suit}-${rank}`)),
  'JK-R',
  'JK-B',
];

// ---------------------------------------------------------------------------
// counter：counter-game 的替身牌（kind: 'fixture'），不是真的撲克牌。
// 契約測試與（T4 之後的）外殼用它驗證「從選牌到結算」整條路通。
// ---------------------------------------------------------------------------

export const counterMeta: CardMeta = {
  id: 'counter',
  name: '計數替身',
  description: '測試用的替身牌：按住 A 每個 tick 加 1 分，一百個 tick 後分數高的贏。',
  controls: '按住 A（空白鍵）得分。',
  suit: null,
  rank: null,
  defaultPolicy: null,
  baseLevel: 1,
  symmetric: true,
};

/** 左右兩條分數條，長度與分數成正比。 */
export function counterRender(ctx: CanvasRenderingContext2D, state: CounterState): void {
  const barMax = 140;
  const total = Math.max(1, state.length);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(10, 100, barMax, 20);
  ctx.fillRect(170, 100, barMax, 20);
  ctx.fillStyle = COLOR.clubs;
  ctx.fillRect(10, 100, Math.min(barMax, (state.scores[0] / total) * barMax), 20);
  ctx.fillStyle = COLOR.hearts;
  ctx.fillRect(170, 100, Math.min(barMax, (state.scores[1] / total) * barMax), 20);
  ctx.fillStyle = COLOR.fg;
  ctx.fillText(`${state.scores[0]}`, 10, 90);
  ctx.fillText(`${state.scores[1]}`, 170, 90);
}

export const counterEntry: RegistryEntry = defineEntry<CounterState>({
  id: counterMeta.id,
  kind: 'fixture',
  game: counterGame,
  render: counterRender,
  meta: counterMeta,
});

// ---------------------------------------------------------------------------

/** 登記表。目前只有替身牌。 */
export const registry: readonly RegistryEntry[] = [counterEntry];

/** 用 id 找登記項。 */
export function findEntry(id: string): RegistryEntry | undefined {
  return registry.find((entry) => entry.id === id);
}
