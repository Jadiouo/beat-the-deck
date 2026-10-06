import { describe, expect, it } from 'vitest';

import { levelController, levelParams, wrapPolicy } from '../../ai/level';
import { humanModel } from '../../ai/human-model';
import { pathfinder } from '../../ai/policies/pathfinder';
import { random } from '../../ai/policies/random';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Inputs, Side } from '../../core/types';
import { AI_WAIT_TICKS, DECISION_TIMEOUT, IDLE } from '../_hearts/logic';
import {
  CHIPS,
  FOLD,
  LOCK_TICKS,
  MOVE_BUTTONS,
  PAPER,
  predictOpponent,
  RESULT_TICKS,
  ROCK,
  ROUNDS,
  SCISSORS,
  foldCost,
  hQGame,
  makeState,
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

/** 這個按鍵是哪一個 Move（沒有對應回傳 null）。 */
function moveOf(buttons: Buttons): Move | null {
  const found = ([ROCK, PAPER, SCISSORS, FOLD] as const).find((m) =>
    sameButtons(MOVE_BUTTONS[m], buttons),
  );
  return found ?? null;
}

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

  it('賭注每回合加倍、上限 8：1、2、4、8、8、8、8、8、8、8；棄牌付四分之三（進位）', () => {
    expect(ROUNDS).toBe(10);
    expect(Array.from({ length: ROUNDS }, (_v, r) => stakeFor(r))).toEqual([
      1, 2, 4, 8, 8, 8, 8, 8, 8, 8,
    ]);
    expect([1, 2, 4, 8].map(foldCost)).toEqual([1, 2, 3, 6]);
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

  it('7. 棄牌：棄牌的人付 foldCost 給對方；對方出什麼都一樣（連對方的輸拳也拿）', () => {
    for (const other of [ROCK, PAPER, SCISSORS] as const) {
      const a = playRound(choosing({ stake: 8, round: 4 }), FOLD, other);
      expect(a.chips).toEqual([CHIPS - 6, CHIPS + 6]);
      const b = playRound(choosing({ stake: 8, round: 4 }), other, FOLD);
      expect(b.chips).toEqual([CHIPS + 6, CHIPS - 6]);
    }
    expect(playRound(choosing({ stake: 1 }), FOLD, ROCK).chips).toEqual([CHIPS - 1, CHIPS + 1]);
    expect(playRound(choosing({ stake: 2, round: 1 }), ROCK, FOLD).chips).toEqual([
      CHIPS + 2,
      CHIPS - 2,
    ]);
    expect(playRound(choosing({ stake: 4, round: 2 }), FOLD, SCISSORS).chips).toEqual([
      CHIPS - 3,
      CHIPS + 3,
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
    expect(timedOut.last?.delta).toEqual([6, -6]);
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
  it('actions：choose 而且還沒出手是 [石頭、布、剪刀、棄牌]（沒有全放開，石頭排第一）；其他階段只有 [全放開]', () => {
    const four = hQGame.actions(choosing(), 1);
    expect(four).toHaveLength(4);
    expect(four.map(moveOf)).toEqual([ROCK, PAPER, SCISSORS, FOLD]);
    expect(hQGame.actions(choosing(), 0).map(moveOf)).toEqual([ROCK, PAPER, SCISSORS, FOLD]);
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
