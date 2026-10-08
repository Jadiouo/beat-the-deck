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
 * 人類的 200 毫秒反應：看到「現在」的畫面、對「世界的變化」慢 200 毫秒才反應；
 * 但自己在哪裡、自己剛剛按了什麼，人是一直知道的。
 * 所以性格看到的 state ＝ reactionTicks 個 tick 以前的世界，再把「自己這段時間按過的鍵」
 * 照著重播進去（對手當作沒動）：自己是現在的，世界（對手、新出現的東西）是舊的。
 */

const CONFIG = { maxTicks: 400, params: { length: 400 } };
const NEUTRAL: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS_A: Buttons = { ...NEUTRAL, a: true };

/** 沿著 counter-game 走：第 t 個 state 就是 tick = t（兩邊都放開）。 */
function states(count: number): CounterState[] {
  const out: CounterState[] = [];
  let state = counterGame.init(1, CONFIG);
  for (let t = 0; t < count; t += 1) {
    out.push(state);
    state = counterGame.step(state, [NEUTRAL, NEUTRAL]);
  }
  return out;
}

/** 把性格看到的東西記下來。永遠按 A（自己的分數就是自己按過幾個 A）。 */
function spyPolicy(press: Buttons): { policy: Policy; seen: CounterState[] } {
  const seen: CounterState[] = [];
  const policy: Policy = {
    name: 'spy',
    decide<S>(_game: Game<S>, state: S): Buttons {
      seen.push(state as unknown as CounterState);
      return press;
    },
  };
  return { policy, seen };
}

describe('wrapPolicy 的反應延遲：自己是現在的、世界是舊的', () => {
  it('性格看到的自己（分數＝自己按過的 A）是現在的，對手（一直按 A）是 reactionTicks 以前的', () => {
    const reaction = 18;
    const { policy, seen } = spyPolicy(PRESS_A);
    const controller = wrapPolicy(
      counterGame,
      policy,
      { reactionTicks: reaction, decideEvery: 1, depth: 1, epsilon: 0 },
      7,
    );
    let state = counterGame.init(1, CONFIG);
    for (let t = 0; t < 60; t += 1) {
      const mine = controller.decide(state, 0, t);
      state = counterGame.step(state, [mine, PRESS_A]);
    }
    expect(seen).toHaveLength(60);
    for (let t = 0; t < 60; t += 1) {
      const view = seen[t] as CounterState;
      // 自己：t 個 tick 都按了 A（第 0 個 tick 之前什麼都沒按，所以是 t 次）。現在的位置，不是 t−18 的。
      expect(view.scores[0]).toBe(t);
      // 世界：對手那一邊停在 t−18（前 18 個 tick 還沒看到對手動過）。
      expect(view.scores[1]).toBe(Math.max(0, t - reaction));
    }
  });

  it('性格每次被問，拿到的都是「現在」這個 tick 的 state 往前補到現在', () => {
    const { policy, seen } = spyPolicy(PRESS_A);
    const controller = wrapPolicy(
      counterGame,
      policy,
      { reactionTicks: 12, decideEvery: 1, depth: 1, epsilon: 0 },
      7,
    );
    let state = counterGame.init(1, CONFIG);
    for (let t = 0; t < 40; t += 1) {
      state = counterGame.step(state, [controller.decide(state, 0, t), PRESS_A]);
    }
    seen.forEach((view, t) => {
      expect(view.tick).toBe(t);
    });
  });

  it('決定馬上生效（不是排隊等 reactionTicks）：輸出與 reactionTicks = 0 的一樣', () => {
    const byTick: Policy = {
      name: 'by-tick',
      decide<S>(game: Game<S>, state: S, side: 0 | 1, tick: number): Buttons {
        const actions = game.actions(state, side);
        return actions[Math.floor(tick / 7) % actions.length] as Buttons;
      },
    };
    const make = (reactionTicks: number) =>
      wrapPolicy(counterGame, byTick, { reactionTicks, decideEvery: 1, depth: 1, epsilon: 0 }, 7);
    const delayed = make(18);
    const immediate = make(0);
    const all = states(80);
    expect(all.map((state, t) => delayed.decide(state, 0, t))).toEqual(
      all.map((state, t) => immediate.decide(state, 0, t)),
    );
  });

  it('記憶體：只留 reactionTicks + 1 個 state，不會留整場', () => {
    const { policy } = spyPolicy(PRESS_A);
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
    expect(controller.retainedStates()).toBe(19);
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
