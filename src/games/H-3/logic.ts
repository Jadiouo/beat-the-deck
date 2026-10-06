import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { clamp01, IDLE, PRESS_A, ROUNDS, ROUND_PAUSE, winnerByTotals } from '../_hearts/logic';

/**
 * H-3 懸崖（SPEC 第 10 節；小規格 `docs/cards/H-3.md`）。
 * 共 5 局，兩邊同時從 0 出發往懸崖衝（跑道 300 像素），速度每 30 tick 加 0.1；按下 a 煞車，減速度 0.05。
 * 停在 300 以內得位置的整數部分，超過就掉下去得 0。每局的起始速度（0.8 到 1.2）兩邊相同。
 *
 * 位置與速度一律用整數的「千分之一像素」：0.1 與 0.05 在二進位浮點數裡不精確，
 * 「剛好 300.0」、「287.6」這種邊界要靠整數運算才可靠。
 */

/** 跑道長度：300 像素。 */
export const TRACK = 300000;
/** 起始速度的範圍：0.8 到 1.2 像素／tick。 */
export const V0_MIN = 800;
export const V0_MAX = 1200;
/** 減速度 0.05；每 30 個 tick 加速 0.1。 */
export const DECEL = 50;
export const SPEED_STEP = 100;
export const SPEED_EVERY = 30;

export type RunnerStatus = 'running' | 'braking' | 'stopped' | 'fallen';

export interface Runner {
  readonly status: RunnerStatus;
  /** 位置，千分之一像素。 */
  readonly pos: number;
  /** 速度，千分之一像素／tick。 */
  readonly speed: number;
  /** 已經跑了幾個 tick（每 30 個 tick 加速一次用）。 */
  readonly age: number;
}

export type H3Phase = 'run' | 'pause';

export interface H3State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  readonly round: number;
  readonly phase: H3Phase;
  readonly roundTick: number;
  readonly pause: number;
  /** 這一局的起始速度，兩邊相同。 */
  readonly v0: number;
  readonly runners: readonly [Runner, Runner];
  readonly totals: readonly [number, number];
  readonly roundScores: readonly [readonly number[], readonly number[]];
  readonly rng: RngState;
}

/** `evaluate` 假設的反應延遲（tick）：「再等這麼多個 tick 才煞車」。 */
const DELAY = 16;
/** `danger` 的視野：離「必須煞車」還有幾個 tick 以內開始緊張。 */
const DANGER_HORIZON = 30;
/** 結束的局，勝負加成（比任何分差都大）。 */
const END_BONUS = 1000000;

/** 煞車距離（千分之一像素）：按下的那個 tick 開始時速度是 `speed`，之後到停下來走多遠。 */
export function brakeDistance(speed: number): number {
  if (speed <= 0) {
    return 0;
  }
  // 每個 tick「先用目前的速度走一步，再減速」：speed + (speed − a) + (speed − 2a) + …（到速度 ≤ 0 為止）。
  const n = Math.floor(speed / DECEL);
  return (n + 1) * speed - (DECEL * n * (n + 1)) / 2;
}

function startingRunner(v0: number): Runner {
  return { status: 'running', pos: 0, speed: v0, age: 0 };
}

/** 測試用：從預設局面出發，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<H3State> = {}): H3State {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    round: 0,
    phase: 'run',
    roundTick: 0,
    pause: 0,
    v0: 1000,
    runners: [startingRunner(1000), startingRunner(1000)],
    totals: [0, 0],
    roundScores: [[], []],
    rng: rngStateFor(0, 'v0'),
    ...overrides,
  };
}

/** 抽一個起始速度：{800, …, 1200} 均勻。新的 `RngState` 要寫回 state。 */
function drawSpeed(rng: RngState): readonly [number, RngState] {
  const [offset, next] = intFrom(rng, V0_MAX - V0_MIN + 1);
  return [V0_MIN + offset, next];
}

function moving(runner: Runner): boolean {
  return runner.status === 'running' || runner.status === 'braking';
}

function scoreOf(runner: Runner): number {
  return runner.status === 'stopped' ? Math.floor(runner.pos / 1000) : 0;
}

/** 一個跑者一個 tick：先（可能）開始煞車，用目前的速度走一步，再改速度，最後判斷掉下去或停下來。 */
function stepRunner(runner: Runner, pressed: boolean): Runner {
  if (!moving(runner)) {
    return runner;
  }
  const slowing = runner.status === 'braking' || pressed;
  const pos = runner.pos + runner.speed;
  let speed: number;
  let age = runner.age;
  if (slowing) {
    speed = Math.max(0, runner.speed - DECEL);
  } else {
    age += 1;
    speed = runner.speed + (age % SPEED_EVERY === 0 ? SPEED_STEP : 0);
  }
  if (pos > TRACK) {
    return { status: 'fallen', pos, speed: 0, age };
  }
  if (slowing && speed === 0) {
    return { status: 'stopped', pos, speed: 0, age };
  }
  return { status: slowing ? 'braking' : 'running', pos, speed, age };
}

