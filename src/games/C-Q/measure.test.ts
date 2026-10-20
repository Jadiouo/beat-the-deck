import { describe, expect, it } from 'vitest';

import { HUMAN_PARAMS, humanPolicy } from '../../ai/human-model';
import { levelController, wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { playMatch } from '../../core/match';
import type { LevelParams, Policy } from '../../ai/types';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import { cellX, cellY } from '../_clubs/logic';
import { createCQGame, cqGame } from './logic';
import type { CQState } from './logic';
import {
  forcedLaunches,
  median,
  p10,
  playPair,
  scriptedWinRate,
  summarize,
} from './players.test-helpers';
import type { PlayerKind } from './players.test-helpers';

/**
 * C-Q 的量測型測試（DESIGN-AI-FUN 2.3 指紋、2.5 互動強度、3 反應速度、10.19 第 4 題、10.40 支配策略、10.48、10.54）。
 * 數字與量測的 commit 見 `docs/cards/C-Q.md`「實作與量測」。門檻是量到的值留餘裕，沒有為了讓它過而調整；
 * 小規格的目標沒達到的地方（兩個低等級的局長）如實寫在小規格，這裡釘住量到的區間而不是宣稱達標。
 *
 * 版本：預設的 `cqGame` 是 tailCost（放出割尾巴、分數 −1，命中才還）；`plain` 是小規格原版（放出不花東西）。
 * 兩個版本的差別就是 10.19 第 4 題要量的東西。
 */

/**
 * **場數與門檻（守門版）。** 這支檔案是守門用的：預設場數是原本大場次的 1/5 到 1/10 以下，一次跑約 4 分鐘；
 * 原本的大場次（共 2153 秒，約 36 分鐘）用環境變數開，數字與量測的 commit 在 `docs/cards/C-Q.md`
 * 「實作與量測」（`logic.ts` 的行為自 `c99bfba` 起沒變；原本的測試也是 `c99bfba`）：
 *
 *     CQ_N=10 CQ_VERBOSE=1 npx vitest run --project heavy src/games/C-Q/measure.test.ts
 *
 * `CQ_N`（預設 1）乘上每一項的場數（但不超過原本的場數）；**`CQ_N=10`（以上）就是原本的場數與原本的門檻**
 * （每一項的守門版場數與原本場數的對照表在小規格「守門版的場數」）。`CQ_VERBOSE=1` 把量到的數字印出來。
 *
 * **門檻怎麼算。** 場數縮小，標準誤變大。比例類的門檻用同一個公式：
 * 中心值 p 取大場次量到的值，標準誤 SE = √(p(1−p)/n)（n 是這一項的場數；平手算半場，所以是略保守的上界），
 * 門檻 = p ∓ 3·SE（偶然紅的機率約 0.13%）；**原本的門檻更寬就沿用原本的，不收緊**（`Math.max`／`Math.min`）。
 * 兩個比例相減的標準誤是 √(p₁(1−p₁)/n + p₂(1−p₂)/n)（當成獨立，是上界）。
 * 不是比例的（局長的中位數、第 10 百分位、指紋的比值、誤放的平均）用大場次的原始樣本重抽（bootstrap）算，
 * 註解寫在各處。守門版抓得到的是「大幅退步」，抓不到幾個百分點的漂移；要看漂移請開大場次。
 */
const N = Math.max(1, Math.floor(Number(process.env.CQ_N ?? '1')));
const Z = 3;
/** `CQ_N=10` 以上：原本的場數與原本的門檻。 */
const FULL = N >= 10;

/** 這一項的場數：守門版 `base` × `CQ_N`，不超過原本的 `original`；`FULL` 時就是 `original`。 */
function count(base: number, original: number): number {
  return FULL ? original : Math.min(original, base * N);
}

const CONFIG = { maxTicks: 3600, params: {} };

function report(text: string): void {
  if (process.env.CQ_VERBOSE !== undefined) {
    console.log(text);
  }
}

/** 比例 p 在 n 場下的標準誤。 */
function se(p: number, n: number): number {
  return Math.sqrt((p * (1 - p)) / n);
}

/** 兩個比例的差（p₁ − p₂）在各 n 場下的標準誤。 */
function diffSe(p1: number, p2: number, n: number): number {
  return Math.sqrt(se(p1, n) ** 2 + se(p2, n) ** 2);
}

const plain: Game<CQState> = createCQGame({ tailCost: false });

function seeds(count: number, from = 0): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}

function level10(game: Game<CQState>, seed: number): Controller<CQState> {
  return levelController(game, pathfinder, 10, seed);
}

function human(game: Game<CQState>, seed: number): Controller<CQState> {
  return wrapPolicy(game, humanPolicy, HUMAN_PARAMS, seed);
}

/** 兩個控制器對打：偶數種子 a 坐 0 號邊。 */
function pair(
  game: Game<CQState>,
  seed: number,
  make: (seed: number) => [Controller<CQState>, Controller<CQState>],
): ReturnType<typeof playPair> {
  const [a, b] = make(seed);
  return seed % 2 === 0 ? playPair(game, seed, CONFIG, a, b) : playPair(game, seed, CONFIG, b, a);
}

/**
 * 劇本玩家對搜尋型等級 10 的勝率，同一組（遊戲版本、種類、場數）只算一次：「沒有支配策略」「永遠不放不是好策略」
 * 「探針 A」用的是同一批對局（種子 0..n−1、同樣的玩家、同樣的 AI），原本各算各的（eater、spam 各算兩次、reads 兩次），
 * 結果完全一樣，只是重複花時間。
 */
