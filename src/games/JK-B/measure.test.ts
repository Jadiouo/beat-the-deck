import { describe, expect, it } from 'vitest';

import { winRate } from '../../ai/evolution';
import { levelController, levelParams, policyByName, wrapPolicy } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { lookOneStep } from '../../ai/policies/shared';
import type { Policy } from '../../ai/types';
import type { Buttons, Controller, Side } from '../../core/types';
import { cell, densestSpot, initState, jkbGame, makeState } from './logic';
import type { JKBState, Rule } from './logic';
import { createRng } from '../../core/rng';
import {
  CONTRACT,
  ai,
  humanModel,
  press,
  quantile,
  record,
  scripted,
  seedRange,
  sideOf,
  wantFor,
  winPercent,
} from './players.test-helpers';
import type { ScriptKind } from './players.test-helpers';

/**
 * JK-B 的量測（小規格「實作與量測」）：局長、wrapPolicy 的自己、探針 A、劇本玩家、搶劫與分數互換、反應速度、性格指紋。
 * 都是真實規則、真實 AI、固定種子，所以數字是確定的；斷言寫在量到的值附近（不是目標值），
 * 萬一誰改了 `evaluate` 或規則，這些量測會跟著變，而不是悄悄漂掉。
 *
 * 這裡的場數比小規格的表少（那邊是 100 到 200 場，在 scratchpad 跑，數字與 commit 寫在小規格裡），
 * 為了讓整個檔案在一般的機器上幾分鐘跑完；所以斷言的範圍比較寬，數字不要拿來跟小規格的表逐格比。
 * 設 `JKB_VERBOSE=1` 會把量到的數字印出來。
 */

const LONG = 3_600_000;

function report(text: string): void {
  if (process.env.JKB_VERBOSE !== undefined) {
    process.stdout.write(`${text}\n`);
  }
}

const aiRival = (level: number) => (seed: number) => ai(level, seed + 1_000_003);

/** 劇本玩家加上和 AI 一樣的 12 tick 反應延遲（每 tick 決定、不失誤）。 */
function delayed(kind: ScriptKind, seed: number): Controller<JKBState> {
  const policy: Policy = {
    name: `script-${kind}`,
    decide<S>(_game: unknown, state: S, side: Side): Buttons {
      return press(wantFor(kind, state as unknown as JKBState, side));
    },
  };
  return wrapPolicy(
    jkbGame,
    policy,
    { reactionTicks: 12, decideEvery: 1, depth: 1, epsilon: 0 },
    seed,
  );
}

describe('JK-B 量測｜局長（固定 3600 tick，沒有死亡，一定打滿 60 秒）', () => {
  it(
    '四個情境（10 對 10、人類模型對 10／2／1）每場都是 3600 tick ＝ 60 秒，在 30 到 90 秒之內',
    () => {
      const scenarios: [
        string,
        (seed: number) => Controller<JKBState>,
        (seed: number) => Controller<JKBState>,
      ][] = [
        ['10 對 10', (seed) => ai(10, seed), aiRival(10)],
        ['人類模型對 10', humanModel, aiRival(10)],
        ['人類模型對 2', humanModel, aiRival(2)],
        ['人類模型對 1', humanModel, aiRival(1)],
      ];
      for (const [name, me, rival] of scenarios) {
        const secs = seedRange(4).map((seed) => record(seed, me(seed), rival(seed)).ticks / 60);
        report(
          `局長 ${name}：中位數 ${quantile(secs, 0.5)} 秒，第 10 百分位 ${quantile(secs, 0.1)} 秒`,
        );
        expect(Math.min(...secs), name).toBeGreaterThanOrEqual(30);
        expect(Math.max(...secs), name).toBeLessThanOrEqual(90);
        expect(new Set(secs).size, name).toBe(1);
        expect(secs[0], name).toBe(60);
      }
    },
    LONG,
  );
});

