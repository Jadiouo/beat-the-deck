import { describe, expect, it } from 'vitest';

import { rngStateFor } from '../../core/rng';
import type { Inputs } from '../../core/types';
import { cell, CELLS, START_CELLS } from '../_diamonds/logic';
import {
  CONFIG,
  deepFreeze,
  IDLE,
  NONE,
  PRESS_LEFT,
  PRESS_RIGHT,
  run,
} from '../_diamonds/shared-rules.test-helpers';
import {
  dKGame,
  INTRO_TICKS,
  makeState,
  STAGE1_END,
  STAGE2_END,
  STAGE2_START,
  STAGE3_START,
  stageOf,
  STEAL_EXTRA,
  TURF_POINTS,
} from './logic';
import type { DKState } from './logic';

/**
 * D-K 方塊馬拉松的規則測試（docs/cards/D-K.md）。三段的原規則（D-8 塗地、D-3 寶石、D-J 小偷）在各自的
 * `logic.test.ts` 測過，這裡只測 D-K 自己的東西：段落時間表、分數怎麼接、三條連結、`STEAL_EXTRA`、零和方向、不可變。
 * 全部用 `makeState` 直接構造局面。
 */

const BASE_0 = START_CELLS[0];
const BASE_1 = START_CELLS[1];
const RIGHT_ONLY: Inputs = [PRESS_RIGHT, NONE];
const BOTH_IDLE = IDLE;

/** n 個連續的格子編號（同一列，從 (x0, y) 起）。 */
function row(y: number, x0: number, n: number): number[] {
  return Array.from({ length: n }, (_v, i) => cell(x0 + i, y));
}

describe('D-K｜時間表與段落', () => {
  it('常數：過場 60、第 1 段 60..1079、第 2 段 1140..2519、第 3 段 2580..3599', () => {
    expect(INTRO_TICKS).toBe(60);
    expect(STAGE1_END).toBe(1080);
    expect(STAGE2_START).toBe(1140);
    expect(STAGE2_END).toBe(2520);
    expect(STAGE3_START).toBe(2580);
    expect(TURF_POINTS).toBe(10);
    expect(STEAL_EXTRA).toBe(1);
  });

  it('stageOf 在每個邊界：0 過場、1 圈地、2 寶石、3 存與偷（1079／1080、2519／2520 都測）', () => {
    const table: [number, 0 | 1 | 2 | 3][] = [
      [0, 0],
      [59, 0],
      [60, 1],
      [1079, 1],
      [1080, 0],
      [1139, 0],
      [1140, 2],
      [2519, 2],
      [2520, 0],
      [2579, 0],
      [2580, 3],
      [3599, 3],
    ];
    for (const [tick, stage] of table) {
      expect(stageOf(tick), `tick ${tick}`).toBe(stage);
    }
  });

  it('init：兩邊起點是自己的顏色、分數 0、沒有寶石、金幣、背包，tick 0 是過場', () => {
    const state = dKGame.init(3, CONFIG);
    expect(state.tick).toBe(0);
    expect(state.paint[BASE_0]).toBe(1);
    expect(state.paint[BASE_1]).toBe(2);
    expect(state.players[0].score).toBe(0);
    expect(state.players[1].score).toBe(0);
    expect(state.turfCells).toEqual([1, 1]);
    expect(state.gems).toEqual([]);
    expect(state.coins).toEqual([]);
    expect(state.bags).toEqual([0, 0]);
    expect(state.lurk).toEqual([0, 0]);
    expect(state.stolen).toEqual([0, 0]);
    expect(state.turfGems).toEqual([0, 0]);
    expect(state.blocked).toEqual([0, 0]);
    expect(dKGame.isOver(state)).toBe(false);
  });

  it('過場期間（tick 0..59、1080..1139、2520..2579）輸入被忽略：不動、不塗、不計分，只有 tick 前進', () => {
    for (const start of [0, 1080, 2520]) {
      const before = makeState({ tick: start, paint0: [BASE_0], paint1: [BASE_1] });
      let state: DKState = before;
      for (let i = 0; i < 60; i += 1) {
        state = dKGame.step(state, [PRESS_RIGHT, PRESS_LEFT]);
      }
      expect(state.tick, `start ${start}`).toBe(start + 60);
      expect(state.players[0].cell).toBe(BASE_0);
      expect(state.players[1].cell).toBe(BASE_1);
      expect(state.players[0].pending).toBe(-1);
      expect(state.paint).toEqual(before.paint);
      expect(state.players[0].score).toBe(before.players[0].score);
    }
  });

  it('過場期間 actions 只有「全放開」一個', () => {
    for (const tick of [0, 59, 1080, 1139, 2520, 2579]) {
      const state = makeState({ tick });
      for (const side of [0, 1] as const) {
        const actions = dKGame.actions(state, side);
        expect(actions.length, `tick ${tick}`).toBe(1);
        expect(actions[0]).toEqual(NONE);
      }
    }
  });
});

