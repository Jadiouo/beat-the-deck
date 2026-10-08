import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import { bfsDistances, CELLS, cell, cellX, cellY, START_CELLS } from '../_diamonds/logic';
import {
  BEFORE_MOVE,
  CONFIG,
  deepFreeze,
  describeSharedDiamondsRules,
  IDLE,
  NONE,
  PRESS_DOWN,
  PRESS_LEFT,
  PRESS_RIGHT,
  PRESS_UP,
  run,
} from '../_diamonds/shared-rules.test-helpers';
import {
  CAP,
  CHARGE,
  d4Game,
  makeState,
  STATION_COUNT,
  STATION_GAP,
  TRICKLE_EVERY,
} from './logic';
import type { D4State } from './logic';

/**
 * D-4 電池的規則測試。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * `makeState` 預設：沒有牆、4 個站在 (8,6)(23,17)(23,6)(8,17)（兩對 180 度旋轉對稱）、`holder` 全 −1、
 * 兩邊電 30、金幣同 D-A。方向是絕對方向（上 = y 減少）。
 */

describeSharedDiamondsRules<D4State>({
  label: 'D-4 電池',
  game: d4Game,
  makeState,
  pickupCells: (state) => state.coins,
  withPickups: (cells) => ({ coins: cells }),
  count: 6,
});

const STATION_A = cell(8, 6);
const STATION_A2 = cell(23, 17);
const STATION_B = cell(23, 6);
const STATION_B2 = cell(8, 17);
const FAR_AI = cell(25, 20);
const FAR_HUMAN = cell(5, 20);

/** 下一次 step 就是走格結算：兩個角色預設離所有站很遠。 */
function atMove(overrides: Parameters<typeof makeState>[0] = {}): D4State {
  return makeState({
    tick: BEFORE_MOVE,
    players: [{ cell: cell(5, 5) }, { cell: FAR_AI }],
    ...overrides,
  });
}

/** 對面的格子（180 度旋轉）。 */
function mirror(c: number): number {
  return CELLS - 1 - c;
}

describe('D-4 電池｜初始', () => {
  it('開局：兩邊電 30、涓流計時 0、stuck 0、4 個站都沒有 holder、分數 0、一局固定 3600 tick', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const state = d4Game.init(seed, CONFIG);
      expect(state.battery).toEqual([CAP, CAP]);
      expect(CAP).toBe(30);
      expect(state.trickle).toEqual([0, 0]);
      expect(state.stuck).toEqual([0, 0]);
      expect(state.holder).toEqual([-1, -1, -1, -1]);
      expect(state.stations).toHaveLength(STATION_COUNT);
      expect(d4Game.score(state)).toEqual([0, 0]);
      expect(state.maxTicks).toBe(3600);
    }
  });

  it('站：4 個不同的格子、不在牆上、不在兩個起點；兩對 180 度旋轉對稱；兩站之間至少 6 步（種子 0 到 49）', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const state = d4Game.init(seed, CONFIG);
      const [a, a2, b, b2] = state.stations as [number, number, number, number];
      expect(new Set(state.stations).size, `種子 ${seed}`).toBe(4);
      for (const s of state.stations) {
        expect(state.walls[s], `種子 ${seed}：站在牆上`).toBe(0);
        expect(START_CELLS, `種子 ${seed}：站在起點上`).not.toContain(s);
      }
      expect(a2, `種子 ${seed}`).toBe(mirror(a));
      expect(b2, `種子 ${seed}`).toBe(mirror(b));
      for (let i = 0; i < 4; i += 1) {
        const field = bfsDistances(state.walls, state.stations[i] as number);
        for (let j = i + 1; j < 4; j += 1) {
          expect(
            field[state.stations[j] as number] as number,
            `種子 ${seed}：站 ${i} 與站 ${j} 太近`,
          ).toBeGreaterThanOrEqual(STATION_GAP);
        }
      }
      expect(STATION_GAP).toBe(6);
      expect([a, a2, b, b2]).toEqual([...state.stations]);
    }
  });

  it('站的位置隨種子變：種子 0 到 9 至少 6 種不同的排法', () => {
    const layouts = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      layouts.add(d4Game.init(seed, CONFIG).stations.join(','));
    }
    expect(layouts.size).toBeGreaterThanOrEqual(6);
  });

  it('同一個種子 init 兩次完全相同', () => {
    for (const seed of [0, 3, 41]) {
      expect(d4Game.init(seed, CONFIG)).toEqual(d4Game.init(seed, CONFIG));
    }
  });
});

