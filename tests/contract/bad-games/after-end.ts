import type { CounterState } from '../../fixtures/counter-game';
import { counterGame } from '../../fixtures/counter-game';
import type { Inputs } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/** 違反：遊戲結束之後 step 還在改分數。 */
export const afterEnd: BadGame = {
  name: 'after-end',
  violates: '結束後 step 還讓分數增加（K6）',
  entry: makeBadEntry({
    step(state: CounterState, inputs: Inputs): CounterState {
      if (state.tick >= state.length) {
        return { ...state, scores: [state.scores[0] + 1, state.scores[1]] };
      }
      return counterGame.step(state, inputs);
    },
  }),
  primary: 'K6',
  collateral: [],
};
