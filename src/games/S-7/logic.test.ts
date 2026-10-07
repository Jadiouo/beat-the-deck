import { describe, expect, it } from 'vitest';
import { policyByName } from '../../ai/level';
import type { Buttons, Inputs, Side } from '../../core/types';
import {
  FAKE_TICKS,
  FEINTS,
  REAL_TIMEOUT,
  RESOLVE_TICKS,
  RESULT_TICKS,
  ROUNDS,
  TWITCH_AFTER,
  WAIT_MAX,
  WAIT_MIN,
  WIN_ROUNDS,
  makeState,
  pBite,
  pReal,
  s7Game,
  twitchRate,
} from './logic';
import type { Flash, RoundRecord, S7State } from './logic';

/**
 * S-7 拔槍的規則測試。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 0 號邊是人、1 號邊是 AI（兩邊規則完全相同）。
 */
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];
const press = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const DRAW0: Inputs = [press({ a: true }), NONE];
const DRAW1: Inputs = [NONE, press({ a: true })];
const TWITCH0: Inputs = [press({ b: true }), NONE];
const CONFIG = { maxTicks: 3600, params: {} };

function run(state: S7State, count: number, inputs: Inputs = IDLE): S7State {
  let s = state;
  for (let i = 0; i < count; i += 1) {
    s = s7Game.step(s, inputs);
  }
  return s;
}

const real = (age = 0): Flash => ({ age, makers: [false, false], real: true });
const fakeBy = (maker: Side, age = 0): Flash => ({
  age,
  makers: [maker === 0, maker === 1],
  real: false,
});
/** 一輪的歷史：預設每次假動作都亮在第 96 tick（測試用的光大多是 elapsed 100、亮了 3 tick，也就是第 96 tick 亮起）。 */
const rec = (
  human: number,
  ai: number,
  baited: readonly [number, number] = [0, 0],
  at: readonly [readonly number[], readonly number[]] = [
    Array.from({ length: human }, () => 96),
    Array.from({ length: ai }, () => 96),
  ],
): RoundRecord => ({ twitches: [human, ai], twitchAt: at, baited, winner: null });
const rounds = (n: number, make: () => RoundRecord): RoundRecord[] =>
  Array.from({ length: n }, make);

