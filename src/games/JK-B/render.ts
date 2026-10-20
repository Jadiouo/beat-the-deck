import { COLOR } from '../../shell/palette';
import { strings } from '../../shell/strings';
import {
  GRAVITY_FLIP,
  HEIGHT,
  NOTICE_TICKS,
  PHASE_TICKS,
  RAIN_RADIUS,
  SHOVE_CD,
  WIDTH,
  cellX,
  cellY,
} from './logic';
import type { JKBAvatar, JKBState, Rule } from './logic';

/**
 * JK-B 的畫面：沒有隱藏資訊，兩個點、金幣、現在的規則、下一條規則（預告期）、標記格、重力箭頭、推擠冷卻全部畫出來。
 * 版面（320×240）：上方 24 像素是兩邊分數與規則；下面 288×216 是格子場（每格 9 像素），置中。
 * 人是方形（梅花綠）、AI 是菱形（青）；金幣的顏色告訴你這條規則下撿它值不值得。
 */

const CELL = 9;
const FIELD_X = (320 - WIDTH * CELL) / 2;
const FIELD_Y = 24;

const COIN_COLOR: Readonly<Record<Rule, string>> = {
  normal: COLOR.diamonds,
  poison: COLOR.joker,
  gift: COLOR.hearts,
  rain: COLOR.diamonds,
  gravity: COLOR.diamonds,
  rob: COLOR.mid,
  exchange: COLOR.accent,
};

function text(
  ctx: CanvasRenderingContext2D,
  value: string | number,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'left',
): void {
  ctx.font = `${size}px monospace`;
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(String(value), x, y);
}

const px = (x: number): number => FIELD_X + x * CELL;
const py = (y: number): number => FIELD_Y + y * CELL;

function drawCoin(
  ctx: CanvasRenderingContext2D,
  index: number,
  color: string,
  small: boolean,
): void {
  const inset = small ? 3 : 2;
  ctx.fillStyle = color;
  ctx.fillRect(
    px(cellX(index)) + inset,
    py(cellY(index)) + inset,
    CELL - 2 * inset,
    CELL - 2 * inset,
  );
}

function drawAvatar(ctx: CanvasRenderingContext2D, av: JKBAvatar, human: boolean): void {
  const x = px(av.x);
  const y = py(av.y);
  ctx.fillStyle = human ? COLOR.clubs : COLOR.accent;
  if (human) {
    ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + CELL / 2, y);
    ctx.lineTo(x + CELL, y + CELL / 2);
    ctx.lineTo(x + CELL / 2, y + CELL);
    ctx.lineTo(x, y + CELL / 2);
    ctx.closePath();
    ctx.fill();
  }
  // 推擠冷卻：點下面一條漸短的線
  if (av.shoveCd > 0) {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(x, y + CELL - 1, Math.max(1, Math.round((CELL * av.shoveCd) / SHOVE_CD)), 1);
  }
}

function drawArrows(ctx: CanvasRenderingContext2D, state: JKBState): void {
  const upward = state.gravity === 'up';
  ctx.fillStyle = COLOR.warning;
  for (const sx of [3, 311]) {
    for (let k = 0; k < 6; k += 1) {
      const y = FIELD_Y + 14 + k * 34;
      ctx.beginPath();
      if (upward) {
        ctx.moveTo(sx, y);
        ctx.lineTo(sx + 5, y + 8);
        ctx.lineTo(sx - 1, y + 8);
      } else {
        ctx.moveTo(sx - 1, y);
        ctx.lineTo(sx + 5, y);
        ctx.lineTo(sx + 2, y + 8);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
}

export function jkbRender(ctx: CanvasRenderingContext2D, state: JKBState): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(FIELD_X - 1, FIELD_Y - 1, WIDTH * CELL + 2, HEIGHT * CELL + 2);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(FIELD_X, FIELD_Y, WIDTH * CELL, HEIGHT * CELL);

  const notice = state.ruleTick >= PHASE_TICKS - NOTICE_TICKS && state.next !== 'none';

  // 標記格（預告期閃爍的 5×5 框；金幣雨期間留著）
  if (state.rainCell >= 0 && (state.rule === 'rain' || notice)) {
    const flash = state.tick % 30 < 18;
    if (flash || state.rule === 'rain') {
      const x = px(cellX(state.rainCell) - RAIN_RADIUS);
      const y = py(cellY(state.rainCell) - RAIN_RADIUS);
      const size = (2 * RAIN_RADIUS + 1) * CELL;
      ctx.fillStyle = COLOR.warning;
      ctx.fillRect(x, y, size, 1);
      ctx.fillRect(x, y + size - 1, size, 1);
      ctx.fillRect(x, y, 1, size);
      ctx.fillRect(x + size - 1, y, 1, size);
    }
  }
  if (state.rule === 'gravity') {
    drawArrows(ctx, state);
  }

  for (const c of state.coins) {
    drawCoin(ctx, c, COIN_COLOR[state.rule], false);
  }
  for (const c of state.extra) {
    drawCoin(ctx, c, COLOR.fg, true);
  }
  drawAvatar(ctx, state.avatars[1], false);
  drawAvatar(ctx, state.avatars[0], true);

  // 上方：分數、現在的規則；預告期改亮下一條規則與倒數
  const names = strings.brokenRules.rules;
  text(ctx, `${strings.brokenRules.you} ${state.scores[0]}`, 6, 4, 14, COLOR.clubs);
  text(ctx, `${state.scores[1]} ${strings.brokenRules.ai}`, 314, 4, 14, COLOR.accent, 'right');
  const flashing = state.ruleTick < 20 && state.phase > 0 && state.tick % 8 < 4;
  text(ctx, names[state.rule], 160, 2, 11, flashing ? COLOR.fg : COLOR.light, 'center');
  if (notice) {
    const seconds = Math.ceil((PHASE_TICKS - state.ruleTick) / 60);
    text(
      ctx,
      strings.brokenRules.next(names[state.next], seconds),
      160,
      13,
      10,
      COLOR.warning,
      'center',
    );
  } else {
    text(ctx, strings.brokenRules.blurbs[state.rule], 160, 14, 9, COLOR.mid, 'center');
  }

  // 最下面一條：整局剩下的時間
  const left = state.maxTicks === 0 ? 0 : 1 - state.tick / state.maxTicks;
  ctx.fillStyle = COLOR.joker;
  ctx.fillRect(FIELD_X, 239, Math.round(WIDTH * CELL * left), 1);
  if (state.rule === 'gravity') {
    const toFlip = GRAVITY_FLIP - (state.ruleTick % GRAVITY_FLIP);
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(FIELD_X, 238, Math.round((WIDTH * CELL * toFlip) / GRAVITY_FLIP), 1);
  }
}
