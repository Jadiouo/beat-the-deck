import { rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  DEATH_GAIN_PENALTY,
  FOOD_GRADIENT,
  GAIN_PER_POINT,
  RUN_DANGER,
  RUN_EXPONENT,
  RUN_LOOKAHEAD,
  SIDE_PENALTY,
  SIDE_PENALTY_FOOD_RANGE,
  HEIGHT,
  LEFT,
  MOVE_EVERY,
  RIGHT,
  WIDTH,
  cell,
  cellX,
  cellY,
  evaluateClubs,
  orderedActions,
  refillFoods,
  startSnakes,
  steerSnake,
  winnerByScore,
} from '../_clubs/logic';
import type { ClubsState, Dir, Snake } from '../_clubs/logic';

/**
 * C-6 傳送門（小規格 `docs/cards/C-6.md`）。
 * 規則：中間一道牆、兩對傳送門；蛇頭踩進門口要在原地「傳送中」30 tick、出口先亮，再從配對的門口冒出來；
 * 身體會穿過去，所以門口會被堵；出口被佔用就死。格子、轉向、食物沿用 `_clubs/logic.ts`（不改它），走格自己寫在這裡。
 * 完整資訊：`evaluate`、`actions` 與人看到的一樣。
 */

// ---------------------------------------------------------------------------
// 常數與固定地圖
// ---------------------------------------------------------------------------

/** 傳送要花幾個 tick（5 次走格）。 */
export const TRANSIT_TICKS = 30;
/** 傳送占幾次走格。 */
export const TRANSIT_MOVES = TRANSIT_TICKS / MOVE_EVERY;
export const PORTAL_PAIRS = 2;
/** 中間牆的兩欄、上下界（含）。 */
export const WALL_COLUMNS: readonly number[] = [15, 16];
export const WALL_TOP = 2;
export const WALL_BOTTOM = 21;
/** 距離場上限（走不到也是這個值）。 */
export const FAR = 99;

const DX: readonly number[] = [0, 1, 0, -1];
const DY: readonly number[] = [-1, 0, 1, 0];

export interface Portal {
  readonly cell: number;
  readonly partner: number;
  /** 從這個門口冒出來時的行進方向。 */
  readonly facing: Dir;
  readonly pair: 0 | 1;
}

/** 四個門口。第 1 對左 (12,6) ↔ 右 (19,17)；第 2 對左 (12,17) ↔ 右 (19,6)。左邊的門朝左、右邊的朝右。 */
export const PORTALS: readonly Portal[] = [
  { cell: cell(12, 6), partner: cell(19, 17), facing: LEFT, pair: 0 },
  { cell: cell(19, 17), partner: cell(12, 6), facing: RIGHT, pair: 0 },
  { cell: cell(12, 17), partner: cell(19, 6), facing: LEFT, pair: 1 },
  { cell: cell(19, 6), partner: cell(12, 17), facing: RIGHT, pair: 1 },
];

/** 牆格（由小到大）。 */
export const WALL_CELLS: readonly number[] = (() => {
  const cells: number[] = [];
  for (let y = WALL_TOP; y <= WALL_BOTTOM; y += 1) {
    for (const x of WALL_COLUMNS) {
      cells.push(cell(x, y));
    }
  }
  return cells;
})();

const IS_WALL = new Uint8Array(CELLS);
for (const c of WALL_CELLS) {
  IS_WALL[c] = 1;
}
/** 配對的門口；不是門口是 -1。 */
const PARTNER = new Int16Array(CELLS).fill(-1);
const FACING = new Int8Array(CELLS).fill(-1);
for (const p of PORTALS) {
  PARTNER[p.cell] = p.partner;
  FACING[p.cell] = p.facing;
}

export function isWall(index: number): boolean {
  return IS_WALL[index] === 1;
}
/** 配對的門口；不是門口回 -1。 */
export function partnerOf(index: number): number {
  return PARTNER[index] as number;
}
/** 從這個門口冒出來的方向；不是門口回 -1。 */
export function facingOf(index: number): number {
  return FACING[index] as number;
}

