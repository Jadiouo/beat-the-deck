import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Side } from '../../core/types';

/**
 * 方塊三張牌（D-A、D-2、D-3）共用的格子世界邏輯：地圖與牆（含連通性檢查）、走格、補東西、
 * 給 AI 的距離計算。全部是純的：亂數只用 `RngState`（`intFrom`），沒有時鐘。
 *
 * 規則的出處是 SPEC 第 10 節「方塊共同設定」；SPEC 沒寫到的細節寫在 `docs/cards/D-A.md` 的「我做的決定」。
 */

// ---------------------------------------------------------------------------
// 格子與方向
// ---------------------------------------------------------------------------

export const WIDTH = 32;
export const HEIGHT = 24;
export const CELLS = WIDTH * HEIGHT;
/** 每格的像素大小。 */
export const CELL_SIZE = 10;
/** 每幾個 tick 可以走一格。 */
export const MOVE_EVERY = 5;
/** 一組牆有幾道。 */
export const WALL_COUNT = 20;
export const WALL_MIN_LENGTH = 2;
export const WALL_MAX_LENGTH = 5;
/** 牆的組數上限：試過這麼多組都不連通，就退回沒有牆（`init` 不可以有不會結束的迴圈）。 */
export const MAX_WALL_SETS = 64;
/** 放一道牆最多重挑幾次。 */
const MAX_PLACE_TRIES = 20;

/** 方向：0 上、1 右、2 下、3 左。 */
export type Dir = 0 | 1 | 2 | 3;
export const UP: Dir = 0;
export const RIGHT: Dir = 1;
export const DOWN: Dir = 2;
export const LEFT: Dir = 3;
/** 沒有待走方向。 */
export const NO_DIR = -1;
export type Pending = -1 | Dir;

const DX: readonly number[] = [0, 1, 0, -1];
const DY: readonly number[] = [-1, 0, 1, 0];

/** 格子編號：`y × 32 + x`。 */
export function cell(x: number, y: number): number {
  return y * WIDTH + x;
}
export function cellX(index: number): number {
  return index % WIDTH;
}
export function cellY(index: number): number {
  return Math.floor(index / WIDTH);
}

/** 人在左下角、AI 在右上角（兩個起點是 180 度旋轉對稱的）。 */
export const START_CELLS: readonly [number, number] = [cell(0, HEIGHT - 1), cell(WIDTH - 1, 0)];

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface Walker {
  /** 所在的格子編號。 */
  readonly cell: number;
  /** 這個週期裡「下一次走格要走的方向」；沒有是 -1。 */
  readonly pending: Pending;
  readonly score: number;
}

export interface DiamondsBase {
  /** 已經 step 的次數。 */
  readonly tick: number;
  readonly maxTicks: number;
  /** 長度 `CELLS` 的 0／1 陣列，1 是牆。 */
  readonly walls: readonly number[];
  /** 0 號是人（左下），1 號是 AI（右上）。 */
  readonly players: readonly [Walker, Walker];
  /** 補東西用的亂數狀態。每挑一次就要把新的狀態寫回來。 */
  readonly rng: RngState;
  readonly over: boolean;
  /** 只有 `over` 之後有意義；平手是 null。 */
  readonly winner: Side | null;
}

// ---------------------------------------------------------------------------
// 牆
// ---------------------------------------------------------------------------

export interface WallResult {
  /** 長度 `CELLS` 的 0／1 陣列。 */
  readonly walls: readonly number[];
  /** 試了幾組（1 表示第一組就連通）。 */
  readonly attempts: number;
  /** 試滿 `MAX_WALL_SETS` 組都不連通，退回了沒有牆。 */
  readonly fallback: boolean;
}

