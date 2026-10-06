import { COLOR } from '../../shell/palette';
import { AI_WAIT_TICKS, DECISION_TIMEOUT } from '../_hearts/logic';
import {
  AI_COLOR,
  bar,
  clear,
  drawDie,
  frame,
  HUMAN_COLOR,
  number,
  sideColor,
} from '../_hearts/draw';
import type { HAState } from './logic';

/**
 * H-A 的畫面：完整資訊。左邊人、右邊 AI；輪到的那一邊外框亮起；中間是骰子與這回合的累積；
 * 底部是 300 tick 的超時條（AI 等待時是 45 tick 的倒數）。
 */
export function hARender(ctx: CanvasRenderingContext2D, state: HAState): void {
  clear(ctx);

  for (const side of [0, 1] as const) {
    const x = side === 0 ? 12 : 200;
    const mine = state.turn === side && !state.over;
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(x, 20, 108, 70);
    frame(ctx, x, 20, 108, 70, mine ? sideColor(side) : COLOR.mid);
    number(ctx, state.totals[side], x + 54, 38, 32, sideColor(side), 'center');
    ctx.fillStyle = side === 0 ? HUMAN_COLOR : AI_COLOR;
    ctx.fillRect(x + 4, 24, 8, 8);
  }

  // 骰子：滾動時每 3 個 tick 換一個圖案。
  const rolling = state.phase === 'rolling';
  const face = rolling ? 1 + (Math.floor(state.tick / 3) % 6) : state.lastRoll;
  const bust = !rolling && state.lastRoll === 1 && state.lastEvent === 'bust';
  drawDie(ctx, 160, 62, 44, face, bust ? COLOR.heartsDark : COLOR.fg, bust ? COLOR.fg : COLOR.bg);

  // 這回合累積。
  number(ctx, state.acc, 160, 110, 40, state.turn === 0 ? HUMAN_COLOR : AI_COLOR, 'center');
  number(ctx, state.finalTurn ? '!' : '', 160, 158, 20, COLOR.warning, 'center');

  // 回合數：兩排小點，已經結束的回合填滿。
  for (let i = 0; i < 40; i += 1) {
    const col = i % 20;
    const row = Math.floor(i / 20);
    ctx.fillStyle = i < state.turnsDone ? COLOR.light : COLOR.dark;
    ctx.fillRect(40 + col * 12, 190 + row * 6, 8, 3);
  }

  // 超時條：AI 等待時是倒數（暗色），可以輸入時是 300 tick 的剩餘。
  if (!state.over && state.wait > 0) {
    bar(ctx, 20, 222, 280, 6, state.wait / AI_WAIT_TICKS, COLOR.mid);
  } else if (!state.over) {
    bar(ctx, 20, 222, 280, 6, 1 - state.idle / DECISION_TIMEOUT, COLOR.warning);
  }
}
