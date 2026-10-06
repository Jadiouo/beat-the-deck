import { describe, expect, it } from 'vitest';

import { entriesOfBucket, bucketOf, type Bucket } from '../ai/a-checks.shared';
import { CHECKS, CONTRACT_SEEDS, runCheck } from './checks';

/**
 * TEST_PLAN 第 4 節｜契約測試（K1–K13、R1–R3）依花色分檔跑的共用部分。
 *
 * 為什麼分檔：vitest 以「檔案」為並行單位。一張牌的契約檢查約 27 秒，54 張牌全塞在一個檔案裡
 * 會序列執行、只用到 1 個核心。分成 5 個檔案（`all-games.<花色>.test.ts`）就能同時用多個核心。
 *
 * 新增一張牌不用改任何測試檔：每個檔案的牌都是從 `[...registry, counterEntry]` 依花色過濾出來的
 * （重用 `a-checks.shared.ts` 的 `entriesOfBucket`，不另寫第二份）。檢查本身寫在 `checks.ts`，
 * `bad-games.test.ts` 也用同一份。分檔的完整性（不漏不重）由 `a-checks.buckets.test.ts` 守住。
 */
export function defineContractChecks(bucket: Bucket): void {
  const entries = entriesOfBucket(bucket);

  // 這一組目前沒有任何牌時，檔案裡也要至少有一個測試，否則 vitest 把空檔案當成失敗。
  describe(`契約｜${bucket}｜負責的牌`, () => {
    it(`${entries.length} 張：${entries.map((e) => e.id).join('、') || '（目前沒有）'}`, () => {
      expect(entries.every((entry) => bucketOf(entry) === bucket)).toBe(true);
    });
  });

  if (entries.length === 0) {
    return;
  }

  describe.each(entries)('$id', (entry) => {
    for (const check of CHECKS) {
      const title = `${check.code} ${check.title}`;
      if (!check.applies(entry)) {
        it.skip(`${title}（這張牌不適用）`, () => undefined);
        continue;
      }
      it(
        title,
        () => {
          const outcome = runCheck(check, entry, CONTRACT_SEEDS);
          if (typeof outcome === 'object') {
            // 把檢查的錯誤訊息原樣丟出來，測試報告才看得到是哪個種子、哪個 tick。
            throw new Error(outcome.fail);
          }
          expect(outcome).toBe('pass');
        },
        60_000,
      );
    }
  });
}
