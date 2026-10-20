import { rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  GAIN_PER_POINT,
  START_CELLS,
  WIN_BONUS,
  cellX,
  cellY,
  generateWalls,
  pickEmptyCells,
  winnerByScore,
} from '../_diamonds/logic';
import type { BaseOverrides, DiamondsBase, Walker } from '../_diamonds/logic';
import { BAG_LIMIT } from '../D-2/logic';
import { COIN_COUNT } from '../D-A/logic';
import { GEM_COUNT } from '../D-3/logic';
import type { Gem } from '../D-3/logic';
import { d3Game } from '../D-3/logic';
import { d8Game, makeState as makeD8State } from '../D-8/logic';
import type { D8State } from '../D-8/logic';
import { dJGame, GUARD_RANGE, STEAL_RANGE } from '../D-J/logic';
import type { DJState } from '../D-J/logic';
import type { D3State } from '../D-3/logic';

/**
 * D-K 方塊馬拉松（SPEC 第 9 節；小規格 `docs/cards/D-K.md`）。
 *
 * 同一張地圖、同一個計分，60 秒分三段：圈地（D-8）→ 寶石（D-3）→ 存與偷（D-J／D-2），段與段之間有 60 tick 的過場。
 * `step` 依段落把 state 交給那一段的原牌去走（原牌的 `step` 都用 `...state`，多出來的欄位原樣帶過去），
 * 再疊上 D-K 自己的三條連結（地盤紅利、地盤是安全區、偷竊加碼）。
 *
 * 分數是整場累計：第 1 段是 ⌊顏色格數 ÷ `TURF_POINTS`⌋（D-8 的 `step` 每次走格會把 `score` 覆寫成格數，
 * 所以委派之後立刻改回來；第 2、3 段絕對不再呼叫 `d8Game.step`）。
 */

// ---------------------------------------------------------------------------
// 時間表與常數
// ---------------------------------------------------------------------------

/** 每一段前面的過場 tick 數。 */
export const INTRO_TICKS = 60;
/** 第 1 段（圈地）：state.tick 在 [60, 1080) 時，下一步是 D-8 的規則。 */
export const STAGE1_START = 60;
export const STAGE1_END = 1080;
/** 第 2 段（寶石）：[1140, 2520)。 */
export const STAGE2_START = 1140;
export const STAGE2_END = 2520;
/** 第 3 段（存與偷）：[2580, 結束)。 */
export const STAGE3_START = 2580;
/**
 * 第 1 段的分數：每這麼多格顏色 1 分（無條件捨去）。小規格原本是 10；原型關卡量到三段的分數是 21:186:4
 * （第 2 段占 87%），所以改成 1（1 格 1 分，和 D-8 原本的算法一致），見 `docs/cards/D-K.md`「原型關卡」。
 */
export const TURF_POINTS = 1;
/**
 * 第 3 段一枚金幣值幾分：D-2 的金幣存進去只加 1 分，在這張牌的分數尺度下第 3 段等於不存在；
 * 這裡把存進基地改成每枚 `COIN_POINTS` 分，偷竊也搬一枚金幣的分數（背包裡的一枚，存進去時值 `COIN_POINTS`）。
 */
export const COIN_POINTS = 20;
/** 偷成功時額外再從對手的分數拿 1 分放進背包（背包有空位、對手還有分才有）。 */
export const STEAL_EXTRA = 1;

/** 段落：0 過場、1 圈地、2 寶石、3 存與偷。 */
export type Stage = 0 | 1 | 2 | 3;

/** 一個 `tick` 的 state 現在在哪一段（下一步用哪一段的規則）。 */
export function stageOf(tick: number): Stage {
  if (tick < STAGE1_START) {
    return 0;
  }
  if (tick < STAGE1_END) {
    return 1;
  }
  if (tick < STAGE2_START) {
    return 0;
  }
  if (tick < STAGE2_END) {
    return 2;
  }
  if (tick < STAGE3_START) {
    return 0;
  }
  return 3;
}

/** 測試與外殼共用的設定（跟 `GameConfig` 的預設一樣）。 */
export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };

