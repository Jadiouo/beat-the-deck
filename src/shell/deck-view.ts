import { CARD_IDS } from '../games/registry';
import { COLOR } from './palette';
import {
  GLYPH_HEIGHT,
  PIPS,
  drawBitmap,
  drawGlyphs,
  glyphTextWidth,
  splitId,
  suitColors,
} from './pixel';
import { isUnlocked } from './progress';
import type { Progress } from './progress';

/**
 * 牌桌畫面的版面與畫法（SPEC 8.1）：54 個格子，4 列 13 張，加一列 2 張鬼牌；上方一排 54 格進度燈。
 * 版面是純的（`cellRect`、`cellAt`、`moveCursor` 可以在沒有畫面的環境測試），畫法才碰 canvas。
 */

export type CellState = 'revealed' | 'playable' | 'locked' | 'unimplemented';
export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const COLUMNS = 13;
const SUIT_CARDS = COLUMNS * 4; // 52
const CELL_W = 20;
const CELL_H = 30;
const PITCH_X = 24;
const PITCH_Y = 34;
const ORIGIN_X = 4;
const ORIGIN_Y = 30;

/** 格子的狀態：翻開 > 尚未開放（牌還沒做）> 可玩（已解鎖）> 鎖住。 */
export function cellState(progress: Progress, id: string, implemented: boolean): CellState {
  if (progress.cards[id]?.won === true) {
    return 'revealed';
  }
  if (!implemented) {
    return 'unimplemented';
  }
  return isUnlocked(progress, id) ? 'playable' : 'locked';
}

function rowOf(index: number): number {
  return index < SUIT_CARDS ? Math.floor(index / COLUMNS) : 4;
}
function columnOf(index: number): number {
  return index < SUIT_CARDS ? index % COLUMNS : index - SUIT_CARDS;
}

export function cellRect(index: number): Rect {
  return {
    x: ORIGIN_X + columnOf(index) * PITCH_X,
    y: ORIGIN_Y + rowOf(index) * PITCH_Y,
    w: CELL_W,
    h: CELL_H,
  };
}

/** 邏輯座標落在哪個格子；縫隙與畫面外是 null。 */
export function cellAt(x: number, y: number): number | null {
  for (let index = 0; index < CARD_IDS.length; index += 1) {
    const rect = cellRect(index);
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) {
      return index;
    }
  }
  return null;
}

/** 游標在格子間移動；邊界不繞出去。第 13 欄往下是 JK-B，第 1 欄往下是 JK-R。 */
export function moveCursor(index: number, direction: Direction): number {
  const row = rowOf(index);
  const column = columnOf(index);
  switch (direction) {
    case 'left':
      return column > 0 ? index - 1 : index;
    case 'right':
      if (row === 4) {
        return index === SUIT_CARDS ? index + 1 : index;
      }
      return column < COLUMNS - 1 ? index + 1 : index;
    case 'up':
      if (row === 4) {
        return (row - 1) * COLUMNS + column;
      }
      return row > 0 ? index - COLUMNS : index;
    case 'down':
      if (row === 4) {
        return index;
      }
      return row === 3 ? SUIT_CARDS + Math.min(column, 1) : index + COLUMNS;
  }
}

export interface DeckView {
  readonly progress: Progress;
  readonly cursor: number;
  /** 這張牌在登記表裡嗎（做好了嗎）。 */
  readonly implemented: (id: string) => boolean;
}

/** 進度燈：54 格，翻開一張亮一格；四個花色各用主色，鬼牌兩格用紫色（亮的整格、暗的只有頂端兩像素）。 */
export function drawLights(ctx: CanvasRenderingContext2D, view: DeckView): void {
  const y = 8;
  const height = 6;
  const gap = 3;
  const total = 54 * 5 - 1 + 4 * gap + 4;
  const left = Math.floor((320 - total) / 2);
  CARD_IDS.forEach((id, index) => {
    const x = left + index * 5 + Math.floor(index / COLUMNS) * gap;
    const { suit } = splitId(id);
    const lit = view.progress.cards[id]?.won === true;
    const colors = suitColors(suit);
    if (suit === 'JK') {
      ctx.fillStyle = COLOR.dark;
      ctx.fillRect(x, y, 4, height);
      ctx.fillStyle = COLOR.joker;
      ctx.fillRect(x, y, 4, lit ? height : 2);
    } else {
      ctx.fillStyle = lit ? colors.main : COLOR.dark;
      ctx.fillRect(x, y, 4, height);
    }
  });
}

function drawCard(ctx: CanvasRenderingContext2D, id: string, state: CellState, rect: Rect): void {
  const { suit, rank } = splitId(id);
  const colors = suitColors(suit);
  const label = rank;

  // 底色與邊框。
  let fill: string = COLOR.bg;
  let border: string = COLOR.dark;
  let ink: string = COLOR.mid;
  switch (state) {
    case 'revealed':
      fill = COLOR.fg;
      border = colors.main;
      ink = colors.main;
      break;
    case 'playable':
      fill = COLOR.dark;
      border = colors.main;
      ink = colors.main;
      break;
    case 'locked':
      fill = COLOR.bg;
      border = COLOR.dark;
      ink = COLOR.mid;
      break;
    case 'unimplemented':
      fill = COLOR.bg;
      border = COLOR.dark;
      ink = COLOR.dark;
      break;
  }
  ctx.fillStyle = border;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = fill;
  ctx.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);

  if (state === 'unimplemented') {
    // 斜線紋：還沒做好的牌。
    ctx.fillStyle = COLOR.dark;
    for (let yy = 1; yy < rect.h - 1; yy += 1) {
      for (let xx = 1; xx < rect.w - 1; xx += 1) {
        if ((xx + yy) % 6 === 0) {
          ctx.fillRect(rect.x + xx, rect.y + yy, 1, 1);
        }
      }
    }
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(rect.x + 2, rect.y + 2, glyphTextWidth(label) + 2, GLYPH_HEIGHT + 2);
    ctx.fillRect(rect.x + 5, rect.y + 17, 10, 10);
  }

  drawGlyphs(ctx, label, rect.x + 3, rect.y + 3, state === 'unimplemented' ? COLOR.mid : ink);
  const pip = PIPS[suit];
  if (state === 'revealed') {
    drawBitmap(ctx, pip, rect.x + 3, rect.y + 12, ink, 2);
  } else {
    drawBitmap(ctx, pip, rect.x + 6, rect.y + 19, state === 'unimplemented' ? COLOR.mid : ink);
  }
}

/** 畫 54 個格子與游標。 */
export function drawCards(ctx: CanvasRenderingContext2D, view: DeckView): void {
  CARD_IDS.forEach((id, index) => {
    const state = cellState(view.progress, id, view.implemented(id));
    drawCard(ctx, id, state, cellRect(index));
  });
  const cursor = cellRect(view.cursor);
  ctx.strokeStyle = COLOR.accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(cursor.x - 2.5, cursor.y - 2.5, cursor.w + 5, cursor.h + 5);
}
