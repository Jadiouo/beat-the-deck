import type { CardSpec } from './engine';
import { CLUBS_SPECS } from './specs.clubs';
import { CONTROL_DIAMONDS, DIAMONDS_SPECS } from './specs.diamonds';
import { CONTROL_SPADES } from './specs.spades';

/** 對照組（已量過探針 A 的牌；不在那 34 張裡）。 */
export const CONTROL_SPECS: readonly CardSpec[] = [...CONTROL_DIAMONDS, ...CONTROL_SPADES];

/** 那 34 張裡已經寫好規格的。 */
export const TARGET_SPECS: readonly CardSpec[] = [...CLUBS_SPECS, ...DIAMONDS_SPECS];

export const ALL_SPECS: readonly CardSpec[] = [...CONTROL_SPECS, ...TARGET_SPECS];

const BY_ID = new Map(ALL_SPECS.map((s) => [s.id, s]));

export function specFor(id: string): CardSpec {
  const spec = BY_ID.get(id);
  if (spec === undefined) {
    throw new Error(`還沒有 ${id} 的篩檢規格`);
  }
  return spec;
}
