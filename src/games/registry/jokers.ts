import { jkrGame } from '../JK-R/logic';
import type { JkrState } from '../JK-R/logic';
import { jkrMeta } from '../JK-R/meta';
import { jkrRender } from '../JK-R/render';
import type { RegistryEntry } from '../types';
import { defineEntry } from '../types';

/** 鬼牌（JK-*）的登記項。只放 `JK-*` 開頭的牌；JK-B 還沒做。 */
export const jokersEntries: readonly RegistryEntry[] = [
  defineEntry<JkrState>({
    id: jkrMeta.id,
    kind: 'card',
    game: jkrGame,
    render: jkrRender,
    meta: jkrMeta,
  }),
];
