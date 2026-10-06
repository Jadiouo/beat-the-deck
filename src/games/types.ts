import type { Game } from '../core/types';

/** 花色：梅花、黑桃、方塊、紅心，與鬼牌。 */
export type Suit = 'C' | 'S' | 'D' | 'H' | 'JK';

/** 點數。鬼牌的點數是 `R`（紅）與 `B`（黑），所以 id 都是 `<花色>-<點數>`。 */
export type Rank =
  'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'R' | 'B';

/** 預設性格（SPEC 7.1）。 */
export type PolicyName = 'pathfinder' | 'precise' | 'greedy' | 'gambler';

/**
 * 一張牌的 meta（SPEC 第 4 節 `meta.ts`；TEST_PLAN 第 4 節 meta 檢查用到的欄位）。
 * 每張牌的 `meta.ts` 匯出一個這個型別的值。
 */
export interface CardMeta {
  /** 與登記表的 id 一致，例如 `C-A`。 */
  readonly id: string;
  /** 繁體中文名稱。 */
  readonly name: string;
  /** 一句說明。 */
  readonly description: string;
  /** 操作說明（顯示在說明頁）。 */
  readonly controls: string;
  /** 替身牌（`kind: 'fixture'`）是 null。 */
  readonly suit: Suit | null;
  /** 替身牌（`kind: 'fixture'`）是 null。 */
  readonly rank: Rank | null;
  /** 預設性格；J、Q、K、鬼牌或還沒指定的牌是 null（AI 行為測試會跳過 null）。 */
  readonly defaultPolicy: PolicyName | null;
  /** 基礎等級（SPEC 7.2）：A–3 是 1，4–6 是 2，7–10 是 3，J、Q、K 是 4。 */
  readonly baseLevel: number;
  /** 兩邊完全對稱：K12 會跑。 */
  readonly symmetric?: boolean;
  /** 有淘汰規則，贏家不一定是分數高的：K7 跳過。 */
  readonly winnerNotByScore?: boolean;
  /** 運氣成分高（紅心）：A1、A2 的門檻降低。 */
  readonly luckHeavy?: boolean;
  /** 這張牌真的與種子無關（不用任何隨機事件）：K13（種子有效）跳過。 */
  readonly seedIndependent?: boolean;
}

/** 畫一個 state。只讀 state，不可以改它。 */
export type RenderFn<S> = (ctx: CanvasRenderingContext2D, state: S) => void;

/**
 * 登記表的一筆。
 *
 * `kind` 明確區分真的撲克牌（`'card'`）與測試用的替身（`'fixture'`，例如 counter-game）。
 * 替身不是牌：它沒有花色與點數，id 也不在 54 張牌的清單裡，meta 檢查據此跳過
 * 花色、點數與 id 清單的比對，而不是靠 id 的樣子去猜。
 */
export interface RegistryEntry<S = unknown> {
  readonly id: string;
  readonly kind: 'card' | 'fixture';
  readonly game: Game<S>;
  readonly render: RenderFn<S>;
  readonly meta: CardMeta;
}

/**
 * 把具體 state 型別的登記項放進同一個清單。
 *
 * `Game<S>` 的 S 同時出現在參數與回傳（不變），所以 `RegistryEntry<CounterState>`
 * 不能直接指定給 `RegistryEntry<unknown>`。登記表與契約測試只經由 Game 的方法
 * 在同一個 S 上來回，從來不自己讀 state，所以在這裡做一次型別轉換是安全的。
 */
export function defineEntry<S>(entry: RegistryEntry<S>): RegistryEntry {
  return entry as unknown as RegistryEntry;
}
