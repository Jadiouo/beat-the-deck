import { COLOR } from '../../shell/palette';
import { START_LIMIT } from './logic';
import type { H2State, Racer } from './logic';
import { ROUNDS } from '../_hearts/logic';
import { bar, clear, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';

/**
 * H-2 的畫面：兩條直立的引信（人在左、AI 在右），按著時一條由下往上長的條（`acc / 600`）。
 * **引信長度不畫**，要等這一局兩邊都結束（`revealed`）才在條旁邊畫一條橫線標出來。
 */

const TOP = 40;
const HEIGHT = 150;
const WIDTH = 40;
const MAX_FUSE = 600;

function columnX(side: 0 | 1): number {
  return side === 0 ? 70 : 210;
}

function drawRacer(ctx: CanvasRenderingContext2D, state: H2State, racer: Racer, side: 0 | 1): void {
  const x = columnX(side);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x, TOP, WIDTH, HEIGHT);
  frame(ctx, x, TOP, WIDTH, HEIGHT, COLOR.mid);

  const color = racer.status === 'boom' ? COLOR.heartsDark : sideColor(side);
  const shown = racer.status === 'holding' || racer.status === 'banked' ? racer.acc : 0;
  const filled = Math.round((HEIGHT * Math.min(MAX_FUSE, shown)) / MAX_FUSE);
  ctx.fillStyle = racer.status === 'banked' ? COLOR.light : color;
  ctx.fillRect(x + 2, TOP + HEIGHT - filled, WIDTH - 4, filled);

  // 狀態：按著時頂端一個火花，爆炸時整條畫成暗紅色的叉。
  if (racer.status === 'holding') {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(x + WIDTH / 2 - 3, TOP + HEIGHT - filled - 6, 6, 6);
  } else if (racer.status === 'boom') {
    ctx.fillStyle = COLOR.heartsDark;
    ctx.fillRect(x, TOP + HEIGHT / 2 - 3, WIDTH, 6);
  }

  // 還沒按、60 tick 的倒數。
  if (racer.status === 'idle' && state.phase === 'play') {
    bar(ctx, x, TOP + HEIGHT + 8, WIDTH, 4, 1 - state.roundTick / START_LIMIT, COLOR.warning);
  }

  // 公開之後的引信長度：橫線。
  if (state.revealed) {
    const y = TOP + HEIGHT - Math.round((HEIGHT * state.fuse) / MAX_FUSE);
    ctx.fillStyle = COLOR.fg;
    ctx.fillRect(x - 6, y, WIDTH + 12, 1);
  }

  number(ctx, state.totals[side], x + WIDTH / 2, 10, 20, sideColor(side), 'center');
  number(ctx, shown, x + WIDTH / 2, TOP + HEIGHT + 18, 14, COLOR.light, 'center');
}

export function h2Render(ctx: CanvasRenderingContext2D, state: H2State): void {
  clear(ctx);
  drawRacer(ctx, state, state.players[0], 0);
  drawRacer(ctx, state, state.players[1], 1);

  // 局數：5 個點，已經結束的填滿，現在這一局亮色。
  for (let i = 0; i < ROUNDS; i += 1) {
    const done = i < state.fuses.length;
    ctx.fillStyle = done ? COLOR.light : i === state.round ? HUMAN_COLOR : COLOR.dark;
    ctx.fillRect(140 + i * 8, 20, 6, 6);
  }
}
