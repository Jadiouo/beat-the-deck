import { precise } from '../../ai/policies/precise';
import { createRng } from '../../core/rng';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import { actionsSpades } from '../_spades/logic';
import {
  CLEAR_CAP,
  CLEARS,
  EXPOSURE_FULL,
  H_BASE,
  H_WEIGHT,
  canClear,
  dangerOf,
  holdValue,
  s10Game,
  step,
} from './logic';
import type { S10State } from './logic';

/**
 * S-10 的劇本玩家（DESIGN-AI-FUN 5.2、10.4、10.24）。都是 Controller，只讀 state（完整資訊），
 * 不是 `logic.ts`，不在純度掃描範圍。移動的規則全部一樣（精準型、不看清場），只差「按清場的規則」，
 * 這樣兩個玩家之間的差只來自那一件事。
 *
 * - `absent`：把 AI 整個拿掉：按的規則假設沒有人會搶（h = 0），也不看 AI。
 * - `habit`：照習慣打：知道有人會搶（h = 底數），但不看 AI 現在在做什麼。
 * - `reader`：讀 AI 公開的險度（它貼著子彈的程度）：它快撐不住就會先按，我的 h 跟著升高。
 * - `sniper`：讀 AI 公開的決定規則（診斷用的上界）：如果 AI 下一個 tick 就會按，我現在先按。
 * - `feint(k)`：照習慣打，但在清場用掉 k 次之前，故意貼近子彈（又閃得開），讓 AI 讀到「你很險」。
 * - `masher`：一直按住 b，能按就按。
 * - `uniform`：每個 tick 從 `actions()` 均勻亂挑。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const MOVES = actionsSpades();
const other = (side: Side): Side => (side === 0 ? 1 : 0);

/** 沒有清場的遊戲：移動的決定一律用同一套。 */
const MOVE_GAME: Game<S10State> = { ...s10Game, actions: () => MOVES };

/** 現在按下去比再等好嗎（用 `h` 當「對手搶先按」的機率）。與 AI 的 evaluate 同一把尺。 */
export function wantsPress(state: S10State, h: number): boolean {
  if (!canClear(state)) {
    return false;
  }
  const n = Math.min(state.bullets.length, CLEAR_CAP);
  const post: S10State = { ...state, bullets: [], quiet: state.quietFor, clears: state.clears - 1 };
  return n + holdValue(post, post.clears, h) > holdValue(state, state.clears, h);
}

export type PressRule = 'absent' | 'habit' | 'reader' | 'sniper';

const hFrom = (state: S10State, side: Side): number =>
  H_BASE + H_WEIGHT * Math.min(1, state.exposure[side] / EXPOSURE_FULL);

/** 這一邊在這個局面按不按。 */
export function pressDecision(rule: PressRule, state: S10State, side: Side): boolean {
  if (rule === 'absent') {
    return wantsPress(state, 0);
  }
  if (rule === 'habit') {
    return wantsPress(state, H_BASE);
  }
  if (rule === 'reader') {
    return wantsPress(state, hFrom(state, other(side)));
  }
  // 狙擊：AI 的規則是公開的；如果 AI 下一個 tick 就會按，我現在先按。
  const next = step(state, [NONE, NONE]);
  const hAi = hFrom(state, side);
  return wantsPress(state, 0) || wantsPress(state, hAi) || wantsPress(next, hAi);
}

const asInputs = (move: Buttons, side: Side): [Buttons, Buttons] =>
  side === 0 ? [move, NONE] : [NONE, move];

export function player(rule: PressRule, seed: number): Controller<S10State> {
  return {
    decide(state: S10State, side: Side, tick: number): Buttons {
      const move = precise.decide(MOVE_GAME, state, side, tick, { depth: 1, seed });
      return pressDecision(rule, state, side) ? { ...move, b: true } : move;
    },
  };
}

/** 離最近的一顆子彈的距離（沒有子彈是無限大）。 */
function nearestBullet(state: S10State, side: Side): number {
  const p = state.players[side];
  let best = Number.POSITIVE_INFINITY;
  for (const b of state.bullets) {
    best = Math.min(best, Math.hypot(b.x - p.x, b.y - p.y));
  }
  return best;
}

/** 假裝險的時候不靠近到比這個更近（命中是 5）。 */
const FEINT_FLOOR = 6.5;

/**
 * 在清場被用掉 `times` 次之前，貼近子彈：在動態上仍然閃得開（預測路徑 danger ≤ 0.3）的動作裡，
 * 挑離最近的子彈最近、但不小於 FEINT_FLOOR 的；其餘跟 `habit` 一樣。
 */
export function feint(times: number, seed: number): Controller<S10State> {
  return {
    decide(state: S10State, side: Side, tick: number): Buttons {
      const base = precise.decide(MOVE_GAME, state, side, tick, { depth: 1, seed });
      let move = base;
      if (CLEARS - state.clears < times && state.tick >= 200 && state.bullets.length > 0) {
        let bestDistance = nearestBullet(step(state, asInputs(base, side)), side);
        if (bestDistance > FEINT_FLOOR) {
          for (const candidate of MOVES) {
            const next = step(state, asInputs(candidate, side));
            if (dangerOf(next, side) > 0.3) {
              continue;
            }
            const distance = nearestBullet(next, side);
            if (distance >= FEINT_FLOOR && distance < bestDistance) {
              bestDistance = distance;
              move = candidate;
            }
          }
        }
      }
      return pressDecision('habit', state, side) ? { ...move, b: true } : move;
    },
  };
}

/** 一直按住 b：能按就按。移動同其他玩家。 */
export function masher(seed: number): Controller<S10State> {
  return {
    decide(state: S10State, side: Side, tick: number): Buttons {
      return { ...precise.decide(MOVE_GAME, state, side, tick, { depth: 1, seed }), b: true };
    },
  };
}

/** 均勻亂決定。 */
export function uniform(seed: number, side: Side): Controller<S10State> {
  const rng = createRng(seed).fork(`s10-uniform-${side}`);
  return {
    decide(state: S10State, who: Side): Buttons {
      const list = s10Game.actions(state, who);
      return list[rng.int(list.length)] as Buttons;
    },
  };
}
