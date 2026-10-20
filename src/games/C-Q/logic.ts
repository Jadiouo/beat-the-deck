import type { Buttons, GameConfig, Inputs, Side } from '../../core/types';
import type { GameWithSelfFromPresent } from '../types';
import {
  HEIGHT,
  MOVE_EVERY,
  WIDTH,
  cell,
  cellX,
  cellY,
  evaluateClubs,
  initClubsState,
  makeState as makeClubsState,
  orderedActions,
  stepClubs,
} from '../_clubs/logic';
import type { ClubsState, Snake, StateOverrides } from '../_clubs/logic';

/**
 * C-Q 兩條蛇（小規格 `docs/cards/C-Q.md`）。每邊一條主蛇（規則全部是貪食蛇 C-A，走格、食物、死亡直接用
 * `_clubs/logic.ts` 的 `stepClubs`）加一台「僚機」：按 a 從主蛇尾端放出，每 `DRONE_EVERY` tick 走一格飛向
 * `aim`（對手蛇頭沿行進方向再走 `AIM_LEAD` 格，每 `AIM_EVERY` tick 更新），碰到對手任何一格就鎖住對手的轉向
 * `LOCK_MOVES` 次走格，之後 `IMMUNE_TICKS` tick 免疫。
 *
 * 另外有一個選項 `tailCost`（DESIGN-AI-FUN 10.19 的改法，小規格的原版沒有）：放出要割下主蛇 1 格尾巴、
 * 分數 −1，命中（鎖定生效）才還給你；撲空、免疫中被碰到、互相擊落都不還。
 *
 * 完整資訊：僚機、aim、冷卻、鎖定都在 state 裡，AI 與人看到的一樣。
 */

// ---------------------------------------------------------------------------
// 常數（起始值）
// ---------------------------------------------------------------------------

export const RELOAD = 480;
export const START_RELOAD = 300;
export const DRONE_EVERY = 9;
export const AIM_EVERY = 24;
export const AIM_LEAD = 4;
export const DRONE_TTL = 300;
export const LOCK_MOVES = 3;
export const IMMUNE_TICKS = 60;
/** tailCost 版本：蛇至少要這麼長才能放（放完至少剩 3 格）。 */
export const MIN_LAUNCH_LENGTH = 4;

/** 評估用：僚機到對手蛇身的距離超過這個值，hope 就是 0。 */
export const HOPE_RANGE = 16;
/** 評估用：我的僚機在場上時，`hope` 的 gain 權重。 */
export const HOPE_WEIGHT = 40;
/** 評估用：對手被鎖定、我的主蛇夠近時，每格剩餘鎖定的 gain（`× lock / LOCK_MOVES`）。 */
export const LOCK_BONUS = 60;
/** 評估用：我的蛇頭離被鎖定的對手蛇頭幾格以內才算「收口」。 */
export const CLOSE_RANGE = 8;
/** 評估用：放出的成本（一次冷卻的價值）。tailCost 版本不用（真正的成本在分數裡）。 */
export const LAUNCH_COST = 30;
/** 評估用：對手的僚機 2 次走格內會碰到我時的 danger。 */
export const DRONE_DANGER = 0.6;
/** 評估用：tailCost 版本，僚機在場上時把「還給我的 1 分」按 hope 算進 gain 的權重（每分 100）。 */
export const ESCROW_WEIGHT = 100;

const DX: readonly number[] = [0, 1, 0, -1];
const DY: readonly number[] = [-1, 0, 1, 0];

// ---------------------------------------------------------------------------
// state 與選項
// ---------------------------------------------------------------------------

export interface Drone {
  /** 現在的格子。 */
  readonly cell: number;
  /** 前兩個位置（只給畫面用），最新的在前。 */
  readonly tail: readonly number[];
  /** 瞄準的格子（公開）。 */
  readonly aim: number;
  /** 剩餘壽命 tick。 */
  readonly ttl: number;
  /** 下一次更新 aim 的 tick 數。 */
  readonly nextAim: number;
}

