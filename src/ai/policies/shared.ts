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

/** 束搜尋每一層最多保留幾個節點（第一層一定全留，其他層至少留這麼多）。 */
export const SEARCH_BEAM = 4;

/** 前瞻搜尋裡的一個節點：一條路徑走到現在的終點。 */
export interface Leaf<S> {
  readonly state: S;
  /** 這條路徑的第一步是 `actions()` 的第幾個。 */
  readonly first: number;
  /** 終點的 gain 與 danger。 */
  readonly gain: number;
  readonly danger: number;
  /** 這條路徑上（含終點）出現過的最大 danger；一步時等於 danger。 */
  readonly peak: number;
}

/** 給一層節點打分，分數越高越好；同一層內比較，單位由性格自己決定。 */
export type LeafScorer<S> = (leaves: readonly Leaf<S>[]) => number[];

/**
 * 把「比較兩個節點誰比較好」變成分數：比較結果相同的節點得到同一個分數。
 * compare 回傳負數代表 a 比 b 好。用來表達「先排除危險的、再比 gain」這種字典序的偏好。
 */
export function ranksFrom<T>(items: readonly T[], compare: (a: T, b: T) => number): number[] {
  const order = items.map((_item, i) => i);
  order.sort((a, b) => compare(items[a] as T, items[b] as T) || a - b);
  const ranks = new Array<number>(items.length).fill(0);
  let rank = items.length;
  for (let position = 0; position < order.length; position += 1) {
    const index = order[position] as number;
    const before = order[position - 1];
    if (before !== undefined && compare(items[before] as T, items[index] as T) !== 0) {
      rank = items.length - position;
    }
    ranks[index] = rank;
  }
  return ranks;
}

/**
 * 前瞻（束搜尋）：我方每一步從 `actions()` 選、對手維持不動，往前走 depth 個 tick，
 * 用 `score` 給每一層的節點打分，回傳終點分數最高的那條路的第一步。
 *
 * - 每一層只留分數最高的 max(b, beam) 個節點；第一層一定保留所有第一步。
 *   總成本約 b · max(b, beam) · depth 次 `step`。
 * - 模擬到一半遊戲結束（`isOver`），那個節點就不再展開，直接當終點。
 * - 平手取第一步索引最小的；排序是穩定的，所以整個過程是決定性的。
 * - depth 1 就是「每個動作走一步、看下一個 tick」。
 */
export function lookAhead<S>(
  game: Game<S>,
  state: S,
  side: Side,
  depth: number,
  score: LeafScorer<S>,
  beam: number = SEARCH_BEAM,
): Buttons {
  const actions = myActions(game, state, side);
  const steps = Math.max(1, Math.floor(depth));
  const width = Math.max(actions.length, beam);

  const make = (next: S, first: number, before: number): Leaf<S> => {
    const { gain, danger } = game.evaluate(next, side);
    return { state: next, first, gain, danger, peak: Math.max(before, danger) };
  };

  let layer: Leaf<S>[] = actions.map((action, first) =>
    make(advance(game, state, side, action), first, Number.NEGATIVE_INFINITY),
  );

  for (let step = 1; step < steps; step += 1) {
    const expanded: Leaf<S>[] = [];
    let growing = false;
    for (const node of layer) {
      if (game.isOver(node.state)) {
        expanded.push(node); // 終局：留著，當作終點
        continue;
      }
      growing = true;
      for (const action of myActions(game, node.state, side)) {
        expanded.push(make(advance(game, node.state, side, action), node.first, node.peak));
      }
    }
    if (!growing) {
      layer = expanded;
      break;
    }
    if (expanded.length > width) {
      const scores = score(expanded);
      const order = expanded.map((_node, i) => i);
      // 穩定排序：分數相同時保留生成順序（第一步索引小的在前）。
      order.sort((a, b) => (scores[b] as number) - (scores[a] as number) || a - b);
      layer = order.slice(0, width).map((i) => expanded[i] as Leaf<S>);
    } else {
      layer = expanded;
    }
  }

  const scores = score(layer);
  let best = 0;
  for (let i = 1; i < layer.length; i += 1) {
    const candidate = layer[i] as Leaf<S>;
    const current = layer[best] as Leaf<S>;
    const better = (scores[i] as number) > (scores[best] as number);
    const tie = scores[i] === scores[best] && candidate.first < current.first;
    if (better || tie) {
      best = i;
    }
  }
  return actions[(layer[best] as Leaf<S>).first] as Buttons;
}