/** 沒有被保護的舊顏色用的時間戳（同 D-8）。 */
const LONG_AGO = -1_000_000;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** 三張原牌欄位的聯集，加上 D-K 自己的三個統計欄位。 */
export interface DKState extends DiamondsBase {
  // D-8
  readonly paint: readonly number[];
  readonly stamp: readonly number[];
  readonly heading: readonly [number, number];
  // D-3
  readonly gems: readonly Gem[];
  // D-2／D-J
  readonly coins: readonly number[];
  readonly bags: readonly [number, number];
  readonly lurk: readonly [number, number];
  readonly stolen: readonly [number, number];
  // D-K
  /** 兩邊的顏色格數。第 1 段每次走格更新，第 1 段結束後凍結。 */
  readonly turfCells: readonly [number, number];
  /** 第 2 段靠連結 1 的紅利多得幾分。 */
  readonly turfGems: readonly [number, number];
  /** 第 3 段被連結 2 擋掉偷竊的 tick 數（偷的人的編號）。 */
  readonly blocked: readonly [number, number];
}

export interface StateOverrides extends BaseOverrides {
  readonly paint0?: readonly number[];
  readonly paint1?: readonly number[];
  readonly stamps?: readonly (readonly [number, number])[];
  readonly gems?: readonly Gem[];
  readonly coins?: readonly number[];
  readonly bags?: readonly [number, number];
  readonly lurk?: readonly [number, number];
  readonly stolen?: readonly [number, number];
  readonly turfGems?: readonly [number, number];
  readonly blocked?: readonly [number, number];
}

/**
 * 測試輔助：預設沒有牆、兩人在起點、沒有任何顏色、`tick = 60`（第 1 段開始）。
 * `players[i].score` 預設是 ⌊顏色格數 ÷ 10⌋（第 1 段的定義），可以用 `players` 覆蓋成任何累計分。
 * `stage` 由 `tick` 推出，不另存。
 */
