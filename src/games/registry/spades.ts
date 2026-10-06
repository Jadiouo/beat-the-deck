import { s2Game } from '../S-2/logic';
import { s2Meta } from '../S-2/meta';
import { s2Render } from '../S-2/render';
import { s3Game } from '../S-3/logic';
import { s3Meta } from '../S-3/meta';
import { s3Render } from '../S-3/render';
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
];
