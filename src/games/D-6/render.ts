import { COLOR } from '../../shell/palette';
import { strings } from '../../shell/strings';
import { GOODS, ROUNDS, WINDOW, priceOf } from './logic';
import type { D6State, Trade } from './logic';

/**
 * D-6 的畫面：完整資訊，只有「對方這回合鎖定了什麼」在開牌前是祕密。
 * 上方：兩邊現金（人在左、AI 在右）與回合數。中間：三條行情曲線（穀黃、布紅、鐵藍），現在的回合有一條直線，
 * 每種貨在現在這一回合的實際價格是一個點（偏移讓點離開曲線）。下方：每種貨一欄，上面是價格與偏移，
 * 下面是兩邊的存貨；最底下是最近 6 回合雙方做了什麼（公開的紀錄）。
 */

const GOOD_COLOR = [COLOR.diamonds, COLOR.hearts, COLOR.spades] as const;
const HUMAN = COLOR.clubs;
const AI = COLOR.accent;

const CHART_X = 12;
const CHART_Y = 40;
const CHART_W = 296;
const CHART_H = 76;
const PRICE_TOP = 22;
const PRICE_SPAN = PRICE_TOP - 2;

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

function chartX(round: number): number {
  return CHART_X + ((round + 0.5) * CHART_W) / ROUNDS;
}

function chartY(price: number): number {
  return CHART_Y + CHART_H - ((price - 2) * CHART_H) / PRICE_SPAN;
}

function drawCurves(ctx: CanvasRenderingContext2D, state: D6State): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(CHART_X, CHART_Y - 2, CHART_W, CHART_H + 4);
  for (let g = 0; g < GOODS; g += 1) {
    const row = state.base[g] as readonly number[];
    ctx.strokeStyle = GOOD_COLOR[g] as string;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = 0; r < ROUNDS; r += 1) {
      const x = chartX(r);
      const y = chartY(row[r] as number);
      if (r === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  const x = chartX(Math.min(state.round, ROUNDS - 1));
  ctx.fillStyle = COLOR.light;
  ctx.fillRect(Math.round(x), CHART_Y - 2, 1, CHART_H + 4);
  if (!state.over) {
    for (let g = 0; g < GOODS; g += 1) {
      ctx.fillStyle = GOOD_COLOR[g] as string;
      ctx.fillRect(Math.round(x) - 2, Math.round(chartY(priceOf(state, g))) - 2, 5, 5);
    }
  }
}

/** 一個動作的小圖示：買 ▲、賣 ▼、不動 —，顏色是那種貨。 */
function drawTrade(ctx: CanvasRenderingContext2D, trade: Trade, cx: number, cy: number): void {
  if (trade === 0) {
    ctx.fillStyle = COLOR.mid;
    ctx.fillRect(cx - 3, cy, 7, 1);
    return;
  }
  const good = (trade - 1) % 3;
  ctx.fillStyle = GOOD_COLOR[good] as string;
  if (trade <= 3) {
    ctx.fillRect(cx - 1, cy - 3, 3, 2);
    ctx.fillRect(cx - 3, cy - 1, 7, 3);
  } else {
    ctx.fillRect(cx - 3, cy - 3, 7, 3);
    ctx.fillRect(cx - 1, cy, 3, 2);
  }
}

function drawSlot(
  ctx: CanvasRenderingContext2D,
  state: D6State,
  side: 0 | 1,
  x: number,
  y: number,
): void {
  const color = side === 0 ? HUMAN : AI;
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x, y, 40, 14);
  const pending = state.pending[side];
  const revealed = state.phase === 'result' && state.last !== null;
  if (revealed) {
    drawTrade(ctx, (state.last as NonNullable<D6State['last']>).trades[side], x + 20, y + 7);
  } else if (
    pending !== null &&
    (side === 0 || state.phase === 'locked' || state.phase === 'choose')
  ) {
    // 自己的鎖定看得到；對方的只看得到「已鎖定」。
    if (side === 0) {
      drawTrade(ctx, pending, x + 20, y + 7);
    } else {
      text(ctx, strings.market.locked, x + 20, y + 3, 8, color, 'center');
    }
  }
}

function drawHistory(ctx: CanvasRenderingContext2D, state: D6State): void {
  const rows = state.history.slice(-WINDOW);
  const y = 214;
  for (let i = 0; i < WINDOW; i += 1) {
    const x = 60 + i * 34;
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(x, y, 30, 22);
    const pair = rows[i - (WINDOW - rows.length)];
    if (pair !== undefined) {
      drawTrade(ctx, pair[0], x + 8, y + 6);
      drawTrade(ctx, pair[1], x + 22, y + 16);
    }
  }
}

export function d6Render(ctx: CanvasRenderingContext2D, state: D6State): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);

  text(ctx, state.cash[0], 12, 6, 14, HUMAN);
  text(ctx, state.cash[1], 308, 6, 14, AI, 'right');
  text(
    ctx,
    strings.market.round(Math.min(state.round + 1, ROUNDS), ROUNDS),
    160,
    8,
    8,
    COLOR.light,
    'center',
  );
  drawSlot(ctx, state, 0, 12, 24);
  drawSlot(ctx, state, 1, 268, 24);

  drawCurves(ctx, state);

  for (let g = 0; g < GOODS; g += 1) {
    const x = 12 + g * 100;
    const color = GOOD_COLOR[g] as string;
    ctx.fillStyle = color;
    ctx.fillRect(x, 128, 6, 6);
    text(ctx, strings.market.goods[g] as string, x + 10, 126, 10, color);
    text(ctx, priceOf(state, g), x + 34, 124, 14, COLOR.fg);
    const dev = state.dev[g] as number;
    text(
      ctx,
      dev > 0 ? `+${dev}` : String(dev),
      x + 62,
      128,
      8,
      dev === 0 ? COLOR.mid : COLOR.warning,
    );
    text(ctx, (state.inv[0] as readonly number[])[g] as number, x + 6, 148, 16, HUMAN);
    text(ctx, (state.inv[1] as readonly number[])[g] as number, x + 62, 148, 16, AI);
  }

  drawHistory(ctx, state);
}
