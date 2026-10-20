import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC, divergence, formatProbeA, pairedStats } from '../../../tests/ai/probe-a.shared';
import {
  B_FAMILY,
  CELLS,
  C_FAMILY,
  MEASURE_FROM,
  TEMPOS,
  TRAIN_FROM,
  playCell,
  s5Spec,
  selectBest,
  trainTable,
} from './probe-a.test-helpers';
import type { MemberName } from './probe-a.test-helpers';
import { makeUpperBound } from './probe-a.rival.test-helpers';

/**
 * S-5 完整探針 A 的量測（`docs/cards/S-5.md`「完整探針 A」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61）。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   S5_PROBE_CELLS（格子 id，逗號分隔，預設第一格）、S5_PROBE_TRAIN（訓練場數，預設 2，種子 20000 起）、
 *   S5_PROBE_N（量測場數，預設 4，種子 0 起）、S5_PROBE_PHASE（select | div | measure | all，預設 all）、
 *   S5_PROBE_B、S5_PROBE_C（div 與 measure 階段要用的 (b\*)、(c\*) 名字；沒給就讀 select 階段寫的 JSON）、
 *   S5_PROBE_OUT（結果 JSON 的資料夾）、S5_PROBE_VERBOSE（把報告印出來）。
 * 分階段的理由（10.59）：先 select（訓練種子上選 (b\*)(c\*)），再 div（只報決策分歧率，不碰勝率），
 * 分歧率有效才跑 measure（讀 (c)−(b)）。環境變數不叫 TEST（vitest 佔用）。
 */
const env = (k: string): string | undefined => process.env[k];
const N = Math.max(1, Number(env('S5_PROBE_N') ?? '4'));
const TRAIN = Math.max(1, Number(env('S5_PROBE_TRAIN') ?? '2'));
const PHASE = env('S5_PROBE_PHASE') ?? 'all';
const OUT = env('S5_PROBE_OUT');
const LONG = 7_200_000;
const cells = (env('S5_PROBE_CELLS') ?? CELLS[0]?.id ?? '')
  .split(',')
  .map((id) => CELLS.find((c) => c.id === id))
  .filter((c): c is (typeof CELLS)[number] => c !== undefined);

const seedsOf = (from: number, n: number): number[] =>
  Array.from({ length: n }, (_v, i) => from + i);

function say(text: string): void {
  if (env('S5_PROBE_VERBOSE') !== undefined) {
    console.log(text);
    // 這個專案的 vitest 設定下 console 輸出常被吞掉，所以同時寫進輸出資料夾的 report.txt。
    if (OUT !== undefined) {
      mkdirSync(OUT, { recursive: true });
      appendFileSync(`${OUT}/report.txt`, text + '\n');
    }
  }
}

