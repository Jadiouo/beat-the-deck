import { COLOR } from '../../shell/palette';
import { strings } from '../../shell/strings';
import { DEPOSITS, PASS, predictOpponent } from './logic';
import type { D9State } from './logic';

/**
 * D-9 的畫面：32×24 的格子地圖上 10 個礦脈（圓，大小是剩餘存量，旁邊小字是存量），已擺成的採集器是方塊
 * （綠是你、青是 AI）。我的游標是黃色外框；對手的游標與這一輪的鎖定在揭曉前不畫，只在上方顯示「已鎖定／選擇中」。
 * 上方：兩邊的分數（抽到的單位）、第幾輪、一個 0 到 3 格的「AI 的把握」（粗粒度，不說它預測你挑哪個）。
 * 最下面是過去每一輪雙方挑的礦脈名次（1 最肥、× 是作廢、– 是沒擺）。
 */

const HUMAN = COLOR.clubs;
const AI = COLOR.accent;
const CELL = 10;
const GRID_W = 32;

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

function centerOf(cell: number): [number, number] {
  return [(cell % GRID_W) * CELL + CELL / 2, Math.floor(cell / GRID_W) * CELL + CELL / 2];
}

function radiusOf(stock: number): number {
  return stock <= 0 ? 2 : 3 + Math.round(stock / 3);
}

/** 「AI 的把握」：它對「你這一輪挑哪個」的最大機率，分四級（< 0.4、< 0.55、< 0.7、其他）。 */
function confidenceBars(state: D9State): number {
  const q = predictOpponent(state.history, state, 1);
  const top = Math.max(0, ...q);
  return top < 0.4 ? 0 : top < 0.55 ? 1 : top < 0.7 ? 2 : 3;
}

function drawDeposits(ctx: CanvasRenderingContext2D, state: D9State): void {
  state.deposits.forEach((deposit, dep) => {
    const [cx, cy] = centerOf(deposit.cell);
    const r = radiusOf(deposit.stock);
    ctx.fillStyle = deposit.stock > 0 ? COLOR.diamondsDark : COLOR.dark;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, deposit.stock, cx, cy - 4, 8, deposit.stock > 0 ? COLOR.fg : COLOR.mid, 'center');
    let k = 0;
    for (const c of state.coll) {
      if (c.dep === dep) {
        ctx.fillStyle = c.owner === 0 ? HUMAN : AI;
        ctx.fillRect(Math.round(cx - 7 + k * 8), Math.round(cy + r + 1), 6, 6);
        k += 1;
      }
    }
  });
}

function drawCursor(ctx: CanvasRenderingContext2D, state: D9State): void {
  if (state.over || (state.phase !== 'place' && state.pending[0] === null)) {
    return;
  }
  const mine = state.pending[0];
  const dep = mine === null ? (state.sel[0] as number) : mine;
  if (dep < 0 || dep >= DEPOSITS) {
    return;
  }
  const deposit = state.deposits[dep];
  if (deposit === undefined) {
    return;
  }
  const [cx, cy] = centerOf(deposit.cell);
  const r = radiusOf(deposit.stock) + 3;
  ctx.strokeStyle = COLOR.diamonds;
  ctx.lineWidth = mine === null ? 1 : 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

function rankText(rank: number, voided: boolean, pick: number): string {
  if (pick === PASS) {
    return '–';
  }
  return voided ? '×' : String(rank);
}

function drawHistory(ctx: CanvasRenderingContext2D, state: D9State): void {
  const y = 226;
  const x0 = 16;
  state.history.forEach((h, i) => {
    const x = x0 + i * 36;
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(x, y, 32, 12);
    text(ctx, rankText(h.ranks[0], h.voided[0], h.picks[0]), x + 4, y + 2, 8, HUMAN);
    text(ctx, rankText(h.ranks[1], h.voided[1], h.picks[1]), x + 18, y + 2, 8, AI);
  });
}

export function d9Render(ctx: CanvasRenderingContext2D, state: D9State): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);

  drawDeposits(ctx, state);
  drawCursor(ctx, state);

  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 18);
  text(ctx, state.drawn[0], 8, 2, 14, HUMAN);
  text(ctx, state.drawn[1], 312, 2, 14, AI, 'right');
  text(
    ctx,
    strings.deposit.round(Math.min(state.round + 1, state.rounds), state.rounds),
    160,
    2,
    8,
    COLOR.light,
    'center',
  );
  const lockedOpp = state.pending[1] !== null;
  text(
    ctx,
    lockedOpp ? strings.deposit.locked : strings.deposit.choosing,
    312,
    16,
    8,
    lockedOpp ? AI : COLOR.mid,
    'right',
  );
  const bars = confidenceBars(state);
  text(ctx, strings.deposit.confidence, 8, 16, 8, COLOR.mid);
  for (let i = 0; i < 3; i += 1) {
    ctx.fillStyle = i < bars ? COLOR.warning : COLOR.dark;
    ctx.fillRect(80 + i * 8, 17, 6, 6);
  }

  drawHistory(ctx, state);
}
