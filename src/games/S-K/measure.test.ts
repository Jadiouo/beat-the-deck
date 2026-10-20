import { describe, expect, it } from 'vitest';

import { levelController, wrapPolicy } from '../../ai/level';
import { HUMAN_PARAMS } from '../../ai/human-model';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import { copyButtons, playMatch } from '../../core/match';
import type { Buttons, Controller, Side } from '../../core/types';
import { skGame } from './logic';
import type { SKState } from './logic';
import { FINAL, POOL, poolEntry, sigmaLabel } from './pool';
import {
  CONFIG,
  CONTRACT_MAX_TICKS,
  NEUTRAL,
  ai,
  humanModel,
  level,
  marginTable,
  mean,
  playOne,
  playSeated,
  quantile,
  ruleFirst,
  ruleOwnBestFamily,
  ruleRisky,
  ruleStable,
  ruleTable,
  scripted,
  strongHuman,
  winPercent,
} from './players.test-helpers';
import type { MakeController } from './players.test-helpers';

/**
 * S-K 的量測（小規格「實作與量測」）：標度、局長、劇本玩家與支配策略、探針 A、放水、反應速度、性格指紋。
 * 都是真實規則、真實 AI、固定種子，所以數字是確定的。`SK_N`（預設 1）乘上每一項的場數，
 * 小規格的數字是用 `SK_N=4` 跑的；`SK_VERBOSE=1` 把量到的數字印出來。
 *
 * 這張牌是變化牌（DESIGN-AI-FUN 10.27）：選牌層沒有自己的 AI 互動，所以探針 A 接近零是預期結果，
 * 這裡的斷言只釘住「量法」與「沒有支配策略」，不宣稱互動強度。
 */

const N = Math.max(1, Number(process.env.SK_N ?? '1'));
const LONG = 7_200_000;
const seeds = (n: number, from = 0): number[] => Array.from({ length: n }, (_v, i) => from + i);

function report(text: string): void {
  if (process.env.SK_VERBOSE !== undefined) {
    console.log(text);
  }
}

const strong: MakeController = (seed) => strongHuman(seed);

// ---------------------------------------------------------------------------
// 標度（小規格：人類模型對等級 5 精準型各 100 場，取 |分數差| 的第 80 百分位）
// ---------------------------------------------------------------------------

