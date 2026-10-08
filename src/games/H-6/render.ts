import { COLOR } from '../../shell/palette';
import { AI_COLOR, clear, frame, HUMAN_COLOR, number } from '../_hearts/draw';
import { cellIndex, COLS, confidenceLevel, rewardOf, ROUNDS, ROWS } from './logic';
import type { H6Event, H6State } from './logic';

/**
 * H-6 地雷區的畫面（只有圖形與數字，不放文字）。
 *
 * 上方：兩邊的總分（大數字，你在左、AI 在右）、第幾回合，AI 那邊的三格是「AI 對你的把握」（只看你的紀錄回合數，
 * 不說它認為你會不會領頭）。
 * 中間：4 × 6 的雷圖，最上面是第 6 排、最下面的橫線是起點。沒公開的格子是暗的，公開的安全格是亮的，公開的雷是橘色的叉。
 * 兩邊各有一個標記停在目前的排上（你在左、AI 在右），標記旁邊是手上還沒存的分。
 * 每一排的兩側各有一個數字：那一邊現在先踏上這排能拿幾分（對手到過了就剩一半）——把「先到拿全額」直接寫在格子上。
 * 選了之後只畫一把鎖，公開之前不畫選了什麼；公開之後兩邊踏的格子外框變成各自的顏色。
 * 下方：a 存分（旁邊是手上的分）、b 等；12 個小點是回合進度。
 */

const GRID_X = 100;
const CELL_W = 30;
const CELL_H = 22;
const GRID_TOP = 42;
const CELL_GAP = 2;

function cellY(row: number): number {
  return GRID_TOP + (ROWS - row) * (CELL_H + CELL_GAP);
}

function rowCenterY(row: number): number {
  return row === 0 ? cellY(0) + 4 : cellY(row) + CELL_H / 2 - 5;
}

function drawHeader(ctx: CanvasRenderingContext2D, state: H6State): void {
  number(ctx, state.totals[0], 12, 6, 20, HUMAN_COLOR);
  number(ctx, state.totals[1], 308, 6, 20, AI_COLOR, 'right');
  number(ctx, `${Math.min(state.round + 1, ROUNDS)}/${ROUNDS}`, 160, 8, 12, COLOR.mid, 'center');
  const confidence = confidenceLevel(state, 1);
  for (let i = 0; i < 3; i += 1) {
    const x = 148 + i * 10;
    if (i < confidence) {
      ctx.fillStyle = AI_COLOR;
      ctx.fillRect(x, 24, 8, 8);
    } else {
      frame(ctx, x, 24, 8, 8, COLOR.dark);
    }
  }
}

function drawCell(ctx: CanvasRenderingContext2D, state: H6State, row: number, col: number): void {
  const x = GRID_X + col * (CELL_W + CELL_GAP);
  const y = cellY(row);
  const v = state.known[cellIndex(row, col)] as number;
  if (v === 1) {
    ctx.fillStyle = COLOR.light;
    ctx.fillRect(x, y, CELL_W, CELL_H);
  } else if (v === 2) {
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(x, y, CELL_W, CELL_H);
    ctx.fillStyle = COLOR.warning;
    for (let i = 0; i < 12; i += 1) {
      ctx.fillRect(x + 9 + i, y + 5 + Math.round((i * 12) / 12), 2, 2);
      ctx.fillRect(x + 9 + i, y + 16 - Math.round((i * 12) / 12), 2, 2);
    }
  } else {
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(x, y, CELL_W, CELL_H);
    frame(ctx, x, y, CELL_W, CELL_H, COLOR.mid);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, state: H6State): void {
  for (let row = 1; row <= ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      drawCell(ctx, state, row, col);
    }
  }
  ctx.fillStyle = COLOR.mid;
  ctx.fillRect(GRID_X, cellY(0) + 1, COLS * (CELL_W + CELL_GAP) - CELL_GAP, 2);
}

/** 公開之後：兩邊踏的那一格外框變成各自的顏色。 */
function drawResolve(ctx: CanvasRenderingContext2D, state: H6State): void {
  if (state.phase !== 'resolve' || state.last === null) {
    return;
  }
  for (const side of [0, 1] as const) {
    const event: H6Event = state.last.events[side];
    if (event.col < 0) {
      continue;
    }
    const x = GRID_X + event.col * (CELL_W + CELL_GAP);
    const y = cellY(state.row[side] + 1);
    const color = side === 0 ? HUMAN_COLOR : AI_COLOR;
    frame(ctx, x - 1, y - 1, CELL_W + 2, CELL_H + 2, color);
    frame(ctx, x, y, CELL_W, CELL_H, color);
  }
}

function drawSide(ctx: CanvasRenderingContext2D, state: H6State, side: 0 | 1): void {
  const color = side === 0 ? HUMAN_COLOR : AI_COLOR;
  const markX = side === 0 ? 62 : 248;
  const labelX = side === 0 ? 46 : 282;
  const carryX = side === 0 ? 12 : 308;
  const align: CanvasTextAlign = side === 0 ? 'left' : 'right';
  // 每一排先踏上去能拿幾分：對手到過了就剩一半
  for (let row = 1; row <= ROWS; row += 1) {
    const second = state.claimed[row - 1]?.[1 - side] === true;
    number(
      ctx,
      rewardOf(row, second, state.half),
      labelX,
      cellY(row) + 5,
      12,
      second ? COLOR.mid : COLOR.light,
      side === 0 ? 'right' : 'left',
    );
  }
  const r = state.row[side];
  ctx.fillStyle = color;
  ctx.fillRect(markX, rowCenterY(r), 10, 10);
  number(ctx, state.carry[side], carryX, rowCenterY(r) - 1, 12, color, align);
  // 這回合的選擇：公開之前只畫鎖
  if (state.pending[side] !== null && state.phase !== 'resolve') {
    ctx.fillStyle = color;
    ctx.fillRect(markX + (side === 0 ? 12 : -6), rowCenterY(r) + 2, 4, 6);
  }
}

function drawKeys(ctx: CanvasRenderingContext2D, state: H6State): void {
  if (state.phase === 'choose' && state.pending[0] === null) {
    ctx.fillStyle = HUMAN_COLOR;
    ctx.fillRect(GRID_X, 214, COLS * (CELL_W + CELL_GAP) - CELL_GAP, 3);
    number(ctx, 'a', GRID_X + 8, 220, 10, COLOR.light);
    number(ctx, 'b', GRID_X + 100, 220, 10, COLOR.light);
  }
  const x0 = 14;
  for (let i = 0; i < ROUNDS; i += 1) {
    ctx.fillStyle = i < state.round ? HUMAN_COLOR : COLOR.dark;
    ctx.fillRect(x0 + i * 24, 236, 20, 2);
  }
}

export function h6Render(ctx: CanvasRenderingContext2D, state: H6State): void {
  clear(ctx);
  drawHeader(ctx, state);
  drawGrid(ctx, state);
  drawResolve(ctx, state);
  drawSide(ctx, state, 0);
  drawSide(ctx, state, 1);
  drawKeys(ctx, state);
}
