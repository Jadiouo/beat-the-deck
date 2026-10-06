import { hashState } from './hash';
import type { Buttons, Controller, Game, GameConfig, Inputs, Side } from './types';

/** 一場對局的結果（SPEC 第 6 節）。 */
export interface MatchResult {
  winner: Side | null;
  score: readonly [number, number];
  ticks: number;
  finalHash: string;
  inputs: Inputs[]; // 重播用
}

/** 複製一組按鍵，避免控制器之後改動它回傳的物件而污染紀錄。 */
export function copyButtons(buttons: Buttons): Buttons {
  return {
    up: buttons.up,
    down: buttons.down,
    left: buttons.left,
    right: buttons.right,
    a: buttons.a,
    b: buttons.b,
  };
}

/** `maxTicks` 必須是正整數，否則「走了 maxTicks 步」的檢查會失效（NaN、Infinity）。 */
export function assertMaxTicks(maxTicks: number): void {
  if (!Number.isSafeInteger(maxTicks) || maxTicks <= 0) {
    throw new RangeError(`config.maxTicks 必須是正整數，收到 ${String(maxTicks)}`);
  }
}

/**
 * 不開畫面跑完一場對局。
 *
 * 每個 tick 先問兩個控制器（都看同一個 state），再呼叫一次 `step`。
 * `isOver` 一變成 true 就立刻停。如果已經走了 `maxTicks` 步還沒結束，
 * 代表遊戲違反契約（SPEC 5.1「一定會結束」），丟出錯誤而不是默默回傳。
 */
export function playMatch<S>(
  game: Game<S>,
  seed: number,
  config: GameConfig,
  c0: Controller<S>,
  c1: Controller<S>,
): MatchResult {
  assertMaxTicks(config.maxTicks);
  let state = game.init(seed, config);
  const inputs: Inputs[] = [];

  while (!game.isOver(state)) {
    const tick = inputs.length;
    if (tick >= config.maxTicks) {
      throw new Error(
        `遊戲 ${game.id} 違反契約：走了 maxTicks（${config.maxTicks}）個 tick 之後 isOver 仍然是 false`,
      );
    }
    const tickInputs: Inputs = [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ];
    inputs.push(tickInputs);
    state = game.step(state, tickInputs);
  }

  return {
    winner: game.winner(state),
    score: game.score(state),
    ticks: inputs.length,
    finalHash: hashState(state),
    inputs,
  };
}
