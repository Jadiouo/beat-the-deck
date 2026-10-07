import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  DOWN,
  HEIGHT,
  LEFT,
  MOVE_EVERY,
  RIGHT,
  UP,
  WIDTH,
  cell,
  cellX,
  cellY,
  orderedActions,
  steerSnake,
  winnerByScore,
} from '../_clubs/logic';
import type { ClubsState, Dir, Snake } from '../_clubs/logic';

/**
 * C-J 關卡設計師（SPEC 第 9 節；小規格 `docs/cards/C-J.md`）。
 *
 * 一邊控蛇、一邊（AI）當設計師，兩局交換、分數加總。蛇要在時限內吃到食物；設計師在食物的四個側面蓋牆
 * （有預告、有冷卻、永遠留一條路）。每一局 10 個食物：吃到算蛇的、時限到了算設計師的。
 * 格子、轉向、`steerSnake`、`orderedActions`、`winnerByScore` 用梅花共用的 `_clubs/logic.ts`；
 * 走格與碰撞自己寫（蛇只有一條，牆會出現與消失）。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 一局的食物數。 */
export const FOODS_PER_ROUND = 10;
/** 每一局開始前不動的 tick 數（第一個食物的預覽也從這裡開始算）。 */
export const GRACE_TICKS = 30;
/** 一局結束之後畫面停住的 tick 數。 */
export const PAUSE_TICKS = 60;
/** 食物預覽的 tick 數（等於牆的預告長度，所以預覽一開始就蓋的牆，現身時剛好變硬）。 */
export const PREVIEW_TICKS = 45;
/** 牆蓋下去之後幾個 tick 變硬。 */
export const RIPEN_TICKS = 45;
/** 蓋完一面牆之後幾個 tick 才能再蓋。 */
export const COOLDOWN_TICKS = 60;
/** 食物現身的時限：直線距離再多給這麼多格。 */
export const SLACK_MOVES = 6;
/** 牆離食物幾格（中心）。 */
export const WALL_DISTANCE = 2;
/** 牆的任何一格離蛇頭不到或等於這麼多格（曼哈頓）就不能蓋。 */
export const SAFE_RADIUS = 3;
/** 食物離上一個食物（第一個離蛇頭）至少幾格（曼哈頓）。 */
export const MIN_FOOD_GAP = 8;
/** 食物離地圖邊至少幾格。 */
export const FOOD_MARGIN = 3;
/** 蛇起始位置離牆至少幾格。 */
export const START_MARGIN = 5;
/** 蛇的起始長度。 */
export const START_LENGTH = 3;
/** 蛇的 gain：離食物每遠一步扣多少。 */
export const PATH_WEIGHT = 10;
/** 設計師的 gain：蛇的最短路每多一步加多少。 */
export const PRESSURE_WEIGHT = 10;
/** 蛇的最短路沒辦法在時限內走完時再扣的分。 */
export const LATE_PENALTY = 100;
/** 設計師的 gain：有用的預告牆每「早蓋 1 個 tick」加多少（只拿來打破平手，必須遠小於 `PRESSURE_WEIGHT`）。 */
export const HASTE_WEIGHT = 0.05;
/** 下一格就是現身中的食物時蛇的 gain。 */
export const EAT_GAIN = 1000;
/** 蛇下一格會死時的 gain（比任何最短路都低、但有限）。 */
export const DEATH_GAIN = -500;
/** 一局結束時，每多拿一個食物的 gain。 */
export const ROUND_FOOD_GAIN = 100;
/** 整場結束的 gain。 */
export const MATCH_BONUS = 10_000;
/** 走不到時的最短路步數。 */
export const UNREACHABLE = 99;
/** 蛇前方最多看幾格有沒有障礙（讓有反應延遲的 AI 提早轉彎）。 */
export const RUN_LOOKAHEAD = 10;
/** 地圖外框離得這麼近才算危險（食物離外框至少 3 格，太早怕外框會讓蛇不敢靠近食物）。 */
export const BORDER_LOOKAHEAD = 3;
/** 蛇撞死之後，重生要等幾個 tick（也是撞死之後下一個食物的預覽長度）。 */
export const RESPAWN_TICKS = 60;

export type RoundOutcome = 'finished' | 'timeout';
export type Phase = 'preview' | 'live';

/** 設計師蓋的一面牆。`ripe` 是還要幾個 tick 變硬；0 是已經硬了。 */
export interface Wall {
  readonly side: Dir;
  readonly cells: readonly number[];
  readonly ripe: number;
}

/** 第 0 局的蛇起始位置與食物序列；第 1 局把它們轉 180 度。 */
export interface Layout {
  readonly head: number;
  readonly dir: Dir;
  readonly foods: readonly number[];
}