function startRound(state: H3State, tick: number): H3State {
  const [v0, rng] = drawSpeed(state.rng);
  return {
    ...state,
    tick,
    round: state.round + 1,
    phase: 'run',
    roundTick: 0,
    pause: 0,
    v0,
    runners: [startingRunner(v0), startingRunner(v0)],
    rng,
  };
}

function stepH3(state: H3State, inputs: Inputs): H3State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: H3State;

  if (state.phase === 'pause') {
    const pause = state.pause - 1;
    after = pause > 0 ? { ...state, tick, pause } : startRound(state, tick);
  } else {
    const runners: readonly [Runner, Runner] = [
      stepRunner(state.runners[0], inputs[0].a),
      stepRunner(state.runners[1], inputs[1].a),
    ];
    // 得分在跑者結束（停下來）的那個 tick 就加進總分。
    const gained = (side: Side): number =>
      moving(state.runners[side]) && runners[side].status === 'stopped'
        ? scoreOf(runners[side])
        : 0;
    const totals: readonly [number, number] = [
      state.totals[0] + gained(0),
      state.totals[1] + gained(1),
    ];
    const moved: H3State = { ...state, tick, roundTick: state.roundTick + 1, runners, totals };
    if (moving(runners[0]) || moving(runners[1])) {
      after = moved;
    } else {
      const roundScores: readonly [readonly number[], readonly number[]] = [
        [...state.roundScores[0], scoreOf(runners[0])],
        [...state.roundScores[1], scoreOf(runners[1])],
      ];
      const ended: H3State = { ...moved, roundScores };
      after =
        state.round + 1 >= ROUNDS
          ? { ...ended, over: true, winner: winnerByTotals(totals) }
          : { ...ended, phase: 'pause', pause: ROUND_PAUSE };
    }
  }

  if (!after.over && tick >= state.maxTicks) {
    return { ...after, over: true, winner: winnerByTotals(after.totals) };
  }
  return after;
}

function stopScore(stop: number): number {
  return stop > TRACK ? 0 : Math.floor(stop / 1000);
}

/** 這個跑者這一局現在的價值（還沒進總分的部分）。 */
function runnerValue(runner: Runner): number {
  switch (runner.status) {
    case 'stopped':
      return scoreOf(runner);
    case 'fallen':
      return 0;
    case 'braking':
      return stopScore(runner.pos + brakeDistance(runner.speed));
    default:
      // 還在跑：假設再過 DELAY 個 tick 才煞車。
      return stopScore(runner.pos + runner.speed * DELAY + brakeDistance(runner.speed));
  }
}

function runnerDanger(runner: Runner): number {
  if (runner.status === 'braking') {
    return runner.pos + brakeDistance(runner.speed) > TRACK ? 1 : 0;
  }
  if (runner.status === 'running') {
    const room = TRACK - (runner.pos + brakeDistance(runner.speed));
    return clamp01(1 - room / runner.speed / DANGER_HORIZON);
  }
  return 0;
}

function evaluateH3(state: H3State, side: Side): { gain: number; danger: number } {
  const other: Side = side === 0 ? 1 : 0;
  const mine = state.totals[side];
  const theirs = state.totals[other];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: mine - theirs + sign * END_BONUS, danger: 0 };
  }
  const gain =
    mine + runnerValue(state.runners[side]) - (theirs + runnerValue(state.runners[other]));
  return { gain, danger: runnerDanger(state.runners[side]) };
}

export const h3Game: Game<H3State> = {
  id: 'H-3',

  init(seed: number, config: GameConfig): H3State {
    const [v0, rng] = drawSpeed(rngStateFor(seed, 'v0'));
    return makeState({
      maxTicks: config.maxTicks,
      v0,
      runners: [startingRunner(v0), startingRunner(v0)],
      rng,
    });
  },

  step(state: H3State, inputs: Inputs): H3State {
    return stepH3(state, inputs);
  },

  isOver(state: H3State): boolean {
    return state.over;
  },

  score(state: H3State): readonly [number, number] {
    return [state.totals[0], state.totals[1]];
  },

  winner(state: H3State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: H3State, side: Side): readonly Buttons[] {
    const live = !state.over && state.phase === 'run' && state.runners[side].status === 'running';
    return live ? [IDLE, PRESS_A] : [IDLE];
  },

  evaluate(state: H3State, side: Side): { gain: number; danger: number } {
    return evaluateH3(state, side);
  },
};
