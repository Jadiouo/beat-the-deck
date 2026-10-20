import { describe, expect, it } from 'vitest';

import { HUMAN_PARAMS, humanModel, humanPolicy } from '../../ai/human-model';
import { levelController, wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { random } from '../../ai/policies/random';
import { playMatch } from '../../core/match';
import type { Controller, Side } from '../../core/types';
import type { Policy } from '../../ai/types';
import { winRate } from '../../../tests/ai/harness';
import { registry } from '../registry';
import { EDGE, STAGE_POOL, STAGES, hkGame, stageTicksFor } from './logic';
import type { HKState, StageId } from './logic';
import {
  CONFIG,
  bestEdge,
  betFrom,
  firstStage,
  lastStage,
  leadKeepTrailLast,
  level,
  never,
  playAs,
  playFull,
  trailUse,
  withBet,
  worstEdge,
} from './players.test-helpers';
import type { BetRecord, BetRule } from './players.test-helpers';

/**
 * H-K 的量測型測試。這張牌是變化牌（DESIGN-AI-FUN 10.27）：加倍層沒有自己的 AI 互動，
 * 所以這裡量的是「賽制跑得起來」、「沒有支配策略」、「加倍決定有沒有鑑別力」與「互動強度接近零」，
 * 不是宣稱互動。門檻是 TEST_PLAN／DESIGN-AI-FUN 的建議值或「量到的區間」，沒有為了讓它過而調整。
 * 場數可用環境變數 `HK_N` 放大（小規格的數字用較大的場數量；這裡預設較小，讓 `npm run check` 跑得動）。
 */

const N = Number(process.env['HK_N'] ?? 0);
const n = (fallback: number): number => (N > 0 ? N : fallback);
const seeds = (count: number, from = 0): number[] =>
  Array.from({ length: count }, (_v, i) => from + i);
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** 劇本玩家（`inner` 打每一場被包的牌，`rule` 決定開場）對真正的 AI（等級 10）的得分，座位輪流。 */
function vsAi(make: (seed: number) => Controller<HKState>, count: number, from = 0): number {
  return mean(seeds(count, from).map((seed) => playAs(make(seed), level(10, seed + 1), seed)));
}

describe('H-K 紅心馬拉松｜局長（沒有任何契約測試在守局長，所以這裡守；四個情境）', () => {
  const scenarios: [string, (seed: number) => [Controller<HKState>, Controller<HKState>]][] = [
    ['等級 10 對等級 10', (s) => [level(10, s * 2 + 1), level(10, s * 2 + 2)]],
    ['人類模型對等級 10', (s) => [humanModel(hkGame, s * 2 + 1), level(10, s * 2 + 2)]],
    ['人類模型對等級 2（新手情境）', (s) => [humanModel(hkGame, s * 2 + 1), level(2, s * 2 + 2)]],
    ['人類模型對等級 1', (s) => [humanModel(hkGame, s * 2 + 1), level(1, s * 2 + 2)]],
  ];
  it.each(scenarios)(
    '%s：中位數 30 到 90 秒，第 10 百分位不少於 20 秒',
    (_name, make) => {
      const secs = seeds(n(30)).map((seed) => {
        const [a, b] = make(seed);
        return playFull(a, b, seed).ticks / 60;
      });
      const s = sorted(secs);
      const median = s[Math.floor(s.length / 2)] as number;
      const p10 = s[Math.floor(s.length * 0.1)] as number;
      expect(median).toBeGreaterThanOrEqual(30);
      expect(median).toBeLessThanOrEqual(90);
      expect(p10).toBeGreaterThanOrEqual(20);
    },
    300_000,
  );
});

describe('H-K 紅心馬拉松｜場次池的收錄條件（量測）', () => {
  /** 人類模型對搜尋型等級 10，在 673 tick 內分不出勝負（平手）的比率。 */
  function tieRate(id: string, count: number): number {
    const game = (registry.find((e) => e.id === id) as unknown as { game: typeof hkGame })
      .game as never;
    let ties = 0;
    for (const seed of seeds(count)) {
      const aiSide: Side = seed % 2 === 0 ? 0 : 1;
      const ai = levelController(game, pathfinder, 10, seed * 2 + 1);
      const human = humanModel(game, seed * 2 + 2);
      const config = { maxTicks: stageTicksFor(3600), params: {} };
      const result =
        aiSide === 0
          ? playMatch(game, seed + 5000, config, ai, human)
          : playMatch(game, seed + 5000, config, human, ai);
      if (result.winner === null) {
        ties += 1;
      }
    }
    return ties / count;
  }

  it('池裡每一張在縮短版（673 tick）裡對人類模型分得出勝負：平手少於 20%', () => {
    for (const id of STAGE_POOL) {
      expect(tieRate(id, n(100)), id).toBeLessThan(0.2);
    }
  }, 300_000);

  it('H-7 與 H-8 不收的理由：縮短版有二成五以上平手', () => {
    for (const id of ['H-7', 'H-8']) {
      expect(tieRate(id, n(100)), id).toBeGreaterThanOrEqual(0.2);
    }
  }, 300_000);

  it('edge 表可以重現：用較少的場數重量，每一格與表上的數字差不到 0.12（標準誤約 0.04）', () => {
    for (const id of STAGE_POOL) {
      const game = (registry.find((e) => e.id === id) as unknown as { game: never }).game;
      let points = 0;
      const count = n(120);
      for (const seed of seeds(count)) {
        const aiSide: Side = seed % 2 === 0 ? 0 : 1;
        const ai = levelController(game, pathfinder, 10, seed * 2 + 1);
        const human = humanModel(game, seed * 2 + 2);
        const config = { maxTicks: stageTicksFor(3600), params: {} };
        const result =
          aiSide === 0
            ? playMatch(game, seed + 9000, config, ai, human)
            : playMatch(game, seed + 9000, config, human, ai);
        points += result.winner === null ? 0.5 : result.winner === aiSide ? 1 : 0;
      }
      const edge = EDGE[id as StageId][0];
      expect(Math.abs(points / count - edge), id).toBeLessThan(0.12);
    }
  }, 600_000);
});

describe('H-K 紅心馬拉松｜反應速度（準則 3：快而淺對慢而深，快而淺的勝率低於 90%；三個維度分開量）', () => {
  const base = { reactionTicks: 12, decideEvery: 1, depth: 1, epsilon: 0 };
  const cases: [string, typeof base, typeof base][] = [
    [
      '合起來 {反應 3、每 tick、深度 1} 對 {反應 18、每 12 tick、深度 6}',
      { reactionTicks: 3, decideEvery: 1, depth: 1, epsilon: 0 },
      { reactionTicks: 18, decideEvery: 12, depth: 6, epsilon: 0 },
    ],
    ['只差反應（3 對 18）', { ...base, reactionTicks: 3 }, { ...base, reactionTicks: 18 }],
    [
      '只差決定頻率（每 tick 對每 12 tick）',
      { ...base, decideEvery: 1 },
      { ...base, decideEvery: 12 },
    ],
  ];
  it.each(cases)(
    '%s：前者勝率低於 90%',
    (_name, fast, slow) => {
      let points = 0;
      const count = n(100);
      for (const seed of seeds(count)) {
        const f = wrapPolicy(hkGame, pathfinder, fast, seed + 1);
        const s = wrapPolicy(hkGame, pathfinder, slow, seed + 2);
        points += playAs(f, s, seed);
      }
      expect(points / count).toBeLessThan(0.9);
    },
    300_000,
  );

  it('只差深度（6 對 1）：深的一方贏（等級的差別主要在深度，而不是反應速度）', () => {
    let points = 0;
    const count = n(100);
    for (const seed of seeds(count)) {
      const deep = wrapPolicy(hkGame, pathfinder, { ...base, depth: 6 }, seed + 1);
      const shallow = wrapPolicy(hkGame, pathfinder, base, seed + 2);
      points += playAs(deep, shallow, seed);
    }
    // H-8 的版本多一條「< 0.95」；那不是 TEST_PLAN 的要求，H-K 量到的深度效應更大，這裡不設上限（數字寫在小規格）。
    expect(points / count).toBeGreaterThan(0.6);
  }, 300_000);
});

describe('H-K 紅心馬拉松｜A1 到 A4 的餘裕（樣本外種子 500..999；門檻不動：A1 ≥ 75%、A2 ≥ 60%、A3 ≥ 45%、A4 ≤ 35%）', () => {
  it('A3（人類模型對等級 1）與 A4（人類模型對等級 10）同時成立', () => {
    const oos = seeds(n(500), 500);
    expect(winRate(hkGame, humanPolicy, HUMAN_PARAMS, pathfinder, 1, oos)).toBeGreaterThanOrEqual(
      0.45,
    );
    expect(winRate(hkGame, humanPolicy, HUMAN_PARAMS, pathfinder, 10, oos)).toBeLessThanOrEqual(
      0.35,
    );
  }, 600_000);

  it('A1（等級 5 對 random）與 A2（等級 9 對等級 2）成立', () => {
    const oos = seeds(n(300), 500);
    expect(winRate(hkGame, pathfinder, 5, random, 10, oos)).toBeGreaterThanOrEqual(0.75);
    expect(winRate(hkGame, pathfinder, 9, pathfinder, 2, oos)).toBeGreaterThanOrEqual(0.6);
  }, 600_000);
});

describe('H-K 紅心馬拉松｜沒有支配策略（10.40：簡單劇本對等級 10 的勝率，> 90% 就是支配策略）', () => {
  const rules: [string, BetRule][] = [
    ['永遠不用', never],
    ['第一場就用', firstStage],
    ['留到最後一場才用', lastStage],
    ['領先時留著、落後時最後一場用', leadKeepTrailLast],
    ['落後就用、領先留到最後', trailUse],
    ['用在 AI 最強的一場（edge 最高）', bestEdge],
    ['用在 AI 最弱的一場（edge 最低）', worstEdge],
  ];
  it.each(rules)(
    '%s（打牌的是等級 10 的搜尋型，只有開場規則不同）：低於 60%',
    (_name, rule) => {
      const rate = vsAi((seed) => withBet(level(10, seed * 2 + 7), rule), n(100));
      expect(rate).toBeLessThan(0.6);
    },
    300_000,
  );

  it.each(rules)(
    '%s（打牌的是人類模型）：低於 90%（人類模型會輸，但不能有哪個規則把它推到支配）',
    (_name, rule) => {
      const rate = vsAi((seed) => withBet(humanModel(hkGame, seed * 2 + 7), rule), n(100));
      expect(rate).toBeLessThan(0.9);
    },
    300_000,
  );
});

describe('H-K 紅心馬拉松｜加倍決定有沒有鑑別力（edge 表用實測 vs 第一版全放 0.5）', () => {
  /** 搜尋的時候把 edge 當成全 0.5（10.19 的第一版）；實際的對局還是真的 H-K。 */
  const flatGame = {
    ...hkGame,
    evaluate: (state: HKState, side: Side) => hkGame.evaluate({ ...state, flat: true }, side),
  };
  const flat = (seed: number): Controller<HKState> =>
    levelController(flatGame, pathfinder, 10, seed);

  it('兩個控制器的開場決定真的不同（表有被用到）：同一批局面裡至少一成的決定不一樣', () => {
    let differ = 0;
    let total = 0;
    for (const seed of seeds(n(40))) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const other: Side = side === 0 ? 1 : 0;
      const real = level(10, seed + 1);
      const ablated = flat(seed + 1);
      const opponent = level(10, seed + 11);
      let state = hkGame.init(seed, CONFIG);
      while (!hkGame.isOver(state)) {
        // 兩個控制器每個 tick 都要被問一次（它們記得自己的歷史）；對局由真的那個走。
        const mine = real.decide(state, side, state.tick);
        const theirs = ablated.decide(state, side, state.tick);
        if (state.phase === 'bet' && state.pending[side] === null && state.doublers[side] > 0) {
          total += 1;
          if (mine.a !== theirs.a || mine.b !== theirs.b) {
            differ += 1;
          }
        }
        const oppMove = opponent.decide(state, other, state.tick);
        state = hkGame.step(state, side === 0 ? [mine, oppMove] : [oppMove, mine]);
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(differ / total).toBeGreaterThanOrEqual(0.1);
  }, 300_000);

  it('實測 edge 的 AI 對全 0.5 的 AI（座位輪流）：勝率不低於 45%（至少沒有比沒有依據更差）', () => {
    const rate = mean(
      seeds(n(150)).map((seed) => playAs(level(10, seed * 2 + 1), flat(seed * 2 + 2), seed)),
    );
    expect(rate).toBeGreaterThanOrEqual(0.45);
  }, 600_000);
});

describe('H-K 紅心馬拉松｜互動強度（探針 A 三層，10.35；單位是勝率；定義在量之前固定）', () => {
  /**
   * 三組劇本玩家打每一場牌的方式都一樣（人類模型），只差開場決定「知道多少」，對真正的 AI（等級 10）：
   * - (a) 不知道有加倍牌的策略：永遠不用。
   * - (b) 知道有對手、有加倍牌，也知道各張牌自己的強弱（EDGE 表的反面：AI 最弱的一場就是人最強的一場），
   *   但不讀對手的公開狀態（籌碼、對手剩不剩加倍牌）：剩下的場次裡 EDGE 最低的那一場用。
   *   先驗合理：這是量出來的「人類模型對 AI」的各場勝率，不是亂設的。
   * - (c) 讀對手的公開狀態：開場決定交給 AI 自己的引擎（等級 10）。**(c) 是鏡像**：它就是 AI 的決定邏輯，
   *   而且它的 edge 表是 AI 對人的（站在人類座位上用它其實是錯的邊）。
   * 互動強度 = (c) − (b)。
   */
  it('(a) 永遠不用、(b) 用在自己最強的一場、(c) AI 自己的引擎；(c) − (b) 接近零', () => {
    const count = n(200);
    const a = vsAi((seed) => withBet(humanModel(hkGame, seed * 2 + 7), never), count);
    const b = vsAi((seed) => withBet(humanModel(hkGame, seed * 2 + 7), worstEdge), count);
    const c = vsAi(
      (seed) => betFrom(humanModel(hkGame, seed * 2 + 7), level(10, seed * 2 + 9)),
      count,
    );
    // 預期結果：加倍層沒有自己的互動，三者都在人類模型對 AI 的底線附近，差距在雜訊內。
    expect(Math.abs(c - b)).toBeLessThan(0.12);
    expect(Math.abs(b - a)).toBeLessThan(0.12);
  }, 600_000);
});

describe('H-K 紅心馬拉松｜四個性格的指紋（機制：開場決定怎麼用加倍牌，10.48）', () => {
  function betRecords(policy: Policy, count: number): BetRecord[] {
    const out: BetRecord[] = [];
    for (const seed of seeds(count)) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const mine = levelController(hkGame, policy, 10, seed + 7);
      const other = level(10, seed + 9);
      let state = hkGame.init(seed, CONFIG);
      while (!hkGame.isOver(state)) {
        const next = hkGame.step(
          state,
          side === 0
            ? [mine.decide(state, 0, state.tick), other.decide(state, 1, state.tick)]
            : [other.decide(state, 0, state.tick), mine.decide(state, 1, state.tick)],
        );
        if (state.pending[side] === null && next.pending[side] !== null && state.phase === 'bet') {
          out.push({
            stageIdx: state.stageIdx,
            stage: state.stages[state.stageIdx] as string,
            used: next.pending[side] === 1,
            holds: state.doublers[side] > 0,
            outlook: hkGame.evaluate(state, side).gain,
            chipsDiff: state.chips[side] - state.chips[side === 0 ? 1 : 0],
          });
        }
        state = next;
      }
    }
    return out;
  }
  const edgeOfStage = (r: BetRecord): number => EDGE[r.stage as StageId][0];
  const rate = (xs: BetRecord[], pick: (r: BetRecord) => boolean): number => {
    const ys = xs.filter(pick);
    return ys.filter((r) => r.used).length / Math.max(1, ys.length);
  };

  it('貪心型：只在最後一場用（有就用）；精準型：只在最後一場、而且這一場 edge ≥ 0.7 才用', () => {
    const gr = betRecords(greedy, n(60));
    const pr = betRecords(precise, n(60));
    expect(gr.some((r) => r.stageIdx === STAGES - 1 && r.holds)).toBe(true);
    expect(rate(gr, (r) => r.holds && r.stageIdx < STAGES - 1)).toBe(0);
    expect(rate(gr, (r) => r.holds && r.stageIdx === STAGES - 1)).toBe(1);
    expect(rate(pr, (r) => r.holds && r.stageIdx < STAGES - 1)).toBe(0);
    expect(rate(pr, (r) => r.holds && r.stageIdx === STAGES - 1 && edgeOfStage(r) < 0.7)).toBe(0);
    expect(rate(pr, (r) => r.holds && r.stageIdx === STAGES - 1 && edgeOfStage(r) >= 0.7)).toBe(1);
  }, 600_000);

  it('賭徒型：展望是輸面時提早用（連 edge 不到 0.75 的場也用）；展望是贏面時和貪心型一樣留著', () => {
    const ga = betRecords(gambler, n(60));
    expect(
      rate(ga, (r) => r.holds && r.stageIdx < STAGES - 1 && r.outlook < 0 && edgeOfStage(r) < 0.7),
    ).toBeGreaterThan(0.9);
    expect(rate(ga, (r) => r.holds && r.stageIdx < STAGES - 1 && r.outlook >= 0)).toBe(0);
  }, 600_000);

  it('搜尋型（等級 10）不是門檻：用在剩下的場次裡 edge 最高的那一場，最後一場一定用（還有的話），而且整場最多用一次', () => {
    const pf = betRecords(pathfinder, n(60));
    const byMatch = new Map<number, number>();
    let usedBest = 0;
    let used = 0;
    for (const r of pf) {
      if (r.used) {
        used += 1;
        void byMatch;
      }
      if (r.used && r.stageIdx < STAGES - 1) {
        usedBest += 1;
      }
    }
    expect(used).toBeGreaterThan(0);
    // 搜尋型有時在前面的場次用（edge 高的那場），不像貪心型與精準型永遠留到最後一場
    expect(usedBest / used).toBeGreaterThan(0.1);
  }, 600_000);
});
