import type { Buttons, Controller, Game, GameConfig, Inputs } from '../core/types';

export function viewRotationOf(_state: unknown): 0 | 1 | 2 | 3 {
  throw new Error('not implemented');
}

export function screenController<S>(_read: () => Buttons): Controller<S> {
  throw new Error('not implemented');
}

export interface MatchSession<S> {
  readonly game: Game<S>;
  readonly seed: number;
  readonly config: GameConfig;
  state(): S;
  tick(): number;
  inputs(): readonly Inputs[];
  isOver(): boolean;
  advance(): void;
}

export function createMatchSession<S>(
  _game: Game<S>,
  _seed: number,
  _config: GameConfig,
  _c0: Controller<S>,
  _c1: Controller<S>,
): MatchSession<S> {
  throw new Error('not implemented');
}

export interface ReplaySession<S> {
  state(): S;
  tick(): number;
  isOver(): boolean;
  advance(): void;
  hash(): string;
}

export function createReplaySession<S>(
  _game: Game<S>,
  _seed: number,
  _config: GameConfig,
  _inputs: readonly Inputs[],
): ReplaySession<S> {
  throw new Error('not implemented');
}
