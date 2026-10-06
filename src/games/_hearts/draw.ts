import { COLOR } from '../../shell/palette';

/**
 * 紅心共用的畫法：只讀 state，只用色盤裡的顏色，全部畫在 320×240 之內。
 * 這個檔案不是 `logic.ts`，不在純度掃描範圍內，但仍然不碰時鐘與亂數。
 * 畫面上只有數字與圖形（文字集中在 `src/shell/strings.ts`，不在紅心牌的範圍內）。
 */

export const WIDTH = 320;
export const HEIGHT = 240;

export const HUMAN_COLOR = COLOR.hearts;
export const AI_COLOR = COLOR.accent;

export function sideColor(side: 0 | 1): string {
  return side === 0 ? HUMAN_COLOR : AI_COLOR;
}

export function clear(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

/** 數字（等寬字型）。 */
export function number(
  ctx: CanvasRenderingContext2D,
  value: number | string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'left',
): void {
  ctx.font = `${size}px monospace`;
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(String(value), x, y);
}

export function disc(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** 一條橫的進度條：`fraction` 是 0 到 1。 */
export function bar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fraction: number,
  color: string,
): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.round(width * Math.min(1, Math.max(0, fraction))), height);
}

/** 外框（用四個細長方形畫，不用 strokeRect，座標好控制）。 */
export function frame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, 1);
  ctx.fillRect(x, y + height - 1, width, 1);
  ctx.fillRect(x, y, 1, height);
  ctx.fillRect(x + width - 1, y, 1, height);
}

const PIPS: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  1: [[0, 0]],
  2: [
    [-1, -1],
    [1, 1],
  ],
  3: [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
};

/** 骰子：`face` 是 1 到 6（0 畫成空白）。`size` 是邊長，中心在 (cx, cy)。 */
export function drawDie(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  face: number,
  body: string,
  pip: string,
): void {
  ctx.fillStyle = body;
  ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
  const step = size / 4;
  for (const [px, py] of PIPS[face] ?? []) {
    disc(ctx, cx + px * step, cy + py * step, Math.max(1, size / 12), pip);
  }
}
