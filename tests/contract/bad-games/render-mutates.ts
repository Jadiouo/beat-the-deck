import { PALETTE } from '../../../src/shell/palette';
import type { CounterState } from '../../fixtures/counter-game';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/** 違反：render 畫完之後改了 state（對凍結的 state 會丟 TypeError）。 */
export const renderMutates: BadGame = {
  name: 'render-mutates',
  violates: 'render 改動 state（R1）',
  entry: makeBadEntry(
    {},
    {
      render(ctx: CanvasRenderingContext2D, state: CounterState): void {
        ctx.fillStyle = PALETTE[0];
        ctx.fillRect(0, 0, 10, 10);
        (state as unknown as { tick: number }).tick = 999;
      },
    },
  ),
  primary: 'R1',
  collateral: [],
};
