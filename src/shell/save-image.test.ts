import { describe, expect, it } from 'vitest';

import { emptyButtons } from './input';
import { PALETTE } from './palette';
import { jkrPngExport, savePng } from './save-image';
import type { PngCanvasLike, SavePngDeps } from './save-image';
import { jkrGame, canvasToPixels, pngFileName } from '../games/JK-R/logic';
import type { JkrState } from '../games/JK-R/logic';

/** 讓人那支筆一路往右下畫、AI 筆自己跑，畫幾百個 tick，畫布上就有好幾種顏色。 */
function drawnState(seed: number, ticks = 900): JkrState {
  let state = jkrGame.init(seed, { maxTicks: 5400, params: {} });
  for (let t = 0; t < ticks; t += 1) {
    const human = {
      ...emptyButtons(),
      a: true,
      b: t % 120 === 0,
      right: t % 400 < 300,
      down: t % 3 === 0,
      left: t % 400 >= 300,
    };
    state = jkrGame.step(state, [human, emptyButtons()]);
  }
  return state;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function fakeDeps(options: { blob?: Blob | null; context?: boolean } = {}): {
  deps: SavePngDeps;
  imageDataCalls: Array<{ data: Uint8ClampedArray; width: number; height: number }>;
  canvases: Array<{ width: number; height: number; put: unknown[]; mime: string[] }>;
  downloads: Array<{ blob: Blob; fileName: string }>;
} {
  const imageDataCalls: Array<{ data: Uint8ClampedArray; width: number; height: number }> = [];
  const canvases: Array<{ width: number; height: number; put: unknown[]; mime: string[] }> = [];
  const downloads: Array<{ blob: Blob; fileName: string }> = [];
  const deps: SavePngDeps = {
    makeImageData(data, width, height) {
      imageDataCalls.push({ data, width, height });
      return { tag: 'image-data', data, width, height };
    },
    createCanvas(width, height): PngCanvasLike {
      const record = { width, height, put: [] as unknown[], mime: [] as string[] };
      canvases.push(record);
      return {
        getContext: () =>
          options.context === false
            ? null
            : {
                putImageData(image: unknown, x: number, y: number): void {
                  record.put.push({ image, x, y });
                },
              },
        toBlob(callback, mime): void {
          record.mime.push(mime);
          callback(options.blob === undefined ? new Blob(['png']) : options.blob);
        },
      };
    },
    download(blob, fileName): void {
      downloads.push({ blob, fileName });
    },
  };
  return { deps, imageDataCalls, canvases, downloads };
}

describe('shell/save-image：JK-R 存成 PNG（SPEC 第 11 節）', () => {
  it('檔名帶種子：JK-R-seed-<種子>.png，與 logic 的 pngFileName 一致', () => {
    const state = drawnState(42, 10);
    expect(jkrPngExport(state).fileName).toBe('JK-R-seed-42.png');
    expect(jkrPngExport(state).fileName).toBe(pngFileName(state));
    expect(jkrPngExport(drawnState(7, 10)).fileName).toBe('JK-R-seed-7.png');
  });

  it('像素資料是 320×240 的 RGBA（長度 320×240×4）', () => {
    const exported = jkrPngExport(drawnState(3, 50));
    expect(exported.width).toBe(320);
    expect(exported.height).toBe(240);
    expect(exported.data.length).toBe(320 * 240 * 4);
  });

  it('每個像素的色號都對到色盤的 RGB，alpha 是 255；畫過之後不只一種顏色', () => {
    const state = drawnState(5);
    const { pixels } = canvasToPixels(state);
    const { data } = jkrPngExport(state);
    const used = new Set<number>();
    for (let i = 0; i < pixels.length; i += 1) {
      const index = pixels[i] as number;
      used.add(index);
      const [r, g, b] = hexToRgb(PALETTE[index] as string);
      expect([data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]]).toEqual([
        r,
        g,
        b,
        255,
      ]);
    }
    expect(used.size).toBeGreaterThan(2);
  });

  it('savePng：用 ImageData 畫到 320×240 的離屏 canvas，toBlob 成 image/png，用檔名交給下載', async () => {
    const { deps, imageDataCalls, canvases, downloads } = fakeDeps();
    const exported = jkrPngExport(drawnState(11, 60));
    const name = await savePng(exported, deps);

    expect(name).toBe('JK-R-seed-11.png');
    expect(imageDataCalls).toHaveLength(1);
    expect(imageDataCalls[0]?.width).toBe(320);
    expect(imageDataCalls[0]?.height).toBe(240);
    expect(imageDataCalls[0]?.data).toBe(exported.data);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]?.width).toBe(320);
    expect(canvases[0]?.height).toBe(240);
    expect(canvases[0]?.put).toHaveLength(1);
    expect(canvases[0]?.put[0]).toMatchObject({ x: 0, y: 0, image: { tag: 'image-data' } });
    expect(canvases[0]?.mime).toEqual(['image/png']);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.fileName).toBe('JK-R-seed-11.png');
    expect(downloads[0]?.blob).toBeInstanceOf(Blob);
  });

  it('產生失敗（toBlob 給 null、取不到 2d context）：拒絕，而且不會下載', async () => {
    const noBlob = fakeDeps({ blob: null });
    await expect(savePng(jkrPngExport(drawnState(1, 5)), noBlob.deps)).rejects.toThrow();
    expect(noBlob.downloads).toHaveLength(0);

    const noContext = fakeDeps({ context: false });
    await expect(savePng(jkrPngExport(drawnState(1, 5)), noContext.deps)).rejects.toThrow();
    expect(noContext.downloads).toHaveLength(0);
  });

  it('連存兩次：各自獨立，不會互相干擾', async () => {
    const { deps, downloads } = fakeDeps();
    await savePng(jkrPngExport(drawnState(2, 5)), deps);
    await savePng(jkrPngExport(drawnState(2, 5)), deps);
    expect(downloads.map((d) => d.fileName)).toEqual(['JK-R-seed-2.png', 'JK-R-seed-2.png']);
  });
});
