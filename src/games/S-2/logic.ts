import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  actionsSpades,
  evaluateSpades,
  initSpadesState,
  isOverSpades,
  makeSpadesState,
  scoreSpades,
  stepSpades,
  winnerSpades,
} from '../_spades/logic';
import type { SpadesState, StateOverrides } from '../_spades/logic';

/**
 * S-2 瞄準彈（SPEC 第 10 節；小規格 `docs/cards/S-2.md`）。
 * 落雨的子彈固定每 15 tick 一顆，另外每 45 tick 一顆瞄準玩家的子彈。大部分的邏輯在黑桃共用的 `_spades/logic.ts`。
 */

export type { SpadesState };

/** 測試用：直接構造局面（見 `_spades/logic.ts` 的 `makeSpadesState`）。 */
export function makeState(overrides: StateOverrides = {}): SpadesState {
  return makeSpadesState('aimed', overrides);
}

export const s2Game: Game<SpadesState> = {
  id: 'S-2',

  init(seed: number, config: GameConfig): SpadesState {
    return initSpadesState('aimed', seed, config);
  },

  step(state: SpadesState, inputs: Inputs): SpadesState {
    return stepSpades(state, inputs);
  },

  isOver(state: SpadesState): boolean {
    return isOverSpades(state);
  },

  score(state: SpadesState): readonly [number, number] {
    return scoreSpades(state);
  },

  winner(state: SpadesState): Side | null {
    return winnerSpades(state);
  },

  actions(_state: SpadesState, _side: Side): readonly Buttons[] {
    return actionsSpades();
  },

  evaluate(state: SpadesState, side: Side): { gain: number; danger: number } {
    return evaluateSpades(state, side);
  },
};
