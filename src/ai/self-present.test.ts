import { describe, expect, it } from 'vitest';

import { deepFreeze } from '../../tests/contract/freeze';
import type { Buttons, Game, Inputs, Side } from '../core/types';
import { registry } from '../games/registry';
import type { GameWithSelfFromPresent } from '../games/types';
import { wrapPolicy } from './level';
import type { Policy } from './types';

/**
 * 「外力造成的自身位移無法用重播重現」的選配 hook（`selfFromPresent`，SPEC 7.2）。
 *
 * `wrapPolicy` 的延遲模型：世界是 reactionTicks 以前的、自己用 `game.step` 重播自己的輸入到現在（對手當作沒動）。
 * 重播只含「自己的輸入」，所以被對手推開、被拉走這類外力造成的位移重現不出來。
 * 牌可以宣告 `selfFromPresent(replayed, present, side)`：把重播結果裡「自己」的欄位換成真實的現在。
 * 沒宣告的牌一個 tick 都不變。這裡用一個玩具遊戲測語意：
 *   - 位置 x：左右鍵 ∓1；
 *   - 外力：對手按 a 的那個 tick，我被往右推 5（重播時對手當作放開，所以重播不出來）。
 */

interface ToyState {
  readonly tick: number;
  readonly xs: readonly [number, number];
}

const NEUTRAL: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const RIGHT: Buttons = { ...NEUTRAL, right: true };
const PUSH: Buttons = { ...NEUTRAL, a: true };

function toyStep(state: ToyState, inputs: Inputs): ToyState {
  const move = (b: Buttons): number => (b.right ? 1 : 0) - (b.left ? 1 : 0);
  const shove = (b: Buttons): number => (b.a ? 5 : 0);
  return {
    tick: state.tick + 1,
    xs: [
      state.xs[0] + move(inputs[0]) + shove(inputs[1]),
      state.xs[1] + move(inputs[1]) + shove(inputs[0]),
    ],
  };
}

const toyBase: Game<ToyState> = {
  id: 'toy-shove',
  init: () => ({ tick: 0, xs: [0, 0] }),
  step: toyStep,
  isOver: (s) => s.tick >= 400,
  score: (s) => s.xs,
  winner: () => null,
  actions: () => [NEUTRAL, RIGHT, PUSH],
  evaluate: () => ({ gain: 0, danger: 0 }),
};

const calls: { replayed: ToyState; present: ToyState; side: Side }[] = [];

/** 宣告 hook 的版本：自己的 x 從真實的現在取，其餘（對手、tick）維持重播的結果。 */
const toyDeclared: GameWithSelfFromPresent<ToyState> = {
  ...toyBase,
  selfFromPresent(replayed, present, side) {
    calls.push({ replayed, present, side });
    const xs: [number, number] = [replayed.xs[0], replayed.xs[1]];
    xs[side] = present.xs[side];
    return { ...replayed, xs };
  },
};

function spy(): { policy: Policy; seen: ToyState[] } {
  const seen: ToyState[] = [];
  const policy: Policy = {
    name: 'spy',
    decide<S>(_game: Game<S>, state: S): Buttons {
      seen.push(state as unknown as ToyState);
      return RIGHT;
    },
  };
  return { policy, seen };
}

/** 0 號邊是被測的（永遠按右），1 號邊每個 tick 都按 a（每個 tick 把 0 號邊往右推 5）。 */
function play(game: Game<ToyState>, reactionTicks: number, ticks = 40) {
  const { policy, seen } = spy();
  const controller = wrapPolicy(game, policy, { reactionTicks, decideEvery: 1, depth: 1, epsilon: 0 }, 3);
  const presents: ToyState[] = [];
  let state = game.init(0, { maxTicks: 400, params: {} });
  for (let t = 0; t < ticks; t += 1) {
    presents.push(state);
    state = game.step(state, [controller.decide(state, 0, t), PUSH]);
  }
  return { seen, presents };
}