export interface CJState extends ClubsState {
  readonly round: 0 | 1;
  /** 這一局誰是蛇（另一邊是設計師）。 */
  readonly snakeSide: Side;
  /** 這一局已經走了幾個 tick；開局不動的時間是負數，從 `-GRACE_TICKS` 數到 0。 */
  readonly roundTick: number;
  /** 一局最多幾個 tick。 */
  readonly roundTicks: number;
  /** 兩局之間停住的剩餘 tick 數。 */
  readonly pause: number;
  readonly pauseTicks: number;
  readonly layout: Layout;
  /** 這一局的食物序列（第 1 局已轉 180 度）。 */
  readonly foodSeq: readonly number[];
  /** 現在是第幾個食物（已經結算幾個）。 */
  readonly foodIndex: number;
  readonly phase: Phase;
  /** 預覽剩幾個 tick、或現身之後時限剩幾個 tick。 */
  readonly phaseLeft: number;
  readonly walls: readonly Wall[];
  /** 還要幾個 tick 設計師才能再蓋牆。 */
  readonly cooldown: number;
  /** 這一局蛇吃到幾個、設計師拿到幾個。 */
  readonly eaten: number;
  readonly lost: number;
  /** 這一局蛇撞死了幾次。 */
  readonly crashes: number;
  readonly outcome: RoundOutcome | null;
}

// ---------------------------------------------------------------------------
// 格子小工具
// ---------------------------------------------------------------------------

const DX: readonly number[] = [0, 1, 0, -1];
const DY: readonly number[] = [-1, 0, 1, 0];

function computeNeighbor(index: number, dir: number): number {
  const x = cellX(index) + (DX[dir] as number);
  const y = cellY(index) + (DY[dir] as number);
  return x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT ? -1 : cell(x, y);
}

/** 每一格往四個方向走一格是哪一格（走出地圖是 -1）；搜尋與評估很常用，所以預先算好。 */
const NEIGHBORS = new Int16Array(CELLS * 4).map((_zero, slot) =>
  computeNeighbor(Math.floor(slot / 4), slot % 4),
);

function neighbor(index: number, dir: Dir): number {
  return NEIGHBORS[index * 4 + dir] as number;
}

function opposite(dir: Dir): Dir {
  return ((dir + 2) % 4) as Dir;
}

function other(side: Side): Side {
  return side === 0 ? 1 : 0;
}

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

function rotate(index: number): number {
  return CELLS - 1 - index;
}

/** 這一局蛇的起始位置與方向（第 1 局是第 0 局轉 180 度）；撞死之後在這裡重生。 */
function spawnOf(state: CJState): { head: number; dir: Dir } {
  const turned = state.round === 1;
  return {
    head: turned ? rotate(state.layout.head) : state.layout.head,
    dir: turned ? opposite(state.layout.dir) : state.layout.dir,
  };
}

/** 蛇頭在哪裡；撞死等重生的時候用重生的位置（牆不能蓋在那裡附近）。 */
function headOf(state: CJState): number {
  const snake = state.snakes[state.snakeSide];
  return snake.alive ? (snake.body[0] as number) : spawnOf(state).head;
}

/** 現身時給的時限：直線距離 + `SLACK_MOVES` 格，每格 `MOVE_EVERY` 個 tick。 */
export function deadlineFor(head: number, food: number): number {
  return MOVE_EVERY * (manhattan(head, food) + SLACK_MOVES);
}

// ---------------------------------------------------------------------------
// 最短路（蛇的評估與設計師的評估共用）
// ---------------------------------------------------------------------------

const seenStamp = new Uint32Array(CELLS);
const distance = new Int16Array(CELLS);
const wallStamp = new Uint32Array(CELLS);
const wallRipe = new Int16Array(CELLS);
const bodyStamp = new Uint32Array(CELLS);
const bodyIndex = new Int16Array(CELLS);
const queue = new Int16Array(CELLS);
let generation = 0;

interface PathOptions {
  /** true：所有牆（含預告中的）都當成已經硬了；用來判斷「會不會把路封死」。 */
  readonly allHard?: boolean;
  /** 不算預告中的牆（只算已經硬的）。 */
  readonly ignorePending?: boolean;
  /** 多一面還沒存在的牆（判斷蓋下去之後會不會把路封死）。 */
  readonly extra?: readonly number[];
}

/** 把牆與蛇身蓋章到 `wallStamp`／`bodyStamp`，之後的廣度優先搜尋用。 */
function stamp(state: CJState, options: PathOptions): number {
  generation += 1;
  for (const wall of state.walls) {
    if (options.ignorePending === true && wall.ripe > 0) {
      continue;
    }
    for (const c of wall.cells) {
      wallStamp[c] = generation;
      wallRipe[c] = options.allHard === true ? 0 : wall.ripe;
    }
  }
  for (const c of options.extra ?? []) {
    wallStamp[c] = generation;
    wallRipe[c] = 0;
  }
  const snake = state.snakes[state.snakeSide];
  if (snake.alive) {
    for (let i = 0; i < snake.body.length; i += 1) {
      bodyStamp[snake.body[i] as number] = generation;
      bodyIndex[snake.body[i] as number] = i;
    }
  }
  return generation;
}

