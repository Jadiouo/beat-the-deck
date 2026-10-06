import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { greedy } from '../../ai/policies/greedy';
import { rngStateFor } from '../../core/rng';
import type { Inputs } from '../../core/types';
import { cell, MOVE_EVERY } from '../_diamonds/logic';
import {
  CONFIG,
  describeSharedDiamondsRules,
  IDLE,
  NONE,
  PRESS_DOWN,
  PRESS_LEFT,
  PRESS_RIGHT,
  PRESS_UP,
  run,
} from '../_diamonds/shared-rules.test-helpers';
import { d3Game, GEM_COUNT, gemValue, LIFETIME, makeState } from './logic';
import type { D3State, Gem } from './logic';

/**
 * D-3 會貶值的寶石的規則測試（TEST_PLAN 第 6 節 D-3 的 7 條）。
 * 第 7 條「D-A 的 1 到 3、6 成立」：用 `_diamonds/shared-rules.test-helpers.ts` 與 D-A 共用同一組測試。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 */

describeSharedDiamondsRules<D3State>({
  label: 'D-3 會貶值的寶石',
  game: d3Game,
  makeState,
  pickupCells: (state) => state.gems.map((gem) => gem.cell),
  withPickups: (cells) => ({ gems: cells.map((c): Gem => ({ cell: c, born: 0 })) }),
  count: GEM_COUNT,
});

const AWAY: Gem[] = [
  { cell: cell(15, 10), born: 0 },
  { cell: cell(16, 10), born: 0 },
  { cell: cell(17, 10), born: 0 },
  { cell: cell(18, 10), born: 0 },
];

/** 人在 (5, 5)、一顆寶石在 (6, 5)（出生 tick 自己給）、其他寶石離得很遠；`tick` 是這次 step 之前的 tick。 */
function pickupAt(tick: number, born = 0): D3State {
  return makeState({
    tick,
    players: [{ cell: cell(5, 5) }, { cell: cell(25, 20) }],
    gems: [{ cell: cell(6, 5), born }, ...AWAY],
  });
}

