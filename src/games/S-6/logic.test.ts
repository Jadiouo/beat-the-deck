import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import { hashState } from '../../core/hash';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Game, Inputs, Side } from '../../core/types';
import { deepFreeze } from '../../../tests/contract/freeze';
import {
  COMPOSE_TICKS,
  DROP_TICKS,
  HISTORY_ROUNDS,
  NOTE_TICKS,
  PLAY_TICKS,
  REST_TICKS,
  ROUNDS,
  ROUND_TICKS,
  SCORE_UNIT,
  SLOT_TICKS,
  TOTAL_TICKS,
  gapKinds,
  makeState,
  noteScore,
  s6Game,
} from './logic';
import type { Note, S6State, Skill } from './logic';

/**
 * S-6 節拍的規則測試（小規格 `docs/cards/S-6.md`「規則測試要涵蓋」）。
 * 用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。0 號邊是人，1 號邊是 AI。
 * 軌道 0 到 3 對應 ← ↓ ↑ →（left、down、up、right）；`phrases[s]` 是 s 編的曲子，s 的對手打它。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const KEYS = ['left', 'down', 'up', 'right'] as const;
const lane = (l: number): Buttons => ({ ...NONE, [KEYS[l] as string]: true });
const lanes = (...ls: number[]): Buttons => {
  const b = { ...NONE };
  for (const l of ls) {
    (b as Record<string, boolean>)[KEYS[l] as string] = true;
  }
  return b;
};
const IDLE: Inputs = [NONE, NONE];
/** 把幾組按鍵合起來（任何一組按著就算按著）。 */
const merge = (...bs: Buttons[]): Buttons => ({
  up: bs.some((b) => b.up),
  down: bs.some((b) => b.down),
  left: bs.some((b) => b.left),
  right: bs.some((b) => b.right),
  a: bs.some((b) => b.a),
  b: bs.some((b) => b.b),
});
const CONFIG = { maxTicks: 3300, params: {} };

function run(state: S6State, count: number, inputs: Inputs = IDLE): S6State {
  let s = state;
  for (let i = 0; i < count; i += 1) {
    s = s6Game.step(s, inputs);
  }
  return s;
}

/** 一路 step 到 `phaseTick` 走到指定的值（同一個 phase 內）。 */
function until(state: S6State, phaseTick: number, inputs: Inputs = IDLE): S6State {
  return run(state, phaseTick - state.phaseTick, inputs);
}

const note = (l: number, slot: number): Note => ({ lane: l, slot });

/** 一個空的準度紀錄。 */
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

/** 直接站在對打階段：兩邊的曲子已編好（`phrases[s]` 是 s 編的）。 */
function inPlay(
  phrases: readonly [readonly Note[], readonly Note[]],
  extra: Partial<S6State> = {},
): S6State {
  return makeState({
    phase: 'play',
    phaseTick: 0,
    phrases,
    hits: [phrases[1].map(() => 0), phrases[0].map(() => 0)],
    over: [0, 0],
    ...extra,
  });
}

/** 對打階段走到某個 phaseTick，每個 tick 的輸入由 `pick(phaseTick)` 決定。 */
function playUntil(
  state: S6State,
  end: number,
  pick: (phaseTick: number) => Inputs = () => IDLE,
): S6State {
  let s = state;
  while (s.phase === 'play' && s.phaseTick < end) {
    s = s6Game.step(s, pick(s.phaseTick));
  }
  return s;
}

/** 在編曲階段把 `draft` 的音符按進去（每個音在它那一格的第一個 tick 按下、下一個 tick 放開）。 */
function compose(
  state: S6State,
  side: Side,
  draft: readonly Note[],
  other: Buttons = NONE,
): S6State {
  let s = state;
  while (s.phase === 'compose') {
    const slot = Math.floor(s.phaseTick / SLOT_TICKS);
    const target = draft.find((n) => n.slot === slot);
    const mine = target !== undefined && s.phaseTick % SLOT_TICKS === 0 ? lane(target.lane) : NONE;
    s = s6Game.step(s, side === 0 ? [mine, other] : [other, mine]);
  }
  return s;
}

