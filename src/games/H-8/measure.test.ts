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
import { CLIMB, STOP, h8Game, ladderValue, successProb } from './logic';
import type { H8Past, H8State } from './logic';
import {
  CONFIG,
  alwaysClimb,
  alwaysStop,
  bluffBad,
  bluffGood,
  playAs,
  playFull,
  planAlone,
  planKnowing,
  planKnowingStatus,
  planReading,
  pointsOf,
  stopAt,
  threshold,
} from './players.test-helpers';

/**
 * H-8 的量測型測試（DESIGN-AI-FUN 10.29 到 10.35、10.40、10.48、10.51、10.54）。
 * 門檻是 TEST_PLAN／DESIGN-AI-FUN 的建議值或「量到的區間」，沒有為了讓它過而調整。
 * 完整的數字（場數更多、三個種子區塊）在 `docs/cards/H-8.md`；這裡的場數少一些，是為了 `npm run check` 跑得動。
 */

const seeds = (n: number, from = 0): number[] => Array.from({ length: n }, (_v, i) => from + i);
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const vsL10 = (player: () => Controller<H8State>, n: number, from = 0): number => {
  let points = 0;
  for (const seed of seeds(n, from)) {
    points += playAs(player(), levelController(h8Game, pathfinder, 10, seed + 1), seed);
  }
  return points / n;
};

