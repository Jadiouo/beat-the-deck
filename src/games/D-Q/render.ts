import { COLOR } from '../../shell/palette';
import { drawArena, drawScores } from '../_diamonds/draw';
import { CELL_SIZE, cellX, cellY, HEIGHT, WIDTH } from '../_diamonds/logic';
import { hazardPermille, ZONE_RADIUS } from './logic';
import type { DQState } from './logic';

/** 在某一格中心畫一個菱形（實心或空心）。 */
function diamond(
  ctx: CanvasRenderingContext2D,
  index: number,
  radius: number,
  color: string,
  filled: boolean,
): void {
  const cx = cellX(index) * CELL_SIZE + CELL_SIZE / 2;
  const cy = cellY(index) * CELL_SIZE + CELL_SIZE / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx + radius, cy);
  ctx.lineTo(cx, cy + radius);
  ctx.lineTo(cx - radius, cy);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** D-Q 的畫面：完整資訊。礦坑範圍用暗色方框圈出；礦越舊越偏橘；下一個礦是空心菱形；上方是分數與身上的礦石，中間是塌的機率。 */
export function dQRender(ctx: CanvasRenderingContext2D, state: DQState): void {
  drawArena(ctx, state);
  // 礦坑範圍的方框（貼著地圖邊緣時裁掉出界的部分）。
  const left = Math.max(0, (cellX(state.mine) - ZONE_RADIUS) * CELL_SIZE);
  const top = Math.max(0, (cellY(state.mine) - ZONE_RADIUS) * CELL_SIZE);
  const right = Math.min(WIDTH * CELL_SIZE, (cellX(state.mine) + ZONE_RADIUS + 1) * CELL_SIZE);
  const bottom = Math.min(HEIGHT * CELL_SIZE, (cellY(state.mine) + ZONE_RADIUS + 1) * CELL_SIZE);
  ctx.strokeStyle = COLOR.mid;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, bottom - top - 1);
  diamond(ctx, state.next, 4.5, COLOR.light, false);
  const hazard = hazardPermille(state.age + 1);
  diamond(ctx, state.mine, 5, hazard >= 350 ? COLOR.warning : COLOR.diamonds, true);
  const label = (carried: number): string => (carried > 0 ? ` +${carried}` : '');
  drawScores(ctx, state, [label(state.carried[0]), label(state.carried[1])]);
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = hazard >= 350 ? COLOR.warning : COLOR.light;
  ctx.fillText(`${Math.round(hazard / 10)}%`, 160, 4);
}
