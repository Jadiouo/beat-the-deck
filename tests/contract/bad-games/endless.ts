import type { CounterState } from '../../fixtures/counter-game';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/** 違反：永遠不 isOver。 */
export const endless: BadGame = {
  name: 'endless',
  violates: 'isOver 永遠是 false（K5 會結束）',
  entry: makeBadEntry({
    isOver(_state: CounterState): boolean {
      return false;
    },
  }),
  primary: 'K5',
  collateral: ['K6', 'K7', 'K10', 'K11'],
};