describe('H-8 加倍或歸零｜局長（沒有任何契約測試在守局長，所以這裡守；四個情境）', () => {
  const scenarios: [string, (seed: number) => [Controller<H8State>, Controller<H8State>]][] = [
    [
      '等級 10 對等級 10',
      (s) => [
        levelController(h8Game, pathfinder, 10, s * 2 + 1),
        levelController(h8Game, pathfinder, 10, s * 2 + 2),
      ],
    ],
    [
      '人類模型對等級 10',
      (s) => [humanModel(h8Game, s * 2 + 1), levelController(h8Game, pathfinder, 10, s * 2 + 2)],
    ],
    [
      '人類模型對等級 2（新手情境）',
      (s) => [humanModel(h8Game, s * 2 + 1), levelController(h8Game, pathfinder, 2, s * 2 + 2)],
    ],
    [
      '人類模型對等級 1',
      (s) => [humanModel(h8Game, s * 2 + 1), levelController(h8Game, pathfinder, 1, s * 2 + 2)],
    ],
  ];
  it.each(scenarios)(
    '%s：中位數 30 到 90 秒，第 10 百分位不少於 20 秒',
    (_name, make) => {
      const secs = seeds(30).map((seed) => {
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
    120_000,
  );
});

describe('H-8 加倍或歸零｜反應速度（準則 3：快而淺對慢而深，快而淺的勝率低於 90%；三個維度分開量）', () => {
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
      const n = 100;
      for (const seed of seeds(n)) {
        const f = wrapPolicy(h8Game, pathfinder, fast, seed + 1);
        const s = wrapPolicy(h8Game, pathfinder, slow, seed + 2);
        points += playAs(f, s, seed);
      }
      expect(points / n).toBeLessThan(0.9);
    },
    300_000,
  );

  it('只差深度（6 對 1）：深的一方贏（等級的差別主要在深度，而不是反應速度）', () => {
    let points = 0;
    const n = 100;
    for (const seed of seeds(n)) {
      const deep = wrapPolicy(h8Game, pathfinder, { ...base, depth: 6 }, seed + 1);
      const shallow = wrapPolicy(h8Game, pathfinder, base, seed + 2);
      points += playAs(deep, shallow, seed);
    }
    expect(points / n).toBeGreaterThan(0.6);
    expect(points / n).toBeLessThan(0.95);
  }, 300_000);
});

describe('H-8 加倍或歸零｜A3、A4 的餘裕（反射門檻是兩者共用的旋鈕；樣本外種子 500..1499）', () => {
  it('A3（人類模型對等級 1 ≥ 45%）與 A4（人類模型對等級 10 ≤ 35%）在樣本外種子上同時成立', () => {
    const oos = seeds(1000, 500);
    const a3 = winRate(h8Game, humanPolicy, HUMAN_PARAMS, pathfinder, 1, oos);
    const a4 = winRate(h8Game, humanPolicy, HUMAN_PARAMS, pathfinder, 10, oos);
    expect(a3).toBeGreaterThanOrEqual(0.45);
    expect(a4).toBeLessThanOrEqual(0.35);
  }, 300_000);

  it('A1（等級 5 對 random ≥ 60%）與 A2（等級 9 對等級 2 ≥ 55%）在樣本外種子上成立', () => {
    const oos = seeds(200, 500);
    expect(winRate(h8Game, pathfinder, 5, random, 10, oos)).toBeGreaterThanOrEqual(0.6);
    expect(winRate(h8Game, pathfinder, 9, pathfinder, 2, oos)).toBeGreaterThanOrEqual(0.55);
  }, 300_000);
});

describe('H-8 加倍或歸零｜沒有支配策略（10.40：簡單劇本對等級 10 的勝率，> 90% 就是支配策略）', () => {
  it('十幾個簡單劇本（永遠爬／永遠停／爬到第 n 層停／p ≥ t 才爬）對等級 10 都低於 60%', () => {
    const scripts: [string, () => Controller<H8State>][] = [
      ['永遠爬', () => alwaysClimb],
      ['永遠停', () => alwaysStop],
      ...[0, 1, 2, 3, 4, 5, 6].map(
        (n) => [`爬到第 ${n} 層停`, () => stopAt(n)] as [string, () => Controller<H8State>],
      ),
      ...[0.3, 0.5, 0.6, 0.7, 0.8, 0.9].map(
        (t) => [`p ≥ ${t} 才爬`, () => threshold(t)] as [string, () => Controller<H8State>],
      ),
    ];
    for (const [name, make] of scripts) {
      const rate = vsL10(make, 100);
      expect(rate, name).toBeLessThan(0.6);
    }
  }, 300_000);
});

describe('H-8 加倍或歸零｜「對手怎麼爬不改變你能拿多少」（10.18 的那一題）', () => {
  /** 同一個劇本（p ≥ 0.7 才爬）面對不同的對手，每座梯子結束時自己的賭注分佈。 */
  function potDistribution(opponent: () => Controller<H8State>): number[] {
    const bins = [0, 0, 0, 0, 0, 0, 0, 0]; // 賭注 0、1、2、4、8、16、32、64
    let total = 0;
    for (const seed of seeds(150)) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const me = threshold(0.7);
      const { state } =
        side === 0 ? playFull(me, opponent(), seed) : playFull(opponent(), me, seed);
      for (const past of state.past) {
        const pot = past.pots[side];
        bins[pot === 0 ? 0 : Math.log2(pot) + 1] += 1;
        total += 1;
      }
    }
    return bins.map((b) => b / total);
  }

  it('賭注分佈與對手無關（總變差距離在抽樣誤差內）：對手只改變「拿多少分」，不改變「能拿多少」', () => {
    const dists = [
      potDistribution(() => alwaysStop),
      potDistribution(() => stopAt(2)),
      potDistribution(() => threshold(0.5)),
      potDistribution(() => levelController(h8Game, pathfinder, 10, 3)),
    ];
    for (let i = 1; i < dists.length; i += 1) {
      const tv =
        0.5 *
        (dists[i] as number[]).reduce((a, p, k) => a + Math.abs(p - (dists[0] as number[])[k]!), 0);
      expect(tv).toBeLessThan(0.08);
    }
  }, 300_000);

  it('但最好的回應隨對手而變：對永遠停的人，p ≥ 0.9 才爬勝過爬到第 6 層；對 p ≥ 0.5 就爬的人，不爬（爬到第 0 層）勝過 p ≥ 0.5 就爬', () => {
    const rate = (a: Controller<H8State>, b: () => Controller<H8State>): number => {
      let points = 0;
      for (const seed of seeds(200)) {
        points += playAs(a, b(), seed);
      }
      return points / 200;
    };
    // 對手永遠停（賭注 1）：我只要爬一層成功就贏；不爬只是平手
    expect(rate(stopAt(1), () => alwaysStop)).toBeGreaterThan(rate(stopAt(0), () => alwaysStop));
    // 對手 p ≥ 0.5 就爬（常常歸零）：不爬就贏很多
    expect(rate(stopAt(0), () => threshold(0.5))).toBeGreaterThan(0.8);
    // 對手永遠停：不爬只能平手（50%）
    expect(rate(stopAt(0), () => alwaysStop)).toBeCloseTo(0.5, 5);
  }, 300_000);
});

