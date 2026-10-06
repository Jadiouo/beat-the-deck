import { copyButtons, playMatch } from '../../src/core/match';
import type { Buttons, Controller, Game, GameConfig, Side } from '../../src/core/types';
import { levelController, wrapPolicy } from '../../src/ai/level';
import { pathfinder } from '../../src/ai/policies/pathfinder';
import { random } from '../../src/ai/policies/random';
import type { LevelParams, Policy } from '../../src/ai/types';

/**
 * AI 行為測試的框架（TEST_PLAN 第 5 節）。
 *
 * 計時（performance.now）寫在這裡而不是 src/ai：src/ai 在純度掃描範圍內。
 * 統計測試的種子清單固定為 `0..N-1`（TEST_PLAN 第 2 節），用 `seedList(N)` 取得。
 */

/** 一場對局的預設設定：SPEC 第 9 節，3600 tick（60 tick 每秒、一分鐘）。 */
export const MATCH_CONFIG: GameConfig = { maxTicks: 3600, params: {} };

/** 等級：1 到 10 的整數，或直接給四個參數（人類模型用）。 */
export type LevelSpec = number | LevelParams;

/** 種子 0..n-1。 */
export function seedList(n: number): number[] {
  return Array.from({ length: n }, (_v, i) => i);
}

function makeController<S>(
  game: Game<S>,
  policy: Policy,
  level: LevelSpec,
  seed: number,
): Controller<S> {
  return typeof level === 'number'
    ? levelController(game, policy, level, seed)
    : wrapPolicy(game, policy, level, seed, { avoidIntended: true });
}

/**
 * 一場對局裡 A 的得分：贏 1、平手 0.5、輸 0。
 * A 坐哪一邊由種子的奇偶決定（偶數種子坐 0 號邊、奇數坐 1 號邊），所以先手或場地不對稱的偏差
 * 會在偶數與奇數種子之間互相抵消，而且同一個種子永遠同一個座位。
 * 兩邊的控制器各有自己的亂數（以種子與邊分開），不會拿到同一串骰子。
 */
function playOne<S>(
  game: Game<S>,
  policyA: Policy,
  levelA: LevelSpec,
  policyB: Policy,
  levelB: LevelSpec,
  seed: number,
  config: GameConfig,
): number {
  const sideA: Side = seed % 2 === 0 ? 0 : 1;
  const a = makeController(game, policyA, levelA, seed);
  const b = makeController(game, policyB, levelB, seed + 1_000_003);
  const result =
    sideA === 0 ? playMatch(game, seed, config, a, b) : playMatch(game, seed, config, b, a);
  return result.winner === null ? 0.5 : result.winner === sideA ? 1 : 0;
}

/**
 * A 的勝率（平手算半場）。
 * `levelA`、`levelB` 是 1 到 10 的等級（`LevelSpec` 也可以直接給參數）。
 */
export function winRate<S>(
  game: Game<S>,
  policyA: Policy,
  levelA: LevelSpec,
  policyB: Policy,
  levelB: LevelSpec,
  seeds: readonly number[],
  config: GameConfig = MATCH_CONFIG,
): number {
  if (seeds.length === 0) {
    throw new RangeError('種子清單不可以是空的');
  }
  let points = 0;
  for (const seed of seeds) {
    points += playOne(game, policyA, levelA, policyB, levelB, seed, config);
  }
  return points / seeds.length;
}

/** 「AI 進化」畫面要打的場數（SPEC 7.5）。 */
export const EVOLUTION_GAMES = 20;

/**
 * 新等級對舊等級，在這張牌上打 20 場（種子 seed..seed+19）的勝率，平手算半場。
 * 數字是真的 `playMatch` 跑出來的；同樣的參數永遠同樣的結果。
 * `policy` 預設是搜尋型；真的牌請傳那張牌的預設性格。
 */
export function evolutionReport<S>(
  game: Game<S>,
  oldLevel: number,
  newLevel: number,
  seed: number,
  policy: Policy = pathfinder,
  config: GameConfig = MATCH_CONFIG,
): number {
  const seeds = Array.from({ length: EVOLUTION_GAMES }, (_v, i) => seed + i);
  return winRate(game, policy, newLevel, policy, oldLevel, seeds, config);
}

export interface DecideTimes {
  readonly samples: number;
  readonly meanMs: number;
  readonly maxMs: number;
}

/**
 * A5 用：量 `policy` 在等級 `level` 時每次 `decide()` 花多少毫秒。
 * 每個種子打一場（對手是 level 10 的 random，坐另一邊），只計時被測的那一邊。
 * 第一場只暖機（讓 JIT 先熱起來），不算進統計。
 */
export function measureDecideTimes<S>(
  game: Game<S>,
  policy: Policy,
  level: number,
  seeds: readonly number[],
  config: GameConfig = MATCH_CONFIG,
): DecideTimes {
  let samples = 0;
  let total = 0;
  let max = 0;
  const run = (seed: number, record: boolean): void => {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const inner = levelController(game, policy, level, seed);
    const timed: Controller<S> = {
      decide(state: S, who: Side, tick: number): Buttons {
        const started = performance.now();
        const pressed = copyButtons(inner.decide(state, who, tick));
        const elapsed = performance.now() - started;
        if (record) {
          samples += 1;
          total += elapsed;
          max = Math.max(max, elapsed);
        }
        return pressed;
      },
    };
    const other = levelController(game, random, 10, seed + 1_000_003);
    if (side === 0) {
      playMatch(game, seed, config, timed, other);
    } else {
      playMatch(game, seed, config, other, timed);
    }
  };
  run(seeds[0] ?? 0, false);
  for (const seed of seeds) {
    run(seed, true);
  }
  return { samples, meanMs: samples === 0 ? 0 : total / samples, maxMs: max };
}
