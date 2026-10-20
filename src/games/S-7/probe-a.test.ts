import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC, divergence, pairedStats, shadow } from '../../../tests/ai/probe-a.shared';
import { deepFreeze } from '../../../tests/contract/freeze';
import { levelController, policyByName } from '../../ai/level';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Side } from '../../core/types';
import { evaluate, makeState, s7Game } from './logic';
import type { RoundRecord, S7State } from './logic';
import { B_FAMILY, C_FAMILY, makeMember } from './probe-a.members.test-helpers';
import {
  CELLS,
  PRIMARY_CELL,
  isFeintPoint,
  isPressPoint,
  playWith,
  s7Spec,
  selectBest,
} from './probe-a.test-helpers';
import type { Cell } from './probe-a.test-helpers';

/**
 * S-7 探針 A（完整版）的工具測試（`docs/cards/S-7.md`「探針 A（完整版）」）。
 * 只測量測工具本身：族的定義、(b) 不讀對手、(c) 真的讀、隱藏欄位不讀、分歧率與統計。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const IDLE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const sameButtons = (x: Buttons, y: Buttons): boolean =>
  x.a === y.a && x.b === y.b && x.up === y.up && x.down === y.down;

const rec = (
  twitchAt: readonly [readonly number[], readonly number[]],
  baited: readonly [number, number] = [0, 0],
): RoundRecord => ({
  twitches: [twitchAt[0].length, twitchAt[1].length],
  twitchAt,
  baited,
  winner: null,
});

/** 一道真光（亮了 age tick、在這一輪第 elapsed−age tick 亮起）。 */
const lit = (age: number, extra: Parameters<typeof makeState>[0] = {}): S7State =>
  makeState({
    elapsed: 130 + age,
    flash: { age, makers: [false, false], real: true },
    waitLeft: 0,
    ...extra,
  });

/** 讓成員連續看同一個 state（tick 0 起）n 次，回傳最後一次的按鍵。D=0 時舊畫面就是現在。 */
function lastDecision(
  name: string,
  state: S7State,
  side: Side = 0,
  n = 1,
  seed = 1,
  delay: 0 | 12 = 0,
): Buttons {
  const m = makeMember(name, seed, delay);
  let out: Buttons = IDLE;
  for (let i = 0; i < n; i += 1) {
    out = m.decide({ ...state, tick: i }, side, i);
  }
  return out;
}

describe('族的定義', () => {
  it('(b) 族 13 個、(c) 族 8 個，名字不重複，(b) 的名字都以 b- 開頭、(c) 以 c- 開頭', () => {
    expect(B_FAMILY).toHaveLength(13);
    expect(C_FAMILY).toHaveLength(8);
    expect(new Set([...B_FAMILY, ...C_FAMILY]).size).toBe(21);
    expect(B_FAMILY.every((n) => n.startsWith('b-'))).toBe(true);
    expect(C_FAMILY.every((n) => n.startsWith('c-'))).toBe(true);
  });

  it('格子：12 格（貪心 L3／L5／L7／L10 × 延遲 0／12 ＋ 精準 L5／L10 × 延遲 0／12），主格是貪心 L5 延遲 12', () => {
    expect(CELLS).toHaveLength(12);
    expect(PRIMARY_CELL).toEqual({ policy: 'greedy', level: 5, delay: 12 });
    expect(CELLS).toContainEqual(PRIMARY_CELL);
    expect(new Set(CELLS.map((c) => JSON.stringify(c))).size).toBe(12);
  });

  it('成員檔不 import AI 的 evaluate、predictOpponent、pReal、pBite、等級控制器，也不用時鐘與亂數函式庫', () => {
    const text = readFileSync(
      new URL('./probe-a.members.test-helpers.ts', import.meta.url),
      'utf8',
    );
    for (const banned of [
      'evaluate',
      'predictOpponent',
      'pReal',
      'pBite',
      'levelController',
      'wrapPolicy',
      'policyByName',
      'Math.random',
      'Date.now',
      'performance.now',
    ]) {
      expect(text, banned).not.toContain(banned);
    }
  });
});

