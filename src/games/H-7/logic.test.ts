import { describe, expect, it } from 'vitest';

import { levelController, wrapPolicy } from '../../ai/level';
import { humanModel } from '../../ai/human-model';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { random } from '../../ai/policies/random';
import { hashState } from '../../core/hash';
import { playMatch } from '../../core/match';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import type { Policy } from '../../ai/types';
import { AI_WAIT_TICKS, DECISION_TIMEOUT, IDLE } from '../_hearts/logic';
import {
  GREEN,
  HEAL,
  HP_MAX,
  HP_START,
  LOCK_TICKS,
  MOVE_BUTTONS,
  NONE,
  RED,
  RED_TABLE,
  RESULT_TICKS,
  ROUNDS,
  WHITE,
  WHITE_POINTS,
  h7Game,
  makeState,
  naiveValue,
  predictOpp,
  trueValue,
} from './logic';
import type { H7State, Move } from './logic';

/**
 * H-7 血換分的規則測試（規則見 `docs/cards/H-7.md`）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 重點三組：結算（同一顆誰都拿不到、昏倒歸零）、不偷看（同時出手：對方這回合的 pending 與 last 不可以讀）、
 * 以及 `actions()[0]` 是會推進結算的「不搶」（DESIGN-AI-FUN 10.6 陷阱二）。
 */

const CONFIG = { maxTicks: 3600, params: {} };

const POLICIES: readonly Policy[] = [pathfinder, precise, greedy, gambler];

function press(side: Side, buttons: Buttons): Inputs {
  return side === 0 ? [buttons, IDLE] : [IDLE, buttons];
}

function idle(): Inputs {
  return [IDLE, IDLE];
}

/** 兩邊各出一手（`null` 是不按）。 */
function pick(m0: Move | null, m1: Move | null): Inputs {
  return [
    m0 === null ? IDLE : (MOVE_BUTTONS[m0] as Buttons),
    m1 === null ? IDLE : (MOVE_BUTTONS[m1] as Buttons),
  ];
}

function stepN(state: H7State, n: number, inputs: Inputs = idle()): H7State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = h7Game.step(s, inputs);
  }
  return s;
}

/** 一個 choose 階段的局面。 */
function choosing(overrides: Partial<H7State> = {}): H7State {
  return makeState({ phase: 'choose', wait: 0, idle: 0, ...overrides });
}

/** 從 choose 局面出發，兩邊同時出手，一路走到入帳（下一回合的 prep 或結束）。 */
function playRound(state: H7State, m0: Move, m1: Move): H7State {
  let s = h7Game.step(state, pick(m0, m1));
  let guard = 0;
  while (!s.over && s.phase !== 'prep' && guard < 1000) {
    s = h7Game.step(s, idle());
    guard += 1;
  }
  return s;
}

function sameButtons(a: Buttons, b: Buttons): boolean {
  return (
    a.up === b.up &&
    a.down === b.down &&
    a.left === b.left &&
    a.right === b.right &&
    a.a === b.a &&
    a.b === b.b
  );
}

function nameOf(buttons: Buttons): string {
  const i = MOVE_BUTTONS.findIndex((b) => sameButtons(b, buttons));
  return i < 0 ? '放開' : ['不搶', '白', '綠', '紅'][i]!;
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

describe('H-7 血換分｜初始與常數', () => {
  it('常數：12 回合、起始血 5、上限 6、綠球補 2、白球 1 分、紅球四組 (3,1)(4,1)(5,2)(6,2)、鎖定 2 tick', () => {
    expect(ROUNDS).toBe(12);
    expect(HP_START).toBe(5);
    expect(HP_MAX).toBe(6);
    expect(HEAL).toBe(2);
    expect(WHITE_POINTS).toBe(1);
    expect(RED_TABLE).toEqual([
      [3, 1],
      [4, 1],
      [5, 2],
      [6, 2],
    ]);
    expect(LOCK_TICKS).toBe(2);
    expect(RESULT_TICKS).toBeGreaterThanOrEqual(30);
  });

  it('紅球的血價隨分數遞增：血價 2 的組合分數都高過血價 1 的組合', () => {
    const cheap = RED_TABLE.filter(([, c]) => c === 1).map(([p]) => p);
    const costly = RED_TABLE.filter(([, c]) => c === 2).map(([p]) => p);
    expect(Math.min(...costly)).toBeGreaterThan(Math.max(...cheap));
  });

  it('init：第 0 回合、血各 5、分數 0、準備階段等 AI_WAIT_TICKS、球是表裡的一組、沒有歷史', () => {
    const s = h7Game.init(3, CONFIG);
    expect(s.round).toBe(0);
    expect(s.hp).toEqual([HP_START, HP_START]);
    expect(s.score).toEqual([0, 0]);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.pending).toEqual([null, null]);
    expect(s.last).toBeNull();
    expect(s.history).toEqual([]);
    expect(s.over).toBe(false);
    expect(RED_TABLE.some(([p, c]) => p === s.orbs.red[0] && c === s.orbs.red[1])).toBe(true);
    expect(s.maxTicks).toBe(3600);
  });

  it('init：同樣的種子同樣的 state；不同種子的紅球序列不全相同（12 回合都出現過表裡的組合）', () => {
    expect(h7Game.init(5, CONFIG)).toEqual(h7Game.init(5, CONFIG));
    const sequences = new Set<string>();
    const seen = new Set<string>();
    for (let seed = 0; seed < 8; seed += 1) {
      let s = h7Game.init(seed, CONFIG);
      const seq: string[] = [];
      for (let r = 0; r < ROUNDS; r += 1) {
        seq.push(s.orbs.red.join(','));
        seen.add(s.orbs.red.join(','));
        s = playRound({ ...s, phase: 'choose', wait: 0 }, NONE, NONE);
      }
      sequences.add(seq.join('|'));
    }
    expect(sequences.size).toBeGreaterThan(4);
    expect(seen.size).toBe(RED_TABLE.length);
  });
});

