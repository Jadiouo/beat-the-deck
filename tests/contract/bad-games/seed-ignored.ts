import type { CounterState } from '../../fixtures/counter-game';
import { counterGame } from '../../fixtures/counter-game';
import type { GameConfig } from '../../../src/core/types';
import type { BadGame } from './make';
import { makeBadEntry } from './make';

/**
 * 違反：init 完全忽略種子（永遠用種子 0 開局），所以不管給什麼種子，同一串輸入都走出同一個結局。
 * 這正是「忘了把 `nextFrom` 回傳的新 RngState 寫回 state」會變成的樣子：遊戲更決定性了，
 * K1（同種子兩次一樣）反而全部通過，只有 K13（不同種子要不一樣）抓得到。
 * counter-game 的 state 會記下種子，所以這裡連記下來的種子也固定成 0，終局雜湊才會全部相同。
 */
export const seedIgnored: BadGame = {
  name: 'seed-ignored',
  violates: 'init 忽略種子，不同種子跑出一模一樣的對局（K13 種子有效）',
  entry: makeBadEntry({
    init(_seed: number, config: GameConfig): CounterState {
      return counterGame.init(0, config);
    },
  }),
  primary: 'K13',
  collateral: [],
};
