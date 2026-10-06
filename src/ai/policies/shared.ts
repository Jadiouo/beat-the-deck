import type { Buttons, Game, Inputs, Side } from '../../core/types';

/**
 * 四種性格共用的小工具。性格只能用 Game 的 actions、step、evaluate、isOver。
 */

/** 另一邊。 */
export function otherSide(side: Side): Side {
  return side === 0 ? 1 : 0;
}

/**
 * 對手在模擬裡的動作：取對手 `actions()` 的第一個（約定俗成是「全放開」）。
 *
 * SPEC 7.1 寫「對手假設維持上一個動作」，但 `Controller.decide(state, side, tick)` 看不到
 * 對手上一個 tick 按了什麼，state 也沒有保證記錄它，所以拿不到。
 * 這裡退而求其次：對手在整個模擬裡「維持不動」。（見回報：建議 core 之後把對手上一個輸入給控制器。）
 */
export function opponentAction<S>(game: Game<S>, state: S, side: Side): Buttons {
  const actions = game.actions(state, otherSide(side));
  const first = actions[0];
  if (first === undefined) {
    throw new Error('遊戲的 actions() 是空的（違反契約 K8）');
  }
  return first;
}

/** 我方做 `mine`、對手維持不動，往前走一個 tick。 */
export function advance<S>(game: Game<S>, state: S, side: Side, mine: Buttons): S {
  const theirs = opponentAction(game, state, side);
  const inputs: Inputs = side === 0 ? [mine, theirs] : [theirs, mine];
  return game.step(state, inputs);
}

/** 我方可選的動作；空的時候丟錯（契約 K8 本來就不允許）。 */
export function myActions<S>(game: Game<S>, state: S, side: Side): readonly Buttons[] {
  const actions = game.actions(state, side);
  if (actions.length === 0) {
    throw new Error('遊戲的 actions() 是空的（違反契約 K8）');
  }
  return actions;
}

export interface Scored {
  readonly index: number;
  readonly gain: number;
  readonly danger: number;
}

/** 對每個動作往前走一步，看下一個 tick 的 gain 與 danger。 */
export function lookOneStep<S>(game: Game<S>, state: S, side: Side): readonly Scored[] {
  return myActions(game, state, side).map((action, index) => {
    const { gain, danger } = game.evaluate(advance(game, state, side, action), side);
    return { index, gain, danger };
  });
}

/** 一組數字的最大值減最小值；用來把 gain 的「單位」換成這個遊戲自己的尺度。 */
export function spreadOf(values: readonly number[]): number {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return high - low;
}

/**
 * 找最大值的索引；平手取索引最小的（嚴格大於才換），所以是決定性的。
 * 空陣列或全部是 NaN 會回傳 0。
 */
export function argMax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] as number) > (values[best] as number)) {
      best = i;
    }
  }
  return best;
}
