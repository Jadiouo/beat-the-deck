import { rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  HEIGHT,
  MOVE_EVERY,
  WIDTH,
  cell,
  cellX,
  cellY,
  evaluateClubs,
  orderedActions,
  refillFoods,
  steerSnake,
  winnerByScore,
} from '../_clubs/logic';
import type { ClubsState, Snake } from '../_clubs/logic';

/**
 * C-7 縮水（小規格 `docs/cards/C-7.md`）。規則同貪食蛇對決，多的是：
 * 蛇身每 `SHRINK_EVERY` tick 縮一格、短到 0 就餓死；場上永遠有 `FOOD_COUNT` 顆食物，吃一顆長 `FOOD_GAIN` 格；
 * 按住 a 可以「燒身體衝刺」：這一次走格連走兩格（第二格直走），花 `SPRINT_COST` 格長度，之後冷卻 `SPRINT_CD` tick。
 * 走格與縮水自己寫在這裡（兩條蛇各自走一次或兩次，`_clubs` 的 `moveSnakes` 做不到）；格子、轉向、食物、
 * `winnerByScore`、共用的 `evaluateClubs` 沿用 `_clubs/logic.ts`（不改它）。
 *
 * 完整資訊：長度、冷卻、食物全在 state 裡，AI 看到的與人看到的一樣。
 */

// ---------------------------------------------------------------------------
// 常數（起始值；旋鈕對照表見小規格）
// ---------------------------------------------------------------------------

export const START_LENGTH = 16;
export const SHRINK_EVERY = 40;
export const FOOD_COUNT = 2;
export const FOOD_GAIN = 5;
export const SPRINT_COST = 2;
export const SPRINT_CD = 30;
export const SPRINT_MIN_LEN = 5;
/** `init` 的 `maxTicks` 下限。 */
export const MIN_MAX_TICKS = 40;
/** 每顆食物的 gain 價值（每格長度 100）。 */
const GAIN_PER_LENGTH = 100;
/** 離食物每遠一格，gain 扣多少（長度剩 6 以下按飢餓權重放大）。 */
export const DISTANCE_WEIGHT = 10;
/** 長度低於這個值時，距離權重放大（越餓越短視）。 */
export const HUNGER_BELOW = 6;
/** 長度 ≤ 這個值才算餓死風險。 */
export const STARVE_LEN = 3;

const DX: readonly number[] = [0, 1, 0, -1];
const DY: readonly number[] = [-1, 0, 1, 0];

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface C7State extends ClubsState {
  /** 兩邊衝刺剩餘冷卻 tick。 */
  readonly sprintCd: readonly [number, number];
  /** 兩邊累計衝刺次數（量測與畫面用）。 */
  readonly sprints: readonly [number, number];
  /** 誰是餓死的（結束後讀）。 */
  readonly starved: readonly [boolean, boolean];
}

export interface C7Options {
  /** false：衝刺關掉（按 a 沒效果，AI 也沒有衝刺的動作）。消融用。預設 true。 */
  readonly sprint?: boolean;
  /** 場上食物數。預設 `FOOD_COUNT`（2）。 */
  readonly foodCount?: number;
  readonly startLength?: number;
  readonly shrinkEvery?: number;
  readonly foodGain?: number;
  readonly sprintCost?: number;
  readonly sprintCd?: number;
}

type Resolved = Required<C7Options>;

function resolve(options: C7Options): Resolved {
  return {
    sprint: options.sprint ?? true,
    foodCount: options.foodCount ?? FOOD_COUNT,
    startLength: options.startLength ?? START_LENGTH,
    shrinkEvery: options.shrinkEvery ?? SHRINK_EVERY,
    foodGain: options.foodGain ?? FOOD_GAIN,
    sprintCost: options.sprintCost ?? SPRINT_COST,
    sprintCd: options.sprintCd ?? SPRINT_CD,
  };
}

// ---------------------------------------------------------------------------
// 起始局面
// ---------------------------------------------------------------------------