/** 所有非牆的格子是不是連成一塊（洪水填充）。 */
export function openCellsConnected(walls: readonly number[]): boolean {
  let first = -1;
  let open = 0;
  for (let i = 0; i < CELLS; i += 1) {
    if (walls[i] === 0) {
      open += 1;
      if (first < 0) {
        first = i;
      }
    }
  }
  if (open === 0) {
    return true;
  }
  const seen = new Uint8Array(CELLS);
  const stack = [first];
  seen[first] = 1;
  let reached = 0;
  while (stack.length > 0) {
    const current = stack.pop() as number;
    reached += 1;
    for (let d = 0; d < 4; d += 1) {
      const next = neighborCell(current, d as Dir);
      if (next >= 0 && walls[next] === 0 && seen[next] === 0) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return reached === open;
}

/** 往某個方向的鄰格編號；出了格子是 -1（不看牆）。 */
function neighborCell(from: number, dir: Dir): number {
  const x = cellX(from) + (DX[dir] as number);
  const y = cellY(from) + (DY[dir] as number);
  return x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT ? -1 : cell(x, y);
}

/** 放一組牆：20 道，每道長度 2 到 5、橫或直，不重疊、不蓋到起點。回傳 0／1 陣列與新的亂數狀態。 */
function placeWallSet(rng: RngState): { mask: number[]; rng: RngState } {
  const mask = new Array<number>(CELLS).fill(0);
  let state = rng;
  for (let i = 0; i < WALL_COUNT; i += 1) {
    for (let attempt = 0; attempt < MAX_PLACE_TRIES; attempt += 1) {
      let length: number;
      let horizontal: number;
      let x: number;
      let y: number;
      [length, state] = intFrom(state, WALL_MAX_LENGTH - WALL_MIN_LENGTH + 1);
      length += WALL_MIN_LENGTH;
      [horizontal, state] = intFrom(state, 2);
      [x, state] = intFrom(state, horizontal === 1 ? WIDTH - length + 1 : WIDTH);
      [y, state] = intFrom(state, horizontal === 1 ? HEIGHT : HEIGHT - length + 1);
      const cells: number[] = [];
      for (let k = 0; k < length; k += 1) {
        cells.push(horizontal === 1 ? cell(x + k, y) : cell(x, y + k));
      }
      const blocked = cells.some(
        (c) => mask[c] === 1 || c === START_CELLS[0] || c === START_CELLS[1],
      );
      if (!blocked) {
        for (const c of cells) {
          mask[c] = 1;
        }
        break;
      }
    }
  }
  return { mask, rng: state };
}

/**
 * 這個種子的牆：用 `'walls'` 這條亂數一組一組放，所有空格連通才算數；
 * 最多 `MAX_WALL_SETS` 組，都不連通就退回沒有牆（`fallback`）。同一個種子永遠同一組牆。
 */
export function generateWalls(seed: number): WallResult {
  let rng = rngStateFor(seed, 'walls');
  for (let attempts = 1; attempts <= MAX_WALL_SETS; attempts += 1) {
    const placed = placeWallSet(rng);
    rng = placed.rng;
    if (openCellsConnected(placed.mask)) {
      return { walls: placed.mask, attempts, fallback: false };
    }
  }
  return { walls: new Array<number>(CELLS).fill(0), attempts: MAX_WALL_SETS, fallback: true };
}

// ---------------------------------------------------------------------------
// 按鍵與走格
// ---------------------------------------------------------------------------

const NONE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});

function press(dir: Dir): Buttons {
  return Object.freeze({
    ...NONE,
    up: dir === UP,
    right: dir === RIGHT,
    down: dir === DOWN,
    left: dir === LEFT,
  });
}

/** 0 號邊的預設順序：上、右、下、左；1 號邊轉 180 度（下、左、上、右），與兩個起點對稱。 */
const DIRS_FIRST: readonly Dir[] = [UP, RIGHT, DOWN, LEFT];
const DIRS_SECOND: readonly Dir[] = [DOWN, LEFT, UP, RIGHT];

/**
 * 這個角色可以選的五個動作（四個方向與全放開），依 state 排序：
 * 往 `focus`（這張牌認為這個角色現在該去的格子）靠近得越多的方向排越前面，全放開**永遠排最後**。
 *
 * 為什麼要排：搜尋型往前看好幾步，終點一樣的路徑平手時取排最前面的動作。「現在按」與「晚一點才按」、
 * 「先往別的方向再轉過來」的終點常常完全一樣，而搜尋型每次決定要連續按好幾個 tick——
 * 全放開排前面它就永遠選「再等一下」而不動，方向排錯它就往錯的方向走。把最靠近目標的方向排前面，
 * 平手時就會選對（跟梅花 C-A 的作法一樣，見 `docs/cards/C-A.md` 第 12 條）。
 * 沒有目標（或已經站在目標上）時用預設順序。這只影響平手，不影響 `evaluate`。
 */
