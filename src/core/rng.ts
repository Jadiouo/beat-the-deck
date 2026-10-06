import type { Rng } from './types';

/**
 * 有種子的亂數（SPEC 第 5 節 `Rng`）。
 *
 * 核心是 mulberry32：32 位元狀態，每一步把狀態加上一個奇數常數，
 * 再用乘法與位移混合輸出。低位元的品質與高位元一樣好（不像 LCG），
 * 10 萬個樣本的平均與骰子分佈都能過 TEST_PLAN 3.1 的門檻。
 *
 * 種子先經過一次 avalanche 混合，所以相鄰的種子（0、1、2…）
 * 不會產生相關的序列。
 */

/** 32 位元的 avalanche 混合（murmur3 的收尾函式）。 */
function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 字串的 32 位元雜湊（FNV-1a），再經過 avalanche 混合。 */
function hashLabel(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

/**
 * 用種子建立一個亂數產生器。
 *
 * `seed` 會被當成 32 位元整數（負數、小數都會被折進 32 位元），
 * 同一個種子永遠得到同一串數字。
 */
export function createRng(seed: number): Rng {
  // 原始種子只用來 fork：子亂數的種子只由「母種子＋label」決定，
  // 與母亂數已經取了幾個數無關，所以隨時重建都會得到同一串。
  const rootSeed = mix32((seed | 0) ^ 0x9e3779b9);
  let state = rootSeed;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (n: number): number => {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError(`Rng.int(n) 的 n 必須是正整數，收到 ${String(n)}`);
    }
    return Math.floor(next() * n);
  };

  const fork = (label: string): Rng => createRng(mix32(rootSeed ^ hashLabel(label)));

  return { next, int, fork };
}
