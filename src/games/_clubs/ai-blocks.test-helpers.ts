import { measureA1, measureA2, measureA3, measureA4 } from '../../../tests/contract/checks';
import type { RegistryEntry } from '../types';

/**
 * 「四個種子區塊」量測工具：給做牌的人在調 `evaluate` 或遊戲參數時用的，**不是測試**。
 *
 * 為什麼需要：A1–A4 的測試只用種子 0..199（TEST_PLAN 第 2 節固定），一個區塊的勝率有
 * 二項分佈的波動（200 場時標準誤約 2.9 個百分點）。只看 0..199 可能剛好落在波動好的那一側，
 * 真實餘裕其實不到一個標準誤。換三個沒用過的區塊再量一次，才知道數字是不是穩的。
 *
 * 不是測試套件的一部分：測試的種子清單必須固定為 `0..N-1`，而且四個區塊會讓 `npm run check` 慢四倍。
 * 用法（寫一個臨時的 `*.test.ts` 放在 repo 外面，或在 REPL 裡）：
 *
 *     import { measureBlocks, formatBlocks } from 'src/games/_clubs/ai-blocks.test-helpers';
 *     console.log(formatBlocks(measureBlocks(registryEntry, ['A1'])));
 *
 * A1–A4 的定義與 `tests/contract/checks.ts` 的 `measureA1`…`measureA4` 完全相同，只是種子換成各區塊。
 */

/** 四個區塊的起點，每個區塊 200 個種子：0..199、200..399、400..599、600..799。 */
export const BLOCK_STARTS: readonly number[] = [0, 200, 400, 600];
export const BLOCK_SIZE = 200;

export type BlockCheck = 'A1' | 'A2' | 'A3' | 'A4';

export interface BlockMeasurement {
  readonly cardId: string;
  /** 每個檢查、每個區塊的勝率（0 到 1），順序同 `BLOCK_STARTS`。 */
  readonly rates: Readonly<Partial<Record<BlockCheck, readonly number[]>>>;
}

/** 某個區塊的種子清單。 */
export function blockSeeds(start: number, size: number = BLOCK_SIZE): number[] {
  return Array.from({ length: size }, (_, i) => start + i);
}

const MEASURE: Record<BlockCheck, (entry: RegistryEntry, seeds: readonly number[]) => number> = {
  A1: measureA1,
  A2: measureA2,
  A3: measureA3,
  A4: measureA4,
};

/** 對一張牌量四個區塊的勝率。`checks` 預設 A1–A4 全量（A4 較慢，一個區塊約 20 秒）。 */
export function measureBlocks(
  entry: RegistryEntry,
  checks: readonly BlockCheck[] = ['A1', 'A2', 'A3', 'A4'],
): BlockMeasurement {
  const rates: Partial<Record<BlockCheck, number[]>> = {};
  for (const check of checks) {
    rates[check] = BLOCK_STARTS.map((start) => MEASURE[check](entry, blockSeeds(start)));
  }
  return { cardId: entry.id, rates };
}

/** 一行一個檢查的文字表：`C-A A1  0..199 87.5%  200..399 ...  最低 85.0%`。 */
export function formatBlocks(measurement: BlockMeasurement): string {
  const lines: string[] = [];
  for (const [check, rates] of Object.entries(measurement.rates)) {
    const cells = (rates ?? []).map((rate, i) => {
      const start = BLOCK_STARTS[i] as number;
      return `${start}..${start + BLOCK_SIZE - 1} ${(rate * 100).toFixed(2)}%`;
    });
    const lowest = Math.min(...(rates ?? [1]));
    lines.push(
      `${measurement.cardId} ${check}  ${cells.join('  ')}  最低 ${(lowest * 100).toFixed(2)}%`,
    );
  }
  return lines.join('\n');
}
