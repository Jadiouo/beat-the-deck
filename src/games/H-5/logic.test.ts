import { describe, expect, it } from 'vitest';

import { humanModel } from '../../ai/human-model';
import { levelController, levelParams, wrapPolicy } from '../../ai/level';
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
  BUST_EXTRA,
  confidenceLevel,
  continuation,
  estimateTheta,
  h5Game,
  handValue,
  HANDS,
  HIT,
  holePosterior,
  LOCK_TICKS,
  makeState,
  MAX_CARDS,
  RESULT_TICKS,
  settle,
  STOP,
  stopProb,
  totalOf,
  unseenCounts,
  WINDOW,
} from './logic';
import type { H5State, Move, PastObs } from './logic';

/**
 * H-5 二十一點的規則測試（規則見 `docs/cards/H-5.md`）。
 * 動作：a ＝ 要牌（HIT = 0）、b ＝ 停牌（STOP = 1）。牌是 1 到 10 的整數（沒有 A 與人頭）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 關鍵的幾組：不偷看（含故意洩漏、含「加同一個常數」那型，同時測 decide、evaluate、actions）、
 * 等級曲線（深度 ≤ 2 只有反射規則、深度 ≥ 3 讀對手）、10.6 的兩個 pending 陷阱、
 * 「它誤判你的門檻就賠錢」在規則層面成立（不是靠參數）。
 */

const CONFIG = { maxTicks: 3600, params: {} };

function idle(): Inputs {
  return [IDLE, IDLE];
}

function press(side: Side, hit: boolean): Inputs {
  const key = hit ? PRESS_A : PRESS_B;
  return side === 0 ? [key, IDLE] : [IDLE, key];
}

function both(m0: Move, m1: Move): Inputs {
  return [m0 === HIT ? PRESS_A : PRESS_B, m1 === HIT ? PRESS_A : PRESS_B];
}

function stepN(state: H5State, n: number, inputs: Inputs = idle()): H5State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = h5Game.step(s, inputs);
  }
  return s;
}

function choosing(overrides: Partial<H5State> = {}): H5State {
  return makeState({ phase: 'choose', wait: 0, ...overrides });
}

/** 從 choose 開始，兩邊都按，走完鎖定到公開（deal 階段，incoming 已經領好）。 */
function toDeal(state: H5State, m0: Move, m1: Move): H5State {
  const locked = h5Game.step(state, both(m0, m1));
  return stepN(locked, LOCK_TICKS);
}

/** 走完整個一輪：兩邊都按、公開、30 tick 後併牌。 */
function playRound(state: H5State, m0: Move, m1: Move): H5State {
  return stepN(toDeal(state, m0, m1), RESULT_TICKS);
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

/** 牌堆只剩指定的幾張（點數 → 張數），其他都沒有。 */
function poolOf(cards: Readonly<Record<number, number>>): number[] {
  const pool = new Array<number>(10).fill(0);
  for (const [rank, n] of Object.entries(cards)) {
    pool[Number(rank) - 1] = n;
  }
  return pool;
}

/** 一手的觀察：[總點數, 動作]。 */
function obs(...pairs: readonly (readonly [number, Move])[]): readonly PastObs[] {
  return pairs.map(([total, move]) => ({ total, move }));
}

/** 對手（0 號邊）n 手：總點數 `total` 就停牌（另外第一輪在 11 要牌）。 */
function oppStopsAt(n: number, total: number): H5State['past'] {
  return [Array.from({ length: n }, () => obs([11, HIT], [total, STOP])), []];
}

/** 對手（0 號邊）n 手：總點數 `total` 還要牌，最後在 `stopTotal` 停牌。 */
function oppHitsAt(n: number, total: number, stopTotal: number): H5State['past'] {
  return [Array.from({ length: n }, () => obs([11, HIT], [total, HIT], [stopTotal, STOP])), []];
}

describe('H-5 二十一點｜初始與常數', () => {
  it('第 0 手、第 0 輪、準備階段（還要等 45 tick）、比分 0:0；每人 1 張暗牌與 1 張明牌，都在 1 到 10', () => {
    const s = h5Game.init(5, CONFIG);
    expect(s.hand).toBe(0);
    expect(s.round).toBe(0);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.scores).toEqual([0, 0]);
    expect(s.pending).toEqual([null, null]);
    expect(s.incoming).toEqual([null, null]);
    expect(s.stood).toEqual([false, false]);
    expect(s.log).toEqual([]);
    expect(s.past).toEqual([[], []]);
    expect(s.model).toBe(true);
    for (const side of [0, 1] as const) {
      expect(Number.isInteger(s.hole[side]) && s.hole[side] >= 1 && s.hole[side] <= 10).toBe(true);
      expect(s.up[side]).toHaveLength(1);
      expect((s.up[side] as number[])[0]).toBeGreaterThanOrEqual(1);
      expect((s.up[side] as number[])[0]).toBeLessThanOrEqual(10);
    }
  });

  it('牌堆：1 到 10 各 4 張共 40 張，發出 4 張之後還剩 36 張，每個點數至多 4 張、剩餘加上已發的剛好等於 4', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const s = h5Game.init(seed, CONFIG);
      expect(s.pool).toHaveLength(10);
      expect(s.pool.reduce((a, b) => a + b, 0)).toBe(36);
      const dealt = [s.hole[0], s.hole[1], ...s.up[0], ...s.up[1]];
      for (let rank = 1; rank <= 10; rank += 1) {
        const out = dealt.filter((c) => c === rank).length;
        expect((s.pool[rank - 1] as number) + out, `點數 ${rank}`).toBe(4);
      }
    }
  });

  it('常數：9 手、最多 4 張、鎖定 2 tick、公開後停 30 tick、爆牌多扣 2 分、窗口 3 手', () => {
    expect(HANDS).toBe(9);
    expect(MAX_CARDS).toBe(4);
    expect(LOCK_TICKS).toBe(2);
    expect(RESULT_TICKS).toBe(30);
    expect(BUST_EXTRA).toBe(2);
    expect(WINDOW).toBe(3);
  });

  it('同一個種子發同樣的牌；不同種子（多數）發不一樣的牌', () => {
    expect(h5Game.init(3, CONFIG)).toEqual(h5Game.init(3, CONFIG));
    const deals = new Set<string>();
    for (let seed = 0; seed < 30; seed += 1) {
      const s = h5Game.init(seed, CONFIG);
      deals.add(JSON.stringify([s.hole, s.up]));
    }
    expect(deals.size).toBeGreaterThan(20);
  });

  it('config.params.model 是對手模型開關（預設開）', () => {
    expect(h5Game.init(1, CONFIG).model).toBe(true);
    expect(h5Game.init(1, { maxTicks: 3600, params: { model: 0 } }).model).toBe(false);
  });
});

