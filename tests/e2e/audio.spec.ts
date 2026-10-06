import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * 音效（SPEC 8.4）的端到端：預設靜音、玩家按過鍵才建立 AudioContext、
 * 在設定裡打開之後真的有方波振盪器在響，而且設定會存起來。
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

test('音效：預設靜音，沒按鍵之前不建立 AudioContext；開關預設是關', async ({ page }) => {
  await spyOnAudio(page);
  await page.goto('/');
  await expect(page.locator('#mirror')).toHaveAttribute('data-screen', 'title');
  await expect(page.getByTestId('menu-sound')).toHaveText('音效：關');
  expect((await readSpy(page)).contexts).toBe(0);

  // 按了鍵、但開關是關的：AudioContext 被啟動（互動過了），仍然沒有任何聲音。
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#mirror')).toHaveAttribute('data-cursor', '1');
  const quiet = await readSpy(page);
  expect(quiet.contexts).toBe(1);
  expect(quiet.types).toEqual([]);
  expect(quiet.sources).toBe(0);
});

test('音效：在標題打開音效之後會響（只有方波與雜訊），設定存在 localStorage，重新整理還在', async ({
  page,
}) => {
  await spyOnAudio(page);
  await page.goto('/');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#mirror')).toHaveAttribute('data-cursor', '2');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('menu-sound')).toHaveText('音效：開');

  const loud = await readSpy(page);
  expect(loud.contexts).toBe(1);
  expect(loud.types.length).toBeGreaterThan(0);
  expect(loud.types.every((type) => type === 'square')).toBe(true);

  const stored = await page.evaluate(() => window.localStorage.getItem('btd.v1'));
  expect(JSON.parse(stored ?? '{}').settings.sound).toBe(true);
  expect(JSON.parse(stored ?? '{}').version).toBe(1);

  await page.reload();
  await expect(page.getByTestId('menu-sound')).toHaveText('音效：開');
});
