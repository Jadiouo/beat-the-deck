import { levelController } from '../../src/ai/level';
import { MATCH_CONFIG } from '../../src/ai/evolution';
import { pathfinder } from '../../src/ai/policies/pathfinder';
import { playMatch } from '../../src/core/match';
import type { Buttons, Controller, Game, Side } from '../../src/core/types';
import { isVisible } from '../../src/games/C-4/logic';
import { CELLS, HEIGHT, WIDTH, cell, cellX, cellY } from '../../src/games/_clubs/logic';
import type { ClubsState } from '../../src/games/_clubs/logic';
import { findEntry } from '../../src/games/registry';

/**
 * 梅花的「簡單腳本」S4 與兩個對打檢查（DESIGN-AI-FUN 10.37）。
 *
 * S4 ＝ 直衝最近的食物、避開兩條蛇身（尾巴不算，它這一格會移走）、不走進沒有出口的死路
 * （下一格的四周除了蛇頭自己以外至少有一格空的）。S4 沒有任何搜尋、沒有任何記憶，是 10.14 說的
 * 「最簡單的合理策略」。它對手是 `pathfinder` 等級 10，固定種子 0..199、平手算半場、玩家邊輪流。
 *
 * 為什麼留在 repo 裡：梅花的 A4（人類模型）一直紅，量到的原因是等級 10 的 AI 缺「不走死路」（10.37）。
 * 這個腳本是那個缺口的直接量測，不依賴人類模型的參數；以後梅花的 AI 退化（或有人改共用的 `evaluateClubs`），這裡會先紅。
 *
 * 修之前（HEAD 931f393 的 evaluateClubs，200 場，延遲 0／延遲 12 tick）：
 *   C-A 53.8／32.5  C-3 31.5／26.0  C-4 96.0／62.0  C-5 32.8／22.5（C-7 對照 42.5／23.3）
 *
 * 延遲版的意思：世界（食物、對手）用 12 tick 前的，自己用現在的，與等級 10 的 `reactionTicks` 相同；
 * 延遲 0 是人做不到的上限。門檻：延遲 12 要 ≤ 40%（10.14 的「簡單策略不該贏過 40%」），延遲 0 要 ≤ 50%
 * （也就是等級 10 至少要和一個零反應延遲的腳本打平）。
 */

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

function press(dir: number): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT;
}

/** 從 (x, y) 往 d 方向連續空格的格數（含 (x, y) 自己），最多數到 max。 */
function rayLength(blocked: Uint8Array, x: number, y: number, d: number, max: number): number {
  let n = 0;
  let cx = x;
  let cy = y;
  while (n < max && inBounds(cx, cy) && blocked[cell(cx, cy)] === 0) {
    n += 1;
    cx += DX[d] as number;
    cy += DY[d] as number;
  }
  return n;
}

/** 這張牌的 S4 要追哪些食物、多避開哪些格子（C-4 只看得到霧裡的食物；C-5 的橫條是障礙）。 */
interface CardView {
  readonly foods: (state: ClubsState, side: Side) => readonly number[];
  readonly extraBlocked: (state: ClubsState) => readonly number[];
}

const PLAIN: CardView = { foods: (state) => state.foods, extraBlocked: () => [] };
const VIEWS: Readonly<Record<string, CardView>> = {
  'C-A': PLAIN,
  'C-3': PLAIN,
  'C-4': {
    foods: (state, side) =>
      state.foods.filter((food) => isVisible(state.snakes[side].body[0] as number, food)),
    extraBlocked: () => [],
  },
  'C-5': {
    foods: (state) => state.foods,
    extraBlocked: (state) => ((state as unknown as { bars: number[][] }).bars ?? []).flat(),
  },
};