describe('S-6 節拍｜常數與初始化', () => {
  it('一回合 96 + 168 + 30 = 294 tick，十回合 2940 tick（約 49 秒）', () => {
    expect(COMPOSE_TICKS).toBe(96);
    expect(PLAY_TICKS).toBe(168);
    expect(REST_TICKS).toBe(30);
    expect(ROUND_TICKS).toBe(294);
    expect(ROUNDS).toBe(10);
    expect(TOTAL_TICKS).toBe(2940);
    expect(NOTE_TICKS).toBe(24);
    expect(DROP_TICKS).toBe(60);
    expect(SLOT_TICKS).toBe(12);
    expect(HISTORY_ROUNDS).toBe(5);
  });

  it('init：第 0 回合、編曲階段、沒有曲子、分數 0、歷史空', () => {
    const s = s6Game.init(0, CONFIG);
    expect(s.round).toBe(0);
    expect(s.phase).toBe('compose');
    expect(s.phaseTick).toBe(0);
    expect(s.tick).toBe(0);
    expect(s.phrases).toEqual([[], []]);
    expect(s.composing).toEqual([[], []]);
    expect(s.points).toEqual([0, 0]);
    expect(s.history).toEqual([[], []]);
    expect(s.last).toBeNull();
    expect(s.taste[0]).toHaveLength(4);
    expect(s.taste[1]).toHaveLength(4);
  });

  it('maxTicks 小於 2940 時 init 丟 RangeError；剛好 2940 可以', () => {
    expect(() => s6Game.init(0, { maxTicks: 2939, params: {} })).toThrow(RangeError);
    expect(() => s6Game.init(0, { maxTicks: 2940, params: {} })).not.toThrow();
  });

  it('兩邊都不動：走滿 2939 tick 還沒結束，第 2940 tick 結束；分數 0，平手', () => {
    let s = s6Game.init(1, CONFIG);
    s = run(s, TOTAL_TICKS - 1);
    expect(s6Game.isOver(s)).toBe(false);
    s = s6Game.step(s, IDLE);
    expect(s6Game.isOver(s)).toBe(true);
    expect(s.phase).toBe('over');
    expect(s.tick).toBe(TOTAL_TICKS);
    // 兩邊都被補了音、也都沒按：各自 E = 0，加上對方零分音符的獎勵，所以兩邊對稱，平手。
    expect(s6Game.winner(s)).toBeNull();
  });

  it('一回合的階段：96 tick 後對打、264 tick 後停頓、294 tick 後下一回合', () => {
    let s = s6Game.init(0, CONFIG);
    s = run(s, 95);
    expect(s.phase).toBe('compose');
    s = run(s, 1);
    expect(s.phase).toBe('play');
    expect(s.phaseTick).toBe(0);
    s = run(s, 167);
    expect(s.phase).toBe('play');
    s = run(s, 1);
    expect(s.phase).toBe('rest');
    s = run(s, 29);
    expect(s.phase).toBe('rest');
    s = run(s, 1);
    expect(s.phase).toBe('compose');
    expect(s.round).toBe(1);
  });

  it('結束之後再 step 不變', () => {
    const s = run(s6Game.init(2, CONFIG), TOTAL_TICKS);
    const again = run(s, 50);
    expect(hashState(again)).toBe(hashState(s));
  });
});

describe('S-6 節拍｜編曲：格子、最小間隔、至少 2 個音', () => {
  it('在游標經過的那一格按軌道鍵，就在那一格放一個音；格子由 phaseTick 算（每 12 tick 一格）', () => {
    const base = makeState({});
    expect(until(base, 1, [lane(2), NONE]).composing[0]).toEqual([note(2, 0)]);
    const at11 = run(until(base, 11), 1, [lane(1), NONE]);
    expect(at11.composing[0]).toEqual([note(1, 0)]);
    const at12 = run(until(base, 12), 1, [lane(1), NONE]);
    expect(at12.composing[0]).toEqual([note(1, 1)]);
    const at24 = run(until(base, 24), 1, [lane(3), NONE]);
    expect(at24.composing[0]).toEqual([note(3, 2)]);
  });

  it('兩邊各編各的：1 號邊的按鍵進 composing[1]，不進 composing[0]', () => {
    const s = run(makeState({}), 1, [NONE, lane(3)]);
    expect(s.composing[0]).toEqual([]);
    expect(s.composing[1]).toEqual([note(3, 0)]);
  });

  it('一直按著同一軌道跨過格子：只算一個音（按下去的那一刻才算，不是按住）', () => {
    const s = run(makeState({}), 40, [lane(1), NONE]);
    expect(s.composing[0]).toEqual([note(1, 0)]);
  });

  it('直接從一軌換到另一軌（沒放開）算新的一次按下', () => {
    let s = run(makeState({}), 24, [lane(0), NONE]);
    s = run(s, 1, [lane(3), NONE]);
    expect(s.composing[0]).toEqual([note(0, 0), note(3, 2)]);
  });

  it('音與音的起點至少隔 2 格：隔 1 格的按鍵不算，隔 2 格的算', () => {
    let s = run(makeState({}), 1, [lane(0), NONE]); // 第 0 格
    s = run(s, 11, IDLE);
    s = run(s, 1, [lane(1), NONE]); // 第 1 格：太近，不算
    expect(s.composing[0]).toEqual([note(0, 0)]);
    s = run(s, 11, IDLE);
    s = run(s, 1, [lane(2), NONE]); // 第 2 格：可以
    expect(s.composing[0]).toEqual([note(0, 0), note(2, 2)]);
  });

  it('每個 tick 都在按放之間交替：最多 4 個音（第 0、2、4、6 格）', () => {
    let s = makeState({});
    for (let t = 0; t < COMPOSE_TICKS - 1; t += 1) {
      s = s6Game.step(s, [t % 2 === 0 ? lane(t % 4) : NONE, NONE]);
    }
    expect(s.composing[0].map((n) => n.slot)).toEqual([0, 2, 4, 6]);
  });

  it('可以從第 1 格開始排到第 7 格：1、3、5、7 也是 4 個音', () => {
    const s = compose(makeState({}), 0, [note(0, 1), note(1, 3), note(2, 5), note(3, 7)]);
    expect(s.phrases[0].map((n) => n.slot)).toEqual([1, 3, 5, 7]);
    expect(s.phrases[0].map((n) => n.lane)).toEqual([0, 1, 2, 3]);
  });

  it('同時按好幾個軌道：取最左邊的（← ↓ ↑ → 的順序）', () => {
    const s = run(makeState({}), 1, [lanes(3, 1), NONE]);
    expect(s.composing[0]).toEqual([note(1, 0)]);
  });

  it('a、b 不用：只按 a 或 b 不會放音', () => {
    const s = run(makeState({}), 30, [{ ...NONE, a: true, b: true }, NONE]);
    expect(s.composing[0]).toEqual([]);
  });

  it('少於 2 個音：編曲結束時由種子補到 2 個，補的音符合最小間隔、保留原有的音', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const empty = run(s6Game.init(seed, CONFIG), COMPOSE_TICKS);
      for (const side of [0, 1] as const) {
        const p = empty.phrases[side];
        expect(p).toHaveLength(2);
        expect(Math.abs((p[1] as Note).slot - (p[0] as Note).slot)).toBeGreaterThanOrEqual(2);
      }
      const one = compose(s6Game.init(seed, CONFIG), 0, [note(2, 3)]);
      const q = one.phrases[0];
      expect(q).toHaveLength(2);
      expect(q.some((n) => n.lane === 2 && n.slot === 3)).toBe(true);
      const slots = q.map((n) => n.slot).sort((a, b) => a - b);
      expect(slots[1]! - slots[0]!).toBeGreaterThanOrEqual(2);
      for (const n of q) {
        expect(n.slot).toBeGreaterThanOrEqual(0);
        expect(n.slot).toBeLessThanOrEqual(7);
        expect(n.lane).toBeGreaterThanOrEqual(0);
        expect(n.lane).toBeLessThanOrEqual(3);
      }
    }
  });

  it('種子 0..9：補上去的音軌道不全相同（種子有效）', () => {
    const lanesSeen = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      const s = run(s6Game.init(seed, CONFIG), COMPOSE_TICKS);
      lanesSeen.add(s.phrases[0].map((n) => `${n.lane}@${n.slot}`).join(','));
    }
    expect(lanesSeen.size).toBeGreaterThan(1);
  });

  it('編好的曲子照格子排序（slot 由小到大）', () => {
    const s = compose(makeState({}), 0, [note(1, 4), note(0, 0), note(2, 2)]);
    expect(s.phrases[0].map((n) => n.slot)).toEqual([0, 2, 4]);
  });
});