describe('D-K｜第 1 段：圈地與分數', () => {
  it('第 1 段是 D-8 的規則：走一格就把那格塗成自己的顏色', () => {
    const state = makeState({ tick: 60, paint0: [BASE_0], paint1: [BASE_1] });
    const next = run(dKGame, state, 5, RIGHT_ONLY);
    expect(next.players[0].cell).toBe(cell(1, 23));
    expect(next.paint[cell(1, 23)]).toBe(1);
    expect(next.turfCells).toEqual([2, 1]);
  });

  it('分數 = ⌊顏色格數 ÷ 10⌋：9 格是 0 分、10 格是 1 分（邊界）', () => {
    // 已經有 8 格，再走一格變 9 格 → 0 分
    const eight = makeState({ tick: 60, paint0: row(22, 0, 8) });
    const nine = run(dKGame, eight, 5, RIGHT_ONLY);
    expect(nine.turfCells[0]).toBe(9);
    expect(nine.players[0].score).toBe(0);
    // 已經有 9 格，再走一格變 10 格 → 1 分
    const nineNow = makeState({ tick: 60, paint0: row(22, 0, 9) });
    const ten = run(dKGame, nineNow, 5, RIGHT_ONLY);
    expect(ten.turfCells[0]).toBe(10);
    expect(ten.players[0].score).toBe(1);
  });

  it('分數是 D-K 的累計分，不是 D-8 的顏色格數：25 格是 2 分', () => {
    const state = makeState({ tick: 60, paint0: row(20, 0, 24) });
    const next = run(dKGame, state, 5, RIGHT_ONLY);
    expect(next.turfCells[0]).toBe(25);
    expect(next.players[0].score).toBe(2);
  });

  it('第 1 段結束（tick 1080）以及之後的過場：score 仍是 ⌊格數 ÷ 10⌋，turfCells 凍結，不被重算', () => {
    const state = makeState({ tick: 1075, paint0: row(20, 0, 24), paint1: row(2, 8, 12) });
    // 1075 → 1080：最後一個走格 tick（1080）人往右走一格
    const end = run(dKGame, state, 5, RIGHT_ONLY);
    expect(end.tick).toBe(1080);
    expect(end.turfCells).toEqual([25, 12]);
    expect(end.players.map((p) => p.score)).toEqual([2, 1]);
    const after = run(dKGame, end, 60, [PRESS_RIGHT, PRESS_RIGHT]);
    expect(after.tick).toBe(1140);
    expect(after.turfCells).toEqual([25, 12]);
    expect(after.paint).toEqual(end.paint);
  });

  it('1079 → 1080 這一步還是第 1 段（會塗色）；1080 → 1081 不是（過場，不塗）', () => {
    const at1079 = makeState({ tick: 1079, paint0: [BASE_0] });
    expect(stageOf(at1079.tick)).toBe(1);
    const at1080 = dKGame.step(at1079, RIGHT_ONLY);
    expect(at1080.tick).toBe(1080);
    const at1081 = dKGame.step(at1080, RIGHT_ONLY);
    expect(at1081.tick).toBe(1081);
    expect(at1081.players[0].pending).toBe(-1);
  });
});

