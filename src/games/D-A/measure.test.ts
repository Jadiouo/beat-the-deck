import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { levelController, policyByName } from '../../ai/level';
import type { PolicyKey } from '../../ai/types';
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
import { dAGame } from './logic';
import type { DAState } from './logic';
import {
  AI_SEED_OFFSET,
  B_FAMILY,
  CONFIG,
  C_FAMILY,
  EXTRA_TWINS,
  TWIN_OF,
  member,
  playWith,
  score,
  selectBest,
  spec,
} from './probe-a.test-helpers';
import type { Cell, Row } from './probe-a.test-helpers';

/**
 * D-A 探針 A（完整版）的量測（`docs/cards/D-A.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61、10.70）。
 * 定義（兩族、選法、種子、格子、雙胞胎）在量之前寫進小規格並 push，這裡只是照做。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   DA_PROBE_CELL（`性格-等級-延遲`，例如 greedy-10-12；預設 greedy-10-12）
 *   DA_PROBE_TRAIN_N（訓練場數，預設 4，正式 100；種子 1000 起）
 *   DA_PROBE_N（量測場數，預設 4，正式 400；種子 5000 起）
 *   DA_PROBE_TWIN_N（雙胞胎對照用的場數，預設 2，正式 400；取量測種子的前 TWIN_N 個）、
 *   DA_PROBE_ALLC（每個 (c) 成員都對 (b*) 量一次）、DA_PROBE_VERBOSE（印出報告；跑完才看得到）、
 *   DA_PROBE_LOG（每行即時附加到這個檔，長時間的量測看進度用）。
 * 不要加 vitest 的 --disable-console-intercept：長時間的行程接管道時會卡住（D-Q 上次整段量測因此停住）。
 * 可續跑、可分給幾個行程（機器上有別的 agent 在跑，一個行程跑完要很久）：
 *   DA_PROBE_OUT_DIR（把每個訓練成員、每個量測項目的結果各存成一個 JSON；有的就不重算）、
 *   DA_PROBE_STAGE（scan ＝ 在掃描種子 7000 起跑兩族全部成員、只印勝率範圍；
 *                train ＝ 只做訓練成員；pre ＝ 選 (b*)(c*) ＋ 訓練種子上的分歧率，不碰量測種子；
 *                jobs ＝ 量測項目；all ＝ 全部，預設）、
 *   DA_PROBE_SCAN_N（掃描場數，預設 16）、
 *   DA_PROBE_ONLY（逗號分隔：train／scan 階段是成員名，jobs 階段是項目名 all／seat0／seat1／twin|b|c／c|name／bstar／mirror）。
 * 環境變數不要叫 TEST（vitest 佔用）。
 */

function parseCell(text: string): Cell {
  const [policy, level, delay] = text.split('-');
  return { policy: policy as PolicyKey, level: Number(level), delay: Number(delay) };
}
const cellName = process.env['DA_PROBE_CELL'] ?? 'greedy-10-12';
const at = parseCell(cellName);
const TRAIN_N = Math.max(1, Number(process.env['DA_PROBE_TRAIN_N'] ?? '4'));
const N = Math.max(1, Number(process.env['DA_PROBE_N'] ?? '4'));
const SCAN_N = Math.max(1, Number(process.env['DA_PROBE_SCAN_N'] ?? '16'));
const SCAN_FROM = 7000;
const TRAIN_FROM = 1000;
const FROM = 5000;
const scanSeeds = Array.from({ length: SCAN_N }, (_v, i) => SCAN_FROM + i);
const trainSeeds = Array.from({ length: TRAIN_N }, (_v, i) => TRAIN_FROM + i);
const seeds = Array.from({ length: N }, (_v, i) => FROM + i);
/** 雙胞胎對照（小規格「雙胞胎」一節，量之前固定）：機器完全一樣、只差「讀對手」那一項的 [(b), (c)]。 */
const TWINS: readonly (readonly [string, string])[] = [
  ...Object.entries(TWIN_OF)
    .filter((e): e is [string, string] => e[1] !== null)
    .filter(([b]) => b !== 'b-stick'),
  ...EXTRA_TWINS,
];
const TWIN_N = Math.min(N, Math.max(1, Number(process.env['DA_PROBE_TWIN_N'] ?? '2')));
const twinSeeds = seeds.slice(0, TWIN_N);
const allC = process.env['DA_PROBE_ALLC'] !== undefined;
const verbose = process.env['DA_PROBE_VERBOSE'] !== undefined;
const OUT_DIR = process.env['DA_PROBE_OUT_DIR'];
const LOG = process.env['DA_PROBE_LOG'];
const STAGE = process.env['DA_PROBE_STAGE'] ?? 'all';
const ONLY = process.env['DA_PROBE_ONLY']?.split(',').filter((s) => s !== '');

