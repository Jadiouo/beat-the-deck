import type { Policy } from '../ai/types';
import type { Game, GameConfig } from '../core/types';

export interface EvolutionRun {
  readonly total: number;
  played(): number;
  points(): number;
  done(): boolean;
  rate(): number;
  runNext(): void;
}

export function createEvolutionRun<S>(
  _game: Game<S>,
  _policy: Policy,
  _oldLevel: number,
  _newLevel: number,
  _seed: number,
  _config?: GameConfig,
): EvolutionRun {
  throw new Error('not implemented');
}
