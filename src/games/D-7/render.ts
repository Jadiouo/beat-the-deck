import { COLOR } from '../../shell/palette';
import { drawArena, drawScores } from '../_diamonds/draw';
import { CELL_SIZE, CELLS, cellX, cellY } from '../_diamonds/logic';
import { bandOf } from './logic';
import type { D7State } from './logic';

/** 岩石的顏色：越深越亮（帶 0 到 3）。牆是 `dark` 整格塗滿，岩石內縮一像素，分得出來。 */
const ROCK_COLOR: readonly string[] = [
  COLOR.dark,
  COLOR.spadesDark,
  COLOR.heartsDark,
  COLOR.diamondsDark,
];

/**
 * D-7 的畫面：完整資訊。先畫地圖與兩個角色（共用的 `drawArena`），再畫岩石（顏色依深度帶）、
 * 礦（岩石裡的是黃色價值數字，鑿穿後躺在空格裡的是黃底）、隧道的歸屬（人鑿的是綠點、AI 鑿的是藍點）。
 * 上方兩邊是分數，後面接背包裡的礦的價值（例如 `12 [10,3]`）。只畫數字與符號，沒有中文字串。
 */
export function d7Render(ctx: CanvasRenderingContext2D, state: D7State): void {
  drawArena(ctx, state);
  const standing = new Set<number>([state.players[0].cell, state.players[1].cell]);
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < CELLS; i += 1) {
    const x = cellX(i) * CELL_SIZE;
    const y = cellY(i) * CELL_SIZE;
    const hp = state.rock[i] as number;
    const value = state.ore[i] as number;
    if (hp > 0) {
      ctx.fillStyle = ROCK_COLOR[bandOf(i)] as string;
      ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      if (value > 0) {
        ctx.fillStyle = COLOR.diamonds;
        ctx.fillText(String(value), x + CELL_SIZE / 2, y + CELL_SIZE / 2 + 1);
      }
    } else if (state.walls[i] === 0) {
      const who = state.opened[i];
      if (who === 0 || who === 1) {
        ctx.fillStyle = who === 0 ? COLOR.clubsDark : COLOR.spadesDark;
        ctx.fillRect(x + 4, y + 4, 2, 2);
      }
      if (value > 0 && !standing.has(i)) {
        ctx.fillStyle = COLOR.diamonds;
        ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        ctx.fillStyle = COLOR.bg;
        ctx.fillText(String(value), x + CELL_SIZE / 2, y + CELL_SIZE / 2 + 1);
      }
    }
  }
  const label = (bag: readonly number[]): string => (bag.length > 0 ? ` [${bag.join(',')}]` : '');
  drawScores(ctx, state, [label(state.bag[0]), label(state.bag[1])]);
}
