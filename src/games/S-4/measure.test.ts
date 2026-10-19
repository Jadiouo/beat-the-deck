import { describe, expect, it } from 'vitest';

import { winRate } from '../../ai/evolution';
import { levelController, levelParams, policyByName, wrapPolicy } from '../../ai/level';
import { precise } from '../../ai/policies/precise';
import { lookOneStep } from '../../ai/policies/shared';
import type { Policy } from '../../ai/types';
import type { Buttons, Controller, Side } from '../../core/types';
import { makeState, s4Game } from './logic';
import type { S4State } from './logic';
import {
  CONTRACT,
  NEUTRAL,
  ai,
  firstCrossTick,
  humanModel,
  pointsFor,
  quantile,
  record,
  scripted,
  seedRange,
  winPercent,
} from './players.test-helpers';
import type { MatchRecord, ScriptKind } from './players.test-helpers';

/**
 * S-4 的量測（小規格「實作與量測」）：局長、互動何時開始、探針 A、劇本玩家、反應速度、性格指紋、
 * 搶磚換目標、瞄準、重播看到的自己。都是真實規則、真實 AI、固定種子，所以數字是確定的；
 * 斷言寫在量到的值附近（不是目標值），萬一誰改了 `evaluate` 或規則，這些量測會跟著變，而不是悄悄漂掉。
 *
 * 這裡的場數比小規格的表少（那邊是 100 到 200 場，在 scratchpad 跑，數字與 commit 寫在小規格裡），
 * 為了讓整個檔案在一般的機器上幾分鐘跑完；所以斷言的範圍比較寬，數字不要拿來跟小規格的表逐格比。
 * 設 `S4_VERBOSE=1` 會把量到的數字印出來。
 */

const LONG = 3_600_000;

function report(text: string): void {
  if (process.env.S4_VERBOSE !== undefined) {
    process.stdout.write(`${text}\n`);
  }
}

const sideOf = (seed: number): Side => (seed % 2 === 0 ? 0 : 1);
const aiRival = (level: number) => (seed: number) => ai(level, seed + 1_000_003);

function records(
  me: (seed: number) => Controller<S4State>,
  rival: (seed: number) => Controller<S4State>,
  seeds: readonly number[],
): MatchRecord[] {
  return seeds.map((seed) => {
    const mine = me(seed);
    const theirs = rival(seed);
    return sideOf(seed) === 0 ? record(seed, mine, theirs) : record(seed, theirs, mine);
  });
}

const median = (xs: readonly number[]): number => quantile(xs, 0.5);

