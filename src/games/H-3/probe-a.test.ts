import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC, divergence } from '../../../tests/ai/probe-a.shared';
import type { Buttons, Controller, Side } from '../../core/types';
import { IDLE } from '../_hearts/logic';
import { TRACK, h3Game, makeState } from './logic';
import type { H3State, Runner } from './logic';
import {
  B_FAMILY,
  C_FAMILY,
  LEAD_GAP,
  MARGINS,
  POSITIONS,
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
  selectDeviating,
  spec,
  withJitter,
} from './probe-a.test-helpers';

/**
 * H-3 探針 A（完整版）的工具測試（`docs/cards/H-3.md`「探針 A（完整版）」）。
 * 只測量測工具本身：族的定義、(b) 不讀對手、(c) 真的讀、雙胞胎、反應延遲、執行抖動、選法、分歧率的串接。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const running = (pos: number, speed = 1000, age = 0): Runner => ({
  status: 'running',
  pos,
  speed,
  age,
});
const stopped = (pos: number): Runner => ({ status: 'stopped', pos, speed: 0, age: 0 });
const braking = (pos: number, speed = 1000): Runner => ({ status: 'braking', pos, speed, age: 0 });
const fallen: Runner = { status: 'fallen', pos: TRACK + 1, speed: 0, age: 0 };

function at(me: Runner, opp: Runner, extra: Partial<H3State> = {}): H3State {
  return makeState({ runners: [me, opp], tick: 100, roundTick: 100, ...extra });
}

const ask = (name: string, state: H3State, side: Side = 0): boolean =>
  member(name).decide(state, side, state.tick).a;

/** 對手：不煞車（一路衝下去）。 */
const never: Controller<H3State> = { decide: (): Buttons => IDLE };

/** 我（0 號邊）跑一局到我的跑者結束；對手不煞車。回傳最後的 state。 */
function runRound(name: string, v0: number, extra: Partial<H3State> = {}): H3State {
  let s = makeState({
    v0,
    runners: [
      { status: 'running', pos: 0, speed: v0, age: 0 },
      { status: 'running', pos: 0, speed: v0, age: 0 },
    ],
    ...extra,
  });
  const ctl = member(name);
  for (
    let t = 0;
    t < 700 && s.runners[0].status !== 'stopped' && s.runners[0].status !== 'fallen';
    t += 1
  ) {
    s = h3Game.step(s, [ctl.decide(s, 0, t), never.decide(s, 1, t)]);
  }
  return s;
}

/** 順著跑，回傳第一次按下 a 時的位置（千分之一像素）；一直沒按回傳 null。 */
function firstBrakePos(
  name: string,
  extra: Partial<H3State>,
  opp: Runner = running(0),
): number | null {
  let s = makeState({
    v0: 1000,
    runners: [running(0), opp],
    ...extra,
  });
  const ctl = member(name);
  for (let t = 0; t < 400 && s.runners[0].status === 'running'; t += 1) {
    const pressed = ctl.decide(s, 0, t).a;
    if (pressed) return s.runners[0].pos;
    const moved = h3Game.step(s, [IDLE, IDLE]);
    // 對手的樣子固定不動（我們要的是「我煞車的那一刻看到的對手」）
    s = { ...moved, runners: [moved.runners[0], opp] };
  }
  return null;
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

  it('每個 (b) 成員（b-never 除外）都有 lead 與 last 兩個 (c) 雙胞胎；雙胞胎名字都在族裡；沒有孤兒', () => {
    for (const name of B_FAMILY) {
      if (name === 'b-never') continue;
      for (const kind of ['lead', 'last']) {
        expect(
          TWINS.some(([b, c]) => b === name && c === `${name.replace('b-', 'c-')}-${kind}`),
        ).toBe(true);
      }
    }
    for (const [b, c] of TWINS) {
      expect((B_FAMILY as readonly string[]).includes(b)).toBe(true);
      expect((C_FAMILY as readonly string[]).includes(c)).toBe(true);
    }
    for (const c of C_FAMILY) {
      expect(
        TWINS.some(([, x]) => x === c),
        c,
      ).toBe(true);
    }
  });

  it('邊距裡有 0（精確煞在邊緣）', () => {
    expect(MARGINS).toContain(0);
    expect(POSITIONS.length).toBeGreaterThanOrEqual(3);
  });
});

