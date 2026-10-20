import { describe, expect, it } from 'vitest';

import { levelController, policyByName, wrapPolicy } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { random } from '../../ai/policies/random';
import { playMatch } from '../../core/match';
import type { Buttons, Inputs, Side } from '../../core/types';
import {
  BUY,
  CASH,
  CHOOSE_TIMEOUT,
  FEE,
  FIRST_PREP_TICKS,
  GOODS,
  HIGH,
  IDLE,
  LOCK_TICKS,
  LOW,
  PASS,
  PREP_TICKS,
  PRICE_MAX,
  PRICE_MIN,
  RESULT_TICKS,
  ROUNDS,
  SELL,
  TRADE_BUTTONS,
  curveFor,
  d6Game,
  makeState,
  predictOpponent,
  priceOf,
} from './logic';
import type { D6State, Trade } from './logic';

/**
 * D-6 市場的規則測試（規則見 `docs/cards/D-6.md`）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 動作編號：0 不動、1 到 3 買穀／布／鐵、4 到 6 賣穀／布／鐵（`BUY(g)`、`SELL(g)`）。
 * `makeState` 的行情曲線：三個峰值在第 5、10、15 回合（穀、布、鐵）。
 */

const CONFIG = { maxTicks: 3600, params: {} };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function idle(): Inputs {
  return [IDLE, IDLE];
}

/** 兩邊各按一個動作（`null` 是不按）。 */
function both(t0: Trade | null, t1: Trade | null): Inputs {
  return [t0 === null ? IDLE : TRADE_BUTTONS[t0]!, t1 === null ? IDLE : TRADE_BUTTONS[t1]!];
}

function stepN(state: D6State, n: number, inputs: Inputs = idle()): D6State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = d6Game.step(s, inputs);
  }
  return s;
}

/** 剛進入 choose 階段（兩邊都還沒鎖定）。 */
function choosing(overrides: Partial<D6State> = {}): D6State {
  return makeState({ phase: 'choose', wait: 0, ...overrides });
}

/** 從 choose 開始：兩邊同一個 tick 鎖定，走完 locked 到開牌（還沒入帳）。 */
function toResult(state: D6State, t0: Trade, t1: Trade): D6State {
  return stepN(d6Game.step(state, both(t0, t1)), LOCK_TICKS);
}

