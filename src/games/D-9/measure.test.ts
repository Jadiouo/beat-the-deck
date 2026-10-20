import { describe, expect, it } from 'vitest';

import { winRate } from '../../ai/evolution';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { GameConfig } from '../../core/types';
import { d9Game } from './logic';
import type { D9State, Round } from './logic';
import * as P from './players.test-helpers';

/**
 * D-9 的量測（小規格「實作與量測」）。真實規則、真實 AI、固定種子，所以數字是確定的；斷言寫在量到的值附近
 * （不是目標值）。場數比小規格的量測少（那邊 200 到 400 場，在 session 的 scratchpad 跑）。
 * 設 `D9_VERBOSE=1` 會把量到的數字印出來。
 */

const LONG = 3_600_000;
const report = (text: string): void => {
  if (process.env['D9_VERBOSE'] !== undefined) {
    console.log(text);
  }
};
const cfg = (params: Record<string, number>): GameConfig => ({ maxTicks: 3600, params });
const quantile = (xs: readonly number[], p: number): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)] as number;

describe('D-9 局長（四個情境；5 輪對照）', () => {
  const scenarios: readonly (readonly [string, P.Make, P.Make])[] = [
    ['L10 對 L10', P.L10, P.L10],
    ['人類模型對 L10', P.HUMAN, P.L10],
    ['人類模型對 L2', P.HUMAN, P.engine('reads', 2)],
    ['人類模型對 L1', P.HUMAN, P.engine('reads', 1)],
  ];
  it(
    '8 輪：四個情境的中位數與第 10 百分位都在 30 到 90 秒內，每一場不超過 maxTicks',
    () => {
      for (const [name, a, b] of scenarios) {
        const ticks = P.batch(a, b, P.seeds(12), cfg({ rounds: 8 })).ticks;
        const median = quantile(ticks, 0.5) / 60;
        const p10 = quantile(ticks, 0.1) / 60;
        report(
          `局長 8 輪 ${name}：中位數 ${median.toFixed(1)} 秒，第 10 百分位 ${p10.toFixed(1)} 秒`,
        );
        expect(median, name).toBeGreaterThanOrEqual(30);
        expect(median, name).toBeLessThanOrEqual(90);
        expect(p10, name).toBeGreaterThanOrEqual(30);
        expect(Math.max(...ticks), name).toBeLessThanOrEqual(3600);
      }
    },
    LONG,
  );

  it(
    '5 輪：四個情境的中位數都不到 30 秒（這是預設用 8 輪的理由，不是信念的理由）',
    () => {
      for (const [name, a, b] of scenarios) {
        const ticks = P.batch(a, b, P.seeds(12), cfg({ rounds: 5 })).ticks;
        const median = quantile(ticks, 0.5) / 60;
        report(`局長 5 輪 ${name}：中位數 ${median.toFixed(1)} 秒`);
        expect(median, name).toBeLessThan(30);
      }
    },
    LONG,
  );
});

describe('D-9 劇本玩家對等級 10（邊輪流；> 90% 才是支配策略）', () => {
  const s = P.seeds(30);
  it(
    '預設（zs = 1，算兩邊的差）：沒有任何劇本超過 10%；最肥、存量最大、先挑沒人的都是一場場平手（50%）；知道原理的上限（算出 AI 挑哪個再回應）也只能平手',
    () => {
      const run = (name: string, make: P.Make): P.Batch => {
        const r = P.batch(make, P.L10, s, cfg({}));
        report(`zs=1 劇本 ${name}：${r.rate}（平手 ${r.ties}）`);
        return r;
      };
      for (const [name, plan] of [
        ['最肥', P.alwaysFattest],
        ['存量最大', P.fattestStock],
        ['先挑沒人的', P.emptyFirst],
        ['上限(d)', P.oracleBest],
        ['不知道有對手(a)', P.planAlone],
      ] as const) {
        const r = run(name, P.S(plan));
        expect(r.rate, name).toBe(0.5);
        expect(r.ties, name).toBe(s.length);
      }
      for (const [name, plan] of [
        ['第二肥', P.alwaysSecond],
        ['第三肥', P.alwaysThird],
        ['均勻亂選', P.uniformLive],
        ['都不擺', P.alwaysPass],
        ['養習慣前 3 輪最肥再第二肥', P.habitThenSecond(3)],
        ['前 3 輪第二肥再最肥', P.secondThenFattest(3)],
        ['跟風', P.copyLast],
        ['(b) 固定先驗', P.planKnowing],
        ['(c) 讀頻率', P.planReading],
      ] as const) {
        expect(run(name, P.S(plan)).rate, name).toBeLessThanOrEqual(0.3);
      }
    },
    LONG,
  );

  it(
    '小規格原文（zs = 0，只算自己的期望收成）：「一直挑最肥」贏 100%（支配策略）；養習慣再挑第二肥只能平手；讀它的 (c) 輸給不讀的 (a)',
    () => {
      const z = cfg({ zs: 0 });
      const rate = (plan: P.Plan): number => P.batch(P.S(plan), P.L10, s, z).rate;
      const fattest = rate(P.alwaysFattest);
      const feint = rate(P.habitThenSecond(3));
      const a = rate(P.planAlone);
      const b = rate(P.planKnowing);
      const c = rate(P.planReading);
      report(`zs=0：最肥 ${fattest}；養習慣再第二肥 ${feint}；(a) ${a} (b) ${b} (c) ${c}`);
      expect(fattest).toBeGreaterThanOrEqual(0.9);
      expect(feint).toBeLessThanOrEqual(0.5);
      expect(fattest - feint).toBeGreaterThanOrEqual(0.4);
      expect(a).toBeGreaterThanOrEqual(0.9);
      expect(c).toBeLessThan(b);
      expect(b).toBeLessThan(a);
    },
    LONG,
  );
});