describe('(b) 的走法', () => {
  it('b-never 一直不煞車；跑者掉下去、停下來之後也不按', () => {
    expect(ask('b-never', at(running(0), running(0)))).toBe(false);
    expect(ask('b-never', at(running(299000), running(0)))).toBe(false);
  });

  it('b-pos-P：位置到 P 才按；沒到不按；已經停下或掉下去不按', () => {
    for (const P of POSITIONS) {
      const name = `b-pos-${String(P)}`;
      expect(ask(name, at(running(P * 1000 - 1), running(0))), name).toBe(false);
      expect(ask(name, at(running(P * 1000), running(0))), name).toBe(true);
      expect(ask(name, at(stopped(P * 1000), running(0))), name).toBe(false);
      expect(ask(name, at(fallen, running(0))), name).toBe(false);
    }
  });

  it('b-exact-M：每個起始速度都停得下來，停點在 300 − M 之前 6 像素以內（逐 tick 的最後一刻才煞）', () => {
    for (const M of MARGINS) {
      for (let v0 = 800; v0 <= 1200; v0 += 25) {
        const s = runRound(`b-exact-${String(M)}`, v0);
        const r = s.runners[0];
        expect(r.status, `M=${String(M)} v0=${String(v0)}`).toBe('stopped');
        expect(r.pos, `M=${String(M)} v0=${String(v0)}`).toBeLessThanOrEqual(TRACK - M * 1000);
        expect(r.pos, `M=${String(M)} v0=${String(v0)}`).toBeGreaterThanOrEqual(
          TRACK - M * 1000 - 6000,
        );
      }
    }
  });

  it('b-exact-0 在 300 邊緣：5 局得分都至少 296', () => {
    let s = h3Game.init(3, CONFIG);
    const ctl = member('b-exact-0');
    for (let t = 0; !s.over && t < 3600; t += 1) {
      s = h3Game.step(s, [ctl.decide(s, 0, t), IDLE]);
    }
    expect(s.over).toBe(true);
    for (const x of s.roundScores[0]) {
      expect(x).toBeGreaterThanOrEqual(296);
      expect(x).toBeLessThanOrEqual(300);
    }
  });
});

describe('(b) 不讀對手', () => {
  it('(b) 全部成員：對手的跑者與總分換掉，按鍵不變', () => {
    const opps: Runner[] = [running(0), running(150000, 1500), stopped(250000), fallen];
    for (const name of B_FAMILY) {
      for (const pos of [
        0, 100000, 199999, 200000, 269999, 270000, 284999, 285000, 290000, 298000,
      ]) {
        const answers = new Set<boolean>();
        for (const o of opps) {
          for (const oppTotal of [0, 600]) {
            answers.add(
              ask(name, at(running(pos, 1100, 7), o, { totals: [0, oppTotal], round: 2 })),
            );
          }
        }
        expect(answers.size, `${name} pos=${String(pos)}`).toBe(1);
      }
    }
  });
});

