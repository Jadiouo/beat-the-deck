import { describe, expect, it } from 'vitest';

import { CARD_IDS, registry } from '../../src/games/registry';
import { PALETTE } from '../../src/shell/palette';
import { CHECKS, CONTRACT_SEEDS, runCheck } from './checks';

/**
 * TEST_PLAN 第 4 節｜契約測試。
 *
 * 對登記表裡每一張牌自動跑同一組檢查。新增一張牌只要在 `registry.ts` 加一行，
 * 不用改這個檔案。檢查本身寫在 `checks.ts`（`bad-games.test.ts` 也用同一份，
 * 用故意違約的假遊戲證明這些檢查真的抓得到問題）。
 *
 * T3 之後這裡要加 A1–A5（AI 行為），並把 K11、K12 的控制器換成預設性格；
 * 見 checks.ts 裡 K11、K12 的註解。
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

describe.each(registry)('$id', (entry) => {
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
