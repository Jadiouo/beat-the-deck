import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  FOOD_COUNT,
  HEIGHT,
  MOVE_EVERY,
  WIDTH,
  cell,
  cellX,
  cellY,
  evaluateClubs,
  initClubsState,
  makeState as makeClubsState,
  moveSnakes,
  orderedActions,
  refillFoods,
  steerSnake,
  winnerByScore,
} from '../_clubs/logic';
import type { ClubsState, Snake, StateOverrides } from '../_clubs/logic';

/**
 * C-5 會動的牆（SPEC 第 9 節；小規格 `docs/cards/C-5.md`）。
 * 規則同 C-A，多的是：場上有 4 面牆（兩對），每 5 秒有一對換位置；換位置前 1 秒先閃出落點，
 * 落點裡永遠放著一顆誘餌（+2 分、長 2 格）；牆落下時身體還在落點上的蛇被壓死。
 * 格子、轉向、走格、食物、`winnerByScore` 全部沿用 `_clubs/logic.ts`（不改它）。
 *
 * 完整資訊：牆、落點、誘餌、倒數全部在 state 裡，AI 看到的與人看到的一樣。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 每面牆是一條幾格的直線。 */
export const BAR_LEN = 6;
/** 每一對牆多久換一次位置（tick）：每 5 秒。 */
export const PAIR_PERIOD = 300;
/** 第 1 對比第 0 對晚多少 tick（所以每 2.5 秒場上就有一面牆在換）。 */
export const PAIR_OFFSET = 150;
/** 換位置之前幾個 tick 開始預告（1 秒）。 */
export const PREVIEW_TICKS = 60;
/** 誘餌：吃到加幾分、長幾格。 */
export const BAIT_POINTS = 2;
export const BAIT_GROW = 2;
/** 挑落點最多試幾次。 */
export const LANDING_TRIES = 50;
/** `init` 的 `maxTicks` 下限（小於這個丟 `RangeError`）。 */
export const MIN_MAX_TICKS = 400;
/** 開局的牆離兩個蛇頭至少幾格（曼哈頓距離；比這個近的格子不放牆）。 */
const START_CLEARANCE = 4;
/** 開局挑牆最多試幾次（比落點多很多：開局一定要有牆）。 */
const INIT_TRIES = 400;
/** 壓死的 danger 找出口時，最多往外走幾步。 */
const BFS_CAP = 12;
/** 壓死的 danger：餘裕這麼多步以上就是 0。 */
export const CRUSH_MARGIN = 3;

/** 橫的牆有 (32 − 6 + 1) × 24 種位置、直的牆有 32 × (24 − 6 + 1) 種。 */
const HORIZONTAL = (WIDTH - BAR_LEN + 1) * HEIGHT;
const VERTICAL = WIDTH * (HEIGHT - BAR_LEN + 1);
const CANDIDATES = HORIZONTAL + VERTICAL;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface Landing {
  /** 哪一對牆（0：牆 0 與牆 1；1：牆 2 與牆 3）。 */
  readonly pair: 0 | 1;
  /** 這一對的兩面牆落下之後的格子（由小到大）。第二面是第一面的 180 度旋轉。 */
  readonly bars: readonly (readonly number[])[];
  /** 落下的 tick（等於 `state.tick` 的那一刻落下）。 */
  readonly at: number;
}

export interface Bait {
  readonly cell: number;
  /** 消失的 tick（等於 `landing.at`）。 */
  readonly until: number;
}

export interface C5State extends ClubsState {
  /** 4 面牆目前的格子（每面 6 格，由小到大；測試用的局面可以是空陣列）。所有牆格的聯集就是硬的牆。 */
  readonly bars: readonly (readonly number[])[];
  /** 正在預告的落點；沒有預告是 null。 */
  readonly landing: Landing | null;
  readonly bait: Bait | null;
  /** 整場被壓死的次數（量測與畫面用，每場最多各 1）。 */
  readonly crushed: readonly [number, number];
}

export interface C5Options {
  /** false：牆照樣落下，但不壓死蛇，AI 也不算壓死的 danger（消融實驗用）。預設 true。 */
  readonly crush?: boolean;
  /** false：預告照樣有，但落點裡沒有誘餌（消融實驗用）。預設 true。 */
  readonly bait?: boolean;
  /** 挑落點最多試幾次（測試用）。預設 `LANDING_TRIES`。 */
  readonly landingTries?: number;
  /** 壓死的 danger 在餘裕幾步以上降到 0（測試與調參用）。預設 `CRUSH_MARGIN`。 */
  readonly crushMargin?: number;
}

