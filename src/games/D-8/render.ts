import { COLOR } from '../../shell/palette';
import { drawArena, drawScores } from '../_diamonds/draw';
import { CELL_SIZE, CELLS, cellX, cellY } from '../_diamonds/logic';
import { PROTECT_TICKS } from './logic';
import type { D8State } from './logic';

/**
 * D-8 的畫面：先畫地圖與兩個角色（共用的 `drawArena`），再把顏色格子畫在上面（角色腳下那一格不蓋，看得出人在哪）。
 * 人的顏色是暗綠、AI 的是暗藍；剛塗上去、還在保護期的格子畫亮一點（人亮綠、AI 青色），看得出「這幾格塗不掉」。
 */
export function d8Render(ctx: CanvasRenderingContext2D, state: D8State): void {
  drawArena(ctx, state);
  const standing = new Set<number>([state.players[0].cell, state.players[1].cell]);
  for (let i = 0; i < CELLS; i += 1) {
    const p = state.paint[i];
    if (p === 0 || p === undefined || standing.has(i)) {
      continue;
    }
    const fresh = state.tick - (state.stamp[i] as number) < PROTECT_TICKS;
    ctx.fillStyle =
      p === 1 ? (fresh ? COLOR.clubs : COLOR.clubsDark) : fresh ? COLOR.accent : COLOR.spadesDark;
    ctx.fillRect(cellX(i) * CELL_SIZE + 1, cellY(i) * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2);
  }
  drawScores(ctx, state);
}
