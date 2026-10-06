import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, GameConfig, Side } from '../../core/types';

/**
 * 梅花三張牌（C-A、C-2、C-3）共用的格子世界邏輯：格子與方向、蛇的轉向與走格、
 * 碰撞判定、食物挑格子、給 AI 的評估。全部是純的：亂數只用 `RngState`。
 *
 * 規則的出處是 SPEC 第 10 節「梅花共同設定」；SPEC 沒寫到的細節（走格的順序、
 * 食物怎麼挑、評估的公式）寫在 `docs/cards/C-A.md` 的「我做的決定」。
 */

// ---------------------------------------------------------------------------
// 格子與方向
// ---------------------------------------------------------------------------

export const WIDTH = 32;
export const HEIGHT = 24;
export const CELLS = WIDTH * HEIGHT;
/** 每格的像素大小。 */
export const CELL_SIZE = 10;
/** 蛇每幾個 tick 走一格。 */
export const MOVE_EVERY = 6;
/** 場上隨時有幾個食物。 */
export const FOOD_COUNT = 2;
export const START_LENGTH = 3;

/** 方向：0 上、1 右、2 下、3 左（順時針，所以 `(d + 2) % 4` 是反方向）。 */
export type Dir = 0 | 1 | 2 | 3;
export const UP: Dir = 0;
export const RIGHT: Dir = 1;
export const DOWN: Dir = 2;
export const LEFT: Dir = 3;

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

function opposite(dir: Dir): Dir {
  return ((dir + 2) % 4) as Dir;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface Snake {
  /** 格子編號，蛇頭在最前面。 */
  readonly body: readonly number[];
  /** 上一次走格的行進方向。 */
  readonly dir: Dir;
  /** 下一次走格要走的方向。等於 `dir` 表示這個週期還沒有鎖定任何轉向。 */
  readonly turn: Dir;
  readonly alive: boolean;
  readonly score: number;
}

export interface ClubsState {
  /** 已經 step 的次數。 */
  readonly tick: number;
  readonly maxTicks: number;
  /** 0 號是人（左），1 號是 AI（右）。 */
  readonly snakes: readonly [Snake, Snake];
  readonly foods: readonly number[];
  /** 挑食物位置用的亂數狀態。每挑一次就要把新的狀態寫回來。 */
  readonly rng: RngState;
  readonly over: boolean;
  /** 只有 `over` 之後有意義；平手是 null。 */
  readonly winner: Side | null;
}

// ---------------------------------------------------------------------------
// 動作與轉向
// ---------------------------------------------------------------------------

const NONE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});

/** 按下某個方向。 */
function press(dir: Dir): Buttons {
  return Object.freeze({
    ...NONE,
    up: dir === UP,
    right: dir === RIGHT,
    down: dir === DOWN,
    left: dir === LEFT,
  });
}

/** 已經鎖定轉向、或局已結束時用的固定順序：全放開、上、右、下、左。 */
const DEFAULT_ORDER: readonly Buttons[] = Object.freeze([
  NONE,
  press(UP),
  press(RIGHT),
  press(DOWN),
  press(LEFT),
]);

/**
 * 沒有鎖定轉向時的排法：兩個有效的轉向排在最前面，之後才是不會改變方向的三個
 * （全放開、按原方向、按反方向）。`TURN_ORDERS[dir][0 或 1]`：第一個轉向是「順時針那一邊」或「逆時針那一邊」。
 */
const TURN_ORDERS: readonly (readonly (readonly Buttons[])[])[] = [UP, RIGHT, DOWN, LEFT].map(
  (dir) => {
    const clockwise = ((dir + 1) % 4) as Dir;
    const anticlockwise = ((dir + 3) % 4) as Dir;
    const noOps = [NONE, press(dir), press(opposite(dir))];
    return [
      Object.freeze([press(clockwise), press(anticlockwise), ...noOps]),
      Object.freeze([press(anticlockwise), press(clockwise), ...noOps]),
    ];
  },
);

