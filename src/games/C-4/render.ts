import { COLOR } from '../../shell/palette';
import { CELL_SIZE, cellX, cellY, HEIGHT, WIDTH } from '../_clubs/logic';
import type { Snake } from '../_clubs/logic';
import { isVisible, radarOf } from './logic';
import type { C4State } from './logic';

/**
 * C-4 的畫面：霧是畫面層。背景暗；人（0 號邊）看得到的範圍畫亮一點；範圍內的食物是橘色實心、
 * 範圍外「記得的食物」是橘色空心；對手的蛇只畫範圍內的格子；自己的蛇整條都畫。
 * 右上角是雷達：不亮的時候一個暗的方框，亮的時候一支箭頭（8 個方位、三級長度）指向最近的食物。
 * 只讀 state，只用色盤顏色，全部畫在 320×240 之內。畫面上不放中文字。
 */

const BOARD_WIDTH = WIDTH * CELL_SIZE;
const BOARD_HEIGHT = HEIGHT * CELL_SIZE;
/** 雷達方框的中心與半徑（像素）。 */
const RADAR_X = BOARD_WIDTH - 28;
const RADAR_Y = 36;
const RADAR_HALF = 14;
/** 方位 0..7（北、東北、東……）的單位向量。 */
const COMPASS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

function fillCell(ctx: CanvasRenderingContext2D, index: number, inset: number): void {
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
  shows: (index: number) => boolean,
): void {
  ctx.fillStyle = snake.alive ? bodyColor : COLOR.mid;
  for (let i = snake.body.length - 1; i >= 1; i -= 1) {
    if (shows(snake.body[i] as number)) {
      fillCell(ctx, snake.body[i] as number, 1);
    }
  }
  if (snake.body.length > 0 && shows(snake.body[0] as number)) {
    ctx.fillStyle = snake.alive ? headColor : COLOR.light;
    fillCell(ctx, snake.body[0] as number, 0);
  }
}

function drawRadar(ctx: CanvasRenderingContext2D, state: C4State): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(RADAR_X - RADAR_HALF, RADAR_Y - RADAR_HALF, RADAR_HALF * 2, RADAR_HALF * 2);
  ctx.strokeStyle = COLOR.mid;
  ctx.lineWidth = 1;
  ctx.strokeRect(
    RADAR_X - RADAR_HALF + 0.5,
    RADAR_Y - RADAR_HALF + 0.5,
    RADAR_HALF * 2 - 1,
    RADAR_HALF * 2 - 1,
  );
  ctx.fillStyle = COLOR.fg;
  ctx.fillRect(RADAR_X - 1, RADAR_Y - 1, 3, 3);
  const radar = radarOf(state);
  if (!radar.lit) {
    return;
  }
  const [dx, dy] = COMPASS[radar.dir] as readonly [number, number];
  ctx.fillStyle = COLOR.warning;
  for (let step = 1; step <= radar.band + 1; step += 1) {
    ctx.fillRect(RADAR_X + dx * step * 3 - 1, RADAR_Y + dy * step * 3 - 1, 3, 3);
  }
}

export function c4Render(ctx: CanvasRenderingContext2D, state: C4State): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

  const human = state.snakes[0];
  const head = human.body[0] as number;
  const visible = (index: number): boolean => isVisible(head, index);

  // 看得到的範圍：亮一點的底。
  ctx.fillStyle = COLOR.dark;
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    if (visible(index)) {
      fillCell(ctx, index, 0);
    }
  }

  // 地圖外框（永遠看得到）。
  ctx.fillStyle = COLOR.mid;
  ctx.fillRect(0, 0, BOARD_WIDTH, 2);
  ctx.fillRect(0, BOARD_HEIGHT - 2, BOARD_WIDTH, 2);
  ctx.fillRect(0, 0, 2, BOARD_HEIGHT);
  ctx.fillRect(BOARD_WIDTH - 2, 0, 2, BOARD_HEIGHT);

  // 食物：範圍內實心；範圍外記得的空心。
  ctx.fillStyle = COLOR.warning;
  for (const food of state.foods) {
    if (visible(food)) {
      fillCell(ctx, food, 2);
    }
  }
  ctx.strokeStyle = COLOR.warning;
  ctx.lineWidth = 1;
  for (const food of state.memory[0].foods) {
    if (!visible(food)) {
      ctx.strokeRect(
        cellX(food) * CELL_SIZE + 2.5,
        cellY(food) * CELL_SIZE + 2.5,
        CELL_SIZE - 5,
        CELL_SIZE - 5,
      );
    }
  }

  // 蛇：對手只畫範圍內的格子。
  drawSnake(ctx, state.snakes[1], COLOR.accent, COLOR.spadesDark, visible);
  drawSnake(ctx, human, COLOR.clubs, COLOR.clubsDark, () => true);

  drawRadar(ctx, state);

  // 兩邊的分數：人在左上、AI 在右上（雷達在它下面）。
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR.clubs;
  ctx.textAlign = 'left';
  ctx.fillText(String(state.snakes[0].score), 6, 4);
  ctx.fillStyle = COLOR.accent;
  ctx.textAlign = 'right';
  ctx.fillText(String(state.snakes[1].score), BOARD_WIDTH - 6, 4);
}