/** 食物、`evaluate` 的障礙判斷用：牆與門口都不可以放食物。 */
const FOOD_BLOCKERS: readonly number[] = [...WALL_CELLS, ...PORTALS.map((p) => p.cell)];

// ---------------------------------------------------------------------------
// 門口感知的距離
// ---------------------------------------------------------------------------

/**
 * 距離場：每一格走到最近的 `targets` 要幾次走格。牆不可走；踩進門口 M 直接到配對的 M′，
 * 花 `1 + TRANSIT_MOVES` 步。蛇身不算（蛇身一直在動，算進來場就沒法共用；蛇身由 `evaluate` 的 danger 管）。
 * 站在門口格上（剛冒出來的那一格）只能往一般的鄰格走，不會再傳送。走不到是 `FAR`。
 * 用 Dial 演算法（距離只有 1 與 6 兩種邊）。
 */
const DIAL = 8;
const DIAL_CAP = 4 * CELLS;
const dialCells = new Int16Array(DIAL * DIAL_CAP);
const dialCount = new Int32Array(DIAL);

function buildField(targets: readonly number[]): Uint8Array {
  const dist = new Uint8Array(CELLS).fill(FAR);
  dialCount.fill(0);
  let pending = 0;
  const push = (c: number, d: number): void => {
    if (d < (dist[c] as number) && d < FAR) {
      dist[c] = d;
      const b = d % DIAL;
      dialCells[b * DIAL_CAP + (dialCount[b] as number)] = c;
      dialCount[b] = (dialCount[b] as number) + 1;
      pending += 1;
    }
  };
  for (const t of targets) {
    push(t, 0);
  }
  for (let d = 0; pending > 0 && d < FAR; d += 1) {
    const b = d % DIAL;
    for (let i = 0; i < (dialCount[b] as number); i += 1) {
      const w = dialCells[b * DIAL_CAP + i] as number;
      pending -= 1;
      if (dist[w] !== d) {
        continue;
      }
      // 站在 w 的前一格是哪些格子：一般格是它的鄰格；門口格（冒出來的那格）只能從配對門口的鄰格踩進去。
      const partner = PARTNER[w] as number;
      const origin = partner >= 0 ? partner : w;
      const cost = partner >= 0 ? 1 + TRANSIT_MOVES : 1;
      const ox = cellX(origin);
      const oy = cellY(origin);
      for (let k = 0; k < 4; k += 1) {
        const nx = ox + (DX[k] as number);
        const ny = oy + (DY[k] as number);
        if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) {
          continue;
        }
        const u = cell(nx, ny);
        if (IS_WALL[u] === 0) {
          push(u, d + cost);
        }
      }
    }
    dialCount[b] = 0;
  }
  return dist;
}

const fieldCache = new Map<number, Uint8Array>();
const FIELD_CACHE_LIMIT = 256;

/** 到最近的 `targets` 的距離場（以食物配置為鍵記起來；同樣輸入永遠同樣答案；回傳的陣列不可以改）。 */
export function fieldFor(targets: readonly number[]): Uint8Array {
  if (targets.length > 5) {
    return buildField(targets);
  }
  const sorted = [...targets].sort((a, b) => a - b);
  let key = sorted.length;
  for (const t of sorted) {
    key = key * 1024 + t + 1;
  }
  let field = fieldCache.get(key);
  if (field === undefined) {
    if (fieldCache.size >= FIELD_CACHE_LIMIT) {
      fieldCache.clear();
    }
    field = buildField(sorted);
    fieldCache.set(key, field);
  }
  return field;
}

/**
 * 門口感知距離：蛇頭在 `from`（一般地走著，或剛冒出來），走到 `to` 要幾次走格；牆擋住、踩門口要多花 5 步。
 * 牆格、走不到是 `FAR`。
 */
