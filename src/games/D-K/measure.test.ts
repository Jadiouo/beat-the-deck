import { describe, expect, it } from 'vitest';

import { humanModel } from '../../ai/human-model';
import { levelController, wrapPolicy } from '../../ai/level';
import { greedy } from '../../ai/policies/greedy';
import { copyButtons, playMatch } from '../../core/match';
import type { Controller, Side } from '../../core/types';
import type { LevelParams } from '../../ai/types';
import { dKGame, stageOf } from './logic';
import type { DKState } from './logic';
import {
  CONFIG,
  PROBE_A,
  engineThenSteal,
  playTraced,
  script,
  scriptPolicy,
} from './players.test-helpers';
import type { ScriptSpec } from './players.test-helpers';
import { compareBC, formatProbeA, outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { ProbeSpec } from '../../../tests/ai/probe-a.shared';

/**
 * D-K 的量測型測試（小規格「實作與量測」；DESIGN-AI-FUN 3 反應速度、10.27、10.40 支配策略、10.54、10.57）。
 * 真實規則、真實 AI、固定種子，所以數字是確定的；斷言訂在量到的值外面留餘裕（不是剛好等於量到的值），
 * 場數比小規格的量測少（那邊 100 到 600 場，在 session 的 scratchpad 跑）。設 `DK_VERBOSE=1` 會印出量到的數字。
 */

const LONG = 3_600_000;
const report = (text: string): void => {
  if (process.env['DK_VERBOSE'] !== undefined) {
    console.log(text);
  }
};
const quantile = (xs: readonly number[], p: number): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)] as number;
const range = (n: number): number[] => Array.from({ length: n }, (_v, i) => i);

type Make = (seed: number) => Controller<DKState>;
const L =
  (level: number): Make =>
  (seed) =>
    levelController(dKGame, greedy, level, seed + 1_000_003);
const HUMAN: Make = (seed) => humanModel(dKGame, seed);

/** a 對 b：a 的勝率（平手算半場），種子奇偶決定 a 坐哪邊；同時回傳每場 tick 數與終局 state。 */
function batch(
  a: Make,
  b: Make,
  seeds: readonly number[],
): { rate: number; ticks: number[]; finals: { state: DKState; side: Side }[] } {
  let points = 0;
  const ticks: number[] = [];
  const finals: { state: DKState; side: Side }[] = [];
  for (const seed of seeds) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const mine = a(seed);
    const theirs = b(seed + 17);
    const trace = side === 0 ? playTraced(seed, mine, theirs) : playTraced(seed, theirs, mine);
    ticks.push(trace.result.ticks);
    finals.push({ state: trace.final, side });
    points += trace.result.winner === null ? 0.5 : trace.result.winner === side ? 1 : 0;
  }
  return { rate: points / seeds.length, ticks, finals };
}

describe('D-K 局長（四個情境都要量）', () => {
  it(
    '等級 10 對 10、人類模型對 10／2／1 各 12 場：每一場都剛好 3600 tick（60 秒，固定時間到結束），中位數與第 10 百分位都在 30 到 90 秒內',
    () => {
      const scenarios: readonly (readonly [string, Make, Make])[] = [
        ['L10 對 L10', L(10), L(10)],
        ['人類模型對 L10', HUMAN, L(10)],
        ['人類模型對 L2', HUMAN, L(2)],
        ['人類模型對 L1', HUMAN, L(1)],
      ];
      for (const [name, a, b] of scenarios) {
        const ticks = batch(a, b, range(12)).ticks;
        const median = quantile(ticks, 0.5) / 60;
        const p10 = quantile(ticks, 0.1) / 60;
        report(`局長 ${name}：中位數 ${median.toFixed(1)} 秒，第 10 百分位 ${p10.toFixed(1)} 秒`);
        expect(median, name).toBe(60); // 時間到結束，沒有任何提早結束的路徑
        expect(median, name).toBeGreaterThanOrEqual(30);
        expect(median, name).toBeLessThanOrEqual(90);
        expect(p10, name).toBeGreaterThanOrEqual(30);
        expect(Math.max(...ticks), name).toBeLessThanOrEqual(3600);
      }
    },
    LONG,
  );
});

describe('D-K 劇本玩家對等級 10（> 90% 才是支配策略）', () => {
  const specs: readonly ScriptSpec[] = [
    { s1: 'greedy', s2: 'turfContest', s3: 'smart' },
    { s1: 'greedy', s2: 'turf', s3: 'coins' },
    { s1: 'greedy', s2: 'turfContest', s3: 'dj' },
    { s1: 'home', s2: 'turfContest', s3: 'smart' },
    { s1: 'outward', s2: 'turfContest', s3: 'smart' },
    { s1: 'center', s2: 'turfContest', s3: 'smart' },
    { s1: 'home', s2: 'turfContest', s3: 'coins' },
    { s1: 'wander', s2: 'nearest', s3: 'coins' },
    { s1: 'greedy', s2: 'nearest', s3: 'lurk' },
  ];
  it(
    '九種零延遲的劇本（三段各種寫法的組合）對等級 10 貪心型各 30 場：沒有任何一種超過 50%（100 場量到最高 18%）',
    () => {
      for (const spec of specs) {
        const { rate } = batch(() => script(spec), L(10), range(30));
        report(`劇本 ${spec.s1}/${spec.s2}/${spec.s3}：${(100 * rate).toFixed(1)}%`);
        expect(rate, `${spec.s1}/${spec.s2}/${spec.s3}`).toBeLessThan(0.5);
      }
    },
    LONG,
  );
});

