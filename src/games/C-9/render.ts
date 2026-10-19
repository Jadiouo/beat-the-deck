import { COLOR } from '../../shell/palette';
import { CELL_SIZE, cellX, cellY, HEIGHT, WIDTH } from '../_clubs/logic';
import type { Snake } from '../_clubs/logic';
import { PAUSE, ROUNDS, layoutOf } from './logic';
import type { C9State, RoundOutcome } from './logic';

/**
 * C-9 的畫面：完整資訊。迷宮佔左上 31×23 格，最下面那一列（y = 230 到 240）是狀態列：
 * 左邊人的總分、右邊 AI 的總分、中間四個小方塊表示四局（完成的填上贏家的顏色，平手與僵局是灰色，
 * 這一局有外框）、最底下一條細線表示這一局已經過了多久。無中文字，只用色盤顏色。
 */

const MAZE_HEIGHT = (HEIGHT - 1) * CELL_SIZE;
const HUD_Y = MAZE_HEIGHT;
const HUMAN_HEAD = COLOR.clubs;
const HUMAN_BODY = COLOR.clubsDark;
const AI_HEAD = COLOR.accent;
const AI_BODY = COLOR.spadesDark;

function cellRect(ctx: CanvasRenderingContext2D, index: number, inset: number): void {
  ctx.fillRect(
    cellX(index) * CELL_SIZE + inset,
    cellY(index) * CELL_SIZE + inset,
    CELL_SIZE - inset * 2,
    CELL_SIZE - inset * 2,
  );
}

/** 鑰匙：金色的菱形。 */
function drawKey(ctx: CanvasRenderingContext2D, index: number, inset: number): void {
  const x = cellX(index) * CELL_SIZE + inset;
  const y = cellY(index) * CELL_SIZE + inset;
  const size = CELL_SIZE - inset * 2;
  const mid = Math.floor(size / 2);
  ctx.fillStyle = COLOR.diamonds;
  ctx.fillRect(x + mid - 1, y, 2, size);
  ctx.fillRect(x + 1, y + mid - 1, size - 2, 2);
  ctx.fillRect(x + 2, y + 2, size - 4, size - 4);
}

function drawSnake(
  ctx: CanvasRenderingContext2D,
  snake: Snake,
  headColor: string,
  bodyColor: string,
): void {
  ctx.fillStyle = snake.alive ? bodyColor : COLOR.mid;
  for (let i = snake.body.length - 1; i >= 1; i -= 1) {
    cellRect(ctx, snake.body[i] as number, 1);
  }
  ctx.fillStyle = snake.alive ? headColor : COLOR.light;
  cellRect(ctx, snake.body[0] as number, 0);
}

function outcomeColor(outcome: RoundOutcome | undefined): string {
  if (outcome === 'side0') {
    return HUMAN_HEAD;
  }
  if (outcome === 'side1') {
    return AI_HEAD;
  }
  return COLOR.mid;
}

function drawHud(ctx: CanvasRenderingContext2D, state: C9State): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(0, HUD_Y, WIDTH * CELL_SIZE, HEIGHT * CELL_SIZE - HUD_Y);
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = HUMAN_HEAD;
  ctx.textAlign = 'left';
  ctx.fillText(String(state.snakes[0].score), 6, HUD_Y);
  ctx.fillStyle = AI_HEAD;
  ctx.textAlign = 'right';
  ctx.fillText(String(state.snakes[1].score), WIDTH * CELL_SIZE - 6, HUD_Y);

  // 四局：完成的填色，這一局有外框
  const finished = state.outcome !== null || state.over ? state.round + 1 : state.round;
  const left = (WIDTH * CELL_SIZE - ROUNDS * 14) / 2;
  for (let round = 0; round < ROUNDS; round += 1) {
    const x = left + round * 14;
    if (round < finished) {
      ctx.fillStyle =
        round === state.round ? outcomeColor(state.outcome ?? undefined) : COLOR.light;
      ctx.fillRect(x, HUD_Y + 1, 8, 6);
    } else {
      ctx.fillStyle = COLOR.bg;
      ctx.fillRect(x, HUD_Y + 1, 8, 6);
    }
    if (round === state.round && !state.over) {
      ctx.fillStyle = COLOR.fg;
      ctx.fillRect(x - 1, HUD_Y, 10, 1);
      ctx.fillRect(x - 1, HUD_Y + 7, 10, 1);
    }
  }

  // 這一局已經過了多久（停頓時是停頓還剩多少）
  const fraction =
    state.pause > 0 ? state.pause / PAUSE : Math.max(0, state.roundTick) / state.roundTicks;
  ctx.fillStyle = state.pause > 0 ? COLOR.mid : COLOR.warning;
  ctx.fillRect(0, HEIGHT * CELL_SIZE - 2, Math.round(WIDTH * CELL_SIZE * Math.min(1, fraction)), 2);
}

export function c9Render(ctx: CanvasRenderingContext2D, state: C9State): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(0, 0, WIDTH * CELL_SIZE, HEIGHT * CELL_SIZE);

  const layout = layoutOf(state);
  ctx.fillStyle = COLOR.bg;
  for (let c = 0; c < layout.walls.length; c += 1) {
    if (layout.walls.charCodeAt(c) === 46) {
      cellRect(ctx, c, 0);
    }
  }

  // 門：有框的方塊
  ctx.fillStyle = COLOR.fg;
  cellRect(ctx, layout.door, 0);
  ctx.fillStyle = COLOR.bg;
  cellRect(ctx, layout.door, 2);

  if (state.keyHolder === null) {
    drawKey(ctx, state.key, 1);
  }

  drawSnake(ctx, state.snakes[0], HUMAN_HEAD, HUMAN_BODY);
  drawSnake(ctx, state.snakes[1], AI_HEAD, AI_BODY);
  if (state.keyHolder !== null) {
    // 叼著鑰匙：蛇頭上亮著鑰匙
    drawKey(ctx, state.snakes[state.keyHolder].body[0] as number, 2);
  }
  drawHud(ctx, state);
}
