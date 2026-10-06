import type { RngState } from '../../core/rng';
import type { Side } from '../../core/types';

/**
 * 方塊三張牌（D-A、D-2、D-3）共用的格子世界邏輯（空殼：先寫測試，實作在下一個 commit）。
 */

export const WIDTH = 32;
export const HEIGHT = 24;
export const CELLS = WIDTH * HEIGHT;
export const CELL_SIZE = 10;
export const MOVE_EVERY = 5;
export const WALL_COUNT = 20;
export const MAX_WALL_SETS = 64;

export type Dir = 0 | 1 | 2 | 3;
export const UP: Dir = 0;
export const RIGHT: Dir = 1;
export const DOWN: Dir = 2;
export const LEFT: Dir = 3;
/** 沒有待走方向。 */
export const NO_DIR = -1;
export type Pending = -1 | Dir;

export function cell(x: number, y: number): number {
  return y * WIDTH + x;
}
export function cellX(index: number): number {
  return index % WIDTH;
}
export function cellY(index: number): number {
  return Math.floor(index / WIDTH);
}

export const START_CELLS: readonly [number, number] = [cell(0, HEIGHT - 1), cell(WIDTH - 1, 0)];

export interface Walker {
  readonly cell: number;
  readonly pending: Pending;
  readonly score: number;
}

export interface DiamondsBase {
  readonly tick: number;
  readonly maxTicks: number;
  readonly walls: readonly number[];
  readonly players: readonly [Walker, Walker];
  readonly rng: RngState;
  readonly over: boolean;
  readonly winner: Side | null;
}

export interface WallResult {
  readonly walls: readonly number[];
  readonly attempts: number;
  readonly fallback: boolean;
}

export function generateWalls(_seed: number): WallResult {
  throw new Error('not implemented');
}

export interface BaseOverrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  /** 牆的格子編號清單（state 裡的 `walls` 是 0／1 陣列）。 */
  readonly walls?: readonly number[];
  readonly players?: readonly [Partial<Walker>, Partial<Walker>];
  readonly rng?: RngState;
  readonly over?: boolean;
  readonly winner?: Side | null;
}
