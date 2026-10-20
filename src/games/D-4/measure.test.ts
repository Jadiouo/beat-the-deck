import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC, formatProbeA, pairedStats } from '../../../tests/ai/probe-a.shared';
import { B_FAMILY, C_FAMILY } from './probe-a.members.test-helpers';
import {
  CELLS,
  PRIMARY_CELL,
  cellLabel,
  controllerFor,
  d4Spec,
  playWith,
  selectBest,
  trainFamily,
} from './probe-a.test-helpers';
import type { Cell } from './probe-a.test-helpers';

/**
 * D-4 探針 A（完整版）的量測（`docs/cards/D-4.md`「探針 A（完整版）」）。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   D4_PROBE_CELLS（`primary`｜`all`｜用逗號分隔的格子編號，預設 `primary`）、
 *   D4_PROBE_TRAIN（訓練場數，預設 2，種子 1000 起）、D4_PROBE_TEST（量測場數，預設 2，種子 5000 起）、
 *   D4_PROBE_OUT（把完整結果寫成 JSON 的路徑）、D4_PROBE_VERBOSE（印出一行報告）、
 *   D4_PROBE_PAIRS（設了就把每個 (c) 對自己的基底量一遍，敏感度分析）、D4_PROBE_ALLC（設了就把每個 (c) 成員都對 (b*) 量一遍，敏感度分析，不是標籤數字）。
 * 訓練種子 1000.. 與量測種子 5000.. 與掃描種子 2000.. 都不重疊（場數 < 1000）。
 */
const TRAIN = Number(process.env.D4_PROBE_TRAIN ?? 2);
const TEST = Number(process.env.D4_PROBE_TEST ?? 2);
const TRAIN_FROM = 1000;
const TEST_FROM = 5000;

/**
 * 敏感度分析（不是標籤數字）：每個 (c) 成員對它**自己的基底** (b)（小規格第 4 節表的「基底」欄），
 * 兩者只差讀對手的那一條規則。
 */
const PAIRS: readonly (readonly [string, string])[] = [
  ['b-thr12', 'c-free-thr12'],
  ['b-thr20', 'c-free-thr20'],
  ['b-thr12', 'c-contest-thr12'],
  ['b-thr12', 'c-squeeze-thr12'],
  ['b-thr20', 'c-free-squeeze-thr20'],
  ['b-plan-m4', 'c-calc'],
  ['b-plan-m4-det', 'c-all'],
];

const seedsOf = (from: number, n: number): number[] =>
  Array.from({ length: n }, (_v, i) => from + i);

function cellsToRun(): readonly Cell[] {
  const spec = process.env.D4_PROBE_CELLS ?? 'primary';
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

describe(`D-4 探針 A 完整版（訓練 ${String(TRAIN)} 場、量測 ${String(TEST)} 場）`, () => {
  it('每一格：選 (b*)、(c*)，量決策分歧率（場級＋點級）與 (c)−(b)；|(c)−(b)| 不超過場級分歧率', () => {
    const results = [];
    for (const cell of cellsToRun()) {
      const bRows = trainFamily(B_FAMILY, cell, seedsOf(TRAIN_FROM, TRAIN));
      const cRows = trainFamily(C_FAMILY, cell, seedsOf(TRAIN_FROM, TRAIN));
      const b = selectBest(bRows);
      const c = selectBest(cRows);
      const seeds = seedsOf(TEST_FROM, TEST);
      // 共用層（tests/ai/probe-a.shared.ts）：(b*) 驅動＋(c*) 影子、(c*) 驅動＋(b*) 影子，各跑一遍。
      const probe = compareBC(d4Spec(b, c, seeds, cell));
      const seat = bySeat(b, c, seeds, cell);
      // (d) 上限：AI 的同一個引擎當玩家（不是 (c)；看上限與鏡像）。
      const engine = compareBC(d4Spec(b, 'd-engine', seeds, cell));
      // 敏感度分析：每個 (c) 成員都對 (b*)。
      const allC =
        process.env.D4_PROBE_ALLC === undefined
          ? []
          : C_FAMILY.map((name) => ({ name, probe: compareBC(d4Spec(b, name, seeds, cell)) }));
      // 敏感度分析：每個 (c) 成員對自己的基底。
      const pairs =
        process.env.D4_PROBE_PAIRS === undefined
          ? []
          : PAIRS.map(([base, member]) => ({
              base,
              member,
              probe: compareBC(d4Spec(base, member, seeds, cell)),
            }));
      results.push({ cell, b, c, bRows, cRows, probe, seat, engine, allC, pairs });
      // 每量完一格就寫一次，長時間的量測中途也看得到已經完成的格子。
      if (process.env.D4_PROBE_OUT !== undefined) {
        writeFileSync(
          process.env.D4_PROBE_OUT,
          JSON.stringify({ train: TRAIN, test: TEST, results }, null, 1),
        );
      }
      if (process.env.D4_PROBE_VERBOSE !== undefined) {
        console.log(formatProbeA(`D-4 ${cellLabel(cell)} ${b} vs ${c}`, probe));
        console.log(formatProbeA(`  (d) ${b} vs d-engine`, engine));
        for (const row of pairs) {
          console.log(formatProbeA(`  [敏感度] ${row.base} vs ${row.member}`, row.probe));
        }
        for (const row of allC) {
          console.log(formatProbeA(`  [敏感度] ${b} vs ${row.name}`, row.probe));
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
});
