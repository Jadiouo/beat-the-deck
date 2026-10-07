import { COLOR } from '../../shell/palette';
import { RESOLVE_TICKS, WIN_ROUNDS, WINDOW } from './logic';
import type { S7State } from './logic';

/**
 * S-7 的畫面（只有圖形，不放文字）。
 * 中間一個大圓：有光就亮（真光與假光畫得一模一樣，連 age 也不影響畫法），沒光是暗圈。
 * 兩側各一個槍手；按下去的那一邊前面閃一下（槍聲，揭曉前不分有效還是搶拍）。
 * 上方各 5 格：贏幾輪。下方是歷史（公開的資訊）：最近 6 輪，每一欄上面是人的假動作（小方塊），下面是 AI 的，
 * 被騙的那一邊畫一個叉，最下面一條是那一輪的贏家顏色。
 * 不畫任何機率、對手的假動作額度、「這道光是假的」。
 */
const HUMAN = COLOR.spades;
const AI = COLOR.accent;
const CX = 160;
const CY = 96;

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.strokeStyle = COLOR.hearts;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 4, y - 4);
  ctx.lineTo(x + 4, y + 4);
  ctx.moveTo(x + 4, y - 4);
  ctx.lineTo(x - 4, y + 4);
  ctx.stroke();
}

export function s7Render(ctx: CanvasRenderingContext2D, state: S7State): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);

  // 贏幾輪
  for (let i = 0; i < WIN_ROUNDS; i += 1) {
    ctx.fillStyle = i < state.wins[0] ? HUMAN : COLOR.dark;
    ctx.fillRect(12 + i * 14, 10, 10, 10);
    ctx.fillStyle = i < state.wins[1] ? AI : COLOR.dark;
    ctx.fillRect(298 - i * 14, 10, 10, 10);
  }

  // 中間的光
  ctx.fillStyle = COLOR.dark;
  disc(ctx, CX, CY, 40);
  ctx.fillStyle = state.flash === null ? COLOR.bg : COLOR.diamonds;
  disc(ctx, CX, CY, 34);

  // 槍手與槍聲
  ctx.fillStyle = HUMAN;
  ctx.fillRect(40, CY - 24, 24, 48);
  ctx.fillStyle = AI;
  ctx.fillRect(256, CY - 24, 24, 48);
  const bang = state.resolveIn !== null || state.phase === 'result';
  if (bang) {
    ctx.fillStyle = COLOR.fg;
    if (state.press[0] !== null) {
      ctx.fillRect(68, CY - 4, 14, 8);
    }
    if (state.press[1] !== null) {
      ctx.fillRect(238, CY - 4, 14, 8);
    }
  }
  if (state.phase === 'result' && state.last !== null && state.last.winner !== null) {
    ctx.fillStyle = state.last.winner === 0 ? HUMAN : AI;
    ctx.fillRect(state.last.winner === 0 ? 40 : 256, CY + 30, 24, 6);
  }

  // 歷史：最近 WINDOW 輪
  const x0 = 100;
  const colW = 20;
  const recent = state.history.slice(-WINDOW);
  for (let i = 0; i < recent.length; i += 1) {
    const r = recent[i];
    if (r === undefined) {
      continue;
    }
    const x = x0 + i * colW;
    for (const side of [0, 1] as const) {
      const y = side === 0 ? 170 : 190;
      for (let k = 0; k < r.twitches[side]; k += 1) {
        ctx.fillStyle = side === 0 ? HUMAN : AI;
        ctx.fillRect(x + k * 7, y, 5, 5);
      }
      if (r.baited[side] > 0) {
        cross(ctx, x + 8, y + 2);
      }
    }
    ctx.fillStyle = r.winner === null ? COLOR.mid : r.winner === 0 ? HUMAN : AI;
    ctx.fillRect(x, 208, 16, 4);
  }
  // 槍聲倒數（揭曉前的緊張感）
  if (state.resolveIn !== null) {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(CX - 24, 150, Math.round((48 * state.resolveIn) / RESOLVE_TICKS), 3);
  }
}
