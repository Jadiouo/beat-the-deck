import { describe, expect, it } from 'vitest';

import { registry } from '../../src/games/registry';
import { measurePursuit, PURSUIT, PURSUIT_SEEDS } from './checks';
import type { PursuitDeclaration, PursuitNotApplicable } from './checks';

/**
 * P1｜追目標的取得率（DESIGN-AI-FUN 10.31、10.32；說明與設計理由見 `checks.ts` 的 P1 一節）。
 *
 * 為什麼是 heavy 測試：每張有可追目標的牌要跑 16 場、每場最多 3600 tick、兩個等級 10 的搜尋型，約 10 到 40 秒。
 *
 * 場數：普查（`tests/scratch/clubs-survey.test.ts`）用 30 場，量到修之前的每分鐘取得數
 * C-A／C-2 2.8、C-3 5.3、C-4 2.2、C-5 4.1、C-7 18.4。這裡用 16 場（種子 0 到 15），因為這個檢查只需要分得開
 * 「徘徊」（每分鐘 2 到 5 顆）與「在吃」（修之後的量值見各張牌小規格），差距是數倍，16 場的雜訊（局與局之間
 * 取得數相差約 ±30%）遠小於這個差距；場數越多只是越慢。下限也留了餘裕，不貼著量到的值。
 */

const declared = registry.filter((entry) => entry.meta.suit === 'C');
const chasing = declared.filter((entry) => {
  const declaration = PURSUIT[entry.id];
  return declaration !== undefined && !('notApplicable' in declaration);
});

describe('追目標｜每張梅花牌都必須宣告', () => {
  it('梅花的每一張都在 PURSUIT 表裡（有可追目標就宣告下限，沒有就寫「不適用」與理由）', () => {
    for (const entry of declared) {
      expect(PURSUIT[entry.id], `${entry.id} 沒有宣告追目標的下限或「不適用」`).toBeDefined();
    }
  });

  it('宣告「不適用」的要有理由（至少 10 個字）', () => {
    for (const entry of declared) {
      const declaration = PURSUIT[entry.id] as
        PursuitDeclaration | PursuitNotApplicable | undefined;
      if (declaration !== undefined && 'notApplicable' in declaration) {
        expect(declaration.notApplicable.length, entry.id).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('表裡沒有登記表以外的牌', () => {
    const ids = new Set(registry.map((entry) => entry.id));
    for (const id of Object.keys(PURSUIT)) {
      expect(ids.has(id), `${id} 不在登記表`).toBe(true);
    }
  });
});

describe.each(chasing)('追目標｜$id', (entry) => {
  it('兩個預設性格等級 10 對打：每分鐘取得數與局長中位數都達到自己宣告的下限', () => {
    const declaration = PURSUIT[entry.id] as PursuitDeclaration;
    const measure = measurePursuit(entry, declaration, PURSUIT_SEEDS);
    expect(
      measure.takesPerMinute,
      `${entry.id} 每分鐘取得 ${measure.takesPerMinute.toFixed(1)}（放過率 ${(100 * measure.missRate).toFixed(0)}%），下限 ${declaration.minTakesPerMinute}`,
    ).toBeGreaterThanOrEqual(declaration.minTakesPerMinute);
    expect(
      measure.medianSeconds,
      `${entry.id} 局長中位數 ${measure.medianSeconds.toFixed(1)} 秒，下限 ${declaration.minMedianSeconds}`,
    ).toBeGreaterThanOrEqual(declaration.minMedianSeconds);
  }, 600_000);
});