/** 依「上、右、下、左」的順序，找第一個有效的轉向（與行進方向不同、也不是反方向）。 */
function validTurn(buttons: Buttons, dir: Dir): Dir | null {
  const pressed = [buttons.up, buttons.right, buttons.down, buttons.left];
  for (let d = 0; d < 4; d += 1) {
    if (pressed[d] === true && d !== dir && d !== opposite(dir)) {
      return d as Dir;
    }
  }
  return null;
}

/** 讀這個 tick 的輸入：這個週期還沒鎖定轉向，而且有有效的轉向，就鎖定它。 */
export function steerSnake(snake: Snake, buttons: Buttons): Snake {
  if (!snake.alive || snake.turn !== snake.dir) {
    return snake;
  }
  const turn = validTurn(buttons, snake.dir);
  return turn === null ? snake : { ...snake, turn };
}

/** 離格子 (x, y) 最近的食物的曼哈頓距離；走出地圖算 1000，沒有食物是 0。 */
function foodDistance(foods: readonly number[], x: number, y: number): number {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
    return 1000;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const food of foods) {
    best = Math.min(best, Math.abs(cellX(food) - x) + Math.abs(cellY(food) - y));
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * 某一邊這個 tick 可以選的動作：固定五個（上、右、下、左、全放開），但**順序**有講究。
 *
 * 搜尋型往前看好幾個 tick，而蛇每 6 個 tick 才走一格：現在就轉彎，與「先等一下、之後再轉彎」，
 * 在幾個 tick 之後的終點完全相同（轉向只要在走格之前鎖定就好）。平手時搜尋型取排在最前面的動作，
 * 如果「全放開」排第一，它就會一直拖延，拖到走格前的最後一個 tick 才轉；而它看到的 state 又比現在舊
 * （反應延遲），結果每一次轉彎都晚一格，撞牆。
 * 所以改成：兩個有效的轉向排在前面（讓蛇頭下一步更靠近食物的排第一），不會改變方向的動作排在後面。
 * 代價：搜尋型模擬對手時（取對手 `actions()` 的第一個）假設對手「往食物的方向轉彎」，而不是維持不動。
 */
export function orderedActions(state: ClubsState, side: Side): readonly Buttons[] {
  const me = state.snakes[side];
  if (state.over || !me.alive || me.turn !== me.dir) {
    return DEFAULT_ORDER;
  }
  const head = me.body[0] as number;
  const x = cellX(head);
  const y = cellY(head);
  const clockwise = ((me.dir + 1) % 4) as Dir;
  const anticlockwise = ((me.dir + 3) % 4) as Dir;
  const clockwiseDistance = foodDistance(
    state.foods,
    x + (DX[clockwise] as number),
    y + (DY[clockwise] as number),
  );
  const anticlockwiseDistance = foodDistance(
    state.foods,
    x + (DX[anticlockwise] as number),
    y + (DY[anticlockwise] as number),
  );
  const orders = TURN_ORDERS[me.dir] as readonly (readonly Buttons[])[];
  return orders[anticlockwiseDistance < clockwiseDistance ? 1 : 0] as readonly Buttons[];
}

// ---------------------------------------------------------------------------
// 走格與碰撞
// ---------------------------------------------------------------------------

export interface MoveOutcome {
  /** 走完之後的蛇（還沒加分）。死掉的蛇停在原地。 */
  readonly snakes: readonly [Snake, Snake];
  /** 兩條蛇各自這一格有沒有死。 */
  readonly dead: readonly [boolean, boolean];
  /** 兩條蛇各自吃到的食物（`foods` 的索引），沒有吃到或死掉是 -1。 */
  readonly ate: readonly [number, number];
  /** 吃掉的食物已經移除、還沒補。 */
  readonly foods: readonly number[];
}

/**
 * 兩條蛇同時走一格。順序（`docs/cards/C-A.md` 決定 5）：
 * 算新蛇頭 → 算蛇身「走完之後」佔用的格子（沒吃到的蛇少一個尾巴）→ 判死亡 → 活著的才吃。
 * `growsOn(foodIndex)`：吃到這個食物會不會變長（C-3 的錯誤顏色不會）；預設都會。
 */
export function moveSnakes(
  snakes: readonly [Snake, Snake],
  foods: readonly number[],
  growsOn: (foodIndex: number) => boolean = () => true,
): MoveOutcome {
  const heads: [number, number] = [-1, -1];
  const crashed: [boolean, boolean] = [false, false];
  const foodAt: [number, number] = [-1, -1];
  const grows: [boolean, boolean] = [false, false];

  for (const i of [0, 1] as const) {
    const snake = snakes[i];
    const head = snake.body[0] as number;
    const x = cellX(head) + (DX[snake.turn] as number);
    const y = cellY(head) + (DY[snake.turn] as number);
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
      crashed[i] = true;
    } else {
      heads[i] = cell(x, y);
      foodAt[i] = foods.indexOf(heads[i]);
      grows[i] = foodAt[i] >= 0 && growsOn(foodAt[i]);
    }
  }

  // 走完之後，這一格還被第 i 條蛇的身體佔著嗎？沒吃到的蛇，尾巴已經移走。
  const occupies = (i: 0 | 1, target: number): boolean => {
    const body = snakes[i].body;
    const at = body.indexOf(target);
    return at !== -1 && (grows[i] || at !== body.length - 1);
  };

  const dead: [boolean, boolean] = [false, false];
  for (const i of [0, 1] as const) {
    dead[i] =
      crashed[i] ||
      occupies(0, heads[i]) ||
      occupies(1, heads[i]) ||
      (heads[0] === heads[1] && heads[0] !== -1);
  }

  const moved = ([0, 1] as const).map((i): Snake => {
    const snake = snakes[i];
    if (dead[i]) {
      return { ...snake, alive: false };
    }
    const body = grows[i] ? snake.body : snake.body.slice(0, -1);
    return { ...snake, body: [heads[i], ...body], dir: snake.turn };
  }) as [Snake, Snake];

  const ate: [number, number] = [dead[0] ? -1 : foodAt[0], dead[1] ? -1 : foodAt[1]];
  const remaining = foods.filter((_food, index) => index !== ate[0] && index !== ate[1]);
  return { snakes: moved, dead, ate, foods: remaining };
}

