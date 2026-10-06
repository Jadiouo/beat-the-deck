import type { CounterState } from '../../fixtures/counter-game';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/** 違反：render 用了色盤以外的顏色（純紅），而且畫得規規矩矩。 */
export const renderColor: BadGame = {
  name: 'render-color',
  violates: 'render 用了色盤外的顏色 #ff0000（R2）',
  entry: makeBadEntry(
    {},
    {
      render(ctx: CanvasRenderingContext2D, state: CounterState): void {
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, 10 + state.tick, 10);
      },
    },
  ),
  primary: 'R2',
  collateral: [],
};
