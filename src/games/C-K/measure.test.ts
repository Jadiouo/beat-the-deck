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

const CONFIG = { maxTicks: 3600, params: {} };
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

describe('C-K 梅花馬拉松｜A1–A4 的另外兩個種子區塊（官方 100 場在契約測試）', () => {
  it.each([
    ['200..399', 200],
    ['400..599', 400],
  ] as const)(
    '種子 %s（200 場）：A1 ≥ 75、A2 ≥ 60、A3 ≥ 45、A4 ≤ 35',
    (_name, from) => {
      const block = seeds(200, from);
      expect(measureA1(entry, block), 'A1').toBeGreaterThanOrEqual(0.75);
      expect(measureA2(entry, block), 'A2').toBeGreaterThanOrEqual(0.6);
      expect(measureA3(entry, block), 'A3').toBeGreaterThanOrEqual(0.45);
      expect(measureA4(entry, block), 'A4').toBeLessThanOrEqual(0.35);
    },
    900_000,
  );

  it('A1 最貼線（官方 78.0）：樣本外種子 1000..1999 合併 1000 場，離門檻 75 至少 3 個點', () => {
    expect(measureA1(entry, seeds(1000, 1000)), 'A1 樣本外 1000 場').toBeGreaterThanOrEqual(0.78);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// 沒有支配策略（10.40）
// ---------------------------------------------------------------------------

describe('C-K 梅花馬拉松｜沒有支配策略（DESIGN-AI-FUN 10.40）', () => {
  it('簡單劇本對搜尋型等級 10：S4（直衝食物，零延遲 400 場／延遲 12 tick 400 場）與只求不死各 200 場，都沒有超過 90%（量到約 51／25／2）', () => {
    const zero = scriptedWinRate(ckGame, () => s4Controller('aware', 0), seeds(400), CONFIG);
    const delayed = scriptedWinRate(ckGame, () => s4Controller('aware', 12), seeds(400), CONFIG);
    const survivor = scriptedWinRate(ckGame, () => survivorController(), seeds(200), CONFIG);
    expect(zero, `S4 零延遲 ${zero}`).toBeLessThan(0.6);
    expect(delayed, `S4 延遲 12 ${delayed}`).toBeLessThan(0.4);
    expect(survivor, `只求不死 ${survivor}`).toBeLessThan(0.1);
  }, 1_200_000);
});

// ---------------------------------------------------------------------------
// 局長（四個情境）
// ---------------------------------------------------------------------------

describe('C-K 梅花馬拉松｜局長（四個情境都要量）', () => {
  it('等級 10 對 10、人類模型對 10／2／1 各 60 場：中位數與第 10 百分位不低於釘住的值（兩個低等級情境沒達到 30 秒，是梅花共用層的性質）', () => {
    const scenarios: {
      readonly name: string;
      readonly make: (seed: number) => [Controller<CKState>, Controller<CKState>];
      readonly median: number;
      readonly p10: number;
    }[] = [
      {
        name: '等級 10 對 10',
        make: (s) => [level10(s), level10(s + 1_000_003)],
        median: 50,
        p10: 30,
      },
      {
        name: '人類模型對 10',
        make: (s) => [human(s), level10(s + 1_000_003)],
        median: 45,
        p10: 10,
      },
      {
        // 目標 30 秒沒達到：等級 2 的 AI 自己撞死（C-A 的對照組 15.7 秒），是共用層的性質
        name: '人類模型對 2',
        make: (s) => [human(s), levelController(ckGame, pathfinder, 2, s + 1_000_003)],
        median: 12,
        p10: 4,
      },
      {
        name: '人類模型對 1',
        make: (s) => [human(s), levelController(ckGame, pathfinder, 1, s + 1_000_003)],
        median: 15,
        p10: 3,
      },
    ];
    for (const scenario of scenarios) {
      const seconds = seeds(60).map((seed) => {
        const [a, b] = scenario.make(seed);
        return (
          (seed % 2 === 0
            ? playPair(ckGame, seed, CONFIG, a, b)
            : playPair(ckGame, seed, CONFIG, b, a)
          ).ticks / 60
        );
      });
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
  it('(a) 不知道有對手 / (b) 知道對手、知道每段規則、不讀預告 / (c) 讀預告（下一段是霧就靠近中心）各 200 場：(a) < (b)，而且 (c) − (b) 在 ±10 個百分點內（預期接近零）', () => {
    const a = scriptedWinRate(ckGame, () => s4Controller('unaware'), seeds(200), CONFIG);
    const b = scriptedWinRate(ckGame, () => s4Controller('aware'), seeds(200), CONFIG);
    const c = scriptedWinRate(ckGame, () => s4Controller('reads'), seeds(200), CONFIG);
    expect(a, `(a) ${a} (b) ${b} (c) ${c}`).toBeLessThan(b);
    expect(Math.abs(c - b), `(c)−(b) = ${((c - b) * 100).toFixed(1)} 個百分點`).toBeLessThan(0.1);
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
  it('30 場真實對局：每一次換段，前後兩個 tick 的分數差只可能是那一格的吃到（+1 或 C-3 吃錯 −2），蛇身長度差也只可能是 +1 或 0', () => {
    let boundaries = 0;
    for (const seed of seeds(30)) {
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
    expect(boundaries).toBeGreaterThan(30);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 反應速度（準則 3）
// ---------------------------------------------------------------------------

describe('C-K 梅花馬拉松｜反應速度（準則 3）', () => {
  it('快而淺對慢而深，以及只差反應延遲／只差搜尋深度，快（淺）的一邊勝率低於 90%；只差決定頻率那一格量到 94%（梅花共用層：C-A 67.5、C-3 86.9、C-4 76.9），釘住低於 98%', () => {
    const neutral: LevelParams = { reactionTicks: 12, decideEvery: 4, depth: 3, epsilon: 0 };
    const cells: {
      readonly name: string;
      readonly a: LevelParams;
      readonly b: LevelParams;
      readonly limit: number;
    }[] = [
      {
        name: '合併（快而淺對慢而深）',
        a: { reactionTicks: 3, decideEvery: 1, depth: 1, epsilon: 0 },
        b: { reactionTicks: 18, decideEvery: 12, depth: 6, epsilon: 0 },
        limit: 0.9,
      },
      {
        name: '只差反應延遲',
        a: { ...neutral, reactionTicks: 3 },
        b: { ...neutral, reactionTicks: 18 },
        limit: 0.9,
      },
      {
        name: '只差決定頻率',
        a: { ...neutral, decideEvery: 1 },
        b: { ...neutral, decideEvery: 12 },
        limit: 0.98,
      },
      {
        name: '只差搜尋深度',
        a: { ...neutral, depth: 1 },
        b: { ...neutral, depth: 6 },
        limit: 0.9,
      },
    ];
    for (const spec of cells) {
      let points = 0;
      const count = 80;
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

describe('C-K 梅花馬拉松｜四個性格玩起來不同（機制，不是症狀；繼承各段，C-K 不另外寫指紋）', () => {
  it('每個性格等級 10 對搜尋型等級 10、各 80 場：死亡率與每分鐘得分，兩兩至少一項差 1.5 倍或 10 個百分點', () => {
    const policies: readonly [string, Policy][] = [
      ['pathfinder', pathfinder],
      ['precise', precise],
      ['greedy', greedy],
      ['gambler', gambler],
    ];
    const prints = policies.map(([name, policy]) => [name, fingerprint(policy, 80)] as const);
    for (let i = 0; i < prints.length; i += 1) {
      for (let j = i + 1; j < prints.length; j += 1) {
        const [nameA, a] = prints[i] as readonly [string, Fingerprint];
        const [nameB, b] = prints[j] as readonly [string, Fingerprint];
        const ratio =
          Math.max(a.scorePerMinute, b.scorePerMinute) /
          Math.max(0.1, Math.min(a.scorePerMinute, b.scorePerMinute));
        const gap = Math.abs(a.diedRate - b.diedRate);
        expect(
          ratio >= 1.5 || gap >= 0.1,
          `${nameA} ${JSON.stringify(a)} 對 ${nameB} ${JSON.stringify(b)}`,
        ).toBe(true);
      }
    }
  }, 900_000);
});
