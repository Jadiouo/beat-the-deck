import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { levelController, policyByName } from '../../ai/level';
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
import { h3Game } from './logic';
import type { H3State } from './logic';
import { B_FAMILY, C_FAMILY, NEED_TWINS, TWINS, member } from './probe-a.members.test-helpers';
import {
  AI_SEED_OFFSET,
  CONFIG,
  playWith,
  score,
  selectBest,
  selectDeviating,
  spec,
} from './probe-a.test-helpers';
import type { Cell, Row } from './probe-a.test-helpers';

/**
 * H-3 探針 A（完整版）的量測（`docs/cards/H-3.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61）。
 * 定義（兩族、選法、種子、格子、雙胞胎）在量之前寫進小規格並 push，這裡只是照做。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   H3_PROBE_CELL（格子，見下面 CELLS；預設 main ＝ 賭徒型等級 10、玩家延遲 12）
 *   H3_PROBE_STAGE（scan ＝ 只做掃描：每個成員在掃描種子 7000 起的 SCAN_N 場上的勝率與分差；
 *                   pre ＝ 訓練 → 選 (b*)(c*) → 訓練種子上的分歧率，不碰量測種子；
 *                   all ＝ 全部，預設）
 *   H3_PROBE_SCAN_N（掃描場數，預設 2，正式 16；種子 7000 起，這批種子之後不再用）
 *   H3_PROBE_TRAIN_N（訓練場數，預設 4，正式 200；種子 1000 起）
 *   H3_PROBE_N（量測場數，預設 4，正式 400；種子 5000 起）
 *   H3_PROBE_STAGE=levels（支配策略檢查：不讀對手的強 (b) 成員對兩種性格、等級 1 到 10、延遲 12，在種子 9000 起的 H3_PROBE_LEVEL_N 場上的勝率與分差；
 *                   跟 (c)−(b) 無關，量衡量標準 3「人贏得了但不是靠運氣」）
 *   H3_PROBE_LEVEL_N（levels 階段的場數，預設 2，正式 100）、H3_PROBE_LEVEL_MEMBERS（逗號分隔，levels 階段測哪些不讀的 (b) 成員）
 *   H3_PROBE_STAGE=need（量測後加的附錄：每個基底的 need 雙胞胎對它的 (b)，量測種子 5000 起 H3_PROBE_N 場；見 `docs/cards/H-3.md` 附錄）、
 *   H3_PROBE_ALLC（每個 (c) 成員都對 (b*) 量一次）、H3_PROBE_LOG（每行即時附加到這個檔，長時間的量測看進度用）、
 *   H3_PROBE_VERBOSE（印出報告；跑完才看得到）。
 * 可續跑、可分給幾個行程（機器上有別的 agent 在跑，一個行程跑完要很久）：
 *   H3_PROBE_OUT_DIR（把訓練成員、每個量測項目的結果各存成一個 JSON；有的就不重算）、
 *   H3_PROBE_ONLY（逗號分隔的項目名，只做這些：all／seat0／seat1／twin|b|c／c|name／bstar／mirror；沒給就全做）。
 * 不要加 vitest 的 --disable-console-intercept：長時間的行程接管道時會卡住。環境變數不要叫 TEST（vitest 佔用）。
 */

