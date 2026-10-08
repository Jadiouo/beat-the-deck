import { describe, expect, it } from 'vitest';

import { copyButtons } from '../../src/core/match';
import type { Buttons, Game } from '../../src/core/types';
import { MATCH_CONFIG } from '../../src/ai/evolution';
import { BOLD_TICKS, STALL_TICKS, levelController, wrapPolicy } from '../../src/ai/level';
import type { WrappedController } from '../../src/ai/level';
import type { Policy } from '../../src/ai/types';
import { precise } from '../../src/ai/policies/precise';
import { d7Game } from '../../src/games/D-7/logic';
import { dAGame } from '../../src/games/D-A/logic';
import { seedList } from './harness';

/**
 * 兩個等級 10 的精準型自己對打，不可以讓世界永久凍結（GOAL 第 1 條：站著不動的 AI 是最糟的「它在幹嘛」）。
 *
 * 根因：精準型先排除 danger 超過 0.3 的動作再挑 gain 最高的。在格子世界裡，唯一往目標前進的那一步
 * 常常 danger 剛好超過門檻（D-7：背著礦再往遠處走；D-A：走向會被對手卡位的格子），
 * 剩下的「安全」動作全是原地不動或頂著牆，於是每個 tick 都選不動；世界沒變，下一個 tick 又是同一個決定。
 * 對手也一樣，就永遠僵持。（與反應延遲無關：reactionTicks 設 0 一樣會凍結。）
 *
 * 這裡不放 D-4：它有另一種殘留的停滯（種子 4 在第 3270 tick 之後兩邊站在同一個充電站，1 步 evaluate
 * 本身就認為「不動」的 gain 最高，不是門檻擋的），放下門檻也走不出來；那屬於性格太短視，不在這個修正範圍。
 */

/** 世界的內容（不算 tick 這個計數器）。 */
function worldKey(state: unknown): string {
  return JSON.stringify(state, (key, value) => (key === 'tick' ? undefined : value));
}

/**
 * 打完一場，回傳「世界沒有前進」最長的 tick 數：每個 tick 之後的世界，都是最近 120 個 tick 內出現過的樣子。
 * 不是只比前一個 tick：頂著牆按方向鍵時，D-7 的移動計時會每 5 個 tick 來回跳一次，位置、背包、岩石都沒有動。
 */
function longestFreeze<S>(game: Game<S>, seed: number, level: number): number {
  const first = levelController(game, precise, level, seed);
  const second = levelController(game, precise, level, seed + 1_000_003);
  let state = game.init(seed, MATCH_CONFIG);
  let tick = 0;
  let run = 0;
  let longest = 0;
  const recent: string[] = [worldKey(state)];
  while (!game.isOver(state) && tick < MATCH_CONFIG.maxTicks) {
    state = game.step(state, [
      copyButtons(first.decide(state, 0, tick)),
      copyButtons(second.decide(state, 1, tick)),
    ]);
    const key = worldKey(state);
    run = recent.includes(key) ? run + 1 : 0;
    longest = Math.max(longest, run);
    recent.push(key);
    if (recent.length > 120) {
      recent.shift();
    }
    tick += 1;
  }
  return longest;
}

/** 允許的最長凍結：2 秒。人類玩家看到對手停 2 秒以上就會覺得壞掉。 */
const MAX_FREEZE_TICKS = 120;

describe('兩個等級 10 的精準型對打不會永久卡死', () => {
  const cases: ReadonlyArray<[string, Game<never>]> = [
    ['D-7 挖礦', d7Game as unknown as Game<never>],
    ['D-A', dAGame as unknown as Game<never>],
  ];

  it.each(cases)(
    '%s：8 個種子，世界連續不變的 tick 數不超過 120',
    (_name, game) => {
      const worst = seedList(8).map((seed) => longestFreeze(game, seed, 10));
      expect(Math.max(...worst), `各種子最長凍結：${worst.join(', ')}`).toBeLessThanOrEqual(
        MAX_FREEZE_TICKS,
      );
    },
    120_000,
  );
});

describe('wrapPolicy 的僵局偵測', () => {
  interface Frozen {
    readonly tick: number;
    readonly x: number;
  }
  const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
  /** 世界永遠不變（只有 tick 在走）的假遊戲。 */
  const frozenGame: Game<Frozen> = {
    id: 'frozen',
    init: () => ({ tick: 0, x: 0 }),
    step: (state) => ({ tick: state.tick + 1, x: state.x }),
    isOver: () => false,
    score: () => [0, 0],
    winner: () => null,
    actions: () => [NONE],
    evaluate: () => ({ gain: 0, danger: 0 }),
  };

  function run(ticks: number, controller: WrappedController<Frozen>): void {
    let state = frozenGame.init(0, MATCH_CONFIG);
    for (let tick = 0; tick < ticks; tick += 1) {
      controller.decide(state, 0, tick);
      state = frozenGame.step(state, [NONE, NONE]);
    }
  }

  const recorded: boolean[] = [];
  const spy: Policy = {
    name: 'spy',
    decide(_game, _state, _side, _tick, params): Buttons {
      recorded.push(params.stalled === true);
      return NONE;
    },
  };
  const everyTick = { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0 };

  it('世界連續不變 STALL_TICKS 個 tick 之後通知性格，並維持 BOLD_TICKS 個 tick', () => {
    recorded.length = 0;
    run(STALL_TICKS + BOLD_TICKS + 20, wrapPolicy(frozenGame, spy, everyTick, 1));
    expect(recorded.slice(0, STALL_TICKS).every((value) => !value)).toBe(true);
    expect(recorded[STALL_TICKS]).toBe(true);
    expect(recorded.slice(STALL_TICKS, STALL_TICKS + BOLD_TICKS).every(Boolean)).toBe(true);
  });

  it('頂著牆來回跳的內部計時（週期 5）也算僵局，不只是 state 完全不變', () => {
    const cyclic: Game<Frozen> = {
      ...frozenGame,
      step: (state) => ({ tick: state.tick + 1, x: (state.x + 1) % 5 }),
    };
    recorded.length = 0;
    const controller = wrapPolicy(cyclic, spy, everyTick, 1);
    let state = cyclic.init(0, MATCH_CONFIG);
    for (let tick = 0; tick < 300; tick += 1) {
      controller.decide(state, 0, tick);
      state = cyclic.step(state, [NONE, NONE]);
    }
    expect(recorded.slice(0, 60).some(Boolean)).toBe(false);
    expect(recorded.slice(70, 150).every(Boolean)).toBe(true);
  });

  it('世界一直在前進（x 每個 tick 都是新的值）：永遠不通知', () => {
    const moving: Game<Frozen> = {
      ...frozenGame,
      step: (state) => ({ tick: state.tick + 1, x: state.x + 1 }),
    };
    recorded.length = 0;
    const controller = wrapPolicy(moving, spy, everyTick, 1);
    let state = moving.init(0, MATCH_CONFIG);
    for (let tick = 0; tick < 400; tick += 1) {
      controller.decide(state, 0, tick);
      state = moving.step(state, [NONE, NONE]);
    }
    expect(recorded.some(Boolean)).toBe(false);
  });

  it('同一個控制器用在第二場（tick 回到 0）：偵測重設，和新建的一樣', () => {
    const controller = wrapPolicy(frozenGame, spy, everyTick, 1);
    recorded.length = 0;
    run(STALL_TICKS + 10, controller);
    const first = recorded.slice();
    recorded.length = 0;
    run(STALL_TICKS + 10, controller);
    expect(recorded).toEqual(first);
  });
});
