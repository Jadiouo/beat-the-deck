import type { Rng } from './types';

/**
 * 有種子的亂數（SPEC 第 5 節 `Rng`）。
 *
 * 核心是 mulberry32：32 位元狀態，每一步把狀態加上一個奇數常數，
 * 再用乘法與位移混合輸出。低位元的品質與高位元一樣好（不像 LCG）。
 *
 * ## 給牌的作者：在 `step` 裡怎麼用亂數（請務必看這段）
 *
 * `Game.step(state, inputs)` 沒有 `Rng` 參數，而 `Rng` 是閉包，不能放進 state
 * （`hashState` 會因為「是函式」丟錯，JSON 來回也會把方法弄掉）。
 * 所以要在 `step` 裡產生隨機事件時：
 *
 * 1. 在自己的 state 裡存一個 `RngState`（就是一個 32 位元整數，可序列化、可雜湊）。
 * 2. `init(seed, config)` 裡用 `rngStateFor(seed, '<用途>')` 取得初始值，
 *    例如 `rngStateFor(seed, 'food')`、`rngStateFor(seed, 'bullets')`。
 * 3. `step` 裡用 `nextFrom(s)` 或 `intFrom(s, n)` 推進，拿到 `[值, 新狀態]`，
 *    把新狀態寫回回傳的新 state。不要改動傳進來的 state。
 *
 * 不要在 `step` 裡呼叫 `createRng(seed)` 再空轉 k 次來「接上」進度：
 * 那是 O(k)，整場對局會變成 O(n²)，而且容易與 state 脫節。
 *
 * 兩種觀點只有一份演算法：`createRng(seed)` 連續 `next()` 的序列，
 * 與從 `rngStateFor(seed, '')` 連續 `nextFrom` 的序列完全相同；
 * `createRng(seed).fork(label)` 的序列，與從 `rngStateFor(seed, label)` 開始的序列完全相同。
 *
 * ## 種子空間
 *
 * 種子必須是安全整數（`Number.isSafeInteger`，約 ±9.007e15）；
 * 小數、NaN、正負無限大一律丟錯，不會被靜默折疊。
 * 負數與超過 2^32 的整數不會被截斷：種子被拆成低 32 位元（對 2^32 取正餘數）
 * 與高位元（`Math.floor(seed / 2^32)`，可為負），兩段都明確地混入雜湊，
 * 所以 0 與 2^32、-1 與 2^32-1 都是不同的種子。
 *
 * ## 上限
 *
 * 底層只有 32 位元熵，所以 `int(n)` / `intFrom(state, n)` 的 `n` 最大是 2^32，
 * 超過就丟錯（否則高位的值永遠取不到）。
 */

/** 可以放進 state 的亂數狀態：就是一個 32 位元（無號）整數。 */
export type RngState = number;

const TWO_32 = 4294967296;

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

function assertSeed(seed: number): void {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`種子必須是安全整數（Number.isSafeInteger），收到 ${String(seed)}`);
  }
}

/** 種子 → 根狀態。低 32 位元與高位元（含負號）都明確混入。 */
function rootState(seed: number): RngState {
  assertSeed(seed);
  const high = Math.floor(seed / TWO_32);
  const low = seed - high * TWO_32;
  return mix32(mix32(low ^ 0x9e3779b9) ^ mix32((high >>> 0) ^ 0x7f4a7c15));
}

/** 從根狀態導出子狀態：只由「根狀態＋label」決定。 */
function deriveState(root: RngState, label: string): RngState {
  return label === '' ? root : mix32(root ^ hashLabel(label));
}

/**
 * 由種子與 label 導出一個獨立的亂數狀態（SPEC 5.1 的 fork 用途）。
 * label 為空字串就是根狀態，等於 `createRng(seed)` 的起點。
 */
export function rngStateFor(seed: number, label: string): RngState {
  return deriveState(rootState(seed), label);
}

function assertState(state: RngState): void {
  if (!Number.isInteger(state) || state < 0 || state >= TWO_32) {
    throw new RangeError(`RngState 必須是 [0, 2^32) 的整數，收到 ${String(state)}`);
  }
}

/** [0, 1)。回傳 `[值, 下一個狀態]`；不改動任何東西，同一個狀態永遠得到同一個結果。 */
export function nextFrom(state: RngState): readonly [number, RngState] {
  assertState(state);
  const s = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / TWO_32, s >>> 0];
}

/** [0, n) 的整數，`n` 是 1 到 2^32 的整數。回傳 `[值, 下一個狀態]`。 */
export function intFrom(state: RngState, n: number): readonly [number, RngState] {
  if (!Number.isInteger(n) || n <= 0 || n > TWO_32) {
    throw new RangeError(`int(n) 的 n 必須是 1 到 2^32 的整數，收到 ${String(n)}`);
  }
  const [value, nextState] = nextFrom(state);
  return [Math.floor(value * n), nextState];
}

function rngFromRoot(root: RngState): Rng {
  let state = root;

  const next = (): number => {
    const [value, following] = nextFrom(state);
    state = following;
    return value;
  };

  const int = (n: number): number => {
    const [value, following] = intFrom(state, n);
    state = following;
    return value;
  };

  // fork 只看根狀態，與已經取了幾個數無關，所以隨時重建都會得到同一串。
  const fork = (label: string): Rng => rngFromRoot(deriveState(root, label));

  return { next, int, fork };
}

/** 用種子建立一個亂數產生器。同一個種子永遠得到同一串數字。 */
export function createRng(seed: number): Rng {
  return rngFromRoot(rootState(seed));
}