const CELLS: Readonly<Record<string, Cell>> = {
  main: { policy: 'gambler', level: 10, delay: 12, jitter: 0 },
  g10d12: { policy: 'gambler', level: 10, delay: 12, jitter: 0 },
  g10d0: { policy: 'gambler', level: 10, delay: 0, jitter: 0 },
  g9d12: { policy: 'gambler', level: 9, delay: 12, jitter: 0 },
  g8d12: { policy: 'gambler', level: 8, delay: 12, jitter: 0 },
  g7d12: { policy: 'gambler', level: 7, delay: 12, jitter: 0 },
  g5d12: { policy: 'gambler', level: 5, delay: 12, jitter: 0 },
  g3d12: { policy: 'gambler', level: 3, delay: 12, jitter: 0 },
  g1d12: { policy: 'gambler', level: 1, delay: 12, jitter: 0 },
  p10d12: { policy: 'precise', level: 10, delay: 12, jitter: 0 },
  p5d12: { policy: 'precise', level: 5, delay: 12, jitter: 0 },
  // 敏感度分析：玩家的煞車晚 0 到 5 個 tick 才落下（人的手不精準；5 ＝ 人類模型每 6 個 tick 才換一次動作）。
  g10d12j5: { policy: 'gambler', level: 10, delay: 12, jitter: 5 },
  g10d0j5: { policy: 'gambler', level: 10, delay: 0, jitter: 5 },
  g7d12j5: { policy: 'gambler', level: 7, delay: 12, jitter: 5 },
  g5d12j5: { policy: 'gambler', level: 5, delay: 12, jitter: 5 },
  p10d12j5: { policy: 'precise', level: 10, delay: 12, jitter: 5 },
  g10d12j10: { policy: 'gambler', level: 10, delay: 12, jitter: 10 },
  g10d12j15: { policy: 'gambler', level: 10, delay: 12, jitter: 15 },
  g10d12j20: { policy: 'gambler', level: 10, delay: 12, jitter: 20 },
  g10d12j30: { policy: 'gambler', level: 10, delay: 12, jitter: 30 },
  g10d0j20: { policy: 'gambler', level: 10, delay: 0, jitter: 20 },
};
const cellName = process.env['H3_PROBE_CELL'] ?? 'main';
const at = CELLS[cellName] as Cell;
const STAGE = process.env['H3_PROBE_STAGE'] ?? 'all';
const SCAN_N = Math.max(1, Number(process.env['H3_PROBE_SCAN_N'] ?? '2'));
const TRAIN_N = Math.max(1, Number(process.env['H3_PROBE_TRAIN_N'] ?? '4'));
const N = Math.max(1, Number(process.env['H3_PROBE_N'] ?? '4'));
const SCAN_FROM = 7000;
const LEVEL_FROM = 9000;
const LEVEL_MEMBERS = (process.env['H3_PROBE_LEVEL_MEMBERS'] ?? 'b-exact-0,b-exact-8')
  .split(',')
  .filter((x) => x !== '');
const LEVEL_N = Math.max(1, Number(process.env['H3_PROBE_LEVEL_N'] ?? '2'));
const TRAIN_FROM = 1000;
const FROM = 5000;
const range = (from: number, n: number): number[] => Array.from({ length: n }, (_v, i) => from + i);
const scanSeeds = range(SCAN_FROM, SCAN_N);
const trainSeeds = range(TRAIN_FROM, TRAIN_N);
const seeds = range(FROM, N);
const allC = process.env['H3_PROBE_ALLC'] !== undefined;
const verbose = process.env['H3_PROBE_VERBOSE'] !== undefined;
const LOG = process.env['H3_PROBE_LOG'];
const OUT_DIR = process.env['H3_PROBE_OUT_DIR'];
const ONLY = process.env['H3_PROBE_ONLY']?.split(',').filter((x) => x !== '');
const wanted = (name: string): boolean => ONLY === undefined || ONLY.includes(name);

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
  const tag = `H-3.${cellName}.t${String(TRAIN_N)}.n${String(N)}`;
  const file = join(OUT_DIR, `${tag}.${kind}.${key.replace(/[^\w.-]/g, '_')}.json`);
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  }
  const value = compute();
  writeFileSync(file, JSON.stringify(value));
  return value;
}

const pct = (x: number): string => (100 * x).toFixed(1);

/** (d) 參照：AI 自己的引擎（同一個性格、等級 10）當玩家。鏡像，不是 (c)。 */
function mirrorRow(list: readonly number[]): { win: number; margin: number } {
  let win = 0;
  let margin = 0;
  for (const seed of list) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const me = levelController(h3Game, policyByName(at.policy), 10, seed + 7);
    const ai = levelController(h3Game, policyByName(at.policy), at.level, seed + AI_SEED_OFFSET);
    const result =
      side === 0
        ? playMatch(h3Game, seed, CONFIG, me, ai)
        : playMatch(h3Game, seed, CONFIG, ai, me);
    const o = outcomeOf(result, side);
    win += o.win;
    margin += o.margin;
  }
  return { win: win / list.length, margin: margin / list.length };
}