describe('S-K 標度｜每張牌的 scale 是量出來的，不是為了讓 A3、A4 過而調的', () => {
  it(
    '人類模型對等級 5 精準型各 100 場（種子 0..99、衝刺長度）：|分數差| 的第 80 百分位四捨五入 ＝ pool.ts 的 scale（S-5 最低取 2）',
    () => {
      const rows: string[] = [];
      for (const card of [...POOL, FINAL]) {
        const diffs: number[] = [];
        for (const seed of seeds(100)) {
          const side: Side = seed % 2 === 0 ? 0 : 1;
          const a = wrapPolicy(card.game, pathfinder, HUMAN_PARAMS, seed);
          const b = levelController(card.game, precise, 5, seed + 1_000_003);
          const config = { maxTicks: card.sprintTicks, params: card.params ?? {} };
          const r =
            side === 0
              ? playMatch(card.game, seed, config, a, b)
              : playMatch(card.game, seed, config, b, a);
          diffs.push(Math.abs((r.score[0] as number) - (r.score[1] as number)));
        }
        const p80 = quantile(diffs, 0.8);
        rows.push(`${card.id} p50 ${quantile(diffs, 0.5)}、p80 ${p80}、最大 ${quantile(diffs, 1)}`);
        const expected = card.id === FINAL.id ? Math.max(2, Math.round(p80)) : Math.round(p80);
        expect(card.scale, card.id).toBe(expected);
      }
      report(`標度：${rows.join('；')}`);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 局長（四個情境，各報中位數與第 10 百分位；目標 30 到 90 秒）
// ---------------------------------------------------------------------------

describe('S-K 局長｜整場多長（秒；maxTicks 5400）', () => {
  function lengths(first: MakeController, second: MakeController, count: number): number[] {
    return seeds(count).map((seed) => {
      const played = seed % 2 === 0 ? playOne(seed, first, second) : playOne(seed, second, first);
      return played.ticks / 60;
    });
  }

  it(
    '四個情境：等級 10 對等級 10、人類模型對等級 10、人類模型對等級 2、人類模型對等級 1，中位數都在 30 到 90 秒',
    () => {
      const scenarios: [string, MakeController, MakeController][] = [
        ['等級10 對 等級10', level(10), level(10)],
        ['人類模型 對 等級10', humanModel, level(10)],
        ['人類模型 對 等級2', humanModel, level(2)],
        ['人類模型 對 等級1', humanModel, level(1)],
      ];
      for (const [name, a, b] of scenarios) {
        const secs = lengths(a, b, 16 * N);
        const median = quantile(secs, 0.5);
        const p10 = quantile(secs, 0.1);
        report(
          `局長 ${name}：中位 ${median.toFixed(1)}、p10 ${p10.toFixed(1)}、p90 ${quantile(secs, 0.9).toFixed(1)}（${secs.length} 場）`,
        );
        expect(median, name).toBeGreaterThanOrEqual(30);
        expect(median, name).toBeLessThanOrEqual(90);
        expect(p10, name).toBeGreaterThanOrEqual(30);
      }
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 劇本玩家：有沒有支配策略（DESIGN-AI-FUN 10.40：>90% 就是）
// ---------------------------------------------------------------------------

describe('S-K 劇本玩家｜打的時候都一樣（精準型、人類節奏、不亂按），只差挑牌規則；對等級 10', () => {
  it(
    '永遠選第一張、永遠選最穩、永遠選最險、永遠選「我成績最好的家族」（AI 自己的規則）、永遠選「我單打最強的那張」：都不到 90%',
    () => {
      const rival = level(10);
      // 「我單打最強的那張」：這個玩家單獨打每張牌（衝刺長度）對等級 10 的平均 m，查表挑最大。
      const table = marginTable(10, seeds(24 * N, 6000));
      report(
        `單打對等級 10 的平均 m：${POOL.map((p) => `${p.id} ${(table[p.id] as number).toFixed(2)}`).join('、')}`,
      );
      const rules: [string, MakeController][] = [
        ['永遠第一張', (seed) => scripted(strongHuman(seed), ruleFirst)],
        ['永遠最穩', (seed) => scripted(strongHuman(seed), ruleStable)],
        ['永遠最險', (seed) => scripted(strongHuman(seed), ruleRisky)],
        ['我成績最好的家族（AI 的規則）', (seed) => scripted(strongHuman(seed), ruleOwnBestFamily)],
        ['我單打最強的那張', (seed) => scripted(strongHuman(seed), ruleTable(table))],
      ];
      const wins: number[] = [];
      for (const [name, make] of rules) {
        const win = winPercent(make, rival, seeds(40 * N));
        wins.push(win);
        report(`劇本玩家 ${name}：${win.toFixed(1)}%（${40 * N} 場，對等級 10）`);
      }
      for (const win of wins) {
        expect(win).toBeLessThan(90);
      }
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 探針 A（10.20、10.24、10.35）：三組玩家只差「知道多少」，單位是勝率
// ---------------------------------------------------------------------------

describe('S-K 探針 A｜(c) − (b)：知道真正的對手有多強，對選牌有沒有用（預期接近零）', () => {
  it(
    '(a) 不知道有對手、永遠按第一張；(b) 知道有對手、用「對一個弱對手（等級 1）」量的先驗表挑牌；(c) 用「對真正的對手（等級 10）」量的表挑牌',
    () => {
      // 先固定定義再量：表用的種子（5000 起、6000 起）和評估的種子（0 起）互不重疊；
      // (b) 的先驗是「對等級 1」，是一個合理的泛用先驗（不是對手的真實強度）；
      // (c) 的表是對真正的對手量的，不是 AI 自己的引擎（沒有鏡像：兩邊的選牌規則不一樣、(c) 的打法是精準型 NO_BLUNDER，AI 是等級 10）。
      const tableB = marginTable(1, seeds(24 * N, 5000));
      const tableC = marginTable(10, seeds(24 * N, 6000));
      const rival = level(10);
      const count = 50 * N;
      const a = winPercent((seed) => scripted(strongHuman(seed), ruleFirst), rival, seeds(count));
      const b = winPercent(
        (seed) => scripted(strongHuman(seed), ruleTable(tableB)),
        rival,
        seeds(count),
      );
      const c = winPercent(
        (seed) => scripted(strongHuman(seed), ruleTable(tableC)),
        rival,
        seeds(count),
      );
      report(
        `探針 A（${count} 場）：(a) ${a.toFixed(1)}、(b) ${b.toFixed(1)}、(c) ${c.toFixed(1)}、(c)−(b) ${(c - b).toFixed(1)}、(c)−(a) ${(c - a).toFixed(1)}`,
      );
      report(
        `  表 (b)：${POOL.map((p) => `${p.id} ${(tableB[p.id] as number).toFixed(2)}`).join('、')}`,
      );
      report(
        `  表 (c)：${POOL.map((p) => `${p.id} ${(tableC[p.id] as number).toFixed(2)}`).join('、')}`,
      );
      // 選牌層沒有自己的互動：不宣稱 (c) 比 (b) 好，只釘住量到的東西是有限的數。
      for (const v of [a, b, c]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 放水（10.7：信號就是得分，放水要真的輸掉一段）
// ---------------------------------------------------------------------------

describe('S-K 放水｜故意輸掉第一段，換 AI 後來挑錯家族，划不划算', () => {
  function sandbag(inner: Controller<SKState>, segs: readonly number[]): Controller<SKState> {
    return {
      decide(state: SKState, side: Side, tick: number): Buttons {
        const pressed = inner.decide(state, side, tick);
        return state.phase === 'play' && segs.includes(state.seg) ? { ...NEUTRAL } : pressed;
      },
    };
  }

  it(
    '放水（第一段不玩）對誠實（同一個劇本玩家）：期望分差（600 分制）與勝率差；AI 後來挑到同家族的比例',
    () => {
      const tableC = marginTable(10, seeds(24 * N, 6000));
      const honest: MakeController = (seed) => scripted(strongHuman(seed), ruleTable(tableC));
      const sandbagged: MakeController = (seed) =>
        sandbag(scripted(strongHuman(seed), ruleTable(tableC)), [0]);
      const rival = level(10);
      const count = 60 * N;
      const stats = (
        make: MakeController,
      ): { diff: number; win: number; same: number; picks: number } => {
        const diffs: number[] = [];
        let points = 0;
        let same = 0;
        let picks = 0;
        for (const seed of seeds(count)) {
          const r = playSeated(seed, make, rival);
          diffs.push(r.scoreDiff);
          points += r.points;
          const aiSide: Side = r.side === 0 ? 1 : 0;
          const ledger = r.played.final.ledger;
          const family = ledger[0]?.family;
          for (let i = 1; i < 4; i += 1) {
            if (ledger[i]?.picker === aiSide) {
              picks += 1;
              if (ledger[i]?.family === family) {
                same += 1;
              }
            }
          }
        }
        return { diff: mean(diffs), win: (100 * points) / count, same, picks };
      };
      const h = stats(honest);
      const s = stats(sandbagged);
      report(
        `放水（${count} 場，對等級 10，分數是 600 分制）：誠實 平均分差 ${h.diff.toFixed(1)}、勝率 ${h.win.toFixed(1)}、AI 後來挑到第一段同家族 ${h.same}/${h.picks}；放水 平均分差 ${s.diff.toFixed(1)}、勝率 ${s.win.toFixed(1)}、同家族 ${s.same}/${s.picks}；期望分差（放水 − 誠實）${(s.diff - h.diff).toFixed(1)}、勝率差 ${(s.win - h.win).toFixed(1)}`,
      );
      // 不宣稱放水可行：期望分差必須不是正的（要是正的，這條會紅，提醒回頭改小規格的說法）。
      expect(s.diff - h.diff).toBeLessThanOrEqual(0);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 反應速度（10.51 的四格）
// ---------------------------------------------------------------------------

describe('S-K 反應速度｜合併值與三個維度分開（快的一方勝率，精準型）', () => {
  const base = { reactionTicks: 12, decideEvery: 1, depth: 1, epsilon: 0 };
  const fastShare = (fast: typeof base, slow: typeof base, count: number): number =>
    winPercent(
      (seed) => wrapPolicy(skGame, precise, fast, seed),
      (seed) => wrapPolicy(skGame, precise, slow, seed),
      seeds(count),
    );

  it(
    '合併、只差反應延遲、只差決定頻率、只差搜尋深度（精準型不用 depth，所以是 50）',
    () => {
      const count = 30 * N;
      const delay = fastShare({ ...base, reactionTicks: 3 }, { ...base, reactionTicks: 18 }, count);
      const every = fastShare(base, { ...base, decideEvery: 12 }, count);
      const depth = fastShare({ ...base, depth: 6 }, base, count);
      const combined = fastShare(
        { reactionTicks: 3, decideEvery: 1, depth: 1, epsilon: 0 },
        { reactionTicks: 18, decideEvery: 12, depth: 6, epsilon: 0 },
        count,
      );
      report(
        `反應速度四格（${count} 場）：合併 ${combined.toFixed(1)}、只差反應延遲 ${delay.toFixed(1)}、只差決定頻率 ${every.toFixed(1)}、只差搜尋深度 ${depth.toFixed(1)}`,
      );
      expect(depth).toBe(50);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 性格指紋（10.48：測機制，不測症狀）
// ---------------------------------------------------------------------------

/** 從真實對局取樣：每個挑牌階段的第 20 個 tick（挑牌人一定還沒鎖定）取一次，記下挑牌人。 */
function samplePickStates(count: number): SKState[] {
  const samples: SKState[] = [];
  for (const seed of seeds(count)) {
    const first: MakeController = seed % 3 === 0 ? humanModel : level(10);
    const second: MakeController = seed % 2 === 0 ? level(5) : level(10);
    const c0 = first(seed);
    const c1 = second(seed + 1_000_003);
    let state = skGame.init(seed, CONFIG);
    let tick = 0;
    while (!skGame.isOver(state)) {
      if (state.phase === 'pick' && state.phaseTick === 20 && state.picker !== null) {
        samples.push(state);
      }
      state = skGame.step(state, [
        copyButtons(c0.decide(state, 0, tick)),
        copyButtons(c1.decide(state, 1, tick)),
      ]);
      tick += 1;
    }
  }
  return samples;
}

const KEYS = ['up', 'down', 'left', 'right'] as const;
const chosenIndex = (b: Buttons): number => KEYS.findIndex((k) => b[k]);

describe('S-K 性格指紋｜同一批真實挑牌局面上，四個性格挑了什麼', () => {
  it(
    '精準型只在穩的牌裡挑；貪心型挑 E 最高的；賭徒型落後時挑險的比例高於領先時；搜尋型與貪心型的差別在 danger 懲罰',
    () => {
      const samples = samplePickStates(24 * N);
      const policies: [string, Policy][] = [
        ['precise', precise],
        ['greedy', greedy],
        ['gambler', gambler],
        ['pathfinder', pathfinder],
      ];
      const params = { depth: 1, seed: 0 };
      const rows = new Map<
        string,
        { stable: number; risky: number; cold: number; coldRisky: number; diffFromGreedy: number }
      >();
      let withStable = 0;
      let preciseOffStable = 0;
      let behindRisky = 0;
      let behindN = 0;
      let aheadRisky = 0;
      let aheadN = 0;
      for (const [name] of policies) {
        rows.set(name, { stable: 0, risky: 0, cold: 0, coldRisky: 0, diffFromGreedy: 0 });
      }
      for (const state of samples) {
        const side = state.picker as Side;
        const picks = new Map<string, number>();
        for (const [name, policy] of policies) {
          const index = chosenIndex(policy.decide(skGame, state, side, 0, params));
          picks.set(name, index);
          const id = state.offer[index] as string;
          const row = rows.get(name) as {
            stable: number;
            risky: number;
            cold: number;
            coldRisky: number;
            diffFromGreedy: number;
          };
          const label = sigmaLabel(poolEntry(id).sigma);
          row.stable += label === 'stable' ? 1 : 0;
          row.risky += label === 'risky' ? 1 : 0;
          if (state.ledger.length === 0) {
            row.cold += 1;
            row.coldRisky += label === 'risky' ? 1 : 0;
          }
        }
        for (const [name] of policies) {
          if (picks.get(name) !== picks.get('greedy')) {
            (rows.get(name) as { diffFromGreedy: number }).diffFromGreedy += 1;
          }
        }
        if (state.offer.some((id) => sigmaLabel(poolEntry(id).sigma) === 'stable')) {
          withStable += 1;
          if (
            sigmaLabel(poolEntry(state.offer[picks.get('precise') as number] as string).sigma) !==
            'stable'
          ) {
            preciseOffStable += 1;
          }
        }
        const lead = state.ledger.reduce(
          (sum, e) => sum + (e.weight * (side === 0 ? e.mm : -e.mm)) / 1000,
          0,
        );
        const gamblerRisky =
          sigmaLabel(poolEntry(state.offer[picks.get('gambler') as number] as string).sigma) ===
          'risky';
        if (lead <= -0.3) {
          behindN += 1;
          behindRisky += gamblerRisky ? 1 : 0;
        } else if (lead >= 0.3) {
          aheadN += 1;
          aheadRisky += gamblerRisky ? 1 : 0;
        }
      }
      const n = samples.length;
      report(
        `性格指紋（${n} 個挑牌局面，其中空 ledger ${(rows.get('precise') as { cold: number }).cold} 個）：${policies
          .map(([name]) => {
            const r = rows.get(name) as {
              stable: number;
              risky: number;
              coldRisky: number;
              diffFromGreedy: number;
            };
            return `${name} 挑穩 ${((100 * r.stable) / n).toFixed(0)}%、挑險 ${((100 * r.risky) / n).toFixed(0)}%、冷啟動挑險 ${r.coldRisky}、與貪心型不同 ${((100 * r.diffFromGreedy) / n).toFixed(0)}%`;
          })
          .join(
            '；',
          )}；賭徒型挑險：落後(lead≤−0.3) ${behindRisky}/${behindN}、領先(lead≥0.3) ${aheadRisky}/${aheadN}`,
      );
      expect(withStable).toBeGreaterThan(0);
      expect(preciseOffStable).toBe(0);
    },
    LONG,
  );
});

// 避免未使用警告（CONTRACT_MAX_TICKS、ai 供 scratch 與其他量測使用）
void CONTRACT_MAX_TICKS;
void ai;
void strong;
