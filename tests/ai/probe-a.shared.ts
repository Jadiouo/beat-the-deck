import type { MatchResult } from '../../src/core/match';
import type { Buttons, Controller, Side } from '../../src/core/types';

/**
 * 探針 A 的共用工具（DESIGN-AI-FUN 10.35、10.54、10.59、10.61、10.63）。
 *
 * 為什麼在 repo 裡：10.59 訂的「決策分歧率」是讀 (c)−(b) 之前的必做前置檢查，但它原本只是一條文件規定；
 * 影子控制器只存在於一次唯讀普查的 scratchpad（10.63），會隨 session 消失。下一張牌的人若得自己重寫，
 * 就會跳過這一步。放在 tests/ai/（和 `clubs-s4.shared.ts`、`a-checks.shared.ts` 同一個慣例），
 * 不放 src/ai：它是測試／量測用的工具，不是遊戲本體，也不需要受純度掃描管（這裡的程式仍然不用時鐘與亂數）。
 *
 * 方法（「影子控制器」）：驅動者 D 真正操作對局；影子 S 在每個 tick 被問「同一個 state、同一個 side、
 * 同一個 tick」，但回答不被採用，只逐 tick 比對按鍵。D = (b) 時這一局就是真正的 (b) 對局，第一個不同的
 * tick 就是真 (b)、(c) 對局開始分岔的地方（此前兩者的狀態逐位元相同）。
 * 這個方法的正確性前提是「影子不影響對局」：`shadow()` 先問驅動者、複製它的回答、才問影子；
 * 影子的回答完全丟掉。測試檔證明了帶影子與不帶影子的對局逐位元相同。
 *
 * 上限關係（10.59）：一場裡 (b)、(c) 一個決策都沒差，這一場的結果必然相同。所以
 * |(c)−(b) 的勝率差| ≤ 場級分歧率。`compareBC()` 把兩者一起回傳，單報 (c)−(b) 沒有意義。
 *
 * 單位：勝率是 0 到 1 的比例（勝 1、平 0.5、敗 0）；分差是「我方分數 − 對方分數」；
 * 分歧率都是 0 到 1 的比例。要印成百分點用 `formatProbeA`。
 *
 * 呼叫端負責：
 * - `play(seed, ctl)`：用傳進來的 `ctl` 當「我方」跑一場，回傳 `MatchOutcome`
 *   （座位、對手、config 都由它決定；`outcomeOf(playMatch(...), side)` 可以直接用）。
 *   (b)、(c) 兩邊必須吃同一個 `play`，對手種子的約定也要相同。
 * - `makeB(seed)`、`makeC(seed)`：每次呼叫都要回傳全新的控制器（有內部狀態與自己的亂數）。
 *   (b) 的定義必須在量之前固定（10.54）；(b)、(c) 是不是 AI 自己的引擎或鏡像要先問（10.61 第二個陷阱）。
 * - `isPoint`：這張牌「什麼算一次決策」。S-10 是 `canClear` 為真、S-K 是自己挑牌的 tick、
 *   H-7 是 choose 階段的第一個 tick、H-K 是每段 bet 的第一個 tick。沒給就退回「動作段」近似。
 *   點級分歧率的定義因牌而異，不能跨牌排名（10.63）。
 */

const KEYS = ['up', 'down', 'left', 'right', 'a', 'b'] as const;
const sameButtons = (x: Buttons, y: Buttons): boolean => KEYS.every((k) => x[k] === y[k]);
const anyButton = (x: Buttons): boolean => KEYS.some((k) => x[k]);
const copy = (x: Buttons): Buttons => ({
  up: x.up,
  down: x.down,
  left: x.left,
  right: x.right,
  a: x.a,
  b: x.b,
});

/** 判斷某個 tick 是不是這張牌的一個「決策點」。 */
export type IsPoint<S> = (state: S, side: Side, tick: number) => boolean;

/** 一場對局「我方」的結果。 */
export interface MatchOutcome {
  /** 勝 1、平 0.5、敗 0。 */
  readonly win: number;
  /** 我方分數 − 對方分數。 */
  readonly margin: number;
}

/** 從 `playMatch` 的結果取出 `side` 這一邊的視角。 */
export function outcomeOf(result: MatchResult, side: Side): MatchOutcome {
  const win = result.winner === null ? 0.5 : result.winner === side ? 1 : 0;
  return { win, margin: result.score[side] - result.score[1 - side] };
}

