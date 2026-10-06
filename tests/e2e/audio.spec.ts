import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * 音效（SPEC 8.4）的端到端：玩家按過鍵才建立 AudioContext、之後預設就會響（方波）、
 * 在設定裡關掉就安靜，而且設定會存起來。
 * 在頁面載入前把 AudioContext 換成會記錄的版本。
 */

interface AudioSpy {
  contexts: number;
  oscillators: OscillatorNode[];
  sources: number;
}

async function spyOnAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spy: AudioSpy = { contexts: 0, oscillators: [], sources: 0 };
    (window as unknown as { __audio: AudioSpy }).__audio = spy;
    const Original = window.AudioContext;
    class Spied extends Original {
      constructor() {
        super();
        spy.contexts += 1;
      }
      override createOscillator(): OscillatorNode {
        const node = super.createOscillator();
        spy.oscillators.push(node);
        return node;
      }
      override createBufferSource(): AudioBufferSourceNode {
        spy.sources += 1;
        return super.createBufferSource();
      }
    }
    window.AudioContext = Spied;
  });
}

const readSpy = (page: Page): Promise<{ contexts: number; types: string[]; sources: number }> =>
  page.evaluate(() => {
    const spy = (window as unknown as { __audio: AudioSpy }).__audio;
    return {
      contexts: spy.contexts,
      types: spy.oscillators.map((node) => node.type),
      sources: spy.sources,
    };
  });

test('音效：沒按鍵之前不建立 AudioContext；第一次按鍵之後預設就會響（開關預設是開）', async ({
  page,
}) => {
  await spyOnAudio(page);
  await page.goto('/');
  await expect(page.locator('#mirror')).toHaveAttribute('data-screen', 'title');
  await expect(page.getByTestId('menu-sound')).toHaveText('音效：開');
  // SPEC 8.4：互動之前什麼都沒有（瀏覽器不准沒互動就發聲）。
  expect((await readSpy(page)).contexts).toBe(0);

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#mirror')).toHaveAttribute('data-cursor', '1');
  const loud = await readSpy(page);
  expect(loud.contexts).toBe(1);
  expect(loud.types.length).toBeGreaterThan(0);
  expect(loud.types.every((type) => type === 'square')).toBe(true);
});

test('音效：在標題把音效關掉之後就安靜，設定存在 localStorage，重新整理還是關', async ({
  page,
}) => {
  await spyOnAudio(page);
  await page.goto('/');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#mirror')).toHaveAttribute('data-cursor', '2');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('menu-sound')).toHaveText('音效：關');

  const stored = await page.evaluate(() => window.localStorage.getItem('btd.v1'));
  expect(JSON.parse(stored ?? '{}').settings.sound).toBe(false);
  expect(JSON.parse(stored ?? '{}').version).toBe(1);

  // 關掉之後再按鍵，不會再多出振盪器。
  const before = (await readSpy(page)).types.length;
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#mirror')).toHaveAttribute('data-cursor', '1');
  expect((await readSpy(page)).types.length).toBe(before);

  // 重新整理：存檔裡明確關過的，仍然是關，而且按鍵之後也沒有聲音。
  await page.reload();
  await expect(page.getByTestId('menu-sound')).toHaveText('音效：關');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#mirror')).toHaveAttribute('data-cursor', '1');
  const after = await readSpy(page);
  expect(after.contexts).toBe(1);
  expect(after.types).toEqual([]);
  expect(after.sources).toBe(0);
});