describe('按的規則', () => {
  it('b-reflex：舊畫面裡一看到光（亮 0 tick）就按；b-wait30：亮滿 30 才按', () => {
    expect(lastDecision('b-reflex', lit(0)).a).toBe(true);
    expect(lastDecision('b-wait30', lit(29)).a).toBe(false);
    expect(lastDecision('b-wait30', lit(30)).a).toBe(true);
    expect(lastDecision('b-wait15', lit(14)).a).toBe(false);
    expect(lastDecision('b-wait15', lit(15)).a).toBe(true);
  });

  it('守則：光在第 T 個 tick 之前亮起要等亮滿 30，之後 k 就按', () => {
    // elapsed 100、亮 0 tick ＝ 第 100 tick 亮起 ＜ 105
    const early = makeState({
      elapsed: 100,
      flash: { age: 0, makers: [false, false], real: true },
      waitLeft: 0,
    });
    const late = makeState({
      elapsed: 110,
      flash: { age: 0, makers: [false, false], real: true },
      waitLeft: 0,
    });
    expect(lastDecision('b-guard105', early).a).toBe(false);
    expect(lastDecision('b-guard105', late).a).toBe(true);
    expect(lastDecision('b-guard130', late).a).toBe(false);
    expect(lastDecision('b-guard105-k8-f2', early).a).toBe(false);
  });

  it('不按自己抽的光，直到亮滿 30 tick', () => {
    const own = (age: number): S7State =>
      makeState({
        elapsed: 130 + age,
        flash: { age, makers: [true, false], real: false },
        waitLeft: 50,
      });
    expect(lastDecision('b-reflex', own(0)).a).toBe(false);
    expect(lastDecision('b-reflex', own(20)).a).toBe(false);
  });

  it('按過就不再按、結果階段不按', () => {
    const pressed = lit(5, {
      press: [{ at: 140, valid: true, flashAge: 3, own: false }, null],
      resolveIn: 3,
    });
    expect(lastDecision('b-reflex', pressed).a).toBe(false);
    expect(lastDecision('b-reflex', makeState({ phase: 'result', resultLeft: 50 })).a).toBe(false);
  });

  it('延遲 12：只看得到 12 tick 前的光（現在才亮的光看不到），而且之後還按得下去', () => {
    const m = makeMember('b-reflex', 1, 12);
    const dark = makeState({ elapsed: 200, flash: null });
    // 前 12 個 tick 畫面都是暗的
    for (let t = 0; t < 12; t += 1) {
      expect(m.decide({ ...dark, tick: t }, 0, t).a).toBe(false);
    }
    // 第 12 個 tick：現在有光，但成員看的是第 0 個 tick 的畫面（暗）
    const now = { ...lit(0), tick: 12 };
    expect(m.decide(now, 0, 12).a).toBe(false);
    // 第 24 個 tick：成員看到第 12 個 tick 的畫面（亮 0）→ 按
    const later = { ...lit(12), tick: 24 };
    for (let t = 13; t < 24; t += 1) {
      m.decide({ ...lit(t - 12), tick: t }, 0, t);
    }
    expect(m.decide(later, 0, 24).a).toBe(true);
  });
});