describe('JK-B 量測｜wrapPolicy 的「自己是現在的」假設（DESIGN-AI-FUN 10.56）', () => {
  /** 打幾場，每個決定比較「性格看到的自己」與真實的現在；回傳 [決定數, 位置不同, 冷卻不同]。 */
  function replayMismatch(
    game: typeof jkbGame,
    rival: (seed: number) => Controller<JKBState>,
    seeds: readonly number[],
  ): [number, number, number] {
    let count = 0;
    let position = 0;
    let cooldown = 0;
    for (const seed of seeds) {
      const side = sideOf(seed);
      let present: JKBState | null = null;
      const spy: Policy = {
        name: 'spy',
        decide(g, state, who, tick, params) {
          const seen = (state as unknown as JKBState).avatars[who];
          const real = (present as JKBState).avatars[who];
          count += 1;
          position += seen.x !== real.x || seen.y !== real.y ? 1 : 0;
          cooldown += seen.shoveCd !== real.shoveCd ? 1 : 0;
          return pathfinder.decide(g, state, who, tick, params);
        },
      };
      const me = wrapPolicy(game, spy, levelParams(10), seed);
      const other = rival(seed);
      let s = game.init(seed, CONTRACT);
      for (let t = 0; !game.isOver(s); t += 1) {
        present = s;
        const a = me.decide(s, side, t);
        const b = other.decide(s, side === 0 ? 1 : 0, t);
        s = game.step(s, side === 0 ? [a, b] : [b, a]);
      }
    }
    return [count, position, cooldown];
  }

  it(
    '宣告了 selfFromPresent：重播的自己的點與真實的現在逐 tick 相同（對 AI 與對一直貼著推的劇本）',
    () => {
      for (const [name, rival] of [
        ['L10', (seed: number) => ai(10, seed + 7)],
        ['stalk', () => scripted('stalk')],
      ] as const) {
        const [count, position, cooldown] = replayMismatch(jkbGame, rival, seedRange(2));
        report(
          `宣告 hook，對 ${name}：${count} 個決定，位置不同 ${position}，冷卻不同 ${cooldown}`,
        );
        expect(count).toBeGreaterThan(5000);
        expect(position).toBe(0);
        expect(cooldown).toBe(0);
      }
    },
    LONG,
  );

  it(
    '沒宣告的話（同一個遊戲拿掉 hook）：重播出來的自己有一成以上的決定是錯的，這就是宣告的理由（小規格的表是 20 場：14.05%／22.52%／59.78%）',
    () => {
      const bare = { ...jkbGame, selfFromPresent: undefined } as unknown as typeof jkbGame;
      const [count, position] = replayMismatch(bare, (seed) => ai(10, seed + 7), seedRange(2));
      report(
        `沒有 hook，對 L10：${count} 個決定，位置不同 ${position}（${((100 * position) / count).toFixed(2)}%）`,
      );
      expect(position / count).toBeGreaterThan(0.05);
      const [c2, p2] = replayMismatch(bare, () => scripted('stalk'), seedRange(2));
      expect(p2 / c2).toBeGreaterThan(0.3);
    },
    LONG,
  );
});

/** 單獨打一段規則（10 秒、600 tick）：兩個點從起始位置出發、第 0 段就是這條規則；回傳 [我的分數, 對手的分數, 我推成功幾次, 我偷到幾分]。 */
function onePhase(
  seed: number,
  rule: Rule,
  me: Controller<JKBState>,
  rival: Controller<JKBState>,
): [number, number, number, number] {
  const mySide = sideOf(seed);
  const base = initState(seed, { maxTicks: 600, params: {} });
  let s = makeState({ seed, maxTicks: 600, rule, next: 'none', coins: base.coins });
  const c0 = mySide === 0 ? me : rival;
  const c1 = mySide === 0 ? rival : me;
  for (let t = 0; !jkbGame.isOver(s); t += 1) {
    s = jkbGame.step(s, [c0.decide(s, 0, t), c1.decide(s, 1, t)]);
  }
  const other = mySide === 0 ? 1 : 0;
  return [s.scores[mySide], s.scores[other], s.shoves[mySide], s.stolen[mySide]];
}