describe('(c) 真的讀', () => {
  it('lead：領先 100 以上就更早煞（更保險），落後 100 以上更晚煞；其餘與 (b) 相同', () => {
    for (const base of ['exact-8', 'pos-270']) {
      const b = firstBrakePos(`b-${base}`, { totals: [0, 0], round: 2 }) as number;
      const even = firstBrakePos(`c-${base}-lead`, { totals: [50, 0], round: 2 }) as number;
      const ahead = firstBrakePos(`c-${base}-lead`, { totals: [LEAD_GAP, 0], round: 2 }) as number;
      const behind = firstBrakePos(`c-${base}-lead`, { totals: [0, LEAD_GAP], round: 2 }) as number;
      expect(even, base).toBe(b);
      expect(ahead, base).toBeLessThan(b);
      expect(behind, base).toBeGreaterThan(b);
    }
  });

  it('exact-0 在落後時不能更晚（已經是邊緣）；領先時才會更早', () => {
    const b = firstBrakePos('b-exact-0', {}) as number;
    expect(firstBrakePos('c-exact-0-lead', { totals: [0, 300], round: 2 })).toBe(b);
    expect(firstBrakePos('c-exact-0-lead', { totals: [300, 0], round: 2 }) as number).toBeLessThan(
      b,
    );
  });

  it('last：只在最後一局、對手已經結束時讀；領先就保險，必輸就孤注一擲，其餘與 (b) 相同', () => {
    const name = 'exact-8';
    const base = firstBrakePos(`b-${name}`, {}) as number;
    const lastRound = { round: 4 };
    // 不是最後一局：讀了也不變
    expect(
      firstBrakePos(
        `c-${name}-last`,
        { ...lastRound, round: 2, totals: [100, 0] },
        stopped(250000),
      ),
    ).toBe(base);
    // 最後一局、對手還在跑：不變
    expect(firstBrakePos(`c-${name}-last`, { ...lastRound, totals: [100, 0] }, running(10))).toBe(
      base,
    );
    // 最後一局、對手已結束：我領先 → 更早
    expect(
      firstBrakePos(
        `c-${name}-last`,
        { ...lastRound, totals: [500, 250] },
        stopped(250000),
      ) as number,
    ).toBeLessThan(base);
    // 必輸（落後 > 300）→ 孤注一擲：更晚（到 0 邊距）
    expect(
      firstBrakePos(
        `c-${name}-last`,
        { ...lastRound, totals: [0, 700] },
        stopped(250000),
      ) as number,
    ).toBeGreaterThan(base);
    // 對手正在煞車（結果已經由煞車距離決定，畫面上看得到）：照它會停的位置算
    // 煞車中：240000 + 10500 ＝ 250500 → 250 分（會停在邊緣內）；總分 500 對 0：領先 → 更早
    expect(
      firstBrakePos(
        `c-${name}-last`,
        { ...lastRound, totals: [500, 0] },
        braking(240000),
      ) as number,
    ).toBeLessThan(base);
    // 煞車中但會衝出去（掉下去，0 分）：總分 100 對 0 → 仍然領先 → 更早；落後 700 對煞車中的 250 → 必輸 → 更晚
    expect(
      firstBrakePos(
        `c-${name}-last`,
        { ...lastRound, totals: [0, 700] },
        braking(240000),
      ) as number,
    ).toBeGreaterThan(base);
    // 煞車中、勢均力敵（總分 0 對 250 加上預測的 250 ＝ 落後 500，不是勢均力敵；改成 250 對 0 加上預測 250 ＝ 平手 → 與 (b) 相同）
    expect(
      firstBrakePos(`c-${name}-last`, { ...lastRound, totals: [250, 0] }, braking(240000)),
    ).toBe(base);
    // 勢均力敵：與 (b) 相同
    expect(
      firstBrakePos(`c-${name}-last`, { ...lastRound, totals: [100, 250] }, stopped(250000)),
    ).toBe(base);
  });

  it('雙胞胎：沒有東西可讀（第 1 局、總分相同、對手還在跑）時，每一對逐 tick 按鍵相同', () => {
    for (const [b, c] of TWINS) {
      for (const v0 of [800, 1000, 1200]) {
        const mb = member(b);
        const mc = member(c);
        let s = makeState({
          v0,
          runners: [
            { status: 'running', pos: 0, speed: v0, age: 0 },
            { status: 'running', pos: 0, speed: v0, age: 0 },
          ],
        });
        for (let t = 0; t < 400 && s.runners[0].status === 'running'; t += 1) {
          const xb = mb.decide(s, 0, t);
          const xc = mc.decide(s, 0, t);
          expect(xc.a, `${b} → ${c} v0=${String(v0)} tick ${String(t)}`).toBe(xb.a);
          s = h3Game.step(s, [xb, IDLE]);
        }
      }
    }
  });
});

