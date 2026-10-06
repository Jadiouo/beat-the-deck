import type { CounterState } from '../../fixtures/counter-game';
import type { Inputs } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

type Mutable = { tick: number; scores: [number, number] };

/** 違反：step 直接改動傳進來的 state，再把同一個物件回傳。 */
export const mutating: BadGame = {
  name: 'mutating',
  violates: 'step 改動傳進來的 state（K4）',
  entry: makeBadEntry({
    step(state: CounterState, inputs: Inputs): CounterState {
      if (state.tick >= state.length) {
        return state;
      }
      const mutable = state as unknown as Mutable;
      mutable.tick += 1;
      mutable.scores[0] += inputs[0].a ? 1 : 0;
      mutable.scores[1] += inputs[1].a ? 1 : 0;
      return state;
    },
  }),
  primary: 'K4',
  collateral: [],
};
