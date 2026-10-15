import { COLOR } from '../../shell/palette';
import { BULLET_R, FIELD_H, FIELD_W, PLAYER_R } from '../_spades/logic';
import { CLEARS, QUIET_TICKS, score } from './logic';
import type { S10State } from './logic';

/**
 * S-10 的畫面：一個共用的場地置中；右上角的小方塊是還剩幾次清場（共用，所以只有一排），
 * 左側的細條是清場之後離彈幕再開還有多久（無彈期）；上方是兩邊的分數。完整資訊，不畫任何 AI 的推論。
 */
const ORIGIN_X = 85;
const ORIGIN_Y = 10;

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

export function s10Render(ctx: CanvasRenderingContext2D, state: S10State): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(ORIGIN_X - 1, ORIGIN_Y - 1, FIELD_W + 2, FIELD_H + 2);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(ORIGIN_X, ORIGIN_Y, FIELD_W, FIELD_H);

  ctx.fillStyle = COLOR.fg;
  for (const b of state.bullets) {
    disc(ctx, ORIGIN_X + b.x, ORIGIN_Y + b.y, BULLET_R);
  }

  const colors = [COLOR.spades, COLOR.accent] as const;
  for (const side of [0, 1] as const) {
    const p = state.players[side];
    const hidden = p.invuln > 0 && Math.floor(state.tick / 4) % 2 === 0;
    if (!hidden) {
      ctx.fillStyle = colors[side];
      disc(ctx, ORIGIN_X + p.x, ORIGIN_Y + p.y, PLAYER_R);
    }
  }

  // 還剩幾次清場：右側一排方塊；第 5 秒之前（還不能按）用暗色框
  const locked = state.tick < 300;
  for (let i = 0; i < CLEARS; i += 1) {
    ctx.fillStyle = i < state.clears ? (locked ? COLOR.mid : COLOR.warning) : COLOR.dark;
    ctx.fillRect(ORIGIN_X + FIELD_W + 12, ORIGIN_Y + 200 - i * 12, 10, 10);
  }
  // 無彈期的倒數：左側由下往上縮的細條
  if (state.quiet > 0) {
    ctx.fillStyle = COLOR.mid;
    const h = Math.round((state.quiet / QUIET_TICKS) * 60);
    ctx.fillRect(ORIGIN_X - 12, ORIGIN_Y + 200 - h, 4, h);
  }

  const [human, ai] = score(state);
  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLOR.spades;
  ctx.fillText(String(human), ORIGIN_X, 1);
  ctx.textAlign = 'right';
  ctx.fillStyle = COLOR.accent;
  ctx.fillText(String(ai), ORIGIN_X + FIELD_W, 1);
  // 場上的子彈數（清場值多少分）：中間
  ctx.textAlign = 'center';
  ctx.fillStyle = COLOR.light;
  ctx.fillText(String(Math.min(state.bullets.length, 60)), ORIGIN_X + FIELD_W / 2, 1);
}