export interface CQState extends ClubsState {
  /** 還要幾個 tick 才能再放（0＝可以放）。 */
  readonly reload: readonly [number, number];
  /** 上一個 tick 有沒有按著 a（邊緣觸發用）。 */
  readonly aHeld: readonly [boolean, boolean];
  readonly drone: readonly [Drone | null, Drone | null];
  /** 還要被鎖幾次走格（0＝沒被鎖）。 */
  readonly lock: readonly [number, number];
  /** 免疫剩餘 tick。 */
  readonly immune: readonly [number, number];
  /** 累計命中（鎖定生效）與放出次數。 */
  readonly hits: readonly [number, number];
  readonly launches: readonly [number, number];
}

export interface CQOptions {
  /** true（預設）：放出要割尾巴、分數 −1，命中才還（10.19 的改法）。false：小規格原版，放出不花東西。 */
  readonly tailCost?: boolean;
  /** false：沒有僚機（按 a 沒效果，AI 沒有放的動作）＝ C-A。消融用。預設 true。 */
  readonly drones?: boolean;
  /** 評估裡「放出去的成本」；只在非 tailCost 時用。預設 `LAUNCH_COST`。 */
  readonly launchCost?: number;
  readonly lockMoves?: number;
  readonly reload?: number;
  readonly startReload?: number;
  readonly droneEvery?: number;
  readonly aimEvery?: number;
  readonly aimLead?: number;
  readonly ttl?: number;
  readonly immuneTicks?: number;
}

type Resolved = Required<CQOptions>;

function resolve(options: CQOptions): Resolved {
  return {
    tailCost: options.tailCost ?? true,
    drones: options.drones ?? true,
    launchCost: options.launchCost ?? LAUNCH_COST,
    lockMoves: options.lockMoves ?? LOCK_MOVES,
    reload: options.reload ?? RELOAD,
    startReload: options.startReload ?? START_RELOAD,
    droneEvery: options.droneEvery ?? DRONE_EVERY,
    aimEvery: options.aimEvery ?? AIM_EVERY,
    aimLead: options.aimLead ?? AIM_LEAD,
    ttl: options.ttl ?? DRONE_TTL,
    immuneTicks: options.immuneTicks ?? IMMUNE_TICKS,
  };
}

// ---------------------------------------------------------------------------
// 瞄準與飛行
// ---------------------------------------------------------------------------

/** 蛇頭沿行進方向（`dir`，不是 `turn`）再走 `lead` 格，走到地圖邊界就停在邊界內的最後一格。 */
export function aimPoint(snake: Snake, lead: number = AIM_LEAD): number {
  const head = snake.body[0] as number;
  let x = cellX(head);
  let y = cellY(head);
  for (let i = 0; i < lead; i += 1) {
    const nx = x + (DX[snake.dir] as number);
    const ny = y + (DY[snake.dir] as number);
    if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) {
      break;
    }
    x = nx;
    y = ny;
  }
  return cell(x, y);
}

/** 往 aim 走一格：橫向與縱向差距比較大的軸先走，相等時橫向先；已經在 aim 上就不動。 */
function flyToward(from: number, aim: number): number {
  const x = cellX(from);
  const y = cellY(from);
  const dx = cellX(aim) - x;
  const dy = cellY(aim) - y;
  if (dx === 0 && dy === 0) {
    return from;
  }
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
    return cell(x + Math.sign(dx), y);
  }
  return cell(x, y + Math.sign(dy));
}

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

// ---------------------------------------------------------------------------
// 一個 tick
// ---------------------------------------------------------------------------

function otherOf(side: Side): Side {
  return side === 0 ? 1 : 0;
}

function canLaunch(options: Resolved, state: CQState, side: Side): boolean {
  const me = state.snakes[side];
  return (
    options.drones &&
    !state.over &&
    me.alive &&
    state.reload[side] === 0 &&
    state.drone[side] === null &&
    !state.aHeld[side] &&
    (!options.tailCost || me.body.length >= MIN_LAUNCH_LENGTH)
  );
}

