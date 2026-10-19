import { describe, expect, it } from 'vitest';

import { humanModel } from '../../ai/human-model';
import { levelController, wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { playMatch } from '../../core/match';
import type { Controller, Side } from '../../core/types';
import type { Policy } from '../../ai/types';
import { MOVE_BUTTONS, RED, h7Game, predictOpp } from './logic';
import type { H7State } from './logic';
import {
  CONFIG,
  playAs,
  playFull,
  planAloneWith,
  planKnowingWith,
  planReadingWith,
} from './players.test-helpers';

/**
 * H-7 的量測型測試（DESIGN-AI-FUN 10.29 到 10.35、10.48、10.51；小規格「量測結果」）。
 * 門檻是 TEST_PLAN／DESIGN-AI-FUN 的建議值或「量到的區間」，沒有為了讓它過而調整。
 * 完整的數字（場數更多）在 `docs/cards/H-7.md`；這裡的場數少一些，是為了 `npm run check` 跑得動。
 */

const seeds = (n: number, from = 0): number[] => Array.from({ length: n }, (_v, i) => from + i);
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);

describe('H-7 血換分｜局長（沒有任何契約測試在守局長，所以這裡守）', () => {
  const scenarios: [string, (seed: number) => [Controller<H7State>, Controller<H7State>]][] = [
    [
      '等級 10 對等級 10',
      (s) => [
        levelController(h7Game, pathfinder, 10, s * 2 + 1),
        levelController(h7Game, pathfinder, 10, s * 2 + 2),
      ],
    ],
    [
      '人類模型對等級 2（新手情境）',
      (s) => [humanModel(h7Game, s * 2 + 1), levelController(h7Game, pathfinder, 2, s * 2 + 2)],
    ],
    [
      '人類模型對等級 10',
      (s) => [humanModel(h7Game, s * 2 + 1), levelController(h7Game, pathfinder, 10, s * 2 + 2)],
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

describe('H-7 血換分｜反應速度（準則 3：快而淺對慢而深，快而淺的勝率低於 90%；三個維度分開量）', () => {
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
        const side: Side = seed % 2 === 0 ? 0 : 1;
        const f = wrapPolicy(h7Game, pathfinder, fast, seed + 1);
        const s = wrapPolicy(h7Game, pathfinder, slow, seed + 2);
        const r =
          side === 0
            ? playMatch(h7Game, seed, CONFIG, f, s)
            : playMatch(h7Game, seed, CONFIG, s, f);
        points += r.winner === null ? 0.5 : r.winner === side ? 1 : 0;
      }
      expect(points / n).toBeLessThan(0.9);
    },
    300_000,
  );

  it('只差深度（6 對 1）：深的一方贏（等級的差別主要在深度，而不是反應速度）', () => {
    let points = 0;
    const n = 100;
    for (const seed of seeds(n)) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const deep = wrapPolicy(h7Game, pathfinder, { ...base, depth: 6 }, seed + 1);
      const shallow = wrapPolicy(h7Game, pathfinder, base, seed + 2);
      const r =
        side === 0
          ? playMatch(h7Game, seed, CONFIG, deep, shallow)
          : playMatch(h7Game, seed, CONFIG, shallow, deep);
      points += r.winner === null ? 0.5 : r.winner === side ? 1 : 0;
    }
    expect(points / n).toBeGreaterThan(0.6);
    expect(points / n).toBeLessThan(0.95);
  }, 300_000);
});

describe('H-7 血換分｜四個性格的指紋（機制：選到 danger ≥ 0.5 的決定占比，10.48）', () => {
  /** 每個回合：這個人搶了紅球、而且血不夠付血價（這就是 danger 0.6 的那個動作）的占比。 */
  function riskyShare(policy: Policy): number {
    let decisions = 0;
    let risky = 0;
    for (const seed of seeds(50)) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const a = levelController(h7Game, policy, 10, seed + 7);
      const b = levelController(h7Game, pathfinder, 10, seed + 9);
      const { state } = side === 0 ? playFull(a, b, seed) : playFull(b, a, seed);
      for (const r of state.history) {
        decisions += 1;
        if (r.picks[side] === RED && r.hp[side] <= r.orb[1]) {
          risky += 1;
        }
      }
    }
    return risky / decisions;
  }

  it('賭徒型 > 貪心型 > 搜尋型 ≥ 精準型；精準型從不冒會昏倒的險', () => {
    const g = riskyShare(gambler);
    const gr = riskyShare(greedy);
    const p = riskyShare(pathfinder);
    const pr = riskyShare(precise);
    expect(g).toBeGreaterThan(1.3 * gr);
    expect(gr).toBeGreaterThan(3 * p);
    expect(p).toBeGreaterThanOrEqual(pr);
    expect(pr).toBe(0);
  }, 300_000);
});

