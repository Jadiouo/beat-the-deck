import { pngFileName } from '../games/JK-R/logic';
import type { JkrState } from '../games/JK-R/logic';
import { canvasToRgba } from '../games/JK-R/render';

/**
 * JK-R 存成 PNG（SPEC 第 11 節：結束畫面可以把畫布存成 PNG，檔名帶種子）。
 *
 * 流程：`canvasToRgba(state)`（純函式，色號 → 色盤 RGBA）→ `new ImageData` → 畫到離屏 canvas →
 * `toBlob('image/png')` → 用 `pngFileName(state)` 當檔名下載。
 * 瀏覽器才有的東西（`ImageData`、離屏 canvas、下載）都從 `SavePngDeps` 注入，所以前半段可以在 node 測；
 * 真的下載那一步由端到端測試驗證（tests/e2e/jkr-png.spec.ts）。
 */

export interface PngExport {
  readonly fileName: string;
  readonly width: number;
  readonly height: number;
  /** RGBA，長度 width × height × 4。 */
  readonly data: Uint8ClampedArray;
}

/** 把 JK-R 的 state 變成要存的圖：檔名與像素資料（320×240）。純函式。 */
export function jkrPngExport(state: JkrState): PngExport {
  const { width, height, data } = canvasToRgba(state);
  return { fileName: pngFileName(state), width, height, data };
}

export interface PngContextLike {
  putImageData(image: unknown, x: number, y: number): void;
}

export interface PngCanvasLike {
  getContext(type: '2d'): PngContextLike | null;
  toBlob(callback: (blob: Blob | null) => void, type: string): void;
}

export interface SavePngDeps {
  makeImageData(data: Uint8ClampedArray, width: number, height: number): unknown;
  createCanvas(width: number, height: number): PngCanvasLike;
  download(blob: Blob, fileName: string): void;
}

/** 產生 PNG 並下載。成功回傳檔名；產生失敗就拒絕，而且不下載。 */
export function savePng(exported: PngExport, deps: SavePngDeps): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const canvas = deps.createCanvas(exported.width, exported.height);
      const context = canvas.getContext('2d');
      if (context === null) {
        reject(new Error('取不到 2d context'));
        return;
      }
      context.putImageData(
        deps.makeImageData(exported.data, exported.width, exported.height),
        0,
        0,
      );
      canvas.toBlob((blob) => {
        if (blob === null) {
          reject(new Error('toBlob 沒有產生 PNG'));
          return;
        }
        try {
          deps.download(blob, exported.fileName);
          resolve(exported.fileName);
        } catch (error) {
          reject(error instanceof Error ? error : new Error('下載失敗'));
        }
      }, 'image/png');
    } catch (error) {
      reject(error instanceof Error ? error : new Error('存圖失敗'));
    }
  });
}

/** 瀏覽器版本：`ImageData`、離屏的 `<canvas>`、`<a download>`。 */
export function createBrowserPngDeps(): SavePngDeps {
  return {
    makeImageData: (data, width, height) =>
      new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height),
    createCanvas(width, height): PngCanvasLike {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return {
        getContext: (type) => canvas.getContext(type),
        toBlob: (callback, type) => canvas.toBlob(callback, type),
      };
    },
    download(blob, fileName): void {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      // 給瀏覽器一點時間開始下載再釋放。
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  };
}
