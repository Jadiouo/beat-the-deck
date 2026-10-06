import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { greedy } from '../../ai/policies/greedy';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import { copyButtons } from '../../core/match';
import type { Buttons, Inputs } from '../../core/types';
import { BAG_LIMIT } from '../D-2/logic';
import { bfsDistances, cell, cellX, cellY, nextCell, START_CELLS } from '../_diamonds/logic';
import {
  BEFORE_MOVE,
  CONFIG,
  deepFreeze,
  describeSharedDiamondsRules,
  IDLE,
  NONE,
  PRESS_LEFT,
  PRESS_RIGHT,
  run,
} from '../_diamonds/shared-rules.test-helpers';
import { dJGame, GUARD_RANGE, makeState, STEAL_RANGE, STEAL_TICKS } from './logic';
import type { DJState } from './logic';

/**
 * D-J 小偷的規則測試。D-2 的規則（金幣、背包、存進基地）在 `D-2/logic.test.ts` 已經測過，
 * 這裡用同一組方塊共同規則（地圖、牆、走格、重疊、補金幣、種子）確認沒有被破壞，再測偷竊本身。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 */

describeSharedDiamondsRules<DJState>({
  label: 'D-J 小偷',
  game: dJGame,
  makeState,
  pickupCells: (state) => state.coins,
  withPickups: (cells) => ({ coins: cells }),
  count: 6,
});

/** 兩個基地：0 號（人）在左下角 (0, 23)，1 號（AI）在右上角 (31, 0)。 */
const BASE_0 = START_CELLS[0];
const BASE_1 = START_CELLS[1];
/** 人貼著 AI 的基地（右上角）：(30, 0) 與基地相鄰。 */
const NEAR_BASE_1 = cell(30, 0);
/** AI 離自己的基地很遠。 */
const AWAY = cell(10, 10);

/** 0 號貼著 1 號的基地偷、1 號在遠處、1 號已經存了 3 分。下一個 tick 不是走格。 */
function stealing(overrides: Parameters<typeof makeState>[0] = {}): DJState {
  return makeState({
    players: [{ cell: NEAR_BASE_1 }, { cell: AWAY, score: 3 }],
    ...overrides,
  });
}