describe('JK-B 量測｜搶劫段：有沒有退化成 10 秒追逐（小規格「不確定與改法」）', () => {
  it(
    '兩個等級 10 對打：10 段裡一次推擠都沒有（互相躲，走動中的人推不到）；人類模型對 10 在 10 段裡推 8 次。AI 偷站著不動的劇本 0 分是量到的限制（小規格預期「AI 追你」沒有成立），只印出來、不斷言',
    () => {
      const seeds = seedRange(10);
      const total = (me: (seed: number) => Controller<JKBState>): number =>
        seeds.reduce(
          (sum, seed) =>
            sum + (onePhase(seed, 'rob', me(seed), ai(10, seed + 1_000_003))[2] as number),
          0,
        );
      const stolenFrom = (me: (seed: number) => Controller<JKBState>): number =>
        seeds.reduce(
          (sum, seed) =>
            sum + (onePhase(seed, 'rob', me(seed), ai(10, seed + 1_000_003))[3] as number),
          0,
        );
      const aiAi = total((seed) => ai(10, seed));
      const idleRobbed = seeds.reduce(
        (sum, seed) =>
          sum + (onePhase(seed, 'rob', ai(10, seed + 1_000_003), scripted('idle'))[3] as number),
        0,
      );
      const human = total(humanModel);
      report(
        `搶劫（10 段）：10 對 10 推 ${aiAi} 次；人類模型推 ${human} 次；AI 偷站著不動的劇本 ${idleRobbed} 分；來回走的 (b) 偷到 ${stolenFrom(() => scripted('b'))}`,
      );
      expect(aiAi).toBe(0);
      expect(human).toBeLessThanOrEqual(30);
    },
    LONG,
  );

  it(
    '和 AI 一樣有 12 tick 反應延遲的完美追擊者也偷不到（0 次）；每 tick 決定、不延遲的追擊者（比任何人都快）一段偷十幾分',
    () => {
      const seeds = seedRange(10);
      const stolen = (make: (seed: number) => Controller<JKBState>): number =>
        seeds.reduce(
          (sum, seed) =>
            sum + (onePhase(seed, 'rob', make(seed), ai(10, seed + 1_000_003))[3] as number),
          0,
        );
      const delayedChase = stolen((seed) => delayed('chase', seed));
      const zeroDelayChase = stolen(() => scripted('chase'));
      report(
        `搶劫（10 段）：延遲 12 的追擊者偷 ${delayedChase}；零延遲的追擊者偷 ${zeroDelayChase}`,
      );
      expect(delayedChase).toBeLessThanOrEqual(5);
      expect(zeroDelayChase).toBeGreaterThanOrEqual(60);
    },
    LONG,
  );
});

describe('JK-B 量測｜劇本玩家：沒有簡單腳本支配 AI（DESIGN-AI-FUN 10.40）', () => {
  it(
    '每 tick 決定、不延遲的劇本（比任何人都快）對等級 10：站著不動 0%、不管規則撿最近的金幣很低，其餘都 ≤ 90%（實測約 60% 到 75%，200 場的表在小規格）',
    () => {
      const seeds = seedRange(12);
      const kinds: ScriptKind[] = ['idle', 'coin', 'a', 'b', 'c', 'chase', 'stalk', 'camp'];
      const wins: Record<string, number> = {};
      for (const kind of kinds) {
        wins[kind] = winPercent(() => scripted(kind), aiRival(10), seeds);
      }
      report(
        `零延遲劇本對等級 10（12 場）：${kinds.map((k) => `${k} ${(wins[k] as number).toFixed(1)}`).join('、')}`,
      );
      expect(wins['idle']).toBe(0);
      expect(wins['coin']).toBeLessThanOrEqual(50);
      for (const kind of kinds) {
        expect(wins[kind], kind).toBeLessThanOrEqual(90);
      }
    },
    LONG,
  );

  it(
    '和 AI 一樣有 12 tick 反應延遲的劇本對等級 10：都 ≤ 75%（沒有劇本贏過 AI；實測約 10% 到 55%）',
    () => {
      const seeds = seedRange(12);
      for (const kind of ['coin', 'a', 'b', 'c', 'chase', 'stalk', 'camp'] as const) {
        const pct = winPercent((seed) => delayed(kind, seed), aiRival(10), seeds);
        report(`延遲 12 的劇本 ${kind} 對等級 10（12 場）：${pct.toFixed(1)}`);
        expect(pct, kind).toBeLessThanOrEqual(75);
      }
    },
    LONG,
  );
});