export function makeState(overrides: StateOverrides = {}): DKState {
  const d8 = makeD8State({ ...overrides, tick: overrides.tick ?? STAGE1_START, players: undefined });
  const cells0 = d8.players[0].score;
  const cells1 = d8.players[1].score;
  const base = d8 as DiamondsBase;
  const walker = (side: Side, cells: number): Walker => ({
    ...base.players[side],
    score: Math.floor(cells / TURF_POINTS),
    ...overrides.players?.[side],
  });
  return {
    ...d8,
    players: [walker(0, cells0), walker(1, cells1)],
    gems: overrides.gems ?? [],
    coins: overrides.coins ?? [],
    bags: overrides.bags ?? [0, 0],
    lurk: overrides.lurk ?? [0, 0],
    stolen: overrides.stolen ?? [0, 0],
    turfCells: [cells0, cells1],
    turfGems: overrides.turfGems ?? [0, 0],
    blocked: overrides.blocked ?? [0, 0],
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

/** 這個人站的格子是不是他自己的顏色。 */
function onOwnTurf(state: DKState, side: Side): boolean {
  return state.paint[(state.players[side] as Walker).cell] === side + 1;
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

/** 第 1 段：交給 D-8，之後把分數改回 ⌊格數 ÷ 10⌋（D-8 會覆寫成格數）。 */
function stepTurf(state: DKState, inputs: Inputs): DKState {
  const next = d8Game.step(state as unknown as D8State, inputs) as unknown as DKState;
  if (next.tick % 5 !== 0) {
    return next; // 沒走格：D-8 原樣帶著我們的分數
  }
  // D-8 在走格 tick 把 score 設成顏色格數：讀出來當 turfCells，再換成 D-K 的分數。
  const cells: [number, number] = [next.players[0].score, next.players[1].score];
  return {
    ...next,
    players: [
      { ...next.players[0], score: Math.floor(cells[0] / TURF_POINTS) },
      { ...next.players[1], score: Math.floor(cells[1] / TURF_POINTS) },
    ],
    turfCells: cells,
  };
}

/** 第 2 段：交給 D-3；站在自己顏色的格子上撿到寶石的人，多得 ⌈價值 ÷ 2⌉（連結 1）。 */
function stepGems(state: DKState, inputs: Inputs): DKState {
  const next = d3Game.step(state as unknown as D3State, inputs) as unknown as DKState;
  if (next.tick % 5 !== 0) {
    return next;
  }
  const players = [next.players[0], next.players[1]] as [Walker, Walker];
  const turfGems = [next.turfGems[0], next.turfGems[1]] as [number, number];
  for (const side of [0, 1] as const) {
    const gained = (players[side] as Walker).score - (state.players[side] as Walker).score;
    if (gained > 0 && state.paint[(players[side] as Walker).cell] === side + 1) {
      const bonus = Math.ceil(gained / 2);
      players[side] = { ...(players[side] as Walker), score: (players[side] as Walker).score + bonus };
      turfGems[side] += bonus;
    }
  }
  return { ...next, players, turfGems };
}

/** 第 3 段：連結 2 在委派前把「被偷的人站在自己顏色上」的偷竊倒數歸 0；交給 D-J；偷成功的再加碼 `STEAL_EXTRA`。 */
function stepSteal(state: DKState, inputs: Inputs): DKState {
  const lurk: [number, number] = [state.lurk[0], state.lurk[1]];
  const safe: [boolean, boolean] = [false, false];
  const blocked: [number, number] = [state.blocked[0], state.blocked[1]];
  for (const thief of [0, 1] as const) {
    const victim: Side = thief === 0 ? 1 : 0;
    if (!onOwnTurf(state, victim)) {
      continue;
    }
    // 只有「不被擋的話這個 tick 本來會累積倒數」才算擋掉一次：貼著對手基地、對手不在自己基地附近、對手有分、背包有空位。
    const wouldLurk =
      manhattan((state.players[thief] as Walker).cell, START_CELLS[victim]) <= STEAL_RANGE &&
      manhattan((state.players[victim] as Walker).cell, START_CELLS[victim]) > GUARD_RANGE &&
      (state.players[victim] as Walker).score >= 1 &&
      state.bags[thief] < BAG_LIMIT;
    if (wouldLurk) {
      blocked[thief] += 1;
    }
    lurk[thief] = 0;
    safe[thief] = true;
  }
  const gated: DKState = { ...state, lurk, blocked };
  let moved = dJGame.step(gated as unknown as DJState, inputs) as unknown as DKState;
  if (safe[0] || safe[1]) {
    // D-J 看到 lurk = 0 會從 0 數到 1；被擋的這個 tick 倒數維持 0（畫面上不會閃一下）。
    moved = { ...moved, lurk: [safe[0] ? 0 : moved.lurk[0], safe[1] ? 0 : moved.lurk[1]] };
  }
  const won: [boolean, boolean] = [
    moved.stolen[0] > state.stolen[0],
    moved.stolen[1] > state.stolen[1],
  ];
  // 金幣一枚 COIN_POINTS 分。D-2／D-J 把存進基地記成 +背包數、把偷成功記成 −1，這裡改成每枚 COIN_POINTS：
  // 存進基地的人補上 (COIN_POINTS − 1) × 枚數；被偷的人改成損失一枚金幣的分數（不到一枚就是他全部）。
  // 兩邊都用 D-J 結算後的同一份快照算，再同時套用（零和：被偷的減多少，偷的人背包的金幣就值多少）。
  const base: [number, number] = [0, 0];
  for (const side of [0, 1] as const) {
    const other: Side = side === 0 ? 1 : 0;
    const lost = won[other] ? 1 : 0;
    const deposited = moved.players[side].score - state.players[side].score + lost;
    base[side] = state.players[side].score + COIN_POINTS * deposited;
  }
  const scores: [number, number] = [base[0], base[1]];
  const bags: [number, number] = [moved.bags[0], moved.bags[1]];
  const stolen: [number, number] = [moved.stolen[0], moved.stolen[1]];
  for (const thief of [0, 1] as const) {
    const victim: Side = thief === 0 ? 1 : 0;
    if (!won[thief]) {
      continue;
    }
    const first = Math.min(COIN_POINTS, base[victim]);
    scores[victim] -= first;
    // 偷成功的加碼：對手還有分、背包還有空位，再偷一枚。
    if (
      STEAL_EXTRA > 0 &&
      base[victim] - first >= 1 &&
      moved.bags[thief] < BAG_LIMIT
    ) {
      scores[victim] -= Math.min(COIN_POINTS, base[victim] - first);
      bags[thief] += STEAL_EXTRA;
      stolen[thief] += STEAL_EXTRA;
    }
  }
  const players: readonly [Walker, Walker] = [
    { ...moved.players[0], score: scores[0] },
    { ...moved.players[1], score: scores[1] },
  ];
  return { ...moved, players, bags, stolen };
}

/** 進入第 2 段那一刻：場上補 5 顆寶石（born = 這個 tick）。 */
function spawnGems(state: DKState): DKState {
  const placed = pickEmptyCells(
    state.rng,
    state.walls,
    [state.players[0].cell, state.players[1].cell],
    GEM_COUNT,
  );
  return {
    ...state,
    gems: placed.cells.map((c): Gem => ({ cell: c, born: state.tick })),
    rng: placed.rng,
  };
}

/** 進入第 3 段那一刻：補 6 枚金幣（不放在基地、人身上），背包與偷竊倒數歸 0。 */
function spawnCoins(state: DKState): DKState {
  const placed = pickEmptyCells(
    state.rng,
    state.walls,
    [state.players[0].cell, state.players[1].cell, ...START_CELLS],
    COIN_COUNT,
  );
  return { ...state, coins: placed.cells, rng: placed.rng, bags: [0, 0], lurk: [0, 0] };
}

function initialState(seed: number, config: GameConfig): DKState {
  const walls = generateWalls(seed).walls;
  const paint = new Array<number>(CELLS).fill(0);
  paint[START_CELLS[0]] = 1;
  paint[START_CELLS[1]] = 2;
  const stamp = new Array<number>(CELLS).fill(LONG_AGO);
  stamp[START_CELLS[0]] = 0;
  stamp[START_CELLS[1]] = 0;
  return {
    tick: 0,
    maxTicks: config.maxTicks,
    walls,
    players: [
      { cell: START_CELLS[0], pending: -1, score: 0 },
      { cell: START_CELLS[1], pending: -1, score: 0 },
    ],
    rng: rngStateFor(seed, 'marathon'),
    over: false,
    winner: null,
    paint,
    stamp,
    heading: [-1, -1],
    gems: [],
    coins: [],
    bags: [0, 0],
    lurk: [0, 0],
    stolen: [0, 0],
    turfCells: [1, 1],
    turfGems: [0, 0],
    blocked: [0, 0],
  };
}

export const dKGame: Game<DKState> = {
  id: 'D-K',

  init(seed: number, config: GameConfig): DKState {
    return initialState(seed, config);
  },

  step(state: DKState, inputs: Inputs): DKState {
    if (state.over) {
      return state;
    }
    const stage = stageOf(state.tick);
    let next: DKState;
    if (stage === 1) {
      next = stepTurf(state, inputs);
    } else if (stage === 2) {
      next = stepGems(state, inputs);
    } else if (stage === 3) {
      next = stepSteal(state, inputs);
    } else {
      next = { ...state, tick: state.tick + 1 };
    }
    // 段落邊界（next.tick 是剛到的 tick）：進第 2 段補寶石、離開第 2 段收寶石、進第 3 段補金幣。
    if (next.tick === STAGE2_START) {
      next = spawnGems(next);
    } else if (next.tick === STAGE2_END) {
      next = { ...next, gems: [] };
    } else if (next.tick === STAGE3_START) {
      next = spawnCoins(next);
    }
    const over = next.tick >= state.maxTicks;
    return { ...next, over, winner: over ? winnerByScore(next.players) : null };
  },

  isOver(state: DKState): boolean {
    return state.over;
  },

  score(state: DKState): readonly [number, number] {
    return [state.players[0].score, state.players[1].score];
  },

  winner(state: DKState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(_state: DKState, _side: Side): readonly Buttons[] {
    return [NONE_BUTTONS];
  },

  evaluate(state: DKState, side: Side): { gain: number; danger: number } {
    const difference = state.players[side].score - state.players[side === 0 ? 1 : 0].score;
    const sign = difference === 0 ? 0 : difference > 0 ? 1 : -1;
    return {
      gain: GAIN_PER_POINT * difference + (state.over ? sign * WIN_BONUS : 0),
      danger: 0,
    };
  },
};

const NONE_BUTTONS: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});
