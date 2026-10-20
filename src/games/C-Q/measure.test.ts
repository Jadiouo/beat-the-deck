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

const CONFIG = { maxTicks: 3600, params: {} };
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

describe('C-Q 兩條蛇｜僚機有沒有人在乎（命中率與局長）', () => {
  it('僚機命中率（小規格判準 ≥ 10%）：搜尋型等級 10 對等級 10，60 場，命中 ÷ 放出 ≥ 10%，而且每場兩邊合計至少放 1 次', () => {
    let launches = 0;
    let hits = 0;
    for (const seed of seeds(60)) {
      const result = pair(cqGame, seed, (s) => [
        level10(cqGame, s),
        level10(cqGame, s + 1_000_003),
      ]);
      launches += result.final.launches[0] + result.final.launches[1];
      hits += result.final.hits[0] + result.final.hits[1];
    }
    expect(launches / 60, `每場放出 ${(launches / 60).toFixed(2)} 次`).toBeGreaterThanOrEqual(1);
    expect(
      hits / launches,
      `命中率 ${((100 * hits) / launches).toFixed(1)}%（${hits}/${launches}）`,
    ).toBeGreaterThanOrEqual(0.1);
  }, 300_000);

  it('局長（DESIGN-AI-FUN 附錄：四個情境都要量）：等級 10 對 10、人類模型對 10／2／1 各 60 場，中位數與第 10 百分位不低於釘住的值（兩個低等級的情境沒達到小規格的 30 秒）', () => {
    const scenarios: {
      readonly name: string;
      readonly make: (seed: number) => [Controller<CQState>, Controller<CQState>];
      readonly median: number;
      readonly p10: number;
    }[] = [
      {
        name: '等級 10 對 10',
        make: (s) => [level10(cqGame, s), level10(cqGame, s + 1_000_003)],
        median: 55,
        p10: 15,
      },
      {
        name: '人類模型對 10',
        make: (s) => [human(cqGame, s), level10(cqGame, s + 1_000_003)],
        median: 30,
        p10: 6,
      },
      {
        // 小規格的目標是 ≥ 30 秒，量到約 15 秒：等級 2 的 AI 自己撞死（epsilon 亂按），沿用 C-A 的規則時 C-A 也是 13.5 秒
        name: '人類模型對 2',
        make: (s) => [human(cqGame, s), levelController(cqGame, pathfinder, 2, s + 1_000_003)],
        median: 10,
        p10: 3,
      },
      {
        name: '人類模型對 1',
        make: (s) => [human(cqGame, s), levelController(cqGame, pathfinder, 1, s + 1_000_003)],
        median: 10,
        p10: 3,
      },
    ];
    for (const scenario of scenarios) {
      const seconds = seeds(60).map((seed) => pair(cqGame, seed, scenario.make).ticks / 60);
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
  it('劇本玩家對搜尋型等級 10 各 100 場：永遠不放（eater）、能放就放（spam）、只躲不放（dodger）、讀對手才放（reads）都沒有超過 90%', () => {
    const kinds: PlayerKind[] = ['eater', 'spam', 'dodger', 'reads'];
    for (const kind of kinds) {
      const rate = scriptedWinRate(cqGame, kind, seeds(100), CONFIG);
      expect(rate, `${kind} ${(100 * rate).toFixed(1)}%`).toBeLessThan(0.9);
    }
  }, 600_000);

  it('永遠不放僚機的劇本不是好策略：eater 的勝率比「能放就放」的 spam 低，也比僚機關掉時（＝貪食蛇）低', () => {
    const eater = scriptedWinRate(cqGame, 'eater', seeds(100), CONFIG);
    const spam = scriptedWinRate(cqGame, 'spam', seeds(100), CONFIG);
    const off = scriptedWinRate(createCQGame({ drones: false }), 'eater', seeds(100), CONFIG);
    expect(eater, `eater ${eater} spam ${spam} 沒有僚機時的 eater ${off}`).toBeLessThan(
      spam + 0.05,
    );
    expect(eater).toBeLessThan(off);
  }, 600_000);
});

/** 小規格原版的強迫放出實驗：兩個測試共用，只跑一次。 */
let plainRows: ReturnType<typeof forcedLaunches> | null = null;
function plainForced(): ReturnType<typeof forcedLaunches> {
  plainRows ??= forcedLaunches(plain, seeds(200), CONFIG);
  return plainRows;
}

describe('C-Q 兩條蛇｜誤放的代價（DESIGN-AI-FUN 10.19 第 4 題：每次 ≥ 0.5）', () => {
  it('小規格原版（放出不花東西）：撲空的僚機讓分差變化的平均值在 ±0.5 以內（放錯不損失東西）', () => {
    const rows = plainForced();
    const misses = summarize(rows.filter((r) => !r.hit).map((r) => r.deltaHorizon));
    expect(misses.n).toBeGreaterThan(20);
    expect(
      Math.abs(misses.mean),
      `原版撲空 n=${misses.n} 平均 ${misses.mean.toFixed(2)} ± ${misses.se.toFixed(2)}`,
    ).toBeLessThan(0.5);
  }, 900_000);

  it('tailCost（預設）：撲空的僚機讓分差少 0.5 以上（10.19 第 4 題的判準），而且比小規格原版的撲空（≈ 0）至少多損失 0.5', () => {
    const rows = forcedLaunches(cqGame, seeds(240), CONFIG);
    const misses = summarize(rows.filter((r) => !r.hit).map((r) => r.deltaHorizon));
    const plainMisses = summarize(
      plainForced()
        .filter((r) => !r.hit)
        .map((r) => r.deltaHorizon),
    );
    expect(misses.n).toBeGreaterThan(50);
    expect(
      misses.mean,
      `tailCost 撲空 n=${misses.n} 平均 ${misses.mean.toFixed(2)} ± ${misses.se.toFixed(2)}`,
    ).toBeLessThanOrEqual(-0.5);
    expect(misses.mean, `原版撲空 ${plainMisses.mean.toFixed(2)}`).toBeLessThan(
      plainMisses.mean - 0.5,
    );
  }, 1_800_000);
});

// ---------------------------------------------------------------------------
// 探針 A（真實規則、真實 AI）
// ---------------------------------------------------------------------------

describe('C-Q 兩條蛇｜探針 A（DESIGN-AI-FUN 10.24、10.54）', () => {
  it('(a) 不知道有對手 / (b) 知道但不讀它的狀態（能放就放）/ (c) 讀它的狀態（靠近才放、躲僚機）各 200 場：互動強度 (c) − (b) 低於 20 個百分點（不宣稱「你可以騙它」）', () => {
    const rate = (kind: PlayerKind): number => scriptedWinRate(cqGame, kind, seeds(200), CONFIG);
    const a = rate('unaware');
    const b = rate('aware');
    const c = rate('reads');
    expect(a, `(a) ${a} (b) ${b} (c) ${c}`).toBeLessThan(b);
    expect(c - b, `互動強度 (c)−(b) = ${((c - b) * 100).toFixed(1)} 個百分點`).toBeLessThan(0.2);
  }, 1_200_000);
});

// ---------------------------------------------------------------------------
// 反應速度
// ---------------------------------------------------------------------------

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

describe('C-Q 兩條蛇｜四個性格的指紋（機制，不是症狀）', () => {
  it('每個性格等級 10 對搜尋型等級 10、各 100 場：「有風險差異時選最危險的」、死亡率、放僚機的次數與時機，兩兩至少一項差 1.5 倍或 10 個百分點；賭徒型更少放、放得更遠', () => {
    const prints = {
      pathfinder: fingerprint(pathfinder, 100),
      precise: fingerprint(precise, 100),
      greedy: fingerprint(greedy, 100),
      gambler: fingerprint(gambler, 100),
    };
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
    expect(prints.pathfinder.decisions).toBeGreaterThanOrEqual(300);
    // 賭徒型的放僚機：次數遠少於搜尋型、放的時候離對手更遠（小規格預測的是「落後才放」，實測推翻，見小規格）
    expect(prints.gambler.launchesPerGame).toBeLessThan(0.5 * prints.pathfinder.launchesPerGame);
    expect(prints.gambler.nearMean).toBeGreaterThan(1.5 * prints.pathfinder.nearMean);
    // 貪心型不看 danger：死在自己選的路上的場數最多
    expect(prints.greedy.lostByDeath).toBeGreaterThanOrEqual(2 * prints.pathfinder.lostByDeath);
    expect(prints.greedy.lostByDeath).toBeGreaterThanOrEqual(2 * prints.precise.lostByDeath);
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
