import { describe, expect, it } from 'vitest';

import type { RegistryEntry } from '../../src/games/types';
import {
  TIMING_CODES,
  bucketOf,
  entriesOfBucket,
  fileNameOf,
  type Bucket,
} from '../ai/a-checks.shared';
import {
  CHECKS,
  CONTRACT_CONFIG,
  CONTRACT_SEEDS,
  SYMMETRY_CHUNKS,
  SYMMETRY_SEEDS,
  judgeSymmetry,
  runCheck,
  symmetryPoints,
} from './checks';

/**
 * TEST_PLAN 第 4 節｜契約測試（K1–K13、R1–R3）依花色分檔跑的共用部分。
 *
 * 為什麼分檔：vitest 以「檔案」為並行單位。一張牌的契約檢查約 27 秒，54 張牌全塞在一個檔案裡
 * 會序列執行、只用到 1 個核心。分成 13 個檔案（`all-games.slotNN.test.ts`，分法見 `a-checks.shared.ts` 的 SLOT_COUNT）就能同時用多個核心。
 *
 * 新增一張牌不用改任何測試檔：每個檔案的牌都是從 `[...registry, counterEntry]` 依序號過濾出來的
 * （重用 `a-checks.shared.ts` 的 `entriesOfBucket`，不另寫第二份）。檢查本身寫在 `checks.ts`，
 * `bad-games.test.ts` 也用同一份。分檔的完整性（不漏不重）由 `check-buckets.test.ts` 守住。
 */
export function defineContractChecks(bucket: Bucket): void {
  const entries = entriesOfBucket(bucket);

  // 這一組目前沒有任何牌時，檔案裡也要至少有一個測試，否則 vitest 把空檔案當成失敗。
  describe(`契約｜${fileNameOf(bucket)}｜負責的牌`, () => {
    it(`${entries.length} 張：${entries.map((e) => e.id).join('、') || '（目前沒有）'}`, () => {
      expect(entries.every((entry) => bucketOf(entry) === bucket)).toBe(true);
    });
  });

  if (entries.length === 0) {
    return;
  }

  describe.each(entries)('$id', (entry) => {
    for (const check of CHECKS) {
      if (TIMING_CODES.includes(check.code)) {
        continue; // 時間類的檢查（K11）改在 tests/timing/ 跑，序列、不與其他 project 並行
      }
      const title = `${check.code} ${check.title}`;
      if (!check.applies(entry)) {
        it.skip(`${title}（這張牌不適用）`, () => undefined);
        continue;
      }
      if (check.code === 'K12') {
        defineSymmetry(entry, title);
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

/**
 * K12 分段：200 個種子切成 `SYMMETRY_CHUNKS`，每段一個測試案例（各自 60 秒），
 * 最後一個案例把各段得分加總、用同一個判準判。種子數與判準都沒動（見 `symmetry-chunks.test.ts`）。
 * 為什麼：最慢的牌（S-Q、S-10、S-A）一次跑完要 70 多秒，成本在控制器，降不下來。
 * 任何一段沒跑完（出錯、逾時）加總的案例就失敗，不會因為少了一段而假裝通過。
 */
function defineSymmetry(entry: RegistryEntry, title: string): void {
  const done = new Map<number, number>();
  SYMMETRY_CHUNKS.forEach((chunk, index) => {
    it(`${title}（第 ${index + 1}/${SYMMETRY_CHUNKS.length} 段：種子 ${chunk[0]} 到 ${chunk[chunk.length - 1]}）`, () => {
      try {
        done.set(index, symmetryPoints(entry, chunk, CONTRACT_CONFIG));
      } catch (error) {
        const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw new Error(`[K12] 遊戲丟出錯誤：${text}`, { cause: error });
      }
    }, 60_000);
  });
  it(title, () => {
    expect([...done.keys()].sort(), '有一段沒有跑完').toEqual(SYMMETRY_CHUNKS.map((_, i) => i));
    let points = 0;
    for (const value of done.values()) {
      points += value;
    }
    judgeSymmetry(points, SYMMETRY_SEEDS.length);
  });
}
