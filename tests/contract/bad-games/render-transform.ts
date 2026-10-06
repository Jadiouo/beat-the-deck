import { PALETTE } from '../../../src/shell/palette';
import type { CounterState } from '../../fixtures/counter-game';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/**
 * 違反：矩形座標本身在界內，但先 translate 了 300，實際畫到 x=300..350。
 * 證明假 context 有追蹤 transform，不是只看傳進去的數字。
 */
export const renderTransform: BadGame = {
  name: 'render-transform',
  violates: 'render 用 translate 把圖畫出界（R3）',
  entry: makeBadEntry(
    {},
    {
      render(ctx: CanvasRenderingContext2D, _state: CounterState): void {
        ctx.fillStyle = PALETTE[0];
        ctx.save();
        ctx.translate(300, 0);
        ctx.fillRect(0, 0, 50, 10);
        ctx.restore();
      },
    },
  ),
  primary: 'R3',
  collateral: [],
};
