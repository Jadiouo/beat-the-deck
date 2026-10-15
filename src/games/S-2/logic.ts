import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  AIMED_INTERVAL,
  FIXED_RAIN_INTERVAL,
  actionsSpades,
  evaluateSpades,
  initSpadesState,
  isOverSpades,
  makeSpadesState,
  scoreSpades,
  stepSpades,
  winnerSpades,
} from '../_spades/logic';
import type { SpadesState, StateOverrides } from '../_spades/logic';

/**
 * S-2 瞄準彈（SPEC 第 10 節；小規格 `docs/cards/S-2.md`）。
 * 落雨的子彈固定每 15 tick 一顆，另外每 45 tick 一顆瞄準玩家的子彈。大部分的邏輯在黑桃共用的 `_spades/logic.ts`。
 */

export type { SpadesState };

/**
 * 老闆裁定的難度旋鈕（`docs/cards/S-2.md`「延遲掃描四」）：子彈放疏。一般子彈每 30 tick 一顆（原本 15）、
 * 瞄準彈每 60 tick 一顆（原本 45）；速度不動（量測：速度在這張牌上沒有作用，見小規格）。
 * 共用層 `_spades/logic.ts` 把生成時刻寫死成 `tick % 15`、`tick % 45`（S-3、S-Q 也在用，不動），
 * 這裡在自己的 `step` 裡把真實的 tick 換成一個會在我們要的時刻生成的 tick 餵進去，回來之後還原。
 */
export const S2_RAIN_INTERVAL = 30;
export const S2_AIMED_INTERVAL = 60;

/** 真實第 `tick` 個 tick 要餵給共用層的 tick：兩種都生成餵 45、只生成一般子彈餵 15、都不生成餵 1。 */
function spawnClock(tick: number): number {
  if (tick % S2_AIMED_INTERVAL === 0) {
    return AIMED_INTERVAL;
  }
  return tick % S2_RAIN_INTERVAL === 0 ? FIXED_RAIN_INTERVAL : 1;
}

/** 測試用：直接構造局面（見 `_spades/logic.ts` 的 `makeSpadesState`）。 */
export function makeState(overrides: StateOverrides = {}): SpadesState {
  return makeSpadesState('aimed', overrides);
}

export const s2Game: Game<SpadesState> = {
  id: 'S-2',

  init(seed: number, config: GameConfig): SpadesState {
    return initSpadesState('aimed', seed, config);
  },

  step(state: SpadesState, inputs: Inputs): SpadesState {
    if (isOverSpades(state)) {
      return state;
    }
    const tick = state.tick + 1;
    const next = stepSpades({ ...state, tick: spawnClock(tick) - 1 }, inputs);
    return { ...next, tick };
  },

  isOver(state: SpadesState): boolean {
    return isOverSpades(state);
  },

  score(state: SpadesState): readonly [number, number] {
    return scoreSpades(state);
  },

  winner(state: SpadesState): Side | null {
    return winnerSpades(state);
  },

  actions(_state: SpadesState, _side: Side): readonly Buttons[] {
    return actionsSpades();
  },

  evaluate(state: SpadesState, side: Side): { gain: number; danger: number } {
    return evaluateSpades(state, side);
  },
};