describe('D-J 小偷｜偷竊', () => {
  it('1. 貼著對手的基地待滿 STEAL_TICKS：對手的分數 −1、我的背包 +1，lurk 歸 0；之後可以繼續偷', () => {
    expect(STEAL_TICKS).toBe(30);
    const first = run(dJGame, stealing(), STEAL_TICKS);
    expect(first.players[1].score).toBe(2);
    expect(first.players[0].score).toBe(0);
    expect(first.bags).toEqual([1, 0]);
    expect(first.lurk).toEqual([0, 0]);
    expect(first.stolen).toEqual([1, 0]);
    const second = run(dJGame, first, STEAL_TICKS);
    expect(second.players[1].score).toBe(1);
    expect(second.bags[0]).toBe(2);
  });

  it('1. 邊界：差 1 個 tick 還沒偷（lurk 是 29），第 30 個才偷；偷之前 lurk 每個 tick 加 1', () => {
    const almost = run(dJGame, stealing(), STEAL_TICKS - 1);
    expect(almost.lurk[0]).toBe(STEAL_TICKS - 1);
    expect(almost.players[1].score).toBe(3);
    expect(almost.bags[0]).toBe(0);
    const done = dJGame.step(almost, IDLE);
    expect(done.players[1].score).toBe(2);
    expect(done.lurk[0]).toBe(0);
  });

  it('2. 邊界：站在基地那一格或相鄰（曼哈頓距離 ≤ 1）才偷得到；距離 2（含斜角）偷不到，lurk 一直是 0', () => {
    expect(STEAL_RANGE).toBe(1);
    for (const spot of [BASE_1, cell(30, 0), cell(31, 1)]) {
      const state = stealing({ players: [{ cell: spot }, { cell: AWAY, score: 3 }] });
      expect(run(dJGame, state, 1).lurk[0]).toBe(1);
    }
    for (const spot of [cell(29, 0), cell(30, 1), cell(31, 2)]) {
      const state = stealing({ players: [{ cell: spot }, { cell: AWAY, score: 3 }] });
      const after = run(dJGame, state, STEAL_TICKS + 5);
      expect(after.lurk[0]).toBe(0);
      expect(after.players[1].score).toBe(3);
    }
  });

  it('3. 守家：對手在自己基地附近（曼哈頓距離 ≤ 2）偷不了，lurk 歸 0；邊界：距離 2 擋得住，距離 3 擋不住', () => {
    expect(GUARD_RANGE).toBe(2);
    const guarded = stealing({ players: [{ cell: NEAR_BASE_1 }, { cell: cell(29, 0), score: 3 }] });
    const blocked = run(dJGame, guarded, STEAL_TICKS + 10);
    expect(blocked.lurk[0]).toBe(0);
    expect(blocked.players[1].score).toBe(3);
    const open = stealing({ players: [{ cell: NEAR_BASE_1 }, { cell: cell(28, 0), score: 3 }] });
    expect(run(dJGame, open, STEAL_TICKS).players[1].score).toBe(2);
  });

  it('3. 偷到一半對手回來守：lurk 立刻歸 0（同一個 tick 走進守家範圍，連剛好滿的那一下也被擋）', () => {
    const half = stealing({
      tick: BEFORE_MOVE,
      lurk: [STEAL_TICKS - 1, 0],
      players: [{ cell: NEAR_BASE_1 }, { cell: cell(28, 0), score: 3 }],
    });
    // 這個 tick 是走格的 tick：對手往右走到 (29, 0)（距離 2），守家成立，偷不成。
    const next = dJGame.step(half, [NONE, PRESS_RIGHT]);
    expect(next.players[1].cell).toBe(cell(29, 0));
    expect(next.lurk[0]).toBe(0);
    expect(next.players[1].score).toBe(3);
    expect(next.bags[0]).toBe(0);
    // 對照：對手不動，同一個 tick 就偷成功。
    const control = dJGame.step(half, IDLE);
    expect(control.players[1].score).toBe(2);
  });

  it('4. 離開範圍：lurk 立刻歸 0，回來要重新數', () => {
    const state = stealing({ tick: BEFORE_MOVE, lurk: [20, 0] });
    // 往左走一格：(30, 0) → (29, 0)，距離 2，離開範圍。
    const left = dJGame.step(state, [PRESS_LEFT, NONE]);
    expect(left.lurk[0]).toBe(0);
  });

  it('5. 背包滿了偷不了（lurk 不累積）；背包 2 枚可以偷到 3 枚', () => {
    const full = run(dJGame, stealing({ bags: [BAG_LIMIT, 0] }), STEAL_TICKS + 10);
    expect(full.lurk[0]).toBe(0);
    expect(full.players[1].score).toBe(3);
    expect(full.bags[0]).toBe(BAG_LIMIT);
    const room = run(dJGame, stealing({ bags: [BAG_LIMIT - 1, 0] }), STEAL_TICKS);
    expect(room.bags[0]).toBe(BAG_LIMIT);
    expect(room.players[1].score).toBe(2);
  });

  it('6. 對手存的分數是 0 偷不了；存了 1 分偷一次就沒有了，之後 lurk 不累積', () => {
    const empty = run(
      dJGame,
      stealing({ players: [{ cell: NEAR_BASE_1 }, { cell: AWAY, score: 0 }] }),
      40,
    );
    expect(empty.lurk[0]).toBe(0);
    expect(empty.bags[0]).toBe(0);
    const one = run(
      dJGame,
      stealing({ players: [{ cell: NEAR_BASE_1 }, { cell: AWAY, score: 1 }] }),
      100,
    );
    expect(one.players[1].score).toBe(0);
    expect(one.bags[0]).toBe(1);
    expect(one.stolen[0]).toBe(1);
    expect(one.lurk[0]).toBe(0);
  });

  it('7. 偷不到對手背包裡的東西：對手的背包原樣不動', () => {
    const next = run(dJGame, stealing({ bags: [0, 2] }), STEAL_TICKS);
    expect(next.bags).toEqual([1, 2]);
  });

  it('8. 贓物要走回自己的基地才算分：走進自己的基地，背包裡的（含贓物）變成分數', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [
        { cell: cell(1, 23), score: 4 },
        { cell: AWAY, score: 0 },
      ],
      bags: [2, 0],
    });
    const next = dJGame.step(state, [PRESS_LEFT, NONE]);
    expect(next.players[0].cell).toBe(BASE_0);
    expect(next.players[0].score).toBe(6);
    expect(next.bags[0]).toBe(0);
  });

  it('8. 時間到時還在背包裡的贓物不算分（但被偷的分已經扣掉了）', () => {
    const over = dJGame.step(stealing({ tick: 3599, bags: [2, 0] }), IDLE);
    expect(dJGame.isOver(over)).toBe(true);
    expect(dJGame.score(over)).toEqual([0, 3]);
  });

  it('9. 兩邊同時偷：各自用同一個 tick 結束時的快照判斷，同時套用（各 −1 分、各 +1 背包）', () => {
    const both = makeState({
      players: [
        { cell: NEAR_BASE_1, score: 3 },
        { cell: cell(1, 23), score: 3 },
      ],
    });
    const next = run(dJGame, both, STEAL_TICKS);
    expect(next.players[0].score).toBe(2);
    expect(next.players[1].score).toBe(2);
    expect(next.bags).toEqual([1, 1]);
    expect(next.stolen).toEqual([1, 1]);
  });

  it('偷竊是結算在 D-2 的 step 之後：同一個 tick 走進範圍、剛好是第一個 tick，lurk 是 1', () => {
    const state = stealing({
      tick: BEFORE_MOVE,
      players: [{ cell: cell(29, 0) }, { cell: AWAY, score: 3 }],
    });
    const next = dJGame.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(NEAR_BASE_1);
    expect(next.lurk[0]).toBe(1);
  });

  it('結束之後再 step：state 原樣不變；step 不改動傳進來的 state（含偷成功的那一次）', () => {
    const over = dJGame.step(stealing({ tick: 3599 }), IDLE);
    expect(dJGame.step(over, [PRESS_RIGHT, PRESS_LEFT])).toEqual(over);
    const frozen = deepFreeze(stealing({ lurk: [STEAL_TICKS - 1, 0] }));
    expect(() => dJGame.step(frozen, IDLE)).not.toThrow();
    expect(frozen.players[1].score).toBe(3);
  });

  it('偷竊沒有橡皮筋：領先與落後的偷法一樣（偷的結果只看對手存了幾分、背包有沒有空位）', () => {
    // 我領先 20 分與我落後 20 分，同樣的位置、同樣的對手存量：偷到的一樣多。
    const ahead = run(
      dJGame,
      makeState({
        players: [
          { cell: NEAR_BASE_1, score: 30 },
          { cell: AWAY, score: 3 },
        ],
      }),
      STEAL_TICKS * 2,
    );
    const behind = run(
      dJGame,
      makeState({
        players: [
          { cell: NEAR_BASE_1, score: 0 },
          { cell: AWAY, score: 3 },
        ],
      }),
      STEAL_TICKS * 2,
    );
    expect(ahead.stolen[0]).toBe(behind.stolen[0]);
    expect(ahead.players[1].score).toBe(behind.players[1].score);
  });
});

