import { COLOR } from '../../shell/palette';
import { CELL, COLS, FIELD_H, FIELD_W, GONE, TILES, WINS_NEEDED } from './logic';
import type { S9State } from './logic';

/**
 * S-9 縮小的場地的畫面：一片共用的地板置中。新鮮的格子是藍灰色，崩落中的格子會抖、顏色隨剩下的 tick 變暗
 * （橘 → 深橘 → 深紅），已掉的格子是背景色（看得到底下的洞）。人是藍點、AI 是青點，各有一圈亮色外框。
 * 上方兩邊各有兩個小方塊表示贏的回合數；回合之間的停頓，地板外框變成這一回合贏家的顏色。
 * 完整資訊，所有格子的狀態都畫出來；不畫 AI 的任何推論。只讀 state，只用色盤裡的顏色。
 */
const ORIGIN_X = 85;
const ORIGIN_Y = 20;
const GAP = 1;

function crumbleColor(t: number): string {
  if (t > 30) {
    return COLOR.warning;
  }
  return t > 15 ? COLOR.diamondsDark : COLOR.heartsDark;
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

export function s9Render(ctx: CanvasRenderingContext2D, state: S9State): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);

  const frame =
    state.phase === 'play' || state.outcome === null || state.outcome === 'draw'
      ? COLOR.dark
      : state.outcome === 'side0'
        ? COLOR.spades
        : COLOR.accent;
  ctx.fillStyle = frame;
  ctx.fillRect(ORIGIN_X - 2, ORIGIN_Y - 2, FIELD_W + 4, FIELD_H + 4);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(ORIGIN_X, ORIGIN_Y, FIELD_W, FIELD_H);

  for (let i = 0; i < TILES; i += 1) {
    const t = state.tiles[i] as number;
    if (t === GONE) {
      continue;
    }
    const shake = t > 0 ? (Math.floor(state.tick / 2) % 2 === 0 ? 1 : -1) * (t <= 30 ? 1 : 0) : 0;
    ctx.fillStyle = t === 0 ? COLOR.spadesDark : crumbleColor(t);
    ctx.fillRect(
      ORIGIN_X + (i % COLS) * CELL + GAP + shake,
      ORIGIN_Y + Math.floor(i / COLS) * CELL + GAP,
      CELL - 2 * GAP,
      CELL - 2 * GAP,
    );
  }

  const colors = [COLOR.spades, COLOR.accent] as const;
  for (const side of [0, 1] as const) {
    const p = state.players[side];
    if (state.fell[side]) {
      continue;
    }
    ctx.fillStyle = COLOR.fg;
    disc(ctx, ORIGIN_X + p.x, ORIGIN_Y + p.y, 4);
    ctx.fillStyle = colors[side];
    disc(ctx, ORIGIN_X + p.x, ORIGIN_Y + p.y, 3);
  }

  // 贏的回合數：人在左上、AI 在右上，各 WINS_NEEDED 個小方塊
  for (const side of [0, 1] as const) {
    for (let k = 0; k < WINS_NEEDED; k += 1) {
      ctx.fillStyle = k < state.wins[side] ? colors[side] : COLOR.dark;
      const x = side === 0 ? ORIGIN_X + k * 9 : ORIGIN_X + FIELD_W - 7 - k * 9;
      ctx.fillRect(x, 6, 7, 7);
    }
  }
  // 第幾回合（中間，數字）
  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillStyle = COLOR.light;
  ctx.fillText(String(Math.min(state.round + 1, 4)), ORIGIN_X + FIELD_W / 2, 5);
}
