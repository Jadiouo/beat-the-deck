import { COLOR } from '../../shell/palette';
import { AI_WAIT_TICKS, DECISION_TIMEOUT } from '../_hearts/logic';
import { AI_COLOR, bar, clear, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import { PAPER, predictOpponent, ROCK, ROUNDS, SCISSORS } from './logic';
import type { HQState, Move } from './logic';

/**
 * H-Q 的畫面。上方：兩邊籌碼、中間的賭注、10 個回合小點。中間：兩個牌位（出手前空的、
 * AI 出手後是牌背、開牌後翻開）。下方是這張牌的重點「AI 在讀你」：三根長條是 AI 相信你下一手
 * 是石頭、布、剪刀的機率（與 `evaluate` 用的是同一個 `predictOpponent`），一排小格是 AI 每一回合
 * 事先的預測有沒有中，右邊的數字是讀對幾次。只有圖形與數字，不放文字。
 */

const SLOT_W = 76;
const SLOT_H = 56;
const SLOT_Y = 52;
const SLOT_X = [44, 200] as const;

/** 一個出手的圖形，中心在 (cx, cy)，邊長 size。 */
function drawMove(
  ctx: CanvasRenderingContext2D,
  move: Move,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  const half = size / 2;
  ctx.fillStyle = color;
  if (move === ROCK) {
    ctx.fillRect(cx - half, cy - half, size, size);
  } else if (move === PAPER) {
    frame(ctx, cx - half, cy - half, size, size, color);
    ctx.fillStyle = color;
    ctx.fillRect(cx - half + 4, cy - 3, size - 8, 2);
    ctx.fillRect(cx - half + 4, cy + 3, size - 8, 2);
  } else if (move === SCISSORS) {
    const step = Math.max(2, Math.floor(size / 8));
    for (let i = 0; i <= size - step; i += step) {
      ctx.fillRect(cx - half + i, cy - half + i, step, step);
      ctx.fillRect(cx + half - step - i, cy - half + i, step, step);
    }
  } else {
    ctx.fillRect(cx - half, cy - 1, size, 3);
  }
}

/** 牌背（對方已經出手、還沒開牌）。 */
function drawBack(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x + 4, y + 4, SLOT_W - 8, SLOT_H - 8);
  ctx.fillStyle = color;
  for (let i = 0; i < 6; i += 1) {
    ctx.fillRect(x + 8 + i * 11, y + 8, 4, SLOT_H - 16);
  }
}

function drawSlot(ctx: CanvasRenderingContext2D, state: HQState, side: 0 | 1): void {
  const x = SLOT_X[side];
  const color = sideColor(side);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x, SLOT_Y, SLOT_W, SLOT_H);

  const opened = state.phase === 'result' && state.last !== null;
  const delta = state.last?.delta[side] ?? 0;
  const border =
    opened && delta > 0 ? COLOR.fg : opened && delta < 0 ? COLOR.heartsDark : COLOR.mid;
  frame(ctx, x, SLOT_Y, SLOT_W, SLOT_H, border);

  const cx = x + SLOT_W / 2;
  const cy = SLOT_Y + SLOT_H / 2;
  if (opened && state.last !== null) {
    drawMove(ctx, state.last.moves[side], cx, cy, 28, color);
    return;
  }
  const mine = state.pending[side];
  if (mine === null) {
    return;
  }
  // 自己的出手自己看得到；對方的出手只看到牌背（不洩漏）。
  if (side === 0) {
    drawMove(ctx, mine, cx, cy, 28, color);
  } else {
    drawBack(ctx, x, SLOT_Y, color);
  }
}

export function hQRender(ctx: CanvasRenderingContext2D, state: HQState): void {
  clear(ctx);

  // 上方：籌碼、賭注、回合小點。
  number(ctx, state.chips[0], 44, 8, 22, HUMAN_COLOR);
  number(ctx, state.chips[1], 276, 8, 22, AI_COLOR, 'right');
  number(ctx, state.over ? 0 : state.stake, 160, 6, 28, COLOR.warning, 'center');
  for (let i = 0; i < ROUNDS; i += 1) {
    ctx.fillStyle =
      i < state.history.length ? COLOR.light : i === state.round ? COLOR.warning : COLOR.dark;
    ctx.fillRect(110 + i * 10, 38, 8, 5);
  }

  drawSlot(ctx, state, 0);
  drawSlot(ctx, state, 1);

  // 牌位之間：這回合的籌碼變化（開牌之後）。
  if (state.phase === 'result' && state.last !== null) {
    number(ctx, Math.abs(state.last.delta[0]), 160, 70, 20, COLOR.fg, 'center');
  }

  // 下方：AI 在讀你。
  const prediction = predictOpponent(state.history, 1);
  const baseline = 220;
  const maxHeight = 56;
  for (const move of [ROCK, PAPER, SCISSORS] as const) {
    const x = 36 + move * 36;
    const p = prediction.probs[move];
    const height = Math.max(2, Math.round(p * maxHeight));
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(x, baseline - maxHeight, 26, maxHeight);
    ctx.fillStyle = prediction.top === move ? COLOR.accent : COLOR.mid;
    ctx.fillRect(x, baseline - height, 26, height);
    drawMove(ctx, move, x + 13, baseline + 7, 8, COLOR.light);
  }

  // 一排小格：AI 每一回合事先的預測有沒有中你出的那一手。
  let hits = 0;
  for (let t = 0; t < state.history.length; t += 1) {
    const before = predictOpponent(state.history.slice(0, t), 1);
    const actual = (state.history[t] as readonly [Move, Move])[0];
    const x = 156 + t * 14;
    if (before.top === null) {
      frame(ctx, x, 154, 11, 11, COLOR.mid);
    } else if (before.top === actual) {
      hits += 1;
      ctx.fillStyle = COLOR.accent;
      ctx.fillRect(x, 154, 11, 11);
    } else {
      ctx.fillStyle = COLOR.dark;
      ctx.fillRect(x, 154, 11, 11);
    }
  }
  number(ctx, hits, 156, 178, 28, COLOR.accent);

  // 最底下：自己的決定倒數（準備時是暗條）。
  if (!state.over && state.phase === 'prep') {
    bar(ctx, 20, 232, 280, 4, state.wait / AI_WAIT_TICKS, COLOR.mid);
  } else if (!state.over && state.phase === 'choose') {
    bar(ctx, 20, 232, 280, 4, 1 - state.idle / DECISION_TIMEOUT, COLOR.warning);
  }
}