/**
 * 從 `start`（第 `startSteps` 步到達）走到 `target` 最少要幾步；走不到是 `UNREACHABLE`。
 * 障礙：硬牆；蛇身（尾巴那一格第 1 步就釋放，其餘依序釋放）；預告中的牆「蛇到達那一格時已經變硬」
 * （`ripe ≤ MOVE_EVERY × 步數`）才算障礙，來不及變硬的牆不影響最短路。
 */
function shortest(
  state: CJState,
  start: number,
  startSteps: number,
  target: number,
  options: PathOptions = {},
): number {
  return shortestStamped(
    stamp(state, options),
    state.snakes[state.snakeSide].body.length,
    start,
    startSteps,
    target,
  );
}

/** `shortest` 的本體：牆與蛇身已經用 `stamp` 蓋好章（同一個 state 要找好幾條路時只蓋一次）。 */
function shortestStamped(
  gen: number,
  length: number,
  start: number,
  startSteps: number,
  target: number,
): number {
  if (start === target) {
    return startSteps;
  }
  let head = 0;
  let tail = 0;
  queue[tail] = start;
  tail += 1;
  seenStamp[start] = gen;
  distance[start] = startSteps;
  while (head < tail) {
    const at = queue[head] as number;
    head += 1;
    const steps = (distance[at] as number) + 1;
    for (let d = 0; d < 4; d += 1) {
      const next = NEIGHBORS[at * 4 + d] as number;
      if (next === -1 || seenStamp[next] === gen) {
        continue;
      }
      if (wallStamp[next] === gen && (wallRipe[next] as number) <= steps * MOVE_EVERY) {
        continue;
      }
      if (bodyStamp[next] === gen && length - (bodyIndex[next] as number) > steps) {
        continue;
      }
      if (next === target) {
        return steps;
      }
      seenStamp[next] = gen;
      distance[next] = steps;
      queue[tail] = next;
      tail += 1;
    }
  }
  return UNREACHABLE;
}

/** 蛇頭到目前的食物（預覽中就是即將現身的那個）最少要幾步，牆與蛇身的時間都算進去。 */
export function pathMoves(state: CJState): number {
  return shortest(state, headOf(state), 0, targetOf(state));
}

function targetOf(state: CJState): number {
  return state.foodSeq[Math.min(state.foodIndex, state.foodSeq.length - 1)] as number;
}

// ---------------------------------------------------------------------------
// 牆
// ---------------------------------------------------------------------------

/** 目前食物的某一側的牆：中心離食物 `WALL_DISTANCE` 格、垂直方向 3 格寬；中心走出地圖是 null。 */
function wallGeometry(target: number, side: Dir): number[] | null {
  const cx = cellX(target) + WALL_DISTANCE * (DX[side] as number);
  const cy = cellY(target) + WALL_DISTANCE * (DY[side] as number);
  if (cx < 0 || cx >= WIDTH || cy < 0 || cy >= HEIGHT) {
    return null;
  }
  const horizontal = side === UP || side === DOWN;
  const cells: number[] = [];
  for (let k = -1; k <= 1; k += 1) {
    const x = cx + (horizontal ? k : 0);
    const y = cy + (horizontal ? 0 : k);
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
      cells.push(cell(x, y));
    }
  }
  return cells;
}

/** 現在在目前食物的這一側蓋得下去嗎（不看冷卻）？可以就回傳牆的格子，不行是 null。 */
function placeable(state: CJState, side: Dir): number[] | null {
  if (state.foodIndex >= state.foodSeq.length) {
    return null;
  }
  const target = targetOf(state);
  const cells = wallGeometry(target, side);
  if (cells === null || state.walls.some((wall) => wall.side === side)) {
    return null;
  }
  const snake = state.snakes[state.snakeSide];
  const head = headOf(state);
  for (const c of cells) {
    if (manhattan(c, head) <= SAFE_RADIUS || snake.body.includes(c)) {
      return null;
    }
  }
  // 永遠留一條路：蓋下去之後（牆當成全部都是硬的）蛇頭還走得到食物。
  // 只有兩面牆以上才可能封死（單獨一面牆擋不住四面八方），一面牆以下省掉搜尋。
  if (
    state.walls.length >= 2 &&
    shortest(state, head, 0, target, { allHard: true, extra: cells }) >= UNREACHABLE
  ) {
    return null;
  }
  return cells;
}

/** 現在蓋得下去的方向（不看冷卻）；畫面用它把不能蓋的方向變暗。 */
export function legalSides(state: CJState): readonly Dir[] {
  return frozen(state) ? [] : SIDES.filter((side) => placeable(state, side) !== null);
}

