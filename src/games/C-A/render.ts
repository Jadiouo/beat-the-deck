import { drawSnakeBoard } from '../_clubs/draw';
import type { ClubsState } from '../_clubs/logic';

/** C-A 的畫面：整張地圖對兩邊都是完整資訊，沒有任何視野限制。 */
export function cARender(ctx: CanvasRenderingContext2D, state: ClubsState): void {
  drawSnakeBoard(ctx, state);
}