/**
 * 起始的蛇身：人的蛇頭在 (9,12) 往右，身體先沿著第 12 列向左排到牆邊（最多 10 格），
 * 不夠再沿著左牆往下排；AI 是它的 180 度旋轉。蛇頭到中間的距離與長度無關。
 */
export function startBody(side: Side, length: number): number[] {
  const body: number[] = [];
  for (let i = 0; i < length; i += 1) {
    body.push(i < 10 ? cell(9 - i, 12) : cell(0, 12 + (i - 9)));
  }
  return side === 0 ? body : body.map((c) => CELLS - 1 - c);
}

function startSnakes(length: number): readonly [Snake, Snake] {
  return [
    { body: startBody(0, length), dir: 1, turn: 1, alive: true, score: length },
    { body: startBody(1, length), dir: 3, turn: 3, alive: true, score: length },
  ];
}

// ---------------------------------------------------------------------------
// 走格
// ---------------------------------------------------------------------------

interface MoveOutcome {
  readonly snakes: readonly [Snake, Snake];
  readonly dead: readonly [boolean, boolean];
  readonly ate: readonly [number, number];
  readonly foods: readonly number[];
}

/**
 * 沿著 `turn` 走一格。只有 `moving` 為 true 的蛇走（衝刺的第二格只有衝刺的蛇走）。
 * 規則同 `moveSnakes`：算新蛇頭 → 走完之後佔用的格子（沒吃到的蛇少一個尾巴；沒走的蛇整條都還在）→ 判死 → 活著的才吃。
 */
function moveOnce(
  snakes: readonly [Snake, Snake],
  foods: readonly number[],
  moving: readonly [boolean, boolean],
): MoveOutcome {
  const heads: [number, number] = [-1, -1];
  const crashed: [boolean, boolean] = [false, false];
  const foodAt: [number, number] = [-1, -1];
  for (const i of [0, 1] as const) {
    if (!moving[i]) {
      continue;
    }
    const snake = snakes[i];
    const head = snake.body[0] as number;
    const x = cellX(head) + (DX[snake.turn] as number);
    const y = cellY(head) + (DY[snake.turn] as number);
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
      crashed[i] = true;
    } else {
      heads[i] = cell(x, y);
      foodAt[i] = foods.indexOf(heads[i]);
    }
  }
  const occupies = (i: 0 | 1, target: number): boolean => {
    const body = snakes[i].body;
    const at = body.indexOf(target);
    return at !== -1 && (!moving[i] || foodAt[i] >= 0 || at !== body.length - 1);
  };
  const dead: [boolean, boolean] = [false, false];
  for (const i of [0, 1] as const) {
    if (!moving[i]) {
      continue;
    }
    dead[i] =
      crashed[i] ||
      occupies(0, heads[i]) ||
      occupies(1, heads[i]) ||
      (heads[0] === heads[1] && heads[0] !== -1);
  }
  const moved = ([0, 1] as const).map((i): Snake => {
    const snake = snakes[i];
    if (!moving[i]) {
      return snake;
    }
    if (dead[i]) {
      return { ...snake, alive: false };
    }
    const body = foodAt[i] >= 0 ? snake.body : snake.body.slice(0, -1);
    return { ...snake, body: [heads[i], ...body], dir: snake.turn };
  }) as [Snake, Snake];
  const ate: [number, number] = [dead[0] ? -1 : foodAt[0], dead[1] ? -1 : foodAt[1]];
  const remaining = foods.filter((_food, index) => index !== ate[0] && index !== ate[1]);
  return { snakes: moved, dead, ate, foods: remaining };
}

/** 吃到食物：身體再加 `gain − 1` 格（走格時已經沒縮尾巴，所以淨增加 `gain` 格）。 */
function grow(snake: Snake, gain: number): Snake {
  const tail = snake.body[snake.body.length - 1] as number;
  return { ...snake, body: [...snake.body, ...Array.from({ length: gain - 1 }, () => tail)] };
}

/** 尾端少 `n` 格（至少留蛇頭一格；長度歸零由呼叫的人用 `length − n` 判斷）。 */
function trim(snake: Snake, n: number): Snake {
  return { ...snake, body: snake.body.slice(0, Math.max(1, snake.body.length - n)) };
}