/** 設計師能不能出手：局進行中、沒有冷卻。 */
function canAct(state: CJState): boolean {
  return !frozen(state) && state.cooldown === 0;
}

const SIDES: readonly Dir[] = [UP, RIGHT, DOWN, LEFT];

/** 蛇現在「從哪一側靠近食物」：差比較多的那一軸。 */
function approachSide(state: CJState): Dir {
  const head = headOf(state);
  const target = targetOf(state);
  const dx = cellX(head) - cellX(target);
  const dy = cellY(head) - cellY(target);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx < 0 ? LEFT : RIGHT;
  }
  return dy < 0 ? UP : DOWN;
}

// ---------------------------------------------------------------------------
// 起始位置、食物序列與每一局的開頭
// ---------------------------------------------------------------------------

function snakeAt(head: number, dir: Dir, score: number): Snake {
  const body = [head];
  let at = head;
  for (let i = 1; i < START_LENGTH; i += 1) {
    at = neighbor(at, opposite(dir));
    body.push(at);
  }
  return { body, dir, turn: dir, alive: true, score };
}

function designerSnake(score: number): Snake {
  return { body: [], dir: UP, turn: UP, alive: true, score };
}

const FALLBACK_FOODS: readonly number[] = [
  cell(22, 12),
  cell(10, 4),
  cell(24, 18),
  cell(6, 16),
  cell(26, 6),
  cell(12, 20),
  cell(28, 14),
  cell(8, 6),
  cell(20, 20),
  cell(16, 8),
];

/** 從亂數狀態抽第 0 局的蛇起始位置與食物序列；新的亂數狀態要寫回 state。 */
function drawLayout(rng: RngState): { layout: Layout; rng: RngState } {
  let state = rng;
  const draw = (n: number): number => {
    const [value, next] = intFrom(state, n);
    state = next;
    return value;
  };
  const head = cell(
    START_MARGIN + draw(WIDTH - 2 * START_MARGIN),
    START_MARGIN + draw(HEIGHT - 2 * START_MARGIN),
  );
  const dir = draw(4) as Dir;
  const foods: number[] = [];
  let previous = head;
  for (let i = 0; i < FOODS_PER_ROUND; i += 1) {
    let picked = -1;
    for (let attempt = 0; attempt < 200 && picked === -1; attempt += 1) {
      const candidate = cell(
        FOOD_MARGIN + draw(WIDTH - 2 * FOOD_MARGIN),
        FOOD_MARGIN + draw(HEIGHT - 2 * FOOD_MARGIN),
      );
      if (manhattan(candidate, previous) >= MIN_FOOD_GAP) {
        picked = candidate;
      }
    }
    // 200 次都抽不到（機率可以忽略）：用固定的食物，仍然是合法的。
    const food = picked === -1 ? (FALLBACK_FOODS[i] as number) : picked;
    foods.push(food);
    previous = food;
  }
  return { layout: { head, dir, foods }, rng: state };
}

function budget(maxTicks: number): { roundTicks: number; pauseTicks: number } {
  const pauseTicks = Math.min(PAUSE_TICKS, Math.floor(maxTicks / 20));
  const roundTicks = Math.floor((maxTicks - pauseTicks - 2 * GRACE_TICKS) / 2);
  return { roundTicks, pauseTicks };
}

function startRound(state: CJState, round: 0 | 1): CJState {
  const turned = round === 1;
  const head = turned ? rotate(state.layout.head) : state.layout.head;
  const dir = turned ? opposite(state.layout.dir) : state.layout.dir;
  const foodSeq = turned ? state.layout.foods.map(rotate) : state.layout.foods;
  const snakeSide: Side = round === 0 ? 0 : 1;
  const designerSide = other(snakeSide);
  const snakes: [Snake, Snake] = [designerSnake(0), designerSnake(0)];
  snakes[snakeSide] = snakeAt(head, dir, state.snakes[snakeSide].score);
  snakes[designerSide] = designerSnake(state.snakes[designerSide].score);
  return {
    ...state,
    round,
    snakeSide,
    snakes,
    roundTick: -GRACE_TICKS,
    pause: 0,
    foodSeq,
    foodIndex: 0,
    phase: 'preview',
    phaseLeft: PREVIEW_TICKS,
    walls: [],
    cooldown: 0,
    eaten: 0,
    lost: 0,
    crashes: 0,
    outcome: null,
    foods: [],
  };
}