describe('反應延遲與執行抖動', () => {
  const asked = (delay: number, states: H3State[]): H3State[] => {
    const seen: H3State[] = [];
    const spy: Controller<H3State> = {
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
    const inner = member('b-exact-0');
    expect(withDelay(inner, 0)).toBe(inner);
  });

  it('對手的跑者與總分是 delay 個 tick 前的，自己的是現在的', () => {
    const states: H3State[] = Array.from({ length: 30 }, (_v, i) =>
      makeState({
        tick: 100 + i,
        roundTick: 70 + i,
        runners: [running(1000 * i), running(2000 * i)],
        totals: [i, 3 * i],
      }),
    );
    const seen = asked(12, states);
    const last = seen[seen.length - 1] as H3State;
    expect(last.runners[0].pos).toBe(29000);
    expect(last.runners[1].pos).toBe(2000 * 17);
    expect(last.totals[0]).toBe(29);
    expect(last.totals[1]).toBe(3 * 17);
    expect(last.tick).toBe(129);
  });

  it('跨局時，延遲看到的若是上一局的對手，當作對手還在起跑線', () => {
    const prev = makeState({ tick: 100, round: 0, runners: [stopped(250000), stopped(280000)] });
    const now = (tick: number): H3State =>
      makeState({ tick, round: 1, roundTick: tick - 100, runners: [running(0), running(0)] });
    const seen = asked(5, [prev, now(101), now(102), now(103), now(104), now(105)]);
    const last = seen[seen.length - 1] as H3State;
    expect(last.round).toBe(1);
    expect(last.runners[1].status).toBe('running');
    expect(last.runners[1].pos).toBe(0);
  });

  it('withJitter：j ＝ 0 就是原控制器；否則煞車晚 0 到 j 個 tick 才生效，之後一直按著，且決定性', () => {
    const inner = member('b-exact-0');
    expect(withJitter(inner, 0, 7)).toBe(inner);
    const play = (seed: number): { pos: number; status: string } => {
      let s = makeState({ v0: 1000, runners: [running(0), running(0)] });
      const ctl = withJitter(member('b-exact-8'), 5, seed);
      for (
        let t = 0;
        t < 400 && s.runners[0].status !== 'stopped' && s.runners[0].status !== 'fallen';
        t += 1
      ) {
        s = h3Game.step(s, [ctl.decide(s, 0, t), IDLE]);
      }
      return { pos: s.runners[0].pos, status: s.runners[0].status };
    };
    const exact = runRound('b-exact-8', 1000).runners[0];
    const results = [1, 2, 3, 4, 5, 6, 7, 8].map(play);
    for (const r of results) {
      // 晚 0 到 5 個 tick：最多多衝 5 個 tick 的距離（每個 tick 約 1 到 2 像素）
      expect(r.pos).toBeGreaterThanOrEqual(exact.pos);
      expect(r.pos).toBeLessThanOrEqual(exact.pos + 12000);
    }
    expect(new Set(results.map((r) => r.pos)).size).toBeGreaterThan(1);
    expect(play(3)).toEqual(play(3));
  });
});

