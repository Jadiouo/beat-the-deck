import { describe, expect, it } from 'vitest';

import { BUCKETS, entriesOfBucket, ALL_ENTRIES } from './a-checks.shared';

/**
 * A1–A5 依花色分檔跑（為了讓 vitest 用多個核心並行）。
 * 這裡守住「新增一張牌不用改任何測試檔」：每一筆登記項恰好落在一個檔案裡，不會漏測、也不會重測。
 */
describe('A1–A5 的分檔', () => {
  it('每一筆登記項（真牌加替身牌）恰好屬於一個分檔', () => {
    const owners = new Map<string, number>();
    for (const bucket of BUCKETS) {
      for (const entry of entriesOfBucket(bucket)) {
        owners.set(entry.id, (owners.get(entry.id) ?? 0) + 1);
      }
    }
    for (const entry of ALL_ENTRIES) {
      expect(owners.get(entry.id), entry.id).toBe(1);
    }
    expect(owners.size).toBe(ALL_ENTRIES.length);
  });

  it('花色分檔只收那個花色；鬼牌與替身牌進 other', () => {
    for (const bucket of ['C', 'S', 'D', 'H'] as const) {
      for (const entry of entriesOfBucket(bucket)) {
        expect(entry.meta.suit).toBe(bucket);
      }
    }
    for (const entry of entriesOfBucket('other')) {
      expect(['C', 'S', 'D', 'H']).not.toContain(entry.meta.suit);
    }
  });
});
