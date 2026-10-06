import { clubsEntries } from './registry/clubs';
import { diamondsEntries } from './registry/diamonds';
import { heartsEntries } from './registry/hearts';
import { jokersEntries } from './registry/jokers';
import { spadesEntries } from './registry/spades';
import type { RegistryEntry } from './types';

/**
 * 54 張牌的登記表（SPEC 第 4 節）。
 *
 * 新增一張牌：只改那個花色的檔案，不用改這個檔案，也不用改任何測試檔。
 *   梅花 `registry/clubs.ts`、黑桃 `registry/spades.ts`、方塊 `registry/diamonds.ts`、
 *   紅心 `registry/hearts.ts`、鬼牌 `registry/jokers.ts`。
 * 在該檔的陣列裡加一筆 `defineEntry({ ... })` 與它的 import 即可；每個花色檔只能放自己花色的牌
 * （`registry.test.ts` 會檢查）。這樣好幾個 session 可以同時做不同花色而不會編輯到同一個檔案。
 * 契約測試（`tests/contract/all-games.test.ts`）用 `describe.each([...registry, 替身牌])`，不用改。
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
  ...clubsEntries,
  ...spadesEntries,
  ...diamondsEntries,
  ...heartsEntries,
  ...jokersEntries,
];

/** 用 id 找登記項。 */
export function findEntry(id: string): RegistryEntry | undefined {
  return registry.find((entry) => entry.id === id);
}