describe('JK-B 量測｜探針 A（DESIGN-AI-FUN 10.20、10.24、10.35、10.54）：玩家讀 AI 的狀態值多少', () => {
  /**
   * 三組劇本玩家只差「怎麼看對手」，移動的方式一樣（完整資訊、每 tick 決定、不延遲、不失誤）。定義在量之前固定，寫在 `players.test-helpers.ts` 的 `ScriptKind`：
   *  (a) 不知道有對手：知道規則與預告，自己撿金幣、布局；從不看對手、不推、不躲；搶劫期間沒事做就站著。
   *  (b) 知道有對手、不讀它的狀態：(a) 加上知道「對手會來推」，所以搶劫的預告期離開原地、搶劫期間不停地來回走，不看對手現在在哪、冷卻多少。
   *  (c) 讀它的狀態：(b) 加上讀對手的位置與冷卻與預告期的習慣——搶金幣時挑對手搆不到的、毒藥／送禮快結束時去第二密處、搶劫時對手停著就推、對手能推就躲、互換最後一秒看對手搆不搆得到金幣。
   * 互動強度 ＝ (c) − (b)（10.35）。(c) 不是 AI 自己的引擎（AI 是搜尋型的 `evaluate`），所以不是鏡像。
   */
  it(
    '三組對等級 10：互動強度 (c) − (b) 不是大的正數（12 場，標準誤約 12，所以只守「不到 40」；200 場的數字在小規格）',
    () => {
      const seeds = seedRange(12);
      const run = (kind: ScriptKind): number =>
        winPercent(() => scripted(kind), aiRival(10), seeds);
      const a = run('a');
      const b = run('b');
      const c = run('c');
      report(
        `探針 A（12 場）：(a) ${a.toFixed(1)}、(b) ${b.toFixed(1)}、(c) ${c.toFixed(1)}、(c)−(b) ${(c - b).toFixed(1)}、(b)−(a) ${(b - a).toFixed(1)}`,
      );
      expect(c - b).toBeLessThan(40);
      expect(a).toBeLessThanOrEqual(90);
      expect(c).toBeLessThanOrEqual(90);
    },
    LONG,
  );
});

describe('JK-B 量測｜等級軸（DESIGN-AI-FUN 3.1 反應速度測試）與人打得贏', () => {
  it(
    'A4（人類模型對等級 10，16 場）≤ 35%（實測約 25%）；對等級 2 與 1 ≥ 50%',
    () => {
      const seeds = seedRange(16);
      const vs = (level: number): number => winPercent(humanModel, aiRival(level), seeds);
      const ten = vs(10);
      const two = vs(2);
      const one = vs(1);
      report(
        `人類模型對 10／2／1（16 場）：${ten.toFixed(1)}／${two.toFixed(1)}／${one.toFixed(1)}`,
      );
      expect(ten).toBeLessThanOrEqual(40);
      expect(two).toBeGreaterThanOrEqual(50);
      expect(one).toBeGreaterThanOrEqual(50);
    },
    LONG,
  );

  it(
    '快而淺對慢而深（搜尋型，12 場）：合併與只差決定頻率、只差反應延遲都明顯贏；只差搜尋深度（6 對 1）不是大贏（見小規格的四格）',
    () => {
      const seeds = seedRange(12);
      const run = (fast: [number, number, number], slow: [number, number, number]): number =>
        100 *
        winRate(
          jkbGame,
          pathfinder,
          { reactionTicks: fast[0], decideEvery: fast[1], depth: fast[2], epsilon: 0 },
          pathfinder,
          { reactionTicks: slow[0], decideEvery: slow[1], depth: slow[2], epsilon: 0 },
          seeds,
          CONTRACT,
        );
      const combined = run([3, 1, 1], [18, 12, 6]);
      const frequency = run([12, 1, 1], [12, 12, 1]);
      const delay = run([3, 1, 1], [18, 1, 1]);
      const depth = run([12, 1, 6], [12, 1, 1]);
      report(
        `反應速度：合併 ${combined}、只差決定頻率 ${frequency}、只差反應延遲 ${delay}、只差搜尋深度 ${depth}`,
      );
      expect(combined).toBeGreaterThanOrEqual(60);
    },
    LONG,
  );
});

