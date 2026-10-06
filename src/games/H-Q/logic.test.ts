import { describe, expect, it } from 'vitest';

import { levelController, levelParams, wrapPolicy } from '../../ai/level';
import { humanModel } from '../../ai/human-model';
import { pathfinder } from '../../ai/policies/pathfinder';
import { random } from '../../ai/policies/random';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Inputs, Side } from '../../core/types';
import { AI_WAIT_TICKS, DECISION_TIMEOUT, IDLE } from '../_hearts/logic';
import {
  CALL_BUTTONS,
  CHIPS,
  FOLD,
  LOCK_TICKS,
  MOVE_BUTTONS,
  PAPER,
  predictOpponent,
  RAISE_BUTTONS,
  readAccuracy,
  RESPOND_PREP,
  RESULT_TICKS,
  ROCK,
  ROUNDS,
  SCISSORS,
  foldCost,
  hQGame,
  makeState,
  raiseFee,
  respondFoldCost,
  stakeFor,
} from './logic';
import type { HQState, Move } from './logic';

/**
 * H-Q 加碼的規則測試（規則見 `docs/cards/H-Q.md`）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 三條關鍵測試：不偷看（pending 階段只有對手的 pending 不同）、會讀對手、隨機事件在不同種子下不全相同。
 */

const CONFIG = { maxTicks: 3600, params: {} };

/** 沒有人出手的一個 tick。 */
function idle(): Inputs {
  return [IDLE, IDLE];
}

/** 兩邊各出一手（`null` 是不按）。 */
function throwBoth(m0: Move | null, m1: Move | null): Inputs {
  return [m0 === null ? IDLE : MOVE_BUTTONS[m0], m1 === null ? IDLE : MOVE_BUTTONS[m1]];
}

function stepN(state: HQState, n: number, inputs: Inputs = idle()): HQState {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = hQGame.step(s, inputs);
  }
  return s;
}

/** 剛進入 choose 階段（兩邊都還沒出手）的局面。 */
function choosing(overrides: Partial<HQState> = {}): HQState {
  return makeState({ phase: 'choose', wait: 0, ...overrides });
}

/** 從 choose 開始：兩邊同一個 tick 出手，走完鎖定與開牌（還沒入帳）。 */
function toResult(state: HQState, m0: Move, m1: Move): HQState {
  const locked = hQGame.step(state, throwBoth(m0, m1));
  return stepN(locked, LOCK_TICKS);
}

/** 從 choose 開始：出手、開牌、入帳（下一回合的 prep 或結束）。 */
function playRound(state: HQState, m0: Move, m1: Move): HQState {
  return stepN(toResult(state, m0, m1), RESULT_TICKS);
}

/** 一個動作是不是某個 Move 的按鍵。 */
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

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** 歷史：每一筆是 `[人, AI]`。 */
function historyOf(moves: readonly (readonly [Move, Move])[]): HQState['history'] {
  return moves.map((pair) => [pair[0], pair[1]] as const);
}

/** 用搜尋型、指定深度（沒有延遲、不亂選）在某個局面替某一邊決定按什麼。 */
function decideAtDepth(state: HQState, side: Side, depth: number): Buttons {
  const controller = wrapPolicy(
    hQGame,
    pathfinder,
    { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
    7,
  );
  return controller.decide(state, side, 0);
}

/** 這個按鍵是哪一個 Move（加碼的拳算那一拳；沒有對應回傳 null）。有沒有加碼看 `decode`。 */
function moveOf(buttons: Buttons): Move | null {
  return decode(buttons)?.move ?? null;
}

/** 這個按鍵是哪個出手、有沒有加碼（沒有對應回傳 null）。 */
function decode(buttons: Buttons): { move: Move; raised: boolean } | null {
  for (const m of [ROCK, PAPER, SCISSORS, FOLD] as const) {
    if (sameButtons(MOVE_BUTTONS[m], buttons)) {
      return { move: m, raised: false };
    }
  }
  for (const m of [ROCK, PAPER, SCISSORS] as const) {
    if (sameButtons(RAISE_BUTTONS[m] as Buttons, buttons)) {
      return { move: m, raised: true };
    }
  }
  return null;
}

/** 回應期的按鍵：a 跟、b 棄牌、其他是沒按。 */
function respondOf(buttons: Buttons): 'call' | 'fold' | 'none' {
  if (sameButtons(buttons, CALL_BUTTONS)) {
    return 'call';
  }
  if (sameButtons(buttons, MOVE_BUTTONS[FOLD])) {
    return 'fold';
  }
  return 'none';
}

/** 出手的按鍵：`raised` 是 a 加上那一拳（棄牌沒有加碼）。 */
function press(move: Move, raised = false): Buttons {
  return raised && move !== FOLD ? (RAISE_BUTTONS[move] as Buttons) : MOVE_BUTTONS[move];
}

/** 從 choose 開始：兩邊出手（可以加碼），走完鎖定的 2 個 tick。 */
function lockAndSettle(state: HQState, b0: Buttons, b1: Buttons): HQState {
  return stepN(hQGame.step(state, [b0, b1]), LOCK_TICKS);
}

/** 再走 RESPOND_PREP 個 tick：只有一邊加碼的回合，回應期開了。 */
function openRespond(state: HQState, b0: Buttons, b1: Buttons): HQState {
  return stepN(lockAndSettle(state, b0, b1), RESPOND_PREP);
}

/** 從 choose 開始走完一整回合（含回應期；`response` 是沒加碼的那一邊的回應），回傳入帳之後的 state。 */
function playFull(
  state: HQState,
  b0: Buttons,
  b1: Buttons,
  response: 'call' | 'fold' = 'call',
): HQState {
  let s = lockAndSettle(state, b0, b1);
  if (s.phase === 'respond') {
    s = stepN(s, RESPOND_PREP);
    const responder: Side = s.raised[0] ? 1 : 0;
    const reply = response === 'call' ? CALL_BUTTONS : MOVE_BUTTONS[FOLD];
    s = hQGame.step(s, responder === 0 ? [reply, IDLE] : [IDLE, reply]);
  }
  return stepN(s, RESULT_TICKS);
}

/** 人（0 號邊）一直出石頭 7 次：AI 讀得很準，已經到加碼值得的程度。 */
const STEADY = historyOf([
  [ROCK, PAPER],
  [ROCK, SCISSORS],
  [ROCK, ROCK],
  [ROCK, PAPER],
  [ROCK, PAPER],
  [ROCK, PAPER],
  [ROCK, SCISSORS],
]);
/** 亂出的人：AI 預測的命中率只有三分之一。 */
const MESSY = historyOf([
  [ROCK, PAPER],
  [SCISSORS, SCISSORS],
  [PAPER, ROCK],
  [PAPER, PAPER],
  [SCISSORS, ROCK],
  [ROCK, SCISSORS],
]);

describe('H-Q 加碼｜初始與常數', () => {
  it('第 0 回合、賭注 1、準備階段（還要等 45 tick）、籌碼各 100、歷史是空的、salt 由種子決定', () => {
    const s = hQGame.init(3, CONFIG);
    expect(s.round).toBe(0);
    expect(s.stake).toBe(1);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.chips).toEqual([CHIPS, CHIPS]);
    expect(CHIPS).toBe(100);
    expect(s.history).toEqual([]);
    expect(s.pending).toEqual([null, null]);
    expect(s.over).toBe(false);
    expect(hQGame.isOver(s)).toBe(false);
    expect(hQGame.winner(s)).toBeNull();
    expect(hQGame.score(s)).toEqual([CHIPS, CHIPS]);
    expect(hQGame.init(3, CONFIG).salt).toBe(s.salt);
  });

  it('賭注每回合加倍、上限 8：1、2、4、8、8、8、8、8、8、8；沒看到加碼就棄牌付一整個賭注，看到加碼之後才棄牌付四分之三（進位）', () => {
    expect(ROUNDS).toBe(10);
    expect(Array.from({ length: ROUNDS }, (_v, r) => stakeFor(r))).toEqual([
      1, 2, 4, 8, 8, 8, 8, 8, 8, 8,
    ]);
    expect([1, 2, 4, 8].map(foldCost)).toEqual([1, 2, 4, 8]);
    expect([1, 2, 4, 8].map(respondFoldCost)).toEqual([1, 2, 3, 6]);
  });
});

