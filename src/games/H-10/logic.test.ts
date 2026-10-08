import { describe, expect, it } from 'vitest';

import { levelController, levelParams, wrapPolicy } from '../../ai/level';
import { humanModel } from '../../ai/human-model';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { random } from '../../ai/policies/random';
import { playMatch } from '../../core/match';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import type { Policy } from '../../ai/types';
import { AI_WAIT_TICKS, DECISION_TIMEOUT, IDLE } from '../_hearts/logic';
import {
  BUDGET,
  confidenceLevel,
  FAIR_LEVEL,
  ITEMS,
  LEVEL_BUTTONS,
  LEVEL_PCT,
  LOCK_TICKS,
  bidOf,
  h10Game,
  makeState,
  predictOpponent,
  remainingValue,
  RESULT_TICKS,
} from './logic';
import type { H10State, Level } from './logic';

/**
 * H-10 暗標的規則測試（規則見 `docs/cards/H-10.md`）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 關鍵的三組：不偷看（含故意洩漏、確認偵測器會紅）、AI 會讀對手（深度 ≥ 3 才讀）、騙它（餵了再破）。
 */

const CONFIG = { maxTicks: 3600, params: {} };

/** 預設順序（makeState 的 values）：3 8 1 6 10 2 7 4 9 5。 */
const ORDER = [3, 8, 1, 6, 10, 2, 7, 4, 9, 5];

function idle(): Inputs {
  return [IDLE, IDLE];
}

/** 兩邊各選一個檔位（`null` 是不按）。 */
function pick(l0: Level | null, l1: Level | null): Inputs {
  return [
    l0 === null ? IDLE : (LEVEL_BUTTONS[l0] as Buttons),
    l1 === null ? IDLE : (LEVEL_BUTTONS[l1] as Buttons),
  ];
}

function stepN(state: H10State, n: number, inputs: Inputs = idle()): H10State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = h10Game.step(s, inputs);
  }
  return s;
}

function choosing(overrides: Partial<H10State> = {}): H10State {
  return makeState({ phase: 'choose', wait: 0, ...overrides });
}

/** 從 choose 開始：兩邊同一個 tick 選好，走完鎖定與揭示的第一步（結果算出來，還沒入帳）。 */
function toResolve(state: H10State, l0: Level, l1: Level): H10State {
  const locked = h10Game.step(state, pick(l0, l1));
  return stepN(locked, LOCK_TICKS);
}

