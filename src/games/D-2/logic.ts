import { rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  GAIN_PER_POINT,
  MOVE_EVERY,
  START_CELLS,
  UNREACHABLE,
  WIN_BONUS,
  bfsDistances,
  clamp01,
  contestDanger,
  distanceFields,
  generateWalls,
  moveWalker,
  orderedActions,
  pickEmptyCells,
  steerWalker,
  winnerByScore,
} from '../_diamonds/logic';
import type { Walker } from '../_diamonds/logic';
import { COIN_COUNT, makeState as makeCoinState } from '../D-A/logic';
import type { DAState, StateOverrides as CoinOverrides } from '../D-A/logic';

/**
 * D-2 背包上限（SPEC 第 10 節；小規格 `docs/cards/D-2.md`）。
 * 規則同 D-A，但撿起來的金幣先放進背包（最多 3 枚，滿了撿不起來），走回自己的基地（起始格）才變成分數；
 * 時間到時還在背包裡的不算分。地圖、牆、走格、補東西的共用邏輯在 `_diamonds/logic.ts`。
 */

/** 背包最多幾枚。 */
export const BAG_LIMIT = 3;
/** 背包裡一枚金幣的潛在價值（比存進去的 100 少）。 */
export const BAG_WEIGHT = 60;
/** 背包有金幣時，每一枚讓「回基地」的距離少算這麼多步（背包越滿越想回家）。 */
export const RETURN_BONUS = 3;
/** 對手比我更靠近某一枚金幣時，我對那一枚的距離要加上這麼多。 */
export const CONTEST_PENALTY = 8;
/** 剩下不到這麼多個 tick 時，「撿了來不及存」的金幣不算目標。 */
export const LATE_TICKS = 300;

export interface D2State extends DAState {
  /** 兩邊背包裡的金幣數，0 到 `BAG_LIMIT`。 */
  readonly bags: readonly [number, number];
}

export interface StateOverrides extends CoinOverrides {
  readonly bags?: readonly [number, number];
}

/** 測試輔助：從預設局面出發，用 overrides 覆蓋。預設兩邊背包都是空的。 */
export function makeState(overrides: StateOverrides = {}): D2State {
  return { ...makeCoinState(overrides), bags: overrides.bags ?? [0, 0] };
}

function playerCells(players: readonly [Walker, Walker]): number[] {
  return [players[0].cell, players[1].cell];
}

