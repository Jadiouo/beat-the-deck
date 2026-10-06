import { describe, expect, it } from 'vitest';

import { CARD_IDS, registry } from '../../src/games/registry';
import type { RegistryEntry } from '../../src/games/types';
import { AI_CHECKS, AI_SEEDS, runCheck } from '../contract/checks';
import { counterEntry } from '../fixtures/counter-entry';

/**
 * A1–A5（TEST_PLAN 5.1）分檔跑的共用部分（分檔方式見 SLOT_COUNT）。
 *
 * 為什麼分檔：vitest 以「檔案」為並行單位。A4（人類模型對等級 10，200 場）單場約 110 ms，
 * 一張牌就要 20 多秒，54 張牌全塞在 `all-games.test.ts` 一個檔案裡會序列執行、只用到 1 個核心。
 * 分成 13 個檔案就能同時用多個核心。
 *
 * 新增一張牌不用改任何測試檔：每個檔案的牌都是從 `[...registry, counterEntry]` 依序號過濾出來的，
 * 不是手寫清單。`check-buckets.test.ts` 證明每一筆登記項恰好落在一個檔案裡。
 */

/** 真牌（登記表）加上替身牌（只存在於 tests/）。 */
export const ALL_ENTRIES: readonly RegistryEntry[] = [...registry, counterEntry];

/**
 * 分檔：牌在 54 張清單裡的序號 mod SLOT_COUNT；不在清單裡的（替身牌）進 'other'。
 *
 * 為什麼不按花色：一張牌的檢查成本差很多（落雨、瞄準彈這類 A4 要二十幾秒，擲骰子的紅心牌不到 1 秒），
 * 按花色切，54 張牌時最重的檔案仍是 13 張牌 × 約 50 秒，單檔就超過整體目標。
 * 按序號 mod 12 切，每個檔案 4 到 5 張、四個花色混著，單檔成本平均、也方便 CI 用 `--shard` 平均分給多台機器。
 * 新增一張牌不用改任何測試檔：它的序號決定它在哪一檔。
 */
export const SLOT_COUNT = 12;
export type Bucket = number | 'other';
export const BUCKETS: readonly Bucket[] = [
  ...Array.from({ length: SLOT_COUNT }, (_, slot) => slot),
  'other',
];

export function bucketOf(entry: { readonly id: string }): Bucket {
  const index = CARD_IDS.indexOf(entry.id);
  return index < 0 ? 'other' : index % SLOT_COUNT;
}

/** 檔名中間那一段：`a-checks.<這一段>.test.ts`。 */
export function fileNameOf(bucket: Bucket): string {
  return bucket === 'other' ? 'other' : `slot${String(bucket).padStart(2, '0')}`;
}

export function entriesOfBucket(bucket: Bucket): RegistryEntry[] {
  return ALL_ENTRIES.filter((entry) => bucketOf(entry) === bucket);
}

/** 對這一組的每一張牌跑 A1–A5；沒有預設性格的牌（替身牌）與鬼牌顯示為「不適用」。 */
export function defineAChecks(bucket: Bucket): void {
  const entries = entriesOfBucket(bucket);

  // 這一組目前沒有任何牌時，檔案裡也要至少有一個測試，否則 vitest 把空檔案當成失敗。
  describe(`A1–A5｜${fileNameOf(bucket)}｜負責的牌`, () => {
    it(`${entries.length} 張：${entries.map((e) => e.id).join('、') || '（目前沒有）'}`, () => {
      expect(entries.every((entry) => bucketOf(entry) === bucket)).toBe(true);
    });
  });

  if (entries.length === 0) {
    return;
  }

  describe.each(entries)('$id', (entry) => {
    for (const check of AI_CHECKS) {
      const title = `${check.code} ${check.title}`;
      if (!check.applies(entry)) {
        it.skip(`${title}（這張牌不適用）`, () => undefined);
        continue;
      }
      it(
        title,
        () => {
          const outcome = runCheck(check, entry, AI_SEEDS);
          if (typeof outcome === 'object') {
            throw new Error(outcome.fail);
          }
          expect(outcome).toBe('pass');
        },
        120_000,
      );
    }
  });
}
