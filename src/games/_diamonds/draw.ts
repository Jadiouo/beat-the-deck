import { COLOR } from '../../shell/palette';
import { CELL_SIZE, cellX, cellY, CELLS, HEIGHT, WIDTH } from './logic';
import type { DiamondsBase } from './logic';

/**
 * 方塊共用的畫法：只讀 state，只用色盤裡的顏色，全部畫在 320×240 之內。
 * 這個檔案不是 `logic.ts`，不在純度掃描範圍內，但仍然不碰時鐘與亂數。
 */

const HUMAN = COLOR.clubs;
const AI = COLOR.accent;

/** 一格的左上角像素座標。 */
function px(index: number): [number, number] {
  return [cellX(index) * CELL_SIZE, cellY(index) * CELL_SIZE];
}

/** 背景、牆、兩個角色。重疊在同一格時各畫一半（人左半、AI 右半）。 */
export function drawArena(ctx: CanvasRenderingContext2D, state: DiamondsBase): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, WIDTH * CELL_SIZE, HEIGHT * CELL_SIZE);

  ctx.fillStyle = COLOR.dark;
  for (let i = 0; i < CELLS; i += 1) {
    if (state.walls[i] === 1) {
      const [x, y] = px(i);
      ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
    }
  }

  const [human, ai] = state.players;
  const [hx, hy] = px(human.cell);
  const [ax, ay] = px(ai.cell);
  if (human.cell === ai.cell) {
    const half = CELL_SIZE / 2;
    ctx.fillStyle = HUMAN;
    ctx.fillRect(hx, hy, half, CELL_SIZE);
    ctx.fillStyle = AI;
    ctx.fillRect(ax + half, ay, half, CELL_SIZE);
  } else {
    ctx.fillStyle = HUMAN;
    ctx.fillRect(hx, hy, CELL_SIZE, CELL_SIZE);
    ctx.fillStyle = AI;
    ctx.fillRect(ax, ay, CELL_SIZE, CELL_SIZE);
  }
}

/** 在某一格中心畫一個圓。 */
export function drawDisc(
  ctx: CanvasRenderingContext2D,
  index: number,
  radius: number,
  color: string,
): void {
  const [x, y] = px(index);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x + CELL_SIZE / 2, y + CELL_SIZE / 2, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** 上方兩邊的數字（人在左上、AI 在右上），可以多帶一小段文字（例如背包）。 */
export function drawScores(
  ctx: CanvasRenderingContext2D,
  state: DiamondsBase,
  extra: readonly [string, string] = ['', ''],
): void {
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR.fg;
  ctx.textAlign = 'left';
  ctx.fillText(`${state.players[0].score}${extra[0]}`, 14, 4);
  ctx.textAlign = 'right';
  ctx.fillText(`${state.players[1].score}${extra[1]}`, WIDTH * CELL_SIZE - 14, 4);
}
