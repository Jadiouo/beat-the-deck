import type { CounterState } from '../../fixtures/counter-game';
import { counterGame } from '../../fixtures/counter-game';
import type { Inputs } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/** 違反：宣稱對稱（symmetric: true），但 0 號邊每個 tick 都白送 1 分。 */
export const asymmetric: BadGame = {
  name: 'asymmetric',
  violates: '宣稱對稱但 0 號邊白送分數（K12）',
  entry: makeBadEntry(
    {
      step(state: CounterState, inputs: Inputs): CounterState {
        const next = counterGame.step(state, inputs);
        if (next.tick === state.tick) {
          return next;
        }
        return { ...next, scores: [next.scores[0] + 1, next.scores[1]] };
      },
    },
    { meta: { symmetric: true } },
  ),
  primary: 'K12',
  collateral: [],
};
