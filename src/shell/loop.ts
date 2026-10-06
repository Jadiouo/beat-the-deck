export const TICKS_PER_SECOND = 60;
export const MAX_TICKS_PER_FRAME = 5;

export interface LoopOptions {
  readonly onTick: () => void;
  readonly onRender: () => void;
}

export interface Loop {
  frame(nowMs: number): number;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  setSpeed(multiplier: number): void;
}

export function createLoop(_options: LoopOptions): Loop {
  throw new Error('not implemented');
}
