import { COLOR } from '../../shell/palette';
import { drawBoard, drawScores } from '../_clubs/draw';
import { CELL_SIZE, cellX, cellY, HEIGHT, WIDTH } from '../_clubs/logic';
import type { C8State } from './logic';

/**
 * C-8 的畫面：完整資訊。人是梅花綠、AI 是青，軌跡暗、蛇頭亮（`drawBoard`），出局的蛇變灰。
 * 蛇頭有一圈亮色外框；上方各兩個小方塊表示兩邊贏的局數；開局不動時間外圈橘色邊框閃爍；
 * 最上面一條細線表示這一局已經過了多少時間。只讀 state，只用色盤顏色，畫面上不放中文字。
 */

const BOARD_WIDTH = WIDTH * CELL_SIZE;
const BOARD_HEIGHT = HEIGHT * CELL_SIZE;
const FRAME_BLINK_TICKS = 10;

export function c8Render(ctx: CanvasRenderingContext2D, state: C8State): void {
  drawBoard(ctx, state);

  for (const snake of state.snakes) {
    const at = snake.body[0] as number;
    ctx.strokeStyle = snake.alive ? COLOR.fg : COLOR.mid;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      cellX(at) * CELL_SIZE + 0.5,
      cellY(at) * CELL_SIZE + 0.5,
      CELL_SIZE - 1,
      CELL_SIZE - 1,
    );
  }

  if (state.roundTick < 0 && Math.floor(-state.roundTick / FRAME_BLINK_TICKS) % 2 === 0) {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(0, 0, BOARD_WIDTH, 2);
    ctx.fillRect(0, BOARD_HEIGHT - 2, BOARD_WIDTH, 2);
    ctx.fillRect(0, 0, 2, BOARD_HEIGHT);
    ctx.fillRect(BOARD_WIDTH - 2, 0, 2, BOARD_HEIGHT);
  }

  const fraction = Math.min(1, Math.max(0, state.roundTick / state.roundTicks));
  ctx.fillStyle = COLOR.light;
  ctx.fillRect(0, 0, Math.round(BOARD_WIDTH * fraction), 2);

  // 兩邊贏的局數：人在左上、AI 在右上。
  drawScores(ctx, state);
}
