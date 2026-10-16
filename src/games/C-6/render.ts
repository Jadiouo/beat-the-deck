import { COLOR } from '../../shell/palette';
import { drawBoard, drawScores } from '../_clubs/draw';
import { CELL_SIZE, cellX, cellY } from '../_clubs/logic';
import { PORTALS, TRANSIT_TICKS, WALL_CELLS, partnerOf } from './logic';
import type { C6State } from './logic';

/**
 * C-6 的畫面：完整資訊。中間的牆（暗綠）、四個門口（第 1 對藍色圓環、第 2 對黃色菱形環，用形狀區分，色盲也分得出來）。
 * 傳送中：蛇頭所在的門口環變暗；出口環閃爍並在下方畫倒數條。被身體堵住的那一對（任何一端被身體占著）環變暗。
 * 無中文字，只用色盤顏色，全部在 320×240 之內。
 */

function centerOf(index: number): [number, number] {
  return [cellX(index) * CELL_SIZE + CELL_SIZE / 2, cellY(index) * CELL_SIZE + CELL_SIZE / 2];
}

function ring(ctx: CanvasRenderingContext2D, index: number, diamond: boolean, color: string): void {
  const [cx, cy] = centerOf(index);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (diamond) {
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx + 4, cy);
    ctx.lineTo(cx, cy + 4);
    ctx.lineTo(cx - 4, cy);
    ctx.closePath();
  } else {
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  }
  ctx.stroke();
}

function occupiedByBody(state: C6State, index: number): boolean {
  return state.snakes.some((snake) => snake.body.includes(index));
}

export function c6Render(ctx: CanvasRenderingContext2D, state: C6State): void {
  drawBoard(ctx, state);
  ctx.fillStyle = COLOR.clubsDark;
  for (const wall of WALL_CELLS) {
    ctx.fillRect(cellX(wall) * CELL_SIZE, cellY(wall) * CELL_SIZE, CELL_SIZE, CELL_SIZE);
  }
  const exits = new Set<number>();
  for (const transit of state.transit) {
    if (transit !== null) {
      exits.add(transit.to);
    }
  }
  for (const portal of PORTALS) {
    const diamond = portal.pair === 1;
    const lit = portal.pair === 1 ? COLOR.diamonds : COLOR.spades;
    const blocked =
      occupiedByBody(state, portal.cell) || occupiedByBody(state, partnerOf(portal.cell));
    const flashing = exits.has(portal.cell) && Math.floor(state.tick / 6) % 2 === 0;
    ring(
      ctx,
      portal.cell,
      diamond,
      blocked && !exits.has(portal.cell) ? COLOR.mid : flashing ? COLOR.fg : lit,
    );
  }
  for (const transit of state.transit) {
    if (transit === null) {
      continue;
    }
    const left = Math.max(0, Math.min(1, (transit.until - state.tick) / TRANSIT_TICKS));
    const x = cellX(transit.to) * CELL_SIZE;
    const y = cellY(transit.to) * CELL_SIZE + CELL_SIZE + 1;
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(x, y, CELL_SIZE, 2);
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(x, y, Math.max(1, Math.round(CELL_SIZE * left)), 2);
  }
  drawScores(ctx, state);
}
