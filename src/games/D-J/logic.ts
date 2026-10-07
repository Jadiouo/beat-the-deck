import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  BAG_LIMIT,
  BAG_WEIGHT,
  LATE_TICKS,
  RETURN_BONUS,
  d2Game,
  makeState as makeBagState,
} from '../D-2/logic';
import type { D2State, StateOverrides as BagOverrides } from '../D-2/logic';
import {
  GAIN_PER_POINT,
  MOVE_EVERY,
  START_CELLS,
  UNREACHABLE,
  WIN_BONUS,
  actionsToward,
  bfsDistances,
  cellX,
  cellY,
  clamp01,
  distanceFields,
  winnerByScore,
} from '../_diamonds/logic';
import type { Walker } from '../_diamonds/logic';

/**
 * D-J 小偷（SPEC 第 9 節一行方向；小規格 `docs/cards/D-J.md`）。
 * 規則同 D-2（金幣先放背包、走回基地才算分），另外：貼近對手的基地（曼哈頓距離 ≤ 1）待滿 `STEAL_TICKS` 個 tick，
 * 就能從它已經存的分數偷 1 分放進自己的背包；對手在自己基地附近（≤ 2）就偷不了。
 * `step` 先呼叫 D-2 的 `step`（走格、撿金幣、存進基地、補金幣），再結算偷竊。
 */

/** 貼近對手基地的距離（曼哈頓）。 */
export const STEAL_RANGE = 1;
/** 對手在自己基地這個距離以內就守得住（曼哈頓）。 */
export const GUARD_RANGE = 2;
/** 連續待幾個 tick 偷 1 分。 */
export const STEAL_TICKS = 60;
/** 偷竊的每 1 分在 `gain` 裡值多少步的距離（AI 為了偷願意多走多遠）。 */
export const STEAL_BONUS = 10;
/** 偷的倒數每 1 個 tick 在 `gain` 裡多算多少。 */
export const LURK_VALUE = 5;
/** 對手比我更靠近某一枚金幣時，我對那一枚的距離要加上這麼多（D-2 是 8；這張牌的對手也有別的事可做，搶輸的金幣不值得追，所以加重）。 */
export const CONTEST_PENALTY = 16;
/** 預計會被偷時，離守家每近一步 `danger` 少這麼多。 */
export const GUARD_GRADIENT = 0.005;

export interface DJState extends D2State {
  /** 兩邊的偷竊倒數，0 到 `STEAL_TICKS`（`lurk[i]` 是 i 號邊正在偷對手的）。 */
  readonly lurk: readonly [number, number];
  /** 整場累計偷到幾分。 */
  readonly stolen: readonly [number, number];
}

export interface StateOverrides extends BagOverrides {
  readonly lurk?: readonly [number, number];
  readonly stolen?: readonly [number, number];
}

/** 測試輔助：D-2 的預設局面（沒有牆、兩邊背包空的、6 枚金幣）加上 `lurk`、`stolen`。 */
export function makeState(overrides: StateOverrides = {}): DJState {
  return {
    ...makeBagState(overrides),
    lurk: overrides.lurk ?? [0, 0],
    stolen: overrides.stolen ?? [0, 0],
  };
}

/** 兩格的曼哈頓距離（不看牆）：偷與守都是「貼近」，用直線距離。 */
function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

/**
 * 這個角色現在該去的格子（只用來排 `actions` 的順序）：背包滿了去基地；
 * 否則在「最近的金幣」「基地（距離減 RETURN_BONUS × 背包數）」「對手的基地（距離減 STEAL_BONUS × 偷得到的分數）」裡挑最近的。
 */
function focusOf(state: DJState, side: Side): number | null {
  const other: Side = side === 0 ? 1 : 0;
  const me = state.players[side];
  const base = START_CELLS[side];
  const target = START_CELLS[other];
  const bag = state.bags[side];
  const dist = bfsDistances(state.walls, me.cell);
  let best: number | null = null;
  let bestTerm = UNREACHABLE;
  if (bag < BAG_LIMIT) {
    for (const c of state.coins) {
      const d = dist[c] as number;
      if (d < bestTerm) {
        bestTerm = d;
        best = c;
      }
    }
  }
  if (bag > 0) {
    const term = (dist[base] as number) - (bag === BAG_LIMIT ? 0 : RETURN_BONUS * bag);
    if (best === null || term < bestTerm) {
      bestTerm = term;
      best = base;
    }
  }
  const available = Math.min(state.players[other].score, BAG_LIMIT - bag);
  if (available > 0 && manhattan(state.players[other].cell, target) > GUARD_RANGE) {
    const term = (dist[target] as number) - STEAL_RANGE - STEAL_BONUS * available;
    if (best === null || term < bestTerm) {
      best = target;
    }
  }
  return best;
}

