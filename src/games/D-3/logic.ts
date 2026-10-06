import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import type { BaseOverrides, DiamondsBase } from '../_diamonds/logic';

/** D-3 會貶值的寶石（空殼：先寫測試，實作在下一個 commit）。 */

export const GEM_COUNT = 5;
export const START_VALUE = 9;
export const DECAY_EVERY = 60;
export const MIN_VALUE = 1;
export const LINGER = 120;
/** 出生後第幾個 tick 消失。 */
export const LIFETIME = (START_VALUE - MIN_VALUE) * DECAY_EVERY + LINGER;

export interface Gem {
  readonly cell: number;
  readonly born: number;
}

export interface D3State extends DiamondsBase {
  readonly gems: readonly Gem[];
}

export interface StateOverrides extends BaseOverrides {
  readonly gems?: readonly Gem[];
}

export function gemValue(_tick: number, _born: number): number {
  throw new Error('not implemented');
}

export function makeState(_overrides: StateOverrides = {}): D3State {
  throw new Error('not implemented');
}

export const d3Game: Game<D3State> = {
  id: 'D-3',
  init(_seed: number, _config: GameConfig): D3State {
    throw new Error('not implemented');
  },
  step(_state: D3State, _inputs: Inputs): D3State {
    throw new Error('not implemented');
  },
  isOver(_state: D3State): boolean {
    throw new Error('not implemented');
  },
  score(_state: D3State): readonly [number, number] {
    throw new Error('not implemented');
  },
  winner(_state: D3State): Side | null {
    throw new Error('not implemented');
  },
  actions(_state: D3State, _side: Side): readonly Buttons[] {
    throw new Error('not implemented');
  },
  evaluate(_state: D3State, _side: Side): { gain: number; danger: number } {
    throw new Error('not implemented');
  },
};