describe('假動作的規則', () => {
  const eligible = (tick: number, extra: Parameters<typeof makeState>[0] = {}): S7State =>
    makeState({ elapsed: 100, flash: null, tick, ...extra });

  const feints = (name: string, ticks: number, state: Partial<S7State> = {}, seed = 1): number => {
    const m = makeMember(name, seed, 0);
    let n = 0;
    let prev = false;
    for (let t = 0; t < ticks; t += 1) {
      const out = m.decide({ ...eligible(t), ...state, heldB: [prev, false] }, 0, t);
      prev = out.b;
      if (out.b) {
        n += 1;
      }
    }
    return n;
  };

  it('無假動作的成員從不抽；p 越大抽得越多（同一串亂數，所以單調）', () => {
    expect(feints('b-guard105', 400)).toBe(0);
    const f1 = feints('b-guard105-f1', 3000);
    const f2 = feints('b-guard105-f2', 3000);
    const f4 = feints('b-guard105-f4', 3000);
    expect(f1).toBeGreaterThan(0);
    expect(f1).toBeLessThanOrEqual(f2);
    expect(f2).toBeLessThanOrEqual(f4);
    expect(f4).toBeGreaterThan(f1);
  });

  it('還沒過 90 tick、光亮著、這輪已抽滿 2 次、全場滿 6 次，都不抽', () => {
    expect(feints('b-guard105-f4', 400, { elapsed: 50 })).toBe(0);
    expect(
      feints('b-guard105-f4', 400, { flash: { age: 3, makers: [false, false], real: true } }),
    ).toBe(0);
    expect(feints('b-guard105-f4', 400, { twitches: [2, 0] })).toBe(0);
    expect(feints('b-guard105-f4', 400, { spent: [5, 0], twitches: [1, 0] })).toBe(0);
  });

  it('fix90：這一輪第 90 tick 抽一次，其他 tick 不抽', () => {
    const m = makeMember('b-guard105-fix', 1, 0);
    const at = (elapsed: number): boolean =>
      m.decide(makeState({ elapsed, flash: null, tick: elapsed }), 0, elapsed).b;
    expect(at(89)).toBe(false);
    expect(at(90)).toBe(true);
    expect(at(91)).toBe(false);
    expect(at(120)).toBe(false);
  });

  it('同種子同序列、不同種子不同序列', () => {
    const run = (seed: number): number[] => {
      const m = makeMember('b-guard105-f4', seed, 0);
      return Array.from({ length: 300 }, (_v, t) =>
        m.decide(makeState({ elapsed: 100, flash: null, tick: t }), 0, t).b ? 1 : 0,
      );
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });
});

// ---------------------------------------------------------------------------
// 讀什麼：用「雙胞胎重播」——同一串真實對局的 state，一份原樣餵給成員，一份把某一類欄位換掉餵給另一個
// 同樣的成員。每個 tick 的決定都相同 ＝ 沒讀那一類欄位。
// ---------------------------------------------------------------------------

type Scramble = (s: S7State, side: Side) => S7State;

/** 隱藏的欄位：真假、對手的那一格 makers、真訊號倒數、這一輪對手的假動作、對手按下去有沒有效、亂數。 */
const scrambleHidden: Scramble = (s, side) => {
  const opp = side === 0 ? 1 : 0;
  const flash =
    s.flash === null
      ? null
      : {
          ...s.flash,
          real: !s.flash.real,
          makers: (opp === 0
            ? [!s.flash.makers[0], s.flash.makers[1]]
            : [s.flash.makers[0], !s.flash.makers[1]]) as [boolean, boolean],
        };
  const twitches: [number, number] = side === 0 ? [s.twitches[0], 1] : [1, s.twitches[1]];
  const twitchAt: [readonly number[], readonly number[]] =
    side === 0 ? [s.twitchAt[0], [91]] : [[91], s.twitchAt[1]];
  const oppPress = s.press[opp];
  const press: [typeof oppPress, typeof oppPress] =
    side === 0 ? [s.press[0], oppPress] : [oppPress, s.press[1]];
  const scrambled =
    oppPress === null ? oppPress : { ...oppPress, valid: !oppPress.valid, own: !oppPress.own };
  if (opp === 0) {
    press[0] = scrambled;
  } else {
    press[1] = scrambled;
  }
  return {
    ...s,
    flash,
    waitLeft: s.waitLeft + 37,
    twitches,
    twitchAt,
    press,
    rng: s.rng + 12345,
  };
};

/** 對手的公開狀態：歷史裡對手那一欄、對手的 spent、對手的 wins、對手的槍聲。 */
const scrambleOpponent: Scramble = (s, side) => {
  const opp = side === 0 ? 1 : 0;
  const history = s.history.map((r) => {
    const twitchAt: [readonly number[], readonly number[]] =
      opp === 0 ? [[95, 140], r.twitchAt[1]] : [r.twitchAt[0], [95, 140]];
    const baited: [number, number] = opp === 0 ? [3, r.baited[1]] : [r.baited[0], 3];
    return {
      ...r,
      twitches: [twitchAt[0].length, twitchAt[1].length] as [number, number],
      twitchAt,
      baited,
    };
  });
  const spent: [number, number] = opp === 0 ? [6, s.spent[1]] : [s.spent[0], 6];
  const wins: [number, number] = opp === 0 ? [4, s.wins[1]] : [s.wins[0], 4];
  const press: [S7State['press'][0], S7State['press'][1]] = [s.press[0], s.press[1]];
  press[opp] = { at: 100, valid: true, flashAge: 40, own: false };
  return { ...s, history, spent, wins, press };
};

/** 跑一場貪心 L5 的真實對局，成員當玩家（偶數種子坐 0 號邊），回傳每個 tick 看到的 state 與成員的決定。 */
function recordRun(
  name: string,
  seed: number,
  delay: 0 | 12,
): { states: S7State[]; outs: Buttons[]; side: Side } {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const states: S7State[] = [];
  const outs: Buttons[] = [];
  const member = makeMember(name, seed, delay);
  const spy: Controller<S7State> = {
    decide(state, s, tick) {
      const out = member.decide(state, s, tick);
      states.push(state);
      outs.push(out);
      return out;
    },
  };
  const ai = levelController(s7Game, policyByName('greedy'), 5, seed + 1_000_003);
  const cfg = { maxTicks: 3600, params: {} };
  if (side === 0) {
    playMatch(s7Game, seed, cfg, spy, ai);
  } else {
    playMatch(s7Game, seed, cfg, ai, spy);
  }
  return { states, outs, side };
}

function replayWith(
  name: string,
  seed: number,
  delay: 0 | 12,
  run: ReturnType<typeof recordRun>,
  f: Scramble,
): number {
  const twin = makeMember(name, seed, delay);
  let differ = 0;
  run.states.forEach((state, tick) => {
    const out = twin.decide(f(state, run.side), run.side, tick);
    if (!sameButtons(out, run.outs[tick] as Buttons)) {
      differ += 1;
    }
  });
  return differ;
}

describe('隱藏資訊與對手狀態的邊界（雙胞胎重播）', () => {
  const ALL = [...B_FAMILY, ...C_FAMILY];

  it.each(ALL.map((n) => [n]))(
    '%s 不讀任何隱藏欄位（換掉之後每個 tick 的決定都一樣）',
    (name) => {
      for (const delay of [0, 12] as const) {
        const run = recordRun(name, 3, delay);
        expect(run.states.length).toBeGreaterThan(300);
        expect(replayWith(name, 3, delay, run, scrambleHidden)).toBe(0);
      }
    },
    60_000,
  );

  it.each(B_FAMILY.map((n) => [n]))(
    '(b) %s 不讀對手的狀態（換掉之後每個 tick 的決定都一樣）',
    (name) => {
      for (const delay of [0, 12] as const) {
        for (const seed of [3, 4]) {
          const run = recordRun(name, seed, delay);
          expect(replayWith(name, seed, delay, run, scrambleOpponent)).toBe(0);
        }
      }
    },
    60_000,
  );

  it.each(C_FAMILY.filter((n) => n !== 'c-gunshot').map((n) => [n]))(
    '(c) %s 真的讀了對手（換掉之後至少有一個 tick 的決定不一樣）',
    (name) => {
      let total = 0;
      for (const seed of [3, 4, 5, 6]) {
        const run = recordRun(name, seed, 0);
        total += replayWith(name, seed, 0, run, scrambleOpponent);
      }
      expect(total).toBeGreaterThan(0);
    },
    60_000,
  );

  it('c-gunshot 在延遲 0 讀槍聲（換掉槍聲決定會變）；延遲 12 的真實對局與基底的對照在「分歧率」那一組', () => {
    let total0 = 0;
    for (const seed of [3, 4, 5, 6]) {
      total0 += replayWith('c-gunshot', seed, 0, recordRun('c-gunshot', seed, 0), scrambleOpponent);
    }
    expect(total0).toBeGreaterThan(0);
  }, 60_000);
});

describe('(c) 各自讀的東西（對準的局面）', () => {
  it('c-hist-nof：光亮起的時間在對手過去假光的 ±20 tick 內就等亮滿；沒有就一看到就按', () => {
    // 光在第 130 tick 亮起。有歷史（非第一輪），對手過去在 128 抽過
    const near = lit(0, { history: [rec([[], [127]])] });
    const far = lit(0, { history: [rec([[], [60]])] });
    expect(lastDecision('c-hist-nof', near).a).toBe(false);
    expect(lastDecision('c-hist-nof', far).a).toBe(true);
    // 亮滿 30 tick 再近也按
    expect(lastDecision('c-hist-nof', lit(30, { history: [rec([[], [127]])] })).a).toBe(true);
    // 第一輪沒有歷史：退回 T=105 的守則
    expect(lastDecision('c-hist-nof', lit(0)).a).toBe(true);
    const earlyFirst = makeState({
      elapsed: 100,
      flash: { age: 0, makers: [false, false], real: true },
      waitLeft: 0,
    });
    expect(lastDecision('c-hist-nof', earlyFirst).a).toBe(false);
  });

  it('c-hist-nof 讀的是「對手」那一欄：換成自己的欄不影響', () => {
    const mine = lit(0, { history: [rec([[127], []])] });
    expect(lastDecision('c-hist-nof', mine, 0).a).toBe(true);
    expect(lastDecision('c-hist-nof', mine, 1).a).toBe(false);
  });

  it('c-quota：對手 6 次假動作用完，開頭的光也一看到就按', () => {
    const early = (spentOpp: number): S7State =>
      makeState({
        elapsed: 100,
        flash: { age: 0, makers: [false, false], real: true },
        waitLeft: 0,
        spent: [0, spentOpp],
      });
    expect(lastDecision('c-quota', early(5)).a).toBe(false);
    expect(lastDecision('c-quota', early(6)).a).toBe(true);
  });

  it('c-gunshot：對手已經按了而且光亮滿 30 tick（所以是真的）才跟著按；沒滿就等', () => {
    const opp = { at: 150, valid: true, flashAge: 25, own: false };
    expect(lastDecision('c-gunshot', lit(30, { press: [null, opp], resolveIn: 3 })).a).toBe(true);
    expect(lastDecision('c-gunshot', lit(10, { press: [null, opp], resolveIn: 3 })).a).toBe(false);
  });

  it('c-lead、c-baited：落後或對手常被騙時假動作更多', () => {
    const count = (name: string, extra: Partial<S7State>): number => {
      const m = makeMember(name, 1, 0);
      let n = 0;
      let prev = false;
      for (let t = 0; t < 3000; t += 1) {
        const out = m.decide(
          makeState({ elapsed: 100, flash: null, tick: t, heldB: [prev, false], ...extra }),
          0,
          t,
        );
        prev = out.b;
        n += out.b ? 1 : 0;
      }
      return n;
    };
    expect(count('c-lead', { wins: [0, 2] })).toBeGreaterThan(count('c-lead', { wins: [2, 0] }));
    const baited = [rec([[], []], [0, 1]), rec([[], []], [0, 1])];
    expect(count('c-baited', { history: baited })).toBeGreaterThan(
      count('c-baited', { history: [rec([[], []]), rec([[], []])] }),
    );
  });
});

describe('凍結的 state 上不寫 state', () => {
  it('所有成員在深度凍結的 state 上跑不丟錯', () => {
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      const m = makeMember(name, 2, 12);
      for (let t = 0; t < 60; t += 1) {
        const s = deepFreeze(
          makeState({
            tick: t,
            elapsed: 90 + t,
            flash: t % 3 === 0 ? { age: t % 40, makers: [false, false], real: true } : null,
            waitLeft: t % 3 === 0 ? 0 : 50,
            history: [rec([[100], [110]], [0, 1])],
          }),
        );
        expect(() => m.decide(s, t % 2 === 0 ? 0 : 1, t)).not.toThrow();
      }
    }
  });
});

