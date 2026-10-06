import type { CounterState } from '../../fixtures/counter-game';
import { counterGame } from '../../fixtures/counter-game';
import type { Inputs } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/** 違反：state 裡有 NaN（從第一個 step 開始）。 */
export const nan: BadGame = {
  name: 'nan',
  violates: 'state 裡有 NaN（K3）',
  entry: makeBadEntry({
    step(state: CounterState, inputs: Inputs): CounterState {
      const next = { ...counterGame.step(state, inputs), ratio: Number.NaN };
      return next;
    },
  }),
  primary: 'K3',
  // K2：NaN 經過 JSON 來回會變成 null，本來就是 K2 要抓的「不是純資料」。
  // core 的 playMatch／replay 會對最終 state 算 hashState，而 hashState 遇到 NaN 就丟錯，
  // 所以用到 playMatch 的 K10、K11 必然跟著失敗。
  collateral: ['K2', 'K10', 'K11'],
};