export function actionsToward(
  walls: readonly number[],
  me: Walker,
  side: Side,
  focus: number | null,
): readonly Buttons[] {
  const dirs = side === 0 ? DIRS_FIRST : DIRS_SECOND;
  if (focus === null || focus === me.cell) {
    return [...dirs.map(press), NONE];
  }
  const field = bfsDistances(walls, focus);
  const here = field[me.cell] as number;
  const scored = dirs.map((dir, order) => {
    const next = stepTarget(walls, me.cell, dir);
    // 走不動（牆或出界）等於原地不動：比靠近差，比遠離好。
    return { dir, order, score: next === me.cell ? here + 0.5 : (field[next] as number) };
  });
  scored.sort((x, y) => x.score - y.score || x.order - y.order);
  return [...scored.map((entry) => press(entry.dir)), NONE];
}

/** 這組按鍵按的方向：同時按多個就依「上、右、下、左」取第一個；沒按是 -1。 */
export function pressedDir(buttons: Buttons): Pending {
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
  return NO_DIR;
}

/** 往某個方向走一格；牆或出界就留在原地。 */
export function stepTarget(walls: readonly number[], from: number, dir: Dir): number {
  const next = neighborCell(from, dir);
  return next >= 0 && walls[next] === 0 ? next : from;
}

/** 「下一次走格會在哪」：已鎖定方向就走一格（走不動就是原地），沒有就是原地。 */
export function nextCell(walls: readonly number[], walker: Walker): number {
  return walker.pending < 0 ? walker.cell : stepTarget(walls, walker.cell, walker.pending as Dir);
}

/** 每個 tick：按了方向，待走方向就變成它（最後按的算）。 */
export function steerWalker(walker: Walker, buttons: Buttons): Walker {
  const pressed = pressedDir(buttons);
  return pressed < 0 ? walker : { ...walker, pending: pressed };
}

/** 走格的那個 tick：兩個角色同時走（待走方向歸零）。 */
export function moveWalker(walls: readonly number[], walker: Walker): Walker {
  return { ...walker, cell: nextCell(walls, walker), pending: NO_DIR };
}

/** 贏家：分數高的；同分平手。 */
export function winnerByScore(players: readonly [Walker, Walker]): Side | null {
  if (players[0].score === players[1].score) {
    return null;
  }
  return players[0].score > players[1].score ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 補東西
// ---------------------------------------------------------------------------

/**
 * 從空格裡均勻挑 `n` 個不同的格子（逐個挑，每挑一個就把新的亂數狀態接下去）。
 * 空格：不是牆、不在 `taken` 裡。沒有空格就少挑。
 */
export function pickEmptyCells(
  rng: RngState,
  walls: readonly number[],
  taken: readonly number[],
  n: number,
): { cells: number[]; rng: RngState } {
  const blocked = new Uint8Array(CELLS);
  for (const c of taken) {
    blocked[c] = 1;
  }
  const cells: number[] = [];
  let state = rng;
  for (let i = 0; i < n; i += 1) {
    const empties: number[] = [];
    for (let c = 0; c < CELLS; c += 1) {
      if (walls[c] === 0 && blocked[c] === 0) {
        empties.push(c);
      }
    }
    if (empties.length === 0) {
      break;
    }
    let k: number;
    [k, state] = intFrom(state, empties.length);
    const chosen = empties[k] as number;
    cells.push(chosen);
    blocked[chosen] = 1;
  }
  return { cells, rng: state };
}

// ---------------------------------------------------------------------------
// makeState（測試用）
// ---------------------------------------------------------------------------

export interface BaseOverrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  /** 牆的格子編號清單（state 裡的 `walls` 是 0／1 陣列）。 */
  readonly walls?: readonly number[];
  readonly players?: readonly [Partial<Walker>, Partial<Walker>];
  readonly rng?: RngState;
  readonly over?: boolean;
  readonly winner?: Side | null;
}

