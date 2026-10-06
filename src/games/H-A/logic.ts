import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  AI_WAIT_TICKS,
  clamp01,
  DECISION_TIMEOUT,
  GOAL,
  IDLE,
  MAX_TURNS,
  otherSide,
  PRESS_A,
  PRESS_B,
  winnerByTotals,
} from '../_hearts/logic';
import type { Held } from '../_hearts/logic';

/**
 * H-A 貪心骰（SPEC 第 10 節；小規格 `docs/cards/H-A.md`）。
 * 兩邊輪流擲骰累積，擲到 1 這回合歸零，先到 50 贏。回合制：輪到某一邊時另一邊的輸入被忽略。
 */

export type HAPhase = 'choose' | 'rolling';
export type HAEvent = 'none' | 'roll' | 'bust' | 'bank' | 'timeout';

export interface HAState {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 現在輪到誰（0 人、1 AI）。 */
  readonly turn: Side;
  /** 已經結束的回合數（兩邊合計）。 */
  readonly turnsDone: number;
  readonly totals: readonly [number, number];
  /** 這回合的累積。 */
  readonly acc: number;
  /** `choose`：等這一邊做決定；`rolling`：骰子在滾，下一個 tick 出結果。 */
  readonly phase: HAPhase;
  /** 這一邊還要被忽略幾個 tick（AI 的等待；人恆為 0）。 */
  readonly wait: number;
  /** 這個決定已經等了幾個「可以輸入的 tick」。 */
  readonly idle: number;
  /** 兩邊的 a、b 現在算不算還按著（邊緣觸發用）。 */
  readonly held: readonly [Held, Held];
  /** 已經結算的骰子數。 */
  readonly rolls: number;
  /** 上一顆骰子的點數，0 是還沒擲過。 */
  readonly lastRoll: number;
  readonly lastEvent: HAEvent;
  readonly eventTick: number;
  /** 人已經到 50，AI 正在打最後一個回合。 */
  readonly finalTurn: boolean;
  readonly rng: RngState;
}

const RELEASED: Held = { a: false, b: false };

/** 骰子是 1 以外時平均加幾點：2 到 6 的平均。 */
const MEAN_GOOD_ROLL = 4;
/** 再擲一次，累積歸零的機率。 */
const BUST_PROBABILITY = 1 / 6;
/** 「等決定」比「直接存」略差，所以平手時存分贏過繼續等。 */
const CHOOSING_DISCOUNT = 0.01;
/** `danger` 的放大倍數（3 倍的 1/6 是 0.5）與「有多少東西在桌上」的飽和點。 */
const DANGER_SCALE = 3;
const DANGER_SATURATION = 20;
/**
 * 新的一個回合平均值多少（`H(0)`）：輪到對方時，對方的新回合帶著這個價值；
 * 輪到自己時，之後「對方的新回合」還沒發生，所以要扣掉同一個數，兩種局面才站在同一條基準線上。
 */
const TURN_VALUE = (1 - BUST_PROBABILITY) * MEAN_GOOD_ROLL;
/** 結束的局，勝負加成（比任何分差都大）。 */
const END_BONUS = 1000;

/** 測試用：從預設局面出發，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<HAState> = {}): HAState {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    turn: 0,
    turnsDone: 0,
    totals: [0, 0],
    acc: 0,
    phase: 'choose',
    wait: 0,
    idle: 0,
    held: [RELEASED, RELEASED],
    rolls: 0,
    lastRoll: 0,
    lastEvent: 'none',
    eventTick: 0,
    finalTurn: false,
    rng: rngStateFor(0, 'dice'),
    ...overrides,
  };
}

/** 擲完（或存完）之後換人：累積歸零、換對方、AI 要等 45 tick。 */
function nextTurn(state: HAState, patch: Partial<HAState>): HAState {
  const next = otherSide(state.turn);
  return {
    ...state,
    ...patch,
    turn: next,
    acc: 0,
    phase: 'choose',
    wait: next === 1 ? AI_WAIT_TICKS : 0,
    idle: 0,
  };
}

/** 一個回合結束之後的勝負與換人。`banked` 是這個回合存進去的分數（擲到 1 是 0）。 */
function endTurn(state: HAState, banked: number, event: HAEvent, tick: number): HAState {
  const totals: readonly [number, number] =
    state.turn === 0
      ? [state.totals[0] + banked, state.totals[1]]
      : [state.totals[0], state.totals[1] + banked];
  const turnsDone = state.turnsDone + 1;
  const base = { totals, turnsDone, lastEvent: event, eventTick: tick };

  if (state.turn === 0) {
    const finalTurn = state.finalTurn || totals[0] >= GOAL;
    return nextTurn(state, { ...base, finalTurn });
  }
  // AI 的回合結束：人先到 50 的最後一回合、AI 自己到 50、或回合上限，都在這裡結束。
  const finished = state.finalTurn || totals[1] >= GOAL || turnsDone >= MAX_TURNS;
  if (finished) {
    return {
      ...state,
      ...base,
      acc: 0,
      phase: 'choose',
      wait: 0,
      idle: 0,
      over: true,
      winner: winnerByTotals(totals),
    };
  }
  return nextTurn(state, base);
}