const scriptedCache = new Map<string, number>();
function scriptedRate(kind: PlayerKind, count: number, variant = 'tailCost'): number {
  // `aware`（探針 A 的 (b)）與 `spam` 在 `players.test-helpers.ts` 的設定完全一樣（看得到對手、不躲、能放就放）。
  const key = `${variant}:${kind === 'aware' ? 'spam' : kind}:${count}`;
  let value = scriptedCache.get(key);
  if (value === undefined) {
    const game = variant === 'noDrones' ? createCQGame({ drones: false }) : cqGame;
    value = scriptedWinRate(game, kind, seeds(count), CONFIG);
    scriptedCache.set(key, value);
  }
  return value;
}

/** 劇本玩家的場數（種子 0..SCRIPT_N−1）。 */
const SCRIPT_N = count(30, 100);

/** 探針 A 的場數（原本 200 場；守門版和 `SCRIPT_N` 同一批）。 */
const PROBE_N = count(30, 200);

describe('C-Q 兩條蛇｜僚機有沒有人在乎（命中率與局長）', () => {
  // 大場次（60 場，種子 0..59；HEAD 重量的原始樣本：每場放 3.65 次、命中率 53.4%（117/219），每場放出的標準差 4.09 次；
  // 小規格「六」的 4.05 次／54.3% 是 `a638039` 的數字）。守門版 20 × CQ_N 場（最多 60）。
  // 每場放出次數的平均：標準誤 = 4.09/√20 = 0.91，3.65 − 3×0.91 = 0.91（解析）；重抽 20 場取第 0.135 百分位 = 1.15 ≥ 原本的 1；
  // 命中率（命中總數 ÷ 放出總數）重抽的第 0.135 百分位 = 0.32 ≥ 原本的 0.1。兩條的門檻都沿用原本的，不放寬。
  it('僚機命中率（小規格判準 ≥ 10%）：搜尋型等級 10 對等級 10，20 × CQ_N 場（原本 60 場），命中 ÷ 放出 ≥ 10%，而且每場兩邊合計至少放 1 次', () => {
    const games = count(20, 60);
    let launches = 0;
    let hits = 0;
    for (const seed of seeds(games)) {
      const result = pair(cqGame, seed, (s) => [
        level10(cqGame, s),
        level10(cqGame, s + 1_000_003),
      ]);
      launches += result.final.launches[0] + result.final.launches[1];
      hits += result.final.hits[0] + result.final.hits[1];
    }
    report(
      `僚機命中率（${games} 場）：每場放出 ${(launches / games).toFixed(2)} 次、命中 ${hits}/${launches}`,
    );
    expect(launches / games, `每場放出 ${(launches / games).toFixed(2)} 次`).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      hits / launches,
      `命中率 ${((100 * hits) / launches).toFixed(1)}%（${hits}/${launches}）`,
    ).toBeGreaterThanOrEqual(0.1);
  }, 300_000);

  // 大場次（60 場，種子 0..59，`c99bfba`，小規格「二」；HEAD 重量的原始樣本，中位數／第 10 百分位／標準差：
  // 等級 10 對 10 = 60.0／16.7／18.0、人類模型對 10 = 36.9／10.2／20.4、對 2 = 14.1／4.9／9.7、對 1 = 15.6／4.3／12.9 秒）。
  // 守門版 20 × CQ_N 場。中位數與第 10 百分位不是比例：用 60 個原始樣本重抽（10 萬次，每次抽 20 場，算同一個統計量）
  // 取第 0.135 百分位（= 3 個標準誤的單尾）。解析式的交叉檢查：中位數標準誤 ≈ 1.2533·sd/√n，
  // 例如人類模型對 10：36.9 − 3×1.2533×20.4/√20 = 20.0（重抽 15.9，重抽比較寬，因為分佈偏斜）。
  // 第 10 百分位在 20 場是第 3 小的那一場（索引 floor(20/10) = 2）；沒有簡單的標準誤，重抽下限就是這 60 場裡最短的幾場，
  // 所以守門版的第 10 百分位只擋得住「一成以上的對局幾秒內就結束」。重抽的下限 → 門檻（捨去到 0.5 以下）：
  // 中位數 44.1→44、15.9→15.5、5.9→5.5、6.2→6；第 10 百分位 4.3→4、1.9→1.8、1.1→1、1.5→1.4。
  // 場數 = 60（`CQ_N=3` 以上）時用原本的門檻。
  it('局長（DESIGN-AI-FUN 附錄：四個情境都要量）：等級 10 對 10、人類模型對 10／2／1 各 20 × CQ_N 場（原本 60 場），中位數與第 10 百分位不低於釘住的值（兩個低等級的情境沒達到小規格的 30 秒）', () => {
    const lengthN = count(20, 60);
    const full = lengthN >= 60;
    const scenarios: {
      readonly name: string;
      readonly make: (seed: number) => [Controller<CQState>, Controller<CQState>];
      readonly median: number;
      readonly p10: number;
    }[] = [
      {
        name: '等級 10 對 10',
        make: (s) => [level10(cqGame, s), level10(cqGame, s + 1_000_003)],
        median: full ? 55 : 44,
        p10: full ? 15 : 4,
      },
      {
        name: '人類模型對 10',
        make: (s) => [human(cqGame, s), level10(cqGame, s + 1_000_003)],
        median: full ? 30 : 15.5,
        p10: full ? 6 : 1.8,
      },
      {
        // 小規格的目標是 ≥ 30 秒，量到約 15 秒：等級 2 的 AI 自己撞死（epsilon 亂按），沿用 C-A 的規則時 C-A 也是 13.5 秒
        name: '人類模型對 2',
        make: (s) => [human(cqGame, s), levelController(cqGame, pathfinder, 2, s + 1_000_003)],
        median: full ? 10 : 5.5,
        p10: full ? 3 : 1,
      },
      {
        name: '人類模型對 1',
        make: (s) => [human(cqGame, s), levelController(cqGame, pathfinder, 1, s + 1_000_003)],
        median: full ? 10 : 6,
        p10: full ? 3 : 1.4,
      },
    ];
    for (const scenario of scenarios) {
      const seconds = seeds(lengthN).map((seed) => pair(cqGame, seed, scenario.make).ticks / 60);
      report(
        `局長 ${scenario.name}（${lengthN} 場）：中位 ${median(seconds).toFixed(1)}、p10 ${p10(seconds).toFixed(1)}`,
      );
      expect(median(seconds), `${scenario.name} 局長中位數`).toBeGreaterThanOrEqual(
        scenario.median,
      );
      expect(p10(seconds), `${scenario.name} 局長第 10 百分位`).toBeGreaterThanOrEqual(
        scenario.p10,
      );
    }
  }, 600_000);
});