describe('D-9 探針 A（三組同一條決策規則，只差怎麼想對手；定義在 players.test-helpers.ts 檔頭）', () => {
  it(
    '預設：(a) 不知道有對手 50%（一場場平手）、(b) 知道有對手但不讀 0%、(c) 讀它 0%、(d) 上限 50%：(c) − (b) = 0，而且 (b) 與 (c) 都輸給 (a)——躲開它反而吃虧',
    () => {
      const s = P.seeds(60);
      const rate = (plan: P.Plan): number => P.batch(P.S(plan), P.L10, s, cfg({})).rate;
      const [a, b, c, d] = [P.planAlone, P.planKnowing, P.planReading, P.oracleBest].map(rate) as [
        number,
        number,
        number,
        number,
      ];
      report(`探針 A（zs=1）：(a) ${a} (b) ${b} (c) ${c} (d) ${d}`);
      expect(a).toBe(0.5);
      expect(b).toBe(0);
      expect(c).toBe(0);
      expect(c - b).toBe(0);
      expect(d).toBe(0.5);
    },
    LONG,
  );
});

describe('D-9 AI 的信念真的改變選擇嗎（5 輪與 8 輪；10.19 的判準 ≥ 6／場）', () => {
  /** 真實對局裡 AI（1 號邊）每一輪擺放開始時的局面。 */
  function collect(opp: P.Make, params: Record<string, number>, n: number): D9State[][] {
    const games: D9State[][] = [];
    for (const seed of P.seeds(n)) {
      const ai = P.L10(seed + 5);
      const o = opp(seed);
      let s = d9Game.init(seed, cfg(params));
      const samples: D9State[] = [];
      let t = 0;
      while (!s.over) {
        if (s.phase === 'place' && s.idle === 0 && s.pending[1] === null) {
          samples.push(s);
        }
        s = d9Game.step(s, [P.copyButtons(o.decide(s, 0, t)), P.copyButtons(ai.decide(s, 1, t))]);
        t += 1;
      }
      games.push(samples);
    }
    return games;
  }
  /** 把對手歷史裡「挑名次 1」與「挑別的名次」對調。 */
  const swapped = (history: readonly Round[]): Round[] =>
    history.map((r) => ({
      ...r,
      ranks: [
        r.ranks[0] === 1 ? 2 : r.ranks[0] >= 1 ? 1 : 0,
        r.ranks[1] === 1 ? 2 : r.ranks[1] >= 1 ? 1 : 0,
      ] as [number, number],
    }));
  /** 每場有幾個局面，把對手的歷史清空或對調之後 AI 擺的礦脈不一樣。 */
  function changedPerGame(params: Record<string, number>, opp: P.Make, n: number): number {
    const games = collect(opp, params, n);
    let changed = 0;
    for (const g of games) {
      for (const s of g) {
        const base = P.aiChoice(s);
        const cleared = P.aiChoice({ ...s, history: [] }) !== base;
        const swap =
          s.history.length > 0 && P.aiChoice({ ...s, history: swapped(s.history) }) !== base;
        if (cleared || swap) {
          changed += 1;
        }
      }
    }
    return changed / games.length;
  }

  it(
    '預設（zs = 1）：對人類模型，5 輪與 8 輪都是每場不到 1 個局面（遠低於 6）',
    () => {
      const five = changedPerGame({ rounds: 5 }, P.HUMAN, 15);
      const eight = changedPerGame({ rounds: 8 }, P.HUMAN, 15);
      report(`信念改變選擇（zs=1，人類模型）：5 輪 ${five}/場；8 輪 ${eight}/場`);
      expect(five).toBeLessThan(1);
      expect(eight).toBeLessThan(1);
    },
    LONG,
  );

  it(
    '小規格原文（zs = 0）：8 輪每場改變的局面約為 5 輪的 2 到 4 倍，但 8 輪也不到 6（約 4）——10.19 的改法達不到判準',
    () => {
      const five = changedPerGame({ rounds: 5, zs: 0 }, P.HUMAN, 15);
      const eight = changedPerGame({ rounds: 8, zs: 0 }, P.HUMAN, 15);
      report(`信念改變選擇（zs=0，人類模型）：5 輪 ${five}/場；8 輪 ${eight}/場`);
      expect(eight).toBeGreaterThan(2 * five);
      expect(eight).toBeLessThan(6);
      expect(eight).toBeGreaterThan(2.5);
    },
    LONG,
  );
});