function save(name: string, value: unknown): void {
  if (OUT !== undefined) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/${name}.json`, JSON.stringify(value, null, 1));
  }
}

const picked = new Map<string, { b: MemberName; c: MemberName }>();

function pick(cellId: string): { b: MemberName; c: MemberName } {
  const inProcess = picked.get(cellId);
  if (inProcess !== undefined) {
    return inProcess;
  }
  const b = env('S5_PROBE_B');
  const c = env('S5_PROBE_C');
  if (b !== undefined && c !== undefined) {
    return { b: b as MemberName, c: c as MemberName };
  }
  if (OUT === undefined) {
    throw new Error('沒有 S5_PROBE_B／S5_PROBE_C，也沒有 S5_PROBE_OUT 可以讀 select 階段的結果');
  }
  const saved = JSON.parse(readFileSync(`${OUT}/${cellId}.select.json`, 'utf8')) as {
    b: MemberName;
    c: MemberName;
  };
  return { b: saved.b, c: saved.c };
}

describe(`S-5 完整探針 A（階段 ${PHASE}；訓練 ${String(TRAIN)} 場、量測 ${String(N)} 場）`, () => {
  for (const cell of cells) {
    const trainSeeds = seedsOf(TRAIN_FROM, TRAIN);
    const seeds = seedsOf(MEASURE_FROM, N);
    const even = seeds.filter((s) => s % 2 === 0);
    const odd = seeds.filter((s) => s % 2 === 1);

    it(
      `${cell.id}｜select：訓練種子上選 (b*)、(c*)`,
      () => {
        if (PHASE !== 'select' && PHASE !== 'all') return;
        const bRows = trainTable(B_FAMILY, cell, trainSeeds);
        const cRows = trainTable(C_FAMILY, cell, trainSeeds);
        const b = selectBest(bRows) as MemberName;
        const c = selectBest(cRows) as MemberName;
        picked.set(cell.id, { b, c });
        save(`${cell.id}.select`, { cell, train: TRAIN, b, c, bRows, cRows });
        say(
          `S-5 ${cell.id} 訓練（種子 ${String(TRAIN_FROM)}..${String(TRAIN_FROM + TRAIN - 1)}）(b*)=${b} (c*)=${c}`,
        );
        say(
          [...bRows, ...cRows]
            .map((r) => `  ${r.name}: win ${r.win.toFixed(1)} margin ${r.margin.toFixed(2)}`)
            .join('\n'),
        );
        expect(B_FAMILY).toContain(b);
        expect(C_FAMILY).toContain(c);
      },
      LONG,
    );

    it(
      `${cell.id}｜div：只報決策分歧率（不碰勝率）`,
      () => {
        if (PHASE !== 'div' && PHASE !== 'all') return;
        const { b, c } = pick(cell.id);
        const d = divergence(s5Spec(b, c, cell, seeds));
        save(`${cell.id}.div`, { cell, n: N, b, c, divergence: d });
        say(
          `S-5 ${cell.id} 分歧率 (b*)=${b} (c*)=${c} n=${String(N)} 場級 ${String(d.gamesDiffer)}/${String(d.games)}=${(100 * d.gameRate).toFixed(1)}% 點級(決策點) ${String(d.pointsDiff)}/${String(d.points)}=${(100 * d.pointRate).toFixed(1)}% 逐 tick ${(100 * d.tickRate).toFixed(2)}%`,
        );
        expect(d.games).toBe(N);
      },
      LONG,
    );

    it(
      `${cell.id}｜measure：(c)−(b)、座位分組、(d) 上限`,
      () => {
        if (PHASE !== 'measure' && PHASE !== 'all') return;
        const { b, c } = pick(cell.id);
        const all = compareBC(s5Spec(b, c, cell, seeds));
        const bySeat = [even, odd].map((group) =>
          group.length > 0 ? compareBC(s5Spec(b, c, cell, group)) : undefined,
        );
        const upper = seeds.map((seed) =>
          playCell(seed, makeUpperBound(TEMPOS[cell.tempo], seed), cell),
        );
        const d = {
          win: pairedStats(upper.map((o) => o.win)),
          margin: pairedStats(upper.map((o) => o.margin)),
        };
        save(`${cell.id}.measure`, { cell, n: N, b, c, all, bySeat, upper: d });
        say(formatProbeA(`S-5 ${cell.id} ${b} vs ${c}`, all));
        say(`  座位 0 邊：${bySeat[0] ? formatProbeA('seat0', bySeat[0]) : 'n/a'}`);
        say(`  座位 1 邊：${bySeat[1] ? formatProbeA('seat1', bySeat[1]) : 'n/a'}`);
        say(
          `  (d) AI 引擎照玩家節奏：勝率 ${(100 * d.win.mean).toFixed(1)}% 分差 ${d.margin.mean.toFixed(2)}±${d.margin.se.toFixed(2)}`,
        );
        expect(all.n).toBe(N);
        // 沒有決策差別的場，兩條對局逐位元相同，勝率差必為 0：|(c)−(b)| ≤ 場級分歧率。
        expect(all.winBoundHolds).toBe(true);
        expect(all.inconsistentSeeds).toEqual([]);
      },
      LONG,
    );
  }
});