describe('S-4 量測｜局長與互動何時開始（DESIGN-AI-FUN 10.19：第一次穿牆晚於 20 秒就把牆改 5 列）', () => {
  const scenarios: [
    string,
    (seed: number) => Controller<S4State>,
    (seed: number) => Controller<S4State>,
  ][] = [
    ['10 對 10', (seed) => ai(10, seed), aiRival(10)],
    ['人類模型對 10', humanModel, aiRival(10)],
    ['人類模型對 2', humanModel, aiRival(2)],
    ['人類模型對 1', humanModel, aiRival(1)],
  ];
  /** 四個情境各 12 場（種子 0..11），三條測試共用，只跑一次。 */
  let cache: Map<string, MatchRecord[]> | null = null;
  const played = (): Map<string, MatchRecord[]> => {
    cache ??= new Map(
      scenarios.map(([name, me, rival]) => [name, records(me, rival, seedRange(12))]),
    );
    return cache;
  };

  it(
    '局長（秒，12 場的中位數與第 10 百分位）：10 對 10 約 28 秒（比小規格估的 45 秒短：炸彈炸掉一半的磚），人類模型對 10 約 36 秒，對 2 與對 1 打到 50 秒的上限',
    () => {
      const limits: Record<string, [number, number, number]> = {
        '10 對 10': [24, 34, 18],
        '人類模型對 10': [31, 42, 24],
        '人類模型對 2': [40, 50, 30],
        '人類模型對 1': [42, 50, 30],
      };
      for (const [name, rows] of played()) {
        const secs = rows.map((r) => r.ticks / 60);
        const med = median(secs);
        const p10 = quantile(secs, 0.1);
        report(
          `局長 ${name}：中位數 ${med.toFixed(1)} 秒，第 10 百分位 ${p10.toFixed(1)} 秒，最長 ${Math.max(...secs).toFixed(1)}`,
        );
        const [lo, hi, floor] = limits[name] as [number, number, number];
        expect(med, name).toBeGreaterThanOrEqual(lo);
        expect(med, name).toBeLessThanOrEqual(hi);
        expect(p10, name).toBeGreaterThanOrEqual(floor);
        expect(Math.max(...secs), name).toBeLessThanOrEqual(50);
      }
    },
    LONG,
  );

  it(
    '第一次有球穿牆（從一半飛到另一半）的時間中位數都在 20 秒以內，所以牆維持 6 列：10 對 10 約 14 秒，人類模型對 10 約 14 秒，對 2 約 17 秒，對 1 約 18 秒（每個情境 30 場，一出現就停）',
    () => {
      for (const [name, me, rival] of scenarios) {
        const ticks = seedRange(30).map((seed) => {
          const mine = me(seed);
          const theirs = rival(seed);
          return sideOf(seed) === 0
            ? firstCrossTick(seed, mine, theirs)
            : firstCrossTick(seed, theirs, mine);
        });
        const first = ticks.filter((x) => x >= 0).map((x) => x / 60);
        report(
          `第一次穿牆 ${name}：中位數 ${median(first).toFixed(1)} 秒，第 90 百分位 ${quantile(first, 0.9).toFixed(1)} 秒（${first.length}/30 場有）`,
        );
        expect(first.length, name).toBeGreaterThanOrEqual(28);
        expect(median(first), name).toBeLessThanOrEqual(20);
      }
    },
    LONG,
  );

  it(
    '炸彈炸掉的磚占一半上下（每場 4 顆炸彈全都被打到，10 對 10）：這是一局比小規格估的短的原因',
    () => {
      const rows = played().get('10 對 10') as MatchRecord[];
      const share = rows.reduce((sum, r) => sum + r.bombBricks, 0) / (rows.length * 60);
      report(`炸彈炸掉的磚占 ${(100 * share).toFixed(1)}%`);
      expect(share).toBeGreaterThanOrEqual(0.4);
      expect(share).toBeLessThanOrEqual(0.7);
      expect(rows.every((r) => r.bombsWon[0] + r.bombsWon[1] === 4)).toBe(true);
    },
    LONG,
  );
});