describe('D-9 性格指紋、等級曲線、反應速度', () => {
  it(
    '精準型、貪心型、賭徒型在這張牌上選一模一樣的礦脈（danger 只有「只剩 1 個空位」的礦脈才非 0，幾乎碰不到），搜尋型不一樣（常不擺）：小規格的性格表被推翻',
    () => {
      const seeds = P.seeds(20);
      const stats = (kind: P.PolicyKind): { rank: number; passes: number; voids: number } => {
        let rank = 0;
        let picks = 0;
        let passes = 0;
        let voids = 0;
        for (const seed of seeds) {
          const side = (seed % 2) as 0 | 1;
          const a2 = P.engine('reads', 10, kind)(seed + 7);
          const b2 = P.L10(seed + 9);
          let s = d9Game.init(seed, cfg({}));
          let t = 0;
          while (!s.over) {
            const ka = a2.decide(s, side, t);
            const kb = b2.decide(s, side === 0 ? 1 : 0, t);
            s = d9Game.step(s, side === 0 ? [ka, kb] : [kb, ka]);
            t += 1;
          }
          for (const h of s.history) {
            if (h.picks[side] < 0) {
              passes += 1;
            } else {
              picks += 1;
              rank += h.ranks[side];
              voids += h.voided[side] ? 1 : 0;
            }
          }
        }
        return { rank: rank / picks, passes: passes / seeds.length, voids: voids / seeds.length };
      };
      const p = stats('precise');
      const g = stats('greedy');
      const gb = stats('gambler');
      const pf = stats('pathfinder');
      report(
        `指紋：precise ${JSON.stringify(p)} greedy ${JSON.stringify(g)} gambler ${JSON.stringify(gb)} pathfinder ${JSON.stringify(pf)}`,
      );
      expect(g).toEqual(p);
      expect(Math.abs(gb.rank - p.rank)).toBeLessThan(0.1);
      expect(p.voids).toBe(0);
      expect(pf.passes).toBeGreaterThan(1);
      expect(pf.rank).toBeGreaterThan(p.rank + 1);
    },
    LONG,
  );

  it(
    '等級曲線單調：精準型等級 1 到 9 對等級 10 的勝率不下降（容許 0.05 的雜訊），等級 1 接近 0%、等級 9 超過三成',
    () => {
      const s = P.seeds(40);
      const rates = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
        (lv) => P.batch(P.engine('reads', lv), P.L10, s).rate,
      );
      report(`等級曲線（對 L10）：${rates.join('、')}`);
      for (let i = 1; i < rates.length; i += 1) {
        expect(rates[i] as number).toBeGreaterThanOrEqual((rates[i - 1] as number) - 0.05);
      }
      expect(rates[0] as number).toBeLessThanOrEqual(0.05);
      expect(rates[8] as number).toBeGreaterThan(0.3);
    },
    LONG,
  );

  it(
    '反應速度四格：精準型只差反應、只差頻率、只差深度、合併，全是 50%（不是反應競速，深度也沒有用）；搜尋型只差深度 0%（danger 的尺度，見小規格）',
    () => {
      const s = P.seeds(30);
      const L = (reaction: number, every: number, depth: number) => ({
        reactionTicks: reaction,
        decideEvery: every,
        depth,
        epsilon: 0,
      });
      const rate = (
        policy: typeof precise,
        a: ReturnType<typeof L>,
        b: ReturnType<typeof L>,
      ): number => winRate(d9Game, policy, a, policy, b, s);
      expect(rate(precise, L(3, 1, 1), L(18, 12, 6))).toBe(0.5);
      expect(rate(precise, L(3, 1, 1), L(18, 1, 1))).toBe(0.5);
      expect(rate(precise, L(12, 1, 1), L(12, 12, 1))).toBe(0.5);
      expect(rate(precise, L(12, 1, 6), L(12, 1, 1))).toBe(0.5);
      expect(rate(pathfinder, L(12, 1, 6), L(12, 1, 1))).toBeLessThanOrEqual(0.1);
    },
    LONG,
  );
});
