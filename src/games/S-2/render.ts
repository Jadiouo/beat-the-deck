import { drawFields, drawNumbers } from '../_spades/draw';
import type { SpadesState } from '../_spades/logic';
import { scoreSpades } from '../_spades/logic';

/** S-2 的畫面：與 S-A 一樣；瞄準彈與一般子彈畫成一樣，玩家要自己看軌跡判斷。 */
export function s2Render(ctx: CanvasRenderingContext2D, state: SpadesState): void {
  drawFields(ctx, state);
  const [human, ai] = scoreSpades(state);
  drawNumbers(ctx, human, ai);
}
