import { COLOR } from '../../shell/palette';
import { FIELD_H, FIELD_W } from '../_spades/logic';
import { BALL_R, BRICK_H, BRICK_W, COLS, PADDLE_HALF, PADDLE_Y, ROWS, WALL_TOP } from './logic';
import type { S4State } from './logic';

/**
 * S-4 的畫面：一個共用的場地置中；中間是磚牆（炸彈磚是橘色、中間有一點）；上下各一塊板子，
 * 球的顏色是它現在屬於誰（藍：人、青：AI），等待重發的球在板子上閃爍；上方是兩邊分數。
 * 完整資訊，不畫任何 AI 的預測：它的球往哪飛、板子站哪就是它的意圖。
 */
const ORIGIN_X = 85;
const ORIGIN_Y = 10;

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

export function s4Render(ctx: CanvasRenderingContext2D, state: S4State): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(ORIGIN_X - 1, ORIGIN_Y - 1, FIELD_W + 2, FIELD_H + 2);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(ORIGIN_X, ORIGIN_Y, FIELD_W, FIELD_H);

  // 磚牆：整面佔滿寬度；相鄰的磚留 1 像素縫
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const i = r * COLS + c;
      if (state.bricks[i] !== 0) {
        continue;
      }
      const x = ORIGIN_X + c * BRICK_W;
      const y = ORIGIN_Y + WALL_TOP + r * BRICK_H;
      const bomb = state.bombs.includes(i);
      ctx.fillStyle = bomb ? COLOR.warning : (r + c) % 2 === 0 ? COLOR.mid : COLOR.light;
      ctx.fillRect(x, y, BRICK_W - 1, BRICK_H - 1);
      if (bomb) {
        ctx.fillStyle = COLOR.fg;
        ctx.fillRect(x + 6, y + 2, 2, 2);
      }
    }
  }

  // 板子
  const colors = [COLOR.spades, COLOR.accent] as const;
  for (const side of [0, 1] as const) {
    ctx.fillStyle = colors[side];
    ctx.fillRect(
      Math.round(ORIGIN_X + state.paddles[side].x - PADDLE_HALF),
      ORIGIN_Y + PADDLE_Y[side] - 2,
      PADDLE_HALF * 2,
      4,
    );
  }

  // 球
  for (const ball of state.balls) {
    if (ball.respawn > 0 && Math.floor(state.tick / 6) % 2 === 0) {
      continue;
    }
    ctx.fillStyle = ball.owner === 0 ? COLOR.spades : COLOR.accent;
    const x = ball.respawn > 0 ? state.paddles[ball.owner].x : ball.x;
    const y = ball.respawn > 0 ? (ball.owner === 0 ? PADDLE_Y[0] - 6 : PADDLE_Y[1] + 6) : ball.y;
    disc(ctx, ORIGIN_X + x, ORIGIN_Y + y, BALL_R);
  }

  const [human, ai] = state.score;
  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLOR.spades;
  ctx.fillText(String(human), 10, 1);
  ctx.textAlign = 'right';
  ctx.fillStyle = COLOR.accent;
  ctx.fillText(String(ai), 310, 1);
}