describe(`H-3 探針 A 完整版｜格 ${cellName}（${at.policy} 等級 ${String(at.level)}、玩家延遲 ${String(at.delay)}）`, () => {
  it('掃描（只在 STAGE=scan）：每個成員在掃描種子上的勝率與分差', () => {
    if (STAGE !== 'scan') {
      return;
    }
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      const row = score(name, scanSeeds, at);
      say(
        `掃描 ${cellName} ${name} 勝率 ${pct(row.win)} 分差 ${row.margin.toFixed(2)}（n=${String(SCAN_N)}）`,
      );
    }
    const mirror = mirrorRow(scanSeeds);
    say(`掃描 ${cellName} d-engine 勝率 ${pct(mirror.win)} 分差 ${mirror.margin.toFixed(2)}`);
  }, 7_200_000);

  it('支配策略檢查（只在 STAGE=levels）：不讀對手的強成員對各等級的勝率', () => {
    if (STAGE !== 'levels') {
      return;
    }
    const list = range(LEVEL_FROM, LEVEL_N);
    for (const policy of ['gambler', 'precise'] as const) {
      for (const name of LEVEL_MEMBERS) {
        for (let level = 1; level <= 10; level += 1) {
          const row = score(name, list, { policy, level, delay: 12, jitter: at.jitter });
          say(
            `等級 ${policy} L${String(level)} 延遲 12 抖動 ${String(at.jitter)} ${name} 勝率 ${pct(row.win)} 分差 ${row.margin.toFixed(2)}（n=${String(LEVEL_N)}）`,
          );
        }
      }
    }
  }, 7_200_000);

  it('need 附錄（只在 STAGE=need）：每個基底的 need 雙胞胎對它的 (b)，量測種子（量測後加的附錄，不在 (c) 族裡）', () => {
    if (STAGE !== 'need') {
      return;
    }
    for (const [b, c] of NEED_TWINS) {
      const r = cached('job', `need__${b}__${c}`, () => compareBC(spec(b, c, seeds, at)));
      say(formatProbeA(`H-3 ${cellName} ${b} → ${c} [need|${b}|${c}]`, r));
      expect(r.winBoundHolds).toBe(true);
    }
  }, 7_200_000);

  it('訓練 → 選 (b*)(c*) → 訓練種子上的分歧率 →（階段允許時）量測種子上的 (c)−(b)', () => {
    if (STAGE === 'scan' || STAGE === 'levels' || STAGE === 'need') {
      return;
    }
    const train: Row[] = [];
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      const row = cached('train', name, () => score(name, trainSeeds, at));
      train.push(row);
      say(`訓練 ${name} 勝率 ${pct(row.win)} 分差 ${row.margin.toFixed(2)}`);
    }
    const bStar = selectBest(train.filter((r) => r.name.startsWith('b-')));
    // (c*)：先排除在訓練種子上與 (b*) 逐位元相同的成員（一個從來不讀的讀者不是讀者），再選最強的。
    const cRows = train.filter((r) => r.name.startsWith('c-'));
    const diverged = new Set<string>();
    const inert: string[] = [];
    for (const row of cRows) {
      const d = cached('pre', `${bStar.name}__${row.name}`, () =>
        divergence(spec(bStar.name, row.name, trainSeeds, at)),
      );
      if (d.gamesDiffer > 0) {
        diverged.add(row.name);
      } else {
        inert.push(row.name);
      }
    }
    say(
      `訓練種子上與 (b*) 逐位元相同（不讀）的 (c) 成員 ${String(inert.length)} 個：${inert.join('、')}`,
    );
    const cStar = selectDeviating(cRows, diverged) ?? selectBest(cRows);
    say(`(b*) ＝ ${bStar.name}（${pct(bStar.win)}%）、(c*) ＝ ${cStar.name}（${pct(cStar.win)}%）`);

    // 訓練種子上的分歧率（只跑 (b*) 驅動，不讀勝率）。
    const pre = cached('pre', `${bStar.name}__${cStar.name}`, () =>
      divergence(spec(bStar.name, cStar.name, trainSeeds, at)),
    );
    say(
      `訓練種子上 (b*)=${bStar.name} 對 (c*)=${cStar.name}：場級 ${String(pre.gamesDiffer)}/${String(pre.games)}，點級 ${String(pre.pointsDiff)}/${String(pre.points)}（${pct(pre.pointRate)}%），逐 tick ${pct(pre.tickRate)}%，活躍 tick ${pct(pre.liveRate)}%`,
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
      say(formatProbeA(`H-3 ${cellName} ${b} → ${c} [${label}]`, r));
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
      run(`twin|${b}|${c}`, b, c, seeds);
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
        `(b*) 量測種子上的絕對值：勝率 ${pct(abs.win.mean)}±${pct(abs.win.se)}，分差 ${abs.margin.mean.toFixed(2)}±${abs.margin.se.toFixed(2)}`,
      );
    }
    if (wanted('mirror')) {
      const mirror = cached('job', 'mirror', () => mirrorRow(seeds));
      say(`(d) 鏡像（AI 引擎當玩家）勝率 ${pct(mirror.win)}%，分差 ${mirror.margin.toFixed(2)}`);
    }
  }, 7_200_000);

  it('預設場數下，工具串得起來（兩族都有成員、種子不重疊）', () => {
    expect(trainSeeds.some((s) => seeds.includes(s))).toBe(false);
    expect(scanSeeds.some((s) => seeds.includes(s) || trainSeeds.includes(s))).toBe(false);
    expect(Math.max(...trainSeeds)).toBeLessThan(FROM);
    expect(B_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(C_FAMILY.length).toBeGreaterThanOrEqual(5);
    const state: H3State = h3Game.init(1, CONFIG);
    expect(state.tick).toBe(0);
  });
});
