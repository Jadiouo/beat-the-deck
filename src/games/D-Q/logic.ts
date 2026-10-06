import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  GAIN_PER_POINT,
  MOVE_EVERY,
  START_CELLS,
  UNREACHABLE,
  WIN_BONUS,
  actionsToward,
  bfsDistances,
  cell,
  cellX,
  cellY,
  generateWalls,
  makeBase,
  moveWalker,
  nextCell,
  steerWalker,
  winnerByScore,
} from '../_diamonds/logic';
import type { BaseOverrides, DiamondsBase, Walker } from '../_diamonds/logic';

/**
 * D-Q 唯一的礦（SPEC 第 9 節一行方向；小規格 `docs/cards/D-Q.md`）。
 * 場上只有一個礦：站在礦上（礦那一格與上下左右相鄰的格子）每 `MINE_EVERY` 個 tick 挖一次，挖到的礦石放在身上，走出礦坑範圍才算分；
 * 礦越挖越容易塌，塌的時候還在範圍內的人身上的礦石全部作廢，礦移到公開的「下一個礦」。
 * 地圖、牆、走格、距離的共用邏輯在 `_diamonds/logic.ts`。
 */

/** 每幾個 tick 開挖一次。 */
export const MINE_EVERY = 20;
/** 一個人站著挖到的礦石。 */
export const SOLO_YIELD = 2;
/** 兩個人都站著，各挖到的礦石。 */
export const SHARED_YIELD = 1;
/** 挖礦的範圍：礦那一格與它上下左右相鄰的格子（曼哈頓距離 1 以內）都算「在礦上」。 */
export const MINE_REACH = 1;
/** 礦坑範圍：曼哈頓距離這麼近以內，礦石還不安全，塌的時候會被埋。 */
export const ZONE_RADIUS = 3;
/** 塌的機率每開挖一次增加幾個千分點。 */
export const HAZARD_STEP = 22;
/** 下一個礦離目前的礦至少、至多幾步（繞牆）。 */
export const MIN_GAP = 14;
export const MAX_GAP = 40;
/** 開局的礦離兩個起點至少幾步。 */
export const FIRST_MIN = 12;
/** 身上的礦石在 `gain` 裡一塊算幾分（存起來的是 100，所以比較少）。 */
export const CARRY_WEIGHT = 60;
/** 站在礦上的 `gain` 加成：每 1 塊的挖礦量算這麼多。 */
export const MINE_BONUS_PER_ORE = 15;
/** 往範圍外走一步，身上每 1 塊礦石在 `gain` 裡多算這麼多（走到範圍外就整塊變成 100 分）。 */
export const PROGRESS_PER_ORE = 2.2;
/** 搶下一個礦的位置：每領先 1 步、在塌的機率是 100% 時值多少 `gain`。 */
export const RACE_PER_MOVE = 20;
/** 領先（或落後）的步數最多算幾步。 */
export const RACE_CAP = 8;
/** 「留下來」的計畫，往後算幾次開挖都在範圍裡。 */
export const STAY_HORIZON = 3;
/** `danger` 的尺度：越大越不容易飽和。 */
export const RISK_SCALE = 4;

export interface DQState extends DiamondsBase {
  /** 現在的礦（格子編號）。 */
  readonly mine: number;
  /** 下一個礦（公開）。 */
  readonly next: number;
  /** 這個礦已經開挖幾次。 */
  readonly age: number;
  /** 兩邊身上還沒走出去的礦石。 */
  readonly carried: readonly [number, number];
  /** 整場累計被作廢的礦石。 */
  readonly lost: readonly [number, number];
  /** 塌過幾次。 */
  readonly collapses: number;
}

export interface StateOverrides extends BaseOverrides {
  readonly mine?: number;
  readonly next?: number;
  readonly age?: number;
  readonly carried?: readonly [number, number];
  readonly lost?: readonly [number, number];
  readonly collapses?: number;
}

/** 測試輔助：從預設局面（沒有牆、礦在 (15, 12)、下一個礦在 (25, 20)）出發，用 overrides 覆蓋。 */
export function makeState(overrides: StateOverrides = {}): DQState {
  return {
    ...makeBase(overrides),
    mine: overrides.mine ?? cell(15, 12),
    next: overrides.next ?? cell(25, 20),
    age: overrides.age ?? 0,
    carried: overrides.carried ?? [0, 0],
    lost: overrides.lost ?? [0, 0],
    collapses: overrides.collapses ?? 0,
  };
}