/** 從 choose 開始：選好、揭示、入帳（下一件的 prep 或結束）。 */
function playItem(state: H10State, l0: Level, l1: Level): H10State {
  return stepN(toResolve(state, l0, l1), RESULT_TICKS);
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

/** 這個按鍵是哪個檔位（沒有對應回傳 null）。 */
function levelOf(buttons: Buttons): Level | null {
  const index = LEVEL_BUTTONS.findIndex((b) => sameButtons(b, buttons));
  return index < 0 ? null : (index as Level);
}

/** 一筆歷史：兩邊選的檔位（出價用一個大概的數字，模型只讀檔位）。 */
function rec(value: number, l0: Level, l1: Level): H10State['history'][number] {
  const winner = l0 === l1 ? null : l0 > l1 ? 0 : 1;
  return { value, levels: [l0, l1], bids: [l0 * 3, l1 * 3], winner };
}

/** 對手（0 號邊）一連串的檔位，AI（1 號邊）永遠出公平價。 */
function oppHistory(levels: readonly Level[], values?: readonly number[]): H10State['history'] {
  return levels.map((l, i) => rec(values?.[i] ?? 3, l, FAIR_LEVEL as Level));
}

/** 用搜尋型、指定深度（沒有延遲、不亂選）替某一邊決定按什麼。 */
function decideAtDepth(
  state: H10State,
  side: Side,
  depth: number,
  policy: Policy = pathfinder,
): Buttons {
  const controller = wrapPolicy(
    h10Game,
    policy,
    { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
    7,
  );
  return controller.decide(state, side, 0);
}

describe('H-10 暗標｜初始與常數', () => {
  it('第 0 件、準備階段（還要等 45 tick）、預算各 100、沒有歷史；價值是 1 到 10 的排列，由種子決定', () => {
    const s = h10Game.init(5, CONFIG);
    expect(s.item).toBe(0);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.budget).toEqual([BUDGET, BUDGET]);
    expect(s.got).toEqual([0, 0]);
    expect(s.history).toEqual([]);
    expect(s.pending).toEqual([null, null]);
    expect([...s.values].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(h10Game.init(5, CONFIG).values).toEqual(s.values);
    const orders = new Set(
      Array.from({ length: 10 }, (_, seed) => h10Game.init(seed, CONFIG).values.join(',')),
    );
    expect(orders.size).toBeGreaterThan(5);
    expect(ITEMS).toBe(10);
    expect(BUDGET).toBe(100);
    expect(LEVEL_PCT).toEqual([0, 50, 80, 100, 130, 180]);
    expect(LEVEL_PCT[FAIR_LEVEL]).toBe(100);
    expect(RESULT_TICKS).toBe(60);
  });

  it('remainingValue：從第 item 件到最後一件的價值總和（含這一件）', () => {
    expect(remainingValue(ORDER, 0)).toBe(55);
    expect(remainingValue(ORDER, 1)).toBe(52);
    expect(remainingValue(ORDER, 9)).toBe(5);
  });
});

describe('H-10 暗標｜出價怎麼算', () => {
  it('出價 = 檔位倍數 × 公平價（價值 × 剩餘預算 ÷ 剩餘價值，含這件），四捨五入；棄標是 0', () => {
    // 價值 3、預算 100、剩餘價值 55：公平價 5.45
    expect([0, 1, 2, 3, 4, 5].map((l) => bidOf(l as Level, 3, 100, 55))).toEqual([
      0, 3, 4, 5, 7, 10,
    ]);
    // 價值 10、預算 100、剩餘價值 55：公平價 18.18
    expect([0, 1, 2, 3, 4, 5].map((l) => bidOf(l as Level, 10, 100, 55))).toEqual([
      0, 9, 15, 18, 24, 33,
    ]);
  });

  it('不超過剩餘預算；最後一件的公平價就是全部的預算，所以公平價以上都是 all-in', () => {
    expect(bidOf(5, 10, 20, 10)).toBe(20);
    expect(bidOf(5, 10, 20, 55)).toBe(7);
    expect([3, 4, 5].map((l) => bidOf(l as Level, 5, 37, 5))).toEqual([37, 37, 37]);
    expect(bidOf(2, 5, 37, 5)).toBe(30);
    expect(bidOf(5, 4, 0, 10)).toBe(0);
  });
});

describe('H-10 暗標｜規則', () => {
  it('1. 準備 45 tick：這段時間兩邊的輸入都被忽略（邊界：第 45 個 tick 按無效，第 46 個 tick 才算）', () => {
    let s = h10Game.init(1, CONFIG);
    s = stepN(s, 44, pick(5, 5));
    expect(s.phase).toBe('prep');
    expect(s.pending).toEqual([null, null]);
    s = h10Game.step(s, pick(5, 5));
    expect(s.phase).toBe('choose');
    expect(s.pending).toEqual([null, null]);
    s = h10Game.step(s, pick(5, 5));
    expect(s.pending).toEqual([5, 5]);
  });

  it('2. 選檔位只寫進 pending，不當場結算：預算不動、階段 locked、歷史沒有新的一筆', () => {
    const s = h10Game.step(choosing(), pick(4, null));
    expect(s.phase).toBe('choose');
    expect(s.pending).toEqual([4, null]);
    const both = h10Game.step(s, pick(null, 2));
    expect(both.phase).toBe('locked');
    expect(both.wait).toBe(LOCK_TICKS);
    expect(both.budget).toEqual([100, 100]);
    expect(both.got).toEqual([0, 0]);
    expect(both.history).toHaveLength(0);
  });

  it('3. 選了就不能改：再按別的鍵沒有用', () => {
    let s = h10Game.step(choosing(), pick(4, null));
    s = h10Game.step(s, pick(1, null));
    s = h10Game.step(s, pick(0, null));
    expect(s.pending).toEqual([4, null]);
  });

  it('4. 按鍵對應：b 棄標、← ×0.5、↓ ×0.8、a 公平價、→ ×1.3、↑ ×1.8；同時按好幾個鍵：b > ↑ > → > ↓ > ← > a', () => {
    const press = (b: Partial<Buttons>): Level | null =>
      h10Game.step(choosing(), [{ ...IDLE, ...b }, IDLE]).pending[0];
    expect(press({ b: true })).toBe(0);
    expect(press({ left: true })).toBe(1);
    expect(press({ down: true })).toBe(2);
    expect(press({ a: true })).toBe(3);
    expect(press({ right: true })).toBe(4);
    expect(press({ up: true })).toBe(5);
    expect(press({ a: true, up: true, b: true })).toBe(0);
    expect(press({ a: true, up: true, left: true })).toBe(5);
    expect(press({ a: true, right: true, left: true })).toBe(4);
    expect(press({ a: true, down: true, left: true })).toBe(2);
    expect(press({ a: true, left: true })).toBe(1);
    expect(press({})).toBeNull();
  });

  it('5. 結算順序：兩邊都選好 → 鎖定 2 tick → 揭示（結果算出來、預算與分數還沒動）→ 停 60 tick → 入帳、歷史加一筆、進下一件的準備', () => {
    const s0 = choosing();
    const locked = h10Game.step(s0, pick(4, 3));
    expect(locked.phase).toBe('locked');
    const stillLocked = h10Game.step(locked, idle());
    expect(stillLocked.phase).toBe('locked');
    const resolve = h10Game.step(stillLocked, idle());
    expect(resolve.phase).toBe('resolve');
    expect(resolve.wait).toBe(RESULT_TICKS);
    expect(resolve.last?.bids).toEqual([7, 5]);
    expect(resolve.last?.winner).toBe(0);
    expect(resolve.budget).toEqual([100, 100]);
    expect(resolve.got).toEqual([0, 0]);
    expect(resolve.history).toHaveLength(0);
    const nearly = stepN(resolve, RESULT_TICKS - 1);
    expect(nearly.phase).toBe('resolve');
    expect(nearly.history).toHaveLength(0);
    const banked = h10Game.step(nearly, idle());
    expect(banked.phase).toBe('prep');
    expect(banked.wait).toBe(AI_WAIT_TICKS);
    expect(banked.item).toBe(1);
    expect(banked.budget).toEqual([93, 100]);
    expect(banked.got).toEqual([3, 0]);
    expect(banked.pending).toEqual([null, null]);
    expect(banked.last).toBeNull();
    expect(banked.history).toEqual([{ value: 3, levels: [4, 3], bids: [7, 5], winner: 0 }]);
  });

  it('6. 第一價格：贏的人付自己的出價（不是對方的），輸的人不付錢；AI 側（1 號邊）贏也一樣', () => {
    const win0 = playItem(choosing(), 5, 1);
    expect(win0.budget).toEqual([100 - 10, 100]);
    expect(win0.got).toEqual([3, 0]);
    const win1 = playItem(choosing(), 2, 4);
    expect(win1.budget).toEqual([100, 100 - 7]);
    expect(win1.got).toEqual([0, 3]);
  });

  it('7. 出一樣高：誰都拿不到、不付錢，物品作廢（同檔位、棄標對棄標都是）', () => {
    for (const level of [0, 3, 5] as const) {
      const s = playItem(choosing(), level, level);
      expect(s.budget).toEqual([100, 100]);
      expect(s.got).toEqual([0, 0]);
      expect(s.history[0]?.winner).toBeNull();
    }
  });

  it('8.（邊界）預算不同時，同一個檔位出價不同；出價相同（四捨五入或被預算截斷）也作廢', () => {
    // 0 號邊剩 40，公平價 3 × 40 / 55 = 2.18 → 2；1 號邊剩 100，×0.5 = 2.73 → 3：輸
    const s = playItem(choosing({ budget: [40, 100] }), 3, 1);
    expect(s.history[0]?.bids).toEqual([2, 3]);
    expect(s.history[0]?.winner).toBe(1);
    // 最後一件：兩邊預算相同，公平價以上都是 all-in，同價作廢
    const last = choosing({ item: 9, budget: [30, 30], got: [20, 20] });
    const tie = playItem(last, 5, 3);
    expect(tie.history[0]?.bids).toEqual([30, 30]);
    expect(tie.history[0]?.winner).toBeNull();
  });

  it('9.（邊界）超時：choose 的第 300 個 tick 還沒選的那一邊自動棄標；第 300 個 tick 按了算選了', () => {
    const s0 = choosing();
    const waited = stepN(s0, DECISION_TIMEOUT - 1);
    expect(waited.phase).toBe('choose');
    const timedOut = h10Game.step(waited, pick(4, null));
    expect(timedOut.pending).toEqual([4, 0]);
    expect(timedOut.phase).toBe('locked');
    const nobody = h10Game.step(waited, idle());
    expect(nobody.pending).toEqual([0, 0]);
    const justInTime = h10Game.step(waited, pick(2, 3));
    expect(justInTime.pending).toEqual([2, 3]);
  });

  it('10. 打完 10 件：拿到的價值多的贏；結束之後 step 原樣回傳；結束前 winner 是 null', () => {
    let s = choosing();
    for (let i = 0; i < ITEMS; i += 1) {
      expect(h10Game.isOver(s)).toBe(false);
      expect(h10Game.winner(s)).toBeNull();
      s = playItem(s, 5, 0);
      if (i < ITEMS - 1) {
        s = stepN(s, AI_WAIT_TICKS);
      }
    }
    expect(h10Game.isOver(s)).toBe(true);
    // 0 號邊每件 ×1.8、1 號邊棄標：預算用完之前贏，用完之後 0 對 0 作廢
    expect(s.got[0]).toBeGreaterThan(0);
    expect(s.got[1]).toBe(0);
    expect(h10Game.winner(s)).toBe(0);
    expect(h10Game.score(s)).toEqual([s.got[0], 0]);
    expect(h10Game.step(s, pick(5, 5))).toBe(s);
  });

  it('11.（邊界）打完分數一樣：平手（winner 是 null）', () => {
    const s = playItem(choosing({ item: 9, got: [25, 25], budget: [30, 30] }), 3, 3);
    expect(s.over).toBe(true);
    expect(h10Game.winner(s)).toBeNull();
  });

  it('12.（邊界）時間到（第 maxTicks 個 tick）：已經揭示的先入帳；還在 choose 或 locked 的不算', () => {
    const resolving = toResolve(choosing({ maxTicks: 100, tick: 90 }), 4, 3);
    // tick 90 → 93 揭示；還有 7 個 tick 到 100
    const ended = stepN(resolving, 7);
    expect(ended.over).toBe(true);
    expect(ended.got).toEqual([3, 0]);
    expect(ended.budget).toEqual([93, 100]);
    const stuck = stepN(choosing({ maxTicks: 100, tick: 95 }), 5, pick(4, null));
    expect(stuck.over).toBe(true);
    expect(stuck.got).toEqual([0, 0]);
  });

  it('13. 沒有人按任何鍵：每件 45 + 300 + 2 + 60 = 407 tick，10 件超過 3600，所以時間上限是必要的，而且會結束', () => {
    let s = h10Game.init(2, CONFIG);
    let ticks = 0;
    while (!h10Game.isOver(s) && ticks < 4000) {
      s = h10Game.step(s, idle());
      ticks += 1;
    }
    expect(ticks).toBe(3600);
    expect(s.got).toEqual([0, 0]);
  });

  it('14. 歷史存在 state 裡：大小有上限（最多 10 筆），整場 JSON 來回不變', () => {
    let s = h10Game.init(3, CONFIG);
    for (let i = 0; i < 4000 && !s.over; i += 1) {
      s = h10Game.step(s, pick((i % 6) as Level, ((i * 5) % 6) as Level));
    }
    expect(s.history.length).toBeLessThanOrEqual(ITEMS);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('15. step 不改動傳進來的 state 與輸入（深度凍結也不丟錯），各階段都一樣', () => {
    const states = [
      makeState(),
      choosing(),
      h10Game.step(choosing(), pick(4, 3)),
      toResolve(choosing(), 4, 3),
      playItem(choosing({ item: 9, budget: [30, 30], got: [20, 20] }), 3, 3),
    ];
    for (const s of states) {
      const copy = JSON.parse(JSON.stringify(s)) as H10State;
      const frozen = deepFreeze(s);
      const inputs = deepFreeze(pick(4, 2));
      expect(() => h10Game.step(frozen, inputs)).not.toThrow();
      expect(frozen).toEqual(copy);
    }
  });

  it('16. 對手模型開關是 config.params.model（預設開）；關掉之後 state.model 是 false', () => {
    expect(h10Game.init(1, CONFIG).model).toBe(true);
    expect(h10Game.init(1, { maxTicks: 3600, params: { model: 0 } }).model).toBe(false);
    expect(h10Game.init(1, { maxTicks: 3600, params: { model: 1 } }).model).toBe(true);
  });
});

describe('H-10 暗標｜actions 與 evaluate', () => {
  it('actions：choose 而且還沒選是六個檔位（公平價排第一）；選過、其他階段、結束只有 [全放開]', () => {
    const acts = h10Game.actions(choosing(), 0);
    expect(acts).toHaveLength(6);
    expect(sameButtons(acts[0] as Buttons, LEVEL_BUTTONS[FAIR_LEVEL] as Buttons)).toBe(true);
    expect(new Set(acts.map((a) => levelOf(a))).size).toBe(6);
    expect(h10Game.actions(choosing({ pending: [4, null] }), 0)).toEqual([IDLE]);
    expect(h10Game.actions(choosing({ pending: [4, null] }), 1)).toHaveLength(6);
    expect(h10Game.actions(makeState(), 0)).toEqual([IDLE]);
    expect(h10Game.actions(h10Game.step(choosing(), pick(4, 3)), 0)).toEqual([IDLE]);
    expect(h10Game.actions(toResolve(choosing(), 4, 3), 1)).toEqual([IDLE]);
  });

  it('evaluate：每個階段 gain 有限、danger 在 0 到 1；結束的局有勝負加成', () => {
    const states = [
      makeState(),
      choosing(),
      h10Game.step(choosing(), pick(4, 3)),
      toResolve(choosing({ history: oppHistory([3, 3]), item: 2 }), 4, 3),
    ];
    for (const s of states) {
      for (const side of [0, 1] as const) {
        const e = h10Game.evaluate(s, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
    const won = playItem(choosing({ item: 9, got: [30, 20], budget: [30, 30] }), 3, 0);
    expect(h10Game.evaluate(won, 0).gain).toBeGreaterThan(900);
    expect(h10Game.evaluate(won, 1).gain).toBeLessThan(-900);
  });
});

describe('H-10 暗標｜不偷看（evaluate、actions 只讀自己的 pending 與公開資訊）', () => {
  const history: H10State['history'] = [rec(3, 3, 4), rec(8, 4, 3), rec(1, 0, 0)];
  const base = {
    history,
    item: 3,
    budget: [86, 92] as [number, number],
    got: [8, 3] as [number, number],
  };

  /** 一組只有 0 號邊（對手）隱藏資訊不同的 state；AI 坐 1 號邊。 */
  function variants(): { name: string; states: H10State[] }[] {
    const groups: { name: string; states: H10State[] }[] = [];
    groups.push({
      name: 'choose：對手的 pending（沒選、六個檔位）',
      states: ([null, 0, 1, 2, 3, 4, 5] as const).map((p) =>
        choosing({ ...base, pending: [p, null] }),
      ),
    });
    groups.push({
      name: 'choose：AI 自己選過、對手的 pending 不同',
      states: ([null, 0, 3, 5] as const).map((p) => choosing({ ...base, pending: [p, 3] })),
    });
    groups.push({
      name: 'locked：對手的檔位不同',
      states: ([0, 1, 2, 3, 4, 5] as const).map((p) =>
        makeState({ ...base, phase: 'locked', wait: LOCK_TICKS, pending: [p, 4] }),
      ),
    });
    groups.push({
      name: 'resolve：對手的檔位與揭示結果（last）不同',
      states: ([0, 1, 2, 3, 4, 5] as const).map((p) => toResolve(choosing({ ...base }), p, 4)),
    });
    groups.push({
      name: 'resolve：AI 自己棄標',
      states: ([0, 2, 5] as const).map((p) => toResolve(choosing({ ...base }), p, 0)),
    });
    return groups;
  }

  function peeks(game: Game<H10State>, states: readonly H10State[], side: Side): boolean {
    const first = states[0] as H10State;
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
      expect(peeks(h10Game, g.states, 1), g.name).toBe(false);
    }
  });

  it('反過來也成立：AI 坐 0 號邊，只有 1 號邊的隱藏資訊不同', () => {
    const mirror = (s: H10State): H10State => ({
      ...s,
      budget: [s.budget[1], s.budget[0]],
      got: [s.got[1], s.got[0]],
      pending: [s.pending[1], s.pending[0]],
      history: s.history.map((h) => ({
        ...h,
        levels: [h.levels[1], h.levels[0]],
        bids: [h.bids[1], h.bids[0]],
        winner: h.winner === null ? null : ((1 - h.winner) as Side),
      })),
      last:
        s.last === null
          ? null
          : {
              levels: [s.last.levels[1], s.last.levels[0]],
              bids: [s.last.bids[1], s.last.bids[0]],
              winner: s.last.winner === null ? null : ((1 - s.last.winner) as Side),
            },
    });
    for (const g of variants()) {
      expect(peeks(h10Game, g.states.map(mirror), 0), g.name).toBe(false);
    }
  });

  it('黑箱：四個性格在深度 1、3、6，只有對手 pending 不同的 choose 局面，按的鍵都相同', () => {
    const policies: readonly Policy[] = [pathfinder, precise, greedy, gambler];
    const spots = [
      choosing({ ...base }),
      choosing({ ...base, item: 6, history: oppHistory([3, 3, 3, 3, 1, 1]), budget: [60, 90] }),
      choosing({
        ...base,
        item: 9,
        history: oppHistory([4, 4, 4, 4, 4, 4, 4, 4, 4]),
        budget: [10, 55],
      }),
    ];
    for (const spot of spots) {
      for (const policy of policies) {
        for (const depth of [1, 3, 6]) {
          const presses = ([null, 0, 1, 2, 3, 4, 5] as const).map((p) =>
            decideAtDepth({ ...spot, pending: [p, null] }, 1, depth, policy),
          );
          for (const press of presses) {
            expect(press, `${policy.name} 深度 ${depth}`).toEqual(presses[0]);
          }
        }
      }
    }
  });

  it('偵測器本身有效：故意洩漏（讀對手的 pending、讀 last 的對手出價、讀對手的檔位、讓 actions 多一個動作）一定被抓到', () => {
    const groups = variants();
    const leaks: Record<string, (s: H10State, side: Side) => number> = {
      '讀對手的 pending（locked）': (s, side) => {
        const p = s.pending[1 - side];
        return s.phase === 'locked' && p !== null ? 0.001 * p : 0;
      },
      '讀對手的 pending（choose）': (s, side) => {
        const p = s.pending[1 - side];
        return s.phase === 'choose' && p !== null ? 0.001 * p : 0;
      },
      '讀 last 裡對手的出價': (s, side) =>
        s.last === null ? 0 : 0.001 * (s.last.bids[1 - side] as number),
      '讀 last 的贏家': (s, side) =>
        s.last === null ? 0 : s.last.winner === side ? 0.001 : s.last.winner === null ? 0 : -0.001,
      '讀 resolve 階段對手的 pending': (s, side) => {
        const p = s.pending[1 - side];
        return s.phase === 'resolve' && p !== null ? 0.001 * p : 0;
      },
    };
    for (const [name, extra] of Object.entries(leaks)) {
      const leaky: Game<H10State> = {
        ...h10Game,
        evaluate: (s, side) => {
          const e = h10Game.evaluate(s, side);
          return { gain: e.gain + extra(s, side), danger: e.danger };
        },
      };
      const caught = groups.some((g) => peeks(leaky, g.states, 1));
      expect(caught, `沒抓到洩漏：${name}`).toBe(true);
    }
    const leakyActions: Game<H10State> = {
      ...h10Game,
      actions: (s, side) =>
        s.pending[1 - side] === 5 ? [...h10Game.actions(s, side), IDLE] : h10Game.actions(s, side),
    };
    expect(groups.some((g) => peeks(leakyActions, g.states, 1))).toBe(true);
    // 往前模擬也抓得到：搜尋型的決定會因為洩漏而不同
    const leakyResolve: Game<H10State> = {
      ...h10Game,
      evaluate: (s, side) => {
        const e = h10Game.evaluate(s, side);
        const w =
          s.last === null ? 0 : s.last.winner === side ? 5 : s.last.winner === null ? 0 : -5;
        return { gain: e.gain + w, danger: 0 };
      },
    };
    const decisions = ([null, 0, 3, 5] as const).map((p) => {
      const controller = wrapPolicy(
        leakyResolve,
        pathfinder,
        { reactionTicks: 0, decideEvery: 1, depth: 3, epsilon: 0 },
        7,
      );
      return JSON.stringify(controller.decide(choosing({ ...base, pending: [p, null] }), 1, 0));
    });
    expect(new Set(decisions).size).toBeGreaterThan(1);
  });
});

describe('H-10 暗標｜對手模型 predictOpponent（只讀 history）', () => {
  it('沒有歷史：先驗，全部的機率在公平價（加一點點底噪）；機率加起來是 1', () => {
    const p = predictOpponent([], 1, true);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(p[FAIR_LEVEL] as number).toBeGreaterThan(0.7);
    expect(Math.max(...p)).toBe(p[FAIR_LEVEL]);
  });

  it('最近的件權重大：連出保守之後，保守的機率高過先驗；一次公平價不夠把它蓋回去', () => {
    const lowThenFair = predictOpponent(oppHistory([1, 1, 1]), 1, true);
    expect(lowThenFair[1] as number).toBeGreaterThan(lowThenFair[FAIR_LEVEL] as number);
    const fresh = predictOpponent(oppHistory([1, 1, 1, 4]), 1, true);
    expect(fresh[4] as number).toBeGreaterThan(0.25);
  });

  it('窗口只有最近 4 件：更早的紀錄不影響（可以被覆寫）', () => {
    const a = predictOpponent(oppHistory([0, 0, 0, 3, 3, 3, 3]), 1, true);
    const b = predictOpponent(oppHistory([5, 5, 5, 3, 3, 3, 3]), 1, true);
    expect(a).toEqual(b);
    const recent = predictOpponent(oppHistory([3, 3, 3, 3, 1, 1, 1, 1]), 1, true);
    expect(recent[1] as number).toBeGreaterThan(0.6);
  });

  it('模型關掉：永遠是先驗，不管歷史；只讀 history，不改動傳進來的陣列', () => {
    const prior = predictOpponent([], 1, true);
    expect(predictOpponent(oppHistory([0, 0, 0, 0]), 1, false)).toEqual(prior);
    const h = deepFreeze(oppHistory([1, 1, 4]));
    expect(() => predictOpponent(h, 1, true)).not.toThrow();
    expect(predictOpponent(h, 1, true)).toEqual(predictOpponent(h, 1, true));
  });

  it('從 AI 的兩個方向看都成立：predictOpponent(history, side) 預測的是 side 的對手', () => {
    const h: H10State['history'] = [rec(3, 1, 3), rec(3, 1, 3), rec(3, 1, 3)];
    expect(predictOpponent(h, 1, true)[1] as number).toBeGreaterThan(0.4);
    expect(predictOpponent(h, 0, true)[FAIR_LEVEL] as number).toBeGreaterThan(0.7);
  });

  it('confidenceLevel：粗粒度 0 到 3 四級；沒有歷史是 0；一貫的對手比亂的高；不說是哪一個檔位', () => {
    expect(confidenceLevel([], 1, true)).toBe(0);
    const steady = confidenceLevel(oppHistory([1, 1, 1, 1]), 1, true);
    const messy = confidenceLevel(oppHistory([0, 5, 2, 4]), 1, true);
    expect(steady).toBeGreaterThan(messy);
    for (const l of [0, 1, 2, 3, 4, 5] as const) {
      const level = confidenceLevel(oppHistory([l, l, l, l]), 1, true);
      expect([0, 1, 2, 3]).toContain(level);
    }
  });
});

describe('H-10 暗標｜AI 怎麼出價（等級曲線從結算流程長出來）', () => {
  /** AI 坐 1 號邊，第 item 件，雙方預算相同。 */
  function spot(history: H10State['history'], item = 4, extra: Partial<H10State> = {}): H10State {
    return choosing({ item, history, ...extra });
  }

  it('深度 1 與 2 走不到揭示：永遠出公平價，不管對手的歷史（完全可預測）', () => {
    for (const history of [
      oppHistory([3, 3, 3, 3]),
      oppHistory([0, 0, 0, 0]),
      oppHistory([5, 5, 5, 5]),
    ]) {
      for (const depth of [1, 2]) {
        expect(levelOf(decideAtDepth(spot(history), 1, depth))).toBe(FAIR_LEVEL);
      }
    }
  });

  it('深度 3 以上走得到揭示：對手一直出公平價 → 出 ×1.3 贏下它（比公平價高一檔、不是最高的一檔）', () => {
    for (const depth of [3, 4, 6]) {
      expect(levelOf(decideAtDepth(spot(oppHistory([3, 3, 3, 3])), 1, depth))).toBe(4);
    }
  });

  it('對手一直棄標：出最便宜的會贏的檔位（×0.5），不浪費預算', () => {
    for (const depth of [3, 6]) {
      expect(levelOf(decideAtDepth(spot(oppHistory([0, 0, 0, 0])), 1, depth))).toBe(1);
    }
  });

  it('騙它（機制上做得到）：同一個局面（價值 10 的件、預算相同），歷史是「連出公平價」AI 出 ×1.3 以上，歷史是「連續四件棄標」AI 退到 ×0.5（窗口整個被餵滿）', () => {
    const fed = decideAtDepth(spot(oppHistory([0, 0, 0, 0], [3, 8, 1, 6])), 1, 6);
    const honest = decideAtDepth(spot(oppHistory([3, 3, 3, 3], [3, 8, 1, 6])), 1, 6);
    expect(levelOf(fed)).toBe(1);
    expect(levelOf(honest) as number).toBeGreaterThanOrEqual(4);
  });

  it('騙它的代價不對稱（機制）：被餵滿的 AI 出 ×0.5，你破的公平價拿下價值 10 的件；餵的四件（價值 3、8、1、6）是你自己決定要不要真的付出的', () => {
    const s = spot(oppHistory([0, 0, 0, 0], [3, 8, 1, 6]));
    expect(s.values[4]).toBe(10);
    const aiLevel = levelOf(decideAtDepth(s, 1, 6)) as Level;
    const resolved = playItem(s, FAIR_LEVEL as Level, aiLevel);
    expect(resolved.got[0]).toBe(10);
    expect(resolved.got[1]).toBe(0);
  });

  it('只餵兩件還不夠讓 AI 退（它對最近一件之外的證據有保留）：歷史 [公平, 公平, 棄標, 棄標] 時 AI 還是出 ×1.3', () => {
    const s = spot(oppHistory([3, 3, 0, 0], [3, 8, 1, 6]));
    expect(levelOf(decideAtDepth(s, 1, 6))).toBe(4);
  });

  it('最後一件：預算不再值錢，AI 會 all-in（出價 = 剩餘預算）', () => {
    const s = choosing({
      item: 9,
      budget: [40, 55],
      got: [20, 20],
      history: oppHistory([3, 3, 3, 3, 3, 3, 3, 3, 3]),
    });
    const level = levelOf(decideAtDepth(s, 1, 6)) as Level;
    expect(bidOf(level, 5, 55, 5)).toBe(55);
  });

  it('預算快用完時 AI 不亂追：預算 0 就只能出 0（任何檔位）', () => {
    const s = choosing({ item: 6, budget: [60, 0], history: oppHistory([4, 4, 4, 4, 4, 4]) });
    const level = decideAtDepth(s, 1, 6);
    expect(h10Game.actions(s, 1)).toContainEqual(level);
    const after = playItem(s, 3, levelOf(level) as Level);
    expect(after.budget[1]).toBe(0);
  });

  it('模型關掉（消融）：不管歷史，AI 的選擇和沒有歷史時一樣', () => {
    const off = (history: H10State['history']): string =>
      JSON.stringify(decideAtDepth(spot(history, 4, { model: false }), 1, 6));
    expect(off(oppHistory([0, 0, 0, 0]))).toBe(off([]));
    expect(off(oppHistory([5, 5, 5, 5]))).toBe(off([]));
  });
});

describe('H-10 暗標｜等級曲線從結算流程長出來（DESIGN-AI-FUN 10.6 的兩個陷阱）', () => {
  /** 從 choose 局面用指定深度跑 decide，回傳模擬過程中 evaluate 看過的階段。 */
  function phasesSeen(depth: number, state: H10State, side: Side): Set<string> {
    const seen = new Set<string>();
    const spy: Game<H10State> = {
      ...h10Game,
      evaluate: (s, who) => {
        seen.add(s.phase);
        return h10Game.evaluate(s, who);
      },
    };
    const controller = wrapPolicy(
      spy,
      pathfinder,
      { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
      7,
    );
    controller.decide(state, side, 0);
    return seen;
  }

  it('陷阱二：actions()[0] 是會推進流程的動作（公平價），不是什麼都不按；模擬裡的對手按它就會鎖定', () => {
    const acts = h10Game.actions(choosing(), 0);
    expect(levelOf(acts[0] as Buttons)).toBe(FAIR_LEVEL);
    const afterOne = h10Game.step(choosing(), [acts[0] as Buttons, acts[0] as Buttons]);
    expect(afterOne.phase).toBe('locked');
    // 對手已經真的選過了：模擬裡我再按，一樣鎖定
    const oppDone = h10Game.step(choosing({ pending: [3, null] }), [IDLE, acts[0] as Buttons]);
    expect(oppDone.phase).toBe('locked');
  });

  it('陷阱一：選 → 鎖定 → 揭示一共 3 步，在 depth 的 6 格額度之內：深度 1、2 的 decide 沒評估過 resolve，深度 3 以上評估過', () => {
    const state = choosing({ item: 4, history: oppHistory([3, 3, 3, 3]) });
    for (const side of [0, 1] as const) {
      expect(phasesSeen(1, state, side).has('resolve')).toBe(false);
      expect(phasesSeen(2, state, side).has('resolve')).toBe(false);
      for (const depth of [3, 4, 6]) {
        expect(phasesSeen(depth, state, side).has('resolve'), `深度 ${depth} 側 ${side}`).toBe(
          true,
        );
      }
    }
  });

  it('等級曲線是階梯：深度 1、2 永遠出公平價（讀不到歷史），深度 3 以上同一個局面會因歷史而不同', () => {
    const picks = (depth: number): Set<number> =>
      new Set(
        [oppHistory([3, 3, 3, 3]), oppHistory([0, 0, 0, 0]), oppHistory([4, 4, 4, 4])].map(
          (h) => levelOf(decideAtDepth(choosing({ item: 4, history: h }), 1, depth)) as number,
        ),
      );
    expect(picks(1).size).toBe(1);
    expect(picks(2).size).toBe(1);
    expect(picks(3).size).toBeGreaterThan(1);
    expect(picks(6).size).toBeGreaterThan(1);
  });
});

describe('H-10 暗標｜AI 能不能玩', () => {
  it('兩個等級 5 的搜尋型打完一整場：10 件都打完，在 maxTicks 之前結束', () => {
    for (const seed of [1, 2, 3]) {
      const a = levelController(h10Game, pathfinder, 5, seed);
      const b = levelController(h10Game, pathfinder, 5, seed + 1_000_003);
      const r = playMatch(h10Game, seed, CONFIG, a, b);
      expect(r.ticks).toBeLessThan(3600);
      expect(r.score[0] + r.score[1]).toBeLessThanOrEqual(55);
    }
  });

  it('等級 10 的 AI 對人類模型：20 個種子裡贏多數；等級 1 對人類模型不是這樣（兩邊都出公平價，多半作廢）', () => {
    let wins10 = 0;
    for (let seed = 0; seed < 20; seed += 1) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const ai = levelController(h10Game, pathfinder, 10, seed);
      const human = humanModel(h10Game, seed + 1_000_003);
      const r =
        side === 0
          ? playMatch(h10Game, seed, CONFIG, ai, human)
          : playMatch(h10Game, seed, CONFIG, human, ai);
      wins10 += r.winner === side ? 1 : 0;
    }
    expect(wins10).toBeGreaterThanOrEqual(14);
  });

  it('等級 10 不輸給「永遠同一檔」的腳本玩家（×1.3、×1.8、公平價）：籌碼的影子價格太高估時（GAMMA = 1）它對 ×1.8 只贏 11%', () => {
    for (const level of [3, 4, 5] as const) {
      let points = 0;
      const n = 60;
      for (let seed = 0; seed < n; seed += 1) {
        const aiSide: Side = seed % 2 === 0 ? 0 : 1;
        const ai = levelController(h10Game, pathfinder, 10, seed);
        const flat = {
          decide: (s: H10State, side: Side): Buttons =>
            s.phase === 'choose' && s.pending[side] === null
              ? (LEVEL_BUTTONS[level] as Buttons)
              : IDLE,
        };
        const r =
          aiSide === 0
            ? playMatch(h10Game, seed, CONFIG, ai, flat)
            : playMatch(h10Game, seed, CONFIG, flat, ai);
        points += r.winner === null ? 0.5 : r.winner === aiSide ? 1 : 0;
      }
      expect(points / n, `固定檔位 ${level}`).toBeGreaterThan(0.5);
    }
  });

  it('隨機控制器（亂按）也能把一場打完：不會卡住', () => {
    const a = levelController(h10Game, random, 10, 3);
    const b = levelController(h10Game, random, 10, 4);
    expect(() => playMatch(h10Game, 3, CONFIG, a, b)).not.toThrow();
  });

  it('等級參數沒有被誤用：深度 3 是第一個走得到揭示的深度（levelParams 的 depth 範圍 1 到 6）', () => {
    expect(levelParams(1).depth).toBe(1);
    expect(levelParams(10).depth).toBe(6);
  });
});
