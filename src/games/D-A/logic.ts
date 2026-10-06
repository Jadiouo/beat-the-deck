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
  orderedActions,
  pickEmptyCells,
  steerWalker,
  winnerByScore,
} from '../_diamonds/logic';
import type { BaseOverrides, DiamondsBase, Walker } from '../_diamonds/logic';

/**
 * D-A 搶金幣（SPEC 第 10 節；小規格 `docs/cards/D-A.md`）。
 * 兩個角色在同一張有牆的地圖上搶同一批金幣：走到金幣的格子就撿起來，分數加 1。
 * 地圖、牆、走格、補東西的共用邏輯在 `_diamonds/logic.ts`。
 */

/** 場上隨時有幾枚金幣。 */
export const COIN_COUNT = 6;
/** 對手比我更靠近某一枚金幣時，我對那一枚的距離要加上這麼多（共用場地，搶不到的別去）。 */
export const CONTEST_PENALTY = 8;

export interface DAState extends DiamondsBase {
  /** 金幣所在的格子編號。 */
  readonly coins: readonly number[];
}

export interface StateOverrides extends BaseOverrides {
  readonly coins?: readonly number[];
}

/** 測試用的預設金幣位置：離兩個起點都很遠。 */
const DEFAULT_COINS: readonly number[] = [
  cell(10, 5),
  cell(20, 5),
  cell(10, 18),
  cell(20, 18),
  cell(15, 12),
  cell(16, 12),
];

/** 測試輔助：從預設局面出發，用 overrides 覆蓋。 */
export function makeState(overrides: StateOverrides = {}): DAState {
  return { ...makeBase(overrides), coins: overrides.coins ?? DEFAULT_COINS };
}

function playerCells(players: readonly [Walker, Walker]): number[] {
  return [players[0].cell, players[1].cell];
}

export const dAGame: Game<DAState> = {
  id: 'D-A',

  init(seed: number, config: GameConfig): DAState {
    const walls = generateWalls(seed).walls;
    const players: readonly [Walker, Walker] = [
      { cell: START_CELLS[0], pending: -1, score: 0 },
      { cell: START_CELLS[1], pending: -1, score: 0 },
    ];
    const placed = pickEmptyCells(
      rngStateFor(seed, 'coins'),
      walls,
      playerCells(players),
      COIN_COUNT,
    );
    return {
      tick: 0,
      maxTicks: config.maxTicks,
      walls,
      players,
      rng: placed.rng,
      over: false,
      winner: null,
      coins: placed.cells,
    };
  },

  step(state: DAState, inputs: Inputs): DAState {
    if (state.over) {
      return state;
    }
    const tick = state.tick + 1;
    let players: readonly [Walker, Walker] = [
      steerWalker(state.players[0], inputs[0]),
      steerWalker(state.players[1], inputs[1]),
    ];
    let coins = state.coins;
    let rng = state.rng;

    if (tick % MOVE_EVERY === 0) {
      // 兩邊同時走完，之後才結算撿金幣；兩人在同一枚上：各得 1 分，那一枚只被移除一次。
      players = [moveWalker(state.walls, players[0]), moveWalker(state.walls, players[1])];
      const gained = [0, 0];
      for (const coin of coins) {
        for (const side of [0, 1] as const) {
          if (players[side].cell === coin) {
            gained[side] = (gained[side] as number) + 1;
          }
        }
      }
      const taken = coins.filter((coin) => players[0].cell !== coin && players[1].cell !== coin);
      players = [
        { ...players[0], score: players[0].score + (gained[0] as number) },
        { ...players[1], score: players[1].score + (gained[1] as number) },
      ];
      coins = taken;
      if (coins.length < COIN_COUNT) {
        // 重要：補金幣用掉亂數，新的 RngState 一定要寫回 state。
        const refilled = pickEmptyCells(
          rng,
          state.walls,
          [...coins, ...playerCells(players)],
          COIN_COUNT - coins.length,
        );
        coins = [...coins, ...refilled.cells];
        rng = refilled.rng;
      }
    }

    const over = tick >= state.maxTicks;
    return {
      ...state,
      tick,
      players,
      coins,
      rng,
      over,
      winner: over ? winnerByScore(players) : null,
    };
  },

  isOver(state: DAState): boolean {
    return state.over;
  },

  score(state: DAState): readonly [number, number] {
    return [state.players[0].score, state.players[1].score];
  },

  winner(state: DAState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(_state: DAState, side: Side): readonly Buttons[] {
    return orderedActions(side);
  },

  evaluate(state: DAState, side: Side): { gain: number; danger: number } {
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
    let nearest = UNREACHABLE;
    let nearestCell = -1;
    let best = UNREACHABLE;
    for (const coin of state.coins) {
      if (moving && coin === fields.myNext) {
        virtual += 1; // 下一步就踩到：當作已經撿到
        continue;
      }
      if (oppMoving && coin === fields.oppNext) {
        continue; // 對手下一步就撿走了
      }
      const mine = fields.mine[coin] as number;
      const theirs = fields.theirs[coin] as number;
      const effective = mine + (theirs < mine ? CONTEST_PENALTY : 0);
      if (effective < best) {
        best = effective;
      }
      if (mine < nearest) {
        nearest = mine;
        nearestCell = coin;
      }
    }
    const distance = best >= UNREACHABLE ? 0 : best;
    const danger =
      nearestCell < 0 ? 0 : contestDanger(nearest, fields.theirs[nearestCell] as number);
    return { gain: GAIN_PER_POINT * (difference + virtual) - distance, danger };
  },
};