describe('S-7 拔槍｜規則', () => {
  it('1. 初始：第一輪、等待階段、沒有光、0 比 0、真訊號 90 到 369 tick 之後', () => {
    const s = s7Game.init(3, CONFIG);
    expect([s.round, s.phase, s.flash, s.wins, s.spent]).toEqual([0, 'wait', null, [0, 0], [0, 0]]);
    expect(s.waitLeft).toBeGreaterThanOrEqual(WAIT_MIN);
    expect(s.waitLeft).toBeLessThanOrEqual(WAIT_MAX);
    expect(s7Game.score(s)).toEqual([0, 0]);
    expect(s7Game.isOver(s)).toBe(false);
  });

  it('2.（邊界）真訊號：剩 2 tick 時 1 個 tick 後還沒有光，剩 1 tick 時下一個 tick 就亮（age 0、是真的）', () => {
    const early = run(makeState({ waitLeft: 2 }), 1);
    expect(early.flash).toBeNull();
    const onset = run(makeState({ waitLeft: 1 }), 1);
    expect(onset.flash).toEqual({ age: 0, makers: [false, false], real: true });
  });

  it('3. 有效按下：真光亮著時按 a，第 RESOLVE_TICKS 個 tick 才揭曉（之前還在等待），按的人贏這一輪', () => {
    const s0 = makeState({ flash: real(10) });
    const s1 = s7Game.step(s0, DRAW0);
    expect(s1.press[0]).toMatchObject({ at: s0.elapsed, valid: true, flashAge: 10 });
    expect(run(s1, RESOLVE_TICKS - 2).phase).toBe('wait');
    const done = run(s1, RESOLVE_TICKS - 1);
    expect(done.phase).toBe('result');
    expect(done.wins).toEqual([1, 0]);
    expect(done.last?.winner).toBe(0);
  });

  it('4. 搶拍：沒有光的時候按 a 就輸這一輪（對手贏）', () => {
    const s = run(makeState({ waitLeft: 100 }), RESOLVE_TICKS, DRAW0);
    expect(s.phase).toBe('result');
    expect(s.wins).toEqual([0, 1]);
    expect(s.last).toMatchObject({ winner: 1, early: [true, false] });
  });

  it('5.（邊界）真訊號亮起的那一個 tick 就按也是搶拍：判斷用的是按下去那一刻已經看得到的光', () => {
    const s = run(makeState({ waitLeft: 1 }), RESOLVE_TICKS, DRAW0);
    expect(s.wins).toEqual([0, 1]);
    expect(s.last).toMatchObject({ early: [true, false] });
  });

  it('6. 被假光騙到：假光亮著時按 a 是搶拍，歷史記下「被騙」', () => {
    const s = run(makeState({ flash: fakeBy(1, 10), twitches: [0, 1] }), RESOLVE_TICKS, DRAW0);
    expect(s.wins).toEqual([0, 1]);
    expect(s.history.at(-1)).toMatchObject({ twitches: [0, 1], baited: [1, 0] });
    expect(s.last).toMatchObject({ baited: [true, false], early: [false, false] });
  });

  it('7. 同時開槍：揭曉前兩邊都有效，不是誰比較快，這一輪平手；只有一邊按就是那一邊的', () => {
    const first = s7Game.step(makeState({ flash: real(5) }), DRAW1);
    const second = s7Game.step(first, DRAW0);
    const drawn = run(second, RESOLVE_TICKS);
    expect(drawn.wins).toEqual([0, 0]);
    expect(drawn.last?.winner).toBeNull();
    const alone = run(s7Game.step(makeState({ flash: real(5) }), DRAW1), RESOLVE_TICKS);
    expect(alone.wins).toEqual([0, 1]);
  });

  it('8.（邊界）揭曉的時間線：第一個人按下去之後第 RESOLVE_TICKS 個 tick 揭曉，那一個 tick 另一邊按的還算（平手）；再晚一個 tick 已經揭曉，不算', () => {
    const first = s7Game.step(makeState({ flash: real(5) }), DRAW1);
    const lastCounting = run(run(first, RESOLVE_TICKS - 2), 1, DRAW0);
    expect(lastCounting.phase).toBe('result');
    expect(lastCounting.wins).toEqual([0, 0]);
    const tooLate = run(run(first, RESOLVE_TICKS - 1), 1, DRAW0);
    expect(tooLate.phase).toBe('result');
    expect(tooLate.wins).toEqual([0, 1]);
    // 同一個 tick 兩邊都搶拍也平手；一邊有效一邊搶拍，有效的贏
    const both: Inputs = [press({ a: true }), press({ a: true })];
    expect(run(makeState({ waitLeft: 100 }), RESOLVE_TICKS, both).wins).toEqual([0, 0]);
    const early = s7Game.step(makeState({ waitLeft: 100 }), DRAW1);
    const withReal = run({ ...early, flash: real(2) }, RESOLVE_TICKS, DRAW0);
    expect(withReal.wins).toEqual([1, 0]);
  });

  it('9. 假動作：按 b 在中間亮一道假光（age 0），額度與這輪次數各加一；人與 AI 規則相同', () => {
    const a = s7Game.step(makeState({ elapsed: 120 }), TWITCH0);
    expect(a.flash).toEqual({ age: 0, makers: [true, false], real: false });
    expect(a.twitches).toEqual([1, 0]);
    const b = s7Game.step(makeState({ elapsed: 120 }), [NONE, press({ b: true })]);
    expect(b.flash).toEqual({ age: 0, makers: [false, true], real: false });
    expect(b.twitches).toEqual([0, 1]);
  });

  it('10.（邊界）假動作的限制：這輪開始不到 30 tick、光亮著、這輪已經 2 次、額度（每場 6 次）用完，按 b 都沒有效果', () => {
    expect(s7Game.step(makeState({ elapsed: TWITCH_AFTER - 1 }), TWITCH0).flash).toBeNull();
    expect(s7Game.step(makeState({ elapsed: TWITCH_AFTER }), TWITCH0).flash).not.toBeNull();
    expect(s7Game.step(makeState({ elapsed: 120, flash: real(3) }), TWITCH0).twitches).toEqual([
      0, 0,
    ]);
    expect(s7Game.step(makeState({ elapsed: 120, twitches: [2, 0] }), TWITCH0).flash).toBeNull();
    expect(s7Game.step(makeState({ elapsed: 120, spent: [FEINTS, 0] }), TWITCH0).flash).toBeNull();
    expect(
      s7Game.step(makeState({ elapsed: 120, spent: [FEINTS - 1, 0] }), TWITCH0).flash,
    ).not.toBeNull();
  });

  it('11.（邊界）假光亮 30 tick 就熄：亮到 age 29 還看得到，下一個 tick 就沒有；真光不會熄', () => {
    const f = fakeBy(0, FAKE_TICKS - 2);
    const seen = s7Game.step(makeState({ flash: f, twitches: [1, 0], waitLeft: 100 }), IDLE);
    expect(seen.flash?.age).toBe(FAKE_TICKS - 1);
    expect(s7Game.step(seen, IDLE).flash).toBeNull();
    const longReal = run(makeState({ flash: real(FAKE_TICKS) }), 20);
    expect(longReal.flash).toMatchObject({ real: true, age: FAKE_TICKS + 20 });
  });

  it('12. 假光亮著時真訊號的時間到了：就地變成真光（沒熄、age 連續），所以按了才算數', () => {
    const merged = s7Game.step(
      makeState({ flash: fakeBy(1, 10), twitches: [0, 1], waitLeft: 1 }),
      IDLE,
    );
    expect(merged.flash).toMatchObject({ real: true, age: 11 });
    expect(merged.flash?.makers).toEqual([false, true]);
    const won = run(merged, RESOLVE_TICKS, DRAW0);
    expect(won.wins).toEqual([1, 0]);
  });

  it('13. 按住不放只算一次：一輪開始時還按著上一輪的鍵不算搶拍；放開再按才算', () => {
    const held = makeState({ waitLeft: 100, heldA: [true, false] });
    const stillHeld = run(held, 3, DRAW0);
    expect(stillHeld.press[0]).toBeNull();
    const released = s7Game.step(s7Game.step(held, IDLE), DRAW0);
    expect(released.press[0]).not.toBeNull();
  });

  it('14. 一輪沒人按：真光亮滿 150 tick 就平手，下一輪照樣開始', () => {
    const s = run(makeState({ flash: real(REAL_TIMEOUT - 1) }), 1);
    expect(s.phase).toBe('result');
    expect(s.wins).toEqual([0, 0]);
    const next = run(s, RESULT_TICKS);
    expect(next).toMatchObject({
      phase: 'wait',
      round: 1,
      flash: null,
      press: [null, null],
      elapsed: 0,
    });
  });

  it('15. 輪與歷史：結算後歷史多一筆（假動作次數、被騙），累積假動作額度；只留最近 6 輪', () => {
    const base = makeState({
      flash: real(10),
      twitches: [1, 2],
      spent: [3, 4],
      history: rounds(6, () => rec(0, 0)),
      round: 6,
    });
    const done = run(s7Game.step(base, DRAW0), RESOLVE_TICKS - 1);
    expect(done.history).toHaveLength(6);
    expect(done.history.at(-1)).toMatchObject({ twitches: [1, 2], winner: 0 });
    expect(done.spent).toEqual([4, 6]);
  });

  it('16. 結束：先贏 5 輪就結束；9 輪打完輪數多的贏；時間到（3600 tick）輪數多的贏', () => {
    const clinch = run(
      s7Game.step(makeState({ flash: real(10), wins: [WIN_ROUNDS - 1, 3], round: 7 }), DRAW0),
      RESOLVE_TICKS - 1,
    );
    expect(s7Game.isOver(clinch)).toBe(true);
    expect(s7Game.winner(clinch)).toBe(0);
    const last = run(
      s7Game.step(makeState({ flash: real(10), wins: [3, 4], round: ROUNDS - 1 }), DRAW0),
      RESOLVE_TICKS - 1,
    );
    expect(s7Game.isOver(last)).toBe(true);
    expect(s7Game.score(last)).toEqual([4, 4]);
    expect(s7Game.winner(last)).toBeNull();
    const cut = makeState({ tick: 3599, wins: [2, 3] });
    expect(s7Game.isOver(cut)).toBe(false);
    const ended = s7Game.step(cut, IDLE);
    expect(s7Game.isOver(ended)).toBe(true);
    expect(s7Game.winner(ended)).toBe(1);
    expect(s7Game.step(ended, DRAW0)).toBe(ended);
  });

  it('17. 隨機：真訊號的時間由種子決定，十個種子不全相同；連續兩輪也不同；新的亂數狀態寫回 state', () => {
    const waits = Array.from({ length: 10 }, (_, i) => s7Game.init(i, CONFIG).waitLeft);
    expect(new Set(waits).size).toBeGreaterThan(5);
    const first = s7Game.init(4, CONFIG);
    const nextRound = run(
      s7Game.step(makeState({ flash: real(10), rng: first.rng }), DRAW0),
      RESOLVE_TICKS - 1 + RESULT_TICKS,
    );
    expect(nextRound.round).toBe(1);
    expect(nextRound.waitLeft).not.toBe(first.waitLeft);
    expect(nextRound.rng).not.toBe(first.rng);
  });

  it('18. step 不改動傳進來的 state（凍結也能 step），JSON 來回不變', () => {
    const deep = (o: unknown): void => {
      if (typeof o === 'object' && o !== null) {
        Object.freeze(o);
        Object.values(o).forEach(deep);
      }
    };
    const s = makeState({ flash: fakeBy(0, 3), twitches: [1, 0], history: [rec(1, 0)] });
    deep(s);
    expect(() => s7Game.step(s, DRAW1)).not.toThrow();
    const next = s7Game.step(s, DRAW1);
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });
});

