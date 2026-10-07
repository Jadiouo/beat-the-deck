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
  CALL,
  DICE,
  LOCK_TICKS,
  MAX_ROUNDS,
  PLUS1,
  PLUS2,
  PLUS3,
  RESULT_TICKS,
  S0,
  S_MAX,
  WINS,
  bluffMargin,
  callChance,
  callRates,
  h9Game,
  makeState,
  oppPosterior,
  priorSums,
  trueChance,
} from './logic';
import type { Dice, H9Bid, H9Past, H9State } from './logic';

/**
 * H-9 吹牛骰的規則測試（規則見 `docs/cards/H-9.md`）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 最重要的一組是「不偷看」：對方藏著的兩顆骰子，AI 不可以讀；
 * 而且那組測試本身要抓得到洩漏（用故意洩漏的 evaluate 驗證偵測器真的會紅，
 * 包括只有 `decide` 那一層才抓得到的那一種：亮骰階段的估值讀了亮出來的骰子）。
 */

const CONFIG = { maxTicks: 3600, params: {} };

/** 只有 `side` 那一邊按鍵。 */
function press(side: Side, buttons: Buttons): Inputs {
  return side === 0 ? [buttons, IDLE] : [IDLE, buttons];
}

function idle(): Inputs {
  return [IDLE, IDLE];
}

function stepN(state: H9State, n: number, inputs: Inputs = idle()): H9State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = h9Game.step(s, inputs);
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

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** 兩邊的骰子：人 `human`、AI `ai`。 */
function dice(human: readonly [number, number], ai: readonly [number, number]): Dice {
  return [human, ai];
}

function bid(side: Side, S: number): H9Bid {
  return { side, S };
}

function choosing(overrides: Partial<H9State> = {}): H9State {
  return makeState({ phase: 'choose', wait: 0, ...overrides });
}

/** 一個已結束的回合（公開紀錄）。 */
function past(d: Dice, bids: readonly H9Bid[], challenger: Side, bidderWon: boolean): H9Past {
  return { dice: d, bids, challenger, bidderWon };
}

const POLICIES: readonly Policy[] = [pathfinder, precise, greedy, gambler];

