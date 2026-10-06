import { PALETTE } from '../../../src/shell/palette';
import type { CounterState } from '../../fixtures/counter-game';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/** 違反：render 的矩形畫到 x=400，遠超過 320×240（顏色是合法的）。 */
export const renderBounds: BadGame = {
  name: 'render-bounds',
  violates: 'render 畫出界（R3）',
  entry: makeBadEntry(
    {},
    {
      render(ctx: CanvasRenderingContext2D, _state: CounterState): void {
        ctx.fillStyle = PALETTE[0];
        ctx.fillRect(300, 200, 100, 100);
      },
    },
  ),
  primary: 'R3',
  collateral: [],
};
