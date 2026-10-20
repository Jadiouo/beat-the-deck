import { describe, expect, it } from 'vitest';

import { wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import type { LevelParams } from '../../ai/types';
import { levelController } from '../../ai/level';
import type { Side } from '../../core/types';
import { gapKinds, s6Game } from './logic';
import type { Note, S6State } from './logic';
import {
  ai,
  fixedPhrase,
  human,
  idle,
  meanDiff,
  mix,
  playRecorded,
  quantile,
  sandbag,
  strongHuman,
  weakLane,
  winPercent,
} from './players.test-helpers';
import type { Make } from './players.test-helpers';

/**
 * S-6 的量測（小規格「實測」）：四件要正面量的事、探針 A、劇本玩家、局長、反應速度、性格指紋。
 * 都是真實規則、真實 AI、固定種子，所以數字是確定的；斷言寫在量到的值上（不是目標值），
 * 萬一誰改了 `evaluate` 或規則，這些量測會跟著變，而不是悄悄漂掉。
 * 場數比小規格「實測」一節少（那邊 200 場，在 scratchpad 跑）；設 `S6_VERBOSE=1` 會把量到的數字印出來。
 */

const seeds = (n: number, from = 0): number[] => Array.from({ length: n }, (_v, i) => from + i);
const LONG = 3_600_000;

function report(text: string): void {
  if (process.env.S6_VERBOSE !== undefined) {
    console.log(text);
  }
}

const L10 = ai(precise, 10);

// ---------------------------------------------------------------------------
// 探針 A（DESIGN-AI-FUN 10.20、10.24、10.35、10.54）
// ---------------------------------------------------------------------------

describe('S-6 探針 A｜讀 AI 的準度歷史值多少', () => {
  /**
   * 三組玩家對打的部分都一樣（完美，或人類模型的對打），只差編曲怎麼決定：
   * (a) 不知道有對手：固定編 4 個音（←↓↑→ 依序，第 0、2、4、6 格），以為音越多越好。
   * (b) 知道有對手、但不讀它的狀態：用 AI 自己的編曲決策（精準型等級 10），但評估看到的對手歷史一律換成空的。
   * (c) 讀它的狀態：用 AI 自己的編曲決策，歷史是真的。
   * 互動強度 ＝ (c) − (b)。(b) 的定義在量之前固定，不依結果調整。
   */
  const emptyHistory = {
    ...s6Game,
    evaluate: (s: S6State, side: Side) => s6Game.evaluate({ ...s, history: [[], []] }, side),
  };
  const naive: readonly Note[] = [
    { lane: 0, slot: 0 },
    { lane: 1, slot: 2 },
    { lane: 2, slot: 4 },
    { lane: 3, slot: 6 },
  ];
  const composers: readonly (readonly [string, Make])[] = [
    ['a', fixedPhrase(naive)],
    ['b', (seed, side) => levelController(emptyHistory, precise, 10, seed * 2 + side + 7)],
    ['c', (seed, side) => levelController(s6Game, precise, 10, seed * 2 + side + 7)],
  ];

  it(
    '對等級 10：完美對打與人類模型的對打各三組，(c) − (b) 都是 0（AI 沒有可讀的弱點）',
    () => {
      const rows: Record<string, number> = {};
      for (const [execName, exec] of [
        ['完美', idle],
        ['人類模型', human],
      ] as const) {
        for (const [name, composer] of composers) {
          rows[`${execName}-${name}`] = winPercent(mix(composer, exec), L10, seeds(60));
        }
      }
      report(`探針 A（60 場，對等級 10）：${JSON.stringify(rows)}`);
      expect(rows['完美-c']! - rows['完美-b']!).toBe(0);
      expect(rows['人類模型-c']! - rows['人類模型-b']!).toBe(0);
      expect(rows['完美-b']).toBe(50);
      expect(rows['完美-a']).toBe(0);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 劇本玩家與支配策略（10.40）、藏拙（10.7）
// ---------------------------------------------------------------------------

describe('S-6 劇本玩家｜對等級 10 的單位勝率與平均分差（沒有支配策略，但最好的玩法是平手）', () => {
  const rows: readonly (readonly [string, Make])[] = [
    ['不編曲＋完美對打', idle],
    ['固定 4 音同軌', fixedPhrase([0, 2, 4, 6].map((slot) => ({ lane: 0, slot })))],
    ['固定 4 音四軌', fixedPhrase([0, 1, 2, 3].map((l) => ({ lane: l, slot: l * 2 })))],
    ['藏拙 1 回合（全漏）', sandbag(1)],
    ['藏拙 2 回合（全漏）', sandbag(2)],
    ['藏拙 3 回合（全漏）', sandbag(3)],
    ['藏拙 3 回合（只漏第一個見到的軌道）', sandbag(3, true)],
    ['人類模型', human],
    ['強玩家（不亂按）', strongHuman],
  ];

  it(
    '最好的是平手（50.0）；任何一種都沒有超過 90%；藏拙花的比騙到的多（平均分差是負的）',
    () => {
      const table: Record<string, [number, number]> = {};
      for (const [name, make] of rows) {
        table[name] = [winPercent(make, L10, seeds(40)), meanDiff(make, L10, seeds(40))];
      }
      report(`劇本玩家（40 場，對等級 10）：[單位勝率, 平均分差] ${JSON.stringify(table)}`);
      expect(table['不編曲＋完美對打']![0]).toBe(50);
      expect(table['強玩家（不亂按）']![0]).toBe(50);
      expect(table['人類模型']![0]).toBe(0);
      for (const [name, [rate]] of Object.entries(table)) {
        expect(rate, name).toBeLessThan(90);
      }
      for (const name of ['藏拙 1 回合（全漏）', '藏拙 2 回合（全漏）', '藏拙 3 回合（全漏）']) {
        expect(table[name]![1], name).toBeLessThan(0);
      }
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// AI 會不會收斂成永遠出你最弱的軌道（10.19）
// ---------------------------------------------------------------------------

describe('S-6 收斂｜AI 的曲子（AI 坐 1 邊，第 5 到 10 回合）', () => {
  const key = (ns: readonly Note[]): string => ns.map((n) => `${n.lane}@${n.slot}`).join(',');

  function convergence(
    opponent: Make,
    count: number,
  ): { notes: number; modalShare: number; sameAsLast: number; onWeak: number } {
    let rounds = 0;
    let notes = 0;
    let modal = 0;
    let same = 0;
    let sameChances = 0;
    let onWeak = 0;
    for (const seed of seeds(count)) {
      const r = playRecorded(seed, opponent, L10);
      r.rounds.forEach((round, i) => {
        if (i < 4) {
          return;
        }
        const phrase = round.phrases[1];
        const counts = [0, 0, 0, 0];
        phrase.forEach((n) => (counts[n.lane] = (counts[n.lane] as number) + 1));
        modal += Math.max(...counts) / phrase.length;
        onWeak += (counts[2] as number) / phrase.length;
        notes += phrase.length;
        rounds += 1;
        if (i >= 5) {
          sameChances += 1;
          same +=
            key((r.rounds[i - 1] as (typeof r.rounds)[number]).phrases[1]) === key(phrase) ? 1 : 0;
        }
      });
    }
    return {
      notes: notes / rounds,
      modalShare: modal / rounds,
      sameAsLast: same / sameChances,
      onWeak: onWeak / rounds,
    };
  }

  it(
    '對手永遠漏第 2 軌：AI 幾乎全部出在那一軌，相鄰兩回合的曲子多半完全相同；對手只是隨機出錯：AI 根本不下注',
    () => {
      const stuck = convergence(weakLane(2), 30);
      const noisy = convergence(human, 30);
      const half = convergence(weakLane(2, 50), 30);
      report(
        `收斂：永遠漏第2軌 ${JSON.stringify(stuck)}；漏 50% ${JSON.stringify(half)}；人類模型 ${JSON.stringify(noisy)}`,
      );
      expect(stuck.onWeak).toBeGreaterThan(0.9);
      expect(stuck.sameAsLast).toBeGreaterThan(0.7);
      expect(stuck.notes).toBeGreaterThan(3);
      expect(noisy.notes).toBe(2);
      expect(noisy.sameAsLast).toBeLessThan(0.05);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 「對方零分音符 ×2」是不是被搶的有限物（10.19）
// ---------------------------------------------------------------------------

describe('S-6 零分獎勵｜每場平均賺到的獎勵分', () => {
  it(
    '兩個等級 10 與人類模型對等級 10：一分都沒有；只有對手有穩定弱點時才賺得到，而且不是被搶，是對方送的',
    () => {
      function bonus(a: Make, b: Make, count: number): [number, number] {
        let x = 0;
        let y = 0;
        for (const seed of seeds(count)) {
          for (const round of playRecorded(seed, a, b).rounds) {
            x += round.bonus[0];
            y += round.bonus[1];
          }
        }
        return [x / count, y / count];
      }
      const mirror = bonus(L10, L10, 20);
      const vsHuman = bonus(human, L10, 20);
      const vsWeak = bonus(weakLane(2), L10, 20);
      report(
        `每場獎勵分 [0 邊, 1 邊]：L10對L10 ${mirror}；人類模型對L10 ${vsHuman}；永遠漏第2軌對L10 ${vsWeak}`,
      );
      expect(mirror).toEqual([0, 0]);
      expect(vsHuman).toEqual([0, 0]);
      expect(vsWeak[0]).toBe(0);
      expect(vsWeak[1]).toBeGreaterThan(30);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 反應速度（DESIGN-AI-FUN 3.1、10.51 的四格）
// ---------------------------------------------------------------------------

describe('S-6 反應速度｜合併值與三個維度分開（快的一方勝率，精準型，平手半場）', () => {
  const base: LevelParams = { reactionTicks: 12, decideEvery: 1, depth: 1, epsilon: 0 };
  const make =
    (p: LevelParams, policy: Policy = precise): Make =>
    (seed, side) =>
      wrapPolicy(s6Game, policy, p, seed * 2 + side + 7);
  const fastShare = (fast: LevelParams, slow: LevelParams, count: number): number =>
    winPercent(make(fast), make(slow), seeds(count));

  it(
    '合併值 100%（超過 90%）；只差反應延遲 50.0（沒有作用，因為音符提前 60 tick 就看得到）；只差決定頻率 100%；只差搜尋深度 50.0',
    () => {
      const count = 60;
      const combined = fastShare(
        { reactionTicks: 3, decideEvery: 1, depth: 1, epsilon: 0 },
        { reactionTicks: 18, decideEvery: 12, depth: 6, epsilon: 0 },
        count,
      );
      const delay = fastShare({ ...base, reactionTicks: 3 }, { ...base, reactionTicks: 18 }, count);
      const every = fastShare(base, { ...base, decideEvery: 12 }, count);
      const depth = fastShare({ ...base, depth: 6 }, base, count);
      report(
        `反應速度四格（${count} 場）：合併 ${combined}、反應延遲 ${delay}、決定頻率 ${every}、深度 ${depth}`,
      );
      expect(combined).toBeGreaterThan(90);
      expect(delay).toBe(50);
      expect(every).toBeGreaterThan(90);
      expect(depth).toBe(50);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 局長
// ---------------------------------------------------------------------------

describe('S-6 局長｜整場多長（秒）', () => {
  it(
    '四個情境（等級 10 對等級 10、人類模型對等級 10／2／1）：每場都是 10 回合 49.0 秒，中位數與第 10 百分位相同',
    () => {
      const scenarios: readonly (readonly [string, Make, Make])[] = [
        ['L10 對 L10', L10, L10],
        ['人類模型對 L10', human, L10],
        ['人類模型對 L2', human, ai(precise, 2)],
        ['人類模型對 L1', human, ai(precise, 1)],
      ];
      for (const [name, a, b] of scenarios) {
        const lengths = seeds(12).map((seed) => playRecorded(seed, a, b).ticks / 60);
        report(`局長 ${name}：中位數 ${quantile(lengths, 0.5)}、p10 ${quantile(lengths, 0.1)}`);
        expect(quantile(lengths, 0.5), name).toBe(49);
        expect(quantile(lengths, 0.1), name).toBe(49);
      }
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 性格指紋（10.48：測機制，不測症狀）
// ---------------------------------------------------------------------------

describe('S-6 性格指紋｜等級 10 的四個性格對人類模型（AI 坐 1 邊）', () => {
  function fingerprint(policy: Policy, count: number) {
    let rounds = 0;
    let notes = 0;
    let short = 0;
    let over = 0;
    for (const seed of seeds(count)) {
      for (const round of playRecorded(seed, human, ai(policy, 10)).rounds) {
        rounds += 1;
        notes += round.phrases[1].length;
        short += gapKinds(round.phrases[1]).filter((k) => k === 0).length;
        over += round.over[1];
      }
    }
    return { notes: notes / rounds, short: short / notes, over: over / rounds };
  }

  it(
    '音符數：貪心型 ≈ 2 倍精準型；多按 tick／回合：只有貪心型不是 0；短間隔比例：賭徒型與貪心型遠高於精準型',
    () => {
      const p = fingerprint(precise, 20);
      const g = fingerprint(greedy, 20);
      const b = fingerprint(gambler, 20);
      const s = fingerprint(pathfinder, 20);
      report(
        `指紋：精準 ${JSON.stringify(p)} 貪心 ${JSON.stringify(g)} 賭徒 ${JSON.stringify(b)} 搜尋 ${JSON.stringify(s)}`,
      );
      expect(g.notes).toBeGreaterThanOrEqual(1.5 * p.notes);
      expect(p.over).toBe(0);
      expect(b.over).toBe(0);
      expect(s.over).toBe(0);
      expect(g.over).toBeGreaterThan(10);
      expect(g.short - p.short).toBeGreaterThan(0.1);
      expect(b.short - p.short).toBeGreaterThan(0.1);
    },
    LONG,
  );
});
