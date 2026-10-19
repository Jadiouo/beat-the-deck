import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findEntry } from '../../src/games/registry';
import type { RegistryEntry } from '../../src/games/types';
import { AI_CHECKS, aiThresholds, notApplicableReason, runsA2, runsA4 } from './checks';

/**
 * 用 DESIGN-AI-FUN 10.14 豁免 A4 的牌：H-6（2026-10-08）、H-5 與 S-10（2026-10-19，老闆裁示）。
 * 這個檔案管「豁免有沒有被正確、具體地宣告」；豁免的**前提**（簡單策略真的 ≥ 40%）
 * 是統計測試，在 tests/ai/simple-strategy-premise.test.ts。
 */

const EXEMPT = ['H-5', 'H-6', 'S-10'] as const;
const NEW_TWO = ['H-5', 'S-10'] as const;

function entryOf(id: string): RegistryEntry {
  const entry = findEntry(id);
  if (entry === undefined) {
    throw new Error(`${id} 不在登記表`);
  }
  return entry;
}

const a4 = AI_CHECKS.find((check) => check.code === 'A4');
if (a4 === undefined) {
  throw new Error('AI_CHECKS 裡沒有 A4');
}

function cardDoc(id: string): string {
  const file = resolve(__dirname, `../../docs/cards/${id}.md`);
  expect(existsSync(file), `${id} 小規格存在`).toBe(true);
  return readFileSync(file, 'utf8');
}

describe('H-5、S-10 的 A4 豁免（10.14，老闆 2026-10-19 裁示）', () => {
  it.each(NEW_TWO)('%s 宣告了 simpleStrategyViable', (id) => {
    expect(entryOf(id).meta.simpleStrategyViable).toBe(true);
  });

  it.each(NEW_TWO)('%s 的 A4 不跑，其餘 A 檢查照跑（豁免只豁免 A4）', (id) => {
    const entry = entryOf(id);
    expect(runsA4(entry)).toBe(false);
    expect(runsA2(entry)).toBe(true);
    for (const check of AI_CHECKS.filter((c) => c.code !== 'A4')) {
      expect(check.applies(entry), `${id} ${check.code}`).toBe(true);
    }
  });

  it.each(NEW_TWO)('%s 的豁免不是靠放寬門檻：A4 門檻仍是 35%%', (id) => {
    expect(aiThresholds(entryOf(id).meta).a4).toBe(0.35);
  });

  it.each(NEW_TWO)('%s 沒有同時掛 reflexOnly 或 equilibriumCapped（理由不共用）', (id) => {
    const meta = entryOf(id).meta;
    expect(meta.reflexOnly).not.toBe(true);
    expect(meta.equilibriumCapped).not.toBe(true);
  });

  it('H-5 的理由字串有具體數字：門檻 15、51.5%、40%', () => {
    const reason = notApplicableReason(a4, entryOf('H-5')) ?? '';
    expect(reason.length).toBeGreaterThanOrEqual(150);
    expect(reason).toContain('simpleStrategyViable');
    expect(reason).toContain('10.14');
    expect(reason).toContain('門檻 15');
    expect(reason).toContain('51.5%');
    expect(reason).toContain('docs/cards/H-5.md');
    expect(reason).not.toContain('數字見小規格的簡單策略勝率表');
  });

  it('S-10 的理由字串有具體數字：8 顆、39.0%、40.5%、78% 平手', () => {
    const reason = notApplicableReason(a4, entryOf('S-10')) ?? '';
    expect(reason.length).toBeGreaterThanOrEqual(150);
    expect(reason).toContain('simpleStrategyViable');
    expect(reason).toContain('10.14');
    expect(reason).toContain('8 顆');
    expect(reason).toContain('39.0%');
    expect(reason).toContain('40.5%');
    expect(reason).toContain('78%');
    expect(reason).toContain('docs/cards/S-10.md');
    expect(reason).not.toContain('數字見小規格的簡單策略勝率表');
  });

  it('三張豁免牌的理由字串各不相同（不是同一句空話套三次）', () => {
    const reasons = EXEMPT.map((id) => notApplicableReason(a4, entryOf(id)));
    for (const reason of reasons) {
      expect(reason).not.toBeNull();
    }
    expect(new Set(reasons).size).toBe(EXEMPT.length);
  });

  it('沒有掛旗標的牌，A4 的 notApplicableReason 不是 simpleStrategyViable 的理由', () => {
    const other = entryOf('H-9');
    expect(other.meta.simpleStrategyViable).not.toBe(true);
    expect(notApplicableReason(a4, other)).toBeNull();
  });
});

describe('豁免要寫進文件，不只是旗標', () => {
  it('H-5 小規格：誠實的技術牌、51.5%、老闆裁示、10.14、A4 不是證據一節', () => {
    const text = cardDoc('H-5');
    expect(text).toMatch(/^## .*A4.*(不是證據|不適用)/m);
    expect(text).toContain('誠實的技術牌');
    expect(text).toContain('51.5%');
    expect(text).toContain('10.14');
    expect(text).toContain('老闆');
    expect(text).toContain('單調');
  });

  it('S-10 小規格：78% 平手、39.0%、10.40、未實作的提案、老闆裁示', () => {
    const text = cardDoc('S-10');
    expect(text).toMatch(/^## .*A4.*(不是證據|不適用)/m);
    expect(text).toContain('78%');
    expect(text).toContain('39.0%');
    expect(text).toContain('40.5%');
    expect(text).toContain('10.14');
    expect(text).toContain('10.40');
    expect(text).toContain('老闆');
    expect(text).toMatch(/未實作的提案/);
    expect(text).toContain('不好玩');
  });

  it('DESIGN-AI-FUN 的 10.52 節有豁免清單與「擴散就要重新檢討判準」的警語', () => {
    const all = readFileSync(resolve(__dirname, '../../docs/DESIGN-AI-FUN.md'), 'utf8');
    // 按章節編號定位：從 `### 10.52 ` 開頭讀到下一個 `### ` 為止（不依賴它是不是最後一節）
    const start = all.search(/^### 10\.52 /m);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = all.slice(start + 4);
    const next = rest.search(/^### /m);
    const text = next === -1 ? all.slice(start) : all.slice(start, start + 4 + next);
    expect(text.split('\n')[0]).toMatch(/豁免/);
    expect(text).toContain('目前用 10.14 豁免 A4 的牌共有三張：H-6、H-5、S-10');
    expect(text).toMatch(/第四張/);
    expect(text).toMatch(/判準本身有問題/);
  });
});