export function initCJState(seed: number, config: GameConfig): CJState {
  if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks < 200) {
    throw new RangeError(`config.maxTicks 必須是 200 以上的整數，收到 ${String(config.maxTicks)}`);
  }
  const drawn = drawLayout(rngStateFor(seed, 'layout'));
  const { roundTicks, pauseTicks } = budget(config.maxTicks);
  const blank: CJState = {
    tick: 0,
    maxTicks: config.maxTicks,
    snakes: [designerSnake(0), designerSnake(0)],
    foods: [],
    rng: drawn.rng,
    over: false,
    winner: null,
    round: 0,
    snakeSide: 0,
    roundTick: -GRACE_TICKS,
    roundTicks,
    pause: 0,
    pauseTicks,
    layout: drawn.layout,
    foodSeq: drawn.layout.foods,
    foodIndex: 0,
    phase: 'preview',
    phaseLeft: PREVIEW_TICKS,
    walls: [],
    cooldown: 0,
    eaten: 0,
    lost: 0,
    crashes: 0,
    outcome: null,
  };
  return startRound(blank, 0);
}

// ---------------------------------------------------------------------------
// 一個 tick
// ---------------------------------------------------------------------------

function pressedSide(buttons: Buttons): Dir | null {
  if (buttons.up) {
    return UP;
  }
  if (buttons.right) {
    return RIGHT;
  }
  if (buttons.down) {
    return DOWN;
  }
  if (buttons.left) {
    return LEFT;
  }
  return null;
}

/** 牆變硬的那一刻，蛇身壓著的格子不算牆。 */
function ripen(walls: readonly Wall[], body: readonly number[]): Wall[] {
  return walls.map((wall) => {
    if (wall.ripe === 0) {
      return wall;
    }
    const ripe = wall.ripe - 1;
    if (ripe > 0) {
      return { ...wall, ripe };
    }
    return { ...wall, ripe, cells: wall.cells.filter((c) => !body.includes(c)) };
  });
}

function isHard(walls: readonly Wall[], index: number): boolean {
  return walls.some((wall) => wall.ripe === 0 && wall.cells.includes(index));
}

function foodsOf(state: {
  phase: Phase;
  foodSeq: readonly number[];
  foodIndex: number;
  outcome: RoundOutcome | null;
}): readonly number[] {
  if (state.outcome !== null || state.phase !== 'live' || state.foodIndex >= state.foodSeq.length) {
    return [];
  }
  return [state.foodSeq[state.foodIndex] as number];
}

/**
 * 走一個 tick。順序：
 * 1. 兩局之間的停頓：只倒數，倒數完開始第二局。
 * 2. 冷卻減 1；牆的剩餘時間減 1（變硬的那一刻蛇身壓著的格子留洞）。
 * 3. 蛇那一邊的輸入鎖定轉向；設計師那一邊的輸入若沒有冷卻、而且蓋得下去，就蓋一面牆。
 * 4. 每 `MOVE_EVERY` 個 tick 蛇走一格：撞牆、撞硬牆、撞自己就死；走進現身中的食物就吃到。
 * 5. 結算：蛇死 → 這個食物算設計師的，蛇停在原地，`RESPAWN_TICKS` 個 tick 之後在起始位置重生（長度 3）；
 *    吃到 → 蛇 +1；否則計時，預覽到了現身（撞死的蛇這時重生）、現身的時限到了算設計師 +1。
 * 6. 10 個食物結算完是 `finished`；一局到了 `roundTicks` 還沒完是 `timeout`；第 1 局結束就是整場結束。
 */
