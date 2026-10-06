import { describe, expect, it } from 'vitest';

import type { Buttons, Game, GameConfig, Inputs, Side } from '../core/types';
import { counterGame } from '../../tests/fixtures/counter-game';
import { winRate } from './evolution';
import { HUMAN_PARAMS, humanModel } from './human-model';
import { pathfinder } from './policies/pathfinder';

/**
 * 人類模型「8% 按錯」的量法（SPEC 7.3、TEST_PLAN 3.7）。
 *
 * 規格說的是「8% 機率按錯」，意思是「每 6 個 tick 有 8% 的機率觸發一次按錯事件」。
 * 觸發之後選到什麼，規格沒有規定：這裡的實作是從 `actions()` 均勻亂選一個，
 * 所以可能又剛好選回本來要按的那個。
 *
 * 舊的量法是「與本來要按的動作不同的比率」，並要求它落在 6%–10%。
 * 那等於規定「按錯事件一定要選到別的動作」，在二選一的牌（紅心整個花色）裡
 * 就變成「一觸發就必定選到唯一的另一個動作，也就是必定選到最糟的」：
 * 每局按住約 285 tick、每 6 tick 判定一次，約 47 次判定 × 8%，幾乎必定提早放手，
 * 引信那張牌整張沒辦法玩。那是量法的瑕疵，不是遊戲設計的問題。
 *
 * 所以這裡分開量兩件事：
 * 1. 觸發率：用一個有 64 個動作的假遊戲，讓「觸發」與「結果不同」幾乎等價
 *    （觸發時選回本來那個的機率只有 1/64），量到的比率就是觸發率，約 8%。
 * 2. 觸發時選的一定是 `actions()` 裡的某一個；二選一時有效錯誤率約 4%（一半的觸發又選回對的）。
 */

/** 64 種動作：六個按鍵的所有組合。 */
function combo(index: number): Buttons {
  return {
    up: (index & 1) !== 0,
    down: (index & 2) !== 0,
    left: (index & 4) !== 0,
    right: (index & 8) !== 0,
    a: (index & 16) !== 0,
    b: (index & 32) !== 0,
  };
}

function indexOf(buttons: Buttons): number {
  return (
    (buttons.up ? 1 : 0) +
    (buttons.down ? 2 : 0) +
    (buttons.left ? 4 : 0) +
    (buttons.right ? 8 : 0) +
    (buttons.a ? 16 : 0) +
    (buttons.b ? 32 : 0)
  );
}

interface PickState {
  readonly tick: number;
  readonly picked: number;
}

/**
 * 選單遊戲：n 個動作，動作 0 永遠最好（gain 1，其他 0）。
 * 底層性格（pathfinder，深度 1）每次都會選動作 0，所以「本來要按的」就是動作 0。
 */
function pickGame(n: number): Game<PickState> {
  const table = Array.from({ length: n }, (_v, i) => combo(i));
  return {
    id: `pick-${String(n)}`,
    init: (): PickState => ({ tick: 0, picked: -1 }),
    step: (state: PickState, inputs: Inputs): PickState => ({
      tick: state.tick + 1,
      picked: indexOf(inputs[0]),
    }),
    isOver: (state: PickState): boolean => state.tick >= 40_000,
    score: (): readonly [number, number] => [0, 0],
    winner: (): Side | null => null,
    actions: (): readonly Buttons[] => table,
    evaluate: (state: PickState): { gain: number; danger: number } => ({
      gain: state.picked === 0 ? 1 : 0,
      danger: 0,
    }),
  };
}

const CONFIG: GameConfig = { maxTicks: 40_000, params: {} };
const DECISIONS = 6000;

/** 跑 36000 個 tick（每 6 個 tick 一次決定），回傳每次決定選的動作編號。 */
function decisions(game: Game<PickState>, seed: number): number[] {
  const controller = humanModel(game, seed);
  let state = game.init(1, CONFIG);
  const picks: number[] = [];
  for (let t = 0; t < DECISIONS * HUMAN_PARAMS.decideEvery; t += 1) {
    const pressed = controller.decide(state, 0, t);
    if (t % HUMAN_PARAMS.decideEvery === 0) {
      picks.push(indexOf(pressed));
    }
    state = game.step(state, [pressed, pressed]);
  }
  return picks;
}

describe('human-model 按錯（SPEC 7.3 的 8%）', () => {
  it('按錯事件的觸發率約 8%：64 個動作時，「與本來要按的不同」幾乎等於「觸發」', () => {
    const picks = decisions(pickGame(64), 77);
    expect(picks).toHaveLength(DECISIONS);
    const different = picks.filter((index) => index !== 0).length / DECISIONS;
    // 期望值 0.08 × 63/64 ≈ 7.9%。
    expect(different).toBeGreaterThan(0.065);
    expect(different).toBeLessThan(0.095);
  });

  it('觸發時選的一定是 actions() 裡的某一個，而且不只選到最糟的那個', () => {
    const picks = decisions(pickGame(64), 5);
    expect(picks.every((index) => index >= 0 && index < 64)).toBe(true);
    // 按錯時選到很多種不同的動作，不是固定一個。
    expect(new Set(picks.filter((index) => index !== 0)).size).toBeGreaterThan(20);
  });

  it('只有兩個動作時，有效錯誤率約 4%（8% 觸發裡有一半又選回對的），不是 8%', () => {
    const picks = decisions(pickGame(2), 77);
    expect(picks.every((index) => index === 0 || index === 1)).toBe(true);
    const different = picks.filter((index) => index !== 0).length / DECISIONS;
    expect(different).toBeGreaterThan(0.025);
    expect(different).toBeLessThan(0.055);
  });

  it('同一個種子完全決定性，不同的種子不一樣', () => {
    const game = pickGame(64);
    expect(decisions(game, 31)).toEqual(decisions(game, 31));
    expect(decisions(game, 31)).not.toEqual(decisions(game, 32));
  });

  it('A3、A4 走的路徑（winRate 收 LevelParams）用的是同一種按錯：二選一時有效錯誤率約 4%', () => {
    // counter-game 只有「放開／按 A」兩個動作。對手參數相同但不按錯，所以人類最多打成平手
    // （平手算 0.5）；整場 100 tick 有 17 次決定，一次都沒按錯的機率是 (1 − 有效錯誤率)^17：
    // 有效錯誤率 4% 時約 50%、勝率約 0.25；8%（必定避開）時約 24%、勝率約 0.12。
    const seeds = Array.from({ length: 600 }, (_v, i) => i);
    const config: GameConfig = { maxTicks: 100, params: {} };
    const perfect = { ...HUMAN_PARAMS, epsilon: 0 };
    const rate = winRate(counterGame, pathfinder, HUMAN_PARAMS, pathfinder, perfect, seeds, config);
    expect(rate).toBeGreaterThan(0.19);
    expect(rate).toBeLessThan(0.31);
  });
});
