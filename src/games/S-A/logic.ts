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
 * S-A 落雨（SPEC 第 10 節；小規格 `docs/cards/S-A.md`）。
 * 各自的場地、同一串子彈，被打中次數少的贏。大部分的邏輯在黑桃共用的 `_spades/logic.ts`。
 */

export type { SpadesState };

/** 測試用：直接構造局面（見 `_spades/logic.ts` 的 `makeSpadesState`）。 */
export function makeState(overrides: StateOverrides = {}): SpadesState {
  return makeSpadesState('rain', overrides);
}

export const sAGame: Game<SpadesState> = {
  id: 'S-A',

  init(seed: number, config: GameConfig): SpadesState {
    return initSpadesState('rain', seed, config);
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