// ---------------------------------------------------------------------------
// 一個 tick
// ---------------------------------------------------------------------------

function withScore(snake: Snake, starved: boolean): Snake {
  return { ...snake, score: starved ? 0 : snake.body.length };
}

function stepWith(options: Resolved, state: C7State, inputs: Inputs): C7State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  const cd: [number, number] = [
    Math.max(0, state.sprintCd[0] - 1),
    Math.max(0, state.sprintCd[1] - 1),
  ];
  const sprintCounts: [number, number] = [state.sprints[0], state.sprints[1]];
  const starved: [boolean, boolean] = [state.starved[0], state.starved[1]];
  let snakes: readonly [Snake, Snake] = [
    steerSnake(state.snakes[0], inputs[0]),
    steerSnake(state.snakes[1], inputs[1]),
  ];
  let foods = state.foods;
  let rng = state.rng;
  let over = false;
  let winner: Side | null = null;
  let died = false;

  if (tick % MOVE_EVERY === 0) {
    const sprinting: [boolean, boolean] = [false, false];
    for (const i of [0, 1] as const) {
      sprinting[i] =
        options.sprint &&
        snakes[i].alive &&
        inputs[i].a &&
        cd[i] === 0 &&
        snakes[i].body.length >= SPRINT_MIN_LEN;
    }
    const first = moveOnce(snakes, foods, [snakes[0].alive, snakes[1].alive]);
    snakes = first.snakes;
    foods = first.foods;
    let dead: [boolean, boolean] = [first.dead[0], first.dead[1]];
    for (const i of [0, 1] as const) {
      if (first.ate[i] >= 0) {
        snakes = replaceAt(snakes, i, grow(snakes[i], options.foodGain));
      }
    }
    if (!dead[0] && !dead[1] && (sprinting[0] || sprinting[1])) {
      const second = moveOnce(snakes, foods, sprinting);
      snakes = second.snakes;
      foods = second.foods;
      dead = [second.dead[0], second.dead[1]];
      for (const i of [0, 1] as const) {
        if (second.ate[i] >= 0) {
          snakes = replaceAt(snakes, i, grow(snakes[i], options.foodGain));
        }
      }
    }
    died = dead[0] || dead[1];
    if (!died) {
      for (const i of [0, 1] as const) {
        if (sprinting[i]) {
          snakes = replaceAt(snakes, i, trim(snakes[i], options.sprintCost));
          cd[i] = options.sprintCd;
          sprintCounts[i] += 1;
        }
      }
    }
  }

  if (!died && tick % options.shrinkEvery === 0) {
    for (const i of [0, 1] as const) {
      if (snakes[i].body.length <= 1) {
        starved[i] = true;
        snakes = replaceAt(snakes, i, { ...snakes[i], alive: false });
      } else {
        snakes = replaceAt(snakes, i, trim(snakes[i], 1));
      }
    }
    died = starved[0] || starved[1];
  }

  snakes = [withScore(snakes[0], starved[0]), withScore(snakes[1], starved[1])];
  if (died || !snakes[0].alive || !snakes[1].alive) {
    over = true;
    const deadBoth = !snakes[0].alive && !snakes[1].alive;
    winner = deadBoth ? winnerByScore(snakes) : !snakes[0].alive ? 1 : 0;
  } else if (tick % MOVE_EVERY === 0) {
    const refilled = refillFoods(rng, snakes, foods, options.foodCount);
    foods = refilled.foods;
    rng = refilled.rng;
  }

  if (!over && tick >= state.maxTicks) {
    over = true;
    winner = winnerByScore(snakes);
  }
  return {
    ...state,
    tick,
    snakes,
    foods,
    rng,
    over,
    winner,
    sprintCd: cd,
    sprints: sprintCounts,
    starved,
  };
}

function replaceAt(
  snakes: readonly [Snake, Snake],
  index: 0 | 1,
  snake: Snake,
): readonly [Snake, Snake] {
  return index === 0 ? [snake, snakes[1]] : [snakes[0], snake];
}

