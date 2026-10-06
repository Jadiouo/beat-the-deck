import { describe, expect, it } from 'vitest';
import { CARD_IDS, registry } from './registry';
import { clubsEntries } from './registry/clubs';
import { diamondsEntries } from './registry/diamonds';
import { heartsEntries } from './registry/hearts';
import { jokersEntries } from './registry/jokers';
import { spadesEntries } from './registry/spades';
import type { RegistryEntry } from './types';

/** 每個花色模組與它允許的 id 前綴。 */
const SUIT_MODULES: readonly (readonly [string, readonly RegistryEntry[], string])[] = [
  ['clubs', clubsEntries, 'C-'],
  ['spades', spadesEntries, 'S-'],
  ['diamonds', diamondsEntries, 'D-'],
  ['hearts', heartsEntries, 'H-'],
  ['jokers', jokersEntries, 'JK-'],
];

describe('registry 組裝', () => {
  it('registry 的內容與拆分前相同：C-A、C-2、C-3，依序', () => {
    expect(registry.map((entry) => entry.id)).toEqual(['C-A', 'C-2', 'C-3']);
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

  it('CARD_IDS 仍是 54 張，順序為梅花、黑桃、方塊、紅心 A→K，最後 JK-R、JK-B', () => {
    expect(CARD_IDS).toHaveLength(54);
    expect(CARD_IDS.slice(0, 3)).toEqual(['C-A', 'C-2', 'C-3']);
    expect(CARD_IDS[13]).toBe('S-A');
    expect(CARD_IDS[26]).toBe('D-A');
    expect(CARD_IDS[39]).toBe('H-A');
    expect(CARD_IDS.slice(-2)).toEqual(['JK-R', 'JK-B']);
  });

  it('沒有重複的 id，而且每個 id 都在 54 張牌的清單裡', () => {
    const ids = registry.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(CARD_IDS, id).toContain(id);
  });
});

describe.each(SUIT_MODULES)('花色模組 %s', (_name, entries, prefix) => {
  it(`只放 ${prefix}* 的牌`, () => {
    for (const entry of entries) {
      expect(entry.id.startsWith(prefix), `${entry.id} 放錯檔案`).toBe(true);
      expect(entry.meta.id).toBe(entry.id);
    }
  });

  it('匯出的是陣列', () => {
    expect(Array.isArray(entries)).toBe(true);
  });
});
