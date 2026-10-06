import { COLOR } from '../../shell/palette';
import { AI_WAIT_TICKS, DECISION_TIMEOUT } from '../_hearts/logic';
import { AI_COLOR, bar, clear, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import {
  confidenceLevel,
  PAPER,
  predictOpponent,
  RAISES_PER_GAME,
  raisesLeft,
  respondFoldCost,
  RESPOND_PREP,
  ROCK,
  ROUNDS,
  SCISSORS,
} from './logic';
import type { HQState, Move } from './logic';

/**
 * H-Q 的畫面。上方：兩邊籌碼與各自剩幾次加碼（小菱形，實心是還有、空心是用掉了）、中間的賭注、10 個回合小點。
 * 中間：兩個牌位（出手前空的、AI 出手後是牌背、開牌後翻開）。
 *
 * 下方是這張牌的重點「AI 在讀你」，刻意做成「夠讓你起疑、不夠讓你確定」：
 * - 左邊是**一個三格的訊號**（像手機的訊號強度）：AI 對你的把握是 0、1、2、3 格（`confidenceLevel`，粗粒度的四級）。
 *   **不顯示它認為你下一手是哪一手**，也不畫「值得加碼」的線：它會不會加碼還要看賭注、剩幾次、你被加碼之後的反應。
 *   你要自己想「它讀到的是我哪個習慣」；它真的加碼了，才是它把錢押上去的證據。
 * - 右邊每一欄是一個已經結束的回合：上面一格是 AI 事先的預測有沒有中（亮色中、暗色沒中、空心是當時沒把握），
 *   下面是你出的拳與 AI 出的拳（公開的歷史，讓你不用靠記憶推論）。
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
  // 兩邊剩幾次加碼：這回合已經公開的加碼先算進去（自己的馬上，AI 的等公開）。
  for (const side of [0, 1] as const) {
    const left = Math.max(0, raisesLeft(state.raises, side) - (raiseVisible(state, side) ? 1 : 0));
    for (let i = 0; i < RAISES_PER_GAME; i += 1) {
      const x = side === 0 ? 44 + i * 12 : 276 - i * 12 - 8;
      const color = sideColor(side);
      if (i < left) {
        ctx.fillStyle = color;
        ctx.fillRect(x + 2, 36, 4, 8);
        ctx.fillRect(x, 38, 8, 4);
      } else {
        frame(ctx, x, 36, 8, 8, COLOR.dark);
      }
    }
  }
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

  // 下方左：AI 對你的把握，三格訊號（0 到 3 格）。不說是哪一手，也沒有「值得加碼」的線。
  const level = confidenceLevel(state.history, 1);
  const baseline = 220;
  for (let step = 0; step < 3; step += 1) {
    const x = 40 + step * 34;
    const height = 18 + step * 16;
    const lit = step < level;
    if (lit) {
      ctx.fillStyle = level === 3 ? COLOR.warning : COLOR.accent;
      ctx.fillRect(x, baseline - height, 26, height);
    } else {
      ctx.fillStyle = COLOR.dark;
      ctx.fillRect(x, baseline - height, 26, height);
    }
  }

  // 下方右：每個結束的回合一欄：AI 事先的預測有沒有中、你出的拳、AI 出的拳。
  let hits = 0;
  for (let t = 0; t < state.history.length; t += 1) {
    const before = predictOpponent(state.history.slice(0, t), 1);
    const [mine, theirs] = state.history[t] as readonly [Move, Move];
    const x = 156 + t * 14;
    if (before.top === null) {
      frame(ctx, x, 154, 11, 11, COLOR.mid);
    } else if (before.top === mine) {
      hits += 1;
      ctx.fillStyle = COLOR.accent;
      ctx.fillRect(x, 154, 11, 11);
    } else {
      ctx.fillStyle = COLOR.dark;
      ctx.fillRect(x, 154, 11, 11);
    }
    drawMove(ctx, mine, x + 5, 178, 8, HUMAN_COLOR);
    drawMove(ctx, theirs, x + 5, 194, 8, AI_COLOR);
  }
  number(ctx, hits, 156, 204, 18, COLOR.accent);

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