const say = (text: string): void => {
  if (LOG !== undefined) {
    appendFileSync(LOG, text + '\n');
  }
  if (verbose) {
    console.log(text);
  }
};

/** 有 OUT_DIR 就把結果存成檔（鍵含格子與場數，換設定不會讀到舊的）；有檔就直接讀。 */
function cached<T>(kind: string, key: string, compute: () => T): T {
  if (OUT_DIR === undefined) {
    return compute();
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const tag = `${cellName}.t${String(TRAIN_N)}.n${String(N)}.w${String(TWIN_N)}.s${String(SCAN_N)}`;
  const file = join(OUT_DIR, `${tag}.${kind}.${key.replace(/[^\w.-]/g, '_')}.json`);
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  }
  const value = compute();
  writeFileSync(file, JSON.stringify(value));
  return value;
}

const wanted = (name: string): boolean => ONLY === undefined || ONLY.includes(name);

/** (d) 參照：AI 自己的引擎（同性格、等級 10）當玩家。鏡像，不是 (c)。 */
function mirrorRow(list: readonly number[]): { win: number; margin: number } {
  let win = 0;
  let margin = 0;
  for (const seed of list) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const me = levelController(dAGame, policyByName(at.policy), 10, seed + 7);
    const ai = levelController(dAGame, policyByName(at.policy), at.level, seed + AI_SEED_OFFSET);
    const result =
      side === 0
        ? playMatch(dAGame, seed, CONFIG, me, ai)
        : playMatch(dAGame, seed, CONFIG, ai, me);
    const o = outcomeOf(result, side);
    win += o.win;
    margin += o.margin;
  }
  return { win: win / list.length, margin: margin / list.length };
}

