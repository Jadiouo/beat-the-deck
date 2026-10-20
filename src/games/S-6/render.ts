import { COLOR } from '../../shell/palette';
import {
  COMPOSE_TICKS,
  DROP_TICKS,
  NOTE_TICKS,
  PLAY_TICKS,
  ROUNDS,
  SLOTS,
  SLOT_TICKS,
} from './logic';
import type { Note, S6State, Skill } from './logic';

/**
 * S-6 節拍的畫面：左邊是你要打的軌道（對手編的曲子），右邊是 AI 要打的軌道（你編的曲子）。
 * 編曲時只畫自己的草稿，對手的草稿看不到（隱藏資訊）；底下是兩邊最近 5 回合的準度條（公開）。
 * 只讀 state，只用色盤裡的顏色。
 */
const LANE_W = 26;
const FIELD_X = [24, 190] as const;
const LINE_Y = 150;
const PX_PER_TICK = 1.6;
const LANE_COLORS = [COLOR.hearts, COLOR.diamonds, COLOR.clubs, COLOR.spades] as const;

function laneAccuracy(history: readonly Skill[], lane: number): number {
  let e = 0;
  let n = 0;
  for (const h of history) {
    e += h.laneE[lane] as number;
    n += h.laneN[lane] as number;
  }
  return n === 0 ? 0 : e / (3 * n);
}

function drawField(
  ctx: CanvasRenderingContext2D,
  state: S6State,
  side: 0 | 1,
  playing: readonly Note[],
): void {
  const x0 = FIELD_X[side];
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(x0 - 2, 20, LANE_W * 4 + 4, LINE_Y + 12);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(x0, 22, LANE_W * 4, LINE_Y + 8);
  if (state.phase === 'play') {
    for (const n of playing) {
      const start = DROP_TICKS + SLOT_TICKS * n.slot;
      const bottom = LINE_Y + (state.phaseTick - start) * PX_PER_TICK;
      const top = bottom - NOTE_TICKS * PX_PER_TICK;
      if (bottom < 22 || top > LINE_Y + 30) {
        continue;
      }
      ctx.fillStyle = LANE_COLORS[n.lane] as string;
      const y = Math.max(22, top);
      ctx.fillRect(x0 + n.lane * LANE_W + 2, y, LANE_W - 4, Math.min(bottom, LINE_Y + 30) - y);
    }
  }
  ctx.fillStyle = COLOR.light;
  ctx.fillRect(x0, LINE_Y, LANE_W * 4, 2);
  for (let l = 0; l < 4; l += 1) {
    const pressed = (state.held[side] & (1 << l)) !== 0;
    ctx.fillStyle = pressed ? (LANE_COLORS[l] as string) : COLOR.mid;
    ctx.fillRect(x0 + l * LANE_W + 4, LINE_Y + 8, LANE_W - 8, 10);
  }
}

function drawComposeRow(ctx: CanvasRenderingContext2D, state: S6State): void {
  // 自己的草稿：8 格，游標掃過；對手的草稿不畫。
  const cursor = Math.floor(state.phaseTick / SLOT_TICKS);
  for (let s = 0; s < SLOTS; s += 1) {
    const x = FIELD_X[0] + s * 13;
    ctx.fillStyle = s === cursor && state.phase === 'compose' ? COLOR.light : COLOR.dark;
    ctx.fillRect(x, 40, 11, 40);
  }
  for (const n of state.composing[0]) {
    ctx.fillStyle = LANE_COLORS[n.lane] as string;
    ctx.fillRect(FIELD_X[0] + n.slot * 13, 40 + n.lane * 10, 11, 8);
  }
  for (let s = 0; s < SLOTS; s += 1) {
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(FIELD_X[1] + s * 13, 40, 11, 40);
  }
  ctx.fillStyle = COLOR.mid;
  ctx.fillRect(FIELD_X[1] + 4, 58, 96, 4);
}

function drawBars(ctx: CanvasRenderingContext2D, state: S6State): void {
  for (const side of [0, 1] as const) {
    for (let l = 0; l < 4; l += 1) {
      const a = laneAccuracy(state.history[side], l);
      const h = Math.round(a * 28);
      ctx.fillStyle = COLOR.dark;
      ctx.fillRect(FIELD_X[side] + l * LANE_W + 4, 196, LANE_W - 8, 30);
      ctx.fillStyle = LANE_COLORS[l] as string;
      ctx.fillRect(FIELD_X[side] + l * LANE_W + 4, 226 - h, LANE_W - 8, h);
    }
  }
}

export function s6Render(ctx: CanvasRenderingContext2D, state: S6State): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);

  if (state.phase === 'compose') {
    drawComposeRow(ctx, state);
  } else {
    drawField(ctx, state, 0, state.phrases[1]);
    drawField(ctx, state, 1, state.phrases[0]);
  }
  drawBars(ctx, state);

  // 進度：這一回合的階段條
  const total = state.phase === 'compose' ? COMPOSE_TICKS : PLAY_TICKS;
  const done = state.phase === 'compose' || state.phase === 'play' ? state.phaseTick / total : 1;
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(100, 6, 120, 4);
  ctx.fillStyle = state.phase === 'compose' ? COLOR.warning : COLOR.accent;
  ctx.fillRect(100, 6, Math.round(120 * done), 4);

  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLOR.spades;
  ctx.fillText(String(state.points[0]), 6, 4);
  ctx.textAlign = 'right';
  ctx.fillStyle = COLOR.accent;
  ctx.fillText(String(state.points[1]), 314, 4);
  ctx.textAlign = 'center';
  ctx.fillStyle = COLOR.light;
  ctx.fillText(String(Math.min(state.round + 1, ROUNDS)), 160, 12);
}