// ---------------------------------------------------------------------------
// 格子工具
// ---------------------------------------------------------------------------

/** 180 度旋轉：(x, y) → (31 − x, 23 − y)。 */
export function rotateCell(index: number): number {
  return CELLS - 1 - index;
}

/** 第 `n`（從 1 算起）次落下的 tick。 */
export function landingTick(pair: 0 | 1, n: number): number {
  return PAIR_PERIOD * n + PAIR_OFFSET * pair;
}

/** 下一次有牆落下的 tick（任何一對）：300、450、600……每 150 tick 一次。 */
export function nextLandingTick(tick: number): number {
  return Math.max(PAIR_PERIOD, Math.floor(tick / PAIR_OFFSET + 1) * PAIR_OFFSET);
}

/** 第 `index` 種候選位置（0 到 `CANDIDATES − 1`）的 6 個格子，由小到大。 */
function candidateBar(index: number): number[] {
  const cells: number[] = [];
  if (index < HORIZONTAL) {
    const x = index % (WIDTH - BAR_LEN + 1);
    const y = Math.floor(index / (WIDTH - BAR_LEN + 1));
    for (let i = 0; i < BAR_LEN; i += 1) {
      cells.push(cell(x + i, y));
    }
  } else {
    const j = index - HORIZONTAL;
    const x = j % WIDTH;
    const y = Math.floor(j / WIDTH);
    for (let i = 0; i < BAR_LEN; i += 1) {
      cells.push(cell(x, y + i));
    }
  }
  return cells;
}

function rotatedBar(bar: readonly number[]): number[] {
  return bar.map(rotateCell).sort((a, b) => a - b);
}

/** 除了 `blocked` 以外的格子是不是四連通（洪水填充）。 */
function stillConnected(blocked: Uint8Array): boolean {
  let open = 0;
  let start = -1;
  for (let c = 0; c < CELLS; c += 1) {
    if (blocked[c] === 0) {
      open += 1;
      if (start < 0) {
        start = c;
      }
    }
  }
  if (open === 0) {
    return true;
  }
  const seen = new Uint8Array(CELLS);
  const queue = new Int16Array(CELLS);
  let head = 0;
  let tail = 0;
  queue[tail] = start;
  tail += 1;
  seen[start] = 1;
  while (head < tail) {
    const current = queue[head] as number;
    head += 1;
    const x = cellX(current);
    const y = cellY(current);
    if (x > 0 && seen[current - 1] === 0 && blocked[current - 1] === 0) {
      seen[current - 1] = 1;
      queue[tail] = current - 1;
      tail += 1;
    }
    if (x < WIDTH - 1 && seen[current + 1] === 0 && blocked[current + 1] === 0) {
      seen[current + 1] = 1;
      queue[tail] = current + 1;
      tail += 1;
    }
    if (y > 0 && seen[current - WIDTH] === 0 && blocked[current - WIDTH] === 0) {
      seen[current - WIDTH] = 1;
      queue[tail] = current - WIDTH;
      tail += 1;
    }
    if (y < HEIGHT - 1 && seen[current + WIDTH] === 0 && blocked[current + WIDTH] === 0) {
      seen[current + WIDTH] = 1;
      queue[tail] = current + WIDTH;
      tail += 1;
    }
  }
  return tail === open;
}

interface PickResult {
  readonly bars: readonly [readonly number[], readonly number[]] | null;
  readonly rng: RngState;
}

/**
 * 為一對牆挑新位置：從所有候選位置裡均勻抽（`intFrom`），不合法就重抽，最多 `tries` 次
 * （等於從所有合法位置裡均勻挑）。合法：兩面牆（第一面和它的旋轉）6 個格子都在地圖裡、互不重疊、
 * 不壓到 `forbidden`（蛇、其他牆、自己現在的位置……）、落下之後剩下的空格四連通。
 * `others` 是落下之後仍然在場上的其他牆格（另一對）。
 */
