import { describe, expect, it } from 'vitest';

import { cAGame } from '../games/C-A/logic';
import { cAMeta } from '../games/C-A/meta';
import { EVOLUTION_GAMES, MATCH_CONFIG, evolutionReport, winRate } from './evolution';
import { policyByName } from './level';
import { random } from './policies/random';

/**
 * TEST_PLAN 5.3「AI 進化畫面的數字是真的」。
 * 計時（performance.now）寫在測試檔裡：evolution.ts 在 src/ai，純度掃描不准出現它。
 */

const policy = policyByName(cAMeta.defaultPolicy ?? 'pathfinder');

describe('evolutionReport（src/ai/evolution.ts，外殼與測試共用同一份）', () => {
  it('打 20 場；回傳值是 0.5 的倍數除以 20，介於 0 到 1', () => {
    expect(EVOLUTION_GAMES).toBe(20);
    const rate = evolutionReport(cAGame, 3, 4, 0, policy);
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
    expect(Number.isInteger(rate * 40)).toBe(true);
  });

  it('同樣的參數回傳同樣的數字（5.3 第一條）', () => {
    expect(evolutionReport(cAGame, 2, 6, 11, policy)).toBe(
      evolutionReport(cAGame, 2, 6, 11, policy),
    );
  });

  it('等於用種子 seed..seed+19 直接呼叫 winRate（沒有另一套算法）', () => {
    const seeds = Array.from({ length: 20 }, (_v, i) => 5 + i);
    expect(evolutionReport(cAGame, 3, 8, 5, policy)).toBe(
      winRate(cAGame, policy, 8, policy, 3, seeds, MATCH_CONFIG),
    );
  });

  it('對 C-A 跑一次少於 1 秒（5.3 第二條）', () => {
    const started = performance.now();
    evolutionReport(cAGame, 4, 5, 0, policy);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('winRate', () => {
  it('空的種子清單丟錯', () => {
    expect(() => winRate(cAGame, random, 5, random, 5, [])).toThrow(RangeError);
  });
});
