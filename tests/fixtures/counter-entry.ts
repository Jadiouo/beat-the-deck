import { COLOR } from '../../src/shell/palette';
import type { CardMeta, RegistryEntry } from '../../src/games/types';
import { defineEntry } from '../../src/games/types';
import { counterGame } from './counter-game';
import type { CounterState } from './counter-game';

/**
 * counter-game 的替身登記項（kind: 'fixture'），不是真的撲克牌。
 *
 * 它只存在於 `tests/` 底下：`src/games/registry.ts` 只放真牌，正式建置不會打包這個檔案。
 * 契約測試（`tests/contract/all-games.test.ts`）跑的是 `[...registry, counterEntry]`，
 * 讓它繼續當契約檢查自己的對照組，也當故意違約假遊戲的出發點。
 */

export const counterMeta: CardMeta = {
  id: 'counter',
  name: '計數替身',
  description: '測試用的替身牌：按住 A 每個 tick 加 1 分，一百個 tick 後分數高的贏。',
  controls: '按住 A（空白鍵）得分。',
  suit: null,
  rank: null,
  defaultPolicy: null,
  baseLevel: 1,
  symmetric: true,
};

/** 左右兩條分數條，長度與分數成正比。 */
export function counterRender(ctx: CanvasRenderingContext2D, state: CounterState): void {
  const barMax = 140;
  const total = Math.max(1, state.length);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(10, 100, barMax, 20);
  ctx.fillRect(170, 100, barMax, 20);
  ctx.fillStyle = COLOR.clubs;
  ctx.fillRect(10, 100, Math.min(barMax, (state.scores[0] / total) * barMax), 20);
  ctx.fillStyle = COLOR.hearts;
  ctx.fillRect(170, 100, Math.min(barMax, (state.scores[1] / total) * barMax), 20);
  ctx.fillStyle = COLOR.fg;
  ctx.fillText(`${state.scores[0]}`, 10, 90);
  ctx.fillText(`${state.scores[1]}`, 170, 90);
}

export const counterEntry: RegistryEntry = defineEntry<CounterState>({
  id: counterMeta.id,
  kind: 'fixture',
  game: counterGame,
  render: counterRender,
  meta: counterMeta,
});