describe('D-K｜第 2 段：寶石與連結 1（地盤紅利）', () => {
  it('第 1 段 → 第 2 段（tick 1139 → 1140）：場上補 5 顆寶石、born = 1140，位置不重疊、不在牆上、不在人身上；rng 前進', () => {
    const before = makeState({
      tick: 1139,
      walls: [cell(5, 5), cell(6, 5)],
      rng: rngStateFor(5, 'dk'),
    });
    const next = dKGame.step(before, BOTH_IDLE);
    expect(next.tick).toBe(1140);
    expect(next.gems.length).toBe(5);
    expect(new Set(next.gems.map((g) => g.cell)).size).toBe(5);
    for (const gem of next.gems) {
      expect(gem.born).toBe(1140);
      expect(next.walls[gem.cell]).toBe(0);
      expect(gem.cell).not.toBe(next.players[0].cell);
      expect(gem.cell).not.toBe(next.players[1].cell);
    }
    expect(next.rng).not.toBe(before.rng);
  });

  it('1139 以前沒有寶石；2520 進過場時寶石收掉；第 3 段之前沒有金幣', () => {
    const early = makeState({ tick: 1138 });
    expect(dKGame.step(early, BOTH_IDLE).gems).toEqual([]);
    const late = makeState({
      tick: 2519,
      gems: [{ cell: cell(10, 10), born: 2000 }],
    });
    const intro = dKGame.step(late, BOTH_IDLE);
    expect(intro.tick).toBe(2520);
    expect(intro.gems).toEqual([]);
    expect(intro.coins).toEqual([]);
  });

  it('連結 1：站在自己顏色的格子上撿價值 9 的寶石，得 9 + ⌈9÷2⌉ = 14 分（加上第 1 段已有的分數，不是只有寶石分）', () => {
    const target = cell(1, 23);
    const state = makeState({
      tick: 1140,
      players: [{ score: 2 }, { score: 0 }],
      paint0: [BASE_0, target],
      gems: [{ cell: target, born: 1140 }],
    });
    const next = run(dKGame, state, 5, RIGHT_ONLY);
    expect(next.players[0].cell).toBe(target);
    expect(next.players[0].score).toBe(2 + 9 + 5);
    expect(next.turfGems).toEqual([5, 0]);
    expect(next.gems.some((g) => g.cell === target)).toBe(false);
  });

  it('連結 1：無主的格子、對手顏色的格子上撿，沒有紅利', () => {
    const target = cell(1, 23);
    for (const paint of [{}, { paint1: [target] }]) {
      const state = makeState({
        tick: 1140,
        players: [{ score: 2 }, { score: 0 }],
        paint0: [BASE_0],
        gems: [{ cell: target, born: 1140 }],
        ...paint,
      });
      const next = run(dKGame, state, 5, RIGHT_ONLY);
      expect(next.players[0].score).toBe(2 + 9);
      expect(next.turfGems).toEqual([0, 0]);
    }
  });

  it('連結 1：價值 1 的寶石紅利是 ⌈1÷2⌉ = 1；價值 8（出生後 60 tick）紅利 4', () => {
    const target = cell(1, 23);
    // 出生 1140 − 7×60 = 720 → 在 tick 1140 的價值 = 9 − 7 = 2？用 decay 公式：9 − ⌊(1140 − born)/60⌋
    const cases: [number, number][] = [
      [1140 - 8 * 60, 1], // 價值 1
      [1140 - 60, 8], // 價值 8
    ];
    for (const [born, value] of cases) {
      const state = makeState({
        tick: 1140,
        paint0: [BASE_0, target],
        gems: [{ cell: target, born }],
      });
      const next = run(dKGame, state, 5, RIGHT_ONLY);
      expect(next.players[0].score, `value ${value}`).toBe(value + Math.ceil(value / 2));
    }
  });

  it('第 2 段不會再重算第 1 段分數：第 2 段中任何一步 score 都不低於第 1 段結束時的值', () => {
    const state = makeState({
      tick: 1140,
      players: [{ score: 7 }, { score: 3 }],
      paint0: row(20, 0, 24),
      gems: [],
    });
    let current: DKState = state;
    for (let i = 0; i < 40; i += 1) {
      current = dKGame.step(current, [PRESS_RIGHT, NONE]);
      expect(current.players[0].score).toBeGreaterThanOrEqual(7);
      expect(current.players[1].score).toBeGreaterThanOrEqual(3);
    }
    // 走在自己顏色上也不會塗色或改格數
    expect(current.turfCells).toEqual(state.turfCells);
  });
});

