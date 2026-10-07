import { COLOR } from '../../shell/palette';
import { AI_COLOR, bar, clear, disc, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import { CHAIN_PTS, MAX_CHAIN, RANK_COUNT, TARGET, unseenCounts } from './logic';
import type { H4Entry, H4State } from './logic';

/**
 * H-4 的畫面（只有圖形與數字，不放文字）。
 *
 * 上方：兩邊的存分（數字與到目標 15 的進度條）、輪到誰、這個回合的連對數與連對分。
 * 中間：桌上那張牌。你看過的（你留下的、或你翻出來的）畫成正面；你沒看過的畫成牌背。
 * 翻牌階段，如果是你在猜，會同時亮出「舊的桌上牌」與「翻出來的牌」，所以你知道猜對猜錯的原因；
 * 如果是 AI 在猜，你只看到它猜的方向（箭頭）與入帳之後的對錯，看不到牌。
 * 下方：剩餘牌表（13 欄 × 2 個點）：實心是還沒公開的牌、空心是已經公開丟掉的，
 * 你自己看過的蓋牌用亮色實心標出來（「我看過」）。所以公開資訊只算得出「沒公開的牌共有哪些」，算不出蓋牌是哪一張。
 * 最右下：最近幾次公開的猜法與對錯（↑ ↓ 是猜法、方塊是收手；亮色是對、暗紅是錯），你可以從這裡解讀對方。
 */

const CARD_W = 44;
const CARD_H = 60;
const CARD_Y = 70;

function drawCardBack(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x, y, CARD_W, CARD_H);
  frame(ctx, x, y, CARD_W, CARD_H, color);
  ctx.fillStyle = color;
  for (let i = 0; i < 4; i += 1) {
    ctx.fillRect(x + 6 + i * 9, y + 6, 4, CARD_H - 12);
  }
}

function drawCardFace(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rank: number,
  color: string,
): void {
  ctx.fillStyle = COLOR.fg;
  ctx.fillRect(x, y, CARD_W, CARD_H);
  frame(ctx, x, y, CARD_W, CARD_H, color);
  number(ctx, rank, x + CARD_W / 2, y + CARD_H / 2 - 12, 24, COLOR.heartsDark, 'center');
}

/** 箭頭：up 為 true 朝上。`size` 是寬度。 */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  up: boolean,
  color: string,
): void {
  ctx.fillStyle = color;
  const rows = Math.floor(size / 2);
  for (let i = 0; i < rows; i += 1) {
    const w = (up ? i + 1 : rows - i) * 2;
    ctx.fillRect(cx - w / 2, cy - rows + i * 2, w, 2);
  }
  ctx.fillRect(cx - 1, up ? cy : cy - rows - 3, 3, rows + 3);
}

/** 這一邊（人）看得到哪些牌：自己的回合是換下來的牌，加上看過的桌上牌。 */
function seenByHuman(state: H4State): number[] {
  const seen = new Array<number>(RANK_COUNT).fill(0);
  const unseen = unseenCounts(state, 0);
  for (let r = 0; r < RANK_COUNT; r += 1) {
    seen[r] = Math.max(0, (state.counts[r] as number) - (unseen[r] as number));
  }
  return seen;
}

function drawTable(ctx: CanvasRenderingContext2D, state: H4State): void {
  const humanTurn = state.turn === 0;
  const flipping = state.phase === 'flip' && !state.over;
  const guess = state.guess;
  if (flipping && humanTurn) {
    // 我在猜：舊的桌上牌與翻出來的牌一起亮出來
    drawCardFace(ctx, 84, CARD_Y, state.table, HUMAN_COLOR);
    drawCardFace(ctx, 192, CARD_Y, state.flip, HUMAN_COLOR);
    if (guess !== null) {
      drawArrow(ctx, 160, CARD_Y + 30, 14, guess === 0, COLOR.warning);
    }
    return;
  }
  const x = 138;
  if (state.tableSeen[0]) {
    drawCardFace(ctx, x, CARD_Y, state.table, humanTurn ? HUMAN_COLOR : COLOR.light);
  } else {
    drawCardBack(ctx, x, CARD_Y, COLOR.mid);
  }
  if (flipping && !humanTurn) {
    // AI 在猜：看得到牌背與它猜的方向
    drawCardBack(ctx, 192, CARD_Y, AI_COLOR);
    if (guess !== null) {
      drawArrow(ctx, 160, CARD_Y + 30, 14, guess === 0, AI_COLOR);
    }
  } else if (state.phase === 'locked' && guess !== null) {
    drawArrow(
      ctx,
      160 + (humanTurn ? -42 : 42),
      CARD_Y + 30,
      12,
      guess === 0,
      sideColor(state.turn),
    );
  }
}