/** 一場對局的逐 tick 比對統計。 */
export interface GameStat {
  /** 被問的次數（我方）。 */
  ticks: number;
  /** 按鍵不同的 tick 數。 */
  diffTicks: number;
  /** 至少一邊有按鍵的 tick 數。 */
  liveTicks: number;
  /** 其中不同的。 */
  liveDiffTicks: number;
  /** 第一個不同的 tick，-1 ＝ 整場都相同。 */
  firstDiff: number;
  /** 「動作段」數：連續至少一邊有按鍵的 tick 算一段（兩邊都放開才結束）。 */
  episodes: number;
  /** 其中至少有一個 tick 兩邊按鍵不同的段數。 */
  episodesDiff: number;
  /** 呼叫端用 `isPoint` 指定的決策點數（沒指定就是 0）。 */
  points: number;
  /** 其中兩邊按鍵不同的。 */
  pointsDiff: number;
}

/**
 * 影子控制器。回傳的 `ctl` 放進對局當「我方」；`stat` 在對局結束後讀。
 * `driver` 的回答被採用，`other` 的回答只用來比對。
 */
export function shadow<S>(
  driver: Controller<S>,
  other: Controller<S>,
  isPoint?: IsPoint<S>,
): { ctl: Controller<S>; stat: GameStat } {
  const stat: GameStat = {
    ticks: 0,
    diffTicks: 0,
    liveTicks: 0,
    liveDiffTicks: 0,
    firstDiff: -1,
    episodes: 0,
    episodesDiff: 0,
    points: 0,
    pointsDiff: 0,
  };
  let inEpisode = false;
  let episodeHasDiff = false;
  const ctl: Controller<S> = {
    decide(state: S, side: Side, tick: number): Buttons {
      // 先問驅動者並立刻複製：之後不論影子做什麼，都碰不到驅動者的回答。
      const mine = copy(driver.decide(state, side, tick));
      const theirs = other.decide(state, side, tick);
      stat.ticks += 1;
      const differs = !sameButtons(mine, theirs);
      if (isPoint !== undefined && isPoint(state, side, tick)) {
        stat.points += 1;
        if (differs) stat.pointsDiff += 1;
      }
      if (differs) {
        stat.diffTicks += 1;
        if (stat.firstDiff < 0) stat.firstDiff = tick;
      }
      if (anyButton(mine) || anyButton(theirs)) {
        stat.liveTicks += 1;
        if (differs) stat.liveDiffTicks += 1;
        if (!inEpisode) {
          inEpisode = true;
          episodeHasDiff = false;
          stat.episodes += 1;
        }
        if (differs && !episodeHasDiff) {
          episodeHasDiff = true;
          stat.episodesDiff += 1;
        }
      } else {
        inEpisode = false;
      }
      return mine;
    },
  };
  return { ctl, stat };
}

/** 平均與標準誤。 */
export interface MeanSe {
  readonly n: number;
  readonly mean: number;
  /** 平均的標準誤 ＝ 樣本標準差（n−1）／ sqrt(n)。n < 2 時是 NaN（不假裝有）。 */
  readonly se: number;
}

/**
 * 平均與標準誤。對「同種子配對差」呼叫時，這就是配對標準誤
 * （配對差的樣本標準差除以 sqrt(n)，不是兩組各自標準誤的合成）。
 */
export function pairedStats(values: readonly number[]): MeanSe {
  const n = values.length;
  if (n === 0) return { n, mean: Number.NaN, se: Number.NaN };
  const mean = values.reduce((p, v) => p + v, 0) / n;
  if (n < 2) return { n, mean, se: Number.NaN };
  const variance = values.reduce((p, v) => p + (v - mean) ** 2, 0) / (n - 1);
  return { n, mean, se: Math.sqrt(variance / n) };
}

/** 一組種子上的決策分歧率。 */
export interface Divergence {
  readonly games: number;
  /** 至少有一個 tick 不同的場數。 */
  readonly gamesDiffer: number;
  /** 場級分歧率 ＝ gamesDiffer / games。這是勝率差的上限（10.59）。 */
  readonly gameRate: number;
  /** 每場第一個分歧的 tick（-1 ＝ 整場相同），順序同 seeds。 */
  readonly firstDiffs: readonly number[];
  readonly ticks: number;
  readonly diffTicks: number;
  /** 逐 tick 分歧率（所有被問的 tick）。 */
  readonly tickRate: number;
  readonly liveTicks: number;
  readonly liveDiffTicks: number;
  /** 活躍 tick（至少一邊有按鍵）裡的分歧率。 */
  readonly liveRate: number;
  /** 點級用的是 `isPoint`，還是退回「動作段」近似。 */
  readonly pointBasis: 'isPoint' | 'episode';
  readonly points: number;
  readonly pointsDiff: number;
  /** 點級分歧率；分母是 0（沒有任何決策點）時是 NaN，不是 0。 */
  readonly pointRate: number;
}

