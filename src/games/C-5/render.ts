import { COLOR } from '../../shell/palette';
import { drawBoard, drawCell, drawScores } from '../_clubs/draw';
import { CELL_SIZE, cellX, cellY } from '../_clubs/logic';
import { nextLandingTick, PREVIEW_TICKS } from './logic';
import type { C5State } from './logic';

/**
 * C-5 的畫面：完整資訊。牆是深灰實心；落點是閃爍的空心方框（最後 20 個 tick 閃得更快）；
 * 誘餌是金色的菱形（在落點格子裡閃）；上方中間一條細線表示下一次落牆還有多久（填滿表示快落下了）。
 * 只讀 state，只用色盤顏色，畫面上不放中文字。
 */

const SLOW_BLINK = 12;
const FAST_BLINK = 4;
const LAST_TICKS = 20;
const TIMER_X = 110;
const TIMER_WIDTH = 100;

function drawDiamond(ctx: CanvasRenderingContext2D, index: number): void {
  const cx = cellX(index) * CELL_SIZE + CELL_SIZE / 2;
  const cy = cellY(index) * CELL_SIZE + CELL_SIZE / 2;
  const r = CELL_SIZE / 2 - 0.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
}

export function c5Render(ctx: CanvasRenderingContext2D, state: C5State): void {
  drawBoard(ctx, state);

  // 牆：深灰實心，邊緣留 1 像素的暗邊，一格一格看得出來。
  for (const bar of state.bars) {
    for (const index of bar) {
      ctx.fillStyle = COLOR.mid;
      drawCell(ctx, index, 0);
      ctx.fillStyle = COLOR.light;
      drawCell(ctx, index, 3);
    }
  }

  const landing = state.landing;
  if (landing !== null) {
    const left = landing.at - state.tick;
    const period = left <= LAST_TICKS ? FAST_BLINK : SLOW_BLINK;
    const on = Math.floor(left / period) % 2 === 0;
    if (on) {
      ctx.strokeStyle = COLOR.warning;
      ctx.lineWidth = 1;
      for (const bar of landing.bars) {
        for (const index of bar) {
          ctx.strokeRect(
            cellX(index) * CELL_SIZE + 1.5,
            cellY(index) * CELL_SIZE + 1.5,
            CELL_SIZE - 3,
            CELL_SIZE - 3,
          );
        }
      }
    }
    if (state.bait !== null && (on || left <= LAST_TICKS)) {
      ctx.fillStyle = COLOR.diamonds;
      drawDiamond(ctx, state.bait.cell);
    }
  }

  // 下一次落牆還有多久：中間一條細線，填滿表示快落下了。
  const nextAt = nextLandingTick(state.tick);
  const fraction = Math.min(1, Math.max(0, 1 - (nextAt - state.tick) / (2.5 * PREVIEW_TICKS)));
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(TIMER_X, 2, TIMER_WIDTH, 2);
  ctx.fillStyle = landing === null ? COLOR.light : COLOR.warning;
  ctx.fillRect(TIMER_X, 2, Math.round(TIMER_WIDTH * fraction), 2);

  drawScores(ctx, state);
}