describe('C-Q 兩條蛇｜沒有支配策略（DESIGN-AI-FUN 10.40、5.2）', () => {
  // 大場次（200 場，`c99bfba`，小規格「三」）：eater 36.0%、spam 35.3%、dodger 41.3%、reads 37.8%；原本的測試 100 場。
  // 守門版 30 × CQ_N 場（最多 100）。門檻 0.9 是「支配策略」的定義（DESIGN-AI-FUN 10.40），最高的 dodger 41.3% 在 30 場的標準誤是
  // √(.413×.587/30) = 0.090，+3 個標準誤 = 0.68 < 0.9，所以**門檻不用放寬**。
  it('劇本玩家對搜尋型等級 10 各 30 × CQ_N 場（原本 100 場）：永遠不放（eater）、能放就放（spam）、只躲不放（dodger）、讀對手才放（reads）都沒有超過 90%', () => {
    const kinds: PlayerKind[] = ['eater', 'spam', 'dodger', 'reads'];
    for (const kind of kinds) {
      const rate = scriptedRate(kind, SCRIPT_N);
      report(`劇本玩家 ${kind}（${SCRIPT_N} 場）：${(100 * rate).toFixed(1)}%`);
      expect(rate, `${kind} ${(100 * rate).toFixed(1)}%`).toBeLessThan(0.9);
    }
  }, 600_000);

  // 大場次（200 場）：eater 36.0%、spam 35.3%、沒有僚機的 eater 46.5%（`c44eab0`，小規格「三」）。原本 100 場。
  // 這兩條是**兩個勝率相減**，信號小（eater − spam 的中心 +0.7 個點；eater − off 的中心 −10.5 個點），
  // 原本 100 場的標準誤就已經是 6.8 與 7.0 個點，所以原本的 `eater < spam + 0.05` 只有約 0.6 個標準誤的餘裕，
  // 在大場次也只是「沒有明顯反過來」。守門版 30 × CQ_N 場（最多 100），標準誤（兩個比例相減）：
  // eater − spam：√(.36×.64/30 + .353×.647/30) = 0.124，上限 = +0.007 + 3×0.124 = 0.38（原本 0.05，放寬）；
  // eater − off：√(.36×.64/30 + .465×.535/30) = 0.126，上限 = −0.105 + 3×0.126 = 0.27（原本 0，即 `eater < off`，放寬）。
  // 這兩條在守門版只擋得住「永遠不放變成大贏」（比 spam 高 38 個點、比貪食蛇高 27 個點）。
  it('永遠不放僚機的劇本不是好策略：eater 的勝率比「能放就放」的 spam 低，也比僚機關掉時（＝貪食蛇）低（兩個勝率相減，各 30 × CQ_N 場）', () => {
    const eater = scriptedRate('eater', SCRIPT_N);
    const spam = scriptedRate('spam', SCRIPT_N);
    const off = scriptedRate('eater', SCRIPT_N, 'noDrones');
    const spamLimit = FULL ? 0.05 : Math.max(0.05, 0.007 + Z * diffSe(0.36, 0.353, SCRIPT_N));
    const offLimit = FULL ? 0 : Math.max(0, -0.105 + Z * diffSe(0.36, 0.465, SCRIPT_N));
    report(`永遠不放：eater ${eater}、spam ${spam}、沒有僚機的 eater ${off}（${SCRIPT_N} 場）`);
    expect(eater - spam, `eater ${eater} spam ${spam} 沒有僚機時的 eater ${off}`).toBeLessThan(
      spamLimit,
    );
    expect(eater - off, `eater ${eater} 沒有僚機時的 eater ${off}`).toBeLessThan(offLimit);
  }, 600_000);
});

/** 小規格原版的強迫放出實驗：兩個測試共用，只跑一次。 */
let plainRows: ReturnType<typeof forcedLaunches> | null = null;
function plainForced(): ReturnType<typeof forcedLaunches> {
  plainRows ??= forcedLaunches(plain, seeds(FORCED_N), CONFIG);
  return plainRows;
}

