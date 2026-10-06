import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { clamp01, IDLE, PRESS_A, ROUNDS, ROUND_PAUSE, winnerByTotals } from '../_hearts/logic';

/**
 * H-2 引信（SPEC 第 10 節；小規格 `docs/cards/H-2.md`）。
 * 共 5 局，兩邊同時玩（不是輪流）：按住 a 累積，放開入袋；引信長度是 120 到 600 之間的隱藏隨機數，兩邊同一條；
 * 累積撐到引信長度就爆炸、這一局歸零；開始後 60 tick 內沒按下就是 0。
 */

export const FUSE_MIN = 120;
export const FUSE_MAX = 600;
/** 一局開始後幾個 tick 內要按下 a。 */
export const START_LIMIT = 60;

export type RacerStatus = 'idle' | 'holding' | 'banked' | 'boom' | 'late';

export interface Racer {
  readonly status: RacerStatus;
  /** `holding`：目前累積；`banked`：入袋的分數；其他是 0。 */
  readonly acc: number;
}

export type H2Phase = 'play' | 'pause';

export interface H2State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 現在第幾局（0 到 4）。 */
  readonly round: number;
  readonly phase: H2Phase;
  /** 這一局已經過了幾個 tick。 */
  readonly roundTick: number;
  /** 停頓還剩幾個 tick。 */
  readonly pause: number;
  /** 這一局的引信長度（隱藏，直到 `revealed`）。 */
  readonly fuse: number;
  readonly revealed: boolean;
  /** 已經公開的各局引信長度。 */
  readonly fuses: readonly number[];
  readonly players: readonly [Racer, Racer];
  readonly totals: readonly [number, number];
  /** 兩邊各局的得分（畫面用）。 */
  readonly roundScores: readonly [readonly number[], readonly number[]];
  readonly rng: RngState;
}

/**
 * `gain` 的視野：「再按這麼多個 tick 就放開」的期望值。賭徒型的停止點是 `300 − 視野 / 2`（視野 120 是 240）：
 * 比期望值最大的 285 早一點，因為 AI 放開有 5 到 18 個 tick 的延遲、還有亂選的提早放開。
 */
const GAIN_HORIZON = 120;
/** `danger` 的視野：「再按這麼多個 tick 之內爆炸」的機率。比 gain 長，所以精準型停得早。 */
const DANGER_HORIZON = 150;
/** 結束的局，勝負加成（比任何分差都大）。 */
const END_BONUS = 1000000;

const WAITING: Racer = { status: 'idle', acc: 0 };

/** 測試用：從預設局面出發，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<H2State> = {}): H2State {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    round: 0,
    phase: 'play',
    roundTick: 0,
    pause: 0,
    fuse: 300,
    revealed: false,
    fuses: [],
    players: [WAITING, WAITING],
    totals: [0, 0],
    roundScores: [[], []],
    rng: rngStateFor(0, 'fuse'),
    ...overrides,
  };
}

/** 抽一條引信：{120, …, 600} 均勻。新的 `RngState` 要寫回 state。 */
function drawFuse(rng: RngState): readonly [number, RngState] {
  const [offset, next] = intFrom(rng, FUSE_MAX - FUSE_MIN + 1);
  return [FUSE_MIN + offset, next];
}

function playing(racer: Racer): boolean {
  return racer.status === 'idle' || racer.status === 'holding';
}

/** 一個玩家一個 tick：回傳新狀態。 */
function stepRacer(racer: Racer, pressed: boolean, roundTick: number, fuse: number): Racer {
  if (racer.status === 'idle') {
    if (pressed) {
      return { status: 'holding', acc: 1 };
    }
    return roundTick >= START_LIMIT ? { status: 'late', acc: 0 } : racer;
  }
  if (racer.status === 'holding') {
    const burn = racer.acc + 1; // 這個 tick 燒完之後
    if (burn >= fuse) {
      return { status: 'boom', acc: 0 };
    }
    return pressed ? { status: 'holding', acc: burn } : { status: 'banked', acc: racer.acc };
  }
  return racer;
}

function scoreOf(racer: Racer): number {
  return racer.status === 'banked' ? racer.acc : 0;
}

function startRound(state: H2State, tick: number): H2State {
  const [fuse, rng] = drawFuse(state.rng);
  return {
    ...state,
    tick,
    round: state.round + 1,
    phase: 'play',
    roundTick: 0,
    pause: 0,
    fuse,
    revealed: false,
    players: [WAITING, WAITING],
    rng,
  };
}