export function pdist(from: number, to: number): number {
  return fieldFor([to])[from] as number;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface Transit {
  /** 蛇頭所在的門口。 */
  readonly from: number;
  /** 要冒出來的門口（配對的）。 */
  readonly to: number;
  /** 在這個 tick（同時是走格的 tick）冒出來。 */
  readonly until: number;
}

export interface C6State extends ClubsState {
  readonly transit: readonly [Transit | null, Transit | null];
  /** 每邊累計鑽門次數（量測與畫面用）。 */
  readonly portalUses: readonly [number, number];
  /** 每邊死在出口（出口被佔用）的次數，0 或 1。 */
  readonly exitDeaths: readonly [number, number];
  /** 堵門事件累計：一條蛇因為「出口被佔用」而死（進門時或冒出時）。 */
  readonly blocks: number;
}

export interface C6Overrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly snakes?: readonly [Partial<Snake>?, Partial<Snake>?];
  readonly foods?: readonly number[];
  readonly rng?: ClubsState['rng'];
  readonly over?: boolean;
  readonly winner?: Side | null;
  readonly transit?: readonly [Transit | null, Transit | null];
  readonly portalUses?: readonly [number, number];
  readonly exitDeaths?: readonly [number, number];
  readonly blocks?: number;
}

/** 直接構造一個局面。預設：起始蛇、食物放在 (8,3) 與 (23,20)（各在一個房間裡、離蛇遠）。 */
export function makeState(overrides: C6Overrides = {}): C6State {
  const base = startSnakes();
  const pick = (i: 0 | 1): Snake => {
    const patch = overrides.snakes?.[i] ?? {};
    const merged = { ...base[i], ...patch };
    return { ...merged, turn: patch.turn ?? merged.dir };
  };
  return {
    tick: overrides.tick ?? 0,
    maxTicks: overrides.maxTicks ?? 3600,
    snakes: [pick(0), pick(1)],
    foods: overrides.foods ?? [cell(8, 3), cell(23, 20)],
    rng: overrides.rng ?? rngStateFor(0, 'food'),
    over: overrides.over ?? false,
    winner: overrides.winner ?? null,
    transit: overrides.transit ?? [null, null],
    portalUses: overrides.portalUses ?? [0, 0],
    exitDeaths: overrides.exitDeaths ?? [0, 0],
    blocks: overrides.blocks ?? 0,
  };
}

/** 補食物時，牆與門口當成佔用的格子（`refillFoods` 只認蛇身，所以把它們塞進一條假蛇的身體）。 */
export function refillAvoiding(
  rng: ClubsState['rng'],
  snakes: readonly [Snake, Snake],
  foods: readonly number[],
  target: number,
): { foods: readonly number[]; rng: ClubsState['rng'] } {
  const padded: readonly [Snake, Snake] = [
    { ...snakes[0], body: [...snakes[0].body, ...FOOD_BLOCKERS] },
    snakes[1],
  ];
  return refillFoods(rng, padded, foods, target);
}

// ---------------------------------------------------------------------------
// 動作
// ---------------------------------------------------------------------------

const IDLE: readonly Buttons[] = Object.freeze([
  Object.freeze({ up: false, down: false, left: false, right: false, a: false, b: false }),
]);

function dirOfButtons(b: Buttons): number {
  return b.up ? 0 : b.right ? 1 : b.down ? 2 : b.left ? 3 : -1;
}

const swapCache = new WeakMap<readonly Buttons[], readonly Buttons[]>();

/** 蛇頭從 `head` 往 `dir` 走一步之後，離最近食物的距離（門口算 5 步傳送；牆與出界是 `FAR`）。 */
function stepDistance(field: Uint8Array, head: number, dir: number): number {
  const x = cellX(head) + (DX[dir] as number);
  const y = cellY(head) + (DY[dir] as number);
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
    return FAR;
  }
  const c = cell(x, y);
  if (IS_WALL[c] === 1) {
    return FAR;
  }
  const partner = PARTNER[c] as number;
  return partner >= 0
    ? Math.min(FAR, TRANSIT_MOVES + (field[partner] as number))
    : (field[c] as number);
}

/**
 * 傳送中：蛇不能動，只有「全放開」。沒有鎖定轉向：兩個有效轉向排前面，下一步（門口感知）離食物比較近的排第一；
 * 已鎖定轉向、局結束：同 `orderedActions`（全放開、上、右、下、左）。
 */
