import type { Buttons, Game, GameConfig, Inputs, Side } from '../../src/core/types';

/**
 * 測試專用的計數遊戲：每個 tick，按著 a 的那一邊加 1 分。
 *
 * - 預設 100 tick 結束；`config.params.length` 可以改長度。
 * - 同時受 `config.maxTicks` 限制：長度向下取整後取兩者較小；maxTicks 不是
 *   正整數、length 不是有限數字時 init 丟錯。所以遊戲都遵守「maxTicks 之內一定結束」的契約。
 * - 分數高的贏，同分平手。
 *
 * T2、T3 會拿它當唯一的測試用牌，所以完整實作 `Game<S>` 的每個方法。
 */

export interface CounterState {
  readonly seed: number;
  readonly tick: number;
  /** 這場總共幾個 tick。 */
  readonly length: number;
  readonly scores: readonly [number, number];
}

const DEFAULT_LENGTH = 100;

const RELEASED: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};

const PRESS_A: Buttons = { ...RELEASED, a: true };

export const counterGame: Game<CounterState> = {
  id: 'counter-game',

  init(seed: number, config: GameConfig): CounterState {
    if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks <= 0) {
      throw new RangeError(`config.maxTicks 必須是正整數，收到 ${String(config.maxTicks)}`);
    }
    if (!Number.isSafeInteger(seed)) {
      throw new RangeError(`種子必須是安全整數，收到 ${String(seed)}`);
    }
    const wanted = config.params['length'] ?? DEFAULT_LENGTH;
    if (!Number.isFinite(wanted)) {
      throw new RangeError(`params.length 必須是有限的數字，收到 ${String(wanted)}`);
    }
    return {
      seed,
      tick: 0,
      // 取整後夾在 [0, maxTicks]：保證在 maxTicks 之內結束。
      length: Math.max(0, Math.min(Math.floor(wanted), config.maxTicks)),
      scores: [0, 0],
    };
  },

  step(state: CounterState, inputs: Inputs): CounterState {
    if (state.tick >= state.length) {
      return state;
    }
    return {
      ...state,
      tick: state.tick + 1,
      scores: [state.scores[0] + (inputs[0].a ? 1 : 0), state.scores[1] + (inputs[1].a ? 1 : 0)],
    };
  },

  isOver(state: CounterState): boolean {
    return state.tick >= state.length;
  },

  score(state: CounterState): readonly [number, number] {
    return state.scores;
  },

  winner(state: CounterState): Side | null {
    if (state.scores[0] > state.scores[1]) {
      return 0;
    }
    if (state.scores[1] > state.scores[0]) {
      return 1;
    }
    return null;
  },

  actions(_state: CounterState, _side: Side): readonly Buttons[] {
    return [RELEASED, PRESS_A];
  },

  evaluate(state: CounterState, side: Side): { gain: number; danger: number } {
    const other: Side = side === 0 ? 1 : 0;
    return { gain: state.scores[side] - state.scores[other], danger: 0 };
  },
};
