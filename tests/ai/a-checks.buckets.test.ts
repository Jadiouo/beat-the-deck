import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUCKETS, entriesOfBucket, ALL_ENTRIES, type Bucket } from './a-checks.shared';

/** 分檔名稱：bucket → 檔名裡的花色字樣。 */
const FILE_NAME: Record<Bucket, string> = {
  C: 'clubs',
  S: 'spades',
  D: 'diamonds',
  H: 'hearts',
  other: 'other',
};

/**
 * A1–A5 與契約檢查（K1–K13、R1–R3）依花色分檔跑（為了讓 vitest 用多個核心並行）。
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

  it('每個分檔都有對應的測試檔：A1–A5 與契約檢查各 5 個，且呼叫的是自己那一組', () => {
    const roots = [
      { dir: resolve(__dirname, '../ai'), prefix: 'a-checks', fn: 'defineAChecks' },
      { dir: resolve(__dirname, '../contract'), prefix: 'all-games', fn: 'defineContractChecks' },
    ];
    for (const { dir, prefix, fn } of roots) {
      for (const bucket of BUCKETS) {
        const file = resolve(dir, `${prefix}.${FILE_NAME[bucket]}.test.ts`);
        expect(existsSync(file), file).toBe(true);
        expect(readFileSync(file, 'utf8'), file).toContain(`${fn}('${bucket}')`);
      }
    }
  });
});
