import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import { hashState } from '../../core/hash';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import { deepFreeze } from '../../../tests/contract/freeze';
import {
  DROP_TICKS,
  NOTE_TICKS,
  SLOTS,
  TOTAL_TICKS,
  estimateShared,
  makeState,
  s6Game,
} from './logic';
import type { Note, S6State, Skill } from './logic';

/**
 * S-6 的「共用拍位」選項（小規格第 11 節的提案，`config.params.sharedBeat`，預設關）。
 * 兩邊的曲子放在同一條 8 格的軸上：同一格兩邊都有音就「撞拍」，撞拍的格要同時按兩條軌道
 * （對手那個音的軌道，加上自己曲子裡那一格的軌道）；兩條軌道一樣時只要按一條；撞拍的音只有兩條都按住才算 h；
 * 撞拍時的另一條軌道不算多按。預設關閉時規則與原本逐位相同。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const KEYS = ['left', 'down', 'up', 'right'] as const;
const lanes = (...ls: number[]): Buttons => {
  const b = { ...NONE };
  for (const l of ls) {
    (b as Record<string, boolean>)[KEYS[l] as string] = true;
  }
  return b;
};
const IDLE: Inputs = [NONE, NONE];
const CONFIG = { maxTicks: 3300, params: {} };
const SHARED_CONFIG = { maxTicks: 3300, params: { sharedBeat: 1 } };
const note = (l: number, slot: number): Note => ({ lane: l, slot });

const SKILL0: Skill = {
  laneE: [0, 0, 0, 0],
  laneN: [0, 0, 0, 0],
  laneZ: [0, 0, 0, 0],
  gapE: [0, 0],
  gapN: [0, 0],
  gapZ: [0, 0],
  zeros: 0,
  notes: 0,
};

function inPlay(
  phrases: readonly [readonly Note[], readonly Note[]],
  shared: boolean,
  extra: Partial<S6State> = {},
): S6State {
  return makeState({
    sharedBeat: shared,
    phase: 'play',
    phaseTick: 0,
    phrases,
    hits: [phrases[1].map(() => 0), phrases[0].map(() => 0)],
    over: [0, 0],
    ...extra,
  });
}

/** 走完整個對打階段（結算之後停在 rest）：`pick(phaseTick)` 決定每個 tick 的輸入。 */
function playOut(state: S6State, pick: (phaseTick: number) => Inputs): S6State {
  let s = state;
  while (s.phase === 'play') {
    s = s6Game.step(s, pick(s.phaseTick));
  }
  return s;
}

/** 在第 `slot` 格的音符通過線的 24 個 tick 內，兩邊各按 `b0`／`b1`。 */
const during =
  (slot: number, b0: Buttons, b1: Buttons) =>
  (p: number): Inputs => {
    const start = DROP_TICKS + 12 * slot;
    return p >= start && p < start + NOTE_TICKS ? [b0, b1] : IDLE;
  };

describe('S-6 共用拍位｜選項與初始化', () => {
  it('預設關：init 的 sharedBeat 是 false；params.sharedBeat = 1 才開', () => {
    expect(s6Game.init(1, CONFIG).sharedBeat).toBe(false);
    expect(s6Game.init(1, { maxTicks: 3300, params: { sharedBeat: 0 } }).sharedBeat).toBe(false);
    expect(s6Game.init(1, SHARED_CONFIG).sharedBeat).toBe(true);
  });

  it('開關不改變一場的長度（2940 tick）與 maxTicks 的檢查', () => {
    expect(() => s6Game.init(1, { maxTicks: 2939, params: { sharedBeat: 1 } })).toThrow(RangeError);
    let s = s6Game.init(2, SHARED_CONFIG);
    while (!s6Game.isOver(s)) {
      s = s6Game.step(s, IDLE);
    }
    expect(s.tick).toBe(TOTAL_TICKS);
  });
});

