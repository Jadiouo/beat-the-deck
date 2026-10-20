import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEVELS,
  DEFAULT_POLICIES,
  MATCHUPS,
  classify,
  collectCorpus,
  formatMeasure,
  measureCard,
} from './engine';
import { specFor } from './specs';

/**
 * 篩檢的量測driver（不是單元測試）。平常沒設環境變數就整檔跳過。
 *
 *   PROBE_TRIAGE_CARDS=D-5,S-8 PROBE_TRIAGE_OUT=/某個目錄 npx vitest run tests/ai/triage/measure.test.ts
 *
 * 環境變數（不要叫 TEST，vitest 會佔用它，DESIGN-AI-FUN 10.65）：
 * - PROBE_TRIAGE_CARDS  逗號分隔的規格 id（必填，沒給就跳過）
 * - PROBE_TRIAGE_OUT    輸出目錄（每張牌寫一個 <id>.json 和一個 <id>.txt）；沒給就只驗證能跑
 * - PROBE_TRIAGE_SEEDS  取樣的種子數（預設 24）
 * - PROBE_TRIAGE_FROM   起始種子（預設 6000，與校準／測試用的種子分開）
 * - PROBE_TRIAGE_EVERY  每隔幾個 tick 取樣（預設 30）
 * - PROBE_TRIAGE_QUERIES 決策點數上限（預設 240）
 */

const env = (name: string): string | undefined => process.env[`PROBE_TRIAGE_${name}`];
const cards = (env('CARDS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');
const num = (name: string, fallback: number): number => {
  const raw = env(name);
  return raw === undefined || raw === '' ? fallback : Number(raw);
};

describe.skipIf(cards.length === 0)('篩檢量測', { timeout: 6 * 3600 * 1000 }, () => {
  it.each(cards)('%s', (id) => {
    const spec = specFor(id);
    const seeds = Array.from({ length: num('SEEDS', 24) }, (_v, i) => num('FROM', 6000) + i);
    const corpus = collectCorpus(spec.game, {
      seeds,
      matchups: MATCHUPS,
      every: env('EVERY') === undefined ? (spec.sample?.every ?? 30) : num('EVERY', 30),
      decisionsOnly: spec.sample?.decisionsOnly === true,
    });
    const measure = measureCard(spec, corpus, {
      policies: DEFAULT_POLICIES,
      levels: DEFAULT_LEVELS,
      queries: num('QUERIES', 240),
      maxPerts: 6,
      maxSelf: 3,
      seed: 1,
    });
    const verdict = classify(measure);
    const text = formatMeasure(measure, verdict);
    const out = env('OUT');
    if (out !== undefined && out !== '') {
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, `${id}.json`),
        JSON.stringify({ id, seeds: seeds.length, measure, verdict }, null, 1),
      );
      writeFileSync(join(out, `${id}.txt`), `${text}\n`);
    }
    // 這裡只釘結構：負對照必須是 0（控制器決定性），不釘任何勝率或改變率的數字。
    for (const cell of measure.cells) {
      expect(cell.nullChanged).toBe(0);
    }
  });
});
