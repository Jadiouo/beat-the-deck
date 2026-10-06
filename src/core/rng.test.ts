import { describe, expect, it } from 'vitest';

import { hashState } from './hash';
import { createRng, intFrom, nextFrom, rngStateFor, type RngState } from './rng';

function take(count: number, next: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(next());
  }
  return out;
}

describe('core/rng（TEST_PLAN 3.1）', () => {
  it('同一個種子，前 1000 個 next() 完全相同', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    expect(take(1000, () => a.next())).toEqual(take(1000, () => b.next()));
  });

  it('不同種子（0 與 1），前 10 個值不全相同', () => {
    const a = createRng(0);
    const b = createRng(1);
    expect(take(10, () => a.next())).not.toEqual(take(10, () => b.next()));
  });

  it('next() 的值都在 [0, 1)，10 萬個樣本平均在 0.49 到 0.51 之間', () => {
    const rng = createRng(2024);
    let sum = 0;
    for (let i = 0; i < 100_000; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    const mean = sum / 100_000;
    expect(mean).toBeGreaterThan(0.49);
    expect(mean).toBeLessThan(0.51);
  });

  it('int(n) 的值都是 [0, n) 的整數；int(6) 抽 6 萬次，每一面出現 9,500 到 10,500 次', () => {
    const rng = createRng(7);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 60_000; i += 1) {
      const v = rng.int(6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      counts[v] += 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(9_500);
      expect(count).toBeLessThanOrEqual(10_500);
    }
  });

  it("fork('a') 兩次得到相同的序列；fork('a') 與 fork('b') 的序列不同", () => {
    const rng = createRng(99);
    const a1 = rng.fork('a');
    const a2 = rng.fork('a');
    const b = rng.fork('b');
    const seqA1 = take(100, () => a1.next());
    const seqA2 = take(100, () => a2.next());
    const seqB = take(100, () => b.next());
    expect(seqA1).toEqual(seqA2);
    expect(seqA1).not.toEqual(seqB);
  });

  it('呼叫 fork 不影響母亂數接下來的輸出', () => {
    const plain = createRng(31337);
    const forked = createRng(31337);
    const expected = take(200, () => plain.next());

    const actual: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      if (i % 7 === 0) {
        const child = forked.fork(`child-${i}`);
        child.next();
        child.int(10);
      }
      actual.push(forked.next());
    }
    expect(actual).toEqual(expected);
  });
});

describe('core/rng（補充：決定性與邊界，TEST_PLAN 沒列）', () => {
  it('fork 的結果與母亂數已經用了幾個數無關', () => {
    const early = createRng(5).fork('x');
    const used = createRng(5);
    take(50, () => used.next());
    const late = used.fork('x');
    expect(take(20, () => late.next())).toEqual(take(20, () => early.next()));
  });

  it('不同母種子的同名 fork 序列不同', () => {
    const a = createRng(1).fork('bullets');
    const b = createRng(2).fork('bullets');
    expect(take(10, () => a.next())).not.toEqual(take(10, () => b.next()));
  });

  it('int(n) 對不合法的 n 丟出錯誤', () => {
    const rng = createRng(1);
    expect(() => rng.int(0)).toThrow();
    expect(() => rng.int(-3)).toThrow();
    expect(() => rng.int(2.5)).toThrow();
    expect(() => rng.int(Number.NaN)).toThrow();
  });

  it('int(1) 永遠是 0', () => {
    const rng = createRng(3);
    for (let i = 0; i < 100; i += 1) {
      expect(rng.int(1)).toBe(0);
    }
  });
});

function takeFrom(count: number, start: RngState): number[] {
  const out: number[] = [];
  let state = start;
  for (let i = 0; i < count; i += 1) {
    const [value, following] = nextFrom(state);
    out.push(value);
    state = following;
  }
  return out;
}

