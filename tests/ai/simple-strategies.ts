import { HUMAN_PARAMS } from '../../src/ai/human-model';
import { precise } from '../../src/ai/policies/precise';
import type { LevelParams, Policy } from '../../src/ai/types';
import type { Buttons, Game, Side } from '../../src/core/types';
import { actionsSpades } from '../../src/games/_spades/logic';
import { totalOf } from '../../src/games/H-5/logic';
import { actions as s10Actions } from '../../src/games/S-10/logic';

/**
 * 「簡單策略」的實作，給 DESIGN-AI-FUN 10.14 的豁免前提測試用（H-5、S-10；H-6 的在它自己的小規格）。
 * 這些策略是**豁免的證據本身**：它們只會用一條一行規則下決定，不看對手、不搜尋。
 * 動它們就等於動豁免的依據，改之前請先讀 docs/cards/H-5.md、docs/cards/S-10.md 的 10.14 一節。
 */

const named = (
  name: string,
  decide: (game: never, state: never, side: Side, tick: number, params: never) => Buttons,
): Policy => ({ name, decide }) as unknown as Policy;

/** H-5：總點數小於 T 就要牌，否則停牌（`actions` 的順序是 [停牌, 要牌]）。 */
export function h5Threshold(threshold: number): Policy {
  return named(`h5-threshold-${threshold}`, ((game: Game<never>, state: never, side: Side) => {
    const s = state as unknown as { hole: number[]; up: number[][] };
    const acts = game.actions(state, side) as Buttons[];
    if (acts.length === 1) {
      return acts[0];
    }
    const total = totalOf(s.hole[side] as number, s.up[side] as number[]);
    return total < threshold ? acts[1] : acts[0];
  }) as never);
}

const MOVES = actionsSpades();

/** S-10：移動交給精準型（只算閃躲，不看清場），場上子彈 ≥ N 顆而且清場可按時就按 b。 */
export function s10Threshold(minBullets: number): Policy {
  return named(`s10-threshold-${minBullets}`, ((
    game: Game<never>,
    state: never,
    side: Side,
    tick: number,
    params: never,
  ) => {
    const s = state as unknown as { bullets: readonly unknown[] };
    const moveGame = { ...game, actions: () => MOVES } as unknown as Game<never>;
    const move = precise.decide(moveGame, state, side, tick, params);
    const canClear = (s10Actions(state, side) as readonly Buttons[]).length > MOVES.length;
    return canClear && s.bullets.length >= minBullets ? { ...move, b: true } : move;
  }) as never);
}

/** 沒有人類限制：零反應延遲、每 tick 決定、不亂按。 */
export const NO_LIMITS: LevelParams = { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0 };
/** 人類模型的限制（A3、A4 用的那一組）。 */
export const WITH_HUMAN_LIMITS: LevelParams = HUMAN_PARAMS;
