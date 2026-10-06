import { describe, expect, it } from 'vitest';

import { createRng } from './rng';

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
