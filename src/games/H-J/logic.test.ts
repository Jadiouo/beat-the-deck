import { describe, expect, it } from 'vitest';

import { levelController, levelParams, wrapPolicy } from '../../ai/level';
import { humanModel } from '../../ai/human-model';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { random } from '../../ai/policies/random';
import type { Policy } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import { AI_WAIT_TICKS, DECISION_TIMEOUT, IDLE, PRESS_A, PRESS_B } from '../_hearts/logic';
import {
  CHIPS,
  confidenceLevel,
  eqAction,
  eqAggressiveProb,
  expectedHand,
  HANDS,
  hJGame,
  LOCK_TICKS,
  makeState,
  opponentModel,
  oppAggressiveProb,
  RESULT_TICKS,
  WINDOW,
} from './logic';
import type { Act, Card, HJState } from './logic';

/**
 * H-J 三張牌撲克的規則測試（規則見 `docs/cards/H-J.md`）。
 * 牌：0 = J、1 = Q、2 = K。動作：0 = b（過牌／棄牌）、1 = a（下注／跟）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 關鍵的幾組：不偷看（含故意洩漏、含「加同一個常數」那型）、等級曲線（深度 ≤ 2 只有均衡抽籤、深度 ≥ 3 讀對手）、
 * 10.6 的兩個 pending 陷阱。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const J: Card = 0;
const Q: Card = 1;
const K: Card = 2;

function idle(): Inputs {
  return [IDLE, IDLE];
}

function press(side: Side, a: boolean): Inputs {
  const key = a ? PRESS_A : PRESS_B;
  return side === 0 ? [key, IDLE] : [IDLE, key];
}

function stepN(state: HJState, n: number, inputs: Inputs = idle()): HJState {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = hJGame.step(s, inputs);
  }
  return s;
}

function choosing(overrides: Partial<HJState> = {}): HJState {
  return makeState({ phase: 'choose', wait: 0, ...overrides });
}

/** 輪到 `turn` 這邊做決定（choose），acts 是這手已經有的動作。 */
function turnState(
  turn: Side,
  acts: readonly Act[],
  cards: readonly [Card, Card],
  extra = {},
): HJState {
  const first: Side = acts.length % 2 === 0 ? turn : ((1 - turn) as Side);
  return choosing({ first, turn, acts, cards, ...extra });
}

/** 從 choose 開始，`turn` 這邊按一個鍵，走完鎖定與生效（動作落進 acts、換人或進入攤牌）。 */
function act(state: HJState, a: boolean): HJState {
  const locked = hJGame.step(state, press(state.turn, a));
  return stepN(locked, LOCK_TICKS);
}

