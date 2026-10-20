import { COLOR } from '../../shell/palette';
import { drawBoard, drawCell } from '../_clubs/draw';
import { CELL_SIZE, WIDTH, cellX, cellY } from '../_clubs/logic';
import { RELOAD } from './logic';
import type { CQState, Drone } from './logic';

/**
 * C-Q 的畫面：完整資訊。主蛇照貪食蛇（`drawBoard`）；僚機是 3 格的小蛇（頭亮、尾暗，亮度低於主蛇）；
 * `aim` 畫成橘色的 X（更新前 6 tick 閃爍）；被鎖定的蛇閃爍並在頭上畫一個鎖；
 * 分數旁邊的小蛇圖示：亮＝可放，暗＋冷卻條＝冷卻中。無中文字，只用色盤顏色，全部在 320×240 之內。
 */

const MARGIN = 6;
const BAR_WIDTH = 40;
const BAR_Y = 17;

function drawX(ctx: CanvasRenderingContext2D, index: number): void {
  const x = cellX(index) * CELL_SIZE;
  const y = cellY(index) * CELL_SIZE;
  ctx.fillRect(x + 1, y + 1, 2, 2);
  ctx.fillRect(x + 7, y + 1, 2, 2);
  ctx.fillRect(x + 4, y + 4, 2, 2);
  ctx.fillRect(x + 1, y + 7, 2, 2);
  ctx.fillRect(x + 7, y + 7, 2, 2);
}

function drawDrone(ctx: CanvasRenderingContext2D, drone: Drone, tick: number, side: 0 | 1): void {
  const head = side === 0 ? COLOR.clubs : COLOR.accent;
  const tailColor = side === 0 ? COLOR.clubsDark : COLOR.spadesDark;
  ctx.fillStyle = tailColor;
  for (const c of drone.tail) {
    drawCell(ctx, c, 3);
  }
  ctx.fillStyle = head;
  drawCell(ctx, drone.cell, 2);
  // aim 記號：下一次更新前 6 tick 閃爍
  const blinking = drone.nextAim - tick <= 6 && tick % 2 === 0;
  if (!blinking) {
    ctx.fillStyle = COLOR.warning;
    drawX(ctx, drone.aim);
  }
}

function drawLock(ctx: CanvasRenderingContext2D, state: CQState, side: 0 | 1): void {
  if (state.lock[side] === 0 || !state.snakes[side].alive) {
    return;
  }
  if (Math.floor(state.tick / 6) % 2 === 0) {
    ctx.fillStyle = COLOR.light;
    for (const c of state.snakes[side].body) {
      drawCell(ctx, c, 3);
    }
  }
  const head = state.snakes[side].body[0] as number;
  const x = cellX(head) * CELL_SIZE;
  const y = Math.max(2, cellY(head) * CELL_SIZE - 6);
  ctx.fillStyle = COLOR.fg;
  ctx.fillRect(x + 2, y, 6, 4);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x + 4, y + 1, 2, 2);
}

function drawHud(ctx: CanvasRenderingContext2D, state: CQState, side: 0 | 1): void {
  const left = side === 0;
  const color = left ? COLOR.clubs : COLOR.accent;
  const dark = left ? COLOR.clubsDark : COLOR.spadesDark;
  const x = left ? MARGIN : WIDTH * CELL_SIZE - MARGIN - BAR_WIDTH;
  const ready = state.reload[side] === 0 && state.drone[side] === null && state.snakes[side].alive;
  // 小蛇圖示：3 格
  ctx.fillStyle = ready ? color : COLOR.dark;
  ctx.fillRect(x, BAR_Y, 4, 4);
  ctx.fillStyle = ready ? dark : COLOR.dark;
  ctx.fillRect(x + 5, BAR_Y, 4, 4);
  ctx.fillRect(x + 10, BAR_Y, 4, 4);
  if (state.drone[side] !== null) {
    ctx.fillStyle = color;
    ctx.fillRect(x + 16, BAR_Y, 4, 4);
  } else if (state.reload[side] > 0) {
    const filled = Math.round((BAR_WIDTH - 16) * (1 - Math.min(1, state.reload[side] / RELOAD)));
    ctx.fillStyle = COLOR.mid;
    ctx.fillRect(x + 16, BAR_Y + 1, Math.max(1, filled), 2);
  }
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.textAlign = left ? 'left' : 'right';
  ctx.fillText(String(state.snakes[side].score), left ? MARGIN : WIDTH * CELL_SIZE - MARGIN, 4);
}

export function cqRender(ctx: CanvasRenderingContext2D, state: CQState): void {
  drawBoard(ctx, state);
  for (const side of [0, 1] as const) {
    const drone = state.drone[side];
    if (drone !== null) {
      drawDrone(ctx, drone, state.tick, side);
    }
    drawLock(ctx, state, side);
    drawHud(ctx, state, side);
  }
}
