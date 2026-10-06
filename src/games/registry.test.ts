import { describe, expect, it } from 'vitest';
import { CARD_IDS, registry } from './registry';
import { clubsEntries } from './registry/clubs';
import { diamondsEntries } from './registry/diamonds';
import { heartsEntries } from './registry/hearts';
import { jokersEntries } from './registry/jokers';
import { spadesEntries } from './registry/spades';
import type { RegistryEntry } from './types';

/**
 * 這個檔案只檢查「不管登記了幾張牌都成立」的結構性不變量。
 * 不可以寫死「目前登記了哪幾張」或「共幾張」：新增一張牌不需要改這個檔案
 * （見 registry.ts 檔頭註解）。唯一寫死的是 54 張牌 id 清單本身，那是 SPEC 第 4 節定死的常數。
 */

/** 每個花色模組與它允許的 id 前綴。 */
const SUIT_MODULES: readonly (readonly [string, readonly RegistryEntry[], string])[] = [
  ['clubs', clubsEntries, 'C-'],
  ['spades', spadesEntries, 'S-'],
  ['diamonds', diamondsEntries, 'D-'],
  ['hearts', heartsEntries, 'H-'],
  ['jokers', jokersEntries, 'JK-'],
];

/** SPEC 第 4 節：四個花色各 A→K，順序為梅花、黑桃、方塊、紅心。 */
const SUITS = ['C', 'S', 'D', 'H'] as const;
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;

/** `sub` 是否為 `full` 的子序列（保持相對順序，可以跳過元素）。 */
function isSubsequence(sub: readonly string[], full: readonly string[]): boolean {
  let i = 0;
  for (const item of full) {
    if (i < sub.length && sub[i] === item) i += 1;
  }
  return i === sub.length;
}

describe('registry 組裝', () => {
  const ids = registry.map((entry) => entry.id);

  it('至少登記了一張牌（登記表不可以被清空）', () => {
    expect(registry.length).toBeGreaterThan(0);
  });

  it('沒有重複的 id', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每個 id 都在 54 張牌的清單裡', () => {
    for (const id of ids) expect(CARD_IDS, id).toContain(id);
  });

  it('登記表的順序與 CARD_IDS 一致（是 CARD_IDS 的子序列）', () => {
    expect(isSubsequence(ids, CARD_IDS), `順序不符：${ids.join(', ')}`).toBe(true);
  });

  it('每一筆的 meta.id 與 id 一致', () => {
    for (const entry of registry) expect(entry.meta.id, entry.id).toBe(entry.id);
  });

  it('registry 是各花色模組依 梅花、黑桃、方塊、紅心、鬼牌 的順序串起來', () => {
    expect(registry).toEqual([
      ...clubsEntries,
      ...spadesEntries,
      ...diamondsEntries,
      ...heartsEntries,
      ...jokersEntries,
    ]);
  });
});

describe('CARD_IDS（SPEC 第 4 節的常數）', () => {
  it('共 54 個，沒有重複', () => {
    expect(CARD_IDS).toHaveLength(54);
    expect(new Set(CARD_IDS).size).toBe(54);
  });

  it('四個花色各 13 張，順序為梅花、黑桃、方塊、紅心，各 A,2,…,10,J,Q,K', () => {
    const expected = SUITS.flatMap((suit) => RANKS.map((rank) => `${suit}-${rank}`));
    expect(expected).toHaveLength(52);
    expect(CARD_IDS.slice(0, 52)).toEqual(expected);
  });

  it('最後兩個是 JK-R 與 JK-B', () => {
    expect(CARD_IDS.slice(-2)).toEqual(['JK-R', 'JK-B']);
  });
});

describe.each(SUIT_MODULES)('花色模組 %s', (_name, entries, prefix) => {
  it(`只放 ${prefix}* 的牌，且 meta.id 與 id 一致`, () => {
    for (const entry of entries) {
      expect(entry.id.startsWith(prefix), `${entry.id} 放錯檔案`).toBe(true);
      expect(entry.meta.id).toBe(entry.id);
    }
  });

  it('匯出的是陣列', () => {
    expect(Array.isArray(entries)).toBe(true);
  });
});
