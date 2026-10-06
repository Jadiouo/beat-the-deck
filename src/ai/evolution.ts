import { playMatch } from '../core/match';
import type { Controller, Game, GameConfig, Side } from '../core/types';
import { levelController, wrapPolicy } from './level';
import { pathfinder } from './policies/pathfinder';
import type { LevelParams, Policy } from './types';

/**
 * 對打勝率與「AI 進化」畫面的數字（SPEC 7.5、TEST_PLAN 5.3）。
 *
 * 這個檔案放在 src/ai，外殼可以直接 import；測試框架（tests/ai/harness.ts）也從這裡 re-export，
 * 全專案只有這一份實作。這裡是模擬層：亂數只來自種子，沒有時間，也不碰任何瀏覽器物件。
 * 計時寫在呼叫端（測試檔）。
 */

/** 一場對局的預設設定：SPEC 第 9 節，3600 tick（60 tick 每秒、一分鐘）。 */
export const MATCH_CONFIG: GameConfig = { maxTicks: 3600, params: {} };

/** 等級：1 到 10 的整數，或直接給四個參數（人類模型用）。 */
export type LevelSpec = number | LevelParams;

function makeController<S>(
  game: Game<S>,
  policy: Policy,
  level: LevelSpec,
  seed: number,
): Controller<S> {
  return typeof level === 'number'
    ? levelController(game, policy, level, seed)
    : wrapPolicy(game, policy, level, seed);
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