describe('H-8 加倍或歸零｜假訊號要付的代價（10.7）', () => {
  /** 前兩座梯子（假裝的）與後三座梯子（吃信號）自己平均每座得幾分。 */
  function earlyLate(player: () => Controller<H8State>, n: number): [number, number, number] {
    let early = 0;
    let late = 0;
    let nEarly = 0;
    let nLate = 0;
    let wins = 0;
    for (const seed of seeds(n)) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const ai = levelController(h8Game, pathfinder, 10, seed + 1);
      const { state } = side === 0 ? playFull(player(), ai, seed) : playFull(ai, player(), seed);
      wins += state.winner === null ? 0.5 : state.winner === side ? 1 : 0;
      state.past.forEach((p, i) => {
        if (i < 2) {
          early += pointsOf(p, side);
          nEarly += 1;
        } else {
          late += pointsOf(p, side);
          nLate += 1;
        }
      });
    }
    return [early / nEarly, late / nLate, wins / n];
  }

  it('假好梯子（q ≤ 0 的梯子連爬到第 4 層）：假裝的那幾座賠得多，後面幾座沒有賺回來', () => {
    const base = threshold(0.7);
    const [honestEarly, honestLate] = earlyLate(() => base, 200);
    const [fakeEarly, fakeLate] = earlyLate(() => bluffGood(base, 2, 4), 200);
    expect(fakeEarly - honestEarly).toBeLessThan(-0.1);
    expect(fakeLate - honestLate).toBeLessThan(0.1);
  }, 300_000);

  it('假爛梯子（q ≥ 0.1 的梯子爬一層就停）：假裝的那幾座沒有明顯賠，後面幾座也沒有賺到', () => {
    const base = threshold(0.7);
    const [honestEarly, honestLate] = earlyLate(() => base, 200);
    const [fakeEarly, fakeLate] = earlyLate(() => bluffBad(base, 2, 1), 200);
    expect(Math.abs(fakeEarly - honestEarly)).toBeLessThan(0.15);
    expect(fakeLate - honestLate).toBeLessThan(0.1);
  }, 300_000);
});

describe('H-8 加倍或歸零｜信念改變選擇（10.13 的 (d)；H-7 的對應數字是 28.0%、每場 3.4 個局面）', () => {
  /** 等級 10 對人類模型的真實對局裡，AI（0 號邊）每個決定起點的局面（兩邊都還在爬的）。 */
  function collect(n: number): H8State[] {
    const states: H8State[] = [];
    for (const seed of seeds(n)) {
      const ai = levelController(h8Game, pathfinder, 10, seed * 2 + 1);
      const human = humanModel(h8Game, seed * 2 + 2);
      let s = h8Game.init(seed, CONFIG);
      let t = 0;
      while (!s.over && t < CONFIG.maxTicks) {
        if (
          s.phase === 'choose' &&
          s.idle === 0 &&
          s.status[0] === 'active' &&
          s.status[1] === 'active'
        ) {
          states.push(s);
        }
        s = h8Game.step(s, [ai.decide(s, 0, t), human.decide(s, 1, t)]);
        t += 1;
      }
    }
    return states;
  }
  const decide = (state: H8State): boolean =>
    wrapPolicy(
      h8Game,
      pathfinder,
      { reactionTicks: 0, decideEvery: 1, depth: 6, epsilon: 0 },
      7,
    ).decide(state, 0, 0).a;
  const profile = (k: number): H8Past => ({
    q: [0, 0],
    pots: [2 ** k, 2 ** k],
    log: [
      ...Array.from({ length: k }, (_v, i) => ({
        level: i,
        acts: [CLIMB, CLIMB] as const,
        ok: [true, true] as const,
      })),
      { level: k, acts: [CLIMB, STOP] as const, ok: [true, null] as const },
    ],
  });

  it('把對手過去的紀錄換成空白：有過去的局面裡，AI 的決定在三成以上改變；改變的決定裡多半（九成）損失 0.05 分以上', () => {
    const states = collect(30);
    const withPast = states.filter((s) => s.past.length > 0);
    let changed = 0;
    let costly = 0;
    for (const s of withPast) {
      if (decide(s) !== decide({ ...s, past: [] })) {
        changed += 1;
        const gap = Math.abs(ladderValue(s, 0, CLIMB, true) - ladderValue(s, 0, STOP, true));
        if (gap >= 0.05) {
          costly += 1;
        }
      }
    }
    expect(withPast.length).toBeGreaterThan(100);
    expect(changed / withPast.length).toBeGreaterThan(0.3);
    expect(costly / changed).toBeGreaterThan(0.8);
  }, 300_000);

  it('對手的過去換成五種「爬到第 k 層才停」的人：在九成以上的局面，AI 的決定不全相同', () => {
    const states = collect(20);
    let differs = 0;
    for (const s of states) {
      const ds = [1, 2, 3, 4, 5].map((k) =>
        decide({ ...s, past: [profile(k), profile(k), profile(k)] }),
      );
      if (ds.some((d) => d !== ds[0])) {
        differs += 1;
      }
    }
    expect(differs / states.length).toBeGreaterThan(0.9);
  }, 300_000);

  it('這座梯子裡對手的公開紀錄沒有資訊：兩邊都還在爬，就代表對手爬過了每一層而且都成功（紀錄只有一種可能）', () => {
    for (const s of collect(10)) {
      for (const entry of s.log) {
        expect(entry.acts).toEqual([CLIMB, CLIMB]);
        expect(entry.ok).toEqual([true, true]);
      }
    }
  });
});