/** 平常的贏家：分數高的贏，同分平手。 */
export function winnerByScore(snakes: readonly [Snake, Snake]): Side | null {
  if (snakes[0].score === snakes[1].score) {
    return null;
  }
  return snakes[0].score > snakes[1].score ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 食物
// ---------------------------------------------------------------------------

/** 沒有被蛇身、也沒有被食物佔用的格子（由小到大）。 */
function freeCells(snakes: readonly [Snake, Snake], foods: readonly number[]): number[] {
  const taken = new Uint8Array(CELLS);
  for (const snake of snakes) {
    for (const c of snake.body) {
      taken[c] = 1;
    }
  }
  for (const c of foods) {
    taken[c] = 1;
  }
  const free: number[] = [];
  for (let c = 0; c < CELLS; c += 1) {
    if (taken[c] === 0) {
      free.push(c);
    }
  }
  return free;
}

/**
 * 食物不足 `target` 個就補到 `target` 個：每個都從空格裡均勻挑（`intFrom`），
 * 並把推進後的亂數狀態傳回去，呼叫的人要寫進新 state。沒有空格就停，食物可以少於 `target`。
 */
export function refillFoods(
  rng: RngState,
  snakes: readonly [Snake, Snake],
  foods: readonly number[],
  target: number = FOOD_COUNT,
): { foods: readonly number[]; rng: RngState } {
  if (foods.length >= target) {
    return { foods, rng };
  }
  const free = freeCells(snakes, foods);
  const next = [...foods];
  let state = rng;
  while (next.length < target && free.length > 0) {
    const [pick, following] = intFrom(state, free.length);
    state = following;
    next.push(free[pick] as number);
    free.splice(pick, 1);
  }
  return { foods: next, rng: state };
}

// ---------------------------------------------------------------------------
// init 與 makeState
// ---------------------------------------------------------------------------

/** 起始的兩條蛇：人 (5,12) 往右，AI (26,11) 往左；兩條相對地圖中心 180 度對稱。 */
export function startSnakes(): readonly [Snake, Snake] {
  return [
    {
      body: [cell(5, 12), cell(4, 12), cell(3, 12)],
      dir: RIGHT,
      turn: RIGHT,
      alive: true,
      score: 0,
    },
    {
      body: [cell(26, 11), cell(27, 11), cell(28, 11)],
      dir: LEFT,
      turn: LEFT,
      alive: true,
      score: 0,
    },
  ];
}

export function initClubsState(seed: number, config: GameConfig): ClubsState {
  if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks <= 0) {
    throw new RangeError(`config.maxTicks 必須是正整數，收到 ${String(config.maxTicks)}`);
  }
  const snakes = startSnakes();
  const filled = refillFoods(rngStateFor(seed, 'food'), snakes, []);
  return {
    tick: 0,
    maxTicks: config.maxTicks,
    snakes,
    foods: filled.foods,
    rng: filled.rng,
    over: false,
    winner: null,
  };
}

