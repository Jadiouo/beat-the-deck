import { COLOR } from '../../shell/palette';
import { AI_COLOR, clear, disc, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import { GREEN, HP_MAX, NONE, RED, ROUNDS, WHITE } from './logic';
import type { H7State, Move } from './logic';

/**
 * H-7 的畫面（只有圖形與數字，不放文字）。
 *
 * 上方：兩邊的分數（大數字）與血量（六格，滿格是上限），中間是第幾回合。
 * 中間：四個格子（不搶 b、紅球 ←、白球 ↑、綠球 →），本回合紅球的分數與血價大寫；你選的那格亮起來。
 * AI 選好了只畫一把鎖，**揭示之前不畫它選了什麼**；揭示之後 AI 選的那格亮青色框，撞球的格子畫一個叉。
 * 下方：每一回合雙方搶了什麼（你在上、AI 在下，顏色就是球的顏色）——這是你讀 AI 的原料，也是 AI 讀你的原料。
 */

const BALL_COLOR: Readonly<Record<Move, string>> = {
  0: COLOR.mid,
  1: COLOR.fg,
  2: COLOR.clubs,
  3: COLOR.hearts,
};
const TILE_ORDER: readonly Move[] = [NONE, RED, WHITE, GREEN];
const TILE_KEY: Readonly<Record<Move, string>> = { 0: 'b', 1: '^', 2: '>', 3: '<' };
const TILE_W = 70;
const TILE_X = 12;
const TILE_STRIDE = 76;
const TILE_Y = 62;
const TILE_H = 64;

function drawHp(ctx: CanvasRenderingContext2D, hp: number, x: number, side: 0 | 1): void {
  for (let i = 0; i < HP_MAX; i += 1) {
    const px = side === 0 ? x + i * 12 : x - (i + 1) * 12 + 2;
    if (i < hp) {
      ctx.fillStyle = hp <= 2 ? COLOR.warning : sideColor(side);
      ctx.fillRect(px, 30, 9, 9);
    } else {
      frame(ctx, px, 30, 9, 9, COLOR.dark);
    }
  }
}

function drawHeader(ctx: CanvasRenderingContext2D, state: H7State): void {
  number(ctx, state.score[0], 12, 4, 22, HUMAN_COLOR);
  number(ctx, state.score[1], 308, 4, 22, AI_COLOR, 'right');
  drawHp(ctx, state.hp[0], 12, 0);
  drawHp(ctx, state.hp[1], 308, 1);
  number(ctx, `${Math.min(state.round + 1, ROUNDS)}/${ROUNDS}`, 160, 10, 12, COLOR.mid, 'center');
}

function drawTile(ctx: CanvasRenderingContext2D, state: H7State, ball: Move, index: number): void {
  const x = TILE_X + index * TILE_STRIDE;
  const mine = state.pending[0];
  const chosen = mine === ball;
  const dim = ball === RED && state.hp[0] <= 0;
  ctx.fillStyle = chosen ? HUMAN_COLOR : COLOR.dark;
  ctx.fillRect(x, TILE_Y, TILE_W - 6, TILE_H);
  number(ctx, TILE_KEY[ball], x + 4, TILE_Y + 2, 8, chosen ? COLOR.bg : COLOR.mid);
  const cx = x + (TILE_W - 6) / 2;
  if (ball === NONE) {
    ctx.fillStyle = dim ? COLOR.dark : COLOR.mid;
    ctx.fillRect(cx - 8, TILE_Y + 28, 16, 3);
    return;
  }
  disc(ctx, cx, TILE_Y + 24, 12, dim ? COLOR.dark : BALL_COLOR[ball]);
  if (ball === RED) {
    number(ctx, state.orbs.red[0], cx, TILE_Y + 18, 14, COLOR.bg, 'center');
    number(
      ctx,
      `-${state.orbs.red[1]}`,
      cx,
      TILE_Y + 44,
      12,
      chosen ? COLOR.bg : COLOR.hearts,
      'center',
    );
  } else if (ball === WHITE) {
    number(ctx, 1, cx, TILE_Y + 18, 14, COLOR.bg, 'center');
  } else {
    number(ctx, '+2', cx, TILE_Y + 18, 12, COLOR.bg, 'center');
    number(ctx, 'hp', cx, TILE_Y + 44, 10, chosen ? COLOR.bg : COLOR.clubs, 'center');
  }
}

function drawChoices(ctx: CanvasRenderingContext2D, state: H7State): void {
  TILE_ORDER.forEach((ball, index) => drawTile(ctx, state, ball, index));
  const theirs = state.pending[1];
  if (theirs !== null && state.phase !== 'resolve') {
    // AI 選好了：只畫一把鎖，不畫它選了什麼
    ctx.fillStyle = AI_COLOR;
    ctx.fillRect(152, 44, 16, 11);
    frame(ctx, 155, 38, 10, 8, AI_COLOR);
  }
  const last = state.last;
  if (state.phase === 'resolve' && last !== null) {
    TILE_ORDER.forEach((ball, index) => {
      const x = TILE_X + index * TILE_STRIDE;
      const hits = [0, 1].filter((s) => last.picks[s as 0 | 1] === ball) as (0 | 1)[];
      if (hits.includes(1)) {
        frame(ctx, x - 1, TILE_Y - 1, TILE_W - 4, TILE_H + 2, AI_COLOR);
      }
      if (hits.length === 2 && ball !== NONE) {
        ctx.fillStyle = COLOR.warning;
        ctx.fillRect(x + 8, TILE_Y + 26, TILE_W - 22, 3);
        ctx.fillRect(x + 8, TILE_Y + 32, TILE_W - 22, 3);
      }
    });
  }
}

function drawHistory(ctx: CanvasRenderingContext2D, state: H7State): void {
  for (let i = 0; i < ROUNDS; i += 1) {
    const x = 12 + i * 25;
    const record = state.history[i];
    frame(ctx, x, 150, 22, 62, COLOR.dark);
    if (record === undefined) {
      number(ctx, i + 1, x + 11, 216, 8, COLOR.dark, 'center');
      continue;
    }
    const clash = record.picks[0] === record.picks[1] && record.picks[0] !== NONE;
    for (const side of [0, 1] as const) {
      const m = record.picks[side];
      const y = 154 + side * 28;
      ctx.fillStyle = BALL_COLOR[m];
      ctx.fillRect(x + 4, y, 14, 12);
      if (m === RED) {
        number(ctx, record.orb[0], x + 11, y + 1, 9, COLOR.bg, 'center');
      }
      // 這一邊出手前的血量：細條
      ctx.fillStyle = sideColor(side);
      ctx.fillRect(x + 4, y + 14, Math.round((record.hp[side] * 14) / HP_MAX), 2);
    }
    if (clash) {
      ctx.fillStyle = COLOR.warning;
      ctx.fillRect(x + 2, 181, 18, 2);
    }
    number(ctx, i + 1, x + 11, 216, 8, COLOR.mid, 'center');
  }
}

export function h7Render(ctx: CanvasRenderingContext2D, state: H7State): void {
  clear(ctx);
  drawHeader(ctx, state);
  drawChoices(ctx, state);
  drawHistory(ctx, state);
}
