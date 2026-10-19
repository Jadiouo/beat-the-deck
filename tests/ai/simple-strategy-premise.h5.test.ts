import { describe, expect, it } from 'vitest';

import { policyByName } from '../../src/ai/level';
import { findEntry } from '../../src/games/registry';
import { seedList, winRate } from './harness';
import { NO_LIMITS, WITH_HUMAN_LIMITS, h5Threshold } from './simple-strategies';

/**
 * H-5 的 A4 豁免的**前提**（DESIGN-AI-FUN 10.14；老闆 2026-10-19 裁示）：
 * 「總點數 < 15 就要牌，否則停牌」這一條規則對預設性格等級 10 的勝率 ≥ 40%。
 *
 * 豁免不是「我們決定不管了」，是這條測試：哪天 H-5 的規則被改到簡單策略不再有效
 * （例如把爆牌扣分改成 3，10.14 試過，A4 會降到 34.1%），這條測試會紅，
 * 那就表示 `meta.simpleStrategyViable` 這面旗標失去依據，要拿掉、A4 要回來跑。
 *
 * 量法：種子 0..199（固定），簡單策略 vs 預設性格（pathfinder）等級 10，平手算半場，
 * 座位依種子奇偶輪流（與 A4 同一個 `winRate`）。
 * 實測（2026-10-19）：沒有人類限制 51.5%；加上人類模型的限制（HUMAN_PARAMS）48.8%。
 */
const SEEDS = seedList(200);
const FLOOR = 0.4;
const TIMEOUT = 600_000;

describe('H-5 的 A4 豁免前提：固定門檻 15 的簡單策略 ≥ 40%（10.14）', () => {
  const entry = findEntry('H-5');
  const policy = entry === undefined ? null : policyByName(entry.meta.defaultPolicy ?? 'random');

  it('H-5 在登記表裡，而且有預設性格', () => {
    expect(entry).toBeDefined();
    expect(policy).not.toBeNull();
  });

  it(
    '沒有人類限制：勝率 ≥ 40%（實測 51.5%）',
    () => {
      if (entry === undefined || policy === null) {
        throw new Error('H-5 不在登記表');
      }
      const rate = winRate(entry.game, h5Threshold(15), NO_LIMITS, policy, 10, SEEDS);
      console.log(
        `[10.14 前提] H-5 固定門檻 15、無人類限制、${SEEDS.length} 場：${(rate * 100).toFixed(1)}%`,
      );
      expect(rate).toBeGreaterThanOrEqual(FLOOR);
    },
    TIMEOUT,
  );

  it(
    '加上人類模型的限制：勝率 ≥ 40%（實測 48.8%）',
    () => {
      if (entry === undefined || policy === null) {
        throw new Error('H-5 不在登記表');
      }
      const rate = winRate(entry.game, h5Threshold(15), WITH_HUMAN_LIMITS, policy, 10, SEEDS);
      console.log(
        `[10.14 前提] H-5 固定門檻 15、人類限制、${SEEDS.length} 場：${(rate * 100).toFixed(1)}%`,
      );
      expect(rate).toBeGreaterThanOrEqual(FLOOR);
    },
    TIMEOUT,
  );

  it(
    '簡單策略的前提不是靠挑門檻：14 到 16 都 ≥ 40%（13 與 17 太保守／太激進，已知會掉到 40% 以下）',
    () => {
      if (entry === undefined || policy === null) {
        throw new Error('H-5 不在登記表');
      }
      for (const threshold of [14, 16]) {
        const rate = winRate(entry.game, h5Threshold(threshold), NO_LIMITS, policy, 10, SEEDS);
        console.log(`[10.14 前提] H-5 固定門檻 ${threshold}：${(rate * 100).toFixed(1)}%`);
        expect(rate, `門檻 ${threshold}`).toBeGreaterThanOrEqual(FLOOR);
      }
    },
    TIMEOUT,
  );
});
