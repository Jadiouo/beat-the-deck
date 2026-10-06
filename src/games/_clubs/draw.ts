import { COLOR } from '../../shell/palette';
import { CELL_SIZE, cellX, cellY, HEIGHT, WIDTH } from './logic';
import type { ClubsState, Snake } from './logic';

/**
 * 梅花共用的畫法：只讀 state，只用色盤裡的顏色，全部畫在 320×240 之內。
 * 這個檔案不是 `logic.ts`，不在純度掃描範圍內，但仍然不碰時鐘與亂數。
 */

const HUMAN_HEAD = COLOR.clubs;
const HUMAN_BODY = COLOR.clubsDark;
const AI_HEAD = COLOR.accent;
const AI_BODY = COLOR.spadesDark;
const DEAD = COLOR.mid;

function drawCell(ctx: CanvasRenderingContext2D, index: number, inset: number): void {
  ctx.fillRect(
    cellX(index) * CELL_SIZE + inset,
    cellY(index) * CELL_SIZE + inset,
    CELL_SIZE - inset * 2,
    CELL_SIZE - inset * 2,
  );
}

function drawSnake(
  ctx: CanvasRenderingContext2D,
  snake: Snake,
  headColor: string,
  bodyColor: string,
): void {
  ctx.fillStyle = snake.alive ? bodyColor : DEAD;
  for (let i = snake.body.length - 1; i >= 1; i -= 1) {
    drawCell(ctx, snake.body[i] as number, 1);
  }
  ctx.fillStyle = snake.alive ? headColor : COLOR.light;
  drawCell(ctx, snake.body[0] as number, 0);
}

/** 背景、外框（牆）、兩條蛇、食物與兩邊的分數數字。 */
export function drawSnakeBoard(ctx: CanvasRenderingContext2D, state: ClubsState): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, WIDTH * CELL_SIZE, HEIGHT * CELL_SIZE);

  // 牆：地圖最外面一圈（畫在格子裡面，不超出畫布）。
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(0, 0, WIDTH * CELL_SIZE, 2);
  ctx.fillRect(0, HEIGHT * CELL_SIZE - 2, WIDTH * CELL_SIZE, 2);
  ctx.fillRect(0, 0, 2, HEIGHT * CELL_SIZE);
  ctx.fillRect(WIDTH * CELL_SIZE - 2, 0, 2, HEIGHT * CELL_SIZE);

  ctx.fillStyle = COLOR.warning;
  for (const food of state.foods) {
    drawCell(ctx, food, 2);
  }

  drawSnake(ctx, state.snakes[0], HUMAN_HEAD, HUMAN_BODY);
  drawSnake(ctx, state.snakes[1], AI_HEAD, AI_BODY);

  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = HUMAN_HEAD;
  ctx.textAlign = 'left';
  ctx.fillText(String(state.snakes[0].score), 6, 4);
  ctx.fillStyle = AI_HEAD;
  ctx.textAlign = 'right';
  ctx.fillText(String(state.snakes[1].score), WIDTH * CELL_SIZE - 6, 4);
}
