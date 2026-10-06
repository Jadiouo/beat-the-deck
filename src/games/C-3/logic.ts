import { rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  FOOD_COUNT,
  HEIGHT,
  WIDTH,
  cell,
  MOVE_EVERY,
  cellX,
  cellY,
  evaluateClubs,
  GAIN_PER_POINT,
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
 * C-3 紅藍食物（SPEC 第 10 節；小規格 `docs/cards/C-3.md`）。
 * 與 C-A 一樣的兩條蛇與碰撞，但場上有紅、藍各 2 個食物，只有「現在的正確顏色」算分：
 * 吃對加 1 分、長度加 1；吃錯扣 2 分（可以是負的）、長度不變。正確顏色每 480 tick 換一次。
 */

/** 0 是紅、1 是藍。 */
export type FoodColor = 0 | 1;
export const RED: FoodColor = 0;
export const BLUE: FoodColor = 1;

/** 正確顏色每幾個 tick 換一次。 */
export const SWAP_EVERY = 480;
/** 換色之前幾個 tick 開始警告（指示燈閃爍）。 */
export const WARNING_TICKS = 90;
/** 每種顏色場上有幾個食物。 */
export const FOODS_PER_COLOR = FOOD_COUNT;
/** 吃對加幾分、吃錯扣幾分。 */
export const RIGHT_POINTS = 1;
export const WRONG_POINTS = 2;
/** 局結束時，贏或輸的 gain 加減多少：比任何分差（100 × 分差）都大。 */
export const RESULT_BONUS = 100000;

export interface C3State extends ClubsState {
  /** 與 `foods` 一一對應的顏色。 */
  readonly foodColors: readonly FoodColor[];
  /** 現在的正確顏色。 */
  readonly correct: FoodColor;
  /** 換色之前的 90 個 tick 是 true。 */
  readonly warning: boolean;
}

function other(color: FoodColor): FoodColor {
  return color === RED ? BLUE : RED;
}

/** 第 `tick` 個 tick 是不是在換色前的警告期（每個週期的最後 90 個 tick）。 */
export function warningAt(tick: number): boolean {
  return tick % SWAP_EVERY >= SWAP_EVERY - WARNING_TICKS;
}

/**
 * 把紅、藍各補到 `FOODS_PER_COLOR` 個：先補紅、再補藍，一次補一個（`refillFoods` 挑一個空格），
 * 並把推進後的亂數狀態傳回去，呼叫的人要寫進新 state。沒有空格就停。
 */
function refillColors(
  rng: RngState,
  snakes: readonly [Snake, Snake],
  foods: readonly number[],
  colors: readonly FoodColor[],
): { foods: readonly number[]; colors: readonly FoodColor[]; rng: RngState } {
  let nextFoods = foods;
  let nextColors = colors;
  let nextRng = rng;
  for (const color of [RED, BLUE] as const) {
    while (nextColors.filter((c) => c === color).length < FOODS_PER_COLOR) {
      const filled = refillFoods(nextRng, snakes, nextFoods, nextFoods.length + 1);
      nextRng = filled.rng;
      if (filled.foods.length === nextFoods.length) {
        break; // 沒有空格了
      }
      nextFoods = filled.foods;
      nextColors = [...nextColors, color];
    }
  }
  return { foods: nextFoods, colors: nextColors, rng: nextRng };
}

export interface C3Overrides extends StateOverrides {
  readonly foodColors?: readonly FoodColor[];
  readonly correct?: FoodColor;
  readonly warning?: boolean;
}

/**
 * 測試輔助：直接構造局面。預設食物是 4 個：紅 (15,3)、(15,20)，藍 (20,3)、(20,20)，正確顏色紅。
 * 只給 `foods` 沒給 `foodColors` 時，顏色依序是紅、藍、紅、藍。`warning` 沒給時由 `tick` 推出來。
 */
export function makeState(overrides: C3Overrides = {}): C3State {
  const defaultFoods = [cell(15, 3), cell(15, 20), cell(20, 3), cell(20, 20)];
  const foods = overrides.foods ?? defaultFoods;
  const defaultColors: readonly FoodColor[] =
    overrides.foods === undefined
      ? [RED, RED, BLUE, BLUE]
      : foods.map((_food, index): FoodColor => (index % 2 === 0 ? RED : BLUE));
  const base = makeClubsState({ ...overrides, foods });
  return {
    ...base,
    foodColors: overrides.foodColors ?? defaultColors,
    correct: overrides.correct ?? RED,
    warning: overrides.warning ?? warningAt(base.tick),
  };
}

/** 只留正確顏色的食物：給 `actions` 與 `evaluate` 量距離用（兩個函式本來就只讀 `foods`）。 */
function correctOnly(state: C3State): C3State {
  const foods = state.foods.filter((_food, index) => state.foodColors[index] === state.correct);
  return { ...state, foods };
}

export const c3Game: Game<C3State> = {
  id: 'C-3',

  init(seed: number, config: GameConfig): C3State {
    // `initClubsState` 檢查 config 並放好兩條蛇；它挑的 2 個食物丟掉，改成紅藍各 2 個（從同一個亂數起頭重挑）。
    const base = initClubsState(seed, config);
    const filled = refillColors(rngStateFor(seed, 'food'), base.snakes, [], []);
    return {
      ...base,
      foods: filled.foods,
      foodColors: filled.colors,
      rng: filled.rng,
      correct: RED,
      warning: warningAt(0),
    };
  },

  step(state: C3State, inputs: Inputs): C3State {
    if (state.over) {
      return state;
    }
    const tick = state.tick + 1;
    let snakes: readonly [Snake, Snake] = [
      steerSnake(state.snakes[0], inputs[0]),
      steerSnake(state.snakes[1], inputs[1]),
    ];
    let foods = state.foods;
    let colors = state.foodColors;
    let rng = state.rng;
    let over = false;
    let winner: Side | null = null;

    if (tick % MOVE_EVERY === 0) {
      // 吃到什麼顏色，一律用「這一次 step 開始時」的正確顏色判定；換色在最後才做。
      const right = (index: number): boolean => colors[index] === state.correct;
      const moved = moveSnakes(snakes, foods, right);
      snakes = ([0, 1] as const).map((i): Snake => {
        const eaten = moved.ate[i] as number;
        const points = eaten < 0 ? 0 : right(eaten) ? RIGHT_POINTS : -WRONG_POINTS;
        return { ...moved.snakes[i], score: moved.snakes[i].score + points };
      }) as [Snake, Snake];
      colors = colors.filter((_color, index) => index !== moved.ate[0] && index !== moved.ate[1]);
      foods = moved.foods;
      if (moved.dead[0] || moved.dead[1]) {
        over = true;
        winner = moved.dead[0] && moved.dead[1] ? winnerByScore(snakes) : moved.dead[0] ? 1 : 0;
      } else {
        // 重要：補食物用掉亂數，新的 RngState 一定要寫回 state。
        const refilled = refillColors(rng, snakes, foods, colors);
        foods = refilled.foods;
        colors = refilled.colors;
        rng = refilled.rng;
      }
    }

    if (!over && tick >= state.maxTicks) {
      over = true;
      winner = winnerByScore(snakes);
    }
    const correct = tick % SWAP_EVERY === 0 ? other(state.correct) : state.correct;
    return {
      ...state,
      tick,
      snakes,
      foods,
      foodColors: colors,
      rng,
      over,
      winner,
      correct,
      warning: warningAt(tick),
    };
  },

  isOver(state: C3State): boolean {
    return state.over;
  },

  score(state: C3State): readonly [number, number] {
    return [state.snakes[0].score, state.snakes[1].score];
  },

  winner(state: C3State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: C3State, side: Side): readonly Buttons[] {
    return orderedActions(correctOnly(state), side);
  },

  evaluate(state: C3State, side: Side): { gain: number; danger: number } {
    const { gain, danger } = evaluateClubs(correctOnly(state), side);
    if (state.over) {
      // 分數可以是負的、分差可以很大，而且一條死另一條贏不看分數：勝負加成要比任何分差都大，
      // 否則「分數高但撞死」的那一邊評估起來會比「分數低但活著贏了」的那一邊好。
      const lead =
        GAIN_PER_POINT * (state.snakes[side].score - state.snakes[side === 0 ? 1 : 0].score);
      const bonus =
        state.winner === null ? 0 : state.winner === side ? RESULT_BONUS : -RESULT_BONUS;
      return { gain: lead + bonus, danger };
    }
    return { gain: gain - wrongFoodPenalty(state, side), danger };
  },
};

const STEP_X: readonly number[] = [0, 1, 0, -1];
const STEP_Y: readonly number[] = [-1, 0, 1, 0];

/** 蛇頭下一步正好是錯誤顏色的食物：扣 2 分的 gain。 */
function wrongFoodPenalty(state: C3State, side: Side): number {
  const me = state.snakes[side];
  const head = me.body[0] as number;
  const x = cellX(head) + (STEP_X[me.turn] as number);
  const y = cellY(head) + (STEP_Y[me.turn] as number);
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
    return 0;
  }
  const next = cell(x, y);
  const at = state.foods.indexOf(next);
  return at >= 0 && state.foodColors[at] !== state.correct ? WRONG_POINTS * GAIN_PER_POINT : 0;
}