const ratio = (a: number, b: number): number => (b === 0 ? Number.NaN : a / b);

function summarize(stats: readonly GameStat[], usedIsPoint: boolean): Divergence {
  const sum = (f: (s: GameStat) => number): number => stats.reduce((p, s) => p + f(s), 0);
  const gamesDiffer = stats.filter((s) => s.firstDiff >= 0).length;
  const points = usedIsPoint ? sum((s) => s.points) : sum((s) => s.episodes);
  const pointsDiff = usedIsPoint ? sum((s) => s.pointsDiff) : sum((s) => s.episodesDiff);
  return {
    games: stats.length,
    gamesDiffer,
    gameRate: ratio(gamesDiffer, stats.length),
    firstDiffs: stats.map((s) => s.firstDiff),
    ticks: sum((s) => s.ticks),
    diffTicks: sum((s) => s.diffTicks),
    tickRate: ratio(
      sum((s) => s.diffTicks),
      sum((s) => s.ticks),
    ),
    liveTicks: sum((s) => s.liveTicks),
    liveDiffTicks: sum((s) => s.liveDiffTicks),
    liveRate: ratio(
      sum((s) => s.liveDiffTicks),
      sum((s) => s.liveTicks),
    ),
    pointBasis: usedIsPoint ? 'isPoint' : 'episode',
    points,
    pointsDiff,
    pointRate: ratio(pointsDiff, points),
  };
}

export interface ProbeSpec<S> {
  /** (b) 的控制器工廠，每次呼叫都回傳全新的。 */
  readonly makeB: (seed: number) => Controller<S>;
  /** (c) 的控制器工廠。 */
  readonly makeC: (seed: number) => Controller<S>;
  readonly seeds: readonly number[];
  /** 用傳進來的控制器當「我方」跑一場。(b)、(c) 吃同一個 play。 */
  readonly play: (seed: number, ctl: Controller<S>) => MatchOutcome;
  readonly isPoint?: IsPoint<S> | undefined;
}

interface Driven {
  readonly stats: GameStat[];
  readonly outcomes: MatchOutcome[];
}

function runDriven<S>(
  spec: ProbeSpec<S>,
  makeDriver: (seed: number) => Controller<S>,
  makeOther: (seed: number) => Controller<S>,
): Driven {
  const stats: GameStat[] = [];
  const outcomes: MatchOutcome[] = [];
  for (const seed of spec.seeds) {
    const { ctl, stat } = shadow(makeDriver(seed), makeOther(seed), spec.isPoint);
    outcomes.push(spec.play(seed, ctl));
    stats.push(stat);
  }
  return { stats, outcomes };
}

/**
 * 決策分歧率：驅動者是 (b)、影子是 (c)，跑 `seeds` 裡的每個種子。
 * 這個函式只跑 (b) 驅動那一半（要勝率與分差就用 `compareBC`）。
 */
export function divergence<S>(spec: ProbeSpec<S>): Divergence {
  const { stats } = runDriven(spec, spec.makeB, spec.makeC);
  return summarize(stats, spec.isPoint !== undefined);
}

export interface ProbeAResult {
  readonly n: number;
  /** 驅動者 ＝ (b)：這一局就是真正的 (b) 對局。報告用這一份。 */
  readonly divergence: Divergence;
  /** 驅動者 ＝ (c) 的對照。場級分歧率理論上與上面相同（10.63），點級可以略有不同。 */
  readonly divergenceCDriven: Divergence;
  /** 勝率（0 到 1）。`diff` 是 (c)−(b) 的同種子配對差。 */
  readonly win: { readonly b: number; readonly c: number; readonly diff: MeanSe };
  /** 分差（我方 − 對方）。`diff` 是 (c)−(b) 的同種子配對差。 */
  readonly margin: { readonly b: MeanSe; readonly c: MeanSe; readonly diff: MeanSe };
  /** 只看「(b) 驅動時有分歧的那些場」的分差配對差（10.59：分差沒有自然上界，另報這個）。 */
  readonly marginWhereDiffer: MeanSe;
  /** |勝率差| ≤ 場級分歧率（容許 1e-12 的浮點誤差）。理論上永遠成立；不成立代表實作或控制器有問題。 */
  readonly winBoundHolds: boolean;
  /**
   * 一致性檢查：某個種子上 (b)(c) 其中一個方向「整場沒有任何分歧」，
   * 但兩個方向的結果（勝負或分差）卻不同。這在決定性的控制器上不可能發生，
   * 發生就代表控制器不是 (state, side, tick) 與自己內部狀態的決定性函數，或影子動到了共用的東西。
   */
  readonly inconsistentSeeds: readonly number[];
}

