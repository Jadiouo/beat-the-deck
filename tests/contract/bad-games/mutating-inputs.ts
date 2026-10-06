import type { CounterState } from '../../fixtures/counter-game';
import { counterGame } from '../../fixtures/counter-game';
import type { Inputs } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/**
 * 違反：step 算完之後把拿到的輸入「用掉」（把 a 改成 false）。
 * playMatch 存進紀錄的就是同一個物件，所以紀錄被悄悄改掉，重播的結果就和原本的對局不同。
 */
export const mutatingInputs: BadGame = {
  name: 'mutating-inputs',
  violates: 'step 改動傳進來的輸入，連帶讓重播對不上（K4）',
  entry: makeBadEntry({
    step(state: CounterState, inputs: Inputs): CounterState {
      const next = counterGame.step(state, inputs);
      (inputs[0] as { a: boolean }).a = false;
      (inputs[1] as { a: boolean }).a = false;
      return next;
    },
  }),
  primary: 'K4',
  // 紀錄被改掉，replay 與原本的對局不同（K10）；K2 拿同一組（已被改掉的）輸入去推進復原的 state，也對不上。
  collateral: ['K2', 'K10'],
};