export interface StateOverrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  /** 兩條蛇各自要覆蓋的欄位；沒給的欄位用起始值，`turn` 沒給就等於 `dir`。 */
  readonly snakes?: readonly [Partial<Snake>?, Partial<Snake>?];
  readonly foods?: readonly number[];
  readonly rng?: RngState;
  readonly over?: boolean;
  readonly winner?: Side | null;
}

/**
 * 測試輔助：直接構造一個局面。預設是起始局面，食物放在兩個遠離蛇的固定位置
 * （不是由種子決定的），所以測試不會被隨機的食物位置影響。
 */
export function makeState(overrides: StateOverrides = {}): ClubsState {
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
    foods: overrides.foods ?? [cell(15, 3), cell(15, 20)],
    rng: overrides.rng ?? rngStateFor(0, 'food'),
    over: overrides.over ?? false,
    winner: overrides.winner ?? null,
  };
}

// ---------------------------------------------------------------------------
// 評估（給 AI）
// ---------------------------------------------------------------------------

/** 每 1 分的 gain。比任何距離（最多 54）都大，所以吃到食物永遠比靠近食物重要。 */
export const GAIN_PER_POINT = 100;
/** 局結束時，贏或輸的 gain 加減多少。 */
export const RESULT_BONUS = 500;
/** 蛇頭下一步與對方的下一步是同一格（頭對頭）的 danger。 */
export const HEAD_ON_DANGER = 0.8;
/** 被困住的程度（空間不夠）能貢獻的最大 danger。 */
export const TRAP_DANGER = 0.9;
/** 判斷被困住時，要數到「長度＋這個數字」個空格才算安全。 */
export const ROOM_MARGIN = 2;
/** 離牆幾格以內開始算危險（反應有延遲時，貼著牆走一個誤判就撞上去）。 */
export const EDGE_RANGE = 3;
/** 蛇頭下一步貼著牆（距離 0）時，因為「靠近牆」貢獻的 danger；每遠一格少 1 / EDGE_RANGE。 */
export const EDGE_DANGER = 0.8;
/** 往行進方向看幾格有沒有牆或蛇身。 */
export const RUN_LOOKAHEAD = 10;
/** 前方 RUN_LOOKAHEAD 格內有障礙時，danger 最多多少（障礙在第 1 格就是這個值，越遠越小）。 */
export const RUN_DANGER = 1.0;

/** 最近的食物離 (x, y) 的曼哈頓距離；沒有食物是 0。 */
function nearestFood(foods: readonly number[], x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const food of foods) {
    best = Math.min(best, Math.abs(cellX(food) - x) + Math.abs(cellY(food) - y));
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * `evaluateClubs` 用的暫存格子表。每次評估用一個新的「世代」數字蓋章，
 * 所以不用每次重新配置、清空 768 格的陣列（評估一次要在微秒內完成，搜尋型一次決策會呼叫上百次）。
 * 結果只由這次呼叫的輸入決定，與之前呼叫過幾次無關。
 */
const blockedStamp = new Uint32Array(CELLS);
const seenStamp = new Uint32Array(CELLS);
const bfsQueue = new Int16Array(CELLS);
let stampGeneration = 0;

/** 從 `start` 出發能走到幾格空格（含 `start`），數到 `cap` 就停。被佔住的格子是 `blockedStamp === generation`。 */
function reachable(generation: number, start: number, cap: number): number {
  let head = 0;
  let tail = 0;
  bfsQueue[tail] = start;
  tail += 1;
  seenStamp[start] = generation;
  while (head < tail && tail < cap) {
    const current = bfsQueue[head] as number;
    head += 1;
    const x = cellX(current);
    const y = cellY(current);
    for (let d = 0; d < 4; d += 1) {
      const nx = x + (DX[d] as number);
      const ny = y + (DY[d] as number);
      if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) {
        continue;
      }
      const next = cell(nx, ny);
      if (seenStamp[next] !== generation && blockedStamp[next] !== generation) {
        seenStamp[next] = generation;
        bfsQueue[tail] = next;
        tail += 1;
      }
    }
  }
  return Math.min(tail, cap);
}