describe('H-5 二十一點｜規則', () => {
  it('1. 準備 45 tick：這段時間輸入被忽略（第 45 個 tick 按無效，第 46 個 tick 才算）', () => {
    let s = makeState();
    s = stepN(s, AI_WAIT_TICKS - 1, both(HIT, HIT));
    expect(s.phase).toBe('prep');
    s = h5Game.step(s, both(HIT, HIT));
    expect(s.phase).toBe('choose');
    expect(s.pending).toEqual([null, null]);
    s = h5Game.step(s, press(0, true));
    expect(s.pending).toEqual([HIT, null]);
  });

  it('2. 只有一邊按：還在 choose，等另一邊；兩邊都按了才鎖定 2 tick', () => {
    let s = choosing();
    s = h5Game.step(s, press(0, true));
    expect(s.phase).toBe('choose');
    s = stepN(s, 5);
    expect(s.phase).toBe('choose');
    s = h5Game.step(s, press(1, false));
    expect(s.phase).toBe('locked');
    expect(s.wait).toBe(LOCK_TICKS);
    expect(s.pending).toEqual([HIT, STOP]);
  });

  it('3. 同一個 tick 兩邊都按：一起鎖定', () => {
    const s = h5Game.step(choosing(), both(HIT, STOP));
    expect(s.phase).toBe('locked');
    expect(s.pending).toEqual([HIT, STOP]);
  });

  it('4. 選了就不能改：之後再按別的鍵沒有用', () => {
    let s = h5Game.step(choosing(), press(0, true));
    s = h5Game.step(s, press(0, false));
    expect(s.pending[0]).toBe(HIT);
    s = h5Game.step(s, press(1, true));
    expect(s.pending).toEqual([HIT, HIT]);
    s = h5Game.step(s, both(STOP, STOP));
    expect(s.pending).toEqual([HIT, HIT]);
  });

  it('5. 同時按 a 與 b：b 優先（停牌，保守）', () => {
    const bothKeys: Buttons = { ...IDLE, a: true, b: true };
    const s = h5Game.step(choosing(), [bothKeys, IDLE]);
    expect(s.pending[0]).toBe(STOP);
  });

  it('6. 鎖定中不領牌、不併牌：up 與 incoming 都不動；第 3 步才公開並領牌', () => {
    const start = choosing({ pool: poolOf({ 3: 1, 9: 1 }) });
    const locked = h5Game.step(start, both(HIT, HIT));
    expect(locked.phase).toBe('locked');
    expect(locked.incoming).toEqual([null, null]);
    expect(locked.up).toEqual(start.up);
    const second = h5Game.step(locked, idle());
    expect(second.phase).toBe('locked');
    expect(second.incoming).toEqual([null, null]);
    const third = h5Game.step(second, idle());
    expect(third.phase).toBe('deal');
    expect(third.wait).toBe(RESULT_TICKS);
    expect(third.up).toEqual(start.up);
    expect(third.pool).toEqual(start.pool); // 入帳前不扣
    // 兩邊都要牌，牌堆只有一張 3 與一張 9：兩人各拿一張，不會拿到同一張
    expect([...(third.incoming as readonly number[])].sort((a, b) => a - b)).toEqual([3, 9]);
  });

  it('7. 只有要牌的人領牌；停牌的人 incoming 是 null；公開後 pending 還在（畫面要看）', () => {
    const start = choosing({ pool: poolOf({ 6: 4 }) });
    const deal = toDeal(start, HIT, STOP);
    expect(deal.incoming).toEqual([6, null]);
    expect(deal.pending).toEqual([HIT, STOP]);
    const deal2 = toDeal(start, STOP, HIT);
    expect(deal2.incoming).toEqual([null, 6]);
  });

  it('8. 30 tick 後併牌：領到的牌進 up、牌堆扣掉、log 記這一輪兩邊的選擇、進下一輪的準備', () => {
    const start = choosing({
      hole: [3, 4],
      up: [[5], [6]],
      pool: poolOf({ 2: 4 }),
    });
    const s = playRound(start, HIT, STOP);
    expect(s.up).toEqual([[5, 2], [6]]);
    expect(s.pool[1]).toBe(3);
    expect(s.log).toEqual([[HIT, STOP]]);
    expect(s.round).toBe(1);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.incoming).toEqual([null, null]);
    expect(s.stood).toEqual([false, true]);
    // 停牌的那邊下一輪的 pending 預先填好 STOP（不用再按）
    expect(s.pending).toEqual([null, STOP]);
  });

  it('9. 已經停牌的人不用選：只等另一邊按，按了就鎖定', () => {
    let s = choosing({ stood: [false, true], pending: [null, STOP], log: [[STOP, STOP]] });
    s = h5Game.step(s, press(0, true));
    expect(s.phase).toBe('locked');
    expect(s.pending).toEqual([HIT, STOP]);
    // 停牌的人按什麼都沒用
    let t = choosing({ stood: [false, true], pending: [null, STOP] });
    t = h5Game.step(t, press(1, true));
    expect(t.phase).toBe('choose');
    expect(t.pending).toEqual([null, STOP]);
  });

  it('10. log 裡已經停牌的那一邊是 null（對手分不出是爆了還是自己停的）', () => {
    // 0 號邊第一輪停牌；第二輪 0 號邊已經停了，1 號邊要牌
    let s = choosing({ hole: [9, 2], up: [[8], [3]], pool: poolOf({ 1: 4 }) });
    s = playRound(s, STOP, HIT);
    expect(s.log).toEqual([[STOP, HIT]]);
    s = h5Game.step(s, idle()); // 還在準備
    s = stepN(s, AI_WAIT_TICKS);
    expect(s.phase).toBe('choose');
    s = playRound(s, STOP, HIT);
    expect(s.log).toEqual([
      [STOP, HIT],
      [null, HIT],
    ]);
  });

  it('11. 爆牌自動停牌：併牌後總點數超過 21 就是 stood；log 裡看不出是爆了', () => {
    const start = choosing({
      hole: [9, 2],
      up: [[8], [3]],
      pool: poolOf({ 10: 4 }),
    });
    const s = playRound(start, HIT, STOP);
    expect(totalOf(s.hole[0], s.up[0])).toBe(27);
    expect(s.stood).toEqual([true, true]);
    expect(s.log).toEqual([[HIT, STOP]]); // 只看到「要了牌」，看不到爆
  });

  it('12. 滿 4 張（1 暗＋3 明）自動停牌：第二次要牌之後不再有第三輪', () => {
    const start = choosing({
      hole: [1, 1],
      up: [
        [2, 2],
        [2, 2],
      ],
      pool: poolOf({ 1: 4 }),
      log: [[HIT, HIT]],
      round: 1,
    });
    const s = playRound(start, HIT, HIT);
    expect(s.up[0]).toHaveLength(MAX_CARDS - 1);
    expect(s.up[1]).toHaveLength(MAX_CARDS - 1);
    expect(s.stood).toEqual([true, true]);
    expect(s.phase).toBe('showdown');
  });

  it('13. 兩邊都停牌就攤牌：showdown 停 30 tick；這 30 tick 比分還沒動；結果算在 last', () => {
    const start = choosing({ hole: [9, 5], up: [[8], [6]] });
    const s = playRound(start, STOP, STOP);
    expect(s.phase).toBe('showdown');
    expect(s.wait).toBe(RESULT_TICKS);
    expect(s.scores).toEqual([0, 0]);
    expect(s.last).not.toBeNull();
    expect(s.last?.totals).toEqual([17, 11]);
    expect(s.last?.delta).toEqual([1, 0]);
  });

  it('14. settle：贏 +1、輸 0、平手 0；爆牌的人 −(BUST_EXTRA)、沒爆的對手 +1；兩邊都爆各 −1', () => {
    expect(settle(18, 15)).toEqual([1, 0]);
    expect(settle(15, 18)).toEqual([0, 1]);
    expect(settle(17, 17)).toEqual([0, 0]);
    expect(settle(22, 12)).toEqual([-BUST_EXTRA, 1]);
    expect(settle(12, 25)).toEqual([1, -BUST_EXTRA]);
    expect(settle(23, 30)).toEqual([-BUST_EXTRA, -BUST_EXTRA]);
    expect(settle(21, 21)).toEqual([0, 0]);
    expect(settle(21, 20)).toEqual([1, 0]);
  });

  it('15. 攤牌的結局都寫進 last（含爆牌）：一邊爆牌，另一邊 +1、爆的人 −1', () => {
    const start = choosing({ hole: [9, 5], up: [[8], [6]], pool: poolOf({ 10: 4 }) });
    const s = playRound(start, HIT, STOP);
    expect(s.last?.delta).toEqual([-BUST_EXTRA, 1]);
    const bank = stepN(s, RESULT_TICKS);
    expect(bank.scores).toEqual([-BUST_EXTRA, 1]);
  });

  it('16. 攤牌結束入帳：比分更新、hand + 1、重新發牌（每人 1 暗 1 明）、牌堆補滿再扣、log 清空、回到準備', () => {
    const start = choosing({ hole: [9, 5], up: [[8], [6]], hand: 2, dealer: 0 });
    let s = playRound(start, STOP, STOP);
    s = stepN(s, RESULT_TICKS);
    expect(s.scores).toEqual([1, 0]);
    expect(s.hand).toBe(3);
    expect(s.round).toBe(0);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.log).toEqual([]);
    expect(s.last).toBeNull();
    expect(s.stood).toEqual([false, false]);
    expect(s.pending).toEqual([null, null]);
    expect(s.up[0]).toHaveLength(1);
    expect(s.up[1]).toHaveLength(1);
    expect(s.pool.reduce((a, b) => a + b, 0)).toBe(36);
    expect(s.dealer).toBe(1);
  });

  it('17. past：入帳時把這一手兩邊每次決定時的總點數與選擇記下來（對手的暗牌這時才公開）', () => {
    // 0 號邊：暗牌 4、明牌 5（9 點）要牌拿到 3（12 點），第二輪停牌；1 號邊第一輪就停（暗牌 9、明牌 8 = 17）
    let s = choosing({ hole: [4, 9], up: [[5], [8]], pool: poolOf({ 3: 1 }) });
    s = playRound(s, HIT, STOP);
    s = stepN(s, AI_WAIT_TICKS); // 準備結束，進入第二輪 choose
    s = { ...s, pool: poolOf({ 2: 1 }) };
    s = playRound(s, STOP, STOP);
    expect(s.phase).toBe('showdown');
    s = stepN(s, RESULT_TICKS);
    expect(s.past[0]).toEqual([obs([9, HIT], [12, STOP])]);
    expect(s.past[1]).toEqual([obs([17, STOP])]);
  });

  it('18. past 只留最近 3 手：舊的被擠掉', () => {
    let s = choosing({ hole: [4, 9], up: [[5], [8]] });
    for (let h = 0; h < 5; h += 1) {
      s = playRound(s, STOP, STOP);
      s = stepN(s, RESULT_TICKS);
      s = stepN(s, AI_WAIT_TICKS); // 新一手的準備
      expect(s.phase).toBe('choose');
      expect(s.past[0].length).toBe(Math.min(h + 1, WINDOW));
    }
  });

  it('19. 領牌順序每手交替（dealer 0、1、0……），沒有人因此占便宜（兩邊都是不知道下一張的）', () => {
    let s = h5Game.init(2, CONFIG);
    const dealers: number[] = [s.dealer];
    for (let h = 0; h < 4; h += 1) {
      s = playRound(
        {
          ...s,
          phase: 'choose',
          wait: 0,
        },
        STOP,
        STOP,
      );
      s = stepN(s, RESULT_TICKS);
      dealers.push(s.dealer);
    }
    expect(dealers).toEqual([0, 1, 0, 1, 0]);
  });

  it('20. 超時：choose 的第 300 個 tick 還沒按，自動停牌；第 300 個 tick 按了算按了', () => {
    let s = choosing({ idle: 0 });
    s = stepN(s, DECISION_TIMEOUT - 1);
    expect(s.phase).toBe('choose');
    const auto = h5Game.step(s, idle());
    expect(auto.phase).toBe('locked');
    expect(auto.pending).toEqual([STOP, STOP]);
    const pressed = h5Game.step(s, both(HIT, HIT));
    expect(pressed.pending).toEqual([HIT, HIT]);
  });

  it('21. 打完 HANDS 手：比分高的贏；結束之後 step 原樣回傳；結束前 winner 是 null', () => {
    const last = choosing({ hole: [9, 5], up: [[8], [6]], hand: HANDS - 1, scores: [2, 3] });
    expect(h5Game.winner(last)).toBeNull();
    let s = playRound(last, STOP, STOP);
    s = stepN(s, RESULT_TICKS);
    expect(s.over).toBe(true);
    expect(s.scores).toEqual([3, 3]);
    expect(h5Game.winner(s)).toBeNull();
    const again = h5Game.step(s, press(0, true));
    expect(again).toBe(s);

    const win = choosing({ hole: [9, 5], up: [[8], [6]], hand: HANDS - 1, scores: [3, 3] });
    let t = playRound(win, STOP, STOP);
    t = stepN(t, RESULT_TICKS);
    expect(t.over).toBe(true);
    expect(h5Game.winner(t)).toBe(0);
    expect(h5Game.score(t)).toEqual([4, 3]);
  });

  it('22.（邊界）時間到：已經攤牌的先入帳；還在 choose 或 locked 的這手不算', () => {
    const near = choosing({ maxTicks: 10, tick: 9 });
    const timedOut = h5Game.step(near, press(0, true));
    expect(timedOut.over).toBe(true);
    expect(timedOut.scores).toEqual([0, 0]);
    const shown = playRound(choosing({ hole: [9, 5], up: [[8], [6]] }), STOP, STOP);
    expect(shown.phase).toBe('showdown');
    const cut = h5Game.step({ ...shown, maxTicks: shown.tick + 1 }, idle());
    expect(cut.over).toBe(true);
    expect(cut.scores).toEqual([1, 0]);
  });

  it('23. 沒有人按任何鍵：每個決定等 300 tick，用不完 9 手也會在 3600 tick 內結束', () => {
    let s = h5Game.init(1, CONFIG);
    for (let i = 0; i < 3600 && !s.over; i += 1) {
      s = h5Game.step(s, idle());
    }
    expect(s.over).toBe(true);
  });

  it('24. 亂數狀態有寫回去：連續兩手發的牌不同、同一手的兩輪領的牌也不會每次都一樣', () => {
    let s = h5Game.init(9, CONFIG);
    const deals = new Set<string>();
    deals.add(JSON.stringify([s.hole, s.up]));
    for (let h = 0; h < 6; h += 1) {
      s = playRound({ ...s, phase: 'choose', wait: 0 }, STOP, STOP);
      s = stepN(s, RESULT_TICKS);
      deals.add(JSON.stringify([s.hole, s.up]));
    }
    expect(deals.size).toBeGreaterThanOrEqual(6);
    // 領牌也會推進亂數
    const base = choosing({ pool: poolOf({ 1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4 }) });
    const d = toDeal(base, HIT, HIT);
    expect(d.rng).not.toBe(base.rng);
  });

  it('25. step 不改動傳進來的 state 與輸入（深度凍結也不丟錯），各階段都一樣', () => {
    const base = choosing();
    const phases: H5State[] = [
      makeState(),
      base,
      h5Game.step(base, both(HIT, STOP)),
      toDeal(base, HIT, HIT),
      playRound(base, STOP, STOP),
      stepN(playRound(base, STOP, STOP), RESULT_TICKS - 1),
    ];
    for (const p of phases) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(p)) as H5State);
      const inputs = deepFreeze([{ ...PRESS_A }, { ...PRESS_B }]) as unknown as Inputs;
      expect(() => h5Game.step(frozen, inputs)).not.toThrow();
      expect(frozen).toEqual(p);
    }
  });

  it('26. 整場 JSON 來回不變；比分在每一手之後守恆（贏家 +1、輸家 0 或爆牌 −1）；打完 HANDS 手', () => {
    const a = levelController(h5Game, pathfinder, 5, 3);
    const b = levelController(h5Game, pathfinder, 5, 4);
    let s = h5Game.init(3, CONFIG);
    for (let t = 0; t < 3600 && !s.over; t += 1) {
      s = h5Game.step(s, [a.decide(s, 0, t), b.decide(s, 1, t)]);
    }
    expect(s.over).toBe(true);
    expect(s.hand).toBe(HANDS);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('H-5 二十一點｜totalOf、stopProb、estimateTheta（AI 讀你的門檻）', () => {
  it('totalOf：暗牌加所有明牌', () => {
    expect(totalOf(7, [3, 4])).toBe(14);
    expect(totalOf(10, [])).toBe(10);
  });

  it('stopProb：總點數等於門檻時是 1/2，往上往下單調、對稱；超過 21 一定是停（沒得選）', () => {
    expect(stopProb(15, 15)).toBeCloseTo(0.5, 12);
    expect(stopProb(16.5, 15)).toBeCloseTo(1 / (1 + Math.exp(-1)), 12);
    expect(stopProb(13.5, 15)).toBeCloseTo(1 / (1 + Math.exp(1)), 12);
    for (let t = 3; t < 21; t += 1) {
      expect(stopProb(t + 1, 15.5)).toBeGreaterThan(stopProb(t, 15.5));
    }
    expect(stopProb(22, 15.5)).toBe(1);
    expect(stopProb(30, 8)).toBe(1);
  });

  it('estimateTheta：沒有紀錄是先驗 15.5；模型關掉（消融）永遠是先驗', () => {
    expect(estimateTheta([], true)).toBeCloseTo(15.5, 6);
    expect(estimateTheta(oppStopsAt(3, 12)[0], false)).toBe(15.5);
  });

  it('estimateTheta：在低點數就停牌 → 門檻往下；在高點數還要牌 → 往上', () => {
    expect(estimateTheta(oppStopsAt(3, 12)[0], true)).toBeLessThan(15.5);
    expect(estimateTheta(oppHitsAt(3, 18, 20)[0], true)).toBeGreaterThan(15.5);
  });

  it('estimateTheta 讀得很敏感：只看到一手（一次在 13 停牌）就往下掉至少 1 點；兩手比一手掉得更多', () => {
    const one = estimateTheta(oppStopsAt(1, 13)[0], true);
    const two = estimateTheta(oppStopsAt(2, 13)[0], true);
    expect(15.5 - one).toBeGreaterThanOrEqual(1);
    expect(two).toBeLessThan(one);
  });

  it('estimateTheta 只看最近 3 手：更早的紀錄被擠掉、不影響', () => {
    const recent = oppStopsAt(3, 17)[0];
    const old = [obs([11, HIT], [10, STOP]), ...recent];
    expect(estimateTheta(old, true)).toBeCloseTo(estimateTheta(recent, true), 12);
    // 再多一手就把最舊的擠掉
    const older = [obs([11, HIT], [20, HIT]), ...old];
    expect(estimateTheta(older, true)).toBeCloseTo(estimateTheta(recent, true), 12);
  });

  it('estimateTheta 有上下限（不會因為極端紀錄跑出 6 到 26 之外），不改動傳進來的紀錄', () => {
    const extreme = Array.from({ length: 3 }, () => obs([3, STOP], [4, STOP], [5, STOP]));
    const frozen = deepFreeze(JSON.parse(JSON.stringify(extreme)) as PastObs[][]);
    const theta = estimateTheta(frozen, true);
    expect(theta).toBeGreaterThanOrEqual(6);
    expect(theta).toBeLessThan(15.5);
    expect(frozen).toEqual(extreme);
  });

  it('confidenceLevel：看對手窗口裡有幾手，0 到 3；模型關掉是 0', () => {
    const s = (n: number): H5State =>
      makeState({ past: [Array.from({ length: n }, () => obs([11, HIT], [17, STOP])), []] });
    expect(confidenceLevel(s(0), 1)).toBe(0);
    expect(confidenceLevel(s(1), 1)).toBe(1);
    expect(confidenceLevel(s(2), 1)).toBe(2);
    expect(confidenceLevel(s(3), 1)).toBe(3);
    expect(confidenceLevel(s(5), 1)).toBe(3);
    expect(confidenceLevel({ ...s(3), model: false }, 1)).toBe(0);
  });
});

describe('H-5 二十一點｜unseenCounts、holePosterior（只用公開的資訊推對手的暗牌）', () => {
  it('unseenCounts：每個點數 4 − 我看得到的張數（我的暗牌、雙方的明牌）；不讀牌堆、不讀對手的暗牌、不讀 incoming', () => {
    const s = makeState({ hole: [6, 2], up: [[3], [7, 10]] });
    // 1 號邊看：自己的暗牌 2；明牌 3、7、10
    const u = unseenCounts(s, 1);
    expect(u).toEqual([4, 3, 3, 4, 4, 4, 3, 4, 4, 3]);
    // 對手的暗牌換掉、牌堆亂改、incoming 亂寫，都不影響
    const t = { ...s, hole: [9, 2] as const, pool: poolOf({ 1: 1 }), incoming: [4, 4] as const };
    expect(unseenCounts(t, 1)).toEqual(u);
  });

  it('holePosterior：沒有紀錄時正比於沒看到的張數、加起來是 1', () => {
    const s = makeState({ hole: [6, 2], up: [[3], [7]] });
    const p = holePosterior(s, 1);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    const u = unseenCounts(s, 1);
    const total = u.reduce((a, b) => a + b, 0);
    for (let i = 0; i < 10; i += 1) {
      expect(p[i]).toBeCloseTo((u[i] as number) / total, 12);
    }
  });

  it('holePosterior：對手第一輪就停牌 → 暗牌大的機率變高；對手要牌 → 暗牌小的機率變高', () => {
    const base = { hole: [6, 2] as const, up: [[5], [3]] as const, stood: [true, false] as const };
    const stopped = makeState({ ...base, log: [[STOP, HIT]], round: 1 });
    const hit = makeState({
      ...base,
      up: [[5, 2], [3]],
      stood: [false, false],
      log: [[HIT, HIT]],
      round: 1,
    });
    const mean = (p: readonly number[]): number => p.reduce((a, w, i) => a + w * (i + 1), 0);
    const prior = makeState({ hole: [6, 2], up: [[5], [3]] });
    expect(mean(holePosterior(stopped, 1))).toBeGreaterThan(mean(holePosterior(prior, 1)));
    expect(mean(holePosterior(hit, 1))).toBeLessThan(mean(holePosterior(prior, 1)));
  });

  it('holePosterior：對手要了牌之後就停了、而且不到 4 張 → 一定是爆了，暗牌小的不可能', () => {
    // 0 號邊明牌 6、10，要過一次牌，現在是 stood：總點數 = 暗牌 + 16 > 21 → 暗牌 ≥ 6
    const s = makeState({
      hole: [4, 2],
      up: [[6, 10], [3]],
      stood: [true, false],
      log: [[HIT, HIT]],
      round: 1,
    });
    const p = holePosterior(s, 1);
    for (let h = 1; h <= 5; h += 1) {
      expect(p[h - 1], `暗牌 ${h}`).toBe(0);
    }
    expect(p.slice(5).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('holePosterior 的門檻來自 past：同一個局面，對手過去在低點數停牌 vs 高點數才停，後驗不同', () => {
    const s = (past: H5State['past']): H5State =>
      makeState({
        hole: [6, 2],
        up: [[5], [3]],
        stood: [true, false],
        log: [[STOP, HIT]],
        round: 1,
        past,
      });
    const low = holePosterior(s(oppStopsAt(3, 12)), 1);
    const high = holePosterior(s(oppStopsAt(3, 18)), 1);
    expect(JSON.stringify(low)).not.toBe(JSON.stringify(high));
  });
});

describe('H-5 二十一點｜continuation 與 handValue（這手牌的期望）', () => {
  const FULL = new Array<number>(10).fill(4);

  it('continuation：對手停在 18：17 點停牌 −1；要牌 (3 − 6 × (1 + 爆牌罰分)) ÷ 10（1 平手、2 到 4 贏、5 以上爆）', () => {
    const final = new Array<number>(23).fill(0);
    final[18] = 1;
    const v = continuation(final, FULL, 2, 17);
    expect(v.stop).toBeCloseTo(-1, 12);
    expect(v.hit).toBeCloseTo((3 - 6 * (1 + BUST_EXTRA)) / 10, 12);
  });

  it('continuation：對手一定爆牌：停牌 +2；12 點要牌 9 ÷ 10 × (1 + 爆牌罰分)（拿到 10 反而爆，兩邊都爆是 0）', () => {
    const final = new Array<number>(23).fill(0);
    final[22] = 1;
    const v = continuation(final, FULL, 2, 12);
    expect(v.stop).toBeCloseTo(1 + BUST_EXTRA, 12);
    expect(v.hit).toBeCloseTo((9 * (1 + BUST_EXTRA)) / 10, 12);
  });

  it('continuation：21 點要牌一定爆；3 張牌 20 點要牌拿到 1 以外都爆', () => {
    const final = new Array<number>(23).fill(0);
    final[19] = 1;
    expect(continuation(final, FULL, 2, 21).hit).toBeCloseTo(-1 - BUST_EXTRA, 12);
    // 20 點對 19 點：停牌 +1；要牌：拿 1 → 21 贏 +1，其他爆 −2
    const v = continuation(final, FULL, 3, 20);
    expect(v.stop).toBeCloseTo(1, 12);
    expect(v.hit).toBeCloseTo((1 + 9 * -(1 + BUST_EXTRA)) / 10, 12);
  });

  it('continuation：已經 4 張牌（cards = MAX_CARDS）不能再要，hit 只是形式上的值不會被取用', () => {
    const final = new Array<number>(23).fill(0);
    final[10] = 1;
    const v = continuation(final, FULL, MAX_CARDS, 15);
    expect(Number.isFinite(v.stop)).toBe(true);
    expect(Number.isFinite(v.hit)).toBe(true);
  });

  it('handValue：我 8 點、對手停牌了 → 要牌比停牌好；我 20 點 → 停牌比要牌好', () => {
    const base = {
      up: [[10], [3]] as const,
      stood: [true, false] as const,
      log: [[STOP, HIT]] as H5State['log'],
      round: 1,
    };
    const low = makeState({ ...base, hole: [4, 3 + 2], up: [[10], [3]] }); // 我 5 + 3 = 8
    const lowTotal = totalOf(low.hole[1], low.up[1]);
    expect(lowTotal).toBe(8);
    expect(handValue(low, 1, HIT)).toBeGreaterThan(handValue(low, 1, STOP));
    const high = makeState({ ...base, hole: [4, 9], up: [[10], [3, 8]] });
    expect(totalOf(high.hole[1], high.up[1])).toBe(20);
    expect(handValue(high, 1, STOP)).toBeGreaterThan(handValue(high, 1, HIT));
  });

  it('handValue 只讀公開的資訊與自己的牌：對手的暗牌不同，期望相同', () => {
    const mk = (h: number): H5State =>
      makeState({
        hole: [h, 7],
        up: [[5], [4, 4]],
        stood: [false, false],
        log: [[HIT, HIT]],
        round: 1,
      });
    const a = handValue(mk(2), 1, HIT);
    const b = handValue(mk(10), 1, HIT);
    expect(a).toBeCloseTo(b, 12);
  });

  it('handValue 的 theta 參數：覆寫之後用那個門檻預測對手（對手本輪還沒停牌時才有差）', () => {
    const s = makeState({
      hole: [6, 7],
      up: [
        [5, 3],
        [4, 4],
      ],
      round: 1,
      log: [[HIT, HIT]],
    });
    const v1 = handValue(s, 1, STOP, 12);
    const v2 = handValue(s, 1, STOP, 19);
    expect(v1).not.toBeCloseTo(v2, 6);
  });
});

describe('H-5 二十一點｜actions 與 evaluate', () => {
  it('actions：choose、我還沒按、我沒停牌 → [停牌, 要牌]（停牌排第一）；其他都只有 [全放開]', () => {
    const s = choosing();
    for (const side of [0, 1] as const) {
      const list = h5Game.actions(s, side);
      expect(list).toHaveLength(2);
      expect(sameButtons(list[0] as Buttons, PRESS_B)).toBe(true);
      expect(sameButtons(list[1] as Buttons, PRESS_A)).toBe(true);
    }
    const iPressed = choosing({ pending: [HIT, null] });
    expect(h5Game.actions(iPressed, 0)).toHaveLength(1);
    expect(h5Game.actions(iPressed, 1)).toHaveLength(2);
    const stoodSide = choosing({ stood: [true, false], pending: [STOP, null] });
    expect(h5Game.actions(stoodSide, 0)).toHaveLength(1);
    for (const phase of ['prep', 'locked', 'deal', 'showdown'] as const) {
      expect(h5Game.actions(makeState({ phase }), 0)).toEqual([IDLE]);
    }
    expect(h5Game.actions(makeState({ over: true, phase: 'showdown' }), 0)).toEqual([IDLE]);
  });

  it('evaluate：每個階段 gain 有限、danger 在 0 到 1；結束的局有勝負加成', () => {
    const base = choosing();
    const states: H5State[] = [
      makeState(),
      base,
      h5Game.step(base, both(HIT, STOP)),
      toDeal(base, HIT, HIT),
      playRound(base, STOP, STOP),
    ];
    for (const s of states) {
      for (const side of [0, 1] as const) {
        const e = h5Game.evaluate(s, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
    const won = makeState({ over: true, winner: 0, scores: [3, 1] });
    expect(h5Game.evaluate(won, 0).gain).toBeGreaterThan(1000);
    expect(h5Game.evaluate(won, 1).gain).toBeLessThan(-1000);
  });

  it('evaluate：locked 階段只有反射規則的小加分——我的總點數 < 16 選要牌、≥ 16 選停牌各加 HABIT', () => {
    const at = (total: number, move: Move): number => {
      const hole = Math.min(10, total - 1);
      const s = makeState({
        phase: 'locked',
        wait: LOCK_TICKS,
        hole: [5, hole],
        up: [[5], [total - hole]],
        pending: [null, move],
      });
      return h5Game.evaluate(s, 1).gain;
    };
    // 總點數 15：要牌比停牌多一點點；總點數 16：停牌多一點點
    expect(at(15, HIT) - at(15, STOP)).toBeCloseTo(0.01, 12);
    expect(at(16, STOP) - at(16, HIT)).toBeCloseTo(0.01, 12);
    expect(at(8, HIT)).toBeGreaterThan(at(8, STOP));
    expect(at(19, STOP)).toBeGreaterThan(at(19, HIT));
  });
});

describe('H-5 二十一點｜不偷看（evaluate、actions、decide 都只讀自己的牌與公開資訊）', () => {
  /**
   * 一組只有 0 號邊（對手）隱藏資訊不同的 state；AI 坐 1 號邊。
   * 公開的：雙方的明牌、log、past、stood。隱藏的：對手的暗牌（連帶牌堆）、對手這輪的 pending、incoming、亂數、last。
   */
  const past: H5State['past'] = [
    [obs([11, HIT], [17, STOP]), obs([9, HIT], [13, HIT], [19, STOP])],
    [obs([10, HIT], [16, STOP])],
  ];
  const shared = {
    hole: [0, 8] as readonly [number, number],
    scores: [2, 1] as readonly [number, number],
    past,
    hand: 3,
  };
  const oppHoles = [2, 9];

  function variants(): { name: string; states: H5State[] }[] {
    const g: { name: string; states: H5State[] }[] = [];
    const round0 = { ...shared, up: [[6], [5]] as H5State['up'] };
    const round1 = {
      ...shared,
      up: [
        [6, 3],
        [5, 4],
      ] as H5State['up'],
      log: [[HIT, HIT]] as H5State['log'],
      round: 1,
    };
    g.push({
      name: 'choose 第一輪（我還沒按）：對手暗牌、對手 pending、亂數不同',
      states: oppHoles.flatMap((h) =>
        ([null, HIT, STOP] as const).flatMap((p) =>
          [1, 99999].map((rng) => choosing({ ...round0, hole: [h, 8], pending: [p, null], rng })),
        ),
      ),
    });
    g.push({
      name: 'choose 第二輪：對手暗牌、pending 不同',
      states: oppHoles.flatMap((h) =>
        ([null, HIT, STOP] as const).map((p) =>
          choosing({ ...round1, hole: [h, 8], pending: [p, null] }),
        ),
      ),
    });
    g.push({
      name: 'choose：對手已經停牌（pending 預填），暗牌不同',
      states: oppHoles.map((h) =>
        choosing({ ...round1, hole: [h, 8], stood: [true, false], pending: [STOP, null] }),
      ),
    });
    g.push({
      name: 'locked：我剛按了鍵，對手的暗牌與 pending 不同',
      states: oppHoles.flatMap((h) =>
        ([HIT, STOP] as const).map((p) =>
          makeState({
            ...round1,
            hole: [h, 8],
            phase: 'locked',
            wait: LOCK_TICKS,
            pending: [p, HIT],
          }),
        ),
      ),
    });
    g.push({
      name: 'deal：公開之後，對手的暗牌、pending、incoming 不同（我的 pending 固定）',
      states: oppHoles.flatMap((h) =>
        ([HIT, STOP] as const).flatMap((p) =>
          [1, 7].map((inc) =>
            makeState({
              ...round1,
              hole: [h, 8],
              phase: 'deal',
              wait: RESULT_TICKS,
              pending: [p, HIT],
              incoming: [p === HIT ? inc : null, inc === 1 ? 4 : 9],
              rng: inc * 1000,
            }),
          ),
        ),
      ),
    });
    g.push({
      name: 'deal：我停牌，對手的暗牌、pending、incoming 不同',
      states: oppHoles.flatMap((h) =>
        ([HIT, STOP] as const).map((p) =>
          makeState({
            ...round1,
            hole: [h, 8],
            phase: 'deal',
            wait: RESULT_TICKS,
            pending: [p, STOP],
            incoming: [p === HIT ? 6 : null, null],
          }),
        ),
      ),
    });
    g.push({
      name: 'prep（下一輪）：對手的暗牌不同',
      states: oppHoles.map((h) => makeState({ ...round1, hole: [h, 8], phase: 'prep', wait: 20 })),
    });
    g.push({
      name: 'showdown：結果（last）與對手的暗牌不同',
      states: oppHoles.map((h) =>
        makeState({
          ...round1,
          hole: [h, 8],
          stood: [true, true],
          phase: 'showdown',
          wait: RESULT_TICKS,
          pending: [STOP, STOP],
          last: {
            totals: [h + 9, 17],
            delta: h > 4 ? [1, 0] : [0, 1],
            busted: [false, false],
          },
        }),
      ),
    });
    return g;
  }

  function peeks(game: Game<H5State>, states: readonly H5State[], side: Side): boolean {
    const first = states[0] as H5State;
    const e0 = JSON.stringify(game.evaluate(first, side));
    const a0 = JSON.stringify(game.actions(first, side));
    return states.some(
      (s) =>
        JSON.stringify(game.evaluate(s, side)) !== e0 ||
        JSON.stringify(game.actions(s, side)) !== a0,
    );
  }

  /** 把 0 號邊與 1 號邊對調（AI 坐 0 號邊的鏡像）。 */
  function mirror(s: H5State): H5State {
    const swap = <T>(pair: readonly [T, T]): readonly [T, T] => [pair[1], pair[0]];
    return {
      ...s,
      dealer: (1 - s.dealer) as Side,
      hole: swap(s.hole),
      up: swap(s.up),
      stood: swap(s.stood),
      pending: swap(s.pending),
      incoming: swap(s.incoming),
      scores: swap(s.scores),
      past: swap(s.past),
      log: s.log.map((r) => swap(r)),
      last:
        s.last === null
          ? null
          : {
              totals: swap(s.last.totals),
              delta: swap(s.last.delta),
              busted: swap(s.last.busted),
            },
    };
  }

  function decideAtDepth(
    state: H5State,
    side: Side,
    depth: number,
    policy: Policy = pathfinder,
    game: Game<H5State> = h5Game,
  ): Buttons {
    const controller = wrapPolicy(
      game,
      policy,
      { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
      7,
    );
    return controller.decide(state, side, 0);
  }

  it('每一組只有對手隱藏資訊不同的 state：AI 側的 evaluate 與 actions 完全相同', () => {
    for (const g of variants()) {
      expect(peeks(h5Game, g.states, 1), g.name).toBe(false);
    }
  });

  it('反過來也成立：AI 坐 0 號邊（鏡像）', () => {
    for (const g of variants()) {
      expect(peeks(h5Game, g.states.map(mirror), 0), g.name).toBe(false);
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

  it('偵測器本身有效：故意洩漏（讀對手的暗牌、讀對手的 pending、讀 incoming、讀 last、讓 actions 多一個動作）一定被抓到', () => {
    const groups = variants();
    const leaks: Record<string, (s: H5State, side: Side) => number> = {
      '讀對手的暗牌（所有階段）': (s, side) => 0.001 * (s.hole[1 - side] as number),
      '讀對手的暗牌（locked）': (s, side) =>
        s.phase === 'locked' ? 0.001 * (s.hole[1 - side] as number) : 0,
      '讀對手的暗牌（deal／showdown）': (s, side) =>
        s.phase === 'deal' || s.phase === 'showdown' ? 0.001 * (s.hole[1 - side] as number) : 0,
      '讀對手這一輪的 pending': (s, side) => (s.pending[1 - side] === HIT ? 0.001 : 0),
      '讀對手這一輪領到的牌（incoming）': (s, side) =>
        0.001 * ((s.incoming[1 - side] as number | null) ?? 0),
      '讀自己的 incoming（未來的牌）': (s, side) =>
        0.001 * ((s.incoming[side] as number | null) ?? 0),
      '讀 last 的結局': (s, side) => (s.last === null ? 0 : 0.001 * (s.last.delta[side] as number)),
    };
    for (const [name, extra] of Object.entries(leaks)) {
      const leaky: Game<H5State> = {
        ...h5Game,
        evaluate: (s, side) => {
          const e = h5Game.evaluate(s, side);
          return { gain: e.gain + extra(s, side), danger: e.danger };
        },
      };
      expect(
        groups.some((g) => peeks(leaky, g.states, 1)),
        `沒抓到洩漏：${name}`,
      ).toBe(true);
    }
    const leakyActions: Game<H5State> = {
      ...h5Game,
      actions: (s, side) =>
        s.pending[1 - side] === HIT ? [...h5Game.actions(s, side), IDLE] : h5Game.actions(s, side),
    };
    expect(groups.some((g) => peeks(leakyActions, g.states, 1))).toBe(true);
  });

  it('「對所有動作加同一個常數」的洩漏：黑箱 decide 抓不到（選擇不變），只有 evaluate／actions 相等那兩條抓得到', () => {
    // 洩漏：不管我按什麼，都加上對手暗牌的一個常數。排序不變，所以 decide 一樣；但 evaluate 已經不同。
    const leaky: Game<H5State> = {
      ...h5Game,
      evaluate: (s, side) => {
        const e = h5Game.evaluate(s, side);
        return { gain: e.gain + 0.37 * (s.hole[1 - side] as number), danger: e.danger };
      },
    };
    const group = variants()[1] as { states: H5State[] };
    // 1. evaluate 相等測試會紅
    expect(peeks(leaky, group.states, 1)).toBe(true);
    // 2. 但是黑箱 decide 一樣（這就是為什麼不能只測 decide）
    for (const depth of [1, 3, 6]) {
      const presses = group.states.map((s) =>
        JSON.stringify(decideAtDepth(s, 1, depth, pathfinder, leaky)),
      );
      expect(new Set(presses).size, `深度 ${depth}`).toBe(1);
    }
  });

  it('洩漏會改變選擇的那型：往前模擬時假裝知道對手的暗牌 → 黑箱 decide 也會不同', () => {
    const leakyChoice: Game<H5State> = {
      ...h5Game,
      evaluate: (s, side) => {
        const e = h5Game.evaluate(s, side);
        if (s.phase !== 'deal') {
          return e;
        }
        // 假裝知道對手的總點數：我要牌且我會贏就加分
        const oppTotal =
          (s.hole[1 - side] as number) + (s.up[1 - side] as number[]).reduce((a, b) => a + b, 0);
        const mine = totalOf(s.hole[side], s.up[side]);
        const bonus = mine > oppTotal ? 3 : -3;
        return { gain: e.gain + (s.pending[side] === HIT ? bonus : 0), danger: 0 };
      },
    };
    const decisions = [2, 10].map((h) =>
      JSON.stringify(
        decideAtDepth(
          choosing({
            hole: [h, 8],
            up: [
              [6, 3],
              [5, 4],
            ],
            log: [[HIT, HIT]],
            round: 1,
          }),
          1,
          3,
          pathfinder,
          leakyChoice,
        ),
      ),
    );
    expect(new Set(decisions).size).toBeGreaterThan(1);
  });
});

describe('H-5 二十一點｜AI 怎麼打（等級曲線從結算流程長出來）', () => {
  function decideAtDepth(state: H5State, side: Side, depth: number): Buttons {
    return wrapPolicy(
      h5Game,
      pathfinder,
      { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
      7,
    ).decide(state, side, 0);
  }

  /** AI（1 號邊）第一輪的決定：自己的總點數 `total`（暗牌＋一張明牌）。 */
  function firstRound(total: number, oppUp: number, past: H5State['past'] = [[], []]): H5State {
    const up = Math.min(10, total - 1);
    const hole = total - up;
    return choosing({ hole: [4, hole], up: [[oppUp], [up]], past });
  }

  /** AI 第二輪的決定：自己 3 張牌合計 `total`；對手要了一次牌，明牌 `oppUp`。 */
  function secondRound(
    total: number,
    oppUp: readonly number[],
    past: H5State['past'] = [[], []],
  ): H5State {
    const mineUp = [Math.min(8, total - 2), 0];
    mineUp[1] = Math.min(8, Math.max(1, total - 1 - (mineUp[0] as number)));
    const hole = total - (mineUp[0] as number) - (mineUp[1] as number);
    return choosing({ hole: [4, hole], up: [oppUp, mineUp], log: [[HIT, HIT]], round: 1, past });
  }

  it('深度 1、2（等級 1 到 3）是反射規則：總點數 < 16 要牌、≥ 16 停牌，不管歷史、不管對手的明牌', () => {
    const pasts: H5State['past'][] = [[[], []], oppStopsAt(3, 12), oppHitsAt(3, 18, 20)];
    for (const depth of [1, 2]) {
      for (let total = 4; total <= 20; total += 1) {
        for (const past of pasts) {
          for (const oppUp of [2, 9]) {
            const press = decideAtDepth(firstRound(total, oppUp, past), 1, depth);
            expect(press.a, `深度 ${depth} 總點數 ${total}`).toBe(total < 16);
            expect(press.b, `深度 ${depth} 總點數 ${total}`).toBe(total >= 16);
          }
        }
      }
    }
  });

  it('深度 ≥ 3：絕對安全的要牌（總點數 ≤ 11 不可能爆）一定要；21 點一定停', () => {
    for (const depth of [3, 4, 6]) {
      for (let total = 4; total <= 11; total += 1) {
        expect(
          decideAtDepth(firstRound(total, 5), 1, depth).a,
          `深度 ${depth} 總點數 ${total}`,
        ).toBe(true);
      }
      expect(decideAtDepth(secondRound(21, [5, 6]), 1, depth).b).toBe(true);
      expect(decideAtDepth(secondRound(20, [5, 6]), 1, depth).b).toBe(true);
    }
  });

  it('深度 ≥ 3 不是反射規則：存在局面，深度 6 的選擇和「< 16 就要」不同', () => {
    let differs = false;
    for (let total = 12; total <= 19 && !differs; total += 1) {
      for (const oppUp of [
        [2, 3],
        [9, 10],
      ]) {
        for (const second of [true]) {
          const s = second ? secondRound(total, oppUp) : firstRound(total, 5);
          const press = decideAtDepth(s, 1, 6);
          if (press.a !== total < 16) {
            differs = true;
          }
        }
      }
    }
    expect(differs).toBe(true);
  });

  it('等級曲線是階梯：深度 1、2 永遠一樣（讀不到歷史），深度 ≥ 3 存在同一個局面因為歷史不同而選不同的鍵', () => {
    const pasts: H5State['past'][] = [
      [[], []],
      oppStopsAt(3, 12),
      oppStopsAt(3, 19),
      oppHitsAt(3, 18, 20),
    ];
    const scenarios: H5State[] = [];
    for (let total = 11; total <= 19; total += 1) {
      for (const oppUp of [
        [2, 3],
        [5, 6],
        [9, 10],
      ]) {
        scenarios.push(secondRound(total, oppUp));
      }
    }
    const picks = (depth: number): boolean => {
      let differs = false;
      for (const s of scenarios) {
        const set = new Set(
          pasts.map((past) => JSON.stringify(decideAtDepth({ ...s, past }, 1, depth))),
        );
        if (set.size > 1) {
          differs = true;
        }
      }
      return differs;
    };
    expect(picks(1)).toBe(false);
    expect(picks(2)).toBe(false);
    expect(picks(3)).toBe(true);
    expect(picks(6)).toBe(true);
  });

  it('模型關掉（消融）：深度 6 的 AI 對任何歷史都選一樣的鍵', () => {
    const pasts: H5State['past'][] = [
      [[], []],
      oppStopsAt(3, 12),
      oppStopsAt(3, 19),
      oppHitsAt(3, 18, 20),
    ];
    for (let total = 11; total <= 19; total += 1) {
      for (const oppUp of [
        [2, 3],
        [5, 6],
        [9, 10],
      ]) {
        const set = new Set(
          pasts.map((past) =>
            JSON.stringify(
              decideAtDepth({ ...secondRound(total, oppUp, past), model: false }, 1, 6),
            ),
          ),
        );
        expect(set.size, `總點數 ${total} 對手明牌 ${oppUp.join('+')}`).toBe(1);
      }
    }
  });

  it('DESIGN-AI-FUN 10.11 (a)(b)(c)：它讀錯你的門檻就賠錢——規則層面成立（不是靠參數）', () => {
    // 真實世界：對手（0 號邊）的門檻是 16（總點數 ≥ 16 就停）。
    const TRUE_THETA = 16;
    const believedLow = oppStopsAt(3, 12); // AI 看到的紀錄：它以為你在很低的點數就停
    let found = 0;
    let worstLoss = 0;
    for (let total = 11; total <= 19; total += 1) {
      for (const oppUp of [
        [2, 3],
        [4, 6],
        [5, 8],
        [7, 9],
      ]) {
        const s = { ...secondRound(total, oppUp), past: believedLow };
        // (a)(b) AI 的選擇因為它的錯誤信念而偏離「用真實門檻算的最佳選擇」
        const believedBest = handValue(s, 1, HIT) > handValue(s, 1, STOP) ? HIT : STOP;
        const trueBest =
          handValue(s, 1, HIT, TRUE_THETA) > handValue(s, 1, STOP, TRUE_THETA) ? HIT : STOP;
        if (believedBest === trueBest) {
          continue;
        }
        // 它真的會照信念選（decide 與信念下的最佳一致）
        const pressed = decideAtDepth(s, 1, 6);
        expect(pressed.a).toBe(believedBest === HIT);
        // (c) 照錯誤信念選，在真實世界裡期望比較低
        const loss =
          handValue(s, 1, trueBest, TRUE_THETA) - handValue(s, 1, believedBest, TRUE_THETA);
        expect(loss).toBeGreaterThan(0);
        worstLoss = Math.max(worstLoss, loss);
        found += 1;
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(worstLoss).toBeGreaterThan(0.05);
  });

  describe('DESIGN-AI-FUN 10.6 的兩個 pending 陷阱', () => {
    function phasesSeen(depth: number, state: H5State, side: Side): Set<string> {
      const seen = new Set<string>();
      const spy: Game<H5State> = {
        ...h5Game,
        evaluate: (s, who) => {
          seen.add(s.phase);
          return h5Game.evaluate(s, who);
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

    it('陷阱二：actions()[0] 是停牌（b），一個會推進結算的動作，不是什麼都不按', () => {
      for (const s of [choosing(), choosing({ pending: [HIT, null] }), secondRound(14, [3, 4])]) {
        for (const side of [0, 1] as const) {
          const list = h5Game.actions(s, side);
          if (list.length === 1) {
            continue; // 我已經按過了；對手模擬時用的是它的 actions()[0]
          }
          expect(sameButtons(list[0] as Buttons, IDLE)).toBe(false);
          expect(sameButtons(list[0] as Buttons, PRESS_B)).toBe(true);
        }
      }
      // 對手在模擬裡按 actions()[0]：我按完之後 state 一定進入 locked（不會卡在 choose）
      const s = choosing();
      const mine = h5Game.actions(s, 0)[1] as Buttons;
      const theirs = h5Game.actions(s, 1)[0] as Buttons;
      expect(h5Game.step(s, [mine, theirs]).phase).toBe('locked');
    });

    it('陷阱一：按 → 鎖定 → 公開一共 3 步，在 depth 的 6 格額度之內', () => {
      let cur = h5Game.step(choosing(), both(HIT, HIT));
      let steps = 1;
      while (cur.phase !== 'deal') {
        cur = h5Game.step(cur, idle());
        steps += 1;
      }
      expect(steps).toBe(3);
      expect(steps).toBeLessThanOrEqual(6);
    });

    it('深度 1、2 的 decide 沒評估過公開之後的局面（deal），深度 3 以上評估過', () => {
      const states = [firstRound(13, 5), secondRound(15, [4, 5])];
      for (const state of states) {
        for (const depth of [1, 2]) {
          expect(phasesSeen(depth, state, 1).has('deal'), `深度 ${depth}`).toBe(false);
        }
        for (const depth of [3, 4, 6]) {
          expect(phasesSeen(depth, state, 1).has('deal'), `深度 ${depth}`).toBe(true);
        }
      }
    });
  });
});

describe('H-5 二十一點｜AI 能不能玩', () => {
  it('兩個等級 5 的搜尋型打完一整場：9 手都打完，在 maxTicks 之前結束', () => {
    for (const seed of [1, 2, 3]) {
      const a = levelController(h5Game, pathfinder, 5, seed);
      const b = levelController(h5Game, pathfinder, 5, seed + 1_000_003);
      const r = playMatch(h5Game, seed, CONFIG, a, b);
      expect(r.ticks).toBeLessThan(3600);
      expect(r.ticks).toBeGreaterThan(900);
    }
  });

  it('人類模型與隨機控制器也能把一場打完：不會卡住', () => {
    const a = levelController(h5Game, random, 10, 3);
    const b = humanModel(h5Game, 4);
    expect(() => playMatch(h5Game, 3, CONFIG, a, b)).not.toThrow();
  });

  it('等級參數沒有被誤用：深度 3 是第一個走得到公開的深度（levelParams 的 depth 範圍 1 到 6）', () => {
    expect(levelParams(1).depth).toBe(1);
    expect(levelParams(10).depth).toBe(6);
    expect(LOCK_TICKS + 1).toBeLessThanOrEqual(6);
  });

  it('holePosterior 回傳的後驗不會因為 unseenCounts 用光而變成 NaN（極端局面也有限）', () => {
    const s = makeState({
      hole: [10, 10],
      up: [
        [10, 10],
        [10, 10],
      ],
      stood: [true, false],
      log: [[HIT, HIT]],
      round: 1,
    });
    const p = holePosterior(s, 1);
    for (const w of p) {
      expect(Number.isFinite(w)).toBe(true);
    }
  });
});