// ---------------------------------------------------------------------------
// 動作與評估
// ---------------------------------------------------------------------------

function withA(buttons: Buttons): Buttons {
  return Object.freeze({ ...buttons, a: true });
}

const IDLE: readonly Buttons[] = Object.freeze([
  Object.freeze({ up: false, down: false, left: false, right: false, a: false, b: false }),
]);
const IDLE_OR_SPRINT: readonly Buttons[] = Object.freeze([
  IDLE[0] as Buttons,
  withA(IDLE[0] as Buttons),
]);

const actionCache = new WeakMap<readonly Buttons[], readonly Buttons[]>();

function sprintVariants(base: readonly Buttons[]): readonly Buttons[] {
  let cached = actionCache.get(base);
  if (cached === undefined) {
    cached = Object.freeze([...base, ...base.map(withA)]);
    actionCache.set(base, cached);
  }
  return cached;
}

function canSprint(options: Resolved, state: C7State, side: Side): boolean {
  const me = state.snakes[side];
  return (
    options.sprint &&
    me.alive &&
    (state.sprintCd[side] as number) <= 1 &&
    me.body.length >= SPRINT_MIN_LEN
  );
}

/**
 * 沒有鎖定轉向：兩個轉向、全放開，各自帶或不帶 a（衝刺可用時才有帶 a 的）；轉向在前、不衝在前。
 * 已鎖定轉向：全放開、全放開＋a。結束時只有全放開。
 */
function actionsWith(options: Resolved, state: C7State, side: Side): readonly Buttons[] {
  if (state.over) {
    return IDLE;
  }
  const me = state.snakes[side];
  const sprint = canSprint(options, state, side);
  if (!me.alive || me.turn !== me.dir) {
    return sprint ? IDLE_OR_SPRINT : IDLE;
  }
  const base = orderedActions(state, side).slice(0, 3);
  return sprint ? sprintVariants(orderedBase(base)) : orderedBase(base);
}

const baseCache = new Map<string, readonly Buttons[]>();
function orderedBase(base: readonly Buttons[]): readonly Buttons[] {
  const key = base
    .map((b) => `${b.up ? 'u' : ''}${b.right ? 'r' : ''}${b.down ? 'd' : ''}${b.left ? 'l' : ''}`)
    .join('|');
  let cached = baseCache.get(key);
  if (cached === undefined) {
    cached = Object.freeze(base.map((b) => Object.freeze({ ...b })));
    baseCache.set(key, cached);
  }
  return cached;
}

function dist(a: number, x: number, y: number): number {
  return Math.abs(cellX(a) - x) + Math.abs(cellY(a) - y);
}