/**
 * 梅花共用的評估（公式見 `docs/cards/C-A.md`）：
 * `gain = 100 × (我的分數 − 對方分數) − 蛇頭下一步到最近食物的距離`；
 * `danger` = 下一步撞牆或撞蛇身 1、頭對頭 0.8、快被困死 0.9 × (1 − 空間 / (長度 + 2))，取最大。
 * 「下一步」用 state 裡已經鎖定的 `turn`，所以按一個方向鍵在下一個 tick 就看得出差別。
 */
export function evaluateClubs(state: ClubsState, side: Side): { gain: number; danger: number } {
  const me = state.snakes[side];
  const other = state.snakes[side === 0 ? 1 : 0];
  const lead = GAIN_PER_POINT * (me.score - other.score);

  if (state.over) {
    const bonus = state.winner === null ? 0 : state.winner === side ? RESULT_BONUS : -RESULT_BONUS;
    return { gain: lead + bonus, danger: me.alive ? 0 : 1 };
  }

  const head = me.body[0] as number;
  const nx = cellX(head) + (DX[me.turn] as number);
  const ny = cellY(head) + (DY[me.turn] as number);
  const gain = lead - nearestFood(state.foods, nx, ny);

  if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) {
    return { gain, danger: 1 };
  }
  const next = cell(nx, ny);

  // 被佔住的格子：兩條蛇的身體，不含各自的尾巴（它們這一格會移走）。
  stampGeneration += 1;
  const generation = stampGeneration;
  for (const snake of state.snakes) {
    for (let i = 0; i < snake.body.length - 1; i += 1) {
      blockedStamp[snake.body[i] as number] = generation;
    }
  }
  if (blockedStamp[next] === generation) {
    return { gain, danger: 1 };
  }

  // 前方走得到幾格：反應有延遲的 AI 看到的是舊的 state，只看下一步會來不及轉彎。
  let run = 1;
  while (run < RUN_LOOKAHEAD) {
    const rx = nx + run * (DX[me.turn] as number);
    const ry = ny + run * (DY[me.turn] as number);
    if (
      rx < 0 ||
      rx >= WIDTH ||
      ry < 0 ||
      ry >= HEIGHT ||
      blockedStamp[cell(rx, ry)] === generation
    ) {
      break;
    }
    run += 1;
  }
  let danger = run < RUN_LOOKAHEAD ? RUN_DANGER * (1 - run / RUN_LOOKAHEAD) : 0;
  const edge = Math.min(nx, WIDTH - 1 - nx, ny, HEIGHT - 1 - ny);
  if (edge < EDGE_RANGE) {
    danger = Math.max(danger, (EDGE_DANGER * (EDGE_RANGE - edge)) / EDGE_RANGE);
  }
  const otherHead = other.body[0] as number;
  const otherX = cellX(otherHead) + (DX[other.turn] as number);
  const otherY = cellY(otherHead) + (DY[other.turn] as number);
  if (other.alive && otherX === nx && otherY === ny) {
    danger = Math.max(danger, HEAD_ON_DANGER);
  }
  const cap = me.body.length + ROOM_MARGIN;
  const room = reachable(generation, next, cap);
  if (room < cap) {
    danger = Math.max(danger, TRAP_DANGER * (1 - room / cap));
  }
  return { gain, danger };
}