export const dJGame: Game<DJState> = {
  id: 'D-J',

  init(seed: number, config: GameConfig): DJState {
    return { ...d2Game.init(seed, config), lurk: [0, 0], stolen: [0, 0] };
  },

  step(state: DJState, inputs: Inputs): DJState {
    if (state.over) {
      return state;
    }
    // 走格、撿金幣、存進基地、補金幣、時間到：全部交給 D-2；多出來的欄位（lurk、stolen）原樣帶過去。
    const moved = d2Game.step(state, inputs) as DJState;
    const players = moved.players;
    const snapshotScores = [players[0].score, players[1].score];
    const snapshotBags = [moved.bags[0], moved.bags[1]];
    const lurk = [0, 0];
    const wins = [false, false];
    for (const side of [0, 1] as const) {
      const other: Side = side === 0 ? 1 : 0;
      const inRange = manhattan(players[side].cell, START_CELLS[other]) <= STEAL_RANGE;
      const guarded = manhattan(players[other].cell, START_CELLS[other]) <= GUARD_RANGE;
      const canTake =
        (snapshotScores[other] as number) >= 1 && (snapshotBags[side] as number) < BAG_LIMIT;
      lurk[side] = inRange && !guarded && canTake ? state.lurk[side] + 1 : 0;
      if ((lurk[side] as number) >= STEAL_TICKS) {
        wins[side] = true;
        lurk[side] = 0;
      }
    }
    const scores = [...snapshotScores];
    const bags = [...snapshotBags];
    const stolen = [state.stolen[0], state.stolen[1]];
    for (const side of [0, 1] as const) {
      if (wins[side]) {
        const other: Side = side === 0 ? 1 : 0;
        scores[other] = (scores[other] as number) - 1;
        bags[side] = (bags[side] as number) + 1;
        stolen[side] = (stolen[side] as number) + 1;
      }
    }
    const finalPlayers: readonly [Walker, Walker] = [
      { ...players[0], score: scores[0] as number },
      { ...players[1], score: scores[1] as number },
    ];
    return {
      ...moved,
      players: finalPlayers,
      bags: [bags[0] as number, bags[1] as number],
      lurk: [lurk[0] as number, lurk[1] as number],
      stolen: [stolen[0] as number, stolen[1] as number],
      winner: moved.over ? winnerByScore(finalPlayers) : null,
    };
  },

  isOver(state: DJState): boolean {
    return state.over;
  },

  score(state: DJState): readonly [number, number] {
    return [state.players[0].score, state.players[1].score];
  },

  winner(state: DJState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: DJState, side: Side): readonly Buttons[] {
    return actionsToward(state.walls, state.players[side], side, focusOf(state, side));
  },

  evaluate(state: DJState, side: Side): { gain: number; danger: number } {
    const other: Side = side === 0 ? 1 : 0;
    const me = state.players[side];
    const opponent = state.players[other];
    if (state.over) {
      const difference = me.score - opponent.score;
      const sign = difference === 0 ? 0 : difference > 0 ? 1 : -1;
      return { gain: GAIN_PER_POINT * difference + sign * WIN_BONUS, danger: 0 };
    }
    const base = START_CELLS[side];
    const target = START_CELLS[other];
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
      }
    }
    let baseTerm = UNREACHABLE;
    if (bag > 0) {
      baseTerm = bag === BAG_LIMIT || forced ? baseDistance : baseDistance - RETURN_BONUS * bag;
    }
    // 偷竊：對手有存分數、我的背包有空位、對手不在它的基地附近、來得及走回去存。
    let stealTerm = UNREACHABLE;
    const room = BAG_LIMIT - bag;
    const available = Math.min(opponent.score, room);
    if (available > 0 && !forced && manhattan(fields.oppNext, target) > GUARD_RANGE) {
      const toTarget = Math.min(bfsDistances(state.walls, target)[fields.myNext] as number, 200);
      stealTerm = Math.max(0, toTarget - STEAL_RANGE) - STEAL_BONUS * available;
    }
    const best = Math.min(coinTerm, baseTerm, stealTerm);
    const distance = best >= UNREACHABLE ? 0 : best;

    // 背包裡的東西只有「來得及存」才有價值（時間到時還在背包裡的不算分）。
    const depositable = MOVE_EVERY * baseDistance + 5 <= ticksLeft;
    const gain =
      GAIN_PER_POINT * (score - opponent.score) +
      BAG_WEIGHT * ((depositable ? bag : 0) - state.bags[other]) +
      LURK_VALUE * state.lurk[side] -
      distance;

    // danger：背包來不及存、我存的分數被偷。（D-2 的「金幣被搶先」不放進 danger：精準型把它當「不安全」會一直躲有人在爭的金幣，整場站著不動。）
    const slack = ticksLeft - MOVE_EVERY * baseDistance;
    const atRisk = bag === 0 ? 0 : (bag / BAG_LIMIT) * clamp01(1 - slack / 300);
    // 被偷的危險：用時間算。對手走到偷得到的位置要 `reachTicks`，之後每 STEAL_TICKS 偷 1 分；我走回守得住的位置要 `guardTicks`。
    // 我還沒到家對手就偷成功幾次，就是預計被偷幾分（最多我存的分數、對手背包的空位）；一分都不會被偷就是 0。
    // 預計被偷的越多越危險；預計會被偷時，離守家越近越安全（每一步差 `GUARD_GRADIENT`），精準型才有方向回家。
    let theft = 0;
    const stored = score;
    const oppRoom = BAG_LIMIT - state.bags[other];
    if (stored >= 1 && oppRoom > 0) {
      const guardMoves = Math.max(0, (fields.mine[base] as number) - GUARD_RANGE);
      if (guardMoves > 0) {
        const reachMoves = Math.max(
          0,
          (bfsDistances(state.walls, base)[fields.oppNext] as number) - STEAL_RANGE,
        );
        const arrival = reachMoves > 0 ? MOVE_EVERY * reachMoves : -state.lurk[other];
        const lead = MOVE_EVERY * guardMoves - (arrival + STEAL_TICKS);
        if (lead > 0) {
          const loss = Math.min(stored, oppRoom, 1 + Math.floor(lead / STEAL_TICKS));
          // 預計被偷 1 分就已經超過 0.3（精準型的門檻）；越多越高；離守家越近越低（每一步 GUARD_GRADIENT，最多算 40 步），所以不會飽和在 1。
          theft = clamp01(
            0.2 + (0.6 * loss) / BAG_LIMIT + GUARD_GRADIENT * Math.min(lead / MOVE_EVERY, 40),
          );
        }
      }
    }
    return { gain, danger: Math.max(atRisk, theft) };
  },
};
