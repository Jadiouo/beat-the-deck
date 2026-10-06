// core/types.ts

export type Side = 0 | 1; // 0 是人，1 是 AI（測試裡兩邊都可以是 AI）

/** 抽象按鍵。所有遊戲只認這些。 */
export interface Buttons {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  a: boolean;
  b: boolean;
}

/** 一個 tick 的輸入：兩邊各一組按鍵。 */
export type Inputs = readonly [Buttons, Buttons];

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [0, n) 的整數 */
  int(n: number): number;
  /** 分出一個獨立的子亂數，給「兩邊要拿到同一串亂數」的鏡像場地用 */
  fork(label: string): Rng;
}

export interface GameConfig {
  /** 這場的 tick 上限。到了就結束。 */
  maxTicks: number;
  /** 牌自己的參數，定義在各牌的 meta.ts */
  params: Readonly<Record<string, number>>;
}

/** state 必須是可以 JSON 序列化的純資料：沒有函式、沒有類別實例、沒有 NaN。 */
export interface Game<S> {
  readonly id: string;

  init(seed: number, config: GameConfig): S;

  /** 純函式。不可以改動傳入的 state。 */
  step(state: S, inputs: Inputs): S;

  isOver(state: S): boolean;

  /** 兩邊的分數。只有 isOver 之後的值算數。 */
  score(state: S): readonly [number, number];

  /** 贏家。平手回傳 null。預設是分數高的贏；有淘汰規則的牌可以自己定。 */
  winner(state: S): Side | null;

  /**
   * 某一邊在這個 tick 可以選的動作。動作就是一組 Buttons。
   * 即時遊戲通常回傳固定的幾種（例如停、上、下、左、右）。
   * 回合制遊戲在不是自己回合時回傳只有一個「全放開」的陣列。
   */
  actions(state: S, side: Side): readonly Buttons[];

  /**
   * 給 AI 的評估：數字越大對這一邊越好。
   * danger 是「接下來會不會死或被扣大分」的估計，0 到 1。
   * gain 是「目前領先多少」的估計，單位自訂但要單調。
   */
  evaluate(state: S, side: Side): { gain: number; danger: number };
}

/** 控制器：人或 AI。每個 tick 被問一次。 */
export interface Controller<S> {
  decide(state: S, side: Side, tick: number): Buttons;
}