/** 從 choose 開始：鎖定、開牌、入帳（下一回合的 prep，或結束）。 */
function playRound(state: D6State, t0: Trade, t1: Trade): D6State {
  return stepN(toResult(state, t0, t1), RESULT_TICKS);
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

function decideAtDepth(
  state: D6State,
  side: Side,
  depth: number,
  name: 'pathfinder' | 'precise' | 'greedy' | 'gambler' = 'pathfinder',
): Buttons {
  const controller = wrapPolicy(
    d6Game,
    policyByName(name),
    { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
    7,
  );
  return controller.decide(state, side, 0);
}

describe('D-6 市場｜初始與行情曲線', () => {
  it('init：第 0 回合、準備期、現金各 60、存貨 0、偏移 0、歷史是空的、曲線是 3 × 24 的整數', () => {
    const s = d6Game.init(3, CONFIG);
    expect(s.round).toBe(0);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(FIRST_PREP_TICKS);
    expect(s.cash).toEqual([CASH, CASH]);
    expect(s.inv).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(s.dev).toEqual([0, 0, 0]);
    expect(s.history).toEqual([]);
    expect(s.base).toHaveLength(GOODS);
    for (const row of s.base) {
      expect(row).toHaveLength(ROUNDS);
      for (const v of row) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(LOW);
        expect(v).toBeLessThanOrEqual(HIGH);
      }
    }
    expect(d6Game.isOver(s)).toBe(false);
    expect(d6Game.winner(s)).toBeNull();
  });

  it('曲線公式：峰值 15、離峰 1 到 6 格依序 14、12、11、9、8、6，旺季之外是 6', () => {
    const base = curveFor([5, 10, 15]);
    expect(base[0]!.slice(0, 12)).toEqual([6, 6, 6, 6, 6, 15, 14, 12, 11, 9, 8, 6]);
    const peak = 10;
    expect(
      [peak - 6, peak - 5, peak - 4, peak - 3, peak - 2, peak - 1, peak].map((r) => base[1]![r]),
    ).toEqual([6, 8, 9, 11, 12, 14, 15]);
    expect(base[2]![15]).toBe(HIGH);
    expect(base[2]![23]).toBe(6);
  });

  it('三個峰值都在第 4 到 17 回合、兩兩至少差 5 回合，每一種貨在自己的峰值回合最貴（種子 0 到 49）', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const s = d6Game.init(seed, CONFIG);
      const peaks = s.base.map((row) => row.indexOf(HIGH));
      for (const p of peaks) {
        expect(p).toBeGreaterThanOrEqual(4);
        expect(p).toBeLessThanOrEqual(17);
      }
      const sorted = [...peaks].sort((a, b) => a - b);
      expect(sorted[1]! - sorted[0]!).toBeGreaterThanOrEqual(5);
      expect(sorted[2]! - sorted[1]!).toBeGreaterThanOrEqual(5);
    }
  });

  it('種子有效：種子 0 到 9 的曲線不全相同；同一個種子兩次 init 完全一樣', () => {
    const curves = Array.from({ length: 10 }, (_v, seed) =>
      JSON.stringify(d6Game.init(seed, CONFIG).base),
    );
    expect(new Set(curves).size).toBeGreaterThan(3);
    expect(d6Game.init(4, CONFIG)).toEqual(d6Game.init(4, CONFIG));
  });

  it('價格 ＝ clamp(曲線 + 偏移, 2, 20)：偏移很負時是 2，很正時是 20', () => {
    const s = makeState({ round: 5, dev: [3, -30, 30] });
    expect(priceOf(s, 0)).toBe(18);
    expect(priceOf(s, 1)).toBe(PRICE_MIN);
    expect(priceOf(s, 2)).toBe(PRICE_MAX);
  });
});

