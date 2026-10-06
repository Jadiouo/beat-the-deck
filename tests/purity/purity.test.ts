import { describe, expect, it } from 'vitest';

import type { Impurity } from '../../tools/purity.ts';
import {
  FORBIDDEN_PATTERNS,
  PURE_GLOBS,
  findImpurities,
  formatImpurities,
  isPureFile,
  scanPureSources,
} from '../../tools/purity.ts';

/**
 * TEST_PLAN 3.8｜純度檢查
 *
 * `src/core/**`、`src/ai/**`、`src/games/**\/logic.ts` 是模擬層，必須是純的。
 * 這組測試一半在驗證掃描器本身真的抓得到東西（不然它永遠是綠的也看不出來），
 * 一半在對真的原始碼跑一次。
 */

describe('純度檢查的設定', () => {
  it('禁止清單就是 CLAUDE.md 與 TEST_PLAN 3.8 列的那幾個', () => {
    expect([...FORBIDDEN_PATTERNS]).toEqual([
      'Math.random',
      'Date.now',
      'performance.now',
      'window',
      'document',
      'setTimeout',
      'setInterval',
    ]);
  });

  it('掃描範圍是模擬層的三塊', () => {
    expect([...PURE_GLOBS]).toEqual([
      'src/core/**/*.ts',
      'src/ai/**/*.ts',
      'src/games/**/logic.ts',
    ]);
  });
});

describe('isPureFile', () => {
  it.each([
    'src/core/rng.ts',
    'src/core/sub/deep/thing.ts',
    'src/ai/level.ts',
    'src/ai/policies/greedy.ts',
    'src/games/C-A/logic.ts',
    'src/games/_clubs/logic.ts',
  ])('%s 在範圍內', (path) => {
    expect(isPureFile(path)).toBe(true);
  });

  it.each([
    'src/main.ts',
    'src/shell/loop.ts',
    'src/games/registry.ts',
    'src/games/C-A/render.ts',
    'src/games/C-A/meta.ts',
    'src/core/rng.test.ts',
    'tests/contract/all-games.test.ts',
    'tools/purity.ts',
  ])('%s 不在範圍內', (path) => {
    expect(isPureFile(path)).toBe(false);
  });

  it('接受 Windows 風格的路徑分隔符號', () => {
    expect(isPureFile('src\\core\\rng.ts')).toBe(true);
  });
});

describe('findImpurities', () => {
  it.each([...FORBIDDEN_PATTERNS])(
    '抓到 %s，並指出檔名與行號',
    (pattern) => {
      const source = ['const a = 1;', '', `const b = ${pattern};`].join('\n');
      const found = findImpurities('src/core/rng.ts', source);

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        file: 'src/core/rng.ts',
        line: 3,
        pattern,
      });
    },
  );

  it('一個檔案裡的多處都會被列出來', () => {
    const source = [
      'export function bad() {',
      '  const r = Math.random();',
      '  const t = Date.now();',
      '  return r + t;',
      '}',
    ].join('\n');

    const found = findImpurities('src/ai/policies/greedy.ts', source);

    expect(found.map((i: Impurity) => [i.line, i.pattern])).toEqual([
      [2, 'Math.random'],
      [3, 'Date.now'],
    ]);
  });

  it('同一行出現兩次會被算成兩筆', () => {
    const found = findImpurities('src/core/x.ts', 'const a = [Math.random(), Math.random()];');
    expect(found).toHaveLength(2);
    expect(found[0]?.column ?? 0).toBeLessThan(found[1]?.column ?? 0);
  });

  it('只是名字像的識別字不算', () => {
    const source = [
      'const windowSize = 4;',
      'const rotatedWindow = 1;',
      'interface Documentation { page: number }',
      'const myDocument = null;',
      'const mathRandomish = 0;',
      'const dateNow = 0;',
      'const performanceNote = 0;',
      'const setTimeoutTicks = 0;',
      'const clearInterval = 0;',
      'export { windowSize, rotatedWindow, myDocument, mathRandomish, dateNow };',
      'export { performanceNote, setTimeoutTicks, clearInterval };',
    ].join('\n');

    expect(findImpurities('src/core/x.ts', source)).toEqual([]);
  });

  it('中間有空白的 Math . random 也抓得到', () => {
    const found = findImpurities('src/core/x.ts', 'const a = Math . random();');
    expect(found).toHaveLength(1);
    expect(found[0]?.pattern).toBe('Math.random');
  });

  it('乾淨的檔案回傳空陣列', () => {
    const source = [
      'export function next(seed: number): number {',
      '  return (seed * 1664525 + 1013904223) >>> 0;',
      '}',
    ].join('\n');

    expect(findImpurities('src/core/rng.ts', source)).toEqual([]);
  });
});

describe('formatImpurities', () => {
  it('訊息列出檔名、行號與是哪一個模式', () => {
    const message = formatImpurities([
      { file: 'src/core/rng.ts', line: 7, column: 12, pattern: 'Math.random', text: 'Math.random' },
    ]);

    expect(message).toContain('src/core/rng.ts:7:12');
    expect(message).toContain('Math.random');
  });
});

describe('真正的原始碼', () => {
  it('模擬層裡沒有任何不純的東西', () => {
    const impurities = scanPureSources();
    expect(formatImpurities(impurities)).toBe('');
  });
});
