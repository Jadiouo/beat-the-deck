import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  FOOD_COUNT,
  MOVE_EVERY,
  evaluateClubs,
  initClubsState,
  makeState,
  moveSnakes,
  orderedActions,
  refillFoods,
  steerSnake,
  winnerByScore,
} from '../_clubs/logic';
import type { ClubsState, Snake } from '../_clubs/logic';

/**
 * C-A 貪食蛇對決（SPEC 第 10 節；小規格 `docs/cards/C-A.md`）。
 * 兩條蛇、同一張地圖、搶食物：吃到食物加 1 分、長度加 1。大部分的邏輯在梅花共用的 `_clubs/logic.ts`。
 */

export { makeState };
export type { ClubsState };

export const cAGame: Game<ClubsState> = {
  id: 'C-A',

  init(seed: number, config: GameConfig): ClubsState {
    return initClubsState(seed, config);
  },

  step(state: ClubsState, inputs: Inputs): ClubsState {
    if (state.over) {
      return state;
    }
    const tick = state.tick + 1;
    let snakes: readonly [Snake, Snake] = [
      steerSnake(state.snakes[0], inputs[0]),
      steerSnake(state.snakes[1], inputs[1]),
    ];
    let foods = state.foods;
    let rng = state.rng;
    let over = false;
    let winner: Side | null = null;

    if (tick % MOVE_EVERY === 0) {
      const moved = moveSnakes(snakes, foods);
      const scored = ([0, 1] as const).map((i): Snake => ({
        ...moved.snakes[i],
        score: moved.snakes[i].score + (moved.ate[i] >= 0 ? 1 : 0),
      })) as [Snake, Snake];
      snakes = scored;
      foods = moved.foods;
      if (moved.dead[0] || moved.dead[1]) {
        // 死亡優先：只有一條死，另一條贏（不看分數）；兩條都死才比分數。
        over = true;
        winner = moved.dead[0] && moved.dead[1] ? winnerByScore(snakes) : moved.dead[0] ? 1 : 0;
      } else {
        // 重要：補食物用掉亂數，新的 RngState 一定要寫回 state。
        const refilled = refillFoods(rng, snakes, foods, FOOD_COUNT);
        foods = refilled.foods;
        rng = refilled.rng;
      }
    }

    if (!over && tick >= state.maxTicks) {
      over = true;
      winner = winnerByScore(snakes);
    }
    return { ...state, tick, snakes, foods, rng, over, winner };
  },

  isOver(state: ClubsState): boolean {
    return state.over;
  },

  score(state: ClubsState): readonly [number, number] {
    return [state.snakes[0].score, state.snakes[1].score];
  },

  winner(state: ClubsState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: ClubsState, side: Side): readonly Buttons[] {
    return orderedActions(state, side);
  },

  evaluate(state: ClubsState, side: Side): { gain: number; danger: number } {
    return evaluateClubs(state, side);
  },
};
