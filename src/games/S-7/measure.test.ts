import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC, divergence, formatProbeA, pairedStats } from '../../../tests/ai/probe-a.shared';
import { makeSweepMember } from './probe-a.members.test-helpers';
import { B_FAMILY, C_FAMILY } from './probe-a.members.test-helpers';
import {
  CELLS,
  PRIMARY_CELL,
  cellLabel,
  controllerFor,
  playWith,
  s7Spec,
  selectBest,
  trainFamily,
} from './probe-a.test-helpers';
import type { Cell } from './probe-a.test-helpers';

/**
 * S-7 探針 A（完整版）的量測（`docs/cards/S-7.md`「探針 A（完整版）」）。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   S7_PROBE_CELLS（`primary`｜`all`｜用逗號分隔的格子編號，預設 `primary`）、
 *   S7_PROBE_TRAIN（訓練場數，預設 2，種子 1000 起）、S7_PROBE_TEST（量測場數，預設 4，種子 5000 起）、
 *   S7_PROBE_OUT（把完整結果寫成 JSON 的路徑）、S7_PROBE_VERBOSE（印出一行報告）、
 *   S7_PROBE_PAIRS（設了就把每個 (c) 對自己的基底量一遍，敏感度分析）、S7_PROBE_SWEEP（等待曲線的場數，預設 0 ＝ 不跑；種子 3000 起）。
 * 訓練種子 1000.. 與量測種子 5000.. 與掃描種子 2000..、等待曲線 3000.. 都不重疊（場數 < 1000）。
 */
const TRAIN = Number(process.env.S7_PROBE_TRAIN ?? 2);
const TEST = Number(process.env.S7_PROBE_TEST ?? 4);
const SWEEP = Number(process.env.S7_PROBE_SWEEP ?? 0);
const TRAIN_FROM = 1000;
const TEST_FROM = 5000;
const SWEEP_FROM = 3000;

/**
 * 敏感度分析（不是標籤數字）：每個 (c) 成員對它**自己的基底** (b)（小規格第 4 節表的「基底」欄）。
 * 這是最小對照：兩者只差讀對手的那一條規則。c-baited 與 c-combo 的基底沒有假動作，最接近的 (b) 是 b-guard105-f1（近似）。
 */
const PAIRS: readonly (readonly [string, string])[] = [
  ['b-guard105', 'c-hist-nof'],
  ['b-guard105-f2', 'c-hist-f2'],
  ['b-guard105-f2', 'c-quota'],
  ['b-guard105-f1', 'c-baited'],
  ['b-guard105-f2', 'c-gunshot'],
  ['b-guard105-f2', 'c-lead'],
  ['b-guard105-f1', 'c-combo'],
  ['b-wait30-f2', 'c-hist-wait'],
];

const seedsOf = (from: number, n: number): number[] =>
  Array.from({ length: n }, (_v, i) => from + i);

function cellsToRun(): readonly Cell[] {
  const spec = process.env.S7_PROBE_CELLS ?? 'primary';
  if (spec === 'primary') {
    return [PRIMARY_CELL];
  }
  if (spec === 'all') {
    return CELLS;
  }
  return spec.split(',').map((i) => CELLS[Number(i)] as Cell);
}

/** 用 (b*) 與 (c*) 各打一場（同種子同座位同 AI 種子），按座位（偶數／奇數種子）分開算 (c)−(b)。 */
function bySeat(b: string, c: string, seeds: readonly number[], cell: Cell) {
  const rows = seeds.map((seed) => {
    const rb = playWith(seed, controllerFor(b, seed, cell), cell);
    const rc = playWith(seed, controllerFor(c, seed, cell), cell);
    return { seat: rb.side, dWin: rc.win - rb.win, dMargin: rc.margin - rb.margin };
  });
  const part = (seat: 0 | 1) => {
    const mine = rows.filter((r) => r.seat === seat);
    return {
      n: mine.length,
      win: pairedStats(mine.map((r) => r.dWin)),
      margin: pairedStats(mine.map((r) => r.dMargin)),
    };
  };
  return { seat0: part(0), seat1: part(1) };
}