describe('H-Q 加碼｜規則', () => {
  it('1. 準備 45 tick：這段時間兩邊的輸入都被忽略（邊界：第 45 個 tick 按無效，第 46 個 tick 才算）', () => {
    let s = hQGame.init(1, CONFIG);
    s = stepN(s, AI_WAIT_TICKS - 1, throwBoth(ROCK, ROCK));
    expect(s.phase).toBe('prep');
    expect(s.pending).toEqual([null, null]);
    // 第 45 個 tick：還是準備的最後一個 tick，按了沒有用，之後進入 choose。
    s = hQGame.step(s, throwBoth(ROCK, ROCK));
    expect(s.tick).toBe(AI_WAIT_TICKS);
    expect(s.phase).toBe('choose');
    expect(s.pending).toEqual([null, null]);
    // 第 46 個 tick：收輸入。
    s = hQGame.step(s, throwBoth(PAPER, null));
    expect(s.pending).toEqual([PAPER, null]);
  });

  it('2. 出手只寫進 pending，不當場結算：籌碼不動、階段還是 choose、歷史沒有新的一筆', () => {
    const s = hQGame.step(choosing(), throwBoth(ROCK, null));
    expect(s.pending).toEqual([ROCK, null]);
    expect(s.phase).toBe('choose');
    expect(s.chips).toEqual([CHIPS, CHIPS]);
    expect(s.history).toEqual([]);
  });

  it('3. 出手之後不能改：再按別的拳沒有用', () => {
    let s = hQGame.step(choosing(), throwBoth(ROCK, null));
    s = hQGame.step(s, throwBoth(SCISSORS, null));
    s = hQGame.step(s, throwBoth(FOLD, null));
    expect(s.pending[0]).toBe(ROCK);
  });

  it('4. 結算順序：兩邊都出手 → 鎖定 2 tick → 開牌（結果算出來、籌碼還沒動）→ 開牌停 30 tick → 入帳、歷史加一筆、進下一回合的準備', () => {
    const base = choosing({ stake: 4, round: 2 });
    const locked = hQGame.step(base, throwBoth(PAPER, ROCK));
    expect(locked.phase).toBe('locked');
    expect(locked.wait).toBe(LOCK_TICKS);
    expect(locked.chips).toEqual([CHIPS, CHIPS]);
    expect(locked.last).toBeNull();

    const halfway = hQGame.step(locked, idle());
    expect(halfway.phase).toBe('locked');
    expect(halfway.last).toBeNull();

    const opened = hQGame.step(halfway, idle());
    expect(opened.phase).toBe('result');
    expect(opened.wait).toBe(RESULT_TICKS);
    expect(opened.last?.moves).toEqual([PAPER, ROCK]);
    expect(opened.last?.delta).toEqual([4, -4]);
    expect(opened.chips).toEqual([CHIPS, CHIPS]);
    expect(opened.history).toEqual([]);

    const during = stepN(opened, RESULT_TICKS - 1);
    expect(during.phase).toBe('result');
    expect(during.chips).toEqual([CHIPS, CHIPS]);

    const next = hQGame.step(during, idle());
    expect(next.chips).toEqual([CHIPS + 4, CHIPS - 4]);
    expect(next.history).toEqual([[PAPER, ROCK]]);
    expect(next.round).toBe(3);
    expect(next.stake).toBe(8);
    expect(next.phase).toBe('prep');
    expect(next.wait).toBe(AI_WAIT_TICKS);
    expect(next.pending).toEqual([null, null]);
    expect(next.last).toBeNull();
  });

  it('5. 石頭、布、剪刀的九種組合：布贏石頭、剪刀贏布、石頭贏剪刀，贏的人拿走賭注，同手平手', () => {
    const wins = new Map<string, number>([
      [`${PAPER}${ROCK}`, 1],
      [`${SCISSORS}${PAPER}`, 1],
      [`${ROCK}${SCISSORS}`, 1],
    ]);
    for (const m0 of [ROCK, PAPER, SCISSORS] as const) {
      for (const m1 of [ROCK, PAPER, SCISSORS] as const) {
        const after = playRound(choosing({ stake: 8, round: 5 }), m0, m1);
        const win0 = wins.has(`${m0}${m1}`);
        const win1 = wins.has(`${m1}${m0}`);
        const expected: [number, number] = win0
          ? [CHIPS + 8, CHIPS - 8]
          : win1
            ? [CHIPS - 8, CHIPS + 8]
            : [CHIPS, CHIPS];
        expect(after.chips).toEqual(expected);
      }
    }
  });

  it('6. 平手：誰都不動，賭注不重複、不疊加，下一回合還是照回合數加倍', () => {
    const after = playRound(choosing({ stake: 2, round: 1 }), SCISSORS, SCISSORS);
    expect(after.chips).toEqual([CHIPS, CHIPS]);
    expect(after.history).toEqual([[SCISSORS, SCISSORS]]);
    expect(after.round).toBe(2);
    expect(after.stake).toBe(4);
  });

  it('7. 棄牌（沒看到加碼）：棄牌的人付一整個賭注給對方；對方出什麼都一樣（連對方的輸拳也拿）', () => {
    for (const other of [ROCK, PAPER, SCISSORS] as const) {
      const a = playRound(choosing({ stake: 8, round: 4 }), FOLD, other);
      expect(a.chips).toEqual([CHIPS - 8, CHIPS + 8]);
      const b = playRound(choosing({ stake: 8, round: 4 }), other, FOLD);
      expect(b.chips).toEqual([CHIPS + 8, CHIPS - 8]);
    }
    expect(playRound(choosing({ stake: 1 }), FOLD, ROCK).chips).toEqual([CHIPS - 1, CHIPS + 1]);
    expect(playRound(choosing({ stake: 2, round: 1 }), ROCK, FOLD).chips).toEqual([
      CHIPS + 2,
      CHIPS - 2,
    ]);
    expect(playRound(choosing({ stake: 4, round: 2 }), FOLD, SCISSORS).chips).toEqual([
      CHIPS - 4,
      CHIPS + 4,
    ]);
  });

  it('8.（邊界）兩邊都棄牌：誰都不動', () => {
    const after = playRound(choosing({ stake: 8, round: 6 }), FOLD, FOLD);
    expect(after.chips).toEqual([CHIPS, CHIPS]);
    expect(after.history).toEqual([[FOLD, FOLD]]);
  });

  it('9.（邊界）同一個 tick 兩邊都出手：兩邊都記下來，立刻鎖定；同一邊同一個 tick 按好幾個鍵：棄牌贏過拳，其次左、上、右', () => {
    const both = hQGame.step(choosing(), throwBoth(ROCK, PAPER));
    expect(both.pending).toEqual([ROCK, PAPER]);
    expect(both.phase).toBe('locked');

    const press = (buttons: Partial<Buttons>): Move | null =>
      hQGame.step(choosing(), [{ ...IDLE, ...buttons }, IDLE]).pending[0];
    expect(press({ left: true, b: true })).toBe(FOLD);
    expect(press({ up: true, right: true, b: true })).toBe(FOLD);
    expect(press({ left: true, up: true, right: true })).toBe(ROCK);
    expect(press({ up: true, right: true })).toBe(PAPER);
    expect(press({ right: true })).toBe(SCISSORS);
    // a 與下沒有作用。
    expect(press({ a: true })).toBeNull();
    expect(press({ down: true })).toBeNull();
  });

  it('10.（邊界）超時：choose 的第 300 個 tick 還沒出手的那一邊自動棄牌；第 300 個 tick 按了拳算出手，不算超時', () => {
    const base = choosing({ stake: 8, round: 4 });
    // 還差 1 個 tick 超時：不按 → 自動棄牌。
    const late = hQGame.step({ ...base, idle: DECISION_TIMEOUT - 1 }, idle());
    expect(late.pending).toEqual([FOLD, FOLD]);
    expect(late.phase).toBe('locked');
    // 第 300 個 tick 按了拳：算出手；沒按的那一邊自動棄牌。
    const edge = hQGame.step({ ...base, idle: DECISION_TIMEOUT - 1 }, throwBoth(PAPER, null));
    expect(edge.pending).toEqual([PAPER, FOLD]);
    const settled = toResult({ ...base, idle: DECISION_TIMEOUT - 1 }, PAPER, ROCK);
    expect(settled.last?.timeout).toEqual([false, false]);
    // 第 299 個 tick 不按：還在等。
    const waiting = hQGame.step({ ...base, idle: DECISION_TIMEOUT - 2 }, idle());
    expect(waiting.pending).toEqual([null, null]);
    expect(waiting.phase).toBe('choose');
    // 超時的棄牌要記下來，而且照棄牌算錢。
    const timedOut = stepN(
      hQGame.step({ ...base, idle: DECISION_TIMEOUT - 1 }, throwBoth(ROCK, null)),
      LOCK_TICKS,
    );
    expect(timedOut.last?.moves).toEqual([ROCK, FOLD]);
    expect(timedOut.last?.timeout).toEqual([false, true]);
    expect(timedOut.last?.delta).toEqual([8, -8]);
  });

  it('11. 打完 10 回合：籌碼多的贏；結束之後 step 原樣回傳；winner 在結束前是 null', () => {
    let s = choosing({ round: ROUNDS - 1, stake: 8, chips: [CHIPS + 3, CHIPS - 3] });
    expect(hQGame.winner(s)).toBeNull();
    s = playRound(s, SCISSORS, ROCK);
    expect(s.over).toBe(true);
    expect(hQGame.isOver(s)).toBe(true);
    expect(s.chips).toEqual([CHIPS + 3 - 8, CHIPS - 3 + 8]);
    expect(hQGame.winner(s)).toBe(1);
    expect(hQGame.score(s)).toEqual([CHIPS - 5, CHIPS + 5]);
    expect(hQGame.step(s, throwBoth(ROCK, ROCK))).toBe(s);
  });

  it('12.（邊界）最後一回合打完籌碼剛好一樣：平手（winner 是 null）', () => {
    const s = playRound(
      choosing({ round: ROUNDS - 1, stake: 8, chips: [CHIPS - 8, CHIPS + 8] }),
      PAPER,
      ROCK,
    );
    expect(s.chips).toEqual([CHIPS, CHIPS]);
    expect(s.over).toBe(true);
    expect(hQGame.winner(s)).toBeNull();
  });

  it('13.（邊界）時間到（第 maxTicks 個 tick）：已經開牌的回合先入帳；還在 choose 或 locked 的回合不算', () => {
    // 開牌階段，時間到：這回合要算。
    const opening = toResult(
      choosing({ stake: 8, round: 4, maxTicks: 100, tick: 0 }),
      ROCK,
      SCISSORS,
    );
    const cutResult = hQGame.step({ ...opening, tick: 99 }, idle());
    expect(cutResult.over).toBe(true);
    expect(cutResult.chips).toEqual([CHIPS + 8, CHIPS - 8]);
    expect(cutResult.history).toEqual([[ROCK, SCISSORS]]);
    expect(hQGame.winner(cutResult)).toBe(0);
    // choose 階段（有人已經出手），時間到：不算。
    const chooseCut = hQGame.step(
      { ...choosing({ stake: 8, round: 4, pending: [ROCK, null] }), maxTicks: 100, tick: 99 },
      throwBoth(null, SCISSORS),
    );
    expect(chooseCut.over).toBe(true);
    expect(chooseCut.chips).toEqual([CHIPS, CHIPS]);
    expect(hQGame.winner(chooseCut)).toBeNull();
    // 最後一回合的入帳剛好在 maxTicks 那個 tick：只入帳一次。
    const last = toResult(choosing({ round: ROUNDS - 1, stake: 8, maxTicks: 100 }), ROCK, SCISSORS);
    const both = hQGame.step({ ...last, tick: 99, wait: 1 }, idle());
    expect(both.over).toBe(true);
    expect(both.chips).toEqual([CHIPS + 8, CHIPS - 8]);
    expect(both.history).toHaveLength(1);
  });

  it('14. maxTicks 的算式：沒有人按任何鍵，一回合 45 + 300 + 2 + 30 = 377 tick；10 回合 3770，比 3600 多，所以時間上限是必要的', () => {
    const perRound = AI_WAIT_TICKS + DECISION_TIMEOUT + LOCK_TICKS + RESULT_TICKS;
    expect(perRound).toBe(377);
    // maxTicks 夠大：自然結束在 ROUNDS × 377。
    let s = hQGame.init(0, { maxTicks: 10_000, params: {} });
    let ticks = 0;
    while (!hQGame.isOver(s)) {
      s = hQGame.step(s, idle());
      ticks += 1;
    }
    expect(ticks).toBe(ROUNDS * perRound);
    expect(s.history).toHaveLength(ROUNDS);
    expect(s.history.every((pair) => pair[0] === FOLD && pair[1] === FOLD)).toBe(true);
    // 預設 maxTicks 3600：到第 3600 個 tick 結束，用 playMatch 跑也不會丟錯。
    const idleController: Controller<HQState> = { decide: () => IDLE };
    const result = playMatch(hQGame, 0, CONFIG, idleController, idleController);
    expect(result.ticks).toBe(CONFIG.maxTicks);
    expect(ROUNDS * perRound).toBeGreaterThan(CONFIG.maxTicks);
  });

  it('15. 歷史存在 state 裡：大小有上限（最多 ROUNDS 筆，每筆兩個整數），整場 JSON 來回不變', () => {
    const a = levelController(hQGame, pathfinder, 5, 3);
    const b = levelController(hQGame, pathfinder, 5, 4);
    let s = hQGame.init(9, CONFIG);
    let biggest = 0;
    for (let tick = 0; !hQGame.isOver(s); tick += 1) {
      s = hQGame.step(s, [a.decide(s, 0, tick), b.decide(s, 1, tick)]);
      biggest = Math.max(biggest, s.history.length);
      expect(s.history.length).toBeLessThanOrEqual(ROUNDS);
    }
    expect(s.history).toHaveLength(ROUNDS);
    expect(biggest).toBe(ROUNDS);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(JSON.stringify(s.history).length).toBeLessThan(200);
  });

  it('16. step 不改動傳進來的 state 與輸入（深度凍結也不丟錯），各階段都一樣', () => {
    const states: HQState[] = [
      makeState(),
      choosing({ pending: [ROCK, null] }),
      stepN(choosing(), 0, idle()),
      hQGame.step(choosing(), throwBoth(ROCK, PAPER)),
      toResult(choosing(), ROCK, PAPER),
      choosing({ round: ROUNDS - 1, stake: 8, history: historyOf([[ROCK, PAPER]]) }),
    ];
    for (const state of states) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(state)) as HQState);
      const before = JSON.stringify(frozen);
      const inputs = deepFreeze<Inputs>([{ ...MOVE_BUTTONS[ROCK] }, { ...MOVE_BUTTONS[PAPER] }]);
      expect(() => hQGame.step(frozen, inputs)).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(before);
    }
  });

  it('17. 隨機事件：每回合的 salt 與 rng 都有推進並寫回 state；同一個種子重跑一樣，不同種子的序列不全相同（K13 抓不到沒寫回）', () => {
    const saltsOf = (seed: number): { salts: number[]; rngs: number[] } => {
      let s = hQGame.init(seed, { maxTicks: 10_000, params: {} });
      const salts: number[] = [s.salt];
      const rngs: number[] = [s.rng];
      let round = s.round;
      while (!hQGame.isOver(s)) {
        s = hQGame.step(s, idle());
        if (s.round !== round && !s.over) {
          round = s.round;
          salts.push(s.salt);
          rngs.push(s.rng);
        }
      }
      return { salts, rngs };
    };
    const one = saltsOf(1);
    expect(one.salts).toHaveLength(ROUNDS);
    // 一個種子裡，各回合的 salt 不可以全部相同（忘記把新的 rng 寫回 state 就會全部相同）。
    expect(new Set(one.salts).size).toBeGreaterThan(1);
    expect(new Set(one.rngs).size).toBe(one.rngs.length);
    // 同一個種子重跑一樣。
    expect(saltsOf(1)).toEqual(one);
    // 不同種子的序列不全相同。
    const sequences = [1, 2, 3, 4, 5].map((seed) => JSON.stringify(saltsOf(seed).salts));
    expect(new Set(sequences).size).toBeGreaterThan(1);
  });
});