export function actionsC6(state: C6State, side: Side): readonly Buttons[] {
  if (state.over) {
    return IDLE;
  }
  const me = state.snakes[side];
  if (!me.alive || state.transit[side] !== null) {
    return IDLE;
  }
  const base = orderedActions(state, side);
  if (me.turn !== me.dir || state.foods.length === 0) {
    return base;
  }
  const first = base[0] as Buttons;
  const second = base[1] as Buttons;
  const field = fieldFor(state.foods);
  const head = me.body[0] as number;
  const d1 = stepDistance(field, head, dirOfButtons(first));
  const d2 = stepDistance(field, head, dirOfButtons(second));
  if (d2 >= d1) {
    return base;
  }
  let swapped = swapCache.get(base);
  if (swapped === undefined) {
    swapped = Object.freeze([second, first, ...base.slice(2)]);
    swapCache.set(base, swapped);
  }
  return swapped;
}

// ---------------------------------------------------------------------------
// 評估
// ---------------------------------------------------------------------------

/** 這一格現在被某條蛇的身體佔著嗎（各自的尾巴不算，它們這一格會移走）。 */
function bodyOccupied(state: ClubsState, index: number): boolean {
  for (const snake of state.snakes) {
    const at = snake.body.indexOf(index);
    if (at !== -1 && at !== snake.body.length - 1) {
      return true;
    }
  }
  return false;
}

/** 這一格是牆、出界、或被身體佔著。 */
function blockedCell(state: ClubsState, x: number, y: number): boolean {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
    return true;
  }
  const c = cell(x, y);
  return IS_WALL[c] === 1 || bodyOccupied(state, c);
}

function nearestManhattan(foods: readonly number[], x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const food of foods) {
    best = Math.min(best, Math.abs(cellX(food) - x) + Math.abs(cellY(food) - y));
  }
  return Number.isFinite(best) ? best : 0;
}

/** 出口前方幾格有牆或身體就算「出口前面是死路」。 */
export const EXIT_FRONT_CELLS = 2;
export const EXIT_FRONT_DANGER = 0.8;
/** 對手蛇頭離出口幾格以內開始算埋伏。 */
export const EXIT_AMBUSH_RANGE = 4;
export const EXIT_AMBUSH_DANGER = 0.6;