type Name = 'precise' | 'greedy' | 'gambler' | 'pathfinder';
const NAMES: readonly Name[] = ['precise', 'greedy', 'gambler', 'pathfinder'];
const decide = (name: Name, s: S7State, side: Side, depth = 1): Buttons =>
  policyByName(name).decide(s7Game, s, side, 0, { depth, seed: 1 });

describe('S-7 拔槍｜AI 讀你', () => {
  it('A. 假動作率與「這道光是真的」的把握：你假動作越多把握越低；亮滿 30 tick 或你的額度用完就確定是真的', () => {
    const clean = makeState({ history: rounds(6, () => rec(0, 0)) });
    const twitchy = makeState({ history: rounds(6, () => rec(2, 0)) });
    expect(twitchRate(twitchy, 0)).toBeGreaterThan(twitchRate(clean, 0));
    expect(pReal(clean, 1, 5)).toBeGreaterThan(0.9);
    expect(pReal(twitchy, 1, 5)).toBeLessThan(0.5);
    expect(pReal(twitchy, 1, FAKE_TICKS)).toBe(1);
    expect(
      pReal(makeState({ history: rounds(6, () => rec(2, 0)), spent: [FEINTS, 0] }), 1, 5),
    ).toBe(1);
  });

  it('B. 讀你：你一直假動作，精準型看到光先等；你都不假動作，它一看到光就按；亮滿 30 tick 一定按', () => {
    const flash = real(3);
    const twitchy = makeState({ flash, history: rounds(6, () => rec(2, 0)) });
    const clean = makeState({ flash, history: rounds(6, () => rec(0, 0)) });
    expect(decide('precise', twitchy, 1).a).toBe(false);
    expect(decide('precise', clean, 1).a).toBe(true);
    const confirmed = makeState({ flash: real(FAKE_TICKS), history: rounds(6, () => rec(2, 0)) });
    expect(decide('precise', confirmed, 1).a).toBe(true);
  });

  it('C. 性格不同：你這個時間偶爾抽（它有點把握、但不到精準型的標準）時，貪心型一看到光就按，精準型等', () => {
    // 6 輪裡只有 1 次在第 78 tick 抽過（離這道光亮起的第 96 tick 有 18 tick）
    const middle = makeState({
      flash: real(3),
      history: [rec(1, 0, [0, 0], [[78], []]), ...rounds(5, () => rec(0, 0))],
    });
    expect(pReal(middle, 1, 3)).toBeGreaterThan(0.66);
    expect(pReal(middle, 1, 3)).toBeLessThan(0.7);
    expect(decide('greedy', middle, 1).a).toBe(true);
    expect(decide('precise', middle, 1).a).toBe(false);
  });

  it('C2. 讀你的習慣時間：你愛在第 96 tick 抽，那個時間亮的光它不信；換一個你從沒抽過的時間，它就信', () => {
    const habit = makeState({ elapsed: 300, history: rounds(6, () => rec(1, 0)) });
    expect(pReal(habit, 1, 3, 96)).toBeLessThan(0.3);
    expect(pReal(habit, 1, 3, 250)).toBeGreaterThan(0.9);
    const late = makeState({ flash: real(3), elapsed: 254, history: rounds(6, () => rec(1, 0)) });
    expect(decide('precise', late, 1).a).toBe(true);
  });

  it('D. 雙向：你愛上當，AI 就假動作；你假動作都不上當，它就不假動作', () => {
    const bites = makeState({ elapsed: 120, history: rounds(6, () => rec(0, 1, [1, 0])) });
    const never = makeState({ elapsed: 120, history: rounds(6, () => rec(0, 1, [0, 0])) });
    expect(pBite(bites, 1)).toBeGreaterThan(pBite(never, 1));
    expect(decide('greedy', bites, 1).b).toBe(true);
    expect(decide('greedy', never, 1).b).toBe(false);
    expect(decide('precise', never, 1).b).toBe(false);
  });

  it('E. 導演不看分差（沒有橡皮筋）：兩邊輪數對調，AI 的選擇不變', () => {
    const flashLead = makeState({ flash: real(3), wins: [3, 0], round: 3 });
    const flashTrail = makeState({ flash: real(3), wins: [0, 3], round: 3 });
    const waitLead = makeState({ elapsed: 120, wins: [3, 0], round: 3 });
    const waitTrail = makeState({ elapsed: 120, wins: [0, 3], round: 3 });
    // 賭徒型落後時多冒險是性格（SPEC 7.1，不算橡皮筋），所以只比其他三個。
    for (const name of ['precise', 'greedy', 'pathfinder'] as const) {
      expect(decide(name, flashLead, 1)).toEqual(decide(name, flashTrail, 1));
      expect(decide(name, waitLead, 1)).toEqual(decide(name, waitTrail, 1));
    }
  });

  it('F. AI 的選項裡沒有搶拍：沒有光時只有「全放開」與（有額度時）假動作', () => {
    const wait = s7Game.actions(makeState({ elapsed: 120 }), 1);
    expect(wait.some((x) => x.a)).toBe(false);
    expect(wait.some((x) => x.b)).toBe(true);
    expect(
      s7Game.actions(makeState({ elapsed: 120, spent: [0, FEINTS] }), 1).some((x) => x.b),
    ).toBe(false);
    const lit = s7Game.actions(makeState({ flash: real(3) }), 1);
    expect(lit.some((x) => x.a)).toBe(true);
    expect(lit.some((x) => x.b)).toBe(false);
    expect(s7Game.actions(makeState({ phase: 'result' }), 1)).toHaveLength(1);
  });
});