/**
 * 探針 A 的 (b)(c) 對照，連同決策分歧率。每個種子跑兩場：(b) 驅動＋(c) 影子，與 (c) 驅動＋(b) 影子。
 * 報告要寫「(c)−(b) ＝ X，場級分歧率 ＝ Y」這一對數字（10.59）。
 */
export function compareBC<S>(spec: ProbeSpec<S>): ProbeAResult {
  const b = runDriven(spec, spec.makeB, spec.makeC);
  const c = runDriven(spec, spec.makeC, spec.makeB);
  const usedIsPoint = spec.isPoint !== undefined;
  const div = summarize(b.stats, usedIsPoint);
  const winDiffs = spec.seeds.map((_s, i) => (c.outcomes[i]?.win ?? 0) - (b.outcomes[i]?.win ?? 0));
  const marginDiffs = spec.seeds.map(
    (_s, i) => (c.outcomes[i]?.margin ?? 0) - (b.outcomes[i]?.margin ?? 0),
  );
  const winDiff = pairedStats(winDiffs);
  const inconsistentSeeds = spec.seeds.filter((_s, i) => {
    const noDiff = (b.stats[i]?.firstDiff ?? 0) < 0 || (c.stats[i]?.firstDiff ?? 0) < 0;
    return noDiff && (winDiffs[i] !== 0 || marginDiffs[i] !== 0);
  });
  return {
    n: spec.seeds.length,
    divergence: div,
    divergenceCDriven: summarize(c.stats, usedIsPoint),
    win: {
      b: pairedStats(b.outcomes.map((o) => o.win)).mean,
      c: pairedStats(c.outcomes.map((o) => o.win)).mean,
      diff: winDiff,
    },
    margin: {
      b: pairedStats(b.outcomes.map((o) => o.margin)),
      c: pairedStats(c.outcomes.map((o) => o.margin)),
      diff: pairedStats(marginDiffs),
    },
    marginWhereDiffer: pairedStats(
      marginDiffs.filter((_d, i) => (b.stats[i]?.firstDiff ?? -1) >= 0),
    ),
    winBoundHolds: Math.abs(winDiff.mean) <= div.gameRate + 1e-12,
    inconsistentSeeds,
  };
}

const pct = (x: number): string => (Number.isNaN(x) ? 'n/a' : (100 * x).toFixed(1) + '%');
const pp = (x: number): string =>
  Number.isNaN(x) ? 'n/a' : (x >= 0 ? '+' : '') + (100 * x).toFixed(1);
const num = (x: number): string => (Number.isNaN(x) ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(2));

/** 一行報告。(c)−(b) 與場級分歧率永遠成對出現。 */
export function formatProbeA(label: string, r: ProbeAResult): string {
  const d = r.divergence;
  const basis = d.pointBasis === 'isPoint' ? '決策點' : '動作段(近似)';
  return [
    `${label} n=${r.n}`,
    `勝率 b=${pct(r.win.b)} c=${pct(r.win.c)} (c)−(b)=${pp(r.win.diff.mean)}±${pp(r.win.diff.se).replace('+', '')}pp`,
    `場級分歧率=${d.gamesDiffer}/${d.games}=${pct(d.gameRate)}（勝率差上限）${r.winBoundHolds ? '' : ' [上限不成立！]'}`,
    `點級(${basis})=${d.pointsDiff}/${d.points}=${pct(d.pointRate)}`,
    `分差 (c)−(b)=${num(r.margin.diff.mean)}±${num(r.margin.diff.se).replace('+', '')} 有分歧的場=${num(r.marginWhereDiffer.mean)}(n=${r.marginWhereDiffer.n})`,
    r.inconsistentSeeds.length > 0 ? `[一致性違規 ${r.inconsistentSeeds.length} 場]` : '',
  ]
    .filter((x) => x !== '')
    .join(' | ');
}
