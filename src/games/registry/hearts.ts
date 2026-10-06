import { hAGame } from '../H-A/logic';
import type { HAState } from '../H-A/logic';
import { hAMeta } from '../H-A/meta';
import { hARender } from '../H-A/render';
import type { RegistryEntry } from '../types';
import { defineEntry } from '../types';

/** 紅心（H-*）的登記項。只放 `H-*` 開頭的牌；順序 A→K。 */
export const heartsEntries: readonly RegistryEntry[] = [
  defineEntry<HAState>({
    id: hAMeta.id,
    kind: 'card',
    game: hAGame,
    render: hARender,
    meta: hAMeta,
  }),
];
