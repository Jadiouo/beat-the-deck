import { COLOR } from '../../shell/palette';
import { drawFields, drawNumbers } from '../_spades/draw';
import { FIELD_H, FIELD_ORIGIN, FIELD_W, scoreSpades } from '../_spades/logic';
import type { SQState } from './logic';

/** S-Q 的畫面：S-3 的兩個場地加反轉的標示（預告：邊框閃爍；反轉中：橘色邊框）。 */
export function sQRender(ctx: CanvasRenderingContext2D, state: SQState): void {
  drawFields(ctx, state);
  for (const side of [0, 1] as const) {
    const m = state.mirror[side];
    const o = FIELD_ORIGIN[side];
    const blink = Math.floor(state.tick / 4) % 2 === 0;
    if (m.active > 0 || (m.pending > 0 && blink)) {
      ctx.strokeStyle = COLOR.warning;
      ctx.lineWidth = 2;
      ctx.strokeRect(o.x - 1, o.y - 1, FIELD_W + 2, FIELD_H + 2);
    }
  }
  const [human, ai] = scoreSpades(state);
  drawNumbers(ctx, human, ai);
}