function sameButtons(x: Buttons, y: Buttons): boolean {
  return (
    x.up === y.up &&
    x.down === y.down &&
    x.left === y.left &&
    x.right === y.right &&
    x.a === y.a &&
    x.b === y.b
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

/** 一筆歷史（公開）：誰先手、動作序列、攤牌亮出的牌（沒攤牌就是 null）。 */
function rec(
  first: Side,
  acts: readonly Act[],
  shown: readonly [Card | null, Card | null] = [null, null],
): HJState['hands'][number] {
  return { first, acts, shown };
}

/** n 手：AI（1 號邊）先手下注，對手（0 號邊）棄牌。 */
function oppFolds(n: number): HJState['hands'] {
  return Array.from({ length: n }, () => rec(1, [1, 0]));
}

/** n 手：AI 先手下注，對手跟，攤牌（對手是 Q、AI 是 J）。 */
function oppCalls(n: number): HJState['hands'] {
  return Array.from({ length: n }, () => rec(1, [1, 1], [Q, J]));
}

/** n 手：對手先手下注，攤牌亮出 K（只拿好牌下注）。 */
function oppValueOnly(n: number): HJState['hands'] {
  return Array.from({ length: n }, () => rec(0, [1, 1], [K, Q]));
}

/** n 手：對手先手下注，攤牌亮出 J（愛詐唬）。 */
function oppBluffs(n: number): HJState['hands'] {
  return Array.from({ length: n }, () => rec(0, [1, 1], [J, Q]));
}

function decideAtDepth(
  state: HJState,
  side: Side,
  depth: number,
  policy: Policy = pathfinder,
): Buttons {
  const controller = wrapPolicy(
    hJGame,
    policy,
    { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
    7,
  );
  return controller.decide(state, side, 0);
}

/** 按的是 a（下注／跟）還是 b（過牌／棄）。 */
function aggressive(buttons: Buttons): boolean {
  return buttons.a;
}

describe('H-J 三張牌撲克｜初始與常數', () => {
  it('第 0 手、人先手、準備階段（還要等 45 tick）、籌碼各 20；兩張暗牌不同、都在 0 到 2；eqDraw 是整數', () => {
    const s = hJGame.init(5, CONFIG);
    expect(s.hand).toBe(0);
    expect(s.first).toBe(0);
    expect(s.turn).toBe(0);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.chips).toEqual([CHIPS, CHIPS]);
    expect(s.acts).toEqual([]);
    expect(s.hands).toEqual([]);
    expect(s.cards[0]).not.toBe(s.cards[1]);
    for (const c of s.cards) {
      expect([0, 1, 2]).toContain(c);
    }
    for (const d of s.eqDraw) {
      expect(Number.isInteger(d) && d >= 0 && d < 10000).toBe(true);
    }
    expect(s.model).toBe(true);
    expect(HANDS).toBe(10);
    expect(CHIPS).toBe(20);
  });

  it('同一個種子發同樣的牌；不同種子（多數）發不一樣的牌', () => {
    expect(hJGame.init(3, CONFIG)).toEqual(hJGame.init(3, CONFIG));
    const deals = new Set<string>();
    for (let seed = 0; seed < 30; seed += 1) {
      const s = hJGame.init(seed, CONFIG);
      deals.add(`${String(s.cards[0])}${String(s.cards[1])}`);
    }
    expect(deals.size).toBe(6);
  });
});

describe('H-J 三張牌撲克｜規則', () => {
  it('1. 準備 45 tick：這段時間輸入被忽略（第 45 個 tick 按無效，第 46 個 tick 才算）', () => {
    let s = makeState();
    s = stepN(s, AI_WAIT_TICKS - 1, press(0, true));
    expect(s.phase).toBe('prep');
    s = hJGame.step(s, press(0, true));
    expect(s.phase).toBe('choose');
    expect(s.pending).toBeNull();
    s = hJGame.step(s, press(0, true));
    expect(s.phase).toBe('locked');
    expect(s.pending).toBe(1);
  });

  it('2. 只有輪到的那一邊的輸入算；另一邊按什麼都被忽略', () => {
    const s = choosing({ turn: 0 });
    const ignored = hJGame.step(s, press(1, true));
    expect(ignored.phase).toBe('choose');
    expect(ignored.pending).toBeNull();
    const taken = hJGame.step(choosing({ turn: 1, first: 1 }), press(1, false));
    expect(taken.phase).toBe('locked');
    expect(taken.pending).toBe(0);
  });

  it('3. 按鍵只寫進 pending，不當場生效：acts 不動、籌碼不動、階段 locked；鎖定 2 tick 後第 3 步才生效', () => {
    const s = choosing({ cards: [K, Q] });
    const locked = hJGame.step(s, press(0, true));
    expect(locked.phase).toBe('locked');
    expect(locked.wait).toBe(LOCK_TICKS);
    expect(locked.acts).toEqual([]);
    expect(locked.chips).toEqual([CHIPS, CHIPS]);
    const second = hJGame.step(locked, idle());
    expect(second.phase).toBe('locked');
    expect(second.acts).toEqual([]);
    const third = hJGame.step(second, idle());
    expect(third.acts).toEqual([1]);
    expect(third.phase).toBe('prep');
    expect(third.turn).toBe(1);
    expect(third.wait).toBe(AI_WAIT_TICKS);
  });

  it('4. 選了就不能改：locked 時再按別的鍵沒有用', () => {
    const locked = hJGame.step(choosing(), press(0, true));
    const after = hJGame.step(locked, press(0, false));
    expect(after.pending).toBe(1);
  });

  it('5. 同時按 a 與 b：b 優先（保守）', () => {
    const both: Buttons = { ...IDLE, a: true, b: true };
    const locked = hJGame.step(choosing(), [both, IDLE]);
    expect(locked.pending).toBe(0);
  });

  it('6. 六種動作序列的結局與淨籌碼（先手 0 號邊）', () => {
    const cases: { acts: Act[]; cards: [Card, Card]; net0: number; shown: boolean }[] = [
      { acts: [1, 0], cards: [J, K], net0: 1, shown: false }, // 先手下注、後手棄：先手贏 1
      { acts: [1, 1], cards: [K, Q], net0: 2, shown: true }, // 下注被跟：K 贏 2
      { acts: [1, 1], cards: [J, Q], net0: -2, shown: true },
      { acts: [0, 0], cards: [Q, J], net0: 1, shown: true }, // 都過牌：大的贏 1
      { acts: [0, 0], cards: [J, K], net0: -1, shown: true },
      { acts: [0, 1, 0], cards: [K, J], net0: -1, shown: false }, // 過牌後被下注、棄：後手贏 1
      { acts: [0, 1, 1], cards: [Q, J], net0: 2, shown: true },
      { acts: [0, 1, 1], cards: [Q, K], net0: -2, shown: true },
    ];
    for (const c of cases) {
      // 從最後一個動作之前的局面出發，按最後一個動作
      const prefix = c.acts.slice(0, -1);
      const turn: Side = c.acts.length % 2 === 1 ? 0 : 1;
      let s = turnState(turn, prefix, c.cards);
      s = act(s, c.acts[c.acts.length - 1] === 1);
      expect(s.phase, JSON.stringify(c)).toBe('showdown');
      expect(s.wait).toBe(RESULT_TICKS);
      expect(s.last).not.toBeNull();
      expect(s.last?.net[0], JSON.stringify(c)).toBe(c.net0);
      expect(s.last?.net[1]).toBe(-c.net0);
      expect(s.last?.shown[0] !== null, JSON.stringify(c)).toBe(c.shown);
      expect(s.chips).toEqual([CHIPS, CHIPS]); // 還沒入帳
    }
  });

  it('7. 棄牌的牌不亮；攤牌兩張都亮', () => {
    const fold = act(turnState(1, [1], [K, J]), false);
    expect(fold.last?.shown).toEqual([null, null]);
    const showdown = act(turnState(1, [1], [K, J]), true);
    expect(showdown.last?.shown).toEqual([K, J]);
  });

  it('8. 停 30 tick 才入帳：籌碼更新、歷史多一筆（動作與亮出的牌）、換先手、重新發牌、回到準備', () => {
    let s = act(turnState(1, [1], [K, J]), true);
    s = stepN(s, RESULT_TICKS - 1);
    expect(s.chips).toEqual([CHIPS, CHIPS]);
    s = hJGame.step(s, idle());
    expect(s.chips).toEqual([CHIPS + 2, CHIPS - 2]);
    expect(s.hands).toEqual([{ first: 0, acts: [1, 1], shown: [K, J] }]);
    expect(s.hand).toBe(1);
    expect(s.first).toBe(1);
    expect(s.turn).toBe(1);
    expect(s.acts).toEqual([]);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.last).toBeNull();
    expect(s.pending).toBeNull();
    expect(s.cards[0]).not.toBe(s.cards[1]);
  });

  it('9. 先後手每手交替（0 號邊先、1 號邊先、0 號邊先……）', () => {
    let s = makeState({ phase: 'choose', wait: 0, cards: [K, Q] });
    const firsts: Side[] = [];
    for (let h = 0; h < 4; h += 1) {
      firsts.push(s.first);
      // 先手過牌、後手過牌 → 攤牌 → 入帳
      s = act(s, false);
      s = stepN(s, AI_WAIT_TICKS + 1);
      s = act(s, false);
      s = stepN(s, RESULT_TICKS);
      s = stepN(s, AI_WAIT_TICKS + 1);
    }
    expect(firsts).toEqual([0, 1, 0, 1]);
  });

  it('10. 超時：choose 的第 300 個 tick 還沒按，自動 b（過牌／棄牌）；第 300 個 tick 按了算按了', () => {
    let s = choosing({ idle: 0 });
    s = stepN(s, DECISION_TIMEOUT - 1);
    expect(s.phase).toBe('choose');
    const auto = hJGame.step(s, idle());
    expect(auto.phase).toBe('locked');
    expect(auto.pending).toBe(0);
    const pressed = hJGame.step(s, press(0, true));
    expect(pressed.pending).toBe(1);
  });

  it('11. 打完 10 手：籌碼多的贏；結束之後 step 原樣回傳；結束前 winner 是 null', () => {
    const last = turnState(1, [1], [K, J], { hand: HANDS - 1, first: 0, chips: [22, 18] });
    expect(hJGame.winner(last)).toBeNull();
    let s = act(last, true);
    s = stepN(s, RESULT_TICKS);
    expect(s.over).toBe(true);
    expect(s.chips).toEqual([24, 16]);
    expect(hJGame.winner(s)).toBe(0);
    expect(hJGame.score(s)).toEqual([24, 16]);
    expect(hJGame.step(s, press(0, true))).toBe(s);
  });

  it('12.（邊界）打完籌碼一樣：平手（winner 是 null）', () => {
    const last = turnState(1, [0], [K, J], { hand: HANDS - 1, first: 0, chips: [19, 21] });
    // 先手過牌、後手過牌 → K 大：+1 / −1，雙方變成 20 對 20
    let s = act(last, false);
    s = stepN(s, RESULT_TICKS);
    expect(s.over).toBe(true);
    expect(s.chips[0]).toBe(s.chips[1]);
    expect(hJGame.winner(s)).toBeNull();
  });

  it('13.（邊界）時間到：已經攤牌的先入帳；還在 choose 或 locked 的這手不算', () => {
    const near = choosing({ maxTicks: 10, tick: 9 });
    const timedOut = hJGame.step(near, press(0, true));
    expect(timedOut.over).toBe(true);
    expect(timedOut.chips).toEqual([CHIPS, CHIPS]);
    const shown = act(turnState(1, [1], [K, J]), true);
    const cut = hJGame.step({ ...shown, maxTicks: shown.tick + 1 }, idle());
    expect(cut.over).toBe(true);
    expect(cut.chips).toEqual([CHIPS + 2, CHIPS - 2]);
  });

  it('14. 沒有人按任何鍵：每個決定等 300 tick，10 手用不完 3600 tick，所以時間上限是必要的，而且會結束', () => {
    let s = hJGame.init(1, CONFIG);
    for (let i = 0; i < 3600 && !s.over; i += 1) {
      s = hJGame.step(s, idle());
    }
    expect(s.over).toBe(true);
    expect(s.hands.length).toBeLessThanOrEqual(HANDS);
  });

  it('15. 歷史最多 10 筆；整場 JSON 來回不變；籌碼守恆（兩邊合計 40）', () => {
    const a = levelController(hJGame, pathfinder, 5, 3);
    const b = levelController(hJGame, pathfinder, 5, 4);
    let s = hJGame.init(3, CONFIG);
    for (let t = 0; t < 3600 && !s.over; t += 1) {
      s = hJGame.step(s, [a.decide(s, 0, t), b.decide(s, 1, t)]);
      expect(s.chips[0] + s.chips[1]).toBe(2 * CHIPS);
    }
    expect(s.over).toBe(true);
    expect(s.hands.length).toBe(HANDS);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('16. step 不改動傳進來的 state 與輸入（深度凍結也不丟錯），各階段都一樣', () => {
    const phases: HJState[] = [
      makeState(),
      choosing(),
      hJGame.step(choosing(), press(0, true)),
      act(turnState(1, [1], [K, J]), true),
    ];
    for (const p of phases) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(p)) as HJState);
      const inputs = deepFreeze([{ ...PRESS_A }, { ...PRESS_B }]) as unknown as Inputs;
      expect(() => hJGame.step(frozen, inputs)).not.toThrow();
      expect(frozen).toEqual(p);
    }
  });

  it('17. 對手模型開關是 config.params.model（預設開）', () => {
    expect(hJGame.init(1, CONFIG).model).toBe(true);
    expect(hJGame.init(1, { maxTicks: 3600, params: { model: 0 } }).model).toBe(false);
  });
});

