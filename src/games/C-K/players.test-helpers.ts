import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { copyButtons } from '../../core/match';
import type { Buttons, Controller, Game, GameConfig, Side } from '../../core/types';
import { decideS4 } from '../../../tests/ai/clubs-s4.shared';
import { isVisible } from '../C-4/logic';
import { cell, cellX, cellY } from '../_clubs/logic';
import type { ClubsState } from '../_clubs/logic';
import type { CKState } from './logic';

/**
 * C-K 的劇本玩家與量測工具（DESIGN-AI-FUN 10.20、10.24、10.35、10.40、10.54）。都只讀 state，不是 `logic.ts`，
 * 不在純度掃描範圍。
 *
 * 所有劇本玩家的「走路」都是梅花共用的 S4（`tests/ai/clubs-s4.shared.ts` 的 `decideS4`）：
 * 直衝最近的食物、避開兩條蛇身（尾巴不算）、不走進沒有出口的死路；沒有反應延遲、看得到現在的世界
 * （比 AI 強的是這一點，不是策略）。它「追哪些食物」依目前這一段的規則：C-3 段只追現在的正確顏色，
 * C-4 段只追視野（離蛇頭 4 格）裡的食物，其他段追全部。
 *
 * 探針 A 的三組（**定義在量之前固定**，DESIGN-AI-FUN 10.54）：C-K 這一層唯一「新的資訊」是預告（`notice` 與
 * `phases[phase + 1]`），所以三組只差知道多少：
 * - `unaware`（a）：不知道有對手。對手的蛇身不是障礙（只避自己的身體與牆）。
 * - `aware`（b）：知道有對手（S4 本身）、知道每一段的規則（C-3 看顏色、C-4 有霧），**不讀預告**。
 * - `reads`（c）：（b）加上讀預告：下一段是霧（C-4）而且在預告期間（最後 300 tick）時，只追離地圖中心最近的食物
 *   （進霧時蛇頭靠近中心，之後探索最省）；下一段是別的就照（b）。
 * 互動強度 ＝ （c）− （b）。預期接近零（老闆裁定 10.27：互動借自被包的牌）。
 */

export type ScriptKind = 'unaware' | 'aware' | 'reads';

const CENTER = cell(16, 12);

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

/** 目前這一段的 S4 食物視野。 */
function foodsFor(state: ClubsState, side: Side, reads: boolean): readonly number[] {
  const k = state as unknown as CKState;
  const id = k.phases[k.phase];
  let foods: readonly number[] = state.foods;
  if (id === 'C-3') {
    const sub = k.sub as { foodColors: readonly number[]; correct: number };
    foods = foods.filter((_food, index) => sub.foodColors[index] === sub.correct);
  } else if (id === 'C-4') {
    const head = state.snakes[side].body[0] as number;
    foods = foods.filter((food) => isVisible(head, food));
  }
  if (reads && k.notice && k.phases[k.phase + 1] === 'C-4' && foods.length > 1) {
    let best = foods[0] as number;
    for (const food of foods) {
      if (manhattan(food, CENTER) < manhattan(best, CENTER)) {
        best = food;
      }
    }
    return [best];
  }
  return foods;
}

/** 純 S4（不讀預告、不看自己是哪一種），給「簡單劇本有沒有支配策略」用。 */
export function s4Controller(kind: ScriptKind = 'aware', delay = 0): Controller<CKState> {
  const history: CKState[] = [];
  return {
    decide(state: CKState, side: Side, tick: number): Buttons {
      history[tick] = state;
      let seen: CKState = state;
      if (delay > 0) {
        // 延遲版：食物與對手用 `delay` tick 前的，自己用現在的（與 `clubs-s4.shared.ts` 相同）。
        const old = history[Math.max(0, tick - delay)] as CKState;
        const other = side === 0 ? 1 : 0;
        const snakes: [CKState['snakes'][0], CKState['snakes'][1]] = [
          state.snakes[0],
          state.snakes[1],
        ];
        snakes[other] = old.snakes[other];
        seen = { ...state, foods: old.foods, snakes };
      }
      if (kind === 'unaware') {
        const other = side === 0 ? 1 : 0;
        const snakes: [CKState['snakes'][0], CKState['snakes'][1]] = [
          seen.snakes[0],
          seen.snakes[1],
        ];
        snakes[other] = { ...snakes[other], body: [] };
        seen = { ...seen, snakes };
      }
      const view = {
        foods: (s: ClubsState, who: Side) => foodsFor(s, who, kind === 'reads'),
        extraBlocked: () => [],
      };
      return decideS4(view, seen, side);
    },
  };
}

/** 一個什麼都不吃、只求不死的玩家：S4 的走法，但食物視野是空的（直走，前方有障礙才轉）。 */
export function survivorController(): Controller<CKState> {
  const view = { foods: () => [], extraBlocked: () => [] };
  return {
    decide(state: CKState, side: Side): Buttons {
      return decideS4(view, state, side);
    },
  };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** 第 10 百分位（升冪排序後取索引 floor(n/10)）。 */
export function p10(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 10)] as number;
}

export interface PlayedGame {
  readonly winner: Side | null;
  readonly ticks: number;
  readonly final: CKState;
}

/** 跑一場，`onTick` 在每個 tick 之後被呼叫。 */
export function playPair(
  game: Game<CKState>,
  seed: number,
  config: GameConfig,
  c0: Controller<CKState>,
  c1: Controller<CKState>,
  onTick?: (after: CKState, before: CKState) => void,
): PlayedGame {
  let state = game.init(seed, config);
  let tick = 0;
  while (!game.isOver(state)) {
    const before = state;
    state = game.step(state, [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ]);
    tick += 1;
    onTick?.(state, before);
  }
  return { winner: game.winner(state), ticks: state.tick, final: state };
}

/**
 * 劇本玩家對搜尋型的勝率（平手算半場）。偶數種子坐 0 號邊、奇數坐 1 號邊；
 * AI 的亂數種子是 `seed + 1_000_003`（與 `winRate` 同一個約定）。
 */
export function scriptedWinRate(
  game: Game<CKState>,
  make: () => Controller<CKState>,
  seeds: readonly number[],
  config: GameConfig,
  aiLevel = 10,
): number {
  let points = 0;
  for (const seed of seeds) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const player = make();
    const ai = levelController(game, pathfinder, aiLevel, seed + 1_000_003);
    const result = playPair(game, seed, config, side === 0 ? player : ai, side === 0 ? ai : player);
    points += result.winner === null ? 0.5 : result.winner === side ? 1 : 0;
  }
  return points / seeds.length;
}
