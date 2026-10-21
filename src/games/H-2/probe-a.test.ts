import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC, divergence } from '../../../tests/ai/probe-a.shared';
import type { Buttons, Controller, Side } from '../../core/types';
import { IDLE, PRESS_A } from '../_hearts/logic';
import { h2Game, makeState } from './logic';
import type { H2State, Racer } from './logic';
import {
  B_FAMILY,
  C_FAMILY,
  LOCK_IN,
  START_LATE,
  THRESHOLDS,
  TWINS,
  member,
  withDelay,
} from './probe-a.members.test-helpers';
import {
  AI_SEED_OFFSET,
  CONFIG,
  MAIN_CELL,
  isPoint,
  playWith,
  score,
  selectBest,
  spec,
} from './probe-a.test-helpers';

/**
 * H-2 探針 A（完整版）的工具測試（`docs/cards/H-2.md`「探針 A（完整版）」）。
 * 只測量測工具本身：族的定義、(b) 不讀對手、(c) 真的讀、雙胞胎、反應延遲、不偷看引信、選法、分歧率的串接。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const holding = (acc: number): Racer => ({ status: 'holding', acc });
const waiting: Racer = { status: 'idle', acc: 0 };
const banked = (acc: number): Racer => ({ status: 'banked', acc });
const boom: Racer = { status: 'boom', acc: 0 };

/** 我（0 號邊）與對手（1 號邊）的一個局面。 */
function at(me: Racer, opp: Racer, extra: Partial<H2State> = {}): H2State {
  return makeState({ players: [me, opp], roundTick: 100, tick: 100, ...extra });
}

const pressed = (b: Buttons): boolean => b.a;
const ask = (name: string, state: H2State, side: Side = 0): boolean =>
  pressed(member(name).decide(state, side, state.tick));

/** 對手：每個 tick 都按著。 */
const holdForever: Controller<H2State> = { decide: () => PRESS_A };
/** 對手：一開始就按，累積到 `until` 就放開。 */
function holdUntil(until: number): Controller<H2State> {
  return {
    decide(state, side) {
      const me = state.players[side];
      if (me.status === 'idle') return PRESS_A;
      return me.status === 'holding' && me.acc < until ? PRESS_A : IDLE;
    },
  };
}

/** 跑完第 1 局（直到引信公開）。我是 0 號邊，`mine` 套上 `delay` 的延遲。 */
function firstRound(
  seed: number,
  mine: Controller<H2State>,
  opp: Controller<H2State>,
  delay = 0,
): H2State {
  let s = h2Game.init(seed, CONFIG);
  const m = withDelay(mine, delay);
  for (let t = 0; !s.revealed && !s.over && t < 3600; t += 1) {
    s = h2Game.step(s, [m.decide(s, 0, t), opp.decide(s, 1, t)]);
  }
  return s;
}

/** 第一個第 1 局引信落在 [lo, hi] 的種子。 */
function seedWithFuse(lo: number, hi: number, skip = 0): number {
  let seen = 0;
  for (let seed = 0; seed < 5000; seed += 1) {
    const f = h2Game.init(seed, CONFIG).fuse;
    if (f >= lo && f <= hi) {
      if (seen === skip) return seed;
      seen += 1;
    }
  }
  throw new Error('找不到種子');
}