/**
 * 誤放的種子數（兩個版本各一份，種子 0..n−1）。**這是整支檔案裡最貴的一項**：每個種子跑三場完整的對局，
 * 約 3.5 秒，原本 200 + 240 個種子共 1380 秒（佔 64%）。守門版 10 × CQ_N 個種子（原本 200／240）。
 *
 * 量到的東西是「撲空的僚機讓放出後 900 tick 的分差平均變化多少」，每個種子只有一個樣本，而且只有約 4 成的種子撲空，
 * 單一樣本的標準差約 1（HEAD 種子 0..99 的原始樣本：原版撲空 n=44、平均 0.00、sd 0.86；
 * tailCost 撲空 n=33、平均 −0.46、sd 1.25；小規格 240 個種子的 tailCost 撲空是 −0.72 ± 0.13）。
 * 標準誤 = sd/√(撲空的次數)，10 個種子只有約 4 與 3 次撲空 → 標準誤 0.4 到 0.7，**效應（−0.7）只有 1 到 1.5 個標準誤**。
 * 所以這兩條在守門版的門檻放得很寬（見下），**抓不到「割尾巴被拿掉」這種 0.7 分的退步**，只抓得到分差平均變化超過 1 分以上的壞掉、
 * 或是根本放不出僚機（撲空次數 = 0）；要驗證 10.19 第 4 題請用大場次（`CQ_N=10` 是 200／240 個種子）。
 */
const FORCED_N = count(10, 200);
const TAIL_N = count(10, 240);

describe('C-Q 兩條蛇｜誤放的代價（DESIGN-AI-FUN 10.19 第 4 題：每次 ≥ 0.5）', () => {
  // 中心 0（小規格：原版撲空 −0.05 ± 0.11、先前 +0.12 ± 0.07），單一樣本 sd 0.86（HEAD 種子 0..99 的 n=44）。
  // 上限 = max(0.5, 3 × 0.86/√(撲空次數))：10 個種子約 4 次撲空 → 1.3；撲空次數 ≥ 27 時 3 × 0.86/√n ≤ 0.5，用原本的 0.5。
  // 撲空次數的下限：原本 `> 20`（200 個種子，期望約 88 次）；守門版期望只有 4 次，Poisson 下 `> 1` 偶然不過 3%、`> 0` 偶然不過 0.5%，
  // 所以守門版只要求 `> 0`（有撲空的樣本，平均才有定義）。
  it('小規格原版（放出不花東西）：撲空的僚機讓分差變化的平均值在 ±0.5 以內（放錯不損失東西；種子數 10 × CQ_N，原本 200 個；±3 個標準誤取寬的）', () => {
    const rows = plainForced();
    const misses = summarize(rows.filter((r) => !r.hit).map((r) => r.deltaHorizon));
    const limit = FULL ? 0.5 : Math.max(0.5, (Z * 0.86) / Math.sqrt(Math.max(1, misses.n)));
    report(
      `原版撲空（${FORCED_N} 個種子）：n=${misses.n} 平均 ${misses.mean.toFixed(2)} ± ${misses.se.toFixed(2)}，上限 ±${limit.toFixed(2)}`,
    );
    expect(misses.n).toBeGreaterThan(FULL ? 20 : 0);
    expect(
      Math.abs(misses.mean),
      `原版撲空 n=${misses.n} 平均 ${misses.mean.toFixed(2)} ± ${misses.se.toFixed(2)}`,
    ).toBeLessThan(limit);
  }, 900_000);

  // 中心 −0.72（小規格：tailCost 撲空 −0.72 ± 0.13；先前 −0.68 ± 0.13），單一樣本 sd 1.25（HEAD 種子 0..99 的 n=33）。
  // 第一條：上限 = max(−0.5, −0.72 + 3 × 1.25/√(撲空次數))，10 個種子約 3 次撲空 → +1.4。
  // 第二條（和原版相比）：中心差 −0.72 − (−0.05) = −0.67，標準誤 √(1.25²/n_tail + 0.86²/n_plain)，
  // 上限 = max(−0.5, −0.67 + 3 × 標準誤) → 10 個種子約 +1.6。撲空次數夠多（tailCost ≥ 約 50 次、原版 ≥ 約 40 次，
  // 約 150 個種子）時算出來的上限 ≤ 原本的，用原本的。
  // 撲空次數的下限：原本 `> 50`（240 個種子）；守門版期望只有 3 次，只要求 `> 0`。
  it('tailCost（預設）：撲空的僚機讓分差少 0.5 以上（10.19 第 4 題的判準），而且比小規格原版的撲空（≈ 0）至少多損失 0.5（種子數 10 × CQ_N，原本 240 個；±3 個標準誤取寬的）', () => {
    const rows = forcedLaunches(cqGame, seeds(TAIL_N), CONFIG);
    const misses = summarize(rows.filter((r) => !r.hit).map((r) => r.deltaHorizon));
    const plainMisses = summarize(
      plainForced()
        .filter((r) => !r.hit)
        .map((r) => r.deltaHorizon),
    );
    const meanLimit = FULL
      ? -0.5
      : Math.max(-0.5, -0.72 + (Z * 1.25) / Math.sqrt(Math.max(1, misses.n)));
    const diffLimit = FULL
      ? -0.5
      : Math.max(
          -0.5,
          -0.67 +
            Z *
              Math.sqrt(1.25 ** 2 / Math.max(1, misses.n) + 0.86 ** 2 / Math.max(1, plainMisses.n)),
        );
    report(
      `tailCost 撲空（${TAIL_N} 個種子）：n=${misses.n} 平均 ${misses.mean.toFixed(2)} ± ${misses.se.toFixed(2)}，上限 ${meanLimit.toFixed(2)}；與原版的差 ${(misses.mean - plainMisses.mean).toFixed(2)}，上限 ${diffLimit.toFixed(2)}`,
    );
    expect(misses.n).toBeGreaterThan(FULL ? 50 : 0);
    expect(
      misses.mean,
      `tailCost 撲空 n=${misses.n} 平均 ${misses.mean.toFixed(2)} ± ${misses.se.toFixed(2)}`,
    ).toBeLessThanOrEqual(meanLimit);
    expect(misses.mean - plainMisses.mean, `原版撲空 ${plainMisses.mean.toFixed(2)}`).toBeLessThan(
      diffLimit,
    );
  }, 1_800_000);
});

