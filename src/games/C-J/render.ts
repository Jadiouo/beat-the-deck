import { COLOR } from '../../shell/palette';
import { CELL_SIZE, cellX, cellY, DOWN, HEIGHT, LEFT, RIGHT, UP, WIDTH } from '../_clubs/logic';
import { COOLDOWN_TICKS, legalSides } from './logic';
import type { CJState } from './logic';

/**
 * C-J 的畫面：完整資訊。蛇（人是梅花綠、AI 是青；蛇頭亮、身體暗）、食物（預覽是空心方框、
 * 現身是橘色實心，旁邊一條細線是時限剩餘）、牆（預告中閃爍、變硬後是亮灰）、設計師的冷卻（食物下方的小條）。
 * 人當設計師時，左下角畫四個方向的小箭頭，蓋不下去的方向變暗。只讀 state，只用色盤顏色，全部畫在 320×240 之內。
 * 畫面上不放中文字。
 */

const BOARD_WIDTH = WIDTH * CELL_SIZE;
const BOARD_HEIGHT = HEIGHT * CELL_SIZE;
const BLINK_TICKS = 3;
const FRAME_BLINK_TICKS = 10;

function fillCell(ctx: CanvasRenderingContext2D, index: number, inset: number): void {
  ctx.fillRect(
    cellX(index) * CELL_SIZE + inset,
    cellY(index) * CELL_SIZE + inset,
    CELL_SIZE - inset * 2,
    CELL_SIZE - inset * 2,
  );
}

function drawWalls(ctx: CanvasRenderingContext2D, state: CJState): void {
  for (const wall of state.walls) {
    const pending = wall.ripe > 0;
    if (pending && Math.floor(state.tick / BLINK_TICKS) % 2 === 1) {
      ctx.fillStyle = COLOR.dark;
    } else {
      ctx.fillStyle = pending ? COLOR.warning : COLOR.light;
    }
    for (const c of wall.cells) {
      fillCell(ctx, c, pending ? 2 : 0);
    }
  }
}

function drawFood(ctx: CanvasRenderingContext2D, state: CJState): void {
  if (state.foodIndex >= state.foodSeq.length || state.outcome !== null) {
    return;
  }
  const food = state.foodSeq[state.foodIndex] as number;
  const x = cellX(food) * CELL_SIZE;
  const y = cellY(food) * CELL_SIZE;
  if (state.phase === 'preview') {
    ctx.strokeStyle = COLOR.warning;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 1.5, y + 1.5, CELL_SIZE - 3, CELL_SIZE - 3);
    return;
  }
  ctx.fillStyle = COLOR.warning;
  fillCell(ctx, food, 2);
  // 時限剩餘：食物上方的細線（一格寬 = 10 個像素 = 剩 100% 以上）。
  const fraction = Math.min(1, state.phaseLeft / 240);
  ctx.fillStyle = COLOR.fg;
  ctx.fillRect(x, y - 3, Math.round(CELL_SIZE * fraction), 1);
}

function drawCooldown(ctx: CanvasRenderingContext2D, state: CJState): void {
  if (state.foodIndex >= state.foodSeq.length || state.outcome !== null) {
    return;
  }
  const food = state.foodSeq[state.foodIndex] as number;
  const x = cellX(food) * CELL_SIZE;
  const y = cellY(food) * CELL_SIZE + CELL_SIZE + 2;
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x - 5, y, CELL_SIZE + 10, 2);
  ctx.fillStyle = state.cooldown === 0 ? COLOR.clubs : COLOR.mid;
  const filled = 1 - state.cooldown / COOLDOWN_TICKS;
  ctx.fillRect(x - 5, y, Math.round((CELL_SIZE + 10) * filled), 2);
}

function drawSnake(ctx: CanvasRenderingContext2D, state: CJState): void {
  const snake = state.snakes[state.snakeSide];
  if (snake.body.length === 0) {
    return;
  }
  const human = state.snakeSide === 0;
  ctx.fillStyle = snake.alive ? (human ? COLOR.clubsDark : COLOR.spadesDark) : COLOR.mid;
  for (let i = snake.body.length - 1; i >= 1; i -= 1) {
    fillCell(ctx, snake.body[i] as number, 1);
  }
  ctx.fillStyle = snake.alive ? (human ? COLOR.clubs : COLOR.accent) : COLOR.light;
  fillCell(ctx, snake.body[0] as number, 0);
}

/** 人當設計師時的四個方向箭頭（左下角）：蓋得下去的亮、蓋不下去的暗。 */
function drawDesignerKeys(ctx: CanvasRenderingContext2D, state: CJState): void {
  const legal = legalSides(state);
  const cx = 24;
  const cy = BOARD_HEIGHT - 24;
  const arrows: [number, number, number][] = [
    [UP, 0, -8],
    [RIGHT, 8, 0],
    [DOWN, 0, 8],
    [LEFT, -8, 0],
  ];
  for (const [side, dx, dy] of arrows) {
    ctx.fillStyle =
      legal.includes(side as 0 | 1 | 2 | 3) && state.cooldown === 0 ? COLOR.fg : COLOR.dark;
    ctx.fillRect(cx + dx - 3, cy + dy - 3, 6, 6);
  }
}

export function cJRender(ctx: CanvasRenderingContext2D, state: CJState): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(0, 0, BOARD_WIDTH, 2);
  ctx.fillRect(0, BOARD_HEIGHT - 2, BOARD_WIDTH, 2);
  ctx.fillRect(0, 0, 2, BOARD_HEIGHT);
  ctx.fillRect(BOARD_WIDTH - 2, 0, 2, BOARD_HEIGHT);

  drawWalls(ctx, state);
  drawFood(ctx, state);
  drawCooldown(ctx, state);
  drawSnake(ctx, state);

  if (state.snakeSide === 1 && !state.over) {
    drawDesignerKeys(ctx, state);
  }

  // 開局不動時間：最外圈的橘色邊框閃爍。
  if (state.roundTick < 0 && Math.floor(-state.roundTick / FRAME_BLINK_TICKS) % 2 === 0) {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(0, 0, BOARD_WIDTH, 2);
    ctx.fillRect(0, BOARD_HEIGHT - 2, BOARD_WIDTH, 2);
    ctx.fillRect(0, 0, 2, BOARD_HEIGHT);
    ctx.fillRect(BOARD_WIDTH - 2, 0, 2, BOARD_HEIGHT);
  }

  // 這一局的進度：最上面一條細線（已結算的食物 / 10）。
  const fraction = Math.min(1, (state.eaten + state.lost) / state.foodSeq.length);
  ctx.fillStyle = COLOR.light;
  ctx.fillRect(0, 0, Math.round(BOARD_WIDTH * fraction), 2);

  // 兩局的進度：中間兩個小方塊，完成的填滿。
  for (const round of [0, 1] as const) {
    const done = state.round > round || (state.round === round && state.outcome !== null);
    ctx.fillStyle = done ? COLOR.fg : COLOR.dark;
    ctx.fillRect(150 + round * 12, 4, 8, 8);
  }

  // 兩邊累積的分數：人在左上、AI 在右上。
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR.clubs;
  ctx.textAlign = 'left';
  ctx.fillText(String(state.snakes[0].score), 6, 4);
  ctx.fillStyle = COLOR.accent;
  ctx.textAlign = 'right';
  ctx.fillText(String(state.snakes[1].score), BOARD_WIDTH - 6, 4);
}
