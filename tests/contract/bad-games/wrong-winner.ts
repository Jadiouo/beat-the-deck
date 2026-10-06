import type { CounterState } from '../../fixtures/counter-game';
import type { BadGame } from './make';
import type { Side } from '../../../src/core/types';
import { makeBadEntry } from './make';

/** 違反：winner 是分數「低」的那一邊，而且沒有標 winnerNotByScore。 */
export const wrongWinner: BadGame = {
  name: 'wrong-winner',
  violates: 'winner 的分數比較低（K7）',
  entry: makeBadEntry({
    winner(state: CounterState): Side | null {
      if (state.scores[0] < state.scores[1]) {
        return 0;
      }
      if (state.scores[1] < state.scores[0]) {
        return 1;
      }
      return null;
    },
  }),
  primary: 'K7',
  collateral: [],
};
