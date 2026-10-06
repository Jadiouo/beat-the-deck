import { drawFields, drawNumbers } from '../_spades/draw';
import type { SpadesState } from '../_spades/logic';
import { scoreSpades } from '../_spades/logic';

/** S-3 的畫面：與 S-A 一樣的兩個場地；已經算過擦彈的子彈畫成暗色，上方是兩邊的分數（擦彈數 − 5 × 命中數）。 */
export function s3Render(ctx: CanvasRenderingContext2D, state: SpadesState): void {
  drawFields(ctx, state);
  const [human, ai] = scoreSpades(state);
  drawNumbers(ctx, human, ai);
}
