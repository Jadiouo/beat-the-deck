import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { greedy } from '../../ai/policies/greedy';
import { playMatch } from '../../core/match';
import type { Side } from '../../core/types';
import {
  compareBC,
  divergence,
  formatProbeA,
  outcomeOf,
  pairedStats,
} from '../../../tests/ai/probe-a.shared';
import type { ProbeAResult } from '../../../tests/ai/probe-a.shared';
import { d8Game } from './logic';
import type { D8State } from './logic';
import {
  AI_SEED_OFFSET,
  B_FAMILY,
  CONFIG,
  C_FAMILY,
  member,
  playWith,
  score,
  selectBest,
  spec,
} from './probe-a.test-helpers';
import type { Cell, Row } from './probe-a.test-helpers';

/**
 * D-8 探針 A（完整版）的量測（`docs/cards/D-8.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61）。
 * 定義（兩族、選法、種子、格子）在量之前寫進小規格並 push（見 `git log -- docs/cards/D-8.md` 的「探針 A 完整版」那個 docs commit），這裡只是照做。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   D8_PROBE_CELL（main ＝ 貪心型等級 10、玩家延遲 12；d0 ＝ 等級 10 延遲 0；l7、l5 ＝ 等級 7、5 延遲 12；預設 main）
 *   D8_PROBE_TRAIN_N（訓練場數，預設 4，正式 60；種子 1000 起）
 *   D8_PROBE_N（量測場數，預設 4，正式 400；種子 5000 起）
 *   D8_PROBE_TWIN_N（雙胞胎對照用的場數，預設 2，正式 200；取量測種子的前 TWIN_N 個）、D8_PROBE_ALLC（每個 (c) 成員都對 (b*) 量一次）、
 *   D8_PROBE_VERBOSE（印出報告）、D8_PROBE_OUT（把結果寫成 JSON 的路徑）、
 *   D8_PROBE_PRE_ONLY（只做訓練與訓練種子上的分歧率，不碰量測種子）。
 * 環境變數不要叫 TEST（vitest 佔用）。
 */

const CELLS: Readonly<Record<string, Cell>> = {
  main: { policy: 'greedy', level: 10, delay: 12 },
  d0: { policy: 'greedy', level: 10, delay: 0 },
  l7: { policy: 'greedy', level: 7, delay: 12 },
  l5: { policy: 'greedy', level: 5, delay: 12 },
};
const cellName = process.env['D8_PROBE_CELL'] ?? 'main';
const at = CELLS[cellName] as Cell;
const TRAIN_N = Math.max(1, Number(process.env['D8_PROBE_TRAIN_N'] ?? '4'));
const N = Math.max(1, Number(process.env['D8_PROBE_N'] ?? '4'));
const TRAIN_FROM = 1000;
const FROM = 5000;
const trainSeeds = Array.from({ length: TRAIN_N }, (_v, i) => TRAIN_FROM + i);
const seeds = Array.from({ length: N }, (_v, i) => FROM + i);
/** 雙胞胎對照（小規格「雙胞胎」一節，量之前固定）：機器完全一樣、只差「讀對手」那一項的 [(b), (c)]。 */
const TWINS: readonly (readonly [string, string])[] = [
  ['b-box7-fill', 'c-box7-cut'],
  ['b-box6-fill', 'c-box6-cut'],
  ['b-box7-near', 'c-box7-away'],
  ['b-box6-near', 'c-box6-away'],
  ['b-nearest', 'c-nearest-chase'],
  ['b-nearest', 'c-nearest-swing'],
  ['b-nearest', 'c-nearest-avoid'],
  ['b-snake2', 'c-snake2-flee'],
];
const TWIN_N = Math.min(N, Math.max(1, Number(process.env['D8_PROBE_TWIN_N'] ?? '2')));
const twinSeeds = seeds.slice(0, TWIN_N);
const allC = process.env['D8_PROBE_ALLC'] !== undefined;
const verbose = process.env['D8_PROBE_VERBOSE'] !== undefined;
const preOnly = process.env['D8_PROBE_PRE_ONLY'] !== undefined;

const say = (text: string): void => {
  if (verbose) {
    console.log(text);
  }
};

const pp = (x: number): string => (x >= 0 ? '+' : '') + (100 * x).toFixed(1);

/** (d) 參照：AI 自己的引擎（貪心型等級 10）當玩家。鏡像，不是 (c)。 */
function mirrorRow(list: readonly number[]): { win: number; margin: number } {
  let win = 0;
  let margin = 0;
  for (const seed of list) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const me = levelController(d8Game, greedy, 10, seed + 7);
    const ai = levelController(d8Game, greedy, at.level, seed + AI_SEED_OFFSET);
    const result =
      side === 0
        ? playMatch(d8Game, seed, CONFIG, me, ai)
        : playMatch(d8Game, seed, CONFIG, ai, me);
    const o = outcomeOf(result, side);
    win += o.win;
    margin += o.margin;
  }
  return { win: win / list.length, margin: margin / list.length };
}