describe('D-6 市場｜規則', () => {
  it('1. 準備期：第一回合 60 tick、之後每回合 30 tick，這段時間輸入都被忽略（邊界：最後一個 tick 按無效，下一個 tick 才算）', () => {
    let s = makeState();
    s = stepN(s, FIRST_PREP_TICKS - 1, both(BUY(0), BUY(0)));
    expect(s.phase).toBe('prep');
    s = d6Game.step(s, both(BUY(0), BUY(0)));
    expect(s.phase).toBe('choose');
    expect(s.pending).toEqual([null, null]);
    const t = d6Game.step(s, both(PASS, null));
    expect(t.pending).toEqual([PASS, null]);
    // 第二回合的準備期是 30 tick。
    const next = playRound(choosing(), PASS, PASS);
    expect(next.round).toBe(1);
    expect(next.phase).toBe('prep');
    expect(next.wait).toBe(PREP_TICKS);
  });

  it('2. 買：付「價格 + 手續費」，存貨 +1；鎖定與開牌時現金不動，要等入帳（result 結束）', () => {
    const start = choosing({ round: 5 }); // 穀的峰值：15
    expect(priceOf(start, 0)).toBe(15);
    const locked = d6Game.step(start, both(BUY(0), PASS));
    expect(locked.phase).toBe('locked');
    expect(locked.pending).toEqual([BUY(0), PASS]);
    expect(locked.cash).toEqual([CASH, CASH]);
    const opened = stepN(locked, LOCK_TICKS);
    expect(opened.phase).toBe('result');
    expect(opened.cash).toEqual([CASH, CASH]);
    expect(opened.inv[0]).toEqual([0, 0, 0]);
    expect(opened.last?.delta).toEqual([-(15 + FEE), 0]);
    const banked = stepN(opened, RESULT_TICKS);
    expect(banked.cash).toEqual([CASH - 16, CASH]);
    expect(banked.inv[0]).toEqual([1, 0, 0]);
    expect(banked.history).toEqual([[BUY(0), PASS]]);
    expect(banked.round).toBe(6);
  });

  it('3. 賣：得到「價格 − 手續費」，存貨 −1；價格壓到 2 時至少拿 1', () => {
    const start = choosing({
      round: 5,
      inv: [
        [2, 0, 0],
        [0, 0, 0],
      ],
    });
    const after = playRound(start, SELL(0), PASS);
    expect(after.cash).toEqual([CASH + 14, CASH]);
    expect(after.inv[0]).toEqual([1, 0, 0]);
    const low = choosing({
      round: 5,
      dev: [-30, 0, 0],
      inv: [
        [1, 0, 0],
        [0, 0, 0],
      ],
    });
    expect(priceOf(low, 0)).toBe(PRICE_MIN);
    expect(playRound(low, SELL(0), PASS).cash[0]).toBe(CASH + 1);
  });

  it('4. 現金不夠不能買、沒有存貨不能賣：那個鍵被忽略（沒鎖定），可以再按別的', () => {
    const poor = choosing({ round: 5, cash: [10, 60] });
    const t = d6Game.step(poor, both(BUY(0), null));
    expect(t.pending).toEqual([null, null]);
    expect(t.phase).toBe('choose');
    const noStock = d6Game.step(choosing({ round: 5 }), both(SELL(1), null));
    expect(noStock.pending).toEqual([null, null]);
    // 同一個局面 actions 也不列出這些動作。
    const acts = d6Game.actions(poor, 0);
    expect(acts.some((a) => sameButtons(a, TRADE_BUTTONS[BUY(0)]!))).toBe(false);
    expect(acts.some((a) => sameButtons(a, TRADE_BUTTONS[SELL(0)]!))).toBe(false);
    expect(acts.some((a) => sameButtons(a, TRADE_BUTTONS[PASS]!))).toBe(true);
  });

  it('5. 恰好買得起：現金 = 價格 + 手續費 可以買（邊界）；少 1 不行', () => {
    const exact = choosing({ round: 5, cash: [16, 60] });
    expect(d6Game.step(exact, both(BUY(0), null)).pending[0]).toBe(BUY(0));
    const short = choosing({ round: 5, cash: [15, 60] });
    expect(d6Game.step(short, both(BUY(0), null)).pending[0]).toBeNull();
  });

  it('6. 兩邊在回合開頭的同一個價格成交，不分先後：兩邊都買穀，各付 16', () => {
    const after = playRound(choosing({ round: 5 }), BUY(0), BUY(0));
    expect(after.cash).toEqual([CASH - 16, CASH - 16]);
    expect(after.inv).toEqual([
      [1, 0, 0],
      [1, 0, 0],
    ]);
  });

  it('7. 偏移：dev ← trunc((dev + IMPACT × net) / 2)。一個人買 1 件 → +1，再下一回合 0；兩個人買 → +2，再 +1', () => {
    const one = playRound(choosing({ round: 0 }), BUY(1), PASS);
    expect(one.dev).toEqual([0, 1, 0]);
    expect(priceOf(one, 1)).toBe(7);
    const two = playRound(choosing({ round: 0 }), BUY(1), BUY(1));
    expect(two.dev).toEqual([0, 2, 0]);
    expect(playRound(stepN(two, PREP_TICKS), PASS, PASS).dev).toEqual([0, 1, 0]);
    expect(playRound(stepN(one, PREP_TICKS), PASS, PASS).dev).toEqual([0, 0, 0]);
  });

  it('8. 偏移：賣壓低、買賣同一種貨互相抵銷、往 0 無條件捨去、不出現 −0', () => {
    const inv: readonly (readonly number[])[] = [
      [0, 3, 0],
      [0, 3, 0],
    ];
    const sold = playRound(choosing({ round: 0, inv }), SELL(1), PASS);
    expect(sold.dev).toEqual([0, -1, 0]);
    const bothSell = playRound(choosing({ round: 0, inv }), SELL(1), SELL(1));
    expect(bothSell.dev).toEqual([0, -2, 0]);
    const cancel = playRound(choosing({ round: 0, inv }), SELL(1), BUY(1));
    expect(cancel.dev).toEqual([0, 0, 0]);
    const decay = playRound(stepN(sold, PREP_TICKS), PASS, PASS);
    expect(decay.dev).toEqual([0, 0, 0]);
    for (const v of decay.dev) {
      expect(Object.is(v, -0)).toBe(false);
    }
  });

  it('9. 來回買賣沒有白賺：曲線沒有上坡時，買了下一回合就賣，在每一種貨、每一個回合、種子 0 到 19，一對來回至少賠 1', () => {
    // 下坡與平坦：價格不會自己漲，買 (p+1)、賣 (p'−1)，p' ≤ p + 偏移 1 → 每一對至少賠 1。
    for (let seed = 0; seed < 20; seed += 1) {
      const s0 = d6Game.init(seed, CONFIG);
      for (let g = 0; g < GOODS; g += 1) {
        for (let r = 0; r < ROUNDS - 1; r += 1) {
          const rising = s0.base[g]![r + 1]! > s0.base[g]![r]!;
          if (rising) {
            continue;
          }
          const start = choosing({ base: s0.base, round: r });
          const bought = playRound(start, BUY(g), PASS);
          const next = choosing({ ...bought, phase: 'choose', wait: 0 });
          const sold = playRound(next, SELL(g), PASS);
          expect(sold.cash[0]).toBeLessThanOrEqual(CASH - 1);
        }
      }
    }
  });

  it('10. 自己抬價沒有套利：每一回合買同一種貨連買 k 回合、再每回合賣同一種貨賣 k 回合，在曲線平坦的區段現金一定少於開局（IMPACT 2）', () => {
    // 平坦區段：base 全 6 的曲線，只剩偏移在動價格。
    const flat = [
      new Array<number>(ROUNDS).fill(6),
      new Array<number>(ROUNDS).fill(6),
      new Array<number>(ROUNDS).fill(6),
    ];
    for (const k of [1, 2, 3, 4, 6]) {
      let s = choosing({ base: flat, round: 0 });
      for (let i = 0; i < k; i += 1) {
        s = playRound({ ...s, phase: 'choose', wait: 0 }, BUY(0), PASS);
      }
      for (let i = 0; i < k; i += 1) {
        s = playRound({ ...s, phase: 'choose', wait: 0 }, SELL(0), PASS);
      }
      expect(s.inv[0]).toEqual([0, 0, 0]);
      expect(s.cash[0]).toBeLessThan(CASH);
    }
  });

  it('11. 不動：鎖定「不動」，現金與存貨都不變，歷史記一筆 0', () => {
    const after = playRound(choosing({ round: 3 }), PASS, PASS);
    expect(after.cash).toEqual([CASH, CASH]);
    expect(after.history).toEqual([[PASS, PASS]]);
  });

  it('12.（邊界）同一個 tick 兩邊都鎖定：兩邊都記下來、立刻進 locked；鎖定之後再按別的沒有用', () => {
    const locked = d6Game.step(choosing({ round: 5 }), both(BUY(0), BUY(2)));
    expect(locked.phase).toBe('locked');
    expect(locked.pending).toEqual([BUY(0), BUY(2)]);
    const again = d6Game.step(locked, both(BUY(1), BUY(1)));
    expect(again.pending).toEqual([BUY(0), BUY(2)]);
    const one = d6Game.step(choosing({ round: 5 }), both(BUY(0), null));
    expect(one.phase).toBe('choose');
    const changed = d6Game.step(one, both(PASS, null));
    expect(changed.pending[0]).toBe(BUY(0));
  });

  it('13.（邊界）同一個 tick 同時按 a 和 b：當作沒有動作；方向鍵單獨按也不鎖定；down 單獨按是不動', () => {
    const ab: Buttons = { ...IDLE, a: true, b: true, left: true };
    const t = d6Game.step(
      choosing({
        round: 5,
        inv: [
          [1, 0, 0],
          [0, 0, 0],
        ],
      }),
      [ab, IDLE],
    );
    expect(t.pending[0]).toBeNull();
    const dirOnly: Buttons = { ...IDLE, left: true };
    expect(d6Game.step(choosing({ round: 5 }), [dirOnly, IDLE]).pending[0]).toBeNull();
    const down: Buttons = { ...IDLE, down: true };
    expect(d6Game.step(choosing({ round: 5 }), [down, IDLE]).pending[0]).toBe(PASS);
  });

  it('14.（邊界）超時：choose 的第 CHOOSE_TIMEOUT 個 tick 還沒鎖定的那一邊自動「不動」；那個 tick 按了算數，不算超時', () => {
    let s = choosing({ round: 5 });
    s = stepN(s, CHOOSE_TIMEOUT - 1);
    expect(s.phase).toBe('choose');
    expect(s.pending).toEqual([null, null]);
    const timedOut = d6Game.step(s, idle());
    expect(timedOut.pending).toEqual([PASS, PASS]);
    expect(timedOut.phase).toBe('locked');
    const pressed = d6Game.step(s, both(BUY(0), null));
    expect(pressed.pending).toEqual([BUY(0), PASS]);
  });

  it('15. 打完 24 回合：現金多的贏；結束之後 step 原樣回傳；結束前 winner 是 null', () => {
    const start = choosing({ round: ROUNDS - 1, cash: [70, 60] });
    expect(d6Game.winner(start)).toBeNull();
    const end = playRound(start, PASS, PASS);
    expect(d6Game.isOver(end)).toBe(true);
    expect(d6Game.winner(end)).toBe(0);
    expect(d6Game.score(end)).toEqual([70, 60]);
    expect(d6Game.step(end, idle())).toBe(end);
  });

  it('16. 只算現金：沒賣掉的貨一毛不值（最後一回合還有 9 件貨、現金少 1 的人輸）', () => {
    const start = choosing({
      round: ROUNDS - 1,
      cash: [60, 61],
      inv: [
        [3, 3, 3],
        [0, 0, 0],
      ],
    });
    const end = playRound(start, PASS, PASS);
    expect(d6Game.score(end)).toEqual([60, 61]);
    expect(d6Game.winner(end)).toBe(1);
  });

  it('17.（邊界）第 24 回合的最後一賣算數；現金一樣多是平手（winner 是 null）', () => {
    const start = choosing({
      round: ROUNDS - 1,
      cash: [60, 74],
      inv: [
        [0, 0, 0],
        [0, 0, 0],
      ],
    });
    expect(playRound(start, PASS, PASS).winner).toBe(1);
    const sell = choosing({
      round: ROUNDS - 1,
      cash: [60, 60 + 6 - 1],
      inv: [
        [0, 0, 1],
        [0, 0, 0],
      ],
    });
    const end = playRound(sell, SELL(2), PASS);
    // 第 23 回合鐵的價格是 6（旺季已過），賣出得 5。
    expect(end.cash).toEqual([65, 65]);
    expect(d6Game.winner(end)).toBeNull();
  });

  it('18. 時間表：誰都不按，一回合 30 + 68 + 2 + 48 tick，24 回合加第一回合多的 30 tick，不超過 3600；有人很快鎖定的最短一局不少於 30 秒', () => {
    const perRound = PREP_TICKS + CHOOSE_TIMEOUT + LOCK_TICKS + RESULT_TICKS;
    const slowest = FIRST_PREP_TICKS - PREP_TICKS + ROUNDS * perRound;
    expect(slowest).toBeLessThanOrEqual(3600);
    let s = d6Game.init(0, CONFIG);
    let ticks = 0;
    while (!d6Game.isOver(s)) {
      s = d6Game.step(s, idle());
      ticks += 1;
    }
    expect(ticks).toBe(slowest);
    expect(d6Game.winner(s)).toBeNull();
    // 每回合一進 choose 就鎖定：每回合 PREP + 1 + LOCK + RESULT。
    let f = d6Game.init(0, CONFIG);
    let fastTicks = 0;
    while (!d6Game.isOver(f)) {
      f = d6Game.step(f, both(PASS, PASS));
      fastTicks += 1;
    }
    expect(fastTicks).toBe(
      FIRST_PREP_TICKS - PREP_TICKS + ROUNDS * (PREP_TICKS + 1 + LOCK_TICKS + RESULT_TICKS),
    );
    expect(fastTicks / 60).toBeGreaterThanOrEqual(30);
  });

  it('19.（邊界）時間到（第 maxTicks 個 tick）：已經開牌的回合先入帳；還在 choose 或 locked 的回合不算', () => {
    const resultNow = toResult(
      choosing({ round: 5, maxTicks: 100, tick: 99 - LOCK_TICKS - 1 }),
      BUY(0),
      PASS,
    );
    expect(resultNow.phase).toBe('result');
    const ended = d6Game.step({ ...resultNow, tick: 99, maxTicks: 100 }, idle());
    expect(ended.over).toBe(true);
    expect(ended.cash[0]).toBe(CASH - 16);
    const midChoose = choosing({ round: 5, maxTicks: 100, tick: 99 });
    const endedChoose = d6Game.step(midChoose, both(BUY(0), PASS));
    expect(endedChoose.over).toBe(true);
    expect(endedChoose.cash).toEqual([CASH, CASH]);
  });

  it('20. 歷史存在 state 裡，一回合一筆，最多 ROUNDS 筆，整場 JSON 來回不變', () => {
    let s = d6Game.init(2, CONFIG);
    while (!d6Game.isOver(s)) {
      s = d6Game.step(s, both(PASS, PASS));
      expect(s.history.length).toBeLessThanOrEqual(ROUNDS);
    }
    expect(s.history).toHaveLength(ROUNDS);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('21. step 不改動傳進來的 state 與輸入（深度凍結也不丟錯），各階段都一樣', () => {
    const states = [
      makeState(),
      choosing({
        round: 5,
        inv: [
          [1, 1, 1],
          [1, 1, 1],
        ],
      }),
      d6Game.step(choosing({ round: 5 }), both(BUY(0), PASS)),
      toResult(choosing({ round: 5 }), BUY(0), PASS),
    ];
    for (const s of states) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(s)) as D6State);
      const inputs = deepFreeze(both(BUY(0), PASS));
      expect(() => d6Game.step(frozen, inputs)).not.toThrow();
    }
    const last = deepFreeze(
      JSON.parse(JSON.stringify(toResult(choosing({ round: 5 }), BUY(0), PASS))) as D6State,
    );
    expect(() => stepN(last, RESULT_TICKS)).not.toThrow();
  });
});

