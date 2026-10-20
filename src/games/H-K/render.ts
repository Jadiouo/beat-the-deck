import type { RenderFn } from '../types';
import { COLOR } from '../../shell/palette';
import { AI_COLOR, bar, clear, disc, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import { h4Render } from '../H-4/render';
import { h5Render } from '../H-5/render';
import { h6Render } from '../H-6/render';
import { h9Render } from '../H-9/render';
import { h10Render } from '../H-10/render';
import { hJRender } from '../H-J/render';
import { hQRender } from '../H-Q/render';
import { BET_TIMEOUT, STAGES } from './logic';
import type { HKState, StageId } from './logic';

/**
 * H-K 的畫面（只有圖形與數字，不放文字）。
 *
 * 上方一條：左邊你的籌碼、右邊 AI 的籌碼、中間四個小方塊（四場，亮的是現在、填色的是跑完的，
 * 顏色是那一場的贏家）、籌碼旁邊的菱形是還剩的加倍牌。
 * 開場決定（bet 階段）：中間畫這一場的牌面點數，下面兩個選項（a：×2 加倍、b：×1 不用）；
 * 你選了畫實心，AI 選好了只畫一把鎖（不畫它選了什麼），揭示之後兩邊各畫自己用沒用，以及倍數。
 * 打牌時：下面整個畫面就是那張牌自己的畫面（縮小）。一場結束時，在上面蓋一個贏家與籌碼轉移的數字。
 */

type SubRender = RenderFn<unknown>;
const RENDERS: Readonly<Record<StageId, SubRender>> = {
  'H-4': h4Render as unknown as SubRender,
  'H-5': h5Render as unknown as SubRender,
  'H-6': h6Render as unknown as SubRender,
  'H-9': h9Render as unknown as SubRender,
  'H-10': h10Render as unknown as SubRender,
  'H-J': hJRender as unknown as SubRender,
  'H-Q': hQRender as unknown as SubRender,
};

const HEADER_H = 26;
const BODY_SCALE = 0.88;
const BODY_X = (320 - 320 * BODY_SCALE) / 2;

function diamond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
}

function drawHeader(ctx: CanvasRenderingContext2D, state: HKState): void {
  number(ctx, state.chips[0], 8, 4, 18, HUMAN_COLOR);
  number(ctx, state.chips[1], 312, 4, 18, AI_COLOR, 'right');
  for (const side of [0, 1] as const) {
    for (let k = 0; k < state.doublers[side]; k += 1) {
      diamond(ctx, side === 0 ? 14 + k * 12 : 306 - k * 12, 23, 4, sideColor(side));
    }
  }
  for (let i = 0; i < STAGES; i += 1) {
    const x = 124 + i * 20;
    const result = state.results[i];
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(x, 6, 14, 14);
    if (result !== undefined) {
      ctx.fillStyle = result.winner === null ? COLOR.mid : sideColor(result.winner);
      ctx.fillRect(x + 2, 8, 10, 10);
    }
    if (i === state.stageIdx && !state.over) {
      frame(ctx, x - 2, 4, 18, 18, COLOR.fg);
    }
  }
}

function drawBet(ctx: CanvasRenderingContext2D, state: HKState): void {
  const id = state.stages[state.stageIdx] as StageId;
  number(ctx, id.slice(2), 160, 56, 40, COLOR.light, 'center');
  const revealed = state.phase === 'betReveal';
  const chosen = state.pending[0];
  for (const move of [1, 0] as const) {
    const x = move === 1 ? 36 : 184;
    const picked = revealed ? state.used[0] === (move === 1) : chosen === move;
    ctx.fillStyle = picked ? HUMAN_COLOR : COLOR.dark;
    ctx.fillRect(x, 130, 100, 44);
    frame(ctx, x, 130, 100, 44, picked ? COLOR.fg : COLOR.mid);
    number(
      ctx,
      move === 1 ? '×2' : '×1',
      x + 50,
      140,
      24,
      picked ? COLOR.bg : COLOR.light,
      'center',
    );
    number(ctx, move === 1 ? 'a' : 'b', x + 8, 134, 10, picked ? COLOR.bg : COLOR.mid);
  }
  // AI：選好了只畫一把鎖；揭示之後才畫它用沒用
  if (revealed) {
    number(
      ctx,
      `×${state.mult}`,
      160,
      190,
      28,
      state.mult > 1 ? COLOR.warning : COLOR.mid,
      'center',
    );
    for (const side of [0, 1] as const) {
      if (state.used[side]) {
        diamond(ctx, side === 0 ? 86 : 234, 118, 7, sideColor(side));
      }
    }
  } else if (state.pending[1] !== null) {
    ctx.fillStyle = AI_COLOR;
    ctx.fillRect(228, 108, 16, 11);
    frame(ctx, 231, 102, 10, 8, AI_COLOR);
  }
  if (state.phase === 'bet') {
    bar(ctx, 60, 206, 200, 6, 1 - state.idle / BET_TIMEOUT, COLOR.warning);
  } else if (state.phase === 'betPrep') {
    bar(ctx, 60, 206, 200, 6, 1 - state.wait / 45, COLOR.mid);
  }
}

function drawSub(ctx: CanvasRenderingContext2D, state: HKState): void {
  const id = state.stages[state.stageIdx] as StageId;
  ctx.save();
  ctx.translate(BODY_X, HEADER_H + 2);
  ctx.scale(BODY_SCALE, BODY_SCALE);
  RENDERS[id](ctx, state.sub);
  ctx.restore();
}

function drawResult(ctx: CanvasRenderingContext2D, state: HKState): void {
  const result = state.results[state.stageIdx];
  if (result === undefined) {
    return;
  }
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(100, 100, 120, 44);
  frame(ctx, 100, 100, 120, 44, result.winner === null ? COLOR.mid : sideColor(result.winner));
  if (result.winner === null) {
    number(ctx, '=', 160, 110, 24, COLOR.mid, 'center');
  } else {
    number(ctx, `+${result.delta}`, 160, 110, 24, sideColor(result.winner), 'center');
    disc(ctx, 112, 122, 5, sideColor(result.winner));
  }
  number(ctx, `×${result.mult}`, 160, 132, 8, COLOR.mid, 'center');
}

export const hkRender: RenderFn<HKState> = (ctx, state) => {
  clear(ctx);
  drawHeader(ctx, state);
  if (state.phase === 'play' || state.phase === 'stageResult') {
    drawSub(ctx, state);
    if (state.phase === 'stageResult') {
      drawResult(ctx, state);
    }
  } else {
    drawBet(ctx, state);
  }
};