// ---------------------------------------------------------------------------
// 探針 A（真實規則、真實 AI）
// ---------------------------------------------------------------------------

describe('C-Q 兩條蛇｜探針 A（DESIGN-AI-FUN 10.24、10.54）', () => {
  // 大場次（200 場，`c99bfba`，小規格「四」）：(a) 7.8%、(b) 35.3%、(c) 37.8%，(c)−(b) = +2.5（標準誤 4.8）。
  // (b) 就是劇本玩家 `spam`、(c) 就是 `reads`（小規格「三」「四」是同一批對局），所以和上面共用同一份結果，不重算。
  // 守門版 30 × CQ_N 場（最多 200）。(a) < (b) 的差 27.5 個點，標準誤 √(.078×.922/30 + .353×.647/30) = 0.100，
  // 只有 2.75 個標準誤（偶然不過約 0.3%，略高於 3 個標準誤的 0.135%）；這條是方向性的斷言，(a) 是「不知道有對手」的 8%，
  // 沒有可以放寬的量，所以照原樣。
  // (c)−(b) < 0.2：標準誤 √(.353×.647/30 + .378×.622/30) = 0.124，上限 = 0.025 + 3×0.124 = 0.40（原本 0.2，放寬；
  // 原本 200 場的標準誤是 0.048，0.2 是 3.6 個標準誤）。守門版只擋得住「讀對手的狀態變成大贏」（40 個點）。
  it('(a) 不知道有對手 / (b) 知道但不讀它的狀態（能放就放）/ (c) 讀它的狀態（靠近才放、躲僚機）各 30 × CQ_N 場（原本 200 場）：互動強度 (c) − (b) 低於「中心 + 3 個標準誤」（不宣稱「你可以騙它」；原本 20 個百分點）', () => {
    const a = scriptedRate('unaware', PROBE_N);
    const b = scriptedRate('aware', PROBE_N);
    const c = scriptedRate('reads', PROBE_N);
    const limit = FULL ? 0.2 : Math.max(0.2, 0.025 + Z * diffSe(0.353, 0.378, PROBE_N));
    report(
      `探針 A（${PROBE_N} 場）：(a) ${a}、(b) ${b}、(c) ${c}、(c)−(b) ${((c - b) * 100).toFixed(1)}`,
    );
    expect(a, `(a) ${a} (b) ${b} (c) ${c}`).toBeLessThan(b);
    expect(
      c - b,
      `互動強度 (c)−(b) = ${((c - b) * 100).toFixed(1)} 個百分點（上限 ${(limit * 100).toFixed(1)}）`,
    ).toBeLessThan(limit);
  }, 1_200_000);
});

// ---------------------------------------------------------------------------
// 反應速度
// ---------------------------------------------------------------------------

// 反應速度：80 場 ×（40 場一格）約 19 秒，**沒有縮**（場數與門檻和原本一樣）：最貼線的「只差決定頻率」是 77.5%，
// 40 場的標準誤是 6.6 個點，離 90% 只有 1.9 個標準誤，場數再縮小，「中心 + 3 個標準誤」會超過 100%。
describe('C-Q 兩條蛇｜反應速度（準則 3）', () => {
  it('快而淺對慢而深，以及只差反應延遲／只差決定頻率／只差搜尋深度，快（淺）的一邊勝率都低於 90%', () => {
    const neutral: LevelParams = { reactionTicks: 12, decideEvery: 4, depth: 3, epsilon: 0 };
    const cells: { readonly name: string; readonly a: LevelParams; readonly b: LevelParams }[] = [
      {
        name: '合併（快而淺對慢而深）',
        a: { reactionTicks: 3, decideEvery: 1, depth: 1, epsilon: 0 },
        b: { reactionTicks: 18, decideEvery: 12, depth: 6, epsilon: 0 },
      },
      {
        name: '只差反應延遲',
        a: { ...neutral, reactionTicks: 3 },
        b: { ...neutral, reactionTicks: 18 },
      },
      {
        name: '只差決定頻率',
        a: { ...neutral, decideEvery: 1 },
        b: { ...neutral, decideEvery: 12 },
      },
      { name: '只差搜尋深度', a: { ...neutral, depth: 1 }, b: { ...neutral, depth: 6 } },
    ];
    for (const spec of cells) {
      let points = 0;
      const count = 40;
      for (let seed = 0; seed < count; seed += 1) {
        const side: Side = seed % 2 === 0 ? 0 : 1;
        const fast = wrapPolicy(cqGame, pathfinder, spec.a, seed + 1);
        const slow = wrapPolicy(cqGame, pathfinder, spec.b, seed + 2);
        const result =
          side === 0
            ? playMatch(cqGame, seed, CONFIG, fast, slow)
            : playMatch(cqGame, seed, CONFIG, slow, fast);
        points += result.winner === null ? 0.5 : result.winner === side ? 1 : 0;
      }
      expect(points / count, `${spec.name}：${((100 * points) / count).toFixed(1)}%`).toBeLessThan(
        0.9,
      );
    }
  }, 600_000);
});

