import { describe, expect, it } from 'vitest';

import type { Buttons, Game } from '../core/types';
import { counterGame } from '../../tests/fixtures/counter-game';
import type { CounterState } from '../../tests/fixtures/counter-game';
import { dAGame } from '../games/D-A/logic';
import { wrapPolicy } from './level';
import { greedy } from './policies/greedy';
import type { Policy } from './types';

/**
 * 反應延遲的語意（修正「延遲讓 AI 看到自己的舊位置」）。
 *
 * 人類的 200 毫秒反應：看到「現在」的畫面，手慢 200 毫秒才動。
 * 所以延遲的是「決定生效的時間」，不是「性格看到的世界」：
 * 性格永遠拿到現在的 state，它的決定過 reactionTicks 個 tick 才輸出。
 */

const CONFIG = { maxTicks: 400, params: { length: 400 } };
const NEUTRAL: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

function states(count: number): CounterState[] {
  const out: CounterState[] = [];
  let state = counterGame.init(1, CONFIG);
  for (let t = 0; t < count; t += 1) {
    out.push(state);
    const idle = counterGame.actions(state, 0)[0] as Buttons;
    state = counterGame.step(state, [idle, idle]);
  }
  return out;
}

/** 記錄「收到什麼 state」；回傳的動作由「被問時的 tick」決定，方便對照何時生效。 */
function tickPolicy(): { policy: Policy; seen: number[]; ticks: number[] } {
  const seen: number[] = [];
  const ticks: number[] = [];
  const policy: Policy = {
    name: 'by-tick',
    decide<S>(game: Game<S>, state: S, side: 0 | 1, tick: number): Buttons {
      seen.push((state as unknown as CounterState).tick);
      ticks.push(tick);
      const actions = game.actions(state, side);
      return actions[Math.floor(tick / 7) % actions.length] as Buttons;
    },
  };
  return { policy, seen, ticks };
}

describe('wrapPolicy 的反應延遲：延遲決定生效的時間，不延遲觀察', () => {
  it('性格看到的 state 永遠是「現在」的（自己的位置不會是舊的）', () => {
    const { policy, seen } = tickPolicy();
    const controller = wrapPolicy(
      counterGame,
      policy,
      { reactionTicks: 18, decideEvery: 1, depth: 1, epsilon: 0 },
      7,
    );
    states(60).forEach((state, t) => controller.decide(state, 0, t));
    expect(seen).toHaveLength(60);
    for (let t = 0; t < 60; t += 1) {
      expect(seen[t]).toBe(t);
    }
  });

  it('第 t 個 tick 輸出的是第 t − reactionTicks 個 tick 做的決定；之前是全放開', () => {
    const { policy } = tickPolicy();
    const reaction = 18;
    const delayed = wrapPolicy(
      counterGame,
      policy,
      { reactionTicks: reaction, decideEvery: 1, depth: 1, epsilon: 0 },
      7,
    );
    const immediate = wrapPolicy(
      counterGame,
      tickPolicy().policy,
      { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0 },
      7,
    );
    const all = states(80);
    const outDelayed = all.map((state, t) => delayed.decide(state, 0, t));
    const outNow = all.map((state, t) => immediate.decide(state, 0, t));
    for (let t = 0; t < 80; t += 1) {
      expect(outDelayed[t]).toEqual(t < reaction ? NEUTRAL : outNow[t - reaction]);
    }
    // 沒有被平凡地比成同一串：兩串真的不一樣。
    expect(outNow.some((b, t) => JSON.stringify(b) !== JSON.stringify(outDelayed[t]))).toBe(true);
  });

  it('等級 1 的節奏（reactionTicks 12、decideEvery 12）：在第 0、12、24… 個 tick 以「當下的 state」決定', () => {
    const { policy, seen, ticks } = tickPolicy();
    const controller = wrapPolicy(
      counterGame,
      policy,
      { reactionTicks: 12, decideEvery: 12, depth: 1, epsilon: 0 },
      3,
    );
    states(48).forEach((state, t) => controller.decide(state, 0, t));
    expect(ticks).toEqual([0, 12, 24, 36]);
    expect(seen).toEqual([0, 12, 24, 36]);
  });

  it('記憶體：只留還沒生效的決定，不會留整場', () => {
    const { policy } = tickPolicy();
    const controller = wrapPolicy(
      counterGame,
      policy,
      { reactionTicks: 18, decideEvery: 1, depth: 1, epsilon: 0 },
      7,
    );
    for (const [t, state] of states(300).entries()) {
      controller.decide(state, 0, t);
      expect(controller.retainedStates()).toBeLessThanOrEqual(19);
    }
  });
});

/** D-A 搶金幣：貪心型單跑 3600 個 tick（對手不動），種子 0 到 4 的平均撿幣數。 */
function meanCoins(reactionTicks: number): number {
  const idle: Buttons = NEUTRAL;
  const config = { maxTicks: 3600, params: {} };
  const seeds = [0, 1, 2, 3, 4];
  let total = 0;
  for (const seed of seeds) {
    const ai = wrapPolicy(
      dAGame,
      greedy,
      { reactionTicks, decideEvery: 1, depth: 6, epsilon: 0 },
      seed,
    );
    let state = dAGame.init(seed, config);
    for (let tick = 0; !dAGame.isOver(state); tick += 1) {
      state = dAGame.step(state, [ai.decide(state, 0, tick), idle]);
    }
    total += dAGame.score(state)[0];
  }
  return total / seeds.length;
}

describe('D-A 搶金幣：反應延遲不可以讓貪心型導航失能（懸崖）', () => {
  it('延遲 12 撿的幣不少於延遲 3 的 80%，也不少於 40 枚', () => {
    const at3 = meanCoins(3);
    const at12 = meanCoins(12);
    expect(at12).toBeGreaterThanOrEqual(at3 * 0.8);
    expect(at12).toBeGreaterThanOrEqual(40);
  });

  it('延遲 6 與 18 也沒有斷崖（都不少於延遲 3 的 70%）', () => {
    const at3 = meanCoins(3);
    expect(meanCoins(6)).toBeGreaterThanOrEqual(at3 * 0.7);
    expect(meanCoins(18)).toBeGreaterThanOrEqual(at3 * 0.7);
  });
});