describe('D-J 小偷｜動作與評估', () => {
  const ACTIONS: readonly Buttons[] = [
    { up: true, down: false, left: false, right: false, a: false, b: false },
    { up: false, down: false, left: false, right: true, a: false, b: false },
    { up: false, down: true, left: false, right: false, a: false, b: false },
    { up: false, down: false, left: true, right: false, a: false, b: false },
    NONE,
  ];
  const gainsOf = (state: DJState, side: 0 | 1): number[] =>
    ACTIONS.map((action) => {
      const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
      return dJGame.evaluate(dJGame.step(state, inputs), side).gain;
    });

  it('actions：五個不同的動作，全放開排最後', () => {
    const state = makeState();
    for (const side of [0, 1] as const) {
      const actions = dJGame.actions(state, side);
      expect(actions).toHaveLength(5);
      expect(new Set(actions.map((a) => JSON.stringify(a))).size).toBe(5);
      expect(actions[4]).toEqual(NONE);
    }
  });

  it('gain：偷到一半（lurk 越高）比剛開始高，待著比走開高（貪心型會待到偷完）', () => {
    const early = stealing({ lurk: [2, 0] });
    const late = stealing({ lurk: [20, 0] });
    expect(dJGame.evaluate(late, 0).gain).toBeGreaterThan(dJGame.evaluate(early, 0).gain);
    const gains = gainsOf(stealing({ tick: 1, lurk: [10, 0] }), 0);
    expect(gains[4]).toBe(Math.max(...gains));
  });

  it('gain：對手存了分數、背包有空位時，往對手的基地走比往普通的方向走高；對手存 0 分時不會', () => {
    const rich = makeState({
      tick: 1,
      players: [{ cell: cell(20, 3) }, { cell: cell(2, 20), score: 3 }],
      coins: [cell(2, 2), cell(3, 2), cell(2, 3), cell(3, 3), cell(4, 2), cell(4, 3)],
    });
    const poor = makeState({
      tick: 1,
      players: [{ cell: cell(20, 3) }, { cell: cell(2, 20), score: 0 }],
      coins: [cell(2, 2), cell(3, 2), cell(2, 3), cell(3, 3), cell(4, 2), cell(4, 3)],
    });
    const richGains = gainsOf(rich, 0);
    const poorGains = gainsOf(poor, 0);
    // 對手基地在右上角：往右（索引 1）靠近它；金幣在左邊：往左（索引 3）。
    expect(richGains.indexOf(Math.max(...richGains))).toBe(1);
    expect(poorGains.indexOf(Math.max(...poorGains))).toBe(3);
  });

  it('gain：我的分數與對手的分數是對稱的（我被偷了比沒被偷低；對 1 號邊相反）', () => {
    const before = makeState({ players: [{ score: 3 }, { score: 0 }] });
    const after = makeState({ players: [{ score: 2 }, { score: 0 }], bags: [0, 1] });
    expect(dJGame.evaluate(after, 0).gain).toBeLessThan(dJGame.evaluate(before, 0).gain);
    expect(dJGame.evaluate(after, 1).gain).toBeGreaterThan(dJGame.evaluate(before, 1).gain);
  });

  it('danger：永遠在 0 到 1；我有存分數而對手比我先到我的基地附近時高；我在守家（距離 ≤ 2）是 0；我存 0 分時沒有被偷的危險', () => {
    const threatened = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10), score: 3 }, { cell: cell(3, 21) }],
    });
    const safe = makeState({
      tick: 1,
      players: [{ cell: cell(1, 22), score: 3 }, { cell: cell(3, 21) }],
    });
    const nothing = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10), score: 0 }, { cell: cell(3, 21) }],
    });
    const t = dJGame.evaluate(threatened, 0).danger;
    expect(t).toBeGreaterThan(0.3);
    expect(t).toBeLessThanOrEqual(1);
    expect(dJGame.evaluate(safe, 0).danger).toBeLessThan(t);
    expect(dJGame.evaluate(nothing, 0).danger).toBeLessThan(0.3);
  });

  it('已經結束的局：贏的一邊 gain 比輸的高很多；danger 是 0', () => {
    const won = dJGame.step(
      makeState({ tick: 3599, players: [{ score: 40 }, { score: 1 }] }),
      IDLE,
    );
    expect(dJGame.evaluate(won, 0).gain).toBeGreaterThan(dJGame.evaluate(won, 1).gain);
    expect(dJGame.evaluate(won, 0).danger).toBe(0);
  });
});