function pickBars(
  rng: RngState,
  tries: number,
  forbidden: Uint8Array,
  others: readonly number[],
): PickResult {
  let state = rng;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const [pick, following] = intFrom(state, CANDIDATES);
    state = following;
    const first = candidateBar(pick);
    const second = rotatedBar(first);
    let ok = true;
    for (const c of first) {
      if (forbidden[c] === 1 || second.includes(c)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (const c of second) {
        if (forbidden[c] === 1) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) {
      continue;
    }
    const blocked = new Uint8Array(CELLS);
    for (const c of others) {
      blocked[c] = 1;
    }
    for (const c of first) {
      blocked[c] = 1;
    }
    for (const c of second) {
      blocked[c] = 1;
    }
    if (stillConnected(blocked)) {
      return { bars: [first, second], rng: state };
    }
  }
  return { bars: null, rng: state };
}

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

/** 開局的 4 面牆：牆 0（隨機）與它的旋轉、牆 2（隨機）與它的旋轉；不壓蛇、食物，也不貼著起點。 */
function initialBars(seed: number, base: ClubsState): readonly (readonly number[])[] {
  const forbidden = new Uint8Array(CELLS);
  for (const snake of base.snakes) {
    for (const c of snake.body) {
      forbidden[c] = 1;
    }
  }
  for (const c of base.foods) {
    forbidden[c] = 1;
  }
  const heads = [base.snakes[0].body[0] as number, base.snakes[1].body[0] as number];
  for (let c = 0; c < CELLS; c += 1) {
    if (
      manhattan(c, heads[0] as number) < START_CLEARANCE ||
      manhattan(c, heads[1] as number) < START_CLEARANCE
    ) {
      forbidden[c] = 1;
    }
  }
  let rng = rngStateFor(seed, 'walls');
  const first = pickBars(rng, INIT_TRIES, forbidden, []);
  rng = first.rng;
  if (first.bars === null) {
    return [[], [], [], []];
  }
  const taken = new Uint8Array(forbidden);
  for (const c of [...first.bars[0], ...first.bars[1]]) {
    taken[c] = 1;
  }
  const second = pickBars(rng, INIT_TRIES, taken, [...first.bars[0], ...first.bars[1]]);
  if (second.bars === null) {
    return [first.bars[0], first.bars[1], [], []];
  }
  return [first.bars[0], first.bars[1], second.bars[0], second.bars[1]];
}

// ---------------------------------------------------------------------------
// 誘餌
// ---------------------------------------------------------------------------

/** 落點格子裡兩個蛇頭距離之差最小的一格（同值取格子編號小的），不選已經有普通食物的格子。 */
function baitCell(
  landingCells: readonly number[],
  snakes: readonly [Snake, Snake],
  foods: readonly number[],
): number | null {
  const h0 = snakes[0].body[0] as number;
  const h1 = snakes[1].body[0] as number;
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const c of [...landingCells].sort((a, b) => a - b)) {
    if (foods.includes(c)) {
      continue;
    }
    const gap = Math.abs(manhattan(c, h0) - manhattan(c, h1));
    if (gap < bestGap) {
      bestGap = gap;
      best = c;
    }
  }
  return best < 0 ? null : best;
}

// ---------------------------------------------------------------------------
// 一個 tick
// ---------------------------------------------------------------------------

function crushed(snake: Snake, cells: ReadonlySet<number>): boolean {
  return snake.body.some((c) => cells.has(c));
}