describe('S-6 節拍｜隱藏資訊：編曲階段互相看不到，結算只在編曲結束時發生', () => {
  it('編曲階段 phrases 是空的、分數不動，到第 96 個 tick 才有曲子', () => {
    let s = makeState({});
    for (let t = 0; t < COMPOSE_TICKS - 1; t += 1) {
      s = s6Game.step(s, [lane(t % 4), lane((t + 1) % 4)]);
      expect(s.phrases).toEqual([[], []]);
      expect(s.points).toEqual([0, 0]);
      expect(s.phase).toBe('compose');
    }
    s = s6Game.step(s, IDLE);
    expect(s.phase).toBe('play');
    expect(s.phrases[0].length).toBeGreaterThanOrEqual(2);
    expect(s.composing).toEqual([[], []]);
  });

  it('編曲階段的 step：我這一邊的草稿只取決於我的輸入，不取決於對手的輸入', () => {
    const base = makeState({});
    const seqs: Buttons[] = [lane(0), lane(1), NONE, lanes(0, 3), lane(2)];
    for (const side of [0, 1] as const) {
      const a = run(base, 60, side === 0 ? [lane(1), NONE] : [NONE, lane(1)]);
      const b = run(base, 60, side === 0 ? [lane(1), lane(3)] : [lane(3), lane(1)]);
      expect(a.composing[side]).toEqual(b.composing[side]);
      expect(a.held[side]).toBe(b.held[side]);
    }
    expect(seqs.length).toBe(5);
  });

  it('對打階段：每一邊打的是對方編的曲子（0 號邊打 phrases[1]）', () => {
    // phrases[0]（0 號編的）在軌道 0、phrases[1]（1 號編的）在軌道 3，都在第 0 格：第 60 tick 到線。
    const s0 = inPlay([[note(0, 0)], [note(3, 0)]]);
    const s = playUntil(s0, DROP_TICKS + 10, (p) => (p >= DROP_TICKS ? [lane(3), lane(0)] : IDLE));
    expect(s.hits[0]).toEqual([10]);
    expect(s.hits[1]).toEqual([10]);
    const wrong = playUntil(s0, DROP_TICKS + 10, (p) =>
      p >= DROP_TICKS ? [lane(0), lane(3)] : IDLE,
    );
    expect(wrong.hits[0]).toEqual([0]);
    expect(wrong.hits[1]).toEqual([0]);
  });
});