describe('H-7 血換分｜規則', () => {
  it('1. 準備：等 AI_WAIT_TICKS 個 tick 才能出手，期間輸入被忽略；之後進 choose', () => {
    let s = h7Game.init(0, CONFIG);
    s = stepN(s, AI_WAIT_TICKS - 1, pick(RED, WHITE));
    expect(s.phase).toBe('prep');
    expect(s.pending).toEqual([null, null]);
    s = h7Game.step(s, pick(RED, WHITE));
    expect(s.phase).toBe('choose');
    expect(s.pending).toEqual([null, null]);
  });

  it('2. 兩邊同時出手：只有一邊出手時還在 choose，兩邊都出手的那個 tick 進 locked（鎖定 LOCK_TICKS）；選了不能改', () => {
    let s = choosing();
    s = h7Game.step(s, press(0, MOVE_BUTTONS[RED] as Buttons));
    expect(s.phase).toBe('choose');
    expect(s.pending).toEqual([RED, null]);
    // 改按別的：不算
    s = h7Game.step(s, press(0, MOVE_BUTTONS[GREEN] as Buttons));
    expect(s.pending).toEqual([RED, null]);
    s = h7Game.step(s, press(1, MOVE_BUTTONS[WHITE] as Buttons));
    expect(s.pending).toEqual([RED, WHITE]);
    expect(s.phase).toBe('locked');
    expect(s.wait).toBe(LOCK_TICKS);
  });

  it('3. 鎖定 2 tick 之後（共 3 步）揭示：階段是 resolve、停 RESULT_TICKS，這段時間分數與血都沒動', () => {
    const s0 = choosing({ hp: [5, 5], score: [2, 3] });
    let s = h7Game.step(s0, pick(RED, WHITE));
    expect(s.phase).toBe('locked');
    s = h7Game.step(s, idle());
    expect(s.phase).toBe('locked');
    s = h7Game.step(s, idle());
    expect(s.phase).toBe('resolve');
    expect(s.wait).toBe(RESULT_TICKS);
    expect(s.last).toEqual({ picks: [RED, WHITE] });
    expect(s.score).toEqual([2, 3]);
    expect(s.hp).toEqual([5, 5]);
    // 停滿 RESULT_TICKS 才入帳
    const mid = stepN(s, RESULT_TICKS - 1);
    expect(mid.phase).toBe('resolve');
    expect(mid.score).toEqual([2, 3]);
    const after = h7Game.step(mid, idle());
    expect(after.phase).toBe('prep');
    expect(after.score[0]).toBeGreaterThan(2);
  });

  it('4. 搶不同顆各自拿到：紅球加分扣血、白球加 1 分', () => {
    const s = playRound(choosing({ orbs: { red: [5, 2] } }), RED, WHITE);
    expect(s.score).toEqual([5, WHITE_POINTS]);
    expect(s.hp).toEqual([HP_START - 2, HP_START]);
  });

  it('5. 搶同一顆誰都拿不到分；紅球撞球各掉一個血價（撞球要付代價，見小規格），其他球撞球什麼都沒有', () => {
    const s = playRound(choosing({ orbs: { red: [6, 2] }, score: [4, 4] }), RED, RED);
    expect(s.score).toEqual([4, 4]);
    expect(s.hp).toEqual([HP_START - 2, HP_START - 2]);
    const cheap = playRound(choosing({ orbs: { red: [3, 1] }, score: [4, 4] }), RED, RED);
    expect(cheap.hp).toEqual([HP_START - 1, HP_START - 1]);
  });

  it('5a. 紅球撞球只傷不昏（邊界）：血最多掉到 1，分數不歸零；各自掉的血只看自己的血', () => {
    const s = playRound(choosing({ orbs: { red: [5, 2] }, hp: [2, 6], score: [9, 9] }), RED, RED);
    expect(s.hp).toEqual([1, 4]);
    expect(s.score).toEqual([9, 9]);
    const low = playRound(choosing({ orbs: { red: [5, 2] }, hp: [1, 1], score: [9, 9] }), RED, RED);
    expect(low.hp).toEqual([1, 1]);
  });

  it('5c. 消融 clash=false（小規格原本的規則）：紅球撞球什麼都沒有', () => {
    const s = playRound(choosing({ clash: false, orbs: { red: [6, 2] }, score: [4, 4] }), RED, RED);
    expect(s.hp).toEqual([HP_START, HP_START]);
    expect(h7Game.init(0, { maxTicks: 3600, params: { clash: 0 } }).clash).toBe(false);
    expect(h7Game.init(0, CONFIG).clash).toBe(true);
  });

  it('5b. 搶同一顆誰都拿不到：白球、綠球撞球', () => {
    const w = playRound(choosing(), WHITE, WHITE);
    expect(w.score).toEqual([0, 0]);
    const g = playRound(choosing({ hp: [3, 3] }), GREEN, GREEN);
    expect(g.hp).toEqual([3, 3]);
  });

  it('6. 不搶什麼都不做；對方的球照拿（兩個都不搶也沒事）', () => {
    const a = playRound(choosing({ orbs: { red: [4, 1] } }), NONE, RED);
    expect(a.score).toEqual([0, 4]);
    expect(a.hp).toEqual([HP_START, HP_START - 1]);
    const b = playRound(choosing(), NONE, NONE);
    expect(b.score).toEqual([0, 0]);
    expect(b.hp).toEqual([HP_START, HP_START]);
  });

  it('7. 綠球補 HEAL 點血，上限 HP_MAX（邊界：血 5 只補到 6；血 6 沒效果）', () => {
    expect(playRound(choosing({ hp: [2, 2] }), GREEN, NONE).hp).toEqual([2 + HEAL, 2]);
    expect(playRound(choosing({ hp: [5, 5] }), GREEN, NONE).hp).toEqual([HP_MAX, 5]);
    expect(playRound(choosing({ hp: [6, 5] }), GREEN, NONE).hp).toEqual([HP_MAX, 5]);
  });

  it('8. 昏倒（邊界）：血剛好等於血價就昏倒——分數立刻歸零、血停在 0；多 1 點血則活著（剩 1）', () => {
    const faint = playRound(
      choosing({ hp: [2, 5], score: [9, 0], orbs: { red: [5, 2] } }),
      RED,
      NONE,
    );
    expect(faint.score[0]).toBe(0);
    expect(faint.hp[0]).toBe(0);
    const alive = playRound(
      choosing({ hp: [3, 5], score: [9, 0], orbs: { red: [5, 2] } }),
      RED,
      NONE,
    );
    expect(alive.score[0]).toBe(14);
    expect(alive.hp[0]).toBe(1);
    // 血價 1、血 1 也是昏倒
    const one = playRound(
      choosing({ hp: [1, 5], score: [7, 0], orbs: { red: [3, 1] } }),
      RED,
      NONE,
    );
    expect(one.score[0]).toBe(0);
    expect(one.hp[0]).toBe(0);
  });

  it('8b. 昏倒的是搶紅球而沒撞球的人：撞球時不昏倒（血 1 的撞球不掉血）', () => {
    const s = playRound(choosing({ hp: [1, 1], score: [7, 7], orbs: { red: [3, 1] } }), RED, RED);
    expect(s.score).toEqual([7, 7]);
    expect(s.hp).toEqual([1, 1]);
  });

  it('9. 昏倒的人不能搶紅球（輸入被忽略、actions 裡沒有）；綠球補到血 ≥ 1 就恢復行動，分數從 0 重新累計', () => {
    const fainted = choosing({ hp: [0, 5], score: [0, 0] });
    const pressedRed = h7Game.step(fainted, press(0, MOVE_BUTTONS[RED] as Buttons));
    expect(pressedRed.pending[0]).toBeNull();
    expect(
      h7Game.actions(fainted, 0).some((a) => sameButtons(a, MOVE_BUTTONS[RED] as Buttons)),
    ).toBe(false);
    // 同時按紅與白：紅被忽略，白算
    const both = h7Game.step(fainted, press(0, { ...IDLE, left: true, up: true }));
    expect(both.pending[0]).toBe(WHITE);
    const healed = playRound(fainted, GREEN, NONE);
    expect(healed.hp[0]).toBe(HEAL);
    const next = playRound(
      { ...healed, phase: 'choose', wait: 0, orbs: { red: [3, 1] } },
      RED,
      NONE,
    );
    expect(next.score[0]).toBe(3);
    expect(next.hp[0]).toBe(HEAL - 1);
  });

  it('10. 兩邊同一回合各自昏倒或各自拿分，互不影響（結算同時、互相獨立）', () => {
    // 0 號拿紅球昏倒、1 號拿白球：1 號的白球照拿
    const s = playRound(choosing({ hp: [1, 5], score: [6, 0], orbs: { red: [4, 1] } }), RED, WHITE);
    expect(s.score).toEqual([0, WHITE_POINTS]);
    expect(s.hp).toEqual([0, 5]);
  });

  it('11. 入帳之後：這回合寫進 history（兩邊的出手、出手前的血與分數、紅球），回合加 1、新的紅球、pending 清掉', () => {
    const start = choosing({ round: 3, hp: [4, 5], score: [8, 6], orbs: { red: [5, 2] } });
    const s = playRound(start, RED, GREEN);
    expect(s.round).toBe(4);
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toEqual({
      orb: [5, 2],
      picks: [RED, GREEN],
      hp: [4, 5],
      score: [8, 6],
    });
    expect(s.pending).toEqual([null, null]);
    expect(s.last).toBeNull();
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(RED_TABLE.some(([p, c]) => p === s.orbs.red[0] && c === s.orbs.red[1])).toBe(true);
  });

  it('12. 超時（邊界）：choose 閒置到第 DECISION_TIMEOUT 個 tick 自動不搶；那個 tick 才按的鍵算按了', () => {
    let s = choosing();
    s = stepN(s, DECISION_TIMEOUT - 1);
    expect(s.pending).toEqual([null, null]);
    const timedOut = h7Game.step(s, idle());
    expect(timedOut.pending).toEqual([NONE, NONE]);
    expect(timedOut.phase).toBe('locked');
    const late = h7Game.step(s, press(1, MOVE_BUTTONS[RED] as Buttons));
    expect(late.pending).toEqual([NONE, RED]);
  });

  it('13. 按鍵：b 與 ↓ 是不搶、← 紅、↑ 白、→ 綠；a 沒有作用；多鍵同按 b 最優先，其次 ←、↑、→、↓', () => {
    const cases: [Buttons, Move | null][] = [
      [{ ...IDLE, b: true }, NONE],
      [{ ...IDLE, down: true }, NONE],
      [{ ...IDLE, left: true }, RED],
      [{ ...IDLE, up: true }, WHITE],
      [{ ...IDLE, right: true }, GREEN],
      [{ ...IDLE, a: true }, null],
      [{ ...IDLE, left: true, up: true, right: true, down: true, b: true }, NONE],
      [{ ...IDLE, left: true, up: true, right: true, down: true }, RED],
      [{ ...IDLE, up: true, right: true, down: true }, WHITE],
      [{ ...IDLE, right: true, down: true }, GREEN],
    ];
    for (const [buttons, expected] of cases) {
      expect(h7Game.step(choosing(), press(0, buttons)).pending[0]).toBe(expected);
    }
  });

  it('14. 12 回合後結束：分數高的贏、一樣多平手；時間用完也結束', () => {
    let s = choosing({ round: ROUNDS - 1, score: [10, 7] });
    s = playRound(s, NONE, NONE);
    expect(s.over).toBe(true);
    expect(s.winner).toBe(0);
    expect(h7Game.score(s)).toEqual([10, 7]);
    expect(h7Game.winner(s)).toBe(0);
    const tie = playRound(choosing({ round: ROUNDS - 1, score: [9, 9] }), WHITE, WHITE);
    expect(tie.over).toBe(true);
    expect(tie.winner).toBeNull();
    const behind = playRound(choosing({ round: ROUNDS - 1, score: [3, 4] }), WHITE, NONE);
    expect(behind.winner).toBeNull();
    const lead1 = playRound(choosing({ round: ROUNDS - 1, score: [3, 4] }), NONE, WHITE);
    expect(lead1.winner).toBe(1);
    // 還沒結束時 winner 是 null
    expect(h7Game.winner(choosing())).toBeNull();
  });

  it('15. 最後一回合昏倒：分數歸零後才比（邊界）', () => {
    const s = playRound(
      choosing({ round: ROUNDS - 1, hp: [1, 5], score: [20, 3], orbs: { red: [3, 1] } }),
      RED,
      NONE,
    );
    expect(s.over).toBe(true);
    expect(s.score).toEqual([0, 3]);
    expect(s.winner).toBe(1);
  });

  it('16. 時間到（第 maxTicks 個 tick）：已經揭示的先入帳；還在選的不算', () => {
    const resolving = h7Game.step(
      h7Game.step(h7Game.step(choosing({ maxTicks: 100, tick: 90 }), pick(WHITE, NONE)), idle()),
      idle(),
    );
    expect(resolving.phase).toBe('resolve');
    const done = stepN({ ...resolving, tick: 99 }, 1);
    expect(done.over).toBe(true);
    expect(done.score).toEqual([WHITE_POINTS, 0]);
    expect(done.winner).toBe(0);
    const choosingAtEnd = h7Game.step(choosing({ maxTicks: 100, tick: 99 }), pick(WHITE, null));
    expect(choosingAtEnd.over).toBe(true);
    expect(choosingAtEnd.score).toEqual([0, 0]);
  });

  it('17. step 不改動傳進來的 state 與輸入：各階段深度凍結都不丟錯', () => {
    const states: H7State[] = [
      h7Game.init(1, CONFIG),
      choosing(),
      choosing({ pending: [RED, null] }),
      makeState({ phase: 'locked', wait: 2, pending: [RED, WHITE] }),
      makeState({
        phase: 'resolve',
        wait: 5,
        pending: [RED, WHITE],
        last: { picks: [RED, WHITE] },
      }),
      makeState({
        phase: 'resolve',
        wait: 1,
        pending: [RED, WHITE],
        last: { picks: [RED, WHITE] },
      }),
    ];
    for (const s of states) {
      const before = hashState(s);
      const frozen = deepFreeze(JSON.parse(JSON.stringify(s)) as H7State);
      expect(() => h7Game.step(frozen, deepFreeze(pick(RED, WHITE)))).not.toThrow();
      expect(hashState(frozen)).toBe(before);
    }
  });

  it('18. 整場 JSON 來回不變、同種子重跑一樣、不同種子不一樣', () => {
    const run = (seed: number): string => {
      const a = levelController(h7Game, random, 10, seed + 1);
      const b = levelController(h7Game, random, 10, seed + 2);
      return playMatch(h7Game, seed, CONFIG, a, b).finalHash;
    };
    expect(run(4)).toBe(run(4));
    expect(run(4)).not.toBe(run(5));
    let s = h7Game.init(2, CONFIG);
    for (let i = 0; i < 300; i += 1) {
      s = h7Game.step(s, pick(i % 7 === 0 ? RED : WHITE, i % 5 === 0 ? GREEN : NONE));
      expect(hashState(JSON.parse(JSON.stringify(s)) as H7State)).toBe(hashState(s));
    }
  });

  it('19. 結束之後 step 原樣回傳', () => {
    const over = playRound(choosing({ round: ROUNDS - 1 }), WHITE, NONE);
    expect(over.over).toBe(true);
    expect(h7Game.step(over, pick(RED, RED))).toBe(over);
  });

  it('20. 全程不卡住：兩個亂按的控制器打得完一整場，history 恰好 ROUNDS 筆', () => {
    for (const seed of [1, 2, 3]) {
      const a = levelController(h7Game, random, 10, seed * 2);
      const b = levelController(h7Game, random, 10, seed * 2 + 1);
      let s = h7Game.init(seed, CONFIG);
      let t = 0;
      while (!s.over && t < 3600) {
        s = h7Game.step(s, [a.decide(s, 0, t), b.decide(s, 1, t)]);
        t += 1;
      }
      expect(s.over).toBe(true);
      expect(s.history).toHaveLength(ROUNDS);
    }
  });
});

