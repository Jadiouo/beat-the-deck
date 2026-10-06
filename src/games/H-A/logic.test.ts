import { describe, expect, it } from 'vitest';

import { levelController, levelParams, wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { playMatch } from '../../core/match';
import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Inputs, Side } from '../../core/types';
import {
  AI_WAIT_TICKS,
  DECISION_TIMEOUT,
  GOAL,
  IDLE,
  MAX_TURNS,
  PRESS_A,
  PRESS_B,
} from '../_hearts/logic';
import { hAGame, makeState } from './logic';
import type { HAState } from './logic';

/**
 * H-A 貪心骰的規則測試（TEST_PLAN 第 6 節 H-A 的 12 條，加上邊界與 AI 能不能玩）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣；骰子用「找一個會擲出指定點數的亂數狀態」的小工具決定。
 */

const CONFIG = { maxTicks: 3600, params: {} };

const BOTH_A: Buttons = { ...IDLE, a: true, b: true };

/** 一個 tick 的輸入：只有 `side` 這一邊按 `buttons`，另一邊全放開。 */
function only(side: Side, buttons: Buttons): Inputs {
  return side === 0 ? [buttons, IDLE] : [IDLE, buttons];
}

function idle(): Inputs {
  return [IDLE, IDLE];
}

function stepN(state: HAState, n: number, inputs: Inputs): HAState {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = hAGame.step(s, inputs);
  }
  return s;
}

/** 從某個亂數狀態開始，連續擲 `count` 顆骰子的點數。 */
function diceFrom(rng: RngState, count: number): number[] {
  const out: number[] = [];
  let s = rng;
  for (let i = 0; i < count; i += 1) {
    const [v, next] = intFrom(s, 6);
    out.push(v + 1);
    s = next;
  }
  return out;
}

/** 找一個亂數狀態，它連續擲出的骰子符合 `want`（只比對 want 的長度那麼多顆）。 */
function rngWithDice(want: readonly number[]): RngState {
  for (let i = 0; i < 100000; i += 1) {
    const candidate = rngStateFor(i, 'probe');
    const got = diceFrom(candidate, want.length);
    if (got.every((v, k) => v === want[k])) {
      return candidate;
    }
  }
  throw new Error(`找不到擲出 ${want.join(',')} 的亂數狀態`);
}

/** 找一個前 `count` 顆都不是 1 的亂數狀態。 */
function rngWithoutOnes(count: number): RngState {
  for (let i = 0; i < 100000; i += 1) {
    const candidate = rngStateFor(i, 'probe');
    if (diceFrom(candidate, count).every((v) => v !== 1)) {
      return candidate;
    }
  }
  throw new Error('找不到');
}