function drawStock(ctx: CanvasRenderingContext2D, state: H4State): void {
  const seen = seenByHuman(state);
  const left = 24;
  const step = 21;
  for (let r = 1; r <= RANK_COUNT; r += 1) {
    const x = left + (r - 1) * step;
    const alive = state.counts[r - 1] as number;
    const mine = Math.min(alive, seen[r - 1] as number);
    for (let k = 0; k < 2; k += 1) {
      const cx = x + 4;
      const cy = 160 + k * 11;
      if (k < alive) {
        // 我看過的排在前面（亮色），其餘是沒人看過的（紅）
        disc(ctx, cx, cy, 4, k < mine ? COLOR.light : COLOR.hearts);
      } else {
        frame(ctx, cx - 4, cy - 4, 8, 8, COLOR.dark);
      }
    }
    number(ctx, r, x + 4, 183, 8, COLOR.mid, 'center');
  }
}

function drawHistory(ctx: CanvasRenderingContext2D, history: readonly H4Entry[]): void {
  const recent = history.slice(-14);
  for (let i = 0; i < recent.length; i += 1) {
    const e = recent[i] as H4Entry;
    const x = 22 + i * 21;
    const color = e.ok ? sideColor(e.side) : COLOR.heartsDark;
    if (e.act === 2) {
      ctx.fillStyle = color;
      ctx.fillRect(x, 208, 8, 8);
    } else {
      drawArrow(ctx, x + 4, 212, 8, e.act === 0, color);
    }
    ctx.fillStyle = e.side === 0 ? HUMAN_COLOR : AI_COLOR;
    ctx.fillRect(x, 222, 8, 2);
  }
}

export function h4Render(ctx: CanvasRenderingContext2D, state: H4State): void {
  clear(ctx);

  // 上方：存分
  number(ctx, state.totals[0], 24, 6, 24, HUMAN_COLOR);
  number(ctx, state.totals[1], 296, 6, 24, AI_COLOR, 'right');
  bar(ctx, 24, 36, 108, 5, state.totals[0] / TARGET, HUMAN_COLOR);
  bar(ctx, 188, 36, 108, 5, state.totals[1] / TARGET, AI_COLOR);
  number(ctx, TARGET, 160, 10, 14, COLOR.mid, 'center');

  // 輪到誰：該邊的顏色亮一條；這個回合的連對（小方塊）與連對分
  const turnX = state.turn === 0 ? 24 : 188;
  ctx.fillStyle = sideColor(state.turn);
  ctx.fillRect(turnX, 44, 108, 2);
  for (let i = 0; i < MAX_CHAIN; i += 1) {
    const x = state.turn === 0 ? 24 + i * 12 : 296 - 8 - i * 12;
    if (i < state.c) {
      ctx.fillStyle = sideColor(state.turn);
      ctx.fillRect(x, 50, 8, 8);
    } else {
      frame(ctx, x, 50, 8, 8, COLOR.dark);
    }
  }
  if (state.c > 0) {
    number(
      ctx,
      CHAIN_PTS[state.c] as number,
      state.turn === 0 ? 24 + 6 * 12 + 4 : 296 - 6 * 12 - 4,
      47,
      14,
      COLOR.warning,
      state.turn === 0 ? 'left' : 'right',
    );
  }

  drawTable(ctx, state);
  drawStock(ctx, state);
  drawHistory(ctx, state.history);
}
