import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { PALETTE } from '../../src/shell/palette';

/**
 * JK-R 結算頁「存成圖片」（SPEC 第 11 節）：真的下載一個 PNG，檔名帶種子，
 * 而且是合法的 320×240 PNG、顏色都在色盤裡、不是一整片單色。
 */

interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** 還原濾波之後的原始像素（每像素 channels 個位元組）。 */
  pixels: Buffer;
  channels: number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(file: Buffer): DecodedPng {
  expect(file.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  let offset = 8;
  let header: Buffer | null = null;
  const idat: Buffer[] = [];
  let sawEnd = false;
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      sawEnd = true;
    }
    offset += 12 + length;
  }
  expect(sawEnd).toBe(true);
  expect(header).not.toBeNull();
  const head = header as Buffer;
  const width = head.readUInt32BE(0);
  const height = head.readUInt32BE(4);
  const bitDepth = head[8] as number;
  const colorType = head[9] as number;
  expect(bitDepth).toBe(8);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  expect(channels).toBeGreaterThan(0);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  expect(raw.length).toBe(height * (stride + 1));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[y * (stride + 1) + 1 + i] as number;
      const left = i >= channels ? (pixels[y * stride + i - channels] as number) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + i] as number) : 0;
      const upLeft =
        y > 0 && i >= channels ? (pixels[(y - 1) * stride + i - channels] as number) : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, upLeft);
      pixels[y * stride + i] = (x + predictor) & 0xff;
    }
  }
  return { width, height, bitDepth, colorType, pixels, channels };
}

test('JK-R：玩完到結算頁，選「存成圖片」會下載檔名帶種子的 PNG（合法、320×240、色盤內、不是單色）', async ({
  page,
}) => {
  await page.goto('/?card=JK-R&seed=7&autoplay=human-model');
  const mirror = page.locator('#mirror');
  await expect(mirror).toHaveAttribute('data-screen', 'result', { timeout: 60_000 });
  await expect(mirror).toHaveAttribute('data-card', 'JK-R');
  await expect(page.getByTestId('result-headline')).toHaveText('畫完了');

  // 選單：看重播、存成圖片、再一次、回牌桌。往下一格就是「存成圖片」。
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150); // 同一幀的方向鍵與確認會被當成只有方向鍵。
  const downloading = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('JK-R-seed-7.png');
  await expect(page.getByTestId('result-saved')).toHaveText('JK-R-seed-7.png');

  const path = await download.path();
  const png = decodePng(readFileSync(path));
  expect(png.width).toBe(320);
  expect(png.height).toBe(240);

  const palette = new Set(
    PALETTE.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',')),
  );
  const colors = new Map<string, number>();
  let translucent = 0;
  for (let i = 0; i < png.width * png.height; i += 1) {
    const base = i * png.channels;
    const key = `${png.pixels[base]},${png.pixels[base + 1]},${png.pixels[base + 2]}`;
    colors.set(key, (colors.get(key) ?? 0) + 1);
    if (png.channels === 4 && png.pixels[base + 3] !== 255) {
      translucent += 1;
    }
  }
  expect(translucent).toBe(0);
  // 每個顏色都是色盤裡的；畫面上不只一種顏色（不是空白也不是全黑）。
  for (const key of colors.keys()) {
    expect(palette.has(key)).toBe(true);
  }
  expect(colors.size).toBeGreaterThan(2);
  expect(colors.has('0,0,0')).toBe(false);
});

test('一般牌的結算頁仍是 3 項選單（沒有存成圖片）', async ({ page }) => {
  await page.goto('/?card=C-A&seed=1&autoplay=human-model');
  await expect(page.locator('#mirror')).toHaveAttribute('data-screen', 'result', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('result-saved')).toHaveCount(0);
  // C-A 的結算頁往下兩格是「回牌桌」（3 項），不會下載任何東西。
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await expect(page.locator('#mirror')).toHaveAttribute('data-screen', 'table');
});
