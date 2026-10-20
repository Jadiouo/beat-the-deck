import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC, formatProbeA } from '../../../tests/ai/probe-a.shared';
import { B_FAMILY, C_FAMILY, playPair, s10Spec, selectBest } from './probe-a.test-helpers';

/**
 * S-10 探針 A 重做的量測（`docs/cards/S-10.md`「探針 A 重做」）。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   S10_PROBE_LEVEL（AI 等級，預設 5）、S10_PROBE_TRAIN（訓練場數，預設 2，種子 1000 起）、
 *   S10_PROBE_TEST（量測場數，預設 4，種子 5000 起）、S10_PROBE_OUT（把完整結果寫成 JSON 的路徑）。
 * `S10_PROBE_VERBOSE` 印出一行報告（勝率、分差、場級／點級分歧率）。
 * 訓練種子 1000.. 與量測種子 5000.. 不重疊（訓練場數 < 4000）。
 */
const LEVEL = Number(process.env.S10_PROBE_LEVEL ?? 5);
const TRAIN = Number(process.env.S10_PROBE_TRAIN ?? 2);
const TEST = Number(process.env.S10_PROBE_TEST ?? 4);
const TRAIN_FROM = 1000;
const TEST_FROM = 5000;

const seedsOf = (from: number, n: number): number[] =>
  Array.from({ length: n }, (_v, i) => from + i);
const mean = (xs: readonly number[]): number =>
  xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);

function train(names: readonly string[]): { name: string; win: number; margin: number }[] {
  return names.map((name) => {
    const rs = seedsOf(TRAIN_FROM, TRAIN).map((s) =>
      playPair(name, 'b-habit', s, { level: LEVEL }),
    );
    return { name, win: 100 * mean(rs.map((r) => r.win)), margin: mean(rs.map((r) => r.margin)) };
  });
}

describe(`S-10 探針 A 重做（等級 ${String(LEVEL)}，訓練 ${String(TRAIN)} 場、量測 ${String(TEST)} 場）`, () => {
  it('選 (b*)、(c*)，量決策分歧率與 (c)−(b)；(c)−(b) 不超過場級分歧率', () => {
    const bRows = train(B_FAMILY);
    const cRows = train(C_FAMILY);
    const b = selectBest(bRows);
    const c = selectBest(cRows);
    const seeds = seedsOf(TEST_FROM, TEST);
    // 共用層（tests/ai/probe-a.shared.ts）：(b*) 驅動＋(c*) 影子、(c*) 驅動＋(b*) 影子，各跑一遍。
    const probe = compareBC(s10Spec(b, c, seeds, { level: LEVEL }));
    const result = { level: LEVEL, train: TRAIN, test: TEST, b, c, bRows, cRows, probe };
    if (process.env.S10_PROBE_OUT !== undefined) {
      writeFileSync(process.env.S10_PROBE_OUT, JSON.stringify(result, null, 1));
    }
    if (process.env.S10_PROBE_VERBOSE !== undefined) {
      console.log(formatProbeA(`S-10 L${String(LEVEL)} ${b} vs ${c}`, probe));
    }
    expect(B_FAMILY).toContain(b);
    expect(C_FAMILY).toContain(c);
    expect(probe.divergence.points).toBeGreaterThanOrEqual(1);
    // 沒有決策差別的場，兩條對局逐位元相同，勝率差必為 0：|(c)−(b)| ≤ 場級分歧率。
    expect(probe.winBoundHolds).toBe(true);
    expect(probe.inconsistentSeeds).toEqual([]);
    if (probe.divergence.gamesDiffer === 0) {
      expect(probe.win.diff.mean).toBe(0);
      expect(probe.margin.diff.mean).toBe(0);
    }
  }, 600_000);
});
