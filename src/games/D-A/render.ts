import { COLOR } from '../../shell/palette';
import { drawArena, drawDisc, drawScores } from '../_diamonds/draw';
import type { DAState } from './logic';

/** D-A 的畫面：整張地圖對兩邊都是完整資訊，沒有任何視野限制。 */
export function dARender(ctx: CanvasRenderingContext2D, state: DAState): void {
  drawArena(ctx, state);
  for (const coin of state.coins) {
    drawDisc(ctx, coin, 4, COLOR.diamonds);
  }
  drawScores(ctx, state);
}
