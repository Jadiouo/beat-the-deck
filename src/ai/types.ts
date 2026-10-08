import type { Buttons, Game, Side } from '../core/types';
import type { PolicyName } from '../games/types';

/**
 * 性格需要的、與「這是哪張牌」無關的參數。
 * - depth：搜尋型往前看幾步（SPEC 7.2），其他性格忽略。
 * - seed：這場對局的種子，只有需要亂數的性格（random）會用；
 *   亂數由「種子＋邊＋tick」推導，所以性格本身仍然是純的。
 */
export interface PolicyParams {
  readonly depth: number;
  readonly seed: number;
  /**
   * 世界已經連續好一陣子完全沒有變化（兩邊都不動）。由 `wrapPolicy` 從 state 的歷史算出來，
   * 所以性格本身仍然是純的。只有精準型看它：僵局時不再用 danger 門檻否決動作。省略就是 false。
   */
  readonly stalled?: boolean;
}

/**
 * 性格（SPEC 7.1）：一個純函式，只透過 Game 的 actions、step、evaluate 工作。
 * 同樣的 game、state、side、tick、params，一定得到同樣的按鍵；不改動傳進來的 state。
 */
export interface Policy {
  readonly name: string;
  decide<S>(game: Game<S>, state: S, side: Side, tick: number, params: PolicyParams): Buttons;
}

/** 等級（SPEC 7.2）決定的四個參數。 */
export interface LevelParams {
  /** 看到的是幾個 tick 以前的 state。 */
  readonly reactionTicks: number;
  /** 每幾個 tick 才能換一次動作。 */
  readonly decideEvery: number;
  /** 搜尋型往前看幾步。 */
  readonly depth: number;
  /** 每次決定時亂選的機率，0 到 1。 */
  readonly epsilon: number;
}

/** 性格的名字：meta 的四種預設性格，加上測試用的基準線 random。 */
export type PolicyKey = PolicyName | 'random';
