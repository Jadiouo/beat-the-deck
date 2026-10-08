import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

describe('reflexOnly（A4 不適用旗標）', () => {
  /** 老闆核准的六張純反射牌（S-A、S-2 與 S-3 同構，2026-10-08 補掛）。要加第七張，先去問老闆（docs/TEST_PLAN.md 5.1 訂正）。 */
  const APPROVED = ['S-A', 'S-2', 'S-3', 'S-7', 'S-J', 'S-Q'];

  it('只有核准的六張掛旗標（梅花與 D-2 有策略深度，不准用旗標蓋掉）', () => {
    const flagged = registry
      .filter((entry) => entry.meta.reflexOnly === true)
      .map((entry) => entry.id)
      .sort();
    expect(flagged).toEqual(APPROVED.filter((id) => registry.some((e) => e.id === id)).sort());
  });

  it('掛旗標的牌，小規格要有「A4 不是證據」一節與劇本玩家的量測', () => {
    for (const entry of registry) {
      if (entry.meta.reflexOnly !== true) {
        continue;
      }
      const file = resolve(__dirname, `../../docs/cards/${entry.id}.md`);
      expect(existsSync(file), `${entry.id} 小規格存在`).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text, `${entry.id} 有 reflexOnly 一節`).toMatch(/^## .*A4.*(不是證據|不適用)/m);
      expect(text, `${entry.id} 提到劇本玩家`).toContain('劇本玩家');
      expect(text, `${entry.id} 提到強玩家與弱玩家`).toMatch(/強玩家/);
      expect(text, `${entry.id} 提到強玩家與弱玩家`).toMatch(/弱玩家/);
    }
  });
});

describe('equilibriumCapped（A2、A4 不適用旗標：零和均衡）', () => {
  /** 老闆核准的牌。要加第二張，先去問老闆（docs/TEST_PLAN.md 5.1 訂正）。 */
  const APPROVED = ['H-J'];

  it('只有核准的牌掛旗標', () => {
    const flagged = registry
      .filter((entry) => entry.meta.equilibriumCapped === true)
      .map((entry) => entry.id)
      .sort();
    expect(flagged).toEqual(APPROVED.filter((id) => registry.some((e) => e.id === id)).sort());
  });

  it('旗標與 reflexOnly 不重疊（兩個理由不同，不共用）', () => {
    for (const entry of registry) {
      expect(
        entry.meta.equilibriumCapped === true && entry.meta.reflexOnly === true,
        entry.id,
      ).toBe(false);
    }
  });

  it('掛旗標的牌，小規格要有「A2／A4 不是證據」一節、零和均衡的理由與替代證據', () => {
    for (const entry of registry) {
      if (entry.meta.equilibriumCapped !== true) {
        continue;
      }
      const file = resolve(__dirname, `../../docs/cards/${entry.id}.md`);
      expect(existsSync(file), `${entry.id} 小規格存在`).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text, `${entry.id} 有 equilibriumCapped 一節`).toMatch(
        /^## .*A2.*A4.*(不是證據|不適用)/m,
      );
      expect(text, `${entry.id} 提到零和與均衡`).toMatch(/零和/);
      expect(text, `${entry.id} 提到均衡`).toMatch(/均衡/);
      expect(text, `${entry.id} 提到劇本玩家`).toContain('劇本玩家');
      expect(text, `${entry.id} 提到反讀`).toContain('反讀');
    }
  });
});

describe('simpleStrategyViable（A4 不適用旗標：簡單策略就能打到 40% 上下）', () => {
  /** 老闆核准的牌（H-6，2026-10-08 裁定）。要加第二張，先去問老闆，並照 DESIGN-AI-FUN 10.14 的判準量過（TEST_PLAN 5.1）。 */
  const APPROVED = ['H-6'];

  it('只有核准的牌掛旗標', () => {
    const flagged = registry
      .filter((entry) => entry.meta.simpleStrategyViable === true)
      .map((entry) => entry.id)
      .sort();
    expect(flagged).toEqual(APPROVED.filter((id) => registry.some((e) => e.id === id)).sort());
  });

  it('旗標與 reflexOnly、equilibriumCapped 不重疊（三個理由不同，不共用）', () => {
    for (const entry of registry) {
      expect(
        entry.meta.simpleStrategyViable === true &&
          (entry.meta.reflexOnly === true || entry.meta.equilibriumCapped === true),
        entry.id,
      ).toBe(false);
    }
  });

  it('掛旗標的牌，小規格要有「A4 不是證據」一節、10.14 的判準與簡單策略勝率表', () => {
    for (const entry of registry) {
      if (entry.meta.simpleStrategyViable !== true) {
        continue;
      }
      const file = resolve(__dirname, `../../docs/cards/${entry.id}.md`);
      expect(existsSync(file), `${entry.id} 小規格存在`).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text, `${entry.id} 有 simpleStrategyViable 一節`).toMatch(
        /^## .*A4.*(不是證據|不適用)/m,
      );
      expect(text, `${entry.id} 提到 10.14`).toContain('10.14');
      expect(text, `${entry.id} 提到簡單策略`).toContain('簡單策略');
      expect(text, `${entry.id} 提到老闆裁定`).toContain('老闆');
    }
  });
});
