import { describe, expect, it } from 'vitest';

import { HUMAN_PARAMS, humanPolicy } from '../../ai/human-model';
import { levelController, wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { playMatch } from '../../core/match';
import type { LevelParams, Policy } from '../../ai/types';
import type { Controller, Side } from '../../core/types';
import { measureA1, measureA2, measureA3, measureA4 } from '../../../tests/contract/checks';
import { findEntry } from '../registry';
import { ckGame } from './logic';
import type { CKState, PhaseId } from './logic';
import {
  median,
  p10,
  playPair,
  s4Controller,
  scriptedWinRate,
  survivorController,
} from './players.test-helpers';

/**
 * C-K 的量測型測試（DESIGN-AI-FUN 2.3 指紋、3 反應速度、10.27 老闆裁定、10.40 支配策略、10.54、10.57）。
 * 數字與量測的 commit 見 `docs/cards/C-K.md`「實作與量測」。門檻是量到的值留餘裕，沒有為了讓它過而調整；
 * 沒達到目標的地方（兩個低等級的局長、決定頻率那一格的反應速度）如實寫在小規格，這裡釘住量到的區間而不是宣稱達標。
 *
 * **這張牌沒有自己的 AI 互動**（10.27）：探針 A 的 (c) − (b) 預期接近零，這裡釘的是「接近零」，不是「夠大」。
 */

/**
 * **場數與門檻（守門版）。** 這支檔案是守門用的：預設場數是原本大場次的 1/5 到 1/10，一次跑約 3 到 4 分鐘；
 * 原本的大場次（共 1959 秒，約 33 分鐘）用環境變數開，數字與量測的 commit 在 `docs/cards/C-K.md`
 * 「實作與量測」（`logic.ts` 的行為自 `e7d327b` 起沒變，原本的測試是 `9ddff39`）：
 *
 *     CK_N=10 CK_VERBOSE=1 npx vitest run --project heavy src/games/C-K/measure.test.ts
 *
 * `CK_N`（預設 1）乘上每一項的場數（但不超過原本的場數）；**`CK_N=10`（以上）就是原本的場數與原本的門檻**
 * （每一項的守門版場數與原本場數的對照表在小規格「守門版的場數」）。`CK_VERBOSE=1` 把量到的數字印出來。
 *
 * **門檻怎麼算。** 場數縮小，標準誤變大，所以每一條比例類的門檻都用同一個公式（`floorFor`／`ceilFor`）：
 * 中心值 p 取大場次量到的值（小規格寫的 commit 的數字），標準誤 SE = √(p(1−p)/n)（n 是這一項的場數；
 * 平手算半場，所以這是略保守的上界），門檻 = p ∓ 3·SE（偶然紅的機率約 0.13%）；**如果原本的門檻比這個更寬，
 * 就沿用原本的，不收緊**。所以場數越多（`CK_N` 越大）門檻越接近原本的，`CK_N=10` 時等於原本的
 * （不是比例的幾項寫成「場數 = 原本就用原本的門檻」）。
 * 局長與指紋的門檻不是比例，用大場次的原始樣本重抽（bootstrap）算，註解寫在各處。
 * 守門版抓得到的是「大幅退步」（例如 AI 變笨、規則被改壞），抓不到幾個百分點的漂移；要看漂移請開大場次。
 */
const N = Math.max(1, Math.floor(Number(process.env.CK_N ?? '1')));
const Z = 3;
/** `CK_N=10` 以上：原本的場數與原本的門檻。 */
const FULL = N >= 10;

/** 這一項的場數：守門版 `base` × `CK_N`，不超過原本的 `original`；`FULL` 時就是 `original`。 */
function count(base: number, original: number): number {
  return FULL ? original : Math.min(original, base * N);
}

const CONFIG = { maxTicks: 3600, params: {} };

function report(text: string): void {
  if (process.env.CK_VERBOSE !== undefined) {
    console.log(text);
  }
}

/** 比例 p 在 n 場下的標準誤。 */
function se(p: number, n: number): number {
  return Math.sqrt((p * (1 - p)) / n);
}

/** 「≥ 原本的門檻」的守門版：中心 p 減 3 個標準誤，原本的門檻更低就沿用原本的。 */
function floorFor(p: number, n: number, original: number): number {
  return Math.min(original, p - Z * se(p, n));
}

/** 「≤／< 原本的門檻」的守門版：中心 p 加 3 個標準誤，原本的門檻更高就沿用原本的。 */
function ceilFor(p: number, n: number, original: number): number {
  return Math.max(original, p + Z * se(p, n));
}

const entry = findEntry('C-K');
if (entry === undefined) {
  throw new Error('登記表裡沒有 C-K');
}

function seeds(count: number, from = 0): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}