export function evaluateC6(state: C6State, side: Side): { gain: number; danger: number } {
  if (state.over) {
    return evaluateClubs(state, side);
  }
  const me = state.snakes[side];
  const other = state.snakes[side === 0 ? 1 : 0];
  const head = me.body[0] as number;
  const lead = GAIN_PER_POINT * (me.score - other.score);
  const transit = state.transit[side];

  // 出口：傳送中就是要冒出來的門口；下一步踩進門口就是它的配對門口；其他是 -1。
  let exit = -1;
  let wait = 0;
  if (transit !== null) {
    exit = transit.to;
    wait = Math.max(1, Math.ceil((transit.until - state.tick) / MOVE_EVERY));
  } else {
    const nx = cellX(head) + (DX[me.turn] as number);
    const ny = cellY(head) + (DY[me.turn] as number);
    if (nx >= 0 && nx < WIDTH && ny >= 0 && ny < HEIGHT) {
      const next = cell(nx, ny);
      if (IS_WALL[next] === 1) {
        return {
          gain: lead - FOOD_GRADIENT * nearestManhattan(state.foods, nx, ny) - DEATH_GAIN_PENALTY,
          danger: 1,
        };
      }
      const partner = PARTNER[next] as number;
      if (partner >= 0) {
        if (bodyOccupied(state, next)) {
          return { gain: lead - DEATH_GAIN_PENALTY, danger: 1 };
        }
        exit = partner;
        wait = TRANSIT_MOVES;
      }
    }
  }

  let viewMe = me;
  if (exit >= 0) {
    // 把蛇頭換成「出口往後退一格」、方向朝向出口的朝向：`evaluateClubs` 看的「下一步」就是出口，
    // 往前看的障礙、兩側的牆、被困住、頭對頭，全部變成「冒出來之後」的局面。
    const facing = FACING[exit] as Dir;
    const behind = cell(cellX(exit) - (DX[facing] as number), cellY(exit) - (DY[facing] as number));
    viewMe = { ...me, body: [behind, ...me.body], dir: facing, turn: facing };
  }
  const view: C6State =
    viewMe === me ? state : { ...state, snakes: side === 0 ? [viewMe, other] : [other, viewMe] };
  const base = evaluateClubs(view, side);
  if (base.danger >= 1) {
    return base;
  }

  // 距離換成門口感知的（`evaluateClubs` 用曼哈頓距離，每格 `FOOD_GRADIENT`）。
  const target =
    exit >= 0
      ? exit
      : cell(cellX(head) + (DX[me.turn] as number), cellY(head) + (DY[me.turn] as number));
  let gain = base.gain;
  if (state.foods.length > 0) {
    const field = fieldFor(state.foods);
    const moves = Math.min(FAR, (exit >= 0 ? wait : 0) + (field[target] as number));
    gain += FOOD_GRADIENT * (nearestManhattan(state.foods, cellX(target), cellY(target)) - moves);
  }

  // 兩側的牆：同 `evaluateClubs` 對蛇身與邊界的兩側扣分（離食物近時打折）。
  {
    const turnDir = exit >= 0 ? (FACING[exit] as number) : me.turn;
    const near = nearestManhattan(state.foods, cellX(target), cellY(target));
    for (const sideDir of [(turnDir + 1) % 4, (turnDir + 3) % 4]) {
      for (let r = 1; r <= SIDE_PENALTY.length; r += 1) {
        const x = cellX(target) + r * (DX[sideDir] as number);
        const y = cellY(target) + r * (DY[sideDir] as number);
        if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
          break;
        }
        if (IS_WALL[cell(x, y)] === 1) {
          gain -= (SIDE_PENALTY[r - 1] as number) * Math.min(1, near / SIDE_PENALTY_FOOD_RANGE);
          break;
        }
      }
    }
  }
  // 前方的牆：`evaluateClubs` 只認蛇身與地圖邊界，中間的牆自己算。規則同它對邊界的處理：
  // 食物在牆前面（蛇會先吃到食物再轉彎）就不算前方障礙，否則牆邊的食物永遠沒人敢吃（10.31）。
  let danger = base.danger;
  const ahead = exit >= 0 ? (FACING[exit] as number) : me.turn;
  if (!state.foods.includes(target)) {
    for (let r = 1; r < RUN_LOOKAHEAD; r += 1) {
      const x = cellX(target) + r * (DX[ahead] as number);
      const y = cellY(target) + r * (DY[ahead] as number);
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
        break;
      }
      const c = cell(x, y);
      if (IS_WALL[c] === 1) {
        danger = Math.max(danger, RUN_DANGER * Math.pow(1 - r / RUN_LOOKAHEAD, RUN_EXPONENT));
        break;
      }
      if (state.foods.includes(c)) {
        break;
      }
    }
  }
  if (exit >= 0) {
    const facing = FACING[exit] as number;
    const ex = cellX(exit);
    const ey = cellY(exit);
    for (let r = 1; r <= EXIT_FRONT_CELLS; r += 1) {
      if (blockedCell(state, ex + r * (DX[facing] as number), ey + r * (DY[facing] as number))) {
        danger = Math.max(danger, EXIT_FRONT_DANGER);
        break;
      }
    }
    if (other.alive) {
      const oh = other.body[0] as number;
      const d = Math.abs(cellX(oh) - ex) + Math.abs(cellY(oh) - ey);
      if (d <= EXIT_AMBUSH_RANGE) {
        danger = Math.max(danger, EXIT_AMBUSH_DANGER * (1 - d / (EXIT_AMBUSH_RANGE + 1)));
      }
    }
  }
  return { gain, danger };
}

// ---------------------------------------------------------------------------
// 走格
// ---------------------------------------------------------------------------

interface MoveResult {
  readonly snakes: readonly [Snake, Snake];
  readonly transit: readonly [Transit | null, Transit | null];
  readonly dead: readonly [boolean, boolean];
  readonly exitDead: readonly [boolean, boolean];
  readonly ate: readonly [number, number];
  readonly entered: readonly [boolean, boolean];
  readonly foods: readonly number[];
}

