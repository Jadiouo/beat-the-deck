import { COLOR } from '../../shell/palette';
import { AI_COLOR, clear, disc, frame, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import { CHIPS, confidenceLevel, HANDS } from './logic';
import type { Card, HJState } from './logic';

/**
 * H-J 的畫面（只有圖形與數字；牌用 J、Q、K 三個字母）。
 *
 * 上方：兩邊的籌碼（大數字，你在左、AI 在右）、第幾手，AI 那邊的三格是「AI 對你的把握」（只看攤牌的手數）。
 * 中間：你的暗牌（正面）與 AI 的暗牌（背面；攤牌才翻開，棄牌不翻）；這手的動作序列，每個動作一個記號
 * （實心 ＝ 積極 a，空心 ＝ 消極 b），誰先手由顏色看。輪到誰、鎖定中的動作用亮框，**不畫 AI 剛按了什麼**，直到生效。
 * 下方：每一手的紀錄（動作序列、亮出的牌）——這就是 AI 讀你的原料，也是你讀它的原料。
 */

const LETTER: readonly string[] = ['J', 'Q', 'K'];

function cardBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  card: Card | null,
  color: string,
): void {
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x, y, 44, 60);
  frame(ctx, x, y, 44, 60, color);
  if (card !== null) {
    number(ctx, LETTER[card] as string, x + 22, y + 16, 28, color, 'center');
  } else {
    // 背面：斜線感的點
    for (let i = 0; i < 3; i += 1) {
      disc(ctx, x + 12 + i * 10, y + 30, 2, COLOR.mid);
    }
  }
}

function drawHeader(ctx: CanvasRenderingContext2D, state: HJState): void {
  number(ctx, state.chips[0], 12, 6, 20, HUMAN_COLOR);
  number(ctx, state.chips[1], 308, 6, 20, AI_COLOR, 'right');
  number(ctx, `${Math.min(state.hand + 1, HANDS)}/${HANDS}`, 160, 8, 12, COLOR.mid, 'center');
  const confidence = confidenceLevel(state.hands, 1, state.model);
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

function drawActs(
  ctx: CanvasRenderingContext2D,
  acts: readonly number[],
  first: 0 | 1,
  x: number,
  y: number,
  size: number,
  pending: number | null,
  turn: 0 | 1,
): void {
  for (let i = 0; i < acts.length; i += 1) {
    const side = i % 2 === 0 ? first : ((1 - first) as 0 | 1);
    const cx = x + i * (size + 4);
    if (acts[i] === 1) {
      ctx.fillStyle = sideColor(side);
      ctx.fillRect(cx, y, size, size);
    } else {
      frame(ctx, cx, y, size, size, sideColor(side));
    }
  }
  if (pending !== null) {
    // 鎖定中的動作：只畫一個亮框，不畫是積極還是消極（AI 的也一樣）
    const cx = x + acts.length * (size + 4);
    frame(ctx, cx, y, size, size, sideColor(turn));
  }
}

function drawTable(ctx: CanvasRenderingContext2D, state: HJState): void {
  const last = state.last;
  const shown = last?.shown ?? [null, null];
  const mine = state.over ? null : state.cards[0];
  cardBox(ctx, 36, 48, mine, HUMAN_COLOR);
  cardBox(ctx, 240, 48, shown[1], AI_COLOR);
  drawActs(ctx, state.acts, state.first, 100, 66, 20, state.pending, state.turn);
  if (state.phase === 'choose' && state.turn === 0) {
    ctx.fillStyle = HUMAN_COLOR;
    ctx.fillRect(100, 94, 120, 3);
    number(ctx, 'a', 112, 100, 10, COLOR.light);
    number(ctx, 'b', 196, 100, 10, COLOR.light);
  }
  if (last !== null) {
    const net = last.net[0];
    number(
      ctx,
      net > 0 ? `+${net}` : net,
      160,
      118,
      24,
      last.winner === 0 ? HUMAN_COLOR : AI_COLOR,
      'center',
    );
  }
}

function drawHistory(ctx: CanvasRenderingContext2D, state: HJState): void {
  for (let h = 0; h < state.hands.length; h += 1) {
    const record = state.hands[h];
    if (record === undefined) {
      continue;
    }
    const x = 8 + h * 31;
    number(
      ctx,
      record.shown[0] === null ? '-' : (LETTER[record.shown[0]] as string),
      x + 6,
      156,
      10,
      HUMAN_COLOR,
    );
    number(
      ctx,
      record.shown[1] === null ? '-' : (LETTER[record.shown[1]] as string),
      x + 18,
      156,
      10,
      AI_COLOR,
    );
    for (let i = 0; i < record.acts.length; i += 1) {
      const side = i % 2 === 0 ? record.first : ((1 - record.first) as 0 | 1);
      const cy = 174 + i * 10;
      if (record.acts[i] === 1) {
        ctx.fillStyle = sideColor(side);
        ctx.fillRect(x + 8, cy, 14, 7);
      } else {
        frame(ctx, x + 8, cy, 14, 7, sideColor(side));
      }
    }
  }
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(8, 214, 304, 2);
  ctx.fillStyle = HUMAN_COLOR;
  ctx.fillRect(8, 214, Math.round((state.chips[0] * 304) / (2 * CHIPS)), 2);
}

export function hJRender(ctx: CanvasRenderingContext2D, state: HJState): void {
  clear(ctx);
  drawHeader(ctx, state);
  drawTable(ctx, state);
  drawHistory(ctx, state);
}
