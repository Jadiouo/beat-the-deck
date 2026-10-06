export const STORAGE_KEY = 'btd.v1';
export const PROGRESS_VERSION = 1;

export interface CardRecord {
  readonly best: number;
  readonly won: boolean;
}

export interface Settings {
  readonly scanlines: boolean;
}

export interface Progress {
  readonly version: typeof PROGRESS_VERSION;
  readonly cards: Readonly<Record<string, CardRecord>>;
  readonly globalLevel: number;
  readonly lossStreak: number;
  readonly settings: Settings;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Outcome = 'win' | 'loss' | 'draw';

export function defaultProgress(): Progress {
  throw new Error('not implemented');
}
export function parseProgress(_text: string | null): Progress {
  throw new Error('not implemented');
}
export function loadProgress(_storage: StorageLike | null): Progress {
  throw new Error('not implemented');
}
export function saveProgress(_storage: StorageLike | null, _progress: Progress): void {
  throw new Error('not implemented');
}
export function revealedCount(_progress: Progress): number {
  throw new Error('not implemented');
}
export function isUnlocked(_progress: Progress, _id: string): boolean {
  throw new Error('not implemented');
}
export function currentGlobalLevel(_progress: Progress): number {
  throw new Error('not implemented');
}
export function cardLevel(_progress: Progress, _baseLevel: number): number {
  throw new Error('not implemented');
}
export function recordResult(
  _progress: Progress,
  _id: string,
  _score: number,
  _outcome: Outcome,
): Progress {
  throw new Error('not implemented');
}
export function withSettings(_progress: Progress, _settings: Settings): Progress {
  throw new Error('not implemented');
}
