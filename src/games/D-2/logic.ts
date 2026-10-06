import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import type { DAState, StateOverrides as DAOverrides } from '../D-A/logic';

/** D-2 背包上限（空殼：先寫測試，實作在下一個 commit）。 */

export const BAG_LIMIT = 3;

export interface D2State extends DAState {
  readonly bags: readonly [number, number];
}

export interface StateOverrides extends DAOverrides {
  readonly bags?: readonly [number, number];
}

export function makeState(_overrides: StateOverrides = {}): D2State {
  throw new Error('not implemented');
}

export const d2Game: Game<D2State> = {
  id: 'D-2',
  init(_seed: number, _config: GameConfig): D2State {
    throw new Error('not implemented');
  },
  step(_state: D2State, _inputs: Inputs): D2State {
    throw new Error('not implemented');
  },
  isOver(_state: D2State): boolean {
    throw new Error('not implemented');
  },
  score(_state: D2State): readonly [number, number] {
    throw new Error('not implemented');
  },
  winner(_state: D2State): Side | null {
    throw new Error('not implemented');
  },
  actions(_state: D2State, _side: Side): readonly Buttons[] {
    throw new Error('not implemented');
  },
  evaluate(_state: D2State, _side: Side): { gain: number; danger: number } {
    throw new Error('not implemented');
  },
};
