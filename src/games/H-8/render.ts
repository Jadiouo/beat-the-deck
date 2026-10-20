import { COLOR } from '../../shell/palette';
import { AI_COLOR, clear, disc, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import { BASE, CLIMB, LADDERS, LEVELS, STOP, successProb } from './logic';
import type { Act, H8State } from './logic';

/**
 * H-8 的畫面（只有圖形與數字，不放文字）。
 *
 * 左邊是你的梯子、右邊是 AI 的梯子，各 6 格，由下往上。你的每一格寫著「你這層實際的成功率」（只有你看得到）；
 * AI 的每一格寫著公開的基準成功率（它的實際成功率你看不到，要從它爬或停去猜）。
 * 爬過的格子填色；目前所在的格子有框；出局畫橘色、停下來畫灰色。梯子下面是賭注。
 * 中間：你選的（三角形爬、方塊停）；AI 選好了只畫一把鎖，揭示之後才畫它選了什麼，以及成功（綠點）或失敗（橘點）。
 * 底部：已經結束的梯子，雙方的 q（×10）與誰贏。
 */

const RUNG_W = 64;
const RUNG_H = 20;
const RUNG_STRIDE = 24;
const BOTTOM_Y = 176;
const LEFT_X = 28;
const RIGHT_X = 228;

function ladderX(side: 0 | 1): number {
  return side === 0 ? LEFT_X : RIGHT_X;
}

function rungY(level: number): number {
  return BOTTOM_Y - level * RUNG_STRIDE;
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  act: Act,
  cx: number,
  cy: number,
  color: string,
): void {
  ctx.fillStyle = color;
  if (act === CLIMB) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - 9);
    ctx.lineTo(cx + 9, cy + 8);
    ctx.lineTo(cx - 9, cy + 8);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillRect(cx - 8, cy - 8, 16, 16);
  }
}

function drawLadder(ctx: CanvasRenderingContext2D, state: H8State, side: 0 | 1): void {
  const x = ladderX(side);
  const status = state.status[side];
  const color = sideColor(side);
  for (let k = 0; k < LEVELS; k += 1) {
    const y = rungY(k);
    const done = k < state.level[side];
    const here = k === state.level[side] && status === 'active';
    ctx.fillStyle = done ? color : COLOR.dark;
    ctx.fillRect(x, y, RUNG_W, RUNG_H);
    if (here) {
      frame(ctx, x - 2, y - 2, RUNG_W + 4, RUNG_H + 4, COLOR.fg);
    }
    const value =
      side === 0
        ? Math.round(successProb(k, state.q[0]) * 100)
        : Math.round((BASE[k] as number) * 100);
    number(
      ctx,
      value,
      x + RUNG_W / 2,
      y + 4,
      12,
      done ? COLOR.bg : here ? COLOR.fg : COLOR.mid,
      'center',
    );
  }
  const potColor = status === 'out' ? COLOR.warning : status === 'stopped' ? COLOR.light : color;
  number(ctx, state.pot[side], x + RUNG_W / 2, BOTTOM_Y + 30, 22, potColor, 'center');
  if (status === 'out') {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(x, rungY(Math.min(state.level[side], LEVELS - 1)) + 8, RUNG_W, 4);
  }
}

function drawCenter(ctx: CanvasRenderingContext2D, state: H8State): void {
  const mine = state.pending[0];
  if (mine !== null) {
    drawGlyph(ctx, mine, 124, 100, HUMAN_COLOR);
  }
  const theirs = state.pending[1];
  const last = state.last;
  if (state.phase === 'resolve' && last !== null) {
    for (const side of [0, 1] as const) {
      const act = last.acts[side];
      const ok = last.ok[side];
      const cx = side === 0 ? 124 : 196;
      if (act !== null) {
        drawGlyph(ctx, act, cx, 100, sideColor(side));
      }
      if (ok !== null) {
        disc(ctx, cx, 124, 5, ok ? COLOR.clubs : COLOR.warning);
      }
    }
  } else if (theirs !== null && state.status[1] === 'active') {
    // AI 選好了：只畫一把鎖，不畫它選了什麼
    ctx.fillStyle = AI_COLOR;
    ctx.fillRect(188, 100, 16, 11);
    frame(ctx, 191, 94, 10, 8, AI_COLOR);
  }
  if (state.phase === 'choose' && state.status[0] === 'active' && state.pending[0] === null) {
    drawGlyph(ctx, CLIMB, 124, 60, COLOR.mid);
    drawGlyph(ctx, STOP, 196, 60, COLOR.mid);
    number(ctx, 'a', 124, 74, 10, COLOR.mid, 'center');
    number(ctx, 'b', 196, 74, 10, COLOR.mid, 'center');
  }
}

function drawPast(ctx: CanvasRenderingContext2D, state: H8State): void {
  for (let i = 0; i < LADDERS; i += 1) {
    const x = 12 + i * 61;
    frame(ctx, x, 214, 56, 22, COLOR.dark);
    const past = state.past[i];
    if (past === undefined) {
      number(ctx, i + 1, x + 28, 220, 10, COLOR.dark, 'center');
      continue;
    }
    number(ctx, Math.round(past.q[0] * 10), x + 4, 218, 10, HUMAN_COLOR);
    number(ctx, Math.round(past.q[1] * 10), x + 52, 218, 10, AI_COLOR, 'right');
    const win = past.pots[0] === past.pots[1] ? null : past.pots[0] > past.pots[1] ? 0 : 1;
    ctx.fillStyle = win === null ? COLOR.mid : sideColor(win);
    ctx.fillRect(x + 20, 228, 16, 3);
  }
}

export function h8Render(ctx: CanvasRenderingContext2D, state: H8State): void {
  clear(ctx);
  number(ctx, state.scores[0], 12, 4, 22, HUMAN_COLOR);
  number(ctx, state.scores[1], 308, 4, 22, AI_COLOR, 'right');
  number(
    ctx,
    `${Math.min(state.ladder + 1, LADDERS)}/${LADDERS}`,
    160,
    10,
    12,
    COLOR.mid,
    'center',
  );
  drawLadder(ctx, state, 0);
  drawLadder(ctx, state, 1);
  drawCenter(ctx, state);
  drawPast(ctx, state);
}
