import { defineConfig } from 'vite';

export default defineConfig({
  // 邏輯解析度固定 320×240（SPEC 第 3 節），放大在 shell 處理。
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
});
