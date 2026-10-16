import { describe, expect, it } from 'vitest';

import { counterEntry } from '../fixtures/counter-entry';
import {
  CONTRACT_CONFIG,
  ContractViolation,
  SYMMETRY_CHUNKS,
  SYMMETRY_SEEDS,
  checkSymmetry,
  judgeSymmetry,
  symmetryPoints,
} from './checks';

/**
 * K12 分段（為什麼要有它）：最慢的幾張牌（S-Q、S-10、S-A）跑完 200 場要 70 多秒，
 * 超過單一測試案例的 60 秒。成本在控制器（decide 佔 95% 以上），不在遊戲的 step，
 * 所以種子數與判準都不能動；改成把 200 個種子切成幾段，每段各自一個測試案例，
 * 最後一個案例把各段的得分加起來，用和原本完全相同的判準判。
 * 這裡證明：切法不漏不重，加總之後和一次跑完 200 場得到同樣的結果與同樣的錯誤訊息。
 */
describe('K12 分段', () => {
  it('各段合起來恰好是 SYMMETRY_SEEDS，不漏不重', () => {
    const joined = SYMMETRY_CHUNKS.flat();
    expect(joined).toEqual([...SYMMETRY_SEEDS]);
    expect(SYMMETRY_CHUNKS.length).toBeGreaterThan(1);
  });

  it('各段得分加總 ＝ 一次跑完全部種子的得分', () => {
    const config = { ...CONTRACT_CONFIG, maxTicks: 120 };
    const whole = symmetryPoints(counterEntry, SYMMETRY_SEEDS, config);
    const parts = SYMMETRY_CHUNKS.map((chunk) => symmetryPoints(counterEntry, chunk, config));
    expect(parts.reduce((sum, p) => sum + p, 0)).toBe(whole);
  });

  it('judgeSymmetry：40% 與 60% 的邊界算過，超出就丟 K12 並帶上種子數與勝率', () => {
    expect(() => judgeSymmetry(80, 200)).not.toThrow();
    expect(() => judgeSymmetry(120, 200)).not.toThrow();
    expect(() => judgeSymmetry(79.5, 200)).toThrow(ContractViolation);
    expect(() => judgeSymmetry(120.5, 200)).toThrow(/\[K12\] 200 個種子，0 號邊的勝率是 60\.3%/);
  });

  it('checkSymmetry 仍然可以一次跑完（bad-games 與舊呼叫端不用改）', () => {
    const config = { ...CONTRACT_CONFIG, maxTicks: 120 };
    expect(() => checkSymmetry(counterEntry, SYMMETRY_SEEDS, config)).not.toThrow();
  });
});
