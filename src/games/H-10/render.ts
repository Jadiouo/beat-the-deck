import { COLOR } from '../../shell/palette';
import { AI_COLOR, clear, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import { bidOf, confidenceLevel, ITEMS, remainingValue } from './logic';
import type { H10State, Level } from './logic';

/**
 * H-10 的畫面（只有圖形與數字，不放文字）。
 *
 * 上方：兩邊的價值總和（大數字）與剩下的預算（小數字），中間是第幾件，AI 那邊的三格是「AI 對你的把握」
 * （粗粒度，不說它認為你會選哪個檔位）。
 * 第二排：十件物品的價值（順序全部公開）；已經入帳的件塗上贏家的顏色，作廢的畫成暗格，現在這件有亮框。
 * 中間：現在這件的價值，與你的六個檔位這件各是多少籌碼（按鍵標在上面）；你選的那格亮框。
 * AI 選好了只畫一把鎖，**揭示之前不畫它選了什麼**；揭示之後兩邊的出價並排大寫，贏的那邊亮。
 * 下方：每一件的雙方出價紀錄（你在上、AI 在下，贏的亮、輸的暗）——這就是 AI 讀你的原料，也是你讀它的原料。
 */

const KEYS: readonly string[] = ['b', '<', 'v', 'a', '>', '^'];
const CELL = 30;

function drawHeader(ctx: CanvasRenderingContext2D, state: H10State): void {
  number(ctx, state.got[0], 12, 6, 20, HUMAN_COLOR);
  number(ctx, state.budget[0], 12, 28, 10, COLOR.light);
  number(ctx, state.got[1], 308, 6, 20, AI_COLOR, 'right');
  number(ctx, state.budget[1], 308, 28, 10, COLOR.light, 'right');
  number(ctx, `${Math.min(state.item + 1, ITEMS)}/${ITEMS}`, 160, 8, 12, COLOR.mid, 'center');
  // AI 對你的把握：三格
  const confidence = confidenceLevel(state.history, 1, state.model);
  for (let i = 0; i < 3; i += 1) {
    const x = 148 + i * 10;
    if (i < confidence) {
      ctx.fillStyle = AI_COLOR;
      ctx.fillRect(x, 26, 8, 8);
    } else {
      frame(ctx, x, 26, 8, 8, COLOR.dark);
    }
  }
}

function drawItems(ctx: CanvasRenderingContext2D, state: H10State): void {
  for (let i = 0; i < ITEMS; i += 1) {
    const x = 10 + i * CELL;
    const y = 44;
    const record = state.history[i];
    if (record !== undefined) {
      ctx.fillStyle = record.winner === null ? COLOR.dark : sideColor(record.winner);
      ctx.fillRect(x, y, CELL - 2, 22);
      number(ctx, record.value, x + (CELL - 2) / 2, y + 5, 12, COLOR.bg, 'center');
    } else {
      frame(ctx, x, y, CELL - 2, 22, i === state.item && !state.over ? COLOR.fg : COLOR.dark);
      number(ctx, state.values[i] as number, x + (CELL - 2) / 2, y + 5, 12, COLOR.mid, 'center');
    }
  }
}

function drawChoices(ctx: CanvasRenderingContext2D, state: H10State): void {
  const value = state.values[Math.min(state.item, ITEMS - 1)] as number;
  const rest = remainingValue(state.values, Math.min(state.item, ITEMS - 1));
  number(ctx, value, 160, 74, 40, COLOR.fg, 'center');
  const mine = state.pending[0];
  for (let level = 0; level < 6; level += 1) {
    const x = 20 + level * 46;
    const y = 124;
    const chosen = mine === level;
    ctx.fillStyle = chosen ? HUMAN_COLOR : COLOR.dark;
    ctx.fillRect(x, y, 42, 30);
    number(ctx, KEYS[level] as string, x + 4, y + 2, 8, chosen ? COLOR.bg : COLOR.mid);
    number(
      ctx,
      bidOf(level as Level, value, state.budget[0], rest),
      x + 21,
      y + 12,
      14,
      chosen ? COLOR.bg : COLOR.light,
      'center',
    );
  }
  // AI 選好了：只畫一把鎖，不畫它選了什麼
  if (state.pending[1] !== null && state.phase !== 'resolve') {
    ctx.fillStyle = AI_COLOR;
    ctx.fillRect(296, 76, 14, 10);
    frame(ctx, 299, 70, 8, 8, AI_COLOR);
  }
}

function drawReveal(ctx: CanvasRenderingContext2D, state: H10State): void {
  const last = state.last;
  if (last === null) {
    return;
  }
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 100, 320, 60);
  for (const side of [0, 1] as const) {
    const x = side === 0 ? 70 : 250;
    const won = last.winner === side;
    number(ctx, last.bids[side], x, 108, 36, won ? sideColor(side) : COLOR.mid, 'center');
    if (won) {
      ctx.fillStyle = sideColor(side);
      ctx.fillRect(x - 40, 148, 80, 3);
    }
  }
  if (last.winner === null) {
    number(ctx, '=', 160, 112, 28, COLOR.warning, 'center');
  }
}

function drawHistory(ctx: CanvasRenderingContext2D, state: H10State): void {
  for (let i = 0; i < state.history.length; i += 1) {
    const record = state.history[i];
    if (record === undefined) {
      continue;
    }
    const x = 10 + i * CELL;
    number(ctx, record.value, x + 13, 168, 9, COLOR.mid, 'center');
    for (const side of [0, 1] as const) {
      const won = record.winner === side;
      const dim = record.winner === null || !won;
      number(
        ctx,
        record.bids[side],
        x + 13,
        182 + side * 22,
        12,
        dim ? COLOR.dark : sideColor(side),
        'center',
      );
      // 檔位：細條，越高越長
      ctx.fillStyle = side === 0 ? COLOR.heartsDark : COLOR.mid;
      ctx.fillRect(
        x + 2,
        196 + side * 22,
        Math.round(((record.levels[side] as number) * 22) / 5),
        2,
      );
    }
  }
}

export function h10Render(ctx: CanvasRenderingContext2D, state: H10State): void {
  clear(ctx);
  drawHeader(ctx, state);
  drawItems(ctx, state);
  drawChoices(ctx, state);
  if (state.phase === 'resolve') {
    drawReveal(ctx, state);
  }
  drawHistory(ctx, state);
}