/** 沒有延遲、不亂選的指定深度控制器。 */
function decideWith(policy: Policy, depth: number, state: H9State, side: Side): Buttons {
  return wrapPolicy(
    h9Game,
    policy,
    { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
    7,
  ).decide(state, side, 0);
}

function nameOf(buttons: Buttons): string {
  if (sameButtons(buttons, PLUS1)) {
    return 'plus1';
  }
  if (sameButtons(buttons, PLUS2)) {
    return 'plus2';
  }
  if (sameButtons(buttons, PLUS3)) {
    return 'plus3';
  }
  if (sameButtons(buttons, CALL)) {
    return 'call';
  }
  return 'idle';
}

/** 一個完整的、可以直接走的對局狀態：AI（1）在 `choose`，人（0）剛喊過 `S`。 */
function aiToAct(overrides: Partial<H9State> = {}): H9State {
  return choosing({
    turn: 1,
    first: 0,
    S: 10,
    bidder: 0,
    bids: [bid(0, 5), bid(1, 7), bid(0, 10)],
    dice: dice([3, 4], [2, 5]),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 初始與常數
// ---------------------------------------------------------------------------

describe('H-9 吹牛骰｜初始與常數', () => {
  it('常數：每人 2 顆骰、先贏 3 回合、最多 5 回合、鎖定 2 tick、亮骰停 30 tick、喊價從 4 到 24', () => {
    expect(DICE).toBe(2);
    expect(WINS).toBe(3);
    expect(MAX_ROUNDS).toBe(5);
    expect(LOCK_TICKS).toBe(2);
    expect(RESULT_TICKS).toBe(30);
    expect(S0).toBe(4);
    expect(S_MAX).toBe(24);
  });

  it('init：第 1 回合人先、喊價 4、沒有人喊過、骰子都是 1 到 6、勝場 0、沒有過去的回合', () => {
    const s = h9Game.init(3, CONFIG);
    expect(s.round).toBe(1);
    expect(s.first).toBe(0);
    expect(s.turn).toBe(0);
    expect(s.S).toBe(4);
    expect(s.bidder).toBeNull();
    expect(s.phase).toBe('choose');
    expect(s.wins).toEqual([0, 0]);
    expect(s.bids).toEqual([]);
    expect(s.past).toEqual([]);
    expect(s.over).toBe(false);
    for (const side of [0, 1] as const) {
      expect(s.dice[side]).toHaveLength(2);
      for (const d of s.dice[side]) {
        expect(Number.isInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(6);
      }
    }
  });

  it('init：同樣的種子同樣的骰子；不同種子的骰子不全相同；maxTicks 來自 config', () => {
    expect(hashState(h9Game.init(5, CONFIG))).toBe(hashState(h9Game.init(5, CONFIG)));
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      seen.add(JSON.stringify(h9Game.init(seed, CONFIG).dice));
    }
    expect(seen.size).toBeGreaterThan(5);
    expect(h9Game.init(1, { maxTicks: 1234, params: {} }).maxTicks).toBe(1234);
  });

  it('init：骰子的總和平均接近 14（四顆骰子），兩邊各約 7', () => {
    let human = 0;
    let ai = 0;
    const n = 400;
    for (let seed = 0; seed < n; seed += 1) {
      const s = h9Game.init(seed, CONFIG);
      human += s.dice[0][0] + s.dice[0][1];
      ai += s.dice[1][0] + s.dice[1][1];
    }
    expect(human / n).toBeGreaterThan(6.6);
    expect(human / n).toBeLessThan(7.4);
    expect(ai / n).toBeGreaterThan(6.6);
    expect(ai / n).toBeLessThan(7.4);
  });
});

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

describe('H-9 吹牛骰｜規則', () => {
  it('1. 加價：← 加 1、↑ 加 2、→ 加 3；喊價與喊價紀錄立刻更新，進入 locked（鎖定 2 tick）', () => {
    const base = choosing({ S: 10, bidder: 1, turn: 0, bids: [bid(1, 10)] });
    const left = h9Game.step(base, press(0, PLUS1));
    expect(left.S).toBe(11);
    const up = h9Game.step(base, press(0, PLUS2));
    expect(up.S).toBe(12);
    const right = h9Game.step(base, press(0, PLUS3));
    expect(right.S).toBe(13);
    for (const s of [left, up, right]) {
      expect(s.phase).toBe('locked');
      expect(s.lock).toBe('raise');
      expect(s.wait).toBe(LOCK_TICKS);
      expect(s.bidder).toBe(0);
      expect(s.bids).toHaveLength(2);
      expect(s.bids[1]).toEqual(bid(0, s.S));
      expect(s.wins).toEqual([0, 0]);
    }
  });

  it('2. 鎖定 2 tick 之後（共 3 步）：回合交給對方，喊價不變；對方是 AI 要先等 AI_WAIT_TICKS，是人直接可以決定', () => {
    const humanBids = choosing({ S: 10, bidder: 1, turn: 0, bids: [bid(1, 10)] });
    const a1 = h9Game.step(humanBids, press(0, PLUS1));
    expect(a1.phase).toBe('locked');
    const a2 = stepN(a1, 1);
    expect(a2.phase).toBe('locked');
    expect(a2.wait).toBe(1);
    const a3 = stepN(a2, 1);
    expect(a3.turn).toBe(1);
    expect(a3.S).toBe(11);
    expect(a3.phase).toBe('prep');
    expect(a3.wait).toBe(AI_WAIT_TICKS);
    expect(a3.lock).toBeNull();

    const aiBids = choosing({ S: 10, bidder: 0, turn: 1, bids: [bid(0, 10)] });
    const b3 = stepN(aiBids, 1, press(1, PLUS2));
    const b4 = stepN(b3, 2);
    expect(b4.turn).toBe(0);
    expect(b4.S).toBe(12);
    expect(b4.phase).toBe('choose');
    expect(b4.idle).toBe(0);
  });

  it('3. prep：AI 的回合開頭等 AI_WAIT_TICKS 個 tick，期間輸入被忽略；之後進 choose', () => {
    const s = makeState({ phase: 'prep', wait: AI_WAIT_TICKS, turn: 1, S: 9, bidder: 0 });
    const early = stepN(s, AI_WAIT_TICKS - 1, press(1, CALL));
    expect(early.phase).toBe('prep');
    expect(early.S).toBe(9);
    expect(early.bids).toEqual([]);
    const ready = stepN(early, 1, press(1, CALL));
    expect(ready.phase).toBe('choose');
    // 進入 choose 的那個 tick 不算按鍵；下一個 tick 才算
    const acted = h9Game.step(ready, press(1, CALL));
    expect(acted.phase).toBe('locked');
    expect(acted.lock).toBe('call');
  });

  it('4. 沒有人喊過（S = 4）不能抓：b 沒有效，輸入被當成沒按（idle 繼續累積）', () => {
    const s = choosing({ S: 4, bidder: null, turn: 0 });
    const after = h9Game.step(s, press(0, CALL));
    expect(after.phase).toBe('choose');
    expect(after.S).toBe(4);
    expect(after.idle).toBe(1);
    // 同時按著 b 與 ←：b 無效，← 照常加價
    const both = h9Game.step(s, press(0, { ...CALL, left: true }));
    expect(both.S).toBe(5);
  });

  it('5. 抓：進入 locked（lock = call），鎖定 2 tick 之後（第 3 步）亮骰，階段是 reveal、停 RESULT_TICKS；這段時間勝場沒動', () => {
    const s = choosing({ turn: 1, S: 12, bidder: 0, bids: [bid(0, 8), bid(1, 9), bid(0, 12)] });
    const c1 = h9Game.step(s, press(1, CALL));
    expect(c1.phase).toBe('locked');
    expect(c1.lock).toBe('call');
    expect(c1.wait).toBe(LOCK_TICKS);
    expect(c1.S).toBe(12);
    expect(c1.bids).toHaveLength(3);
    const c2 = stepN(c1, 1);
    expect(c2.phase).toBe('locked');
    const c3 = stepN(c2, 1);
    expect(c3.phase).toBe('reveal');
    expect(c3.wait).toBe(RESULT_TICKS);
    expect(c3.wins).toEqual([0, 0]);
    const mid = stepN(c3, RESULT_TICKS - 2);
    expect(mid.phase).toBe('reveal');
    expect(mid.wins).toEqual([0, 0]);
  });

  it('6. 結算：總和 ≥ 喊價，喊的人贏；總和 < 喊價，抓的人贏', () => {
    // 人（0）喊 14，AI（1）抓。總和 = 3+4+2+5 = 14：喊的人贏
    const trueBid = choosing({
      turn: 1,
      S: 14,
      bidder: 0,
      dice: dice([3, 4], [2, 5]),
      bids: [bid(0, 14)],
    });
    const wonByBidder = stepN(h9Game.step(trueBid, press(1, CALL)), LOCK_TICKS + RESULT_TICKS);
    expect(wonByBidder.wins).toEqual([1, 0]);
    // 喊 15：總和 14 < 15，抓的人贏
    const falseBid = { ...trueBid, S: 15, bids: [bid(0, 15)] };
    const wonByCaller = stepN(h9Game.step(falseBid, press(1, CALL)), LOCK_TICKS + RESULT_TICKS);
    expect(wonByCaller.wins).toEqual([0, 1]);
    // 反過來：AI 喊、人抓
    const aiBid = choosing({
      turn: 0,
      S: 13,
      bidder: 1,
      dice: dice([3, 4], [2, 5]),
      bids: [bid(1, 13)],
    });
    const aiWins = stepN(h9Game.step(aiBid, press(0, CALL)), LOCK_TICKS + RESULT_TICKS);
    expect(aiWins.wins).toEqual([0, 1]);
    const aiLies = { ...aiBid, S: 16, bids: [bid(1, 16)] };
    const humanWins = stepN(h9Game.step(aiLies, press(0, CALL)), LOCK_TICKS + RESULT_TICKS);
    expect(humanWins.wins).toEqual([1, 0]);
  });

  it('7. 結算之後：這回合寫進 past（兩邊的骰子、這回合所有喊價、誰抓、喊的人有沒有贏），換下一回合：先喊的人交替、新骰子、喊價歸 4', () => {
    const s = choosing({
      round: 1,
      first: 0,
      turn: 1,
      S: 14,
      bidder: 0,
      dice: dice([3, 4], [2, 5]),
      bids: [bid(0, 6), bid(1, 8), bid(0, 14)],
    });
    const done = stepN(h9Game.step(s, press(1, CALL)), LOCK_TICKS + RESULT_TICKS);
    expect(done.past).toHaveLength(1);
    expect(done.past[0]).toEqual({
      dice: [
        [3, 4],
        [2, 5],
      ],
      bids: [bid(0, 6), bid(1, 8), bid(0, 14)],
      challenger: 1,
      bidderWon: true,
    });
    expect(done.round).toBe(2);
    expect(done.first).toBe(1);
    expect(done.turn).toBe(1);
    expect(done.S).toBe(S0);
    expect(done.bidder).toBeNull();
    expect(done.bids).toEqual([]);
    expect(done.lock).toBeNull();
    expect(done.phase).toBe('prep');
    expect(done.wait).toBe(AI_WAIT_TICKS);
    expect(done.rng).not.toBe(s.rng);
    expect(done.over).toBe(false);
    // 第 3 回合又換回人先、人先就不用等
    const next = stepN(
      h9Game.step(
        { ...done, phase: 'choose', wait: 0, S: 5, bidder: 1, bids: [bid(1, 5)], turn: 0 },
        press(0, CALL),
      ),
      LOCK_TICKS + RESULT_TICKS,
    );
    expect(next.round).toBe(3);
    expect(next.first).toBe(0);
    expect(next.turn).toBe(0);
    expect(next.phase).toBe('choose');
  });

  it('8. 每個回合都擲新的骰子（1 到 6），同一個種子擲出同樣的骰子；不同回合的骰子不全相同', () => {
    const playRound = (state: H9State): H9State => {
      // 目前輪到的人抓前一個人剛喊的價（S = 5）
      const caller = state.turn;
      const other: Side = caller === 0 ? 1 : 0;
      const ready = {
        ...state,
        phase: 'choose' as const,
        wait: 0,
        S: 5,
        bidder: other,
        bids: [bid(other, 5)],
      };
      return stepN(h9Game.step(ready, press(caller, CALL)), LOCK_TICKS + RESULT_TICKS);
    };
    const run = (seed: number): string[] => {
      let s = h9Game.init(seed, CONFIG);
      const rolls = [JSON.stringify(s.dice)];
      for (let r = 0; r < 4 && !s.over; r += 1) {
        s = playRound(s);
        if (!s.over) {
          rolls.push(JSON.stringify(s.dice));
          for (const side of [0, 1] as const) {
            for (const d of s.dice[side]) {
              expect(d).toBeGreaterThanOrEqual(1);
              expect(d).toBeLessThanOrEqual(6);
            }
          }
        }
      }
      return rolls;
    };
    expect(run(11)).toEqual(run(11));
    expect(new Set(run(11)).size).toBeGreaterThan(1);
  });

  it('9. 先贏 3 回合的贏：拿到第 3 場勝利立刻結束、贏家是那一邊、分數是勝場', () => {
    const s = choosing({
      round: 4,
      first: 1,
      wins: [2, 1],
      turn: 1,
      S: 14,
      bidder: 0,
      dice: dice([3, 4], [2, 5]),
      bids: [bid(0, 14)],
    });
    const done = stepN(h9Game.step(s, press(1, CALL)), LOCK_TICKS + RESULT_TICKS);
    expect(done.over).toBe(true);
    expect(done.winner).toBe(0);
    expect(h9Game.isOver(done)).toBe(true);
    expect(h9Game.score(done)).toEqual([3, 1]);
    expect(h9Game.winner(done)).toBe(0);
    expect(done.past).toHaveLength(1);
  });

  it('10. 邊界：2 比 2 打到第 5 回合，這一回合決勝；沒有平手、不會有第 6 回合', () => {
    const base = choosing({
      round: 5,
      first: 0,
      wins: [2, 2],
      turn: 1,
      S: 14,
      bidder: 0,
      dice: dice([3, 4], [2, 5]),
      bids: [bid(0, 14)],
    });
    const humanTakes = stepN(h9Game.step(base, press(1, CALL)), LOCK_TICKS + RESULT_TICKS);
    expect(humanTakes.over).toBe(true);
    expect(humanTakes.winner).toBe(0);
    expect(humanTakes.round).toBe(5);
    const aiTakes = stepN(
      h9Game.step({ ...base, S: 15, bids: [bid(0, 15)] }, press(1, CALL)),
      LOCK_TICKS + RESULT_TICKS,
    );
    expect(aiTakes.over).toBe(true);
    expect(aiTakes.winner).toBe(1);
    expect(h9Game.score(aiTakes)).toEqual([2, 3]);
  });

  it('11. 邊界：喊價 24 是上限。超過 24 的鍵沒有效；S = 23 只能 ←；S = 24 只能抓', () => {
    const at23 = choosing({ turn: 0, S: 23, bidder: 1, bids: [bid(1, 23)] });
    expect(h9Game.step(at23, press(0, PLUS2)).phase).toBe('choose');
    expect(h9Game.step(at23, press(0, PLUS3)).phase).toBe('choose');
    expect(h9Game.step(at23, press(0, PLUS1)).S).toBe(24);
    const at22 = { ...at23, S: 22, bids: [bid(1, 22)] };
    expect(h9Game.step(at22, press(0, PLUS3)).phase).toBe('choose');
    expect(h9Game.step(at22, press(0, PLUS2)).S).toBe(24);
    const at24 = choosing({ turn: 0, S: 24, bidder: 1, bids: [bid(1, 24)] });
    for (const key of [PLUS1, PLUS2, PLUS3]) {
      expect(h9Game.step(at24, press(0, key)).phase).toBe('choose');
    }
    expect(h9Game.step(at24, press(0, CALL)).lock).toBe('call');
  });

  it('12. 邊界：喊價剛好等於總和是真的（喊的人贏）；差 1 是假的', () => {
    for (const [S, bidderWins] of [
      [14, true],
      [15, false],
      [5, true],
    ] as const) {
      const s = choosing({
        turn: 1,
        S,
        bidder: 0,
        dice: dice([3, 4], [2, 5]),
        bids: [bid(0, S)],
      });
      const done = stepN(h9Game.step(s, press(1, CALL)), LOCK_TICKS + RESULT_TICKS);
      expect(done.past[0]?.bidderWon, `S = ${S}`).toBe(bidderWins);
    }
  });

  it('13. 同時按多個鍵：b 最優先，其次 ←、↑、→；不是這一邊的回合，輸入被忽略', () => {
    const s = choosing({ turn: 0, S: 10, bidder: 1, bids: [bid(1, 10)] });
    const all = { ...IDLE, left: true, up: true, right: true, b: true };
    expect(h9Game.step(s, press(0, all)).lock).toBe('call');
    expect(h9Game.step(s, press(0, { ...all, b: false })).S).toBe(11);
    expect(h9Game.step(s, press(0, { ...all, b: false, left: false })).S).toBe(12);
    // 不是 1 的回合：1 按什麼都沒有用
    const ignored = h9Game.step(s, press(1, all));
    expect(ignored.phase).toBe('choose');
    expect(ignored.S).toBe(10);
    expect(ignored.idle).toBe(1);
  });

  it('14. 超時：choose 閒置到第 DECISION_TIMEOUT 個 tick 自動「抓」；沒人喊過就自動加 1；那個 tick 按了鍵算按了', () => {
    const called = choosing({
      turn: 0,
      S: 10,
      bidder: 1,
      bids: [bid(1, 10)],
      idle: DECISION_TIMEOUT - 2,
    });
    const stillWaiting = h9Game.step(called, idle());
    expect(stillWaiting.phase).toBe('choose');
    expect(stillWaiting.idle).toBe(DECISION_TIMEOUT - 1);
    const timeout = h9Game.step(stillWaiting, idle());
    expect(timeout.phase).toBe('locked');
    expect(timeout.lock).toBe('call');

    const opening = choosing({ turn: 0, S: 4, bidder: null, idle: DECISION_TIMEOUT - 1 });
    const autoRaise = h9Game.step(opening, idle());
    expect(autoRaise.lock).toBe('raise');
    expect(autoRaise.S).toBe(5);
    expect(autoRaise.bids).toEqual([bid(0, 5)]);

    const justInTime = h9Game.step(called, idle());
    const pressed = h9Game.step({ ...justInTime }, press(0, PLUS3));
    expect(pressed.S).toBe(13);
    expect(pressed.lock).toBe('raise');
  });

  it('15. 超時的邊界：喊價 24 時沒有加價可選，超時自動抓', () => {
    const s = choosing({
      turn: 0,
      S: 24,
      bidder: 1,
      bids: [bid(1, 24)],
      idle: DECISION_TIMEOUT - 1,
    });
    expect(h9Game.step(s, idle()).lock).toBe('call');
  });

  it('16. 時間到（第 maxTicks 個 tick）：比目前的勝場，多的贏，一樣多平手', () => {
    const lead = choosing({ maxTicks: 100, tick: 99, wins: [1, 0] });
    const ended = h9Game.step(lead, idle());
    expect(ended.over).toBe(true);
    expect(ended.winner).toBe(0);
    const tie = choosing({ maxTicks: 100, tick: 99, wins: [1, 1] });
    const tied = h9Game.step(tie, idle());
    expect(tied.over).toBe(true);
    expect(tied.winner).toBeNull();
  });

  it('17. step 不改動傳進來的 state 與輸入：各階段深度凍結都不丟錯', () => {
    const states: H9State[] = [
      makeState({ phase: 'prep', wait: AI_WAIT_TICKS, turn: 1 }),
      choosing({ turn: 0, S: 9, bidder: 1, bids: [bid(1, 9)] }),
      h9Game.step(choosing({ turn: 0, S: 9, bidder: 1, bids: [bid(1, 9)] }), press(0, PLUS2)),
      h9Game.step(choosing({ turn: 0, S: 9, bidder: 1, bids: [bid(1, 9)] }), press(0, CALL)),
      stepN(
        h9Game.step(choosing({ turn: 0, S: 9, bidder: 1, bids: [bid(1, 9)] }), press(0, CALL)),
        LOCK_TICKS,
      ),
    ];
    for (const s of states) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(s)) as H9State);
      const before = hashState(frozen);
      const inputs = deepFreeze([
        { ...IDLE, b: true },
        { ...IDLE, left: true },
      ]) as unknown as Inputs;
      h9Game.step(frozen, inputs);
      expect(hashState(frozen)).toBe(before);
    }
    // 結算的那一步（換回合、擲骰）也不改動
    const bank = stepN(
      h9Game.step(choosing({ turn: 0, S: 9, bidder: 1, bids: [bid(1, 9)] }), press(0, CALL)),
      LOCK_TICKS + RESULT_TICKS - 1,
    );
    const frozen = deepFreeze(JSON.parse(JSON.stringify(bank)) as H9State);
    const before = hashState(frozen);
    h9Game.step(frozen, idle());
    expect(hashState(frozen)).toBe(before);
  });

  it('18. 整場 JSON 來回不變、同種子重跑一樣、不同種子不一樣', () => {
    const run = (seed: number): { hashes: string[]; final: H9State } => {
      let s = h9Game.init(seed, CONFIG);
      const hashes: string[] = [];
      for (let t = 0; t < 1500 && !s.over; t += 1) {
        const inputs: Inputs =
          t % 40 === 0
            ? [
                { ...IDLE, left: true },
                { ...IDLE, up: true },
              ]
            : t % 53 === 0
              ? [
                  { ...IDLE, b: true },
                  { ...IDLE, b: true },
                ]
              : idle();
        s = h9Game.step(s, inputs);
        const copy = JSON.parse(JSON.stringify(s)) as H9State;
        expect(hashState(copy)).toBe(hashState(s));
        hashes.push(hashState(s));
      }
      return { hashes, final: s };
    };
    const a = run(4);
    const b = run(4);
    expect(a.hashes).toEqual(b.hashes);
    expect(run(5).hashes).not.toEqual(a.hashes);
  });

  it('19. 結束之後 step 原樣回傳；winner 在結束前是 null', () => {
    const live = choosing({ wins: [2, 1] });
    expect(h9Game.winner(live)).toBeNull();
    const over = choosing({ over: true, winner: 1, wins: [1, 3] });
    expect(h9Game.step(over, press(0, CALL))).toBe(over);
    expect(h9Game.winner(over)).toBe(1);
  });

  it('20. 全程不卡住：兩個亂按的控制器打得完一整場，勝場有一邊到 3', () => {
    for (const seed of [1, 2, 3]) {
      const result = playMatch(
        h9Game,
        seed,
        CONFIG,
        levelController(h9Game, random, 5, seed),
        levelController(h9Game, random, 5, seed + 100),
      );
      expect(result.ticks).toBeLessThanOrEqual(3600);
      expect(Math.max(...result.score)).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

describe('H-9 吹牛骰｜actions 與 evaluate', () => {
  it('自己的回合、choose：[← , ↑ , →, b]，加 1 排第一；S = 4 沒有 b；超過 24 的鍵不列', () => {
    const mid = choosing({ turn: 0, S: 10, bidder: 1 });
    expect(h9Game.actions(mid, 0).map(nameOf)).toEqual(['plus1', 'plus2', 'plus3', 'call']);
    const open = choosing({ turn: 0, S: 4, bidder: null });
    expect(h9Game.actions(open, 0).map(nameOf)).toEqual(['plus1', 'plus2', 'plus3']);
    expect(h9Game.actions(choosing({ turn: 0, S: 22, bidder: 1 }), 0).map(nameOf)).toEqual([
      'plus1',
      'plus2',
      'call',
    ]);
    expect(h9Game.actions(choosing({ turn: 0, S: 23, bidder: 1 }), 0).map(nameOf)).toEqual([
      'plus1',
      'call',
    ]);
    expect(h9Game.actions(choosing({ turn: 0, S: 24, bidder: 1 }), 0).map(nameOf)).toEqual([
      'call',
    ]);
  });

  it('不是自己的回合、prep、locked、reveal、結束：只有 [全放開]', () => {
    const mine = choosing({ turn: 0, S: 10, bidder: 1 });
    expect(h9Game.actions(mine, 1)).toEqual([IDLE]);
    for (const phase of ['prep', 'locked', 'reveal'] as const) {
      expect(h9Game.actions({ ...mine, phase }, 0)).toEqual([IDLE]);
    }
    expect(h9Game.actions({ ...mine, over: true }, 0)).toEqual([IDLE]);
  });

  it('每一個動作都是 step 認得的：沒有一個 action 會讓 choose 原地不動', () => {
    for (const S of [4, 5, 10, 22, 23, 24]) {
      const s = choosing({ turn: 0, S, bidder: S === 4 ? null : 1 });
      for (const action of h9Game.actions(s, 0)) {
        expect(h9Game.step(s, press(0, action)).phase, `S = ${S}`).toBe('locked');
      }
    }
  });

  it('evaluate：各階段 gain 有限、danger 在 0 到 1；結束的局有勝負加成 ±1000', () => {
    const base = aiToAct({ wins: [1, 0] });
    const states: H9State[] = [
      base,
      { ...base, phase: 'prep', wait: AI_WAIT_TICKS },
      h9Game.step(base, press(1, PLUS1)),
      h9Game.step(base, press(1, CALL)),
      stepN(h9Game.step(base, press(1, CALL)), LOCK_TICKS),
      stepN(h9Game.step(base, press(1, PLUS2)), LOCK_TICKS),
      choosing({ turn: 0, S: 4, bidder: null }),
      choosing({ turn: 1, S: 24, bidder: 0 }),
    ];
    for (const s of states) {
      for (const side of [0, 1] as const) {
        const e = h9Game.evaluate(s, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
    const won = choosing({ over: true, winner: 1, wins: [1, 3] });
    expect(h9Game.evaluate(won, 1).gain).toBeGreaterThan(900);
    expect(h9Game.evaluate(won, 0).gain).toBeLessThan(-900);
    const tied = choosing({ over: true, winner: null, wins: [2, 2] });
    expect(h9Game.evaluate(tied, 0).gain).toBe(0);
  });

  it('evaluate：勝場領先越多 gain 越大（單調；這裡看的是 AI（1）那一邊）', () => {
    const at = (wins: [number, number]): number =>
      h9Game.evaluate(h9Game.step(aiToAct({ wins }), press(1, PLUS1)), 1).gain;
    expect(at([2, 0])).toBeLessThan(at([1, 0]));
    expect(at([1, 0])).toBeLessThan(at([0, 0]));
    expect(at([0, 0])).toBeLessThan(at([0, 1]));
    expect(at([0, 1])).toBeLessThan(at([0, 2]));
  });
});

// ---------------------------------------------------------------------------
// 這一邊看得到什麼：後驗、虛報量、對方抓的習慣
// ---------------------------------------------------------------------------

describe('H-9 吹牛骰｜對手模型（後驗、虛報量、抓的習慣）', () => {
  it('priorSums：兩顆骰子的總和分佈（2 到 12，7 最多），加起來是 1', () => {
    const p = priorSums();
    expect(p).toHaveLength(13);
    expect(p[0]).toBe(0);
    expect(p[1]).toBe(0);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(p[7]).toBeCloseTo(6 / 36, 12);
    expect(p[2]).toBeCloseTo(1 / 36, 12);
    expect(p[12]).toBeCloseTo(1 / 36, 12);
  });

  it('bluffMargin：沒有紀錄是先驗 1.5；每一回合一票（先驗也算一票）；誠實的紀錄把它拉向 0', () => {
    expect(bluffMargin([], 0)).toBe(1.5);
    // 人（0）最後一次喊 11，他自己的兩顆骰子加起來是 4：虛報量 11 − 7 − 4 = 0（誠實）
    const honest = (): H9Past =>
      past(dice([2, 2], [3, 4]), [bid(0, 6), bid(1, 8), bid(0, 11)], 1, false);
    expect(bluffMargin([honest()], 0)).toBeCloseTo((1.5 + 0) / 2, 12);
    expect(bluffMargin([honest(), honest(), honest()], 0)).toBeCloseTo(1.5 / 4, 12);
  });

  it('bluffMargin：愛虛報的紀錄讓它變大；窗口只有最近 3 回合；對方沒喊過價的回合不算', () => {
    // 人最後喊 14、自己的骰子加起來 4：虛報量 3
    const liar = (): H9Past =>
      past(dice([2, 2], [3, 4]), [bid(0, 6), bid(1, 8), bid(0, 14)], 1, true);
    const honest = (): H9Past =>
      past(dice([2, 2], [3, 4]), [bid(0, 6), bid(1, 8), bid(0, 11)], 1, false);
    expect(bluffMargin([liar(), liar(), liar()], 0)).toBeCloseTo((1.5 + 9) / 4, 12);
    expect(bluffMargin([liar(), liar(), liar()], 0)).toBeGreaterThan(bluffMargin([honest()], 0));
    // 更早的回合被擠出去：最近 3 回合都誠實，更早的 4 個騙局不算
    expect(bluffMargin([liar(), liar(), liar(), honest(), honest(), honest()], 0)).toBeCloseTo(
      1.5 / 4,
      12,
    );
    // 對方（人）沒有喊過價的回合（AI 先喊、人馬上抓）不算一票
    const noBid = past(dice([2, 2], [3, 4]), [bid(1, 5)], 0, true);
    expect(bluffMargin([noBid], 0)).toBe(1.5);
    expect(bluffMargin([honest(), noBid], 0)).toBeCloseTo(bluffMargin([honest()], 0), 12);
    // 看的是指定那一邊的喊價
    expect(bluffMargin([honest()], 1)).not.toBe(bluffMargin([honest()], 0));
  });

  it('callRates：沒有紀錄是先驗；觀察到對方在某個區間抓了或沒抓，那一區的機率跟著變，其他區不動', () => {
    const [p0, p1, p2] = callRates([], 1);
    expect(p0).toBeLessThan(p1);
    expect(p1).toBeLessThan(p2);
    // AI（1）喊 8、人（0）加到 9、AI 喊 12、人抓。人的骰子加起來是 4（7 + 4 = 11）：
    // AI 的喊價離人的 11 有 −3、+1：8 → 區間 0（沒抓），12 → 區間 1（抓了）
    const record = past(dice([2, 2], [3, 4]), [bid(1, 8), bid(0, 9), bid(1, 12)], 0, false);
    const [r0, r1, r2] = callRates([record], 1);
    expect(r0).toBeLessThan(p0);
    expect(r1).toBeGreaterThan(p1);
    expect(r2).toBeCloseTo(p2, 12);
  });

  it('callRates：窗口只看最近 3 回合', () => {
    const calledAt1 = past(dice([2, 2], [3, 4]), [bid(1, 12)], 0, false);
    const quiet = past(dice([2, 2], [3, 4]), [bid(1, 5), bid(0, 6), bid(1, 7)], 1, false);
    const [with1] = callRates([calledAt1], 1);
    expect(with1).toBeDefined();
    const old = callRates([calledAt1, quiet, quiet, quiet], 1);
    const none = callRates([quiet, quiet, quiet], 1);
    expect(old).toEqual(none);
  });

  it('oppPosterior：沒有對方的喊價時等於先驗；機率加起來是 1，只有 2 到 12', () => {
    const s = aiToAct({ bids: [bid(1, 5)], S: 5, bidder: 1 });
    const post = oppPosterior(s, 1);
    const prior = priorSums();
    for (let b = 0; b <= 12; b += 1) {
      expect(post[b]).toBeCloseTo(prior[b] as number, 12);
    }
  });

  it('oppPosterior：對方喊得越高，它的兩顆骰子越可能大（單調）；加起來是 1', () => {
    const mean = (S: number): number => {
      const s = aiToAct({ S, bids: [bid(0, 5), bid(1, 6), bid(0, S)] });
      const post = oppPosterior(s, 1);
      expect(post.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      return post.reduce((total, p, b) => total + p * b, 0);
    };
    expect(mean(10)).toBeLessThan(mean(13));
    expect(mean(13)).toBeLessThan(mean(16));
    expect(mean(16)).toBeLessThan(mean(19));
  });

  it('oppPosterior：對方的紀錄愛虛報（δ̂ 大）時，同一個喊價代表的骰子比較小', () => {
    const state = (history: readonly H9Past[]): H9State =>
      aiToAct({ S: 16, bids: [bid(0, 5), bid(1, 6), bid(0, 16)], past: history });
    const liar = (): H9Past =>
      past(dice([2, 2], [3, 4]), [bid(0, 6), bid(1, 8), bid(0, 14)], 1, true);
    const honest = (): H9Past =>
      past(dice([2, 2], [3, 4]), [bid(0, 6), bid(1, 8), bid(0, 11)], 1, false);
    const meanOf = (s: H9State): number =>
      oppPosterior(s, 1).reduce((total, p, b) => total + p * b, 0);
    expect(meanOf(state([liar(), liar(), liar()]))).toBeLessThan(
      meanOf(state([honest(), honest(), honest()])),
    );
  });

  it('trueChance：我的骰子越大，同一個喊價越可能是真的；喊價越高越不可能；喊價 ≤ 我的總和 + 2 一定是真的', () => {
    const at = (mine: [number, number], S: number): number =>
      trueChance(aiToAct({ dice: dice([3, 4], mine), S, bids: [bid(0, S)] }), 1, S);
    expect(at([6, 6], 14)).toBeGreaterThan(at([1, 1], 14));
    expect(at([3, 3], 12)).toBeGreaterThan(at([3, 3], 14));
    expect(at([3, 3], 14)).toBeGreaterThan(at([3, 3], 16));
    expect(at([6, 6], 14)).toBeCloseTo(1, 12);
    expect(at([1, 1], 15)).toBeCloseTo(0, 12);
    for (let S = 4; S <= 24; S += 1) {
      const p = at([3, 4], S);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('callChance：對方抓的紀錄越多，對同一個喊價它會抓的機率越高', () => {
    const state = (history: readonly H9Past[]): H9State =>
      choosing({
        turn: 0,
        first: 1,
        S: 14,
        bidder: 1,
        dice: dice([3, 4], [2, 3]),
        bids: [bid(1, 5), bid(0, 6), bid(1, 14)],
        past: history,
      });
    // AI（1）喊價，人（0）每次都抓 / 每次都加價。人的骰子加起來是 7：他的「自己 + 7」是 14
    const alwaysCalls = (): H9Past => past(dice([3, 4], [2, 3]), [bid(1, 14)], 0, false);
    const neverCalls = (): H9Past =>
      past(dice([3, 4], [2, 3]), [bid(1, 14), bid(0, 15), bid(1, 16), bid(0, 17)], 1, false);
    const calling = callChance(state([alwaysCalls(), alwaysCalls(), alwaysCalls()]), 1, 14);
    const quiet = callChance(state([neverCalls(), neverCalls(), neverCalls()]), 1, 14);
    expect(calling).toBeGreaterThan(quiet + 0.1);
    expect(calling).toBeLessThanOrEqual(1);
    expect(quiet).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 不偷看
// ---------------------------------------------------------------------------

interface PeekCase {
  readonly name: string;
  readonly side: Side;
  readonly base: H9State;
  /** 只有隱藏資訊（對方的骰子、下一回合的骰子 rng）不同的變體。 */
  readonly variants: readonly H9State[];
}

/** 對方（`opp`）的骰子的所有不同總和（2 到 12）的代表，加上幾種拆法。 */
const OPP_DICE: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, 2],
  [2, 2],
  [1, 4],
  [3, 3],
  [3, 4],
  [4, 4],
  [6, 2],
  [5, 5],
  [6, 4],
  [6, 5],
  [6, 6],
];

/** 公開背景：過去的回合、這回合的喊價、勝場。 */
const BACKGROUNDS: readonly Partial<H9State>[] = [
  { round: 1, wins: [0, 0], past: [] },
  {
    round: 3,
    first: 0,
    wins: [1, 1],
    past: [
      past(dice([2, 2], [3, 4]), [bid(0, 6), bid(1, 8), bid(0, 11)], 1, false),
      past(dice([5, 6], [1, 2]), [bid(1, 5), bid(0, 8), bid(1, 12)], 0, false),
    ],
  },
  {
    round: 5,
    first: 0,
    wins: [2, 2],
    past: [
      past(dice([2, 2], [6, 6]), [bid(0, 8), bid(1, 11), bid(0, 14)], 1, false),
      past(dice([5, 6], [1, 2]), [bid(1, 5), bid(0, 8), bid(1, 12)], 0, false),
      past(dice([6, 6], [1, 1]), [bid(0, 12), bid(1, 13)], 0, true),
      past(dice([3, 4], [3, 4]), [bid(1, 9), bid(0, 12), bid(1, 14)], 0, true),
    ],
  },
];

function peekCases(): PeekCase[] {
  const cases: PeekCase[] = [];
  for (const [bi, bg] of BACKGROUNDS.entries()) {
    // A. AI（1）在 choose：人的骰子與下一回合的骰子（rng）都不可以讀
    for (const S of [8, 12, 16]) {
      const base = aiToAct({ ...bg, S, bids: [bid(0, 5), bid(1, 7), bid(0, S)] });
      cases.push({
        name: `AI 的 choose S=${S} 背景 ${bi}：人的骰子與 rng`,
        side: 1,
        base,
        variants: [
          ...OPP_DICE.map((d) => ({ ...base, dice: dice(d, base.dice[1]) })),
          { ...base, rng: base.rng + 1 },
          { ...base, rng: base.rng + 99_999 },
        ],
      });
    }
    // B. AI 在 prep（等 45 tick）
    const prep = aiToAct({ ...bg, phase: 'prep', wait: AI_WAIT_TICKS });
    cases.push({
      name: `AI 的 prep 背景 ${bi}：人的骰子`,
      side: 1,
      base: prep,
      variants: OPP_DICE.map((d) => ({ ...prep, dice: dice(d, prep.dice[1]) })),
    });
    // C. 鎖定中（AI 剛加價、剛抓）：兩邊都不可以讀對方的骰子
    for (const lock of ['raise', 'call'] as const) {
      const locked = aiToAct({
        ...bg,
        phase: 'locked',
        wait: LOCK_TICKS,
        lock,
        S: 13,
        bids: lock === 'raise' ? [bid(0, 5), bid(1, 13)] : [bid(0, 5), bid(1, 7), bid(0, 13)],
        bidder: lock === 'raise' ? 1 : 0,
      });
      cases.push({
        name: `AI locked ${lock} 背景 ${bi}：人的骰子`,
        side: 1,
        base: locked,
        variants: OPP_DICE.map((d) => ({ ...locked, dice: dice(d, locked.dice[1]) })),
      });
    }
    // D. 亮骰階段（AI 抓、人抓）：亮出來的骰子 evaluate 也不可以讀（只讀 past 裡已經公開的）
    for (const caller of [0, 1] as const) {
      const reveal = aiToAct({
        ...bg,
        phase: 'reveal',
        wait: RESULT_TICKS,
        lock: 'call',
        turn: caller,
        bidder: caller === 1 ? 0 : 1,
        S: 14,
        bids: [bid(0, 5), bid(1, 7), bid(caller === 1 ? 0 : 1, 14)],
      });
      for (const side of [0, 1] as const) {
        const other = side === 0 ? 1 : 0;
        cases.push({
          name: `reveal 抓的人 ${caller} 背景 ${bi} 側 ${side}：對方的骰子`,
          side,
          base: reveal,
          variants: OPP_DICE.map((d) => ({
            ...reveal,
            dice: (other === 0 ? dice(d, reveal.dice[1]) : dice(reveal.dice[0], d)) as Dice,
          })),
        });
      }
    }
    // E. 對方（人）的回合、AI 剛喊價：人的骰子不可以讀（含人在 prep／choose）
    for (const phase of ['choose'] as const) {
      const theirs = choosing({
        ...bg,
        phase,
        turn: 0,
        first: 1,
        S: 13,
        bidder: 1,
        dice: dice([3, 4], [2, 5]),
        bids: [bid(1, 5), bid(0, 8), bid(1, 13)],
      });
      cases.push({
        name: `人的回合 ${phase} 背景 ${bi}：人的骰子與 rng`,
        side: 1,
        base: theirs,
        variants: [
          ...OPP_DICE.map((d) => ({ ...theirs, dice: dice(d, theirs.dice[1]) })),
          { ...theirs, rng: theirs.rng + 7 },
        ],
      });
    }
    // F. 對稱：人側也不可以讀 AI 的骰子（AI 剛喊價、輪到人）
    const humanView = choosing({
      ...bg,
      turn: 0,
      first: 1,
      S: 13,
      bidder: 1,
      dice: dice([3, 4], [2, 5]),
      bids: [bid(1, 5), bid(0, 8), bid(1, 13)],
    });
    cases.push({
      name: `人側 choose 背景 ${bi}：AI 的骰子`,
      side: 0,
      base: humanView,
      variants: OPP_DICE.map((d) => ({ ...humanView, dice: dice(humanView.dice[0], d) })),
    });
  }
  return cases;
}

/** 只有隱藏資訊不同的變體，`game` 的 evaluate 或 actions 有任何一個不同，就是偷看。 */
function peeks(
  game: Game<H9State>,
  base: H9State,
  variants: readonly H9State[],
  side: Side,
): boolean {
  const expected = JSON.stringify([game.evaluate(base, side), game.actions(base, side)]);
  return variants.some(
    (v) => JSON.stringify([game.evaluate(v, side), game.actions(v, side)]) !== expected,
  );
}

describe('H-9 吹牛骰｜不偷看（evaluate 與 actions 只讀這一邊看得到的）', () => {
  it('每一個隱藏資訊的情境：只有隱藏資訊不同的兩個 state，evaluate 與 actions 完全相同', () => {
    for (const c of peekCases()) {
      expect(peeks(h9Game, c.base, c.variants, c.side), c.name).toBe(false);
    }
  });

  it('這一邊讀的後驗與機率（oppPosterior、trueChance、callChance）也只由看得到的東西決定', () => {
    for (const c of peekCases()) {
      const look = (st: H9State): unknown => [
        oppPosterior(st, c.side),
        trueChance(st, c.side, st.S),
        callChance(st, c.side, st.S),
      ];
      const expected = look(c.base);
      for (const v of c.variants) {
        expect(look(v), c.name).toEqual(expected);
      }
    }
  });

  it('只有「自己的骰子」不同：這一條不該被禁止（evaluate 讀得到自己的骰子，而且骰子大小有影響）', () => {
    const base = aiToAct({ S: 13, bids: [bid(0, 5), bid(1, 7), bid(0, 13)] });
    const strong = { ...base, dice: dice(base.dice[0], [6, 6]) };
    const weak = { ...base, dice: dice(base.dice[0], [1, 1]) };
    expect(trueChance(strong, 1, 13)).toBeGreaterThan(trueChance(weak, 1, 13));
    expect(h9Game.evaluate(h9Game.step(strong, press(1, CALL)), 1)).not.toEqual(
      h9Game.evaluate(h9Game.step(weak, press(1, CALL)), 1),
    );
  });

  it('偵測器本身有效：故意洩漏（讀對方的骰子、讀亮骰階段的骰子、讀 rng）一定被抓到', () => {
    const oppSum = (s: H9State, side: Side): number => {
      const o = s.dice[side === 0 ? 1 : 0];
      return o[0] + o[1];
    };
    const leaks: Record<string, (s: H9State, side: Side) => number> = {
      '讀對方的骰子（choose）': (s, side) => (s.phase === 'choose' ? 0.001 * oppSum(s, side) : 0),
      '讀對方的骰子（locked）': (s, side) => (s.phase === 'locked' ? 0.001 * oppSum(s, side) : 0),
      '讀對方的骰子（prep）': (s, side) => (s.phase === 'prep' ? 0.001 * oppSum(s, side) : 0),
      讀亮骰階段亮出來的骰子: (s, side) => (s.phase === 'reveal' ? 0.001 * oppSum(s, side) : 0),
      讀下一回合的骰子所在的亂數: (s) => 0.000001 * (s.rng % 1000),
    };
    const cases = peekCases();
    for (const [name, extra] of Object.entries(leaks)) {
      const leaky: Game<H9State> = {
        ...h9Game,
        evaluate: (s, side) => {
          const e = h9Game.evaluate(s, side);
          return { gain: e.gain + extra(s, side), danger: e.danger };
        },
      };
      const caught = cases.some((c) => peeks(leaky, c.base, c.variants, c.side));
      expect(caught, `沒抓到洩漏：${name}`).toBe(true);
    }
    // 讀 actions 的洩漏也抓得到：對方骰子總和 12 時多給一個動作
    const leakyActions: Game<H9State> = {
      ...h9Game,
      actions: (s, side) =>
        oppSum(s, side) === 12 ? [...h9Game.actions(s, side), IDLE] : h9Game.actions(s, side),
    };
    expect(cases.some((c) => peeks(leakyActions, c.base, c.variants, c.side))).toBe(true);
  });

  it('黑箱：四個性格在深度 1、3、6，只有對方的骰子（與 rng）不同的 choose 局面，按的鍵都相同', () => {
    for (const bg of BACKGROUNDS) {
      for (const S of [6, 9, 12, 15, 18]) {
        const base = aiToAct({
          ...bg,
          S,
          bids: [bid(0, 5), bid(1, 6), bid(0, S)],
          dice: dice([3, 4], [3, 4]),
        });
        for (const policy of POLICIES) {
          for (const depth of [1, 3, 6]) {
            const expected = nameOf(decideWith(policy, depth, base, 1));
            for (const d of OPP_DICE) {
              expect(
                nameOf(decideWith(policy, depth, { ...base, dice: dice(d, base.dice[1]) }, 1)),
                `${policy.name} 深度 ${depth} S=${S} 人的骰子 ${d.join(',')}`,
              ).toBe(expected);
            }
            for (const rng of [base.rng + 1, base.rng + 12345, 1, 987654321]) {
              expect(nameOf(decideWith(policy, depth, { ...base, rng }, 1))).toBe(expected);
            }
          }
        }
      }
    }
  });

  it('黑箱也抓得到「只有 decide 那一層才看得出來」的洩漏：亮骰階段的估值讀了亮出來的骰子（深度 3 以上走得到亮骰）', () => {
    const leaky: Game<H9State> = {
      ...h9Game,
      evaluate: (s, side) => {
        const e = h9Game.evaluate(s, side);
        if (s.phase !== 'reveal') {
          return e;
        }
        const total = s.dice[0][0] + s.dice[0][1] + s.dice[1][0] + s.dice[1][1];
        const bidderWon = total >= s.S;
        const iAmBidder = s.bidder === side;
        // 洩漏：知道結果，所以沒有風險
        return { gain: e.gain + (iAmBidder === bidderWon ? 5 : -5), danger: 0 };
      },
    };
    const decide = (state: H9State, depth: number): string =>
      nameOf(
        wrapPolicy(
          leaky,
          pathfinder,
          { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
          7,
        ).decide(state, 1, 0),
      );
    // 在根的 state 上，evaluate 與 actions 沒有破綻（這就是為什麼只測它們不夠）
    const base = aiToAct({ S: 12, bids: [bid(0, 5), bid(1, 7), bid(0, 12)] });
    const loud = { ...base, dice: dice([6, 6], base.dice[1]) };
    const quiet = { ...base, dice: dice([1, 1], base.dice[1]) };
    expect(peeks(leaky, base, [loud, quiet], 1)).toBe(false);
    // 深度 3 走得到亮骰，決定就會跟著人的骰子變
    expect(decide(loud, 3)).not.toBe(decide(quiet, 3));
    expect(decide(loud, 6)).not.toBe(decide(quiet, 6));
    // 深度 1、2 走不到亮骰，不受影響
    expect(decide(loud, 1)).toBe(decide(quiet, 1));
    expect(decide(loud, 2)).toBe(decide(quiet, 2));
  });

  it('結算在 AI 的模擬範圍之外：從 choose 抓走 6 步（最深的搜尋）仍在 reveal，勝場與 past 都沒動', () => {
    const s = aiToAct({ S: 12, bids: [bid(0, 5), bid(1, 7), bid(0, 12)] });
    let t = h9Game.step(s, press(1, CALL));
    for (let i = 1; i < 6; i += 1) {
      t = h9Game.step(t, idle());
    }
    expect(t.phase).toBe('reveal');
    expect(t.wins).toEqual(s.wins);
    expect(t.past).toEqual(s.past);
    // 只有骰子不同的兩個局面，走 6 步之後的 state 除了骰子之外完全相同
    const other = { ...s, dice: dice([6, 6], s.dice[1]) };
    let u = h9Game.step(other, press(1, CALL));
    for (let i = 1; i < 6; i += 1) {
      u = h9Game.step(u, idle());
    }
    expect({ ...u, dice: t.dice }).toEqual(t);
  });
});

// ---------------------------------------------------------------------------
// 等級曲線：動作鎖定 2 tick → 第 3 步
// ---------------------------------------------------------------------------

describe('H-9 吹牛骰｜等級曲線（動作鎖定 2 tick → 第 3 步亮骰或換回合）', () => {
  /** 從 choose 往前走 n 步（我方按 `buttons`、對手不動）。 */
  function after(state: H9State, n: number, buttons: Buttons): H9State {
    let s = h9Game.step(state, press(state.turn, buttons));
    for (let i = 1; i < n; i += 1) {
      s = h9Game.step(s, idle());
    }
    return s;
  }

  it('抓：走 1 步與 2 步還在 locked，第 3 步才是 reveal；加價：第 3 步才換回合', () => {
    const s = aiToAct({ S: 12, bids: [bid(0, 5), bid(1, 7), bid(0, 12)] });
    expect(after(s, 1, CALL).phase).toBe('locked');
    expect(after(s, 2, CALL).phase).toBe('locked');
    expect(after(s, 3, CALL).phase).toBe('reveal');
    expect(after(s, 2, PLUS1).turn).toBe(1);
    expect(after(s, 3, PLUS1).turn).toBe(0);
  });

  /** 兩個後驗相反的情境：人的紀錄愛虛報 / 誠實。 */
  function histories(): { liar: H9State; honest: H9State } {
    const liar = (): H9Past =>
      past(dice([2, 2], [3, 4]), [bid(0, 6), bid(1, 8), bid(0, 15)], 1, true);
    const honest = (): H9Past =>
      past(dice([2, 2], [3, 4]), [bid(0, 6), bid(1, 8), bid(0, 11)], 1, false);
    const make = (h: readonly H9Past[]): H9State =>
      aiToAct({
        round: 4,
        S: 15,
        bids: [bid(0, 5), bid(1, 7), bid(0, 15)],
        dice: dice([3, 4], [3, 4]),
        past: h,
      });
    return {
      liar: make([liar(), liar(), liar()]),
      honest: make([honest(), honest(), honest()]),
    };
  }

  it('locked 是反射：evaluate 完全不用後驗（對方的紀錄、對方的喊價不同，evaluate 相同）；亮骰才讀得到', () => {
    const { liar, honest } = histories();
    const lockedLiar = after(liar, 2, CALL);
    const lockedHonest = after(honest, 2, CALL);
    expect(lockedLiar.phase).toBe('locked');
    expect(h9Game.evaluate(lockedLiar, 1)).toEqual(h9Game.evaluate(lockedHonest, 1));
    const raisedLiar = after(liar, 2, PLUS1);
    const raisedHonest = after(honest, 2, PLUS1);
    expect(h9Game.evaluate(raisedLiar, 1)).toEqual(h9Game.evaluate(raisedHonest, 1));
    const revealLiar = after(liar, 3, CALL);
    const revealHonest = after(honest, 3, CALL);
    expect(revealLiar.phase).toBe('reveal');
    expect(h9Game.evaluate(revealLiar, 1).gain).not.toBe(h9Game.evaluate(revealHonest, 1).gain);
    // 加價之後走到對方的回合（第 3 步）：用 callChance，也讀得到紀錄
    const passLiar = after(liar, 3, PLUS1);
    const passHonest = after(honest, 3, PLUS1);
    expect(h9Game.evaluate(passLiar, 1).gain).not.toBe(h9Game.evaluate(passHonest, 1).gain);
  });

  it('反射規則：只喊自己這組骰子撐得住的（S ≤ 自己的總和 + 7），超過 + 9 就抓', () => {
    // 我的骰子加起來是 8：+7 是 15，+9 是 17
    const mine = (S: number): H9State =>
      aiToAct({ S, bids: [bid(1, 5), bid(0, S)], dice: dice([3, 4], [4, 4]) });
    const gain = (S: number, key: Buttons): number =>
      h9Game.evaluate(after(mine(S), 2, key), 1).gain;
    // 對方喊 8：加 1 變 9，在 15 以內，誠實的加價比不誠實的好
    const honest = after(mine(8), 2, PLUS1);
    const stretchy = after({ ...mine(8), S: 14 }, 2, PLUS3);
    expect(honest.S).toBe(9);
    expect(stretchy.S).toBe(17);
    expect(h9Game.evaluate(honest, 1).gain).toBeGreaterThan(
      h9Game.evaluate({ ...honest, S: 16 }, 1).gain,
    );
    // 抓：對方喊 18（> 8 + 9 = 17）有加成；喊 17 沒有
    expect(gain(18, CALL)).toBeGreaterThan(gain(17, CALL));
    expect(gain(17, CALL)).toBe(gain(10, CALL));
  });

  it('深度 1 與 2 的決定永遠一樣（掃描）；深度 3 以上讀得到紀錄，掃描裡至少有一個局面的決定跟深度 1 不同', () => {
    const { liar, honest } = histories();
    const seen = new Set<string>();
    let differ = 0;
    let total = 0;
    for (const base of [liar, honest]) {
      for (const mine of [
        [1, 1],
        [2, 3],
        [3, 4],
        [5, 5],
        [6, 6],
      ] as const) {
        for (const S of [7, 10, 12, 14, 16, 18, 20]) {
          const state = {
            ...base,
            S,
            bids: [bid(0, 5), bid(1, 6), bid(0, S)],
            dice: dice([3, 4], mine),
          };
          for (const policy of [pathfinder]) {
            const d1 = nameOf(decideWith(policy, 1, state, 1));
            const d2 = nameOf(decideWith(policy, 2, state, 1));
            expect(d2, `S=${S} 我的骰子 ${mine.join(',')}`).toBe(d1);
            const d3 = nameOf(decideWith(policy, 3, state, 1));
            seen.add(d3);
            total += 1;
            differ += d3 === d1 ? 0 : 1;
          }
        }
      }
    }
    expect(total).toBeGreaterThan(50);
    expect(differ).toBeGreaterThan(0);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('深度 1、2：不論對方有什麼紀錄、喊了什麼，決定都一樣（只看自己的骰子與喊價）', () => {
    const { liar, honest } = histories();
    for (const mine of [
      [1, 2],
      [3, 4],
      [6, 5],
    ] as const) {
      for (const S of [9, 13, 17]) {
        const a = { ...liar, S, bids: [bid(0, 5), bid(1, 6), bid(0, S)], dice: dice([3, 4], mine) };
        const b = {
          ...honest,
          S,
          bids: [bid(0, 12), bid(1, 13), bid(0, S)],
          dice: dice([3, 4], mine),
        };
        for (const policy of POLICIES) {
          for (const depth of [1, 2]) {
            expect(nameOf(decideWith(policy, depth, a, 1))).toBe(
              nameOf(decideWith(policy, depth, b, 1)),
            );
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 對手建模：玩家的喊價與抓的紀錄會改變 AI 的決定
// ---------------------------------------------------------------------------

describe('H-9 吹牛骰｜互相讀取：AI 讀你的虛報與你抓的習慣', () => {
  it('同一個局面，對方的紀錄誠實或愛虛報，深度 3 與 6 的 AI 在掃描裡有決定不同的局面', () => {
    const liar = (): H9Past =>
      past(dice([2, 2], [3, 4]), [bid(0, 6), bid(1, 8), bid(0, 15)], 1, true);
    const honest = (): H9Past =>
      past(dice([2, 2], [3, 4]), [bid(0, 6), bid(1, 8), bid(0, 11)], 1, false);
    for (const depth of [3, 6]) {
      let differs = 0;
      for (const mine of [
        [1, 3],
        [2, 4],
        [3, 4],
        [4, 4],
        [5, 5],
      ] as const) {
        for (const S of [8, 10, 12, 14, 16, 18]) {
          const make = (h: readonly H9Past[]): H9State =>
            aiToAct({
              round: 4,
              S,
              bids: [bid(0, 5), bid(1, 6), bid(0, S)],
              dice: dice([3, 4], mine),
              past: h,
            });
          const a = nameOf(decideWith(pathfinder, depth, make([liar(), liar(), liar()]), 1));
          const b = nameOf(decideWith(pathfinder, depth, make([honest(), honest(), honest()]), 1));
          differs += a === b ? 0 : 1;
        }
      }
      expect(differs, `深度 ${depth}`).toBeGreaterThan(0);
    }
  });

  it('對方愛抓的時候，AI 高喊的價值變低；對方從不抓的時候，高喊的價值變高（同一個局面，只換對方抓的紀錄）', () => {
    // AI（1）剛喊了 14（它的骰子加起來才 5，這個價多半是假的）。回合在人（0）手上。
    const state = (history: readonly H9Past[]): H9State =>
      choosing({
        turn: 0,
        first: 1,
        S: 14,
        bidder: 1,
        round: 4,
        wins: [1, 1],
        dice: dice([3, 4], [2, 3]),
        bids: [bid(1, 5), bid(0, 6), bid(1, 14)],
        past: history,
      });
    const alwaysCalls = (): H9Past => past(dice([3, 4], [2, 3]), [bid(1, 14)], 0, false);
    const neverCalls = (): H9Past =>
      past(dice([3, 4], [2, 3]), [bid(1, 14), bid(0, 15), bid(1, 16), bid(0, 17)], 1, false);
    const calling = h9Game.evaluate(state([alwaysCalls(), alwaysCalls(), alwaysCalls()]), 1).gain;
    const quiet = h9Game.evaluate(state([neverCalls(), neverCalls(), neverCalls()]), 1).gain;
    expect(quiet).toBeGreaterThan(calling + 0.05);
  });

  it('AI 的真話（喊價撐得住）在對方愛抓時不吃虧：同樣是對方愛抓，真的喊價的價值高過假的', () => {
    const state = (mine: [number, number]): H9State =>
      choosing({
        turn: 0,
        first: 1,
        S: 12,
        bidder: 1,
        round: 4,
        dice: dice([3, 4], mine),
        bids: [bid(1, 5), bid(0, 6), bid(1, 12)],
        past: [
          past(dice([3, 4], [2, 3]), [bid(1, 14)], 0, false),
          past(dice([3, 4], [2, 3]), [bid(1, 14)], 0, false),
          past(dice([3, 4], [2, 3]), [bid(1, 14)], 0, false),
        ],
      });
    expect(h9Game.evaluate(state([6, 5]), 1).gain).toBeGreaterThan(
      h9Game.evaluate(state([1, 1]), 1).gain,
    );
  });
});

// ---------------------------------------------------------------------------
// 四種性格
// ---------------------------------------------------------------------------

describe('H-9 吹牛骰｜四種性格', () => {
  it('精準型：喊價有七成撐得住才喊；對方的喊價撐得住的機率低於三成才抓', () => {
    // 我的骰子加起來是 3：對方喊 12，那要對方有 9 以上（約 28%）才是真的：抓
    const lowDice = aiToAct({
      S: 12,
      bids: [bid(0, 5), bid(1, 6), bid(0, 12)],
      dice: dice([3, 4], [1, 2]),
    });
    expect(nameOf(decideWith(precise, 1, lowDice, 1))).toBe('call');
    // 我的骰子加起來是 11：對方喊 12 是幾乎一定是真的（只要對方 ≥ 1）：不抓
    const highDice = aiToAct({
      S: 12,
      bids: [bid(0, 5), bid(1, 6), bid(0, 12)],
      dice: dice([3, 4], [5, 6]),
    });
    expect(nameOf(decideWith(precise, 1, highDice, 1))).not.toBe('call');
  });

  it('賭徒型：落後越多，選的動作越冒險（danger 不低於領先時），而且掃描裡至少有一個局面更冒險', () => {
    let strictly = 0;
    for (const mine of [
      [1, 2],
      [2, 4],
      [3, 4],
      [5, 4],
    ] as const) {
      for (const S of [8, 10, 12, 14, 16]) {
        const make = (wins: [number, number]): H9State =>
          aiToAct({
            round: 4,
            wins,
            S,
            bids: [bid(0, 5), bid(1, 6), bid(0, S)],
            dice: dice([3, 4], mine),
          });
        const dangerOf = (wins: [number, number]): number => {
          const s = make(wins);
          const pick = decideWith(gambler, 1, s, 1);
          const next = h9Game.step(s, press(1, pick));
          return h9Game.evaluate(next, 1).danger;
        };
        const behind = dangerOf([2, 0]);
        const ahead = dangerOf([0, 2]);
        expect(behind).toBeGreaterThanOrEqual(ahead - 1e-12);
        strictly += behind > ahead + 1e-9 ? 1 : 0;
      }
    }
    expect(strictly).toBeGreaterThan(0);
  });

  it('貪心型：只看 gain、不看比分——領先與落後的選擇一樣', () => {
    for (const S of [8, 12, 16]) {
      const make = (wins: [number, number]): H9State =>
        aiToAct({ round: 4, wins, S, bids: [bid(0, 5), bid(1, 6), bid(0, S)] });
      expect(nameOf(decideWith(greedy, 1, make([2, 0]), 1))).toBe(
        nameOf(decideWith(greedy, 1, make([0, 2]), 1)),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// AI 能不能玩
// ---------------------------------------------------------------------------

describe('H-9 吹牛骰｜AI 能不能玩', () => {
  it('兩個等級 5 的搜尋型打完一整場：在 maxTicks 之前結束', () => {
    const result = playMatch(
      h9Game,
      21,
      CONFIG,
      levelController(h9Game, pathfinder, 5, 21),
      levelController(h9Game, pathfinder, 5, 22),
    );
    expect(result.ticks).toBeLessThanOrEqual(3600);
    expect(Math.max(...result.score)).toBe(3);
  });

  it('等級 10 的搜尋型對人類模型：20 個種子贏過半（座位輪流）', () => {
    let wins = 0;
    for (let seed = 0; seed < 20; seed += 1) {
      const ai = levelController(h9Game, pathfinder, 10, seed);
      const human = humanModel(h9Game, seed + 1000);
      const aiSide: Side = seed % 2 === 0 ? 0 : 1;
      const r =
        aiSide === 0
          ? playMatch(h9Game, seed, CONFIG, ai, human)
          : playMatch(h9Game, seed, CONFIG, human, ai);
      wins += r.winner === null ? 0.5 : r.winner === aiSide ? 1 : 0;
    }
    expect(wins).toBeGreaterThan(10);
    // 整局對打並行時會超過預設的 5 秒：給明確的時間預算（門檻與種子數都沒動）
  }, 30_000);
});
