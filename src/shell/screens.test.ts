import { describe, expect, it } from 'vitest';

import { resultMenuHit, resultMenuTops } from './screens';

describe('shell/screens：結算頁的選單位置（3 項或 4 項）', () => {
  it('3 項（一般牌）：看重播、再一次、回牌桌，位置不變', () => {
    expect(resultMenuTops(3)).toEqual([174, 190, 206]);
  });

  it('4 項（JK-R 多一個「存成圖片」）：往上擠一點，最後一項仍在畫面內且不壓到提示列', () => {
    const tops = resultMenuTops(4);
    expect(tops).toHaveLength(4);
    for (let i = 1; i < tops.length; i += 1) {
      expect((tops[i] as number) - (tops[i - 1] as number)).toBeGreaterThanOrEqual(14);
    }
    expect(tops[0]).toBeGreaterThan(168);
    expect((tops[3] as number) + 14).toBeLessThanOrEqual(228);
  });

  it('點擊：每一項各有一段不重疊的範圍；範圍外是 -1', () => {
    for (const count of [3, 4]) {
      const tops = resultMenuTops(count);
      tops.forEach((top, index) => {
        expect(resultMenuHit(count, top + 6)).toBe(index);
      });
      expect(resultMenuHit(count, 10)).toBe(-1);
      expect(resultMenuHit(count, 239)).toBe(-1);
    }
  });
});
