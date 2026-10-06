import type { CounterState } from '../../fixtures/counter-game';
import { counterGame } from '../../fixtures/counter-game';
import type { Inputs } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

const SPIN_MS = 25;
const LENGTH = 120; // 120 × 25 毫秒 ＝ 3 秒，超過 K11 的 2 秒上限

/**
 * 違反：每個 tick 都空轉 25 毫秒（測試檔可以讀時鐘，模擬層不行）。
 * 結果仍然是決定性的，只是慢，所以只會被 K11 抓到。為了不讓測試自己跑太久，
 * 只對它跑 K11、一個種子。
 */
export const slow: BadGame = {
  name: 'slow',
  violates: '一場對局要 3 秒（K11 夠快）',
  entry: makeBadEntry({
    init(seed: number): CounterState {
      return { seed, tick: 0, length: LENGTH, scores: [0, 0] };
    },
    step(state: CounterState, inputs: Inputs): CounterState {
      const started = performance.now();
      while (performance.now() - started < SPIN_MS) {
        // 空轉
      }
      return counterGame.step(state, inputs);
    },
  }),
  primary: 'K11',
  collateral: [],
  only: ['K11'],
  seeds: [0],
};
