import type { Buttons, Side } from '../../core/types';

/**
 * 紅心三張牌（H-A、H-2、H-3）共用的小東西（SPEC 第 10 節「紅心共同設定」）。
 *
 * 紅心是唯一的回合制／多局制花色：沒有 60 tick 的即時輸入，而是「輪到某一邊做決定」（H-A）
 * 或「共 5 局」（H-2、H-3）。這個檔案只放三張牌真的共用的：按鍵常數、兩個時間常數、局數、勝負比較。
 * 各張牌自己的 state 與規則留在各自資料夾的 logic.ts。
 */

/** 全放開。 */
export const IDLE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});

/** 只按 a。 */
export const PRESS_A: Buttons = Object.freeze({ ...IDLE, a: true });

/** 只按 b。 */
export const PRESS_B: Buttons = Object.freeze({ ...IDLE, b: true });

/** 每個決定最多等幾個 tick，超過就自動選保守的那個選項（SPEC 紅心共同設定）。 */
export const DECISION_TIMEOUT = 300;

/** AI 做決定前固定等幾個 tick，讓人看得清楚發生什麼事（SPEC 紅心共同設定）。 */
export const AI_WAIT_TICKS = 45;

/** H-2、H-3 的局數。 */
export const ROUNDS = 5;

/** H-2、H-3 兩邊都結束之後，下一局開始之前停幾個 tick（讓人看清楚結果）。 */
export const ROUND_PAUSE = 45;

/** H-A 的目標分數與回合上限（兩邊合計，各 20 個）。 */
export const GOAL = 50;
export const MAX_TURNS = 40;

export function otherSide(side: Side): Side {
  return side === 0 ? 1 : 0;
}

/** 總分高的贏，同分平手（`null`）。 */
export function winnerByTotals(totals: readonly [number, number]): Side | null {
  if (totals[0] === totals[1]) {
    return null;
  }
  return totals[0] > totals[1] ? 0 : 1;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 輸入的 a、b 是不是被這個 tick 的原始輸入「按著」。 */
export interface Held {
  readonly a: boolean;
  readonly b: boolean;
}
