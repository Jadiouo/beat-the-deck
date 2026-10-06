import { COLOR } from '../../shell/palette';
import { drawBoard, drawScores } from '../_clubs/draw';
import { CELL_SIZE, HEIGHT, WIDTH } from '../_clubs/logic';
import type { C2State } from './logic';

/**
 * C-2 的畫面：與 C-A 一樣的完整資訊，但整張地圖依 `viewRotation` 順時針轉 90 度的倍數（繞畫布中心）。
 * 地圖 320×240，轉 90 或 270 度之後是 240×320，放不進畫布，所以奇數次旋轉同時縮成 0.75 倍。
 * 旋轉前（`warning`）最外圈畫橘色邊框，每 10 個 tick 亮暗交替；分數數字畫在轉動範圍外，不跟著轉。
 */

const SCREEN_WIDTH = WIDTH * CELL_SIZE;
const SCREEN_HEIGHT = HEIGHT * CELL_SIZE;
/** 奇數次旋轉的縮放：240 / 320。 */
const TURNED_SCALE = SCREEN_HEIGHT / SCREEN_WIDTH;
/** 邊框的粗細（像素）。 */
const FRAME = 4;
/** 閃爍：每幾個 tick 亮暗交替一次。 */
const BLINK_TICKS = 10;

export function c2Render(ctx: CanvasRenderingContext2D, state: C2State): void {
  // 縮小之後地圖外面會露出空白，先把整個畫布塗成背景。
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

  ctx.save();
  if (state.viewRotation !== 0) {
    ctx.translate(SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
    ctx.rotate((state.viewRotation * Math.PI) / 2);
    if (state.viewRotation % 2 === 1) {
      ctx.scale(TURNED_SCALE, TURNED_SCALE);
    }
    ctx.translate(-SCREEN_WIDTH / 2, -SCREEN_HEIGHT / 2);
  }
  drawBoard(ctx, state);
  ctx.restore();

  drawScores(ctx, state);

  if (state.warning && Math.floor(state.tick / BLINK_TICKS) % 2 === 0) {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(0, 0, SCREEN_WIDTH, FRAME);
    ctx.fillRect(0, SCREEN_HEIGHT - FRAME, SCREEN_WIDTH, FRAME);
    ctx.fillRect(0, 0, FRAME, SCREEN_HEIGHT);
    ctx.fillRect(SCREEN_WIDTH - FRAME, 0, FRAME, SCREEN_HEIGHT);
  }
}