describe('H-J 三張牌撲克｜均衡表與 actions／evaluate', () => {
  it('eqAggressiveProb：先手 J 1/6、Q 0、K 1/2；後手面對過牌 J 1/3、Q 0、K 1；面對下注 J 0、Q 1/3、K 1；先手過牌後被下注 J 0、Q 1/2、K 1', () => {
    const table: [Act[], [number, number, number]][] = [
      [[], [1 / 6, 0, 1 / 2]],
      [[0], [1 / 3, 0, 1]],
      [[1], [0, 1 / 3, 1]],
      [
        [0, 1],
        [0, 1 / 2, 1],
      ],
    ];
    for (const [acts, probs] of table) {
      for (const card of [J, Q, K] as const) {
        expect(eqAggressiveProb(card, acts), `${JSON.stringify(acts)} ${card}`).toBeCloseTo(
          probs[card],
          12,
        );
      }
    }
  });

  it('eqAction：抽籤小於機率就是 a，否則 b；機率 0 永遠 b、機率 1 永遠 a', () => {
    expect(eqAction(J, [], 1000)).toBe(1); // 0.1 < 1/6
    expect(eqAction(J, [], 1700)).toBe(0);
    expect(eqAction(K, [], 4999)).toBe(1);
    expect(eqAction(K, [], 5000)).toBe(0);
    expect(eqAction(Q, [], 0)).toBe(0);
    expect(eqAction(K, [1], 9999)).toBe(1);
  });

  it('actions：輪到而且在 choose 是 [b, a]（消極排第一）；其他都只有 [全放開]', () => {
    const acts = hJGame.actions(choosing({ turn: 1, first: 1 }), 1);
    expect(acts).toHaveLength(2);
    expect(sameButtons(acts[0] as Buttons, PRESS_B)).toBe(true);
    expect(sameButtons(acts[1] as Buttons, PRESS_A)).toBe(true);
    for (const s of [
      choosing({ turn: 1, first: 1 }), // 不是我的回合（0 號邊）
      makeState(),
      hJGame.step(choosing(), press(0, true)),
    ]) {
      const list = hJGame.actions(s, 0);
      if (s.phase === 'choose' && s.turn === 0) {
        continue;
      }
      expect(list).toHaveLength(1);
      expect(sameButtons(list[0] as Buttons, IDLE)).toBe(true);
    }
    expect(hJGame.actions(choosing({ turn: 1, first: 1 }), 0)).toHaveLength(1);
  });

  it('evaluate：每個階段 gain 有限、danger 在 0 到 1；結束的局有勝負加成', () => {
    const states = [
      makeState(),
      choosing(),
      hJGame.step(choosing(), press(0, true)),
      act(turnState(1, [1], [K, J]), true),
      act(turnState(1, [0], [K, J]), true),
    ];
    for (const s of states) {
      for (const side of [0, 1] as const) {
        const e = hJGame.evaluate(s, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
    const won = makeState({ over: true, winner: 1, chips: [15, 25] });
    expect(hJGame.evaluate(won, 1).gain).toBeGreaterThan(900);
    expect(hJGame.evaluate(won, 0).gain).toBeLessThan(-900);
  });
});

describe('H-J 三張牌撲克｜expectedHand（一手牌的期望，只用均衡先驗時等於 Kuhn 撲克的已知數字）', () => {
  const eqValue = (turn: Side, acts: Act[], my: Card): number => {
    const s = turnState(turn, acts, my === J ? [K, J] : my === Q ? [K, Q] : [J, K]);
    // AI 坐 1 號邊：我的牌放在 cards[1]
    return expectedHand({ ...s, cards: [my === K ? J : K, my] as [Card, Card] }, 1);
  };

  it('先手：J −1、Q −1/3（過牌）、K +7/6（下注與過牌一樣好）', () => {
    expect(eqValue(1, [], J)).toBeCloseTo(-1, 9);
    expect(eqValue(1, [], Q)).toBeCloseTo(-1 / 3, 9);
    expect(eqValue(1, [], K)).toBeCloseTo(7 / 6, 9);
  });

  it('後手面對過牌：J −1、Q +1/4（過牌）、K +14/11（下注）', () => {
    expect(eqValue(1, [0], J)).toBeCloseTo(-1, 9);
    expect(eqValue(1, [0], Q)).toBeCloseTo(0.25, 9);
    expect(eqValue(1, [0], K)).toBeCloseTo(14 / 11, 9);
  });

  it('後手面對下注：J −1（棄）、Q −1（跟與棄一樣）、K +2', () => {
    expect(eqValue(1, [1], J)).toBeCloseTo(-1, 9);
    expect(eqValue(1, [1], Q)).toBeCloseTo(-1, 9);
    expect(eqValue(1, [1], K)).toBeCloseTo(2, 9);
  });

  it('只讀自己的牌：對手的牌不同，期望相同', () => {
    const a = expectedHand(turnState(1, [1], [J, Q]), 1);
    const b = expectedHand(turnState(1, [1], [K, Q]), 1);
    expect(a).toBe(b);
  });
});

describe('H-J 三張牌撲克｜不偷看（evaluate、actions 只讀自己的牌、自己的抽籤與公開資訊）', () => {
  const hands = [rec(0, [0, 0], [Q, J]), rec(1, [1, 0]), rec(0, [1, 1], [K, Q])];
  const base = { hands, hand: 3, chips: [21, 19] as [number, number] };

  /** 一組只有 0 號邊（對手）隱藏資訊不同的 state；AI 坐 1 號邊，牌 Q。 */
  function variants(): { name: string; states: HJState[] }[] {
    const opp = ([J, K] as const).map((c) => c);
    const groups: { name: string; states: HJState[] }[] = [];
    groups.push({
      name: 'AI 先手 choose：對手的牌與抽籤不同',
      states: opp.flatMap((c) =>
        [0, 3000, 9999].map((d) =>
          turnState(1, [], [c, Q], { ...base, first: 1, eqDraw: [d, 4000] }),
        ),
      ),
    });
    groups.push({
      name: 'AI 後手面對下注：對手的牌、抽籤不同',
      states: opp.flatMap((c) =>
        [0, 5000, 9999].map((d) => turnState(1, [1], [c, Q], { ...base, eqDraw: [d, 4000] })),
      ),
    });
    groups.push({
      name: 'locked：AI 剛按了鍵，對手的牌不同',
      states: opp.flatMap((c) =>
        [0, 9999].map((d) =>
          hJGame.step(turnState(1, [0], [c, Q], { ...base, eqDraw: [d, 4000] }), press(1, true)),
        ),
      ),
    });
    groups.push({
      name: 'locked：輪到對手，對手剛按的鍵（pending）與牌不同',
      states: opp.flatMap((c) =>
        [true, false].map((a) => hJGame.step(turnState(0, [], [c, Q], { ...base }), press(0, a))),
      ),
    });
    groups.push({
      name: 'prep（對手的回合）：對手的牌、對手還沒按的抽籤不同',
      states: opp.flatMap((c) =>
        [0, 8000].map((d) =>
          act(turnState(1, [], [c, Q], { ...base, first: 1, eqDraw: [d, 4000] }), true),
        ),
      ),
    });
    groups.push({
      name: 'showdown：揭示結果（last）與對手的牌不同',
      states: opp.flatMap((c) =>
        [0, 9999].map((d) => act(turnState(1, [1], [c, Q], { ...base, eqDraw: [d, 4000] }), true)),
      ),
    });
    groups.push({
      name: 'showdown：AI 棄牌',
      states: opp.map((c) => act(turnState(1, [1], [c, J], { ...base }), false)),
    });
    return groups;
  }

  function peeks(game: Game<HJState>, states: readonly HJState[], side: Side): boolean {
    const first = states[0] as HJState;
    const e0 = JSON.stringify(game.evaluate(first, side));
    const a0 = JSON.stringify(game.actions(first, side));
    return states.some(
      (s) =>
        JSON.stringify(game.evaluate(s, side)) !== e0 ||
        JSON.stringify(game.actions(s, side)) !== a0,
    );
  }

  it('每一組只有對手隱藏資訊不同的 state：AI 側的 evaluate 與 actions 完全相同', () => {
    for (const g of variants()) {
      expect(peeks(hJGame, g.states, 1), g.name).toBe(false);
    }
  });

  it('反過來也成立：AI 坐 0 號邊（鏡像）', () => {
    const mirror = (s: HJState): HJState => ({
      ...s,
      first: (1 - s.first) as Side,
      turn: (1 - s.turn) as Side,
      cards: [s.cards[1], s.cards[0]],
      eqDraw: [s.eqDraw[1], s.eqDraw[0]],
      chips: [s.chips[1], s.chips[0]],
      hands: s.hands.map((h) => ({
        first: (1 - h.first) as Side,
        acts: h.acts,
        shown: [h.shown[1], h.shown[0]],
      })),
      last:
        s.last === null
          ? null
          : {
              ...s.last,
              net: [s.last.net[1], s.last.net[0]],
              shown: [s.last.shown[1], s.last.shown[0]],
              winner: (1 - s.last.winner) as Side,
            },
    });
    for (const g of variants()) {
      expect(peeks(hJGame, g.states.map(mirror), 0), g.name).toBe(false);
    }
  });

  it('黑箱：四個性格在深度 1、3、6，只有對手隱藏資訊不同的局面，按的鍵都相同', () => {
    const policies: readonly Policy[] = [pathfinder, precise, greedy, gambler];
    for (const g of variants().filter((v) => v.states[0]?.phase === 'choose')) {
      for (const policy of policies) {
        for (const depth of [1, 3, 6]) {
          const presses = g.states.map((s) => decideAtDepth(s, 1, depth, policy));
          for (const p of presses) {
            expect(p, `${g.name} ${policy.name} 深度 ${depth}`).toEqual(presses[0]);
          }
        }
      }
    }
  });

  it('偵測器本身有效：故意洩漏（讀對手的牌、讀對手的抽籤、讀 last、讓 actions 多一個動作）一定被抓到', () => {
    const groups = variants();
    const leaks: Record<string, (s: HJState, side: Side) => number> = {
      '讀對手的牌（所有階段）': (s, side) => 0.001 * (s.cards[1 - side] as number),
      '讀對手的牌（locked）': (s, side) =>
        s.phase === 'locked' ? 0.001 * (s.cards[1 - side] as number) : 0,
      '讀對手的牌（prep／showdown）': (s, side) =>
        s.phase === 'prep' || s.phase === 'showdown' ? 0.001 * (s.cards[1 - side] as number) : 0,
      讀對手的抽籤: (s, side) => 0.000001 * (s.eqDraw[1 - side] as number),
      '讀 last 的贏家': (s, side) =>
        s.last === null ? 0 : s.last.winner === side ? 0.001 : s.last.winner === null ? 0 : -0.001,
      '讀 last 亮出的對手牌': (s, side) =>
        s.last === null || s.last.shown[1 - side] === null
          ? 0
          : 0.001 * (s.last.shown[1 - side] as number),
    };
    for (const [name, extra] of Object.entries(leaks)) {
      const leaky: Game<HJState> = {
        ...hJGame,
        evaluate: (s, side) => {
          const e = hJGame.evaluate(s, side);
          return { gain: e.gain + extra(s, side), danger: e.danger };
        },
      };
      expect(
        groups.some((g) => peeks(leaky, g.states, 1)),
        `沒抓到洩漏：${name}`,
      ).toBe(true);
    }
    const leakyActions: Game<HJState> = {
      ...hJGame,
      actions: (s, side) =>
        s.cards[1 - side] === K ? [...hJGame.actions(s, side), IDLE] : hJGame.actions(s, side),
    };
    expect(groups.some((g) => peeks(leakyActions, g.states, 1))).toBe(true);
  });

  it('「對所有動作加同一個常數」的洩漏：黑箱 decide 抓不到（選擇不變），只有 evaluate／actions 相等那兩條抓得到', () => {
    // 洩漏：不管我按什麼，都加上對手牌的一個常數。排序不變，所以 decide 一樣；但 evaluate 已經不同。
    const leaky: Game<HJState> = {
      ...hJGame,
      evaluate: (s, side) => {
        const e = hJGame.evaluate(s, side);
        return { gain: e.gain + 0.37 * (s.cards[1 - side] as number), danger: e.danger };
      },
    };
    const group = variants()[1] as { states: HJState[] };
    // 1. evaluate 相等測試會紅
    expect(peeks(leaky, group.states, 1)).toBe(true);
    // 2. 但是黑箱 decide 一樣（這就是為什麼不能只測 decide）
    for (const depth of [1, 3, 6]) {
      const presses = group.states.map((s) => {
        const controller = wrapPolicy(
          leaky,
          pathfinder,
          { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
          7,
        );
        return JSON.stringify(controller.decide(s, 1, 0));
      });
      expect(new Set(presses).size, `深度 ${depth}`).toBe(1);
    }
  });

  it('洩漏會改變選擇的那型：往前模擬時讀對手的牌（posterior 坍縮成真牌）→ 黑箱 decide 也會不同', () => {
    const leakyChoice: Game<HJState> = {
      ...hJGame,
      evaluate: (s, side) => {
        const e = hJGame.evaluate(s, side);
        if (s.phase !== 'showdown' && s.phase !== 'prep') {
          return e;
        }
        // 假裝知道對手的牌：我比對手大就加分
        const bonus = (s.cards[side] as number) > (s.cards[1 - side] as number) ? 3 : -3;
        const lastMine = s.acts[s.acts.length - 1] === 1 ? 1 : 0;
        return { gain: e.gain + bonus * lastMine, danger: 0 };
      },
    };
    const decisions = [J, K].map((c) => {
      const controller = wrapPolicy(
        leakyChoice,
        pathfinder,
        { reactionTicks: 0, decideEvery: 1, depth: 3, epsilon: 0 },
        7,
      );
      return JSON.stringify(
        controller.decide(turnState(1, [1], [c, Q], { eqDraw: [0, 9000] }), 1, 0),
      );
    });
    expect(new Set(decisions).size).toBeGreaterThan(1);
  });
});

describe('H-J 三張牌撲克｜對手模型 opponentModel（只讀公開的 hands，最近 5 手）', () => {
  it('沒有歷史：先驗就是均衡，各局面的下注／跟注機率等於 eqAggressiveProb', () => {
    const model = opponentModel([], 1, true);
    for (const acts of [[], [0], [1], [0, 1]] as Act[][]) {
      for (const card of [J, Q, K] as const) {
        expect(oppAggressiveProb(model, card, acts), `${JSON.stringify(acts)} ${card}`).toBeCloseTo(
          eqAggressiveProb(card, acts),
          12,
        );
      }
    }
  });

  it('模型關掉（消融）：不管歷史，永遠是均衡先驗', () => {
    const off = opponentModel([...oppFolds(5), ...oppBluffs(3)], 1, false);
    for (const card of [J, Q, K] as const) {
      expect(oppAggressiveProb(off, card, [1])).toBeCloseTo(eqAggressiveProb(card, [1]), 12);
      expect(oppAggressiveProb(off, card, [])).toBeCloseTo(eqAggressiveProb(card, []), 12);
    }
  });

  it('對手愛棄牌（面對下注都棄）→ 它的 Q 跟注機率掉到 0；愛跟 → 升到 1', () => {
    expect(oppAggressiveProb(opponentModel(oppFolds(4), 1, true), Q, [1])).toBe(0);
    expect(oppAggressiveProb(opponentModel(oppCalls(4), 1, true), Q, [1])).toBe(1);
    // J 永遠不跟、K 永遠跟，不管資料
    expect(oppAggressiveProb(opponentModel(oppCalls(4), 1, true), J, [1])).toBe(0);
    expect(oppAggressiveProb(opponentModel(oppFolds(4), 1, true), K, [1])).toBe(1);
  });

  it('亮出來的下注都是 K → J 詐唬的機率低於均衡；亮出來的下注是 J → 高於均衡', () => {
    const base = eqAggressiveProb(J, []);
    expect(oppAggressiveProb(opponentModel(oppValueOnly(4), 1, true), J, [])).toBeLessThan(base);
    expect(oppAggressiveProb(opponentModel(oppBluffs(4), 1, true), J, [])).toBeGreaterThan(base);
  });

  it('棄牌的牌不亮：沒有攤牌就沒有詐唬比例的證據（weakShare 停在先驗）', () => {
    const hidden = Array.from({ length: 4 }, () => rec(0, [1, 0]));
    const model = opponentModel(hidden, 1, true);
    expect(model.weakShare).toBeCloseTo(0.25, 12);
  });

  it('窗口只有最近 5 手：更早的紀錄不影響（可以被覆寫）', () => {
    const old = oppFolds(8);
    const fresh = oppCalls(WINDOW);
    const a = opponentModel([...old, ...fresh], 1, true);
    const b = opponentModel(fresh, 1, true);
    expect(a).toEqual(b);
  });

  it('只讀 hands，不改動傳進來的陣列；從兩個方向看都成立（預測的是 side 的對手）', () => {
    const hs = deepFreeze(oppFolds(3).map((h) => ({ ...h })));
    expect(() => opponentModel(hs, 1, true)).not.toThrow();
    // 鏡像：0 號邊是 AI、1 號邊是對手，對手愛棄牌
    const mirrored = Array.from({ length: 4 }, () => rec(0, [1, 0]));
    expect(oppAggressiveProb(opponentModel(mirrored, 0, true), Q, [1])).toBe(0);
  });

  it('confidenceLevel：粗粒度 0 到 3 四級，由窗口裡攤牌的數量決定（0、1、2 到 3、4 以上）；模型關掉是 0', () => {
    const sd = (n: number): HJState['hands'] => oppCalls(n);
    expect(confidenceLevel([], 1, true)).toBe(0);
    expect(confidenceLevel(sd(1), 1, true)).toBe(1);
    expect(confidenceLevel(sd(2), 1, true)).toBe(2);
    expect(confidenceLevel(sd(3), 1, true)).toBe(2);
    expect(confidenceLevel(sd(4), 1, true)).toBe(3);
    expect(confidenceLevel(sd(5), 1, true)).toBe(3);
    expect(confidenceLevel(sd(5), 1, false)).toBe(0);
    expect(confidenceLevel(oppFolds(5), 1, true)).toBe(0); // 棄牌沒攤牌，沒有資料
  });
});

describe('H-J 三張牌撲克｜AI 怎麼打（等級曲線從結算流程長出來）', () => {
  const DRAWS = [0, 1000, 1666, 1700, 3000, 3400, 4999, 5000, 6000, 9999];
  const SPOTS: { name: string; turn: Side; acts: Act[] }[] = [
    { name: '先手', turn: 1, acts: [] },
    { name: '後手面對過牌', turn: 1, acts: [0] },
    { name: '後手面對下注', turn: 1, acts: [1] },
    { name: '先手過牌後被下注', turn: 1, acts: [0, 1] },
  ];

  function stateFor(
    spot: { turn: Side; acts: Act[] },
    card: Card,
    draw: number,
    hands: HJState['hands'] = [],
  ): HJState {
    const opponentCard: Card = card === K ? J : K;
    return turnState(spot.turn, spot.acts, [opponentCard, card], {
      eqDraw: [0, draw],
      hands,
      hand: hands.length,
    });
  }

  it('冷啟動（沒有歷史）：任何深度、任何局面、任何牌、任何抽籤，AI 都打均衡抽籤出來的動作（沒證據不亂剝削）', () => {
    for (const spot of SPOTS) {
      for (const card of [J, Q, K] as const) {
        for (const draw of DRAWS) {
          const want = eqAction(card, spot.acts, draw) === 1;
          for (const depth of [1, 2, 3, 4, 6]) {
            const got = aggressive(decideAtDepth(stateFor(spot, card, draw), 1, depth));
            expect(got, `${spot.name} 牌 ${card} 抽籤 ${draw} 深度 ${depth}`).toBe(want);
          }
        }
      }
    }
  });

  it('深度 1、2 不讀你：不管歷史，永遠打均衡抽籤的動作', () => {
    const histories = [oppFolds(5), oppCalls(5), oppValueOnly(5), oppBluffs(5)];
    for (const spot of SPOTS) {
      for (const card of [J, Q, K] as const) {
        for (const draw of [0, 4000, 9000]) {
          const want = eqAction(card, spot.acts, draw) === 1;
          for (const h of histories) {
            for (const depth of [1, 2]) {
              expect(aggressive(decideAtDepth(stateFor(spot, card, draw, h), 1, depth))).toBe(want);
            }
          }
        }
      }
    }
  });

  it('深度 3 以上讀你（1）：對手面對下注都棄 → 我拿 J 先手也下注詐唬（抽籤說過牌也一樣）', () => {
    const s = stateFor(SPOTS[0] as (typeof SPOTS)[number], J, 9000, oppFolds(5));
    for (const depth of [3, 4, 6]) {
      expect(aggressive(decideAtDepth(s, 1, depth)), `深度 ${depth}`).toBe(true);
    }
    for (const depth of [1, 2]) {
      expect(aggressive(decideAtDepth(s, 1, depth))).toBe(false);
    }
  });

  it('深度 3 以上讀你（2）：對手愛跟 → 我拿 J 不詐唬（抽籤說下注也一樣）', () => {
    const s = stateFor(SPOTS[0] as (typeof SPOTS)[number], J, 0, oppCalls(5));
    for (const depth of [3, 4, 6]) {
      expect(aggressive(decideAtDepth(s, 1, depth)), `深度 ${depth}`).toBe(false);
    }
    for (const depth of [1, 2]) {
      expect(aggressive(decideAtDepth(s, 1, depth))).toBe(true);
    }
  });

  it('深度 3 以上讀你（3）：對手只用 K 下注 → 我拿 Q 面對下注就棄；對手愛詐唬 → 我拿 Q 跟', () => {
    const facing = SPOTS[2] as (typeof SPOTS)[number];
    const valueOnly = stateFor(facing, Q, 0, oppValueOnly(5));
    const bluffer = stateFor(facing, Q, 9000, oppBluffs(5));
    for (const depth of [3, 6]) {
      expect(aggressive(decideAtDepth(valueOnly, 1, depth)), `價值下注 深度 ${depth}`).toBe(false);
      expect(aggressive(decideAtDepth(bluffer, 1, depth)), `詐唬 深度 ${depth}`).toBe(true);
    }
    expect(aggressive(decideAtDepth(valueOnly, 1, 1))).toBe(true);
    expect(aggressive(decideAtDepth(bluffer, 1, 1))).toBe(false);
  });

  it('模型關掉（消融）：深度 6 的 AI 對任何歷史都打均衡抽籤的動作', () => {
    for (const h of [oppFolds(5), oppCalls(5), oppBluffs(5)]) {
      for (const draw of [0, 9000]) {
        const s = { ...stateFor(SPOTS[0] as (typeof SPOTS)[number], J, draw, h), model: false };
        expect(aggressive(decideAtDepth(s, 1, 6))).toBe(eqAction(J, [], draw) === 1);
      }
    }
  });

  it('等級曲線是階梯：深度 1、2 永遠一樣（讀不到歷史），深度 3 以上同一個局面會因歷史而不同', () => {
    const picks = (depth: number): Set<boolean> =>
      new Set(
        [oppFolds(5), oppCalls(5), []].map((h) =>
          aggressive(
            decideAtDepth(stateFor(SPOTS[0] as (typeof SPOTS)[number], J, 3000, h), 1, depth),
          ),
        ),
      );
    expect(picks(1).size).toBe(1);
    expect(picks(2).size).toBe(1);
    expect(picks(3).size).toBeGreaterThan(1);
    expect(picks(6).size).toBeGreaterThan(1);
  });

  describe('淺層永遠是均衡抽籤（沒有第二套規則）', () => {
    it('config.params.reflex 不再是選項：給了也沒有作用，state 沒有 reflex 欄位', () => {
      const plain = hJGame.init(1, CONFIG);
      const given = hJGame.init(1, { maxTicks: 3600, params: { reflex: 1 } });
      expect(given).toEqual(plain);
      expect('reflex' in plain).toBe(false);
    });

    it('深度 1、2 不看牌的大小，照抽籤查均衡表：同一張 J，抽籤不同動作不同', () => {
      const spot = SPOTS[0] as (typeof SPOTS)[number];
      const picks = new Set(
        [0, 9999].map((draw) => aggressive(decideAtDepth(stateFor(spot, J, draw, []), 1, 1))),
      );
      expect(picks.size).toBe(2);
    });
  });

  describe('DESIGN-AI-FUN 10.6 的兩個 pending 陷阱', () => {
    function phasesSeen(depth: number, state: HJState, side: Side): Set<string> {
      const seen = new Set<string>();
      const spy: Game<HJState> = {
        ...hJGame,
        evaluate: (s, who) => {
          seen.add(s.phase);
          return hJGame.evaluate(s, who);
        },
      };
      wrapPolicy(
        spy,
        pathfinder,
        { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
        7,
      ).decide(state, side, 0);
      return seen;
    }

    it('陷阱二：actions()[0] 是 b（過牌／棄牌），一個會推進結算的動作，不是什麼都不按', () => {
      for (const s of [
        turnState(0, [], [K, Q]),
        turnState(1, [1], [K, Q]),
        turnState(0, [0, 1], [K, Q]),
      ]) {
        const list = hJGame.actions(s, s.turn);
        expect(sameButtons(list[0] as Buttons, IDLE)).toBe(false);
        expect(sameButtons(list[0] as Buttons, PRESS_B)).toBe(true);
        const afterOne = hJGame.step(
          s,
          s.turn === 0 ? [list[0] as Buttons, IDLE] : [IDLE, list[0] as Buttons],
        );
        expect(afterOne.phase).toBe('locked');
      }
    });

    it('陷阱一：按 → 鎖定 → 生效一共 3 步，在 depth 的 6 格額度之內', () => {
      const s = turnState(0, [], [K, Q]);
      let cur = hJGame.step(s, press(0, true));
      let steps = 1;
      while (cur.acts.length === 0) {
        cur = hJGame.step(cur, idle());
        steps += 1;
      }
      expect(steps).toBe(3);
      expect(steps).toBeLessThanOrEqual(6);
    });

    it('深度 1、2 的 decide 沒評估過生效後的局面（prep／showdown），深度 3 以上評估過', () => {
      const states = [
        turnState(1, [], [K, Q], { hands: oppFolds(3) }),
        turnState(1, [1], [K, Q], { hands: oppFolds(3) }),
      ];
      for (const state of states) {
        for (const side of [1] as const) {
          for (const depth of [1, 2]) {
            const seen = phasesSeen(depth, state, side);
            expect(seen.has('prep') || seen.has('showdown'), `深度 ${depth}`).toBe(false);
          }
          for (const depth of [3, 4, 6]) {
            const seen = phasesSeen(depth, state, side);
            expect(seen.has('prep') || seen.has('showdown'), `深度 ${depth}`).toBe(true);
          }
        }
      }
    });
  });
});

describe('H-J 三張牌撲克｜AI 能不能玩', () => {
  it('兩個等級 5 的搜尋型打完一整場：10 手都打完，在 maxTicks 之前結束', () => {
    for (const seed of [1, 2, 3]) {
      const a = levelController(hJGame, pathfinder, 5, seed);
      const b = levelController(hJGame, pathfinder, 5, seed + 1_000_003);
      const r = playMatch(hJGame, seed, CONFIG, a, b);
      expect(r.ticks).toBeLessThan(3600);
      expect(r.score[0] + r.score[1]).toBe(2 * CHIPS);
    }
  });

  it('人類模型與隨機控制器也能把一場打完：不會卡住', () => {
    const a = levelController(hJGame, random, 10, 3);
    const b = humanModel(hJGame, 4);
    expect(() => playMatch(hJGame, 3, CONFIG, a, b)).not.toThrow();
  });

  it('等級參數沒有被誤用：深度 3 是第一個走得到生效的深度（levelParams 的 depth 範圍 1 到 6）', () => {
    expect(levelParams(1).depth).toBe(1);
    expect(levelParams(10).depth).toBe(6);
    expect(LOCK_TICKS + 1).toBeLessThanOrEqual(6);
  });
});