describe('D-3 會貶值的寶石｜TEST_PLAN 第 6 節', () => {
  it('1. 寶石出現時價值 9：開局 5 顆（born 都是 0，價值 9），不在牆上、不在兩個起點', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const state = d3Game.init(seed, CONFIG);
      expect(state.gems).toHaveLength(5);
      expect(new Set(state.gems.map((g) => g.cell)).size).toBe(5);
      for (const gem of state.gems) {
        expect(gem.born).toBe(0);
        expect(gemValue(state.tick, gem.born)).toBe(9);
        expect(state.walls[gem.cell]).toBe(0);
      }
    }
  });

  it('1. 補上來的新寶石價值也是 9：born 是補上那個 tick，價值 9', () => {
    const next = d3Game.step(pickupAt(124), [PRESS_RIGHT, NONE]);
    const fresh = next.gems.filter((g) => g.born !== 0);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.born).toBe(125);
    expect(gemValue(next.tick, fresh[0]?.born as number)).toBe(9);
  });

  it('2. 每 60 tick 減 1：出現後第 59 tick 還是 9，第 60 tick 是 8，第 480 tick 是 1', () => {
    expect(gemValue(59, 0)).toBe(9);
    expect(gemValue(60, 0)).toBe(8);
    expect(gemValue(119, 0)).toBe(8);
    expect(gemValue(120, 0)).toBe(7);
    expect(gemValue(479, 0)).toBe(2);
    expect(gemValue(480, 0)).toBe(1);
    // 出生的 tick 不是 0 也一樣：從出生那個 tick 起算。
    expect(gemValue(100 + 59, 100)).toBe(9);
    expect(gemValue(100 + 60, 100)).toBe(8);
    expect(gemValue(100 + 480, 100)).toBe(1);
  });

  it('2. 真的跑起來：一顆從 tick 0 出生的寶石，跑 480 個 tick，每個整點的價值都對（state 裡的 tick 與 born 算出來）', () => {
    let state = makeState({
      players: [{ cell: cell(0, 23) }, { cell: cell(31, 0) }],
      gems: [{ cell: cell(15, 10), born: 0 }],
      walls: Array.from({ length: 24 }, (_v, y) => cell(8, y)),
    });
    const seen = new Map<number, number>();
    for (let t = 1; t <= 480; t += 1) {
      state = d3Game.step(state, IDLE);
      const original = state.gems.find((g) => g.born === 0);
      if (original !== undefined) {
        seen.set(state.tick, gemValue(state.tick, original.born));
      }
    }
    expect(seen.get(59)).toBe(9);
    expect(seen.get(60)).toBe(8);
    expect(seen.get(120)).toBe(7);
    expect(seen.get(480)).toBe(1);
  });

  it('3. 價值到 1 之後不再降：第 480 到 599 tick 都是 1，再過很久也是 1', () => {
    for (const tick of [480, 481, 539, 540, 599, 600, 5000]) {
      expect(gemValue(tick, 0)).toBe(1);
    }
    expect(LIFETIME).toBe(600);
  });

  it('3. 再過 120 tick（第 600 tick）消失，並補一顆新的：第 599 tick 還在，第 600 tick 沒有 born = 0 的那顆，場上還是 5 顆', () => {
    const gems: Gem[] = [
      { cell: cell(15, 10), born: 0 },
      { cell: cell(16, 10), born: 100 },
      { cell: cell(17, 10), born: 200 },
      { cell: cell(18, 10), born: 300 },
      { cell: cell(19, 10), born: 400 },
    ];
    const state = makeState({
      tick: 597,
      players: [{ cell: cell(5, 5) }, { cell: cell(25, 20) }],
      gems,
    });
    const at599 = run(d3Game, state, 2, IDLE);
    expect(at599.tick).toBe(599);
    expect(at599.gems).toEqual(gems);
    const at600 = d3Game.step(at599, IDLE);
    expect(at600.tick).toBe(600);
    expect(at600.gems).toHaveLength(GEM_COUNT);
    expect(at600.gems.filter((g) => g.born === 0)).toHaveLength(0);
    expect(at600.gems.filter((g) => g.born === 600)).toHaveLength(1);
    for (const kept of gems.slice(1)) {
      expect(at600.gems).toContainEqual(kept);
    }
    expect(at600.rng).not.toBe(at599.rng);
  });

  it('4. 撿到：分數加上當下的價值（第 125 tick 走到出生在 tick 0 的寶石：價值 7）', () => {
    const next = d3Game.step(pickupAt(124), [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(cell(6, 5));
    expect(d3Game.score(next)).toEqual([7, 0]);
  });

  it('4. 撿到：新的寶石（價值 9）直接得 9 分；最低價值 1 得 1 分；沒有背包，分數馬上加', () => {
    const fresh = d3Game.step(pickupAt(4), [PRESS_RIGHT, NONE]);
    expect(d3Game.score(fresh)).toEqual([9, 0]);
    const old = d3Game.step(pickupAt(504), [PRESS_RIGHT, NONE]);
    expect(d3Game.score(old)).toEqual([1, 0]);
  });

  it('4. 對 AI（1 號邊）也一樣：AI 撿到拿當下的價值', () => {
    const state = makeState({
      tick: 244,
      players: [{ cell: cell(5, 5) }, { cell: cell(21, 10) }],
      gems: [{ cell: cell(20, 10), born: 0 }, ...AWAY.slice(0, 3), { cell: cell(2, 2), born: 0 }],
    });
    const next = d3Game.step(state, [NONE, PRESS_LEFT]);
    expect(d3Game.score(next)).toEqual([0, 5]);
  });

  it('5. 場上維持 5 顆：被撿走補一顆，兩個人各撿一顆補兩顆，消失補一顆；補的不在腳下、不在原來那格', () => {
    const one = d3Game.step(pickupAt(124), [PRESS_RIGHT, NONE]);
    expect(one.gems).toHaveLength(5);
    expect(one.gems.map((g) => g.cell)).not.toContain(cell(6, 5));
    const two = d3Game.step(
      makeState({
        tick: 124,
        players: [{ cell: cell(5, 5) }, { cell: cell(21, 10) }],
        gems: [{ cell: cell(6, 5), born: 0 }, { cell: cell(20, 10), born: 0 }, ...AWAY.slice(0, 3)],
      }),
      [PRESS_RIGHT, PRESS_LEFT],
    );
    expect(two.gems).toHaveLength(5);
    expect(d3Game.score(two)).toEqual([7, 7]);
  });

  it('5. 兩人同一個 tick 走到同一顆：各得當下的價值，只補一顆', () => {
    const state = makeState({
      tick: 124,
      players: [{ cell: cell(5, 5) }, { cell: cell(7, 5) }],
      gems: [{ cell: cell(6, 5), born: 0 }, ...AWAY],
    });
    const next = d3Game.step(state, [PRESS_RIGHT, PRESS_LEFT]);
    expect(d3Game.score(next)).toEqual([7, 7]);
    expect(next.gems).toHaveLength(5);
    expect(next.gems.filter((g) => g.born === 0)).toHaveLength(4);
  });

  it('6. 邊界：在寶石減值的同一個 tick 撿到：拿減之前的價值（第 60 tick 走上去得 9，不是 8）', () => {
    const next = d3Game.step(pickupAt(59), [PRESS_RIGHT, NONE]);
    expect(next.tick).toBe(60);
    expect(gemValue(next.tick, 0)).toBe(8); // 這個 tick 寶石其實已經是 8
    expect(d3Game.score(next)).toEqual([9, 0]);
  });

  it('6. 邊界：下一個減值點也一樣（第 120 tick 得 8，不是 7；第 480 tick 得 2，不是 1）', () => {
    expect(d3Game.score(d3Game.step(pickupAt(119), [PRESS_RIGHT, NONE]))).toEqual([8, 0]);
    expect(d3Game.score(d3Game.step(pickupAt(479), [PRESS_RIGHT, NONE]))).toEqual([2, 0]);
  });

  it('6. 邊界：減值的下一個 tick 才撿就是新的價值（第 65 tick 得 8）', () => {
    expect(d3Game.score(d3Game.step(pickupAt(64), [PRESS_RIGHT, NONE]))).toEqual([8, 0]);
  });

  it('6. 邊界：出生的 tick 不是 0 也一樣（born = 100，第 160 tick 撿到得 9，第 165 tick 得 8）', () => {
    expect(d3Game.score(d3Game.step(pickupAt(159, 100), [PRESS_RIGHT, NONE]))).toEqual([9, 0]);
    expect(d3Game.score(d3Game.step(pickupAt(164, 100), [PRESS_RIGHT, NONE]))).toEqual([8, 0]);
  });

  it('6. 邊界：消失的同一個 tick（第 600 tick）走上去：還撿得到，得價值 1，之後補一顆新的', () => {
    const state = makeState({
      tick: 599,
      players: [{ cell: cell(5, 5) }, { cell: cell(25, 20) }],
      gems: [{ cell: cell(6, 5), born: 0 }, ...AWAY.map((g) => ({ ...g, born: 300 }))],
    });
    const next = d3Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.tick).toBe(600);
    expect(d3Game.score(next)).toEqual([1, 0]);
    expect(next.gems).toHaveLength(5);
    expect(next.gems.filter((g) => g.born === 300)).toHaveLength(4);
  });

  it('時間到：3600 tick 分數高的贏；最後一個 tick（走格的 tick）撿到的算分', () => {
    const state = makeState({
      tick: 3599,
      players: [
        { cell: cell(5, 5), score: 20 },
        { cell: cell(25, 20), score: 24 },
      ],
      gems: [{ cell: cell(6, 5), born: 3590 }, ...AWAY.map((g) => ({ ...g, born: 3000 }))],
    });
    const end = d3Game.step(state, [PRESS_RIGHT, NONE]);
    expect(d3Game.isOver(end)).toBe(true);
    expect(d3Game.score(end)).toEqual([29, 24]);
    expect(d3Game.winner(end)).toBe(0);
    expect(d3Game.step(end, [PRESS_LEFT, PRESS_RIGHT])).toEqual(end);
  });

  it('時間到：同分平手；還沒結束時 winner 是 null', () => {
    const tie = d3Game.step(makeState({ tick: 3599, players: [{ score: 6 }, { score: 6 }] }), IDLE);
    expect(d3Game.winner(tie)).toBeNull();
    expect(d3Game.winner(makeState({ players: [{ score: 9 }, {}] }))).toBeNull();
  });

  it('種子有效：補寶石的亂數狀態與位置隨種子變（10 個種子，補的位置不全相同）', () => {
    const spots = new Set<number>();
    for (let seed = 0; seed < 10; seed += 1) {
      const state = { ...pickupAt(124), rng: rngStateFor(seed, 'gem-test') };
      const next = d3Game.step(state, [PRESS_RIGHT, NONE]);
      expect(next.rng).not.toBe(state.rng);
      for (const gem of next.gems) {
        if (gem.born === 125) {
          spots.add(gem.cell);
        }
      }
    }
    expect(spots.size).toBeGreaterThan(5);
  });
});