describe('D-4 電池｜耗電', () => {
  it('1. 真的換到另一格才扣 1 電；走格結算之外的 tick 不扣', () => {
    let state = makeState({ players: [{ cell: cell(5, 5) }, { cell: FAR_AI }] });
    for (let t = 1; t <= 4; t += 1) {
      state = d4Game.step(state, [PRESS_RIGHT, NONE]);
      expect(state.battery, `第 ${t} 個 tick`).toEqual([30, 30]);
    }
    state = d4Game.step(state, [PRESS_RIGHT, NONE]);
    expect(state.players[0].cell).toBe(cell(6, 5));
    expect(state.battery).toEqual([29, 30]);
  });

  it('1. 朝牆走、出界、沒按方向，都不扣電', () => {
    const wall = atMove({ walls: [cell(6, 5)] });
    expect(d4Game.step(wall, [PRESS_RIGHT, NONE]).battery).toEqual([30, 30]);
    const edge = atMove({ players: [{ cell: cell(0, 5) }, { cell: FAR_AI }] });
    expect(d4Game.step(edge, [PRESS_LEFT, NONE]).battery).toEqual([30, 30]);
    expect(d4Game.step(atMove(), IDLE).battery).toEqual([30, 30]);
  });

  it('1. 兩邊同時走各扣各的', () => {
    const state = atMove({ players: [{ cell: cell(5, 5) }, { cell: cell(20, 20) }] });
    const next = d4Game.step(state, [PRESS_RIGHT, PRESS_LEFT]);
    expect(next.battery).toEqual([29, 29]);
  });

  it('2. 電量 0：走格結算不動，待走方向照常歸零，不扣電', () => {
    const state = atMove({ battery: [0, 30] });
    const next = d4Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(cell(5, 5));
    expect(next.players[0].pending).toBe(-1);
    expect(next.battery[0]).toBe(0);
  });

  it('2. 邊界：電量剛好 1 → 走得動，走完是 0；電量 0 的人下一次就動不了', () => {
    let state = atMove({ battery: [1, 30] });
    state = d4Game.step(state, [PRESS_RIGHT, NONE]);
    expect(state.players[0].cell).toBe(cell(6, 5));
    expect(state.battery[0]).toBe(0);
    const again = run(d4Game, state, 4, [PRESS_RIGHT, NONE]);
    const stuck = d4Game.step(again, [PRESS_RIGHT, NONE]);
    expect(stuck.players[0].cell).toBe(cell(6, 5));
  });

  it('沒電的人仍然可以撿到腳下已有的金幣（站著的人不會走，所以只在剛好走進金幣的那一次撿）', () => {
    // 電量 1 走進金幣：撿到，之後 0 電。
    const state = atMove({ battery: [1, 30], coins: [cell(6, 5), cell(15, 10), cell(16, 10), cell(17, 10), cell(18, 10), cell(19, 10)] });
    const next = d4Game.step(state, [PRESS_RIGHT, NONE]);
    expect(d4Game.score(next)).toEqual([1, 0]);
    expect(next.battery[0]).toBe(0);
  });
});

describe('D-4 電池｜涓流', () => {
  it('3. 電量 0 的人每 60 tick 回 1 電（不管在哪裡）：第 59 個 tick 還是 0，第 60 個變 1，計時歸零', () => {
    expect(TRICKLE_EVERY).toBe(60);
    let state = makeState({ battery: [0, 30], players: [{ cell: cell(5, 5) }, { cell: FAR_AI }] });
    state = run(d4Game, state, 59);
    expect(state.battery[0]).toBe(0);
    expect(state.trickle[0]).toBe(59);
    state = d4Game.step(state, IDLE);
    expect(state.battery[0]).toBe(1);
    expect(state.trickle[0]).toBe(0);
  });

  it('3. 電量大於 0 時計時歸零（不累積）', () => {
    const state = makeState({ battery: [5, 30], trickle: [40, 0] });
    expect(d4Game.step(state, IDLE).trickle).toEqual([0, 0]);
  });

  it('3. 兩邊各算各的：只有電量 0 的那一邊回電', () => {
    let state = makeState({ battery: [0, 12], players: [{ cell: cell(5, 5) }, { cell: FAR_AI }] });
    state = run(d4Game, state, 60);
    expect(state.battery).toEqual([1, 12]);
  });

  it('stuck 累計「電量是 0」的 tick 數（指紋用，不影響規則）', () => {
    let state = makeState({ battery: [0, 30], players: [{ cell: cell(5, 5) }, { cell: FAR_AI }] });
    state = run(d4Game, state, 60);
    expect(state.stuck).toEqual([60, 0]);
    state = run(d4Game, state, 10);
    expect(state.stuck).toEqual([60, 0]);
  });
});

