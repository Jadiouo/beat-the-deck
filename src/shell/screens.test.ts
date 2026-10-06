import { describe, expect, it } from 'vitest';

import { drawResult, resultMenuHit, resultMenuTops, resultTaunt } from './screens';
import type { ResultData } from './screens';
import { TAUNTS } from './taunts';

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

describe('shell/screens：結算頁的 AI 台詞（SPEC 7.4）', () => {
  it('有 AI 性格的牌：依勝負與連輸挑出那個性格那個情境裡的一句', () => {
    const line = resultTaunt('pathfinder', 1, 0, 5);
    expect(line).not.toBeNull();
    expect(TAUNTS.pathfinder.aiWins).toContain(line);
    expect(TAUNTS.gambler.aiLoses).toContain(resultTaunt('gambler', 0, 0, 5));
    expect(TAUNTS.greedy.draw).toContain(resultTaunt('greedy', null, 0, 5));
    expect(TAUNTS.precise.streak).toContain(resultTaunt('precise', 1, 3, 5));
  });

  it('沒有 AI 性格的牌（鬼牌，defaultPolicy 是 null）：沒有台詞，不管勝負是什麼', () => {
    expect(resultTaunt(null, null, 0, 5)).toBeNull();
    expect(resultTaunt(null, 1, 3, 5)).toBeNull();
  });

  const base: ResultData = {
    headline: '結果',
    headlineColor: '#ffffff',
    scores: [0, 0],
    showScores: false,
    seed: 1,
    taunt: null,
    personality: '搜尋型',
    notes: [],
    menu: ['a', 'b', 'c'],
    cursor: 0,
  };

  const drawnTexts = (data: ResultData): string[] => {
    const texts: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'measureText') {
            return (text: string) => ({ width: text.length * 6 });
          }
          if (prop === 'fillText') {
            return (text: string) => texts.push(text);
          }
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    drawResult(ctx, data);
    return texts;
  };

  it('台詞是 null：結算頁不畫台詞，也不畫性格名稱；有台詞時兩者都畫', () => {
    const without = drawnTexts(base);
    expect(without).not.toContain('搜尋型');
    const withTaunt = drawnTexts({ ...base, taunt: '這是一句台詞' });
    expect(withTaunt).toContain('搜尋型');
    expect(withTaunt).toContain('這是一句台詞');
  });
});