describe('D-6 市場｜actions', () => {
  it('choose 而且還沒鎖定：[不動, 賣（有存貨的）, 買（買得起的）]，不動排第一；其他階段只有 [全放開]', () => {
    const s = choosing({
      round: 5,
      inv: [
        [1, 0, 2],
        [0, 0, 0],
      ],
    });
    const acts = d6Game.actions(s, 0);
    const expected = [PASS, SELL(0), SELL(2), BUY(0), BUY(1), BUY(2)].map((t) => TRADE_BUTTONS[t]!);
    expect(acts).toHaveLength(expected.length);
    expected.forEach((e, i) => expect(sameButtons(acts[i]!, e)).toBe(true));
    // 沒存貨的 AI 側：只有不動與三個買。
    expect(d6Game.actions(s, 1)).toHaveLength(4);
    // 已鎖定、locked、result、prep、結束：只有全放開。
    const locked = d6Game.step(s, both(BUY(0), null));
    expect(d6Game.actions(locked, 0)).toEqual([IDLE]);
    expect(d6Game.actions(makeState(), 0)).toEqual([IDLE]);
    expect(d6Game.actions(toResult(s, PASS, PASS), 1)).toEqual([IDLE]);
  });

  it('actions()[0] 會推進結算（10.6 陷阱二）：兩邊都只做第一個動作，三個 tick 後進 result', () => {
    const s = choosing({ round: 5 });
    const first0 = d6Game.actions(s, 0)[0]!;
    const first1 = d6Game.actions(s, 1)[0]!;
    expect(sameButtons(first0, IDLE)).toBe(false);
    const locked = d6Game.step(s, [first0, first1]);
    expect(locked.phase).toBe('locked');
    expect(stepN(locked, LOCK_TICKS).phase).toBe('result');
  });
});

