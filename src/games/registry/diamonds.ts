import { d2Game } from '../D-2/logic';
import type { D2State } from '../D-2/logic';
import { d2Meta } from '../D-2/meta';
import { d2Render } from '../D-2/render';
import { d3Game } from '../D-3/logic';
import type { D3State } from '../D-3/logic';
import { d3Meta } from '../D-3/meta';
import { d3Render } from '../D-3/render';
import { dAGame } from '../D-A/logic';
import type { DAState } from '../D-A/logic';
import { dAMeta } from '../D-A/meta';
import { dARender } from '../D-A/render';
import { d7Game } from '../D-7/logic';
import type { D7State } from '../D-7/logic';
import { d7Meta } from '../D-7/meta';
import { d7Render } from '../D-7/render';
import { d8Game } from '../D-8/logic';
import type { D8State } from '../D-8/logic';
import { d8Meta } from '../D-8/meta';
import { d8Render } from '../D-8/render';
import { dJGame } from '../D-J/logic';
import type { DJState } from '../D-J/logic';
import { dJMeta } from '../D-J/meta';
import { dJRender } from '../D-J/render';
import { dQGame } from '../D-Q/logic';
import type { DQState } from '../D-Q/logic';
import { dQMeta } from '../D-Q/meta';
import { dQRender } from '../D-Q/render';
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
  defineEntry<D2State>({
    id: d2Meta.id,
    kind: 'card',
    game: d2Game,
    render: d2Render,
    meta: d2Meta,
  }),
  defineEntry<D3State>({
    id: d3Meta.id,
    kind: 'card',
    game: d3Game,
    render: d3Render,
    meta: d3Meta,
  }),
  defineEntry<D7State>({
    id: d7Meta.id,
    kind: 'card',
    game: d7Game,
    render: d7Render,
    meta: d7Meta,
  }),
  defineEntry<D8State>({
    id: d8Meta.id,
    kind: 'card',
    game: d8Game,
    render: d8Render,
    meta: d8Meta,
  }),
  defineEntry<DJState>({
    id: dJMeta.id,
    kind: 'card',
    game: dJGame,
    render: dJRender,
    meta: dJMeta,
  }),
  defineEntry<DQState>({
    id: dQMeta.id,
    kind: 'card',
    game: dQGame,
    render: dQRender,
    meta: dQMeta,
  }),
];