describe('S-6 節拍｜計分：長音的重疊、多按懲罰、對方零分音符 ×2', () => {
  it('noteScore：E = round(3 × h / 24)，邊界 3→0、4→1、11→1、12→2、19→2、20→3、24→3', () => {
    expect(noteScore(0)).toBe(0);
    expect(noteScore(3)).toBe(0);
    expect(noteScore(4)).toBe(1);
    expect(noteScore(11)).toBe(1);
    expect(noteScore(12)).toBe(2);
    expect(noteScore(19)).toBe(2);
    expect(noteScore(20)).toBe(3);
    expect(noteScore(24)).toBe(3);
  });

  it('音符在第 60 + 12 × 格 tick 到線，過線 24 tick：按住那一軌才算 h', () => {
    // 0 號打 phrases[1]；那裡的音在第 2 格：第 84 tick 開始、第 108 tick 結束（不含）。
    const s0 = inPlay([[], [note(1, 2)]]);
    const early = playUntil(s0, 84, () => [lane(1), NONE]);
    expect(early.hits[0]).toEqual([0]);
    const exact = playUntil(s0, 108, (p) => (p >= 84 ? [lane(1), NONE] : IDLE));
    expect(exact.hits[0]).toEqual([24]);
    const late = playUntil(s0, 115, (p) => (p >= 84 ? [lane(1), NONE] : IDLE));
    expect(late.hits[0]).toEqual([24]);
  });

  it('只按一半（12 tick）：h = 12，E = 2', () => {
    const s0 = inPlay([[], [note(0, 0)]]);
    const s = playUntil(s0, PLAY_TICKS, (p) =>
      p >= DROP_TICKS + 12 && p < DROP_TICKS + 24 ? [lane(0), NONE] : IDLE,
    );
    expect(s.last?.e[0]).toEqual([2]);
  });

  it('剛好的邊界：h = 3 得 0 分，h = 4 得 1 分', () => {
    const s0 = inPlay([[], [note(0, 0)]]);
    const three = playUntil(s0, PLAY_TICKS, (p) =>
      p >= DROP_TICKS && p < DROP_TICKS + 3 ? [lane(0), NONE] : IDLE,
    );
    const four = playUntil(s0, PLAY_TICKS, (p) =>
      p >= DROP_TICKS && p < DROP_TICKS + 4 ? [lane(0), NONE] : IDLE,
    );
    expect(three.last?.e[0]).toEqual([0]);
    expect(four.last?.e[0]).toEqual([1]);
  });

  it('多按懲罰：沒有音符通過的軌道被按住，每 12 個 tick 扣 1 分；11 個 tick 不扣', () => {
    const s0 = inPlay([[], [note(0, 7)]]); // 音在最後，前面 144 tick 都沒有音
    const eleven = playUntil(s0, 60, (p) => (p < 11 ? [lane(2), NONE] : IDLE));
    expect(eleven.over[0]).toBe(11);
    const e1 = playUntil(s0, PLAY_TICKS, (p) => (p < 11 ? [lane(2), NONE] : IDLE));
    expect(e1.last?.penalty[0]).toBe(0);
    const e2 = playUntil(s0, PLAY_TICKS, (p) => (p < 12 ? [lane(2), NONE] : IDLE));
    expect(e2.last?.penalty[0]).toBe(1);
  });

  it('多按的 tick 跨軌道累加：同時按 3 條沒有音的軌道 12 tick = 36 個 tick = 扣 3 分', () => {
    const s0 = inPlay([[], [note(0, 7)]]);
    const s = playUntil(s0, PLAY_TICKS, (p) => (p < 12 ? [lanes(1, 2, 3), NONE] : IDLE));
    expect(s.last?.penalty[0]).toBe(3);
  });

  it('按住所有軌道亂打會虧：整個音符期間四軌全按，h = 24（E = 3）但多按 72 tick 扣 6 分', () => {
    const s0 = inPlay([[], [note(2, 0)]]);
    const s = playUntil(s0, PLAY_TICKS, (p) =>
      p >= DROP_TICKS && p < DROP_TICKS + 24 ? [lanes(0, 1, 2, 3), NONE] : IDLE,
    );
    expect(s.last?.e[0]).toEqual([3]);
    expect(s.last?.penalty[0]).toBe(6);
    expect(s.points[0]).toBe(3 - 6);
  });

  it('音符的軌道按對了、另一軌也按著：另一軌算多按，這一軌照算 h', () => {
    const s0 = inPlay([[], [note(1, 0)]]);
    const s = playUntil(s0, DROP_TICKS + 24, (p) => (p >= DROP_TICKS ? [lanes(1, 3), NONE] : IDLE));
    expect(s.hits[0]).toEqual([24]);
    expect(s.over[0]).toBe(24);
  });

  it('音符過線結束的那個 tick（第 84 tick，不含）還按著：算多按', () => {
    const s0 = inPlay([[], [note(1, 0)]]);
    const s = playUntil(s0, DROP_TICKS + 25, (p) => (p >= DROP_TICKS ? [lane(1), NONE] : IDLE));
    expect(s.hits[0]).toEqual([24]);
    expect(s.over[0]).toBe(1);
  });

  it('對方零分音符 ×2：我編的曲子裡，對方 E = 0 的每個音符給我 2 分', () => {
    // 0 號編了兩個音；1 號什麼都不按 → 兩個音都零分 → 0 號得 4 分。0 號自己打 phrases[1]（1 個音），也不按 → 0 分。
    const s0 = inPlay([[note(0, 0), note(1, 2)], [note(2, 0)]]);
    const s = playUntil(s0, PLAY_TICKS);
    expect(s.last?.bonus).toEqual([4, 2]);
    expect(s.points).toEqual([4, 2]);
  });

  it('對方 E = 1 就不算零分：h = 4 時沒有獎勵', () => {
    const s0 = inPlay([[note(0, 0)], [note(2, 0)]]);
    const s = playUntil(s0, PLAY_TICKS, (p) =>
      p >= DROP_TICKS && p < DROP_TICKS + 4 ? [NONE, lane(0)] : IDLE,
    );
    expect(s.last?.e[1]).toEqual([1]);
    expect(s.last?.bonus[0]).toBe(0);
    expect(s.points[0]).toBe(0);
    expect(s.points[1]).toBe(1 + 2); // 1 號打出 E = 1，加上 0 號打 phrases[1] 零分的獎勵 2
  });

  it('一回合的分數 = 我打對方曲子的 E 總和 − 多按扣分 + 2 ×（我的曲子裡對方零分的音符數）', () => {
    // 0 號打 phrases[1] = [軌道 2 第 0 格, 軌道 0 第 2 格]：第一個音全按（E 3），第二個按 12 tick（E 2），再多按 24 tick（扣 2）。
    // 1 號打 phrases[0] = [軌道 3 第 1 格]：全按（E 3）。0 號的音 1 號沒零分，1 號的兩個音 0 號沒零分。
    const s0 = inPlay([[note(3, 1)], [note(2, 0), note(0, 2)]]);
    const pick = (p: number): Inputs => {
      const first = p >= 60 && p < 84 ? lane(2) : NONE;
      const second = p >= 84 && p < 96 ? lane(0) : NONE;
      const stray = p >= 100 && p < 124 ? lane(1) : NONE;
      const mine = merge(first, second, stray);
      const theirs = p >= 72 && p < 96 ? lane(3) : NONE;
      return [mine, theirs];
    };
    const s = playUntil(s0, PLAY_TICKS, pick);
    expect(s.last?.e[0]).toEqual([3, 2]);
    expect(s.last?.e[1]).toEqual([3]);
    expect(s.last?.penalty).toEqual([2, 0]);
    expect(s.points).toEqual([3 + 2 - 2 + 0, 3]);
  });

  it('分數可以是負的（只亂按）', () => {
    const s0 = inPlay([[note(0, 7)], [note(0, 7)]]);
    const s = playUntil(s0, PLAY_TICKS, (p) => (p < 60 ? [lanes(0, 1, 2), NONE] : IDLE));
    expect(s.points[0]).toBeLessThan(0);
  });

  it('分數逐回合累加；score() 回傳 points', () => {
    let s = inPlay([[note(0, 0)], [note(1, 0)]]);
    s = playUntil(s, PLAY_TICKS, (p) => (p >= 60 && p < 84 ? [lane(1), lane(0)] : IDLE));
    expect(s.points).toEqual([3, 3]);
    expect(s6Game.score(s)).toEqual([3, 3]);
    expect(s.phase).toBe('rest');
  });

  it('贏家是總分高的；同分平手', () => {
    const ahead = makeState({ phase: 'over', points: [5, 3], round: 10 });
    expect(s6Game.winner(ahead)).toBe(0);
    const behind = makeState({ phase: 'over', points: [2, 3], round: 10 });
    expect(s6Game.winner(behind)).toBe(1);
    const tie = makeState({ phase: 'over', points: [3, 3], round: 10 });
    expect(s6Game.winner(tie)).toBeNull();
  });
});

