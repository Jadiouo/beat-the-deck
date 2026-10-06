import type { CounterState } from '../../fixtures/counter-game';
import { counterGame } from '../../fixtures/counter-game';
import type { Inputs } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/**
 * 違反：state 裡有函式。JSON 來回之後函式就不見了，state 不是純資料。
 * （函式不是 NaN／Infinity／undefined，所以 K3 不管它；K2 是專門抓這種的。）
 */
export const functionInState: BadGame = {
  name: 'function-in-state',
  violates: 'state 裡有函式，JSON 來回會遺失（K2）',
  entry: makeBadEntry({
    step(state: CounterState, inputs: Inputs): CounterState {
      const next = { ...counterGame.step(state, inputs), helper: () => 1 };
      return next;
    },
  }),
  primary: 'K2',
  // core 的 hashState 對函式丟錯，所以 playMatch 版本的 K10、K11 也會失敗。
  collateral: ['K10', 'K11'],
};
