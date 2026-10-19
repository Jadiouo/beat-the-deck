import { describe, expect, it } from 'vitest';

import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { SEARCH_BEAM, advance, lookAhead, myActions } from './shared';
import type { Leaf, LeafScorer } from './shared';

/**
 * `lookAhead`（束搜尋）截斷的單元測試。
 *
 * 缺陷（DESIGN-AI-FUN 10.55）：一層的分數全平（或在截斷的邊界上平手）時，
 * 「分數相同就保留生成順序」會讓保留下來的節點全是最先被展開的那幾個第一步的後代，
 * 最後選出的動作與搜尋無關。S-9（搜尋型自己掉下去 98.4%）與 C-4（每格轉彎）各自量到過。
 *
 * 這裡用一個人造的遊戲：state 只記「我方按過的動作編號」，evaluate 由測試決定，
 * 所以分數可以精確地全平、或只有一個節點比較高。評分函式（LeafScorer）把每一次被問到的那一層記下來，
 * 於是可以看到每一層保留下來的節點涵蓋幾個不同的第一步。
 */

const KEYS = ['up', 'down', 'left', 'right', 'a', 'b'] as const;

function press(index: number): Buttons {
  const buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
  const key = KEYS[index];
  if (key !== undefined) {
    buttons[key] = true;
  }
  return buttons;
}

function indexOf(buttons: Buttons): number {
  return KEYS.findIndex((key) => buttons[key]);
}

interface TraceState {
  readonly tick: number;
  /** 我方（0 號邊）從開局到現在按過的動作編號。 */
  readonly picks: readonly number[];
}

/** `count` 個動作；evaluate 的 gain 由 `gainOf(picks)` 決定，danger 一律 0。 */
function traceGame(
  count: number,
  gainOf: (picks: readonly number[]) => number = () => 0,
): { game: Game<TraceState>; start: TraceState } {
  const game: Game<TraceState> = {
    id: 'trace',
    init: (_seed: number, _config: GameConfig): TraceState => ({ tick: 0, picks: [] }),
    step: (state: TraceState, inputs: Inputs): TraceState => ({
      tick: state.tick + 1,
      picks: [...state.picks, indexOf(inputs[0])],
    }),
    isOver: (state: TraceState): boolean => state.tick >= 50,
    score: (): readonly [number, number] => [0, 0],
    winner: (): Side | null => null,
    actions: (): readonly Buttons[] => Array.from({ length: count }, (_v, i) => press(i)),
    evaluate: (state: TraceState): { gain: number; danger: number } => ({
      gain: gainOf(state.picks),
      danger: 0,
    }),
  };
  return { game, start: game.init(0, { maxTicks: 100, params: {} }) };
}

/** 把每一次被問到的那一層記下來的評分函式；`scoreOf` 決定分數（預設全部相同）。 */
function recorder(scoreOf: (leaf: Leaf<TraceState>) => number = () => 0): {
  score: LeafScorer<TraceState>;
  layers: Leaf<TraceState>[][];
} {
  const layers: Leaf<TraceState>[][] = [];
  return {
    layers,
    score: (leaves) => {
      layers.push([...leaves]);
      return leaves.map(scoreOf);
    },
  };
}

function distinctFirsts(layer: readonly Leaf<TraceState>[]): number {
  return new Set(layer.map((leaf) => leaf.first)).size;
}

/**
 * 修之前的 `lookAhead`（只按分數截斷，同分留生成順序），原樣搬來當參考答案：
 * 分數沒有平手的局面，新舊必須逐一相同。
 */
function lookAheadBefore<S>(
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
        expanded.push(node);
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
    if (
      (scores[i] as number) > (scores[best] as number) ||
      (scores[i] === scores[best] && candidate.first < current.first)
    ) {
      best = i;
    }
  }
  return actions[(layer[best] as Leaf<S>).first] as Buttons;
}