describe(`D-A 探針 A 完整版｜格 ${cellName}（AI ${at.policy} 等級 ${String(at.level)}、玩家延遲 ${String(at.delay)}）`, () => {
  it('掃描 → 訓練 → 選 (b*)(c*) → 訓練種子上的分歧率 →（階段允許時）量測種子上的 (c)−(b)', () => {
    const names = [...B_FAMILY, ...C_FAMILY];
    if (STAGE === 'scan') {
      const rows: Row[] = [];
      for (const name of names) {
        if (!wanted(name)) {
          continue;
        }
        const row = cached('scan', name, () => score(name, scanSeeds, at));
        rows.push(row);
        say(
          `掃描 ${cellName} ${name} 勝率 ${(100 * row.win).toFixed(1)} 分差 ${row.margin.toFixed(2)}`,
        );
      }
      expect(rows.length).toBeGreaterThan(0);
      return;
    }
    // 訓練：兩族全部成員（可分給幾個行程）。
    const train: Row[] = [];
    for (const name of names) {
      if (STAGE === 'train' && !wanted(name)) {
        continue;
      }
      train.push(cached('train', name, () => score(name, trainSeeds, at)));
      say(
        `訓練 ${name} 勝率 ${(100 * (train[train.length - 1] as Row).win).toFixed(1)} 分差 ${(train[train.length - 1] as Row).margin.toFixed(2)}`,
      );
    }
    if (STAGE === 'train') {
      expect(train.length).toBeGreaterThan(0);
      return;
    }
    const bStar = selectBest(train.filter((r) => r.name.startsWith('b-')));
    const cStar = selectBest(train.filter((r) => r.name.startsWith('c-')));
    say(
      `(b*) ＝ ${bStar.name}（${(100 * bStar.win).toFixed(1)}%）、(c*) ＝ ${cStar.name}（${(100 * cStar.win).toFixed(1)}%）`,
    );
    writeIfDir('select', { bStar, cStar, train });

    // 訓練種子上的分歧率（只跑 (b*) 驅動，不讀勝率）。
    const pre = cached('pre', `${bStar.name}__${cStar.name}`, () =>
      divergence(spec(bStar.name, cStar.name, trainSeeds, at)),
    );
    say(
      `訓練種子上 (b*)=${bStar.name} 對 (c*)=${cStar.name}：場級 ${String(pre.gamesDiffer)}/${String(pre.games)}，點級 ${String(pre.pointsDiff)}/${String(pre.points)}，逐 tick ${(100 * pre.tickRate).toFixed(2)}%，活躍 tick ${(100 * pre.liveRate).toFixed(1)}%`,
    );
    expect(pre.games).toBe(TRAIN_N);
    if (STAGE === 'pre') {
      return;
    }

    // 量測。
    const results: Record<string, ProbeAResult> = {};
    const run = (label: string, b: string, c: string, list: readonly number[]): void => {
      if (!wanted(label)) {
        return;
      }
      const r = cached('job', label.replace(/\|/g, '__'), () => compareBC(spec(b, c, list, at)));
      results[label] = r;
      say(formatProbeA(`D-A ${cellName} ${b} → ${c} [${label}]`, r));
      expect(r.winBoundHolds).toBe(true);
      expect(r.inconsistentSeeds).toEqual([]);
    };
    run('all', bStar.name, cStar.name, seeds);
    run(
      'seat0',
      bStar.name,
      cStar.name,
      seeds.filter((s) => s % 2 === 0),
    );
    run(
      'seat1',
      bStar.name,
      cStar.name,
      seeds.filter((s) => s % 2 === 1),
    );
    for (const [b, c] of TWINS) {
      run(`twin|${b}|${c}`, b, c, twinSeeds);
    }
    if (allC) {
      for (const c of C_FAMILY) {
        if (c !== cStar.name) {
          run(`c|${c}`, bStar.name, c, seeds);
        }
      }
    }
    // 參照：(b*) 自己的絕對勝率（陷阱一：(b*) 夠不夠強）、(d) 鏡像。
    if (wanted('bstar')) {
      const abs = cached('job', 'bstar', () => {
        const rows = seeds.map((s) => playWith(s, member(bStar.name), at));
        return {
          win: pairedStats(rows.map((o) => o.win)),
          margin: pairedStats(rows.map((o) => o.margin)),
        };
      });
      say(
        `(b*) 量測種子上的絕對值：勝率 ${(100 * abs.win.mean).toFixed(1)}，分差 ${abs.margin.mean.toFixed(2)}`,
      );
    }
    if (wanted('mirror')) {
      const mirror = cached('job', 'mirror', () => mirrorRow(seeds));
      say(
        `(d) 鏡像（AI 引擎當玩家）勝率 ${(100 * mirror.win).toFixed(1)}%，分差 ${mirror.margin.toFixed(2)}`,
      );
    }
  }, 7_200_000);

  it('預設場數下，工具串得起來（兩族都有成員、種子不重疊）', () => {
    expect(trainSeeds.some((s) => seeds.includes(s))).toBe(false);
    expect(scanSeeds.some((s) => seeds.includes(s) || trainSeeds.includes(s))).toBe(false);
    expect(Math.max(...trainSeeds)).toBeLessThan(FROM);
    expect(B_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(C_FAMILY.length).toBeGreaterThanOrEqual(5);
    const state: DAState = dAGame.init(1, CONFIG);
    expect(state.tick).toBe(0);
  });
});

function writeIfDir(kind: string, value: unknown): void {
  if (OUT_DIR !== undefined) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(
        OUT_DIR,
        `${cellName}.t${String(TRAIN_N)}.n${String(N)}.w${String(TWIN_N)}.${kind}.json`,
      ),
      JSON.stringify(value),
    );
  }
}
