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
  CHAIN_PTS,
  DOWN,
  LOCK_TICKS,
  MAX_CHAIN,
  MISS_PENALTY,
  RESULT_TICKS,
  STOP,
  TARGET,
  UP,
  deckOf,
  deckSize,
  h4Game,
  isExtreme,
  makeState,
  stopBias,
  tablePosterior,
  unseenCounts,
  winChance,
} from './logic';
import type { H4Entry, H4State } from './logic';

/**
 * H-4 比大小的規則測試（規則見 `docs/cards/H-4.md`）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 最重要的一組是「不偷看」：蓋著的桌上牌、對方這個回合翻過的牌、還沒入帳的翻牌，AI 都不可以讀；
 * 而且那組測試本身要抓得到洩漏（用故意洩漏的 evaluate 驗證偵測器真的會紅）。
 */

const CONFIG = { maxTicks: 3600, params: {} };

/** 只有 `turn` 那一邊按鍵。 */
function press(side: Side, buttons: Buttons): Inputs {
  return side === 0 ? [buttons, IDLE] : [IDLE, buttons];
}

function idle(): Inputs {
  return [IDLE, IDLE];
}

function stepN(state: H4State, n: number, inputs: Inputs = idle()): H4State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = h4Game.step(s, inputs);
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

/** 完整的牌：1 到 13 各 2 張。 */
const FULL: readonly number[] = Array.from({ length: 13 }, () => 2);

/** 從 `counts` 拿掉一些已經公開的牌。 */
function without(discarded: readonly number[]): number[] {
  const counts = [...FULL];
  for (const rank of discarded) {
    counts[rank - 1] = (counts[rank - 1] as number) - 1;
  }
  return counts;
}

/**
 * 可以強迫「下一張翻出來的是 `flipRank`」的局面：未公開的牌只有桌上牌（`table`）加上兩張 `flipRank`。
 * （`flipRank` 與 `table` 同點時那一點有 3 張，不合真的牌，但規則測試不在乎。）
 */
function forced(table: number, flipRank: number, overrides: Partial<H4State> = {}): H4State {
  const counts = Array.from({ length: 13 }, () => 0);
  counts[table - 1] = (counts[table - 1] as number) + 1;
  counts[flipRank - 1] = (counts[flipRank - 1] as number) + 2;
  return makeState({ phase: 'choose', wait: 0, table, counts, ...overrides });
}

/** 一筆公開紀錄。 */
function entry(side: Side, act: 0 | 1 | 2, ok: boolean, c: number, card = 0): H4Entry {
  return { side, act, ok, c, card };
}

/** 從 choose 開始：按一下，走完鎖定，到達翻牌（還沒入帳）。 */
function toFlip(state: H4State, side: Side, buttons: Buttons): H4State {
  return stepN(h4Game.step(state, press(side, buttons)), LOCK_TICKS);
}

/** 從 choose 開始：按一下、翻牌、入帳。 */
function playGuess(state: H4State, side: Side, buttons: Buttons): H4State {
  return stepN(toFlip(state, side, buttons), RESULT_TICKS);
}

function choosing(overrides: Partial<H4State> = {}): H4State {
  return makeState({ phase: 'choose', wait: 0, ...overrides });
}

const POLICIES: readonly Policy[] = [pathfinder, precise, greedy, gambler];

