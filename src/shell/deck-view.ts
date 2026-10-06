import type { Progress } from './progress';

export type CellState = 'revealed' | 'playable' | 'locked' | 'unimplemented';
export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function cellState(_progress: Progress, _id: string, _implemented: boolean): CellState {
  throw new Error('not implemented');
}
export function cellRect(_index: number): Rect {
  throw new Error('not implemented');
}
export function cellAt(_x: number, _y: number): number | null {
  throw new Error('not implemented');
}
export function moveCursor(_index: number, _direction: Direction): number {
  throw new Error('not implemented');
}