export function stepCJ(state: CJState, inputs: Inputs): CJState {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;

  if (state.pause > 0) {
    const pause = state.pause - 1;
    return pause > 0 ? { ...state, tick, pause } : startRound({ ...state, tick }, 1);
  }

  const snakeSide = state.snakeSide;
  const designerSide = other(snakeSide);
  const roundTick = state.roundTick + 1;
  let snake = steerSnake(state.snakes[snakeSide], inputs[snakeSide]);
  let walls: readonly Wall[] = ripen(state.walls, snake.body);
  let cooldown = Math.max(0, state.cooldown - 1);

  // 設計師出手
  const working: CJState = { ...state, walls, cooldown, snakes: replaceSnake(state, snake) };
  if (cooldown === 0) {
    const side = pressedSide(inputs[designerSide]);
    const cells = side === null ? null : placeable(working, side);
    if (side !== null && cells !== null) {
      walls = [...walls, { side, cells, ripe: RIPEN_TICKS }];
      cooldown = COOLDOWN_TICKS;
    }
  }

  let phase = state.phase;
  let phaseLeft = state.phaseLeft;
  let foodIndex = state.foodIndex;
  let eaten = state.eaten;
  let lost = state.lost;
  let crashes = state.crashes;
  let designerScore = state.snakes[designerSide].score;
  let snakeScore = snake.score;
  let outcome: RoundOutcome | null = null;
  const target = targetOf(state);

  let crashed = false;
  let ate = false;
  if (snake.alive && roundTick > 0 && roundTick % MOVE_EVERY === 0) {
    const head = snake.body[0] as number;
    const next = neighbor(head, snake.turn);
    ate = next !== -1 && phase === 'live' && next === target;
    const body = snake.body;
    const blocked =
      next === -1 ||
      isHard(walls, next) ||
      (body.includes(next) && (ate || next !== body[body.length - 1]));
    if (blocked) {
      crashed = true;
      ate = false;
      snake = { ...snake, alive: false };
    } else {
      snake = {
        ...snake,
        body: ate ? [next, ...body] : [next, ...body.slice(0, -1)],
        dir: snake.turn,
      };
    }
  }

  if (crashed) {
    // 撞死：這個食物算設計師的，蛇停在原地等重生，下一個食物預覽（也就是重生的等待時間）。
    lost += 1;
    designerScore += 1;
    crashes += 1;
    foodIndex += 1;
    walls = [];
    phase = 'preview';
    phaseLeft = RESPAWN_TICKS;
    outcome = foodIndex >= FOODS_PER_ROUND ? 'finished' : null;
  } else if (ate) {
    eaten += 1;
    snakeScore += 1;
    foodIndex += 1;
    walls = [];
    phase = 'preview';
    phaseLeft = PREVIEW_TICKS;
    outcome = foodIndex >= FOODS_PER_ROUND ? 'finished' : null;
  } else {
    phaseLeft -= 1;
    if (phaseLeft <= 0) {
      if (phase === 'preview') {
        if (!snake.alive) {
          const spawn = spawnOf(state);
          snake = { ...snakeAt(spawn.head, spawn.dir, snake.score) };
        }
        phase = 'live';
        phaseLeft = deadlineFor(snake.body[0] as number, target);
      } else {
        lost += 1;
        designerScore += 1;
        foodIndex += 1;
        walls = [];
        phase = 'preview';
        phaseLeft = PREVIEW_TICKS;
        outcome = foodIndex >= FOODS_PER_ROUND ? 'finished' : null;
      }
    }
  }
  if (outcome === null && roundTick >= state.roundTicks) {
    outcome = 'timeout';
  }

  const snakes: [Snake, Snake] = [designerSnake(0), designerSnake(0)];
  snakes[snakeSide] = { ...snake, score: snakeScore };
  snakes[designerSide] = designerSnake(designerScore);
  const next: CJState = {
    ...state,
    tick,
    roundTick,
    snakes,
    walls,
    cooldown,
    phase,
    phaseLeft,
    foodIndex,
    eaten,
    lost,
    crashes,
    outcome,
    foods: [],
  };
  const withFoods = { ...next, foods: foodsOf(next) };

  if (outcome === null) {
    return tick >= state.maxTicks
      ? { ...withFoods, over: true, winner: winnerByScore(snakes) }
      : withFoods;
  }
  if (state.round === 1 || tick >= state.maxTicks) {
    return { ...withFoods, over: true, winner: winnerByScore(snakes) };
  }
  return { ...withFoods, pause: state.pauseTicks };
}

function replaceSnake(state: CJState, snake: Snake): readonly [Snake, Snake] {
  return state.snakeSide === 0 ? [snake, state.snakes[1]] : [state.snakes[0], snake];
}

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const NONE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});
const PRESS: readonly Buttons[] = [UP, RIGHT, DOWN, LEFT].map((dir) =>
  Object.freeze({
    ...NONE,
    up: dir === UP,
    right: dir === RIGHT,
    down: dir === DOWN,
    left: dir === LEFT,
  }),
);
const FROZEN_ACTIONS: readonly Buttons[] = Object.freeze([NONE]);

/** 一局結束、兩局之間的停頓、整場結束：畫面凍結，沒有動作可選。 */
function frozen(state: CJState): boolean {
  return state.over || state.pause > 0 || state.outcome !== null;
}

function snakeActions(state: CJState): readonly Buttons[] {
  const snake = state.snakes[state.snakeSide];
  if (!snake.alive || snake.turn !== snake.dir) {
    return FROZEN_ACTIONS;
  }
  const ordered = orderedActions({ ...state, foods: [targetOf(state)] }, state.snakeSide);
  return [ordered[0] as Buttons, ordered[1] as Buttons, NONE];
}

function designerActions(state: CJState): readonly Buttons[] {
  if (!canAct(state)) {
    return FROZEN_ACTIONS;
  }
  const first = approachSide(state);
  const sides = [first, ...SIDES.filter((side) => side !== first)];
  const legal = sides.filter((side) => placeable(state, side) !== null);
  return [NONE, ...legal.map((side) => PRESS[side] as Buttons)];
}

