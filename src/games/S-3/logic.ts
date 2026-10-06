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
 * S-3 擦彈（SPEC 第 10 節；小規格 `docs/cards/S-3.md`）。
 * 子彈同 S-2，子彈擦身而過有加分：擦彈得 1 分、被打中扣 5 分。大部分的邏輯在黑桃共用的 `_spades/logic.ts`。
 */

export type { SpadesState };

/** 測試用：直接構造局面（見 `_spades/logic.ts` 的 `makeSpadesState`）。 */
export function makeState(overrides: StateOverrides = {}): SpadesState {
  return makeSpadesState('graze', overrides);
}

export const s3Game: Game<SpadesState> = {
  id: 'S-3',

  init(seed: number, config: GameConfig): SpadesState {
    return initSpadesState('graze', seed, config);
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
