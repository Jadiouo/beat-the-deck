import { COLOR } from '../../shell/palette';
import { AI_WAIT_TICKS, DECISION_TIMEOUT } from '../_hearts/logic';
import { AI_COLOR, bar, clear, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import {
  PAPER,
  predictOpponent,
  readAccuracy,
  respondFoldCost,
  RESPOND_PREP,
  ROCK,
  ROUNDS,
  SCISSORS,
} from './logic';
import type { HQState, Move } from './logic';

/**
 * H-Q 的畫面。上方：兩邊籌碼、中間的賭注、10 個回合小點。中間：兩個牌位（出手前空的、
 * AI 出手後是牌背、開牌後翻開）。下方是這張牌的重點「AI 在讀你」：三根長條是 AI 相信你下一手
 * 是石頭、布、剪刀的機率（與 `evaluate` 用的是同一個 `predictOpponent`），一排小格是 AI 每一回合
 * 事先的預測有沒有中，右邊的數字是讀對幾次，旁邊的橫條是它到目前為止實際的命中率（短刻度是它
 * 開始值得加碼的線）。
 *
 * 加碼：公開之後（回應期與開牌）加碼的那一邊牌位外框變成橘色粗框，中間的賭注變成加倍後的數字；
 * AI 加碼時，人的牌位四角會出現橘色的瞄準框（「我被鎖定了」），回應期的前 30 個 tick 閃爍。
 * 回應期開了之後，畫面中間顯示兩個選項：A（跟）旁邊是會輸贏的 2 倍賭注，B（棄牌）旁邊是棄牌的代價。
 * 只有圖形與數字，不放文字。
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

/** 加碼是不是已經公開（回應期與開牌）。自己的加碼自己出手就看得到；對方的要等公開。 */
function raiseVisible(state: HQState, side: 0 | 1): boolean {
  if (!state.raised[side]) {
    return false;
  }
  return side === 0 || state.phase === 'respond' || state.phase === 'result';
}

/** 四個角的括號（瞄準框），畫在牌位外面一圈。 */
function drawBrackets(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  const left = x - 5;
  const top = y - 5;
  const right = x + SLOT_W + 4;
  const bottom = y + SLOT_H + 4;
  const arm = 9;
  ctx.fillStyle = color;
  for (const [cx, cy, dx, dy] of [
    [left, top, 1, 1],
    [right, top, -1, 1],
    [left, bottom, 1, -1],
    [right, bottom, -1, -1],
  ] as const) {
    ctx.fillRect(dx > 0 ? cx : cx - arm + 1, cy, arm, 2);
    ctx.fillRect(cx, dy > 0 ? cy : cy - arm + 1, 2, arm);
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
  if (raiseVisible(state, side)) {
    // 加碼的那一邊：橘色粗框。
    frame(ctx, x - 1, SLOT_Y - 1, SLOT_W + 2, SLOT_H + 2, COLOR.warning);
    frame(ctx, x - 2, SLOT_Y - 2, SLOT_W + 4, SLOT_H + 4, COLOR.warning);
  }
  if (side === 0 && raiseVisible(state, 1)) {
    // AI 加碼：人的牌位被瞄準了（回應期準備的時候閃爍）。
    const blinking = state.phase === 'respond' && !state.revealed;
    if (!blinking || Math.floor(state.tick / 6) % 2 === 0) {
      drawBrackets(ctx, x, SLOT_Y, COLOR.warning);
    }
  }

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
  // 中間的賭注：加碼公開之後是加倍（或三倍）之後的數字，橘色換成亮色，一眼就看得出來變了。
  const publicRaises = (raiseVisible(state, 0) ? 1 : 0) + (raiseVisible(state, 1) ? 1 : 0);
  number(
    ctx,
    state.over ? 0 : state.stake * (1 + publicRaises),
    160,
    6,
    28,
    publicRaises > 0 ? COLOR.fg : COLOR.warning,
    'center',
  );
  for (let i = 0; i < ROUNDS; i += 1) {
    ctx.fillStyle =
      i < state.history.length ? COLOR.light : i === state.round ? COLOR.warning : COLOR.dark;
    ctx.fillRect(110 + i * 10, 38, 8, 5);
    // 已經結束的回合：誰加碼了（人是紅、AI 是青、兩邊都加碼是白）。
    const raised = state.raises[i];
    if (raised !== undefined && (raised[0] || raised[1])) {
      ctx.fillStyle = raised[0] && raised[1] ? COLOR.fg : raised[0] ? HUMAN_COLOR : AI_COLOR;
      ctx.fillRect(110 + i * 10, 44, 8, 3);
    }
  }

  drawSlot(ctx, state, 0);
  drawSlot(ctx, state, 1);

  // 牌位之間：這回合的籌碼變化（開牌之後）。
  if (state.phase === 'result' && state.last !== null) {
    number(ctx, Math.abs(state.last.delta[0]), 160, 70, 20, COLOR.fg, 'center');
  }

  // 回應期開了、而且我是被加碼的那一邊：兩個選項。A 跟（旁邊是輸贏的 2 倍賭注），B 棄牌（旁邊是棄牌的代價）。
  if (state.phase === 'respond' && state.revealed && state.raised[1] && !state.raised[0]) {
    number(ctx, 'A', 56, 116, 20, COLOR.fg);
    number(ctx, state.stake * 2, 80, 118, 16, COLOR.warning);
    number(ctx, 'B', 200, 116, 20, COLOR.fg);
    number(ctx, respondFoldCost(state.stake), 224, 118, 16, COLOR.light);
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
  // AI 到目前為止實際的命中率，短刻度是「值得加碼」的線（2/3）。
  const accuracy = readAccuracy(state.history, 1);
  bar(ctx, 200, 186, 96, 10, accuracy, accuracy > 2 / 3 ? COLOR.warning : COLOR.accent);
  ctx.fillStyle = COLOR.fg;
  ctx.fillRect(200 + Math.round((2 / 3) * 96), 183, 2, 16);

  // 最底下：自己的決定倒數（準備時是暗條）。
  if (!state.over && state.phase === 'prep') {
    bar(ctx, 20, 232, 280, 4, state.wait / AI_WAIT_TICKS, COLOR.mid);
  } else if (
    !state.over &&
    (state.phase === 'choose' || (state.phase === 'respond' && state.revealed))
  ) {
    bar(ctx, 20, 232, 280, 4, 1 - state.idle / DECISION_TIMEOUT, COLOR.warning);
  } else if (!state.over && state.phase === 'respond') {
    bar(ctx, 20, 232, 280, 4, state.wait / RESPOND_PREP, COLOR.warning);
  }
}
