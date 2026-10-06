import { sAGame } from '../S-A/logic';
import type { SpadesState } from '../S-A/logic';
import { sAMeta } from '../S-A/meta';
import { sARender } from '../S-A/render';
import type { RegistryEntry } from '../types';
import { defineEntry } from '../types';

/** 黑桃（S-*）的登記項。只放 `S-` 開頭的牌；順序 A→K。 */
export const spadesEntries: readonly RegistryEntry[] = [
  defineEntry<SpadesState>({
    id: sAMeta.id,
    kind: 'card',
    game: sAGame,
    render: sARender,
    meta: sAMeta,
  }),
];