/**
 * 一次走格（每 `MOVE_EVERY` tick 一次）。每條蛇是下列三種之一：
 * - 傳送中且還沒到 `until`：不動（整條身體還在，是一堵牆）。
 * - 傳送中且到了 `until`：蛇頭移到出口 `to`，方向改成出口的朝向（身體 [to, 原蛇頭, …]，尾巴照常移走）。
 * - 一般：沿 `turn` 走一格；走進牆或出界死；走進門口 M 則同一格走完、進入傳送（M′ 此時要沒被佔用）。
 * 判死用「走完之後」佔用的格子（沒吃到的蛇少一個尾巴；沒動的蛇整條都在；所有新蛇頭也算佔用）。
 * 「出口被佔用」＝配對的門口 M′ 被任何身體或任何這一格的新蛇頭佔著；兩條蛇同 tick 各踩進一對的兩端，兩邊都死。
 */
function moveAll(
  tick: number,
  snakes: readonly [Snake, Snake],
  transit: readonly [Transit | null, Transit | null],
  foods: readonly number[],
): MoveResult {
  const heads: [number, number] = [-1, -1];
  const moving: [boolean, boolean] = [false, false];
  const crashed: [boolean, boolean] = [false, false];
  const enteringTo: [number, number] = [-1, -1];
  const emerging: [boolean, boolean] = [false, false];
  const foodAt: [number, number] = [-1, -1];
  for (const i of [0, 1] as const) {
    const snake = snakes[i];
    const t = transit[i];
    if (!snake.alive) {
      continue;
    }
    if (t !== null) {
      if (tick >= t.until) {
        moving[i] = true;
        emerging[i] = true;
        heads[i] = t.to;
      }
      continue;
    }
    moving[i] = true;
    const head = snake.body[0] as number;
    const x = cellX(head) + (DX[snake.turn] as number);
    const y = cellY(head) + (DY[snake.turn] as number);
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT || IS_WALL[cell(x, y)] === 1) {
      crashed[i] = true;
    } else {
      heads[i] = cell(x, y);
      enteringTo[i] = PARTNER[heads[i]] as number;
      foodAt[i] = foods.indexOf(heads[i]);
    }
  }

  const occupies = (i: 0 | 1, target: number): boolean => {
    const body = snakes[i].body;
    const at = body.indexOf(target);
    return at !== -1 && (!moving[i] || foodAt[i] >= 0 || at !== body.length - 1);
  };
  const taken = (target: number): boolean =>
    occupies(0, target) || occupies(1, target) || heads[0] === target || heads[1] === target;

  const dead: [boolean, boolean] = [false, false];
  const exitDead: [boolean, boolean] = [false, false];
  for (const i of [0, 1] as const) {
    if (!moving[i]) {
      continue;
    }
    const h = heads[i];
    const j = i === 0 ? 1 : 0;
    const collide =
      crashed[i] || occupies(0, h) || occupies(1, h) || (heads[j] === h && moving[j] && h !== -1);
    if (emerging[i]) {
      // 冒出的出口被任何身體或這一格走進來的蛇頭佔著：卡在出口。
      if (collide) {
        dead[i] = true;
        exitDead[i] = true;
      }
    } else if (collide) {
      dead[i] = true;
    } else if (enteringTo[i] >= 0 && taken(enteringTo[i] as number)) {
      dead[i] = true;
      exitDead[i] = true;
    }
  }

  const entered: [boolean, boolean] = [false, false];
  const nextTransit: [Transit | null, Transit | null] = [transit[0], transit[1]];
  const moved = ([0, 1] as const).map((i): Snake => {
    const snake = snakes[i];
    if (!moving[i]) {
      return snake;
    }
    if (dead[i]) {
      return { ...snake, alive: false };
    }
    const grows = foodAt[i] >= 0;
    const body = grows ? snake.body : snake.body.slice(0, -1);
    if (emerging[i]) {
      const facing = FACING[heads[i]] as Dir;
      nextTransit[i] = null;
      return { ...snake, body: [heads[i], ...body], dir: facing, turn: facing };
    }
    if (enteringTo[i] >= 0) {
      entered[i] = true;
      nextTransit[i] = { from: heads[i], to: enteringTo[i] as number, until: tick + TRANSIT_TICKS };
    }
    return { ...snake, body: [heads[i], ...body], dir: snake.turn };
  }) as [Snake, Snake];

  const ate: [number, number] = [dead[0] ? -1 : foodAt[0], dead[1] ? -1 : foodAt[1]];
  const remaining = foods.filter((_food, index) => index !== ate[0] && index !== ate[1]);
  return { snakes: moved, transit: nextTransit, dead, exitDead, ate, entered, foods: remaining };
}

