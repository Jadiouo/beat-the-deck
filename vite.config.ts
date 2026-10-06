import { defineConfig } from 'vite';

/** GitHub Pages 的網址是 https://jadiouo.github.io/beat-the-deck/，網站在 /beat-the-deck/ 底下。 */
const PAGES_BASE = '/beat-the-deck/';

export default defineConfig(({ command }) => ({
  // 只有 build 才設 base：`npm run dev` 與端到端測試（baseURL 是 http://127.0.0.1:5173，page.goto('/')）
  // 照舊在根路徑，不必改任何測試。`vite preview` 會吃 build 時的 base，所以預覽網址是 /beat-the-deck/。
  base: command === 'build' ? PAGES_BASE : '/',
  // 邏輯解析度固定 320×240（SPEC 第 3 節），放大在 shell 處理。
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  server: {
    // 與 playwright.config.ts 的 webServer.url 一致：明確綁 IPv4，避免 localhost 在 CI 解析成 ::1。
    host: '127.0.0.1',
    port: 5173,
  },
}));
