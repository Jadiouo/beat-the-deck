import { defineConfig } from 'vitest/config';

/**
 * 單元測試與原始碼同資料夾；契約、AI 測試在 tests/ 底下。
 * 端到端測試由 Playwright 跑（npm run e2e），不在這裡。
 * `tests/scratch/` 不跑：那是 agent 跑統計時產生的一次性量測腳本，檔名也叫 *.test.ts，
 * 所以會被 `tests/**` 撈進來，而且它們一跑就是幾分鐘 — 跟真正的單元測試擠同一批 worker，
 * 害單元測試在 5 秒的 timeout 下假性失敗。暫存檔本來應該寫在 session 的 scratchpad 目錄；
 * 寫進 repo 的就由這裡、tsconfig.json 與 .gitignore 一起擋住。
 *
 * 分成兩個 project（`npm test` 兩個都跑，所以 `npm run check` 仍然包含全部測試）：
 * - `light`：型別以外的快測試（單元、純度、登記表……），幾秒到幾十秒。
 * - `heavy`：逐張牌的契約檢查（K1–K13、R1–R3）與 A1–A5 統計檢查，會隨牌數線性變慢。
 *   CI 把它們獨立成幾個並行的 job（`--project heavy --shard=i/N`），讓回饋更快。
 * 兩個 project 的檔案由同一份 HEAVY_FILES 決定，所以不會漏掉任何一個測試檔、也不會重跑。
 */
const HEAVY_FILES = [
  'tests/ai/a-checks.*.test.ts',
  'tests/contract/all-games.*.test.ts',
  'tests/ai/policies.test.ts',
];

const common = {
  environment: 'node' as const,
};

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...common,
          name: 'light',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['tests/e2e/**', 'tests/scratch/**', 'node_modules/**', 'dist/**', ...HEAVY_FILES],
        },
      },
      {
        extends: true,
        test: {
          ...common,
          name: 'heavy',
          include: HEAVY_FILES,
          exclude: ['tests/e2e/**', 'tests/scratch/**', 'node_modules/**', 'dist/**'],
        },
      },
    ],
  },
});
