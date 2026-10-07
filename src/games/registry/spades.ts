import { s2Game } from '../S-2/logic';
import { s2Meta } from '../S-2/meta';
import { s2Render } from '../S-2/render';
import { s3Game } from '../S-3/logic';
import { s3Meta } from '../S-3/meta';
import { s3Render } from '../S-3/render';
import { s5Game } from '../S-5/logic';
import type { S5State } from '../S-5/logic';
import { s5Meta } from '../S-5/meta';
import { s5Render } from '../S-5/render';
import { s7Game } from '../S-7/logic';
import type { S7State } from '../S-7/logic';
import { s7Meta } from '../S-7/meta';
import { s7Render } from '../S-7/render';
import { sJGame } from '../S-J/logic';
import type { SJState } from '../S-J/logic';
import { sJMeta } from '../S-J/meta';
import { sJRender } from '../S-J/render';
import { sQGame } from '../S-Q/logic';
import type { SQState } from '../S-Q/logic';
import { sQMeta } from '../S-Q/meta';
import { sQRender } from '../S-Q/render';
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
  defineEntry<SpadesState>({
    id: s2Meta.id,
    kind: 'card',
    game: s2Game,
    render: s2Render,
    meta: s2Meta,
  }),
  defineEntry<SpadesState>({
    id: s3Meta.id,
    kind: 'card',
    game: s3Game,
    render: s3Render,
    meta: s3Meta,
  }),
  defineEntry<S5State>({
    id: s5Meta.id,
    kind: 'card',
    game: s5Game,
    render: s5Render,
    meta: s5Meta,
  }),
  defineEntry<S7State>({
    id: s7Meta.id,
    kind: 'card',
    game: s7Game,
    render: s7Render,
    meta: s7Meta,
  }),
  defineEntry<SJState>({
    id: sJMeta.id,
    kind: 'card',
    game: sJGame,
    render: sJRender,
    meta: sJMeta,
  }),
  defineEntry<SQState>({
    id: sQMeta.id,
    kind: 'card',
    game: sQGame,
    render: sQRender,
    meta: sQMeta,
  }),
];
