import { COLOR } from '../../shell/palette';
import { cARender } from '../C-A/render';
import { c2Render } from '../C-2/render';
import { c3Render } from '../C-3/render';
import { c4Render } from '../C-4/render';
import { CELL_SIZE, WIDTH } from '../_clubs/logic';
import { NOTICE_TICKS, PHASE_COUNT, PHASE_TICKS, composeState } from './logic';
import type { CKState, PhaseId } from './logic';

/**
 * C-K 的畫面：目前這一段那張牌的 `render`（旋轉、霧、顏色指示燈都在那裡），再疊上：
 * 上方一排四個小方塊（目前這段亮、跑完的填滿、還沒到的空心）；`notice` 時下方亮出下一段的圖示與倒數條；
 * 每一段開頭的前 12 個 tick 邊框閃一下。無文字，只用色盤顏色，全部在 320×240 之內。
 */

type PaintFn = (ctx: CanvasRenderingContext2D, state: never) => void;
const PAINTERS: Readonly<Record<PhaseId, PaintFn>> = {
  'C-A': cARender as PaintFn,
  'C-2': c2Render as PaintFn,
  'C-3': c3Render as PaintFn,
  'C-4': c4Render as PaintFn,
};

const SCREEN_WIDTH = WIDTH * CELL_SIZE;
const BOX = 8;
const GAP = 4;
const ROW_WIDTH = PHASE_COUNT * BOX + (PHASE_COUNT - 1) * GAP;
const ROW_X = (SCREEN_WIDTH - ROW_WIDTH) / 2;
const ROW_Y = 12;
/** 預告的圖示（16×16）與倒數條。 */
const ICON = 16;
const ICON_X = (SCREEN_WIDTH - ICON) / 2;
const ICON_Y = 26;
const BAR_WIDTH = 60;
const BAR_X = (SCREEN_WIDTH - BAR_WIDTH) / 2;
const BAR_Y = ICON_Y + ICON + 3;
const FLASH_TICKS = 12;
const FRAME = 3;

function drawProgress(ctx: CanvasRenderingContext2D, state: CKState): void {
  for (let i = 0; i < PHASE_COUNT; i += 1) {
    const x = ROW_X + i * (BOX + GAP);
    ctx.fillStyle = COLOR.light;
    ctx.fillRect(x, ROW_Y, BOX, BOX);
    ctx.fillStyle = i < state.phase ? COLOR.clubs : i === state.phase ? COLOR.fg : COLOR.bg;
    ctx.fillRect(x + 1, ROW_Y + 1, BOX - 2, BOX - 2);
  }
}

/** 下一段的圖示：C-2 一個轉彎的箭頭、C-3 紅方塊與藍菱形、C-4 稀疏的點（霧）。 */
function drawIcon(ctx: CanvasRenderingContext2D, id: PhaseId): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(ICON_X - 2, ICON_Y - 2, ICON + 4, ICON + 4);
  if (id === 'C-2') {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(ICON_X + 2, ICON_Y + 2, 10, 3);
    ctx.fillRect(ICON_X + 9, ICON_Y + 2, 3, 10);
    ctx.fillRect(ICON_X + 6, ICON_Y + 10, 9, 3);
  } else if (id === 'C-3') {
    ctx.fillStyle = COLOR.hearts;
    ctx.fillRect(ICON_X + 1, ICON_Y + 5, 6, 6);
    ctx.fillStyle = COLOR.spades;
    ctx.fillRect(ICON_X + 11, ICON_Y + 3, 2, 2);
    ctx.fillRect(ICON_X + 9, ICON_Y + 5, 6, 6);
    ctx.fillRect(ICON_X + 11, ICON_Y + 11, 2, 2);
  } else if (id === 'C-4') {
    ctx.fillStyle = COLOR.mid;
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        if ((x + y) % 2 === 0) {
          ctx.fillRect(ICON_X + x * 4, ICON_Y + y * 4, 4, 4);
        }
      }
    }
    ctx.fillStyle = COLOR.light;
    ctx.fillRect(ICON_X + 6, ICON_Y + 6, 4, 4);
  } else {
    ctx.fillStyle = COLOR.clubs;
    ctx.fillRect(ICON_X + 3, ICON_Y + 3, 10, 10);
  }
}

function drawNotice(ctx: CanvasRenderingContext2D, state: CKState): void {
  const next = state.phases[state.phase + 1];
  if (next === undefined) {
    return;
  }
  drawIcon(ctx, next);
  const left = Math.max(0, Math.min(NOTICE_TICKS, PHASE_TICKS - state.phaseTick));
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(BAR_X, BAR_Y, BAR_WIDTH, 3);
  ctx.fillStyle = COLOR.warning;
  ctx.fillRect(BAR_X, BAR_Y, Math.round((BAR_WIDTH * left) / NOTICE_TICKS), 3);
}

function drawFlash(ctx: CanvasRenderingContext2D, state: CKState): void {
  if (state.phase === 0 || state.phaseTick >= FLASH_TICKS || state.phaseTick % 4 >= 2) {
    return;
  }
  const height = 240;
  ctx.fillStyle = COLOR.fg;
  ctx.fillRect(0, 0, SCREEN_WIDTH, FRAME);
  ctx.fillRect(0, height - FRAME, SCREEN_WIDTH, FRAME);
  ctx.fillRect(0, 0, FRAME, height);
  ctx.fillRect(SCREEN_WIDTH - FRAME, 0, FRAME, height);
}

export function ckRender(ctx: CanvasRenderingContext2D, state: CKState): void {
  const paint = PAINTERS[state.phases[state.phase] as PhaseId];
  paint(ctx, composeState(state) as never);
  drawProgress(ctx, state);
  if (state.notice) {
    drawNotice(ctx, state);
  }
  drawFlash(ctx, state);
}