// 放得出去：80 場約 10 秒，**沒有縮**。深的贏 55%、淺的贏 36%（小規格決定 15）：兩邊勝場差在 80 場的標準誤約 8.5 場，
// 差的中心是 +15 場，原本的「深的不比淺的少」已經是 1.8 個標準誤；場數再縮小就沒有意義了。
describe('C-Q 兩條蛇｜放得出去（actions 的排序和 evaluate 的偏好一致，DESIGN-AI-FUN 10.54 之前的三次病例）', () => {
  it('決定頻率低（每 4 個 tick 一次）、深度 6 的搜尋型不會一直拖延：80 場對深度 1 的，每場至少放 1 次，而且深的贏的場數不比淺的少', () => {
    const neutral: LevelParams = { reactionTicks: 12, decideEvery: 4, depth: 3, epsilon: 0 };
    let deepLaunches = 0;
    let deepWins = 0;
    let shallowWins = 0;
    const count = 80;
    for (let seed = 0; seed < count; seed += 1) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const shallow = wrapPolicy(cqGame, pathfinder, { ...neutral, depth: 1 }, seed + 1);
      const deep = wrapPolicy(cqGame, pathfinder, { ...neutral, depth: 6 }, seed + 2);
      const result =
        side === 0
          ? playPair(cqGame, seed, CONFIG, shallow, deep)
          : playPair(cqGame, seed, CONFIG, deep, shallow);
      const deepSide: Side = side === 0 ? 1 : 0;
      deepLaunches += result.final.launches[deepSide];
      deepWins += result.winner === deepSide ? 1 : 0;
      shallowWins += result.winner === side ? 1 : 0;
    }
    expect(
      deepLaunches / count,
      `深的每場放 ${(deepLaunches / count).toFixed(2)} 次`,
    ).toBeGreaterThanOrEqual(1);
    expect(deepWins, `深的贏 ${deepWins}、淺的贏 ${shallowWins}`).toBeGreaterThanOrEqual(
      shallowWins,
    );
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 性格指紋（機制，不是症狀）
// ---------------------------------------------------------------------------

interface Fingerprint {
  /** 有選擇的決定：至少兩個沒有確定會死的動作、而且它們的 danger 差 0.2 以上。 */
  readonly decisions: number;
  /** 這些決定裡，選到 danger 最高的動作的占比。 */
  readonly riskiest: number;
  /** 落後（我的分數低於對手）／領先時，同一個占比。 */
  readonly riskiestBehind: number;
  readonly riskiestAhead: number;
  /** 我死了、對手活著的場數占比（頭對頭兩條都死不算）。 */
  readonly lostByDeath: number;
  /** 放僚機：每場放幾次、命中率、放出時尾端離對手蛇身多近、可以放之後等了多久。 */
  readonly launchesPerGame: number;
  readonly hitRate: number;
  readonly nearMean: number;
  readonly waitMean: number;
}

function manhattanCells(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

/**
 * 性格 `policy` 等級 10 對搜尋型等級 10：每一次有風險差異的決定，它選的是最危險的還是最安全的（機制，10.48）；
 * 另外記放僚機的次數、命中率、時機。
 */
function fingerprint(policy: Policy, count: number): Fingerprint {
  let games = 0;
  let launches = 0;
  let hits = 0;
  let nearSum = 0;
  let waitSum = 0;
  let decisions = 0;
  let risky = 0;
  let behindN = 0;
  let behindRisky = 0;
  let aheadN = 0;
  let aheadRisky = 0;
  let lost = 0;
  for (const seed of seeds(count)) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const other: Side = side === 0 ? 1 : 0;
    const inner = levelController(cqGame, policy, 10, seed);
    const theirs = level10(cqGame, seed + 1_000_003);
    let state = cqGame.init(seed, CONFIG);
    let readyAt = -1;
    let tick = 0;
    while (!cqGame.isOver(state)) {
      const before = state;
      const chosen: Buttons = inner.decide(state, side, tick);
      const reply: Buttons = theirs.decide(state, other, tick);
      const actions = cqGame.actions(state, side);
      if (actions.length > 1) {
        const dangerOf = (action: Buttons): number =>
          cqGame.evaluate(cqGame.step(state, side === 0 ? [action, reply] : [reply, action]), side)
            .danger;
        const options = actions.map(dangerOf).filter((danger) => danger < 1);
        const picked = dangerOf(chosen);
        if (
          options.length >= 2 &&
          Math.max(...options) - Math.min(...options) >= 0.2 &&
          picked < 1
        ) {
          const riskiest = picked === Math.max(...options) ? 1 : 0;
          decisions += 1;
          risky += riskiest;
          const lead = state.snakes[side].score - state.snakes[other].score;
          if (lead < 0) {
            behindN += 1;
            behindRisky += riskiest;
          } else if (lead > 0) {
            aheadN += 1;
            aheadRisky += riskiest;
          }
        }
      }
      state = cqGame.step(state, side === 0 ? [chosen, reply] : [reply, chosen]);
      tick += 1;
      if (readyAt < 0 && actions.some((b) => b.a)) {
        readyAt = before.tick;
      }
      if (state.launches[side] > before.launches[side]) {
        launches += 1;
        waitSum += before.tick - readyAt;
        readyAt = -1;
        const body = before.snakes[side].body;
        const tail = body[body.length - 1] as number;
        nearSum += Math.min(...before.snakes[other].body.map((c) => manhattanCells(tail, c)));
      }
      if (state.hits[side] > before.hits[side]) {
        hits += 1;
      }
    }
    games += 1;
    if (!state.snakes[side].alive && state.snakes[other].alive) {
      lost += 1;
    }
  }
  return {
    decisions,
    riskiest: risky / Math.max(1, decisions),
    riskiestBehind: behindRisky / Math.max(1, behindN),
    riskiestAhead: aheadRisky / Math.max(1, aheadN),
    lostByDeath: lost / games,
    launchesPerGame: launches / games,
    hitRate: hits / Math.max(1, launches),
    nearMean: nearSum / Math.max(1, launches),
    waitMean: waitSum / Math.max(1, launches),
  };
}

// 大場次（100 場，種子 0..99，`c99bfba`；HEAD 重量的原始樣本）：選最危險的 搜尋型 8.7%、精準型 10.1%、貪心型 43.2%、賭徒型 91.4%；
// 死亡 12%／8%／60%／31%；放僚機每場 2.01／2.45／2.35／0.23 次；放時離對手蛇身 6.1／5.4／5.4／12.5 格。
// 這一組斷言是**比較**（兩兩分得開、賭徒型更少放且放得更遠、貪心型死得更多），不是範圍，所以守門版用 100 場的原始樣本重抽
// （每個性格各抽 12 場、賭徒型抽 24 場，10 萬到 20 萬次，算同一組斷言）算每一條偶然不過的機率，超過 0.135% 的才放寬：
// - 五對分得開（原本的準則，搜尋型／精準型那一對本來就不斷言）：偶然不過 0.00%，**不放寬**；
// - `decisions ≥ 300`（100 場，每場至少 3 個有選擇的決定）：每場實際約 1000 個；照場數縮成 ≥ 3 × 場數，**不放寬**；
// - 賭徒型每場放的次數 < 0.5 × 搜尋型：12／24 場偶然不過 0.58%，比值的第 99.865 百分位是 0.70，放寬成 < 0.7 倍；
// - 賭徒型放時離對手 > 1.5 × 搜尋型：賭徒型 100 場只放了 23 次，原本的 1.5 倍在原本的 100 場就有 6.5% 偶然不過；
//   賭徒型 24 場（約 5 次放出）時比值的第 0.135 百分位是 0（有一成多的重抽裡賭徒型根本沒放），所以只能放寬成
//   「賭徒型放過、而且放時離對手有距離」（> 0 倍），這一條在守門版等於只擋得住「賭徒型一次都不放」；
// - 貪心型死亡場數 ≥ 2 × 搜尋型／精準型：真值是 5 倍與 7.5 倍；12 場時比值的第 0.135 百分位是 0.80 與 1.00，
//   放寬成 ≥ 0.8 倍與 ≥ 1.0 倍。
// 場數 = 100（`CQ_N=10`）時全部用原本的門檻。
describe('C-Q 兩條蛇｜四個性格的指紋（機制，不是症狀）', () => {
  const fpN = count(12, 100);
  const gamblerN = count(24, 100);
  const fullFp = FULL;
  it('每個性格等級 10 對搜尋型等級 10、各 12 × CQ_N 場（賭徒型 24 × CQ_N；原本各 100 場）：「有風險差異時選最危險的」、死亡率、放僚機的次數與時機，兩兩至少一項差 1.5 倍或 10 個百分點；賭徒型更少放、放得更遠', () => {
    const prints = {
      pathfinder: fingerprint(pathfinder, fpN),
      precise: fingerprint(precise, fpN),
      greedy: fingerprint(greedy, fpN),
      gambler: fingerprint(gambler, gamblerN),
    };
    report(`指紋（${fpN} 場，賭徒型 ${gamblerN} 場）：${JSON.stringify(prints)}`);
    const names = Object.keys(prints) as (keyof typeof prints)[];
    const apart = (a: number, b: number): boolean =>
      Math.max(a, b) >= 1.5 * Math.min(a, b) || Math.abs(a - b) >= 0.1;
    const ratio = (a: number, b: number): boolean => Math.max(a, b) >= 1.5 * Math.min(a, b);
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        // 搜尋型與精準型在這張牌上量不出可靠的差異（小規格預測的「精準型很少放」被推翻，見小規格）：
        // 這一對不斷言可分，只在小規格寫下兩邊的數字。其餘五對都要分得開。
        if (names[i] === 'pathfinder' && names[j] === 'precise') {
          continue;
        }
        const a = prints[names[i] as keyof typeof prints];
        const b = prints[names[j] as keyof typeof prints];
        expect(
          apart(a.riskiest, b.riskiest) ||
            apart(a.lostByDeath, b.lostByDeath) ||
            ratio(a.launchesPerGame, b.launchesPerGame) ||
            ratio(a.nearMean, b.nearMean),
          `${names[i]} 對 ${names[j]}：${JSON.stringify(a)} 對 ${JSON.stringify(b)}`,
        ).toBe(true);
      }
    }
    expect(prints.pathfinder.decisions).toBeGreaterThanOrEqual(3 * fpN);
    // 賭徒型的放僚機：次數遠少於搜尋型、放的時候離對手更遠（小規格預測的是「落後才放」，實測推翻，見小規格）
    expect(prints.gambler.launchesPerGame).toBeLessThan(
      (fullFp ? 0.5 : 0.7) * prints.pathfinder.launchesPerGame,
    );
    expect(prints.gambler.nearMean).toBeGreaterThan(
      (fullFp ? 1.5 : 0) * prints.pathfinder.nearMean,
    );
    // 貪心型不看 danger：死在自己選的路上的場數最多
    expect(prints.greedy.lostByDeath).toBeGreaterThanOrEqual(
      (fullFp ? 2 : 0.8) * prints.pathfinder.lostByDeath,
    );
    expect(prints.greedy.lostByDeath).toBeGreaterThanOrEqual(
      (fullFp ? 2 : 1) * prints.precise.lostByDeath,
    );
  }, 900_000);
});

// ---------------------------------------------------------------------------
// 互動強度（骨架探針；寫完 step 之後補做，只能當診斷，不是標籤，DESIGN-AI-FUN 10.30）
// ---------------------------------------------------------------------------

const NO_BUTTONS: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};

