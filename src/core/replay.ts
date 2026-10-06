import { hashState } from './hash';
import type { Game, GameConfig, Inputs, Side } from './types';

/** 重播的結果。`finalHash` 要與原本對局的 `MatchResult.finalHash` 比對。 */
export interface ReplayResult {
  winner: Side | null;
  score: readonly [number, number];
  ticks: number;
  finalHash: string;
}

/**
 * 用種子與輸入紀錄重跑一場對局。
 *
 * 紀錄必須剛好把遊戲跑到結束：遊戲還沒結束紀錄就用完，
 * 或遊戲已經結束紀錄還有剩，都代表紀錄與遊戲對不上，丟出錯誤。
 */
export function replay<S>(
  game: Game<S>,
  seed: number,
  config: GameConfig,
  inputs: readonly Inputs[],
): ReplayResult {
  let state = game.init(seed, config);

  for (let tick = 0; tick < inputs.length; tick += 1) {
    if (game.isOver(state)) {
      throw new Error(
        `重播的紀錄太長：遊戲 ${game.id} 在第 ${tick} 個 tick 已經結束，但紀錄有 ${inputs.length} 筆`,
      );
    }
    state = game.step(state, inputs[tick]);
  }

  if (!game.isOver(state)) {
    throw new Error(`重播的紀錄太短：${inputs.length} 筆輸入用完了，遊戲 ${game.id} 還沒結束`);
  }

  return {
    winner: game.winner(state),
    score: game.score(state),
    ticks: inputs.length,
    finalHash: hashState(state),
  };
}
