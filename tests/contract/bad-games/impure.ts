import type { CounterState } from '../../fixtures/counter-game';
import { counterGame } from '../../fixtures/counter-game';
import type { Inputs } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/**
 * 違反：step 用了 Math.random。同樣的種子、同樣的輸入，每次跑出來的 state 都不一樣。
 * 故意放在 tests/ 底下而不是 src/games/**\/logic.ts，才不會被純度掃描器擋下來。
 */
export const impure: BadGame = {
  name: 'impure',
  violates: 'step 用了 Math.random（K1 決定性）',
  entry: makeBadEntry({
    step(state: CounterState, inputs: Inputs): CounterState {
      const next = { ...counterGame.step(state, inputs), luck: Math.random() };
      return next;
    },
  }),
  primary: 'K1',
  collateral: [],
};