describe('selfFromPresent：宣告的牌，自己取真實的現在', () => {
  it('沒宣告：自己的 x 是重播的結果，漏掉被推的位移（這是病）', () => {
    const { seen, presents } = play(toyBase, 12);
    // 第 30 個 tick：真實的 x 每 tick 被推 5 再走 1；重播時對手放開，只剩走的
    expect((presents[30] as ToyState).xs[0]).toBeGreaterThan((seen[30] as ToyState).xs[0] + 50);
  });

  it('宣告了：性格看到的自己（x）等於真實的現在', () => {
    const { seen, presents } = play(toyDeclared, 12);
    for (let t = 0; t < 40; t += 1) {
      expect((seen[t] as ToyState).xs[0], `tick ${t}`).toBe((presents[t] as ToyState).xs[0]);
    }
  });

  it('宣告了：對手仍然是舊的（reactionTicks 以前），tick 是現在的', () => {
    const { seen, presents } = play(toyDeclared, 12);
    for (let t = 12; t < 40; t += 1) {
      expect((seen[t] as ToyState).xs[1], `tick ${t}`).toBe((presents[t - 12] as ToyState).xs[1]);
      expect((seen[t] as ToyState).tick).toBe(t);
    }
  });

  it('hook 拿到的 present 是真實的 state（不是重播的），side 是被測的那一邊，而且不改動它', () => {
    calls.length = 0;
    const { policy } = spy();
    const controller = wrapPolicy(toyDeclared, policy, { reactionTicks: 12, decideEvery: 1, depth: 1, epsilon: 0 }, 3);
    let state = toyDeclared.init(0, { maxTicks: 400, params: {} });
    for (let t = 0; t < 20; t += 1) {
      deepFreeze(state);
      controller.decide(state, 1, t);
      state = toyDeclared.step(state, [PUSH, RIGHT]);
    }
    expect(calls.length).toBe(20);
    for (const call of calls) {
      expect(call.side).toBe(1);
    }
    expect(calls[19]?.present.tick).toBe(19);
  });

  it('reactionTicks = 0：性格直接看到真實的 state，hook 不會被呼叫', () => {
    calls.length = 0;
    const { seen, presents } = play(toyDeclared, 0);
    expect(calls.length).toBe(0);
    for (let t = 0; t < 40; t += 1) {
      expect(seen[t]).toBe(presents[t]);
    }
  });

  it('可重播：同樣的輸入跑兩次，性格看到的完全相同', () => {
    const a = play(toyDeclared, 12);
    const b = play(toyDeclared, 12);
    expect(a.seen).toEqual(b.seen);
  });
});

describe('selfFromPresent：沒宣告的牌一個 tick 都不變', () => {
  it('wrapPolicy 只在遊戲宣告了 hook 時才碰它：沒有 hook 的遊戲，性格看到的就是舊的重播（逐 tick 與手算的重播相同）', () => {
    const { seen } = play(toyBase, 12);
    // 手算：世界 = 12 個 tick 前的 state，自己用自己的輸出（永遠按右）重播，對手放開
    const world: ToyState[] = [];
    let s = toyBase.init(0, { maxTicks: 400, params: {} });
    for (let t = 0; t < 40; t += 1) {
      world.push(s);
      s = toyStep(s, [RIGHT, PUSH]);
    }
    for (let t = 0; t < 40; t += 1) {
      let replay = world[Math.max(0, t - 12)] as ToyState;
      const from = Math.max(0, t - 12);
      for (let k = from; k < t; k += 1) {
        replay = toyStep(replay, [RIGHT, NEUTRAL]);
      }
      expect(seen[t], `tick ${t}`).toEqual(replay);
    }
  });
});

describe('selfFromPresent：核准宣告的牌只有 S-8 與 JK-B', () => {
  /**
   * 宣告要先有數字（DESIGN-AI-FUN 10.56）。核准的牌與數字：
   * - S-8：兩個人互相是實心的，重播裡「自己」的位置被對手擠開之後完全不一樣（擠的劇本 97.5% → 20.0%，見 S-8 小規格）。
   * - JK-B：重播把對手當作放開、停在 12 個 tick 以前的位置，所以我的點在重播裡會撞到（甚至推到）一個真實世界裡早就走開的對手。
   *   量法：20 場（種子 0..19）、每個決定比較「性格看到的自己」與真實的現在，AI 等級 10（reactionTicks 12）：
   *   位置不同的決定占比 L10 對 L10 14.05%（10,119／72,000）、對 chase 22.52%、對 stalk 59.78%、對 b 16.84%；
   *   推擠冷卻不同 8.57%／10.03%／28.36%／8.19%。（`docs/cards/JK-B.md`「wrapPolicy 的自己」一節）
   * 要宣告第三張牌，先在小規格裡附上同一種量測。
   */
  const APPROVED = ['JK-B', 'S-8'];

  it('登記表裡宣告 selfFromPresent 的牌只有核准的（其他牌一行都不改，行為一個 tick 都不能變）', () => {
    const declared = registry
      .filter((entry) => typeof (entry.game as Partial<GameWithSelfFromPresent<unknown>>).selfFromPresent === 'function')
      .map((entry) => entry.id)
      .sort();
    expect(declared).toEqual(APPROVED.filter((id) => registry.some((e) => e.id === id)).sort());
  });
});