function replace<T>(pair: readonly [T, T], index: 0 | 1, value: T): readonly [T, T] {
  return index === 0 ? [value, pair[1]] : [pair[0], value];
}

export function stepC6(state: C6State, inputs: Inputs): C6State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let snakes: readonly [Snake, Snake] = [
    state.transit[0] === null ? steerSnake(state.snakes[0], inputs[0]) : state.snakes[0],
    state.transit[1] === null ? steerSnake(state.snakes[1], inputs[1]) : state.snakes[1],
  ];
  let transit = state.transit;
  let foods = state.foods;
  let rng = state.rng;
  let portalUses = state.portalUses;
  let exitDeaths = state.exitDeaths;
  let blocks = state.blocks;
  let over = false;
  let winner: Side | null = null;

  if (tick % MOVE_EVERY === 0) {
    const moved = moveAll(tick, snakes, transit, foods);
    snakes = ([0, 1] as const).map((i): Snake => ({
      ...moved.snakes[i],
      score: moved.snakes[i].score + (moved.ate[i] >= 0 ? 1 : 0),
    })) as unknown as readonly [Snake, Snake];
    transit = moved.transit;
    foods = moved.foods;
    for (const i of [0, 1] as const) {
      if (moved.entered[i]) {
        portalUses = replace(portalUses, i, (portalUses[i] as number) + 1);
      }
      if (moved.exitDead[i]) {
        exitDeaths = replace(exitDeaths, i, (exitDeaths[i] as number) + 1);
        blocks += 1;
      }
    }
    if (moved.dead[0] || moved.dead[1]) {
      // 死亡優先：只有一條死，另一條贏（不看分數）；兩條都死才比分數。
      over = true;
      winner = moved.dead[0] && moved.dead[1] ? winnerByScore(snakes) : moved.dead[0] ? 1 : 0;
    } else {
      const refilled = refillAvoiding(rng, snakes, foods, FOOD_COUNT);
      foods = refilled.foods;
      rng = refilled.rng;
    }
  }

  if (!over && tick >= state.maxTicks) {
    over = true;
    winner = winnerByScore(snakes);
  }
  return {
    ...state,
    tick,
    snakes,
    transit,
    foods,
    rng,
    over,
    winner,
    portalUses,
    exitDeaths,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

/** 場上隨時有幾個食物（同 C-A）。 */
export const FOOD_COUNT = 2;

export const c6Game: Game<C6State> = {
  id: 'C-6',

  init(seed: number, config: GameConfig): C6State {
    if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks <= 0) {
      throw new RangeError(`config.maxTicks 必須是正整數，收到 ${String(config.maxTicks)}`);
    }
    const snakes = startSnakes();
    const filled = refillAvoiding(rngStateFor(seed, 'food'), snakes, [], FOOD_COUNT);
    return {
      tick: 0,
      maxTicks: config.maxTicks,
      snakes,
      foods: filled.foods,
      rng: filled.rng,
      over: false,
      winner: null,
      transit: [null, null],
      portalUses: [0, 0],
      exitDeaths: [0, 0],
      blocks: 0,
    };
  },

  step: stepC6,

  isOver(state: C6State): boolean {
    return state.over;
  },

  score(state: C6State): readonly [number, number] {
    return [state.snakes[0].score, state.snakes[1].score];
  },

  winner(state: C6State): Side | null {
    return state.over ? state.winner : null;
  },

  actions: actionsC6,
  evaluate: evaluateC6,
};