function evaluateEnded(state: CJState, side: Side): { gain: number; danger: number } {
  const crashedSnake = side === state.snakeSide && !state.snakes[side].alive;
  const danger = crashedSnake ? 1 : 0;
  if (state.over) {
    const bonus = state.winner === null ? 0 : state.winner === side ? MATCH_BONUS : -MATCH_BONUS;
    return { gain: bonus, danger };
  }
  const mine = side === state.snakeSide ? state.eaten : state.lost;
  const theirs = side === state.snakeSide ? state.lost : state.eaten;
  return { gain: ROUND_FOOD_GAIN * (mine - theirs), danger };
}

const roomStamp = new Uint32Array(CELLS);
let roomGeneration = 0;

/** 從 `start` 洪水填充，數到 `cap` 就停：硬牆與蛇身（除了尾巴）擋路。`gen` 是 `stamp` 蓋好的章。 */
function roomFrom(gen: number, length: number, start: number, cap: number): number {
  roomGeneration += 1;
  const room = roomGeneration;
  let head = 0;
  let tail = 0;
  queue[tail] = start;
  tail += 1;
  roomStamp[start] = room;
  let count = 0;
  while (head < tail && count < cap) {
    const at = queue[head] as number;
    head += 1;
    count += 1;
    for (let d = 0; d < 4; d += 1) {
      const next = NEIGHBORS[at * 4 + d] as number;
      if (
        next === -1 ||
        roomStamp[next] === room ||
        (wallStamp[next] === gen && wallRipe[next] === 0) ||
        (bodyStamp[next] === gen && (bodyIndex[next] as number) < length - 1)
      ) {
        continue;
      }
      roomStamp[next] = room;
      queue[tail] = next;
      tail += 1;
    }
  }
  return count;
}

function evaluateSnake(state: CJState, side: Side): { gain: number; danger: number } {
  const snake = state.snakes[side];
  if (!snake.alive) {
    return { gain: DEATH_GAIN, danger: 1 };
  }
  const body = snake.body;
  const length = body.length;
  const gen = stamp(state, {});
  const hard = (index: number): boolean => wallStamp[index] === gen && wallRipe[index] === 0;
  const head = body[0] as number;
  const next = neighbor(head, snake.turn);
  if (
    next === -1 ||
    hard(next) ||
    (bodyStamp[next] === gen && (bodyIndex[next] as number) < length - 1)
  ) {
    return { gain: DEATH_GAIN, danger: 1 };
  }
  const target = targetOf(state);
  if (state.phase === 'live' && next === target) {
    return { gain: EAT_GAIN, danger: 0 };
  }
  const steps = shortestStamped(gen, length, next, 1, target);
  let gain = steps >= UNREACHABLE ? -PATH_WEIGHT * UNREACHABLE : -PATH_WEIGHT * steps;
  if (state.phase === 'live' && steps * MOVE_EVERY > state.phaseLeft) {
    gain -= LATE_PENALTY;
  }
  // 前方走得到幾格：硬牆與蛇身擋住算 `RUN_LOOKAHEAD` 格；地圖外框只算 `BORDER_LOOKAHEAD` 格
  // （反應有延遲的 AI 看到的是舊的 state，只看下一格會來不及轉彎；但食物離外框不遠，外框看太遠會讓蛇不敢吃）。
  let run = 0;
  let at = next;
  let border = false;
  while (run < RUN_LOOKAHEAD) {
    const ahead = neighbor(at, snake.turn);
    if (ahead === -1) {
      border = true;
      break;
    }
    if (hard(ahead) || bodyStamp[ahead] === gen) {
      break;
    }
    at = ahead;
    run += 1;
  }
  const reach = border ? BORDER_LOOKAHEAD : RUN_LOOKAHEAD;
  let danger = run < reach ? 0.7 * (1 - run / reach) ** 2 : 0;
  const cap = length + 2;
  const room = roomFrom(gen, length, next, cap);
  if (room < cap) {
    danger = Math.max(danger, 0.9 * (1 - room / cap));
  }
  return { gain, danger };
}

function evaluateDesigner(state: CJState): { gain: number; danger: number } {
  const head = headOf(state);
  const target = targetOf(state);
  const steps = shortest(state, head, 0, target);
  const budgetMoves =
    state.phase === 'live'
      ? Math.ceil(state.phaseLeft / MOVE_EVERY)
      : manhattan(head, target) + SLACK_MOVES;
  const cap = budgetMoves + 2;
  let gain = PRESSURE_WEIGHT * Math.min(steps, cap);
  const late = steps * MOVE_EVERY < RIPEN_TICKS;
  let danger = late ? 0.8 : 0;
  const pending = state.walls.filter((wall) => wall.ripe > 0);
  if (pending.length > 0) {
    const without = shortest(state, head, 0, target, { ignorePending: true });
    if (steps === without) {
      // 預告中的牆沒有讓蛇的最短路變長：白蓋。
      danger = Math.max(danger, 0.6);
    } else {
      // 有用的牆越早蓋越好（比「再等一個 tick 才蓋」多一點點 gain，免得搜尋型永遠拖延）。
      const youngest = Math.max(...pending.map((wall) => RIPEN_TICKS - wall.ripe));
      gain += HASTE_WEIGHT * youngest;
    }
  }
  return { gain, danger };
}

