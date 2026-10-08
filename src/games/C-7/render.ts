import { COLOR } from '../../shell/palette';
import { drawBoard } from '../_clubs/draw';
import { CELL_SIZE, WIDTH } from '../_clubs/logic';
import { SPRINT_CD, SPRINT_MIN_LEN } from './logic';
import type { C7State } from './logic';

/**
 * C-7 的畫面：完整資訊。上方左右各一條長度條（長度 ÷ 40，上限填滿）加數字，
 * 長度條旁一個小點：亮表示衝刺可用（冷卻中是暗的、旁邊一小段表示剩多少冷卻）。
 * 衝刺那一格在蛇頭後留一條殘影不另外畫（身體本來就接著走）。無中文字，只用色盤顏色。
 */

const BAR_WIDTH = 100;
const BAR_FULL = 40;
const BAR_Y = 15;
const BAR_HEIGHT = 4;
const MARGIN = 6;

function drawSide(ctx: CanvasRenderingContext2D, state: C7State, side: 0 | 1): void {
  const snake = state.snakes[side];
  const color = side === 0 ? COLOR.clubs : COLOR.accent;
  const left = side === 0;
  const x = left ? MARGIN : WIDTH * CELL_SIZE - MARGIN - BAR_WIDTH;
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x, BAR_Y, BAR_WIDTH, BAR_HEIGHT);
  const filled = Math.round(BAR_WIDTH * Math.min(1, snake.score / BAR_FULL));
  ctx.fillStyle = snake.alive ? color : COLOR.mid;
  ctx.fillRect(left ? x : x + BAR_WIDTH - filled, BAR_Y, filled, BAR_HEIGHT);

  const cd = state.sprintCd[side] as number;
  const ready = cd === 0 && snake.alive && snake.body.length >= SPRINT_MIN_LEN;
  const dotX = left ? x + BAR_WIDTH + 6 : x - 10;
  ctx.fillStyle = ready ? COLOR.warning : COLOR.dark;
  ctx.fillRect(dotX, BAR_Y, 4, BAR_HEIGHT);
  if (cd > 0) {
    ctx.fillStyle = COLOR.mid;
    const fraction = Math.min(1, cd / SPRINT_CD);
    ctx.fillRect(dotX, BAR_Y + BAR_HEIGHT + 1, Math.max(1, Math.round(4 * fraction)), 1);
  }

  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.textAlign = left ? 'left' : 'right';
  ctx.fillText(String(snake.score), left ? MARGIN : WIDTH * CELL_SIZE - MARGIN, 4);
}

export function c7Render(ctx: CanvasRenderingContext2D, state: C7State): void {
  drawBoard(ctx, state);
  drawSide(ctx, state, 0);
  drawSide(ctx, state, 1);
}
