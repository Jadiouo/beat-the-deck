import { c10Game } from '../C-10/logic';
import type { C10State } from '../C-10/logic';
import { c10Meta } from '../C-10/meta';
import { c10Render } from '../C-10/render';
import { c2Game } from '../C-2/logic';
import type { C2State } from '../C-2/logic';
import { c2Meta } from '../C-2/meta';
import { c2Render } from '../C-2/render';
import { c3Game } from '../C-3/logic';
import type { C3State } from '../C-3/logic';
import { c3Meta } from '../C-3/meta';
import { c3Render } from '../C-3/render';
import { c4Game } from '../C-4/logic';
import type { C4State } from '../C-4/logic';
import { c4Meta } from '../C-4/meta';
import { c4Render } from '../C-4/render';
import { c8Game } from '../C-8/logic';
import type { C8State } from '../C-8/logic';
import { c8Meta } from '../C-8/meta';
import { c8Render } from '../C-8/render';
import { cAGame } from '../C-A/logic';
import type { ClubsState } from '../C-A/logic';
import { cAMeta } from '../C-A/meta';
import { cARender } from '../C-A/render';
import { cJGame } from '../C-J/logic';
import type { CJState } from '../C-J/logic';
import { cJMeta } from '../C-J/meta';
import { cJRender } from '../C-J/render';
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
  defineEntry<C4State>({
    id: c4Meta.id,
    kind: 'card',
    game: c4Game,
    render: c4Render,
    meta: c4Meta,
  }),
  defineEntry<C8State>({
    id: c8Meta.id,
    kind: 'card',
    game: c8Game,
    render: c8Render,
    meta: c8Meta,
  }),
  defineEntry<C10State>({
    id: c10Meta.id,
    kind: 'card',
    game: c10Game,
    render: c10Render,
    meta: c10Meta,
  }),
  defineEntry<CJState>({
    id: cJMeta.id,
    kind: 'card',
    game: cJGame,
    render: cJRender,
    meta: cJMeta,
  }),
];