describe('S-6 共用拍位｜撞拍：兩條軌道同時按才算', () => {
  // 0 號邊編 ← 在第 0 格，1 號邊編 ↓ 在第 0 格：同一格兩邊都有音，軌道不同。
  const phrases: readonly [readonly Note[], readonly Note[]] = [[note(0, 0)], [note(1, 0)]];

  it('撞拍、兩條都按住整個音符：0 號邊打 ↓（1 號邊的音）得 3 分，不算多按', () => {
    const end = playOut(inPlay(phrases, true), during(0, lanes(0, 1), NONE));
    expect(end.last?.e[0]).toEqual([3]);
    expect(end.last?.penalty[0]).toBe(0);
    expect(end.last?.e[1]).toEqual([0]);
  });

  it('撞拍、只按對手那個音的軌道：h = 0，E = 0（預設關閉時同樣的按法是 3 分）', () => {
    const shared = playOut(inPlay(phrases, true), during(0, lanes(1), NONE));
    expect(shared.last?.e[0]).toEqual([0]);
    const plain = playOut(inPlay(phrases, false), during(0, lanes(1), NONE));
    expect(plain.last?.e[0]).toEqual([3]);
  });

  it('撞拍、只按自己曲子的那條軌道：E = 0，而且不算多按', () => {
    const end = playOut(inPlay(phrases, true), during(0, lanes(0), NONE));
    expect(end.last?.e[0]).toEqual([0]);
    expect(end.last?.penalty[0]).toBe(0);
    expect(end.over[0]).toBe(0);
  });

  it('撞拍、兩條只按住前半（12 tick）：h = 12，E = 2', () => {
    const half = (p: number): Inputs => (p >= 60 && p < 72 ? [lanes(0, 1), NONE] : IDLE);
    const end = playOut(inPlay(phrases, true), half);
    expect(end.last?.e[0]).toEqual([2]);
  });

  it('兩邊對稱：1 號邊打 ←，同樣要兩條都按', () => {
    const both = playOut(inPlay(phrases, true), during(0, NONE, lanes(0, 1)));
    expect(both.last?.e[1]).toEqual([3]);
    const one = playOut(inPlay(phrases, true), during(0, NONE, lanes(0)));
    expect(one.last?.e[1]).toEqual([0]);
  });

  it('撞拍時零分的音符照樣給對手 2 分：0 號邊漏了，1 號邊的曲子被零分，1 號邊得 2', () => {
    const end = playOut(inPlay(phrases, true), during(0, lanes(1), lanes(0, 1)));
    expect(end.last?.e[0]).toEqual([0]);
    expect(end.last?.bonus[1]).toBe(2);
    expect(end.points[1]).toBe(3 + 2);
  });

  it('撞拍、兩邊的軌道一樣：只要按那一條就是 3 分', () => {
    const same: readonly [readonly Note[], readonly Note[]] = [[note(2, 0)], [note(2, 0)]];
    const end = playOut(inPlay(same, true), during(0, lanes(2), lanes(2)));
    expect(end.last?.e).toEqual([[3], [3]]);
    expect(end.last?.penalty).toEqual([0, 0]);
  });

  it('撞拍的第三條軌道算多按：整個音符期間多按一條 → 24 個 tick → 扣 2 分', () => {
    const end = playOut(inPlay(phrases, true), during(0, lanes(0, 1, 3), NONE));
    expect(end.last?.e[0]).toEqual([3]);
    expect(end.last?.penalty[0]).toBe(2);
  });

  it('自己曲子的那條軌道在撞拍的窗口之外按著：算多按（只有撞拍的那一格有豁免）', () => {
    const early = (p: number): Inputs => (p >= 12 && p < 36 ? [lanes(0), NONE] : IDLE);
    const end = playOut(inPlay(phrases, true), early);
    expect(end.last?.penalty[0]).toBe(2);
  });

  it('沒有撞拍（隔一格）：和原本的規則完全一樣，只按那一條就是 3 分，按自己曲子的軌道算多按', () => {
    const apart: readonly [readonly Note[], readonly Note[]] = [[note(0, 1)], [note(1, 0)]];
    const ok = playOut(inPlay(apart, true), during(0, lanes(1), NONE));
    expect(ok.last?.e[0]).toEqual([3]);
    const wrong = playOut(inPlay(apart, true), during(0, lanes(1, 0), NONE));
    expect(wrong.last?.penalty[0]).toBeGreaterThan(0);
  });

  it('關閉時：撞拍的格子照原本規則，按自己曲子的軌道算多按', () => {
    const end = playOut(inPlay(phrases, false), during(0, lanes(1, 0), NONE));
    expect(end.last?.e[0]).toEqual([3]);
    expect(end.last?.penalty[0]).toBe(2);
  });
});

