import { COLOR } from '../../shell/palette';
import { drawArena, drawScores } from '../_diamonds/draw';
import { CELL_SIZE, WIDTH, cellX, cellY } from '../_diamonds/logic';
import { CAP, SHIP_TICKS, bagWeight } from './logic';
import type { D10State, Good } from './logic';

/**
 * D-10 的畫面：完整資訊。帶子是一圈淺色的小框；貨是一塊方塊，邊長隨重量增加（重量 1 到 4 → 5 到 10 像素），
 * 顏色隨價值（1 到 3 暗黃、4 到 6 黃、7 到 9 亮），裡面的數字是價值，底下的小方點是重量。
 * 預告：貨出現前 60 tick 在那一格畫閃爍的橘框，旁邊標「價值／重量」。
 * 上方左右是分數；分數下面是背包重量條（共 8 格），出貨中換成倒數條與秒數。只畫規則公開的資訊。
 */

const TICKS_PER_SECOND = 60;
const BAR_CELL = 4;
const BAR_W = CAP * BAR_CELL;

function valueColor(v: number): string {
  return v >= 7 ? COLOR.fg : v >= 4 ? COLOR.diamonds : COLOR.diamondsDark;
}

function drawGood(ctx: CanvasRenderingContext2D, good: Good): void {
  const cx = cellX(good.cell) * CELL_SIZE + CELL_SIZE / 2;
  const cy = cellY(good.cell) * CELL_SIZE + CELL_SIZE / 2;
  const size = Math.min(CELL_SIZE, 3 + 2 * good.w);
  ctx.fillStyle = valueColor(good.v);
  ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
  ctx.fillStyle = COLOR.bg;
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${good.v}`, cx, cy + 0.5);
}

function drawBag(
  ctx: CanvasRenderingContext2D,
  state: D10State,
  side: 0 | 1,
  x: number,
  y: number,
): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x, y, BAR_W, 5);
  const ship = state.ship[side] as number;
  if (ship > 0) {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(x, y, (BAR_W * ship) / SHIP_TICKS, 5);
    ctx.fillStyle = COLOR.warning;
    ctx.font = '8px monospace';
    ctx.textAlign = side === 0 ? 'left' : 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${Math.ceil(ship / TICKS_PER_SECOND)}`, side === 0 ? x : x + BAR_W, y + 6);
    return;
  }
  ctx.fillStyle = side === 0 ? COLOR.clubs : COLOR.accent;
  ctx.fillRect(x, y, bagFill(bagWeight(state.bag[side])), 5);
  ctx.strokeStyle = COLOR.mid;
  ctx.lineWidth = 1;
  for (let i = 1; i < CAP; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x + i * BAR_CELL, y);
    ctx.lineTo(x + i * BAR_CELL, y + 5);
    ctx.stroke();
  }
}

function bagFill(weight: number): number {
  return Math.min(CAP, weight) * BAR_CELL;
}

export function d10Render(ctx: CanvasRenderingContext2D, state: D10State): void {
  drawArena(ctx, state);

  // 帶子：每一格畫一個淺色的小框（角色腳下的格子之後會被角色蓋住的部分不重畫）。
  ctx.strokeStyle = COLOR.mid;
  ctx.lineWidth = 1;
  for (const c of state.ring) {
    ctx.strokeRect(
      cellX(c) * CELL_SIZE + 1.5,
      cellY(c) * CELL_SIZE + 1.5,
      CELL_SIZE - 3,
      CELL_SIZE - 3,
    );
  }

  // 預告：閃爍的框與「價值／重量」。
  const up = state.upcoming;
  if (up !== null) {
    const c = state.ring[up.idx] as number;
    const x = cellX(c) * CELL_SIZE;
    const y = cellY(c) * CELL_SIZE;
    if (Math.floor(state.tick / 10) % 2 === 0) {
      ctx.strokeStyle = COLOR.warning;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
    }
    ctx.fillStyle = COLOR.warning;
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${up.v}/${up.w}`, x + CELL_SIZE / 2, y - 1);
  }

  for (const good of state.belt) {
    drawGood(ctx, good);
  }

  drawScores(ctx, state);
  drawBag(ctx, state, 0, 14, 16);
  drawBag(ctx, state, 1, WIDTH * CELL_SIZE - 14 - BAR_W, 16);
}
