import { describe, expect, it } from 'vitest';

import { wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import type { Buttons, Side } from '../../core/types';
import { s9Game, tileAt, TILES } from './logic';
import type { S9State } from './logic';
import {
  NEUTRAL,
  NO_BLUNDER,
  ai,
  humanModel,
  idler,
  playObserved,
  playRecorded,
  quantile,
  reader,
  strongHuman,
  straightRunner,
  wallGame,
  winPercent,
} from './players.test-helpers';
import type { MakeController } from './players.test-helpers';

/**
 * S-9 的量測（小規格「實測」）：探針 A、劇本玩家、局長、反應速度、性格指紋、與 C-8 的區隔。
 * 都是真實規則、真實 AI、固定種子，所以數字是確定的；斷言寫在量到的值附近（不是目標值），
 * 萬一誰改了 `evaluate` 或規則，這些量測會跟著變，而不是悄悄漂掉。
 *
 * 這裡的場數比小規格「實測」一節少（那邊是 100 到 200 場，在 scratchpad 跑），為了讓整個檔案在一般的機器上
 * 兩三分鐘跑完；所以斷言的範圍比較寬，數字不要拿來跟小規格的表逐格比。設 `S9_VERBOSE=1` 會把量到的數字印出來。
 */

const seeds = (n: number, from = 0): number[] => Array.from({ length: n }, (_v, i) => from + i);
const LONG = 3_600_000;

function report(text: string): void {
  if (process.env.S9_VERBOSE !== undefined) {
    console.log(text);
  }
}

const level =
  (n: number): MakeController =>
  (seed) =>
    ai(n, seed);

const LEVEL10_PARAMS = { ...NO_BLUNDER, decideEvery: 1 };

// ---------------------------------------------------------------------------
// 探針 A（DESIGN-AI-FUN 10.20、10.24、10.35）
// ---------------------------------------------------------------------------

describe('S-9 探針 A｜玩家讀 AI 的狀態值多少', () => {
  it(
    '三組玩家（規劃時不知道有對手／知道但以為它在我的對面／讀它真正的位置）對等級 10：互動強度 (c) − (b) 是正的',
    () => {
      const run = (kind: 'a' | 'b' | 'c'): number =>
        winPercent((seed) => reader(kind, LEVEL10_PARAMS, seed), level(10), seeds(60));
      const a = run('a');
      const b = run('b');
      const c = run('c');
      report(`探針 A（60 場）：(a) ${a}、(b) ${b}、(c) ${c}、(c)−(b) ${c - b}`);
      // (c) 與對手是同一套評估、同一個等級，鏡像對打必平手，所以正好 50%。
      expect(c).toBe(50);
      expect(c - b).toBeGreaterThan(5);
      expect(c - a).toBeGreaterThan(5);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 劇本玩家
// ---------------------------------------------------------------------------

describe('S-9 劇本玩家｜A4 不是證據（人類模型自己會掉下去），人贏不贏得了看這一組', () => {
  it(
    '對等級 10：站著不動永遠輸；不亂按的人類節奏玩家比人類模型好很多；一行的直線亂跑腳本也有兩成以上',
    () => {
      const rival = level(10);
      const idle = winPercent(() => idler, rival, seeds(20));
      const run = winPercent(() => straightRunner(), rival, seeds(40));
      const human = winPercent(humanModel, rival, seeds(40));
      const strong = winPercent(strongHuman, rival, seeds(40));
      report(`對等級 10：站著 ${idle}、直線亂跑 ${run}、人類模型 ${human}、強玩家 ${strong}`);
      expect(idle).toBe(0);
      expect(human).toBeLessThan(15);
      expect(strong).toBeGreaterThan(human + 20);
      expect(run).toBeGreaterThan(20);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 局長
// ---------------------------------------------------------------------------

describe('S-9 局長｜一回合與整場多長（秒；maxTicks 4500）', () => {
  function lengths(
    first: MakeController,
    second: MakeController,
    count: number,
  ): { match: number[]; rounds: number[] } {
    const match: number[] = [];
    const rounds: number[] = [];
    for (const seed of seeds(count)) {
      const m =
        seed % 2 === 0 ? playRecorded(seed, first, second) : playRecorded(seed, second, first);
      match.push(m.ticks / 60);
      for (const r of m.rounds) {
        rounds.push(r.length / 60);
      }
    }
    return { match, rounds };
  }

  it(
    '等級 10 對等級 10：整場中位數在 30 到 90 秒之內，一回合中位數在 5 秒以上',
    () => {
      const { match, rounds } = lengths(level(10), level(10), 24);
      report(
        `等級10 對 等級10：整場中位 ${quantile(match, 0.5)}、p10 ${quantile(match, 0.1)}；一回合中位 ${quantile(rounds, 0.5)}`,
      );
      expect(quantile(match, 0.5)).toBeGreaterThanOrEqual(30);
      expect(quantile(match, 0.5)).toBeLessThanOrEqual(90);
      expect(quantile(rounds, 0.5)).toBeGreaterThanOrEqual(5);
    },
    LONG,
  );

  it(
    '人類模型對等級 10、2、1：整場的中位數（照實記：都不到 20 秒，離 30 秒的目標很遠，見下一條）',
    () => {
      for (const [name, rival] of [
        ['等級10', level(10)],
        ['等級2', level(2)],
        ['等級1', level(1)],
      ] as const) {
        const { match, rounds } = lengths(humanModel, rival, 24);
        report(
          `人類模型 對 ${name}：整場中位 ${quantile(match, 0.5)}、p10 ${quantile(match, 0.1)}；一回合中位 ${quantile(rounds, 0.5)}`,
        );
        expect(quantile(match, 0.5)).toBeGreaterThan(3);
        expect(quantile(match, 0.5)).toBeLessThan(20);
      }
    },
    LONG,
  );

  // 已知未達標：目標是整場 30 到 90 秒（GOAL 第 4 條）。`it.fails` 的意思是「這條斷言現在會失敗，失敗才算過」：
  // 哪天它真的達標，這條會反過來變紅，提醒把它改成一般的斷言。
  it.fails(
    '（已知未達標）人類模型對等級 2（新手情境）整場中位數至少 30 秒',
    () => {
      const { match } = lengths(humanModel, level(2), 24);
      expect(quantile(match, 0.5)).toBeGreaterThanOrEqual(30);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 反應速度（DESIGN-AI-FUN 10.51 的四格）
// ---------------------------------------------------------------------------

describe('S-9 反應速度｜合併值與三個維度分開（快的一方勝率，精準型）', () => {
  const base = { reactionTicks: 12, decideEvery: 1, depth: 1, epsilon: 0 };
  const fastShare = (fast: typeof base, slow: typeof base, count: number): number =>
    winPercent(
      (seed) => wrapPolicy(s9Game, precise, fast, seed),
      (seed) => wrapPolicy(s9Game, precise, slow, seed),
      seeds(count),
    );

  it(
    '合併值超過 90%（沒過純反應競速的判準）；決定頻率與反應延遲單獨都有作用；搜尋深度單獨是 50%',
    () => {
      const count = 40;
      const delay = fastShare({ ...base, reactionTicks: 3 }, { ...base, reactionTicks: 18 }, count);
      const every = fastShare(base, { ...base, decideEvery: 12 }, count);
      const depth = fastShare({ ...base, depth: 6 }, base, count);
      // 合併值用 100 場（40 場的標準誤約 5 個百分點，會落在 90% 的兩邊）；小規格的 200 場是 95.0。
      const combined = fastShare(
        { reactionTicks: 3, decideEvery: 1, depth: 1, epsilon: 0 },
        { reactionTicks: 18, decideEvery: 12, depth: 6, epsilon: 0 },
        100,
      );
      report(
        `反應速度四格：合併（100 場）${combined}、只差反應延遲（${count} 場）${delay}、只差決定頻率 ${every}、只差搜尋深度 ${depth}`,
      );
      // 精準型不用 depth，所以兩邊逐場相同，平手：正好 50。
      expect(depth).toBe(50);
      expect(combined).toBeGreaterThan(88);
      expect(delay).toBeGreaterThan(60);
      expect(every).toBeGreaterThan(60);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 性格指紋（10.48：測機制，不測症狀）
// ---------------------------------------------------------------------------

/** 從等級 10 對打、人類模型對等級 10 的真實局面取樣：每 10 tick 一次，兩邊都問。 */
function sampleStates(count: number): { state: S9State; side: Side }[] {
  const samples: { state: S9State; side: Side }[] = [];
  for (const seed of seeds(count)) {
    const rival: MakeController = seed % 2 === 0 ? level(10) : humanModel;
    playObserved(seed, level(10), rival, (before) => {
      if (before.phase === 'play' && before.roundTick > 0 && before.roundTick % 10 === 0) {
        samples.push({ state: before, side: 0 }, { state: before, side: 1 });
      }
    });
  }
  return samples;
}

function same(a: Buttons, b: Buttons): boolean {
  return (
    a.up === b.up && a.down === b.down && a.left === b.left && a.right === b.right && a.a === b.a
  );
}

describe('S-9 性格指紋｜同一批真實局面上，四個性格的決定與選到的 danger', () => {
  it(
    '貪心型不看 danger（會選照現在的速度走進洞的動作）、賭徒型偏好高 danger；性格的決定彼此分得開',
    () => {
      const samples = sampleStates(12);
      const policies: [string, Policy][] = [
        ['precise', precise],
        ['greedy', greedy],
        ['gambler', gambler],
        ['pathfinder', pathfinder],
      ];
      const stats = new Map<string, { diff: number; danger: number; fatal: number }>();
      for (const [name] of policies) {
        stats.set(name, { diff: 0, danger: 0, fatal: 0 });
      }
      for (const { state, side } of samples) {
        const base = precise.decide(s9Game, state, side, state.tick, { depth: 1, seed: 0 });
        for (const [name, policy] of policies) {
          const pick = policy.decide(s9Game, state, side, state.tick, { depth: 1, seed: 0 });
          const next = s9Game.step(state, side === 0 ? [pick, NEUTRAL] : [NEUTRAL, pick]);
          const danger = s9Game.evaluate(next, side).danger;
          const entry = stats.get(name) as { diff: number; danger: number; fatal: number };
          entry.diff += same(pick, base) ? 0 : 1;
          entry.danger += danger;
          entry.fatal += danger >= 1 ? 1 : 0;
        }
      }
      const n = samples.length;
      const get = (name: string): { diff: number; danger: number; fatal: number } =>
        stats.get(name) as { diff: number; danger: number; fatal: number };
      report(
        `性格指紋（${n} 個局面）：${policies
          .map(
            ([name]) =>
              `${name} 與精準型不同 ${((100 * get(name).diff) / n).toFixed(1)}%、平均 danger ${(get(name).danger / n).toFixed(3)}、danger=1 占 ${((100 * get(name).fatal) / n).toFixed(2)}%`,
          )
          .join('；')}`,
      );
      expect(get('precise').diff).toBe(0);
      // 貪心型不看 danger：選到 danger = 1（照現在的速度走進洞）的決定明顯比精準型多
      expect(get('greedy').fatal).toBeGreaterThan(get('precise').fatal * 1.5);
      // 賭徒型偏好高 danger：選到的平均 danger 比精準型高，決定至少有 5% 不一樣（加「站在洞邊」的 danger 之前只有 0.2%）
      expect(get('gambler').danger).toBeGreaterThan(get('precise').danger);
      expect(get('gambler').diff / n).toBeGreaterThan(0.05);
      expect(get('greedy').diff / n).toBeGreaterThan(0.02);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------
// 與 C-8 光軌的區隔
// ---------------------------------------------------------------------------

describe('S-9 與 C-8 光軌的區隔｜用數字，不用形容詞', () => {
  it(
    '規則層級的行為：AI 有一半以上的 tick 站著不動，而且會走進對方還沒掉的尾跡（C-8 這兩件事都不可能）',
    () => {
      let ticks = 0;
      let standing = 0;
      let crossings = 0;
      const owner = new Array<number>(TILES).fill(-1);
      for (const seed of seeds(12)) {
        owner.fill(-1);
        playObserved(
          seed,
          level(10),
          seed % 2 === 0 ? humanModel : level(10),
          (before, after, inputs) => {
            if (before.phase === 'rest' && after.phase === 'play') {
              owner.fill(-1);
            }
            if (before.phase !== 'play') {
              return;
            }
            for (const side of [0, 1] as const) {
              const b = inputs[side];
              ticks += 1;
              if (!(b.up || b.down || b.left || b.right)) {
                standing += 1;
              }
              const cell = tileAt(after.players[side].x, after.players[side].y);
              const was = tileAt(before.players[side].x, before.players[side].y);
              if ((before.tiles[cell] as number) === 0 && (after.tiles[cell] as number) > 0) {
                owner[cell] = side;
              } else if (
                cell !== was &&
                (before.tiles[cell] as number) > 0 &&
                owner[cell] === (side === 0 ? 1 : 0)
              ) {
                crossings += 1;
              }
            }
          },
        );
      }
      report(
        `站著不動 ${((100 * standing) / ticks).toFixed(1)}%；走進對方還沒掉的尾跡 ${crossings} 次`,
      );
      expect(standing / ticks).toBeGreaterThan(0.5);
      expect(crossings).toBeGreaterThan(0);
    },
    LONG,
  );

  it(
    '策略移植：把 C-8 的世界觀（踩過的格子都當永久的牆）接到 S-9 的領地算法上，對等級 10 不比時間感知的玩家差——0.75 秒的時效不是策略核心',
    () => {
      const rival = level(10);
      const time = winPercent((seed) => reader('c', LEVEL10_PARAMS, seed), rival, seeds(60));
      const wall = winPercent(
        (seed) => wrapPolicy(wallGame(), precise, LEVEL10_PARAMS, seed),
        rival,
        seeds(60),
      );
      report(`策略移植（60 場）：時間感知 ${time}、C-8 世界觀 ${wall}`);
      // 時間感知的玩家與對手是同一套評估，鏡像對打全平手：50。
      expect(time).toBe(50);
      // 如果時間因素是策略的核心，C-8 世界觀應該輸；實測它不輸（小規格「實測」第 3 節：200 場 78.8%）。
      expect(wall).toBeGreaterThanOrEqual(50);
    },
    LONG,
  );
});
