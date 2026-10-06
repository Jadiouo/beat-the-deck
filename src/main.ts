/// <reference types="vite/client" />
import { createScreenCanvas } from './shell/canvas';
import { startApp } from './shell/app';
import { parseLaunch } from './shell/launch';
import { strings } from './shell/strings';

/**
 * 進入點：把畫布、看不見的 DOM 鏡像與虛擬按鍵區接起來，交給外殼（`src/shell/app.ts`）。
 * 網址參數（`?card=&seed=&autoplay=`）只在開發與測試建置有效（`import.meta.env.DEV`）。
 */
const app = document.querySelector<HTMLElement>('#app');
const mirror = document.querySelector<HTMLElement>('#mirror');

if (app === null || mirror === null) {
  throw new Error('index.html 少了 #app 或 #mirror');
}

try {
  const launch = parseLaunch(window.location.search, import.meta.env.DEV);
  if (launch !== null) {
    // 拿掉網址參數：重新整理之後回到標題，不會又自動打一局。
    window.history.replaceState(null, '', window.location.pathname);
  }
  const screen = createScreenCanvas(app);
  startApp({
    screen,
    mirror,
    touchParent: app,
    storage: (() => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    })(),
    launch,
  });
} catch {
  app.textContent = strings.startupFailed;
}
