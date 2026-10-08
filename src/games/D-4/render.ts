import { COLOR } from '../../shell/palette';
import { drawArena, drawDisc, drawScores } from '../_diamonds/draw';
import { CELL_SIZE, cellX, cellY, WIDTH } from '../_diamonds/logic';
import { CAP } from './logic';
import type { D4State } from './logic';

/** 電量條：30 格，每格 3 像素；低於 8 變橘、沒電變紅（只用色盤裡的顏色）。 */
const BAR_CELL = 3;
const BAR_LOW = 8;

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  battery: number,
  base: string,
  leftToRight: boolean,
): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x, y, CAP * BAR_CELL, 4);
  const color = battery <= 0 ? COLOR.hearts : battery < BAR_LOW ? COLOR.warning : base;
  const width = battery * BAR_CELL;
  ctx.fillStyle = color;
  ctx.fillRect(leftToRight ? x : x + CAP * BAR_CELL - width, y, width, 4);
}

/**
 * D-4 的畫面：完整資訊。金幣是黃色圓點；站是方框，有 holder 時填上 holder 的顏色（人綠、AI 青）。
 * 上方左右是分數，下面是兩條電量條與數字。只畫規則公開的資訊。
 */
export function d4Render(ctx: CanvasRenderingContext2D, state: D4State): void {
  drawArena(ctx, state);
  for (const coin of state.coins) {
    drawDisc(ctx, coin, 3, COLOR.diamonds);
  }
  state.stations.forEach((station, i) => {
    const x = cellX(station) * CELL_SIZE;
    const y = cellY(station) * CELL_SIZE;
    const holder = state.holder[i] as number;
    ctx.strokeStyle = holder < 0 ? COLOR.light : holder === 0 ? COLOR.clubs : COLOR.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
    if (holder >= 0) {
      ctx.fillStyle = holder === 0 ? COLOR.clubsDark : COLOR.dark;
      ctx.fillRect(x + 3, y + 3, CELL_SIZE - 6, CELL_SIZE - 6);
    }
  });
  // 角色畫在站上面（站的框不蓋住人）。
  for (const [index, walker] of state.players.entries()) {
    ctx.fillStyle = index === 0 ? COLOR.clubs : COLOR.accent;
    ctx.fillRect(
      cellX(walker.cell) * CELL_SIZE +
        (state.players[0].cell === state.players[1].cell ? index * 5 : 0),
      cellY(walker.cell) * CELL_SIZE,
      state.players[0].cell === state.players[1].cell ? 5 : CELL_SIZE,
      CELL_SIZE,
    );
  }
  drawScores(ctx, state);
  drawBar(ctx, 14, 16, state.battery[0], COLOR.clubs, true);
  drawBar(ctx, WIDTH * CELL_SIZE - 14 - CAP * BAR_CELL, 16, state.battery[1], COLOR.accent, false);
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR.fg;
  ctx.textAlign = 'left';
  ctx.fillText(`${state.battery[0]}`, 14, 22);
  ctx.textAlign = 'right';
  ctx.fillText(`${state.battery[1]}`, WIDTH * CELL_SIZE - 14, 22);
}
