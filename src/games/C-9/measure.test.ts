import { describe, expect, it } from 'vitest';

import { HUMAN_PARAMS, humanPolicy } from '../../ai/human-model';
import { levelController, wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Side } from '../../core/types';
import type { LevelParams, Policy } from '../../ai/types';
import { measureA4 } from '../../../tests/contract/checks';
import { blockSeeds } from '../_clubs/ai-blocks.test-helpers';
import { findEntry } from '../registry';
import { c9Game } from './logic';
import type { C9State } from './logic';
import { median, p10, playTracked, scripted, scriptedWinRate } from './players.test-helpers';
import type { PlayerKind } from './players.test-helpers';

/**
 * C-9 的量測型測試（DESIGN-AI-FUN 2.3 指紋、2.5 互動強度、3 反應速度、10.40 支配策略、10.48 指紋測機制）。
 * 數字與量測的 commit 見 `docs/cards/C-9.md`「實作與量測」。門檻是量到的值留餘裕，沒有為了讓它過而調整；
 * 小規格的目標（局長中位數 ≥ 35 秒、僵局 ≤ 25%）沒有降低，量到沒達到的地方在小規格如實寫。
 */

const CONFIG = { maxTicks: 3600, params: {} };

function seeds(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

function level10(seed: number): Controller<C9State> {
  return levelController(c9Game, pathfinder, 10, seed);
}

function human(seed: number): Controller<C9State> {
  return wrapPolicy(c9Game, humanPolicy, HUMAN_PARAMS, seed);
}

/** 兩個控制器對打：偶數種子 a 坐 0 號邊。 */
function playPair(
  seed: number,
  make: (seed: number) => [Controller<C9State>, Controller<C9State>],
): ReturnType<typeof playTracked> {
  const [a, b] = make(seed);
  return seed % 2 === 0
    ? playTracked(c9Game, seed, CONFIG, a, b)
    : playTracked(c9Game, seed, CONFIG, b, a);
}

describe('C-9 鑰匙與門｜僵局與局長', () => {
  it('僵局：兩個搜尋型等級 10 對打 60 場（240 局），時間到平手的局數 / 總局數 ≤ 25%（小規格的門檻）', () => {
    let rounds = 0;
    let stalemates = 0;
    for (const seed of seeds(60)) {
      const game = playPair(seed, (s) => [level10(s), level10(s + 1_000_003)]);
      for (const round of game.rounds) {
        rounds += 1;
        stalemates += round.outcome === 'stalemate' ? 1 : 0;
      }
    }
    expect(rounds).toBe(240);
    expect(stalemates / rounds, `僵局 ${stalemates}/${rounds}`).toBeLessThanOrEqual(0.25);
  }, 120_000);

  it('局長（DESIGN-AI-FUN 附錄：四個情境都要量）：等級 10 對 10、人類模型對 10／2／1 各 60 場，中位數與第 10 百分位不低於門檻', () => {
    const scenarios: {
      readonly name: string;
      readonly make: (seed: number) => [Controller<C9State>, Controller<C9State>];
      readonly median: number;
      readonly p10: number;
    }[] = [
      {
        name: '等級 10 對 10',
        make: (s) => [level10(s), level10(s + 1_000_003)],
        median: 35,
        p10: 27,
      },
      {
        name: '人類模型對 10',
        make: (s) => [human(s), level10(s + 1_000_003)],
        median: 33,
        p10: 24,
      },
      {
        name: '人類模型對 2',
        make: (s) => [human(s), levelController(c9Game, pathfinder, 2, s + 1_000_003)],
        median: 25,
        p10: 18,
      },
      {
        name: '人類模型對 1',
        make: (s) => [human(s), levelController(c9Game, pathfinder, 1, s + 1_000_003)],
        median: 26,
        p10: 19,
      },
    ];
    for (const scenario of scenarios) {
      const seconds = seeds(60).map((seed) => playPair(seed, scenario.make).ticks / 60);
      expect(median(seconds), `${scenario.name} 局長中位數`).toBeGreaterThanOrEqual(
        scenario.median,
      );
      expect(p10(seconds), `${scenario.name} 局長第 10 百分位`).toBeGreaterThanOrEqual(
        scenario.p10,
      );
    }
  }, 300_000);
});

describe('C-9 鑰匙與門｜沒有支配策略（DESIGN-AI-FUN 10.40、5.2）', () => {
  it('四個劇本玩家對搜尋型等級 10 各 100 場：沒有任何一個超過 90%；站在門口的輸、讀對手的贏', () => {
    const kinds: PlayerKind[] = ['aware', 'guard', 'bluff', 'reads'];
    const rate: Record<string, number> = {};
    for (const kind of kinds) {
      rate[kind] = scriptedWinRate(c9Game, kind, seeds(100), CONFIG);
    }
    for (const kind of kinds) {
      expect(rate[kind], `${kind} ${(100 * (rate[kind] as number)).toFixed(1)}%`).toBeLessThan(0.9);
    }
    // 「站在門口等」（蛇不能停，所以是在門前路口繞圈）不是支配策略，反而輸
    expect(rate.guard).toBeLessThan(0.45);
    // 看得到對手、會算誰先到的玩家贏得了 AI（A4 之外的證據：人贏得了第十級）
    expect(rate.reads).toBeGreaterThan(0.5);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 性格指紋（機制，DESIGN-AI-FUN 10.48）
// ---------------------------------------------------------------------------

interface Fingerprint {
  /** 有選擇的決定：至少兩個沒有確定會死的動作、而且它們的 danger 差 0.2 以上。 */
  readonly decisions: number;
  /** 這些決定裡，選到 danger 最高的動作的占比。 */
  readonly riskiest: number;
  /** 落後（我的總分低於對手）／領先時，同一個占比。 */
  readonly riskiestBehind: number;
  readonly riskiestAhead: number;
  readonly rounds: number;
  /** 我死了、對手活著的局數占比（頭對頭兩條都死不算）。 */
  readonly lostByDeath: number;
}

const NO_BUTTONS: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};

/** 性格 `policy` 等級 10 對搜尋型等級 10：每一次有風險差異的決定，它選的是最危險的還是最安全的。 */
function fingerprint(policy: Policy, count: number): Fingerprint {
  let decisions = 0;
  let risky = 0;
  let behindN = 0;
  let behindRisky = 0;
  let aheadN = 0;
  let aheadRisky = 0;
  let rounds = 0;
  let lost = 0;
  for (const seed of seeds(count)) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const inner = levelController(c9Game, policy, 10, seed);
    const watched: Controller<C9State> = {
      decide(state, who, tick): Buttons {
        const chosen = inner.decide(state, who, tick);
        if (state.pause === 0 && state.outcome === null && !state.over && state.roundTick > 0) {
          const actions = c9Game.actions(state, who);
          if (actions.length > 1) {
            const theirs = c9Game.actions(state, who === 0 ? 1 : 0)[0] ?? NO_BUTTONS;
            const dangerOf = (action: Buttons): number =>
              c9Game.evaluate(
                c9Game.step(state, who === 0 ? [action, theirs] : [theirs, action]),
                who,
              ).danger;
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
              const lead = state.snakes[who].score - state.snakes[who === 0 ? 1 : 0].score;
              if (lead < 0) {
                behindN += 1;
                behindRisky += riskiest;
              } else if (lead > 0) {
                aheadN += 1;
                aheadRisky += riskiest;
              }
            }
          }
        }
        return chosen;
      },
    };
    const opponent = level10(seed + 1_000_003);
    const game =
      side === 0
        ? playTracked(c9Game, seed, CONFIG, watched, opponent)
        : playTracked(c9Game, seed, CONFIG, opponent, watched);
    for (const round of game.rounds) {
      rounds += 1;
      if (round.outcome !== 'draw' && round.dead.includes(side)) {
        lost += 1;
      }
    }
  }
  return {
    decisions,
    riskiest: risky / Math.max(1, decisions),
    riskiestBehind: behindRisky / Math.max(1, behindN),
    riskiestAhead: aheadRisky / Math.max(1, aheadN),
    rounds,
    lostByDeath: lost / rounds,
  };
}

describe('C-9 鑰匙與門｜四個性格的指紋（機制，不是症狀）', () => {
  it('每個性格等級 10 對搜尋型等級 10、各 100 場：「有風險差異時選最危險的」與死亡率兩兩差 1.5 倍或 10 個百分點以上，賭徒落後時更敢', () => {
    const prints = {
      pathfinder: fingerprint(pathfinder, 100),
      precise: fingerprint(precise, 100),
      greedy: fingerprint(greedy, 100),
      gambler: fingerprint(gambler, 100),
    };
    const names = Object.keys(prints) as (keyof typeof prints)[];
    const apart = (a: number, b: number): boolean =>
      Math.max(a, b) >= 1.5 * Math.min(a, b) || Math.abs(a - b) >= 0.1;
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const a = prints[names[i] as keyof typeof prints];
        const b = prints[names[j] as keyof typeof prints];
        expect(
          apart(a.riskiest, b.riskiest) || apart(a.lostByDeath, b.lostByDeath),
          `${names[i]} 對 ${names[j]}：選最危險的 ${a.riskiest.toFixed(2)} 對 ${b.riskiest.toFixed(2)}，死亡 ${a.lostByDeath.toFixed(2)} 對 ${b.lostByDeath.toFixed(2)}`,
        ).toBe(true);
      }
    }
    expect(prints.pathfinder.decisions).toBeGreaterThanOrEqual(500);
    // 精準型是閃避專家：幾乎總是選最安全的
    expect(prints.precise.riskiest).toBeLessThan(0.15);
    expect(prints.precise.riskiest).toBeLessThan(0.5 * prints.pathfinder.riskiest);
    // 賭徒型偏好風險：比搜尋型與貪心型更常選最危險的
    expect(prints.gambler.riskiest).toBeGreaterThanOrEqual(prints.pathfinder.riskiest + 0.1);
    expect(prints.gambler.riskiest).toBeGreaterThanOrEqual(prints.greedy.riskiest + 0.1);
    // 賭徒型落後時比領先時更敢（小規格：落後就硬闖）
    expect(prints.gambler.riskiestBehind).toBeGreaterThanOrEqual(
      prints.gambler.riskiestAhead + 0.1,
    );
    // 貪心型不看 danger：死在自己選的路上的局最多
    expect(prints.greedy.lostByDeath).toBeGreaterThanOrEqual(2 * prints.pathfinder.lostByDeath);
    expect(prints.greedy.lostByDeath).toBeGreaterThanOrEqual(2 * prints.precise.lostByDeath);
    expect(prints.greedy.lostByDeath).toBeGreaterThanOrEqual(2 * prints.gambler.lostByDeath);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// 互動強度（骨架探針）與反應速度
// ---------------------------------------------------------------------------

/** 人類模型那樣的一步前瞻最佳動作：每個動作套用一個 tick，取 gain − 2 × 範圍 × danger 最高的（平手取排前面的）。 */
function bestAction(state: C9State, side: Side): number {
  const actions = c9Game.actions(state, side);
  const theirs = c9Game.actions(state, side === 0 ? 1 : 0)[0] ?? NO_BUTTONS;
  const evals = actions.map((action) =>
    c9Game.evaluate(c9Game.step(state, side === 0 ? [action, theirs] : [theirs, action]), side),
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

describe('C-9 鑰匙與門｜互動強度與反應速度', () => {
  it('互動強度（準則 2.5，骨架探針）：只看有真選擇的路口，改掉 AI 公開可見的狀態，人的最佳動作改變的比例（建議值 20%，實測約 2%，未達；數字見小規格）', () => {
    // 60 場等級 5 對打，每 18 tick 取一個局面；只留「至少兩個沒有確定會死的動作」的路口。
    const samples: C9State[] = [];
    for (const seed of seeds(60)) {
      let state = c9Game.init(seed, CONFIG);
      const a = levelController(c9Game, pathfinder, 5, seed);
      const b = levelController(c9Game, pathfinder, 5, seed + 1_000_003);
      for (let tick = 0; tick < 2000 && !state.over; tick += 1) {
        if (
          tick % 18 === 0 &&
          state.pause === 0 &&
          state.outcome === null &&
          state.roundTick > 0 &&
          state.roundTick % 6 !== 5
        ) {
          const options = c9Game
            .actions(state, 0)
            .filter(
              (action) => c9Game.evaluate(c9Game.step(state, [action, NO_BUTTONS]), 0).gain > -50,
            );
          if (options.length >= 2) {
            samples.push(state);
          }
        }
        state = c9Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    expect(samples.length).toBeGreaterThanOrEqual(300);
    let flipped = 0;
    let moved = 0;
    let compared = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i] as C9State;
      // (1) AI 叼著鑰匙 ↔ 沒有
      const toggled: C9State = { ...s, keyHolder: s.keyHolder === 1 ? null : 1 };
      flipped += bestAction(s, 0) !== bestAction(toggled, 0) ? 1 : 0;
      // (2) AI 在同一座迷宮的另一個位置（同一座迷宮的別的樣本裡 AI 的蛇）
      const donors = samples.filter(
        (d) => d !== s && d.layouts === s.layouts && d.round >> 1 === s.round >> 1,
      );
      const donor = donors[(i * 7) % Math.max(1, donors.length)];
      if (donor !== undefined) {
        const mine = new Set(s.snakes[0].body);
        if (!donor.snakes[1].body.some((c) => mine.has(c))) {
          const swapped: C9State = {
            ...s,
            snakes: [s.snakes[0], { ...donor.snakes[1], score: s.snakes[1].score }],
          };
          compared += 1;
          moved += bestAction(s, 0) !== bestAction(swapped, 0) ? 1 : 0;
        }
      }
    }
    // 準則 2.5 的建議值是 20%；實測 2.1% 與 1.6%（1437 個路口）。釘住量到的區間而不是改門檻：互動消失（< 0.5%）或到達 20%（好事）時變紅，提醒回頭改小規格的標籤。
    const holdRate = flipped / samples.length;
    const placeRate = moved / Math.max(1, compared);
    expect(holdRate, `AI 叼鑰匙 ↔ 沒有：${(100 * holdRate).toFixed(1)}%`).toBeGreaterThan(0.005);
    expect(holdRate).toBeLessThan(0.2);
    expect(placeRate, `AI 換位置：${(100 * placeRate).toFixed(1)}%`).toBeGreaterThan(0.005);
    expect(placeRate).toBeLessThan(0.2);
  }, 300_000);

  it('反應速度（準則 3）：快而淺對慢而深，以及只差反應延遲／只差決定頻率／只差搜尋深度，快（淺）的一邊勝率都低於 90%', () => {
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
    for (const cellSpec of cells) {
      let points = 0;
      const count = 40;
      for (let seed = 0; seed < count; seed += 1) {
        const side: Side = seed % 2 === 0 ? 0 : 1;
        const fast = wrapPolicy(c9Game, pathfinder, cellSpec.a, seed + 1);
        const slow = wrapPolicy(c9Game, pathfinder, cellSpec.b, seed + 2);
        const result =
          side === 0
            ? playMatch(c9Game, seed, CONFIG, fast, slow)
            : playMatch(c9Game, seed, CONFIG, slow, fast);
        points += result.winner === null ? 0.5 : result.winner === side ? 1 : 0;
      }
      expect(
        points / count,
        `${cellSpec.name}：${((100 * points) / count).toFixed(1)}%`,
      ).toBeLessThan(0.9);
    }
  }, 300_000);
});

describe('C-9 鑰匙與門｜小規格的預測「AI 會在門口繞圈守、等你先拿」', () => {
  it('對手是「走向鑰匙但不拿」以外的任何玩家時，AI 不會乾等：對站在門口不拿鑰匙的玩家，AI 在多數局裡自己拿到鑰匙', () => {
    let rounds = 0;
    let aiTookKey = 0;
    for (const seed of seeds(40)) {
      const aiSide: Side = seed % 2 === 0 ? 1 : 0;
      const guard = scripted('guard' satisfies PlayerKind);
      const ai = level10(seed + 1_000_003);
      const game =
        aiSide === 1
          ? playTracked(c9Game, seed, CONFIG, guard, ai)
          : playTracked(c9Game, seed, CONFIG, ai, guard);
      for (const round of game.rounds) {
        rounds += 1;
        aiTookKey += (round.keyTicks[aiSide] as number) >= 0 ? 1 : 0;
      }
    }
    // 預測是「AI 會乾等」：若成立，AI 拿到鑰匙的局會很少。實測 76%（見小規格），所以預測不成立；門檻放在 60%，低於它代表 AI 真的開始守著不動。
    expect(aiTookKey / rounds, `AI 拿到鑰匙的局 ${aiTookKey}/${rounds}`).toBeGreaterThan(0.6);
  }, 120_000);
});

/**
 * A4（人類模型對預設性格等級 10，門檻 ≤ 35%）的穩定度（DESIGN-AI-FUN 10.57）。
 * 官方 `tests/ai/a-checks.*` 只跑種子 0..99；那 100 個種子剛好落在好的一側（量測 commit 2924262：
 * 0..99 29.0%、100..299 38.3%、300..499 34.8%、500 場合併 35.0%）。門檻 35% 與官方種子都沒動；
 * 這裡守的是另外兩個沒用過的區塊（各 200 場），以及 500 場合併要離門檻至少 6 點（10.57 的 ±6 規則）。
 */
describe('C-9 鑰匙與門｜A4 的餘裕（10.57）', () => {
  const entry = findEntry('C-9');
  it.each([100, 300])(
    '種子 %i..+199 的 A4 ≤ 35%',
    (start) => {
      const rate = measureA4(entry!, blockSeeds(start));
      expect(rate, `A4 ${start}..${start + 199}：${(100 * rate).toFixed(1)}%`).toBeLessThanOrEqual(
        0.35,
      );
    },
    600_000,
  );
  it('500 場（種子 0..499）合併的 A4 離門檻至少 6 點（≤ 29%）', () => {
    const rate = measureA4(entry!, blockSeeds(0, 500));
    expect(rate, `A4 0..499：${(100 * rate).toFixed(1)}%`).toBeLessThanOrEqual(0.29);
  }, 900_000);
});