describe(`D-8 探針 A 完整版｜格 ${cellName}（貪心型等級 ${String(at.level)}、玩家延遲 ${String(at.delay)}）`, () => {
  it('訓練 → 選 (b*)(c*) → 訓練種子上的分歧率 →（不是 PRE_ONLY 才）量測種子上的 (c)−(b)', () => {
    const out: Record<string, unknown> = {
      cell: cellName,
      at,
      trainSeeds: [TRAIN_FROM, TRAIN_N],
      seeds: [FROM, N],
    };

    // 訓練：兩族全部成員。
    const train: Row[] = [...B_FAMILY, ...C_FAMILY].map((name) => score(name, trainSeeds, at));
    const trainB = train.filter((r) => r.name.startsWith('b-'));
    const trainC = train.filter((r) => r.name.startsWith('c-'));
    const bStar = selectBest(trainB);
    const cStar = selectBest(trainC);
    out['train'] = train;
    out['bStar'] = bStar.name;
    out['cStar'] = cStar.name;
    for (const r of train) {
      say(`訓練 ${r.name} 勝率 ${(100 * r.win).toFixed(1)} 分差 ${r.margin.toFixed(2)}`);
    }
    say(
      `(b*) ＝ ${bStar.name}（${(100 * bStar.win).toFixed(1)}%）、(c*) ＝ ${cStar.name}（${(100 * cStar.win).toFixed(1)}%）`,
    );

    // 訓練種子上的分歧率（只跑 (b*) 驅動，不讀勝率）。
    const pre = divergence(spec(bStar.name, cStar.name, trainSeeds, at));
    out['preDivergence'] = pre;
    say(
      `訓練種子上 (b*)=${bStar.name} 對 (c*)=${cStar.name}：場級 ${String(pre.gamesDiffer)}/${String(pre.games)}，點級 ${String(pre.pointsDiff)}/${String(pre.points)}，逐 tick ${(100 * pre.tickRate).toFixed(2)}%，活躍 tick ${(100 * pre.liveRate).toFixed(1)}%`,
    );
    expect(pre.games).toBe(TRAIN_N);

    if (preOnly) {
      if (process.env['D8_PROBE_OUT'] !== undefined) {
        writeFileSync(process.env['D8_PROBE_OUT'], JSON.stringify(out, null, 1));
      }
      return;
    }

    // 量測：(c*)−(b*)，全部、0 號邊、1 號邊分開。
    const results: Record<string, ProbeAResult> = {};
    const run = (label: string, list: readonly number[], c: string): void => {
      const r = compareBC(spec(bStar.name, c, list, at));
      results[label] = r;
      say(formatProbeA(`D-8 ${cellName} (b*)=${bStar.name} (c)=${c} [${label}]`, r));
      expect(r.winBoundHolds).toBe(true);
      expect(r.inconsistentSeeds).toEqual([]);
    };
    run(`all|${cStar.name}`, seeds, cStar.name);
    run(
      `seat0|${cStar.name}`,
      seeds.filter((s) => s % 2 === 0),
      cStar.name,
    );
    run(
      `seat1|${cStar.name}`,
      seeds.filter((s) => s % 2 === 1),
      cStar.name,
    );
    // 敏感度：(c) 族每個成員對 (b*)（事後的敏感度分析，不是標籤）。
    if (allC) {
      for (const c of C_FAMILY) {
        if (c !== cStar.name) {
          run(`all|${c}`, seeds, c);
        }
      }
    }
    // 雙胞胎對照：機器一樣、只差「讀對手」。
    for (const [b, c] of TWINS) {
      const r = compareBC(spec(b, c, twinSeeds, at));
      results[`twin|${b}|${c}`] = r;
      say(formatProbeA(`${b} → ${c} [twin]`, r));
      expect(r.winBoundHolds).toBe(true);
      expect(r.inconsistentSeeds).toEqual([]);
    }
    out['results'] = results;

    // 參照：(b*) 自己的絕對勝率（陷阱一：(b*) 夠不夠強）、(d) 鏡像。
    const bAbs = seeds.map((s) => playWith(s, member(bStar.name), at));
    out['bStarAbs'] = {
      win: pairedStats(bAbs.map((o) => o.win)),
      margin: pairedStats(bAbs.map((o) => o.margin)),
    };
    say(
      `(b*) 量測種子上的絕對值：勝率 ${pp(pairedStats(bAbs.map((o) => o.win)).mean)}，分差 ${pairedStats(bAbs.map((o) => o.margin)).mean.toFixed(2)}`,
    );
    const mirror = mirrorRow(seeds);
    out['mirror'] = mirror;
    say(
      `(d) 鏡像（AI 引擎當玩家）勝率 ${(100 * mirror.win).toFixed(1)}%，分差 ${mirror.margin.toFixed(2)}`,
    );

    if (process.env['D8_PROBE_OUT'] !== undefined) {
      writeFileSync(process.env['D8_PROBE_OUT'], JSON.stringify(out, null, 1));
    }
  }, 7_200_000);

  it('預設場數下，工具串得起來（兩族都有成員、種子不重疊）', () => {
    expect(trainSeeds.some((s) => seeds.includes(s))).toBe(false);
    expect(Math.max(...trainSeeds)).toBeLessThan(FROM);
    expect(B_FAMILY.length).toBeGreaterThanOrEqual(5);
    const state: D8State = d8Game.init(1, CONFIG);
    expect(state.tick).toBe(0);
  });
});