describe('D-J 小偷｜性格（黑箱：用 decide 看性格真的做出不同的事）', () => {
  const params = { depth: 6, seed: 1 };
  /** 這一步按下去之後，鎖定的下一步到某個格子的步數（繞牆）。 */
  function distanceAfter(state: DJState, pressed: Buttons, target: number): number {
    const after = dJGame.step(state, [pressed, NONE]);
    const there = nextCell(after.walls, after.players[0]);
    return bfsDistances(after.walls, target)[there] as number;
  }
  /**
   * 「誘敵」的局面：AI（1 號邊）已經走到人的基地旁邊、人（0 號）存了 3 分、人離自己的基地 12 格，
   * 人的身邊有一枚金幣。這時回家守是對的；去撿金幣是貪的。
   */
  const bait = makeState({
    tick: 1,
    players: [{ cell: cell(10, 13), score: 3 }, { cell: cell(6, 23) }],
    coins: [cell(11, 13), cell(20, 5), cell(21, 5), cell(22, 5), cell(23, 5), cell(24, 5)],
  });

  it('精準型：自己存了分、對手已經貼近基地時，放下身邊的金幣回家守', () => {
    const homeBefore = bfsDistances(bait.walls, BASE_0)[bait.players[0].cell] as number;
    const pressed = precise.decide(dJGame, bait, 0, 1, params);
    expect(distanceAfter(bait, pressed, BASE_0)).toBeLessThan(homeBefore);
  });

  it('貪心型：看不到 danger，同一個局面它去撿身邊的金幣，不回家', () => {
    const coin = cell(11, 13);
    const coinBefore = bfsDistances(bait.walls, coin)[bait.players[0].cell] as number;
    const pressed = greedy.decide(dJGame, bait, 0, 1, params);
    expect(distanceAfter(bait, pressed, coin)).toBeLessThan(coinBefore);
  });

  it('貪心型：對手存了 3 分、自己貼在對手基地旁邊，它不走（待著偷，不去撿金幣）', () => {
    const state = stealing({
      tick: 1,
      lurk: [5, 0],
      coins: [cell(26, 0), cell(25, 1), cell(20, 5), cell(21, 5), cell(22, 5), cell(23, 5)],
    });
    const pressed = greedy.decide(dJGame, state, 0, 1, params);
    const after = dJGame.step(state, [pressed, NONE]);
    const there = nextCell(after.walls, after.players[0]);
    expect(
      Math.abs(cellX(there) - cellX(BASE_1)) + Math.abs(cellY(there) - cellY(BASE_1)),
    ).toBeLessThanOrEqual(1);
  });
});