describe('H-Q 加碼｜actions 與 evaluate', () => {
  it('actions：choose 而且還沒出手是 [石頭、布、剪刀、棄牌、加碼石頭、加碼布、加碼剪刀]（沒有全放開，石頭排第一）；其他階段只有 [全放開]', () => {
    const seven = hQGame.actions(choosing(), 1);
    expect(seven).toHaveLength(7);
    // 前四個與加碼之前一模一樣（石頭排第一、棄牌第四），後三個是加碼的拳。
    expect(seven.slice(0, 4).map(moveOf)).toEqual([ROCK, PAPER, SCISSORS, FOLD]);
    expect(seven.slice(4)).toEqual([...RAISE_BUTTONS]);
    expect(hQGame.actions(choosing(), 0)).toEqual(seven);
    // 已經出手、準備、鎖定、開牌、結束：只有全放開。
    const onlyIdle = (state: HQState, side: Side): void => {
      const actions = hQGame.actions(state, side);
      expect(actions).toHaveLength(1);
      expect(sameButtons(actions[0] as Buttons, IDLE)).toBe(true);
    };
    onlyIdle(choosing({ pending: [ROCK, null] }), 0);
    onlyIdle(makeState(), 0);
    onlyIdle(makeState(), 1);
    onlyIdle(hQGame.step(choosing(), throwBoth(ROCK, PAPER)), 1);
    onlyIdle(toResult(choosing(), ROCK, PAPER), 0);
    onlyIdle(playRound(choosing({ round: ROUNDS - 1 }), ROCK, PAPER), 1);
  });

  it('evaluate：每個階段 gain 有限、danger 在 0 到 1；結束的局有勝負加成', () => {
    const history = historyOf([
      [ROCK, PAPER],
      [PAPER, SCISSORS],
    ]);
    const states: HQState[] = [
      makeState({ history }),
      choosing({ history }),
      choosing({ history, pending: [null, PAPER] }),
      hQGame.step(choosing({ history }), throwBoth(ROCK, PAPER)),
      toResult(choosing({ history }), ROCK, PAPER),
      playRound(choosing({ round: ROUNDS - 1, stake: 8, chips: [90, 110] }), ROCK, PAPER),
    ];
    for (const state of states) {
      for (const side of [0, 1] as const) {
        const { gain, danger } = hQGame.evaluate(state, side);
        expect(Number.isFinite(gain)).toBe(true);
        expect(danger).toBeGreaterThanOrEqual(0);
        expect(danger).toBeLessThanOrEqual(1);
      }
    }
    const over = states[5] as HQState;
    expect(over.over).toBe(true);
    expect(hQGame.evaluate(over, 1).gain).toBeGreaterThan(900);
    expect(hQGame.evaluate(over, 0).gain).toBeLessThan(-900);
  });

  it('不偷看（pending 階段）：只有對手的 pending 不同的兩個 state，AI 側的 evaluate 與 actions 完全相同', () => {
    const history = historyOf([
      [ROCK, PAPER],
      [ROCK, SCISSORS],
      [PAPER, ROCK],
    ]);
    const pendings: readonly (readonly [Move | null, Move | null])[] = [
      [null, null],
      [ROCK, null],
      [PAPER, null],
      [SCISSORS, null],
      [FOLD, null],
    ];
    // AI 坐 1 號邊，只有 0 號邊（人）的 pending 不同；
    const chooseStates = pendings.map((pending) =>
      choosing({ history, pending, stake: 4, round: 2 }),
    );
    const lockedStates = ([ROCK, PAPER, SCISSORS, FOLD] as const).map((human) =>
      makeState({
        phase: 'locked',
        wait: LOCK_TICKS,
        pending: [human, ROCK],
        history,
        stake: 4,
        round: 2,
      }),
    );
    for (const group of [chooseStates, lockedStates]) {
      const first = group[0] as HQState;
      for (const other of group) {
        expect(hQGame.evaluate(other, 1)).toEqual(hQGame.evaluate(first, 1));
        expect(hQGame.actions(other, 1)).toEqual(hQGame.actions(first, 1));
      }
    }
    // 反過來也成立：AI 坐 0 號邊，只有 1 號邊的 pending 不同。
    const mirrored = pendings.map((pending) =>
      choosing({ history, pending: [pending[1], pending[0]], stake: 4, round: 2 }),
    );
    for (const other of mirrored) {
      expect(hQGame.evaluate(other, 0)).toEqual(hQGame.evaluate(mirrored[0] as HQState, 0));
      expect(hQGame.actions(other, 0)).toEqual(hQGame.actions(mirrored[0] as HQState, 0));
    }
  });

  it('不偷看（開牌階段）：只有對手的出手與結算結果不同的兩個 result state，evaluate 相同（往前模擬走得到開牌，所以這裡要目盲）', () => {
    const history = historyOf([
      [ROCK, PAPER],
      [ROCK, PAPER],
      [ROCK, PAPER],
    ]);
    const open = (human: Move): HQState =>
      toResult(choosing({ history, stake: 8, round: 3 }), human, PAPER);
    const results = ([ROCK, PAPER, SCISSORS, FOLD] as const).map(open);
    expect(new Set(results.map((s) => JSON.stringify(s.last?.delta))).size).toBeGreaterThan(1);
    for (const other of results) {
      expect(hQGame.evaluate(other, 1)).toEqual(hQGame.evaluate(results[0] as HQState, 1));
    }
  });

  it('不偷看（整個決定）：等級 10 的搜尋型，在只有對手 pending 不同的 choose 局面，按的鍵相同', () => {
    const history = historyOf([
      [ROCK, PAPER],
      [PAPER, ROCK],
      [SCISSORS, SCISSORS],
      [ROCK, PAPER],
    ]);
    for (const depth of [1, 3, 6]) {
      const presses = ([null, ROCK, PAPER, SCISSORS, FOLD] as const).map((human) =>
        decideAtDepth(choosing({ history, pending: [human, null], stake: 8, round: 4 }), 1, depth),
      );
      for (const press of presses) {
        expect(press).toEqual(presses[0]);
      }
    }
  });

  it('會讀對手：對手一直出石頭 → 看得夠深（開牌看得到）的 evaluate 偏好剋它的布；棄牌最差', () => {
    // 人（0 號邊）連出 5 次石頭，AI 出什麼都有。
    const history = historyOf([
      [ROCK, PAPER],
      [ROCK, SCISSORS],
      [ROCK, ROCK],
      [ROCK, PAPER],
      [ROCK, PAPER],
    ]);
    const gainOf = (ai: Move): number =>
      hQGame.evaluate(toResult(choosing({ history, stake: 8, round: 5 }), ROCK, ai), 1).gain;
    const gains = ([ROCK, PAPER, SCISSORS, FOLD] as const).map(gainOf);
    expect(gains[PAPER]).toBeGreaterThan(gains[ROCK] as number);
    expect(gains[PAPER]).toBeGreaterThan(gains[SCISSORS] as number);
    expect(gains[PAPER]).toBeGreaterThan(gains[FOLD] as number);
    expect(gains[FOLD]).toBeLessThan(gains[ROCK] as number);
    // 搜尋型真的選它：等級 10（深度 6）從 choose 局面決定，按的是布。
    const state = choosing({ history, stake: 8, round: 5 });
    expect(moveOf(decideAtDepth(state, 1, 6))).toBe(PAPER);
    expect(moveOf(levelController(hQGame, pathfinder, 10, 5).decide(state, 1, 0))).toBe(PAPER);
    // 同一個局面，AI 坐 0 號邊，人（1 號邊）一直出剪刀 → AI 出石頭。
    const mirrored = historyOf([
      [PAPER, SCISSORS],
      [ROCK, SCISSORS],
      [PAPER, SCISSORS],
      [SCISSORS, SCISSORS],
      [ROCK, SCISSORS],
    ]);
    expect(moveOf(decideAtDepth(choosing({ history: mirrored, stake: 8, round: 5 }), 0, 6))).toBe(
      ROCK,
    );
  });

  it('等級 1 保守、等級 10 剝削：對手照「石、布、剪」輪流出，深度 1 與 2 只會剋對方上一手（習慣），深度 3 以上才讀出下一手', () => {
    // 人輪流出 石、布、剪、石、布、剪、石；AI 一直出布（不讓「追我」「學我」專家碰巧猜中）。
    const cycle: readonly Move[] = [ROCK, PAPER, SCISSORS, ROCK, PAPER, SCISSORS, ROCK];
    const history = historyOf(cycle.map((m) => [m, PAPER] as const));
    const state = choosing({ history, stake: 8, round: 7 });
    // 下一手是布；剋它的是剪刀。對方上一手是石頭；習慣是出布。
    expect(moveOf(decideAtDepth(state, 1, 1))).toBe(PAPER);
    expect(moveOf(decideAtDepth(state, 1, 2))).toBe(PAPER);
    for (const depth of [3, 4, 5, 6]) {
      expect(moveOf(decideAtDepth(state, 1, depth))).toBe(SCISSORS);
    }
    // 等級與深度的對應（SPEC 7.2）：等級 1、2、3 的深度是 1、2、2；等級 4 起是 3 以上。
    expect([1, 2, 3, 4, 5, 10].map((level) => levelParams(level).depth)).toEqual([
      1, 2, 2, 3, 3, 6,
    ]);
  });

  it('騙它：先連出三次石頭餵出規律，AI 照讀，賭注升到 8 時換成剪刀，AI 輸掉整個賭注', () => {
    // AI 前兩次都剋石頭（出布）；第 3 回合（賭注 8）AI 讀到「又是石頭」，出布。
    const history = historyOf([
      [ROCK, SCISSORS],
      [ROCK, PAPER],
      [ROCK, PAPER],
    ]);
    const state = choosing({ history, stake: 8, round: 3 });
    const aiMove = moveOf(decideAtDepth(state, 1, 6));
    expect(aiMove).toBe(PAPER);
    // 玩家知道 AI 會出布，這手出剪刀：贏下 8。
    const after = playRound(state, SCISSORS, aiMove as Move);
    expect(after.chips).toEqual([CHIPS + 8, CHIPS - 8]);
    // 被騙之後 AI 對「石頭」的信心立刻掉下來。
    const before = predictOpponent(history, 1).probs[ROCK] as number;
    const betrayed = predictOpponent(after.history, 1).probs[ROCK] as number;
    expect(betrayed).toBeLessThan(before - 0.2);
  });

  it('沒有歷史（沒有資訊）：深度 1 永遠出石頭（actions 的第一個）；深度 6 的選擇由 salt 決定，不同 salt 不全相同，而且不會棄牌', () => {
    expect(moveOf(decideAtDepth(choosing(), 1, 1))).toBe(ROCK);
    const picks = new Set<Move | null>();
    for (let salt = 0; salt < 40; salt += 1) {
      const pick = moveOf(decideAtDepth(choosing({ salt: salt * 7919 + 3 }), 1, 6));
      expect(pick).not.toBe(FOLD);
      expect(pick).not.toBeNull();
      picks.add(pick);
    }
    expect(picks.size).toBe(3);
  });

  it('沒有人類模型的規律也能玩：人類模型（深度 1）剋對方上一手，等級 10 讀得出來', () => {
    // 人類模型坐 0 號邊，上一手 AI 出布 → 它這手出剪刀（贏布）。
    const history = historyOf([
      [ROCK, PAPER],
      [SCISSORS, ROCK],
      [PAPER, SCISSORS],
      [ROCK, PAPER],
      [SCISSORS, ROCK],
      [PAPER, SCISSORS],
    ]);
    // 人類模型的每一手都是「贏 AI 上一手」：第 0 回合 AI 出什麼不知道，從第 1 回合起成立。
    const state = choosing({ history, stake: 8, round: 6 });
    const human = decideAtDepth(state, 0, 1);
    expect(moveOf(human)).toBe(ROCK); // AI 上一手是剪刀，贏剪刀的是石頭。
    // 等級 10 的 AI（1 號邊）讀出它會出石頭，所以出布。
    expect(moveOf(decideAtDepth(state, 1, 6))).toBe(PAPER);
  });
});