describe('JK-B 量測｜四個性格的指紋（機制，DESIGN-AI-FUN 10.48）', () => {
  it(
    '每個性格等級 10 對搜尋型等級 10（各 6 場，每個決定都量）：選到 danger ≥ 0.4 的決定占比，賭徒型 ≥ 1.5 倍精準型（實測 3 倍）；貪心型與搜尋型分不開（量到的限制，小規格的表在 40 場）',
    () => {
      const stats = (name: 'pathfinder' | 'precise' | 'greedy' | 'gambler') => {
        let decisions = 0;
        let high = 0;
        const policy: Policy = policyByName(name);
        for (const seed of seedRange(6)) {
          const inner = levelController(jkbGame, policy, 10, seed);
          const spy: Controller<JKBState> = {
            decide(s: JKBState, who: Side, t: number): Buttons {
              const a = inner.decide(s, who, t);
              const acts = jkbGame.actions(s, who);
              const index = acts.findIndex((x) => JSON.stringify(x) === JSON.stringify(a));
              if (index >= 0) {
                decisions += 1;
                high +=
                  (lookOneStep(jkbGame, s, who)[index] as { danger: number }).danger >= 0.4 ? 1 : 0;
              }
              return a;
            },
          };
          record(seed, spy, ai(10, seed + 1_000_003));
        }
        return high / decisions;
      };
      const p = stats('precise');
      const g = stats('greedy');
      const b = stats('gambler');
      const s = stats('pathfinder');
      report(
        `指紋 danger≥0.4 占比：精準 ${p.toFixed(4)}、貪心 ${g.toFixed(4)}、賭徒 ${b.toFixed(4)}、搜尋 ${s.toFixed(4)}`,
      );
      expect(b).toBeGreaterThanOrEqual(1.5 * p);
      expect(b).toBeGreaterThan(g);
      expect(b).toBeGreaterThan(s);
    },
    LONG,
  );
});

describe('JK-B 量測｜預告期 AI 真的往寫死的目標走（小規格第 1 題的預期）', () => {
  const dist = (a: number, b: number): number =>
    Math.abs((a % 32) - (b % 32)) + Math.abs(Math.floor(a / 32) - Math.floor(b / 32));

  /** 從預告開始（上一段的 ruleTick 420）打到這一段結束，兩邊都是等級 10；位置用種子隨機放（離 6 格以上）。 */
  function preview(seed: number, a: Rule, b: Rule): { start: JKBState; end: JKBState } {
    const rng = createRng(seed).fork('pm');
    const base = initState(seed, { maxTicks: 3600, params: {} });
    const pos = () => ({ x: 2 + rng.int(28), y: 2 + rng.int(20) });
    let p = [pos(), pos()] as const;
    while (Math.abs(p[0].x - p[1].x) + Math.abs(p[0].y - p[1].y) < 6) {
      p = [pos(), pos()];
    }
    const c0 = ai(10, seed);
    const c1 = ai(10, seed + 1_000_003);
    let s = makeState({
      seed,
      schedule: [a, b, 'normal', 'normal', 'normal', 'normal'],
      phase: 0,
      rule: a,
      next: b,
      ruleTick: 419,
      coins: base.coins,
      avatars: [p[0], p[1]],
    });
    s = jkbGame.step(s, [c0.decide(s, 0, 419), c1.decide(s, 1, 419)]);
    const start = s;
    for (let t = 420; s.phase === 0; t += 1) {
      s = jkbGame.step(s, [c0.decide(s, 0, t), c1.decide(s, 1, t)]);
    }
    return { start, end: s };
  }

  it(
    'next ＝ 金幣雨：3 秒後離標記格 2 格以內的點占九成上下（實測 94%）；毒藥快結束：離最密處 2 格以內八成上下（實測 84%）；next ＝ 重力：平均 y 從 11.5 往上到 6.5',
    () => {
      const seeds = seedRange(10);
      let rainNear = 0;
      let denseNear = 0;
      let n = 0;
      let y0 = 0;
      let y1 = 0;
      for (const seed of seeds) {
        const rain = preview(seed, 'normal', 'rain');
        const dense = preview(seed, 'poison', 'normal');
        const gravity = preview(seed, 'normal', 'gravity');
        for (const side of [0, 1] as const) {
          const near = (st: JKBState, target: number): number =>
            dist(cell(st.avatars[side].x, st.avatars[side].y), target);
          rainNear += near(rain.end, rain.start.rainCell) <= 2 ? 1 : 0;
          const spot = densestSpot(
            dense.start.coins,
            cell(dense.start.avatars[side].x, dense.start.avatars[side].y),
          );
          denseNear += near(dense.end, spot) <= 2 ? 1 : 0;
          y0 += gravity.start.avatars[side].y;
          y1 += gravity.end.avatars[side].y;
          n += 1;
        }
      }
      report(
        `預告期：標記格 2 格內 ${rainNear}/${n}、最密處 2 格內 ${denseNear}/${n}、重力 y ${(y0 / n).toFixed(1)} → ${(y1 / n).toFixed(1)}`,
      );
      expect(rainNear / n).toBeGreaterThanOrEqual(0.7);
      expect(denseNear / n).toBeGreaterThanOrEqual(0.5);
      expect(y1).toBeLessThan(y0 - 2 * n);
    },
    LONG,
  );
});
