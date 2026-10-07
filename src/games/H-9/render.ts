import { COLOR } from '../../shell/palette';
import { AI_COLOR, clear, drawDie, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import { S_MAX, WINS } from './logic';
import type { H9State } from './logic';

/**
 * H-9 的畫面（只有圖形與數字，不放文字）。
 *
 * 上方：兩邊的勝場（小方塊，實心是贏的回合；一共 3 格）與目前是第幾回合。
 * 中間：目前的喊價（大數字，顏色是喊的人）、輪到誰（該邊的顏色亮一條）、這回合的喊價紀錄（小數字）。
 * 下方：你的兩顆骰子（正面）；AI 的兩顆骰子畫背面，只有抓了、亮骰（`reveal`）之後才畫正面。
 * 這個檔案只讀 state，從 `dice[0]` 讀人的骰子；`dice[1]` 只在 `reveal` 階段才讀。
 */

const DIE = 36;

function drawWins(
  ctx: CanvasRenderingContext2D,
  wins: number,
  x0: number,
  dir: 1 | -1,
  color: string,
): void {
  for (let i = 0; i < WINS; i += 1) {
    const x = dir === 1 ? x0 + i * 14 : x0 - 10 - i * 14;
    if (i < wins) {
      ctx.fillStyle = color;
      ctx.fillRect(x, 10, 10, 10);
    } else {
      frame(ctx, x, 10, 10, 10, COLOR.dark);
    }
  }
}

function drawHiddenDie(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(cx - DIE / 2, cy - DIE / 2, DIE, DIE);
  frame(ctx, cx - DIE / 2, cy - DIE / 2, DIE, DIE, AI_COLOR);
  ctx.fillStyle = AI_COLOR;
  for (let i = 0; i < 3; i += 1) {
    ctx.fillRect(cx - DIE / 2 + 6 + i * 10, cy - DIE / 2 + 6, 4, DIE - 12);
  }
}

export function h9Render(ctx: CanvasRenderingContext2D, state: H9State): void {
  clear(ctx);

  // 上方：勝場與回合
  drawWins(ctx, state.wins[0], 24, 1, HUMAN_COLOR);
  drawWins(ctx, state.wins[1], 296, -1, AI_COLOR);
  number(ctx, state.round, 160, 8, 14, COLOR.mid, 'center');

  // 輪到誰
  const turnX = state.turn === 0 ? 24 : 188;
  ctx.fillStyle = sideColor(state.turn);
  ctx.fillRect(turnX, 30, 108, 2);

  // 中間：目前的喊價
  if (state.bidder !== null) {
    number(ctx, state.S, 160, 56, 40, sideColor(state.bidder), 'center');
  }
  number(ctx, S_MAX, 160, 104, 10, COLOR.dark, 'center');

  // 這回合的喊價紀錄
  const recent = state.bids.slice(-12);
  for (let i = 0; i < recent.length; i += 1) {
    const bid = recent[i] as (typeof recent)[number];
    number(ctx, bid.S, 28 + i * 24, 120, 12, sideColor(bid.side));
  }

  // AI 的骰子（背面；亮骰才看得到）與你的骰子
  const reveal = state.phase === 'reveal';
  for (let k = 0; k < 2; k += 1) {
    const cx = 124 + k * 72;
    if (reveal) {
      drawDie(
        ctx,
        cx,
        158,
        DIE,
        (state.dice[1] as readonly number[])[k] as number,
        COLOR.fg,
        COLOR.dark,
      );
    } else {
      drawHiddenDie(ctx, cx, 158);
    }
    drawDie(
      ctx,
      cx,
      208,
      DIE,
      (state.dice[0] as readonly number[])[k] as number,
      COLOR.fg,
      COLOR.heartsDark,
    );
  }
}