function stepWith(options: Required<C5Options>, state: C5State, inputs: Inputs): C5State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let snakes: readonly [Snake, Snake] = [
    steerSnake(state.snakes[0], inputs[0]),
    steerSnake(state.snakes[1], inputs[1]),
  ];
  let foods = state.foods;
  let rng = state.rng;
  let bars = state.bars;
  let landing = state.landing;
  let bait = state.bait;
  let tally = state.crushed;
  let died = false;
  let moved = false;

  if (tick % MOVE_EVERY === 0) {
    moved = true;
    const wallCells = new Set<number>(bars.flat());
    const extended = bait === null ? foods : [...foods, bait.cell];
    const result = moveSnakes(snakes, extended);
    const dead: [boolean, boolean] = [result.dead[0], result.dead[1]];
    const next: [Snake, Snake] = [result.snakes[0], result.snakes[1]];
    for (const i of [0, 1] as const) {
      if (!dead[i] && wallCells.has(next[i].body[0] as number)) {
        // 蛇頭走進牆格：跟撞牆一樣，死在原地。
        dead[i] = true;
        next[i] = { ...snakes[i], alive: false };
      }
    }
    const baitIndex = foods.length;
    const ate: [number, number] = [dead[0] ? -1 : result.ate[0], dead[1] ? -1 : result.ate[1]];
    let baitEaten = false;
    for (const i of [0, 1] as const) {
      if (ate[i] < 0) {
        continue;
      }
      if (ate[i] === baitIndex && bait !== null) {
        baitEaten = true;
        const grown = next[i];
        const tail = grown.body[grown.body.length - 1] as number;
        next[i] = {
          ...grown,
          body: [...grown.body, ...Array.from({ length: BAIT_GROW - 1 }, () => tail)],
          score: grown.score + BAIT_POINTS,
        };
      } else {
        next[i] = { ...next[i], score: next[i].score + 1 };
      }
    }
    snakes = next;
    foods = foods.filter((_food, index) => index !== ate[0] && index !== ate[1]);
    if (baitEaten) {
      bait = null;
    }
    died = dead[0] || dead[1];
  }

  // 落下：先走格、再落牆。
  if (landing !== null && landing.at === tick) {
    const fallen = new Set<number>(landing.bars.flat());
    const nextBars = bars.map((bar) => bar);
    nextBars[landing.pair * 2] = landing.bars[0] as readonly number[];
    nextBars[landing.pair * 2 + 1] = landing.bars[1] as readonly number[];
    bars = nextBars;
    if (options.crush) {
      const flat: [Snake, Snake] = [snakes[0], snakes[1]];
      const counts: [number, number] = [tally[0], tally[1]];
      for (const i of [0, 1] as const) {
        if (flat[i].alive && crushed(flat[i], fallen)) {
          flat[i] = { ...flat[i], alive: false };
          counts[i] += 1;
          died = true;
        }
      }
      snakes = flat;
      tally = counts;
    }
    foods = foods.filter((food) => !fallen.has(food));
    landing = null;
    bait = null;
    moved = true;
  }

  let over = false;
  let winner: Side | null = null;
  if (died) {
    over = true;
    const deadBoth = !snakes[0].alive && !snakes[1].alive;
    winner = deadBoth ? winnerByScore(snakes) : !snakes[0].alive ? 1 : 0;
  } else {
    if (moved) {
      // 補食物：不能補在牆上，也不能補在誘餌上（用假的蛇身把這些格子標成「被佔用」）。
      const blockedBody = [...bars.flat(), ...(bait === null ? [] : [bait.cell])];
      const filled = refillFoods(
        rng,
        [{ ...snakes[0], body: [...snakes[0].body, ...blockedBody] }, snakes[1]],
        foods,
        FOOD_COUNT,
      );
      foods = filled.foods;
      rng = filled.rng;
    }
    // 預告：這一刻起，tick + 60 有一對牆要落下。
    const at = tick + PREVIEW_TICKS;
    if (landing === null && at < state.maxTicks && at >= PAIR_PERIOD && at % PAIR_OFFSET === 0) {
      const pair = (Math.floor(at / PAIR_OFFSET) % 2) as 0 | 1;
      const forbidden = new Uint8Array(CELLS);
      for (const snake of snakes) {
        for (const c of snake.body) {
          forbidden[c] = 1;
        }
      }
      const rest: number[] = [];
      bars.forEach((bar, index) => {
        if (Math.floor(index / 2) !== pair) {
          rest.push(...bar);
        }
        for (const c of bar) {
          forbidden[c] = 1;
        }
      });
      const picked = pickBars(rng, options.landingTries, forbidden, rest);
      rng = picked.rng;
      if (picked.bars !== null) {
        landing = { pair, bars: picked.bars, at };
        if (options.bait) {
          const c = baitCell([...picked.bars[0], ...picked.bars[1]], snakes, foods);
          bait = c === null ? null : { cell: c, until: at };
        }
      }
    }
  }

  if (!over && tick >= state.maxTicks) {
    over = true;
    winner = winnerByScore(snakes);
  }
  return { ...state, tick, snakes, foods, rng, over, winner, bars, landing, bait, crushed: tally };
}

// ---------------------------------------------------------------------------
// 評估
// ---------------------------------------------------------------------------

const DX: readonly number[] = [0, 1, 0, -1];
const DY: readonly number[] = [-1, 0, 1, 0];