describe('D-J 小偷｜整場（種子 0 到 11）', () => {
  /** 兩邊用同一個性格、等級 10，跑 12 場，回傳每場的偷到分數與每人每場的分數。 */
  function play(policy: Policy): { stolenPerMatch: number; scorePerPlayer: number } {
    let stolen = 0;
    let score = 0;
    const seeds = 12;
    for (let seed = 0; seed < seeds; seed += 1) {
      const a = levelController(dJGame, policy, 10, seed);
      const b = levelController(dJGame, policy, 10, seed + 1_000_003);
      let state = dJGame.init(seed, CONFIG);
      for (let tick = 0; !dJGame.isOver(state); tick += 1) {
        state = dJGame.step(state, [
          copyButtons(a.decide(state, 0, tick)),
          copyButtons(b.decide(state, 1, tick)),
        ]);
      }
      stolen += state.stolen[0] + state.stolen[1];
      score += state.players[0].score + state.players[1].score;
    }
    return { stolenPerMatch: stolen / seeds, scorePerPlayer: score / (2 * seeds) };
  }

  it('貪心型自己會去偷（每場至少偷到 1 分），而且偷的比精準型多（指紋：貪心型不守家、愛偷）', () => {
    const g = play(greedy);
    const p = play(precise);
    expect(g.stolenPerMatch).toBeGreaterThanOrEqual(1);
    expect(g.stolenPerMatch).toBeGreaterThan(p.stolenPerMatch);
    expect(g.scorePerPlayer).toBeGreaterThan(5);
    expect(p.scorePerPlayer).toBeGreaterThan(5);
  });
});

describe('D-J 小偷｜互動強度（DESIGN-AI-FUN 2.5）', () => {
  it('把 AI 換到另一個合法位置（守在自己的基地 vs 在地圖中間），人這一邊 1 步 evaluate 的最好動作會跟著改變的局面，至少 20%', () => {
    const ACTIONS: readonly Buttons[] = [
      { up: true, down: false, left: false, right: false, a: false, b: false },
      { up: false, down: false, left: false, right: true, a: false, b: false },
      { up: false, down: true, left: false, right: false, a: false, b: false },
      { up: false, down: false, left: true, right: false, a: false, b: false },
      NONE,
    ];
    const bestFor = (state: DJState): number => {
      let best = 0;
      let bestValue = Number.NEGATIVE_INFINITY;
      ACTIONS.forEach((action, index) => {
        const value = dJGame.evaluate(dJGame.step(state, [action, NONE]), 0).gain;
        if (value > bestValue) {
          bestValue = value;
          best = index;
        }
      });
      return best;
    };
    const samples: DJState[] = [];
    for (let seed = 0; seed < 20 && samples.length < 200; seed += 1) {
      const a = levelController(dJGame, precise, 10, seed);
      const b = levelController(dJGame, precise, 10, seed + 1_000_003);
      let state = dJGame.init(seed, CONFIG);
      for (let tick = 0; !dJGame.isOver(state); tick += 1) {
        if (tick % 18 === 9 && samples.length < 200) {
          samples.push(state);
        }
        state = dJGame.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    let changed = 0;
    for (const sample of samples) {
      const home = {
        ...sample,
        players: [
          sample.players[0],
          { ...sample.players[1], cell: BASE_1, pending: -1 as const },
        ] as const,
      };
      const middle = {
        ...sample,
        players: [
          sample.players[0],
          { ...sample.players[1], cell: cell(16, 12), pending: -1 as const },
        ] as const,
      };
      if (bestFor(home as DJState) !== bestFor(middle as DJState)) {
        changed += 1;
      }
    }
    expect(samples.length).toBeGreaterThanOrEqual(150);
    expect(changed / samples.length).toBeGreaterThanOrEqual(0.2);
  });
});
