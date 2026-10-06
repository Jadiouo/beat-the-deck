import { c2Game } from './C-2/logic';
import type { C2State } from './C-2/logic';
import { c2Meta } from './C-2/meta';
import { c2Render } from './C-2/render';
import { cAGame } from './C-A/logic';
import type { ClubsState } from './C-A/logic';
import { cAMeta } from './C-A/meta';
import { cARender } from './C-A/render';
import type { RegistryEntry } from './types';
import { defineEntry } from './types';

/**
 * 54 張牌的登記表（SPEC 第 4 節）。
 *
 * 新增一張牌：在 `registry` 加一筆 `defineEntry({ ... })`，不用改契約測試
 * （`tests/contract/all-games.test.ts` 用 `describe.each([...registry, 替身牌])`）。
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

/**
 * 登記表：只放真的牌。測試用的替身牌（counter-game）不在這裡，
 * 它的登記項在 `tests/fixtures/counter-entry.ts`，契約測試自己把它加進來跑，
 * 所以正式建置不會打包 `tests/` 底下的任何東西。
 */
export const registry: readonly RegistryEntry[] = [
  defineEntry<ClubsState>({
    id: cAMeta.id,
    kind: 'card',
    game: cAGame,
    render: cARender,
    meta: cAMeta,
  }),
  defineEntry<C2State>({
    id: c2Meta.id,
    kind: 'card',
    game: c2Game,
    render: c2Render,
    meta: c2Meta,
  }),
];

/** 用 id 找登記項。 */
export function findEntry(id: string): RegistryEntry | undefined {
  return registry.find((entry) => entry.id === id);
}