function level10(seed: number): Controller<CKState> {
  return levelController(ckGame, pathfinder, 10, seed);
}

function human(seed: number): Controller<CKState> {
  return wrapPolicy(ckGame, humanPolicy, HUMAN_PARAMS, seed);
}

// ---------------------------------------------------------------------------
// A1–A4：三個種子區塊（官方 0..99 在契約測試裡），貼近門檻的另外補到 500 場與樣本外
// ---------------------------------------------------------------------------

/**
 * A1–A4 的中心值：大場次的合併 500 場（種子 0..99 + 200..599，`e7d327b`，小規格「六」）：
 * A1 83.4、A2 91.3、A3 82.9、A4 21.1。守門版每個區塊 16 × N 場（原本 200 場），
 * 標準誤 √(p(1−p)/16)：A1 0.093、A2 0.070、A3 0.094、A4 0.102。
 * 門檻 = 中心 ∓ 3 個標準誤，原本的更寬就沿用：A1 ≥ 0.834−0.280 = 0.554（原本 0.75，放寬）；
 * A2 ≥ 0.913−0.211 = 0.702 > 原本 0.60，沿用 0.60；A3 ≥ 0.829−0.283 = 0.546 > 原本 0.45，沿用 0.45；
 * A4 ≤ 0.211+0.306 = 0.517（原本 0.35，放寬）。官方 0..99 的 A1–A4 在契約測試，用原本的門檻，沒有動。
 * 場數 = 200（`CK_N=10`）時公式算出來的門檻就等於或寬於原本的，所以用原本的。
 */
const BLOCK_N = count(16, 200);
const A1_CENTER = 0.834;
const A2_CENTER = 0.913;
const A3_CENTER = 0.829;
const A4_CENTER = 0.211;

