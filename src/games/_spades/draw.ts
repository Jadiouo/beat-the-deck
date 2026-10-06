import { COLOR } from '../../shell/palette';
import { BULLET_R, FIELD_H, FIELD_ORIGIN, FIELD_W, PLAYER_R } from './logic';
import type { Field, SpadesState } from './logic';

/**
 * 黑桃共用的畫法：只讀 state，只用色盤裡的顏色，全部畫在 320×240 之內。
 * 這個檔案不是 `logic.ts`，不在純度掃描範圍內，但仍然不碰時鐘與亂數。
 * 場地座標（左上角 (0, 0)）加上 `FIELD_ORIGIN` 才是畫布座標。
 */

const HUMAN = COLOR.spades;
const AI = COLOR.accent;

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawField(
  ctx: CanvasRenderingContext2D,
  field: Field,
  side: 0 | 1,
  tick: number,
  color: string,
): void {
  const origin = FIELD_ORIGIN[side];
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(origin.x - 1, origin.y - 1, FIELD_W + 2, FIELD_H + 2);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(origin.x, origin.y, FIELD_W, FIELD_H);

  // 子彈：已經算過擦彈的用暗一點的顏色。
  for (const b of field.bullets) {
    ctx.fillStyle = b.grazed ? COLOR.mid : COLOR.fg;
    disc(ctx, origin.x + b.x, origin.y + b.y, BULLET_R);
  }

  // 玩家：無敵時每 4 個 tick 閃一次。
  const hidden = field.invuln > 0 && Math.floor(tick / 4) % 2 === 0;
  if (!hidden) {
    ctx.fillStyle = color;
    disc(ctx, origin.x + field.px, origin.y + field.py, PLAYER_R);
  }
}

/** 兩個場地、子彈、玩家。 */
export function drawFields(ctx: CanvasRenderingContext2D, state: SpadesState): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  drawField(ctx, state.fields[0], 0, state.tick, HUMAN);
  drawField(ctx, state.fields[1], 1, state.tick, AI);
}

/** 上方兩邊的數字（人在左上、AI 在右上）。 */
export function drawNumbers(
  ctx: CanvasRenderingContext2D,
  left: number | string,
  right: number | string,
): void {
  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = HUMAN;
  ctx.textAlign = 'left';
  ctx.fillText(String(left), FIELD_ORIGIN[0].x, 1);
  ctx.fillStyle = AI;
  ctx.textAlign = 'right';
  ctx.fillText(String(right), FIELD_ORIGIN[1].x + FIELD_W, 1);
}
