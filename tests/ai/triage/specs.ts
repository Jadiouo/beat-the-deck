import type { CardSpec } from './engine';
import { CLUBS_SPECS } from './specs.clubs';
import { DIAMONDS_SPECS } from './specs.diamonds';

/** 所有已寫好的篩檢規格（按花色檔案分組）。 */
export const ALL_SPECS: readonly CardSpec[] = [...CLUBS_SPECS, ...DIAMONDS_SPECS];

const BY_ID = new Map(ALL_SPECS.map((s) => [s.id, s]));

export function specFor(id: string): CardSpec {
  const spec = BY_ID.get(id);
  if (spec === undefined) {
    throw new Error(`還沒有 ${id} 的篩檢規格`);
  }
  return spec;
}