describe('C-K 梅花馬拉松｜A1–A4 的另外兩個種子區塊（官方 100 場在契約測試）', () => {
  it.each([
    ['200..399', 200],
    ['400..599', 400],
  ] as const)(
    '種子 %s（16 × CK_N 場）：A1、A2、A3 不低於、A4 不高於「中心 ∓ 3 個標準誤」（原本 200 場：A1 ≥ 75、A2 ≥ 60、A3 ≥ 45、A4 ≤ 35）',
    (_name, from) => {
      const block = seeds(BLOCK_N, from);
      const a1 = measureA1(entry, block);
      const a2 = measureA2(entry, block);
      const a3 = measureA3(entry, block);
      const a4 = measureA4(entry, block);
      report(`A1–A4（${BLOCK_N} 場，種子 ${from}..）：A1 ${a1} A2 ${a2} A3 ${a3} A4 ${a4}`);
      expect(a1, 'A1').toBeGreaterThanOrEqual(floorFor(A1_CENTER, BLOCK_N, 0.75));
      expect(a2, 'A2').toBeGreaterThanOrEqual(floorFor(A2_CENTER, BLOCK_N, 0.6));
      expect(a3, 'A3').toBeGreaterThanOrEqual(floorFor(A3_CENTER, BLOCK_N, 0.45));
      expect(a4, 'A4').toBeLessThanOrEqual(ceilFor(A4_CENTER, BLOCK_N, 0.35));
    },
    900_000,
  );

  // 這一條本來就便宜（1000 場約 11 秒，A1 的對手是隨機型），沒有縮：門檻與場數都和原本一樣。
  it('A1 最貼線（官方 78.0）：樣本外種子 1000..1999 合併 1000 場，離門檻 75 至少 3 個點', () => {
    expect(measureA1(entry, seeds(1000, 1000)), 'A1 樣本外 1000 場').toBeGreaterThanOrEqual(0.78);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// 沒有支配策略（10.40）
// ---------------------------------------------------------------------------

/** S4 劇本玩家對搜尋型等級 10 的勝率（種子 0..count−1），同一組只算一次。 */
const s4Cache = new Map<string, number>();
function s4Rate(kind: 'unaware' | 'aware' | 'reads', delay: number, count: number): number {
  const key = `${kind}:${delay}:${count}`;
  let value = s4Cache.get(key);
  if (value === undefined) {
    value = scriptedWinRate(ckGame, () => s4Controller(kind, delay), seeds(count), CONFIG);
    s4Cache.set(key, value);
  }
  return value;
}

/** S4 與探針 A 的場數（零延遲、延遲、(a)、(b)、(c) 都用同一個）。 */
const PROBE_N = count(24, 200);

describe('C-K 梅花馬拉松｜沒有支配策略（DESIGN-AI-FUN 10.40）', () => {
  // 大場次（`e7d327b`，小規格「五」）：零延遲 400 場 51.0%、延遲 12 tick 400 場 25.3%、只求不死 200 場 2.0%。
  // 守門版 24／24／12 × N 場，標準誤 √(p(1−p)/n)（N=1）：零延遲 √(.51×.49/24) = 0.102 → 上限 .51+3×.102 = 0.816
  // （原本 0.6，放寬）；延遲 √(.253×.747/24) = 0.089 → .253+3×.089 = 0.519（原本 0.4，放寬）；
  // 只求不死 √(.02×.98/12) = 0.040 → .02+3×.040 = 0.141（原本 0.1，放寬）。三個都低於「支配策略」的 0.9。
  // 場數 = 400／400／200（`CK_N=10`）時公式算出來的門檻就等於或寬於原本的，所以用原本的。
  // 零延遲的 S4 就是探針 A 的 (b)（`aware`），種子 0..n−1 與場數相同時是同一批對局，下面的探針 A 共用這一份結果（`s4Rate`）。
  it('簡單劇本對搜尋型等級 10：S4（直衝食物，零延遲 24 × CK_N 場／延遲 12 tick 24 × CK_N 場）與只求不死 12 × CK_N 場，都沒有超過「中心 + 3 個標準誤」（量到約 51／25／2，原本 400／400／200 場、上限 60／40／10）', () => {
    const zeroN = count(24, 400);
    const survivorN = count(12, 200);
    const zero = s4Rate('aware', 0, zeroN);
    const delayed = s4Rate('aware', 12, zeroN);
    const survivor = scriptedWinRate(ckGame, () => survivorController(), seeds(survivorN), CONFIG);
    report(
      `S4：零延遲 ${zero}、延遲 12 ${delayed}（各 ${zeroN} 場）、只求不死 ${survivor}（${survivorN} 場）`,
    );
    expect(zero, `S4 零延遲 ${zero}`).toBeLessThan(ceilFor(0.51, zeroN, 0.6));
    expect(delayed, `S4 延遲 12 ${delayed}`).toBeLessThan(ceilFor(0.253, zeroN, 0.4));
    expect(survivor, `只求不死 ${survivor}`).toBeLessThan(ceilFor(0.02, survivorN, 0.1));
  }, 1_200_000);
});

// ---------------------------------------------------------------------------
// 局長（四個情境）
// ---------------------------------------------------------------------------

describe('C-K 梅花馬拉松｜局長（四個情境都要量）', () => {
  // 大場次（60 場，種子 0..59，`e7d327b`，小規格「七」；HEAD 重量的原始樣本：中位數／第 10 百分位
  // 等級 10 對 10 = 60.0／38.1、人類模型對 10 = 54.5／17.7、對 2 = 15.8／6.0、對 1 = 20.3／4.3，標準差 12.9／17.3／12.2／15.2 秒）。
  // 守門版 10 × CK_N 場。中位數與第 10 百分位不是比例，標準誤用大場次的 60 個原始樣本**重抽**（bootstrap，10 萬次，
  // 每次抽 10 場、算同一個統計量）取第 0.135 百分位（= 3 個標準誤的單尾）；解析式的交叉檢查：
  // 中位數標準誤 ≈ 1.2533·sd/√n（例如人類模型對 1：20.3 − 3×1.2533×15.2/√10 = 2.2，重抽的 4.9）。
  // 第 10 百分位在 10 場時是第 2 小的那一場（索引 floor(10/10) = 1），沒有簡單的標準誤公式，重抽出來的下限
  // 就是 60 場裡最短的那幾場（9.2／1.9／1.1／1.5 秒），所以守門版的第 10 百分位只擋得住「一成以上的對局在幾秒內結束」。
  // 門檻取原本與重抽下限的較小者（取整數或 .5 以下）：中位數 42.2→42、21.8→21、7.1→7、4.9→4.5；
  // 第 10 百分位 9.2→9、1.9→1.8、1.1→1、1.5→1.4。
  // 場數 = 60（`CK_N=10`）時用原本的門檻。
  const lengthN = count(10, 60);
  it('等級 10 對 10、人類模型對 10／2／1 各 10 × CK_N 場（原本 60 場）：中位數與第 10 百分位不低於釘住的值（兩個低等級情境沒達到 30 秒，是梅花共用層的性質）', () => {
    const scenarios: {
      readonly name: string;
      readonly make: (seed: number) => [Controller<CKState>, Controller<CKState>];
      readonly median: number;
      readonly p10: number;
    }[] = [
      {
        name: '等級 10 對 10',
        make: (s) => [level10(s), level10(s + 1_000_003)],
        median: FULL ? 50 : 42,
        p10: FULL ? 30 : 9,
      },
      {
        name: '人類模型對 10',
        make: (s) => [human(s), level10(s + 1_000_003)],
        median: FULL ? 45 : 21,
        p10: FULL ? 10 : 1.8,
      },
      {
        // 目標 30 秒沒達到：等級 2 的 AI 自己撞死（C-A 的對照組 15.7 秒），是共用層的性質
        name: '人類模型對 2',
        make: (s) => [human(s), levelController(ckGame, pathfinder, 2, s + 1_000_003)],
        median: FULL ? 12 : 7,
        p10: FULL ? 4 : 1,
      },
      {
        name: '人類模型對 1',
        make: (s) => [human(s), levelController(ckGame, pathfinder, 1, s + 1_000_003)],
        median: FULL ? 15 : 4.5,
        p10: FULL ? 3 : 1.4,
      },
    ];
    for (const scenario of scenarios) {
      const seconds = seeds(lengthN).map((seed) => {
        const [a, b] = scenario.make(seed);
        return (
          (seed % 2 === 0
            ? playPair(ckGame, seed, CONFIG, a, b)
            : playPair(ckGame, seed, CONFIG, b, a)
          ).ticks / 60
        );
      });
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
  }, 900_000);
});

// ---------------------------------------------------------------------------
// 探針 A：預期接近零
// ---------------------------------------------------------------------------

describe('C-K 梅花馬拉松｜探針 A（DESIGN-AI-FUN 10.24、10.35；老闆裁定 10.27 不要求，照實量）', () => {
  // 大場次（`e7d327b`，小規格「四」，200 場）：(a) 7.3%、(b) 48.5%、(c) 46.8%，(c)−(b) = −1.8。
  // 守門版 24 × N 場（和上面的 S4 共用）。(a) < (b) 的差有 41 個點，標準誤
  // √(.073×.927/24 + .485×.515/24) = 0.115，3.6 個標準誤，斷言本身不用放寬（方向性）。
  // (c)−(b) 的標準誤是兩個比例相減的 √(p_b(1−p_b)/n + p_c(1−p_c)/n)（當成獨立，是上界）：
  // n=200 時 √(2×.25/200) = 0.05，原本的 ±0.1 約 2 個標準誤；n=24 時 √(2×.25/24) = 0.144，
  // 3 個標準誤 = ±0.43（中心 −0.018）。所以門檻 = 0.018 + 3 個標準誤 = 0.45，取比原本 ±0.1 寬的。
  // 這一條在守門版只擋得住「讀預告變成大贏或大輸」（±45 個點）；要看幾個點的互動請開大場次。
  it('(a) 不知道有對手 / (b) 知道對手、知道每段規則、不讀預告 / (c) 讀預告（下一段是霧就靠近中心）各 24 × CK_N 場：(a) < (b)，而且 (c) − (b) 在 ±3 個標準誤內（預期接近零；原本 200 場、±10 個百分點）', () => {
    const count = PROBE_N;
    const a = s4Rate('unaware', 0, count);
    const b = s4Rate('aware', 0, count);
    const c = s4Rate('reads', 0, count);
    report(
      `探針 A（${count} 場）：(a) ${a}、(b) ${b}、(c) ${c}、(c)−(b) ${((c - b) * 100).toFixed(1)}`,
    );
    const diffSe = Math.sqrt(se(0.485, count) ** 2 + se(0.468, count) ** 2);
    const limit = FULL ? 0.1 : Math.max(0.1, 0.018 + Z * diffSe);
    expect(a, `(a) ${a} (b) ${b} (c) ${c}`).toBeLessThan(b);
    expect(
      Math.abs(c - b),
      `(c)−(b) = ${((c - b) * 100).toFixed(1)} 個百分點（上限 ${(limit * 100).toFixed(1)}）`,
    ).toBeLessThan(limit);
  }, 900_000);
});

// ---------------------------------------------------------------------------
// AI 不看預告：真實對局裡量
// ---------------------------------------------------------------------------

describe('C-K 梅花馬拉松｜AI 不看預告（小規格決定 7：量出來）', () => {
  it('真實對局（種子 0..5、等級 10 對 10）每 30 個 tick 取一個 state：把 phases[phase + 1] 換掉、notice 反過來，兩邊的 evaluate 與 actions 完全相同（0 個不同）', () => {
    let compared = 0;
    let different = 0;
    for (const seed of seeds(6)) {
      const controllers = [level10(seed + 1), level10(seed + 1_000_003)] as const;
      playPair(ckGame, seed, CONFIG, controllers[0], controllers[1], (after) => {
        if (after.tick % 30 !== 0 || after.over || after.phase >= 3) {
          return;
        }
        const swapped: PhaseId[] = [...after.phases];
        swapped[after.phase + 1] = after.phases[after.phase + 1] === 'C-4' ? 'C-2' : 'C-4';
        const altered: CKState = { ...after, phases: swapped, notice: !after.notice };
        for (const side of [0, 1] as const) {
          compared += 1;
          const same =
            JSON.stringify(ckGame.evaluate(altered, side)) ===
              JSON.stringify(ckGame.evaluate(after, side)) &&
            JSON.stringify(ckGame.actions(altered, side)) ===
              JSON.stringify(ckGame.actions(after, side));
          different += same ? 0 : 1;
        }
      });
    }
    expect(compared).toBeGreaterThan(100);
    expect(different, `${compared} 次比較`).toBe(0);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 分數不被重算（段與段之間的結算）
// ---------------------------------------------------------------------------

describe('C-K 梅花馬拉松｜分數不被重算（段與段之間）', () => {
  // 這一條是機制檢查（每一次換段的分數差只可能是 +1、0、−2），沒有統計門檻，所以場數縮小不需要放寬任何斷言；
  // 原本 30 場（58 秒），守門版 4 × CK_N 場。換段次數的下限原本是「> 30（30 場，每場至少 1 次）」，照每場至少 1 次縮成「> 場數」。
  it('4 × CK_N 場真實對局（原本 30 場）：每一次換段，前後兩個 tick 的分數差只可能是那一格的吃到（+1 或 C-3 吃錯 −2），蛇身長度差也只可能是 +1 或 0', () => {
    const games = count(4, 30);
    let boundaries = 0;
    for (const seed of seeds(games)) {
      playPair(
        ckGame,
        seed,
        CONFIG,
        level10(seed + 1),
        level10(seed + 1_000_003),
        (after, before) => {
          if (after.phase === before.phase) {
            return;
          }
          boundaries += 1;
          for (const side of [0, 1] as const) {
            const gained = after.snakes[side].score - before.snakes[side].score;
            expect([-2, 0, 1], `種子 ${seed} 換段分數差 ${gained}`).toContain(gained);
            const grew = after.snakes[side].body.length - before.snakes[side].body.length;
            expect([0, 1], `種子 ${seed} 換段蛇長差 ${grew}`).toContain(grew);
          }
        },
      );
    }
    report(`換段次數 ${boundaries}（${games} 場）`);
    expect(boundaries).toBeGreaterThan(games);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 反應速度（準則 3）
// ---------------------------------------------------------------------------

// 大場次（80 場，種子 0..79；小規格「九」另有 40 場與 120 場的數字）：合併 82.1–82.5%、只差反應延遲 60–61%、
// 只差決定頻率 86.3–93.8%（貼線，不穩）、只差搜尋深度 54–62%（現在 HEAD 的 80 場：81.3／64.4／90.0／59.4）。
// 這四格是便宜的對局（約 0.2 秒一場），
// 而且合併與決定頻率兩格離上限只有 8 與 4 到 12 個點（80 場的標準誤 4.3）：場數再縮小，「中心 + 3 個標準誤」
// 會超過 100%，斷言就沒有意義了。所以這兩格**不縮**（80 場、門檻不變）；只縮不貼線的兩格：
// 只差反應延遲（中心 .64，24 場標準誤 √(.64×.36/24) = 0.098，+3 個標準誤 = 0.934，門檻由 0.9 放寬到 0.934）、
// 只差搜尋深度（中心 .59，標準誤 0.100，+3 個標準誤 = 0.89 < 0.9，門檻不變），各 24 × CK_N 場（`ceilFor` 算）。
describe('C-K 梅花馬拉松｜反應速度（準則 3）', () => {
  it('快而淺對慢而深，以及只差反應延遲／只差搜尋深度，快（淺）的一邊勝率低於 90%；只差決定頻率那一格量到 94%（梅花共用層：C-A 67.5、C-3 86.9、C-4 76.9），釘住低於 98%', () => {
    const neutral: LevelParams = { reactionTicks: 12, decideEvery: 4, depth: 3, epsilon: 0 };
    const cells: {
      readonly name: string;
      readonly a: LevelParams;
      readonly b: LevelParams;
      readonly limit: number;
      readonly count: number;
    }[] = [
      {
        name: '合併（快而淺對慢而深）',
        a: { reactionTicks: 3, decideEvery: 1, depth: 1, epsilon: 0 },
        b: { reactionTicks: 18, decideEvery: 12, depth: 6, epsilon: 0 },
        limit: 0.9,
        count: 80,
      },
      {
        name: '只差反應延遲',
        a: { ...neutral, reactionTicks: 3 },
        b: { ...neutral, reactionTicks: 18 },
        limit: ceilFor(0.64, count(24, 80), 0.9),
        count: count(24, 80),
      },
      {
        name: '只差決定頻率',
        a: { ...neutral, decideEvery: 1 },
        b: { ...neutral, decideEvery: 12 },
        limit: 0.98,
        count: 80,
      },
      {
        name: '只差搜尋深度',
        a: { ...neutral, depth: 1 },
        b: { ...neutral, depth: 6 },
        limit: ceilFor(0.59, count(24, 80), 0.9),
        count: count(24, 80),
      },
    ];
    for (const spec of cells) {
      let points = 0;
      const count = spec.count;
      for (let seed = 0; seed < count; seed += 1) {
        const side: Side = seed % 2 === 0 ? 0 : 1;
        const fast = wrapPolicy(ckGame, pathfinder, spec.a, seed + 1);
        const slow = wrapPolicy(ckGame, pathfinder, spec.b, seed + 2);
        const result =
          side === 0
            ? playMatch(ckGame, seed, CONFIG, fast, slow)
            : playMatch(ckGame, seed, CONFIG, slow, fast);
        points += result.winner === null ? 0.5 : result.winner === side ? 1 : 0;
      }
      report(`反應速度 ${spec.name}（${count} 場）：${((100 * points) / count).toFixed(1)}%`);
      expect(points / count, `${spec.name}：${((100 * points) / count).toFixed(1)}%`).toBeLessThan(
        spec.limit,
      );
    }
  }, 900_000);
});

// ---------------------------------------------------------------------------
// 四個性格（繼承各段；機制指紋）
// ---------------------------------------------------------------------------

interface Fingerprint {
  readonly diedRate: number;
  readonly scorePerMinute: number;
}

function fingerprint(policy: Policy, games: number): Fingerprint {
  let died = 0;
  let gained = 0;
  let ticks = 0;
  for (const seed of seeds(games)) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const mine = levelController(ckGame, policy, 10, seed + 1);
    const opponent = level10(seed + 1_000_003);
    const result = playPair(
      ckGame,
      seed,
      CONFIG,
      side === 0 ? mine : opponent,
      side === 0 ? opponent : mine,
      (after, before) => {
        gained += after.snakes[side].score - before.snakes[side].score;
        ticks += 1;
      },
    );
    if (!result.final.snakes[side].alive) {
      died += 1;
    }
  }
  return { diedRate: died / games, scorePerMinute: (gained / ticks) * 3600 };
}

// 大場次（80 場，種子 0..79，`e7d327b` 與 HEAD 重量；小規格「十」用 100 場）：死亡率／每分鐘得分
// 搜尋型 13.8%／12.2、精準型 16.3%／6.3、貪心型 52.5%／19.7、賭徒型 58.8%／2.9。
// 這一條斷言不是「量到的值在範圍內」，而是「六對性格兩兩分得開」：至少一項差 1.5 倍或 10 個百分點。
// 守門版 12 × CK_N 場，兩兩的失敗機率用 80 場的原始樣本重抽（每個性格各抽 12 場，2 萬到 4 萬次）算：
// 原本的 1.5 倍在 12 場下，搜尋型／精準型這一對（得分比 12.2/6.3 = 1.93，死亡率只差 2.5 個點）有 4.6% 的機會偶然
// 不過（搜尋型／貪心型 1.8%），超過 0.135%；把倍數放寬到 1.1 倍（死亡率仍是 10 個百分點），最差的一對是 0.070%
// （搜尋型／精準型），六對加起來約 0.09%。80 場（`CK_N=10`）用原本的 1.5 倍。
// 守門版只擋得住「四個性格變得一樣」（得分比不到 1.1 倍而且死亡率差不到 10 個點）。
describe('C-K 梅花馬拉松｜四個性格玩起來不同（機制，不是症狀；繼承各段，C-K 不另外寫指紋）', () => {
  const fingerprintN = count(12, 80);
  const ratioLimit = FULL ? 1.5 : 1.1;
  it('每個性格等級 10 對搜尋型等級 10、各 12 × CK_N 場（原本 80 場）：死亡率與每分鐘得分，兩兩至少一項差 1.1 倍（原本 1.5 倍）或 10 個百分點', () => {
    const policies: readonly [string, Policy][] = [
      ['pathfinder', pathfinder],
      ['precise', precise],
      ['greedy', greedy],
      ['gambler', gambler],
    ];
    const prints = policies.map(
      ([name, policy]) => [name, fingerprint(policy, fingerprintN)] as const,
    );
    for (let i = 0; i < prints.length; i += 1) {
      for (let j = i + 1; j < prints.length; j += 1) {
        const [nameA, a] = prints[i] as readonly [string, Fingerprint];
        const [nameB, b] = prints[j] as readonly [string, Fingerprint];
        const ratio =
          Math.max(a.scorePerMinute, b.scorePerMinute) /
          Math.max(0.1, Math.min(a.scorePerMinute, b.scorePerMinute));
        const gap = Math.abs(a.diedRate - b.diedRate);
        report(
          `指紋 ${nameA} 對 ${nameB}：得分比 ${ratio.toFixed(2)}、死亡率差 ${gap.toFixed(3)}（${fingerprintN} 場）`,
        );
        expect(
          ratio >= ratioLimit || gap >= 0.1,
          `${nameA} ${JSON.stringify(a)} 對 ${nameB} ${JSON.stringify(b)}`,
        ).toBe(true);
      }
    }
  }, 900_000);
});