/** 人類模型那樣的一步前瞻最佳動作：每個動作套用一個 tick，取 gain − 2 × 範圍 × danger 最高的（平手取排前面的）。 */
function bestAction(state: CQState, side: Side): number {
  const actions = cqGame.actions(state, side);
  const theirs = cqGame.actions(state, side === 0 ? 1 : 0)[0] ?? NO_BUTTONS;
  const evals = actions.map((action) =>
    cqGame.evaluate(cqGame.step(state, side === 0 ? [action, theirs] : [theirs, action]), side),
  );
  const gains = evals.map((e) => e.gain);
  const spread = Math.max(...gains) - Math.min(...gains);
  const scores = evals.map((e) => e.gain - 2 * (spread > 0 ? spread : 1) * e.danger);
  let best = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if ((scores[i] as number) > (scores[best] as number)) {
      best = i;
    }
  }
  return best;
}

// 骨架探針：60 場等級 5 對打取局面，約 2 秒，**沒有縮**（場數與門檻和原本一樣）。
describe('C-Q 兩條蛇｜互動強度（骨架探針，診斷用）', () => {
  it('改掉 AI 公開可見的狀態（僚機在場上／不在、冷卻剩幾秒），人的最佳動作改變的比例（建議值 20%；實測數字見小規格）', () => {
    // 60 場等級 5 對打，每 18 tick 取一個局面。
    const samples: CQState[] = [];
    for (const seed of seeds(60)) {
      let state = cqGame.init(seed, CONFIG);
      const a = levelController(cqGame, pathfinder, 5, seed);
      const b = levelController(cqGame, pathfinder, 5, seed + 1_000_003);
      for (let tick = 0; tick < 2400 && !state.over; tick += 1) {
        if (tick % 18 === 0 && tick > 0 && state.tick % 6 !== 5) {
          samples.push(state);
        }
        state = cqGame.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    expect(samples.length).toBeGreaterThanOrEqual(1000);
    let droneFlips = 0;
    let droneCompared = 0;
    let reloadFlips = 0;
    let swapFlips = 0;
    let swapCompared = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i] as CQState;
      const base = bestAction(s, 0);
      // (1) AI 的僚機：在場上 ↔ 不在（不在時放一台在它的蛇頭上、瞄準人的蛇頭前方）
      const head = s.snakes[1].body[0] as number;
      const toggled: CQState = {
        ...s,
        drone: [
          s.drone[0],
          s.drone[1] === null
            ? {
                cell: head,
                tail: [],
                aim: s.snakes[0].body[0] as number,
                ttl: 200,
                nextAim: s.tick + 12,
              }
            : null,
        ],
      };
      droneCompared += 1;
      droneFlips += base !== bestAction(toggled, 0) ? 1 : 0;
      // (2) AI 的冷卻：剛好可以放 ↔ 剛放完
      const cooled: CQState = { ...s, reload: [s.reload[0], s.reload[1] === 0 ? 480 : 0] };
      reloadFlips += base !== bestAction(cooled, 0) ? 1 : 0;
      // (3) 對照：AI 的整條蛇換成同一批樣本裡別的局面的蛇（不重疊人的蛇身）
      const donor = samples[(i * 7 + 13) % samples.length] as CQState;
      const mine = new Set(s.snakes[0].body);
      if (donor !== s && !donor.snakes[1].body.some((c) => mine.has(c))) {
        swapCompared += 1;
        swapFlips +=
          base !== bestAction({ ...s, snakes: [s.snakes[0], donor.snakes[1]] }, 0) ? 1 : 0;
      }
    }
    const droneRate = droneFlips / droneCompared;
    const reloadRate = reloadFlips / samples.length;
    const swapRate = swapFlips / Math.max(1, swapCompared);
    // 準則 2.5 的建議值是 20%。釘住量到的區間（不是改門檻）：互動消失（< 下限）或到達 20%（好事）時變紅，提醒回頭改小規格的標籤。
    expect(
      droneRate,
      `僚機在場上↔不在：${(100 * droneRate).toFixed(1)}%（${droneCompared} 個局面）`,
    ).toBeLessThan(0.2);
    expect(droneRate).toBeGreaterThan(0.003);
    expect(reloadRate, `冷卻 0↔480：${(100 * reloadRate).toFixed(1)}%`).toBeLessThan(0.2);
    expect(
      swapRate,
      `對照：換掉 AI 的整條蛇 ${(100 * swapRate).toFixed(1)}%（${swapCompared} 個局面）`,
    ).toBeGreaterThan(0);
  }, 600_000);
});