function withSnake(
  snakes: readonly [Snake, Snake],
  side: Side,
  snake: Snake,
): readonly [Snake, Snake] {
  return side === 0 ? [snake, snakes[1]] : [snakes[0], snake];
}

/** 沒有方向鍵的輸入（被鎖定的一邊，轉向輸入被忽略）。 */
function stripDirections(buttons: Buttons): Buttons {
  return { ...buttons, up: false, down: false, left: false, right: false };
}

function stepWith(options: Resolved, state: CQState, inputs: Inputs): CQState {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  const moveTick = tick % MOVE_EVERY === 0;

  // 免疫倒數（鎖定中不倒數）。
  const immune: [number, number] = [
    state.lock[0] === 0 ? Math.max(0, state.immune[0] - 1) : state.immune[0],
    state.lock[1] === 0 ? Math.max(0, state.immune[1] - 1) : state.immune[1],
  ];
  const reload: [number, number] = [
    Math.max(0, state.reload[0] - 1),
    Math.max(0, state.reload[1] - 1),
  ];
  const aHeld: [boolean, boolean] = [inputs[0].a, inputs[1].a];
  const launches: [number, number] = [state.launches[0], state.launches[1]];
  const hits: [number, number] = [state.hits[0], state.hits[1]];
  const lock: [number, number] = [state.lock[0], state.lock[1]];
  const drone: [Drone | null, Drone | null] = [state.drone[0], state.drone[1]];
  const fresh: [boolean, boolean] = [false, false];
  let snakes: readonly [Snake, Snake] = state.snakes;

  // 1. 放出（這個 tick 一開始，主蛇還沒走）。
  for (const side of [0, 1] as const) {
    if (!inputs[side].a || !canLaunch(options, state, side)) {
      continue;
    }
    const me = snakes[side];
    const tailCell = me.body[me.body.length - 1] as number;
    if (options.tailCost) {
      snakes = withSnake(snakes, side, {
        ...me,
        body: me.body.slice(0, -1),
        score: me.score - 1,
      });
    }
    drone[side] = { cell: tailCell, tail: [], aim: tailCell, ttl: options.ttl, nextAim: tick };
    fresh[side] = true;
    reload[side] = options.reload;
    launches[side] += 1;
  }

  // 2. 主蛇：照 C-A（stepClubs）。被鎖定的一邊轉向輸入被忽略（它的 turn 本來就等於 dir）。
  const clubInputs: Inputs = [
    state.lock[0] > 0 ? stripDirections(inputs[0]) : inputs[0],
    state.lock[1] > 0 ? stripDirections(inputs[1]) : inputs[1],
  ];
  const moved = stepClubs({ ...state, snakes }, clubInputs);
  snakes = moved.snakes;

  const finish = (
    over: boolean,
    winner: Side | null,
    foods: readonly number[],
    rng: typeof state.rng,
  ): CQState => ({
    ...state,
    tick,
    snakes,
    foods,
    rng,
    over,
    winner,
    reload,
    aHeld,
    drone,
    lock,
    immune,
    hits,
    launches,
  });
  if (moved.over) {
    return finish(true, moved.winner, moved.foods, moved.rng);
  }

  // 3. 走格時，鎖定中的一邊少一次鎖定；鎖定結束就進入免疫。
  if (moveTick) {
    for (const side of [0, 1] as const) {
      if (state.lock[side] > 0) {
        lock[side] = state.lock[side] - 1;
        if (lock[side] === 0) {
          immune[side] = options.immuneTicks;
        }
      }
    }
  }

  // 4. 僚機：壽命、瞄準、飛行（用主蛇走完之後的位置）。
  const previous: [number, number] = [-1, -1];
  const flew: [boolean, boolean] = [false, false];
  for (const side of [0, 1] as const) {
    const d = drone[side];
    if (d === null) {
      continue;
    }
    let ttl = d.ttl;
    if (!fresh[side]) {
      ttl -= 1;
      if (ttl <= 0) {
        drone[side] = null;
        continue;
      }
    }
    let aim = d.aim;
    let nextAim = d.nextAim;
    if (tick >= nextAim) {
      aim = aimPoint(snakes[otherOf(side)], options.aimLead);
      nextAim = tick + options.aimEvery;
    }
    let at = d.cell;
    let trail = d.tail;
    if (!fresh[side] && (options.ttl - ttl) % options.droneEvery === 0) {
      const next = flyToward(d.cell, aim);
      if (next !== d.cell) {
        previous[side] = d.cell;
        flew[side] = true;
        trail = [d.cell, ...d.tail].slice(0, 2);
        at = next;
      }
    }
    drone[side] = { cell: at, tail: trail, aim, ttl, nextAim };
  }

  // 5. 互相擊落（同格、或同一個 tick 互換位置）。
  const a = drone[0];
  const b = drone[1];
  if (
    a !== null &&
    b !== null &&
    (a.cell === b.cell || (flew[0] && flew[1] && a.cell === previous[1] && b.cell === previous[0]))
  ) {
    drone[0] = null;
    drone[1] = null;
  }

  // 6. 命中：僚機所在格子是對手主蛇的任何一格。
  for (const side of [0, 1] as const) {
    const d = drone[side];
    if (d === null) {
      continue;
    }
    const victim = otherOf(side);
    if (!snakes[victim].alive || !snakes[victim].body.includes(d.cell)) {
      continue;
    }
    drone[side] = null;
    if (lock[victim] > 0 || immune[victim] > 0) {
      continue;
    }
    lock[victim] = options.lockMoves;
    const target = snakes[victim];
    snakes = withSnake(snakes, victim, { ...target, turn: target.dir });
    hits[side] += 1;
    if (options.tailCost) {
      const owner = snakes[side];
      const tailCell = owner.body[owner.body.length - 1] as number;
      snakes = withSnake(snakes, side, {
        ...owner,
        body: [...owner.body, tailCell],
        score: owner.score + 1,
      });
    }
  }

  return finish(false, null, moved.foods, moved.rng);
}