describe('S-6 節拍｜間隔與準度歷史', () => {
  it('gapKinds：第一個音算長間隔；隔 2 格（24 tick）是短，隔 3 格以上（≥ 36 tick）是長', () => {
    expect(gapKinds([])).toEqual([]);
    expect(gapKinds([note(0, 0)])).toEqual([1]);
    expect(gapKinds([note(0, 0), note(1, 2)])).toEqual([1, 0]);
    expect(gapKinds([note(0, 0), note(1, 3)])).toEqual([1, 1]);
    expect(gapKinds([note(0, 1), note(1, 3), note(2, 5), note(3, 7)])).toEqual([1, 0, 0, 0]);
    expect(gapKinds([note(0, 0), note(1, 2), note(2, 5)])).toEqual([1, 0, 1]);
  });

  it('一回合結束後，歷史記下每一邊「打」的準度：軌道、間隔、零分音符數', () => {
    // 0 號打 phrases[1] = [軌道 2 第 0 格, 軌道 0 第 2 格（短間隔）]：第一個全按（E 3），第二個沒按（E 0）。
    const s0 = inPlay([[note(3, 1)], [note(2, 0), note(0, 2)]]);
    const s = playUntil(s0, PLAY_TICKS, (p) => (p >= 60 && p < 84 ? [lane(2), NONE] : IDLE));
    const h = s.history[0][0] as Skill;
    expect(h.laneE).toEqual([0, 0, 3, 0]);
    expect(h.laneN).toEqual([1, 0, 1, 0]);
    expect(h.laneZ).toEqual([1, 0, 0, 0]);
    // 第一個音是長間隔（1）、第二個是短間隔（0）
    expect(h.gapE).toEqual([0, 3]);
    expect(h.gapN).toEqual([1, 1]);
    expect(h.gapZ).toEqual([1, 0]);
    expect(h.zeros).toBe(1);
    expect(h.notes).toBe(2);
    // 1 號打 phrases[0]（1 個音，沒按）
    const h1 = s.history[1][0] as Skill;
    expect(h1.notes).toBe(1);
    expect(h1.zeros).toBe(1);
  });

  it('歷史只留最近 5 回合', () => {
    let s = makeState({});
    for (let r = 0; r < 7; r += 1) {
      s = run(s, ROUND_TICKS);
    }
    expect(s.round).toBe(7);
    expect(s.history[0]).toHaveLength(HISTORY_ROUNDS);
    expect(s.history[1]).toHaveLength(HISTORY_ROUNDS);
    // 第 6 回合開始之後的第一筆是第 3 回合（最舊的兩筆被丟掉）：用 last 與回合數交叉確認長度不再增加
    const more = run(s, ROUND_TICKS);
    expect(more.history[0]).toHaveLength(HISTORY_ROUNDS);
  });

  it('歷史是公開的：同一個 state 的 history[0] 與 history[1] 都完整記錄', () => {
    const s = run(makeState({}), ROUND_TICKS);
    expect(s.history[0]).toHaveLength(1);
    expect(s.history[1]).toHaveLength(1);
  });
});

