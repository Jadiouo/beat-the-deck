import { rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  GAIN_PER_POINT,
  MOVE_EVERY,
  START_CELLS,
  UNREACHABLE,
  WIN_BONUS,
  cell,
  contestDanger,
  distanceFields,
  generateWalls,
  makeBase,
  moveWalker,
  actionsToward,
  bfsDistances,
  pickEmptyCells,
  steerWalker,
  winnerByScore,
} from '../_diamonds/logic';
import type { BaseOverrides, DiamondsBase, Walker } from '../_diamonds/logic';

/**
 * D-3 會貶值的寶石（SPEC 第 10 節；小規格 `docs/cards/D-3.md`）。
 * 場上隨時有 5 顆寶石，出現時價值 9，每 60 tick 減 1，減到 1 之後不再降，再過 120 tick 消失並補一顆新的。
 * 撿到直接得到它「當下」的價值；沒有背包。地圖、牆、走格、補東西的共用邏輯在 `_diamonds/logic.ts`。
 */

/** 場上隨時有幾顆寶石。 */
export const GEM_COUNT = 5;
/** 出現時的價值。 */
export const START_VALUE = 9;
/** 每幾個 tick 減 1。 */
export const DECAY_EVERY = 60;
/** 最低價值，減到這裡就不再降。 */
export const MIN_VALUE = 1;
/** 降到最低價值之後，再過這麼多個 tick 消失。 */
export const LINGER = 120;
/** 出生之後第幾個 tick 消失：(9 − 1) × 60 + 120 = 600。 */
export const LIFETIME = (START_VALUE - MIN_VALUE) * DECAY_EVERY + LINGER;
/** 寶石「吸引力」的係數：`GEM_PULL × 到手時的價值 / (距離 + 2)`。 */
export const GEM_PULL = 100;
/** 對手比我更靠近某一顆寶石時，我對那一顆的距離要加上這麼多。 */
export const CONTEST_PENALTY = 8;

export interface Gem {
  /** 所在的格子編號。 */
  readonly cell: number;
  /** 出生的 tick（state 的 `tick` 等於這個數的那一刻）。 */
  readonly born: number;
}

export interface D3State extends DiamondsBase {
  readonly gems: readonly Gem[];
}

export interface StateOverrides extends BaseOverrides {
  readonly gems?: readonly Gem[];
}

/** 一顆寶石在某個 tick 的價值：出生後每 60 tick 減 1，最低 1。 */
export function gemValue(tick: number, born: number): number {
  return Math.max(MIN_VALUE, START_VALUE - Math.floor((tick - born) / DECAY_EVERY));
}

/** 測試用的預設寶石位置：離兩個起點都很遠。 */
const DEFAULT_GEMS: readonly Gem[] = [
  { cell: cell(10, 5), born: 0 },
  { cell: cell(20, 5), born: 0 },
  { cell: cell(10, 18), born: 0 },
  { cell: cell(20, 18), born: 0 },
  { cell: cell(15, 12), born: 0 },
];

/** 測試輔助：從預設局面出發，用 overrides 覆蓋。 */
export function makeState(overrides: StateOverrides = {}): D3State {
  return { ...makeBase(overrides), gems: overrides.gems ?? DEFAULT_GEMS };
}

function playerCells(players: readonly [Walker, Walker]): number[] {
  return [players[0].cell, players[1].cell];
}

/** 吸引力（`GEM_PULL × 到手時的價值 / (距離 + 2)`）最大的寶石；沒有就是 null。只用來排 `actions` 的順序。 */
function bestGem(state: D3State, from: number): number | null {
  const dist = bfsDistances(state.walls, from);
  let best: number | null = null;
  let bestPull = 0;
  for (const gem of state.gems) {
    const d = dist[gem.cell] as number;
    const arrival = state.tick + MOVE_EVERY * d;
    if (d >= UNREACHABLE || arrival - gem.born > LIFETIME) {
      continue;
    }
    const pull = (GEM_PULL * gemValue(arrival - 1, gem.born)) / (d + 2);
    if (pull > bestPull) {
      bestPull = pull;
      best = gem.cell;
    }
  }
  return best;
}

