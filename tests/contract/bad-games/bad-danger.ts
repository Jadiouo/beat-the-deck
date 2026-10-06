import type { CounterState } from '../../fixtures/counter-game';
import type { Side } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/** 違反：evaluate 的 danger 超出 0 到 1。 */
export const badDanger: BadGame = {
  name: 'bad-danger',
  violates: 'evaluate 的 danger 是 1.5（K9）',
  entry: makeBadEntry({
    evaluate(state: CounterState, side: Side): { gain: number; danger: number } {
      return { gain: state.scores[side], danger: 1.5 };
    },
  }),
  primary: 'K9',
  collateral: [],
};
