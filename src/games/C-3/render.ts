import { COLOR } from '../../shell/palette';
import { CELL_SIZE, cellX, cellY } from '../_clubs/logic';
import { drawBoard, drawCell, drawScores } from '../_clubs/draw';
import type { C3State, FoodColor } from './logic';
import { RED } from './logic';

/**
 * C-3 的畫面：與 C-A 一樣的完整資訊。紅色食物是紅色方塊、藍色食物是藍色菱形（顏色之外再用形狀區分）；
 * 上方中間的指示燈是現在的正確顏色，`warning` 時每 10 個 tick 在「現在的顏色」與「下一個顏色」之間閃爍。
 */

const RED_FILL = COLOR.hearts;
const BLUE_FILL = COLOR.spades;
/** 指示燈：畫在上方中間的小方塊（寬 20、高 6），外面一圈亮色邊。 */
const LIGHT_X = 150;
const LIGHT_Y = 3;
const LIGHT_WIDTH = 20;
const LIGHT_HEIGHT = 6;
/** 閃爍：每幾個 tick 亮暗交替一次。 */
const BLINK_TICKS = 10;

function fillOf(color: FoodColor): string {
  return color === RED ? RED_FILL : BLUE_FILL;
}

function drawDiamond(ctx: CanvasRenderingContext2D, food: number): void {
  const centerX = cellX(food) * CELL_SIZE + CELL_SIZE / 2;
  const centerY = cellY(food) * CELL_SIZE + CELL_SIZE / 2;
  const radius = CELL_SIZE / 2 - 1;
  ctx.beginPath();
  ctx.moveTo(centerX, centerY - radius);
  ctx.lineTo(centerX + radius, centerY);
  ctx.lineTo(centerX, centerY + radius);
  ctx.lineTo(centerX - radius, centerY);
  ctx.closePath();
  ctx.fill();
}

export function c3Render(ctx: CanvasRenderingContext2D, state: C3State): void {
  drawBoard(ctx, state, (context, food, index) => {
    const color = state.foodColors[index] === RED ? RED : 1;
    context.fillStyle = fillOf(color);
    if (color === RED) {
      drawCell(context, food, 2);
    } else {
      drawDiamond(context, food);
    }
  });
  drawScores(ctx, state);

  const showNext = state.warning && Math.floor(state.tick / BLINK_TICKS) % 2 === 0;
  const shown: FoodColor = showNext ? (state.correct === RED ? 1 : RED) : state.correct;
  ctx.fillStyle = COLOR.light;
  ctx.fillRect(LIGHT_X - 1, LIGHT_Y - 1, LIGHT_WIDTH + 2, LIGHT_HEIGHT + 2);
  ctx.fillStyle = fillOf(shown);
  ctx.fillRect(LIGHT_X, LIGHT_Y, LIGHT_WIDTH, LIGHT_HEIGHT);
}
