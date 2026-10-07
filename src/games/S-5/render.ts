import { COLOR } from '../../shell/palette';
import { FIELD_H, FIELD_W } from '../_spades/logic';
import { BALL_R, LINE_Y, PADDLE_HALF } from './logic';
import type { S5State } from './logic';

/**
 * S-5 的畫面：一個場地置中；上下兩塊板子；球、尾跡與旋轉的小箭頭（旋是看得到的資訊）；
 * 兩條板子線外側各一排小點，是對方最近幾次回球抵達這條線的位置（habit，公開）；上方是兩邊分數，發球方在名字旁。
 * 不畫任何 AI 的預測：AI 板子的位置本身就是它的猜測（4.4）。
 */
const ORIGIN_X = 85;
const ORIGIN_Y = 10;

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

export function s5Render(ctx: CanvasRenderingContext2D, state: S5State): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(ORIGIN_X - 1, ORIGIN_Y - 1, FIELD_W + 2, FIELD_H + 2);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(ORIGIN_X, ORIGIN_Y, FIELD_W, FIELD_H);
  // 中線（虛線）
  ctx.fillStyle = COLOR.dark;
  for (let x = 0; x < FIELD_W; x += 10) {
    ctx.fillRect(ORIGIN_X + x, ORIGIN_Y + FIELD_H / 2, 5, 1);
  }

  // 習慣：0 號邊的回球抵達 1 號邊那條線（上），反之亦然（下）
  for (let side = 0; side < 2; side += 1) {
    ctx.fillStyle = side === 0 ? COLOR.spadesDark : COLOR.mid;
    const y = side === 0 ? ORIGIN_Y + 3 : ORIGIN_Y + FIELD_H - 5;
    for (const x of state.habit[side as 0 | 1]) {
      ctx.fillRect(Math.round(ORIGIN_X + x) - 1, y, 2, 2);
    }
  }

  // 板子
  const colors = [COLOR.spades, COLOR.accent] as const;
  for (const side of [0, 1] as const) {
    const paddle = state.paddles[side];
    ctx.fillStyle = colors[side];
    ctx.fillRect(
      Math.round(ORIGIN_X + paddle.x - PADDLE_HALF),
      ORIGIN_Y + LINE_Y[side] - 2,
      PADDLE_HALF * 2,
      4,
    );
  }

  if (state.phase !== 'dead') {
    // 尾跡（舊的暗、新的亮）
    ctx.fillStyle = COLOR.dark;
    for (const [x, y] of state.trail) {
      disc(ctx, ORIGIN_X + x, ORIGIN_Y + y, 1.5);
    }
    // 發球前 45 tick 球閃爍
    const hidden = state.phase === 'serve' && Math.floor(state.tick / 6) % 2 === 0;
    if (!hidden) {
      ctx.fillStyle = COLOR.fg;
      disc(ctx, ORIGIN_X + state.ball.x, ORIGIN_Y + state.ball.y, BALL_R);
      // 旋：球旁邊一小段線，往旋的方向（越旋越長）
      if (state.phase === 'play' && Math.abs(state.ball.spin) > 0.002) {
        const len = Math.min(12, Math.abs(state.ball.spin) * 500);
        ctx.fillStyle = COLOR.light;
        const x0 = ORIGIN_X + state.ball.x + (state.ball.spin > 0 ? BALL_R + 1 : -BALL_R - 1 - len);
        ctx.fillRect(Math.round(x0), Math.round(ORIGIN_Y + state.ball.y) - 1, Math.round(len), 1);
      }
    }
  }

  const [human, ai] = state.points;
  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLOR.spades;
  ctx.fillText(`${state.server === 0 ? '>' : ''}${human}`, 10, 1);
  ctx.textAlign = 'right';
  ctx.fillStyle = COLOR.accent;
  ctx.fillText(`${ai}${state.server === 1 ? '<' : ''}`, 310, 1);
}