export const d3Game: Game<D3State> = {
  id: 'D-3',

  init(seed: number, config: GameConfig): D3State {
    const walls = generateWalls(seed).walls;
    const players: readonly [Walker, Walker] = [
      { cell: START_CELLS[0], pending: -1, score: 0 },
      { cell: START_CELLS[1], pending: -1, score: 0 },
    ];
    const placed = pickEmptyCells(
      rngStateFor(seed, 'gems'),
      walls,
      playerCells(players),
      GEM_COUNT,
    );
    return {
      tick: 0,
      maxTicks: config.maxTicks,
      walls,
      players,
      rng: placed.rng,
      over: false,
      winner: null,
      gems: placed.cells.map((c): Gem => ({ cell: c, born: 0 })),
    };
  },

  step(state: D3State, inputs: Inputs): D3State {
    if (state.over) {
      return state;
    }
    const tick = state.tick + 1;
    let players: readonly [Walker, Walker] = [
      steerWalker(state.players[0], inputs[0]),
      steerWalker(state.players[1], inputs[1]),
    ];
    let gems = state.gems;
    let rng = state.rng;

    if (tick % MOVE_EVERY === 0) {
      players = [moveWalker(state.walls, players[0]), moveWalker(state.walls, players[1])];
      // 撿寶石：拿的是「這次 step 之前」的價值（用 state.tick，不是 tick），所以在減值的那個 tick 撿到，拿減之前的。
      const gained = [0, 0];
      const remaining: Gem[] = [];
      for (const gem of gems) {
        let taken = false;
        for (const side of [0, 1] as const) {
          if (players[side].cell === gem.cell) {
            gained[side] = (gained[side] as number) + gemValue(state.tick, gem.born);
            taken = true;
          }
        }
        if (!taken) {
          remaining.push(gem);
        }
      }
      gems = remaining;
      players = [
        { ...players[0], score: players[0].score + (gained[0] as number) },
        { ...players[1], score: players[1].score + (gained[1] as number) },
      ];
    }

    // 沒被撿走的，出生滿 LIFETIME 個 tick 就消失（在撿起之後才判，所以消失的那個 tick 也撿得到）。
    if (gems.some((gem) => tick - gem.born >= LIFETIME)) {
      gems = gems.filter((gem) => tick - gem.born < LIFETIME);
    }
    if (gems.length < GEM_COUNT) {
      // 重要：補寶石用掉亂數，新的 RngState 一定要寫回 state。
      const refilled = pickEmptyCells(
        rng,
        state.walls,
        [...gems.map((gem) => gem.cell), ...playerCells(players)],
        GEM_COUNT - gems.length,
      );
      gems = [...gems, ...refilled.cells.map((c): Gem => ({ cell: c, born: tick }))];
      rng = refilled.rng;
    }

    const over = tick >= state.maxTicks;
    return {
      ...state,
      tick,
      players,
      gems,
      rng,
      over,
      winner: over ? winnerByScore(players) : null,
    };
  },

  isOver(state: D3State): boolean {
    return state.over;
  },

  score(state: D3State): readonly [number, number] {
    return [state.players[0].score, state.players[1].score];
  },

  winner(state: D3State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: D3State, side: Side): readonly Buttons[] {
    const me = state.players[side];
    return actionsToward(state.walls, me, side, bestGem(state, me.cell));
  },

  evaluate(state: D3State, side: Side): { gain: number; danger: number } {
    const me = state.players[side];
    const opponent = state.players[side === 0 ? 1 : 0];
    const difference = me.score - opponent.score;
    if (state.over) {
      const sign = difference === 0 ? 0 : difference > 0 ? 1 : -1;
      return { gain: GAIN_PER_POINT * difference + sign * WIN_BONUS, danger: 0 };
    }
    const fields = distanceFields(state.walls, me, opponent);
    const moving = fields.myNext !== me.cell;
    const oppMoving = fields.oppNext !== opponent.cell;
    let virtual = 0;
    let pull = 0;
    let danger = 0;
    for (const gem of state.gems) {
      if (moving && gem.cell === fields.myNext) {
        virtual += gemValue(state.tick, gem.born); // 下一步就踩到：當作已經撿到，分數加它現在的價值
        continue;
      }
      if (oppMoving && gem.cell === fields.oppNext) {
        continue; // 對手下一步就撿走了
      }
      const mine = fields.mine[gem.cell] as number;
      if (mine >= UNREACHABLE) {
        continue;
      }
      const arrival = state.tick + MOVE_EVERY * mine;
      if (arrival - gem.born > LIFETIME) {
        continue; // 走到之前就消失了
      }
      const theirs = fields.theirs[gem.cell] as number;
      const effective = mine + (theirs < mine ? CONTEST_PENALTY : 0);
      const value = gemValue(arrival - 1, gem.born);
      const candidate = (GEM_PULL * value) / (effective + 2);
      if (candidate > pull) {
        pull = candidate;
        danger = contestDanger(mine, theirs);
      }
    }
    return { gain: GAIN_PER_POINT * (difference + virtual) + pull, danger };
  },
};