describe('S-6 節拍｜AI 的編曲：讀對手的準度歷史', () => {
  /** 對手（0 號邊）在軌道 `weak` 上很爛：6 個音全部零分；其他軌道都拿 3 分。 */
  function opponentWeakOn(weak: number): readonly Skill[] {
    const laneE = [0, 0, 0, 0];
    const laneN = [0, 0, 0, 0];
    const laneZ = [0, 0, 0, 0];
    for (let l = 0; l < 4; l += 1) {
      laneN[l] = 6;
      laneE[l] = l === weak ? 0 : 18;
      laneZ[l] = l === weak ? 6 : 0;
    }
    return [
      {
        ...SKILL0,
        laneE,
        laneN,
        laneZ,
        gapE: [9, 27],
        gapN: [12, 12],
        gapZ: [3, 3],
        zeros: 6,
        notes: 24,
      },
    ];
  }

  /** AI（1 號邊）在第 0 格按軌道 `l`，之後的 gain、danger。 */
  function afterPress(state: S6State, l: number): { gain: number; danger: number } {
    const next = s6Game.step(state, [NONE, lane(l)]);
    return s6Game.evaluate(next, 1);
  }

  it('剝削：對手在某軌道出錯多，AI 在那一軌放音的 gain 嚴格較大、danger 嚴格較小', () => {
    for (const weak of [0, 1, 2, 3]) {
      const state = makeState({ history: [opponentWeakOn(weak), []] });
      const onWeak = afterPress(state, weak);
      for (let l = 0; l < 4; l += 1) {
        if (l === weak) {
          continue;
        }
        const other = afterPress(state, l);
        expect(onWeak.gain, `軌道 ${weak} 對 ${l}`).toBeGreaterThan(other.gain);
        expect(onWeak.danger, `軌道 ${weak} 對 ${l}`).toBeLessThan(other.danger);
      }
    }
  });

  it('同樣的局面，把對手的歷史換掉，AI 最好的軌道跟著換（它真的在讀 history）', () => {
    const best = (weak: number): number => {
      const state = makeState({ history: [opponentWeakOn(weak), []] });
      let top = 0;
      let topGain = Number.NEGATIVE_INFINITY;
      for (let l = 0; l < 4; l += 1) {
        const g = afterPress(state, l).gain;
        if (g > topGain) {
          topGain = g;
          top = l;
        }
      }
      return top;
    };
    expect(new Set([0, 1, 2, 3].map(best)).size).toBe(4);
    for (const weak of [0, 1, 2, 3]) {
      expect(best(weak)).toBe(weak);
    }
  });

  it('等級 10 的精準型與貪心型：對手只有軌道 2 很爛時，編的音全在軌道 2', () => {
    for (const policy of [precise, greedy]) {
      let s = makeState({ history: [opponentWeakOn(2), []] });
      const ai = levelController(s6Game, policy, 10, 5);
      while (s.phase === 'compose') {
        s = s6Game.step(s, [NONE, ai.decide(s, 1, s.tick)]);
      }
      expect(s.phrases[1].length).toBeGreaterThanOrEqual(2);
      for (const n of s.phrases[1]) {
        expect(n.lane, policy.name).toBe(2);
      }
    }
  });

  it('冷啟動（歷史空）：四個性格編的曲子不全相同（由性格決定，不是讀你）', () => {
    const policies: Policy[] = [precise, greedy, gambler, pathfinder];
    const made = policies.map((policy) => {
      let s = s6Game.init(0, CONFIG);
      const ai = levelController(s6Game, policy, 10, 3);
      while (s.phase === 'compose') {
        s = s6Game.step(s, [NONE, ai.decide(s, 1, s.tick)]);
      }
      return s.phrases[1];
    });
    expect(new Set(made.map((p) => JSON.stringify(p))).size).toBeGreaterThan(1);
    const precisePhrase = made[0] as readonly Note[];
    const greedyPhrase = made[1] as readonly Note[];
    expect(greedyPhrase.length).toBe(4);
    expect(precisePhrase.length).toBeLessThan(greedyPhrase.length);
  });

  it('同樣的歷史、不同的種子：AI 在沒有差別的軌道之間的選擇不全相同', () => {
    const chosen = new Set<number>();
    for (let seed = 0; seed < 8; seed += 1) {
      let s = s6Game.init(seed, CONFIG);
      const ai = levelController(s6Game, precise, 10, seed);
      while (s.phase === 'compose') {
        s = s6Game.step(s, [NONE, ai.decide(s, 1, s.tick)]);
      }
      chosen.add((s.phrases[1][0] as Note).lane);
    }
    expect(chosen.size).toBeGreaterThan(1);
  });

  it('N 是賭注：對手穩（歷史全拿 3 分）時精準型只出 2 個音；對手很不穩時出到 3 個以上', () => {
    const steady: Skill = {
      ...SKILL0,
      laneE: [12, 12, 12, 12],
      laneN: [4, 4, 4, 4],
      gapE: [24, 24],
      gapN: [8, 8],
      notes: 16,
    };
    const shaky: Skill = {
      ...SKILL0,
      laneE: [0, 0, 0, 0],
      laneN: [4, 4, 4, 4],
      laneZ: [4, 4, 4, 4],
      gapE: [0, 0],
      gapN: [8, 8],
      gapZ: [8, 8],
      zeros: 16,
      notes: 16,
    };
    const count = (hist: Skill): number => {
      let s = makeState({ history: [[hist, hist, hist], []] });
      const ai = levelController(s6Game, precise, 10, 1);
      while (s.phase === 'compose') {
        s = s6Game.step(s, [NONE, ai.decide(s, 1, s.tick)]);
      }
      return s.phrases[1].length;
    };
    expect(count(steady)).toBe(2);
    expect(count(shaky)).toBeGreaterThanOrEqual(3);
  });
});