describe('S-4 量測｜探針 A（DESIGN-AI-FUN 10.20、10.24、10.35、10.54）：玩家讀 AI 的狀態值多少', () => {
  /**
   * 三組劇本玩家只差「怎麼看對手」，移動與瞄準的方式一樣（完整資訊、每 tick 決定、不延遲、不失誤）：
   *  (a) 不知道有對手：只管自己發的球，穿牆當作球白白飛走（價值 0）。
   *  (b) 知道有對手、不讀它的狀態（這個定義在量之前固定，寫在 players.test-helpers.ts）：什麼球都接，瞄炸彈，
   *      知道洞會把球送到對方那一半被接回來（固定 −3），不看對手的板子與球。
   *  (c) 讀它的狀態：(b) 加上對手板子夠不到或正忙著接自己的球才穿牆、對手的球先到同一塊就換目標、守快通的欄。
   * 互動強度 ＝ (c) − (b)（10.35）。
   */
  it(
    '三組對等級 10：(a) 最低 且都遠低於 50%（AI 比任何一組劇本都會瞄準）；互動強度 (c) − (b) 不是大的正數（每格只有 16 場，標準誤約 8，所以只守「不到 30」；200 場的數字是 +4.3，在小規格）',
    () => {
      const seeds = seedRange(16);
      const run = (kind: ScriptKind): number =>
        winPercent(() => scripted(kind), aiRival(10), seeds);
      const a = run('a');
      const b = run('b');
      const c = run('c');
      report(
        `探針 A（16 場）：(a) ${a.toFixed(1)}、(b) ${b.toFixed(1)}、(c) ${c.toFixed(1)}、(c)−(b) ${(c - b).toFixed(1)}、(b)−(a) ${(b - a).toFixed(1)}`,
      );
      expect(a).toBeLessThanOrEqual(15);
      expect(c).toBeLessThanOrEqual(40);
      expect(c - b).toBeLessThan(30);
      expect(c).toBeGreaterThanOrEqual(a);
    },
    LONG,
  );

  it(
    '玩家最佳動作對 AI 狀態的敏感度（骨架診斷，不是標籤）：AI 的球預計先到同一塊磚時，AI 換目標 —— 沒有對手的球時 18 次裡敲 18 次，對手的球先到時 0 次（等級 10 與每 6 個 tick 才決定都一樣）',
    () => {
      const N0 = NEUTRAL;
      for (const decideEvery of [1, 6]) {
        let free = 0;
        let contested = 0;
        for (let c = 2; c <= 7; c += 1) {
          for (const dx of [-5, 0, 5]) {
            const gone = [1, 2, 3, 4, 5].map((r) => r * 10 + c);
            const cx = c * 15 + 7.5;
            for (const hasRival of [false, true]) {
              let s = makeState({
                gone,
                balls: [
                  hasRival
                    ? { x: cx, y: 160, vx: 0, vy: -2, owner: 0, respawn: 0 }
                    : { respawn: 500 },
                  { x: cx + dx, y: 60, vx: 0, vy: -2, owner: 1, respawn: 0 },
                ],
                paddles: [{ x: cx }, { x: cx + dx }],
              });
              const ctl = wrapPolicy(
                s4Game,
                precise,
                { reactionTicks: 12, decideEvery, depth: 1, epsilon: 0 },
                1,
              );
              let hit = -1;
              for (let t = 0; t < 140 && hit < 0; t += 1) {
                const n = s4Game.step(s, [N0, ctl.decide(s, 1, t)]);
                for (let i = 0; i < 60; i += 1) {
                  if (s.bricks[i] === 0 && n.bricks[i] === 1 && n.score[1] > s.score[1]) {
                    hit = i;
                  }
                }
                s = n;
              }
              if (hit === c) {
                if (hasRival) {
                  contested += 1;
                } else {
                  free += 1;
                }
              }
            }
          }
        }
        report(
          `搶磚換目標（decideEvery ${decideEvery}）：沒有對手的球 ${free}/18，對手的球先到 ${contested}/18`,
        );
        expect(free).toBeGreaterThanOrEqual(16);
        expect(contested).toBeLessThanOrEqual(2);
      }
    },
    LONG,
  );
});

describe('S-4 量測｜劇本玩家：沒有簡單腳本支配 AI（DESIGN-AI-FUN 10.40）', () => {
  it(
    '對等級 10：站著不動、只用板心、永遠邊緣、只守、只瞄炸彈、只挖、(a)(b)(c) 都 ≤ 90%（實測最高約 15%，200 場的表在小規格）；站著不動永遠輸',
    () => {
      const seeds = seedRange(10);
      const kinds: ScriptKind[] = [
        'idle',
        'center',
        'edge',
        'guard',
        'bomb',
        'tunnel',
        'a',
        'b',
        'c',
      ];
      const wins: Record<string, number> = {};
      for (const kind of kinds) {
        wins[kind] = winPercent(() => scripted(kind), aiRival(10), seeds);
      }
      report(
        `劇本玩家對等級 10（10 場）：${kinds.map((k) => `${k} ${(wins[k] as number).toFixed(1)}`).join('、')}`,
      );
      for (const kind of kinds) {
        expect(wins[kind], kind).toBeLessThanOrEqual(40);
      }
      expect(wins['idle']).toBe(0);
    },
    LONG,
  );

  it(
    'A4（人類模型對等級 10，12 場）：贏不了（≤ 35%，實測約 10%）；對等級 2 與 1 贏得了（≥ 60%）',
    () => {
      const seeds = seedRange(12);
      const vs = (level: number): number => winPercent(humanModel, aiRival(level), seeds);
      const ten = vs(10);
      const two = vs(2);
      const one = vs(1);
      report(`人類模型對 10／2／1：${ten.toFixed(1)}／${two.toFixed(1)}／${one.toFixed(1)}`);
      expect(ten).toBeLessThanOrEqual(35);
      expect(two).toBeGreaterThanOrEqual(60);
      expect(one).toBeGreaterThanOrEqual(80);
    },
    LONG,
  );
});

