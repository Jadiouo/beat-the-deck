import { drawFields, drawNumbers } from '../_spades/draw';
import type { SpadesState } from '../_spades/logic';
import { scoreSpades } from '../_spades/logic';

/** S-A 的畫面：兩個場地都是完整資訊，上方是兩邊的分數（命中數的負數）。 */
export function sARender(ctx: CanvasRenderingContext2D, state: SpadesState): void {
  drawFields(ctx, state);
  const [human, ai] = scoreSpades(state);
  drawNumbers(ctx, human, ai);
}