describe('H-7 血換分｜小規格的預測要驗：深度 ≥ 3 的 AI 會避開撞球或故意封鎖，信念真的改變選擇', () => {
  /** 人類模型對等級 10 的真實對局裡，每個回合 choose 起點的局面。 */
  function collect(n: number): H7State[] {
    const states: H7State[] = [];
    for (const seed of seeds(n)) {
      const a = humanModel(h7Game, seed * 2 + 1);
      const b = levelController(h7Game, pathfinder, 10, seed * 2 + 2);
      let s = h7Game.init(seed, CONFIG);
      let t = 0;
      let lastRound = -1;
      while (!s.over) {
        if (
          s.phase === 'choose' &&
          s.pending[0] === null &&
          s.pending[1] === null &&
          s.round !== lastRound
        ) {
          states.push(s);
          lastRound = s.round;
        }
        s = h7Game.step(s, [a.decide(s, 0, t), b.decide(s, 1, t)]);
        t += 1;
      }
    }
    return states;
  }
  const decide = (state: H7State, depth: number, side: Side): number => {
    const c = wrapPolicy(
      h7Game,
      pathfinder,
      { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
      7,
    );
    const button = c.decide(state, side, 0);
    return MOVE_BUTTONS.findIndex((m) => JSON.stringify(m) === JSON.stringify(button));
  };

  it('深度 6 與深度 1 的決定在一成以上的局面不同；不同的決定裡「避開預測的球」與「搶預測的球（封鎖）」都有（實測各約 340、350 次 / 2880）', () => {
    const states = collect(40);
    let changed = 0;
    let avoid = 0;
    let block = 0;
    let total = 0;
    for (const s of states) {
      for (const side of [0, 1] as const) {
        const q = predictOpp(s, side);
        const top = q.indexOf(Math.max(...q));
        const d1 = decide(s, 1, side);
        const d6 = decide(s, 6, side);
        total += 1;
        if (d1 !== d6) {
          changed += 1;
          if (d1 === top && d6 !== top) {
            avoid += 1;
          } else if (d6 === top && d1 !== top) {
            block += 1;
          }
        }
      }
    }
    expect(changed / total).toBeGreaterThan(0.1);
    expect(avoid).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(0);
  }, 300_000);

  it('信念改變選擇：把對手的血量換成相反的，深度 6 的選擇在一成五以上的局面改變；把歷史關掉改變一些局面', () => {
    const states = collect(40);
    let hpChanged = 0;
    let total = 0;
    let histChanged = 0;
    let histEligible = 0;
    for (const s of states) {
      for (const side of [0, 1] as const) {
        const base = decide(s, 6, side);
        total += 1;
        const o = side === 0 ? 1 : 0;
        const hp: [number, number] = [s.hp[0], s.hp[1]];
        hp[o] = s.hp[o] <= 3 ? 6 : 1;
        if (decide({ ...s, hp }, 6, side) !== base) {
          hpChanged += 1;
        }
        if (s.history.length > 0) {
          histEligible += 1;
          if (decide({ ...s, model: false }, 6, side) !== base) {
            histChanged += 1;
          }
        }
      }
    }
    expect(hpChanged / total).toBeGreaterThan(0.15);
    expect(histChanged / histEligible).toBeGreaterThan(0.02);
  }, 300_000);
});

describe('H-7 血換分｜互動強度（探針 A 三層，10.35；真實規則、真實 AI）', () => {
  it('(c) − (b)：讀 AI 的狀態沒有大幅幫助也沒有大幅傷害（量到的區間；數字與讀法見小規格）', () => {
    const n = 100;
    const prior = [0.006, 0.072, 0.618, 0.303];
    const rate = (player: Controller<H7State>): number => {
      let points = 0;
      for (const seed of seeds(n)) {
        points += playAs(player, levelController(h7Game, pathfinder, 10, seed + 5), seed);
      }
      return points / n;
    };
    const a = rate(planAloneWith(false));
    const b = rate(planKnowingWith(prior, false));
    const c = rate(planReadingWith(false));
    expect(a).toBeGreaterThan(0.3);
    expect(b).toBeGreaterThan(0.3);
    expect(c - b).toBeGreaterThan(-0.2);
    expect(c - b).toBeLessThan(0.2);
  }, 300_000);
});
