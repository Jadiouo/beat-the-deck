import { describe, expect, it } from 'vitest';

import { BLOCK_SIZE, BLOCK_STARTS, blockSeeds, formatBlocks } from './ai-blocks.test-helpers';

/**
 * 四區塊量測工具本身的小測試：只測種子清單與格式，不跑對局
 * （跑四個區塊的 A1–A4 很慢，也不屬於測試套件；見 `ai-blocks.test-helpers.ts`）。
 */
describe('四個種子區塊的量測工具', () => {
  it('四個區塊各 200 個連續種子：0..199、200..399、400..599、600..799，互不重疊', () => {
    expect(BLOCK_STARTS).toEqual([0, 200, 400, 600]);
    expect(BLOCK_SIZE).toBe(200);
    const all = BLOCK_STARTS.flatMap((start) => blockSeeds(start));
    expect(all).toHaveLength(800);
    expect(all).toEqual(Array.from({ length: 800 }, (_, i) => i));
  });

  it('formatBlocks：一行一個檢查，列出四個區塊與最低值', () => {
    const text = formatBlocks({ cardId: 'X', rates: { A1: [0.9, 0.85, 0.875, 0.8] } });
    expect(text).toBe(
      'X A1  0..199 90.00%  200..399 85.00%  400..599 87.50%  600..799 80.00%  最低 80.00%',
    );
  });
});