describe('對局、分歧率與統計', () => {
  const cell: Cell = PRIMARY_CELL;

  it('決策點：光亮著而且我還沒按、不是我還沒亮滿的假光；假動作點：可以抽的 tick', () => {
    expect(isPressPoint(lit(3), 0, 0)).toBe(true);
    expect(isPressPoint(makeState({ elapsed: 100, flash: null }), 0, 0)).toBe(false);
    expect(
      isPressPoint(
        makeState({
          elapsed: 130,
          flash: { age: 3, makers: [true, false], real: false },
          waitLeft: 50,
        }),
        0,
        0,
      ),
    ).toBe(false);
    expect(
      isPressPoint(
        lit(3, { press: [{ at: 1, valid: true, flashAge: 1, own: false }, null] }),
        0,
        0,
      ),
    ).toBe(false);
    expect(isFeintPoint(makeState({ elapsed: 100, flash: null }), 0, 0)).toBe(true);
    expect(isFeintPoint(makeState({ elapsed: 80, flash: null }), 0, 0)).toBe(false);
    expect(isFeintPoint(lit(3), 0, 0)).toBe(false);
  });

  it('同一個成員當驅動者與影子：決策點有、分歧 0', () => {
    const r = divergence(s7Spec('b-guard105-f2', 'b-guard105-f2', [3, 4, 5], cell));
    expect(r.pointBasis).toBe('isPoint');
    expect(r.points).toBeGreaterThan(0);
    expect(r.pointsDiff).toBe(0);
    expect(r.gamesDiffer).toBe(0);
  }, 60_000);

  it('b-reflex 與 b-wait30 的決策點上確實不同', () => {
    const r = divergence(s7Spec('b-reflex', 'b-wait30', [3, 4, 5, 6], cell));
    expect(r.pointsDiff).toBeGreaterThan(0);
    expect(r.gamesDiffer).toBeGreaterThan(0);
  }, 60_000);

  it('c-gunshot 在延遲 12 的格子與基底 b-guard105-f2 場級分歧 0（對自己的檢查）', () => {
    const r = divergence(s7Spec('b-guard105-f2', 'c-gunshot', [3, 4, 5, 6, 7, 8], cell));
    expect(r.gamesDiffer).toBe(0);
  }, 60_000);

  it('影子不影響對局（逐位元）：帶影子與不帶影子的 inputs 與 finalHash 相同，而不同的影子真的做了不同的決定', () => {
    const seed = 4;
    for (const driver of ['b-guard105-f2', 'c-hist-f2']) {
      const plain = playWith(seed, makeMember(driver, seed, 12), cell);
      const { ctl, stat } = shadow(
        makeMember(driver, seed, 12),
        makeMember('b-reflex', seed, 12),
        isPressPoint,
      );
      const shadowed = playWith(seed, ctl, cell);
      expect(stat.diffTicks).toBeGreaterThan(0);
      expect(shadowed.match.inputs).toEqual(plain.match.inputs);
      expect(shadowed.match.finalHash).toBe(plain.match.finalHash);
    }
  }, 60_000);

  it('compareBC：|(c)−(b) 勝率| ≤ 場級分歧率，沒有一致性違規；配對 SE 是配對差的標準誤', () => {
    const seeds = [10, 11, 12, 13, 14, 15];
    const r = compareBC(s7Spec('b-guard105', 'b-guard105-f2', seeds, cell));
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
    const bs = seeds.map((s) => playWith(s, makeMember('b-guard105', s, 12), cell));
    const cs = seeds.map((s) => playWith(s, makeMember('b-guard105-f2', s, 12), cell));
    const diffs = cs.map((c, i) => c.margin - (bs[i] as { margin: number }).margin);
    expect(r.margin.diff.mean).toBeCloseTo(pairedStats(diffs).mean, 12);
    expect(r.margin.diff.se).toBeCloseTo(pairedStats(diffs).se, 12);
  }, 60_000);

  it('選法：勝率高者；同勝率取分差高；再同取排在前面的', () => {
    expect(
      selectBest([
        { name: 'x', win: 40, margin: 9 },
        { name: 'y', win: 51, margin: 1 },
      ]),
    ).toBe('y');
    expect(
      selectBest([
        { name: 'x', win: 51, margin: 1 },
        { name: 'y', win: 51, margin: 2 },
      ]),
    ).toBe('y');
    expect(
      selectBest([
        { name: 'x', win: 51, margin: 2 },
        { name: 'y', win: 51, margin: 2 },
      ]),
    ).toBe('x');
  });

  it('工具檔 import 共用的影子與統計，不再自己定義 pairedStats 或逐 tick 的分歧計數', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    expect(text).toMatch(/from '\.\.\/\.\.\/\.\.\/tests\/ai\/probe-a\.shared'/);
    expect(text).not.toMatch(/export function pairedStats/);
    expect(text).not.toMatch(/diffTicks \+= 1/);
  });
});