describe('H-8 加倍或歸零｜互動強度（探針 A 三層，10.35；真實規則、真實 AI；定義在 players.test-helpers.ts，量之前固定）', () => {
  it('(a) 不知道有對手、(b) 知道但不讀它的狀態、(c) 讀它的狀態，對等級 10 的勝率；(c) 接近 50%，(b) 很低', () => {
    const n = 200;
    const a = vsL10(() => planAlone, n);
    const b = vsL10(() => planKnowing, n);
    const bStatus = vsL10(() => planKnowingStatus, n);
    const c = vsL10(() => planReading, n);
    expect(c).toBeGreaterThan(0.4);
    expect(c).toBeLessThan(0.6);
    expect(c - b).toBeGreaterThan(0.2);
    expect(c - bStatus).toBeGreaterThan(0.1);
    expect(b).toBeLessThan(a + 0.1);
  }, 300_000);
});

describe('H-8 加倍或歸零｜四個性格的指紋（機制：同一個 p 下爬不爬，10.48）', () => {
  interface Decision {
    readonly p: number;
    readonly climbed: boolean;
    readonly behind: boolean;
  }
  function decisions(policy: Policy, n: number): Decision[] {
    const out: Decision[] = [];
    for (const seed of seeds(n)) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const mine = levelController(h8Game, policy, 10, seed + 7);
      const other = levelController(h8Game, pathfinder, 10, seed + 9);
      let s = h8Game.init(seed, CONFIG);
      let t = 0;
      while (!s.over && t < CONFIG.maxTicks) {
        const next = h8Game.step(
          s,
          side === 0
            ? [mine.decide(s, 0, t), other.decide(s, 1, t)]
            : [other.decide(s, 0, t), mine.decide(s, 1, t)],
        );
        if (s.pending[side] === null && next.pending[side] !== null) {
          out.push({
            p: successProb(s.level[side], s.q[side]),
            climbed: next.pending[side] === CLIMB,
            behind: s.scores[side] < s.scores[side === 0 ? 1 : 0],
          });
        }
        s = next;
        t += 1;
      }
    }
    return out;
  }
  const rate = (ds: Decision[], pick: (d: Decision) => boolean): number => {
    const xs = ds.filter(pick);
    return xs.filter((d) => d.climbed).length / Math.max(1, xs.length);
  };

  it('精準型：p < 0.75 從不爬；貪心型：p ≥ 0.65 全爬、p < 0.65 全停；賭徒型：落後時 p 低也爬、領先或平手時像貪心型', () => {
    const pr = decisions(precise, 40);
    const gr = decisions(greedy, 40);
    const ga = decisions(gambler, 40);
    expect(rate(pr, (d) => d.p < 0.7)).toBe(0);
    expect(rate(pr, (d) => d.p >= 0.7)).toBe(1);
    expect(rate(gr, (d) => d.p >= 0.6)).toBe(1);
    expect(rate(gr, (d) => d.p < 0.6)).toBe(0);
    expect(rate(ga, (d) => d.p < 0.6 && d.behind)).toBeGreaterThan(0.9);
    expect(rate(ga, (d) => d.p < 0.6 && !d.behind)).toBe(0);
    expect(rate(ga, (d) => d.p >= 0.6)).toBe(1);
  }, 300_000);

  it('搜尋型（等級 10）不是門檻：同樣的 p 有時爬、有時停（讀對手）；精準型與貪心型是門檻', () => {
    const pf = decisions(pathfinder, 40);
    const mid = rate(pf, (d) => d.p > 0.6 && d.p < 0.7);
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.95);
  }, 300_000);
});

describe('H-8 加倍或歸零｜AI 比亂按強（對照 A1 的另一組種子）', () => {
  it('等級 5 的搜尋型對 random 贏過七成（座位輪流）', () => {
    let points = 0;
    const n = 60;
    for (const seed of seeds(n, 300)) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const ai = levelController(h8Game, pathfinder, 5, seed + 1);
      const rnd = levelController(h8Game, random, 10, seed + 2);
      const r =
        side === 0
          ? playMatch(h8Game, seed, CONFIG, ai, rnd)
          : playMatch(h8Game, seed, CONFIG, rnd, ai);
      points += r.winner === null ? 0.5 : r.winner === side ? 1 : 0;
    }
    expect(points / n).toBeGreaterThan(0.7);
  }, 300_000);
});
