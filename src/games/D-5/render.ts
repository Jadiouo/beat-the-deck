import { COLOR } from '../../shell/palette';
import { drawArena, drawDisc, drawScores } from '../_diamonds/draw';
import { CELL_SIZE, cellX, cellY } from '../_diamonds/logic';
import { worthOf } from './logic';
import type { Carry, D5State } from './logic';

/** 三種貨的顏色：紅、綠、藍（只用色盤裡的顏色）。 */
const PARCEL_COLORS = [COLOR.hearts, COLOR.clubs, COLOR.spades] as const;
const PARCEL_DARK = [COLOR.heartsDark, COLOR.clubsDark, COLOR.spadesDark] as const;
/** 一秒 = 60 tick，倉庫上的倒數用「秒」。 */
const TICKS_PER_SECOND = 60;

function colorOf(index: number): string {
  return PARCEL_COLORS[index] ?? COLOR.light;
}

function drawCarry(
  ctx: CanvasRenderingContext2D,
  state: D5State,
  side: 0 | 1,
  carry: Carry | null,
): void {
  if (carry === null) {
    return;
  }
  // 背著的貨：在角色的格子上畫一個貨色的小方塊（人在左下、AI 在右上角），旁邊標價值。
  const walker = state.players[side];
  const x = cellX(walker.cell) * CELL_SIZE;
  const y = cellY(walker.cell) * CELL_SIZE;
  ctx.fillStyle = colorOf(carry.colour);
  ctx.fillRect(x + 2, y + 2, CELL_SIZE - 4, CELL_SIZE - 4);
  ctx.fillStyle = COLOR.bg;
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${carry.worth}`, x + CELL_SIZE / 2, y + CELL_SIZE / 2 + 0.5);
}

/**
 * D-5 的畫面：完整資訊。倉庫是貨色的方框，休息中填暗色並顯示倒數的秒數；包裹是貨色的圓點，上面標價值；
 * 背著貨的角色身上有一個貨色的小方塊與價值。上方左右是分數。只畫規則公開的資訊。
 */
export function d5Render(ctx: CanvasRenderingContext2D, state: D5State): void {
  drawArena(ctx, state);
  state.depots.forEach((depot, colour) => {
    const x = cellX(depot) * CELL_SIZE;
    const y = cellY(depot) * CELL_SIZE;
    const rest = state.cool[colour] as number;
    ctx.fillStyle = rest > 0 ? COLOR.dark : PARCEL_DARK[colour as 0 | 1 | 2];
    ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
    ctx.strokeStyle = rest > 0 ? COLOR.mid : colorOf(colour);
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
    if (rest > 0) {
      ctx.fillStyle = COLOR.fg;
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        `${Math.ceil(rest / TICKS_PER_SECOND)}`,
        x + CELL_SIZE / 2,
        y + CELL_SIZE / 2 + 0.5,
      );
    }
  });
  for (const parcel of state.parcels) {
    drawDisc(ctx, parcel.cell, 4, colorOf(parcel.colour));
    ctx.fillStyle = COLOR.bg;
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `${worthOf(state.walls, state.depots[parcel.colour] as number, parcel.cell)}`,
      cellX(parcel.cell) * CELL_SIZE + CELL_SIZE / 2,
      cellY(parcel.cell) * CELL_SIZE + CELL_SIZE / 2 + 0.5,
    );
  }
  drawCarry(ctx, state, 0, state.carry[0]);
  drawCarry(ctx, state, 1, state.carry[1]);
  drawScores(ctx, state);
}