describe('D-6 市場｜evaluate 與不偷看（4.2）', () => {
  const history: D6State['history'] = [
    [BUY(0), PASS],
    [BUY(0), BUY(1)],
    [PASS, SELL(1)],
    [BUY(2), PASS],
  ];
  const rich = {
    round: 4,
    history,
    inv: [
      [2, 2, 2],
      [2, 2, 2],
    ] as readonly (readonly number[])[],
  };
  const humanTrades: readonly (Trade | null)[] = [
    null,
    PASS,
    BUY(0),
    BUY(2),
    SELL(0),
    SELL(1),
    SELL(2),
  ];

  it('evaluate：各階段 gain 有限、danger 在 0 到 1；結束的局有勝負加成', () => {
    const s0 = choosing({ ...rich });
    const phases: D6State[] = [
      makeState(),
      s0,
      d6Game.step(s0, both(BUY(0), BUY(1))),
      toResult(s0, BUY(0), BUY(1)),
      playRound(choosing({ round: ROUNDS - 1, cash: [70, 60] }), PASS, PASS),
    ];
    for (const s of phases) {
      for (const side of [0, 1] as const) {
        const e = d6Game.evaluate(s, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
    const end = phases[4]!;
    expect(d6Game.evaluate(end, 0).gain).toBeGreaterThan(500);
    expect(d6Game.evaluate(end, 1).gain).toBeLessThan(-500);
  });

  it('evaluate 對稱、不是橡皮筋：對調兩邊的現金、存貨、鎖定與歷史，AI 側的評價一樣', () => {
    const swapTrade = (t: readonly [Trade, Trade]): readonly [Trade, Trade] => [t[1], t[0]];
    const a = toResult(
      choosing({
        round: 5,
        cash: [50, 66],
        inv: [
          [1, 0, 0],
          [0, 2, 0],
        ],
        history,
      }),
      PASS,
      BUY(2),
    );
    const b = toResult(
      choosing({
        round: 5,
        cash: [66, 50],
        inv: [
          [0, 2, 0],
          [1, 0, 0],
        ],
        history: history.map(swapTrade),
      }),
      BUY(2),
      PASS,
    );
    expect(d6Game.evaluate(a, 1)).toEqual(d6Game.evaluate(b, 0));
    expect(d6Game.evaluate(a, 0)).toEqual(d6Game.evaluate(b, 1));
  });

  it('不偷看（choose、locked）：只有對手的 pending 不同的 state，AI 側的 evaluate 與 actions 完全相同（兩邊都成立）', () => {
    const chooseStates = humanTrades.map((t) => choosing({ ...rich, pending: [t, null] }));
    const lockedStates = humanTrades
      .filter((t): t is Trade => t !== null)
      .map((t) => makeState({ ...rich, phase: 'locked', wait: LOCK_TICKS, pending: [t, BUY(1)] }));
    for (const group of [chooseStates, lockedStates]) {
      for (const other of group) {
        expect(d6Game.evaluate(other, 1)).toEqual(d6Game.evaluate(group[0]!, 1));
        expect(d6Game.actions(other, 1)).toEqual(d6Game.actions(group[0]!, 1));
      }
    }
    const mirrored = humanTrades.map((t) => choosing({ ...rich, pending: [null, t] }));
    for (const other of mirrored) {
      expect(d6Game.evaluate(other, 0)).toEqual(d6Game.evaluate(mirrored[0]!, 0));
      expect(d6Game.actions(other, 0)).toEqual(d6Game.actions(mirrored[0]!, 0));
    }
  });

  it('不偷看（result）：只有對手的鎖定與開牌結果不同的 result state，evaluate 相同（模擬走得到開牌，這裡要目盲）', () => {
    const results = humanTrades
      .filter((t): t is Trade => t !== null)
      .map((t) => toResult(choosing({ ...rich }), t, BUY(1)));
    expect(new Set(results.map((s) => JSON.stringify(s.last))).size).toBeGreaterThan(1);
    for (const other of results) {
      expect(d6Game.evaluate(other, 1)).toEqual(d6Game.evaluate(results[0]!, 1));
    }
  });

  it('不偷看（整個決定）：四個性格、深度 1、3、6，在只有對手 pending 不同的 choose 局面，按的鍵相同；兩邊都成立', () => {
    for (const name of ['pathfinder', 'precise', 'greedy', 'gambler'] as const) {
      for (const depth of [1, 3, 6]) {
        const presses = humanTrades.map((t) =>
          decideAtDepth(choosing({ ...rich, pending: [t, null] }), 1, depth, name),
        );
        for (const press of presses) {
          expect(press, `${name} 深度 ${depth}`).toEqual(presses[0]);
        }
        const flipped = humanTrades.map((t) =>
          decideAtDepth(choosing({ ...rich, pending: [null, t] }), 0, depth, name),
        );
        for (const press of flipped) {
          expect(press, `${name} 深度 ${depth}（0 號邊）`).toEqual(flipped[0]);
        }
      }
    }
  });

  it('搜尋型深度 ≥ 3 真的走得到開牌（10.6 陷阱一）：從 choose 出發，depth 6 的前瞻評價過 result 階段的 state；depth 2 沒有', () => {
    const seen = (depth: number): Set<string> => {
      const phases = new Set<string>();
      const spy = {
        ...d6Game,
        evaluate(s: D6State, side: Side) {
          phases.add(s.phase);
          return d6Game.evaluate(s, side);
        },
      };
      wrapPolicy(
        spy,
        pathfinder,
        { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
        1,
      ).decide(choosing({ ...rich }), 1, 0);
      return phases;
    };
    expect(seen(6).has('result')).toBe(true);
    expect(seen(3).has('result')).toBe(true);
    expect(seen(2).has('result')).toBe(false);
    expect(seen(1).has('result')).toBe(false);
  });
});

describe('D-6 市場｜predictOpponent（只讀 history）', () => {
  it('回傳 7 種動作的機率，加起來是 1，全部為正；不改動傳進來的歷史', () => {
    const history: D6State['history'] = [
      [BUY(0), PASS],
      [BUY(0), BUY(1)],
    ];
    const frozen = deepFreeze(JSON.parse(JSON.stringify(history)) as D6State['history']);
    for (const side of [0, 1] as const) {
      const p = predictOpponent(frozen, side);
      expect(p).toHaveLength(7);
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      for (const v of p) {
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  it('對手一直買布 → 機率集中在「買布」；從兩個座位看都成立；只看最近 WINDOW 回合', () => {
    const buys = Array.from({ length: 6 }, () => [PASS, BUY(1)] as const);
    const p1 = predictOpponent(buys, 0); // 0 號邊看 1 號邊
    expect(p1.indexOf(Math.max(...p1))).toBe(BUY(1));
    const swapped = buys.map((t) => [t[1], t[0]] as const);
    const p0 = predictOpponent(swapped, 1);
    expect(p0.indexOf(Math.max(...p0))).toBe(BUY(1));
    // 早於窗口的紀錄不影響預測。
    const old = [...Array.from({ length: 10 }, () => [PASS, SELL(2)] as const), ...buys];
    expect(predictOpponent(old, 0)).toEqual(predictOpponent(buys, 0));
  });

  it('沒有歷史：機率有限且不偏向任何一種買賣超過一半', () => {
    const p = predictOpponent([], 0);
    expect(Math.max(...p)).toBeLessThan(0.5);
  });
});

describe('D-6 市場｜AI 能不能玩', () => {
  it('兩個等級 5 的搜尋型打完一整場：24 回合都打完，在 maxTicks 之前結束', () => {
    const a = levelController(d6Game, pathfinder, 5, 1);
    const b = levelController(d6Game, pathfinder, 5, 2);
    const r = playMatch(d6Game, 3, CONFIG, a, b);
    expect(r.ticks).toBeLessThanOrEqual(3600);
    // 24 回合每回合至少 PREP + 1 + LOCK + RESULT 個 tick：沒有回合被跳過。
    expect(r.ticks).toBeGreaterThanOrEqual(
      FIRST_PREP_TICKS - PREP_TICKS + ROUNDS * (PREP_TICKS + 1 + LOCK_TICKS + RESULT_TICKS),
    );
  });

  it('亂按的控制器也能把一場打完：不會卡住', () => {
    const a = levelController(d6Game, random, 10, 5);
    const b = levelController(d6Game, random, 10, 6);
    const r = playMatch(d6Game, 4, CONFIG, a, b);
    expect(r.ticks).toBeLessThanOrEqual(3600);
  });
});
