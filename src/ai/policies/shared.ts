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
 * 束搜尋的截斷：從 `nodes`（依生成順序排列，同一個第一步的後代在生成順序上是連在一起的）留下分數最高的 `width` 個。
 *
 * 分數嚴格比邊界高的全留。邊界上（與第 `width` 名同分）的節點如果放不下，不能再用「同分留生成順序」：
 * 生成順序把同一個第一步的後代排在一起，同分時前面幾個第一步的後代會佔滿所有位子，其他第一步整個消失，
 * 最後選出的動作與搜尋無關（DESIGN-AI-FUN 10.55）。改成：邊界上的位子一個一個分，每次給「目前保留的節點
 * 最少的第一步」（保留數一樣就給第一步索引小的），該第一步裡先生成的先留。
 *
 * - 沒有同分要拆開的時候（邊界上的節點全放得下，或第 `width` 名分數比下一名高），結果與舊做法逐一相同。
 * - 只動「同分」之間的取捨；分數不同的節點，高的永遠比低的優先。
 * - 同分是精確相等（`===`）。全牌量測裡拆不開的同分都是整數或同一個算式算出的相同浮點數，沒有需要容差的情況。
 * - 保留下來的節點仍照「分數高到低、同分照生成順序」排列，所以下一層的生成順序與舊做法的約定一致。
 * - 成本：一次排序，加上 O(位子數 × 第一步數) 的分配；不多做任何 `step`，也不加寬束。
 */
function truncate<S>(
  nodes: readonly Leaf<S>[],
  scores: readonly number[],
  width: number,
): Leaf<S>[] {
  // 穩定排序：分數相同時保留生成順序（第一步索引小的在前）。
  const order = nodes.map((_node, i) => i);
  order.sort((a, b) => (scores[b] as number) - (scores[a] as number) || a - b);

  const boundary = scores[order[width - 1] as number] as number;
  let end = width;
  while (end < order.length && scores[order[end] as number] === boundary) {
    end += 1;
  }
  if (end === width || boundary !== boundary) {
    // 第 width 名與下一名分數不同（或分數不是數字）：沒有同分要拆。
    return order.slice(0, width).map((i) => nodes[i] as Leaf<S>);
  }
  let start = width - 1;
  while (start > 0 && scores[order[start - 1] as number] === boundary) {
    start -= 1;
  }

  // order[0 .. start) 分數嚴格較高，全留；order[start .. end) 與邊界同分，只放得下 width - start 個。
  const kept = new Array<number>(nodes.length).fill(0);
  const count = new Map<number, number>();
  for (let position = 0; position < start; position += 1) {
    const node = nodes[order[position] as number] as Leaf<S>;
    kept[order[position] as number] = 1;
    count.set(node.first, (count.get(node.first) ?? 0) + 1);
  }
  const queues = new Map<number, number[]>();
  for (let position = start; position < end; position += 1) {
    const index = order[position] as number;
    const first = (nodes[index] as Leaf<S>).first;
    const queue = queues.get(first);
    if (queue === undefined) {
      queues.set(first, [index]);
    } else {
      queue.push(index);
    }
  }
  const firsts = [...queues.keys()].sort((a, b) => a - b);
  const cursor = new Map<number, number>(firsts.map((first) => [first, 0]));
  for (let slot = start; slot < width; slot += 1) {
    let pick = -1;
    let fewest = Number.POSITIVE_INFINITY;
    for (const first of firsts) {
      const queue = queues.get(first) as number[];
      if ((cursor.get(first) as number) >= queue.length) {
        continue;
      }
      const have = count.get(first) ?? 0;
      if (have < fewest) {
        fewest = have;
        pick = first;
      }
    }
    const queue = queues.get(pick) as number[];
    const next = cursor.get(pick) as number;
    kept[queue[next] as number] = 1;
    cursor.set(pick, next + 1);
    count.set(pick, (count.get(pick) ?? 0) + 1);
  }
  const result: Leaf<S>[] = [];
  for (const index of order) {
    if (kept[index] === 1) {
      result.push(nodes[index] as Leaf<S>);
    }
  }
  return result;
}

/**
 * 前瞻（束搜尋）：我方每一步從 `actions()` 選、對手維持不動，往前走 depth 個 tick，
 * 用 `score` 給每一層的節點打分，回傳終點分數最高的那條路的第一步。
 *
 * - 每一層只留分數最高的 max(b, beam) 個節點；第一層一定保留所有第一步。
 *   總成本約 b · max(b, beam) · depth 次 `step`。
 * - 截斷時分數相同的節點不是照生成順序留，而是平均分給各個第一步（見 `truncate`）：
 *   否則一層的分數全平時，保留下來的節點會全是同一個第一步的後代。
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
    layer = expanded.length > width ? truncate(expanded, score(expanded), width) : expanded;
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