describe('S-4 量測｜等級軸（DESIGN-AI-FUN 3.1 反應速度測試）', () => {
  it(
    '快而淺對慢而深（精準型，10 場）：合併 ≥ 90%（沒過 3.1 的「不是純反應競速」），但拆開之後全部來自決定頻率；反應延遲單獨只有五成上下，因為球的路線是確定的、自己的板子不被延遲',
    () => {
      const seeds = seedRange(10);
      const run = (fast: [number, number, number], slow: [number, number, number]): number =>
        100 *
        winRate(
          s4Game,
          precise,
          { reactionTicks: fast[0], decideEvery: fast[1], depth: fast[2], epsilon: 0 },
          precise,
          { reactionTicks: slow[0], decideEvery: slow[1], depth: slow[2], epsilon: 0 },
          seeds,
          CONTRACT,
        );
      const combined = run([3, 1, 1], [18, 12, 6]);
      const frequency = run([12, 1, 1], [12, 12, 1]);
      const delay = run([3, 1, 1], [18, 1, 1]);
      report(`反應速度：合併 ${combined}、只差決定頻率 ${frequency}、只差反應延遲 ${delay}`);
      expect(combined).toBeGreaterThanOrEqual(90);
      expect(frequency).toBeGreaterThanOrEqual(90);
      expect(delay).toBeLessThanOrEqual(70);
      expect(delay).toBeGreaterThanOrEqual(30);
    },
    LONG,
  );

  it(
    '瞄準（球正對著一顆炸彈，從 19 個不同的來球位置各一次）：每個 tick 都決定的等級 10 全部瞄中，每 6 個 tick 才決定的人類節奏只瞄中約一半以下',
    () => {
      const aimed = (decideEvery: number): number => {
        let hits = 0;
        for (let xa = 30; xa <= 120; xa += 5) {
          let s = makeState({
            bombs: [55],
            balls: [{ x: xa, y: 150, vx: 0, vy: 2, owner: 1, respawn: 0 }, { respawn: 500 }],
            paddles: [{ x: 75 }, { x: 75 }],
          });
          const ctl = wrapPolicy(
            s4Game,
            precise,
            { reactionTicks: 12, decideEvery, depth: 1, epsilon: 0 },
            1,
          );
          for (let t = 0; t < 140 && s.score[0] === 0; t += 1) {
            s = s4Game.step(s, [ctl.decide(s, 0, t), NEUTRAL]);
          }
          hits += s.score[0] >= 6 ? 1 : 0;
        }
        return hits;
      };
      const every1 = aimed(1);
      const every6 = aimed(6);
      report(`瞄中炸彈：每 tick 決定 ${every1}/19、每 6 tick 決定 ${every6}/19`);
      expect(every1).toBeGreaterThanOrEqual(17);
      expect(every6).toBeLessThanOrEqual(11);
    },
    LONG,
  );
});