describe('等待有沒有成本：S-7 的 evaluate（釘住 10.54 第五節第 3 項與小規格的查證）', () => {
  const idleLit = (age: number): S7State =>
    makeState({
      elapsed: 150,
      flash: { age, makers: [false, false], real: true },
      waitLeft: 0,
    });
  const press: Buttons = { ...IDLE, a: true };

  it('「光亮著、我還沒按」的 evaluate 不看光亮了多久：亮 0 到 100 tick，gain 全是 0、danger 全是 0', () => {
    for (const age of [0, 5, 10, 20, 29, 30, 40, 100]) {
      const e = evaluate(idleLit(age), 0);
      expect(e.gain).toBe(0);
      expect(e.danger).toBe(0);
    }
  });

  it('按下去之後的價值不是越晚越低：亮 0 到 29 tick 都一樣，亮滿 30 之後更高', () => {
    const after = (age: number): { gain: number; danger: number } =>
      evaluate(s7Game.step(idleLit(age), [press, IDLE]), 0);
    const early = after(0);
    for (const age of [5, 10, 20, 29]) {
      expect(after(age).gain).toBeCloseTo(early.gain, 6);
    }
    expect(after(30).gain).toBeGreaterThan(early.gain);
    expect(after(100).gain).toBeCloseTo(after(30).gain, 6);
    expect(after(30).danger).toBeLessThan(early.danger);
  });

  it('所以在 AI 的估價裡，現在按與晚一點按沒有差別甚至更好（等待沒有成本）', () => {
    const wait = evaluate(s7Game.step(idleLit(10), [IDLE, IDLE]), 0).gain;
    const pressNow = evaluate(s7Game.step(idleLit(10), [press, IDLE]), 0).gain;
    const pressLater = evaluate(s7Game.step(idleLit(35), [press, IDLE]), 0).gain;
    expect(wait).toBe(0);
    expect(pressNow).toBeGreaterThan(0);
    expect(pressLater).toBeGreaterThan(pressNow);
  });
});