describe('H-7 血換分｜actions 與 evaluate', () => {
  it('choose 且還沒出手：[不搶, 白, 綠, 紅]，不搶排第一；昏倒時沒有紅', () => {
    const acts = h7Game.actions(choosing(), 0);
    expect(acts.map(nameOf)).toEqual(['不搶', '白', '綠', '紅']);
    expect(h7Game.actions(choosing({ hp: [0, 5] }), 0).map(nameOf)).toEqual(['不搶', '白', '綠']);
    expect(h7Game.actions(choosing({ hp: [0, 5] }), 1).map(nameOf)).toEqual([
      '不搶',
      '白',
      '綠',
      '紅',
    ]);
    // 血滿時綠球仍可選（保留，以免 actions 讀對方）
    expect(h7Game.actions(choosing({ hp: [6, 6] }), 0).map(nameOf)).toContain('綠');
  });

  it('其他階段、已經出手、結束：只有 [全放開]', () => {
    for (const s of [
      makeState({ phase: 'prep' }),
      choosing({ pending: [RED, null] }),
      makeState({ phase: 'locked', wait: 2, pending: [RED, WHITE] }),
      makeState({
        phase: 'resolve',
        wait: 9,
        pending: [RED, WHITE],
        last: { picks: [RED, WHITE] },
      }),
      makeState({ over: true }),
    ]) {
      const a0 = h7Game.actions(s, 0);
      expect(a0).toHaveLength(1);
      expect(sameButtons(a0[0] as Buttons, IDLE)).toBe(true);
    }
    // 對方出手了，我這邊的 actions 不變（不偷看）
    expect(h7Game.actions(choosing({ pending: [null, RED] }), 0).map(nameOf)).toEqual(
      h7Game.actions(choosing(), 0).map(nameOf),
    );
  });

  it('actions()[0] 是「不搶」，而且是推進結算的動作（10.6 陷阱二）：兩邊都按 actions()[0]，3 步就揭示', () => {
    const s = choosing();
    for (const side of [0, 1] as const) {
      expect(
        sameButtons(h7Game.actions(s, side)[0] as Buttons, MOVE_BUTTONS[NONE] as Buttons),
      ).toBe(true);
    }
    const first = [0, 1].map((side) => h7Game.actions(s, side as Side)[0] as Buttons);
    let t = h7Game.step(s, [first[0] as Buttons, first[1] as Buttons]);
    expect(t.phase).toBe('locked');
    t = h7Game.step(t, idle());
    t = h7Game.step(t, idle());
    expect(t.phase).toBe('resolve');
  });

  it('只有我出手、模擬裡的對手維持 actions()[0]（搜尋型的做法）：1 步進 locked、3 步進 resolve', () => {
    const s = choosing();
    for (const side of [0, 1] as const) {
      const mine = MOVE_BUTTONS[RED] as Buttons;
      const theirs = h7Game.actions(s, side === 0 ? 1 : 0)[0] as Buttons;
      const inputs: Inputs = side === 0 ? [mine, theirs] : [theirs, mine];
      let t = h7Game.step(s, inputs);
      expect(t.phase).toBe('locked');
      t = stepN(t, 2);
      expect(t.phase).toBe('resolve');
    }
  });

  it('搜尋型深度 6 的 decide 模擬到的最深狀態已經過了揭示（resolve 階段被 evaluate 看到）', () => {
    const seen = new Set<string>();
    const spy: Game<H7State> = {
      ...h7Game,
      evaluate: (s, side) => {
        seen.add(s.phase);
        return h7Game.evaluate(s, side);
      },
    };
    const c = wrapPolicy(
      spy,
      pathfinder,
      { reactionTicks: 0, decideEvery: 1, depth: 6, epsilon: 0 },
      1,
    );
    c.decide(choosing(), 1, 0);
    expect(seen.has('resolve')).toBe(true);
    seen.clear();
    wrapPolicy(
      spy,
      pathfinder,
      { reactionTicks: 0, decideEvery: 1, depth: 2, epsilon: 0 },
      1,
    ).decide(choosing(), 1, 0);
    expect(seen.has('resolve')).toBe(false);
  });

  it('evaluate：各階段 gain 有限、danger 在 0 到 1；結束的局有勝負加成 ±1000', () => {
    const states: H7State[] = [
      makeState({ phase: 'prep' }),
      choosing(),
      choosing({ pending: [RED, null], hp: [1, 5], score: [9, 2] }),
      makeState({ phase: 'locked', wait: 2, pending: [RED, WHITE], hp: [2, 6] }),
      makeState({ phase: 'resolve', wait: 9, pending: [GREEN, RED], hp: [0, 4] }),
      makeState({ phase: 'resolve', wait: 9, pending: [NONE, NONE] }),
    ];
    for (const s of states) {
      for (const side of [0, 1] as const) {
        const e = h7Game.evaluate(s, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
    const won = makeState({ over: true, winner: 0, score: [5, 2] });
    expect(h7Game.evaluate(won, 0).gain).toBeGreaterThan(900);
    expect(h7Game.evaluate(won, 1).gain).toBeLessThan(-900);
    const tied = makeState({ over: true, winner: null, score: [4, 4] });
    expect(h7Game.evaluate(tied, 0).gain).toBe(0);
  });

  it('evaluate：分數領先越多 gain 越大（單調）；血價高的紅球搶了而昏倒的 danger 大於活著的', () => {
    const at = (a: number, b: number): number =>
      h7Game.evaluate(choosing({ score: [a, b], pending: [WHITE, null] }), 0).gain;
    expect(at(8, 3)).toBeGreaterThan(at(5, 3));
    expect(at(5, 3)).toBeGreaterThan(at(5, 7));
    const red = (hp: number): number =>
      h7Game.evaluate(
        makeState({
          phase: 'locked',
          wait: 2,
          orbs: { red: [5, 2] },
          hp: [hp, 5],
          pending: [RED, WHITE],
        }),
        0,
      ).danger;
    expect(red(2)).toBeGreaterThan(0);
    expect(red(3)).toBe(0);
    expect(red(2)).toBeGreaterThan(red(3));
  });

  it('價值函式：昏倒賠掉全部分數；沒有以後的回合時血量不值錢；血少時綠球值錢', () => {
    const red: readonly [number, number] = [5, 2];
    // 昏倒：賠 score 與（還值錢的）血
    expect(trueValue(2, 10, RED, red, 5)).toBeLessThan(-9);
    // 最後一回合：血沒價值，綠球 0、紅球 = 分數
    expect(trueValue(3, 10, GREEN, red, 0)).toBe(0);
    expect(trueValue(4, 10, RED, red, 0)).toBe(5);
    // 血少時綠球比血多時值錢
    expect(trueValue(1, 0, GREEN, red, 6)).toBeGreaterThan(trueValue(5, 0, GREEN, red, 6));
    // 天真價值：血剩 1 時綠球勝過會昏倒的紅球
    expect(naiveValue(1, 6, 0, GREEN, red, 6)).toBeGreaterThan(naiveValue(1, 6, 0, RED, red, 6));
    expect(naiveValue(5, 6, 0, RED, [6, 2], 6)).toBeGreaterThan(
      naiveValue(5, 6, 0, WHITE, [6, 2], 6),
    );
  });
});

describe('H-7 血換分｜對手模型 Q（只讀公開資訊）', () => {
  it('機率加起來是 1；昏倒的對手搶紅球的機率是 0', () => {
    for (const s of [
      choosing(),
      choosing({ hp: [5, 1] }),
      choosing({ hp: [5, 0], score: [0, 0] }),
      choosing({ hp: [2, 6], score: [10, 0] }),
    ]) {
      const q = predictOpp(s, 0);
      expect(q).toHaveLength(4);
      expect(q.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      expect(q.every((p) => p >= 0)).toBe(true);
    }
    expect(predictOpp(choosing({ hp: [5, 0] }), 0)[RED]).toBe(0);
  });

  it('血剩 1 的對手想要綠球、血滿的對手想要紅球（自我模型）', () => {
    const low = predictOpp(choosing({ hp: [5, 1], score: [0, 6] }), 0);
    const full = predictOpp(choosing({ hp: [5, 6], score: [0, 6] }), 0);
    expect(low[GREEN]).toBeGreaterThan(low[RED]);
    expect(full[RED]).toBeGreaterThan(full[GREEN]);
    expect(low[GREEN]).toBeGreaterThan(full[GREEN]);
  });

  it('歷史修正：對方在「同類狀況」下上次搶了什麼，Q 往那顆移；沒有紀錄就是自我模型；model=false 關掉', () => {
    const base = choosing({ hp: [5, 5], orbs: { red: [4, 1] } });
    const rec = (m: Move) => ({
      orb: [4, 1] as const,
      picks: [NONE, m] as const,
      hp: [5, 5] as const,
      score: [0, 0] as const,
    });
    const none = predictOpp(base, 0);
    const greens = predictOpp({ ...base, history: [rec(GREEN), rec(GREEN), rec(GREEN)] }, 0);
    const reds = predictOpp({ ...base, history: [rec(RED), rec(RED), rec(RED)] }, 0);
    expect(greens[GREEN]).toBeGreaterThan(none[GREEN]);
    expect(reds[RED]).toBeGreaterThan(none[RED]);
    expect(greens[RED]).toBeLessThan(reds[RED]);
    // 不同類狀況（紅球貴）的紀錄不影響這一類
    const costly = { ...rec(GREEN), orb: [6, 2] as const };
    expect(predictOpp({ ...base, history: [costly, costly, costly] }, 0)).toEqual(none);
    // 窗口只看最近 3 筆同類
    const old = predictOpp({ ...base, history: [rec(GREEN), rec(RED), rec(RED), rec(RED)] }, 0);
    expect(old).toEqual(reds);
    // 消融
    const off = { ...base, model: false, history: [rec(GREEN), rec(GREEN), rec(GREEN)] };
    expect(predictOpp(off, 0)).toEqual(none);
  });
});

// ---------------------------------------------------------------------------
// 不偷看
// ---------------------------------------------------------------------------

interface PeekCase {
  readonly name: string;
  readonly side: Side;
  readonly base: H7State;
  readonly variants: readonly H7State[];
}

const OPP_PENDING: readonly (Move | null)[] = [null, NONE, WHITE, GREEN, RED];

function peekCases(): PeekCase[] {
  const cases: PeekCase[] = [];
  for (const side of [0, 1] as const) {
    const opp = side === 0 ? 1 : 0;
    const withOpp = (s: H7State, m: Move | null): H7State => {
      const pending: [Move | null, Move | null] = [s.pending[0], s.pending[1]];
      pending[opp] = m;
      return { ...s, pending };
    };
    const bases: [string, H7State][] = [
      ['choose 還沒出手', choosing({ hp: [3, 3], score: [6, 9], round: 4 })],
      [
        'choose 我已出手',
        withOpp(choosing({ hp: [3, 3], score: [6, 9], round: 4, pending: [WHITE, WHITE] }), null),
      ],
      [
        'locked',
        makeState({
          phase: 'locked',
          wait: 2,
          hp: [4, 2],
          score: [6, 9],
          round: 7,
          pending: [RED, RED],
        }),
      ],
      [
        'resolve',
        makeState({
          phase: 'resolve',
          wait: 9,
          hp: [4, 2],
          score: [6, 9],
          round: 7,
          pending: [RED, RED],
          last: { picks: [RED, RED] },
        }),
      ],
    ];
    for (const [name, base0] of bases) {
      const pendingMine: [Move | null, Move | null] = [base0.pending[0], base0.pending[1]];
      const base = withOpp({ ...base0, pending: pendingMine }, null);
      const variants: H7State[] = OPP_PENDING.map((m) => withOpp(base, m));
      // resolve：last 也只跟對方的出手有關，換掉不可以影響
      if (base.phase === 'resolve') {
        for (const m of [NONE, WHITE, GREEN, RED] as const) {
          const picks: [Move, Move] = [base.pending[0] as Move, base.pending[1] as Move];
          picks[opp] = m;
          variants.push({ ...withOpp(base, m), last: { picks } });
        }
      }
      cases.push({ name: `${name}（${side} 號邊）`, side, base, variants });
    }
  }
  return cases;
}

function peeks(
  game: Game<H7State>,
  base: H7State,
  variants: readonly H7State[],
  side: Side,
): boolean {
  const expectedEval = game.evaluate(base, side);
  const expectedActions = game.actions(base, side).map(nameOf);
  return variants.some((v) => {
    const e = game.evaluate(v, side);
    return (
      e.gain !== expectedEval.gain ||
      e.danger !== expectedEval.danger ||
      game.actions(v, side).map(nameOf).join() !== expectedActions.join()
    );
  });
}

function decideWith(policy: Policy, depth: number, state: H7State, side: Side): Buttons {
  return wrapPolicy(
    h7Game,
    policy,
    { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
    7,
  ).decide(state, side, 0);
}

describe('H-7 血換分｜不偷看（同時出手：evaluate 與 actions 不可以讀對方這回合的 pending 與 last）', () => {
  it('每一個情境：只有對方 pending（或 last）不同的兩個 state，evaluate 與 actions 完全相同', () => {
    for (const c of peekCases()) {
      expect(peeks(h7Game, c.base, c.variants, c.side), c.name).toBe(false);
    }
  });

  it('偵測器本身有效：故意洩漏（讀對方 pending、讀 last）一定被抓到', () => {
    const oppPick = (s: H7State, side: Side): Move | null => s.pending[side === 0 ? 1 : 0];
    const leaks: Record<string, (s: H7State, side: Side) => number> = {
      '讀對方的 pending（choose）': (s, side) =>
        s.phase === 'choose' ? 0.001 * ((oppPick(s, side) ?? 0) + 1) : 0,
      '讀對方的 pending（locked）': (s, side) =>
        s.phase === 'locked' ? 0.001 * ((oppPick(s, side) ?? 0) + 1) : 0,
      '讀對方的 pending（resolve）': (s, side) =>
        s.phase === 'resolve' ? 0.001 * ((oppPick(s, side) ?? 0) + 1) : 0,
      '讀 last': (s, side) =>
        s.last === null ? 0 : 0.001 * (s.last.picks[side === 0 ? 1 : 0] as number),
    };
    const cases = peekCases();
    for (const [name, extra] of Object.entries(leaks)) {
      const leaky: Game<H7State> = {
        ...h7Game,
        evaluate: (s, side) => {
          const e = h7Game.evaluate(s, side);
          return { gain: e.gain + extra(s, side), danger: e.danger };
        },
      };
      const caught = cases.some((c) => peeks(leaky, c.base, c.variants, c.side));
      expect(caught, `沒抓到洩漏：${name}`).toBe(true);
    }
    const leakyActions: Game<H7State> = {
      ...h7Game,
      actions: (s, side) =>
        oppPick(s, side) === RED ? [...h7Game.actions(s, side), IDLE] : h7Game.actions(s, side),
    };
    expect(cases.some((c) => peeks(leakyActions, c.base, c.variants, c.side))).toBe(true);
  });

  it('黑箱：四個性格在深度 1、3、6，只有對方 pending 不同的 choose 局面，按的鍵都相同', () => {
    const backgrounds: Partial<H7State>[] = [
      { hp: [5, 5], score: [0, 0] },
      { hp: [1, 5], score: [8, 3], round: 5 },
      { hp: [4, 1], score: [3, 12], round: 9, orbs: { red: [6, 2] } },
      { hp: [2, 6], score: [14, 14], round: 11, orbs: { red: [3, 1] } },
    ];
    for (const bg of backgrounds) {
      for (const side of [0, 1] as const) {
        const base = choosing(bg);
        for (const policy of POLICIES) {
          for (const depth of [1, 3, 6]) {
            const expected = nameOf(decideWith(policy, depth, base, side));
            for (const m of OPP_PENDING) {
              const pending: [Move | null, Move | null] = [null, null];
              pending[side === 0 ? 1 : 0] = m;
              expect(
                nameOf(decideWith(policy, depth, { ...base, pending }, side)),
                `${policy.name} 深度 ${depth} 對方 ${String(m)}`,
              ).toBe(expected);
            }
          }
        }
      }
    }
  });

  it('黑箱也抓得到只有 decide 那一層看得出來的洩漏：resolve 階段的估值讀了對方的 pending（深度 3 以上走得到）', () => {
    const leaky: Game<H7State> = {
      ...h7Game,
      evaluate: (s, side) => {
        const e = h7Game.evaluate(s, side);
        if (s.phase !== 'resolve') {
          return e;
        }
        const theirs = s.pending[side === 0 ? 1 : 0];
        const mine = s.pending[side];
        return { gain: e.gain + (theirs === mine ? -5 : 5), danger: e.danger };
      },
    };
    const decide = (state: H7State, depth: number): string =>
      nameOf(
        wrapPolicy(
          leaky,
          pathfinder,
          { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
          7,
        ).decide(state, 1, 0),
      );
    // 真實對局裡對方已出手而我還沒：模擬裡 pending 保留原樣
    const base = choosing({ hp: [4, 4], score: [3, 3] });
    const normal = decide(base, 3);
    const withPick = (m: Move): H7State => ({ ...base, pending: [m, null] });
    const same = ['不搶', '白', '綠', '紅'].indexOf(normal) as Move;
    const other = ((same + 1) % 4) as Move;
    expect(peeks(leaky, base, [withPick(same), withPick(other)], 1)).toBe(false);
    expect(decide(withPick(same), 3)).not.toBe(decide(withPick(other), 3));
    expect(decide(withPick(same), 1)).toBe(decide(withPick(other), 1));
  });

  it('結算在 AI 的模擬範圍之外：從 choose 出手走 6 步（最深的搜尋）仍在 resolve，分數與 history 都沒動', () => {
    const s = choosing({ hp: [3, 3], score: [5, 6] });
    let t = h7Game.step(s, [h7Game.actions(s, 0)[0] as Buttons, MOVE_BUTTONS[RED] as Buttons]);
    for (let i = 1; i < 6; i += 1) {
      t = h7Game.step(t, idle());
    }
    expect(t.phase).toBe('resolve');
    expect(t.score).toEqual(s.score);
    expect(t.hp).toEqual(s.hp);
    expect(t.history).toEqual(s.history);
  });
});

// ---------------------------------------------------------------------------
// 等級曲線
// ---------------------------------------------------------------------------

describe('H-7 血換分｜等級曲線（出手 → 鎖定 2 → 第 3 步揭示）', () => {
  /** 一組分散的局面：血、分數、回合、紅球組合。 */
  function scan(): H7State[] {
    const states: H7State[] = [];
    for (const round of [1, 5, 9, 11]) {
      for (const hp of [1, 2, 3, 5, 6]) {
        for (const score of [0, 7, 15]) {
          for (const red of RED_TABLE) {
            states.push(
              choosing({ round, hp: [hp, 4], score: [score, 6], orbs: { red: [red[0], red[1]] } }),
            );
          }
        }
      }
    }
    return states;
  }

  it('深度 1、2：完全不管對方——對方的血、分數、歷史怎麼換，決定都一樣（反射規則：搶自己最想要的）', () => {
    const rec = (m: Move) => ({
      orb: [4, 1] as const,
      picks: [NONE, m] as const,
      hp: [5, 5] as const,
      score: [0, 0] as const,
    });
    for (const s of scan()) {
      for (const depth of [1, 2]) {
        const expected = nameOf(decideWith(pathfinder, depth, s, 0));
        for (const alt of [
          { hp: [s.hp[0], 1] as const, score: [s.score[0], 0] as const },
          { hp: [s.hp[0], 6] as const, score: [s.score[0], 30] as const },
          { history: [rec(RED), rec(RED), rec(RED)] },
          { history: [rec(GREEN), rec(GREEN), rec(GREEN)] },
        ]) {
          expect(nameOf(decideWith(pathfinder, depth, { ...s, ...alt }, 0))).toBe(expected);
        }
      }
    }
  });

  it('深度 3 以上讀得到對方：掃描裡至少有 5 個局面的決定跟深度 1 不同；而且至少有 5 個局面隨對方的血量而變', () => {
    let differs = 0;
    let readsHp = 0;
    for (const s of scan()) {
      if (nameOf(decideWith(pathfinder, 3, s, 0)) !== nameOf(decideWith(pathfinder, 1, s, 0))) {
        differs += 1;
      }
      const lowOpp = { ...s, hp: [s.hp[0], 1] as const };
      const fullOpp = { ...s, hp: [s.hp[0], 6] as const };
      if (
        nameOf(decideWith(pathfinder, 3, lowOpp, 0)) !==
        nameOf(decideWith(pathfinder, 3, fullOpp, 0))
      ) {
        readsHp += 1;
      }
    }
    expect(differs).toBeGreaterThanOrEqual(5);
    expect(readsHp).toBeGreaterThanOrEqual(5);
  });

  it('反射規則：血剩 1 的時候不去搶會昏倒的紅球（搜尋型深度 1）；血滿、紅球貴時搶紅球', () => {
    const risky = choosing({ hp: [1, 5], score: [12, 0], orbs: { red: [3, 1] } });
    expect(nameOf(decideWith(pathfinder, 1, risky, 0))).not.toBe('紅');
    const rich = choosing({ hp: [6, 5], score: [0, 0], orbs: { red: [6, 2] } });
    expect(nameOf(decideWith(pathfinder, 1, rich, 0))).toBe('紅');
    const needHeal = choosing({ hp: [1, 5], score: [0, 0], orbs: { red: [3, 1] } });
    expect(nameOf(decideWith(pathfinder, 1, needHeal, 0))).toBe('綠');
  });
});

describe('H-7 血換分｜互相讀取：AI 的信念會改變它的選擇', () => {
  it('同一個局面，只換對方的血量：深度 6 的搜尋型有局面選的球不同（對血少的對手與血滿的對手）', () => {
    let changed = 0;
    for (const round of [2, 6, 10]) {
      for (const hp of [2, 3, 4, 5, 6]) {
        for (const red of RED_TABLE) {
          const base = choosing({
            round,
            hp: [hp, 5],
            score: [4, 4],
            orbs: { red: [red[0], red[1]] },
          });
          const low = nameOf(decideWith(pathfinder, 6, { ...base, hp: [hp, 1] }, 0));
          const full = nameOf(decideWith(pathfinder, 6, { ...base, hp: [hp, 6] }, 0));
          if (low !== full) {
            changed += 1;
          }
        }
      }
    }
    expect(changed).toBeGreaterThanOrEqual(5);
  });

  it('同一個局面，只換對方的歷史：深度 6 有局面選的球不同（它從歷史學到你血低也搶紅球）', () => {
    let changed = 0;
    for (const round of [3, 6, 9]) {
      for (const hp of [2, 3, 4, 5, 6]) {
        for (const red of RED_TABLE) {
          const base = choosing({
            round,
            hp: [hp, 5],
            score: [4, 4],
            orbs: { red: [red[0], red[1]] },
          });
          const rec = (m: Move) => ({
            orb: [red[0], red[1]] as const,
            picks: [NONE, m] as const,
            hp: [hp, 5] as const,
            score: [0, 0] as const,
          });
          const asRed = nameOf(
            decideWith(pathfinder, 6, { ...base, history: [rec(RED), rec(RED), rec(RED)] }, 0),
          );
          const asGreen = nameOf(
            decideWith(
              pathfinder,
              6,
              { ...base, history: [rec(GREEN), rec(GREEN), rec(GREEN)] },
              0,
            ),
          );
          if (asRed !== asGreen) {
            changed += 1;
          }
        }
      }
    }
    expect(changed).toBeGreaterThanOrEqual(1);
  });

  it('model=false（消融）：歷史完全不影響決定', () => {
    const rec = (m: Move) => ({
      orb: [4, 1] as const,
      picks: [NONE, m] as const,
      hp: [5, 5] as const,
      score: [0, 0] as const,
    });
    for (const s of [
      choosing({ model: false, round: 4, hp: [4, 5], orbs: { red: [4, 1] } }),
      choosing({ model: false, round: 8, hp: [3, 2], orbs: { red: [6, 2] } }),
    ]) {
      const a = nameOf(
        decideWith(pathfinder, 6, { ...s, history: [rec(RED), rec(RED), rec(RED)] }, 0),
      );
      const b = nameOf(
        decideWith(pathfinder, 6, { ...s, history: [rec(GREEN), rec(GREEN), rec(GREEN)] }, 0),
      );
      expect(a).toBe(b);
    }
  });
});

describe('H-7 血換分｜四種性格（機制）', () => {
  /** 血 2、紅球 (6,2)：搶了必昏倒，但分數是所有選項裡最高的。 */
  const fatalRich = choosing({ hp: [2, 5], score: [10, 4], orbs: { red: [6, 2] } });
  /** 血 2、紅球 (5,2)：搶了必昏倒；綠球的反射價值比紅球高。 */
  const fatalMid = choosing({ hp: [2, 5], score: [10, 4], orbs: { red: [5, 2] } });

  it('精準型：danger 超過 0.3 的動作不選——不搶會昏倒的紅球（任何深度）', () => {
    for (const depth of [1, 3, 6]) {
      expect(nameOf(decideWith(precise, depth, fatalRich, 0))).not.toBe('紅');
      expect(nameOf(decideWith(precise, depth, fatalMid, 0))).not.toBe('紅');
    }
  });

  it('貪心型：一步看，不管血，搶分最高的（血 2、紅球 (6,2) 照樣搶紅球）', () => {
    expect(nameOf(decideWith(greedy, 1, fatalRich, 0))).toBe('紅');
  });

  it('賭徒型：偏好有風險的選項——精準型與搜尋型不碰的昏倒紅球，賭徒型去搶', () => {
    expect(nameOf(decideWith(gambler, 1, fatalMid, 0))).toBe('紅');
    expect(nameOf(decideWith(pathfinder, 1, fatalMid, 0))).not.toBe('紅');
    expect(nameOf(decideWith(precise, 1, fatalMid, 0))).not.toBe('紅');
  });

  it('賭徒型：落後時搶昏倒紅球的局面不少於領先時（掃描）', () => {
    let behind = 0;
    let ahead = 0;
    for (const hp of [1, 2]) {
      for (const red of RED_TABLE) {
        const base = {
          hp: [hp, 5] as [number, number],
          orbs: { red: [red[0], red[1]] as [number, number] },
        };
        if (nameOf(decideWith(gambler, 1, choosing({ ...base, score: [0, 25] }), 0)) === '紅') {
          behind += 1;
        }
        if (nameOf(decideWith(gambler, 1, choosing({ ...base, score: [25, 0] }), 0)) === '紅') {
          ahead += 1;
        }
      }
    }
    expect(behind).toBeGreaterThanOrEqual(ahead);
    expect(behind).toBeGreaterThanOrEqual(1);
  });
});

describe('H-7 血換分｜AI 能不能玩', () => {
  it('兩個等級 5 的搜尋型打完一整場：在 maxTicks 之前結束，12 回合都打完', () => {
    for (const seed of [0, 1, 2]) {
      const r = playMatch(
        h7Game,
        seed,
        CONFIG,
        levelController(h7Game, pathfinder, 5, seed * 2 + 1),
        levelController(h7Game, pathfinder, 5, seed * 2 + 2),
      );
      expect(r.ticks).toBeLessThan(CONFIG.maxTicks);
    }
  });

  it('等級 10 的搜尋型對人類模型：20 個種子贏過半（座位輪流）', () => {
    let points = 0;
    for (let seed = 0; seed < 20; seed += 1) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const ai = levelController(h7Game, pathfinder, 10, seed + 1);
      const human = humanModel(h7Game, seed + 2);
      const r =
        side === 0
          ? playMatch(h7Game, seed, CONFIG, ai, human)
          : playMatch(h7Game, seed, CONFIG, human, ai);
      points += r.winner === null ? 0.5 : r.winner === side ? 1 : 0;
    }
    expect(points / 20).toBeGreaterThan(0.5);
  }, 120_000);
});