export function decideS4(view: CardView, state: ClubsState, side: Side): Buttons {
  const me = state.snakes[side];
  if (state.over || !me.alive || me.turn !== me.dir) {
    return NONE;
  }
  const head = me.body[0] as number;
  const blocked = new Uint8Array(CELLS);
  for (const snake of state.snakes) {
    for (let i = 0; i < snake.body.length - 1; i += 1) {
      blocked[snake.body[i] as number] = 1;
    }
  }
  for (const c of view.extraBlocked(state)) {
    blocked[c] = 1;
  }
  const candidates = [me.dir, (me.dir + 1) % 4, (me.dir + 3) % 4].map((d) => {
    const nx = cellX(head) + (DX[d] as number);
    const ny = cellY(head) + (DY[d] as number);
    const inside = inBounds(nx, ny);
    let free = inside && blocked[cell(nx, ny)] === 0;
    if (free) {
      let exit = false;
      for (let e = 0; e < 4; e += 1) {
        const ex = nx + (DX[e] as number);
        const ey = ny + (DY[e] as number);
        if (inBounds(ex, ey) && blocked[cell(ex, ey)] === 0 && cell(ex, ey) !== head) {
          exit = true;
        }
      }
      free = exit;
    }
    return { d, nx, ny, inside, free };
  });
  let pool = candidates.filter((c) => c.free);
  if (pool.length === 0) {
    pool = candidates.filter((c) => c.inside);
  }
  if (pool.length === 0) {
    return NONE;
  }
  let pick = pool[0] as (typeof pool)[number];
  const foods = view.foods(state, side);
  if (foods.length === 0) {
    // 沒有目標（C-4 的霧裡看不到食物）：直走，除非前方兩格有障礙；否則挑直線空得最長的。
    const straight = pool.find((c) => c.d === me.dir);
    if (
      straight !== undefined &&
      rayLength(blocked, straight.nx, straight.ny, straight.d, 4) >= 3
    ) {
      pick = straight;
    } else {
      let longest = -1;
      for (const c of pool) {
        const length = rayLength(blocked, c.nx, c.ny, c.d, 12);
        if (length > longest) {
          longest = length;
          pick = c;
        }
      }
    }
  } else {
    let best = Number.POSITIVE_INFINITY;
    for (const c of pool) {
      let distance = Number.POSITIVE_INFINITY;
      for (const food of foods) {
        distance = Math.min(distance, Math.abs(cellX(food) - c.nx) + Math.abs(cellY(food) - c.ny));
      }
      if (distance < best) {
        best = distance;
        pick = c;
      }
    }
  }
  return press(pick.d);
}

/** 延遲版：食物與對手用 `delay` tick 前的，自己用現在的。 */
function s4Controller(view: CardView, delay: number): Controller<ClubsState> {
  const history: ClubsState[] = [];
  return {
    decide(state: ClubsState, side: Side, tick: number): Buttons {
      history[tick] = state;
      if (delay === 0) {
        return decideS4(view, state, side);
      }
      const old = history[Math.max(0, tick - delay)] as ClubsState;
      const other = side === 0 ? 1 : 0;
      const snakes: [ClubsState['snakes'][0], ClubsState['snakes'][1]] = [
        state.snakes[0],
        state.snakes[1],
      ];
      snakes[other] = old.snakes[other];
      return decideS4(view, { ...state, foods: old.foods, snakes }, side);
    },
  };
}

/** S4 對等級 10 的勝率（平手算半場、玩家邊輪流）。 */
export function s4WinRate(cardId: string, delay: number, games: number): number {
  const entry = findEntry(cardId);
  if (entry === undefined) {
    throw new Error(`登記表裡沒有 ${cardId}`);
  }
  const game = entry.game as Game<ClubsState>;
  const view = VIEWS[cardId] as CardView;
  let score = 0;
  for (let seed = 0; seed < games; seed += 1) {
    const mine: Side = seed % 2 === 0 ? 0 : 1;
    const script = s4Controller(view, delay);
    const ai = levelController(game, pathfinder, 10, seed + 1_000_003);
    const result =
      mine === 0
        ? playMatch(game, seed, MATCH_CONFIG, script, ai)
        : playMatch(game, seed, MATCH_CONFIG, ai, script);
    score += result.winner === null ? 0.5 : result.winner === mine ? 1 : 0;
  }
  return score / games;
}

// ---------------------------------------------------------------------------
// 兩個預設性格等級 10 對打：撞死場數與局長（10.37 預測的第一個方向）
// ---------------------------------------------------------------------------

export interface DuelStats {
  readonly crashed: number;
  readonly games: number;
  readonly medianSeconds: number;
}

export function duelStats(cardId: string, games: number): DuelStats {
  const entry = findEntry(cardId);
  if (entry === undefined) {
    throw new Error(`登記表裡沒有 ${cardId}`);
  }
  const game = entry.game as Game<ClubsState>;
  const lengths: number[] = [];
  let crashed = 0;
  for (let seed = 0; seed < games; seed += 1) {
    const controllers = [
      levelController(game, pathfinder, 10, seed + 1),
      levelController(game, pathfinder, 10, seed + 1_000_003),
    ] as const;
    let state = game.init(seed, MATCH_CONFIG);
    while (!game.isOver(state)) {
      state = game.step(state, [
        controllers[0].decide(state, 0, state.tick),
        controllers[1].decide(state, 1, state.tick),
      ]);
    }
    lengths.push(state.tick / 60);
    if (!state.snakes[0].alive || !state.snakes[1].alive) {
      crashed += 1;
    }
  }
  lengths.sort((a, b) => a - b);
  return { crashed, games, medianSeconds: lengths[Math.floor(lengths.length / 2)] as number };
}