describe('S-6 共用拍位｜歷史多記的東西', () => {
  const phrases: readonly [readonly Note[], readonly Note[]] = [
    [note(0, 0), note(2, 4)],
    [note(1, 0), note(3, 6)],
  ];

  it('開啟時：history 記下自己編的曲子放在哪幾格（placed）與撞拍音的準度（chordE／chordN／chordZ）', () => {
    const end = playOut(inPlay(phrases, true), (p) => [
      p >= 60 && p < 84 ? lanes(0, 1) : p >= 120 && p < 144 ? lanes(3) : NONE,
      p >= 60 && p < 84 ? lanes(0, 1) : p >= 108 && p < 132 ? lanes(2) : NONE,
    ]);
    const h0 = end.history[0][0] as Skill;
    const h1 = end.history[1][0] as Skill;
    expect(h0.placed).toEqual([1, 0, 0, 0, 1, 0, 0, 0]);
    expect(h1.placed).toEqual([1, 0, 0, 0, 0, 0, 1, 0]);
    expect(h0.chordN).toBe(1);
    expect(h0.chordE).toBe(3);
    expect(h0.chordZ).toBe(0);
  });

  it('撞拍的音漏掉：chordZ 記一筆零分', () => {
    const end = playOut(inPlay(phrases, true), during(0, lanes(1), lanes(0, 1)));
    const h0 = end.history[0][0] as Skill;
    expect(h0.chordN).toBe(1);
    expect(h0.chordE).toBe(0);
    expect(h0.chordZ).toBe(1);
  });

  it('兩條軌道一樣的撞拍不算「難的撞拍」：chordN 不增加', () => {
    const same: readonly [readonly Note[], readonly Note[]] = [[note(2, 0)], [note(2, 0)]];
    const end = playOut(inPlay(same, true), during(0, lanes(2), lanes(2)));
    expect((end.history[0][0] as Skill).chordN).toBe(0);
    expect((end.history[0][0] as Skill).placed).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('關閉時：history 完全沒有這些欄位', () => {
    const end = playOut(inPlay(phrases, false), during(0, lanes(1), lanes(0)));
    const h0 = end.history[0][0] as Skill;
    expect(h0.placed).toBeUndefined();
    expect(h0.chordN).toBeUndefined();
  });
});

describe('S-6 共用拍位｜actions 與 evaluate 的偏好一致', () => {
  const phrases: readonly [readonly Note[], readonly Note[]] = [[note(0, 0)], [note(1, 0)]];

  it('actions：開啟時對打階段 11 個（前 5 個和原本一樣，後 6 個是兩條軌道的組合）；編曲 5 個；關閉時對打 5 個', () => {
    const on = s6Game.actions(inPlay(phrases, true), 0);
    const off = s6Game.actions(inPlay(phrases, false), 0);
    expect(on).toHaveLength(11);
    expect(off).toHaveLength(5);
    expect(on.slice(0, 5)).toEqual(off);
    for (const b of on.slice(5)) {
      expect([b.left, b.down, b.up, b.right].filter(Boolean)).toHaveLength(2);
    }
    expect(new Set(on.map((b) => JSON.stringify(b))).size).toBe(11);
    expect(s6Game.actions(makeState({ sharedBeat: true }), 0)).toHaveLength(5);
  });

  it('撞拍的音符正在通過時：兩條軌道一起按的 gain 嚴格最大，而且只有它一個最大（沒有平手）', () => {
    let s = inPlay(phrases, true);
    while (s.phaseTick < 70) {
      s = s6Game.step(s, [lanes(0, 1), NONE]);
    }
    const gains = s6Game
      .actions(s, 0)
      .map((b) => ({ b, e: s6Game.evaluate(s6Game.step(s, [b, NONE]), 0) }));
    const top = Math.max(...gains.map((g) => g.e.gain));
    const best = gains.filter((g) => g.e.gain === top);
    expect(best).toHaveLength(1);
    expect(best[0]?.b.left && best[0]?.b.down && !best[0]?.b.up && !best[0]?.b.right).toBe(true);
    expect(best[0]?.e.danger).toBe(0);
    // 按撞拍窗口以外的軌道組合：danger 是 1。
    const wrong = gains.find((g) => g.b.up && g.b.right);
    expect(wrong?.e.danger).toBe(1);
  });

  it('等級 10 的精準型打共用拍位：整場每個音都 E = 3、多按 0（執行得出來）', () => {
    let s = s6Game.init(3, SHARED_CONFIG);
    const a = levelController(s6Game, precise, 10, 11);
    const b = levelController(s6Game, precise, 10, 12);
    let clashes = 0;
    let rounds = 0;
    let allThree = true;
    while (!s6Game.isOver(s)) {
      const before = s.phase;
      s = s6Game.step(s, [a.decide(s, 0, s.tick), b.decide(s, 1, s.tick)]);
      if (before === 'compose' && s.phase === 'play') {
        clashes += s.phrases[0].filter((n) => s.phrases[1].some((m) => m.slot === n.slot)).length;
        rounds += 1;
      }
      if (before === 'play' && s.phase === 'rest' && s.last !== null) {
        allThree = allThree && [...s.last.e[0], ...s.last.e[1]].every((x) => x === 3);
        expect(s.last.penalty).toEqual([0, 0]);
      }
    }
    expect(rounds).toBe(10);
    expect(allThree).toBe(true);
    expect(clashes).toBeGreaterThanOrEqual(0);
    expect(s.points[0]).toBe(s.points[1]);
  });
});

describe('S-6 共用拍位｜AI 讀對手放在哪一格與撞拍準度', () => {
  /** 對手 5 回合：每回合在第 0 格與第 4 格放音（placed），撞拍的準度由參數決定。 */
  function opponent(chordE: number, chordZ: number, chordN: number): readonly Skill[] {
    const one: Skill = {
      ...SKILL0,
      laneE: [3, 3, 3, 3],
      laneN: [1, 1, 1, 1],
      laneZ: [0, 0, 0, 0],
      gapE: [6, 6],
      gapN: [2, 2],
      gapZ: [0, 0],
      zeros: 0,
      notes: 4,
      placed: [1, 0, 0, 0, 1, 0, 0, 0],
      chordE,
      chordN,
      chordZ,
    };
    return [one, one, one, one, one];
  }

  it('對手總是放第 0 格、撞拍的音都打爛：我放第 0 格的零分機率嚴格大於放第 6 格', () => {
    const history = opponent(0, 5, 5);
    const at0 = estimateShared(history, 0, 1, 1);
    const at6 = estimateShared(history, 6, 1, 1);
    expect(at0.clash).toBeGreaterThan(at6.clash);
    expect(at0.z).toBeGreaterThan(at6.z);
    expect(at0.e).toBeLessThan(at6.e);
  });

  it('對手撞拍的音都打得完美：放哪一格都一樣好（零分機率不隨格子增加）', () => {
    const history = opponent(15, 0, 5);
    const at0 = estimateShared(history, 0, 1, 1);
    const at6 = estimateShared(history, 6, 1, 1);
    expect(at0.z).toBeLessThanOrEqual(at6.z);
    expect(at0.e).toBeGreaterThanOrEqual(at6.e);
  });

  it('沒有歷史：每一格的估計完全一樣（先驗）', () => {
    const base = estimateShared([], 0, 2, 1);
    for (let slot = 1; slot < SLOTS; slot += 1) {
      expect(estimateShared([], slot, 2, 1)).toEqual(base);
    }
  });

  it('編曲的 evaluate：對手愛放第 0 格而且撞拍打不好 → 我放在第 0 格的 gain 嚴格大於第 6 格', () => {
    const state = makeState({ sharedBeat: true, history: [opponent(0, 5, 5), []] });
    const pressAt = (slot: number): { gain: number; danger: number } => {
      let s = state;
      while (s.phaseTick < slot * 12) {
        s = s6Game.step(s, IDLE);
      }
      return s6Game.evaluate(s6Game.step(s, [NONE, lanes(1)]), 1);
    };
    expect(pressAt(0).gain).toBeGreaterThan(pressAt(6).gain);
  });

  it('關閉時：同一份歷史，放哪一格的 gain 只差折扣（不讀 placed）', () => {
    const on = makeState({ sharedBeat: true, history: [opponent(0, 5, 5), []] });
    const off = makeState({ sharedBeat: false, history: [opponent(0, 5, 5), []] });
    const e = (st: S6State): number => s6Game.evaluate(s6Game.step(st, [NONE, lanes(1)]), 1).gain;
    expect(e(on)).not.toBe(e(off));
  });
});

describe('S-6 共用拍位｜不偷看與純度', () => {
  const history: readonly [readonly Skill[], readonly Skill[]] = [
    [
      {
        ...SKILL0,
        laneN: [2, 2, 2, 2],
        laneE: [3, 3, 3, 3],
        laneZ: [1, 1, 1, 1],
        gapN: [4, 4],
        gapE: [6, 6],
        gapZ: [2, 2],
        notes: 8,
        zeros: 4,
        placed: [1, 0, 1, 0, 1, 0, 0, 0],
        chordE: 1,
        chordN: 3,
        chordZ: 2,
      },
    ],
    [SKILL0],
  ];
  const VARIANTS: readonly (readonly Note[])[] = [
    [],
    [note(0, 0)],
    [note(1, 0), note(2, 2)],
    [note(3, 1), note(0, 3), note(1, 5), note(2, 7)],
  ];

  function stateWith(side: Side, theirs: readonly Note[], phaseTick: number): S6State {
    const opp: Side = side === 0 ? 1 : 0;
    const composing: [readonly Note[], readonly Note[]] = [[], []];
    composing[side] = [note(1, 0)];
    composing[opp] = theirs;
    return makeState({ sharedBeat: true, history, composing, phaseTick, tick: phaseTick });
  }

  it('evaluate 與 actions：編曲階段兩邊都不偷看對手的草稿', () => {
    for (const phaseTick of [0, 13, 47, 90, 95]) {
      for (const side of [0, 1] as const) {
        const states = VARIANTS.map((v) => stateWith(side, v, phaseTick));
        const first = states[0] as S6State;
        const e0 = JSON.stringify(s6Game.evaluate(first, side));
        const a0 = JSON.stringify(s6Game.actions(first, side));
        for (const s of states) {
          expect(JSON.stringify(s6Game.evaluate(s, side))).toBe(e0);
          expect(JSON.stringify(s6Game.actions(s, side))).toBe(a0);
        }
      }
    }
  });

  it('黑箱：四個性格在深度 1、3、6，只有對手草稿不同的局面，按的鍵都相同', () => {
    const policies: readonly Policy[] = [pathfinder, precise, greedy, gambler];
    for (const side of [0, 1] as const) {
      for (const phaseTick of [0, 24, 61, 90, 95]) {
        for (const policy of policies) {
          for (const depth of [1, 3, 6]) {
            const presses = VARIANTS.map((v) =>
              JSON.stringify(
                policy.decide(s6Game, stateWith(side, v, phaseTick), side, phaseTick, {
                  depth,
                  seed: 1,
                }),
              ),
            );
            for (const press of presses) {
              expect(press, `${policy.name} 深度 ${depth} phaseTick ${phaseTick}`).toBe(presses[0]);
            }
          }
        }
      }
    }
  });

  it('偵測器會紅：故意洩漏的 evaluate（偷看對手草稿的格子）被抓到', () => {
    const leaky: Game<S6State> = {
      ...s6Game,
      evaluate(state, side) {
        const e = s6Game.evaluate(state, side);
        const opp = side === 0 ? 1 : 0;
        const bonus = state.composing[side].filter((n) =>
          state.composing[opp].some((m) => m.slot === n.slot),
        );
        return { gain: e.gain + bonus.length, danger: e.danger };
      },
    };
    const states = VARIANTS.map((v) => stateWith(1, v, 24));
    const first = states[0] as S6State;
    const e0 = JSON.stringify(leaky.evaluate(first, 1));
    expect(states.some((s) => JSON.stringify(leaky.evaluate(s, 1)) !== e0)).toBe(true);
  });

  it('step 不改動傳進來的 state（開啟共用拍位，凍結後整場不丟錯、雜湊不變）', () => {
    let s = s6Game.init(4, SHARED_CONFIG);
    const ai0 = levelController(s6Game, precise, 5, 1);
    const ai1 = levelController(s6Game, greedy, 3, 2);
    while (!s6Game.isOver(s)) {
      const before = hashState(s);
      deepFreeze(s);
      const next = s6Game.step(s, [ai0.decide(s, 0, s.tick), ai1.decide(s, 1, s.tick)]);
      expect(hashState(s)).toBe(before);
      s = next;
    }
  });
});
