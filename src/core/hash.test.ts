import { describe, expect, it } from 'vitest';

import { hashState } from './hash';

describe('core/hash（TEST_PLAN 3.2）', () => {
  it('同樣內容的兩個物件（鍵的順序不同）雜湊相同', () => {
    const a = { x: 1, y: [1, 2, { p: true, q: 'z' }], z: { m: 1, n: 2 } };
    const b = { z: { n: 2, m: 1 }, y: [1, 2, { q: 'z', p: true }], x: 1 };
    expect(hashState(a)).toBe(hashState(b));
  });

  it('任何一個數值欄位差 1，雜湊不同', () => {
    const base = { score: [3, 4], pos: { x: 10, y: 20 }, list: [{ v: 5 }, { v: 6 }] };
    const baseHash = hashState(base);
    const variants = [
      { ...base, score: [4, 4] },
      { ...base, score: [3, 5] },
      { ...base, pos: { x: 11, y: 20 } },
      { ...base, pos: { x: 10, y: 21 } },
      { ...base, list: [{ v: 6 }, { v: 6 }] },
      { ...base, list: [{ v: 5 }, { v: 7 }] },
    ];
    for (const variant of variants) {
      expect(hashState(variant)).not.toBe(baseHash);
    }
  });

  it('state 裡有 NaN 時丟出錯誤，訊息指出是哪個欄位', () => {
    const state = { bullets: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: Number.NaN }] };
    expect(() => hashState(state)).toThrow(/state\.bullets\[3\]\.x/);
  });

  it('state 裡有 undefined 時丟出錯誤，訊息指出是哪個欄位', () => {
    const state = { player: { name: 'a', hp: undefined } };
    expect(() => hashState(state)).toThrow(/state\.player\.hp/);
  });

  it('state 裡有函式時丟出錯誤，訊息指出是哪個欄位', () => {
    const state = { handlers: { onHit: () => 1 } };
    expect(() => hashState(state)).toThrow(/state\.handlers\.onHit/);
  });
});

describe('core/hash（補充：TEST_PLAN 沒列）', () => {
  it('回傳固定長度的十六進位字串，且同輸入每次相同', () => {
    const h = hashState({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashState({ a: 1 })).toBe(h);
  });

  it('型別不同的值不會撞：1 與 "1"、null 與 0、陣列與物件', () => {
    const hashes = [1, '1', null, 0, [], {}, true, false, [1], { 0: 1 }].map((v) =>
      hashState(v),
    );
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('字串內容與結構不會互相混淆', () => {
    expect(hashState(['a,b'])).not.toBe(hashState(['a', 'b']));
    expect(hashState({ a: 'b' })).not.toBe(hashState({ 'a"b': '' }));
  });

  it('Infinity 與 -Infinity 也丟錯；錯誤訊息指出欄位', () => {
    expect(() => hashState({ a: [Number.POSITIVE_INFINITY] })).toThrow(/state\.a\[0\]/);
    expect(() => hashState({ a: Number.NEGATIVE_INFINITY })).toThrow(/state\.a/);
  });

  it('類別實例（例如 Map、Date）丟錯，訊息指出欄位', () => {
    expect(() => hashState({ m: new Map() })).toThrow(/state\.m/);
    expect(() => hashState({ d: new Date(0) })).toThrow(/state\.d/);
  });

  it('循環參照丟錯，不會無限遞迴', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => hashState(a)).toThrow(/state\.self/);
  });

  it('可以指定根名稱，讓訊息更好懂', () => {
    expect(() => hashState({ x: Number.NaN }, 'snapshot')).toThrow(/snapshot\.x/);
  });

  it('JSON 來回之後雜湊不變（K2 會用到）', () => {
    const state = { a: [1, 2.5, -0, { b: 'x', c: null, d: false }] };
    expect(hashState(JSON.parse(JSON.stringify(state)))).toBe(hashState(state));
  });
});
