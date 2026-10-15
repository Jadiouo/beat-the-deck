import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  BULLET_SPEED,
  RAIN_END_INTERVAL,
  RAIN_START_INTERVAL,
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
 * S-A 落雨（SPEC 第 10 節；小規格 `docs/cards/S-A.md`）。
 * 各自的場地、同一串子彈，被打中次數少的贏。大部分的邏輯在黑桃共用的 `_spades/logic.ts`。
 */

export type { SpadesState };

/**
 * 老闆裁定的難度旋鈕（`docs/cards/S-A.md`「延遲掃描四」）：子彈放慢、生成間隔縮短得沒那麼密。
 * 共用層 `_spades/logic.ts` 的 `BULLET_SPEED`（1.2）與 `RAIN_END_INTERVAL`（5）不動（S-2、S-3、S-Q 也在用），
 * 在這張牌自己的 `step` 裡換掉：新生成的子彈（y 恰好是 0）改成這裡的速度；間隔的縮短幅度由
 * 「餵給共用層一個放慢的 tick」換算，換算後第 3600 個 tick 的間隔是 `S_A_END_INTERVAL`。
 */
export const S_A_BULLET_SPEED = 0.7;
export const S_A_END_INTERVAL = 11;

/** 共用層的間隔是 20 線性縮短到 5；這裡縮短到 11，等於共用層的時鐘走得慢一些。 */
const RAMP_PACE = (RAIN_START_INTERVAL - S_A_END_INTERVAL) / (RAIN_START_INTERVAL - RAIN_END_INTERVAL);

/** 測試用：直接構造局面（見 `_spades/logic.ts` 的 `makeSpadesState`）。 */
export function makeState(overrides: StateOverrides = {}): SpadesState {
  return makeSpadesState('rain', overrides);
}

/** 這個 tick 剛生成的子彈（y 恰好是 0）換成這張牌的速度；其他子彈照自己的速度飛。 */
function slowed(field: SpadesState['fields'][0]): SpadesState['fields'][0] {
  if (!field.bullets.some((b) => b.y === 0 && b.vy === BULLET_SPEED)) {
    return field;
  }
  return {
    ...field,
    bullets: field.bullets.map((b) =>
      b.y === 0 && b.vy === BULLET_SPEED ? { ...b, vy: S_A_BULLET_SPEED } : b,
    ),
  };
}

export const sAGame: Game<SpadesState> = {
  id: 'S-A',

  init(seed: number, config: GameConfig): SpadesState {
    return initSpadesState('rain', seed, config);
  },

  step(state: SpadesState, inputs: Inputs): SpadesState {
    if (isOverSpades(state)) {
      return state;
    }
    const tick = state.tick + 1;
    // 共用層用 `tick` 算生成間隔；餵它放慢的時鐘，回來之後把 tick 還原成真的。
    const next = stepSpades({ ...state, tick: tick * RAMP_PACE - 1 }, inputs);
    return { ...next, tick, fields: [slowed(next.fields[0]), slowed(next.fields[1])] };
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
