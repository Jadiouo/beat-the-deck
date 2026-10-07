import { COLOR } from '../../shell/palette';
import { BULLET_R, FIELD_H, FIELD_W, PLAYER_R } from '../_spades/logic';
import { AMMO_CAP, REGEN_TICKS, ZONE_Y, score } from './logic';
import type { SJState } from './logic';

/**
 * S-J 的畫面：一個場地置中；上緣的游標；左邊一排方塊是射手剩幾發（承諾，可以精確顯示），
 * 下面一條細線是離下一發補充的進度；上方是兩邊分數，目前的射手標示在名字旁。不畫任何 AI 的預測。
 */
const ORIGIN_X = 85;
const ORIGIN_Y = 10;

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

export function sJRender(ctx: CanvasRenderingContext2D, state: SJState): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(ORIGIN_X - 1, ORIGIN_Y - 1, FIELD_W + 2, FIELD_H + 2);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(ORIGIN_X, ORIGIN_Y, FIELD_W, FIELD_H);
  // 上半場（躲的人在這裡停留得分）
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(ORIGIN_X, ORIGIN_Y + ZONE_Y, FIELD_W, 1);

  const shooterColor = state.shooter === 0 ? COLOR.spades : COLOR.accent;
  const dodgerColor = state.shooter === 0 ? COLOR.accent : COLOR.spades;

  ctx.fillStyle = COLOR.fg;
  for (const b of state.bullets) {
    disc(ctx, ORIGIN_X + b.x, ORIGIN_Y + b.y, BULLET_R);
  }
  ctx.fillStyle = shooterColor;
  ctx.fillRect(ORIGIN_X + state.cursor - 4, ORIGIN_Y, 8, 3);

  const hidden = state.invuln > 0 && Math.floor(state.tick / 4) % 2 === 0;
  if (!hidden) {
    ctx.fillStyle = dodgerColor;
    disc(ctx, ORIGIN_X + state.px, ORIGIN_Y + state.py, PLAYER_R);
  }

  // 彈藥：一格一發
  for (let i = 0; i < AMMO_CAP; i += 1) {
    ctx.fillStyle = i < state.ammo ? shooterColor : COLOR.dark;
    ctx.fillRect(10, ORIGIN_Y + 200 - i * 10, 8, 8);
  }
  ctx.fillStyle = COLOR.mid;
  const progress = state.ammo >= AMMO_CAP ? 1 : 1 - state.regen / REGEN_TICKS;
  ctx.fillRect(10, ORIGIN_Y + 212, Math.round(60 * progress), 2);

  const [human, ai] = score(state);
  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLOR.spades;
  ctx.fillText(`${state.shooter === 0 ? '>' : ''}${human}`, 10, 1);
  ctx.textAlign = 'right';
  ctx.fillStyle = COLOR.accent;
  ctx.fillText(`${ai}${state.shooter === 1 ? '<' : ''}`, 310, 1);
}
