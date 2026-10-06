import type { CounterState } from '../../fixtures/counter-game';
import { counterGame } from '../../fixtures/counter-game';
import type { Game } from '../../../src/core/types';
import { counterMeta, counterRender } from '../../../src/games/registry';
import type { CardMeta, RegistryEntry, RenderFn } from '../../../src/games/types';
import { defineEntry } from '../../../src/games/types';
import type { CheckCode } from '../checks';

/**
 * 故意違約的假遊戲都從 counter-game 出發，只覆蓋「一個」方法（或一個 render），
 * 所以它們違反的只有那一條，其他地方都和一個守規矩的遊戲一樣。
 * 登記用 `counter` 這個 id，這樣 `docs/cards/counter.md` 存在，meta 檢查不會被牽連。
 */

export interface BadGame {
  /** 檔名，也是測試標題。 */
  readonly name: string;
  /** 一句話：違反什麼。 */
  readonly violates: string;
  readonly entry: RegistryEntry;
  /** 設計上要抓住它的那一條。 */
  readonly primary: CheckCode;
  /**
   * 同時也會失敗的其他檢查。這些不是「誤報」：它們是同一個問題的必然後果
   * （例如 state 裡有 NaN，core 的 `hashState` 就無法算出 K10 要的雜湊）。
   * 測試會要求「失敗的檢查」剛好等於 primary ＋ collateral，不多也不少。
   */
  readonly collateral: readonly CheckCode[];
  /** 只跑這幾條（例如 slow 很慢，只跑 K11）。 */
  readonly only?: readonly CheckCode[];
  /** 用幾個種子跑；預設 0 到 2。 */
  readonly seeds?: readonly number[];
}

export function makeBadEntry(
  overrides: Partial<Game<CounterState>>,
  options: { render?: RenderFn<CounterState>; meta?: Partial<CardMeta> } = {},
): RegistryEntry {
  const game: Game<CounterState> = { ...counterGame, ...overrides };
  return defineEntry<CounterState>({
    id: 'counter',
    kind: 'fixture',
    game,
    render: options.render ?? counterRender,
    meta: { ...counterMeta, ...options.meta },
  });
}
