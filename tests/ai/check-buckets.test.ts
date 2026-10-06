import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CARD_IDS } from '../../src/games/registry';
import { counterEntry } from '../fixtures/counter-entry';
import {
  ALL_ENTRIES,
  BUCKETS,
  SLOT_COUNT,
  bucketOf,
  entriesOfBucket,
  fileNameOf,
  type Bucket,
} from './a-checks.shared';

/**
 * A1–A5 與契約檢查（K1–K13、R1–R3）依「牌的序號 mod SLOT_COUNT」分檔跑
 * （為了讓 vitest 用多個核心並行，也讓 CI 的 --shard 切得平均；一張牌的成本差很多，按花色切會很不平均）。
 * 這裡守住「新增一張牌不用改任何測試檔」：每一筆登記項恰好落在一個檔案裡，不會漏測、也不會重測。
 */
describe('A1–A5 與契約檢查的分檔', () => {
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

  it(`54 張牌（含還沒做的）每一張都有一個固定的分檔，${SLOT_COUNT} 個分檔的張數相差不超過 1`, () => {
    const counts = new Map<Bucket, number>();
    for (const id of CARD_IDS) {
      const bucket = bucketOf({ id } as never);
      expect(bucket, id).not.toBe('other');
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    expect(counts.size).toBe(SLOT_COUNT);
    const sizes = [...counts.values()];
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('不在 54 張清單裡的登記項（替身牌）進 other', () => {
    expect(bucketOf({ id: counterEntry.id } as never)).toBe('other');
    expect(entriesOfBucket('other').map((entry) => entry.id)).toContain(counterEntry.id);
  });

  it('每個分檔都有對應的測試檔，呼叫的是自己那一組，而且沒有多餘的檔案', () => {
    const roots = [
      { dir: resolve(__dirname, '../ai'), prefix: 'a-checks', fn: 'defineAChecks' },
      { dir: resolve(__dirname, '../contract'), prefix: 'all-games', fn: 'defineContractChecks' },
    ];
    for (const { dir, prefix, fn } of roots) {
      const expected = BUCKETS.map((bucket) => `${prefix}.${fileNameOf(bucket)}.test.ts`);
      for (const [index, name] of expected.entries()) {
        const file = resolve(dir, name);
        expect(existsSync(file), file).toBe(true);
        const bucket = BUCKETS[index] as Bucket;
        expect(readFileSync(file, 'utf8'), file).toContain(
          `${fn}(${JSON.stringify(bucket).replace(/"/g, "'")})`,
        );
      }
      const actual = readdirSync(dir).filter(
        (name) => name.startsWith(`${prefix}.`) && name.endsWith('.test.ts'),
      );
      expect(actual.sort()).toEqual([...expected].sort());
    }
  });
});
