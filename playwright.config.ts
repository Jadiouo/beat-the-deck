import { defineConfig, devices } from '@playwright/test';

/**
 * 有些環境（例如沙箱）下不了 Playwright 自己的瀏覽器，但系統裡已經有一份。
 * 設 PLAYWRIGHT_CHROMIUM_PATH 就用那一份；CI 上不設，照 Playwright 的預設。
 */
const chromiumPath = process.env['PLAYWRIGHT_CHROMIUM_PATH'];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'list' : 'html',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumPath === undefined ? {} : { launchOptions: { executablePath: chromiumPath } }),
      },
    },
  ],
  webServer: {
    // 為什麼明確綁 127.0.0.1（請不要改回預設）：
    // GitHub Actions 的 e2e job 曾失敗，log 最後一行是
    //   Error: Timed out waiting 60000ms from config.webServer.
    // Vite 預設綁 `localhost`；在 GitHub runner 上 localhost 可能先解析成 IPv6 的 ::1，
    // Vite 於是只監聽 ::1，而下面的 url 輪詢的是 IPv4 的 127.0.0.1，永遠等不到回應。
    // 本機容器把 localhost 解析成 127.0.0.1，所以本機不會重現。
    // 這裡用 --host 127.0.0.1 讓「server 實際綁的位址」與「url 輪詢的位址」一致。
    // （推論：這是最可能的原因，本機驗不出來，要等 CI 實跑才能確認。）
    command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    // 逾時從預設 60 秒拉到 180 秒：保險而非主修法，冷啟的 runner 本來就可能比較慢。
    timeout: 180_000,
    reuseExistingServer: !process.env['CI'],
    // stdout 要 pipe：以前是 'ignore'，Vite 的啟動訊息全被丟掉，逾時時完全看不出 server 印了什麼。
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
