import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  evaluateClubs,
  initClubsState,
  makeState,
  orderedActions,
  stepClubs,
} from '../_clubs/logic';
import type { ClubsState } from '../_clubs/logic';

/**
 * C-A 貪食蛇對決（SPEC 第 10 節；小規格 `docs/cards/C-A.md`）。
 * 兩條蛇、同一張地圖、搶食物：吃到食物加 1 分、長度加 1。大部分的邏輯在梅花共用的 `_clubs/logic.ts`。
 */

export { makeState };
export type { ClubsState };

export const cAGame: Game<ClubsState> = {
  id: 'C-A',

  init(seed: number, config: GameConfig): ClubsState {
    return initClubsState(seed, config);
  },

  step(state: ClubsState, inputs: Inputs): ClubsState {
    // 一個 tick 的規則（轉向鎖定、走格、死亡優先、補食物）與 C-2 共用，放在 `_clubs/logic.ts` 的 `stepClubs`。
    return stepClubs(state, inputs);
  },

  isOver(state: ClubsState): boolean {
    return state.over;
  },

  score(state: ClubsState): readonly [number, number] {
    return [state.snakes[0].score, state.snakes[1].score];
  },

  winner(state: ClubsState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: ClubsState, side: Side): readonly Buttons[] {
    return orderedActions(state, side);
  },

  evaluate(state: ClubsState, side: Side): { gain: number; danger: number } {
    return evaluateClubs(state, side);
  },
};