describe('D-4 電池｜充電站', () => {
  /** 人在站 A 旁邊 (7,6)，電 20，下一次 step 是結算。 */
  const nextToA = (overrides: Parameters<typeof makeState>[0] = {}): D4State =>
    atMove({
      players: [{ cell: cell(7, 6) }, { cell: FAR_AI }],
      battery: [20, 20],
      ...overrides,
    });

  it('4. 走進空站：當場成為 holder，同一次結算 +2 電（扣 1 電移動、加 2 電充電）', () => {
    expect(CHARGE).toBe(2);
    const next = d4Game.step(nextToA(), [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(STATION_A);
    expect(next.holder[0]).toBe(0);
    expect(next.battery[0]).toBe(21);
  });

  it('4. holder 每次走格結算 +2，上限 30', () => {
    let state = d4Game.step(nextToA({ battery: [27, 20] }), [PRESS_RIGHT, NONE]);
    expect(state.battery[0]).toBe(28); // 27 − 1 + 2
    state = run(d4Game, state, 5);
    expect(state.battery[0]).toBe(30); // 28 + 2
    state = run(d4Game, state, 5);
    expect(state.battery[0]).toBe(30); // 上限
  });

  it('4. 不是結算的 tick 不充電', () => {
    const state = makeState({
      tick: 0,
      players: [{ cell: STATION_A }, { cell: FAR_AI }],
      battery: [10, 30],
      holder: [0, -1, -1, -1],
    });
    expect(run(d4Game, state, 4).battery[0]).toBe(10);
    expect(run(d4Game, state, 5).battery[0]).toBe(12);
  });

  it('5. 先到先得：站上有 holder，另一個人走進來不充電、也不是 holder', () => {
    const state = atMove({
      players: [{ cell: cell(7, 6) }, { cell: STATION_A }],
      battery: [20, 20],
      holder: [1, -1, -1, -1],
    });
    const next = d4Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.players[0].cell).toBe(STATION_A);
    expect(next.holder[0]).toBe(1);
    expect(next.battery).toEqual([19, 22]); // 人只扣移動；AI 照充
  });

  it('5. 同一次結算兩個人同時走進空站：沒有 holder，兩個人都不充電（各扣 1 電）', () => {
    const state = atMove({
      players: [{ cell: cell(7, 6) }, { cell: cell(9, 6) }],
      battery: [20, 20],
    });
    const next = d4Game.step(state, [PRESS_RIGHT, PRESS_LEFT]);
    expect(next.players[0].cell).toBe(STATION_A);
    expect(next.players[1].cell).toBe(STATION_A);
    expect(next.holder[0]).toBe(-1);
    expect(next.battery).toEqual([19, 19]);
  });

  it('5. 兩個人都在空站上，其中一個離開之後，留下的人在下一次結算成為 holder 並充電', () => {
    let state = atMove({
      players: [{ cell: cell(7, 6) }, { cell: cell(9, 6) }],
      battery: [20, 20],
    });
    state = d4Game.step(state, [PRESS_RIGHT, PRESS_LEFT]); // 兩人都在站 A，沒有 holder
    state = run(d4Game, state, 4, [PRESS_LEFT, NONE]); // 人鎖定往左
    state = d4Game.step(state, [PRESS_LEFT, NONE]);
    expect(state.players[0].cell).toBe(cell(7, 6));
    expect(state.holder[0]).toBe(1);
    expect(state.battery).toEqual([18, 21]);
  });

  it('5. 兩人都留在空站上：整場沒有 holder、沒有人充電', () => {
    const state = makeState({
      tick: 0,
      players: [{ cell: STATION_A }, { cell: STATION_A }],
      battery: [10, 10],
    });
    const later = run(d4Game, state, 50);
    expect(later.holder[0]).toBe(-1);
    expect(later.battery).toEqual([10, 10]);
  });

  it('6. holder 離開那一格：站立刻變空，離開的人不充電', () => {
    const state = atMove({
      players: [{ cell: STATION_A }, { cell: FAR_AI }],
      battery: [20, 20],
      holder: [0, -1, -1, -1],
    });
    const next = d4Game.step(state, [PRESS_LEFT, NONE]);
    expect(next.players[0].cell).toBe(cell(7, 6));
    expect(next.holder[0]).toBe(-1);
    expect(next.battery[0]).toBe(19);
  });

  it('6. 站空了之後，另一個站在站上的人下一次結算接手', () => {
    let state = atMove({
      players: [{ cell: STATION_A }, { cell: STATION_A }],
      battery: [20, 20],
      holder: [0, -1, -1, -1],
    });
    state = d4Game.step(state, [PRESS_LEFT, NONE]); // 人離開
    expect(state.holder[0]).toBe(1); // AI 在同一次結算就接手（站上只剩它一個）
    expect(state.battery).toEqual([19, 22]);
  });

  it('7. 電滿了 holder 可以繼續站著，不會被趕走，對手也進不來', () => {
    let state = makeState({
      tick: 0,
      players: [{ cell: STATION_A }, { cell: cell(9, 6) }],
      battery: [30, 20],
      holder: [0, -1, -1, -1],
    });
    state = run(d4Game, state, 5, [NONE, PRESS_LEFT]);
    expect(state.players[1].cell).toBe(STATION_A);
    state = run(d4Game, state, 20);
    expect(state.holder[0]).toBe(0);
    expect(state.battery[0]).toBe(30);
    expect(state.battery[1]).toBe(19); // 對手只付了移動的 1 電，沒有充到
  });

  it('8. 電量 0 的人站在空站上：結算時成為 holder 並充電（這就是出路）', () => {
    const state = makeState({
      tick: BEFORE_MOVE,
      players: [{ cell: STATION_A }, { cell: FAR_AI }],
      battery: [0, 30],
    });
    const next = d4Game.step(state, IDLE);
    expect(next.holder[0]).toBe(0);
    expect(next.battery[0]).toBe(2);
  });

  it('9. 四個站各自獨立：站 B 的 holder 不影響站 A', () => {
    const state = atMove({
      players: [{ cell: cell(7, 6) }, { cell: STATION_B }],
      battery: [20, 20],
      holder: [-1, -1, 1, -1],
    });
    const next = d4Game.step(state, [PRESS_RIGHT, NONE]);
    expect(next.holder).toEqual([0, -1, 1, -1]);
    expect(STATION_A2).toBe(mirror(STATION_A));
    expect(STATION_B2).toBe(mirror(STATION_B));
  });
});

describe('D-4 電池｜純度與契約', () => {
  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，包含充電、涓流、走格的那一次）', () => {
    const cases: D4State[] = [
      atMove({ players: [{ cell: cell(7, 6) }, { cell: cell(9, 6) }], battery: [20, 20] }),
      atMove({ battery: [0, 3] }),
      makeState({ tick: 59, battery: [0, 30], trickle: [59, 0] }),
      atMove({
        players: [{ cell: STATION_A }, { cell: FAR_AI }],
        holder: [0, -1, -1, -1],
        battery: [10, 10],
      }),
    ];
    for (const state of cases) {
      const before = JSON.stringify(state);
      const frozen = deepFreeze(JSON.parse(before) as D4State);
      expect(() => d4Game.step(frozen, [PRESS_RIGHT, PRESS_LEFT])).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(before);
    }
  });

  it('沒有牆、站、金幣變動時，walls 與 stations 是同一個陣列物件（A5 的距離場才能快取）', () => {
    const state = d4Game.init(3, CONFIG);
    const next = run(d4Game, state, 40, [PRESS_UP, PRESS_DOWN]);
    expect(next.walls).toBe(state.walls);
    expect(next.stations).toBe(state.stations);
  });

  it('K1：同一個種子、同一串輸入跑兩次結果相同', () => {
    const play = (): D4State => {
      const a = levelController(d4Game, greedy, 6, 1);
      const b = levelController(d4Game, greedy, 6, 2);
      let state = d4Game.init(5, CONFIG);
      for (let tick = 0; tick < 900; tick += 1) {
        state = d4Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
      return state;
    };
    expect(play()).toEqual(play());
  });

  it('時間到：分數高的贏、同分平手；結束之後再 step，state 原樣不變', () => {
    const base = makeState({ tick: 3599, players: [{ score: 3 }, { score: 2 }] });
    const end = d4Game.step(base, IDLE);
    expect(d4Game.isOver(end)).toBe(true);
    expect(d4Game.winner(end)).toBe(0);
    expect(d4Game.step(end, [PRESS_RIGHT, PRESS_LEFT])).toBe(end);
    const tie = d4Game.step(makeState({ tick: 3599, players: [{ score: 2 }, { score: 2 }] }), IDLE);
    expect(d4Game.winner(tie)).toBeNull();
    const second = d4Game.step(makeState({ tick: 3599, players: [{ score: 1 }, { score: 2 }] }), IDLE);
    expect(d4Game.winner(second)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ACTIONS: readonly Buttons[] = [PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT, NONE];

function evalAfter(state: D4State, side: Side, action: Buttons): { gain: number; danger: number } {
  const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
  return d4Game.evaluate(d4Game.step(state, inputs), side);
}
function gainsOf(state: D4State, side: Side = 0): number[] {
  return ACTIONS.map((action) => evalAfter(state, side, action).gain);
}
function dangersOf(state: D4State, side: Side = 0): number[] {
  return ACTIONS.map((action) => evalAfter(state, side, action).danger);
}
const UP_I = 0;
const RIGHT_I = 1;
const DOWN_I = 2;
const LEFT_I = 3;
const NONE_I = 4;

function bestIndex(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] as number) > (values[best] as number)) {
      best = i;
    }
  }
  return best;
}

function dirName(buttons: Buttons): 'up' | 'right' | 'down' | 'left' | 'none' {
  if (buttons.up) {
    return 'up';
  }
  if (buttons.right) {
    return 'right';
  }
  if (buttons.down) {
    return 'down';
  }
  if (buttons.left) {
    return 'left';
  }
  return 'none';
}

/** 人在 (12,6)，離站 A（8,6）4 步；金幣 (15,6) 在另一邊，離人 3 步、離最近的站 7 步；其他金幣很遠。 */
function nearStation(overrides: Parameters<typeof makeState>[0] = {}): D4State {
  return makeState({
    tick: 1,
    players: [{ cell: cell(12, 6) }, { cell: cell(31, 0) }],
    coins: [cell(15, 6), cell(20, 20), cell(25, 20), cell(26, 20), cell(27, 20), cell(28, 20)],
    ...overrides,
  });
}

describe('D-4 電池｜actions', () => {
  it('五個不同的動作，全放開排最後', () => {
    for (const state of [nearStation(), nearStation({ battery: [4, 30] }), d4Game.init(7, CONFIG)]) {
      for (const side of [0, 1] as const) {
        const actions = d4Game.actions(state, side);
        expect(actions).toHaveLength(5);
        expect(new Set(actions.map(dirName)).size).toBe(5);
        expect(dirName(actions[4] as Buttons)).toBe('none');
      }
    }
  });

  it('電量夠：排最前面的動作往最近的金幣走', () => {
    const state = makeState({
      players: [{ cell: cell(5, 5) }, { cell: FAR_AI }],
      coins: [cell(9, 5), cell(20, 20), cell(25, 20), cell(26, 20), cell(27, 20), cell(28, 20)],
    });
    expect(dirName(d4Game.actions(state, 0)[0] as Buttons)).toBe('right');
  });

  it('電量不夠到金幣再回到站：排最前面的動作往我能用的最近的站走', () => {
    const state = nearStation({ battery: [6, 30] });
    expect(dirName(d4Game.actions(state, 0)[0] as Buttons)).toBe('left');
  });

  it('站被對手占著（holder）：往下一個我能用的站走，不是往被占的站', () => {
    const state = nearStation({
      battery: [6, 30],
      players: [{ cell: cell(12, 6) }, { cell: STATION_A }],
      holder: [1, -1, -1, -1],
    });
    expect(dirName(d4Game.actions(state, 0)[0] as Buttons)).toBe('right');
  });
});

describe('D-4 電池｜evaluate', () => {
  it('撿到金幣（下一步踩上去）比別的方向高很多', () => {
    const state = makeState({
      tick: 1,
      players: [{ cell: cell(5, 5) }, { cell: FAR_AI }],
      coins: [cell(6, 5), cell(20, 20), cell(25, 20), cell(26, 20), cell(27, 20), cell(28, 20)],
    });
    const gains = gainsOf(state);
    expect(bestIndex(gains)).toBe(RIGHT_I);
    expect((gains[RIGHT_I] as number) - (gains[NONE_I] as number)).toBeGreaterThan(90);
  });

  it('電量夠：往金幣走；電量只夠回站：往站走（同一個位置，只差電量）', () => {
    expect(bestIndex(gainsOf(nearStation({ battery: [30, 30] })))).toBe(RIGHT_I);
    expect(bestIndex(gainsOf(nearStation({ battery: [6, 30] })))).toBe(LEFT_I);
  });

  it('金幣的來回算進去：走過去撿得到、但回不了站的金幣，不算「夠」', () => {
    // 金幣離人 3 步、離最近的站 7 步：需要 3 + 7 + 餘裕 2 = 12 電。11 電不去、12 電去。
    expect(bestIndex(gainsOf(nearStation({ battery: [11, 30] })))).toBe(LEFT_I);
    expect(bestIndex(gainsOf(nearStation({ battery: [13, 30] })))).toBe(RIGHT_I);
  });

  it('站上充電：電沒滿就留在站上（不動），電滿了才走向金幣', () => {
    const onStation = (battery: number): D4State =>
      makeState({
        tick: 1,
        players: [{ cell: STATION_A }, { cell: cell(31, 0) }],
        holder: [0, -1, -1, -1],
        battery: [battery, 30],
        coins: [cell(14, 6), cell(20, 20), cell(25, 20), cell(26, 20), cell(27, 20), cell(28, 20)],
      });
    expect(bestIndex(gainsOf(onStation(10)))).toBe(NONE_I);
    expect(bestIndex(gainsOf(onStation(20)))).toBe(NONE_I);
    expect(bestIndex(gainsOf(onStation(30)))).toBe(RIGHT_I);
  });

  it('被對手占著的站不算我能用的：改去別的站', () => {
    const state = nearStation({
      battery: [6, 30],
      players: [{ cell: cell(12, 6) }, { cell: STATION_A }],
      holder: [1, -1, -1, -1],
    });
    const gains = gainsOf(state);
    expect(gains[RIGHT_I] as number).toBeGreaterThan(gains[LEFT_I] as number);
  });

  it('對手已經走了（不在站上）的 holder 站，我可以去', () => {
    const state = nearStation({
      battery: [6, 30],
      players: [{ cell: cell(12, 6) }, { cell: cell(20, 20) }],
      holder: [1, -1, -1, -1],
    });
    expect(bestIndex(gainsOf(state))).toBe(LEFT_I);
  });

  it('擠它：對手快沒電、它最近的站我先到，我走上那個站；對手電量很夠時不這樣做', () => {
    // AI（1 號邊）在 (8,7)，離站 A 一步；人在 (12,6)，離站 A 4 步。AI 想收下面的金幣 (8,10)。
    const squeezeCase = (humanBattery: number): D4State =>
      makeState({
        tick: 1,
        players: [{ cell: cell(12, 6) }, { cell: cell(8, 7) }],
        battery: [humanBattery, 30],
        coins: [cell(8, 10), cell(20, 20), cell(25, 20), cell(26, 20), cell(27, 20), cell(28, 20)],
      });
    expect(bestIndex(gainsOf(squeezeCase(5), 1))).toBe(UP_I); // 走上站 A
    expect(bestIndex(gainsOf(squeezeCase(30), 1))).toBe(DOWN_I); // 去收金幣
  });

  it('擠它不看分差：兩邊分數對調，每個動作相對「全放開」的 gain 差一模一樣（不是橡皮筋）', () => {
    const build = (scores: [number, number]): D4State =>
      makeState({
        tick: 1,
        players: [
          { cell: cell(12, 6), score: scores[0] },
          { cell: cell(8, 7), score: scores[1] },
        ],
        battery: [5, 30],
        coins: [cell(8, 10), cell(20, 20), cell(25, 20), cell(26, 20), cell(27, 20), cell(28, 20)],
      });
    for (const side of [0, 1] as const) {
      const a = gainsOf(build([4, 0]), side);
      const b = gainsOf(build([0, 4]), side);
      const c = gainsOf(build([9, 9]), side);
      for (let i = 0; i < 5; i += 1) {
        expect((a[i] as number) - (a[NONE_I] as number)).toBeCloseTo(
          (b[i] as number) - (b[NONE_I] as number),
          9,
        );
        expect((a[i] as number) - (a[NONE_I] as number)).toBeCloseTo(
          (c[i] as number) - (c[NONE_I] as number),
          9,
        );
      }
    }
  });

  it('gain：我的分數越高越好、對方越高越差；已結束的局，贏的一邊高很多、danger 是 0', () => {
    const lead = nearStation({ players: [{ cell: cell(12, 6), score: 3 }, { cell: cell(31, 0), score: 1 }] });
    expect(d4Game.evaluate(lead, 0).gain).toBeGreaterThan(d4Game.evaluate(lead, 1).gain);
    const over = makeState({ over: true, players: [{ score: 3 }, { score: 1 }] });
    expect(d4Game.evaluate(over, 0).gain).toBeGreaterThan(900_000);
    expect(d4Game.evaluate(over, 1).gain).toBeLessThan(-900_000);
    expect(d4Game.evaluate(over, 0).danger).toBe(0);
  });

  it('gain 與 danger 對兩邊對稱：把整個局面轉 180 度、兩邊對調，同一組數字', () => {
    const rotate = (s: D4State): D4State => ({
      ...s,
      players: [
        { ...s.players[1], cell: mirror(s.players[1].cell), pending: rotatePending(s.players[1].pending) },
        { ...s.players[0], cell: mirror(s.players[0].cell), pending: rotatePending(s.players[0].pending) },
      ],
      battery: [s.battery[1], s.battery[0]],
      trickle: [s.trickle[1], s.trickle[0]],
      stuck: [s.stuck[1], s.stuck[0]],
      coins: s.coins.map(mirror),
      stations: s.stations.map((_c, i) => mirror(s.stations[i] as number)),
      holder: s.holder.map((h) => (h < 0 ? -1 : 1 - h)),
    });
    function rotatePending(p: -1 | 0 | 1 | 2 | 3): -1 | 0 | 1 | 2 | 3 {
      return p < 0 ? -1 : (((p + 2) % 4) as 0 | 1 | 2 | 3);
    }
    const cases: D4State[] = [
      nearStation({ battery: [6, 30] }),
      nearStation({ battery: [14, 9], players: [{ cell: cell(12, 6), pending: 1 }, { cell: cell(10, 7), pending: 2 }] }),
      nearStation({
        battery: [20, 5],
        players: [{ cell: STATION_A }, { cell: cell(13, 6) }],
        holder: [0, -1, -1, -1],
      }),
      nearStation({
        battery: [3, 3],
        players: [{ cell: cell(15, 12), score: 2 }, { cell: cell(16, 12), score: 1 }],
      }),
    ];
    for (const state of cases) {
      const flipped = rotate(state);
      expect(flipped.stations.map((c) => c)).toEqual([STATION_A2, STATION_A, STATION_B2, STATION_B]);
      for (const side of [0, 1] as const) {
        const a = d4Game.evaluate(state, side);
        const b = d4Game.evaluate(flipped, side === 0 ? 1 : 0);
        expect(a.gain).toBeCloseTo(b.gain, 9);
        expect(a.danger).toBeCloseTo(b.danger, 9);
      }
    }
  });

  it('danger：電量夠、站近、沒人搶，是 0', () => {
    expect(dangersOf(nearStation({ battery: [30, 30] }))).toEqual([0, 0, 0, 0, 0]);
  });

  it('danger：永遠在 0 到 1；電量低而且離站遠，是 1', () => {
    const lost = makeState({
      tick: 1,
      players: [{ cell: cell(15, 12) }, { cell: cell(31, 0) }],
      battery: [3, 30],
    });
    for (const d of dangersOf(lost)) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
    expect(dangersOf(lost)[NONE_I]).toBe(1);
  });

  it('danger：離站越遠、電越少越高；站被對手搶先時再高一些（對手比我近）', () => {
    const base = (aiAt: number, battery: number): D4State =>
      nearStation({ battery: [battery, 30], players: [{ cell: cell(12, 6) }, { cell: aiAt }] });
    const near = dangersOf(base(cell(31, 0), 7))[NONE_I] as number;
    const nearLow = dangersOf(base(cell(31, 0), 5))[NONE_I] as number;
    expect(nearLow).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(1);
    const contested = dangersOf(base(cell(8, 8), 7))[NONE_I] as number;
    expect(contested).toBeCloseTo(Math.min(1, near + 0.3), 9);
  });
});

// ---------------------------------------------------------------------------
// 互動強度（DESIGN-AI-FUN 2.5）
// ---------------------------------------------------------------------------

describe('D-4 電池｜互動強度（DESIGN-AI-FUN 2.5）', () => {
  it('把 AI 換到另一個合法位置（正在離人最近的站上充電 vs 在地圖另一邊），人這一邊 1 步 evaluate 的最好動作會跟著改變的局面，至少 20%', () => {
    const bestFor = (state: D4State): number => {
      let best = 0;
      let bestValue = Number.NEGATIVE_INFINITY;
      ACTIONS.forEach((action, index) => {
        const value = d4Game.evaluate(d4Game.step(state, [action, NONE]), 0).gain;
        if (value > bestValue) {
          bestValue = value;
          best = index;
        }
      });
      return best;
    };
    const samples: D4State[] = [];
    for (let seed = 0; seed < 8 && samples.length < 200; seed += 1) {
      const a = levelController(d4Game, greedy, 10, seed);
      const b = levelController(d4Game, greedy, 10, seed + 1_000_003);
      let state = d4Game.init(seed, CONFIG);
      for (let tick = 0; !d4Game.isOver(state); tick += 1) {
        if (tick % 36 === 17 && samples.length < 200) {
          samples.push(state);
        }
        state = d4Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    let changed = 0;
    for (const sample of samples) {
      const field = bfsDistances(sample.walls, sample.players[0].cell);
      // 離人最近（而且人不在上面）的站。
      let nearest = 0;
      for (let i = 1; i < sample.stations.length; i += 1) {
        const s = sample.stations[i] as number;
        const best = sample.stations[nearest] as number;
        const here = sample.players[0].cell;
        if (best === here || ((field[s] as number) < (field[best] as number) && s !== here)) {
          nearest = i;
        }
      }
      const charging = (): D4State => ({
        ...sample,
        players: [
          sample.players[0],
          { ...sample.players[1], cell: sample.stations[nearest] as number, pending: -1 as const },
        ],
        holder: sample.holder.map((_h, i) => (i === nearest ? 1 : -1)),
        battery: [sample.battery[0], 12],
      });
      const away = (): D4State => ({
        ...sample,
        players: [sample.players[0], { ...sample.players[1], cell: START_CELLS[1], pending: -1 as const }],
        holder: sample.holder.map(() => -1),
        battery: [sample.battery[0], 12],
      });
      if (bestFor(charging()) !== bestFor(away())) {
        changed += 1;
      }
    }
    expect(samples.length).toBeGreaterThanOrEqual(150);
    expect(changed / samples.length).toBeGreaterThanOrEqual(0.2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// decide 層盲測：完整資訊的牌，AI 不可以偷看 rng 與指紋計數（10.9：decide、evaluate、actions 都要測）
// ---------------------------------------------------------------------------

describe('D-4 電池｜盲測（decide、evaluate、actions）', () => {
  const NAMES = ['precise', 'greedy', 'gambler', 'pathfinder'] as const;
  const POLICIES: Record<(typeof NAMES)[number], Policy> = { precise, greedy, gambler, pathfinder };
  const DEPTHS = [1, 3, 6] as const;

  function snapshots(): D4State[] {
    const out: D4State[] = [];
    for (const seed of [1, 2]) {
      const a = levelController(d4Game, precise, 10, seed);
      const b = levelController(d4Game, gambler, 10, seed + 5);
      let state = d4Game.init(seed, CONFIG);
      for (let tick = 0; tick < 2400 && !d4Game.isOver(state); tick += 1) {
        if (tick % 97 === 3) {
          out.push(state);
        }
        state = d4Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
      }
    }
    return out;
  }

  /** 只改 rng 與 stuck（指紋用的累計）：這兩個欄位對規則沒有影響，AI 不該受影響。 */
  const scramble = (s: D4State, n: number): D4State => ({
    ...s,
    rng: (s.rng + 977 * (n + 1)) >>> 0,
    stuck: [s.stuck[0] + 3 * n, s.stuck[1] + 7 * n],
  });

  /** 黑箱：四個性格 × depth 1／3／6 × 兩邊的 decide。 */
  function decideLeaks(game: Game<D4State>, states: readonly D4State[]): string[] {
    const leaks: string[] = [];
    for (const s of states) {
      for (const side of [0, 1] as const) {
        for (const name of NAMES) {
          for (const depth of DEPTHS) {
            const params = { depth, seed: 1 };
            const seen = POLICIES[name].decide(game, s, side, 1, params);
            const other = POLICIES[name].decide(game, scramble(s, 1 + depth), side, 1, params);
            if (JSON.stringify(seen) !== JSON.stringify(other)) {
              leaks.push(`${name}/${depth}/tick ${s.tick}`);
            }
          }
        }
      }
    }
    return leaks;
  }

  /**
   * 相等性：evaluate 與 actions 在隱藏欄位不同時必須「完全相等」。
   * 為什麼不能只測 decide：對所有動作加同一個常數的洩漏不會改變排序（10.9）。
   */
  function equalityLeaks(game: Game<D4State>, states: readonly D4State[]): string[] {
    const leaks: string[] = [];
    for (const s of states) {
      const t = scramble(s, 3);
      for (const side of [0, 1] as const) {
        if (JSON.stringify(game.actions(s, side)) !== JSON.stringify(game.actions(t, side))) {
          leaks.push(`actions/tick ${s.tick}/side ${side}`);
        }
        const x = game.evaluate(s, side);
        const y = game.evaluate(t, side);
        if (x.gain !== y.gain || x.danger !== y.danger) {
          leaks.push(`evaluate/tick ${s.tick}/side ${side}`);
        }
        for (const action of ACTIONS) {
          const inputs: Inputs = side === 0 ? [action, NONE] : [NONE, action];
          const p = game.evaluate(game.step(s, inputs), side);
          const q = game.evaluate(game.step(t, inputs), side);
          if (p.gain !== q.gain || p.danger !== q.danger) {
            leaks.push(`evaluate-after-step/tick ${s.tick}/side ${side}`);
          }
        }
      }
    }
    return leaks;
  }

  /** 四種故意的洩漏。 */
  function leaky(kind: 'rng-const' | 'rng-position' | 'stuck' | 'actions-order'): Game<D4State> {
    return {
      ...d4Game,
      actions(s: D4State, side: Side) {
        const base = d4Game.actions(s, side);
        if (kind !== 'actions-order') {
          return base;
        }
        // 依 rng 轉動前四個動作的順序（全放開仍排最後）。
        const k = s.rng % 4;
        return [...base.slice(0, 4).map((_a, i) => base[(i + k) % 4] as Buttons), base[4] as Buttons];
      },
      evaluate(s: D4State, side: Side) {
        const base = d4Game.evaluate(s, side);
        if (kind === 'actions-order') {
          return base;
        }
        if (kind === 'rng-const') {
          // 對所有動作加「同一個」數：排序不變，decide 看不出來。
          return { gain: base.gain + ((s.rng % 7) - 3) * 30, danger: base.danger };
        }
        const me = s.players[side];
        const bias = kind === 'rng-position' ? ((s.rng % 7) - 3) * 30 : s.stuck[side] * 30;
        return { gain: base.gain + bias * ((cellX(me.cell) - 15) / 15), danger: base.danger };
      },
    };
  }

  const states = snapshots();

  it('取樣到的局面涵蓋開局、充電中、快沒電、沒電等各種時候', () => {
    expect(states.length).toBeGreaterThan(40);
    expect(states.some((s) => s.holder.some((h) => h >= 0))).toBe(true);
    expect(states.some((s) => s.battery[0] <= 8 || s.battery[1] <= 8)).toBe(true);
    expect(states.some((s) => s.battery[0] === 30 && s.battery[1] === 30)).toBe(true);
  });

  it('真的遊戲：只改 rng、stuck，四個性格 × depth 1／3／6 × 兩邊的 decide 完全不變', () => {
    expect(decideLeaks(d4Game, states)).toEqual([]);
  }, 120_000);

  it('真的遊戲：evaluate（含 step 之後）與 actions 在 rng、stuck 不同時完全相等', () => {
    expect(equalityLeaks(d4Game, states)).toEqual([]);
  }, 60_000);

  it('注入「偷看 rng、位置相關」的 evaluate：decide 層與相等性都抓得到（必須是紅的）', () => {
    expect(decideLeaks(leaky('rng-position'), states).length).toBeGreaterThan(0);
    expect(equalityLeaks(leaky('rng-position'), states).length).toBeGreaterThan(0);
  }, 120_000);

  it('注入「對所有動作加同一個常數」的 evaluate：相等性抓得到（這一型 decide 層抓不到，所以一定要有相等性）', () => {
    expect(equalityLeaks(leaky('rng-const'), states).length).toBeGreaterThan(0);
  }, 60_000);

  it('注入「偷看 stuck」的 evaluate：decide 層與相等性都抓得到', () => {
    expect(decideLeaks(leaky('stuck'), states).length).toBeGreaterThan(0);
    expect(equalityLeaks(leaky('stuck'), states).length).toBeGreaterThan(0);
  }, 120_000);

  it('注入「actions 的順序依 rng 轉動」：相等性抓得到', () => {
    expect(equalityLeaks(leaky('actions-order'), states).length).toBeGreaterThan(0);
  }, 60_000);
});
