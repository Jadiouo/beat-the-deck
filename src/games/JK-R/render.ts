import { COLOR, PALETTE } from '../../shell/palette';
import { HEIGHT, WIDTH, canvasToPixels } from './logic';
import type { JkrState } from './logic';

/**
 * JK-R 的畫面。
 *
 * 畫布逐列掃描，把同色的水平連續像素合併成一條 `fillRect`；空白（色號 0）不畫，背景一次填滿。
 * 這樣整張畫布只用 `fillStyle` 與 `fillRect`（契約測試 R2、R3 看得到每一個顏色與座標），
 * 一般的畫面也只有幾百到幾千條線段，不需要 `putImageData`。
 */
export function jkrRender(ctx: CanvasRenderingContext2D, state: JkrState): void {
  ctx.fillStyle = PALETTE[0] as string;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const { pixels } = canvasToPixels(state);
  let current = -1;
  for (let y = 0; y < HEIGHT; y += 1) {
    let x = 0;
    while (x < WIDTH) {
      const color = pixels[y * WIDTH + x] as number;
      let end = x + 1;
      while (end < WIDTH && pixels[y * WIDTH + end] === color) {
        end += 1;
      }
      if (color !== 0) {
        if (color !== current) {
          ctx.fillStyle = PALETTE[color] as string;
          current = color;
        }
        ctx.fillRect(x, y, end - x, 1);
      }
      x = end;
    }
  }

  // 四支筆的游標：人是白色十字，AI 各一個小方框。
  ctx.fillStyle = COLOR.fg;
  ctx.fillRect(state.human.x - 4, state.human.y, 9, 1);
  ctx.fillRect(state.human.x, state.human.y - 4, 1, 9);
  ctx.fillStyle = COLOR.accent;
  for (const pen of [state.follower, state.filler, state.contrarian]) {
    ctx.fillRect(pen.x - 2, pen.y - 2, 5, 1);
    ctx.fillRect(pen.x - 2, pen.y + 2, 5, 1);
    ctx.fillRect(pen.x - 2, pen.y - 1, 1, 3);
    ctx.fillRect(pen.x + 2, pen.y - 1, 1, 3);
  }

  // 剩餘時間條（畫在最下面一列）。
  const left = state.maxTicks === 0 ? 0 : 1 - state.tick / state.maxTicks;
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(0, HEIGHT - 2, WIDTH, 2);
  ctx.fillStyle = COLOR.joker;
  ctx.fillRect(0, HEIGHT - 2, Math.round(WIDTH * left), 2);
}

/**
 * 畫布轉成 RGBA 資料，可以直接 `new ImageData(data, width, height)` 寫進 canvas、再 `toBlob` 存成 PNG。
 * 純函式，不碰任何瀏覽器 API；存檔的 UI 在 `src/shell/`（本任務沒做）。空白（色號 0）是色盤的第 0 色。
 */
export function canvasToRgba(state: JkrState): {
  width: number;
  height: number;
  data: Uint8ClampedArray;
} {
  const { width, height, pixels } = canvasToPixels(state);
  const rgb = PALETTE.map((hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 1) {
    const color = rgb[pixels[i] as number] as number[];
    data[i * 4] = color[0] as number;
    data[i * 4 + 1] = color[1] as number;
    data[i * 4 + 2] = color[2] as number;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
