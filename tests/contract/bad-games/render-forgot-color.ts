import type { CounterState } from '../../fixtures/counter-game';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/**
 * 違反：render 完全沒設顏色就畫圖，吃到瀏覽器預設的 #000000（不在色盤裡）。
 * 假的 context 要連「實際用到」的顏色都記錄，才抓得到這種。
 */
export const renderForgotColor: BadGame = {
  name: 'render-forgot-color',
  violates: 'render 沒設 fillStyle 就畫，用到預設的黑色（R2）',
  entry: makeBadEntry(
    {},
    {
      render(ctx: CanvasRenderingContext2D, state: CounterState): void {
        ctx.fillRect(0, 0, 10 + state.tick, 10);
      },
    },
  ),
  primary: 'R2',
  collateral: [],
};