/**
 * 4.2／4.3：隱藏的資訊不可以被看見。只有「這道光是真是假、誰抽的、真訊號還有多久、對手這輪抽了幾次、
 * 對手按得有不有效、亂數」不同的兩個 state，`evaluate`、`actions` 與四個性格在深度 1、3、6 的 `decide` 都要相同。
 * 兩個已知窗口（見小規格「已知限制」）排除在外：假光熄滅前的最後幾個 tick、真訊號出現前的最後幾個 tick。
 */
describe('S-7 拔槍｜不偷看（4.2、4.3 的黑箱盲測）', () => {
  const DEPTHS = [1, 3, 6] as const;
  const history = rounds(6, () => rec(0, 0));
  const lit = (flash: Flash, extra: Partial<S7State> = {}): S7State =>
    makeState({ flash, history, elapsed: 100, waitLeft: 100, ...extra });

  type Pair = readonly [string, S7State, S7State];
  // 每一組是 [說明, state, 只有「對手的」隱藏資訊不同的 state]
  const pairs: readonly Pair[] = [
    ...[0, 5, 12, 20].map((age): Pair => [
      `光亮了 ${age} tick：真光 vs 人抽的假光`,
      lit(real(age)),
      lit(fakeBy(0, age), { twitches: [1, 0], twitchAt: [[100 - age - 1], []] }),
    ]),
    [
      '等待中：真訊號還有 60 tick vs 200 tick，亂數也不同（沒有光）',
      makeState({ history, elapsed: 120, waitLeft: 60 }),
      makeState({ history, elapsed: 120, waitLeft: 200, rng: 12345 }),
    ],
    [
      '等待中：人這輪已經抽 0 次 vs 1 次（隱藏）',
      makeState({ history, elapsed: 120, waitLeft: 100, twitches: [0, 0] }),
      makeState({ history, elapsed: 120, waitLeft: 100, twitches: [1, 0] }),
    ],
    [
      '人已經按了：有效 vs 搶拍（揭曉前看不到）',
      makeState({
        history,
        flash: real(6),
        press: [{ at: 100, valid: true, flashAge: 6, own: false }, null],
        resolveIn: RESOLVE_TICKS - 1,
      }),
      makeState({
        history,
        flash: fakeBy(0, 6),
        twitches: [1, 0],
        press: [{ at: 100, valid: false, flashAge: 6, own: false }, null],
        resolveIn: RESOLVE_TICKS - 1,
      }),
    ],
  ];

  it('evaluate 與 actions：只有隱藏資訊不同，AI 側（1 號邊）相同', () => {
    for (const [name, a, b] of pairs) {
      expect(s7Game.evaluate(a, 1), name).toEqual(s7Game.evaluate(b, 1));
      expect(s7Game.actions(a, 1), name).toEqual(s7Game.actions(b, 1));
    }
  });

  it.each(NAMES)('%s：深度 1、3、6 的 decide 都不受隱藏資訊影響', (name) => {
    for (const [label, a, b] of pairs) {
      for (const depth of DEPTHS) {
        expect(decide(name, a, 1, depth), `${label} 深度 ${depth}`).toEqual(
          decide(name, b, 1, depth),
        );
      }
    }
  });

  it('AI 的決定不是常數：同一組 state 裡四個性格在不同歷史下確實會做出不同的事（防止盲測是靠「什麼都不做」過的）', () => {
    const clean = lit(real(3));
    const twitchy = makeState({ flash: real(3), history: rounds(6, () => rec(2, 0)) });
    const wait = makeState({ elapsed: 120, history: rounds(6, () => rec(0, 1, [1, 0])) });
    expect(decide('precise', clean, 1).a).toBe(true);
    expect(decide('precise', twitchy, 1).a).toBe(false);
    expect(decide('greedy', wait, 1).b).toBe(true);
  });
});