describe('S-6 節拍｜AI 的對打：精準型不踩空，貪心型搶拍', () => {
  /** 兩邊都是等級 10 的某性格，打一整場，回傳每一回合兩邊的多按扣分總和。 */
  function penaltyTotals(policyA: Policy, policyB: Policy, seed: number): [number, number] {
    let s = s6Game.init(seed, CONFIG);
    const a = levelController(s6Game, policyA, 10, seed);
    const b = levelController(s6Game, policyB, 10, seed + 1);
    const total: [number, number] = [0, 0];
    while (!s6Game.isOver(s)) {
      const before = s.phase;
      s = s6Game.step(s, [a.decide(s, 0, s.tick), b.decide(s, 1, s.tick)]);
      if (before === 'play' && s.phase === 'rest' && s.last !== null) {
        total[0] += s.last.penalty[0];
        total[1] += s.last.penalty[1];
      }
    }
    return total;
  }

  it('等級 10 精準型打對手編的曲子：每個音都 E = 3、一整場沒有多按扣分', () => {
    for (let seed = 0; seed < 3; seed += 1) {
      let s = s6Game.init(seed, CONFIG);
      const ai = levelController(s6Game, precise, 10, seed);
      let everyE = true;
      while (!s6Game.isOver(s)) {
        const before = s.phase;
        s = s6Game.step(s, [ai.decide(s, 0, s.tick), NONE]);
        if (before === 'play' && s.phase === 'rest' && s.last !== null) {
          everyE = everyE && s.last.e[0]!.every((e) => e === 3) && s.last.penalty[0] === 0;
        }
      }
      expect(everyE, `種子 ${seed}`).toBe(true);
    }
  });

  it('貪心型不看多按的 danger（搶拍）：多按扣分比精準型多', () => {
    let precisePenalty = 0;
    let greedyPenalty = 0;
    for (let seed = 0; seed < 3; seed += 1) {
      precisePenalty += penaltyTotals(precise, precise, seed)[0];
      greedyPenalty += penaltyTotals(greedy, precise, seed)[0];
    }
    expect(precisePenalty).toBe(0);
    expect(greedyPenalty).toBeGreaterThan(precisePenalty);
  });
});