// ---------------------------------------------------------------------------
// 動作
// ---------------------------------------------------------------------------

const NONE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});
const IDLE: readonly Buttons[] = Object.freeze([NONE]);
const LAUNCH: Buttons = Object.freeze({ ...NONE, a: true });

const launchCache = new WeakMap<readonly Buttons[], readonly Buttons[]>();

/**
 * 「全放開＋a」接在基底動作的**前面**。基底動作是 `orderedActions` 的回傳值（模組內固定的共用陣列），
 * 所以用它當快取的鑰匙，不會每個 tick 新配置。
 *
 * 為什麼放在前面（小規格原本寫「不放在前、放在後（平手時不放）」，量測推翻）：搜尋型往前看 6 個 tick，
 * 「現在放」與「晚一點放」的終點一樣好（僚機放出去 9 個 tick 才動一格），平手取排前面的，不放排前面就永遠拖延到最後一刻；
 * 決定頻率低（每 4 個 tick 才決定一次）的 AI 於是幾乎不放：深度 6 每場 0.1 次，深度 1 卻放 3.4 次，淺的贏 82.5%
 * （commit c44eab0，80 場）。放在前面之後，深的每場放 3.5 次、贏 55%。
 * 這只影響「現在放」與「晚點放」平手的局面；放得值不值由 `evaluate` 決定，不值得時不放嚴格比較好，不是平手。
 */
function withLaunch(base: readonly Buttons[]): readonly Buttons[] {
  let cached = launchCache.get(base);
  if (cached === undefined) {
    cached = Object.freeze([LAUNCH, ...base]);
    launchCache.set(base, cached);
  }
  return cached;
}

/**
 * 基底動作完全沿用 C-A（`orderedActions`：兩個有效的轉向在前，之後是不會改變方向的三個）。小規格原本寫「3 個基底動作各帶一份 a」，
 * 量測推翻：3 個基底動作時搜尋型等級 5 對亂按只贏 71.0%（C-A 的 5 個動作是 81.0%，種子 0..99），沿用 5 個回到 79–80%。
 * 放僚機的 a 是否與轉向同時按，對結果沒有差別（a 是邊緣觸發、轉向只要在走格前鎖定），所以只加一個「全放開＋a」。
 */