/** `side` 按 a（剛按下）再等一個 tick：骰子結算完。 */
function rollOnce(state: HAState, side: Side): HAState {
  const rolling = hAGame.step(state, only(side, PRESS_A));
  return hAGame.step(rolling, idle());
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

describe('H-A 貪心骰｜初始', () => {
  it('人先；兩邊 0 分；累積 0；沒有等待；骰子亂數由種子決定', () => {
    const s = hAGame.init(7, CONFIG);
    expect(s.turn).toBe(0);
    expect(s.totals).toEqual([0, 0]);
    expect(s.acc).toBe(0);
    expect(s.wait).toBe(0);
    expect(s.over).toBe(false);
    expect(hAGame.isOver(s)).toBe(false);
    expect(hAGame.winner(s)).toBeNull();
    expect(s.rng).toBe(rngStateFor(7, 'dice'));
  });
});

describe('H-A 貪心骰｜TEST_PLAN 第 6 節', () => {
  it('1. 人先。輪到人時 AI 的輸入被忽略，輪到 AI 時人的輸入被忽略', () => {
    const humanTurn = makeState({ turn: 0, acc: 4 });
    const afterAi = stepN(humanTurn, 10, only(1, BOTH_A));
    expect(afterAi.phase).toBe('choose');
    expect(afterAi.acc).toBe(4);
    expect(afterAi.turn).toBe(0);
    expect(afterAi.totals).toEqual([0, 0]);

    const aiTurn = makeState({ turn: 1, wait: 0, acc: 4 });
    const afterHuman = stepN(aiTurn, 10, only(0, BOTH_A));
    expect(afterHuman.phase).toBe('choose');
    expect(afterHuman.acc).toBe(4);
    expect(afterHuman.turn).toBe(1);
    expect(afterHuman.totals).toEqual([0, 0]);
  });

  it('2. 按 a 擲到 2 到 6：累積增加那個點數，還是自己的回合', () => {
    for (let points = 2; points <= 6; points += 1) {
      const start = makeState({ acc: 5, rng: rngWithDice([points]) });
      const rolling = hAGame.step(start, only(0, PRESS_A));
      expect(rolling.phase).toBe('rolling');
      expect(rolling.acc).toBe(5); // 骰子還在滾，結果還沒出來
      const done = hAGame.step(rolling, idle());
      expect(done.acc).toBe(5 + points);
      expect(done.lastRoll).toBe(points);
      expect(done.lastEvent).toBe('roll');
      expect(done.turn).toBe(0);
      expect(done.phase).toBe('choose');
      expect(done.totals).toEqual([0, 0]);
    }
  });

  it('3. 按 a 擲到 1：累積歸零，換對方，總分不變', () => {
    const start = makeState({ acc: 13, totals: [8, 3], rng: rngWithDice([1]) });
    const done = rollOnce(start, 0);
    expect(done.acc).toBe(0);
    expect(done.totals).toEqual([8, 3]);
    expect(done.turn).toBe(1);
    expect(done.lastRoll).toBe(1);
    expect(done.lastEvent).toBe('bust');
    expect(done.turnsDone).toBe(1);
    expect(done.wait).toBe(AI_WAIT_TICKS);
  });

  it('4. 按 b：累積加進總分，換對方', () => {
    const start = makeState({ acc: 12, totals: [5, 9] });
    const done = hAGame.step(start, only(0, PRESS_B));
    expect(done.totals).toEqual([17, 9]);
    expect(done.acc).toBe(0);
    expect(done.turn).toBe(1);
    expect(done.lastEvent).toBe('bank');
    expect(done.turnsDone).toBe(1);
  });

  it('5.（邊界）累積是 0 時按 b：允許，總分不變，換對方', () => {
    const start = makeState({ acc: 0, totals: [5, 9] });
    const done = hAGame.step(start, only(0, PRESS_B));
    expect(done.totals).toEqual([5, 9]);
    expect(done.turn).toBe(1);
    expect(done.turnsDone).toBe(1);
  });

  it('6.（邊界）輪到自己 300 個可以輸入的 tick 沒按：自動當成按 b；第 300 個 tick 按了 a 就不算超時', () => {
    const start = makeState({ acc: 9, totals: [3, 0] });
    const almost = stepN(start, DECISION_TIMEOUT - 1, idle());
    expect(almost.turn).toBe(0);
    expect(almost.acc).toBe(9);
    expect(almost.totals).toEqual([3, 0]);
    const timedOut = hAGame.step(almost, idle());
    expect(timedOut.totals).toEqual([12, 0]);
    expect(timedOut.turn).toBe(1);
    expect(timedOut.lastEvent).toBe('timeout');

    // 第 300 個 tick 剛好按 a：是擲骰，不是超時。
    const pressedAtLast = hAGame.step(almost, only(0, PRESS_A));
    expect(pressedAtLast.phase).toBe('rolling');
    expect(pressedAtLast.totals).toEqual([3, 0]);
    expect(pressedAtLast.turn).toBe(0);
  });

  it('6b. AI 的 45 tick 等待不算進 300：等待 45 ＋ 299 個 tick 還沒超時，再一個 tick 才超時', () => {
    const start = makeState({ turn: 1, wait: AI_WAIT_TICKS, acc: 0, totals: [0, 4] });
    const almost = stepN(start, AI_WAIT_TICKS + DECISION_TIMEOUT - 1, idle());
    expect(almost.turn).toBe(1);
    const timedOut = hAGame.step(almost, idle());
    expect(timedOut.turn).toBe(0);
    expect(timedOut.lastEvent).toBe('timeout');
    expect(timedOut.totals).toEqual([0, 4]);
  });

  it('7. 按住 a 不放：只擲一次；放開再按才算下一次', () => {
    const rng = rngWithoutOnes(3);
    const dice = diceFrom(rng, 3);
    let s = makeState({ rng });
    s = stepN(s, 12, only(0, PRESS_A)); // 一直按著
    expect(s.rolls).toBe(1);
    expect(s.acc).toBe(dice[0]);
    expect(s.turn).toBe(0);

    s = hAGame.step(s, idle()); // 放開
    s = stepN(s, 12, only(0, PRESS_A)); // 再按著
    expect(s.rolls).toBe(2);
    expect(s.acc).toBe((dice[0] as number) + (dice[1] as number));
  });

  it('8. 人先到 50：AI 還有一個回合；AI 在那個回合追過：AI 贏', () => {
    const start = makeState({ totals: [45, 40], acc: 8 });
    const humanBanks = hAGame.step(start, only(0, PRESS_B));
    expect(humanBanks.totals[0]).toBe(53);
    expect(humanBanks.over).toBe(false);
    expect(humanBanks.finalTurn).toBe(true);
    expect(humanBanks.turn).toBe(1);

    const chase = { ...humanBanks, wait: 0, acc: 15 };
    const aiBanks = hAGame.step(chase, only(1, PRESS_B));
    expect(aiBanks.totals).toEqual([53, 55]);
    expect(aiBanks.over).toBe(true);
    expect(hAGame.winner(aiBanks)).toBe(1);
    expect(hAGame.score(aiBanks)).toEqual([53, 55]);
  });

  it('8b. 人先到 50、AI 的最後一回合沒追過（擲到 1、存的不夠、超時）：人贏；剛好追平：平手', () => {
    const final = makeState({ totals: [53, 40], turn: 1, wait: 0, finalTurn: true, turnsDone: 11 });

    const bust = rollOnce({ ...final, acc: 6, rng: rngWithDice([1]) }, 1);
    expect(bust.over).toBe(true);
    expect(hAGame.winner(bust)).toBe(0);

    const short = hAGame.step({ ...final, acc: 9 }, only(1, PRESS_B));
    expect(short.over).toBe(true);
    expect(hAGame.winner(short)).toBe(0);

    const tie = hAGame.step({ ...final, acc: 13 }, only(1, PRESS_B));
    expect(tie.totals).toEqual([53, 53]);
    expect(tie.over).toBe(true);
    expect(hAGame.winner(tie)).toBeNull();

    const timeout = stepN({ ...final, acc: 20 }, DECISION_TIMEOUT, idle());
    expect(timeout.over).toBe(true);
    expect(hAGame.winner(timeout)).toBe(1);
  });

  it('9. AI 先到 50（AI 是後手）：立刻結束，AI 贏', () => {
    const start = makeState({ turn: 1, wait: 0, totals: [30, 45], acc: 6, turnsDone: 9 });
    const done = hAGame.step(start, only(1, PRESS_B));
    expect(done.totals).toEqual([30, 51]);
    expect(done.over).toBe(true);
    expect(hAGame.isOver(done)).toBe(true);
    expect(hAGame.winner(done)).toBe(1);
  });

  it('9b.（邊界）剛好 50 分就算達到；累積加總分超過 50 但沒存，不算', () => {
    const exactly = hAGame.step(
      makeState({ turn: 1, wait: 0, totals: [30, 42], acc: 8, turnsDone: 9 }),
      only(1, PRESS_B),
    );
    expect(exactly.totals[1]).toBe(GOAL);
    expect(exactly.over).toBe(true);

    const unbanked = rollOnce(
      makeState({
        turn: 1,
        wait: 0,
        totals: [30, 49],
        acc: 10,
        turnsDone: 9,
        rng: rngWithDice([6]),
      }),
      1,
    );
    expect(unbanked.acc).toBe(16);
    expect(unbanked.over).toBe(false);
  });

  it('10.（邊界）兩邊各 20 個回合後都沒到 50：比總分；同分平手', () => {
    const last = makeState({
      turn: 1,
      wait: 0,
      turnsDone: MAX_TURNS - 1,
      totals: [30, 28],
      acc: 5,
    });
    const aiHigher = hAGame.step(last, only(1, PRESS_B));
    expect(aiHigher.turnsDone).toBe(MAX_TURNS);
    expect(aiHigher.over).toBe(true);
    expect(aiHigher.totals).toEqual([30, 33]);
    expect(hAGame.winner(aiHigher)).toBe(1);

    const humanHigher = hAGame.step({ ...last, acc: 1 }, only(1, PRESS_B));
    expect(humanHigher.over).toBe(true);
    expect(hAGame.winner(humanHigher)).toBe(0);

    const tied = hAGame.step({ ...last, acc: 2 }, only(1, PRESS_B));
    expect(tied.totals).toEqual([30, 30]);
    expect(hAGame.winner(tied)).toBeNull();

    // 第 40 個回合是擲到 1 結束的，也要結束。
    const bust = rollOnce({ ...last, acc: 5, rng: rngWithDice([1]) }, 1);
    expect(bust.over).toBe(true);
    expect(hAGame.winner(bust)).toBe(0);

    // 第 39 個回合（人的第 20 個）之後還沒結束。
    const before = hAGame.step(
      makeState({ turn: 0, turnsDone: MAX_TURNS - 2, totals: [30, 28], acc: 5 }),
      only(0, PRESS_B),
    );
    expect(before.over).toBe(false);
    expect(before.turn).toBe(1);
  });

  it('11. AI 做每個決定前等 45 tick：這 45 個 tick 裡 AI 的輸入被忽略，第 46 個 tick 才擲；每擲完一次又等 45 tick；人沒有等待', () => {
    const rng = rngWithoutOnes(3);
    // 人存分之後輪到 AI：wait = 45。
    const afterHuman = hAGame.step(makeState({ acc: 7, rng }), only(0, PRESS_B));
    expect(afterHuman.turn).toBe(1);
    expect(afterHuman.wait).toBe(AI_WAIT_TICKS);

    let s = afterHuman;
    for (let i = 1; i <= AI_WAIT_TICKS; i += 1) {
      s = hAGame.step(s, only(1, PRESS_A)); // AI 一直按著 a
      expect(s.phase).toBe('choose');
      expect(s.acc).toBe(0);
    }
    expect(s.wait).toBe(0);
    s = hAGame.step(s, only(1, PRESS_A)); // 第 46 個 tick
    expect(s.phase).toBe('rolling');
    s = hAGame.step(s, only(1, PRESS_A)); // 第 47 個：結果出來
    expect(s.rolls).toBe(1);
    expect(s.acc).toBe(diceFrom(rng, 1)[0]);
    expect(s.turn).toBe(1);
    expect(s.wait).toBe(AI_WAIT_TICKS); // 擲完又等 45 tick

    // 再 45 個 tick 的輸入都被忽略；一直按著 a，等待一結束又擲一次（被忽略的輸入視同放開）。
    for (let i = 1; i <= AI_WAIT_TICKS; i += 1) {
      s = hAGame.step(s, only(1, PRESS_A));
      expect(s.phase).toBe('choose');
    }
    s = hAGame.step(s, only(1, PRESS_A));
    expect(s.phase).toBe('rolling');

    // 人（0 號邊）擲完沒有等待。
    const human = rollOnce(makeState({ rng }), 0);
    expect(human.wait).toBe(0);
  });

  it('12. 用固定種子，骰子序列是決定的；不同種子的序列不全相同', () => {
    // 兩邊都交替按下、放開 a：每一個結算出來的骰子都記下來。
    const record = (seed: number, count: number): number[] => {
      let s = hAGame.init(seed, { maxTicks: 100000, params: {} });
      const seen: number[] = [];
      let lastRolls = 0;
      for (let t = 0; t < 4000 && seen.length < count; t += 1) {
        const press = t % 2 === 0 ? PRESS_A : IDLE;
        s = hAGame.step(s, [press, press]);
        if (s.rolls !== lastRolls) {
          lastRolls = s.rolls;
          seen.push(s.lastRoll);
        }
      }
      return seen;
    };
    const a = record(5, 12);
    const b = record(5, 12);
    expect(a).toHaveLength(12);
    expect(a).toEqual(b);
    // 與 `rngStateFor(seed, 'dice')` 連續 `intFrom(…, 6) + 1` 的序列一致。
    expect(a).toEqual(diceFrom(rngStateFor(5, 'dice'), 12));

    const sequences = Array.from({ length: 10 }, (_, seed) => record(seed, 8).join(','));
    expect(new Set(sequences).size).toBeGreaterThan(1);
  });
});

describe('H-A 貪心骰｜其他規則', () => {
  it('兩個鍵同時剛按下：b 贏（保守的那個）', () => {
    const done = hAGame.step(makeState({ acc: 6 }), only(0, BOTH_A));
    expect(done.totals).toEqual([6, 0]);
    expect(done.turn).toBe(1);
    expect(done.phase).toBe('choose');
  });

  it('b 也是邊緣觸發：按著 b 跨過對方的回合，回到自己的回合不會立刻存分', () => {
    // 人按 b 存分，之後一直按著 b。AI 超時 b 回來之後，人的回合不會因為 b 還按著就立刻結束。
    let s = hAGame.step(makeState({ acc: 3 }), only(0, PRESS_B));
    expect(s.turn).toBe(1);
    s = stepN(s, AI_WAIT_TICKS + DECISION_TIMEOUT, only(0, PRESS_B));
    expect(s.turn).toBe(0);
    s = stepN(s, 5, only(0, PRESS_B));
    expect(s.turn).toBe(0);
    expect(s.turnsDone).toBe(2);
    // 放開再按才算。
    s = hAGame.step(s, idle());
    s = hAGame.step(s, only(0, PRESS_B));
    expect(s.turn).toBe(1);
  });

  it('時間到（第 maxTicks 個 tick）：結束，比總分，沒存的累積不算', () => {
    const s = makeState({ maxTicks: 10, tick: 9, totals: [7, 5], acc: 20 });
    const done = hAGame.step(s, idle());
    expect(done.over).toBe(true);
    expect(done.totals).toEqual([7, 5]);
    expect(hAGame.winner(done)).toBe(0);

    const tie = hAGame.step(makeState({ maxTicks: 10, tick: 9, totals: [5, 5] }), idle());
    expect(tie.over).toBe(true);
    expect(hAGame.winner(tie)).toBeNull();
  });

  it('結束之後 step 原樣回傳同一個 state；winner 在結束前是 null', () => {
    const live = makeState({ acc: 3 });
    expect(hAGame.winner(live)).toBeNull();
    const over = hAGame.step(
      makeState({ turn: 1, wait: 0, totals: [30, 49], acc: 3 }),
      only(1, PRESS_B),
    );
    expect(over.over).toBe(true);
    expect(hAGame.step(over, only(0, PRESS_A))).toBe(over);
  });

  it('step 不改動傳進來的 state 與輸入（深度凍結也不丟錯）', () => {
    const s = deepFreeze(makeState({ acc: 4, rng: rngWithDice([3]) }));
    const inputs = deepFreeze<Inputs>([{ ...PRESS_A }, { ...IDLE }]);
    const rolling = hAGame.step(s, inputs);
    expect(rolling.phase).toBe('rolling');
    expect(s.phase).toBe('choose');
    const done = hAGame.step(deepFreeze(rolling), deepFreeze<Inputs>([{ ...IDLE }, { ...IDLE }]));
    expect(done.acc).toBe(7);
  });

  it('隨機事件：骰子的新 RngState 有寫回 state（連續兩次擲骰不會拿到同一個亂數狀態）', () => {
    const s = makeState({ rng: rngWithoutOnes(2) });
    const first = rollOnce(s, 0);
    const second = rollOnce(hAGame.step(first, idle()), 0);
    expect(first.rng).not.toBe(s.rng);
    expect(second.rng).not.toBe(first.rng);
    expect(second.rolls).toBe(2);
  });
});

describe('H-A 貪心骰｜actions 與 evaluate', () => {
  it('可以輸入時：兩個鍵都能按就是 [b, a]（不列「全放開」，免得一步看的性格一直拖延）；不能輸入時只有一個「全放開」', () => {
    const mine = hAGame.actions(makeState(), 0);
    expect(mine).toHaveLength(2);
    expect(mine.some((a) => a.a && !a.b)).toBe(true);
    expect(mine.some((a) => a.b && !a.a)).toBe(true);
    expect(mine.some((a) => !a.a && !a.b)).toBe(false);

    // a 還按著：按 a 沒有用，所以列「全放開」與 b；b 還按著同理。
    const aHeld = hAGame.actions(
      makeState({
        held: [
          { a: true, b: false },
          { a: false, b: false },
        ],
      }),
      0,
    );
    expect(aHeld[0]).toEqual(IDLE);
    expect(aHeld.some((a) => a.a)).toBe(false);
    expect(aHeld.some((a) => a.b)).toBe(true);
    const bHeld = hAGame.actions(
      makeState({
        held: [
          { a: false, b: true },
          { a: false, b: false },
        ],
      }),
      0,
    );
    expect(bHeld[0]).toEqual(IDLE);
    expect(bHeld.some((a) => a.b)).toBe(false);
    expect(bHeld.some((a) => a.a)).toBe(true);
    const bothHeld = hAGame.actions(
      makeState({
        held: [
          { a: true, b: true },
          { a: false, b: false },
        ],
      }),
      0,
    );
    expect(bothHeld).toEqual([IDLE]);

    const notMine = hAGame.actions(makeState(), 1);
    expect(notMine).toEqual([IDLE]);
    const waiting = hAGame.actions(makeState({ turn: 1, wait: 12 }), 1);
    expect(waiting).toEqual([IDLE]);
    const rolling = hAGame.actions(makeState({ phase: 'rolling' }), 0);
    expect(rolling).toEqual([IDLE]);
    const over = hAGame.actions(makeState({ over: true }), 0);
    expect(over).toEqual([IDLE]);
  });

  it('a 還按著時，按 a 沒有用（邊緣觸發）：往前模擬「按 a」得到的局面，和「全放開」不同的只有「還按著」', () => {
    const held = makeState({
      acc: 6,
      held: [
        { a: true, b: false },
        { a: false, b: false },
      ],
    });
    const stillHeld = hAGame.step(held, only(0, PRESS_A));
    expect(stillHeld.phase).toBe('choose');
    expect(stillHeld.rolls).toBe(0);
    const released = hAGame.step(held, idle());
    expect(released.held[0].a).toBe(false);
    // 放開之後再按，才會擲。
    expect(hAGame.step(released, only(0, PRESS_A)).phase).toBe('rolling');
  });

  it('evaluate：danger 在 0 到 1，gain 有限；結束的局有勝負加成', () => {
    for (const acc of [0, 5, 20, 40]) {
      for (const phase of ['choose', 'rolling'] as const) {
        const s = makeState({ acc, phase, totals: [10, 20] });
        for (const side of [0, 1] as const) {
          const { gain, danger } = hAGame.evaluate(s, side);
          expect(Number.isFinite(gain)).toBe(true);
          expect(danger).toBeGreaterThanOrEqual(0);
          expect(danger).toBeLessThanOrEqual(1);
        }
      }
    }
    const won = makeState({ over: true, winner: 0, totals: [52, 30] });
    expect(hAGame.evaluate(won, 0).gain).toBeGreaterThan(900);
    expect(hAGame.evaluate(won, 1).gain).toBeLessThan(-900);
    expect(hAGame.evaluate(won, 0).danger).toBe(0);
  });

  it('evaluate 不讀骰子：同一個局面、不同的下一顆骰子，骰子在滾時的 gain 相同（AI 不偷看）', () => {
    const a = makeState({ acc: 10, phase: 'rolling', rng: rngWithDice([1]) });
    const b = makeState({ acc: 10, phase: 'rolling', rng: rngWithDice([6]) });
    expect(hAGame.evaluate(a, 0)).toEqual(hAGame.evaluate(b, 0));
    // 一步看的性格往前模擬「按 a」，看到的也是「骰子在滾」，所以兩種骰子下的 evaluate 相同。
    const afterA = hAGame.step(makeState({ acc: 10, rng: rngWithDice([1]) }), only(0, PRESS_A));
    const afterB = hAGame.step(makeState({ acc: 10, rng: rngWithDice([6]) }), only(0, PRESS_A));
    expect(hAGame.evaluate(afterA, 0).gain).toBe(hAGame.evaluate(afterB, 0).gain);
  });

  it('賭徒型（領先或打平）：累積到 20 以前繼續擲，20 以上存分；等待與骰子在滾時不亂按', () => {
    const decide = (s: HAState, side: Side = 0): Buttons =>
      gambler.decide(hAGame, s, side, 0, { depth: 1, seed: 0 });
    expect(decide(makeState({ acc: 0 })).a).toBe(true);
    expect(decide(makeState({ acc: 12 })).a).toBe(true);
    expect(decide(makeState({ acc: 19 })).a).toBe(true);
    expect(decide(makeState({ acc: 22 })).b).toBe(true);
    expect(decide(makeState({ acc: 31 })).b).toBe(true);
    expect(decide(makeState({ turn: 1, wait: 20, acc: 8 }), 1)).toEqual(IDLE);
    expect(decide(makeState({ phase: 'rolling', acc: 8 }))).toEqual(IDLE);
    // 存了就能贏的時候存分。
    expect(decide(makeState({ turn: 1, wait: 0, totals: [30, 45], acc: 6 }), 1).b).toBe(true);
    // 人已經 53、AI 是最後一回合：總分 40 + 累積 9 還追不上，一定繼續擲。
    const chase = makeState({
      turn: 1,
      wait: 0,
      finalTurn: true,
      totals: [53, 40],
      acc: 9,
    });
    expect(decide(chase, 1).a).toBe(true);
  });

  it('a 還按著、而且想繼續擲的時候，一步看的性格會先選「放開」（精準型、搜尋型也一樣，不會因為怕危險一直不動）', () => {
    const held = makeState({
      acc: 6,
      held: [
        { a: true, b: false },
        { a: false, b: false },
      ],
    });
    for (const policy of [gambler, precise, pathfinder]) {
      const choice = policy.decide(hAGame, held, 0, 0, { depth: 1, seed: 0 });
      expect(choice).toEqual(IDLE);
    }
    // 已經放開（可以擲）時，三種性格都會按 a。
    const armed = makeState({ acc: 6 });
    for (const policy of [gambler, precise, pathfinder]) {
      expect(policy.decide(hAGame, armed, 0, 0, { depth: 1, seed: 0 }).a).toBe(true);
    }
  });
});

describe('H-A 貪心骰｜AI 在邊緣觸發下也能玩', () => {
  it('AI 坐 1 號邊、每個 tick 都回傳同一組按鍵（一直按著 a）：等待一結束就擲，連續擲好幾次', () => {
    const rng = rngWithoutOnes(4);
    let s = makeState({ turn: 1, wait: AI_WAIT_TICKS, rng });
    s = stepN(s, 400, only(1, PRESS_A));
    expect(s.rolls).toBeGreaterThanOrEqual(4);
    expect(s.turn).toBe(1);
  });

  it('等級 5 的賭徒型坐 1 號邊：一個回合裡擲不止一次，而且不是靠超時', () => {
    const rng = rngWithoutOnes(6);
    let s = makeState({ turn: 1, wait: AI_WAIT_TICKS, rng });
    // 等級 5 的反應延遲（11）與決定間隔（7），但不亂選（epsilon = 0），測的是邊緣觸發而不是運氣。
    const steady = { ...levelParams(5), epsilon: 0 };
    const ai = wrapPolicy(hAGame, gambler, steady, 3);
    const human = wrapPolicy(hAGame, gambler, steady, 4);
    for (let tick = 0; tick < 500 && s.turn === 1; tick += 1) {
      s = hAGame.step(s, [human.decide(s, 0, tick), ai.decide(s, 1, tick)]);
    }
    expect(s.rolls).toBeGreaterThanOrEqual(2);
    expect(s.lastEvent).not.toBe('timeout');
    expect(s.turn).toBe(0); // 累積到 20 以上就存了，回合結束
    expect(s.totals[1]).toBeGreaterThanOrEqual(20);
  });

  it('等級 5 的賭徒型坐 0 號邊（沒有 45 tick 等待）：要先放開再按，也能連續擲、不靠超時', () => {
    const rng = rngWithoutOnes(6);
    let s = makeState({ turn: 0, rng });
    const steady = { ...levelParams(5), epsilon: 0 };
    const human = wrapPolicy(hAGame, gambler, steady, 3);
    const ai = wrapPolicy(hAGame, gambler, steady, 4);
    for (let tick = 0; tick < 600 && s.turn === 0; tick += 1) {
      s = hAGame.step(s, [human.decide(s, 0, tick), ai.decide(s, 1, tick)]);
    }
    expect(s.rolls).toBeGreaterThanOrEqual(2);
    expect(s.lastEvent).not.toBe('timeout');
    expect(s.totals[0]).toBeGreaterThanOrEqual(20);
  });

  it('兩個等級 5 的賭徒型打完一整場：在 maxTicks 之內結束，並且在時間上限之前通常就分出勝負', () => {
    let finishedEarly = 0;
    for (let seed = 0; seed < 6; seed += 1) {
      const a = levelController(hAGame, gambler, 5, seed);
      const b = levelController(hAGame, gambler, 5, seed + 1_000_003);
      const result = playMatch(hAGame, seed, CONFIG, a, b);
      expect(result.ticks).toBeLessThanOrEqual(CONFIG.maxTicks);
      if (result.ticks < CONFIG.maxTicks) {
        finishedEarly += 1;
      }
    }
    expect(finishedEarly).toBeGreaterThanOrEqual(3);
  });
});