describe('族的定義', () => {
  it('(b) 至少 5 個、(c) 至少 5 個，名字不重複，前綴對，每個都做得出控制器', () => {
    expect(B_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(C_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(new Set([...B_FAMILY, ...C_FAMILY]).size).toBe(B_FAMILY.length + C_FAMILY.length);
    for (const name of B_FAMILY) {
      expect(name.startsWith('b-')).toBe(true);
      expect(typeof member(name).decide).toBe('function');
    }
    for (const name of C_FAMILY) {
      expect(name.startsWith('c-')).toBe(true);
      expect(typeof member(name).decide).toBe('function');
    }
    expect(() => member('x-nothing')).toThrow();
    expect(() => member('b-nothing')).toThrow();
  });

  it('每個 (b) 成員（b-idle 除外）都有一個「全讀」的 (c) 雙胞胎；雙胞胎名字都在族裡', () => {
    for (const name of B_FAMILY) {
      if (name === 'b-idle') continue;
      expect(TWINS.some(([b, c]) => b === name && c === name.replace('b-', 'c-'))).toBe(true);
    }
    for (const [b, c] of TWINS) {
      expect((B_FAMILY as readonly string[]).includes(b)).toBe(true);
      expect((C_FAMILY as readonly string[]).includes(c)).toBe(true);
    }
    // 每個 (c) 成員都至少是一對雙胞胎的一邊（沒有孤兒）
    for (const c of C_FAMILY) {
      expect(
        TWINS.some(([, x]) => x === c),
        c,
      ).toBe(true);
    }
  });

  it('門檻裡有「必安全」的 118（引信至少 120，累積 118 放開必入袋）', () => {
    expect(THRESHOLDS).toContain(118);
    expect(THRESHOLDS).toContain(300);
  });
});

describe('(b) 的走法：開始與放開', () => {
  it('b-early 在第 1 個 tick 就按；b-late 到這一局第 58 個 tick 才按（還趕得上 60 tick 的限制）', () => {
    const t0 = at(waiting, waiting, { roundTick: 0, tick: 0 });
    expect(ask('b-early-300', t0)).toBe(true);
    expect(ask('b-late-300', t0)).toBe(false);
    expect(ask('b-late-300', { ...t0, roundTick: START_LATE - 1 })).toBe(false);
    expect(ask('b-late-300', { ...t0, roundTick: START_LATE })).toBe(true);
    expect(START_LATE).toBeGreaterThanOrEqual(50);
    expect(START_LATE).toBeLessThanOrEqual(59);
  });

  it('b-late 一整場都不會「遲到」（每一局都趕在 60 tick 內按下，得分不是被 late 吃掉）', () => {
    let s = h2Game.init(3, CONFIG);
    const ctl = member('b-late-118');
    for (let t = 0; !s.over && t < 3600; t += 1) {
      s = h2Game.step(s, [ctl.decide(s, 0, t), IDLE]);
      expect(s.players[0].status).not.toBe('late');
    }
    expect(s.totals[0]).toBe(118 * 5);
  });

  it('b-X-T：累積到 T 就放開（T−1 還按著，T 放開）；放開後這一局不再按', () => {
    for (const T of THRESHOLDS) {
      for (const start of ['early', 'late']) {
        const name = `b-${start}-${String(T)}`;
        expect(ask(name, at(holding(T - 1), waiting)), name).toBe(true);
        expect(ask(name, at(holding(T), waiting)), name).toBe(false);
        expect(ask(name, at(banked(T), waiting)), name).toBe(false);
        expect(ask(name, at(boom, waiting)), name).toBe(false);
      }
    }
  });

  it('b-late-118 對一個不按的對手：每局入袋 118，5 局 590（118 不會爆）', () => {
    let s = h2Game.init(9, CONFIG);
    const ctl = member('b-late-118');
    for (let t = 0; !s.over && t < 3600; t += 1) {
      s = h2Game.step(s, [ctl.decide(s, 0, t), IDLE]);
    }
    expect(s.totals[0]).toBe(590);
    expect(s.winner).toBe(0);
  });

  it('b-idle 從不按', () => {
    expect(ask('b-idle', at(waiting, waiting, { roundTick: 0, tick: 0 }))).toBe(false);
    expect(ask('b-idle', at(holding(5), waiting))).toBe(false);
  });
});

describe('(b) 不讀對手、全體不讀引信', () => {
  const mine: Racer[] = [waiting, holding(1), holding(60), holding(117), holding(118), holding(119)]
    .concat([holding(199), holding(200), holding(239), holding(240), holding(299), holding(300)])
    .concat([holding(339), holding(340), banked(100), boom]);
  const opps: Racer[] = [
    waiting,
    holding(10),
    holding(150),
    holding(250),
    banked(100),
    banked(250),
    boom,
  ];

  it('(b) 全部成員：對手的狀態與總分換掉，按鍵不變', () => {
    for (const name of B_FAMILY) {
      for (const m of mine) {
        for (const rt of [0, 58, 100, 400]) {
          const answers = new Set<boolean>();
          for (const o of opps) {
            for (const oppTotal of [0, 400]) {
              answers.add(ask(name, at(m, o, { roundTick: rt, tick: rt, totals: [0, oppTotal] })));
            }
          }
          expect(answers.size, `${name} ${JSON.stringify(m)} rt=${String(rt)}`).toBe(1);
        }
      }
    }
  });

  it('全部成員：引信長度（state 裡藏著的那個）換掉，按鍵不變', () => {
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      for (const m of mine) {
        for (const o of opps) {
          const a = ask(name, at(m, o, { fuse: 125 }));
          const b = ask(name, at(m, o, { fuse: 590 }));
          expect(a, `${name} ${JSON.stringify(m)}`).toBe(b);
        }
      }
    }
  });
});

describe('(c) 真的讀：insurance（炸掉的對手）與 cover（對手的下限）', () => {
  it('(c) 的 boom 讀法：對手炸了，就撐到「引信 − 2」放開；(b) 同門檻會炸成 0', () => {
    for (const delay of [0, 12]) {
      for (const [lo, hi] of [
        [140, 200],
        [200, 260],
      ] as const) {
        const seed = seedWithFuse(lo, hi);
        const fuse = h2Game.init(seed, CONFIG).fuse;
        const b = firstRound(seed, member('b-late-300'), holdForever, delay);
        const c = firstRound(seed, member('c-late-300-boom'), holdForever, delay);
        const both = firstRound(seed, member('c-late-300'), holdForever, delay);
        expect(b.roundScores[0][0], `b delay=${String(delay)} fuse=${String(fuse)}`).toBe(0);
        expect(c.roundScores[0][0], `boom delay=${String(delay)}`).toBe(fuse - 2);
        expect(both.roundScores[0][0], `both delay=${String(delay)}`).toBe(fuse - 2);
        // 只讀 cover 的不知道引信：在對手炸了之前已經在 cover 下撐著，之後照 T 放開，不會比 boom 好
        const cover = firstRound(seed, member('c-late-300-cover'), holdForever, delay);
        expect(cover.roundScores[0][0]).toBeLessThanOrEqual(fuse - 2);
      }
    }
  });

  it('(c) 的 cover 讀法：對手在 200 入袋，我（門檻 118）也撐到 200；(b) 只拿 118', () => {
    for (const delay of [0, 12]) {
      const seed = seedWithFuse(300, 580);
      const b = firstRound(seed, member('b-late-118'), holdUntil(200), delay);
      const c = firstRound(seed, member('c-late-118-cover'), holdUntil(200), delay);
      const both = firstRound(seed, member('c-late-118'), holdUntil(200), delay);
      expect(b.roundScores[0][0]).toBe(118);
      expect(c.roundScores[0][0]).toBe(200);
      expect(both.roundScores[0][0]).toBe(200);
      expect(c.roundScores[1][0]).toBe(200);
    }
  });

  it('cover 不會撐過下限：對手還按著（沒結束）時，我跟著它，但永遠不超過它「看到的累積 − 2」', () => {
    // 對手一直按著、引信很長：我（118 門檻）一路跟著，不會自己先炸
    const seed = seedWithFuse(560, 600);
    const c = firstRound(seed, member('c-late-118-cover'), holdForever, 12);
    expect(c.players[0].status).toBe('banked');
    expect(c.roundScores[0][0]).toBeGreaterThanOrEqual(118);
  });

  it('沒有東西可讀（對手不按）時，除了 lead 之外的 (c) 與它的 (b) 逐 tick 按鍵相同', () => {
    for (const [b, c] of TWINS) {
      if (c.endsWith('-lead')) continue;
      const mb = member(b);
      const mc = member(c);
      let sb = h2Game.init(4, CONFIG);
      let sc = h2Game.init(4, CONFIG);
      for (let t = 0; t < 1500 && !sb.over; t += 1) {
        const xb = mb.decide(sb, 0, t);
        const xc = mc.decide(sc, 0, t);
        expect(xc.a, `${b} → ${c} tick ${String(t)}`).toBe(xb.a);
        sb = h2Game.step(sb, [xb, IDLE]);
        sc = h2Game.step(sc, [xc, IDLE]);
      }
    }
  });

  it('(c) 的 lead 讀法：領先 100 以上就鎖分（118 放開），落後 100 以上多撐 40', () => {
    const lead = at(holding(118), waiting, { totals: [300, 100], round: 2 });
    const even = at(holding(118), waiting, { totals: [100, 100], round: 2 });
    const behind = at(holding(300), waiting, { totals: [0, 300], round: 2 });
    expect(ask('c-late-300-lead', lead)).toBe(false);
    expect(ask('b-late-300', lead)).toBe(true);
    expect(ask('c-late-300-lead', even)).toBe(true);
    expect(ask('c-late-300-lead', behind)).toBe(true); // 300 + 40 之前還按著
    expect(ask('b-late-300', behind)).toBe(false);
    expect(LOCK_IN).toBe(118);
  });
});

describe('反應延遲', () => {
  const asked = (delay: number, states: H2State[]): H2State[] => {
    const seen: H2State[] = [];
    const spy: Controller<H2State> = {
      decide(s) {
        seen.push(s);
        return IDLE;
      },
    };
    const ctl = withDelay(spy, delay);
    states.forEach((s) => ctl.decide(s, 0, s.tick));
    return seen;
  };

  it('delay 0 就是原控制器本身', () => {
    const inner = member('b-late-300');
    expect(withDelay(inner, 0)).toBe(inner);
  });

  it('對手的狀態與總分是 delay 個 tick 前的，自己的是現在的', () => {
    const states: H2State[] = Array.from({ length: 30 }, (_v, i) =>
      makeState({
        tick: 100 + i,
        roundTick: 70 + i,
        players: [holding(i + 1), holding(2 * i + 1)],
        totals: [i, 3 * i],
      }),
    );
    const seen = asked(12, states);
    const last = seen[seen.length - 1] as H2State;
    expect(last.players[0].acc).toBe(30); // 自己是現在的
    expect(last.players[1].acc).toBe(2 * 17 + 1); // 對手是 29 − 12 = 17 個 tick 的
    expect(last.totals[0]).toBe(29);
    expect(last.totals[1]).toBe(3 * 17);
    expect(last.tick).toBe(129);
  });

  it('跨局時，延遲的世界若是上一局的，對手當作還沒動（不拿上一局的 banked 當這一局的資訊）', () => {
    const prev = makeState({ tick: 100, round: 0, players: [banked(50), banked(200)] });
    const now = (tick: number): H2State =>
      makeState({ tick, round: 1, roundTick: tick - 100, players: [waiting, waiting] });
    const seen = asked(5, [prev, now(101), now(102), now(103), now(104), now(105)]);
    const last = seen[seen.length - 1] as H2State;
    expect(last.round).toBe(1);
    expect(last.players[1]).toEqual({ status: 'idle', acc: 0 });
  });
});

describe('對局與分歧率的串接', () => {
  it('playWith 跑得完一整場；同一個種子兩次結果相同；偶數種子坐 0 號邊、奇數種子坐 1 號邊', () => {
    const a = playWith(3, member('b-late-255'), MAIN_CELL);
    const b = playWith(3, member('b-late-255'), MAIN_CELL);
    expect(a).toEqual(b);
    expect(Number.isFinite(a.margin)).toBe(true);
    const side0 = playWith(4, member('b-idle'), MAIN_CELL);
    const side1 = playWith(5, member('b-idle'), MAIN_CELL);
    expect(side0.margin).toBeLessThanOrEqual(0);
    expect(side1.margin).toBeLessThanOrEqual(0);
  });

  it('isPoint：我這一邊正在按著（持住）的 tick 才是一次「繼續或放開」的決定', () => {
    expect(isPoint(at(holding(5), waiting), 0, 100)).toBe(true);
    expect(isPoint(at(waiting, holding(5)), 0, 100)).toBe(false);
    expect(isPoint(at(holding(5), waiting), 1, 100)).toBe(false);
    expect(isPoint(at(banked(5), waiting), 0, 100)).toBe(false);
    expect(isPoint(at(holding(5), waiting, { phase: 'pause' }), 0, 100)).toBe(false);
  });

  it('compareBC：自己對自己 → 分歧率 0、勝率差 0；上限成立、沒有一致性違規', () => {
    const r = compareBC(spec('b-late-255', 'b-late-255', [1, 2], MAIN_CELL));
    expect(r.divergence.gamesDiffer).toBe(0);
    expect(r.win.diff.mean).toBe(0);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
  });

  it('divergence：b-late-300 對 c-late-300 的點級分母 > 0（用的是自己的 isPoint）', () => {
    const d = divergence(spec('b-late-300', 'c-late-300', [1], MAIN_CELL));
    expect(d.pointBasis).toBe('isPoint');
    expect(d.points).toBeGreaterThan(0);
  });

  it('(b) 驅動的對局與單獨的 (b) 對局逐位元相同（影子不影響對局）', () => {
    const plain = playWith(5, member('b-late-300'), MAIN_CELL);
    const r = compareBC(spec('b-late-300', 'c-late-300', [5], MAIN_CELL));
    expect(r.margin.b.mean).toBe(plain.margin);
    expect(r.win.b).toBe(plain.win);
  });

  it('選法：勝率最高；同勝率取分差高；再同取靠前', () => {
    expect(
      selectBest([
        { name: 'a', win: 0.5, margin: 1 },
        { name: 'b', win: 0.7, margin: -5 },
        { name: 'c', win: 0.7, margin: 3 },
        { name: 'd', win: 0.7, margin: 3 },
      ]).name,
    ).toBe('c');
  });

  it('score：b-idle（地板）拿到的勝率與分差有意義（有限數字）', () => {
    const row = score('b-idle', [11, 12], MAIN_CELL);
    expect(row.win).toBeGreaterThanOrEqual(0);
    expect(row.win).toBeLessThanOrEqual(1);
    expect(Number.isFinite(row.margin)).toBe(true);
  });

  it('AI 的種子約定', () => {
    expect(AI_SEED_OFFSET).toBe(1_000_003);
  });
});

describe('(c) 不是 AI（10.61 第二個陷阱）；成員不讀引信', () => {
  const code = (file: string): string =>
    readFileSync(new URL(file, import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  it('成員檔的原始碼沒有 import evaluate、opponentAction、levelController、policyByName、各性格檔，也沒有讀 .fuse', () => {
    const text = code('./probe-a.members.test-helpers.ts');
    expect(text).not.toMatch(
      /\bevaluate\b|predictOpponent|opponentAction|levelController|policyByName|wrapPolicy|humanModel|human-model|policies\/|ai\/level|ai\/policies|ai\/human/,
    );
    expect(text).not.toMatch(/from ['"][^'"]*\/ai\//);
    expect(text).not.toMatch(/\.fuse\b|\bfuse\s*[,}:]/);
  });

  it('成員檔與 logic.ts 都沒有時鐘與亂數', () => {
    for (const file of ['./probe-a.members.test-helpers.ts', './logic.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text).not.toMatch(/Math\.random|Date\.now|performance\.now|setTimeout|setInterval/);
    }
  });
});