describe('H-Q 加碼｜對手建模 predictOpponent', () => {
  const sum = (probs: readonly number[]): number => probs.reduce((total, p) => total + p, 0);

  it('沒有歷史：三種拳各 1/3、棄牌 0；機率加起來是 1', () => {
    const p = predictOpponent([], 1);
    expect(p.probs[ROCK]).toBeCloseTo(1 / 3, 10);
    expect(p.probs[PAPER]).toBeCloseTo(1 / 3, 10);
    expect(p.probs[SCISSORS]).toBeCloseTo(1 / 3, 10);
    expect(p.probs[FOLD]).toBe(0);
    expect(sum(p.probs)).toBeCloseTo(1, 10);
    expect(p.top).toBeNull();
  });

  it('對手一直出石頭：集中在石頭；從 AI 與人兩個方向看都成立', () => {
    const asAi = predictOpponent(historyOf([0, 1, 2, 3, 4].map(() => [ROCK, PAPER] as const)), 1);
    expect(asAi.top).toBe(ROCK);
    expect(asAi.probs[ROCK]).toBeGreaterThan(0.7);
    expect(sum(asAi.probs)).toBeCloseTo(1, 10);
    const asHuman = predictOpponent(historyOf([0, 1, 2].map(() => [SCISSORS, ROCK] as const)), 0);
    expect(asHuman.top).toBe(ROCK);
  });

  it('被騙：連出石頭之後換一手，AI 對「石頭」的信心立刻掉下來（玩家可以反過來騙 AI）', () => {
    const baited = historyOf([0, 1, 2, 3, 4].map(() => [ROCK, PAPER] as const));
    const before = predictOpponent(baited, 1).probs[ROCK] as number;
    const switched = predictOpponent([...baited, [SCISSORS, PAPER] as const], 1);
    expect(switched.probs[ROCK] as number).toBeLessThan(before - 0.2);
    expect(sum(switched.probs)).toBeCloseTo(1, 10);
  });

  it('輪流出（石、布、剪）：預測下一手是輪下去的那一手', () => {
    const cycle: readonly Move[] = [ROCK, PAPER, SCISSORS, ROCK, PAPER];
    const p = predictOpponent(historyOf(cycle.map((m) => [m, PAPER] as const)), 1);
    expect(p.top).toBe(SCISSORS);
  });

  it('追我：對手每次都剋我上一手 → 預測也讀得出來（人類模型的習慣）', () => {
    // AI（1 號邊）出 石、布、石、剪、布；人（0 號邊）每次出「贏 AI 上一手」的那一手。
    const ai: readonly Move[] = [ROCK, PAPER, ROCK, SCISSORS, PAPER, ROCK];
    const human: Move[] = [ROCK];
    for (let t = 1; t < ai.length; t += 1) {
      const last = ai[t - 1] as Move;
      human.push(((last + 1) % 3) as Move);
    }
    const pairs = ai.map((m, t) => [human[t] as Move, m] as const);
    const prediction = predictOpponent(historyOf(pairs), 1);
    // 下一手：人會出贏 AI 上一手（石頭）的那一手，也就是布。
    expect(prediction.top).toBe(PAPER);
  });

  it('只讀 history：同樣的歷史，同樣的答案；不改動傳進來的陣列', () => {
    const history = deepFreeze(
      historyOf([
        [ROCK, PAPER],
        [PAPER, PAPER],
        [ROCK, SCISSORS],
      ]),
    );
    expect(predictOpponent(history, 1)).toEqual(predictOpponent(history, 1));
  });
});