describe('S-6 節拍｜不偷看（evaluate、actions、decide 不讀對手正在編的內容）', () => {
  /** 對手草稿的幾種樣子：[草稿, 對手上一個 tick 按住的軌道遮罩, 對手的 taste]。 */
  const VARIANTS: readonly (readonly [readonly Note[], number, readonly number[]])[] = [
    [[], 0, [0, 0, 0, 0]],
    [[note(0, 0)], 1, [0.9, 0.1, 0.4, 0.2]],
    [[note(1, 0), note(2, 2)], 4, [0.2, 0.2, 0.9, 0.1]],
    [[note(3, 1), note(0, 3), note(1, 5), note(2, 7)], 8, [0.5, 0.5, 0.5, 0.5]],
    [[note(2, 0), note(2, 2), note(2, 4)], 4, [0.1, 0.8, 0.3, 0.6]],
  ];

  /** 我方（side）有一個草稿 [軌道 1 第 0 格]，對手（另一邊）的草稿等隱藏資訊用 `variant` 換。 */
  function stateWith(
    side: Side,
    variant: readonly [readonly Note[], number, readonly number[]],
    phaseTick: number,
  ): S6State {
    const opp: Side = side === 0 ? 1 : 0;
    const composing: [readonly Note[], readonly Note[]] = [[], []];
    composing[side] = [note(1, 0)];
    composing[opp] = variant[0];
    const held: [number, number] = [0, 0];
    held[opp] = variant[1];
    const taste: [readonly number[], readonly number[]] = [[], []];
    taste[side] = [0.7, 0.3, 0.6, 0.2];
    taste[opp] = variant[2];
    return makeState({
      history: [[SKILL0, SKILL0], [SKILL0]],
      composing,
      held,
      taste,
      phaseTick,
      tick: phaseTick,
    });
  }

  /** 同一個我方局面，只有對手的隱藏資訊不同：evaluate 與 actions 是否有任何一個不同。 */
  function peeks(game: Game<S6State>, phaseTick: number, side: Side): boolean {
    const states = VARIANTS.map((v) => stateWith(side, v, phaseTick));
    const first = states[0] as S6State;
    const e0 = JSON.stringify(game.evaluate(first, side));
    const a0 = JSON.stringify(game.actions(first, side));
    return states.some(
      (s) =>
        JSON.stringify(game.evaluate(s, side)) !== e0 ||
        JSON.stringify(game.actions(s, side)) !== a0,
    );
  }

  /** 故意洩漏：evaluate 偷看對手草稿的軌道（與我這一邊放的軌道重疊就加分）。 */
  const leaky: Game<S6State> = {
    ...s6Game,
    evaluate(state, side) {
      const e = s6Game.evaluate(state, side);
      const opp = side === 0 ? 1 : 0;
      const theirs = state.composing[opp];
      const bonus = state.composing[side].filter((n) => theirs.some((m) => m.lane === n.lane));
      return { gain: e.gain + bonus.length, danger: e.danger };
    },
  };

  it('evaluate 與 actions：編曲階段（開頭、中段、倒數 6 個 tick 內），兩邊都不偷看', () => {
    for (const phaseTick of [0, 13, 47, 90, 95]) {
      for (const side of [0, 1] as const) {
        expect(peeks(s6Game, phaseTick, side), `phaseTick ${phaseTick} 邊 ${side}`).toBe(false);
      }
    }
  });

  it('偵測器會紅：故意洩漏的 evaluate 被抓到', () => {
    let caught = false;
    for (const phaseTick of [0, 13, 47]) {
      for (const side of [0, 1] as const) {
        caught = caught || peeks(leaky, phaseTick, side);
      }
    }
    expect(caught).toBe(true);
  });

  it('黑箱：四個性格在深度 1、3、6，只有對手隱藏資訊不同的局面，按的鍵都相同（含倒數 6 個 tick 內）', () => {
    const policies: readonly Policy[] = [pathfinder, precise, greedy, gambler];
    for (const side of [0, 1] as const) {
      for (const phaseTick of [0, 24, 61, 90, 93, 95]) {
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

  it('黑箱偵測器會紅：故意洩漏的 evaluate 讓精準型的決定隨對手草稿改變', () => {
    // 對手的歷史要是「不穩」的：精準型在沒有資料（先驗）時本來就不出額外的音（danger 擋下），
    // 洩漏的 gain 加分也蓋不過它；偵測器要在精準型會出音的局面上才有意義。
    const shaky: Skill = {
      ...SKILL0,
      laneE: [0, 0, 0, 0],
      laneN: [4, 4, 4, 4],
      laneZ: [4, 4, 4, 4],
      gapE: [0, 0],
      gapN: [8, 8],
      gapZ: [8, 8],
      zeros: 16,
      notes: 16,
    };
    let changed = false;
    for (const phaseTick of [24, 48, 72]) {
      const presses = VARIANTS.map((v) => {
        const s = {
          ...stateWith(1, v, phaseTick),
          history: [[shaky, shaky, shaky], []] as const,
          composing: [v[0], []] as const,
        };
        return JSON.stringify(
          precise.decide(leaky, s as unknown as S6State, 1, phaseTick, { depth: 1, seed: 1 }),
        );
      });
      changed = changed || presses.some((p) => p !== presses[0]);
    }
    expect(changed).toBe(true);
  });
});

describe('S-6 節拍｜evaluate、actions 與純度', () => {
  it('actions：編曲與對打各 5 個（全放開排第一、四個軌道鍵），停頓與結束只有全放開', () => {
    const compose = makeState({});
    expect(s6Game.actions(compose, 0)).toHaveLength(5);
    expect(s6Game.actions(compose, 1)).toHaveLength(5);
    expect(s6Game.actions(compose, 0)[0]).toEqual(NONE);
    const keys = s6Game
      .actions(compose, 0)
      .slice(1)
      .map((b) => KEYS.filter((k) => b[k]));
    expect(keys).toEqual([['left'], ['down'], ['up'], ['right']]);
    const play = inPlay([[note(0, 0)], [note(1, 0)]]);
    expect(s6Game.actions(play, 0)).toHaveLength(5);
    const rest = makeState({ phase: 'rest' });
    expect(s6Game.actions(rest, 0)).toEqual([NONE]);
    const over = makeState({ phase: 'over' });
    expect(s6Game.actions(over, 1)).toEqual([NONE]);
  });

  it('evaluate：gain 有限、danger 在 0 到 1；結束時 gain = SCORE_UNIT × 領先分數', () => {
    const phases: S6State[] = [
      makeState({}),
      inPlay([[note(0, 0), note(1, 2)], [note(3, 0)]]),
      makeState({ phase: 'rest', points: [3, 1] }),
      makeState({ phase: 'over', points: [3, 1], round: 10 }),
    ];
    for (const s of phases) {
      for (const side of [0, 1] as const) {
        const e = s6Game.evaluate(s, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
    expect(s6Game.evaluate(phases[3] as S6State, 0).gain).toBe(2 * SCORE_UNIT);
    expect(s6Game.evaluate(phases[3] as S6State, 1).gain).toBe(-2 * SCORE_UNIT);
  });

  it('對打階段：按對軌道的 gain 嚴格較大；按到沒有音的軌道 danger 大於 0，按對的軌道 danger 是 0', () => {
    const s0 = inPlay([[], [note(1, 0)]]);
    const at = until(s0, DROP_TICKS + 3, IDLE);
    const right = s6Game.evaluate(s6Game.step(at, [lane(1), NONE]), 0);
    const wrong = s6Game.evaluate(s6Game.step(at, [lane(2), NONE]), 0);
    const none = s6Game.evaluate(s6Game.step(at, IDLE), 0);
    expect(right.gain).toBeGreaterThan(none.gain);
    expect(right.gain).toBeGreaterThan(wrong.gain);
    expect(right.danger).toBe(0);
    expect(wrong.danger).toBeGreaterThan(0);
    expect(none.danger).toBe(0);
  });

  it('step 不改動傳進來的 state（深度凍結後 step 一整場不丟錯、雜湊不變）', () => {
    let s = s6Game.init(4, CONFIG);
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

  it('十回合一定結束：兩個隨機按的控制器，在 maxTicks 之內結束', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      const rnd = (side: Side): Controller<S6State> => ({
        decide(state: S6State, who: Side, tick: number): Buttons {
          const actions = s6Game.actions(state, who);
          return actions[(tick * 7 + seed * 3 + side * 5) % actions.length] as Buttons;
        },
      });
      const r = playMatch(s6Game, seed, CONFIG, rnd(0), rnd(1));
      expect(r.ticks).toBe(TOTAL_TICKS);
    }
  });
});