describe('core/rng：可放進 state 的純亂數（RngState）', () => {
  it('兩種觀點等價：createRng(seed).next() 與從 rngStateFor(seed, "") 連續 nextFrom 的序列相同', () => {
    for (const seed of [0, 1, 42, 12345, -7, 2 ** 32 + 5]) {
      const rng = createRng(seed);
      expect(takeFrom(1000, rngStateFor(seed, ''))).toEqual(take(1000, () => rng.next()));
    }
  });

  it('兩種觀點等價：int(n) 與 intFrom 的序列相同', () => {
    const rng = createRng(77);
    let state = rngStateFor(77, '');
    for (let i = 0; i < 500; i += 1) {
      const [value, following] = intFrom(state, 13);
      expect(value).toBe(rng.int(13));
      state = following;
    }
  });

  it('next 與 int 交錯呼叫，兩種觀點仍然等價', () => {
    const rng = createRng(8);
    let state = rngStateFor(8, '');
    for (let i = 0; i < 200; i += 1) {
      if (i % 2 === 0) {
        const [v, s] = nextFrom(state);
        expect(v).toBe(rng.next());
        state = s;
      } else {
        const [v, s] = intFrom(state, 1000);
        expect(v).toBe(rng.int(1000));
        state = s;
      }
    }
  });

  it('fork(label) 等於從 rngStateFor(seed, label) 開始的序列', () => {
    for (const label of ['bullets', 'food', 'a', 'dice']) {
      const child = createRng(2024).fork(label);
      expect(takeFrom(300, rngStateFor(2024, label))).toEqual(take(300, () => child.next()));
    }
  });

  it('不同 label 與不同種子的 rngStateFor 不同', () => {
    expect(rngStateFor(1, 'a')).not.toBe(rngStateFor(1, 'b'));
    expect(rngStateFor(1, 'a')).not.toBe(rngStateFor(2, 'a'));
    expect(rngStateFor(1, 'a')).not.toBe(rngStateFor(1, ''));
  });

  it('純函式：同一個 RngState 呼叫兩次 nextFrom／intFrom 得到同一個結果', () => {
    const s = rngStateFor(5, 'x');
    expect(nextFrom(s)).toEqual(nextFrom(s));
    expect(intFrom(s, 6)).toEqual(intFrom(s, 6));
    // 從同一個狀態重跑，序列可重現
    expect(takeFrom(50, s)).toEqual(takeFrom(50, s));
  });

  it('RngState 是整數；JSON 來回之後相等，序列相同，hashState 不丟錯', () => {
    let s = rngStateFor(9, 'bullets');
    for (let i = 0; i < 20; i += 1) {
      s = nextFrom(s)[1];
      expect(Number.isInteger(s)).toBe(true);
      const roundTripped = JSON.parse(JSON.stringify({ rng: s })) as { rng: RngState };
      expect(roundTripped.rng).toBe(s);
      expect(() => hashState({ rng: s })).not.toThrow();
      expect(hashState({ rng: roundTripped.rng })).toBe(hashState({ rng: s }));
    }
    expect(takeFrom(10, JSON.parse(JSON.stringify(s)) as RngState)).toEqual(takeFrom(10, s));
  });

  it('intFrom：值都在 [0, n)；intFrom(s, 6) 抽 6 萬次，每一面 9,500 到 10,500 次', () => {
    let s = rngStateFor(7, 'dice');
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 60_000; i += 1) {
      const [v, following] = intFrom(s, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      counts[v] += 1;
      s = following;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(9_500);
      expect(count).toBeLessThanOrEqual(10_500);
    }
  });

  it('intFrom(s, 1) 永遠是 0；n 不合法時丟錯', () => {
    const s = rngStateFor(1, '');
    expect(intFrom(s, 1)[0]).toBe(0);
    for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => intFrom(s, bad)).toThrow(RangeError);
    }
  });

  it('nextFrom 對不是合法 RngState 的值丟錯', () => {
    for (const bad of [Number.NaN, 1.5, -1, 2 ** 32, Number.POSITIVE_INFINITY]) {
      expect(() => nextFrom(bad)).toThrow(RangeError);
    }
  });
});

describe('core/rng：種子與 n 的邊界', () => {
  it('非整數、NaN、無限大的種子丟錯，訊息帶出收到的值', () => {
    expect(() => createRng(Number.NaN)).toThrow(/NaN/);
    expect(() => createRng(Number.POSITIVE_INFINITY)).toThrow(/Infinity/);
    expect(() => createRng(Number.NEGATIVE_INFINITY)).toThrow(/-Infinity/);
    expect(() => createRng(1.5)).toThrow(/1\.5/);
    expect(() => createRng(2 ** 53)).toThrow();
    expect(() => rngStateFor(Number.NaN, 'a')).toThrow(/NaN/);
    expect(() => rngStateFor(0.1, 'a')).toThrow(/0\.1/);
  });

  it('過去會被 seed | 0 靜默折疊的種子，現在都是不同的序列', () => {
    const pairs: Array<[number, number]> = [
      [0, 2 ** 32],
      [-1, 2 ** 32 - 1],
      [1, 2 ** 32 + 1],
      [0, 2 ** 40],
      [5, -5],
    ];
    for (const [a, b] of pairs) {
      const ra = createRng(a);
      const rb = createRng(b);
      expect(take(10, () => ra.next())).not.toEqual(take(10, () => rb.next()));
      expect(rngStateFor(a, 'x')).not.toBe(rngStateFor(b, 'x'));
    }
  });

  it('安全整數範圍的極端種子可以用', () => {
    expect(() => createRng(Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(() => createRng(Number.MIN_SAFE_INTEGER)).not.toThrow();
  });

  it('int(n) 的 n 超過 2^32 丟錯；n = 2^32 可以用且值在範圍內', () => {
    const rng = createRng(1);
    expect(() => rng.int(2 ** 32 + 1)).toThrow(RangeError);
    expect(() => rng.int(2 ** 40)).toThrow(RangeError);
    expect(() => intFrom(rngStateFor(1, ''), 2 ** 40)).toThrow(RangeError);
    const v = rng.int(2 ** 32);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(2 ** 32);
  });
});