describe('H-Q 加碼｜AI 能不能玩', () => {
  it('兩個等級 5 的搜尋型打完一整場：10 回合都打完，在 maxTicks 之前結束', () => {
    for (let seed = 0; seed < 4; seed += 1) {
      const a = levelController(hQGame, pathfinder, 5, seed);
      const b = levelController(hQGame, pathfinder, 5, seed + 1_000_003);
      const result = playMatch(hQGame, seed, CONFIG, a, b);
      expect(result.ticks).toBeLessThan(CONFIG.maxTicks);
      expect(result.score[0] + result.score[1]).toBe(2 * CHIPS);
    }
  });

  it('等級 10 的 AI 對人類模型：20 個種子裡贏多數（剝削）；等級 1 對人類模型不是這樣（不讀）', () => {
    const rate = (level: number): number => {
      let points = 0;
      for (let seed = 0; seed < 20; seed += 1) {
        const aiSide: Side = seed % 2 === 0 ? 1 : 0;
        const ai = levelController(hQGame, pathfinder, level, seed);
        const human = humanModel(hQGame, seed + 1_000_003);
        const result =
          aiSide === 1
            ? playMatch(hQGame, seed, CONFIG, human, ai)
            : playMatch(hQGame, seed, CONFIG, ai, human);
        points += result.winner === null ? 0.5 : result.winner === aiSide ? 1 : 0;
      }
      return points / 20;
    };
    const strong = rate(10);
    const weak = rate(1);
    expect(strong).toBeGreaterThanOrEqual(0.7);
    expect(strong - weak).toBeGreaterThanOrEqual(0.2);
  });

  it('隨機控制器（亂按）也能把一場打完：不會卡住', () => {
    const a = levelController(hQGame, random, 10, 1);
    const b = levelController(hQGame, random, 10, 2);
    const result = playMatch(hQGame, 1, CONFIG, a, b);
    expect(result.ticks).toBeLessThanOrEqual(CONFIG.maxTicks);
  });
});

