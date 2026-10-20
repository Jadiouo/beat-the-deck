import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { B_FAMILY, C_FAMILY, pairedStats, playPair, selectBest } from './probe-a.test-helpers';
import type { PairResult } from './probe-a.test-helpers';

/**
 * S-10 探針 A 重做的量測（`docs/cards/S-10.md`「探針 A 重做」）。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   S10_PROBE_LEVEL（AI 等級，預設 5）、S10_PROBE_TRAIN（訓練場數，預設 2，種子 1000 起）、
 *   S10_PROBE_TEST（量測場數，預設 4，種子 5000 起）、S10_PROBE_OUT（把完整結果寫成 JSON 的路徑）。
 * 訓練種子 1000.. 與量測種子 5000.. 不重疊（訓練場數 < 4000）。
 */
const LEVEL = Number(process.env.S10_PROBE_LEVEL ?? 5);
const TRAIN = Number(process.env.S10_PROBE_TRAIN ?? 2);
const TEST = Number(process.env.S10_PROBE_TEST ?? 4);
const TRAIN_FROM = 1000;
const TEST_FROM = 5000;

const seedsOf = (from: number, n: number): number[] => Array.from({ length: n }, (_v, i) => from + i);
const mean = (xs: readonly number[]): number => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);

function train(names: readonly string[]): { name: string; win: number; margin: number }[] {
  return names.map((name) => {
    const rs = seedsOf(TRAIN_FROM, TRAIN).map((s) => playPair(name, 'b-habit', s, { level: LEVEL }));
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
    const bDriven: PairResult[] = seeds.map((s) => playPair(b, c, s, { level: LEVEL }));
    const cDriven: PairResult[] = seeds.map((s) => playPair(c, b, s, { level: LEVEL }));
    const gameRate = bDriven.filter((r) => r.firstDiffTick >= 0).length / seeds.length;
    const pointRate =
      bDriven.reduce((a, r) => a + r.diffPoints, 0) / Math.max(1, bDriven.reduce((a, r) => a + r.points, 0));
    const win = pairedStats(cDriven.map((r) => r.win), bDriven.map((r) => r.win));
    const margin = pairedStats(cDriven.map((r) => r.margin), bDriven.map((r) => r.margin));
    const result = { level: LEVEL, train: TRAIN, test: TEST, b, c, bRows, cRows, gameRate, pointRate, win, margin };
    if (process.env.S10_PROBE_OUT !== undefined) {
      writeFileSync(process.env.S10_PROBE_OUT, JSON.stringify({ ...result, bDriven, cDriven }, null, 1));
    }
    expect(B_FAMILY).toContain(b);
    expect(C_FAMILY).toContain(c);
    expect(bDriven.every((r) => r.points >= 1)).toBe(true);
    // 沒有決策差別的場，兩條對局逐位元相同，勝率差必為 0：|(c)−(b)| ≤ 場級分歧率。
    expect(Math.abs(win.mean)).toBeLessThanOrEqual(gameRate + 1e-9);
    if (gameRate === 0) {
      expect(win.mean).toBe(0);
      expect(margin.mean).toBe(0);
    }
  }, 600_000);
});
