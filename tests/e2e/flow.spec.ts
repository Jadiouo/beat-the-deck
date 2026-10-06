import { expect, test } from '@playwright/test';

/**
 * TEST_PLAN 第 7 節的四條端到端測試。
 *
 * 畫面是 canvas，看不到文字；外殼另外維護一份看不見的 DOM 鏡像（#mirror）給讀螢幕的人與這些測試用：
 * data-screen 是目前的畫面，每個格子是 data-testid="card-<id>"，結算頁有 result-* 的元素。
 *
 * 與 TEST_PLAN 原文的差別（目前只有 C-A、C-2、C-3 三張牌做好了）：
 * - 第 1 條：「4 張 A 可以選」改成「4 張 A 的格子都在，C-A 可以選，其餘三張標示為尚未開放（做好之後會變成可以選）」。
 * - 第 3 條：H-A 還沒有，改用 ?card=C-A&seed=1&autoplay=human-model。
 */

const mirror = (page: import('@playwright/test').Page): import('@playwright/test').Locator =>
  page.locator('#mirror');

test('1. 打開首頁：看到標題，按鍵進到牌桌，看到 54 張牌，4 張 A 的格子都在', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('title')).toHaveText('Beat the Deck');
  await expect(mirror(page)).toHaveAttribute('data-screen', 'title');

  await page.keyboard.press('Enter');
  await expect(mirror(page)).toHaveAttribute('data-screen', 'table');

  await expect(page.locator('[data-testid^="card-"]')).toHaveCount(54);
  // C-A 做好了，可以選；其餘三張 A 還沒做，標示為尚未開放（做好之後登記表一加，就會變成 playable）。
  await expect(page.getByTestId('card-C-A')).toHaveAttribute('data-state', 'playable');
  for (const id of ['S-A', 'D-A', 'H-A']) {
    await expect(page.getByTestId(`card-${id}`)).toHaveAttribute(
      'data-state',
      /^(playable|unimplemented)$/,
    );
  }
  // 沒有解鎖的牌是鎖住的。
  await expect(page.getByTestId('card-C-2')).toHaveAttribute('data-state', 'locked');
  // 兩張鬼牌也在。
  await expect(page.getByTestId('card-JK-R')).toBeAttached();
  await expect(page.getByTestId('card-JK-B')).toBeAttached();
});

test('2. 選 C-A：看到說明頁，開始後畫布有在更新（兩次截圖不同）', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Enter'); // 標題 → 牌桌
  await expect(mirror(page)).toHaveAttribute('data-screen', 'table');
  await page.keyboard.press('Enter'); // 游標一開始在 C-A
  await expect(mirror(page)).toHaveAttribute('data-screen', 'info');
  await expect(page.getByTestId('info-name')).toContainText('貪食蛇對決');

  await page.keyboard.press('Enter'); // 開始
  await expect(mirror(page)).toHaveAttribute('data-screen', 'match');
  await expect(mirror(page)).toHaveAttribute('data-phase', 'playing');

  const canvas = page.locator('canvas');
  const first = await canvas.screenshot();
  await page.waitForTimeout(700);
  const second = await canvas.screenshot();
  expect(first.equals(second)).toBe(false);
});

test('3. ?card=C-A&seed=1&autoplay=human-model 跑完一局：出現結算頁，有兩邊的分數與一句 AI 台詞', async ({
  page,
}) => {
  await page.goto('/?card=C-A&seed=1&autoplay=human-model');
  await expect(mirror(page)).toHaveAttribute('data-screen', 'result', { timeout: 30_000 });
  await expect(page.getByTestId('result-score-0')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('result-score-1')).toHaveText(/^\d+$/);
  const taunt = (await page.getByTestId('result-taunt').textContent()) ?? '';
  expect(taunt.trim().length).toBeGreaterThan(4);
});

test('4. 贏了一局之後重新整理頁面：那張牌是翻開的', async ({ page }) => {
  // 種子 3：人類模型（人這一邊）對 1 級的搜尋型 AI 贏（2 比 1），已用 playMatch 離線確認。
  await page.goto('/?card=C-A&seed=3&autoplay=human-model');
  await expect(mirror(page)).toHaveAttribute('data-screen', 'result', { timeout: 30_000 });
  await expect(mirror(page)).toHaveAttribute('data-outcome', 'win');

  // 外殼啟動之後會把網址參數拿掉，所以重新整理回到標題，不會又自動打一局。
  await page.reload();
  await expect(mirror(page)).toHaveAttribute('data-screen', 'title');
  await page.keyboard.press('Enter');
  await expect(mirror(page)).toHaveAttribute('data-screen', 'table');
  await expect(page.getByTestId('card-C-A')).toHaveAttribute('data-revealed', 'true');
  await expect(page.getByTestId('card-C-A')).toHaveAttribute('data-state', 'revealed');
  // 贏了 C-A，C-2 開放。
  await expect(page.getByTestId('card-C-2')).toHaveAttribute('data-state', 'playable');
});
