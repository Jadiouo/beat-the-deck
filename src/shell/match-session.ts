import { hashState } from '../core/hash';
import { copyButtons } from '../core/match';
import type { Buttons, Controller, Game, GameConfig, Inputs } from '../core/types';
import { rotateButtons } from './input';

/**
 * 對局的推進（SPEC 第 6 節）：外殼的主迴圈每個 tick 呼叫一次 `advance()`，
 * 它做的事與 `playMatch` 的迴圈本體一模一樣——先問兩個控制器、記下輸入、呼叫一次 `step`。
 * 所以任何一場在瀏覽器裡打的對局，都可以用紀錄的輸入與種子完整重播（`replay.ts`）。
 */

/**
 * 玩家這一側的畫面轉了幾個 90 度。只有 C-2 的 state 有 `viewRotation`，其他牌一律是 0。
 * （外殼讀 state 的這一個欄位，是為了把輸入轉回世界方向；遊戲邏輯本身完全不讀它。）
 */
export function viewRotationOf(state: unknown): 0 | 1 | 2 | 3 {
  if (typeof state === 'object' && state !== null && 'viewRotation' in state) {
    const value = (state as { viewRotation: unknown }).viewRotation;
    if (value === 1 || value === 2 || value === 3) {
      return value;
    }
  }
  return 0;
}

/**
 * 人的控制器：讀「畫面上的按鍵」，依 state 的 `viewRotation` 轉回世界方向再交給 `step`。
 * C-2 的 `step` 收到的是世界方向（畫面轉了，輸入還是世界的上下左右），轉換是外殼的責任。
 * 紀錄的輸入是轉換之後的，所以重播不需要知道當時畫面轉到哪裡。
 */
export function screenController<S>(read: () => Buttons): Controller<S> {
  return {
    decide(state: S): Buttons {
      return rotateButtons(read(), viewRotationOf(state));
    },
  };
}

export interface MatchSession<S> {
  readonly game: Game<S>;
  readonly seed: number;
  readonly config: GameConfig;
  state(): S;
  /** 已經推進了幾個 tick。 */
  tick(): number;
  /** 到目前為止的輸入紀錄（重播用）。 */
  inputs(): readonly Inputs[];
  isOver(): boolean;
  /** 推進一個 tick；已經結束就什麼都不做。 */
  advance(): void;
}

export function createMatchSession<S>(
  game: Game<S>,
  seed: number,
  config: GameConfig,
  c0: Controller<S>,
  c1: Controller<S>,
): MatchSession<S> {
  let state = game.init(seed, config);
  const log: Inputs[] = [];

  return {
    game,
    seed,
    config,
    state: () => state,
    tick: () => log.length,
    inputs: () => log,
    isOver: () => game.isOver(state),
    advance(): void {
      if (game.isOver(state) || log.length >= config.maxTicks) {
        return;
      }
      const tick = log.length;
      const tickInputs: Inputs = [
        copyButtons(c0.decide(state, 0, tick)),
        copyButtons(c1.decide(state, 1, tick)),
      ];
      log.push(tickInputs);
      state = game.step(state, tickInputs);
    },
  };
}

export interface ReplaySession<S> {
  state(): S;
  tick(): number;
  isOver(): boolean;
  advance(): void;
  /** 目前 state 的雜湊，重播結束後與原本對局的 `finalHash` 比對。 */
  hash(): string;
}

/** 重播：用種子與紀錄的輸入重跑，不問任何控制器。紀錄用完（或遊戲結束）就停。 */
export function createReplaySession<S>(
  game: Game<S>,
  seed: number,
  config: GameConfig,
  inputs: readonly Inputs[],
): ReplaySession<S> {
  let state = game.init(seed, config);
  let tick = 0;
  const finished = (): boolean => game.isOver(state) || tick >= inputs.length;

  return {
    state: () => state,
    tick: () => tick,
    isOver: finished,
    advance(): void {
      if (finished()) {
        return;
      }
      state = game.step(state, inputs[tick] as Inputs);
      tick += 1;
    },
    hash: () => hashState(state),
  };
}