function actionsWith(options: Resolved, state: CQState, side: Side): readonly Buttons[] {
  // 局結束、死了、這個走格週期已經鎖定轉向（turn ≠ dir）、被僚機鎖住（轉向輸入作廢）：只有「全放開」是有意義的動作。
  // 這個走格週期已鎖定轉向時，C-A 仍提供 5 個等價動作；搜尋型的束搜尋會被這些重複的分支塞滿（A2 63.5%，
  // 只留全放開是 93%，種子 0..99），所以 C-Q 只留一個。
  const me = state.snakes[side];
  const idleOnly = state.over || !me.alive || me.turn !== me.dir || state.lock[side] > 0;
  const base = idleOnly ? IDLE : orderedActions(state, side);
  return canLaunch(options, state, side) ? withLaunch(base) : base;
}

// ---------------------------------------------------------------------------
// 評估
// ---------------------------------------------------------------------------

/** 到對手蛇身最近一格的曼哈頓距離。 */
function nearestBody(from: number, snake: Snake): number {
  let best = Number.POSITIVE_INFINITY;
  for (const c of snake.body) {
    best = Math.min(best, manhattan(from, c));
  }
  return best;
}

/** 對手的僚機現在或接下來 2 次走格內，會不會落在我的身體（或我往前直走 3 格）上。 */
function droneThreatens(threat: Drone, me: Snake): boolean {
  const cells = [...me.body];
  const head = me.body[0] as number;
  let x = cellX(head);
  let y = cellY(head);
  for (let i = 0; i < 3; i += 1) {
    x += DX[me.dir] as number;
    y += DY[me.dir] as number;
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
      break;
    }
    cells.push(cell(x, y));
  }
  let at = threat.cell;
  for (let step = 0; step <= 2; step += 1) {
    if (cells.includes(at)) {
      return true;
    }
    at = flyToward(at, threat.aim);
  }
  return false;
}

/** 被鎖定的 `lock` 次走格內，直走會不會撞牆或撞身體。 */
function lockedIntoObstacle(state: CQState, side: Side): boolean {
  const me = state.snakes[side];
  const head = me.body[0] as number;
  let x = cellX(head);
  let y = cellY(head);
  for (let i = 1; i <= (state.lock[side] as number); i += 1) {
    x += DX[me.dir] as number;
    y += DY[me.dir] as number;
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
      return true;
    }
    const c = cell(x, y);
    for (const snake of state.snakes) {
      const at = snake.body.indexOf(c);
      // 尾巴那一格走的時候會空出來（不算）；其餘有身體就算。
      if (at !== -1 && at < snake.body.length - i) {
        return true;
      }
    }
  }
  return false;
}

