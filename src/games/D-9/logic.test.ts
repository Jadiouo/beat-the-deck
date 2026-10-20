import { describe, expect, it } from 'vitest';

import { levelController, policyByName, wrapPolicy } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { random } from '../../ai/policies/random';
import { playMatch } from '../../core/match';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import {
  DEPOSITS,
  DRAW_EVERY,
  END_TICKS,
  IDLE,
  JUMP_EVERY,
  KEY_LEFT,
  KEY_LOCK,
  KEY_PASS,
  KEY_RIGHT,
  LOCK_TICKS,
  MAX_ROUNDS,
  PASS,
  PLACE_TIMEOUT,
  PREP_TICKS,
  RUN_TICKS,
  STOCKS,
  WINDOW,
  d9Game,
  makeState,
  predictOpponent,
  projectDraws,
  ranksOf,
} from './logic';
import type { D9State, Round } from './logic';

/**
 * D-9 擺放的規則測試（規則見 `docs/cards/D-9.md`）。
 * 全部用 `makeState` 直接構造局面。`makeState` 的礦脈：存量照 `STOCKS` 原順序（索引 0 是 6、索引 9 是 20），
 * 所以「最肥」是索引 9（20）、第二肥 8（16）、第三肥 7（14）、再來 5（12）、6（12）、3（10）、4（10）、1（8）、2（8）、0（6）。
 * 游標預設都在索引 0。測試用的局面預設 8 輪（`MAX_ROUNDS`）、`zs`（對手收成的權重）= 預設值（1：算兩邊的差；要看小規格原文的「只算自己的期望收成」要明寫 `zs: 0`）。
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

function both(k0: Buttons = IDLE, k1: Buttons = IDLE): Inputs {
  return [k0, k1];
}

function stepN(state: D9State, n: number, inputs: Inputs = both()): D9State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = d9Game.step(s, inputs);
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

/** 擺放階段、兩邊都還沒鎖定。 */
function placing(overrides: Partial<D9State> = {}): D9State {
  return makeState({ phase: 'place', wait: 0, ...overrides });
}

/** 把兩邊的游標放到指定礦脈、同一個 tick 都按 a 鎖定。 */
function lockBoth(state: D9State, p0: number, p1: number): D9State {
  return d9Game.step({ ...state, sel: [p0, p1] }, both(KEY_LOCK, KEY_LOCK));
}

/** 從擺放階段出發：兩邊鎖定在 p0、p1（-1 是不擺），走完 locked 到揭曉（run 的第 0 tick）。 */
function toRun(state: D9State, p0: number, p1: number): D9State {
  const keyOf = (p: number, sel: number): [Buttons, number] =>
    p === PASS ? [KEY_PASS, sel] : [KEY_LOCK, p];
  const [k0, s0] = keyOf(p0, 0);
  const [k1, s1] = keyOf(p1, 0);
  const locked = d9Game.step({ ...state, sel: [s0, s1] }, both(k0, k1));
  return stepN(locked, LOCK_TICKS);
}

/** 從擺放階段出發：鎖定、揭曉、跑完整個 run（下一輪的擺放，或結束前的 end）。 */
function playRound(state: D9State, p0: number, p1: number): D9State {
  return stepN(toRun(state, p0, p1), RUN_TICKS);
}

function ringStocks(stocks: readonly number[]): D9State['deposits'] {
  const base = makeState().deposits;
  return base.map((d, i) => ({ cell: d.cell, stock: stocks[i] ?? 0 }));
}

describe('D-9 擺放｜初始', () => {
  it('init：10 個礦脈（格子不同、兩兩曼哈頓距離 ≥ 4、依格子編號排好）、存量是 STOCKS 的排列（共 116）、準備期、分數 0', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const s = d9Game.init(seed, CONFIG);
      expect(s.deposits).toHaveLength(DEPOSITS);
      const cells = s.deposits.map((d) => d.cell);
      expect([...cells].sort((a, b) => a - b)).toEqual(cells);
      expect(new Set(cells).size).toBe(DEPOSITS);
      for (const c of cells) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(32 * 24);
      }
      for (let i = 0; i < DEPOSITS; i += 1) {
        for (let j = i + 1; j < DEPOSITS; j += 1) {
          const dist =
            Math.abs(((cells[i] as number) % 32) - ((cells[j] as number) % 32)) +
            Math.abs(Math.floor((cells[i] as number) / 32) - Math.floor((cells[j] as number) / 32));
          expect(dist).toBeGreaterThanOrEqual(4);
        }
      }
      expect(s.deposits.map((d) => d.stock).sort((a, b) => a - b)).toEqual(
        [...STOCKS].sort((a, b) => a - b),
      );
      expect(s.phase).toBe('prep');
      expect(s.wait).toBe(PREP_TICKS);
      expect(s.round).toBe(0);
      expect(s.drawn).toEqual([0, 0]);
      expect(s.coll).toEqual([]);
      expect(s.history).toEqual([]);
      expect(d9Game.isOver(s)).toBe(false);
      expect(d9Game.winner(s)).toBeNull();
    }
  });

  it('種子有效：種子 0 到 9 的礦脈位置與存量不全相同；同一個種子兩次 init 完全一樣', () => {
    const maps = Array.from({ length: 10 }, (_v, seed) =>
      JSON.stringify(d9Game.init(seed, CONFIG).deposits),
    );
    expect(new Set(maps).size).toBeGreaterThan(5);
    const stocks = Array.from({ length: 10 }, (_v, seed) =>
      d9Game
        .init(seed, CONFIG)
        .deposits.map((d) => d.stock)
        .join(),
    );
    expect(new Set(stocks).size).toBeGreaterThan(5);
    expect(d9Game.init(4, CONFIG)).toEqual(d9Game.init(4, CONFIG));
  });

  it('輪數是參數：預設 MAX_ROUNDS 以內；params.rounds = 5 就是 5 輪；超出範圍夾回 1 到 MAX_ROUNDS', () => {
    const rounds = (n?: number): number =>
      d9Game.init(0, { maxTicks: 3600, params: n === undefined ? {} : { rounds: n } }).rounds;
    expect(rounds()).toBeGreaterThanOrEqual(5);
    expect(rounds()).toBeLessThanOrEqual(MAX_ROUNDS);
    expect(rounds(5)).toBe(5);
    expect(rounds(8)).toBe(8);
    expect(rounds(99)).toBe(MAX_ROUNDS);
    expect(rounds(0)).toBe(1);
  });
});

