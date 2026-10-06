import { COLOR } from '../../shell/palette';
import { AI_COLOR, bar, clear, HUMAN_COLOR, number, sideColor } from '../_hearts/draw';
import { ROUNDS } from '../_hearts/logic';
import { TRACK } from './logic';
import type { H3State, Runner } from './logic';

/**
 * H-3 的畫面：兩條橫的跑道（人在上、AI 在下），右端是懸崖（暗紅色）。
 * 跑者是一個方塊，位置按 `pos / 300000` 的比例；煞車中拖一條尾巴，停下來亮色並標出分數，掉下去畫在跑道下方。
 */

const LEFT = 20;
const WIDTH = 270;
const LANE_TOP = [70, 140] as const;
const LANE_HEIGHT = 36;

function drawLane(ctx: CanvasRenderingContext2D, runner: Runner, side: 0 | 1): void {
  const top = LANE_TOP[side];
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(LEFT, top, WIDTH, LANE_HEIGHT);
  ctx.fillStyle = COLOR.heartsDark;
  ctx.fillRect(LEFT + WIDTH, top, 24, LANE_HEIGHT);

  const x = LEFT + Math.round((Math.min(runner.pos, TRACK + 20000) / TRACK) * WIDTH);
  const color = sideColor(side);
  if (runner.status === 'fallen') {
    ctx.fillStyle = COLOR.heartsDark;
    ctx.fillRect(x - 5, top + LANE_HEIGHT + 4, 10, 10);
    return;
  }
  if (runner.status === 'braking') {
    ctx.fillStyle = COLOR.warning;
    ctx.fillRect(x - 14, top + LANE_HEIGHT / 2 - 1, 12, 2);
  }
  ctx.fillStyle = runner.status === 'stopped' ? COLOR.fg : color;
  ctx.fillRect(x - 5, top + LANE_HEIGHT / 2 - 5, 10, 10);
  if (runner.status === 'stopped') {
    number(ctx, Math.floor(runner.pos / 1000), x, top - 12, 10, color, 'center');
  }
}

export function h3Render(ctx: CanvasRenderingContext2D, state: H3State): void {
  clear(ctx);
  drawLane(ctx, state.runners[0], 0);
  drawLane(ctx, state.runners[1], 1);

  number(ctx, state.totals[0], 60, 10, 20, HUMAN_COLOR, 'center');
  number(ctx, state.totals[1], 260, 10, 20, AI_COLOR, 'center');

  // 局數：5 個點，已經結束的填滿，現在這一局亮色。
  for (let i = 0; i < ROUNDS; i += 1) {
    const done = i < state.roundScores[0].length;
    ctx.fillStyle = done ? COLOR.light : i === state.round ? HUMAN_COLOR : COLOR.dark;
    ctx.fillRect(140 + i * 8, 20, 6, 6);
  }

  // 人的速度：一條細條（2 像素／tick 滿）。
  const mine = state.runners[0];
  if (mine.status === 'running' || mine.status === 'braking') {
    bar(ctx, LEFT, 200, WIDTH, 5, mine.speed / 2000, COLOR.warning);
  }
}