export const d2Game: Game<D2State> = {
  id: 'D-2',

  init(seed: number, config: GameConfig): D2State {
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
      bags: [0, 0],
    };
  },

  step(state: D2State, inputs: Inputs): D2State {
    if (state.over) {
      return state;
    }
    const tick = state.tick + 1;
    let players: readonly [Walker, Walker] = [
      steerWalker(state.players[0], inputs[0]),
      steerWalker(state.players[1], inputs[1]),
    ];
    let coins = state.coins;
    let bags = state.bags;
    let rng = state.rng;

    if (tick % MOVE_EVERY === 0) {
      players = [moveWalker(state.walls, players[0]), moveWalker(state.walls, players[1])];
      // 撿金幣：站在金幣上而且背包有空位的各撿 1 枚；有人撿到，那一枚就被移除（兩個人一起撿也只移除一次）。
      const nextBags = [state.bags[0], state.bags[1]];
      const remaining: number[] = [];
      for (const coin of coins) {
        let taken = false;
        for (const side of [0, 1] as const) {
          if (players[side].cell === coin && state.bags[side] < BAG_LIMIT) {
            nextBags[side] = (nextBags[side] as number) + 1;
            taken = true;
          }
        }
        if (!taken) {
          remaining.push(coin);
        }
      }
      coins = remaining;
      // 存進基地：走進自己的基地而且背包不是空的，背包全部變成分數。
      const scores = [players[0].score, players[1].score];
      for (const side of [0, 1] as const) {
        const arrived = players[side].cell !== state.players[side].cell;
        if (arrived && players[side].cell === START_CELLS[side] && (nextBags[side] as number) > 0) {
          scores[side] = (scores[side] as number) + (nextBags[side] as number);
          nextBags[side] = 0;
        }
      }
      players = [
        { ...players[0], score: scores[0] as number },
        { ...players[1], score: scores[1] as number },
      ];
      bags = [nextBags[0] as number, nextBags[1] as number];
      if (coins.length < COIN_COUNT) {
        // 重要：補金幣用掉亂數，新的 RngState 一定要寫回 state。基地也不放金幣。
        const refilled = pickEmptyCells(
          rng,
          state.walls,
          [...coins, ...playerCells(players), ...START_CELLS],
          COIN_COUNT - coins.length,
        );
        coins = [...coins, ...refilled.cells];
        rng = refilled.rng;
      }
    }

    // 時間到：背包裡還沒存的不算分。
    const over = tick >= state.maxTicks;
    return {
      ...state,
      tick,
      players,
      coins,
      bags,
      rng,
      over,
      winner: over ? winnerByScore(players) : null,
    };
  },

  isOver(state: D2State): boolean {
    return state.over;
  },

  score(state: D2State): readonly [number, number] {
    return [state.players[0].score, state.players[1].score];
  },

  winner(state: D2State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(_state: D2State, side: Side): readonly Buttons[] {
    return orderedActions(side);
  },

  evaluate(state: D2State, side: Side): { gain: number; danger: number } {
    const me = state.players[side];
    const other: Side = side === 0 ? 1 : 0;
    const opponent = state.players[other];
    if (state.over) {
      const difference = me.score - opponent.score;
      const sign = difference === 0 ? 0 : difference > 0 ? 1 : -1;
      return { gain: GAIN_PER_POINT * difference + sign * WIN_BONUS, danger: 0 };
    }
    const base = START_CELLS[side];
    const fields = distanceFields(state.walls, me, opponent);
    const moving = fields.myNext !== me.cell;
    const oppMoving = fields.oppNext !== opponent.cell;
    let bag = state.bags[side];
    let score = me.score;
    let virtualCoin = -1;
    if (moving && fields.myNext === base && bag > 0) {
      score += bag; // 下一步就走進基地：當作已經存進去
      bag = 0;
    } else if (moving && bag < BAG_LIMIT && state.coins.includes(fields.myNext)) {
      virtualCoin = fields.myNext; // 下一步踩到金幣而且有空位：當作已經撿到
      bag += 1;
    }
    const ticksLeft = state.maxTicks - state.tick;
    const baseDistance = Math.min(fields.mine[base] as number, 200);
    const forced = bag > 0 && MOVE_EVERY * baseDistance + 10 >= ticksLeft;
    const fromBase = ticksLeft < LATE_TICKS ? bfsDistances(state.walls, base) : null;

    let coinTerm = UNREACHABLE;
    let nearest = UNREACHABLE;
    let nearestCell = -1;
    if (bag < BAG_LIMIT && !forced) {
      for (const coin of state.coins) {
        if (coin === virtualCoin || (oppMoving && coin === fields.oppNext)) {
          continue;
        }
        const mine = fields.mine[coin] as number;
        if (fromBase !== null && MOVE_EVERY * (mine + (fromBase[coin] as number)) + 5 > ticksLeft) {
          continue; // 撿了也來不及存
        }
        const theirs = fields.theirs[coin] as number;
        coinTerm = Math.min(coinTerm, mine + (theirs < mine ? CONTEST_PENALTY : 0));
        if (mine < nearest) {
          nearest = mine;
          nearestCell = coin;
        }
      }
    }
    let baseTerm = UNREACHABLE;
    if (bag > 0) {
      baseTerm = bag === BAG_LIMIT || forced ? baseDistance : baseDistance - RETURN_BONUS * bag;
    }
    const target = Math.min(coinTerm, baseTerm);
    const distance = target >= UNREACHABLE ? 0 : target;

    // 背包裡的金幣只有「來得及存」才有價值（時間到時還在背包裡的不算分）。
    const depositable = MOVE_EVERY * baseDistance + 5 <= ticksLeft;
    const gain =
      GAIN_PER_POINT * (score - opponent.score) +
      BAG_WEIGHT * ((depositable ? bag : 0) - state.bags[other]) -
      distance;
    const contest =
      nearestCell < 0 ? 0 : contestDanger(nearest, fields.theirs[nearestCell] as number);
    const slack = ticksLeft - MOVE_EVERY * baseDistance;
    const atRisk = bag === 0 ? 0 : (bag / BAG_LIMIT) * clamp01(1 - slack / 300);
    return { gain, danger: Math.max(contest, atRisk) };
  },
};