function stepH2(state: H2State, inputs: Inputs): H2State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: H2State;

  if (state.phase === 'pause') {
    const pause = state.pause - 1;
    after = pause > 0 ? { ...state, tick, pause } : startRound(state, tick);
  } else {
    const roundTick = state.roundTick + 1;
    const players: readonly [Racer, Racer] = [
      stepRacer(state.players[0], inputs[0].a, roundTick, state.fuse),
      stepRacer(state.players[1], inputs[1].a, roundTick, state.fuse),
    ];
    const bankedNow = (side: Side): number =>
      state.players[side].status === 'holding' && players[side].status === 'banked'
        ? players[side].acc
        : 0;
    const totals: readonly [number, number] = [
      state.totals[0] + bankedNow(0),
      state.totals[1] + bankedNow(1),
    ];
    const moved: H2State = { ...state, tick, roundTick, players, totals };
    if (playing(players[0]) || playing(players[1])) {
      after = moved;
    } else {
      // 兩邊都結束：公開引信，記下這一局的得分。
      const roundScores: readonly [readonly number[], readonly number[]] = [
        [...state.roundScores[0], scoreOf(players[0])],
        [...state.roundScores[1], scoreOf(players[1])],
      ];
      const revealed: H2State = {
        ...moved,
        revealed: true,
        fuses: [...state.fuses, state.fuse],
        roundScores,
      };
      after =
        state.round + 1 >= ROUNDS
          ? { ...revealed, over: true, winner: winnerByTotals(totals) }
          : { ...revealed, phase: 'pause', pause: ROUND_PAUSE };
    }
  }

  if (!after.over && tick >= state.maxTicks) {
    return { ...after, over: true, winner: winnerByTotals(after.totals) };
  }
  return after;
}

/** 這一邊還能按 a 嗎。 */
function canPress(state: H2State, side: Side): boolean {
  return !state.over && state.phase === 'play' && playing(state.players[side]);
}

/** P(fuse > x)：x 是已經撐過的 tick 數。只用公開的分佈，不讀 state 裡的 `fuse`。 */
function survival(x: number): number {
  if (x >= FUSE_MAX) {
    return 0;
  }
  return (FUSE_MAX - Math.max(x, FUSE_MIN - 1)) / (FUSE_MAX - FUSE_MIN + 1);
}

/** 已經撐了 acc、再撐 horizon 個 tick 的條件機率。 */
function surviveMore(acc: number, horizon: number): number {
  const now = survival(acc);
  return now <= 0 ? 0 : survival(acc + horizon) / now;
}

/** 再按 `GAIN_HORIZON` 個 tick 就放開的期望值。 */
function expectedHold(acc: number): number {
  return (acc + GAIN_HORIZON) * surviveMore(acc, GAIN_HORIZON);
}

/** 這一局現在的價值（還沒進總分的部分）。 */
function roundValue(racer: Racer): number {
  return racer.status === 'holding' ? expectedHold(racer.acc) : 0;
}

function evaluateH2(state: H2State, side: Side): { gain: number; danger: number } {
  const other: Side = side === 0 ? 1 : 0;
  const mine = state.totals[side];
  const theirs = state.totals[other];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: mine - theirs + sign * END_BONUS, danger: 0 };
  }
  const gain = mine + roundValue(state.players[side]) - (theirs + roundValue(state.players[other]));
  const me = state.players[side];
  const danger = me.status === 'holding' ? clamp01(1 - surviveMore(me.acc, DANGER_HORIZON)) : 0;
  return { gain, danger };
}

export const h2Game: Game<H2State> = {
  id: 'H-2',

  init(seed: number, config: GameConfig): H2State {
    const [fuse, rng] = drawFuse(rngStateFor(seed, 'fuse'));
    return makeState({ maxTicks: config.maxTicks, fuse, rng });
  },

  step(state: H2State, inputs: Inputs): H2State {
    return stepH2(state, inputs);
  },

  isOver(state: H2State): boolean {
    return state.over;
  },

  score(state: H2State): readonly [number, number] {
    return [state.totals[0], state.totals[1]];
  },

  winner(state: H2State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: H2State, side: Side): readonly Buttons[] {
    return canPress(state, side) ? [IDLE, PRESS_A] : [IDLE];
  },

  evaluate(state: H2State, side: Side): { gain: number; danger: number } {
    return evaluateH2(state, side);
  },
};
