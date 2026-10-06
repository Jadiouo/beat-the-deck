import { h2Game } from '../H-2/logic';
import type { H2State } from '../H-2/logic';
import { h2Meta } from '../H-2/meta';
import { h2Render } from '../H-2/render';
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
  defineEntry<H2State>({
    id: h2Meta.id,
    kind: 'card',
    game: h2Game,
    render: h2Render,
    meta: h2Meta,
  }),
];
