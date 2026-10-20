import { availableParallelism } from 'node:os';

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
 *
 * 第三個 project `timing`（10.41 之後加）：所有用牆鐘做門檻的測試 —— A5（decide() 平均 < 1ms、
 * p99.9 < 8ms）、K11（一場 < 2 秒）、以及幾條「跑一次少於 1 秒」的單元測試，檔案都在 tests/timing/。
 * 這些測試量的是時間，機器一忙就假性變紅（整套檢查裡 A5 是 8 到 9 毫秒，隔離重跑是 0.7 到 2.2），
 * 所以它們：
 * - 序列執行（`fileParallelism: false`、`maxWorkers: 1`）：自己不會被同 project 的別的檔案搶；
 * - 排在 light 與 heavy 全部跑完之後（`sequence.groupOrder` 較大）：不與任何其他 project 並行；
 * - light 與 heavy 的 worker 數都留一顆核心給作業系統與 vitest 主程序，不把機器灌到超載
 *   （60 秒、120 秒的 timeout 也是時間類斷言，超載時會假性逾時）。
 * 門檻一個都沒動、沒有任何一條被跳過。只想跑一個 project 時（例如 CI 的分 job），
 * 各自 `--project` 指定即可；timing 在 CI 上獨佔一個 job。
 */
const PARALLEL_WORKERS = Math.max(1, availableParallelism() - 1);
const HEAVY_FILES = [
  'tests/ai/a-checks.*.test.ts',
  'tests/contract/all-games.*.test.ts',
  'tests/ai/policies.test.ts',
  // 追目標的取得率（P1）：每張有可追目標的牌跑 16 場對局，慢。
  'tests/contract/pursuit.test.ts',
  // 梅花簡單腳本 S4 與對打撞死（10.37）：每張 400 場 + 24 場等級 10 對打，慢。
  'tests/ai/clubs-s4.test.ts',
  // C-4 霧的探索行為與 A4 兩個種子區塊（10.38 第 7 節）：數十場對打 + 400 場 A4，慢。
  'tests/ai/c4-fog.test.ts',
  // A4 豁免的前提（10.14）：簡單策略對等級 10 的勝率 ≥ 40%（H-5 兩百場、S-10 一百場 × 2），慢。
  'tests/ai/simple-strategy-premise.*.test.ts',
  // 每張牌的量測測試（A1–A4 樣本外、對打、劇本等）：一支就數十秒到數十分鐘（C-K 一次約 31 分鐘），
  // 不屬於「快、每次都跑」的 light。用 glob，以後新增的牌自動包含；`scratch.*` 不在這裡。
  'src/games/*/measure.test.ts',
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
          maxWorkers: PARALLEL_WORKERS,
          sequence: { groupOrder: 1 },
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: [
            'tests/e2e/**',
            'tests/scratch/**',
            'tests/timing/**',
            'node_modules/**',
            'dist/**',
            ...HEAVY_FILES,
          ],
        },
      },
      {
        extends: true,
        test: {
          ...common,
          name: 'heavy',
          maxWorkers: PARALLEL_WORKERS,
          sequence: { groupOrder: 1 },
          include: HEAVY_FILES,
          exclude: [
            'tests/e2e/**',
            'tests/scratch/**',
            'tests/timing/**',
            'node_modules/**',
            'dist/**',
          ],
        },
      },
      {
        extends: true,
        test: {
          ...common,
          name: 'timing',
          include: ['tests/timing/**/*.test.ts'],
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