/** 預設局面（沒有牆、兩人在起點）加上 overrides。每張牌的 `makeState` 在它上面加自己的欄位。 */
export function makeBase(overrides: BaseOverrides = {}): DiamondsBase {
  const walls = new Array<number>(CELLS).fill(0);
  for (const c of overrides.walls ?? []) {
    walls[c] = 1;
  }
  const walker = (side: Side): Walker => ({
    cell: START_CELLS[side],
    pending: NO_DIR,
    score: 0,
    ...overrides.players?.[side],
  });
  return {
    tick: overrides.tick ?? 0,
    maxTicks: overrides.maxTicks ?? 3600,
    walls,
    players: [walker(0), walker(1)],
    rng: overrides.rng ?? rngStateFor(0, 'coins'),
    over: overrides.over ?? false,
    winner: overrides.winner ?? null,
  };
}

// ---------------------------------------------------------------------------
// 給 AI 的距離
// ---------------------------------------------------------------------------

/** 到不了（不會發生：所有空格連通；牆都被圍住的測試局面才可能）。 */
export const UNREACHABLE = 9999;
/** 每 1 分的 `gain`。比任何距離都大，所以得分永遠比靠近重要。 */
export const GAIN_PER_POINT = 100;
/** 結束的局：勝負加成。方塊的分差沒有上限，所以取一個比任何分差都大的數。 */
export const WIN_BONUS = 1_000_000;

/**
 * 距離場的快取：同一張牆（陣列物件）、同一個出發格，結果永遠一樣，搜尋型一次決定會問上百次。
 * 以牆陣列為鑰匙（WeakMap），牆不再被用到時整份一起被回收；回傳的陣列是共用的，呼叫端只能讀。
 */
const DISTANCE_CACHE = new WeakMap<readonly number[], Map<number, Int32Array>>();

/** 從 `from` 出發，繞過牆走到每一格的最短步數（廣度優先）；到不了的是 `UNREACHABLE`。只讀，不要改它。 */
export function bfsDistances(walls: readonly number[], from: number): Int32Array {
  let byCell = DISTANCE_CACHE.get(walls);
  if (byCell === undefined) {
    byCell = new Map<number, Int32Array>();
    DISTANCE_CACHE.set(walls, byCell);
  }
  const cached = byCell.get(from);
  if (cached !== undefined) {
    return cached;
  }
  const dist = new Int32Array(CELLS).fill(UNREACHABLE);
  const queue = new Int32Array(CELLS);
  let head = 0;
  let tail = 0;
  dist[from] = 0;
  queue[tail] = from;
  tail += 1;
  while (head < tail) {
    const current = queue[head] as number;
    head += 1;
    for (let d = 0; d < 4; d += 1) {
      const next = neighborCell(current, d as Dir);
      if (next >= 0 && walls[next] === 0 && dist[next] === UNREACHABLE) {
        dist[next] = (dist[current] as number) + 1;
        queue[tail] = next;
        tail += 1;
      }
    }
  }
  byCell.set(from, dist);
  return dist;
}

export interface Fields {
  /** 我下一步會在哪、對手下一步會在哪。 */
  readonly myNext: number;
  readonly oppNext: number;
  /** 從那兩格出發到每一格的最短步數。 */
  readonly mine: Int32Array;
  readonly theirs: Int32Array;
}

/** 算「我」與「對手」各自從下一步的格子出發的距離場。 */
export function distanceFields(walls: readonly number[], me: Walker, opponent: Walker): Fields {
  const myNext = nextCell(walls, me);
  const oppNext = nextCell(walls, opponent);
  return {
    myNext,
    oppNext,
    mine: bfsDistances(walls, myNext),
    theirs: bfsDistances(walls, oppNext),
  };
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 「被對手搶先」的 danger：對手到那個目標比我近就偏高（0.5 是一樣近，每差 1 步差 0.05）。 */
export function contestDanger(myDistance: number, theirDistance: number): number {
  return clamp01(0.5 + (myDistance - theirDistance) / 20);
}