function evaluateWith(
  options: Resolved,
  state: CQState,
  side: Side,
): { gain: number; danger: number } {
  const base = evaluateClubs(state, side);
  if (state.over) {
    return base;
  }
  const other = otherOf(side);
  const me = state.snakes[side];
  const opp = state.snakes[other];
  let gain = base.gain;
  let danger = base.danger;

  const mine = state.drone[side];
  if (mine !== null && opp.alive) {
    const hope = 1 - Math.min(1, nearestBody(mine.cell, opp) / HOPE_RANGE);
    gain += HOPE_WEIGHT * hope;
    if (options.tailCost) {
      gain += ESCROW_WEIGHT * hope;
    } else {
      gain -= options.launchCost;
    }
  }
  if (state.lock[other] > 0 && me.alive && opp.alive) {
    if (manhattan(me.body[0] as number, opp.body[0] as number) <= CLOSE_RANGE) {
      gain += (LOCK_BONUS * state.lock[other]) / options.lockMoves;
    }
  }

  const theirs = state.drone[other];
  if (
    theirs !== null &&
    me.alive &&
    state.lock[side] === 0 &&
    state.immune[side] === 0 &&
    droneThreatens(theirs, me)
  ) {
    danger = Math.max(danger, DRONE_DANGER);
  }
  if (state.lock[side] > 0 && me.alive) {
    danger = Math.max(
      danger,
      lockedIntoObstacle(state, side) ? 1 : (0.4 * state.lock[side]) / options.lockMoves,
    );
  }
  return { gain, danger: Math.min(1, danger) };
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

function extend(base: ClubsState, options: Resolved): CQState {
  return {
    ...base,
    reload: [options.startReload, options.startReload],
    aHeld: [false, false],
    drone: [null, null],
    lock: [0, 0],
    immune: [0, 0],
    hits: [0, 0],
    launches: [0, 0],
  };
}

export function createCQGame(options: CQOptions = {}): GameWithSelfFromPresent<CQState> {
  const resolved = resolve(options);
  return {
    id: 'C-Q',

    init(seed: number, config: GameConfig): CQState {
      return extend(initClubsState(seed, config), resolved);
    },

    step(state: CQState, inputs: Inputs): CQState {
      return stepWith(resolved, state, inputs);
    },

    isOver(state: CQState): boolean {
      return state.over;
    },

    score(state: CQState): readonly [number, number] {
      return [state.snakes[0].score, state.snakes[1].score];
    },

    winner(state: CQState): Side | null {
      return state.over ? state.winner : null;
    },

    actions(state: CQState, side: Side): readonly Buttons[] {
      return actionsWith(resolved, state, side);
    },

    evaluate(state: CQState, side: Side): { gain: number; danger: number } {
      return evaluateWith(resolved, state, side);
    },

    /**
     * 反應延遲的重播只含自己的輸入，重現不出「被對手的僚機鎖定、轉向輸入作廢」這個外力：
     * 重播的主蛇會照自己按的鍵轉彎，真實的主蛇卻被鎖著直走。所以自己這一邊的欄位（主蛇、冷卻、僚機、
     * 鎖定、免疫、計數）取真實的現在；對手與食物維持重播（舊）的樣子。
     */
    selfFromPresent(replayed: CQState, present: CQState, side: Side): CQState {
      const pick = <T>(mine: readonly [T, T], theirs: readonly [T, T]): readonly [T, T] =>
        side === 0 ? [mine[0], theirs[1]] : [theirs[0], mine[1]];
      return {
        ...replayed,
        snakes: pick(present.snakes, replayed.snakes),
        reload: pick(present.reload, replayed.reload),
        aHeld: pick(present.aHeld, replayed.aHeld),
        drone: pick(present.drone, replayed.drone),
        lock: pick(present.lock, replayed.lock),
        immune: pick(present.immune, replayed.immune),
        hits: pick(present.hits, replayed.hits),
        launches: pick(present.launches, replayed.launches),
      };
    },
  };
}

export const cqGame: GameWithSelfFromPresent<CQState> = createCQGame();

// ---------------------------------------------------------------------------
// 測試輔助
// ---------------------------------------------------------------------------

export interface CQOverrides extends StateOverrides {
  readonly reload?: readonly [number, number];
  readonly aHeld?: readonly [boolean, boolean];
  readonly drone?: readonly [Drone | null, Drone | null];
  readonly lock?: readonly [number, number];
  readonly immune?: readonly [number, number];
  readonly hits?: readonly [number, number];
  readonly launches?: readonly [number, number];
}

/**
 * 直接構造一個局面。預設：起始蛇、食物放在兩個遠離蛇的固定位置、**兩邊 reload = 0（可以放）**、
 * 沒有僚機、沒有鎖定。
 */
export function makeState(overrides: CQOverrides = {}): CQState {
  const base = makeClubsState(overrides);
  return {
    ...base,
    reload: overrides.reload ?? [0, 0],
    aHeld: overrides.aHeld ?? [false, false],
    drone: overrides.drone ?? [null, null],
    lock: overrides.lock ?? [0, 0],
    immune: overrides.immune ?? [0, 0],
    hits: overrides.hits ?? [0, 0],
    launches: overrides.launches ?? [0, 0],
  };
}
