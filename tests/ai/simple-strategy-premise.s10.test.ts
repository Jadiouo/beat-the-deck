import { describe, expect, it } from 'vitest';

import { humanPolicy } from '../../src/ai/human-model';
import { policyByName } from '../../src/ai/level';
import { findEntry } from '../../src/games/registry';
import { seedList, winRate } from './harness';
import { WITH_HUMAN_LIMITS, s10Threshold } from './simple-strategies';

/**
 * S-10 的 A4 豁免的**前提**（DESIGN-AI-FUN 10.14、10.40、10.49、10.52；老闆 2026-10-19 裁示「不降線，加樣本」）：
 * 「場上子彈 ≥ 8 顆才按清場」這一條規則（移動交給精準型），在人類模型的限制下對預設性格等級 10 的勝率，
 * (1) ≥ 10.14 的 40%（這條線原封不動），(2) 和人類模型本身幾乎一樣（差距 ≤ 5 個百分點）——
 * 人類模型在這張牌上就是那個簡單策略。
 *
 * **為什麼用 300 場，而且這不是放寬門檻：** S-10 有 78% 的局是平手，100 場的標準誤約 2 個百分點，
 * 拿 100 場去判一條 40% 的線樣本不足。官方的種子 0..99（100 場）量到 39.0%，低於 40%，
 * 但那是雜訊內的結果；再量種子 100..299（200 場）是 41.3%；合併種子 0..299（300 場）是 40.5%。
 * 三個區塊的數字：39.0% ／ 41.3% ／ 40.5%。判準用的是**合併 300 場的 40.5%**，它合法通過 40%；
 * 官方 100 場單獨看是 39.0%，並沒有過，這裡不假裝它過。
 * 先前一版把線降到 38% 是錯的（CLAUDE.md 第 8 條：不為了讓測試過而放寬測試），已改回 40%。
 * 合併樣本若掉到 40% 以下，表示 S-10 的豁免前提不成立，要由老闆重新裁示，不是改這條線。
 *
 * 量法：種子 0..299（固定），簡單策略 vs 預設性格（precise）等級 10，平手算半場，座位依種子奇偶輪流（同 A4 的 `winRate`）。
 */
const SEEDS = seedList(300);
const FLOOR = 0.4;
const MAX_GAP = 0.05;

describe('S-10 的 A4 豁免前提：子彈 ≥ 8 才按清場的簡單策略 ≈ 人類模型（10.14）', () => {
  const entry = findEntry('S-10');
  const policy = entry === undefined ? null : policyByName(entry.meta.defaultPolicy ?? 'random');

  it('簡單策略（合併 300 場）≥ 40%，而且與人類模型相差 ≤ 5 個百分點', () => {
    if (entry === undefined || policy === null) {
      throw new Error('S-10 不在登記表');
    }
    const simple = winRate(entry.game, s10Threshold(8), WITH_HUMAN_LIMITS, policy, 10, SEEDS);
    const human = winRate(entry.game, humanPolicy, WITH_HUMAN_LIMITS, policy, 10, SEEDS);
    console.log(
      `[10.14 前提] S-10 子彈 ≥ 8 才按、人類限制、${SEEDS.length} 場：${(simple * 100).toFixed(1)}%；人類模型：${(human * 100).toFixed(1)}%`,
    );
    expect(simple).toBeGreaterThanOrEqual(FLOOR);
    expect(Math.abs(simple - human)).toBeLessThanOrEqual(MAX_GAP);
  }, 3_600_000);
});
