import { describe, expect, it } from 'vitest';

import { TIMING_CODES, ALL_ENTRIES } from '../ai/a-checks.shared';
import {
  AI_CHECKS,
  AI_SEEDS,
  CHECKS,
  CONTRACT_SEEDS,
  notApplicableReason,
  runCheck,
} from '../contract/checks';
import { loadNote } from './load';

/**
 * 量時間的逐牌檢查：K11（一場對局 < 2 秒）與 A5（decide() 平均 < 1 毫秒、p99.9 < 8 毫秒）。
 *
 * 為什麼獨立成一個檔案、一個 project：這兩條量的是牆鐘時間，機器一忙就會假性變紅
 * （10.41：整套檢查裡 A5 的 p99.9 是 8 到 9 毫秒，隔離重跑是 0.7 到 2.2 毫秒）。
 * 所以它們跑在 vitest 的 `timing` project：序列（一次一個檔案）、而且排在其他 project 全部跑完之後，
 * 不與它們並行。門檻（tests/contract/checks.ts）沒有動，也沒有任何一條被跳過；
 * 逐牌分檔（slotNN）只是不再定義這兩條，由這裡對同一份 ALL_ENTRIES 全部定義。
 * 「這兩條一定有人在跑」由 tests/contract/timing-project.test.ts 守住。
 */
const TIMED = [...CHECKS, ...AI_CHECKS].filter((check) => TIMING_CODES.includes(check.code));

describe('量時間的檢查', () => {
  it(`目前的機器負載（資訊，不是斷言）：${loadNote()}`, () => {
    expect(TIMED.map((c) => c.code).sort()).toEqual([...TIMING_CODES].sort());
  });
});

describe.each(ALL_ENTRIES)('$id', (entry) => {
  for (const check of TIMED) {
    const title = `${check.code} ${check.title}`;
    const why = notApplicableReason(check, entry);
    if (why !== null) {
      it.skip(`${title}（不適用：${why}）`, () => undefined);
      continue;
    }
    const seeds = check.code.startsWith('A') ? AI_SEEDS : CONTRACT_SEEDS;
    it(
      title,
      () => {
        const outcome = runCheck(check, entry, seeds);
        if (typeof outcome === 'object') {
          throw new Error(`${outcome.fail}\n（${loadNote()}）`);
        }
        expect(outcome).toBe('pass');
      },
      check.code.startsWith('A') ? 120_000 : 60_000,
    );
  }
});
