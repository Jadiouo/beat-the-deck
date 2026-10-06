import { dAGame } from '../D-A/logic';
import type { DAState } from '../D-A/logic';
import { dAMeta } from '../D-A/meta';
import { dARender } from '../D-A/render';
import type { RegistryEntry } from '../types';
import { defineEntry } from '../types';

/** 方塊（D-*）的登記項。只放 `D-*` 開頭的牌；順序 A→K。 */
export const diamondsEntries: readonly RegistryEntry[] = [
  defineEntry<DAState>({
    id: dAMeta.id,
    kind: 'card',
    game: dAGame,
    render: dARender,
    meta: dAMeta,
  }),
];