describe('D-9 擺放｜規則', () => {
  it('1. 準備期 PREP_TICKS：這段時間輸入都被忽略（邊界：最後一個 tick 按無效，下一個 tick 才算）', () => {
    let s = makeState();
    s = stepN(s, PREP_TICKS - 1, both(KEY_LOCK, KEY_LOCK));
    expect(s.phase).toBe('prep');
    expect(s.pending).toEqual([null, null]);
    s = d9Game.step(s, both(KEY_LOCK, KEY_LOCK));
    expect(s.phase).toBe('place');
    const t = d9Game.step(s, both(KEY_LOCK, IDLE));
    expect(t.pending).toEqual([0, null]);
  });

  it('2. 游標：左（上）跳到上一個、右（下）跳到下一個，首尾相接', () => {
    const s = placing();
    const left = d9Game.step(s, both(KEY_LEFT, KEY_RIGHT));
    expect(left.sel).toEqual([DEPOSITS - 1, 1]);
    const up = d9Game.step(s, both({ ...IDLE, up: true }, { ...IDLE, down: true }));
    expect(up.sel).toEqual([DEPOSITS - 1, 1]);
    const wrap = d9Game.step(placing({ sel: [DEPOSITS - 1, 0] }), both(KEY_RIGHT, KEY_LEFT));
    expect(wrap.sel).toEqual([0, DEPOSITS - 1]);
    // 左右同時按：當作沒有方向。
    expect(d9Game.step(s, both({ ...IDLE, left: true, right: true })).sel).toEqual([0, 0]);
  });

  it('3. 按住不放只跳一次（要放開再按）', () => {
    const s = stepN(placing(), 30, both(KEY_LEFT, KEY_RIGHT));
    expect(s.sel).toEqual([DEPOSITS - 1, 1]);
  });

  it('4.（邊界）跳的冷卻 JUMP_EVERY：放開再按，第 JUMP_EVERY 個 tick 之前再按無效，第 JUMP_EVERY 個 tick 才算', () => {
    // 每個 tick 交替按／放：第 0 個 tick 跳，第 2、4 個 tick 在冷卻中，第 JUMP_EVERY 個 tick 又能跳。
    let s = placing();
    for (let k = 0; k < JUMP_EVERY; k += 1) {
      s = d9Game.step(s, both(k % 2 === 0 ? KEY_LEFT : IDLE));
    }
    expect(s.sel[0]).toBe(DEPOSITS - 1);
    s = d9Game.step(s, both(JUMP_EVERY % 2 === 0 ? KEY_LEFT : IDLE));
    expect(s.sel[0]).toBe(JUMP_EVERY % 2 === 0 ? DEPOSITS - 2 : DEPOSITS - 1);
    // 兩邊的冷卻各自算。
    const mixed = d9Game.step(d9Game.step(placing(), both(KEY_LEFT, IDLE)), both(IDLE, KEY_LEFT));
    expect(mixed.sel).toEqual([DEPOSITS - 1, DEPOSITS - 1]);
  });

  it('5. 按 a 鎖定游標指的礦脈；鎖定之後再按什麼（跳、a、b）都沒有用，游標也不動', () => {
    const s = placing({ sel: [4, 2] });
    const t = d9Game.step(s, both(KEY_LOCK, IDLE));
    expect(t.pending).toEqual([4, null]);
    const again = stepN(t, 20, both(KEY_RIGHT, IDLE));
    expect(again.pending[0]).toBe(4);
    expect(again.sel[0]).toBe(4);
    expect(d9Game.step(t, both(KEY_PASS, IDLE)).pending[0]).toBe(4);
    expect(d9Game.step(t, both(KEY_LOCK, IDLE)).pending[0]).toBe(4);
  });

  it('6. 按 b：這一輪不擺（pending = -1）；同一個 tick 同時按 a 和 b 當作沒有動作', () => {
    const s = placing({ sel: [4, 2] });
    expect(d9Game.step(s, both(KEY_PASS, IDLE)).pending).toEqual([PASS, null]);
    const ab: Buttons = { ...IDLE, a: true, b: true };
    expect(d9Game.step(s, both(ab, ab)).pending).toEqual([null, null]);
    // a 與方向同一個 tick：鎖定在原地，不跳。
    const al: Buttons = { ...IDLE, a: true, left: true };
    const t = d9Game.step(s, both(al, IDLE));
    expect(t.pending[0]).toBe(4);
    expect(t.sel[0]).toBe(4);
  });

  it('7.（邊界）超時：第 PLACE_TIMEOUT 個 tick 還沒鎖定的那一邊自動不擺；那個 tick 按了算數，不算超時', () => {
    const s = stepN(placing({ sel: [3, 3] }), PLACE_TIMEOUT - 1);
    expect(s.phase).toBe('place');
    expect(s.pending).toEqual([null, null]);
    const timedOut = d9Game.step(s, both());
    expect(timedOut.pending).toEqual([PASS, PASS]);
    expect(timedOut.phase).toBe('locked');
    const pressed = d9Game.step(s, both(KEY_LOCK, IDLE));
    expect(pressed.pending).toEqual([3, PASS]);
  });

  it('8.（邊界）兩邊鎖定之後等 LOCK_TICKS 個 tick，第 LOCK_TICKS + 1 步揭曉（搜尋 3 步看得到，10.6 陷阱一）', () => {
    const locked = lockBoth(placing(), 9, 8);
    expect(locked.phase).toBe('locked');
    expect(locked.coll).toEqual([]);
    const mid = stepN(locked, LOCK_TICKS - 1);
    expect(mid.phase).toBe('locked');
    const run = d9Game.step(mid, both());
    expect(run.phase).toBe('run');
    expect(run.wait).toBe(RUN_TICKS);
    expect(run.coll).toEqual([
      { dep: 9, owner: 0, round: 0 },
      { dep: 8, owner: 1, round: 0 },
    ]);
    expect(run.pending).toEqual([9, 8]);
  });

  it('9. 揭曉：空位夠（req ≤ free）全部擺成；兩邊同一輪搶同一個全空的礦脈 → 兩個都擺成', () => {
    const run = toRun(placing(), 9, 9);
    expect(run.coll).toEqual([
      { dep: 9, owner: 0, round: 0 },
      { dep: 9, owner: 1, round: 0 },
    ]);
    expect(run.last?.voided).toEqual([false, false]);
  });

  it('10.（邊界）揭曉：只剩 1 個空位而兩邊同一輪都要 → 兩個要求都作廢（沒有採集器）；只有一邊要就擺成', () => {
    const half = placing({ coll: [{ dep: 9, owner: 0, round: 0 }], round: 1 });
    const clash = toRun(half, 9, 9);
    expect(clash.coll).toEqual([{ dep: 9, owner: 0, round: 0 }]);
    expect(clash.last?.voided).toEqual([true, true]);
    const alone = toRun(half, 8, 9);
    expect(alone.coll).toEqual([
      { dep: 9, owner: 0, round: 0 },
      { dep: 8, owner: 0, round: 1 },
      { dep: 9, owner: 1, round: 1 },
    ]);
    expect(alone.last?.voided).toEqual([false, false]);
  });

  it('11.（邊界）揭曉：礦脈已經有 2 個採集器（free = 0）→ 擺的人作廢，採集器不退還（不補回下一輪）', () => {
    const full = placing({
      round: 1,
      coll: [
        { dep: 9, owner: 0, round: 0 },
        { dep: 9, owner: 1, round: 0 },
      ],
    });
    const run = toRun(full, 9, 8);
    expect(run.last?.voided).toEqual([true, false]);
    expect(run.coll.filter((c) => c.round === 1)).toEqual([{ dep: 8, owner: 1, round: 1 }]);
  });

  it('12. 不擺（pass）：沒有採集器、沒有作廢；歷史記 -1', () => {
    const run = toRun(placing(), PASS, 9);
    expect(run.coll).toEqual([{ dep: 9, owner: 1, round: 0 }]);
    expect(run.last?.voided).toEqual([false, false]);
    const after = stepN(run, RUN_TICKS);
    expect(after.history[0]?.picks).toEqual([PASS, 9]);
    expect(after.history[0]?.ranks[0]).toBe(0);
  });

  /** 一個 run 階段的局面：只有索引 5 的礦脈有存量 `stock`，採集器用 `coll`；之後的輪數不擺。 */
  function drawing(stock: number, coll: D9State['coll'], round = 1): D9State {
    const stocks = Array.from({ length: DEPOSITS }, (_v, i) => (i === 5 ? stock : 0));
    return makeState({
      phase: 'run',
      wait: RUN_TICKS,
      round,
      rounds: round + 1,
      deposits: ringStocks(stocks),
      coll,
      pending: [null, null],
      last: {
        picks: [PASS, PASS],
        voided: [false, false],
        ranks: [0, 0],
        drawn0: [0, 0],
        stock0: stocks,
      },
    });
  }

  it('13. 抽取：每 DRAW_EVERY tick 一次，每個採集器抽 1 單位（存量夠就各得 1，存量減少）；一輪 8 次', () => {
    const s = drawing(20, [
      { dep: 5, owner: 0, round: 0 },
      { dep: 5, owner: 1, round: 1 },
    ]);
    const before = stepN(s, DRAW_EVERY - 1);
    expect(before.drawn).toEqual([0, 0]);
    const one = d9Game.step(before, both());
    expect(one.drawn).toEqual([1, 1]);
    expect(one.deposits[5]?.stock).toBe(18);
    expect(RUN_TICKS / DRAW_EVERY).toBe(8);
    const end = stepN(s, RUN_TICKS - 1);
    expect(end.drawn).toEqual([7, 7]);
    expect(end.phase).toBe('run');
  });

  it('14.（邊界）存量剛好 1：單獨一個採集器抽到 1、存量 0；之後不再抽、存量不會變負', () => {
    const s = drawing(1, [{ dep: 5, owner: 0, round: 0 }]);
    const t = stepN(s, DRAW_EVERY);
    expect(t.drawn).toEqual([1, 0]);
    expect(t.deposits[5]?.stock).toBe(0);
    const later = stepN(t, DRAW_EVERY * 3);
    expect(later.drawn).toEqual([1, 0]);
    expect(later.deposits[5]?.stock).toBe(0);
  });

  it('15.（邊界）存量不夠：同一輪擺的兩個，存量剩 1 → 兩個都沒抽到、存量清 0（餘下的 1 單位作廢）', () => {
    const s = drawing(3, [
      { dep: 5, owner: 0, round: 1 },
      { dep: 5, owner: 1, round: 1 },
    ]);
    const first = stepN(s, DRAW_EVERY);
    expect(first.drawn).toEqual([1, 1]);
    expect(first.deposits[5]?.stock).toBe(1);
    const second = stepN(first, DRAW_EVERY);
    expect(second.drawn).toEqual([1, 1]);
    expect(second.deposits[5]?.stock).toBe(0);
  });

  it('16.（邊界）存量不夠：不同輪擺的兩個，剩下的給比較早擺的；存量剛好 2 兩個各得 1', () => {
    const early = drawing(3, [
      { dep: 5, owner: 1, round: 0 },
      { dep: 5, owner: 0, round: 1 },
    ]);
    const t = stepN(early, DRAW_EVERY * 2);
    expect(t.drawn).toEqual([1, 2]);
    expect(t.deposits[5]?.stock).toBe(0);
    const exact = drawing(2, [
      { dep: 5, owner: 0, round: 0 },
      { dep: 5, owner: 1, round: 1 },
    ]);
    const u = stepN(exact, DRAW_EVERY);
    expect(u.drawn).toEqual([1, 1]);
    expect(u.deposits[5]?.stock).toBe(0);
  });

  it('17. 一輪跑完：歷史多一筆（picks、ranks、voided、gained），下一輪回到擺放：pending 清掉、游標保留、冷卻歸零', () => {
    const s = placing({ round: 0 });
    const after = playRound({ ...s, sel: [0, 0] }, 9, 8);
    expect(after.phase).toBe('place');
    expect(after.round).toBe(1);
    expect(after.pending).toEqual([null, null]);
    expect(after.idle).toBe(0);
    expect(after.jump).toEqual([0, 0]);
    expect(after.sel).toEqual([9, 8]);
    expect(after.history).toHaveLength(1);
    const h = after.history[0] as Round;
    expect(h.picks).toEqual([9, 8]);
    expect(h.ranks).toEqual([1, 2]);
    expect(h.voided).toEqual([false, false]);
    expect(h.gained).toEqual([8, 8]);
    expect(after.drawn).toEqual([8, 8]);
    expect(after.deposits[9]?.stock).toBe(12);
    expect(after.deposits[8]?.stock).toBe(8);
  });

  it('18. 名次：剩餘價值 ÷（1 + 已有採集器）排名，1 是最肥，同分索引小的在前；已經有採集器的礦脈價值減半', () => {
    const fresh = ranksOf(placing());
    expect(fresh[9]).toBe(1);
    expect(fresh[8]).toBe(2);
    expect(fresh[7]).toBe(3);
    expect(fresh[5]).toBe(4);
    expect(fresh[6]).toBe(5);
    expect(fresh[0]).toBe(10);
    // 索引 9 有一個採集器：20 ÷ 2 = 10，與索引 3、4 同分，排在它們後面。
    const half = ranksOf(placing({ round: 1, coll: [{ dep: 9, owner: 0, round: 0 }] }));
    expect(half[8]).toBe(1);
    expect(half[7]).toBe(2);
    expect(half[3]).toBe(5);
    expect(half[4]).toBe(6);
    expect(half[9]).toBe(7);
  });

  it('19. 打完最後一輪：進 end 等 END_TICKS 再結束；抽到多的贏；同分平手；結束後 step 原樣回傳', () => {
    const last = placing({ round: 7, rounds: 8, drawn: [10, 9] });
    const end = playRound(last, PASS, PASS);
    expect(end.phase).toBe('end');
    expect(end.over).toBe(false);
    expect(d9Game.winner(end)).toBeNull();
    const over = stepN(end, END_TICKS);
    expect(over.over).toBe(true);
    expect(d9Game.isOver(over)).toBe(true);
    expect(d9Game.winner(over)).toBe(0);
    expect(d9Game.score(over)).toEqual([10, 9]);
    expect(d9Game.step(over, both())).toBe(over);
    const tie = stepN(
      playRound(placing({ round: 7, rounds: 8, drawn: [5, 5] }), PASS, PASS),
      END_TICKS,
    );
    expect(d9Game.winner(tie)).toBeNull();
  });

  it('20.（邊界）時間到（第 maxTicks 個 tick）：立刻結束，抽到多的贏（沒跑完的輪不補）', () => {
    const s = placing({ maxTicks: 100, tick: 99, drawn: [3, 4] });
    const e = d9Game.step(s, both(KEY_LOCK, IDLE));
    expect(e.over).toBe(true);
    expect(e.winner).toBe(1);
    expect(d9Game.score(e)).toEqual([3, 4]);
  });

  it('21. 時間表：誰都不按，一局 PREP + R × (PLACE_TIMEOUT + LOCK + RUN) + END tick，不超過 3600；每輪最快就鎖定的一局不少於 30 秒', () => {
    const R = d9Game.init(0, CONFIG).rounds;
    const slowest = PREP_TICKS + R * (PLACE_TIMEOUT + LOCK_TICKS + RUN_TICKS) + END_TICKS;
    expect(slowest).toBeLessThanOrEqual(3600);
    let s = d9Game.init(0, CONFIG);
    let ticks = 0;
    while (!d9Game.isOver(s)) {
      s = d9Game.step(s, both());
      ticks += 1;
    }
    expect(ticks).toBe(slowest);
    // 每輪一進入擺放就按 b：每輪 1 + LOCK + RUN。
    let f = d9Game.init(0, CONFIG);
    let fast = 0;
    while (!d9Game.isOver(f)) {
      f = d9Game.step(f, both(KEY_PASS, KEY_PASS));
      fast += 1;
    }
    expect(fast).toBe(PREP_TICKS + R * (1 + LOCK_TICKS + RUN_TICKS) + END_TICKS);
    expect(fast / 60).toBeGreaterThanOrEqual(30);
  });

  it('22. 輪數 5 與 8 都跑得完：5 輪的歷史 5 筆、8 輪 8 筆；整場 JSON 來回不變', () => {
    for (const rounds of [5, 8]) {
      let s = d9Game.init(2, { maxTicks: 3600, params: { rounds } });
      expect(s.rounds).toBe(rounds);
      while (!d9Game.isOver(s)) {
        s = d9Game.step(s, both(KEY_PASS, KEY_PASS));
      }
      expect(s.history).toHaveLength(rounds);
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    }
  });

  it('23. step 不改動傳進來的 state 與輸入（深度凍結也不丟錯），各階段都一樣', () => {
    const states = [
      makeState(),
      placing({ sel: [4, 2] }),
      lockBoth(placing(), 9, 8),
      toRun(placing(), 9, 8),
      stepN(toRun(placing(), 9, 8), RUN_TICKS - 1),
      playRound(placing({ round: 7, rounds: 8 }), 9, 8),
    ];
    for (const s of states) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(s)) as D9State);
      const inputs = deepFreeze(both(KEY_LOCK, KEY_RIGHT));
      expect(() => d9Game.step(frozen, inputs)).not.toThrow();
    }
  });

  it('24. 抽取的閉式解 projectDraws 與 step 實際跑的一樣（各種存量、採集器組合、輪數）', () => {
    const colls: D9State['coll'][] = [
      [{ dep: 5, owner: 0, round: 0 }],
      [
        { dep: 5, owner: 0, round: 0 },
        { dep: 5, owner: 1, round: 0 },
      ],
      [
        { dep: 5, owner: 1, round: 0 },
        { dep: 5, owner: 0, round: 1 },
      ],
      [
        { dep: 5, owner: 0, round: 0 },
        { dep: 5, owner: 0, round: 1 },
      ],
    ];
    for (const stock of [0, 1, 2, 3, 5, 6, 7, 11, 16, 20, 40]) {
      for (const coll of colls) {
        for (const left of [1, 2, 4]) {
          // 現在是第 `round` 輪（0 起算），共 round + left 輪：還剩 left 輪的抽取機會。
          const round = 1;
          const s = { ...drawing(stock, coll, round), rounds: round + left };
          let x = s;
          let guard = 0;
          while (!x.over && (x.round < s.rounds || x.phase === 'run') && guard < 100000) {
            x = d9Game.step(x, both(KEY_PASS, KEY_PASS));
            guard += 1;
            if (x.phase === 'end') {
              break;
            }
          }
          const expected = projectDraws(
            stock,
            coll.map((c) => ({ owner: c.owner, round: c.round })),
            (RUN_TICKS / DRAW_EVERY) * left,
          );
          expect(
            [x.drawn[0], x.drawn[1]],
            `stock ${stock} left ${left} ${JSON.stringify(coll)}`,
          ).toEqual(expected);
        }
      }
    }
  });
});