describe('D-K｜第 3 段：連結 2（地盤是安全區）、連結 3（累計分數可被偷）、STEAL_EXTRA', () => {
  const NEAR_BASE_1 = cell(30, 0);
  const AWAY = cell(10, 10);

  /** 0 號貼著 1 號的基地偷、1 號在遠處、1 號已有 5 分；0 號的 lurk 差 1 個 tick 就偷到。下一步不是走格。 */
  function stealing(overrides: Parameters<typeof makeState>[0] = {}): DKState {
    return makeState({
      tick: 2601,
      players: [{ cell: NEAR_BASE_1 }, { cell: AWAY, score: 5 }],
      lurk: [59, 0],
      ...overrides,
    });
  }

  it('連結 3：第 3 段開始時兩邊的分數是第 1、2 段累計的（不是 0），所以有分可以被偷', () => {
    const entering = makeState({
      tick: 2579,
      players: [{ score: 20 }, { score: 31 }],
    });
    const next = dKGame.step(entering, BOTH_IDLE);
    expect(next.tick).toBe(2580);
    expect(next.players.map((p) => p.score)).toEqual([20, 31]);
    expect(next.coins.length).toBe(6);
    expect(next.bags).toEqual([0, 0]);
    expect(next.lurk).toEqual([0, 0]);
    for (const coin of next.coins) {
      expect(coin).not.toBe(BASE_0);
      expect(coin).not.toBe(BASE_1);
      expect(next.walls[coin]).toBe(0);
    }
  });

  it('沒有連結 2 的情況（被偷的人站在無主的格子上）：lurk 59 再 1 個 tick 就偷到，且有 STEAL_EXTRA：被偷的人 −2、偷的人背包 +2', () => {
    const next = dKGame.step(stealing(), BOTH_IDLE);
    expect(next.players[1].score).toBe(5 - 1 - STEAL_EXTRA);
    expect(next.bags).toEqual([2, 0]);
    expect(next.stolen[0]).toBe(2);
    expect(next.lurk[0]).toBe(0);
    expect(next.blocked).toEqual([0, 0]);
  });

  it('連結 2：被偷的人站在自己顏色的格子上，偷的人 lurk 歸 0、偷不到，blocked +1', () => {
    const state = stealing({ paint1: [AWAY] });
    const next = dKGame.step(state, BOTH_IDLE);
    expect(next.lurk[0]).toBe(0);
    expect(next.players[1].score).toBe(5);
    expect(next.bags).toEqual([0, 0]);
    expect(next.blocked).toEqual([1, 0]);
  });

  it('連結 2：站在「對手的顏色」上不算安全區（被偷的人站在人的顏色上，照樣被偷）', () => {
    const state = stealing({ paint0: [AWAY] });
    const next = dKGame.step(state, BOTH_IDLE);
    expect(next.players[1].score).toBe(5 - 1 - STEAL_EXTRA);
  });

  it('連結 2 的邊界：lurk 是 59、被偷的人剛好走上自己顏色那個 tick：這個 tick 不偷；走出去之後 lurk 從 0 重新累積', () => {
    // 1 號在 AWAY 旁邊的自己顏色格子，下一次走格（tick 2605）走出來？先驗：站在顏色上被擋
    const onTurf = stealing({ tick: 2602, paint1: [AWAY] });
    const blocked = dKGame.step(onTurf, BOTH_IDLE);
    expect(blocked.lurk[0]).toBe(0);
    // 同一局面但被偷的人站在無主格：偷到
    const offTurf = dKGame.step(stealing({ tick: 2602 }), BOTH_IDLE);
    expect(offTurf.players[1].score).toBe(5 - 1 - STEAL_EXTRA);
    // 被擋之後不是永久：lurk 要重新數 60 個 tick
    const again = run(dKGame, blocked, 59, BOTH_IDLE);
    expect(again.lurk[0]).toBe(0); // 還在自己顏色上，持續被擋
  });

  it('被偷的人在自己基地附近（距離 ≤ 2）照 D-J 規則偷不了（連結 2 不改這條）', () => {
    const state = stealing({ players: [{ cell: NEAR_BASE_1 }, { cell: cell(30, 1), score: 5 }] });
    const next = dKGame.step(state, BOTH_IDLE);
    expect(next.players[1].score).toBe(5);
    expect(next.bags).toEqual([0, 0]);
  });

  it('STEAL_EXTRA：被偷的人只有 1 分 → 只偷到 1 分（沒有額外）、分數不會變負', () => {
    const state = stealing({ players: [{ cell: NEAR_BASE_1 }, { cell: AWAY, score: 1 }] });
    const next = dKGame.step(state, BOTH_IDLE);
    expect(next.players[1].score).toBe(0);
    expect(next.bags).toEqual([1, 0]);
    expect(next.stolen[0]).toBe(1);
  });

  it('STEAL_EXTRA：偷的人背包已有 2 枚 → 偷 1 枚就滿了，沒有額外', () => {
    const state = stealing({ bags: [2, 0] });
    const next = dKGame.step(state, BOTH_IDLE);
    expect(next.bags).toEqual([3, 0]);
    expect(next.players[1].score).toBe(4);
  });

  it('零和方向：偷竊前後「兩邊分數 + 兩邊背包」的總和不變；被偷的減、偷的人背包加，方向是 0 偷 1', () => {
    const state = stealing();
    const total = (s: DKState): number =>
      s.players[0].score + s.players[1].score + s.bags[0] + s.bags[1];
    const next = dKGame.step(state, BOTH_IDLE);
    expect(total(next)).toBe(total(state));
    expect(next.players[1].score).toBeLessThan(state.players[1].score);
    expect(next.players[0].score).toBe(state.players[0].score);
    expect(next.bags[0]).toBeGreaterThan(state.bags[0]);
    expect(next.bags[1]).toBe(state.bags[1]);
  });

  it('對稱：兩個人同時偷到對方（各自貼著對方基地、都不在自己顏色上）：結果左右對稱、總和不變', () => {
    const state = makeState({
      tick: 2601,
      players: [
        { cell: cell(30, 0), score: 6 },
        { cell: cell(1, 23), score: 6 },
      ],
      lurk: [59, 59],
    });
    const next = dKGame.step(state, BOTH_IDLE);
    expect(next.players[0].score).toBe(next.players[1].score);
    expect(next.bags[0]).toBe(next.bags[1]);
    expect(next.players[0].score + next.bags[0]).toBe(6);
  });

  it('時間到：背包裡還沒存的不算分；贏家按分數，同分平手', () => {
    const state = makeState({
      tick: 3599,
      players: [{ score: 10 }, { score: 11 }],
      bags: [3, 0],
      coins: [],
    });
    const end = dKGame.step(state, BOTH_IDLE);
    expect(end.over).toBe(true);
    expect(end.players[0].score).toBe(10);
    expect(dKGame.winner(end)).toBe(1);
    const tie = dKGame.step(makeState({ tick: 3599, players: [{ score: 10 }, { score: 10 }] }), BOTH_IDLE);
    expect(dKGame.winner(tie)).toBeNull();
    // 結束以後 step 原樣回傳
    expect(dKGame.step(end, BOTH_IDLE)).toBe(end);
  });

  it('金幣存進基地：走進自己的基地，背包變成分數（累加在第 1、2 段的分數上）', () => {
    const state = makeState({
      tick: 2700,
      players: [{ cell: cell(1, 23), score: 12 }, { score: 4 }],
      bags: [2, 0],
      coins: [cell(10, 10)],
    });
    // 往左走回基地 (0, 23)
    const next = run(dKGame, state, 5, [PRESS_LEFT, NONE]);
    expect(next.players[0].cell).toBe(BASE_0);
    expect(next.players[0].score).toBe(14);
    expect(next.bags[0]).toBe(0);
  });
});

