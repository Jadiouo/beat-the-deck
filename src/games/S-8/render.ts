import { COLOR } from '../../shell/palette';
import { FIELD_H, FIELD_W, PLAYER_R } from '../_spades/logic';
import { CX, CY, R_MAX, R_MIN, SLIT_HALF, score } from './logic';
import type { S8State } from './logic';

/**
 * S-8 的畫面：一個共用的場地置中（光幕是暗色、縫是亮色的長條，完整資訊：縫的位置與轉速是確定的，畫面直接畫出），
 * 上方是兩邊的分數。不畫任何 AI 的意圖（它站的半徑本身就是它的選擇）。
 */
const ORIGIN_X = 85;
const ORIGIN_Y = 10;

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** 射線（從中心出發，角度 `angle`）離開場地之前的長度。 */
function rayLength(angle: number): number {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const toX = c > 1e-9 ? (FIELD_W - CX) / c : c < -1e-9 ? -CX / c : Number.POSITIVE_INFINITY;
  const toY = s > 1e-9 ? (FIELD_H - CY) / s : s < -1e-9 ? -CY / s : Number.POSITIVE_INFINITY;
  return Math.min(R_MAX, toX, toY);
}

export function s8Render(ctx: CanvasRenderingContext2D, state: S8State): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(ORIGIN_X - 1, ORIGIN_Y - 1, FIELD_W + 2, FIELD_H + 2);
  // 光幕：整個場地都是暗色
  ctx.fillStyle = COLOR.spadesDark;
  ctx.fillRect(ORIGIN_X, ORIGIN_Y, FIELD_W, FIELD_H);
  // 中心 r < 10 是光幕（不在縫的範圍）
  ctx.fillStyle = COLOR.dark;
  disc(ctx, ORIGIN_X + CX, ORIGIN_Y + CY, R_MIN);

  // 縫：從 r = 10 到離開場地（或 90）、寬 8 的長條
  const angle = state.slit.angle;
  const end = rayLength(angle);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const nx = -uy;
  const ny = ux;
  const corner = (along: number, lat: number): [number, number] => [
    Math.min(ORIGIN_X + FIELD_W, Math.max(ORIGIN_X, ORIGIN_X + CX + ux * along + nx * lat)),
    Math.min(ORIGIN_Y + FIELD_H, Math.max(ORIGIN_Y, ORIGIN_Y + CY + uy * along + ny * lat)),
  ];
  if (end > R_MIN) {
    const points = [
      corner(R_MIN, -SLIT_HALF),
      corner(end, -SLIT_HALF),
      corner(end, SLIT_HALF),
      corner(R_MIN, SLIT_HALF),
    ];
    ctx.fillStyle = COLOR.light;
    ctx.beginPath();
    ctx.moveTo(points[0]![0], points[0]![1]);
    for (const p of points.slice(1)) {
      ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.fill();
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

  const [human, ai] = score(state);
  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLOR.spades;
  ctx.fillText(String(Math.round(human)), ORIGIN_X, 1);
  ctx.textAlign = 'right';
  ctx.fillStyle = COLOR.accent;
  ctx.fillText(String(Math.round(ai)), ORIGIN_X + FIELD_W, 1);
}
