import { describe, expect, it } from 'vitest';

import { humanModel } from '../../ai/human-model';
import { levelController, wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { random } from '../../ai/policies/random';
import { hashState } from '../../core/hash';
import { playMatch } from '../../core/match';
import { rngStateFor } from '../../core/rng';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import type { Policy } from '../../ai/types';
import { AI_WAIT_TICKS, DECISION_TIMEOUT, IDLE, PRESS_A, PRESS_B } from '../_hearts/logic';
import {
  BASE,
  CLIMB,
  LADDERS,
  LADDER_PAUSE,
  LEVELS,
  LOCK_TICKS,
  Q_VALUES,
  RESULT_TICKS,
  STOP,
  h8Game,
  ladderPoints,
  ladderValue,
  makeState,
  posteriorOf,
  successProb,
  thetaHat,
} from './logic';
import type { Act, H8Log, H8State } from './logic';

/**
 * H-8 加倍或歸零的規則測試（規則見 `docs/cards/H-8.md`）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣；要某個骰子結果時用 `forceDice`
 * 去找一個讓 `step` 擲出那個結果的亂數狀態（不依賴擲骰的實作細節）。
 * 重點四組：結算、不偷看（同時出手：對方的 q、pending、last 不可以讀）、
 * `actions()[0]` 是會推進結算的「停」（DESIGN-AI-FUN 10.6 陷阱二）、等級曲線與性格的機制。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const POLICIES: readonly Policy[] = [pathfinder, precise, greedy, gambler];

function pick(a0: Act | null, a1: Act | null): Inputs {
  const f = (a: Act | null): Buttons => (a === null ? IDLE : a === CLIMB ? PRESS_A : PRESS_B);
  return [f(a0), f(a1)];
}

function idle(): Inputs {
  return [IDLE, IDLE];
}

function stepN(state: H8State, n: number, inputs: Inputs = idle()): H8State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = h8Game.step(s, inputs);
  }
  return s;
}

function choosing(overrides: Partial<H8State> = {}): H8State {
  return makeState({ phase: 'choose', wait: 0, idle: 0, ...overrides });
}

/** 兩邊都還在爬、同在第 `j` 層（賭注 2^j）的選擇局面。 */
function ladderAt(j: number, overrides: Partial<H8State> = {}): H8State {
  return choosing({ level: [j, j], pot: [2 ** j, 2 ** j], ...overrides });
}

/** 前 n 層雙方都爬、都成功的公開紀錄。 */
function climbs(n: number): H8Log[] {
  return Array.from({ length: n }, (_v, i) => ({
    level: i,
    acts: [CLIMB, CLIMB] as const,
    ok: [true, true] as const,
  }));
}

/** 兩邊按鍵，一路走到揭示（resolve 階段，還沒入帳）。 */
function toResolve(state: H8State, a0: Act | null, a1: Act | null): H8State {
  let s = h8Game.step(state, pick(a0, a1));
  let guard = 0;
  while (s.phase !== 'resolve' && !s.over && guard < 20) {
    s = h8Game.step(s, idle());
    guard += 1;
  }
  return s;
}

/** 入帳：resolve 走完。 */
function bank(state: H8State): H8State {
  return stepN(state, RESULT_TICKS);
}

/** 找一個亂數狀態，讓這一層擲出指定結果（沒爬的人不擲，不限制）。 */
function forceDice(
  state: H8State,
  a0: Act | null,
  a1: Act | null,
  ok0: boolean | null,
  ok1: boolean | null,
): H8State {
  for (let i = 0; i < 5000; i += 1) {
    const candidate = { ...state, rng: rngStateFor(i, 'force') };
    const r = toResolve(candidate, a0, a1);
    const last = r.last;
    if (last === null) {
      continue;
    }
    if ((ok0 === null || last.ok[0] === ok0) && (ok1 === null || last.ok[1] === ok1)) {
      return candidate;
    }
  }
  throw new Error('找不到符合的骰子');
}

/** 這一層兩邊做指定的事，擲出指定的骰子，入帳。 */
function playLevel(
  state: H8State,
  a0: Act | null,
  a1: Act | null,
  ok0: boolean | null = null,
  ok1: boolean | null = null,
): H8State {
  const forced = forceDice(state, a0, a1, ok0, ok1);
  return bank(toResolve(forced, a0, a1));
}

function nameOf(buttons: Buttons): string {
  if (buttons.a && !buttons.b) {
    return '爬';
  }
  if (buttons.b && !buttons.a) {
    return '停';
  }
  return '放開';
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function decideWith(policy: Policy, depth: number, state: H8State, side: Side): Buttons {
  return wrapPolicy(
    h8Game,
    policy,
    { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
    7,
  ).decide(state, side, 0);
}

const qOf = (value: number): number => Q_VALUES.indexOf(value);

// ---------------------------------------------------------------------------
// 常數與 init
// ---------------------------------------------------------------------------

describe('H-8 加倍或歸零｜初始與常數', () => {
  it('常數：6 層、5 座梯子、基準成功率逐層下降、q 五個值、鎖定 2 tick', () => {
    expect(LEVELS).toBe(6);
    expect(LADDERS).toBe(5);
    expect(BASE).toEqual([0.85, 0.75, 0.65, 0.55, 0.45, 0.35]);
    expect(Q_VALUES).toEqual([-0.2, -0.1, 0, 0.1, 0.2]);
    expect(LOCK_TICKS).toBe(2);
    for (let i = 1; i < BASE.length; i += 1) {
      expect(BASE[i] as number).toBeLessThan(BASE[i - 1] as number);
    }
  });

  it('successProb：BASE + q，夾在 0.05 到 0.95（邊界：0.85 + 0.2 夾到 0.95；0.35 − 0.2 = 0.15 不夾）', () => {
    expect(successProb(0, 0)).toBeCloseTo(0.85, 10);
    expect(successProb(0, 0.2)).toBeCloseTo(0.95, 10);
    expect(successProb(1, 0.2)).toBeCloseTo(0.95, 10);
    expect(successProb(5, -0.2)).toBeCloseTo(0.15, 10);
    expect(successProb(2, -0.1)).toBeCloseTo(0.55, 10);
    for (let k = 0; k < LEVELS; k += 1) {
      for (const q of Q_VALUES) {
        expect(successProb(k, q)).toBeGreaterThanOrEqual(0.05);
        expect(successProb(k, q)).toBeLessThanOrEqual(0.95);
      }
    }
  });

  it('init：第 0 座、層 0、賭注 1、兩邊還在爬、分數 0、準備階段等 AI_WAIT_TICKS、沒有紀錄', () => {
    const s = h8Game.init(3, CONFIG);
    expect(s.ladder).toBe(0);
    expect(s.level).toEqual([0, 0]);
    expect(s.pot).toEqual([1, 1]);
    expect(s.status).toEqual(['active', 'active']);
    expect(s.scores).toEqual([0, 0]);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.pending).toEqual([null, null]);
    expect(s.log).toEqual([]);
    expect(s.past).toEqual([]);
    expect(s.over).toBe(false);
    expect(Q_VALUES).toContain(s.q[0]);
    expect(Q_VALUES).toContain(s.q[1]);
  });

  it('init：同種子同 state；兩邊的 q 各抽各的、分佈一樣（400 個種子，每個值約兩成）', () => {
    expect(h8Game.init(5, CONFIG)).toEqual(h8Game.init(5, CONFIG));
    const counts: [number[], number[]] = [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ];
    let differ = 0;
    for (let seed = 0; seed < 400; seed += 1) {
      const s = h8Game.init(seed, CONFIG);
      for (const side of [0, 1] as const) {
        (counts[side] as number[])[qOf(s.q[side])] += 1;
      }
      if (s.q[0] !== s.q[1]) {
        differ += 1;
      }
    }
    for (const side of [0, 1] as const) {
      for (const c of counts[side]) {
        expect(c).toBeGreaterThanOrEqual(55);
        expect(c).toBeLessThanOrEqual(105);
      }
    }
    // 各抽各的：不是永遠相同，也不是永遠不同
    expect(differ).toBeGreaterThan(200);
    expect(differ).toBeLessThan(380);
  });
});

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

describe('H-8 加倍或歸零｜規則', () => {
  it('1. 準備：等 AI_WAIT_TICKS 個 tick 才能出手，期間輸入被忽略；之後進 choose', () => {
    let s = makeState();
    for (let i = 0; i < AI_WAIT_TICKS - 1; i += 1) {
      s = h8Game.step(s, pick(CLIMB, STOP));
      expect(s.phase).toBe('prep');
      expect(s.pending).toEqual([null, null]);
    }
    s = h8Game.step(s, pick(CLIMB, STOP));
    expect(s.phase).toBe('choose');
    expect(s.pending).toEqual([null, null]);
  });

  it('2. 兩邊同時決定：只有一邊按時還在 choose；兩邊都按的那個 tick 進 locked（鎖定 LOCK_TICKS）；選了不能改', () => {
    const s = choosing();
    const one = h8Game.step(s, pick(CLIMB, null));
    expect(one.phase).toBe('choose');
    expect(one.pending).toEqual([CLIMB, null]);
    const changed = h8Game.step(one, pick(STOP, null));
    expect(changed.pending).toEqual([CLIMB, null]);
    const both = h8Game.step(one, pick(null, STOP));
    expect(both.phase).toBe('locked');
    expect(both.wait).toBe(LOCK_TICKS);
    expect(both.pending).toEqual([CLIMB, STOP]);
  });

  it('3. 鎖定 2 tick 後（共 3 步）揭示：階段是 resolve、停 RESULT_TICKS；這段時間賭注與狀態都沒動；骰子在 last', () => {
    const s0 = choosing();
    let s = h8Game.step(s0, pick(CLIMB, CLIMB));
    expect(s.phase).toBe('locked');
    s = h8Game.step(s, idle());
    expect(s.phase).toBe('locked');
    s = h8Game.step(s, idle());
    expect(s.phase).toBe('resolve');
    expect(s.wait).toBe(RESULT_TICKS);
    expect(s.last).not.toBeNull();
    expect(s.last?.acts).toEqual([CLIMB, CLIMB]);
    expect(typeof s.last?.ok[0]).toBe('boolean');
    expect(typeof s.last?.ok[1]).toBe('boolean');
    expect(s.pot).toEqual([1, 1]);
    expect(s.level).toEqual([0, 0]);
    expect(s.status).toEqual(['active', 'active']);
    expect(s.log).toEqual([]);
    const mid = stepN(s, RESULT_TICKS - 1);
    expect(mid.phase).toBe('resolve');
    expect(mid.pot).toEqual([1, 1]);
  });

  it('4. 爬成功：賭注 ×2、進下一層、還在爬；爬失敗：賭注歸零、出局；停：保留賭注、不再行動', () => {
    const s = ladderAt(1);
    const a = playLevel(s, CLIMB, CLIMB, true, false);
    expect(a.pot).toEqual([4, 0]);
    expect(a.level[0]).toBe(2);
    expect(a.status).toEqual(['active', 'out']);
    const b = playLevel(s, STOP, CLIMB, null, true);
    expect(b.pot).toEqual([2, 4]);
    expect(b.status).toEqual(['stopped', 'active']);
    expect(b.level).toEqual([1, 2]);
  });

  it('5. 入帳之後：這層寫進 log（層、兩邊的選擇、骰子結果），進下一層的準備階段，pending 與 last 清掉', () => {
    const s = ladderAt(1);
    const a = playLevel(s, CLIMB, STOP, true, null);
    expect(a.log).toEqual([{ level: 1, acts: [CLIMB, STOP], ok: [true, null] }]);
    expect(a.phase).toBe('prep');
    expect(a.wait).toBe(AI_WAIT_TICKS);
    expect(a.pending).toEqual([null, null]);
    expect(a.last).toBeNull();
    expect(a.ladder).toBe(0);
  });

  it('6. 一個人停了之後另一個人單獨繼續決定；停下的人 actions 只有放開、輸入沒有作用', () => {
    const s = ladderAt(1);
    const after = playLevel(s, STOP, CLIMB, null, true);
    let c = stepN(after, AI_WAIT_TICKS);
    expect(c.phase).toBe('choose');
    // 已經停的 0 號邊按什麼都沒有用；只要 1 號邊決定，就進 locked
    c = h8Game.step(c, pick(CLIMB, null));
    expect(c.pending).toEqual([null, null]);
    c = h8Game.step(c, pick(CLIMB, STOP));
    expect(c.phase).toBe('locked');
    expect(c.pending).toEqual([null, STOP]);
    expect(h8Game.actions(after, 0).length).toBe(1);
  });

  it('7. 梯子結束：兩邊都不在爬；賭注高的 2 分、一樣高各 1 分、都出局（賭注都是 0）各 1 分', () => {
    // 0 停在賭注 4、1 停在賭注 2：0 贏
    let s = ladderAt(2, { level: [2, 1], pot: [4, 2] });
    let r = playLevel({ ...s, level: [2, 2], pot: [4, 4] }, STOP, STOP);
    expect(r.scores).toEqual([1, 1]);
    // 兩邊同時爬，0 成功 1 失敗，然後 0 停
    s = ladderAt(2);
    r = playLevel(s, CLIMB, CLIMB, true, false);
    expect(r.status).toEqual(['active', 'out']);
    r = playLevel(stepN(r, AI_WAIT_TICKS), STOP, null);
    expect(r.scores).toEqual([2, 0]);
    // 兩邊同時失敗：賭注都是 0，平手各 1 分
    const both = playLevel(ladderAt(1), CLIMB, CLIMB, false, false);
    expect(both.scores).toEqual([1, 1]);
    expect(both.ladder).toBe(1);
  });

  it('7b. ladderPoints：高的 2、一樣各 1、低的 0（邊界：0 對 0 是平手）', () => {
    expect(ladderPoints(4, 2)).toEqual([2, 0]);
    expect(ladderPoints(2, 4)).toEqual([0, 2]);
    expect(ladderPoints(4, 4)).toEqual([1, 1]);
    expect(ladderPoints(0, 0)).toEqual([1, 1]);
    expect(ladderPoints(0, 1)).toEqual([0, 2]);
  });

  it('8. 爬到最後一層成功就登頂：賭注 2^6、自動停（梯子因此結束，past 記下賭注 64）', () => {
    const s = ladderAt(5);
    const r = playLevel(s, CLIMB, STOP, true, null);
    expect(r.past[0]?.pots).toEqual([64, 32]);
    expect(r.past[0]?.log[0]).toEqual({ level: 5, acts: [CLIMB, STOP], ok: [true, null] });
    expect(r.ladder).toBe(1);
    expect(r.scores).toEqual([2, 0]);
    // 兩邊都登頂：賭注一樣高，各 1 分
    const both = playLevel(s, CLIMB, CLIMB, true, true);
    expect(both.past[0]?.pots).toEqual([64, 64]);
    expect(both.scores).toEqual([1, 1]);
  });

  it('9. 梯子結束後：past 記下雙方的 q、賭注與紀錄；新的一座從層 0、賭注 1、重新抽 q 開始，準備階段多等 LADDER_PAUSE', () => {
    const s = ladderAt(1, { q: [0.1, -0.2] });
    const r = playLevel(s, STOP, STOP);
    expect(r.ladder).toBe(1);
    expect(r.past.length).toBe(1);
    const entry = r.past[0];
    expect(entry?.q).toEqual([0.1, -0.2]);
    expect(entry?.pots).toEqual([2, 2]);
    expect(entry?.log).toEqual([{ level: 1, acts: [STOP, STOP], ok: [null, null] }]);
    expect(r.level).toEqual([0, 0]);
    expect(r.pot).toEqual([1, 1]);
    expect(r.status).toEqual(['active', 'active']);
    expect(r.log).toEqual([]);
    expect(r.phase).toBe('prep');
    expect(r.wait).toBe(AI_WAIT_TICKS + LADDER_PAUSE);
    expect(Q_VALUES).toContain(r.q[0]);
    expect(Q_VALUES).toContain(r.q[1]);
  });

  it('10. 擲骰：成功率是 BASE + q（夾在 0.05 到 0.95），各擲各的；統計（600 個種子）落在容許範圍', () => {
    const cases: [number, number][] = [
      [0.2, 0],
      [-0.2, 0],
      [0, 3],
    ];
    for (const [q, level] of cases) {
      let hits = 0;
      const n = 600;
      for (let i = 0; i < n; i += 1) {
        const s = ladderAt(level, { q: [q, q], rng: rngStateFor(i, 'dice') });
        const r = toResolve(s, CLIMB, CLIMB);
        if (r.last?.ok[0] === true) {
          hits += 1;
        }
      }
      expect(hits / n).toBeGreaterThan(successProb(level, q) - 0.06);
      expect(hits / n).toBeLessThan(successProb(level, q) + 0.06);
    }
    // 各擲各的：兩邊結果不是永遠相同
    let same = 0;
    for (let i = 0; i < 400; i += 1) {
      const r = toResolve(ladderAt(2, { rng: rngStateFor(i, 'dice') }), CLIMB, CLIMB);
      if (r.last?.ok[0] === r.last?.ok[1]) {
        same += 1;
      }
    }
    expect(same).toBeGreaterThan(100);
    expect(same).toBeLessThan(380);
  });

  it('11. 超時（邊界）：choose 閒置到第 DECISION_TIMEOUT 個 tick 自動停；那個 tick 才按的鍵算按了', () => {
    let s = choosing();
    s = stepN(s, DECISION_TIMEOUT - 1);
    expect(s.phase).toBe('choose');
    const late = h8Game.step(s, pick(CLIMB, null));
    expect(late.pending).toEqual([CLIMB, STOP]);
    expect(late.phase).toBe('locked');
    const timed = h8Game.step(s, idle());
    expect(timed.pending).toEqual([STOP, STOP]);
  });

  it('12. 按鍵：a 爬、b 停；a 與 b 同按算停；其他鍵沒有作用', () => {
    const s = choosing();
    const keys = (b: Partial<Buttons>): Buttons => ({ ...IDLE, ...b });
    expect(h8Game.step(s, [keys({ a: true }), IDLE]).pending[0]).toBe(CLIMB);
    expect(h8Game.step(s, [keys({ b: true }), IDLE]).pending[0]).toBe(STOP);
    expect(h8Game.step(s, [keys({ a: true, b: true }), IDLE]).pending[0]).toBe(STOP);
    expect(
      h8Game.step(s, [keys({ up: true, left: true, right: true, down: true }), IDLE]).pending[0],
    ).toBeNull();
  });

  it('13. 5 座結束：總分高的贏、一樣多平手；結束後 ladder 是 LADDERS、past 有 LADDERS 筆', () => {
    for (const [scores, winner] of [
      [[2, 6], 1],
      [[7, 3], 0],
      [[4, 4], null],
    ] as const) {
      const s = ladderAt(1, { ladder: LADDERS - 1, scores: [scores[0] - 1, scores[1] - 1] });
      const withPast = {
        ...s,
        past: Array.from({ length: LADDERS - 1 }, () => ({
          q: [0, 0] as const,
          pots: [1, 1] as const,
          log: [],
        })),
      };
      const r = playLevel(withPast, STOP, STOP);
      expect(r.over).toBe(true);
      expect(r.scores).toEqual(scores);
      expect(r.winner).toBe(winner);
      expect(r.ladder).toBe(LADDERS);
      expect(r.past.length).toBe(LADDERS);
    }
  });

  it('14. 時間到（第 maxTicks 個 tick）：已經揭示的先入帳；進行中的那座梯子用現在的賭注比；結束後穩定', () => {
    const s = ladderAt(2, { maxTicks: 10, tick: 9, level: [2, 2], pot: [4, 4] });
    const t = h8Game.step(s, idle());
    expect(t.over).toBe(true);
    expect(t.scores).toEqual([1, 1]);
    // 揭示後的 resolve 階段時間到：先入帳（0 號邊爬失敗賭注歸零），再比
    const base = ladderAt(2, { maxTicks: 3600 });
    const r = forceDice(base, CLIMB, STOP, false, null);
    const inResolve = toResolve(r, CLIMB, STOP);
    const end = h8Game.step({ ...inResolve, maxTicks: inResolve.tick + 1 }, idle());
    expect(end.over).toBe(true);
    expect(end.scores).toEqual([0, 2]);
    expect(h8Game.step(end, pick(CLIMB, CLIMB))).toBe(end);
  });

  it('15. step 不改動傳進來的 state 與輸入：各階段深度凍結都不丟錯', () => {
    const states = [
      makeState(),
      choosing(),
      choosing({ pending: [CLIMB, null] }),
      toResolve(choosing(), CLIMB, STOP),
      ladderAt(1, { log: climbs(1) }),
    ];
    for (const s of states) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(s)) as H8State);
      const before = hashState(frozen);
      const inputs = deepFreeze([{ ...PRESS_A }, { ...PRESS_B }] as unknown as Inputs);
      expect(() => h8Game.step(frozen, inputs)).not.toThrow();
      expect(hashState(frozen)).toBe(before);
    }
  });

  it('16. 整場 JSON 來回不變、同種子重跑一樣、不同種子不一樣', () => {
    const run = (seed: number): H8State => {
      let s = h8Game.init(seed, CONFIG);
      const ctl = [random, random];
      for (let t = 0; t < 1500 && !s.over; t += 1) {
        const ins = [0, 1].map((side) =>
          ctl[side]!.decide(h8Game, s, side as Side, t, { depth: 1, seed: seed + side }),
        ) as unknown as Inputs;
        s = h8Game.step(s, ins);
        expect(JSON.parse(JSON.stringify(s))).toEqual(s);
      }
      return s;
    };
    expect(hashState(run(4))).toBe(hashState(run(4)));
    expect(hashState(run(4))).not.toBe(hashState(run(5)));
  });

  it('17. 全程不卡住：兩個亂按的控制器打得完一整場，past 恰好 LADDERS 筆', () => {
    for (const seed of [0, 1, 2, 3]) {
      const r = playMatch(
        h8Game,
        seed,
        CONFIG,
        levelController(h8Game, random, 1, seed + 1),
        levelController(h8Game, random, 1, seed + 2),
      );
      expect(r.ticks).toBeLessThanOrEqual(CONFIG.maxTicks);
      let s = h8Game.init(seed, CONFIG);
      const a = levelController(h8Game, random, 1, seed + 1);
      const b = levelController(h8Game, random, 1, seed + 2);
      let t = 0;
      while (!s.over && t < CONFIG.maxTicks) {
        s = h8Game.step(s, [a.decide(s, 0, t), b.decide(s, 1, t)]);
        t += 1;
      }
      expect(s.over).toBe(true);
      expect(s.past.length).toBe(LADDERS);
    }
  });
});

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

