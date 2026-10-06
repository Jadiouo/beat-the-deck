import { mkdirSync } from 'node:fs';

import { expect, test } from '@playwright/test';

/**
 * 產生 PR 說明與 README 用的截圖，存進 docs/screenshots/。
 *
 * 平常的 `npm run e2e` 會略過這個檔案（不寫任何檔案，不讓測試跑完工作目錄變髒）；要重新產生就執行：
 *   SCREENSHOTS=1 npx playwright test tests/e2e/screenshots.spec.ts
 *
 * - deck.png：牌桌。先存一份「翻開 8 張」的進度，畫面上同時看得到 54 格、進度燈、已翻開的牌、
 *   可玩但還鎖著的牌，以及「尚未開放」的格子。
 * - jkr-seed-1/2/3.png：JK-R 三個種子各玩滿 5400 tick（autoplay 加速）後，用結算頁的「存成圖片」存下來的 320×240 成品。
 *   種子由網址指定，所以每次產生的內容一樣。
 */

const OUT = 'docs/screenshots';

test.skip(process.env['SCREENSHOTS'] !== '1', '只有 SCREENSHOTS=1 時才產生截圖');

test('牌桌截圖 deck.png', async ({ page }) => {
  await page.addInitScript(() => {
    const won = ['C-A', 'C-2', 'C-3', 'S-A', 'S-2', 'D-A', 'D-2', 'H-A'];
    const cards: Record<string, { best: number; won: boolean }> = {};
    won.forEach((id, index) => {
      cards[id] = { best: 10 + index, won: true };
    });
    window.localStorage.setItem(
      'btd.v1',
      JSON.stringify({
        version: 1,
        cards,
        globalLevel: 3,
        lossStreak: 0,
        settings: { scanlines: false, sound: false },
      }),
    );
  });
  await page.goto('/');
  await page.keyboard.press('Enter');
  await expect(page.locator('#mirror')).toHaveAttribute('data-screen', 'table');
  await expect(page.locator('[data-testid^="card-"]')).toHaveCount(54);
  mkdirSync(OUT, { recursive: true });
  await page.locator('canvas').screenshot({ path: `${OUT}/deck.png` });
});

for (const seed of [1, 2, 3]) {
  test(`JK-R 種子 ${seed} 的成品 jkr-seed-${seed}.png`, async ({ page }) => {
    await page.goto(`/?card=JK-R&seed=${seed}&autoplay=human-model`);
    await expect(page.locator('#mirror')).toHaveAttribute('data-screen', 'result', {
      timeout: 60_000,
    });
    mkdirSync(OUT, { recursive: true });
    // 用結算頁的「存成圖片」（SPEC 第 11 節）：下載到的就是 320×240 的畫布成品，再存進 docs/screenshots/。
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150); // 同一幀的方向鍵與確認會被當成只有方向鍵。
    const downloading = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`JK-R-seed-${seed}.png`);
    await download.saveAs(`${OUT}/jkr-seed-${seed}.png`);
  });
}
