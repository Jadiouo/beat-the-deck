import type { PolicyKey } from '../../../src/ai/types';
import type { Side } from '../../../src/core/types';
import { findEntry } from '../../../src/games/registry';
import type { CardSpec, Path, SpecialPerturbation, Det } from './engine';

/**
 * 每張牌的篩檢規格（`CardSpec`）怎麼定義：
 * - `comp(side)`：這一邊的元件在 state 裡的路徑；
 * - `legal`：合法性檢查，回傳 null 或簡短的類別原因；
 * - 選配 `special`、`farDonors`、`notScreenable`（見 engine.ts）。
 * 規格從登記表取 `game` 與 `meta.defaultPolicy`，所以不會與真的牌脫鉤。
 */

export interface SpecInput<S> {
  readonly comp: (side: Side, state?: S) => readonly Path[];
  readonly donorOk?: (query: S, donor: S, ai: Side) => boolean;
  readonly entangled?: (side: Side, state?: S) => readonly Path[];
  readonly donorOkRelaxed?: (query: S, donor: S, ai: Side) => boolean;
  readonly mixed?: readonly Path[];
  readonly mixedOk?: (before: S, after: S, preserved: Side) => boolean;
  readonly graftSide?: (query: S, donor: S, ai: Side, side: Side) => S | null;
  readonly legal: (state: S, ai: Side) => string | null;
  readonly special?: (state: S, ai: Side, det: Det) => readonly SpecialPerturbation<S>[];
  readonly teeth?: (state: S, ai: Side) => readonly SpecialPerturbation<S>[];
  readonly farDonors?: boolean;
  readonly sample?: { readonly every?: number; readonly decisionsOnly?: boolean };
  readonly minTicks?: number;
  readonly notScreenable?: string;
}

export function defineSpec<S>(id: string, input: SpecInput<S>, label: string = id): CardSpec {
  const entry = findEntry(id);
  if (entry === undefined) {
    throw new Error(`登記表裡找不到 ${id}`);
  }
  const policy = (entry.meta.defaultPolicy ?? 'pathfinder') as PolicyKey;
  return { id: label, game: entry.game, defaultPolicy: policy, ...input } as unknown as CardSpec;
}

/** `${prefix}.${side}` 路徑的簡寫。 */
export const sideOf =
  (...prefixes: string[]) =>
  (side: Side): readonly Path[] =>
    prefixes.map((p) => `${p}.${side}`);

/** 格子世界共用：寬 32、高 24。 */
export const WIDTH = 32;
export const HEIGHT = 24;
export const CELLS = WIDTH * HEIGHT;
export const cellX = (c: number): number => c % WIDTH;
export const cellY = (c: number): number => Math.floor(c / WIDTH);

export const isCell = (c: unknown): c is number =>
  typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < CELLS;
