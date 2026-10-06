import { readFileSync } from 'node:fs';

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * 純度規則（CLAUDE.md 第 2 條、TEST_PLAN 3.8）與測試讀的是同一份設定，
 * 所以兩邊不會各說各話。改禁止清單只要改 tools/purity.config.json。
 */
const purity = JSON.parse(
  readFileSync(new URL('./tools/purity.config.json', import.meta.url), 'utf8'),
);

const PURITY_NOTE =
  '模擬層必須是純的：亂數只能用傳進來的 Rng，時間只有 tick 數（CLAUDE.md 第 2 條）。';

const restrictedGlobals = purity.forbidden
  .filter((pattern) => !pattern.includes('.'))
  .map((name) => ({ name, message: PURITY_NOTE }));

const restrictedProperties = purity.forbidden
  .filter((pattern) => pattern.includes('.'))
  .map((pattern) => {
    const dot = pattern.indexOf('.');
    return {
      object: pattern.slice(0, dot),
      property: pattern.slice(dot + 1),
      message: PURITY_NOTE,
    };
  });

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2022 },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tools/**/*.ts', 'tests/**/*.ts', '*.config.ts', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
  },
  {
    // 模擬層：這裡不可以碰時鐘、瀏覽器或自己的亂數。
    files: purity.pureGlobs,
    ignores: purity.excludeGlobs,
    rules: {
      'no-restricted-globals': ['error', ...restrictedGlobals],
      'no-restricted-properties': ['error', ...restrictedProperties],
    },
  },
);