describe('D-3 會貶值的寶石｜動作與評估（給貪心型用）', () => {
  const gainsOf = (state: D3State, side: 0 | 1): number[] =>
    d3Game.actions(state, side).map((action) => {
      const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
      return d3Game.evaluate(d3Game.step(state, inputs), side).gain;
    });
  const best = (values: readonly number[]): number => values.indexOf(Math.max(...values));
  const [, ACT_UP, ACT_RIGHT, , ACT_LEFT] = [0, 1, 2, 3, 4];
  const gem = (x: number, y: number, born = 0): Gem => ({ cell: cell(x, y), born });
  const FAR = [gem(2, 2), gem(2, 3), gem(3, 2), gem(3, 3)];

  it('actions：同 D-A（5 個不同的動作，1 號邊的順序轉 180 度）', () => {
    const state = makeState();
    expect(d3Game.actions(state, 0)).toEqual([NONE, PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT]);
    expect(d3Game.actions(state, 1)).toEqual([NONE, PRESS_DOWN, PRESS_LEFT, PRESS_UP, PRESS_RIGHT]);
  });

  it('gain：往最近的寶石走一步最高（價值一樣的時候）', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      gems: [gem(14, 10, 1), gem(30, 22, 1), gem(29, 22, 1), gem(28, 22, 1), gem(27, 22, 1)],
    });
    expect(best(gainsOf(state, 0))).toBe(ACT_RIGHT);
  });

  it('gain：價值高的優先：兩顆一樣遠，往 9 分的那顆走，不往 2 分的那顆走', () => {
    // 人在 (10, 10)；右邊 5 格有一顆、左邊 5 格有一顆。右邊那顆已經出生很久（價值 2），左邊那顆剛出生（價值 9）。
    const state = makeState({
      tick: 421,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      gems: [gem(15, 10, 0), gem(5, 10, 420), ...FAR.slice(0, 3)],
    });
    expect(best(gainsOf(state, 0))).toBe(ACT_LEFT);
    // 反過來：價值對調，就往右走。
    const swapped = makeState({
      tick: 421,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      gems: [gem(15, 10, 420), gem(5, 10, 0), ...FAR.slice(0, 3)],
    });
    expect(best(gainsOf(swapped, 0))).toBe(ACT_RIGHT);
  });

  it('gain：近的 3 分與遠的 9 分：夠近的 3 分先拿', () => {
    const state = makeState({
      tick: 400,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      gems: [gem(11, 10, 0), gem(10, 23, 399), ...FAR.slice(0, 3)],
    });
    expect(best(gainsOf(state, 0))).toBe(ACT_RIGHT);
  });

  it('gain：預計走到之前就會消失的寶石不算目標（快消失的 1 分寶石不如遠一點的新寶石）', () => {
    // 快消失的寶石在右邊 12 格（要 60 個 tick 才走得到，它再 5 個 tick 就消失）；新寶石在左邊 12 格。
    const state = makeState({
      tick: 595,
      players: [{ cell: cell(15, 10) }, { cell: cell(30, 1) }],
      gems: [gem(27, 10, 0), gem(3, 10, 590), ...FAR.slice(0, 3)],
    });
    expect(best(gainsOf(state, 0))).toBe(ACT_LEFT);
  });

  it('gain：下一步就踩到寶石，加的是它當下的價值（100 × 價值），走格前後連續', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      gems: [gem(11, 10, 1), ...FAR],
    });
    const gains = gainsOf(state, 0);
    // 踩到 9 分的寶石是 900 分；靠近另一顆寶石的吸引力最多幾百分。
    expect(gains[ACT_RIGHT]).toBeGreaterThan((gains[ACT_UP] as number) + 500);
    const moved = d3Game.evaluate(
      run(d3Game, d3Game.step(state, [PRESS_RIGHT, NONE]), MOVE_EVERY - 1, IDLE),
      0,
    ).gain;
    expect(Math.abs(moved - (gains[ACT_RIGHT] as number))).toBeLessThan(150);
  });

  it('gain：對手比我更靠近的寶石，gain 比較低', () => {
    const mine = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      gems: [gem(16, 10, 1)],
    });
    const contested = makeState({
      tick: 1,
      players: [{ cell: cell(10, 10) }, { cell: cell(17, 10) }],
      gems: [gem(16, 10, 1)],
    });
    expect(d3Game.evaluate(contested, 0).gain).toBeLessThan(d3Game.evaluate(mine, 0).gain);
  });

  it('gain：分數領先越多越高；對 1 號邊相反', () => {
    const ahead = makeState({ players: [{ score: 30 }, { score: 12 }] });
    const behind = makeState({ players: [{ score: 12 }, { score: 30 }] });
    expect(d3Game.evaluate(ahead, 0).gain).toBeGreaterThan(d3Game.evaluate(behind, 0).gain);
    expect(d3Game.evaluate(ahead, 1).gain).toBeLessThan(d3Game.evaluate(behind, 1).gain);
  });

  it('danger：永遠在 0 到 1 之間；對手搶先時比較高；已結束的局是 0', () => {
    const safe = makeState({
      players: [{ cell: cell(10, 10) }, { cell: cell(30, 1) }],
      gems: [gem(12, 10)],
    });
    const risky = makeState({
      players: [{ cell: cell(10, 10) }, { cell: cell(13, 10) }],
      gems: [gem(12, 10)],
    });
    const s = d3Game.evaluate(safe, 0).danger;
    const r = d3Game.evaluate(risky, 0).danger;
    expect(s).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
    expect(r).toBeGreaterThan(s);
    expect(d3Game.evaluate(makeState({ gems: [] }), 0).danger).toBe(0);
    expect(d3Game.evaluate(d3Game.step(makeState({ tick: 3599 }), IDLE), 0).danger).toBe(0);
  });

  it('已經結束的局：贏的一邊 gain 比輸的高很多', () => {
    const won = d3Game.step(
      makeState({ tick: 3599, players: [{ score: 300 }, { score: 1 }] }),
      IDLE,
    );
    expect(d3Game.evaluate(won, 0).gain).toBeGreaterThan(d3Game.evaluate(won, 1).gain);
  });
});

describe('D-3 會貶值的寶石｜AI 在這張牌上會動腦', () => {
  it('貪心型（等級 10）自己一個人跑 3600 個 tick（對手不動）：至少拿 150 分', () => {
    const seed = 4;
    const ai = levelController(d3Game, greedy, 10, seed);
    let state = d3Game.init(seed, CONFIG);
    for (let tick = 0; !d3Game.isOver(state); tick += 1) {
      state = d3Game.step(state, [ai.decide(state, 0, tick), NONE]);
    }
    expect(d3Game.score(state)[0]).toBeGreaterThanOrEqual(150);
    expect(d3Game.score(state)[1]).toBe(0);
  });
});