describe('lookAhead 截斷｜分數全平的局面不能把束收成同一個第一步的後代', () => {
  it.each([
    { actions: 3, depth: 6 }, // 梅花的形狀：三個動作，束寬 4
    { actions: 5, depth: 4 },
    { actions: 6, depth: 6 }, // 動作數大於預設束寬
  ])(
    '$actions 個動作、往前 $depth 步、分數全部相同：最後一層保留的節點涵蓋所有第一步',
    ({ actions, depth }) => {
      const { game, start } = traceGame(actions);
      const seen = recorder();
      lookAhead(game, start, 0, depth, seen.score);
      const last = seen.layers[seen.layers.length - 1] as Leaf<TraceState>[];
      expect(distinctFirsts(last)).toBe(actions);
    },
  );

  it('每一層（不只是最後一層）保留下來的節點都涵蓋所有第一步', () => {
    const { game, start } = traceGame(5);
    const seen = recorder();
    lookAhead(game, start, 0, 6, seen.score);
    expect(seen.layers.length).toBe(6);
    for (const layer of seen.layers) {
      expect(distinctFirsts(layer)).toBe(5);
    }
  });

  it('只有一個節點分數比較高、其餘全平：多出來的位子分給還沒有節點的第一步，而不是全給最先展開的那個', () => {
    // 全部按 0 的那條路徑 gain 1，其餘 0。舊做法：這條路徑的兄弟（同樣是第一步 0 的後代）佔滿剩下的位子。
    const { game, start } = traceGame(5, (picks) => (picks.every((pick) => pick === 0) ? 1 : 0));
    const seen = recorder((leaf) => leaf.gain);
    lookAhead(game, start, 0, 5, seen.score);
    const last = seen.layers[seen.layers.length - 1] as Leaf<TraceState>[];
    expect(distinctFirsts(last)).toBe(5);
    // 分數最高的那條路徑還在（嚴格比較高的節點不會被「公平」擠掉）
    expect(last.some((leaf) => leaf.gain === 1)).toBe(true);
  });

  it('分數嚴格不同的時候照舊：位子全給分數最高的，不為了涵蓋更多第一步而留較差的節點', () => {
    // 第一步是 0 的節點一律比其他的高：束裡應該只有第一步 0 的後代。
    const { game, start } = traceGame(5, (picks) => (picks[0] === 0 ? 1 : 0));
    const seen = recorder((leaf) => leaf.gain);
    const chosen = lookAhead(game, start, 0, 4, seen.score);
    for (const layer of seen.layers.slice(1)) {
      expect(layer.every((leaf) => leaf.first === 0)).toBe(true);
    }
    expect(indexOf(chosen)).toBe(0);
  });

  it('分數沒有平手的局面：選出的動作與修之前的 lookAhead 逐一相同（五十種分數函式）', () => {
    // gain 是把按過的編號雜湊成一個小數：不同路徑的分數幾乎不可能相同，所以沒有平手。
    let mismatches = 0;
    for (let salt = 1; salt <= 50; salt += 1) {
      const gainOf = (picks: readonly number[]): number => {
        let h = salt * 2654435761;
        for (const pick of picks) {
          h = Math.imul(h ^ (pick + 1), 0x01000193) >>> 0;
        }
        return h / 4294967296;
      };
      for (const actions of [2, 3, 5]) {
        const { game, start } = traceGame(actions, gainOf);
        const scorer = recorder((leaf) => leaf.gain).score;
        const before = lookAheadBefore(game, start, 0, 5, scorer);
        const after = lookAhead(game, start, 0, 5, scorer);
        if (indexOf(before) !== indexOf(after)) {
          mismatches += 1;
        }
      }
    }
    expect(mismatches).toBe(0);
  });

  it('決定性：同樣的輸入每次回傳同一個動作', () => {
    const { game, start } = traceGame(5);
    const a = lookAhead(game, start, 0, 6, recorder().score);
    const b = lookAhead(game, start, 0, 6, recorder().score);
    expect(a).toEqual(b);
  });

  it('全部平手時，最後仍然取第一步索引最小的（沿用「平手取索引最小」）', () => {
    const { game, start } = traceGame(5);
    expect(indexOf(lookAhead(game, start, 0, 6, recorder().score))).toBe(0);
  });

  it('深度 1 不截斷：每個動作各一個節點，選分數最高的', () => {
    const { game, start } = traceGame(5, (picks) => (picks[0] === 3 ? 2 : 1));
    const seen = recorder((leaf) => leaf.gain);
    const chosen = lookAhead(game, start, 0, 1, seen.score);
    expect(seen.layers.length).toBe(1);
    expect(distinctFirsts(seen.layers[0] as Leaf<TraceState>[])).toBe(5);
    expect(indexOf(chosen)).toBe(3);
  });

  it('不改動傳進來的 state', () => {
    const { game, start } = traceGame(5);
    const before = JSON.stringify(start);
    lookAhead(game, start, 0, 6, recorder().score);
    expect(JSON.stringify(start)).toBe(before);
  });
});
