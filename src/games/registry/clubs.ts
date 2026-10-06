import { c2Game } from '../C-2/logic';
import type { C2State } from '../C-2/logic';
import { c2Meta } from '../C-2/meta';
import { c2Render } from '../C-2/render';
import { c3Game } from '../C-3/logic';
import type { C3State } from '../C-3/logic';
import { c3Meta } from '../C-3/meta';
import { c3Render } from '../C-3/render';
import { cAGame } from '../C-A/logic';
import type { ClubsState } from '../C-A/logic';
import { cAMeta } from '../C-A/meta';
import { cARender } from '../C-A/render';
import type { RegistryEntry } from '../types';
import { defineEntry } from '../types';

/** 梅花（C-*）的登記項。只放 `C-` 開頭的牌；順序 A→K。 */
export const clubsEntries: readonly RegistryEntry[] = [
  defineEntry<ClubsState>({
    id: cAMeta.id,
    kind: 'card',
    game: cAGame,
    render: cARender,
    meta: cAMeta,
  }),
  defineEntry<C2State>({
    id: c2Meta.id,
    kind: 'card',
    game: c2Game,
    render: c2Render,
    meta: c2Meta,
  }),
  defineEntry<C3State>({
    id: c3Meta.id,
    kind: 'card',
    game: c3Game,
    render: c3Render,
    meta: c3Meta,
  }),
];