/** 兩格的曼哈頓距離（不看牆）。礦坑範圍用它：塌方是岩層的事，不管路怎麼走。 */
export function zoneDistance(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

/** 這個礦開挖了 `age` 次之後，塌的機率（千分點）。 */
export function hazardPermille(age: number): number {
  return Math.min(1000, HAZARD_STEP * age);
}

// ---------------------------------------------------------------------------
// 挑礦的位置
// ---------------------------------------------------------------------------

/** 從候選裡均勻挑一個，新的亂數狀態接下去。 */
function pickFrom(candidates: readonly number[], rng: RngState): { cell: number; rng: RngState } {
  const [k, after] = intFrom(rng, candidates.length);
  return { cell: candidates[k] as number, rng: after };
}

/** 開局的礦：兩個起點到它的步數差不超過 1、離兩邊都至少 FIRST_MIN 步；找不到就放寬到任何非牆格。 */
function pickFirstMine(walls: readonly number[], rng: RngState): { cell: number; rng: RngState } {
  const from0 = bfsDistances(walls, START_CELLS[0]);
  const from1 = bfsDistances(walls, START_CELLS[1]);
  const fair: number[] = [];
  const open: number[] = [];
  for (let c = 0; c < CELLS; c += 1) {
    if (walls[c] !== 0 || c === START_CELLS[0] || c === START_CELLS[1]) {
      continue;
    }
    open.push(c);
    const a = from0[c] as number;
    const b = from1[c] as number;
    if (Math.abs(a - b) <= 1 && Math.min(a, b) >= FIRST_MIN) {
      fair.push(c);
    }
  }
  return pickFrom(fair.length > 0 ? fair : open, rng);
}

/** 下一個礦：離目前的礦繞牆 MIN_GAP 到 MAX_GAP 步；找不到就放寬到任何離礦 ≥ 1 步的非牆格。 */
function pickNextMine(
  walls: readonly number[],
  mine: number,
  rng: RngState,
): { cell: number; rng: RngState } {
  const from = bfsDistances(walls, mine);
  const ring: number[] = [];
  const open: number[] = [];
  for (let c = 0; c < CELLS; c += 1) {
    const d = from[c] as number;
    if (walls[c] !== 0 || c === mine || d >= UNREACHABLE) {
      continue;
    }
    open.push(c);
    if (d >= MIN_GAP && d <= MAX_GAP) {
      ring.push(c);
    }
  }
  return pickFrom(ring.length > 0 ? ring : open, rng);
}

// ---------------------------------------------------------------------------
// 遊戲
// ---------------------------------------------------------------------------

export const dQGame: Game<DQState> = {
  id: 'D-Q',

  init(seed: number, config: GameConfig): DQState {
    const walls = generateWalls(seed).walls;
    const first = pickFirstMine(walls, rngStateFor(seed, 'mine'));
    const second = pickNextMine(walls, first.cell, first.rng);
    return {
      tick: 0,
      maxTicks: config.maxTicks,
      walls,
      players: [
        { cell: START_CELLS[0], pending: -1, score: 0 },
        { cell: START_CELLS[1], pending: -1, score: 0 },
      ],
      rng: second.rng,
      over: false,
      winner: null,
      mine: first.cell,
      next: second.cell,
      age: 0,
      carried: [0, 0],
      lost: [0, 0],
      collapses: 0,
    };
  },

  step(state: DQState, inputs: Inputs): DQState {
    if (state.over) {
      return state;
    }
    const tick = state.tick + 1;
    let players: readonly [Walker, Walker] = [
      steerWalker(state.players[0], inputs[0]),
      steerWalker(state.players[1], inputs[1]),
    ];
    const carried = [state.carried[0], state.carried[1]];
    const lost = [state.lost[0], state.lost[1]];
    let { mine, next, age, collapses, rng } = state;

    if (tick % MOVE_EVERY === 0) {
      players = [moveWalker(state.walls, players[0]), moveWalker(state.walls, players[1])];
      // 走出礦坑範圍：身上的礦石變成分數。
      const scores = [players[0].score, players[1].score];
      for (const side of [0, 1] as const) {
        if ((carried[side] as number) > 0 && zoneDistance(players[side].cell, mine) > ZONE_RADIUS) {
          scores[side] = (scores[side] as number) + (carried[side] as number);
          carried[side] = 0;
        }
      }
      players = [
        { ...players[0], score: scores[0] as number },
        { ...players[1], score: scores[1] as number },
      ];
    }

    if (tick % MINE_EVERY === 0) {
      // 開挖：站在礦上的人挖到礦石；一個人 SOLO_YIELD，兩個人各 SHARED_YIELD。
      const onMine = [
        zoneDistance(players[0].cell, mine) <= MINE_REACH,
        zoneDistance(players[1].cell, mine) <= MINE_REACH,
      ];
      const count = (onMine[0] ? 1 : 0) + (onMine[1] ? 1 : 0);
      const gain = count === 1 ? SOLO_YIELD : SHARED_YIELD;
      for (const side of [0, 1] as const) {
        if (onMine[side]) {
          carried[side] = (carried[side] as number) + gain;
        }
      }
      age += 1;
      // 塌不塌：每次開挖都擲一次（不管有沒有人在），新的亂數狀態一定寫回 state。
      let roll: number;
      [roll, rng] = intFrom(rng, 1000);
      if (roll < hazardPermille(age)) {
        for (const side of [0, 1] as const) {
          if (zoneDistance(players[side].cell, mine) <= ZONE_RADIUS) {
            lost[side] = (lost[side] as number) + (carried[side] as number);
            carried[side] = 0;
          }
        }
        mine = next;
        const picked = pickNextMine(state.walls, mine, rng);
        next = picked.cell;
        rng = picked.rng;
        age = 0;
        collapses += 1;
      }
    }

    const over = tick >= state.maxTicks;
    return {
      ...state,
      tick,
      players,
      rng,
      mine,
      next,
      age,
      collapses,
      carried: [carried[0] as number, carried[1] as number],
      lost: [lost[0] as number, lost[1] as number],
      over,
      winner: over ? winnerByScore(players) : null,
    };
  },

  isOver(state: DQState): boolean {
    return state.over;
  },

  score(state: DQState): readonly [number, number] {
    return [state.players[0].score, state.players[1].score];
  },

  winner(state: DQState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: DQState, side: Side): readonly Buttons[] {
    return actionsToward(state.walls, state.players[side], side, state.mine);
  },

  evaluate(state: DQState, side: Side): { gain: number; danger: number } {
    const other: Side = side === 0 ? 1 : 0;
    const me = state.players[side];
    const opponent = state.players[other];
    if (state.over) {
      const difference = me.score - opponent.score;
      const sign = difference === 0 ? 0 : difference > 0 ? 1 : -1;
      return { gain: GAIN_PER_POINT * difference + sign * WIN_BONUS, danger: 0 };
    }
    const myNext = nextCell(state.walls, me);
    const oppNext = nextCell(state.walls, opponent);
    let score = me.score;
    let carried = state.carried[side];
    const d = zoneDistance(myNext, state.mine);
    if (d > ZONE_RADIUS && carried > 0) {
      score += carried; // 下一步就在範圍外：當作已經變成分數
      carried = 0;
    }
    const onMine = d <= MINE_REACH;
    const yieldNow = !onMine
      ? 0
      : zoneDistance(oppNext, state.mine) <= MINE_REACH
        ? SHARED_YIELD
        : SOLO_YIELD;
    const distance = Math.max(
      0,
      Math.min(bfsDistances(state.walls, state.mine)[myNext] as number, 200) - MINE_REACH,
    );
    // 搶位置：礦塌了之後，誰先到下一個礦誰就多挖幾次獨吞。礦越舊（塌得越快）、我比對手近得越多，這一項越高。
    const toNext = bfsDistances(state.walls, state.next);
    const lead = Math.max(
      -RACE_CAP,
      Math.min(RACE_CAP, (toNext[oppNext] as number) - (toNext[myNext] as number)),
    );
    const race = (RACE_PER_MOVE * hazardPermille(state.age + 1) * lead) / 1000;
    const gain =
      GAIN_PER_POINT * (score - opponent.score) +
      race +
      CARRY_WEIGHT * (carried - state.carried[other]) +
      PROGRESS_PER_ORE * carried * Math.max(0, Math.min(d, ZONE_RADIUS) - MINE_REACH) +
      MINE_BONUS_PER_ORE * yieldNow -
      distance;
    // danger：照現在的計畫做下去，身上的礦石被埋掉的機率。
    // 走出去的計畫：走出範圍之前要花 `untilExit` 個 tick，期間經過 `untilExit / MINE_EVERY` 次開挖（用小數，
    // 越往外走越小，所以一旦開始走就會一路走出去，不會在範圍邊緣抖動）；
    // 留下的計畫（不動或往礦走）：往後 STAY_HORIZON 次開挖都在範圍裡。
    const leaving = myNext !== me.cell && d >= zoneDistance(me.cell, state.mine);
    const exit = Math.max(0, ZONE_RADIUS + 1 - d);
    let events = STAY_HORIZON;
    if (leaving) {
      events = (MOVE_EVERY - (state.tick % MOVE_EVERY) + MOVE_EVERY * exit) / MINE_EVERY;
    }
    const collapse = 1 - Math.pow(1 - hazardPermille(state.age + 1) / 1000, events);
    const x = (collapse * (carried + yieldNow)) / RISK_SCALE;
    return { gain, danger: x / (1 + x) };
  },
};
