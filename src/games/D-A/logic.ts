import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import type { BaseOverrides, DiamondsBase } from '../_diamonds/logic';

/** D-A 搶金幣（空殼：先寫測試，實作在下一個 commit）。 */

export interface DAState extends DiamondsBase {
  readonly coins: readonly number[];
}

export interface StateOverrides extends BaseOverrides {
  readonly coins?: readonly number[];
}

export function makeState(_overrides: StateOverrides = {}): DAState {
  throw new Error('not implemented');
}

export const dAGame: Game<DAState> = {
  id: 'D-A',
  init(_seed: number, _config: GameConfig): DAState {
    throw new Error('not implemented');
  },
  step(_state: DAState, _inputs: Inputs): DAState {
    throw new Error('not implemented');
  },
  isOver(_state: DAState): boolean {
    throw new Error('not implemented');
  },
  score(_state: DAState): readonly [number, number] {
    throw new Error('not implemented');
  },
  winner(_state: DAState): Side | null {
    throw new Error('not implemented');
  },
  actions(_state: DAState, _side: Side): readonly Buttons[] {
    throw new Error('not implemented');
  },
  evaluate(_state: DAState, _side: Side): { gain: number; danger: number } {
    throw new Error('not implemented');
  },
};