function heldAfter(state: HAState, inputs: Inputs): readonly [Held, Held] {
  const next = ([0, 1] as const).map((side): Held => {
    // AI 等待的那些 tick，輸入被忽略，視同放開：等待一結束，按著的鍵就是一次新的「剛按下」。
    if (side === state.turn && state.wait > 0) {
      return RELEASED;
    }
    const raw = inputs[side];
    return { a: raw.a, b: raw.b };
  });
  return [next[0] as Held, next[1] as Held];
}

function stepHA(state: HAState, inputs: Inputs): HAState {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  const held = heldAfter(state, inputs);
  const moved: HAState = { ...state, tick, held };
  let after: HAState;

  if (state.phase === 'rolling') {
    // 骰子出結果；這個 tick 的輸入被忽略。
    const [value, rng] = intFrom(state.rng, 6);
    const points = value + 1;
    const rolled: HAState = { ...moved, rng, rolls: state.rolls + 1, lastRoll: points };
    after =
      points === 1
        ? endTurn(rolled, 0, 'bust', tick)
        : {
            ...rolled,
            acc: state.acc + points,
            phase: 'choose',
            wait: state.turn === 1 ? AI_WAIT_TICKS : 0,
            idle: 0,
            lastEvent: 'roll',
            eventTick: tick,
          };
  } else if (state.wait > 0) {
    after = { ...moved, wait: state.wait - 1 };
  } else {
    const raw = inputs[state.turn];
    const before = state.held[state.turn];
    const pressedB = raw.b && !before.b;
    const pressedA = raw.a && !before.a;
    if (pressedB) {
      after = endTurn(moved, state.acc, 'bank', tick);
    } else if (pressedA) {
      after = { ...moved, phase: 'rolling', idle: 0 };
    } else if (state.idle + 1 >= DECISION_TIMEOUT) {
      after = endTurn(moved, state.acc, 'timeout', tick);
    } else {
      after = { ...moved, idle: state.idle + 1 };
    }
  }

  if (!after.over && tick >= state.maxTicks) {
    return { ...after, over: true, winner: winnerByTotals(after.totals) };
  }
  return after;
}

/** 這一邊現在能不能輸入。 */
function accepting(state: HAState, side: Side): boolean {
  return !state.over && state.turn === side && state.phase === 'choose' && state.wait === 0;
}

function actionsHA(state: HAState, side: Side): readonly Buttons[] {
  if (!accepting(state, side)) {
    return [IDLE];
  }
  // 邊緣觸發：還按著的鍵再按沒有用，所以不列出來；要先「全放開」才能再按。
  // 兩個鍵都可以按時不列「全放開」：什麼都不做只是拖延，一步看的性格會因為怕危險而一直選它。
  const held = state.held[side];
  const actions: Buttons[] = [];
  if (!held.b) {
    actions.push(PRESS_B);
  }
  if (!held.a) {
    actions.push(PRESS_A);
  }
  if (held.a || held.b) {
    actions.unshift(IDLE);
  }
  return actions;
}

/** 再擲一次之後，累積的期望值。 */
function expectedAfterRoll(acc: number): number {
  return (1 - BUST_PROBABILITY) * (acc + MEAN_GOOD_ROLL);
}

/** 輪到的那個人，這回合累積的價值。 */
function carryValue(state: HAState): number {
  if (state.phase === 'rolling') {
    return expectedAfterRoll(state.acc);
  }
  return Math.max(state.acc, expectedAfterRoll(state.acc)) - CHOOSING_DISCOUNT;
}

function evaluateHA(state: HAState, side: Side): { gain: number; danger: number } {
  const mine = state.totals[side];
  const theirs = state.totals[otherSide(side)];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: mine - theirs + sign * END_BONUS, danger: 0 };
  }
  const carry = carryValue(state);
  const gain = state.turn === side ? mine + carry - TURN_VALUE - theirs : mine - (theirs + carry);
  const danger =
    state.turn === side && state.phase === 'rolling'
      ? clamp01(BUST_PROBABILITY * DANGER_SCALE * Math.min(1, state.acc / DANGER_SATURATION))
      : 0;
  return { gain, danger };
}

export const hAGame: Game<HAState> = {
  id: 'H-A',

  init(seed: number, config: GameConfig): HAState {
    return makeState({ maxTicks: config.maxTicks, rng: rngStateFor(seed, 'dice') });
  },

  step(state: HAState, inputs: Inputs): HAState {
    return stepHA(state, inputs);
  },

  isOver(state: HAState): boolean {
    return state.over;
  },

  score(state: HAState): readonly [number, number] {
    return [state.totals[0], state.totals[1]];
  },

  winner(state: HAState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: HAState, side: Side): readonly Buttons[] {
    return actionsHA(state, side);
  },

  evaluate(state: HAState, side: Side): { gain: number; danger: number } {
    return evaluateHA(state, side);
  },
};
