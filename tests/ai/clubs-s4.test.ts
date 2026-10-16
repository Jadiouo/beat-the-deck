import { describe, expect, it } from 'vitest';

import { duelStats, s4WinRate } from './clubs-s4.shared';

/**
 * 梅花的簡單腳本 S4 與兩個對打檢查（DESIGN-AI-FUN 10.37）。腳本本身與修之前的數字寫在 `clubs-s4.shared.ts`。
 */

const S4_GAMES = 200;
// C-2 與 C-A 的數字逐位相同（腳本看不到畫面層的旋轉），C-7 只是對照組，所以只放這四張。
const CARDS = ['C-A', 'C-3', 'C-4', 'C-5'] as const;

describe.each(CARDS)('梅花簡單腳本 S4｜%s', (id) => {
  it('延遲 12 tick 的 S4 對等級 10 的勝率 ≤ 40%', () => {
    const rate = s4WinRate(id, 12, S4_GAMES);
    expect(rate, `${id} S4（延遲 12）勝率 ${(100 * rate).toFixed(1)}%`).toBeLessThanOrEqual(0.4);
  });
  it('延遲 0 的 S4 對等級 10 的勝率 ≤ 50%', () => {
    const rate = s4WinRate(id, 0, S4_GAMES);
    expect(rate, `${id} S4（延遲 0）勝率 ${(100 * rate).toFixed(1)}%`).toBeLessThanOrEqual(0.5);
  });
});

/**
 * 修之前（30 場，10.34）撞死：C-A／C-2 12、C-3 17、C-4 3、C-5 22、C-7 19（C-7 還有餓死，不計入）；
 * 局長中位數 C-A 60、C-3 46.5、C-5 47.3 秒。
 * 預測（10.37）：AI 不再走進死路，撞死降到 24 場裡 8 場（三分之一）以下，局長中位數回到接近滿局（≥ 55 秒）。
 * C-7 的局長另有縮水機制（餓死），只檢查撞死場數。
 */
const DUEL_GAMES = 24;
const DUEL_CARDS = ['C-A', 'C-3', 'C-4', 'C-5', 'C-7'] as const;
describe.each(DUEL_CARDS)('梅花對打撞死｜%s', (id) => {
  it('兩個等級 10 對打 24 場：撞死 ≤ 8 場，局長中位數 ≥ 55 秒（C-7 只看撞死）', () => {
    const stats = duelStats(id, DUEL_GAMES);
    expect(stats.crashed, `${id} 撞死 ${stats.crashed}／${stats.games}`).toBeLessThanOrEqual(8);
    if (id !== 'C-7') {
      expect(
        stats.medianSeconds,
        `${id} 局長中位數 ${stats.medianSeconds} 秒`,
      ).toBeGreaterThanOrEqual(55);
    }
  });
});