describe('H-Q 加碼｜第二層規則：加碼、回應、結算', () => {
  it('R1. 按鍵：a 加上一拳是加碼的拳；a 單獨沒有作用；b 勝過 a 與拳（棄牌不算加碼）；出手之後加碼與拳都不能改', () => {
    expect(RAISE_BUTTONS).toHaveLength(3);
    expect(RAISE_BUTTONS[ROCK]).toEqual({ ...IDLE, a: true, left: true });
    expect(RAISE_BUTTONS[PAPER]).toEqual({ ...IDLE, a: true, up: true });
    expect(RAISE_BUTTONS[SCISSORS]).toEqual({ ...IDLE, a: true, right: true });
    expect(CALL_BUTTONS).toEqual({ ...IDLE, a: true });

    const commit = (buttons: Partial<Buttons>): HQState =>
      hQGame.step(choosing(), [{ ...IDLE, ...buttons }, IDLE]);
    for (const move of [ROCK, PAPER, SCISSORS] as const) {
      const raised = hQGame.step(choosing(), [press(move, true), IDLE]);
      expect(raised.pending[0]).toBe(move);
      expect(raised.raised).toEqual([true, false]);
      const plain = hQGame.step(choosing(), [press(move), IDLE]);
      expect(plain.pending[0]).toBe(move);
      expect(plain.raised).toEqual([false, false]);
    }
    // a 單獨：沒有出手，也沒有加碼。
    expect(commit({ a: true }).pending[0]).toBeNull();
    expect(commit({ a: true }).raised).toEqual([false, false]);
    // b 勝過 a 與拳：棄牌，而且不算加碼。
    const folded = commit({ a: true, b: true, left: true });
    expect(folded.pending[0]).toBe(FOLD);
    expect(folded.raised).toEqual([false, false]);
    // 出手之後不能改：不能把沒加碼的拳補成加碼，也不能撤掉加碼。
    const plain = hQGame.step(choosing(), [press(ROCK), IDLE]);
    expect(hQGame.step(plain, [press(ROCK, true), IDLE]).raised).toEqual([false, false]);
    const raised = hQGame.step(choosing(), [press(ROCK, true), IDLE]);
    const later = hQGame.step(raised, [press(PAPER), IDLE]);
    expect(later.raised).toEqual([true, false]);
    expect(later.pending[0]).toBe(ROCK);
    // 兩邊同時、一邊加碼：各記各的。
    const both = hQGame.step(choosing(), [press(PAPER, true), press(SCISSORS)]);
    expect(both.raised).toEqual([true, false]);
    expect(both.phase).toBe('locked');
  });

  it('R2. 加碼費是賭注的一半（進位），付給對方：1、1、2、4', () => {
    expect([1, 2, 4, 8].map(raiseFee)).toEqual([1, 1, 2, 4]);
  });

  it('R3. 結算：一邊加碼，贏輸都是 2 倍賭注；加碼費付給對方（贏、輸、平手都付）；兩邊加碼是 3 倍而費用互相抵銷；總籌碼不變', () => {
    const base = choosing({ stake: 8, round: 4 });
    const chips = (b0: Buttons, b1: Buttons, response: 'call' | 'fold' = 'call'): number[] => [
      ...playFull(base, b0, b1, response).chips,
    ];
    // 人加碼、AI 跟（沒加碼）：贏 16 再付 4 的加碼費；輸付 16 再付 4；平手只有加碼費。
    expect(chips(press(PAPER, true), press(ROCK))).toEqual([CHIPS + 12, CHIPS - 12]);
    expect(chips(press(ROCK, true), press(PAPER))).toEqual([CHIPS - 20, CHIPS + 20]);
    expect(chips(press(PAPER, true), press(PAPER))).toEqual([CHIPS - 4, CHIPS + 4]);
    // AI 加碼、人跟：鏡像（人收到加碼費）。
    expect(chips(press(ROCK), press(PAPER, true))).toEqual([CHIPS - 12, CHIPS + 12]);
    expect(chips(press(PAPER), press(PAPER, true))).toEqual([CHIPS + 4, CHIPS - 4]);
    // 回應期棄牌：棄牌的人付 respondFoldCost（賭注 8 是 6），仍然收到加碼費 4。
    expect(chips(press(ROCK, true), press(SCISSORS), 'fold')).toEqual([CHIPS + 2, CHIPS - 2]);
    expect(chips(press(SCISSORS), press(ROCK, true), 'fold')).toEqual([CHIPS - 2, CHIPS + 2]);
    // 兩邊加碼：3 倍賭注，費用抵銷。
    expect(chips(press(PAPER, true), press(ROCK, true))).toEqual([CHIPS + 24, CHIPS - 24]);
    expect(chips(press(PAPER, true), press(PAPER, true))).toEqual([CHIPS, CHIPS]);
    // 加碼的同時對方棄牌（出手時就棄牌：沒看到加碼，付一整個賭注 8，沒有回應期），加碼的人付加碼費 4。
    expect(chips(press(ROCK, true), press(FOLD))).toEqual([CHIPS + 4, CHIPS - 4]);
    expect(chips(press(FOLD), press(ROCK, true))).toEqual([CHIPS - 4, CHIPS + 4]);
    // 賭注小的時候：賭注 1 加碼贏 2、付費 1 → 淨贏 1。
    const cheap = playFull(choosing({ stake: 1 }), press(PAPER, true), press(ROCK));
    expect(cheap.chips).toEqual([CHIPS + 1, CHIPS - 1]);
    // 總籌碼不變。
    for (const [b0, b1] of [
      [press(PAPER, true), press(ROCK)],
      [press(FOLD), press(SCISSORS, true)],
      [press(ROCK, true), press(ROCK, true)],
    ] as const) {
      const after = chips(b0, b1);
      expect((after[0] as number) + (after[1] as number)).toBe(2 * CHIPS);
    }
  });

  it('R4. 回應期：一邊加碼、另一邊出拳 → 鎖定之後不開牌，進 respond；其他組合（都沒加碼、都加碼、一邊棄牌）直接開牌', () => {
    const base = choosing({ stake: 8, round: 4 });
    const respond = lockAndSettle(base, press(PAPER, true), press(ROCK));
    expect(respond.phase).toBe('respond');
    expect(respond.wait).toBe(RESPOND_PREP);
    expect(respond.revealed).toBe(false);
    expect(respond.last).toBeNull();
    expect(respond.pending).toEqual([PAPER, ROCK]);
    expect(respond.raised).toEqual([true, false]);
    expect(respond.chips).toEqual([CHIPS, CHIPS]);
    // 鏡像：AI 加碼。
    expect(lockAndSettle(base, press(ROCK), press(PAPER, true)).phase).toBe('respond');
    for (const [b0, b1] of [
      [press(PAPER), press(ROCK)],
      [press(PAPER, true), press(ROCK, true)],
      [press(PAPER, true), press(FOLD)],
      [press(FOLD), press(ROCK, true)],
      [press(FOLD), press(FOLD)],
    ] as const) {
      const direct = lockAndSettle(base, b0, b1);
      expect(direct.phase).toBe('result');
      expect(direct.last).not.toBeNull();
    }
  });

  it('R5. 回應期的前 30 個 tick 兩邊的輸入都被忽略（邊界：第 30 個 tick 按無效，第 31 個才算）；之後只有沒加碼的那一邊能回應', () => {
    const base = choosing({ stake: 8, round: 4 });
    let s = lockAndSettle(base, press(PAPER, true), press(ROCK));
    // 人是加碼的那一邊，AI（1 號邊）是回應的那一邊。
    s = stepN(s, RESPOND_PREP - 1, [MOVE_BUTTONS[FOLD], MOVE_BUTTONS[FOLD]]);
    expect(s.phase).toBe('respond');
    expect(s.revealed).toBe(false);
    s = hQGame.step(s, [MOVE_BUTTONS[FOLD], MOVE_BUTTONS[FOLD]]);
    expect(s.phase).toBe('respond');
    expect(s.wait).toBe(0);
    expect(s.revealed).toBe(true);
    expect(s.pending).toEqual([PAPER, ROCK]);
    // 加碼的那一邊按什麼都沒有用。
    const ignored = hQGame.step(s, [MOVE_BUTTONS[FOLD], IDLE]);
    expect(ignored.phase).toBe('respond');
    expect(ignored.pending).toEqual([PAPER, ROCK]);
    // 回應的那一邊：a 是跟，b 是棄牌，b 勝過 a。
    const called = hQGame.step(s, [IDLE, CALL_BUTTONS]);
    expect(called.phase).toBe('result');
    expect(called.last?.moves).toEqual([PAPER, ROCK]);
    expect(called.last?.delta).toEqual([12, -12]);
    const folded = hQGame.step(s, [IDLE, MOVE_BUTTONS[FOLD]]);
    expect(folded.last?.moves).toEqual([PAPER, FOLD]);
    expect(folded.last?.delta).toEqual([2, -2]);
    expect(hQGame.step(s, [IDLE, { ...IDLE, a: true, b: true }]).last?.moves).toEqual([
      PAPER,
      FOLD,
    ]);
    // 回應的那一邊按了拳：沒有作用（出手不能改）。
    expect(hQGame.step(s, [IDLE, MOVE_BUTTONS[SCISSORS]]).phase).toBe('respond');
    // 開牌之後照常停 30 個 tick 才入帳；歷史與加碼紀錄各加一筆。
    const banked = stepN(called, RESULT_TICKS);
    expect(banked.chips).toEqual([CHIPS + 12, CHIPS - 12]);
    expect(banked.history).toEqual([[PAPER, ROCK]]);
    expect(banked.raises).toEqual([[true, false]]);
    expect(banked.phase).toBe('prep');
    expect(banked.raised).toEqual([false, false]);
    expect(banked.revealed).toBe(false);
  });

  it('R6.（邊界）回應期超時：第 300 個 tick 還沒回應就自動棄牌（保守的那個），記成超時；第 300 個 tick 按了 a 算跟，不算超時', () => {
    const base = choosing({ stake: 8, round: 4 });
    const open = openRespond(base, press(PAPER, true), press(ROCK));
    expect(open.phase).toBe('respond');
    const late = hQGame.step({ ...open, idle: DECISION_TIMEOUT - 1 }, idle());
    expect(late.phase).toBe('result');
    expect(late.last?.moves).toEqual([PAPER, FOLD]);
    expect(late.last?.timeout).toEqual([false, true]);
    expect(late.last?.delta).toEqual([2, -2]);
    const edge = hQGame.step({ ...open, idle: DECISION_TIMEOUT - 1 }, [IDLE, CALL_BUTTONS]);
    expect(edge.last?.moves).toEqual([PAPER, ROCK]);
    expect(edge.last?.timeout).toEqual([false, false]);
    const waiting = hQGame.step({ ...open, idle: DECISION_TIMEOUT - 2 }, idle());
    expect(waiting.phase).toBe('respond');
  });

  it('R7. 時間到（maxTicks）時還在回應期：這一回合不算（和 choose、locked 一樣）', () => {
    const open = openRespond(
      choosing({ stake: 8, round: 4, maxTicks: 1000 }),
      press(PAPER, true),
      press(ROCK),
    );
    const cut = hQGame.step({ ...open, tick: 999 }, idle());
    expect(cut.over).toBe(true);
    expect(cut.chips).toEqual([CHIPS, CHIPS]);
    expect(cut.history).toEqual([]);
    expect(hQGame.winner(cut)).toBeNull();
  });

  it('R8. actions：回應期的前 30 個 tick 兩邊只有 [全放開]；之後回應的那一邊是 [跟、棄牌]，加碼的那一邊是 [全放開]', () => {
    const base = choosing({ stake: 8, round: 4 });
    const closed = lockAndSettle(base, press(PAPER, true), press(ROCK));
    for (const side of [0, 1] as const) {
      expect(hQGame.actions(closed, side)).toEqual([IDLE]);
    }
    const open = openRespond(base, press(PAPER, true), press(ROCK));
    expect(hQGame.actions(open, 1).map(respondOf)).toEqual(['call', 'fold']);
    expect(hQGame.actions(open, 0)).toEqual([IDLE]);
    // 鏡像：AI 加碼、人回應。
    const mirrored = openRespond(base, press(ROCK), press(PAPER, true));
    expect(hQGame.actions(mirrored, 0).map(respondOf)).toEqual(['call', 'fold']);
    expect(hQGame.actions(mirrored, 1)).toEqual([IDLE]);
  });

  it('R9. step 不改動傳進來的 state 與輸入：回應期的各個階段也一樣；加碼紀錄存在 state 裡，JSON 來回不變，大小有上限', () => {
    const base = choosing({ stake: 8, round: 4 });
    const states: HQState[] = [
      hQGame.step(base, [press(PAPER, true), IDLE]),
      lockAndSettle(base, press(PAPER, true), press(ROCK)),
      openRespond(base, press(PAPER, true), press(ROCK)),
    ];
    for (const state of states) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(state)) as HQState);
      const before = JSON.stringify(frozen);
      const inputs = deepFreeze<Inputs>([{ ...CALL_BUTTONS }, { ...MOVE_BUTTONS[FOLD] }]);
      expect(() => hQGame.step(frozen, inputs)).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(before);
    }
    const a = levelController(hQGame, pathfinder, 8, 3);
    const b = levelController(hQGame, random, 5, 4);
    let s = hQGame.init(11, CONFIG);
    for (let tick = 0; !hQGame.isOver(s); tick += 1) {
      s = hQGame.step(s, [a.decide(s, 0, tick), b.decide(s, 1, tick)]);
      expect(s.raises.length).toBeLessThanOrEqual(ROUNDS);
      expect(s.raises.length).toBe(s.history.length);
    }
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('H-Q 加碼｜第二層：AI 什麼時候加碼', () => {
  /** AI（1 號邊）出 `move`（可以加碼），人出石頭；走到「還看不到對手出什麼」的終點，回傳 AI 的 gain。 */
  const gainOf = (state: HQState, move: 0 | 1 | 2, raised: boolean): number =>
    hQGame.evaluate(lockAndSettle(state, press(ROCK), press(move, raised)), 1).gain;

  it('P1. 命中率：規律的歷史 AI 一直讀對，命中率高；亂出的歷史只有三分之一左右；沒有歷史是三分之一', () => {
    expect(readAccuracy([], 1)).toBeCloseTo(1 / 3, 10);
    expect(readAccuracy(STEADY, 1)).toBeGreaterThan(0.6);
    expect(readAccuracy(MESSY, 1)).toBeLessThan(0.4);
    // 只讀 history，不改動傳進來的陣列。
    const frozen = deepFreeze(historyOf(STEADY));
    expect(readAccuracy(frozen, 1)).toBe(readAccuracy(STEADY, 1));
  });

  it('P2. AI 只在有把握時加碼：歷史有明顯規律 → evaluate 偏好加碼；歷史是亂的 → 每一手加碼都比不加碼差；淺搜尋（等級 1 到 3）看不到，不加碼', () => {
    const steady = choosing({ history: STEADY, stake: 8, round: 7 });
    const messy = choosing({ history: MESSY, stake: 8, round: 6 });
    // 前提：兩個局面的預測確實一個集中、一個平。
    expect(predictOpponent(STEADY, 1).probs[ROCK]).toBeGreaterThan(0.8);
    // 有規律：剋它的布，加碼比不加碼好，而且好得明顯（至少 1 個籌碼，遠大於習慣與隨機的小加分）。
    expect(gainOf(steady, PAPER, true)).toBeGreaterThan(gainOf(steady, PAPER, false) + 1);
    // 亂的：每一手加碼都比不加碼差（差不多一個加碼費）。
    for (const move of [ROCK, PAPER, SCISSORS] as const) {
      expect(gainOf(messy, move, true)).toBeLessThan(gainOf(messy, move, false) - 1);
    }
    // 實際按的鍵：等級 10（深度 6）。
    expect(decode(decideAtDepth(steady, 1, 6))).toEqual({ move: PAPER, raised: true });
    for (let salt = 0; salt < 40; salt += 1) {
      const pick = decode(decideAtDepth({ ...messy, salt: salt * 7919 + 3 }, 1, 6));
      expect(pick?.raised).toBe(false);
    }
    // 深度 1、2 看不到開牌，所有出手的 evaluate 都只差習慣：不加碼。
    for (const depth of [1, 2]) {
      expect(decode(decideAtDepth(steady, 1, depth))?.raised).toBe(false);
    }
    // 沒有歷史：不加碼。
    for (let salt = 0; salt < 20; salt += 1) {
      expect(decode(decideAtDepth(choosing({ salt: salt * 31 + 5, stake: 8 }), 1, 6))?.raised).toBe(
        false,
      );
    }
  });

  it('P3. 賭注小的時候不加碼：同樣一眼就讀出來的規律，賭注 1 時加碼費（1）比多賺的還多', () => {
    const cheap = choosing({ history: STEADY, stake: 1, round: 0 });
    expect(decode(decideAtDepth(cheap, 1, 6))?.raised).toBe(false);
    const dear = choosing({ history: STEADY, stake: 8, round: 7 });
    expect(decode(decideAtDepth(dear, 1, 6))?.raised).toBe(true);
  });

  it('P4. 被加碼的時候 AI 照 evaluate 回應：自己出的拳會被預測剋住 → 棄牌；不會被剋 → 跟', () => {
    const base = choosing({ history: STEADY, stake: 8, round: 7 });
    // 人（0 號邊）加碼出石頭；AI 事先出的是 `ai`。AI 預測人一直出石頭。
    const reply = (ai: Move, depth: number): 'call' | 'fold' | 'none' =>
      respondOf(decideAtDepth(openRespond(base, press(ROCK, true), press(ai)), 1, depth));
    for (const depth of [1, 3, 6]) {
      expect(reply(SCISSORS, depth)).toBe('fold');
      expect(reply(PAPER, depth)).toBe('call');
      expect(reply(ROCK, depth)).toBe('call');
    }
  });
});

describe('H-Q 加碼｜第二層：跟、棄牌、換手各有對的時候', () => {
  /** 人（0 號邊）出 `commit`，AI（1 號邊，等級 10）照它自己的 decide 打，回應期人照 `response` 回應。回傳人這回合的籌碼變化。 */
  function humanDelta(
    state: HQState,
    commit: Buttons,
    response: 'call' | 'fold',
  ): { delta: number; ai: { move: Move; raised: boolean } | null } {
    let s = state;
    for (let guard = 0; guard < 2000 && !(s.phase === 'result' && s.last !== null); guard += 1) {
      const humanIsResponder = s.phase === 'respond' && s.wait === 0 && s.raised[1] && !s.raised[0];
      const mine: Buttons =
        s.phase === 'choose' && s.pending[0] === null
          ? commit
          : humanIsResponder
            ? response === 'call'
              ? CALL_BUTTONS
              : MOVE_BUTTONS[FOLD]
            : IDLE;
      s = hQGame.step(s, [mine, decideAtDepth(s, 1, 6)]);
    }
    expect(s.last).not.toBeNull();
    const aiMove = s.pending[1];
    return {
      delta: (s.last as NonNullable<HQState['last']>).delta[0],
      ai: aiMove === null ? null : { move: aiMove, raised: s.raised[1] },
    };
  }

  // 局面一：人一直出石頭（7 次），AI 讀得很準，這回合賭注 8。AI 加碼出布（見 P2）。
  const locked = choosing({ history: STEADY, stake: 8, round: 7 });
  // 局面二：人照「石、布、剪」輪流出（7 次，最後一手是石頭）。AI 讀到下一手是布，所以加碼出剪刀。
  const CYCLE = historyOf(
    [ROCK, PAPER, SCISSORS, ROCK, PAPER, SCISSORS, ROCK].map((m) => [m, PAPER] as const),
  );
  const cycling = choosing({ history: CYCLE, stake: 8, round: 7 });

  it('T1. 棄牌的時候：我出的正是它讀到的那一手 → 它加碼了，跟會輸 2 倍賭注（-12，已經收了加碼費 4），回應期棄牌只付 respondFoldCost（-2）→ 棄牌最好；一出手就棄牌（沒看到加碼）更貴（-4）', () => {
    const call = humanDelta(locked, press(ROCK), 'call');
    const fold = humanDelta(locked, press(ROCK), 'fold');
    expect(call.ai).toEqual({ move: PAPER, raised: true });
    expect(call.delta).toBe(-12);
    expect(fold.delta).toBe(-2);
    expect(fold.delta).toBeGreaterThan(call.delta);
    expect(humanDelta(locked, press(FOLD), 'call').delta).toBe(-4);
    // 自己也加碼更慘：3 倍賭注（費用互相抵銷）。
    expect(humanDelta(locked, press(ROCK, true), 'call').delta).toBe(-24);
  });

  it('T2. 跟的時候：我出的拳贏它的拳（它讀錯了／被我騙）→ 它加碼了，跟贏 2 倍賭注（+20），棄牌只是 -2 → 跟最好；兩個局面都成立', () => {
    // 局面一：我換成剪刀（騙它）。
    const trick = humanDelta(locked, press(SCISSORS), 'call');
    expect(trick.ai).toEqual({ move: PAPER, raised: true });
    expect(trick.delta).toBe(20);
    expect(humanDelta(locked, press(SCISSORS), 'fold').delta).toBe(-2);
    // 局面二：輪流出的人這回合不照輪，又出石頭；AI 照輪流讀、出剪刀，石頭贏剪刀。
    const repeat = humanDelta(cycling, press(ROCK), 'call');
    expect(repeat.ai).toEqual({ move: SCISSORS, raised: true });
    expect(repeat.delta).toBe(20);
    expect(humanDelta(cycling, press(ROCK), 'fold').delta).toBe(-2);
  });

  it('T3. 換手的時候：被讀的規律鎖死（局面一）→ 繼續出同一手，最好也只能棄牌（-2）；換一手打破規律並跟，贏 20 → 換手最好', () => {
    const best = (state: HQState, move: Move): number =>
      Math.max(
        humanDelta(state, press(move), 'call').delta,
        humanDelta(state, press(move), 'fold').delta,
      );
    expect(best(locked, ROCK)).toBe(-2);
    expect(best(locked, SCISSORS)).toBe(20);
    expect(best(locked, SCISSORS)).toBeGreaterThan(best(locked, ROCK));
    // 換到另一個錯的拳（出布：和它的布平手）也比留在石頭好，但不如剪刀。
    expect(best(locked, PAPER)).toBe(4);
  });

  it('T4. 沒有一個選項永遠最好：局面二裡「跟（沿用上一手的石頭）」是最好的、換手反而輸，局面一裡剛好相反；棄牌在 T1 最好、T2 最差', () => {
    const best = (state: HQState, move: Move): number =>
      Math.max(
        humanDelta(state, press(move), 'call').delta,
        humanDelta(state, press(move), 'fold').delta,
      );
    // 局面二：沿用上一手（石頭）最好（+20），換成布（-2，只能棄牌）或剪刀（+4）都比較差。
    expect(best(cycling, ROCK)).toBe(20);
    expect(best(cycling, PAPER)).toBe(-2);
    expect(best(cycling, SCISSORS)).toBe(4);
    expect(best(cycling, ROCK)).toBeGreaterThan(
      Math.max(best(cycling, PAPER), best(cycling, SCISSORS)),
    );
    // 局面一：換手最好（T3）。同一個選項（沿用上一手），在兩個局面最好與最差各一次。
    expect(best(locked, ROCK)).toBeLessThan(best(locked, SCISSORS));
  });

  it('T5. AI 沒有把握（亂出的歷史）的時候它不加碼，沒有回應期可言；沒有資訊，三種拳的平均相差遠小於一個賭注', () => {
    const messy = choosing({ history: MESSY, stake: 8, round: 6 });
    let raises = 0;
    const deltas = new Map<number, number>();
    for (let salt = 0; salt < 60; salt += 1) {
      const state = { ...messy, salt: salt * 7919 + 3 };
      for (const move of [ROCK, PAPER, SCISSORS] as const) {
        const result = humanDelta(state, press(move), 'call');
        raises += result.ai?.raised ? 1 : 0;
        deltas.set(move, (deltas.get(move) ?? 0) + result.delta);
      }
    }
    expect(raises).toBe(0);
    const values = [...deltas.values()].map((total) => total / 60);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(8);
  });
});

describe('H-Q 加碼｜第二層：不偷看（含加碼）', () => {
  const history = historyOf([
    [ROCK, PAPER],
    [ROCK, SCISSORS],
    [PAPER, ROCK],
    [ROCK, PAPER],
  ]);
  /** 對手可能的 pending（出手、有沒有加碼）。 */
  const variants: readonly (readonly [Move | null, boolean])[] = [
    [null, false],
    [ROCK, false],
    [ROCK, true],
    [PAPER, false],
    [PAPER, true],
    [SCISSORS, false],
    [SCISSORS, true],
    [FOLD, false],
  ];

  it('N1. choose 階段：只有對手的 pending（出手與加碼與否）不同的兩個 state，evaluate 與 actions 完全相同；兩邊都成立', () => {
    for (const aiSide of [0, 1] as const) {
      const states = variants.map(([move, raised]) => {
        const pending: [Move | null, Move | null] = aiSide === 1 ? [move, null] : [null, move];
        const flags: [boolean, boolean] = aiSide === 1 ? [raised, false] : [false, raised];
        return choosing({ history, pending, raised: flags, stake: 8, round: 4 });
      });
      for (const other of states) {
        expect(hQGame.evaluate(other, aiSide)).toEqual(
          hQGame.evaluate(states[0] as HQState, aiSide),
        );
        expect(hQGame.actions(other, aiSide)).toEqual(hQGame.actions(states[0] as HQState, aiSide));
      }
    }
  });

  it('N2. locked 階段（兩邊都出手了、對手的加碼還沒公開）：對手的出手與加碼不同，AI 側的 evaluate 與 actions 相同', () => {
    const states = variants
      .filter(([move]) => move !== null)
      .map(([move, raised]) =>
        makeState({
          phase: 'locked',
          wait: LOCK_TICKS,
          pending: [move, PAPER],
          raised: [raised, true],
          history,
          stake: 8,
          round: 4,
        }),
      );
    for (const other of states) {
      expect(hQGame.evaluate(other, 1)).toEqual(hQGame.evaluate(states[0] as HQState, 1));
      expect(hQGame.actions(other, 1)).toEqual(hQGame.actions(states[0] as HQState, 1));
    }
  });

  it('N3. 鎖定走完、回應期的準備（對手的加碼還沒公開）與開牌：AI 出的拳一樣、對手的出手與加碼不同，往前模擬走得到的每一種終點 evaluate 都相同', () => {
    const base = choosing({ history, stake: 8, round: 4 });
    for (const ai of [PAPER, ROCK, SCISSORS] as const) {
      for (const aiRaised of [false, true]) {
        const ends = variants
          .filter(([move]) => move !== null)
          .map(([move, raised]) =>
            lockAndSettle(base, press(move as Move, raised), press(ai, aiRaised)),
          );
        // 這些 state 的階段不同（respond、result），但在沒有公開之前 evaluate 一樣。
        expect(new Set(ends.map((s) => s.phase)).size).toBeGreaterThan(1);
        for (const other of ends) {
          expect(hQGame.evaluate(other, 1)).toEqual(hQGame.evaluate(ends[0] as HQState, 1));
        }
      }
    }
  });

  it('N4. 整個決定：深度 1、3、6 的搜尋型，在只有對手 pending（含加碼與否）不同的 choose 局面，實際按的鍵都相同；兩邊都成立；規律集中的局面也成立', () => {
    const histories: readonly (readonly [string, HQState['history']])[] = [
      ['mixed', history],
      ['steady', STEADY],
      ['messy', MESSY],
    ];
    for (const [, hist] of histories) {
      for (const depth of [1, 3, 6]) {
        for (const aiSide of [0, 1] as const) {
          const presses = variants.map(([move, raised]) => {
            const pending: [Move | null, Move | null] = aiSide === 1 ? [move, null] : [null, move];
            const flags: [boolean, boolean] = aiSide === 1 ? [raised, false] : [false, raised];
            return decideAtDepth(
              choosing({ history: hist, pending, raised: flags, stake: 8, round: 7 }),
              aiSide,
              depth,
            );
          });
          for (const one of presses) {
            expect(one).toEqual(presses[0]);
          }
        }
      }
    }
  });

  it('N5. 公開之後才看得到：回應期開了以後，AI 的回應確實依據對手有沒有加碼（沒有加碼的人沒有回應期，所以用「人加碼」與「人沒加碼但 AI 加碼」比較 AI 側的 actions）', () => {
    const base = choosing({ history: STEADY, stake: 8, round: 7 });
    const humanRaised = openRespond(base, press(ROCK, true), press(SCISSORS));
    const aiRaised = openRespond(base, press(ROCK), press(SCISSORS, true));
    expect(hQGame.actions(humanRaised, 1).map(respondOf)).toEqual(['call', 'fold']);
    expect(hQGame.actions(aiRaised, 1)).toEqual([IDLE]);
  });
});