describe('H-8 加倍或歸零｜actions 與 evaluate', () => {
  it('choose、還在爬、還沒決定：[停, 爬]，停排第一；其他情況只有 [全放開]', () => {
    const s = choosing();
    for (const side of [0, 1] as const) {
      const acts = h8Game.actions(s, side);
      expect(acts.map(nameOf)).toEqual(['停', '爬']);
    }
    expect(h8Game.actions({ ...s, pending: [CLIMB, null] }, 0).map(nameOf)).toEqual(['放開']);
    expect(h8Game.actions({ ...s, status: ['stopped', 'active'] }, 0).map(nameOf)).toEqual([
      '放開',
    ]);
    expect(h8Game.actions({ ...s, status: ['out', 'active'] }, 0).map(nameOf)).toEqual(['放開']);
    expect(h8Game.actions(makeState(), 0).map(nameOf)).toEqual(['放開']);
    expect(h8Game.actions({ ...s, phase: 'locked' }, 0).map(nameOf)).toEqual(['放開']);
    expect(h8Game.actions({ ...s, over: true }, 0).map(nameOf)).toEqual(['放開']);
  });

  it('actions()[0] 是「停」，而且是推進結算的動作（10.6 陷阱二）：兩邊都按 actions()[0]，3 步就揭示', () => {
    const s = choosing();
    const first = [h8Game.actions(s, 0)[0] as Buttons, h8Game.actions(s, 1)[0] as Buttons] as const;
    expect(nameOf(first[0])).toBe('停');
    let t = h8Game.step(s, first);
    expect(t.pending).toEqual([STOP, STOP]);
    expect(t.phase).toBe('locked');
    t = stepN(t, 2);
    expect(t.phase).toBe('resolve');
  });

  it('只有我決定、模擬裡的對手維持 actions()[0]（搜尋型的做法）：1 步進 locked、3 步進 resolve；單獨爬的人也一樣', () => {
    const s = choosing();
    const theirs = h8Game.actions(s, 1)[0] as Buttons;
    let t = h8Game.step(s, [PRESS_A, theirs]);
    expect(t.phase).toBe('locked');
    t = stepN(t, 2);
    expect(t.phase).toBe('resolve');
    const lone = choosing({ status: ['active', 'stopped'], pot: [2, 2], level: [1, 1] });
    const u = h8Game.step(lone, [PRESS_A, h8Game.actions(lone, 1)[0] as Buttons]);
    expect(u.phase).toBe('locked');
  });

  it('搜尋型深度 6 的 decide 模擬到的最深狀態已經過了揭示（resolve 階段被 evaluate 看到），而且走 6 步仍在 resolve、沒入帳', () => {
    const s = choosing();
    let t = h8Game.step(s, [PRESS_A, PRESS_B]);
    for (let i = 1; i < 6; i += 1) {
      t = h8Game.step(t, idle());
    }
    expect(t.phase).toBe('resolve');
    expect(t.scores).toEqual(s.scores);
    expect(t.log).toEqual([]);
    expect(t.pot).toEqual(s.pot);
  });

  it('evaluate：各階段 gain 有限、danger 在 0 到 1；結束的局有勝負加成 ±1000', () => {
    const phases: H8State[] = [
      makeState(),
      choosing(),
      choosing({ pending: [CLIMB, null] }),
      toResolve(choosing(), CLIMB, STOP),
      toResolve(ladderAt(3, { q: [-0.2, 0.2] }), CLIMB, CLIMB),
      ladderAt(4, { status: ['active', 'out'], pot: [16, 0], level: [4, 4] }),
    ];
    for (const s of phases) {
      for (const side of [0, 1] as const) {
        const e = h8Game.evaluate(s, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
    const won = { ...choosing(), over: true, winner: 0 as Side, scores: [6, 4] as const };
    expect(h8Game.evaluate(won, 0).gain).toBe(2 + 1000);
    expect(h8Game.evaluate(won, 1).gain).toBe(-2 - 1000);
    const tied = { ...choosing(), over: true, winner: null, scores: [5, 5] as const };
    expect(h8Game.evaluate(tied, 0).gain).toBe(0);
  });

  it('evaluate（locked 以前）：gain = 總分差 + 0.01 × [我選的 = 反射規則（自己這層 p > 0.5 就爬）]；danger = 爬的失敗率', () => {
    for (const q of Q_VALUES) {
      for (let k = 0; k < LEVELS; k += 1) {
        const p = successProb(k, q);
        const base = ladderAt(k, { q: [q, 0], scores: [3, 1], phase: 'locked', wait: 2 });
        const climb = h8Game.evaluate({ ...base, pending: [CLIMB, STOP] }, 0);
        const stop = h8Game.evaluate({ ...base, pending: [STOP, STOP] }, 0);
        expect(climb.gain).toBeCloseTo(2 + (p > 0.5 ? 0.01 : 0), 10);
        expect(stop.gain).toBeCloseTo(2 + (p > 0.5 ? 0 : 0.01), 10);
        expect(climb.danger).toBeCloseTo(1 - p, 10);
        expect(stop.danger).toBe(0);
      }
    }
  });

  it('evaluate（resolve）：gain = 總分差 + 2 × (這座梯子預期得分) − 2；danger 0（失敗已經算在 gain 裡，不重複扣：10.54）', () => {
    const base = toResolve(ladderAt(2, { q: [0.1, 0], scores: [1, 3] }), CLIMB, STOP);
    for (const act of [CLIMB, STOP] as const) {
      const s = { ...base, pending: [act, base.pending[1]] as const };
      const e = h8Game.evaluate(s, 0);
      expect(e.gain).toBeCloseTo(-2 + 2 * ladderValue(s, 0, act, true) - 2, 10);
      expect(e.danger).toBe(0);
    }
  });

  it('價值函式：對手已經停了／出局的單人局面有閉式解', () => {
    // 我層 0、q = 0（p0 = .85, p1 = .75）；對手停在賭注 2
    const vs2 = choosing({ level: [0, 1], pot: [1, 2], status: ['active', 'stopped'] });
    expect(ladderValue(vs2, 0, STOP, true)).toBeCloseTo(0, 10);
    // 爬：最好的是爬兩層（賭注 4 > 2）：2 × .85 × .75
    expect(ladderValue(vs2, 0, CLIMB, true)).toBeCloseTo(2 * 0.85 * 0.75, 10);
    // 對手出局（賭注 0）：停就贏 2；爬一層失敗是 0 比 0 平手
    const vs0 = choosing({ level: [0, 0], pot: [1, 0], status: ['active', 'out'] });
    expect(ladderValue(vs0, 0, STOP, true)).toBeCloseTo(2, 10);
    expect(ladderValue(vs0, 0, CLIMB, true)).toBeCloseTo(0.85 * 2 + 0.15 * 1, 10);
    // 我已經領先：停 > 爬；對手停在賭注 1、我賭注 2
    const ahead = choosing({ level: [1, 0], pot: [2, 1], status: ['active', 'stopped'] });
    expect(ladderValue(ahead, 0, STOP, true)).toBeCloseTo(2, 10);
    expect(ladderValue(ahead, 0, CLIMB, true)).toBeLessThan(2);
  });

  it('價值函式（同時決定）：值在 0 到 2；我的 q 越高、爬的價值越大；readOpp = false 與 true 在沒有對手資訊時相同', () => {
    for (let k = 0; k < LEVELS; k += 1) {
      let last = -1;
      for (const q of Q_VALUES) {
        const s = ladderAt(k, { q: [q, 0], log: climbs(k) });
        for (const act of [STOP, CLIMB] as const) {
          const v = ladderValue(s, 0, act, true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(2);
        }
        const c = ladderValue(s, 0, CLIMB, true);
        expect(c).toBeGreaterThanOrEqual(last - 1e-9);
        last = c;
      }
    }
    const fresh = ladderAt(0, { q: [0.1, 0] });
    expect(ladderValue(fresh, 0, CLIMB, false)).toBeCloseTo(ladderValue(fresh, 0, CLIMB, true), 10);
    expect(ladderValue(fresh, 0, STOP, false)).toBeCloseTo(ladderValue(fresh, 0, STOP, true), 10);
  });
});

// ---------------------------------------------------------------------------
// 對手模型
// ---------------------------------------------------------------------------

describe('H-8 加倍或歸零｜對手模型（只讀公開資訊）', () => {
  const stopRec = (level: number, ok: boolean | null = null) => ({
    level,
    acts: [CLIMB, STOP] as const,
    ok: [ok, null] as const,
  });

  it('門檻 θ̂：沒有歷史是 0.5；一座梯子「停過的最高 p 與爬過的最低 p」的中點與先驗 0.5 平均', () => {
    expect(thetaHat(makeState(), 0)).toBeCloseTo(0.5, 10);
    // 對手（1 號邊）q = 0：爬了層 0、1（p .85、.75），在層 2（p .65）停 → 中點 .70；(.5 + .7) / 2 = .6
    const past = [
      {
        q: [0, 0] as const,
        pots: [4, 4] as const,
        log: [
          { level: 0, acts: [CLIMB, CLIMB] as const, ok: [true, true] as const },
          { level: 1, acts: [CLIMB, CLIMB] as const, ok: [true, true] as const },
          { level: 2, acts: [CLIMB, STOP] as const, ok: [true, null] as const },
        ],
      },
    ];
    expect(thetaHat(makeState({ past }), 0)).toBeCloseTo(0.6, 10);
    // 兩座都一樣：(.5 + .7 + .7) / 3
    expect(thetaHat(makeState({ past: [past[0]!, past[0]!] }), 0)).toBeCloseTo(1.9 / 3, 10);
  });

  it('門檻 θ̂：只看最近 3 座（W = 3）；對手單獨爬的決定（我已經停了）不算', () => {
    const rec = () => ({
      q: [0, 0] as const,
      pots: [2, 2] as const,
      // 對手在層 0 爬（p .85）、層 1 停（p .75 + 0）：中點 .8
      log: [
        { level: 0, acts: [CLIMB, CLIMB] as const, ok: [true, true] as const },
        { level: 1, acts: [CLIMB, STOP] as const, ok: [true, null] as const },
      ],
    });
    const old = { ...rec(), q: [0, -0.2] as const };
    const state = makeState({ past: [old, rec(), rec(), rec()] });
    // 最近三座的中點都是 .8，先驗 .5：(.5 + 3 × .8) / 4 = .725；第一座（q = −.2，中點會是 .6）不能進來
    expect(thetaHat(state, 0)).toBeCloseTo(0.725, 10);
    // 單獨爬：我（0 號邊）已經停了，對手的決定不算
    const lonely = {
      q: [0, 0] as const,
      pots: [1, 8] as const,
      log: [
        { level: 2, acts: [null, CLIMB] as const, ok: [null, true] as const },
        { level: 3, acts: [null, STOP] as const, ok: [null, null] as const },
      ],
    };
    expect(thetaHat(makeState({ past: [lonely] }), 0)).toBeCloseTo(0.5, 10);
  });

  it('後驗：機率加起來是 1；沒有資訊是均勻；對手連爬到高層 → q 高的機率大；對手早停 → q 低的機率大', () => {
    const none = posteriorOf(ladderAt(0), 0);
    expect(none.length).toBe(Q_VALUES.length);
    for (const w of none) {
      expect(w).toBeCloseTo(0.2, 10);
    }
    const mean = (w: readonly number[]): number =>
      w.reduce((a, b, i) => a + b * (Q_VALUES[i] as number), 0);
    const bold = posteriorOf(ladderAt(4, { log: climbs(4) }), 0);
    expect(bold.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(mean(bold)).toBeGreaterThan(0);
    const timid = posteriorOf(
      makeState({
        log: [
          { level: 0, acts: [CLIMB, CLIMB], ok: [true, true] },
          { level: 1, acts: [CLIMB, STOP], ok: [true, null] },
        ],
        status: ['active', 'stopped'],
        level: [2, 1],
        pot: [4, 2],
      }),
      0,
    );
    expect(mean(timid)).toBeLessThan(0);
  });

  it('後驗：對手擲骰失敗（出局）→ 偏向 q 低；成功 → 偏向 q 高（公開結果也是資訊）', () => {
    const mean = (w: readonly number[]): number =>
      w.reduce((a, b, i) => a + b * (Q_VALUES[i] as number), 0);
    const failed = posteriorOf(
      makeState({
        log: [{ level: 0, acts: [CLIMB, CLIMB], ok: [true, false] }],
        status: ['active', 'out'],
        level: [1, 0],
        pot: [2, 0],
      }),
      0,
    );
    const passed = posteriorOf(
      makeState({
        log: [{ level: 0, acts: [CLIMB, CLIMB], ok: [true, true] }],
        level: [1, 1],
        pot: [2, 2],
      }),
      0,
    );
    expect(mean(failed)).toBeLessThan(mean(passed));
  });

  it('model=false（消融）：後驗與 θ̂ 不讀紀錄與歷史，價值與沒有紀錄時相同', () => {
    const plain = ladderAt(3, { model: false, q: [0, 0] });
    const withLog = {
      ...plain,
      log: climbs(3),
      past: [{ q: [0, 0.2] as const, pots: [8, 8] as const, log: climbs(3) }],
    };
    for (const act of [STOP, CLIMB] as const) {
      expect(ladderValue(withLog, 0, act, true)).toBeCloseTo(ladderValue(plain, 0, act, true), 10);
    }
  });
});

// ---------------------------------------------------------------------------
// 不偷看
// ---------------------------------------------------------------------------

interface PeekCase {
  readonly name: string;
  readonly side: Side;
  readonly base: H8State;
  readonly variants: readonly H8State[];
}

function peekCases(): PeekCase[] {
  const cases: PeekCase[] = [];
  for (const side of [0, 1] as const) {
    const opp: Side = side === 0 ? 1 : 0;
    const bases: [string, H8State][] = [
      ['prep', makeState({ level: [2, 2], pot: [4, 4], scores: [3, 5] })],
      ['choose 還沒決定', ladderAt(2, { scores: [3, 5], log: climbs(2) })],
      [
        'choose 我已決定',
        ladderAt(3, {
          scores: [3, 5],
          log: climbs(3),
          pending: side === 0 ? [CLIMB, null] : [null, CLIMB],
        }),
      ],
      [
        'locked',
        ladderAt(3, {
          scores: [3, 5],
          log: climbs(3),
          phase: 'locked',
          wait: 2,
          pending: [CLIMB, CLIMB],
        }),
      ],
      [
        'resolve',
        ladderAt(3, {
          scores: [3, 5],
          log: climbs(3),
          phase: 'resolve',
          wait: 9,
          pending: [CLIMB, CLIMB],
          last: { acts: [CLIMB, CLIMB], ok: [true, false] },
        }),
      ],
      [
        'resolve（過去的梯子）',
        ladderAt(2, {
          ladder: 2,
          scores: [3, 5],
          past: [
            { q: [0, 0.1], pots: [4, 8], log: climbs(3) },
            { q: [0.2, -0.1], pots: [16, 2], log: climbs(1) },
          ],
          phase: 'resolve',
          wait: 9,
          pending: [STOP, CLIMB],
          last: { acts: [STOP, CLIMB], ok: [null, true] },
        }),
      ],
    ];
    for (const [name, base] of bases) {
      const variants: H8State[] = [];
      // 對方這座梯子的 q
      for (const q of Q_VALUES) {
        const qq: [number, number] = [base.q[0], base.q[1]];
        qq[opp] = q;
        variants.push({ ...base, q: qq });
      }
      // 對方 pending
      for (const a of [null, STOP, CLIMB] as const) {
        const pending: [Act | null, Act | null] = [base.pending[0], base.pending[1]];
        pending[opp] = a;
        variants.push({ ...base, pending });
      }
      // last 與 rng
      if (base.phase === 'resolve') {
        for (const ok of [true, false]) {
          const lastOk: [boolean | null, boolean | null] = [
            base.last?.ok[0] ?? null,
            base.last?.ok[1] ?? null,
          ];
          lastOk[opp] = ok;
          variants.push({ ...base, last: { acts: base.last?.acts ?? [null, null], ok: lastOk } });
        }
      }
      variants.push({ ...base, rng: rngStateFor(99, 'other') });
      // 對方 q 同時換 past 以外的東西不屬於偷看；不加
      cases.push({ name: `${name}（${side} 號邊）`, side, base, variants });
    }
  }
  return cases;
}

function peeks(
  game: Game<H8State>,
  base: H8State,
  variants: readonly H8State[],
  side: Side,
): boolean {
  const expectedEval = game.evaluate(base, side);
  const expectedActions = game.actions(base, side).map(nameOf).join();
  return variants.some((v) => {
    const e = game.evaluate(v, side);
    return (
      e.gain !== expectedEval.gain ||
      e.danger !== expectedEval.danger ||
      game.actions(v, side).map(nameOf).join() !== expectedActions
    );
  });
}

describe('H-8 加倍或歸零｜不偷看（evaluate 與 actions 不可以讀對方的 q、對方這層的 pending、骰子結果 last）', () => {
  it('每一個情境：只有對方的 q（或對方 pending、last、rng）不同的兩個 state，evaluate 與 actions 完全相同', () => {
    for (const c of peekCases()) {
      expect(peeks(h8Game, c.base, c.variants, c.side), c.name).toBe(false);
    }
  });

  it('偵測器本身有效：故意洩漏（讀對方 q、讀對方 pending、讀 last）一定被抓到', () => {
    const leaks: Record<string, (s: H8State, side: Side) => number> = {
      '讀對方的 q': (s, side) => 0.001 * qOf(s.q[side === 0 ? 1 : 0]),
      '讀對方的 pending（choose）': (s, side) =>
        s.phase === 'choose' ? 0.001 * ((s.pending[side === 0 ? 1 : 0] ?? 0) + 1) : 0,
      '讀對方的 pending（locked）': (s, side) =>
        s.phase === 'locked' ? 0.001 * ((s.pending[side === 0 ? 1 : 0] ?? 0) + 1) : 0,
      '讀對方的 pending（resolve）': (s, side) =>
        s.phase === 'resolve' ? 0.001 * ((s.pending[side === 0 ? 1 : 0] ?? 0) + 1) : 0,
      '讀 last': (s, side) =>
        s.last === null ? 0 : 0.001 * (s.last.ok[side === 0 ? 1 : 0] === true ? 1 : 0),
    };
    const cases = peekCases();
    for (const [name, extra] of Object.entries(leaks)) {
      const leaky: Game<H8State> = {
        ...h8Game,
        evaluate: (s, side) => {
          const e = h8Game.evaluate(s, side);
          return { gain: e.gain + extra(s, side), danger: e.danger };
        },
      };
      expect(
        cases.some((c) => peeks(leaky, c.base, c.variants, c.side)),
        `沒抓到洩漏：${name}`,
      ).toBe(true);
    }
    const leakyActions: Game<H8State> = {
      ...h8Game,
      actions: (s, side) =>
        s.q[side === 0 ? 1 : 0] > 0.15
          ? [...h8Game.actions(s, side), IDLE]
          : h8Game.actions(s, side),
    };
    expect(cases.some((c) => peeks(leakyActions, c.base, c.variants, c.side))).toBe(true);
  });

  it('黑箱：四個性格在深度 1、3、6，只有對方 q 或 pending 不同的 choose 局面，按的鍵都相同', () => {
    const backgrounds: Partial<H8State>[] = [
      { level: [0, 0], pot: [1, 1] },
      { level: [2, 2], pot: [4, 4], log: climbs(2), scores: [1, 3] },
      { level: [3, 3], pot: [8, 8], log: climbs(3), scores: [6, 2], ladder: 2 },
      { level: [4, 4], pot: [16, 16], log: climbs(4), scores: [2, 7], ladder: 3 },
    ];
    for (const bg of backgrounds) {
      for (const side of [0, 1] as const) {
        const opp: Side = side === 0 ? 1 : 0;
        for (const ownQ of [-0.1, 0.1]) {
          const q0: [number, number] = [0, 0];
          q0[side] = ownQ;
          const base = choosing({ ...bg, q: q0 });
          for (const policy of POLICIES) {
            for (const depth of [1, 3, 6]) {
              const expected = nameOf(decideWith(policy, depth, base, side));
              for (const oq of Q_VALUES) {
                const q: [number, number] = [q0[0], q0[1]];
                q[opp] = oq;
                for (const act of [null, STOP, CLIMB] as const) {
                  const pending: [Act | null, Act | null] = [null, null];
                  pending[opp] = act;
                  expect(
                    nameOf(decideWith(policy, depth, { ...base, q, pending }, side)),
                    `${policy.name} 深度 ${depth} 對方 q ${oq} pending ${String(act)}`,
                  ).toBe(expected);
                }
              }
            }
          }
        }
      }
    }
  });

  it('黑箱也抓得到只有 decide 那一層看得出來的洩漏：resolve 階段的估值讀了對方的 q（深度 3 以上走得到）', () => {
    const leaky: Game<H8State> = {
      ...h8Game,
      evaluate: (s, side) => {
        const e = h8Game.evaluate(s, side);
        if (s.phase !== 'resolve') {
          return e;
        }
        const mine = s.pending[side];
        return {
          gain: e.gain + (s.q[side === 0 ? 1 : 0] > 0 ? 5 : -5) * (mine === CLIMB ? 1 : 0),
          danger: e.danger,
        };
      },
    };
    const decide = (state: H8State, depth: number): string =>
      nameOf(
        wrapPolicy(
          leaky,
          pathfinder,
          { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
          7,
        ).decide(state, 1, 0),
      );
    const base = ladderAt(3, { q: [0, -0.1] });
    const high: H8State = { ...base, q: [0.2, -0.1] };
    const low: H8State = { ...base, q: [-0.2, -0.1] };
    expect(decide(high, 3)).not.toBe(decide(low, 3));
    expect(decide(high, 1)).toBe(decide(low, 1));
  });
});

// ---------------------------------------------------------------------------
// 等級曲線
// ---------------------------------------------------------------------------

describe('H-8 加倍或歸零｜等級曲線（出手 → 鎖定 2 → 第 3 步揭示）', () => {
  /** 自己這層成功率的各種組合：層 0..5 × 自己的 q。 */
  function scan(): H8State[] {
    const states: H8State[] = [];
    for (let k = 0; k < LEVELS; k += 1) {
      for (const q of Q_VALUES) {
        for (const scores of [
          [0, 0],
          [0, 4],
          [5, 1],
        ] as const) {
          states.push(ladderAt(k, { q: [q, 0], scores: [scores[0], scores[1]] }));
        }
      }
    }
    return states;
  }

  it('深度 1、2：反射規則——自己這層 p > 0.5 就爬，否則停；完全不管對方（對方的賭注、狀態、紀錄、歷史怎麼換，決定都一樣）', () => {
    const alts: Partial<H8State>[] = [
      {},
      { log: climbs(3) },
      { past: [{ q: [0, 0.2], pots: [8, 64], log: climbs(4) }] },
      { status: ['active', 'stopped'] },
    ];
    for (const s of scan()) {
      const p = successProb(s.level[0], s.q[0]);
      for (const depth of [1, 2]) {
        for (const alt of alts) {
          const variant = { ...s, ...alt };
          // 對方已經停的情況：賭注讓它不同於我，但決定一樣
          if (alt.status !== undefined) {
            variant.pot = [s.pot[0], s.pot[0] * 2];
          }
          expect(nameOf(decideWith(pathfinder, depth, variant, 0)), `p ${p} 深度 ${depth}`).toBe(
            p > 0.5 ? '爬' : '停',
          );
        }
      }
    }
  });

  it('深度 3 以上讀得到對方：掃描裡有局面的決定跟深度 1 不同；單獨爬的時候知道對方的賭注（領先就停、落後就拚）', () => {
    let differs = 0;
    for (const s of scan()) {
      if (nameOf(decideWith(pathfinder, 4, s, 0)) !== nameOf(decideWith(pathfinder, 1, s, 0))) {
        differs += 1;
      }
    }
    expect(differs).toBeGreaterThanOrEqual(5);
    // 我在層 1（賭注 2，p .75），對手停在賭注 1：我領先，停；對手停在賭注 8：我要拚
    const lead = choosing({ level: [1, 0], pot: [2, 1], status: ['active', 'stopped'] });
    const behind = choosing({ level: [1, 3], pot: [2, 8], status: ['active', 'stopped'] });
    expect(nameOf(decideWith(pathfinder, 4, lead, 0))).toBe('停');
    expect(nameOf(decideWith(pathfinder, 4, behind, 0))).toBe('爬');
    // 深度 1 的反射規則看不到：兩個局面都是 p > 0.5 就爬
    expect(nameOf(decideWith(pathfinder, 1, lead, 0))).toBe('爬');
  });

  it('互相讀取：同一個局面只換對手這座梯子的公開紀錄，深度 6 有局面的決定不同（信念改變選擇）', () => {
    let changed = 0;
    for (let k = 1; k <= 4; k += 1) {
      for (const q of Q_VALUES) {
        const cautious = ladderAt(k, {
          q: [q, 0],
          log: Array.from({ length: k }, (_v, i) => ({
            level: i,
            acts: [CLIMB, CLIMB] as const,
            ok: [true, true] as const,
          })),
        });
        // 對手在低成功率的層仍然爬（賭徒或高 q）對上：對手一直有爬的紀錄 vs 沒有任何紀錄的 prep 局面
        const unknown = ladderAt(k, { q: [q, 0] });
        if (
          nameOf(decideWith(pathfinder, 6, cautious, 0)) !==
          nameOf(decideWith(pathfinder, 6, unknown, 0))
        ) {
          changed += 1;
        }
      }
    }
    expect(changed).toBeGreaterThanOrEqual(1);
  });

  it('消融 model=false：對手的公開紀錄與歷史完全不影響決定', () => {
    for (const s of scan()) {
      const off = { ...s, model: false };
      const a = nameOf(decideWith(pathfinder, 6, off, 0));
      const b = nameOf(
        decideWith(
          pathfinder,
          6,
          {
            ...off,
            log: climbs(s.level[0]),
            past: [{ q: [0, 0.2], pots: [8, 64], log: climbs(4) }],
          },
          0,
        ),
      );
      expect(b).toBe(a);
    }
  });
});

// ---------------------------------------------------------------------------
// 性格
// ---------------------------------------------------------------------------

describe('H-8 加倍或歸零｜四種性格（機制：爬升門檻）', () => {
  const act = (policy: Policy, depth: number, s: H8State): string =>
    nameOf(decideWith(policy, depth, s, 0));

  it('貪心型：一步看，p > 0.5 就爬（與賭注大小、落後多少無關）', () => {
    for (const s of [
      ...Array.from({ length: LEVELS }, (_v, k) => k).flatMap((k) =>
        Q_VALUES.flatMap((q) => [
          ladderAt(k, { q: [q, 0] }),
          ladderAt(k, { q: [q, 0], scores: [0, 8] }),
        ]),
      ),
    ]) {
      expect(act(greedy, 1, s)).toBe(successProb(s.level[0], s.q[0]) > 0.5 ? '爬' : '停');
    }
  });

  it('精準型：danger（失敗率）超過 0.3 的動作不選——p ≥ 0.75 才爬', () => {
    for (let k = 0; k < LEVELS; k += 1) {
      for (const q of Q_VALUES) {
        const p = successProb(k, q);
        expect(act(precise, 1, ladderAt(k, { q: [q, 0] })), `p ${p}`).toBe(p >= 0.7 ? '爬' : '停');
      }
    }
  });

  it('賭徒型：領先或平手時像貪心型（p > 0.5 才爬）；落後時 p 低也爬', () => {
    for (let k = 0; k < LEVELS; k += 1) {
      for (const q of Q_VALUES) {
        const p = successProb(k, q);
        expect(act(gambler, 1, ladderAt(k, { q: [q, 0], scores: [3, 3] }))).toBe(
          p > 0.5 ? '爬' : '停',
        );
        expect(act(gambler, 1, ladderAt(k, { q: [q, 0], scores: [5, 3] }))).toBe(
          p > 0.5 ? '爬' : '停',
        );
      }
    }
    // 落後 4 分：連 p = .15 都爬
    expect(act(gambler, 1, ladderAt(5, { q: [-0.2, 0], scores: [0, 4] }))).toBe('爬');
    // 落後時爬的局面不少於領先時
    let behind = 0;
    let ahead = 0;
    for (let k = 0; k < LEVELS; k += 1) {
      for (const q of Q_VALUES) {
        behind += act(gambler, 1, ladderAt(k, { q: [q, 0], scores: [0, 4] })) === '爬' ? 1 : 0;
        ahead += act(gambler, 1, ladderAt(k, { q: [q, 0], scores: [4, 0] })) === '爬' ? 1 : 0;
      }
    }
    expect(behind).toBeGreaterThan(ahead);
  });

  it('搜尋型：深度 1 同貪心型，深度 4 以上用對手的後驗（有局面不同）', () => {
    for (let k = 0; k < LEVELS; k += 1) {
      for (const q of Q_VALUES) {
        const s = ladderAt(k, { q: [q, 0] });
        expect(act(pathfinder, 1, s)).toBe(act(greedy, 1, s));
      }
    }
  });
});

describe('H-8 加倍或歸零｜AI 能不能玩', () => {
  it('兩個等級 5 的搜尋型打完一整場：在 maxTicks 之前結束，5 座梯子都打完', () => {
    for (const seed of [0, 1, 2]) {
      let s = h8Game.init(seed, CONFIG);
      const a = levelController(h8Game, pathfinder, 5, seed * 2 + 1);
      const b = levelController(h8Game, pathfinder, 5, seed * 2 + 2);
      let t = 0;
      while (!s.over && t < CONFIG.maxTicks) {
        s = h8Game.step(s, [a.decide(s, 0, t), b.decide(s, 1, t)]);
        t += 1;
      }
      expect(s.over).toBe(true);
      expect(s.past.length).toBe(LADDERS);
    }
  });

  it('等級 10 的搜尋型對人類模型：20 個種子贏過半（座位輪流）', () => {
    let points = 0;
    for (let seed = 0; seed < 20; seed += 1) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const ai = levelController(h8Game, pathfinder, 10, seed + 1);
      const human = humanModel(h8Game, seed + 2);
      const r =
        side === 0
          ? playMatch(h8Game, seed, CONFIG, ai, human)
          : playMatch(h8Game, seed, CONFIG, human, ai);
      points += r.winner === null ? 0.5 : r.winner === side ? 1 : 0;
    }
    expect(points / 20).toBeGreaterThan(0.5);
  }, 120_000);
});
