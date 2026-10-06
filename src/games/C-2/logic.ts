import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  evaluateClubs,
  initClubsState,
  makeState as makeClubsState,
  orderedActions,
  stepClubs,
} from '../_clubs/logic';
import type { ClubsState, StateOverrides } from '../_clubs/logic';

/**
 * C-2 旋轉的房間（SPEC 第 10 節；小規格 `docs/cards/C-2.md`）。
 * 規則與 C-A 完全相同；多的是兩個由 tick 算出來的欄位，給畫面與外殼讀：
 * `viewRotation`（人這一邊的畫面轉了幾個 90 度）與 `warning`（旋轉前 60 tick）。
 * 旋轉是畫面層的效果：`step` 收到的輸入是世界方向，完全不讀這兩個欄位；
 * `actions` 與 `evaluate` 也不讀，所以 AI 不受旋轉影響。
 */

/** 每幾個 tick 旋轉一次。 */
export const ROTATE_EVERY = 600;
/** 旋轉之前幾個 tick 開始警告（邊框閃爍）。 */
export const WARNING_TICKS = 60;

export type ViewRotation = 0 | 1 | 2 | 3;

export interface C2State extends ClubsState {
  /** 人那一側的畫面順時針轉了幾個 90 度；由 `tick` 算出來。 */
  readonly viewRotation: ViewRotation;
  /** 旋轉前 60 個 tick 是 true（邊框閃爍）。 */
  readonly warning: boolean;
}

/** 第 `tick` 個 tick 的旋轉：每 600 tick 加 1，每 2400 tick 循環。 */
export function viewRotationAt(tick: number): ViewRotation {
  return (Math.floor(tick / ROTATE_EVERY) % 4) as ViewRotation;
}

/** 第 `tick` 個 tick 是不是在旋轉前的警告期（每個週期的最後 60 個 tick）。 */
export function warningAt(tick: number): boolean {
  return tick % ROTATE_EVERY >= ROTATE_EVERY - WARNING_TICKS;
}

export interface C2Overrides extends StateOverrides {
  readonly viewRotation?: ViewRotation;
  readonly warning?: boolean;
}

/** 測試輔助：直接構造局面。`viewRotation`、`warning` 沒給時由 `tick` 推出來。 */
export function makeState(overrides: C2Overrides = {}): C2State {
  const base = makeClubsState(overrides);
  return {
    ...base,
    viewRotation: overrides.viewRotation ?? viewRotationAt(base.tick),
    warning: overrides.warning ?? warningAt(base.tick),
  };
}

export const c2Game: Game<C2State> = {
  id: 'C-2',

  init(seed: number, config: GameConfig): C2State {
    const base = initClubsState(seed, config);
    return { ...base, viewRotation: viewRotationAt(0), warning: warningAt(0) };
  },

  step(state: C2State, inputs: Inputs): C2State {
    if (state.over) {
      return state;
    }
    const next = stepClubs(state, inputs);
    return { ...next, viewRotation: viewRotationAt(next.tick), warning: warningAt(next.tick) };
  },

  isOver(state: C2State): boolean {
    return state.over;
  },

  score(state: C2State): readonly [number, number] {
    return [state.snakes[0].score, state.snakes[1].score];
  },

  winner(state: C2State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: C2State, side: Side): readonly Buttons[] {
    return orderedActions(state, side);
  },

  evaluate(state: C2State, side: Side): { gain: number; danger: number } {
    return evaluateClubs(state, side);
  },
};