describe('對局與分歧率的串接', () => {
  it('playWith 跑得完一整場；同一個種子兩次結果相同', () => {
    const a = playWith(3, member('b-exact-8'), MAIN_CELL);
    const b = playWith(3, member('b-exact-8'), MAIN_CELL);
    expect(a).toEqual(b);
    expect(Number.isFinite(a.margin)).toBe(true);
    const c = playWith(3, member('b-exact-8'), { ...MAIN_CELL, jitter: 5 });
    expect(Number.isFinite(c.margin)).toBe(true);
  });

  it('isPoint：我這一邊還在跑、而且在跑的階段，每個 tick 都是一次「現在煞車或再等」的決定', () => {
    expect(isPoint(at(running(0), running(0)), 0, 100)).toBe(true);
    expect(isPoint(at(stopped(10), running(0)), 0, 100)).toBe(false);
    expect(isPoint(at(running(0), running(0)), 1, 100)).toBe(true);
    expect(isPoint(at(running(0), stopped(100)), 1, 100)).toBe(false);
    expect(isPoint(at(running(0), running(0), { phase: 'pause' }), 0, 100)).toBe(false);
  });

  it('compareBC：自己對自己 → 分歧率 0、勝率差 0；上限成立、沒有一致性違規', () => {
    const r = compareBC(spec('b-exact-8', 'b-exact-8', [1, 2], MAIN_CELL));
    expect(r.divergence.gamesDiffer).toBe(0);
    expect(r.win.diff.mean).toBe(0);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
  });

  it('divergence：b-exact-8 對 c-exact-8-lead 的點級分母 > 0（用的是自己的 isPoint）', () => {
    const d = divergence(spec('b-exact-8', 'c-exact-8-lead', [1], MAIN_CELL));
    expect(d.pointBasis).toBe('isPoint');
    expect(d.points).toBeGreaterThan(0);
  });

  it('(b) 驅動的對局與單獨的 (b) 對局逐位元相同（影子不影響對局）', () => {
    const plain = playWith(5, member('b-exact-8'), MAIN_CELL);
    const r = compareBC(spec('b-exact-8', 'c-exact-8-lead', [5], MAIN_CELL));
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

  it('selectDeviating：先排除在訓練種子上與 (b*) 逐位元相同的 (c) 成員（讀了等於沒讀），再選最強的；全都相同時回傳 null', () => {
    const rows = [
      { name: 'c-a', win: 1, margin: 10 },
      { name: 'c-b', win: 1, margin: 8 },
      { name: 'c-c', win: 0.9, margin: 99 },
    ];
    expect(selectDeviating(rows, new Set(['c-a']))?.name).toBe('c-a');
    expect(selectDeviating(rows, new Set(['c-b', 'c-c']))?.name).toBe('c-b');
    expect(selectDeviating(rows, new Set(['c-c']))?.name).toBe('c-c');
    expect(selectDeviating(rows, new Set())).toBeNull();
  });

  it('score：b-never（地板）拿到的勝率與分差有意義（有限數字）', () => {
    const row = score('b-never', [11, 12], MAIN_CELL);
    expect(row.win).toBeGreaterThanOrEqual(0);
    expect(row.win).toBeLessThanOrEqual(1);
    expect(Number.isFinite(row.margin)).toBe(true);
  });

  it('AI 的種子約定', () => {
    expect(AI_SEED_OFFSET).toBe(1_000_003);
  });
});

describe('(c) 不是 AI（10.61 第二個陷阱）', () => {
  it('成員檔的原始碼沒有 import evaluate、opponentAction、levelController、policyByName、各性格檔', () => {
    const text = readFileSync(new URL('./probe-a.members.test-helpers.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(text).not.toMatch(
      /\bevaluate\b|predictOpponent|opponentAction|levelController|policyByName|wrapPolicy|humanModel|human-model|policies\/|ai\/level|ai\/policies|ai\/human/,
    );
    expect(text).not.toMatch(/from ['"][^'"]*\/ai\//);
  });

  it('成員檔與 logic.ts 都沒有時鐘與亂數', () => {
    for (const file of ['./probe-a.members.test-helpers.ts', './logic.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text).not.toMatch(/Math\.random|Date\.now|performance\.now|setTimeout|setInterval/);
    }
  });
});
