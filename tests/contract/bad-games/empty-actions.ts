import type { Buttons } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/** 違反：actions 回傳空陣列。 */
export const emptyActions: BadGame = {
  name: 'empty-actions',
  violates: 'actions 回傳空陣列（K8）',
  entry: makeBadEntry({
    actions(): readonly Buttons[] {
      return [];
    },
  }),
  primary: 'K8',
  collateral: [],
};
