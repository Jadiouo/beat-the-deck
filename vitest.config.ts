import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 單元測試與原始碼同資料夾；契約、AI 測試在 tests/ 底下。
    // 端到端測試由 Playwright 跑（npm run e2e），不在這裡。
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