describe('D-K 三段的分數比例（小規格預估 1 : 2.5 : 1，原型關卡量到 21 : 186 : 4，重新平衡後）', () => {
  it(
    '等級 10 對 10 的 12 場：每一段占整場分數的比例都在 15% 到 55% 之間（量到約 29% : 44% : 27%）',
    () => {
      const shares = [0, 0, 0];
      let games = 0;
      for (const seed of range(12)) {
        const trace = playTraced(seed, L(10)(seed), L(10)(seed + 17));
        const final = trace.final;
        const s1 = (trace.s1[0] + trace.s1[1]) / 2;
        const s2 = (trace.s2[0] + trace.s2[1]) / 2 - s1;
        const s3 = (final.players[0].score + final.players[1].score) / 2 - s1 - s2;
        const total = s1 + s2 + s3;
        shares[0] = (shares[0] as number) + s1 / total;
        shares[1] = (shares[1] as number) + s2 / total;
        shares[2] = (shares[2] as number) + s3 / total;
        games += 1;
      }
      const mean = shares.map((x) => x / games);
      report(`三段比例 ${mean.map((x) => (100 * x).toFixed(1)).join(' : ')}`);
      for (const share of mean) {
        expect(share).toBeGreaterThan(0.15);
        expect(share).toBeLessThan(0.55);
      }
    },
    LONG,
  );
});

describe('D-K 分數不被重算（段與段之間）', () => {
  it(
    '8 場真實對局：第 1 段結束到第 3 段開始之間，兩邊的分數只增不減；換段那一步（2579 到 2580）分數不變',
    () => {
      for (const seed of range(8)) {
        const a = L(10)(seed);
        const b = L(10)(seed + 17);
        let state = dKGame.init(seed, CONFIG);
        while (!dKGame.isOver(state)) {
          const tick = state.tick;
          const previous = state;
          state = dKGame.step(state, [
            copyButtons(a.decide(state, 0, tick)),
            copyButtons(b.decide(state, 1, tick)),
          ]);
          if (state.tick > 1080 && state.tick <= 2580) {
            for (const side of [0, 1] as const) {
              expect(
                state.players[side].score,
                `種子 ${seed} tick ${state.tick}`,
              ).toBeGreaterThanOrEqual(previous.players[side].score);
            }
          }
          if (state.tick === 2580) {
            expect(state.players.map((p) => p.score)).toEqual(previous.players.map((p) => p.score));
          }
          if (stageOf(previous.tick) === 0) {
            expect(state.players.map((p) => p.score)).toEqual(previous.players.map((p) => p.score));
          }
        }
      }
    },
    LONG,
  );
});

describe('D-K 探針 A′（第 3 段專用；DESIGN-AI-FUN 10.24、10.35）', () => {
  it(
    '前兩段用 AI 自己的引擎（所以基準線約 50%），第 3 段換成 (a) 只撿金幣、(b) D-J 固定規則、(c) 讀對手狀態各 60 場：三組都在 20% 到 80% 之間，不是地板或天花板',
    () => {
      const rates: number[] = [];
      for (const mode of ['coins', 'dj', 'smart'] as const) {
        const { rate } = batch(
          (seed) => engineThenSteal(levelController(dKGame, greedy, 10, seed + 3), mode),
          L(10),
          range(60),
        );
        rates.push(rate);
        report(`探針 A′ ${mode}：${(100 * rate).toFixed(1)}%`);
      }
      for (const rate of rates) {
        expect(rate).toBeGreaterThan(0.2);
        expect(rate).toBeLessThan(0.8);
      }
    },
    LONG,
  );
});