describe('S-4 量測｜四個性格的指紋（機制，DESIGN-AI-FUN 10.48）', () => {
  it(
    '每個性格等級 10 對精準型等級 10（精準、貪心、賭徒各 8 場，搜尋型 4 場，每個決定都量）：選到 danger ≥ 0.5 的決定占比，賭徒型 ≥ 5 倍精準型、貪心型與搜尋型 ≥ 2 倍；漏接率貪心型 ≥ 2 倍精準型；邊緣擊球（|o| ≥ 0.85）賭徒型 ≥ 10 倍',
    () => {
      const stats = (name: 'precise' | 'greedy' | 'gambler' | 'pathfinder') => {
        let decisions = 0;
        let high = 0;
        let hits = 0;
        let rim = 0;
        let penalties = 0;
        const policy: Policy = policyByName(name);
        const games = name === 'pathfinder' ? 4 : 8;
        for (let seed = 0; seed < games; seed += 1) {
          const side = sideOf(seed);
          const me = levelController(s4Game, policy, 10, seed);
          const seen: Controller<S4State> = {
            decide(s: S4State, who: Side, t: number): Buttons {
              const a = me.decide(s, who, t);
              const actions = s4Game.actions(s, who);
              const index = actions.findIndex((x) => JSON.stringify(x) === JSON.stringify(a));
              if (index >= 0) {
                decisions += 1;
                high +=
                  (lookOneStep(s4Game, s, who)[index] as { danger: number }).danger >= 0.5 ? 1 : 0;
              }
              return a;
            },
          };
          const rival = aiRival(10)(seed);
          const r = side === 0 ? record(seed, seen, rival) : record(seed, rival, seen);
          hits += r.hits[side];
          rim += r.rim[side];
          penalties += r.penalties[side];
        }
        return { high: high / decisions, rim: rim / hits, miss: penalties / (hits + penalties) };
      };
      const p = stats('precise');
      const g = stats('greedy');
      const b = stats('gambler');
      const s = stats('pathfinder');
      report(
        `指紋 danger≥0.5 占比：精準 ${p.high.toFixed(4)}、貪心 ${g.high.toFixed(4)}、賭徒 ${b.high.toFixed(4)}、搜尋 ${s.high.toFixed(4)}；` +
          `rimRate：${p.rim.toFixed(3)}／${g.rim.toFixed(3)}／${b.rim.toFixed(3)}／${s.rim.toFixed(3)}；` +
          `missRate：${p.miss.toFixed(3)}／${g.miss.toFixed(3)}／${b.miss.toFixed(3)}／${s.miss.toFixed(3)}`,
      );
      expect(b.high).toBeGreaterThanOrEqual(5 * Math.max(p.high, 0.005));
      expect(g.high).toBeGreaterThanOrEqual(2 * Math.max(p.high, 0.005));
      expect(s.high).toBeGreaterThanOrEqual(2 * Math.max(p.high, 0.005));
      expect(g.miss).toBeGreaterThanOrEqual(2 * p.miss);
      expect(b.rim).toBeGreaterThanOrEqual(10 * Math.max(p.rim, 0.005));
    },
    LONG,
  );
});

describe('S-4 量測｜wrapPolicy 的「自己是現在的」假設（DESIGN-AI-FUN 10.56）', () => {
  it(
    '球與對手都推不動板子：AI 做決定時，重播出來的自己的板子（x、v）與真實的現在逐 tick 相同（4 場，對劇本 (c) 與對 AI），所以不宣告 selfFromPresent',
    () => {
      let count = 0;
      let mismatch = 0;
      for (let seed = 0; seed < 4; seed += 1) {
        const side = sideOf(seed);
        let present: S4State | null = null;
        const spy: Policy = {
          name: 'spy',
          usesStall: false,
          decide(game, state, who, tick, params) {
            const s = state as unknown as S4State;
            const p = present as S4State;
            count += 1;
            if (s.paddles[who].x !== p.paddles[who].x || s.paddles[who].v !== p.paddles[who].v) {
              mismatch += 1;
            }
            return precise.decide(game, state, who, tick, params);
          },
        };
        const me = wrapPolicy(s4Game, spy, levelParams(10), seed);
        const rival = seed % 2 === 0 ? scripted('c') : ai(10, seed + 7);
        let s = s4Game.init(seed, CONTRACT);
        for (let t = 0; !s4Game.isOver(s); t += 1) {
          present = s;
          const a = me.decide(s, side, t);
          const b = rival.decide(s, side === 0 ? 1 : 0, t);
          s = s4Game.step(s, side === 0 ? [a, b] : [b, a]);
        }
      }
      report(`重播的自己與真實的現在：${count} 個決定，${mismatch} 個不同`);
      expect(count).toBeGreaterThan(5000);
      expect(mismatch).toBe(0);
    },
    LONG,
  );

  it('人類模型與等級 10 對同一個劇本的局面一致性：pointsFor 的偶數種子坐 0 號邊、奇數種子坐 1 號邊（量測的慣例）', () => {
    const even = pointsFor(0, humanModel, aiRival(1));
    const odd = pointsFor(1, humanModel, aiRival(1));
    expect(even.mySide).toBe(0);
    expect(odd.mySide).toBe(1);
  });
});
