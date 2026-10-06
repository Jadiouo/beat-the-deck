import type { Buttons } from '../core/types';

export function emptyButtons(): Buttons {
  throw new Error('not implemented');
}

export function rotateButtons(_buttons: Buttons, _r: number): Buttons {
  throw new Error('not implemented');
}

export function mergeButtons(..._all: readonly Buttons[]): Buttons {
  throw new Error('not implemented');
}

export interface KeyboardState {
  keyDown(code: string): void;
  keyUp(code: string): void;
  blur(): void;
  buttons(): Buttons;
  pause(): boolean;
  confirm(): boolean;
}

export function createKeyboardState(): KeyboardState {
  throw new Error('not implemented');
}

export interface PadLike {
  readonly buttons: readonly { readonly pressed: boolean }[];
  readonly axes: readonly number[];
}

export interface PadSnapshot {
  readonly buttons: Buttons;
  readonly pause: boolean;
}

export function readPad(_pad: PadLike | null): PadSnapshot {
  throw new Error('not implemented');
}

export const TOUCH_MAX_WIDTH = 640;

export function shouldShowTouchControls(_width: number): boolean {
  throw new Error('not implemented');
}

export interface InputSnapshot {
  readonly buttons: Buttons;
  readonly confirm: boolean;
  readonly pause: boolean;
}

export function newPresses(_previous: InputSnapshot, _current: InputSnapshot): InputSnapshot {
  throw new Error('not implemented');
}