/**
 * 壓死的 danger（這張牌的核心）：`margin = stepsLeft − clearSteps`，`danger = clamp(1 − margin / 3, 0, 1)`。
 * `clearSteps` 是整條蛇離開落點要走幾步：蛇頭還在落點裡是 `exitSteps + inZone − 1`
 * （頭先出去，身體再一格一格出來）；蛇頭已經在外面、只剩身體在裡面是 `inZone`。
 * 沒有任何一格在落點裡（`inZone = 0`）是 0。
 */
export function crushDanger(
  stepsLeft: number,
  exitSteps: number,
  inZone: number,
  headInZone: boolean,
  marginScale: number = CRUSH_MARGIN,
): number {
  if (inZone <= 0) {
    return 0;
  }
  const clearSteps = headInZone ? exitSteps + inZone - 1 : inZone;
  const margin = stepsLeft - clearSteps;
  return Math.min(1, Math.max(0, 1 - margin / marginScale));
}

const exitSeen = new Uint32Array(CELLS);
const exitQueue = new Int16Array(CELLS);
const exitDepth = new Uint8Array(CELLS);
let exitGeneration = 0;

/** 從 `from` 走到最近的「不在落點、也沒被擋住」的格子要幾步（最多 `BFS_CAP`；找不到是 `BFS_CAP`）。 */
function exitDistance(
  from: number,
  zone: ReadonlySet<number>,
  blocked: ReadonlySet<number>,
): number {
  exitGeneration += 1;
  let head = 0;
  let tail = 0;
  exitQueue[tail] = from;
  tail += 1;
  exitSeen[from] = exitGeneration;
  exitDepth[from] = 0;
  while (head < tail) {
    const current = exitQueue[head] as number;
    head += 1;
    const depth = exitDepth[current] as number;
    if (!zone.has(current)) {
      return depth;
    }
    if (depth >= BFS_CAP) {
      continue;
    }
    const x = cellX(current);
    const y = cellY(current);
    for (let d = 0; d < 4; d += 1) {
      const nx = x + (DX[d] as number);
      const ny = y + (DY[d] as number);
      if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) {
        continue;
      }
      const next = cell(nx, ny);
      if (exitSeen[next] !== exitGeneration && !blocked.has(next)) {
        exitSeen[next] = exitGeneration;
        exitDepth[next] = depth + 1;
        exitQueue[tail] = next;
        tail += 1;
      }
    }
  }
  return BFS_CAP;
}

/** `side` 下一步之後被牆壓死的 danger（0 到 1）；沒有預告、或下一步之後沒有身體在落點裡是 0。 */
function crushDangerOf(state: C5State, side: Side, marginScale: number): number {
  const landing = state.landing;
  const me = state.snakes[side];
  if (landing === null || !me.alive) {
    return 0;
  }
  const head = me.body[0] as number;
  const nx = cellX(head) + (DX[me.turn] as number);
  const ny = cellY(head) + (DY[me.turn] as number);
  if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) {
    return 0;
  }
  const next = cell(nx, ny);
  const zone = new Set<number>(landing.bars.flat());
  const grows = state.bait !== null && state.bait.cell === next;
  const newBody = [next, ...(grows ? me.body : me.body.slice(0, -1))];
  let firstInZone = -1;
  for (let i = 0; i < newBody.length; i += 1) {
    if (zone.has(newBody[i] as number)) {
      firstInZone = i;
      break;
    }
  }
  if (firstInZone < 0) {
    return 0;
  }
  const headInZone = zone.has(next);
  // 身體是一格接一格走過同一條路：落點整個清空要等到尾巴也走過去。
  // 頭在裡面：頭出去之後，整條身體（含吃誘餌長出來的）都還要走過這一段，所以算全長；
  // 頭在外面：從最靠近頭的那一格在落點裡的身體算到尾巴。
  const inZone = headInZone ? newBody.length : newBody.length - firstInZone;
  let exitSteps = 0;
  if (headInZone) {
    const blocked = new Set<number>(state.bars.flat());
    for (let i = 1; i < newBody.length; i += 1) {
      blocked.add(newBody[i] as number);
    }
    const other = state.snakes[side === 0 ? 1 : 0];
    for (let i = 0; i < other.body.length - 1; i += 1) {
      blocked.add(other.body[i] as number);
    }
    exitSteps = exitDistance(next, zone, blocked);
  }
  const stepsLeft = Math.max(0, Math.ceil((landing.at - state.tick) / MOVE_EVERY) - 1);
  return crushDanger(stepsLeft, exitSteps, inZone, headInZone, marginScale);
}

