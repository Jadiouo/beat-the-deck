import { describe, expect, it } from 'vitest';

import { CARD_IDS, registry } from '../../src/games/registry';
import { PALETTE } from '../../src/shell/palette';

/**
 * TEST_PLAN 第 4 節｜登記表與色盤的整體檢查（與牌數無關、很快）。
 *
 * 逐張牌的契約檢查（K1–K13、R1–R3）在 `all-games.<花色>.test.ts`，由 `all-games.shared.ts`
 * 從 `[...registry, counterEntry]` 依花色過濾後自動跑，新增一張真牌只要在 `registry.ts` 加一筆。
 * A1–A5（TEST_PLAN 5.1）在 `tests/ai/a-checks.<花色>.test.ts`。
 */

describe('登記表', () => {
  it('每個 id 只出現一次', () => {
    const ids = registry.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('54 張牌的 id 清單完整：4 個花色 × 13 個點數 ＋ 2 張鬼牌，沒有重複', () => {
    expect(CARD_IDS).toHaveLength(54);
    expect(new Set(CARD_IDS).size).toBe(54);
    for (const id of ['C-A', 'C-10', 'S-K', 'D-2', 'H-Q', 'JK-R', 'JK-B']) {
      expect(CARD_IDS).toContain(id);
    }
  });

  it('登記的真牌都在 54 張的清單裡', () => {
    for (const entry of registry) {
      if (entry.kind === 'card') {
        expect(CARD_IDS).toContain(entry.id);
      }
    }
  });
});

describe('色盤', () => {
  it('剛好 16 色，都是小寫的 #rrggbb，沒有重複', () => {
    expect(PALETTE).toHaveLength(16);
    for (const color of PALETTE) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(PALETTE).size).toBe(16);
  });
});
