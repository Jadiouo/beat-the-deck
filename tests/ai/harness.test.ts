import { describe, expect, it } from 'vitest';

import type { Buttons, Game } from '../../src/core/types';
import { greedy } from '../../src/ai/policies/greedy';
import { random } from '../../src/ai/policies/random';
import type { Policy } from '../../src/ai/types';
import { counterGame } from '../fixtures/counter-game';
import { evolutionReport, measureDecideTimes, seedList, winRate } from './harness';

/**
 * 測試框架本身的測試，與 TEST_PLAN 5.3「AI 進化畫面的數字是真的」。
 * 計時（performance.now）只能寫在 tests/ 底下：src/ai 在純度掃描範圍內。
 */

/** 永遠按 A / 永遠放開：counter-game 上最強與最弱的固定策略。 */
function fixed(name: string, wantA: boolean): Policy {
  return {
    name,
    decide<S>(game: Game<S>, state: S, side: 0 | 1): Buttons {
      const actions = game.actions(state, side);
      return (actions.find((b) => b.a === wantA) ?? actions[0]) as Buttons;
    },
  };
}

const pressA = fixed('press-a', true);
const idle = fixed('idle', false);

describe('seedList：統計測試的種子固定為 0..N-1', () => {
  it('seedList(5) 是 [0,1,2,3,4]', () => {
    expect(seedList(5)).toEqual([0, 1, 2, 3, 4]);
    expect(seedList(0)).toEqual([]);
  });
});

describe('winRate', () => {
  const seeds = seedList(20);

  it('A 永遠贏：1；永遠輸：0（A 與 B 的位置不影響答案）', () => {
    expect(winRate(counterGame, pressA, 10, idle, 10, seeds)).toBe(1);
    expect(winRate(counterGame, idle, 10, pressA, 10, seeds)).toBe(0);
  });

  it('平手算半場', () => {
    expect(winRate(counterGame, idle, 10, idle, 10, seeds)).toBe(0.5);
    expect(winRate(counterGame, pressA, 10, pressA, 10, seeds)).toBe(0.5);
  });

  it('同樣的參數永遠同樣的答案', () => {
    const run = (): number => winRate(counterGame, greedy, 5, random, 10, seedList(50));
    expect(run()).toBe(run());
  });

  it('不同的種子清單會得到不同（但都合理）的數字', () => {
    const rate = winRate(counterGame, greedy, 3, greedy, 3, seedList(60));
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
  });

  it('等級高的贏等級低的（counter-game 上 9 對 2）', () => {
    expect(winRate(counterGame, greedy, 9, greedy, 2, seedList(100))).toBeGreaterThan(0.6);
  });

  it('空的種子清單丟錯，不回傳 NaN', () => {
    expect(() => winRate(counterGame, greedy, 5, random, 5, [])).toThrow(RangeError);
  });
});

describe('evolutionReport（TEST_PLAN 5.3）', () => {
  it('回傳 20 場的勝率：是 0.5 的倍數除以 20，介於 0 到 1', () => {
    const rate = evolutionReport(counterGame, 3, 9, 100);
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
    expect(Number.isInteger(rate * 40)).toBe(true);
  });

  it('同樣的參數回傳同樣的數字', () => {
    expect(evolutionReport(counterGame, 3, 9, 100)).toBe(evolutionReport(counterGame, 3, 9, 100));
    expect(evolutionReport(counterGame, 1, 10, 7, greedy)).toBe(
      evolutionReport(counterGame, 1, 10, 7, greedy),
    );
  });

  it('數字是真的跑出來的：新等級對舊等級，差距大就接近 1，反過來接近 0', () => {
    expect(evolutionReport(counterGame, 1, 10, 0)).toBeGreaterThan(0.7);
    expect(evolutionReport(counterGame, 10, 1, 0)).toBeLessThan(0.3);
  });

  it('不同的種子會得到不同的場次（不是寫死的）', () => {
    const rates = new Set(
      Array.from({ length: 8 }, (_v, seed) => evolutionReport(counterGame, 4, 5, seed * 1000)),
    );
    expect(rates.size).toBeGreaterThan(1);
  });

  it('對 counter-game 跑一次要少於 1 秒', () => {
    const started = performance.now();
    evolutionReport(counterGame, 3, 4, 0);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('measureDecideTimes（給 A5 用）', () => {
  it('回傳樣本數、平均與最慢（毫秒），都是有限的非負數', () => {
    const result = measureDecideTimes(counterGame, greedy, 10, seedList(3));
    expect(result.samples).toBeGreaterThan(0);
    expect(Number.isFinite(result.meanMs)).toBe(true);
    expect(result.maxMs).toBeGreaterThanOrEqual(result.meanMs);
    expect(result.meanMs).toBeGreaterThanOrEqual(0);
  });
});