/**
 * 評估：把牆格併進對手的蛇身（尾巴還是最後一格），誘餌併進食物，交給 `evaluateClubs`
 * （牆算障礙：前方、兩側、困死的洪水填充都看得到；誘餌算食物），再和壓死的 danger 取最大。
 * `gain` 是 `evaluateClubs` 的 gain，沒有任何看分差以外的項目（沒有橡皮筋）。
 */
function evaluateWith(
  options: Required<C5Options>,
  state: C5State,
  side: Side,
): { gain: number; danger: number } {
  const other = state.snakes[side === 0 ? 1 : 0];
  const wall = state.bars.flat();
  const tailIndex = other.body.length - 1;
  const solid: Snake = {
    ...other,
    body:
      wall.length === 0 || tailIndex < 0
        ? other.body
        : [...other.body.slice(0, tailIndex), ...wall, other.body[tailIndex] as number],
  };
  const world: ClubsState = {
    tick: state.tick,
    maxTicks: state.maxTicks,
    snakes: side === 0 ? [state.snakes[0], solid] : [solid, state.snakes[1]],
    foods: state.bait === null ? state.foods : [...state.foods, state.bait.cell],
    rng: state.rng,
    over: state.over,
    winner: state.winner,
  };
  const base = evaluateClubs(world, side);
  if (!options.crush || state.over || base.danger >= 1) {
    return base;
  }
  return { gain: base.gain, danger: Math.max(base.danger, crushDangerOf(state, side, options.crushMargin)) };
}

function actionsWith(state: C5State, side: Side): readonly Buttons[] {
  // 誘餌算食物；落點與牆不影響排序（那是 `evaluate` 的事）。
  const foods = state.bait === null ? state.foods : [...state.foods, state.bait.cell];
  return orderedActions({ ...state, foods }, side);
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export function createC5Game(options: C5Options = {}): Game<C5State> {
  const resolved: Required<C5Options> = {
    crush: options.crush ?? true,
    bait: options.bait ?? true,
    landingTries: options.landingTries ?? LANDING_TRIES,
    crushMargin: options.crushMargin ?? CRUSH_MARGIN,
  };
  return {
    id: 'C-5',

    init(seed: number, config: GameConfig): C5State {
      if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks < MIN_MAX_TICKS) {
        throw new RangeError(
          `config.maxTicks 必須是不小於 ${MIN_MAX_TICKS} 的整數，收到 ${String(config.maxTicks)}`,
        );
      }
      const base = initClubsState(seed, config);
      return {
        ...base,
        bars: initialBars(seed, base),
        landing: null,
        bait: null,
        crushed: [0, 0],
      };
    },

    step(state: C5State, inputs: Inputs): C5State {
      return stepWith(resolved, state, inputs);
    },

    isOver(state: C5State): boolean {
      return state.over;
    },

    score(state: C5State): readonly [number, number] {
      return [state.snakes[0].score, state.snakes[1].score];
    },

    winner(state: C5State): Side | null {
      return state.over ? state.winner : null;
    },

    actions(state: C5State, side: Side): readonly Buttons[] {
      return actionsWith(state, side);
    },

    evaluate(state: C5State, side: Side): { gain: number; danger: number } {
      return evaluateWith(resolved, state, side);
    },
  };
}

export const c5Game: Game<C5State> = createC5Game();

// ---------------------------------------------------------------------------
// 測試輔助
// ---------------------------------------------------------------------------

export interface C5Overrides extends StateOverrides {
  readonly bars?: readonly (readonly number[])[];
  readonly landing?: Landing | null;
  readonly bait?: Bait | null;
  readonly crushed?: readonly [number, number];
}

/**
 * 直接構造一個局面。預設是 C-A 的起始局面（人 (5,12) 往右、AI (26,11) 往左、食物 (15,3) 與 (15,20)），
 * 四面牆都還沒放（四個空陣列）、沒有預告、沒有誘餌。
 */
export function makeState(overrides: C5Overrides = {}): C5State {
  return {
    ...makeClubsState(overrides),
    bars: overrides.bars ?? [[], [], [], []],
    landing: overrides.landing ?? null,
    bait: overrides.bait ?? null,
    crushed: overrides.crushed ?? [0, 0],
  };
}