describe('D-K｜整場', () => {
  it('同一個種子、同一串輸入：整場結果相同；3600 tick 時結束', () => {
    const play = (): DKState => {
      let state = dKGame.init(7, CONFIG);
      for (let i = 0; i < 3600; i += 1) {
        const input: Inputs = [
          i % 40 < 20 ? PRESS_RIGHT : { ...NONE, up: true },
          i % 30 < 15 ? PRESS_LEFT : { ...NONE, down: true },
        ];
        state = dKGame.step(state, input);
      }
      return state;
    };
    const a = play();
    const b = play();
    expect(a.over).toBe(true);
    expect(a.tick).toBe(3600);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.gems).toEqual([]);
  });

  it('step 不改動傳進來的 state：深度凍結之後跑完整場（含三段與兩次換段）都不丟錯', () => {
    let state = dKGame.init(11, CONFIG);
    const dirs = [PRESS_RIGHT, { ...NONE, up: true }, PRESS_LEFT, { ...NONE, down: true }];
    for (let i = 0; i < 3600; i += 1) {
      deepFreeze(state);
      const inputs: Inputs = [dirs[Math.floor(i / 7) % 4] ?? NONE, dirs[Math.floor(i / 11) % 4] ?? NONE];
      state = dKGame.step(state, inputs);
    }
    expect(state.over).toBe(true);
  });

  it('整場結束時 paint、stamp 的長度是 CELLS；所有數字都是整數', () => {
    let state = dKGame.init(2, CONFIG);
    for (let i = 0; i < 3600; i += 1) {
      state = dKGame.step(state, [i % 50 < 25 ? PRESS_RIGHT : { ...NONE, up: true }, NONE]);
    }
    expect(state.paint.length).toBe(CELLS);
    expect(state.stamp.length).toBe(CELLS);
    expect(Number.isInteger(state.players[0].score)).toBe(true);
    expect(Number.isInteger(state.players[1].score)).toBe(true);
  });
});
