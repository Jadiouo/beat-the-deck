import { COLOR } from '../../shell/palette';
import { drawBoard } from '../_clubs/draw';
import { CELL_SIZE, cellX, cellY, HEIGHT, WIDTH } from '../_clubs/logic';
import { AIM_EVERY } from './logic';
import type { C10State } from './logic';

/**
 * C-10 的畫面：完整資訊。逃的蛇的蛇頭有一圈亮色外框，追的蛇是一個紅色的菱形（沒有身體）；
 * 人在逃（0 號邊逃）時，AI 在追，畫出追的蛇現在瞄準的那一格（橘色十字）。
 * 只讀 state，只用色盤顏色，全部畫在 320×240 之內。畫面上不放中文字。
 */

const BOARD_WIDTH = WIDTH * CELL_SIZE;
const BOARD_HEIGHT = HEIGHT * CELL_SIZE;
/** 下一次瞄準之前，記號開始閃爍的 tick 數。 */
const AIM_WARNING_TICKS = 6;
/** 閃爍：每幾個 tick 亮暗交替一次。 */
const BLINK_TICKS = 2;
const FRAME_BLINK_TICKS = 10;

function drawDiamond(ctx: CanvasRenderingContext2D, index: number, color: string): void {
  const centerX = cellX(index) * CELL_SIZE + CELL_SIZE / 2;
  const centerY = cellY(index) * CELL_SIZE + CELL_SIZE / 2;
  const radius = CELL_SIZE / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(centerX, centerY - radius);
  ctx.lineTo(centerX + radius, centerY);
  ctx.lineTo(centerX, centerY + radius);
  ctx.lineTo(centerX - radius, centerY);
  ctx.closePath();
  ctx.fill();
}

function drawAim(ctx: CanvasRenderingContext2D, state: C10State): void {
  const x = cellX(state.aim) * CELL_SIZE;
  const y = cellY(state.aim) * CELL_SIZE;
  ctx.fillStyle = COLOR.warning;
  ctx.fillRect(x + 4, y, 2, CELL_SIZE);
  ctx.fillRect(x, y + 4, CELL_SIZE, 2);
}

export function c10Render(ctx: CanvasRenderingContext2D, state: C10State): void {
  drawBoard(ctx, state);

  const runner = state.snakes[state.runner];
  const chaser = state.snakes[state.runner === 0 ? 1 : 0];

  // 追的蛇：一個菱形，蓋在 `drawBoard` 畫的蛇頭上；出局的是灰色。
  drawDiamond(ctx, chaser.body[0] as number, chaser.alive ? COLOR.hearts : COLOR.mid);

  // 逃的蛇：蛇頭一圈亮色外框。
  ctx.strokeStyle = runner.alive ? COLOR.fg : COLOR.mid;
  ctx.lineWidth = 1;
  ctx.strokeRect(
    cellX(runner.body[0] as number) * CELL_SIZE + 0.5,
    cellY(runner.body[0] as number) * CELL_SIZE + 0.5,
    CELL_SIZE - 1,
    CELL_SIZE - 1,
  );

  // 追的蛇（AI）現在瞄準的那一格：下一次瞄準之前 6 個 tick 閃爍。
  const playing = !state.over && state.pause === 0 && state.outcome === null;
  if (playing && state.runner === 0) {
    const sinceAim = state.roundTick > 0 ? state.roundTick % AIM_EVERY : 0;
    const blinking = state.roundTick > 0 && sinceAim >= AIM_EVERY - AIM_WARNING_TICKS;
    if (!blinking || Math.floor(state.roundTick / BLINK_TICKS) % 2 === 0) {
      drawAim(ctx, state);
    }
  }

  // 開局不動時間：最外圈的橘色邊框閃爍。
  if (state.roundTick < 0 && Math.floor(-state.roundTick / FRAME_BLINK_TICKS) % 2 === 0) {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(0, 0, BOARD_WIDTH, 2);
    ctx.fillRect(0, BOARD_HEIGHT - 2, BOARD_WIDTH, 2);
    ctx.fillRect(0, 0, 2, BOARD_HEIGHT);
    ctx.fillRect(BOARD_WIDTH - 2, 0, 2, BOARD_HEIGHT);
  }

  // 這一局已經過了多少時間：最上面一條細線。
  const fraction = Math.min(1, Math.max(0, state.roundTick / state.roundTicks));
  ctx.fillStyle = COLOR.light;
  ctx.fillRect(0, 0, Math.round(BOARD_WIDTH * fraction), 2);

  // 兩局的進度：中間兩個小方塊，完成的填滿。
  for (const round of [0, 1] as const) {
    const done = state.round > round || (state.round === round && state.outcome !== null);
    ctx.fillStyle = done ? COLOR.fg : COLOR.dark;
    ctx.fillRect(150 + round * 12, 4, 8, 8);
  }

  // 兩邊累積的分數（秒）：人在左上、AI 在右上。
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR.clubs;
  ctx.textAlign = 'left';
  ctx.fillText(String(Math.floor(state.snakes[0].score / 60)), 6, 4);
  ctx.fillStyle = COLOR.accent;
  ctx.textAlign = 'right';
  ctx.fillText(String(Math.floor(state.snakes[1].score / 60)), BOARD_WIDTH - 6, 4);
}
