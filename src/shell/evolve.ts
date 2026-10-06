import { EVOLUTION_GAMES, MATCH_CONFIG, winRate } from '../ai/evolution';
import type { Policy } from '../ai/types';
import type { Game, GameConfig } from '../core/types';

/**
 * 「AI 進化」畫面的數字（SPEC 7.5）：新舊兩個等級的 AI 在這張牌上對打 20 場。
 *
 * 為什麼一次只跑一場：`evolutionReport` 一口氣跑 20 場，對搜尋型的牌在高等級很慢
 * （C-A 實測：1→2 約 22 毫秒，8→9 約 1.5 秒，9→10 約 2.6 秒），在一個 frame 裡跑會讓畫面凍住好幾秒。
 * 所以外殼把 20 場分散到多個 frame，每次呼叫 `runNext()` 只跑一場，畫面逐場累加勝率與進度條。
 * 數字仍然是真的：每一場用的就是 `winRate`（種子 seed+i，跟 `evolutionReport` 完全同一份實作與種子），
 * 20 場加總之後與 `evolutionReport` 逐位相同（`evolve.test.ts` 驗證）。
 */
export interface EvolutionRun {
  readonly total: number;
  /** 已經打完幾場。 */
  played(): number;
  /** 新等級目前累計的得分（贏 1、平手 0.5、輸 0）。 */
  points(): number;
  done(): boolean;
  /** 目前的勝率；一場都還沒打時是 0。 */
  rate(): number;
  /** 打一場。已經 20 場就什麼都不做。 */
  runNext(): void;
}

export function createEvolutionRun<S>(
  game: Game<S>,
  policy: Policy,
  oldLevel: number,
  newLevel: number,
  seed: number,
  config: GameConfig = MATCH_CONFIG,
): EvolutionRun {
  let played = 0;
  let points = 0;

  return {
    total: EVOLUTION_GAMES,
    played: () => played,
    points: () => points,
    done: () => played >= EVOLUTION_GAMES,
    rate: () => (played === 0 ? 0 : points / played),
    runNext(): void {
      if (played >= EVOLUTION_GAMES) {
        return;
      }
      // winRate 對單一種子回傳 1、0.5 或 0。
      points += winRate(game, policy, newLevel, policy, oldLevel, [seed + played], config);
      played += 1;
    },
  };
}
