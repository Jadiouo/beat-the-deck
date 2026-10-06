import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { FORBIDDEN_PATTERNS } from '../../tools/purity.ts';

/**
 * TEST_PLAN 3.8 要求「一個測試」加「對應的 ESLint 規則」。
 * 上面的 purity.test.ts 管測試那一半；這裡證明 ESLint 那一半真的會擋，
 * 而且只擋模擬層，不會連 shell 一起擋。
 */

const lint = new ESLint({ overrideConfigFile: 'eslint.config.js' });

async function messagesFor(filePath: string, code: string): Promise<string[]> {
  const results = await lint.lintText(code, { filePath, warnIgnored: false });
  return (results[0]?.messages ?? []).map((m) => `${m.ruleId ?? '?'}: ${m.message}`);
}

const SNIPPETS: Record<string, string> = {
  'Math.random': 'export const a = Math.random();',
  'Date.now': 'export const a = Date.now();',
  'performance.now': 'export const a = performance.now();',
  window: 'export const a = window;',
  document: 'export const a = document;',
  setTimeout: 'export const a = setTimeout;',
  setInterval: 'export const a = setInterval;',
};

describe('ESLint 的純度規則', () => {
  it.each([...FORBIDDEN_PATTERNS])(
    '在 src/core 裡用 %s 會被擋下來',
    async (pattern) => {
      const messages = await messagesFor('src/core/probe.ts', SNIPPETS[pattern] ?? '');
      expect(messages.join('\n')).toContain(pattern);
    },
  );

  it('src/games/<id>/logic.ts 也被擋', async () => {
    const messages = await messagesFor('src/games/C-A/logic.ts', SNIPPETS['Math.random'] ?? '');
    expect(messages.join('\n')).toContain('Math.random');
  });

  it('src/ai 也被擋', async () => {
    const messages = await messagesFor('src/ai/policies/greedy.ts', SNIPPETS['Date.now'] ?? '');
    expect(messages.join('\n')).toContain('Date.now');
  });

  it('src/shell 不受限制（畫面層本來就要用 window）', async () => {
    const messages = await messagesFor('src/shell/loop.ts', SNIPPETS['window'] ?? '');
    expect(messages).toEqual([]);
  });

  it('src/games/<id>/render.ts 不受限制', async () => {
    const messages = await messagesFor('src/games/C-A/render.ts', SNIPPETS['Date.now'] ?? '');
    expect(messages).toEqual([]);
  });

  it('乾淨的模擬層程式碼不會被誤報', async () => {
    const messages = await messagesFor(
      'src/core/rng.ts',
      'export function next(seed: number): number {\n  return (seed * 1664525 + 1013904223) >>> 0;\n}\n',
    );
    expect(messages).toEqual([]);
  });
});