/** 沒有延遲、不亂選的指定深度控制器。 */
function decideWith(policy: Policy, depth: number, state: H4State, side: Side): Buttons {
  return wrapPolicy(
    h4Game,
    policy,
    { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
    7,
  ).decide(state, side, 0);
}

function nameOf(buttons: Buttons): string {
  if (sameButtons(buttons, UP)) {
    return 'up';
  }
  if (sameButtons(buttons, DOWN)) {
    return 'down';
  }
  if (sameButtons(buttons, STOP)) {
    return 'stop';
  }
  return 'idle';
}

// ---------------------------------------------------------------------------
// 初始與常數
// ---------------------------------------------------------------------------

describe('H-4 比大小｜初始與常數', () => {
  it('常數：目標 15、連對分 [0,1,3,6,10,15,21]、連對 6 次自動收手、猜錯扣 2、鎖定 2 tick', () => {
    expect(TARGET).toBe(15);
    expect([...CHAIN_PTS]).toEqual([0, 1, 3, 6, 10, 15, 21]);
    expect(MAX_CHAIN).toBe(6);
    expect(MISS_PENALTY).toBe(2);
    expect(LOCK_TICKS).toBe(2);
  });

  it('init：26 張牌（1 到 13 各 2 張）、桌上牌從牌堆來、兩邊都沒看過、牌堆 25 張、等 AI 等待 tick 才開始', () => {
    const s = h4Game.init(5, CONFIG);
    expect(s.counts).toEqual(FULL);
    expect(s.table).toBeGreaterThanOrEqual(1);
    expect(s.table).toBeLessThanOrEqual(13);
    expect(s.tableSeen).toEqual([false, false]);
    expect(deckSize(s)).toBe(25);
    expect(deckOf(s).reduce((a, b) => a + b, 0)).toBe(25);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.totals).toEqual([0, 0]);
    expect(s.c).toBe(0);
    expect(s.history).toEqual([]);
    expect(s.turnCards).toEqual([]);
    expect(s.over).toBe(false);
    expect(s.maxTicks).toBe(3600);
  });

  it('init：同樣的種子同樣的局面；誰先由種子決定，兩邊都會當先手；桌上牌也不全相同', () => {
    expect(h4Game.init(11, CONFIG)).toEqual(h4Game.init(11, CONFIG));
    const starters = new Set<number>();
    const tables = new Set<number>();
    for (let seed = 0; seed < 40; seed += 1) {
      const s = h4Game.init(seed, CONFIG);
      starters.add(s.turn);
      tables.add(s.table);
    }
    expect(starters.size).toBe(2);
    expect(tables.size).toBeGreaterThan(5);
  });

  it('牌堆是推出來的：未公開的牌（counts）減掉桌上牌與這個回合換下來的牌', () => {
    const s = makeState({ table: 5, turnCards: [3, 3], counts: without([1, 2]) });
    const deck = deckOf(s);
    expect(deck[5 - 1]).toBe(1);
    expect(deck[3 - 1]).toBe(0);
    expect(deck[1 - 1]).toBe(1);
    // 26 − 2（已公開）= 24 張未公開；扣掉換下來的 2 張與桌上牌 = 21
    expect(deckSize(s)).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

describe('H-4 比大小｜規則', () => {
  it('1. 準備 AI_WAIT_TICKS tick：這段時間輸入被忽略；之後進 choose', () => {
    const s0 = makeState({ turn: 0 });
    const early = stepN(s0, AI_WAIT_TICKS - 1, press(0, UP));
    expect(early.phase).toBe('prep');
    expect(early.guess).toBeNull();
    const ready = h4Game.step(early, press(0, UP));
    expect(ready.phase).toBe('choose');
    // 這一個 tick 的輸入還是被忽略；下一個 tick 才算
    expect(ready.guess).toBeNull();
    expect(h4Game.step(ready, press(0, UP)).phase).toBe('locked');
  });

  it('2. 猜了只記下方向，不當場結算：階段 locked、總分、連對、桌上牌、歷史都沒動；鎖定 LOCK_TICKS 個 tick', () => {
    const s = choosing({ table: 7 });
    const locked = h4Game.step(s, press(0, UP));
    expect(locked.phase).toBe('locked');
    expect(locked.guess).toBe(0);
    expect(locked.table).toBe(7);
    expect(locked.totals).toEqual([0, 0]);
    expect(locked.history).toEqual([]);
    expect(locked.flip).toBe(0);
    const second = h4Game.step(locked, idle());
    expect(second.phase).toBe('locked');
    const third = h4Game.step(second, idle());
    expect(third.phase).toBe('flip');
  });

  it('3. 翻牌：翻出來的牌放在 flip，入帳之前 counts、table、連對、總分都不動', () => {
    const s = forced(7, 10);
    const flipping = toFlip(s, 0, UP);
    expect(flipping.phase).toBe('flip');
    expect(flipping.flip).toBe(10);
    expect(flipping.counts).toEqual(s.counts);
    expect(flipping.table).toBe(7);
    expect(flipping.c).toBe(0);
    expect(flipping.totals).toEqual([0, 0]);
    expect(flipping.history).toEqual([]);
    expect(flipping.rng).not.toBe(s.rng);
  });

  it('4. 猜大猜對：連對 +1、翻出的牌成為新的桌上牌、舊的桌上牌換下來（還沒公開）、這一邊看過桌上牌、同一個人繼續', () => {
    const after = playGuess(forced(7, 10), 0, UP);
    expect(after.c).toBe(1);
    expect(after.table).toBe(10);
    expect(after.turnCards).toEqual([7]);
    expect(after.tableSeen).toEqual([true, false]);
    expect(after.turn).toBe(0);
    expect(after.totals).toEqual([0, 0]);
    expect(after.history).toEqual([entry(0, 0, true, 1)]);
    expect(after.phase).toBe('prep');
    // 還沒公開：counts 不動
    expect(after.counts).toEqual(forced(7, 10).counts);
  });

  it('5. 猜小猜對：同樣道理（翻出 4 比桌上 7 小）', () => {
    const after = playGuess(forced(7, 4), 0, DOWN);
    expect(after.c).toBe(1);
    expect(after.table).toBe(4);
    expect(after.history).toEqual([entry(0, 1, true, 1)]);
  });

  it('6. 猜錯（猜大翻到小）：連對作廢、已存總分扣 2、換對方、換下來的牌公開（counts 少一張）、最後那張蓋著留給對方', () => {
    const s = forced(7, 4);
    const after = playGuess(s, 0, UP);
    expect(after.totals).toEqual([-2, 0]);
    expect(after.c).toBe(0);
    expect(after.turn).toBe(1);
    expect(after.table).toBe(4);
    expect(after.tableSeen).toEqual([true, false]);
    expect(after.turnCards).toEqual([]);
    // 舊的桌上牌（7）公開丟掉；新的桌上牌（4）還在 counts 裡
    expect(after.counts[7 - 1]).toBe(s.counts[7 - 1]! - 1);
    expect(after.counts[4 - 1]).toBe(s.counts[4 - 1]);
    expect(after.history).toEqual([entry(0, 0, false, 0)]);
    expect(after.phase).toBe('prep');
  });

  it('7. 同點算猜錯：猜大與猜小都一樣', () => {
    for (const buttons of [UP, DOWN]) {
      const after = playGuess(forced(7, 7), 0, buttons);
      expect(after.totals).toEqual([-2, 0]);
      expect(after.turn).toBe(1);
    }
  });

  it('8. 收手：存 CHAIN_PTS[c]、當場生效（一個 tick）、換對方、這個回合換下來的牌全部公開、桌上牌蓋著留給對方', () => {
    const s = choosing({
      c: 2,
      table: 9,
      tableSeen: [true, false],
      turnCards: [3, 5],
      counts: without([]),
      history: [entry(1, 2, true, 1, 0), entry(0, 0, true, 1), entry(0, 1, true, 2)],
    });
    const after = h4Game.step(s, press(0, STOP));
    expect(after.totals).toEqual([CHAIN_PTS[2], 0]);
    expect(after.turn).toBe(1);
    expect(after.c).toBe(0);
    expect(after.table).toBe(9);
    expect(after.tableSeen).toEqual([true, false]);
    expect(after.turnCards).toEqual([]);
    expect(after.counts[3 - 1]).toBe(1);
    expect(after.counts[5 - 1]).toBe(1);
    expect(after.counts[9 - 1]).toBe(2);
    expect(after.phase).toBe('prep');
    expect(after.wait).toBe(AI_WAIT_TICKS);
    const last = after.history[after.history.length - 1] as H4Entry;
    expect(last).toEqual(entry(0, 2, true, 2));
    // 對方上一個回合最後那筆（蓋著的牌）現在公開了：就是這個回合一開始的桌上牌 3
    expect(after.history[0]).toEqual(entry(1, 2, true, 1, 3));
  });

  it('9. 連對 0 的時候不能收手（b 沒有效）；b 勝過方向鍵，其次是上、下；不是這一邊的回合，輸入被忽略', () => {
    const s = choosing({ table: 7 });
    expect(h4Game.step(s, press(0, STOP)).phase).toBe('choose');
    const c1 = choosing({ c: 1, table: 7, tableSeen: [true, false] });
    expect(h4Game.step(c1, press(0, { ...UP, b: true })).turn).toBe(1);
    expect(h4Game.step(c1, press(0, { ...UP, down: true })).guess).toBe(0);
    expect(h4Game.step(c1, press(0, DOWN)).guess).toBe(1);
    // 輪到 0 的時候 1 的輸入沒有用
    expect(h4Game.step(c1, press(1, UP)).phase).toBe('choose');
  });

  it('10. 連對 6 次自動收手：存 21 分，達到目標，這一邊贏', () => {
    const s = forced(7, 10, { c: MAX_CHAIN - 1, tableSeen: [true, false] });
    const after = playGuess(s, 0, UP);
    expect(after.totals[0]).toBe(CHAIN_PTS[MAX_CHAIN]);
    expect(after.over).toBe(true);
    expect(after.winner).toBe(0);
  });

  it('11. 收手之後總分 ≥ 目標：立刻結束，那一邊贏；剛好 15 也算', () => {
    const s = choosing({ c: 3, table: 9, tableSeen: [false, true], turn: 1, totals: [4, 9] });
    const after = h4Game.step(s, press(1, STOP));
    expect(after.totals).toEqual([4, 9 + CHAIN_PTS[3]]);
    expect(after.over).toBe(true);
    expect(after.winner).toBe(1);
    const exact = h4Game.step(
      choosing({ c: 3, table: 9, tableSeen: [true, false], totals: [9, 3] }),
      press(0, STOP),
    );
    expect(exact.totals[0]).toBe(15);
    expect(exact.over).toBe(true);
    expect(exact.winner).toBe(0);
  });

  it('12. 猜錯可以讓總分變負；猜對沒到目標就沒結束', () => {
    const s = forced(7, 10, { totals: [14, 0], c: 0 });
    expect(playGuess(s, 0, UP).over).toBe(false);
    const neg = playGuess(forced(7, 4, { totals: [1, 0] }), 0, UP);
    expect(neg.totals[0]).toBe(-1);
  });

  it('13. 牌堆翻完：進行中的連對自動收手，比總分（多的贏，一樣多平手）', () => {
    // 未公開只有桌上牌 + 一張牌堆：翻出之後牌堆空了
    const counts = Array.from({ length: 13 }, () => 0);
    counts[7 - 1] = 1;
    counts[10 - 1] = 1;
    const s = makeState({
      phase: 'choose',
      wait: 0,
      table: 7,
      counts,
      c: 1,
      tableSeen: [true, false],
      totals: [2, 5],
    });
    const after = playGuess(s, 0, UP);
    expect(after.over).toBe(true);
    // 連對 1 → 2，自動收手 3 分：2 + 3 = 5，與對方一樣 → 平手
    expect(after.totals).toEqual([5, 5]);
    expect(after.winner).toBeNull();
    const lead = playGuess({ ...s, totals: [4, 5] }, 0, UP);
    expect(lead.totals[0]).toBe(7);
    expect(lead.winner).toBe(0);
  });

  it('14. 時間到（第 maxTicks 個 tick）：進行中的連對不算，比目前總分', () => {
    const s = choosing({
      maxTicks: 10,
      tick: 9,
      c: 3,
      table: 9,
      totals: [2, 3],
      tableSeen: [true, false],
    });
    const after = h4Game.step(s, idle());
    expect(after.over).toBe(true);
    expect(after.totals).toEqual([2, 3]);
    expect(after.winner).toBe(1);
  });

  it('15. 超時：choose 閒置到第 DECISION_TIMEOUT 個 tick 自動選保守的；第一猜選未公開張數多的那一邊，有連對就收手；那個 tick 按了鍵算按了', () => {
    // 看不到桌上牌的第一猜：桌上牌與翻出的牌來自同一堆牌，牌表再偏也是五五波，所以自動選的是 ↑（一樣時猜大）
    const lowGone = choosing({
      table: 7,
      idle: DECISION_TIMEOUT - 1,
      counts: without([1, 1, 2, 2, 3, 3, 4, 4]),
    });
    expect(h4Game.step(lowGone, idle()).guess).toBe(0);
    const highGone = choosing({
      table: 7,
      idle: DECISION_TIMEOUT - 1,
      counts: without([10, 10, 11, 11, 12, 12, 13, 13]),
    });
    expect(h4Game.step(highGone, idle()).guess).toBe(0);
    // 看過桌上牌（連對中，但這裡用 c = 0 的換手後模擬不到）→ 改用 chain 的收手；看得到桌上牌的猜法見下面的 known
    const known = choosing({
      table: 7,
      tableSeen: [true, false],
      idle: DECISION_TIMEOUT - 1,
      counts: without([10, 10, 11, 11, 12, 12, 13, 13]),
    });
    expect(h4Game.step(known, idle()).guess).toBe(1);
    const chain = choosing({
      c: 2,
      table: 9,
      tableSeen: [true, false],
      idle: DECISION_TIMEOUT - 1,
    });
    const stopped = h4Game.step(chain, idle());
    expect(stopped.turn).toBe(1);
    expect(stopped.totals[0]).toBe(CHAIN_PTS[2]);
    const early = h4Game.step({ ...lowGone, idle: DECISION_TIMEOUT - 2 }, idle());
    expect(early.phase).toBe('choose');
    const pressed = h4Game.step({ ...lowGone }, press(0, DOWN));
    expect(pressed.guess).toBe(1);
  });

  it('16. 蓋牌的流向：我收手留下 N，對方第一猜翻牌之後看過 N（但桌上牌換成新翻的）；N 在對方回合結束時公開', () => {
    // 輪到 1：桌上 8（0 看過，1 沒看過）；1 猜小，翻出 3，猜對 → 8 換下來（1 看過了，還沒公開）
    const s = forced(8, 3, { turn: 1, tableSeen: [true, false] });
    const hit = playGuess(s, 1, DOWN);
    expect(hit.table).toBe(3);
    expect(hit.turnCards).toEqual([8]);
    expect(hit.tableSeen).toEqual([false, true]);
    expect(hit.counts[8 - 1]).toBe(s.counts[8 - 1]);
    // 1 現在收手 → 8 公開
    const stop = h4Game.step(stepN(hit, AI_WAIT_TICKS), press(1, STOP));
    expect(stop.counts[8 - 1]).toBe(s.counts[8 - 1]! - 1);
    expect(stop.turn).toBe(0);
    expect(stop.table).toBe(3);
  });

  it('17. step 不改動傳進來的 state 與輸入：各階段深度凍結都不丟錯', () => {
    const states: H4State[] = [
      deepFreeze(makeState()),
      deepFreeze(choosing()),
      deepFreeze(h4Game.step(choosing(), press(0, UP))),
      deepFreeze(toFlip(forced(7, 10), 0, UP)),
      deepFreeze(
        choosing({
          c: 2,
          table: 9,
          tableSeen: [true, false],
          turnCards: [3, 5],
          history: [entry(1, 2, true, 1)],
        }),
      ),
    ];
    for (const s of states) {
      const before = hashState(s);
      expect(() => h4Game.step(s, deepFreeze(press(0, STOP)))).not.toThrow();
      expect(() => h4Game.step(s, deepFreeze(press(0, UP)))).not.toThrow();
      expect(hashState(s)).toBe(before);
    }
  });

  it('18. 整場 JSON 來回不變、不同種子的牌序不全相同、同種子重跑一樣', () => {
    const a = playMatch(
      h4Game,
      3,
      CONFIG,
      levelController(h4Game, random, 5, 3),
      levelController(h4Game, random, 5, 4),
    );
    const b = playMatch(
      h4Game,
      3,
      CONFIG,
      levelController(h4Game, random, 5, 3),
      levelController(h4Game, random, 5, 4),
    );
    expect(a.finalHash).toBe(b.finalHash);
    const s = toFlip(h4Game.init(3, CONFIG), 0, UP);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const flips = new Set<number>();
    for (let seed = 0; seed < 30; seed += 1) {
      const init = h4Game.init(seed, CONFIG);
      const ready = stepN(init, AI_WAIT_TICKS);
      flips.add(toFlip(ready, ready.turn, UP).flip);
    }
    expect(flips.size).toBeGreaterThan(5);
  });

  it('19. 結束之後 step 原樣回傳；winner 在結束前是 null', () => {
    const live = choosing();
    expect(h4Game.winner(live)).toBeNull();
    const over = h4Game.step(
      choosing({ c: 3, table: 9, tableSeen: [true, false], totals: [14, 0] }),
      press(0, STOP),
    );
    expect(h4Game.isOver(over)).toBe(true);
    expect(h4Game.step(over, press(1, UP))).toBe(over);
    expect(h4Game.score(over)).toEqual([over.totals[0], over.totals[1]]);
  });
});

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

describe('H-4 比大小｜actions', () => {
  it('自己的回合、choose：第一猜 [↑, ↓]；有連對 [b, ↑, ↓]（收手排第一）；其他時候只有 [全放開]', () => {
    const s = choosing({ table: 7 });
    expect(h4Game.actions(s, 0).map(nameOf)).toEqual(['up', 'down']);
    expect(h4Game.actions(s, 1).map(nameOf)).toEqual(['idle']);
    const c1 = choosing({ c: 1, table: 7, tableSeen: [true, false] });
    expect(h4Game.actions(c1, 0).map(nameOf)).toEqual(['stop', 'up', 'down']);
    expect(h4Game.actions(c1, 1).map(nameOf)).toEqual(['idle']);
    expect(h4Game.actions(makeState(), 0).map(nameOf)).toEqual(['idle']);
    expect(h4Game.actions(h4Game.step(s, press(0, UP)), 0).map(nameOf)).toEqual(['idle']);
    expect(h4Game.actions(toFlip(forced(7, 10), 0, UP), 0).map(nameOf)).toEqual(['idle']);
  });

  it('evaluate：每個階段 gain 有限、danger 在 0 到 1；結束的局有勝負加成', () => {
    const samples: H4State[] = [
      makeState(),
      choosing(),
      choosing({ c: 2, table: 9, tableSeen: [true, false] }),
      h4Game.step(choosing(), press(0, UP)),
      toFlip(forced(7, 10), 0, UP),
      h4Game.step(
        choosing({ c: 3, table: 9, tableSeen: [true, false], totals: [14, 0] }),
        press(0, STOP),
      ),
    ];
    for (const s of samples) {
      for (const side of [0, 1] as const) {
        const e = h4Game.evaluate(s, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
    const won = samples[samples.length - 1] as H4State;
    expect(h4Game.evaluate(won, 0).gain).toBeGreaterThan(500);
    expect(h4Game.evaluate(won, 1).gain).toBeLessThan(-500);
  });
});

// ---------------------------------------------------------------------------
// 看得到什麼：unseenCounts、後驗、winChance
// ---------------------------------------------------------------------------

describe('H-4 比大小｜這一邊看得到什麼（unseenCounts、後驗、猜中機率）', () => {
  it('unseenCounts：自己的回合扣掉自己換下來的牌與看過的桌上牌；對方的回合不扣對方的牌（讀不到）', () => {
    const mine = choosing({
      turn: 0,
      c: 2,
      table: 9,
      tableSeen: [true, false],
      turnCards: [3, 5],
      counts: FULL,
    });
    const seen = unseenCounts(mine, 0);
    expect(seen[3 - 1]).toBe(1);
    expect(seen[5 - 1]).toBe(1);
    expect(seen[9 - 1]).toBe(1);
    // 對方（1）看這個局面：只有公開的，所有牌都還是未公開
    expect(unseenCounts(mine, 1)).toEqual(FULL);
  });

  it('winChance：已知桌上牌 13，猜小幾乎一定中（同點算錯）；猜大一定不中', () => {
    const s = choosing({
      c: 1,
      table: 13,
      tableSeen: [true, false],
      turnCards: [4],
      counts: FULL,
    });
    // 牌堆 = 26 − 4 − 13 = 24 張，其中 13 還有 1 張（同點，猜小算錯）
    expect(winChance(s, 0, 1)).toBeCloseTo(23 / 24, 6);
    expect(winChance(s, 0, 0)).toBe(0);
  });

  it('winChance：看不到桌上牌時對先驗取期望，兩個方向加起來小於 1（同點算錯），而且左右對稱', () => {
    const s = choosing({ turn: 1, tableSeen: [true, false], counts: FULL, table: 3 });
    const up = winChance(s, 1, 0);
    const down = winChance(s, 1, 1);
    expect(up + down).toBeLessThan(1);
    expect(up).toBeCloseTo(down, 6);
  });

  it('winChance：看不到桌上牌時，牌表再偏也是五五波（桌上牌與翻出的牌來自同一堆牌）；看過桌上牌時，低牌都丟掉了猜大比較可能中', () => {
    const counts = without([1, 1, 2, 2, 3, 3, 4, 4]);
    const blind = choosing({ turn: 1, tableSeen: [true, false], counts, table: 9 });
    expect(winChance(blind, 1, 0)).toBeCloseTo(winChance(blind, 1, 1), 9);
    const known = choosing({ turn: 1, tableSeen: [false, true], counts, table: 9, c: 1 });
    expect(winChance(known, 1, 0)).toBeGreaterThan(winChance(known, 1, 1) - 0.3);
    const mid = choosing({ turn: 1, tableSeen: [false, true], counts, table: 6, c: 1 });
    expect(winChance(mid, 1, 0)).toBeGreaterThan(winChance(mid, 1, 1));
  });

  it('後驗：沒有線索時等於未公開牌的比例；機率加起來是 1；只在還沒看過的桌上牌上有意義（看過的是 delta）', () => {
    const blind = choosing({ turn: 1, tableSeen: [true, false], counts: FULL, table: 6 });
    const p = tablePosterior(blind, 1);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(p[0]).toBeCloseTo(1 / 13, 6);
    const known = choosing({ c: 1, table: 6, tableSeen: [true, false], counts: FULL });
    const q = tablePosterior(known, 0);
    expect(q[6 - 1]).toBe(1);
  });

  it('後驗：對方連猜大連對 3 次然後收手 → 蓋牌偏大；連猜小 → 偏小（用公開的猜法與對錯）', () => {
    const base = {
      turn: 1 as const,
      tableSeen: [true, false] as [boolean, boolean],
      counts: FULL,
      table: 6,
    };
    const ups = choosing({
      ...base,
      history: [
        entry(0, 0, true, 1),
        entry(0, 0, true, 2),
        entry(0, 0, true, 3),
        entry(0, 2, true, 3),
      ],
    });
    const downs = choosing({
      ...base,
      history: [
        entry(0, 1, true, 1),
        entry(0, 1, true, 2),
        entry(0, 1, true, 3),
        entry(0, 2, true, 3),
      ],
    });
    const mean = (p: readonly number[]): number => p.reduce((acc, v, i) => acc + v * (i + 1), 0);
    expect(mean(tablePosterior(ups, 1))).toBeGreaterThan(8);
    expect(mean(tablePosterior(downs, 1))).toBeLessThan(6);
    expect(winChance(ups, 1, 1)).toBeGreaterThan(winChance(ups, 1, 0));
    expect(winChance(downs, 1, 0)).toBeGreaterThan(winChance(downs, 1, 1));
  });

  it('後驗：對方的回合最後是猜錯 → 蓋牌在猜錯的那一邊（猜大錯 → 蓋牌不比上一張大，偏小）', () => {
    const s = choosing({
      turn: 1,
      tableSeen: [true, false],
      counts: FULL,
      table: 6,
      history: [entry(0, 0, true, 1), entry(0, 0, false, 0)],
    });
    const mean = tablePosterior(s, 1).reduce((acc, v, i) => acc + v * (i + 1), 0);
    expect(mean).toBeLessThan(7);
  });
});

// ---------------------------------------------------------------------------
// stopBias
// ---------------------------------------------------------------------------

describe('H-4 比大小｜stopBias（對方在極端牌收手的比例）', () => {
  it('極端牌：點數 ≤ 3 或 ≥ 11', () => {
    expect([1, 2, 3, 4, 7, 10, 11, 12, 13].map(isExtreme)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it('沒有紀錄是先驗 0.15；極端牌的收手把它拉高、中間牌的收手把它拉低；越多筆越接近實際比例', () => {
    expect(stopBias([], 0)).toBeCloseTo(0.15, 9);
    const extreme = [entry(0, 2, true, 1, 13)];
    const middle = [entry(0, 2, true, 1, 7)];
    expect(stopBias(extreme, 0)).toBeGreaterThan(0.3);
    expect(stopBias(middle, 0)).toBeLessThan(0.15);
    const three = [13, 1, 12].map((card) => entry(0, 2, true, 1, card));
    expect(stopBias(three, 0)).toBeGreaterThan(stopBias(extreme, 0));
    expect(stopBias(three, 0)).toBeGreaterThan(0.6);
  });

  it('窗口是最近 4 次收手：更早的極端收手被擠出去', () => {
    const old = [13, 13, 13, 13].map((card) => entry(0, 2, true, 1, card));
    const recent = [7, 6, 8, 5].map((card) => entry(0, 2, true, 1, card));
    expect(stopBias([...old, ...recent], 0)).toBeCloseTo(stopBias(recent, 0), 9);
    expect(stopBias([...old, ...recent.slice(0, 3)], 0)).toBeGreaterThan(stopBias(recent, 0));
  });

  it('只算公開了牌的收手（card = 0 是還蓋著的，不能算）、只算那一邊、猜對猜錯的紀錄不算', () => {
    const mixed: H4Entry[] = [
      entry(0, 2, true, 1, 0),
      entry(1, 2, true, 1, 13),
      entry(0, 0, true, 1, 0),
      entry(0, 1, false, 0, 12),
    ];
    expect(stopBias(mixed, 0)).toBeCloseTo(0.15, 9);
    expect(stopBias(mixed, 1)).toBeGreaterThan(0.3);
  });

  it('收手的人騙人（一直在極端牌收手）：同樣的猜法與收手，後驗不再相信「收手 ＝ 中間牌」', () => {
    const chain = [entry(0, 0, true, 1), entry(0, 2, true, 1)];
    const honest = [7, 6, 8, 5].map((card) => entry(0, 2, true, 1, card));
    const bluff = [13, 1, 12, 2].map((card) => entry(0, 2, true, 1, card));
    const mk = (past: readonly H4Entry[]): H4State =>
      choosing({
        turn: 1,
        tableSeen: [true, false],
        counts: FULL,
        table: 6,
        history: [...past, entry(1, 2, true, 1, 5), ...chain],
      });
    const mid = (p: readonly number[]): number => p.slice(4, 9).reduce((a, b) => a + b, 0);
    expect(mid(tablePosterior(mk(honest), 1))).toBeGreaterThan(mid(tablePosterior(mk(bluff), 1)));
  });
});

// ---------------------------------------------------------------------------
// 不偷看
// ---------------------------------------------------------------------------

/** 偵測器：只有「這一邊不該看到的東西」不同的兩個 state，evaluate 與 actions 必須相等。 */
function peeks(
  game: Game<H4State>,
  base: H4State,
  variants: readonly H4State[],
  side: Side,
): boolean {
  const e = game.evaluate(base, side);
  const a = game.actions(base, side);
  for (const v of variants) {
    const ev = game.evaluate(v, side);
    if (ev.gain !== e.gain || ev.danger !== e.danger) {
      return true;
    }
    const av = game.actions(v, side);
    if (av.length !== a.length || av.some((x, i) => !sameButtons(x, a[i] as Buttons))) {
      return true;
    }
  }
  return false;
}

const RANKS = Array.from({ length: 13 }, (_, i) => i + 1);

/** 公開的背景：幾種不同的歷史與丟牌。 */
const BACKGROUNDS: readonly Partial<H4State>[] = [
  { counts: FULL, history: [] },
  {
    counts: without([2, 5, 9, 9, 13]),
    history: [entry(0, 0, true, 1), entry(0, 0, true, 2), entry(0, 2, true, 2, 0)],
  },
  {
    counts: without([1, 1, 3, 12]),
    totals: [6, 3],
    history: [
      entry(1, 2, true, 1, 7),
      entry(0, 1, true, 1),
      entry(0, 1, false, 0),
      entry(1, 0, true, 1),
      entry(1, 2, true, 1, 0),
    ],
  },
];

/** 每個「隱藏資訊」的情境：回傳 [基準, 只有隱藏資訊不同的變體們, 要檢查的那一邊, 這個情境洩漏哪一種]。 */
interface PeekCase {
  readonly name: string;
  readonly side: Side;
  readonly base: H4State;
  readonly variants: readonly H4State[];
}

function peekCases(): PeekCase[] {
  const cases: PeekCase[] = [];
  for (const [bi, bg] of BACKGROUNDS.entries()) {
    // A. 輪到 1 的第一猜（盲猜）：桌上牌是 0 留下的、1 沒看過；桌上牌與下一張牌（rng）都不可以讀
    for (const phase of ['choose', 'locked'] as const) {
      const base = makeState({
        ...bg,
        phase,
        wait: phase === 'locked' ? LOCK_TICKS : 0,
        guess: phase === 'locked' ? 0 : null,
        turn: 1,
        c: 0,
        tableSeen: [true, false],
        table: 6,
      });
      cases.push({
        name: `盲猜 ${phase} 背景 ${bi}：桌上牌與 rng`,
        side: 1,
        base,
        variants: [
          ...RANKS.map((table) => ({ ...base, table })),
          { ...base, rng: base.rng + 1 },
          { ...base, rng: base.rng + 99_999 },
        ],
      });
    }
    // B. 翻牌階段（入帳前）：翻出的牌與桌上牌都不可以讀（兩邊都是：自己的盲猜）
    const flipBase = makeState({
      ...bg,
      phase: 'flip',
      wait: RESULT_TICKS,
      guess: 1,
      turn: 1,
      c: 0,
      tableSeen: [true, false],
      table: 6,
      flip: 9,
    });
    cases.push({
      name: `盲猜 flip 背景 ${bi}：桌上牌與翻出的牌`,
      side: 1,
      base: flipBase,
      variants: RANKS.flatMap((v) => [
        { ...flipBase, flip: v },
        { ...flipBase, table: v },
        { ...flipBase, table: v, flip: 14 - v },
      ]),
    });
    // C. 自己已經看過桌上牌（連對中）：翻出的牌與 rng 不可以讀（桌上牌可以讀）
    const knownBase = makeState({
      ...bg,
      phase: 'flip',
      wait: RESULT_TICKS,
      guess: 0,
      turn: 1,
      c: 1,
      tableSeen: [false, true],
      table: 8,
      turnCards: [4],
      flip: 12,
    });
    cases.push({
      name: `連對中 flip 背景 ${bi}：翻出的牌與 rng`,
      side: 1,
      base: knownBase,
      variants: [
        ...RANKS.map((flip) => ({ ...knownBase, flip })),
        { ...knownBase, rng: knownBase.rng + 7 },
      ],
    });
    // D. 對方的回合（人在猜）：AI 側不可以讀對方的桌上牌、對方這個回合翻過的牌、對方翻出的牌、rng
    for (const phase of ['choose', 'locked', 'flip'] as const) {
      const theirs = makeState({
        ...bg,
        phase,
        wait: phase === 'choose' ? 0 : phase === 'locked' ? LOCK_TICKS : RESULT_TICKS,
        guess: phase === 'choose' ? null : 0,
        turn: 0,
        c: 2,
        tableSeen: [true, false],
        table: 9,
        turnCards: [4, 6],
        flip: phase === 'flip' ? 11 : 0,
      });
      cases.push({
        name: `對方的回合 ${phase} 背景 ${bi}：對方的桌上牌、turnCards、flip、rng`,
        side: 1,
        base: theirs,
        variants: [
          ...RANKS.map((table) => ({ ...theirs, table })),
          ...RANKS.map((r) => ({ ...theirs, turnCards: [r, 14 - r] })),
          ...(phase === 'flip' ? RANKS.map((flip) => ({ ...theirs, flip })) : []),
          { ...theirs, rng: theirs.rng + 5 },
        ],
      });
    }
    // F. 開局：桌上牌誰都沒看過（兩邊都不可以讀）；各階段、各種背景
    for (const phase of ['prep', 'choose', 'locked', 'flip'] as const) {
      const first = makeState({
        ...bg,
        phase,
        wait:
          phase === 'prep'
            ? AI_WAIT_TICKS
            : phase === 'choose'
              ? 0
              : phase === 'locked'
                ? LOCK_TICKS
                : RESULT_TICKS,
        guess: phase === 'locked' || phase === 'flip' ? 0 : null,
        turn: 0,
        c: 0,
        tableSeen: [false, false],
        table: 6,
        flip: phase === 'flip' ? 9 : 0,
      });
      for (const side of [0, 1] as const) {
        cases.push({
          name: `開局（兩邊都沒看過桌上牌）${phase} 背景 ${bi} 側 ${side}：桌上牌與翻出的牌`,
          side,
          base: first,
          variants: [
            ...RANKS.map((table) => ({ ...first, table })),
            ...(phase === 'flip' ? RANKS.map((flip) => ({ ...first, flip })) : []),
          ],
        });
      }
    }
    // E. 對方剛收手（輪到對方、對方沒看過我留的牌）：我留的牌的資訊在 evaluate 裡是我自己看過的（可以讀），
    //    但對方這邊（人）看 AI 留的牌不可以讀
    const handed = makeState({
      ...bg,
      phase: 'prep',
      wait: AI_WAIT_TICKS,
      turn: 0,
      c: 0,
      tableSeen: [false, true],
      table: 7,
    });
    cases.push({
      name: `人的回合開始、桌上牌是 AI 留的 背景 ${bi}：人側 evaluate 不可以讀`,
      side: 0,
      base: handed,
      variants: RANKS.map((table) => ({ ...handed, table })),
    });
  }
  return cases;
}

describe('H-4 比大小｜不偷看（evaluate 與 actions 只讀這一邊看得到的）', () => {
  it('每一個隱藏資訊的情境：只有隱藏資訊不同的兩個 state，evaluate 與 actions 完全相同', () => {
    for (const c of peekCases()) {
      expect(peeks(h4Game, c.base, c.variants, c.side), c.name).toBe(false);
    }
  });

  it('這一邊讀的牌表與後驗（unseenCounts、tablePosterior、winChance）也只由看得到的東西決定', () => {
    for (const c of peekCases()) {
      const look = (st: H4State): unknown => [
        unseenCounts(st, c.side),
        tablePosterior(st, c.side),
        winChance(st, c.side, 0),
        winChance(st, c.side, 1),
      ];
      const expected = look(c.base);
      for (const v of c.variants) {
        expect(look(v), c.name).toEqual(expected);
      }
    }
  });

  it('偵測器本身有效：故意洩漏（讀蓋著的桌上牌、讀對方的 turnCards、讀 flip）一定被抓到', () => {
    const leaks: Record<string, (s: H4State, side: Side) => number> = {
      讀蓋著的桌上牌: (s, side) => (s.tableSeen[side] ? 0 : 0.001 * s.table),
      讀對方這個回合翻過的牌: (s, side) => (s.turn !== side ? 0.001 * (s.turnCards[0] ?? 0) : 0),
      讀還沒入帳的翻牌: (s) => (s.phase === 'flip' ? 0.001 * s.flip : 0),
      '讀對方蓋著的桌上牌（對方回合）': (s, side) =>
        s.turn !== side && s.tableSeen[s.turn] ? 0.001 * s.table : 0,
    };
    const cases = peekCases();
    for (const [name, extra] of Object.entries(leaks)) {
      const leaky: Game<H4State> = {
        ...h4Game,
        evaluate: (s, side) => {
          const e = h4Game.evaluate(s, side);
          return { gain: e.gain + extra(s, side), danger: e.danger };
        },
      };
      const caught = cases.some((c) => peeks(leaky, c.base, c.variants, c.side));
      expect(caught, `沒抓到洩漏：${name}`).toBe(true);
    }
    // 讀 actions 的洩漏也抓得到：桌上牌是 13 時多給一個動作
    const leakyActions: Game<H4State> = {
      ...h4Game,
      actions: (s, side) =>
        !s.tableSeen[side] && s.table === 13
          ? [...h4Game.actions(s, side), IDLE]
          : h4Game.actions(s, side),
    };
    expect(cases.some((c) => peeks(leakyActions, c.base, c.variants, c.side))).toBe(true);
  });

  it('黑箱：四個性格在深度 1、3、6，只有隱藏資訊（桌上牌、下一張牌）不同的 choose 局面，按的鍵都相同', () => {
    for (const bg of BACKGROUNDS) {
      // AI（1）盲猜
      const blind = makeState({
        ...bg,
        phase: 'choose',
        wait: 0,
        turn: 1,
        c: 0,
        tableSeen: [true, false],
        table: 6,
      });
      // AI（1）先手：桌上牌誰都沒看過
      const opening = makeState({
        ...bg,
        phase: 'choose',
        wait: 0,
        turn: 1,
        c: 0,
        tableSeen: [false, false],
        table: 6,
      });
      // AI（1）連對中：桌上牌自己看過；下一張牌（rng）不可以影響
      const chain = makeState({
        ...bg,
        phase: 'choose',
        wait: 0,
        turn: 1,
        c: 1,
        tableSeen: [false, true],
        table: 9,
        turnCards: [4],
      });
      for (const policy of POLICIES) {
        for (const depth of [1, 3, 6]) {
          const expected = nameOf(decideWith(policy, depth, blind, 1));
          for (const table of RANKS) {
            expect(
              nameOf(decideWith(policy, depth, { ...blind, table }, 1)),
              `${policy.name} 深度 ${depth} 盲猜 桌上牌 ${table}`,
            ).toBe(expected);
          }
          for (const rng of [blind.rng + 1, blind.rng + 12345, 1, 987654321]) {
            expect(nameOf(decideWith(policy, depth, { ...blind, rng }, 1))).toBe(expected);
          }
          const expectedOpening = nameOf(decideWith(policy, depth, opening, 1));
          for (const table of RANKS) {
            expect(
              nameOf(decideWith(policy, depth, { ...opening, table }, 1)),
              `${policy.name} 深度 ${depth} 開局 桌上牌 ${table}`,
            ).toBe(expectedOpening);
          }
          const expectedChain = nameOf(decideWith(policy, depth, chain, 1));
          for (const rng of [chain.rng + 1, chain.rng + 12345, 1, 987654321]) {
            expect(
              nameOf(decideWith(policy, depth, { ...chain, rng }, 1)),
              `${policy.name} ${depth} 連對中`,
            ).toBe(expectedChain);
          }
        }
      }
    }
  });

  it('黑箱：蓋著的牌決定不了猜哪邊——同樣的公開資訊下，兩邊盲猜的 gain 與 danger 只由公開資訊決定', () => {
    const base = makeState({
      phase: 'locked',
      wait: LOCK_TICKS,
      guess: 0,
      turn: 1,
      tableSeen: [true, false],
      table: 1,
      counts: FULL,
    });
    const high = { ...base, table: 13 };
    expect(h4Game.evaluate(base, 1)).toEqual(h4Game.evaluate(high, 1));
  });
});

// ---------------------------------------------------------------------------
// 等級曲線：結算 3 步，深度 ≤ 2 走不到翻牌
// ---------------------------------------------------------------------------

describe('H-4 比大小｜等級曲線（動作鎖定 2 tick → 第 3 步翻牌）', () => {
  /** 從 choose 往前走 n 步（我方猜、對手不動）。 */
  function after(state: H4State, n: number, buttons: Buttons): H4State {
    let s = h4Game.step(state, press(state.turn, buttons));
    for (let i = 1; i < n; i += 1) {
      s = h4Game.step(s, idle());
    }
    return s;
  }

  it('猜了之後走 1 步與 2 步還在 locked，第 3 步才是 flip', () => {
    const s = choosing({ turn: 1, tableSeen: [true, false], table: 6 });
    expect(after(s, 1, UP).phase).toBe('locked');
    expect(after(s, 2, UP).phase).toBe('locked');
    expect(after(s, 3, UP).phase).toBe('flip');
  });

  it('locked 是反射：evaluate 完全不用後驗（對方的猜法、收手、公開的收手紀錄不同，evaluate 相同）；flip 才讀得到', () => {
    const blind = (history: readonly H4Entry[]): H4State =>
      choosing({ turn: 1, tableSeen: [true, false], table: 6, counts: FULL, history });
    const ups = [
      entry(0, 0, true, 1),
      entry(0, 0, true, 2),
      entry(0, 0, true, 3),
      entry(0, 2, true, 3),
    ];
    const downs = [
      entry(0, 1, true, 1),
      entry(0, 1, true, 2),
      entry(0, 1, true, 3),
      entry(0, 2, true, 3),
    ];
    const lockedUp = after(blind(ups), 2, UP);
    const lockedDown = after(blind(downs), 2, UP);
    expect(lockedUp.phase).toBe('locked');
    expect(h4Game.evaluate(lockedUp, 1)).toEqual(h4Game.evaluate(lockedDown, 1));
    const flipUp = after(blind(ups), 3, UP);
    const flipDown = after(blind(downs), 3, UP);
    expect(h4Game.evaluate(flipUp, 1).gain).not.toBe(h4Game.evaluate(flipDown, 1).gain);
  });

  it('深度 1、2：不論對方留了什麼線索，決定都一樣（只看牌堆）；深度 3 以上讀得出蓋牌偏大', () => {
    const blind = (history: readonly H4Entry[]): H4State =>
      choosing({ turn: 1, tableSeen: [true, false], table: 6, counts: FULL, history });
    const ups = [
      entry(0, 0, true, 1),
      entry(0, 0, true, 2),
      entry(0, 0, true, 3),
      entry(0, 2, true, 3),
    ];
    const downs = [
      entry(0, 1, true, 1),
      entry(0, 1, true, 2),
      entry(0, 1, true, 3),
      entry(0, 2, true, 3),
    ];
    for (const depth of [1, 2]) {
      expect(nameOf(decideWith(pathfinder, depth, blind(ups), 1))).toBe(
        nameOf(decideWith(pathfinder, depth, blind(downs), 1)),
      );
    }
    // 對方連猜大 3 次 → 蓋牌偏大 → 猜小；連猜小 → 猜大
    expect(nameOf(decideWith(pathfinder, 3, blind(ups), 1))).toBe('down');
    expect(nameOf(decideWith(pathfinder, 6, blind(ups), 1))).toBe('down');
    expect(nameOf(decideWith(pathfinder, 3, blind(downs), 1))).toBe('up');
    expect(nameOf(decideWith(pathfinder, 6, blind(downs), 1))).toBe('up');
  });

  it('深度 1、2 只會「見好就收」（連對 3 次、桌上 13：收手）；深度 3 以上看得出猜小有 23/24 的把握，繼續', () => {
    const s = choosing({
      turn: 1,
      c: 3,
      tableSeen: [false, true],
      table: 13,
      turnCards: [2, 5, 9],
      counts: FULL,
      totals: [0, 0],
    });
    expect(nameOf(decideWith(pathfinder, 1, s, 1))).toBe('stop');
    expect(nameOf(decideWith(pathfinder, 2, s, 1))).toBe('stop');
    expect(nameOf(decideWith(pathfinder, 3, s, 1))).toBe('down');
    expect(nameOf(decideWith(pathfinder, 6, s, 1))).toBe('down');
  });

  it('深度夠的時候在中間牌收手：連對 2 次、桌上 7、猜中只有一半，不值得賭', () => {
    const s = choosing({
      turn: 1,
      c: 2,
      tableSeen: [false, true],
      table: 7,
      turnCards: [3, 5],
      counts: FULL,
    });
    expect(nameOf(decideWith(pathfinder, 6, s, 1))).toBe('stop');
  });

  it('收手能贏就收手：總分 + 連對分 ≥ 目標，任何深度都收手；猜對就能贏的時候，不會因為猜錯扣分而退縮', () => {
    const s = choosing({
      turn: 1,
      c: 3,
      tableSeen: [false, true],
      table: 8,
      turnCards: [2, 5, 9],
      counts: FULL,
      totals: [0, 9],
    });
    for (const depth of [1, 3, 6]) {
      expect(nameOf(decideWith(pathfinder, depth, s, 1))).toBe('stop');
    }
  });

  it('第一猜（沒有連對）永遠不能收手；盲猜時偏向未公開張數多的那一邊（深度 1 也是）', () => {
    const s = choosing({
      turn: 1,
      c: 0,
      tableSeen: [true, false],
      table: 7,
      counts: without([1, 1, 2, 2, 3, 3, 4, 4, 5]),
    });
    for (const depth of [1, 3, 6]) {
      expect(nameOf(decideWith(pathfinder, depth, s, 1))).toBe('up');
    }
  });
});

// ---------------------------------------------------------------------------
// stopBias 真的影響 AI 的決定
// ---------------------------------------------------------------------------

describe('H-4 比大小｜stopBias 影響 AI 的決定（玩家可以騙它）', () => {
  /** AI（1）盲猜；人（0）剛剛連對 `dirs` 然後收手，而且之前的收手紀錄是 `past`。 */
  function bluffScene(
    dirs: readonly (0 | 1)[],
    past: readonly H4Entry[],
    start: number,
    counts: readonly number[],
  ): H4State {
    const chain = dirs.map((d, i) => entry(0, d, true, i + 1));
    return choosing({
      turn: 1,
      c: 0,
      tableSeen: [true, false],
      table: 6,
      counts,
      history: [
        ...past,
        entry(1, 2, true, 1, start), // AI 上次收手，牌（start）在人的回合結束時公開
        ...chain,
        entry(0, 2, true, dirs.length),
      ],
    });
  }

  const HONEST = [7, 6, 8, 5].map((card) => entry(0, 2, true, 1, card));
  const BLUFF = [13, 1, 12, 2].map((card) => entry(0, 2, true, 1, card));

  it('存在 AI 的決定因為 stopBias 而改變的局面（深度 3 與 6）：AI 自己的收手紀錄誠實 → 對方信任它的收手；紀錄在騙 → 對方不信，AI 的最佳動作跟著變', () => {
    const found: string[] = [];
    const honestPast = [7, 6, 8, 5].map((card) => entry(1, 2, true, 1, card));
    const bluffPast = [13, 1, 12, 2].map((card) => entry(1, 2, true, 1, card));
    for (const dirs of [[0], [1], [0, 0], [1, 1], [0, 1], [1, 0]] as (0 | 1)[][]) {
      for (const start of [2, 4, 6, 8, 10, 12]) {
        for (const table of [1, 3, 5, 7, 9, 11, 13]) {
          for (const skew of [[], [1, 1, 2, 2, 3]]) {
            const mk = (past: readonly H4Entry[]): H4State =>
              choosing({
                turn: 1,
                c: dirs.length,
                tableSeen: [false, true],
                table,
                turnCards: dirs.map(() => 4),
                counts: without(skew),
                history: [
                  ...past,
                  entry(0, 2, true, 1, start),
                  ...dirs.map((d, i) => entry(1, d, true, i + 1)),
                ],
              });
            for (const depth of [3, 6]) {
              const a = nameOf(decideWith(pathfinder, depth, mk(honestPast), 1));
              const b = nameOf(decideWith(pathfinder, depth, mk(bluffPast), 1));
              if (a !== b) {
                found.push(`${dirs.join('')}/${start}/${table}/${depth}: ${a}→${b}`);
              }
            }
          }
        }
      }
    }
    expect(found.length).toBeGreaterThan(0);
  });

  it('玩家的收手紀錄在騙人（極端牌收手）：AI 對蓋牌的後驗被攤平（中間牌的機率變小），猜法的把握因此改變', () => {
    const chain = [entry(0, 0, true, 1), entry(0, 2, true, 1)];
    const honest = [7, 6, 8, 5].map((card) => entry(0, 2, true, 1, card));
    const bluff = [13, 1, 12, 2].map((card) => entry(0, 2, true, 1, card));
    const mk = (past: readonly H4Entry[]): H4State =>
      choosing({
        turn: 1,
        tableSeen: [true, false],
        counts: FULL,
        table: 6,
        history: [...past, entry(1, 2, true, 1, 3), ...chain],
      });
    const margin = (st: H4State): number => winChance(st, 1, 1) - winChance(st, 1, 0);
    expect(margin(mk(bluff))).not.toBeCloseTo(margin(mk(honest)), 3);
    expect(h4Game.evaluate(toFlip(mk(honest), 1, DOWN), 1).gain).not.toBe(
      h4Game.evaluate(toFlip(mk(bluff), 1, DOWN), 1).gain,
    );
  });

  it('同一個局面，深度 1 與 2 完全讀不到 stopBias（反射）：收手紀錄誠實或騙人，決定一樣', () => {
    for (const dirs of [[0], [1, 1], [0, 0, 0]] as (0 | 1)[][]) {
      for (const depth of [1, 2]) {
        const honest = bluffScene(dirs, HONEST, 6, FULL);
        const bluff = bluffScene(dirs, BLUFF, 6, FULL);
        for (const policy of POLICIES) {
          expect(nameOf(decideWith(policy, depth, honest, 1))).toBe(
            nameOf(decideWith(policy, depth, bluff, 1)),
          );
        }
      }
    }
  });

  it('AI 收手也看自己的名聲：AI 自己的收手紀錄在騙人（極端牌收手）→ 人對這次收手的讀法不同，收手的 gain 跟著變（至少有一個局面變）', () => {
    const honestPast = [7, 6, 8, 5].map((card) => entry(1, 2, true, 1, card));
    const bluffPast = [13, 1, 12, 2].map((card) => entry(1, 2, true, 1, card));
    let changed = 0;
    for (const dirs of [[0], [1], [0, 0], [1, 1], [0, 1], [1, 0]] as (0 | 1)[][]) {
      for (const start of [3, 5, 7, 9, 11]) {
        for (const table of [2, 4, 6, 7, 8, 10, 12]) {
          for (const skew of [[], [1, 1, 2, 2, 3], [11, 12, 12, 13, 13]]) {
            const mk = (past: readonly H4Entry[]): H4State =>
              choosing({
                turn: 1,
                c: dirs.length,
                tableSeen: [false, true],
                table,
                turnCards: dirs.map(() => 4),
                counts: without(skew),
                history: [
                  ...past,
                  entry(0, 2, true, 1, start),
                  ...dirs.map((d, i) => entry(1, d, true, i + 1)),
                ],
              });
            const stopGain = (past: readonly H4Entry[]): number =>
              h4Game.evaluate(h4Game.step(mk(past), press(1, STOP)), 1).gain;
            if (Math.abs(stopGain(honestPast) - stopGain(bluffPast)) > 1e-9) {
              changed += 1;
            }
          }
        }
      }
    }
    expect(changed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 性格
// ---------------------------------------------------------------------------

describe('H-4 比大小｜四種性格', () => {
  const middle = (totals: [number, number]): H4State =>
    choosing({
      turn: 1,
      c: 1,
      tableSeen: [false, true],
      table: 7,
      turnCards: [3],
      counts: FULL,
      totals,
    });

  it('賭徒型：落後很多時在中間牌也敢連，領先時早早收手', () => {
    expect(nameOf(decideWith(gambler, 1, middle([12, 0]), 1))).not.toBe('stop');
    expect(nameOf(decideWith(gambler, 1, middle([0, 12]), 1))).toBe('stop');
  });

  it('精準型：猜錯機率超過三成就收手；極端牌（猜錯機率低）才繼續', () => {
    const s7 = middle([0, 0]);
    expect(nameOf(decideWith(precise, 1, s7, 1))).toBe('stop');
    // 極端牌（猜錯機率低），而且對方一看連對的方向就知道該猜哪邊（留下去是壞局）→ 繼續
    const s13 = { ...s7, table: 13, history: [entry(1, 0, true, 1)] };
    expect(nameOf(decideWith(precise, 1, s13, 1))).not.toBe('stop');
  });

  it('貪心型：只看 gain、不看危險與比分——領先與落後的選擇一樣（跟賭徒型不同）', () => {
    for (const table of [4, 7, 10, 13]) {
      const lead = decideWith(greedy, 1, { ...middle([0, 12]), table }, 1);
      const trail = decideWith(greedy, 1, { ...middle([12, 0]), table }, 1);
      expect(nameOf(lead)).toBe(nameOf(trail));
    }
    expect(nameOf(decideWith(gambler, 1, middle([12, 0]), 1))).not.toBe(
      nameOf(decideWith(gambler, 1, middle([0, 12]), 1)),
    );
  });
});

// ---------------------------------------------------------------------------
// AI 能不能玩
// ---------------------------------------------------------------------------

describe('H-4 比大小｜AI 能不能玩', () => {
  it('兩個等級 5 的搜尋型打完一整場：在 maxTicks 之前結束', () => {
    const result = playMatch(
      h4Game,
      21,
      CONFIG,
      levelController(h4Game, pathfinder, 5, 21),
      levelController(h4Game, pathfinder, 5, 22),
    );
    expect(result.ticks).toBeLessThanOrEqual(3600);
  });

  it('隨機控制器（亂按）也能把一場打完：不會卡住', () => {
    for (const seed of [1, 2, 3, 4]) {
      const result = playMatch(
        h4Game,
        seed,
        CONFIG,
        levelController(h4Game, random, 5, seed),
        levelController(h4Game, random, 5, seed + 100),
      );
      expect(result.ticks).toBeLessThanOrEqual(3600);
    }
  });

  it('等級 10 的搜尋型對人類模型：40 個種子贏過半（座位輪流）', () => {
    let wins = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      const ai = levelController(h4Game, pathfinder, 10, seed);
      const human = humanModel(h4Game, seed + 1000);
      const aiSide: Side = seed % 2 === 0 ? 0 : 1;
      const r =
        aiSide === 0
          ? playMatch(h4Game, seed, CONFIG, ai, human)
          : playMatch(h4Game, seed, CONFIG, human, ai);
      wins += r.winner === null ? 0.5 : r.winner === aiSide ? 1 : 0;
    }
    expect(wins).toBeGreaterThan(20);
  });
});
