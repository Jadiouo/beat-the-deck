import { copyButtons, playMatch } from '../../src/core/match';
import type { Buttons, Controller, Game, GameConfig, Side } from '../../src/core/types';
import { EVOLUTION_GAMES, MATCH_CONFIG, evolutionReport, winRate } from '../../src/ai/evolution';
import type { LevelSpec } from '../../src/ai/evolution';
import { levelController } from '../../src/ai/level';
import { random } from '../../src/ai/policies/random';
import type { Policy } from '../../src/ai/types';

/**
 * AI 行為測試的框架（TEST_PLAN 第 5 節）。
 *
 * 計時（performance.now）寫在這裡而不是 src/ai：src/ai 在純度掃描範圍內。
 * 統計測試的種子清單固定為 `0..N-1`（TEST_PLAN 第 2 節），用 `seedList(N)` 取得。
 */

/** 種子 0..n-1。 */
export function seedList(n: number): number[] {
  return Array.from({ length: n }, (_v, i) => i);
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

// winRate、evolutionReport 與常數住在 src/ai/evolution.ts（外殼也要用），這裡只是 re-export。
export { EVOLUTION_GAMES, MATCH_CONFIG, evolutionReport, winRate };
export type { LevelSpec };