describe('D-K 反應速度（準則 3）', () => {
  it(
    '四格各 30 場：只差反應延遲（量到 63.8%）與只差搜尋深度（貪心型看一步，量到 48.8%）的快（淺）一邊勝率低於 85%；合併（量到 97.5%）與只差決定頻率（量到 98.8%）高於 90%，這是準則 3 沒達到的地方，這裡只印出來、不當成通過',
    () => {
      const neutral: LevelParams = { reactionTicks: 12, decideEvery: 4, depth: 3, epsilon: 0 };
      const cells: readonly (readonly [string, LevelParams, LevelParams, number | null])[] = [
        [
          '合併（快而淺對慢而深）',
          { reactionTicks: 3, decideEvery: 1, depth: 1, epsilon: 0 },
          { reactionTicks: 18, decideEvery: 12, depth: 6, epsilon: 0 },
          null,
        ],
        ['只差反應延遲', { ...neutral, reactionTicks: 3 }, { ...neutral, reactionTicks: 18 }, 0.85],
        ['只差決定頻率', { ...neutral, decideEvery: 1 }, { ...neutral, decideEvery: 12 }, null],
        ['只差搜尋深度', { ...neutral, depth: 1 }, { ...neutral, depth: 6 }, 0.85],
      ];
      for (const [name, fast, slow, limit] of cells) {
        let points = 0;
        const count = 30;
        for (const seed of range(count)) {
          const side: Side = seed % 2 === 0 ? 0 : 1;
          const quick = wrapPolicy(dKGame, greedy, fast, seed + 1);
          const steady = wrapPolicy(dKGame, greedy, slow, seed + 2);
          const result =
            side === 0
              ? playMatch(dKGame, seed, CONFIG, quick, steady)
              : playMatch(dKGame, seed, CONFIG, steady, quick);
          points += result.winner === null ? 0.5 : result.winner === side ? 1 : 0;
        }
        report(`反應速度 ${name}：${((100 * points) / count).toFixed(1)}%`);
        if (limit !== null) {
          expect(points / count, name).toBeLessThan(limit);
        }
      }
    },
    LONG,
  );
});

/**
 * 探針 A 與 A′ 的決策分歧率與 (c)−(b)（DESIGN-AI-FUN 10.35、10.59）。腳本是目前取回的版本，不保證是最早的那一份。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   DK_PROBE_N（場數，預設 4）、DK_PROBE_FROM（起始種子，預設 0）、DK_VERBOSE（印出一行報告）。
 * 三格：探針 A 腳本延遲 0、延遲 12（`wrapPolicy`，同人類模型：反應 12、每 tick 決定、深度 1），對貪心型等級 10（AI 種子 ＋ 7）；
 * 探針 A′（第 1、2 段用引擎，只有第 3 段 dj 對 smart），AI 種子 ＋ 17 ＋ 1,000,003。
 */
describe('D-K 探針 A、A′：(b) 對 (c) 的分歧率與勝率差（共用 tests/ai/probe-a.shared.ts）', () => {
  const N = Math.max(1, Number(process.env['DK_PROBE_N'] ?? '4'));
  const FROM = Number(process.env['DK_PROBE_FROM'] ?? '0');
  const seeds = range(N).map((i) => FROM + i);
  const playAgainst =
    (aiOf: (seed: number) => Controller<DKState>): ProbeSpec<DKState>['play'] =>
    (seed, ctl) => {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const ai = aiOf(seed);
      const t = side === 0 ? playTraced(seed, ctl, ai) : playTraced(seed, ai, ctl);
      return outcomeOf(t.result, side);
    };
  const delayed =
    (g: 'b' | 'c', delay: number): Make =>
    (seed) =>
      delay === 0
        ? script(PROBE_A[g])
        : wrapPolicy(
            dKGame,
            scriptPolicy(PROBE_A[g]),
            { reactionTicks: delay, decideEvery: 1, depth: 1, epsilon: 0 },
            seed,
          );
  const cells: (readonly [string, ProbeSpec<DKState>])[] = [0, 12].map(
    (delay) =>
      [
        `探針 A 腳本延遲 ${String(delay)}`,
        {
          makeB: delayed('b', delay),
          makeC: delayed('c', delay),
          seeds,
          play: playAgainst((seed) => levelController(dKGame, greedy, 10, seed + 7)),
        },
      ] as const,
  );
  cells.push([
    '探針 A′（第 3 段 dj 對 smart）',
    {
      makeB: (seed) => engineThenSteal(levelController(dKGame, greedy, 10, seed + 3), 'dj'),
      makeC: (seed) => engineThenSteal(levelController(dKGame, greedy, 10, seed + 3), 'smart'),
      seeds,
      play: playAgainst((seed) => levelController(dKGame, greedy, 10, seed + 17 + 1_000_003)),
    },
  ]);

  it.each(cells.map((c) => [c[0], c[1]] as const))(
    '%s：勝率差不超過場級分歧率；影子不影響對局（驅動者單獨跑的結果相同）',
    (label, spec) => {
      const r = compareBC(spec);
      report(
        formatProbeA(`D-K ${label} greedy L10 seeds ${String(FROM)}..${String(FROM + N - 1)}`, r),
      );
      expect(r.n).toBe(N);
      expect(r.winBoundHolds).toBe(true);
      expect(r.inconsistentSeeds).toEqual([]);
      const alone = seeds.map((seed) => spec.play(seed, spec.makeB(seed)));
      expect(r.win.b).toBe(alone.reduce((a, o) => a + o.win, 0) / N);
    },
    LONG,
  );
});
