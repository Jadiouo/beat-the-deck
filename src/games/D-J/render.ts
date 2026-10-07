import { COLOR } from '../../shell/palette';
import { drawArena, drawDisc, drawScores } from '../_diamonds/draw';
import { CELL_SIZE, cellX, cellY, START_CELLS } from '../_diamonds/logic';
import { BAG_LIMIT } from '../D-2/logic';
import { STEAL_TICKS } from './logic';
import type { DJState } from './logic';

/**
 * D-J 的畫面：D-2 的地圖、金幣、基地方框與背包數，再加上偷竊的倒數：
 * 偷的人貼在對手基地旁邊時，對手基地旁邊畫一條短短的橘色長條，越長越快偷到（公開資訊，守的人看得到、來得及回來）。
 */
export function dJRender(ctx: CanvasRenderingContext2D, state: DJState): void {
  drawArena(ctx, state);
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
  // 偷竊的倒數：畫在「被偷的基地」旁邊（裁在畫面裡）。
  for (const thief of [0, 1] as const) {
    const lurk = state.lurk[thief];
    if (lurk > 0) {
      const victimBase = START_CELLS[thief === 0 ? 1 : 0];
      const width = Math.round((lurk / STEAL_TICKS) * 3 * CELL_SIZE);
      const x = Math.max(0, Math.min(320 - 3 * CELL_SIZE, (cellX(victimBase) - 1) * CELL_SIZE));
      const y = Math.max(
        0,
        Math.min(
          240 - 3,
          (cellY(victimBase) + (cellY(victimBase) < 12 ? 1 : -1)) * CELL_SIZE + CELL_SIZE / 2,
        ),
      );
      ctx.fillStyle = COLOR.warning;
      ctx.fillRect(x, y, width, 3);
    }
  }
  const label = (bag: number): string => (bag > 0 ? ` +${bag}${bag >= BAG_LIMIT ? '!' : ''}` : '');
  drawScores(ctx, state, [label(state.bags[0]), label(state.bags[1])]);
}
