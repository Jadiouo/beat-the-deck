import { COLOR } from '../../shell/palette';
import { drawArena, drawDisc, drawScores } from '../_diamonds/draw';
import { CELL_SIZE, cellX, cellY, START_CELLS } from '../_diamonds/logic';
import { BAG_LIMIT } from './logic';
import type { D2State } from './logic';

/** D-2 的畫面：D-A 的地圖與金幣，加上兩個基地的方框與背包數；整張地圖對兩邊都是完整資訊。 */
export function d2Render(ctx: CanvasRenderingContext2D, state: D2State): void {
  drawArena(ctx, state);
  // 基地：角色顏色的方框（畫在格子裡面）。
  const colors = [COLOR.clubs, COLOR.accent] as const;
  START_CELLS.forEach((base, side) => {
    ctx.strokeStyle = colors[side as 0 | 1];
    ctx.lineWidth = 1;
    ctx.strokeRect(
      cellX(base) * CELL_SIZE + 0.5,
      cellY(base) * CELL_SIZE + 0.5,
      CELL_SIZE - 1,
      CELL_SIZE - 1,
    );
  });
  for (const coin of state.coins) {
    drawDisc(ctx, coin, 4, COLOR.diamonds);
  }
  const label = (bag: number): string => (bag > 0 ? ` +${bag}${bag >= BAG_LIMIT ? '!' : ''}` : '');
  drawScores(ctx, state, [label(state.bags[0]), label(state.bags[1])]);
}