describe(`S-7 探針 A 完整版（訓練 ${String(TRAIN)} 場、量測 ${String(TEST)} 場）`, () => {
  it('每一格：選 (b*)、(c*)，量決策分歧率（場級＋點級）與 (c)−(b)；|(c)−(b)| 不超過場級分歧率', () => {
    const results = [];
    for (const cell of cellsToRun()) {
      const bRows = trainFamily(B_FAMILY, cell, seedsOf(TRAIN_FROM, TRAIN));
      const cRows = trainFamily(C_FAMILY, cell, seedsOf(TRAIN_FROM, TRAIN));
      const b = selectBest(bRows);
      const c = selectBest(cRows);
      const seeds = seedsOf(TEST_FROM, TEST);
      // 共用層（tests/ai/probe-a.shared.ts）：(b*) 驅動＋(c*) 影子、(c*) 驅動＋(b*) 影子，各跑一遍。
      const probe = compareBC(s7Spec(b, c, seeds, cell, 'press'));
      const feint = divergence(s7Spec(b, c, seeds, cell, 'feint'));
      const seat = bySeat(b, c, seeds, cell);
      // (d) 上限：AI 的同一個引擎當玩家（不是 (c)；看上限與鏡像）。
      const engine = compareBC(s7Spec(b, 'd-engine', seeds, cell, 'press'));
      // 敏感度分析：每個 (c) 成員對自己的基底。
      const pairs =
        process.env.S7_PROBE_PAIRS === undefined
          ? []
          : PAIRS.map(([base, member]) => ({
              base,
              member,
              probe: compareBC(s7Spec(base, member, seeds, cell, 'press')),
            }));
      results.push({ cell, b, c, bRows, cRows, probe, feint, seat, engine, pairs });
      // 每量完一格就寫一次，長時間的量測中途也看得到已經完成的格子。
      if (process.env.S7_PROBE_OUT !== undefined) {
        writeFileSync(
          process.env.S7_PROBE_OUT,
          JSON.stringify({ train: TRAIN, test: TEST, results }, null, 1),
        );
      }
      if (process.env.S7_PROBE_VERBOSE !== undefined) {
        console.log(formatProbeA(`S-7 ${cellLabel(cell)} ${b} vs ${c}`, probe));
        console.log(
          `  假動作點 ${String(feint.pointsDiff)}/${String(feint.points)}（場級 ${String(feint.gamesDiffer)}/${String(feint.games)}）`,
        );
        console.log(formatProbeA(`  (d) ${b} vs d-engine`, engine));
        for (const row of pairs) {
          console.log(formatProbeA(`  [敏感度] ${row.base} vs ${row.member}`, row.probe));
        }
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
    }
  }, 7_200_000);

  it('等待曲線（診斷，敏感度分析，不進族）：守則 105、2% 假動作，k ＝ 0／5／10／15／20／30，主格', () => {
    if (SWEEP === 0) {
      return;
    }
    const seeds = seedsOf(SWEEP_FROM, SWEEP);
    const rows = [0, 5, 10, 15, 20, 30].map((k) => {
      const rs = seeds.map((seed) =>
        playWith(
          seed,
          makeSweepMember({ k, guard: 105, p: 0.02 }, seed, PRIMARY_CELL.delay),
          PRIMARY_CELL,
        ),
      );
      return {
        k,
        win: (100 * rs.reduce((a, r) => a + r.win, 0)) / rs.length,
        margin: rs.reduce((a, r) => a + r.margin, 0) / rs.length,
      };
    });
    if (process.env.S7_PROBE_VERBOSE !== undefined) {
      console.log('S-7 等待曲線 ' + JSON.stringify(rows));
    }
    if (process.env.S7_PROBE_OUT !== undefined) {
      writeFileSync(process.env.S7_PROBE_OUT + '.sweep.json', JSON.stringify(rows, null, 1));
    }
    expect(rows).toHaveLength(6);
  }, 7_200_000);
});