export const cJGame: Game<CJState> = {
  id: 'C-J',

  init(seed: number, config: GameConfig): CJState {
    return initCJState(seed, config);
  },

  step(state: CJState, inputs: Inputs): CJState {
    return stepCJ(state, inputs);
  },

  isOver(state: CJState): boolean {
    return state.over;
  },

  /** 兩邊累積到目前為止的分數（只有 `isOver` 之後才是兩局的總分）。 */
  score(state: CJState): readonly [number, number] {
    return [state.snakes[0].score, state.snakes[1].score];
  },

  winner(state: CJState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: CJState, side: Side): readonly Buttons[] {
    if (frozen(state)) {
      return FROZEN_ACTIONS;
    }
    return side === state.snakeSide ? snakeActions(state) : designerActions(state);
  },

  evaluate(state: CJState, side: Side): { gain: number; danger: number } {
    if (frozen(state)) {
      return evaluateEnded(state, side);
    }
    return side === state.snakeSide ? evaluateSnake(state, side) : evaluateDesigner(state);
  },
};

// ---------------------------------------------------------------------------
// 測試輔助
// ---------------------------------------------------------------------------

export interface CJOverrides {
  readonly round?: 0 | 1;
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly roundTick?: number;
  readonly pause?: number;
  /** 蛇那一邊的蛇（`snakeSide` 由 `round` 決定）。 */
  readonly snake?: Partial<Snake>;
  /** 兩邊累積的分數。 */
  readonly scores?: readonly [number, number];
  readonly foodSeq?: readonly number[];
  readonly foodIndex?: number;
  readonly phase?: Phase;
  readonly phaseLeft?: number;
  readonly walls?: readonly Wall[];
  readonly cooldown?: number;
  readonly eaten?: number;
  readonly lost?: number;
  readonly crashes?: number;
  readonly outcome?: RoundOutcome | null;
  readonly over?: boolean;
  readonly winner?: Side | null;
}

/**
 * 直接構造一個局面。預設：第 0 局（0 號邊是蛇、1 號邊是設計師）、`roundTick` 0（開局不動已過）、
 * 蛇頭 (8,12) 往右、長度 3、第一個食物 (22,12) 現身（時限用公式）、沒有牆、冷卻 0、兩邊分數 0。
 * `round: 1` 時 1 號邊是蛇，蛇與食物序列仍用預設值（不轉）；要轉的局面用 `init` 走到第 1 局。
 */
export function makeState(overrides: CJOverrides = {}): CJState {
  const maxTicks = overrides.maxTicks ?? 3600;
  const { roundTicks, pauseTicks } = budget(maxTicks);
  const round = overrides.round ?? 0;
  const snakeSide: Side = round === 0 ? 0 : 1;
  const designerSide = other(snakeSide);
  const scores = overrides.scores ?? [0, 0];
  const foodSeq = overrides.foodSeq ?? FALLBACK_FOODS;
  const patch = overrides.snake ?? {};
  const base = snakeAt(cell(8, 12), RIGHT, scores[snakeSide] as number);
  const merged = { ...base, ...patch };
  const snake: Snake = { ...merged, turn: patch.turn ?? merged.dir };
  const snakes: [Snake, Snake] = [designerSnake(0), designerSnake(0)];
  snakes[snakeSide] = snake;
  snakes[designerSide] = designerSnake(scores[designerSide] as number);
  const foodIndex = overrides.foodIndex ?? 0;
  const phase = overrides.phase ?? 'live';
  const target = foodSeq[Math.min(foodIndex, foodSeq.length - 1)] as number;
  const draft: CJState = {
    tick: overrides.tick ?? 0,
    maxTicks,
    snakes,
    foods: [],
    rng: rngStateFor(0, 'layout'),
    over: overrides.over ?? false,
    winner: overrides.winner ?? null,
    round,
    snakeSide,
    roundTick: overrides.roundTick ?? 0,
    roundTicks,
    pause: overrides.pause ?? 0,
    pauseTicks,
    layout: { head: cell(8, 12), dir: RIGHT, foods: foodSeq },
    foodSeq,
    foodIndex,
    phase,
    phaseLeft:
      overrides.phaseLeft ??
      (phase === 'live' ? deadlineFor(snake.body[0] as number, target) : PREVIEW_TICKS),
    walls: overrides.walls ?? [],
    cooldown: overrides.cooldown ?? 0,
    eaten: overrides.eaten ?? 0,
    lost: overrides.lost ?? 0,
    crashes: overrides.crashes ?? 0,
    outcome: overrides.outcome ?? null,
  };
  return { ...draft, foods: foodsOf(draft) };
}