function evaluateWith(
  options: Resolved,
  state: C7State,
  side: Side,
): { gain: number; danger: number } {
  const base = evaluateClubs(state, side);
  if (state.over || base.danger >= 1) {
    return base;
  }
  const me = state.snakes[side];
  const other = state.snakes[side === 0 ? 1 : 0];
  const head = me.body[0] as number;
  const nx = cellX(head) + (DX[me.turn] as number);
  const ny = cellY(head) + (DY[me.turn] as number);
  const otherHead = other.body[0] as number;
  const ox = cellX(otherHead) + (DX[other.turn] as number);
  const oy = cellY(otherHead) + (DY[other.turn] as number);

  // `evaluateClubs` 扣掉了「到最近食物的距離」；這裡換成逐顆食物的搶奪價值。
  let nearest = Number.POSITIVE_INFINITY;
  let value = Number.NEGATIVE_INFINITY;
  const hunger = 1 + Math.max(0, HUNGER_BELOW - me.body.length) / HUNGER_BELOW;
  for (const food of state.foods) {
    const mine = dist(food, nx, ny);
    nearest = Math.min(nearest, mine);
    // 我先到的機率：我比對手早一步是 1、同時是 0.5、晚一步是 0（對手死了或不存在就是 1）。
    const win = other.alive ? Math.min(1, Math.max(0, 0.5 + 0.5 * (dist(food, ox, oy) - mine))) : 1;
    value = Math.max(
      value,
      GAIN_PER_LENGTH * options.foodGain * win - DISTANCE_WEIGHT * hunger * mine,
    );
  }
  let gain = base.gain;
  if (Number.isFinite(nearest)) {
    gain += nearest + value;
  }
  let danger = base.danger;
  if (me.body.length <= STARVE_LEN && Number.isFinite(nearest)) {
    const ticksLeft =
      (me.body.length - 1) * options.shrinkEvery +
      (options.shrinkEvery - (state.tick % options.shrinkEvery));
    const movesLeft = Math.floor(ticksLeft / MOVE_EVERY);
    danger = Math.max(
      danger,
      nearest > movesLeft
        ? 1
        : Math.max(0, (STARVE_LEN + 1 - me.body.length) / (STARVE_LEN + 1)) * 0.5,
    );
  }
  return { gain, danger };
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export function createC7Game(options: C7Options = {}): Game<C7State> {
  const resolved = resolve(options);
  return {
    id: 'C-7',

    init(seed: number, config: GameConfig): C7State {
      if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks < MIN_MAX_TICKS) {
        throw new RangeError(
          `config.maxTicks 必須是不小於 ${MIN_MAX_TICKS} 的整數，收到 ${String(config.maxTicks)}`,
        );
      }
      const snakes = startSnakes(resolved.startLength);
      const filled = refillFoods(rngStateFor(seed, 'food'), snakes, [], resolved.foodCount);
      return {
        tick: 0,
        maxTicks: config.maxTicks,
        snakes,
        foods: filled.foods,
        rng: filled.rng,
        over: false,
        winner: null,
        sprintCd: [0, 0],
        sprints: [0, 0],
        starved: [false, false],
      };
    },

    step(state: C7State, inputs: Inputs): C7State {
      return stepWith(resolved, state, inputs);
    },

    isOver(state: C7State): boolean {
      return state.over;
    },

    score(state: C7State): readonly [number, number] {
      return [state.snakes[0].score, state.snakes[1].score];
    },

    winner(state: C7State): Side | null {
      return state.over ? state.winner : null;
    },

    actions(state: C7State, side: Side): readonly Buttons[] {
      return actionsWith(resolved, state, side);
    },

    evaluate(state: C7State, side: Side): { gain: number; danger: number } {
      return evaluateWith(resolved, state, side);
    },
  };
}

export const c7Game: Game<C7State> = createC7Game();

// ---------------------------------------------------------------------------
// 測試輔助
// ---------------------------------------------------------------------------

export interface C7Overrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly snakes?: readonly [Partial<Snake>?, Partial<Snake>?];
  readonly foods?: readonly number[];
  readonly rng?: number;
  readonly over?: boolean;
  readonly winner?: Side | null;
  readonly sprintCd?: readonly [number, number];
  readonly sprints?: readonly [number, number];
  readonly starved?: readonly [boolean, boolean];
}

/** 直接構造一個局面。預設：起始蛇、食物放在兩個遠離蛇的固定位置 (15,3) 與 (15,20)。 */
export function makeState(overrides: C7Overrides = {}): C7State {
  const base = startSnakes(START_LENGTH);
  const pick = (i: 0 | 1): Snake => {
    const patch = overrides.snakes?.[i] ?? {};
    const merged = { ...base[i], ...patch };
    const body = merged.body;
    return { ...merged, turn: patch.turn ?? merged.dir, score: patch.score ?? body.length };
  };
  return {
    tick: overrides.tick ?? 0,
    maxTicks: overrides.maxTicks ?? 3600,
    snakes: [pick(0), pick(1)],
    foods: overrides.foods ?? [cell(15, 3), cell(15, 20)],
    rng: overrides.rng ?? rngStateFor(0, 'food'),
    over: overrides.over ?? false,
    winner: overrides.winner ?? null,
    sprintCd: overrides.sprintCd ?? [0, 0],
    sprints: overrides.sprints ?? [0, 0],
    starved: overrides.starved ?? [false, false],
  };
}