describe('D-9 擺放｜actions', () => {
  it('擺放而且還沒鎖定：[不擺, 全放開, 左, 右, 擺下]，不擺排第一；其他階段與鎖定之後只有 [全放開]', () => {
    const s = placing();
    const acts = d9Game.actions(s, 1);
    const expected = [KEY_PASS, IDLE, KEY_LEFT, KEY_RIGHT, KEY_LOCK];
    expect(acts).toHaveLength(expected.length);
    expected.forEach((e, i) => expect(sameButtons(acts[i] as Buttons, e)).toBe(true));
    const locked = d9Game.step(s, both(KEY_LOCK, IDLE));
    expect(d9Game.actions(locked, 0)).toEqual([IDLE]);
    expect(d9Game.actions(locked, 1)).toHaveLength(5);
    expect(d9Game.actions(makeState(), 0)).toEqual([IDLE]);
    expect(d9Game.actions(toRun(s, 9, 8), 1)).toEqual([IDLE]);
  });

  it('actions()[0] 會推進結算（10.6 陷阱二）：兩邊都只做第一個動作，一個 tick 後進 locked、3 個 tick 後進 run', () => {
    const s = placing();
    const first0 = d9Game.actions(s, 0)[0] as Buttons;
    const first1 = d9Game.actions(s, 1)[0] as Buttons;
    expect(sameButtons(first0, IDLE)).toBe(false);
    const locked = d9Game.step(s, [first0, first1]);
    expect(locked.phase).toBe('locked');
    expect(stepN(locked, LOCK_TICKS).phase).toBe('run');
  });

  it('搜尋型深度 ≥ 3 真的走得到揭曉（10.6 陷阱一）：從擺放出發（游標在最肥的礦脈，擺下去是好選擇），depth 6 的前瞻評價過 run 階段的 state；depth 2 沒有', () => {
    const seen = (depth: number): Set<string> => {
      const phases = new Set<string>();
      const spy: Game<D9State> = {
        ...d9Game,
        evaluate(s: D9State, side: Side) {
          phases.add(s.phase);
          return d9Game.evaluate(s, side);
        },
      };
      wrapPolicy(
        spy,
        pathfinder,
        { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
        1,
      ).decide(placing({ sel: [9, 9] }), 1, 0);
      return phases;
    };
    expect(seen(6).has('run')).toBe(true);
    expect(seen(3).has('run')).toBe(true);
    expect(seen(2).has('run')).toBe(false);
    expect(seen(1).has('run')).toBe(false);
  });
});

describe('D-9 擺放｜predictOpponent（只讀公開紀錄）', () => {
  const hist = (rank: number, n: number): D9State['history'] =>
    Array.from({ length: n }, () => ({
      picks: [rank === 0 ? PASS : 9, rank === 0 ? PASS : 9] as [number, number],
      ranks: [rank, rank] as [number, number],
      voided: [false, false] as [boolean, boolean],
      gained: [0, 0] as [number, number],
    }));

  it('回傳每個礦脈被對手選中的機率：長度 DEPOSITS、沒有負的、總和是 1（還有可選的礦脈時）；不改動傳進來的歷史', () => {
    const s = deepFreeze(placing({ round: 3, history: hist(1, 3) }));
    for (const side of [0, 1] as const) {
      const p = predictOpponent(s.history, s, side);
      expect(p).toHaveLength(DEPOSITS);
      expect(p.every((v) => v >= 0)).toBe(true);
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
  });

  it('沒有歷史（冷啟動）：機率集中在最肥與第二肥，但最肥不超過 0.6；從兩個座位看都一樣', () => {
    const s = placing();
    for (const side of [0, 1] as const) {
      const p = predictOpponent([], s, side);
      expect(p[9]).toBeGreaterThan(p[8] as number);
      expect(p[8]).toBeGreaterThan(p[7] as number);
      expect(p[9]).toBeLessThan(0.6);
      expect(p[9]).toBeGreaterThan(0.4);
    }
  });

  it('對手連續 3 輪選名次 1 → 機率集中在現在名次 1 的礦脈（超過 0.75）；對手連續選名次 2 → 集中在名次 2', () => {
    const s = placing({ round: 3 });
    const one = predictOpponent(hist(1, 3), s, 1);
    expect(one[9]).toBeGreaterThan(0.75);
    const two = predictOpponent(hist(2, 3), s, 1);
    expect(two[8]).toBeGreaterThan(0.6);
    expect(two[8]).toBeGreaterThan(two[9] as number);
  });

  it('只看最近 WINDOW 輪；早於窗口的紀錄不影響預測', () => {
    const s = placing({ round: 9, rounds: 12 });
    const recent = hist(1, WINDOW);
    const old = [...hist(2, 6), ...recent];
    expect(predictOpponent(old, s, 1)).toEqual(predictOpponent(recent, s, 1));
  });

  it('已經滿了（2 個採集器）或存量 0 的礦脈，機率是 0（對手擺了也作廢）；名次只在還能擺的礦脈裡排', () => {
    const s = placing({
      round: 2,
      coll: [
        { dep: 9, owner: 0, round: 0 },
        { dep: 9, owner: 1, round: 1 },
      ],
      deposits: ringStocks([6, 8, 8, 10, 10, 12, 12, 14, 16, 0]),
    });
    const p = predictOpponent([], s, 1);
    expect(p[9]).toBe(0);
    expect(p[8]).toBeGreaterThan(p[7] as number);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('model = false（消融）：歷史不看，機率等於沒有歷史時的先驗', () => {
    const s = placing({ round: 3, model: false });
    expect(predictOpponent(hist(1, 3), s, 1)).toEqual(
      predictOpponent([], { ...s, model: true }, 1),
    );
  });
});

describe('D-9 擺放｜evaluate 與不偷看（4.2）', () => {
  const rich = (extra: Partial<D9State> = {}): D9State =>
    placing({
      round: 3,
      coll: [
        { dep: 9, owner: 0, round: 0 },
        { dep: 8, owner: 1, round: 0 },
        { dep: 7, owner: 0, round: 1 },
      ],
      drawn: [14, 10],
      history: [
        { picks: [9, 8], ranks: [1, 2], voided: [false, false], gained: [8, 8] },
        { picks: [8, 7], ranks: [1, 2], voided: [false, false], gained: [8, 8] },
        { picks: [7, 5], ranks: [1, 2], voided: [false, false], gained: [6, 6] },
      ],
      ...extra,
    });
  const oppPicks: readonly (number | null)[] = [null, PASS, 0, 3, 5, 9];
  const oppSels = [0, 2, 5, 8, 9];

  it('evaluate：各階段 gain 有限、danger 在 0 到 1；結束的局有勝負加成', () => {
    const s = rich();
    const states: D9State[] = [
      makeState(),
      s,
      d9Game.step(s, both(KEY_LOCK, KEY_PASS)),
      toRun(s, 5, 6),
      stepN(toRun(s, 5, 6), 100),
      stepN(playRound(placing({ round: 7, rounds: 8, drawn: [10, 9] }), PASS, PASS), END_TICKS),
    ];
    for (const x of states) {
      for (const side of [0, 1] as const) {
        const e = d9Game.evaluate(x, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBeGreaterThanOrEqual(0);
        expect(e.danger).toBeLessThanOrEqual(1);
      }
    }
    const end = states[5] as D9State;
    expect(d9Game.evaluate(end, 0).gain).toBeGreaterThan(500);
    expect(d9Game.evaluate(end, 1).gain).toBeLessThan(-500);
  });

  it('evaluate 對稱、不是橡皮筋：對調兩邊的採集器、分數、鎖定與歷史，AI 側的評價一樣', () => {
    const swapRound = (h: Round): Round => ({
      picks: [h.picks[1], h.picks[0]],
      ranks: [h.ranks[1], h.ranks[0]],
      voided: [h.voided[1], h.voided[0]],
      gained: [h.gained[1], h.gained[0]],
    });
    const a = rich({ sel: [2, 6], pending: [null, 5] });
    const b: D9State = {
      ...a,
      coll: a.coll.map((c) => ({ ...c, owner: c.owner === 0 ? 1 : 0 })),
      drawn: [a.drawn[1], a.drawn[0]],
      history: a.history.map(swapRound),
      sel: [a.sel[1], a.sel[0]],
      pending: [a.pending[1], a.pending[0]],
      jump: [a.jump[1], a.jump[0]],
      dir: [a.dir[1], a.dir[0]],
    };
    expect(d9Game.evaluate(a, 1)).toEqual(d9Game.evaluate(b, 0));
    expect(d9Game.evaluate(a, 0)).toEqual(d9Game.evaluate(b, 1));
  });

  it('不偷看（擺放、locked）：只有對手的 sel、pending、跳的冷卻不同的 state，AI 側的 evaluate 與 actions 完全相同（兩邊都成立）', () => {
    for (const me of [0, 1] as const) {
      const opp = me === 0 ? 1 : 0;
      const make = (pick: number | null, sel: number, mine: number | null): D9State => {
        const pending: [number | null, number | null] = [null, null];
        pending[me] = mine;
        pending[opp] = pick;
        const selv: [number, number] = [0, 0];
        selv[opp] = sel;
        selv[me] = 3;
        const phase = pending[0] !== null && pending[1] !== null ? 'locked' : 'place';
        return rich({ pending, sel: selv, phase, wait: phase === 'locked' ? LOCK_TICKS : 0 });
      };
      for (const mine of [null, 3]) {
        const group: D9State[] = [];
        for (const pick of oppPicks) {
          for (const sel of oppSels) {
            group.push(make(pick, sel, mine));
          }
        }
        for (const other of group) {
          expect(d9Game.evaluate(other, me)).toEqual(d9Game.evaluate(group[0] as D9State, me));
          expect(d9Game.actions(other, me)).toEqual(d9Game.actions(group[0] as D9State, me));
        }
      }
    }
  });

  it('不偷看（揭曉之後）：只有對手這一輪鎖定的礦脈不同的 run state，evaluate 相同（模擬走得到揭曉，這裡要目盲）', () => {
    for (const me of [0, 1] as const) {
      const opp = me === 0 ? 1 : 0;
      const runs = [PASS, 0, 3, 5, 8, 9].map((pick) => {
        const picks: [number, number] = [4, 4];
        picks[opp] = pick;
        picks[me] = 6;
        return toRun(rich(), picks[0], picks[1]);
      });
      expect(new Set(runs.map((s) => JSON.stringify(s.coll))).size).toBeGreaterThan(2);
      for (const other of runs) {
        expect(d9Game.evaluate(other, me)).toEqual(d9Game.evaluate(runs[0] as D9State, me));
      }
    }
  });

  it('不偷看（整個決定）：四個性格、深度 1、3、6，在只有對手 sel／pending 不同的擺放局面，按的鍵相同；兩邊都成立', () => {
    for (const name of ['pathfinder', 'precise', 'greedy', 'gambler'] as const) {
      for (const depth of [1, 3, 6]) {
        for (const me of [0, 1] as const) {
          const opp = me === 0 ? 1 : 0;
          const presses: Buttons[] = [];
          for (const pick of oppPicks) {
            for (const sel of [0, 5, 9]) {
              const pending: [number | null, number | null] = [null, null];
              pending[opp] = pick;
              const selv: [number, number] = [2, 2];
              selv[opp] = sel;
              const c = wrapPolicy(
                d9Game,
                policyByName(name),
                { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
                7,
              );
              presses.push(c.decide(rich({ pending, sel: selv }), me, 0));
            }
          }
          for (const press of presses) {
            expect(press, `${name} 深度 ${depth} 座位 ${me}`).toEqual(presses[0]);
          }
        }
      }
    }
  });

  /**
   * 故意注入洩漏：確認「不偷看」的檢查抓得到。洩漏版 evaluate／actions 讀對手的 sel、pending，
   * 檢查函式（同上面的比對）必須回報不相同。
   */
  function leaks(game: Game<D9State>): boolean {
    const base = rich();
    const variants: D9State[] = [];
    for (const pick of [null, 0, 9]) {
      for (const sel of [0, 9]) {
        variants.push({ ...base, pending: [null, pick], sel: [2, sel] });
      }
    }
    return variants.some(
      (v) =>
        JSON.stringify(game.evaluate(v, 0)) !==
          JSON.stringify(game.evaluate(variants[0] as D9State, 0)) ||
        JSON.stringify(game.actions(v, 0)) !==
          JSON.stringify(game.actions(variants[0] as D9State, 0)),
    );
  }

  it('故意注入洩漏會紅：真的遊戲不洩漏；evaluate 讀 sel[對手]、evaluate 讀 pending[對手]、actions 讀 pending[對手] 各一次都被抓到', () => {
    expect(leaks(d9Game)).toBe(false);
    const readsSel: Game<D9State> = {
      ...d9Game,
      evaluate: (s, side) => {
        const e = d9Game.evaluate(s, side);
        return { gain: e.gain + (s.sel[side === 0 ? 1 : 0] as number) * 0.01, danger: e.danger };
      },
    };
    const readsPending: Game<D9State> = {
      ...d9Game,
      evaluate: (s, side) => {
        const e = d9Game.evaluate(s, side);
        const p = s.pending[side === 0 ? 1 : 0];
        return { gain: e.gain + (p === null ? 0 : 1), danger: e.danger };
      },
    };
    const actionsRead: Game<D9State> = {
      ...d9Game,
      actions: (s, side) =>
        s.pending[side === 0 ? 1 : 0] === 9 ? [IDLE] : d9Game.actions(s, side),
    };
    expect(leaks(readsSel)).toBe(true);
    expect(leaks(readsPending)).toBe(true);
    expect(leaks(actionsRead)).toBe(true);
  });
});

describe('D-9 擺放｜AI 的選擇（用真的控制器：等級 10 的設定、沒有延遲、沒有失誤）', () => {
  /** AI（`side`）在這個局面會鎖定哪個礦脈（-1 是不擺）；對手不動。 */
  function chosen(
    state: D9State,
    side: Side = 1,
    name: 'pathfinder' | 'precise' | 'greedy' | 'gambler' = 'precise',
    depth = 1,
  ): number {
    const c = wrapPolicy(
      d9Game,
      policyByName(name),
      { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
      7,
    );
    let s = state;
    for (let t = 0; t < PLACE_TIMEOUT && s.phase === 'place'; t += 1) {
      const key = c.decide(s, side, t);
      s = d9Game.step(s, side === 1 ? [IDLE, key] : [key, IDLE]);
      const p = s.pending[side];
      if (p !== null) {
        return p;
      }
    }
    return PASS;
  }
  const opp1 = (n: number): D9State['history'] =>
    Array.from({ length: n }, () => ({
      picks: [9, 8] as [number, number],
      ranks: [1, 2] as [number, number],
      voided: [false, false] as [boolean, boolean],
      gained: [8, 8] as [number, number],
    }));

  it('冷啟動：沒有歷史時，AI 會擺（不是不擺），而且擺在最肥的兩三個之一', () => {
    for (const start of [0, 3, 6, 9]) {
      const pick = chosen(placing({ sel: [start, start] }));
      expect([9, 8, 7]).toContain(pick);
    }
  });

  it('不管游標從哪裡開始，AI 選的礦脈一樣（游標只是手段，決定來自評價）', () => {
    const picks = [0, 1, 4, 5, 8, 9].map((start) => chosen(placing({ sel: [start, start] })));
    expect(new Set(picks).size).toBe(1);
  });

  it('歷史改變選擇（小規格原文的 zs = 0，只算自己的期望收成）：對手連 3 輪選名次 1，AI 不再跟它搶名次 1，改選名次 2；沒有歷史時選名次 1', () => {
    const base = placing({ round: 3, zs: 0 });
    expect(chosen({ ...base, history: [] })).toBe(9);
    const read = chosen({ ...base, history: opp1(3) });
    expect(read).toBe(8);
    // 消融：model = false 就不看歷史，選擇與沒有歷史時相同。
    expect(chosen({ ...base, history: opp1(3), model: false })).toBe(9);
  });

  it('預設（zs = 1，算兩邊的差）：不被歷史帶偏——對手連 3 輪選名次 1、連 3 輪選名次 2、沒有歷史，AI 都選最肥的（跟它分，兩邊都少一半，不吃虧；躲開它才是讓它獨吞最肥的）', () => {
    const base = placing({ round: 3 });
    expect(base.zs).toBe(1);
    expect(chosen({ ...base, history: [] })).toBe(9);
    expect(chosen({ ...base, history: opp1(3) })).toBe(9);
    const two = opp1(3).map((h) => ({ ...h, ranks: [2, 2] as [number, number] }));
    expect(chosen({ ...base, history: two })).toBe(9);
  });

  it('danger 是「落空」的機率：空位還有 2 個的礦脈 danger 是 0（跟它分不算危險）；只剩 1 個空位的礦脈 danger 等於對手也挑它的機率；滿了或沒存量是 1', () => {
    const s = placing({
      round: 2,
      coll: [{ dep: 9, owner: 0, round: 0 }],
      deposits: ringStocks([6, 8, 8, 10, 10, 12, 12, 14, 16, 20]),
      history: opp1(2).map((h) => ({ ...h, ranks: [5, 5] as [number, number] })),
    });
    const dangerOf = (dep: number): number =>
      d9Game.evaluate(d9Game.step({ ...s, sel: [0, dep] }, both(IDLE, KEY_LOCK)), 1).danger;
    const q = predictOpponent(s.history, s, 1);
    expect(dangerOf(8)).toBe(0);
    expect(dangerOf(9)).toBeCloseTo(q[9] as number, 12);
    const gone = { ...s, deposits: ringStocks([6, 8, 8, 10, 10, 12, 12, 14, 0, 20]) };
    expect(
      d9Game.evaluate(d9Game.step({ ...gone, sel: [0, 8] }, both(IDLE, KEY_LOCK)), 1).danger,
    ).toBe(1);
  });

  it('不選已經滿了的礦脈，也不選存量 0 的；全部都沒價值就不擺', () => {
    const full = placing({
      round: 2,
      coll: [
        { dep: 9, owner: 0, round: 0 },
        { dep: 9, owner: 1, round: 1 },
      ],
    });
    expect(chosen(full)).not.toBe(9);
    expect(chosen(full)).not.toBe(PASS);
    const empty = placing({ deposits: ringStocks(new Array<number>(DEPOSITS).fill(0)) });
    expect(chosen(empty)).toBe(PASS);
  });

  it('只剩最後一輪：存量夠大（≥ 16，兩個人分也抽得滿 8 次）的礦脈比小的好，AI 選存量夠大又不會作廢的', () => {
    const s = placing({ round: 7, rounds: 8 });
    expect([9, 8]).toContain(chosen(s));
  });

  it('游標已經在最好的礦脈上就擺下（不閒晃）；游標在隔壁就先跳過去再擺', () => {
    const s = placing({ history: [] });
    const press = (sel: number): Buttons =>
      wrapPolicy(
        d9Game,
        policyByName('precise'),
        { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0 },
        7,
      ).decide({ ...s, sel: [sel, sel] }, 1, 0);
    expect(sameButtons(press(9), KEY_LOCK)).toBe(true);
    expect(sameButtons(press(8), KEY_RIGHT)).toBe(true);
    expect(sameButtons(press(0), KEY_LEFT)).toBe(true);
  });

  it('跟全 AI 對手的對局：兩個等級 5 的搜尋型、亂按的控制器都打得完一整場，在 maxTicks 之前結束', () => {
    const a = levelController(d9Game, pathfinder, 5, 1);
    const b = levelController(d9Game, pathfinder, 5, 2);
    const r = playMatch(d9Game, 3, CONFIG, a, b);
    expect(r.ticks).toBeLessThanOrEqual(3600);
    const x = levelController(d9Game, random, 10, 5);
    const y = levelController(d9Game, random, 10, 6);
    expect(playMatch(d9Game, 4, CONFIG, x, y).ticks).toBeLessThanOrEqual(3600);
  });
});

describe('D-9 擺放｜四個性格的機制（10.48：測機制，不測症狀）', () => {
  /** 隨機打到的擺放局面（AI 是 1 號邊、還沒鎖定、這輪剛開始）。 */
  function sampleStates(count: number): D9State[] {
    const out: D9State[] = [];
    for (let seed = 0; out.length < count && seed < 40; seed += 1) {
      const a = levelController(d9Game, random, 10, seed);
      const b = levelController(d9Game, pathfinder, 10, seed + 99);
      const tap = {
        decide(s: D9State, side: Side, tick: number): Buttons {
          if (side === 1 && s.phase === 'place' && s.idle === 0 && s.round >= 1) {
            out.push(s);
          }
          return b.decide(s, side, tick);
        },
      };
      playMatch(d9Game, seed, CONFIG, a, tap);
    }
    return out.slice(0, count);
  }
  const states = sampleStates(40);
  /** 一步看的 (gain, danger)：和三個一步看的性格看到的一樣（對手做 actions()[0]）。 */
  function oneStep(s: D9State, action: Buttons): { gain: number; danger: number } {
    const theirs = d9Game.actions(s, 0)[0] as Buttons;
    return d9Game.evaluate(d9Game.step(s, [theirs, action]), 1);
  }
  const decide = (s: D9State, name: 'greedy' | 'precise'): Buttons =>
    wrapPolicy(
      d9Game,
      policyByName(name),
      { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0 },
      7,
    ).decide(s, 1, 0);
  const index = (s: D9State, b: Buttons): number =>
    d9Game.actions(s, 1).findIndex((a) => sameButtons(a, b));

  it('取到足夠多的局面，而且有採集器已經佔位的局面不少（否則下面的機制測試是空的）', () => {
    expect(states.length).toBeGreaterThanOrEqual(30);
    expect(states.filter((s) => s.coll.length >= 4).length).toBeGreaterThan(10);
  });

  it('貪心型：一步看 gain 最高的，完全不看 danger', () => {
    for (const s of states) {
      const gains = d9Game.actions(s, 1).map((a) => oneStep(s, a).gain);
      expect(gains[index(s, decide(s, 'greedy'))]).toBeCloseTo(Math.max(...gains), 9);
    }
  });

  it('精準型：先排除 danger 超過 0.3 的動作，剩下選 gain 最高的', () => {
    for (const s of states) {
      const scored = d9Game.actions(s, 1).map((a) => oneStep(s, a));
      const safe = scored.filter((x) => x.danger <= 0.3);
      const chosenScore = scored[index(s, decide(s, 'precise'))] as {
        gain: number;
        danger: number;
      };
      if (safe.length > 0) {
        expect(chosenScore.danger).toBeLessThanOrEqual(0.3);
        expect(chosenScore.gain).toBeCloseTo(Math.max(...safe.map((x) => x.gain)), 9);
      }
    }
  });

  it('擺下去（pending 設了）的評價不隨游標的位置變：評價看的是「擺在哪」，不是「游標現在在哪」；不擺的 danger 是 0', () => {
    const s = placing({ round: 2, history: opp1Hist() });
    const a = d9Game.step({ ...s, sel: [0, 4] }, both(IDLE, KEY_LOCK));
    expect(a.pending[1]).toBe(4);
    const b: D9State = { ...a, sel: [0, 9] };
    expect(d9Game.evaluate(a, 1)).toEqual(d9Game.evaluate(b, 1));
    const c = d9Game.step({ ...s, sel: [0, 4] }, both(IDLE, KEY_PASS));
    expect(d9Game.evaluate(c, 1).danger).toBe(0);
  });

  function opp1Hist(): D9State['history'] {
    return Array.from({ length: 2 }, () => ({
      picks: [9, 8] as [number, number],
      ranks: [1, 2] as [number, number],
      voided: [false, false] as [boolean, boolean],
      gained: [8, 8] as [number, number],
    }));
  }
});

// ---------------------------------------------------------------------------
// 獨佔規則（小規格十：config.params.cap、config.params.contest；預設值 = 舊規則）
// ---------------------------------------------------------------------------

describe('D-9 擺放｜獨佔規則 cap／contest', () => {
  const cfg = (params: Record<string, number>) => ({ maxTicks: 3600, params });

  it('E1. 參數：預設 cap = 2、contest = 0；params 給 1 就是 1；其他值夾回 1 到 2 與 0 到 1', () => {
    const d = d9Game.init(0, CONFIG);
    expect([d.cap, d.contest]).toEqual([2, 0]);
    const e = d9Game.init(0, cfg({ cap: 1, contest: 1 }));
    expect([e.cap, e.contest]).toEqual([1, 1]);
    const big = d9Game.init(0, cfg({ cap: 9, contest: 7 }));
    expect([big.cap, big.contest]).toEqual([2, 1]);
    const small = d9Game.init(0, cfg({ cap: 0, contest: -3 }));
    expect([small.cap, small.contest]).toEqual([1, 0]);
    expect([makeState().cap, makeState().contest]).toEqual([2, 0]);
  });

  it('E2. cap = 1：礦脈已有 1 個採集器（free = 0），再擺的人作廢；空的礦脈單獨擺成', () => {
    const held = placing({ cap: 1, round: 1, coll: [{ dep: 9, owner: 0, round: 0 }] });
    const run = toRun(held, 9, 8);
    expect(run.last?.voided).toEqual([true, false]);
    expect(run.coll.filter((c) => c.round === 1)).toEqual([{ dep: 8, owner: 1, round: 1 }]);
  });

  it('E3.（邊界）cap = 1、contest = 0：同一輪兩邊挑同一個空礦脈 → 兩邊都作廢、沒有採集器；只有一邊挑就擺成；cap = 2 同樣的挑法兩個都擺成（舊規則不變）', () => {
    const clash = toRun(placing({ cap: 1 }), 9, 9);
    expect(clash.coll).toEqual([]);
    expect(clash.last?.voided).toEqual([true, true]);
    const alone = toRun(placing({ cap: 1 }), 9, 8);
    expect(alone.coll).toEqual([
      { dep: 9, owner: 0, round: 0 },
      { dep: 8, owner: 1, round: 0 },
    ]);
    const old = toRun(placing({ cap: 2 }), 9, 9);
    expect(old.coll).toHaveLength(2);
    expect(old.last?.voided).toEqual([false, false]);
  });

  it('E4. cap = 1、contest = 1：搶同一個礦脈時，第 r 輪優先權在 r % 2 號邊——那一邊拿到、另一邊作廢；挑不同的礦脈兩邊都擺成', () => {
    const r0 = toRun(placing({ cap: 1, contest: 1, round: 0 }), 9, 9);
    expect(r0.coll).toEqual([{ dep: 9, owner: 0, round: 0 }]);
    expect(r0.last?.voided).toEqual([false, true]);
    const r1 = toRun(placing({ cap: 1, contest: 1, round: 1 }), 9, 9);
    expect(r1.coll).toEqual([{ dep: 9, owner: 1, round: 1 }]);
    expect(r1.last?.voided).toEqual([true, false]);
    const r2 = toRun(placing({ cap: 1, contest: 1, round: 2 }), 9, 9);
    expect(r2.last?.voided).toEqual([false, true]);
    const apart = toRun(placing({ cap: 1, contest: 1, round: 0 }), 9, 8);
    expect(apart.last?.voided).toEqual([false, false]);
    expect(apart.coll).toHaveLength(2);
  });

  it('E5. 優先權只管「搶同一個」：礦脈已被占（free = 0）時，優先權的一邊也作廢', () => {
    const held = placing({
      cap: 1,
      contest: 1,
      round: 2,
      coll: [{ dep: 9, owner: 1, round: 0 }],
    });
    const run = toRun(held, 9, 9);
    expect(run.last?.voided).toEqual([true, true]);
    expect(run.coll).toHaveLength(1);
  });

  it('E6. cap = 1 的抽取：一個採集器獨吞，存量夠就每次 1 單位、一輪 8 次；整場 JSON 來回不變、打得完', () => {
    const run = toRun(placing({ cap: 1 }), 9, PASS);
    const done = stepN(run, RUN_TICKS);
    expect(done.drawn).toEqual([8, 0]);
    expect(done.deposits[9]?.stock).toBe(12);
    const s = d9Game.init(3, cfg({ cap: 1 }));
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const a = levelController(d9Game, pathfinder, 5, 1);
    const b = levelController(d9Game, pathfinder, 5, 2);
    const m = playMatch(d9Game, 3, cfg({ cap: 1 }), a, b);
    expect(m.ticks).toBeLessThanOrEqual(3600);
  });

  it('E7. 名次：cap = 1 時有 1 個採集器的礦脈就不能擺，排在能擺的後面；cap = 2 仍然能擺', () => {
    const coll = [{ dep: 9, owner: 0 as const, round: 0 }];
    const one = ranksOf(placing({ cap: 1, round: 1, coll }));
    expect(one[9]).toBe(DEPOSITS); // 不能擺的排最後（唯一一個）
    expect(one[8]).toBe(1); // 剩下最肥的
    const two = ranksOf(placing({ cap: 2, round: 1, coll }));
    expect(two[9]).toBeLessThan(DEPOSITS);
  });

  it('E8. predictOpponent：cap = 1 時被占的礦脈機率是 0，其餘總和是 1', () => {
    const s = placing({ cap: 1, round: 1, coll: [{ dep: 9, owner: 0, round: 0 }] });
    const q = predictOpponent(s.history, s, 0);
    expect(q[9]).toBe(0);
    expect(q.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
  });

  it('E9. danger：cap = 1 時每個還能擺的礦脈都是「搶了會雙雙落空」，danger 等於對手也挑它的機率（不是 0）；contest = 1 時有優先權的一邊是 0、沒有的一邊仍是機率', () => {
    const s = placing({ cap: 1, sel: [9, 9] });
    const q = predictOpponent(s.history, s, 0);
    const locked = d9Game.step(s, both(KEY_LOCK, IDLE));
    expect(q[9]).toBeGreaterThan(0.3);
    expect(d9Game.evaluate(locked, 0).danger).toBeCloseTo(q[9] as number, 9);
    // 優先權：第 0 輪在 0 號邊
    const pr = placing({ cap: 1, contest: 1, sel: [9, 9] });
    const l0 = d9Game.step(pr, both(KEY_LOCK, KEY_LOCK));
    expect(d9Game.evaluate(l0, 0).danger).toBe(0);
    expect(d9Game.evaluate(l0, 1).danger).toBeGreaterThan(0.3);
  });

  it('E10. 獨佔規則下仍然不偷看：只有對手 sel／pending 不同的 state，evaluate 與 actions 相同（兩邊、cap = 1 與 contest = 1 都測）', () => {
    for (const extra of [{ cap: 1 }, { cap: 1, contest: 1 }] as const) {
      for (const side of [0, 1] as const) {
        const opp = side === 0 ? 1 : 0;
        const a = placing({ ...extra, sel: [3, 3], round: 1, coll: [{ dep: 9, owner: 0, round: 0 }] });
        const p1 = [a.pending[0], a.pending[1]] as [number | null, number | null];
        const p2 = [a.pending[0], a.pending[1]] as [number | null, number | null];
        p1[opp] = 8;
        p2[opp] = 2;
        const sel2 = [a.sel[0], a.sel[1]] as [number, number];
        sel2[opp] = 5;
        const x: D9State = { ...a, pending: p1 };
        const y: D9State = { ...a, pending: p2, sel: sel2 };
        expect(d9Game.evaluate(x, side)).toEqual(d9Game.evaluate(y, side));
        expect(d9Game.actions(x, side)).toEqual(d9Game.actions(y, side));
      }
    }
  });

  it('E11. 預設不變：不傳 cap／contest 與傳 cap = 2、contest = 0 的整場結果逐位元相同', () => {
    for (const seed of [0, 1, 2]) {
      const run = (params: Record<string, number>) => {
        const a = levelController(d9Game, pathfinder, 6, seed + 11);
        const b = levelController(d9Game, pathfinder, 4, seed + 13);
        return playMatch(d9Game, seed, cfg(params), a, b);
      };
      const base = run({});
      const explicit = run({ cap: 2, contest: 0 });
      expect(explicit.finalHash).toBe(base.finalHash);
      expect(explicit.score).toEqual(base.score);
    }
  });
});
