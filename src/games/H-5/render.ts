import { COLOR } from '../../shell/palette';
import { AI_COLOR, clear, frame, HUMAN_COLOR, number } from '../_hearts/draw';
import { confidenceLevel, HANDS, HIT, MAX_CARDS, totalOf } from './logic';
import type { H5State, Move, PastObs } from './logic';

/**
 * H-5 的畫面（只有圖形與數字，不放文字；牌用 1 到 10 的數字）。
 *
 * 上方：兩邊的分數（大數字，你在左、AI 在右）、第幾手，AI 那邊的三格是「AI 對你的把握」（只看你的紀錄手數）。
 * 中間：左邊是你的牌（暗牌正面、明牌依序排開，下面是你的總點數）；右邊是 AI 的牌（暗牌是牌背，攤牌才翻開；
 * 下面只有明牌的合計）。選了之後只畫一把鎖，**公開之前不畫選了什麼**；公開之後兩邊的選擇（實心 ＝ 要牌、空心 ＝ 停牌）
 * 與領到的牌並排。
 * 下方：你最近幾手每次決定時的總點數與選擇——這就是 AI 估計你停牌門檻的原料，也是你讀它的原料。
 */

const CARD_W = 28;
const CARD_H = 40;

function drawCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  value: number | null,
  color: string,
): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x, y, CARD_W, CARD_H);
  frame(ctx, x, y, CARD_W, CARD_H, color);
  if (value === null) {
    for (let i = 0; i < 3; i += 1) {
      ctx.fillStyle = COLOR.mid;
      ctx.fillRect(x + 6 + i * 7, y + 18, 4, 4);
    }
    return;
  }
  number(ctx, value, x + CARD_W / 2, y + 12, 16, color, 'center');
}

function drawHeader(ctx: CanvasRenderingContext2D, state: H5State): void {
  number(ctx, state.scores[0], 12, 6, 20, HUMAN_COLOR);
  number(ctx, state.scores[1], 308, 6, 20, AI_COLOR, 'right');
  number(ctx, `${Math.min(state.hand + 1, HANDS)}/${HANDS}`, 160, 8, 12, COLOR.mid, 'center');
  const confidence = confidenceLevel(state, 1);
  for (let i = 0; i < 3; i += 1) {
    const x = 148 + i * 10;
    if (i < confidence) {
      ctx.fillStyle = AI_COLOR;
      ctx.fillRect(x, 26, 8, 8);
    } else {
      frame(ctx, x, 26, 8, 8, COLOR.dark);
    }
  }
}

function drawMoveMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  move: Move,
  color: string,
): void {
  if (move === HIT) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 14, 14);
  } else {
    frame(ctx, x, y, 14, 14, color);
  }
}

function drawSide(ctx: CanvasRenderingContext2D, state: H5State, side: 0 | 1): void {
  const color = side === 0 ? HUMAN_COLOR : AI_COLOR;
  const left = side === 0 ? 14 : 170;
  const showHole = side === 0 || state.phase === 'showdown' || state.over;
  drawCard(ctx, left, 50, showHole ? state.hole[side] : null, color);
  const ups = state.up[side];
  for (let i = 0; i < MAX_CARDS - 1; i += 1) {
    const x = left + (i + 1) * (CARD_W + 4);
    const card = ups[i];
    if (card !== undefined) {
      drawCard(ctx, x, 50, card, color);
    } else if (i === ups.length && state.incoming[side] !== null && state.phase === 'deal') {
      drawCard(ctx, x, 50, state.incoming[side], COLOR.fg);
    } else {
      frame(ctx, x, 50, CARD_W, CARD_H, COLOR.dark);
    }
  }
  const total =
    side === 0 ? totalOf(state.hole[0], ups) : showHole ? totalOf(state.hole[1], ups) : null;
  if (total !== null) {
    number(ctx, total, left + 60, 100, 24, total > 21 ? COLOR.warning : color, 'center');
  } else {
    number(
      ctx,
      ups.reduce((a, b) => a + b, 0),
      left + 60,
      100,
      24,
      COLOR.mid,
      'center',
    );
  }
  // 這一輪的選擇：公開之前只畫鎖
  const pending = state.pending[side];
  const markX = left + 46;
  if (state.stood[side]) {
    frame(ctx, markX, 136, 14, 14, COLOR.mid);
  } else if (pending !== null) {
    if (state.phase === 'deal') {
      drawMoveMark(ctx, markX, 136, pending, color);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(markX + 4, 140, 6, 6);
    }
  }
}

function drawKeys(ctx: CanvasRenderingContext2D, state: H5State): void {
  if (state.phase === 'choose' && !state.stood[0] && state.pending[0] === null) {
    ctx.fillStyle = HUMAN_COLOR;
    ctx.fillRect(14, 158, 110, 3);
    number(ctx, 'a', 30, 164, 10, COLOR.light);
    number(ctx, 'b', 100, 164, 10, COLOR.light);
  }
}

function drawPast(ctx: CanvasRenderingContext2D, state: H5State): void {
  const hands: readonly (readonly PastObs[])[] = state.past[0];
  for (let h = 0; h < hands.length; h += 1) {
    const x = 14 + h * 96;
    const obs = hands[h] as readonly PastObs[];
    for (let i = 0; i < obs.length; i += 1) {
      const o = obs[i] as PastObs;
      const cx = x + i * 44;
      number(ctx, o.total, cx + 8, 190, 12, HUMAN_COLOR);
      drawMoveMark(ctx, cx + 24, 188, o.move, HUMAN_COLOR);
    }
  }
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(14, 224, 292, 2);
  ctx.fillStyle = HUMAN_COLOR;
  ctx.fillRect(14, 224, Math.round((Math.min(state.hand, HANDS) * 292) / HANDS), 2);
}

export function h5Render(ctx: CanvasRenderingContext2D, state: H5State): void {
  clear(ctx);
  drawHeader(ctx, state);
  drawSide(ctx, state, 0);
  drawSide(ctx, state, 1);
  drawKeys(ctx, state);
  drawPast(ctx, state);
}
