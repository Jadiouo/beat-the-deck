import { expect, test } from '@playwright/test';

/**
 * TEST_PLAN 第 7 節的四條端到端測試在 T4 寫（要等外殼存在）。
 * 骨架階段只確認網站真的開得起來。
 */
test('首頁開得起來並看到標題', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('title')).toHaveText('Beat the Deck');
});
