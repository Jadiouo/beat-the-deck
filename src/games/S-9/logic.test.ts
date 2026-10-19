import { describe, expect, it } from 'vitest';

import type { Buttons, Inputs } from '../../core/types';
import { deepFreeze } from '../../../tests/contract/freeze';
import {
  CELL,
  COLS,
  CRUMBLE_TICKS,
  FIELD_H,
  FIELD_W,
  GONE,
  MAX_ROUNDS,
  MIN_MAX_TICKS,
  REST_TICKS,
  ROWS,
  TILES,
  evaluateS9,
  headingBlocked,
  makeState,
  roundLimit,
  rotated,
  s9Game,
  soloReach,
  territory,
  tileAt,
  tileCenter,
  tileIndex,
} from './logic';
import type { S9State } from './logic';

/**
 * S-9 縮小的場地的規則測試（小規格 `docs/cards/S-9.md`「規則測試要涵蓋」）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。0 號邊是人（起點在左上），1 號邊是 AI（轉 180 度）。
 * 格子編號 = 列 × 10 + 欄；`tileIndex(欄, 列)`。座標單位是像素，場地 150 × 210，每格 15 × 15。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const press = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const IDLE: Inputs = [NONE, NONE];
const CONFIG = { maxTicks: 4500, params: {} };

function run(state: S9State, count: number, inputs: Inputs = IDLE): S9State {
  let s = state;
  for (let i = 0; i < count; i += 1) {
    s = s9Game.step(s, inputs);
  }
  return s;
}

/** 欄、列的格子中心（像素）。 */
const at = (col: number, row: number): { x: number; y: number } => tileCenter(tileIndex(col, row));

/** 人站在 (欄, 列) 的中心、AI 站在轉 180 度的格子的中心。 */
function placed(col: number, row: number, overrides: Parameters<typeof makeState>[0] = {}): S9State {
  const a = at(col, row);
  const b = at(COLS - 1 - col, ROWS - 1 - row);
  return makeState({ ...overrides, players: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] });
}

// ---------------------------------------------------------------------------
// 幾何
// ---------------------------------------------------------------------------

describe('S-9 縮小的場地｜幾何', () => {
  it('10 欄 × 14 列、每格 15 × 15、共 140 格；場地 150 × 210', () => {
    expect([COLS, ROWS, CELL, TILES, FIELD_W, FIELD_H]).toEqual([10, 14, 15, 140, 150, 210]);
  });

  it('（邊界）圓心剛好在格邊界上算右邊／下邊那一格：x = 15 是第 1 欄、x = 14.999 是第 0 欄；y 同理', () => {
    expect(tileAt(14.999, 0)).toBe(0);
    expect(tileAt(15, 0)).toBe(1);
    expect(tileAt(0, 14.999)).toBe(0);
    expect(tileAt(0, 15)).toBe(10);
    expect(tileAt(30, 45)).toBe(tileIndex(2, 3));
    expect(tileAt(147, 207)).toBe(139);
  });

  it('轉 180 度：格子 i 對應 139 − i；格子中心也是', () => {
    expect(rotated(0)).toBe(139);
    expect(rotated(tileIndex(4, 6))).toBe(tileIndex(5, 7));
    const c = tileCenter(tileIndex(2, 3));
    const r = tileCenter(rotated(tileIndex(2, 3)));
    expect([c.x + r.x, c.y + r.y]).toEqual([FIELD_W, FIELD_H]);
  });

  it('一回合最多 min(1200, floor((maxTicks − 180) / 4)) tick；四回合加三次停頓放得進 maxTicks', () => {
    expect(roundLimit(4500)).toBe(1080);
    expect(roundLimit(3600)).toBe(855);
    expect(roundLimit(600)).toBe(105);
    expect(roundLimit(9000)).toBe(1200);
    for (const maxTicks of [600, 1000, 3600, 4500, 5000]) {
      expect(MAX_ROUNDS * roundLimit(maxTicks) + (MAX_ROUNDS - 1) * REST_TICKS).toBeLessThanOrEqual(
        maxTicks,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 初始
// ---------------------------------------------------------------------------

describe('S-9 縮小的場地｜初始', () => {
  it('開局：140 格，只有兩個起點格在崩落中（t = 45），其餘新鮮；第 0 回合、0 比 0、進行中', () => {
    const s = s9Game.init(3, CONFIG);
    expect(s.tiles).toHaveLength(140);
    const crumbling = s.tiles.map((t, i) => [t, i] as const).filter(([t]) => t !== 0);
    expect(crumbling).toHaveLength(2);
    expect(crumbling.every(([t]) => t === CRUMBLE_TICKS)).toBe(true);
    expect([s.tick, s.round, s.roundTick, s.phase]).toEqual([0, 0, 0, 'play']);
    expect(s.wins).toEqual([0, 0]);
    expect(s9Game.score(s)).toEqual([0, 0]);
    expect(s9Game.isOver(s)).toBe(false);
    expect(s9Game.winner(s)).toBeNull();
  });

  it('起點對稱：兩人各站在自己的起點格，AI 的格子是人的格子轉 180 度；人在左上四分之一（欄 0–4、列 0–6）', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const s = s9Game.init(seed, CONFIG);
      const human = tileAt(s.players[0].x, s.players[0].y);
      const ai = tileAt(s.players[1].x, s.players[1].y);
      expect(ai, `seed ${seed}`).toBe(rotated(human));
      expect(human % COLS, `seed ${seed} 欄`).toBeLessThanOrEqual(4);
      expect(Math.floor(human / COLS), `seed ${seed} 列`).toBeLessThanOrEqual(6);
      expect(s.tiles[human]).toBe(CRUMBLE_TICKS);
      expect(s.tiles[ai]).toBe(CRUMBLE_TICKS);
      // 圓心整個轉 180 度對稱：x、y 加起來剛好是場地的寬、高
      expect([s.players[0].x + s.players[1].x, s.players[0].y + s.players[1].y]).toEqual([
        FIELD_W,
        FIELD_H,
      ]);
    }
  });

  it('起點不會剛好站在格邊界上（全速的步長 1.5 加上去不會踩到邊界，否則「邊界算右邊」對 180 度轉不對稱）', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const p = s9Game.init(seed, CONFIG).players;
      for (const player of p) {
        expect(player.x % CELL, `seed ${seed} x`).not.toBe(0);
        expect(player.y % CELL, `seed ${seed} y`).not.toBe(0);
        expect((player.x - 7.5) % 1.5, `seed ${seed} 離中心不是 1.5 的倍數`).not.toBe(0);
      }
    }
  });

  it('起點由種子決定：同種子相同、種子 0 到 19 至少出現 8 種起點格', () => {
    expect(s9Game.init(7, CONFIG)).toEqual(s9Game.init(7, CONFIG));
    const starts = new Set(
      Array.from({ length: 20 }, (_, seed) => {
        const s = s9Game.init(seed, CONFIG);
        return tileAt(s.players[0].x, s.players[0].y);
      }),
    );
    expect(starts.size).toBeGreaterThanOrEqual(8);
  });

  it('maxTicks 小於 600 丟 RangeError（600 可以）；不是整數也丟', () => {
    expect(() => s9Game.init(0, { maxTicks: MIN_MAX_TICKS - 1, params: {} })).toThrow(RangeError);
    expect(() => s9Game.init(0, { maxTicks: 1000.5, params: {} })).toThrow(RangeError);
    expect(s9Game.init(0, { maxTicks: MIN_MAX_TICKS, params: {} }).maxTicks).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// 移動
// ---------------------------------------------------------------------------

describe('S-9 縮小的場地｜移動', () => {
  it('八方向 1.5（斜向合速度也是 1.5）、按住 a 是 0.6；上一個 tick 的速度記在 vx、vy', () => {
    const s = placed(2, 3);
    const p = s.players[0];
    const right = s9Game.step(s, [press({ right: true }), NONE]);
    expect(right.players[0].x).toBeCloseTo(p.x + 1.5, 10);
    expect([right.players[0].vx, right.players[0].vy]).toEqual([1.5, 0]);
    const diag = s9Game.step(s, [press({ left: true, up: true }), NONE]);
    expect(Math.hypot(diag.players[0].x - p.x, diag.players[0].y - p.y)).toBeCloseTo(1.5, 10);
    const slow = s9Game.step(s, [press({ down: true, a: true }), NONE]);
    expect(slow.players[0].y).toBeCloseTo(p.y + 0.6, 10);
    expect(s9Game.step(right, IDLE).players[0].vx).toBe(0);
  });

  it('（邊界）夾在場地內：半徑 3，所以 x 在 [3, 147]、y 在 [3, 207]', () => {
    const s = makeState({ players: [{ x: 4, y: 4 }, { x: 146, y: 206 }] });
    const moved = run(s, 5, [press({ left: true, up: true }), press({ right: true, down: true })]);
    expect([moved.players[0].x, moved.players[0].y]).toEqual([3, 3]);
    expect([moved.players[1].x, moved.players[1].y]).toEqual([147, 207]);
  });

  it('兩人可以重疊（沒有碰撞）；對手的按鍵不會移動我', () => {
    const s = makeState({ players: [{ x: 60, y: 100 }, { x: 62, y: 100 }] });
    const moved = run(s, 3, [press({ right: true }), NONE]);
    expect(moved.players[0].x).toBeCloseTo(64.5, 10);
    expect(moved.players[1].x).toBe(62);
    expect(run(s, 3, [NONE, press({ left: true })]).players[0].x).toBe(60);
  });

  it('動作：進行中 17 個（全放開排第一、八方向全速、八方向加 a）；AI 那一邊是人那一邊轉 180 度（第 k 個互為鏡像）', () => {
    const s = placed(2, 3);
    const human = s9Game.actions(s, 0);
    const ai = s9Game.actions(s, 1);
    expect(human).toHaveLength(17);
    expect(ai).toHaveLength(17);
    expect(human[0]).toEqual(NONE);
    expect(human.slice(1, 9).every((b) => !b.a)).toBe(true);
    expect(human.slice(9).every((b) => b.a)).toBe(true);
    for (let k = 0; k < 17; k += 1) {
      const h = human[k] as Buttons;
      const a = ai[k] as Buttons;
      expect([a.up, a.down, a.left, a.right, a.a]).toEqual([h.down, h.up, h.right, h.left, h.a]);
    }
  });

  it('動作：停頓與整場結束只有一個（全放開）', () => {
    expect(s9Game.actions(placed(2, 3, { phase: 'rest' }), 0)).toEqual([NONE]);
    expect(s9Game.actions(placed(2, 3, { phase: 'over' }), 1)).toEqual([NONE]);
  });
});

// ---------------------------------------------------------------------------
// 格子崩落
// ---------------------------------------------------------------------------

describe('S-9 縮小的場地｜格子崩落', () => {
  it('踩到：圓心所在的新鮮格子變成崩落中，t = 45（踩到的那個 tick 不減）', () => {
    const s = placed(2, 3);
    const home = tileIndex(2, 3);
    expect(s.tiles[home]).toBe(0);
    const after = s9Game.step(s, IDLE);
    expect(after.tiles[home]).toBe(CRUMBLE_TICKS);
    expect(after.tiles[rotated(home)]).toBe(CRUMBLE_TICKS);
    expect(after.tiles.filter((t) => t !== 0)).toHaveLength(2);
  });

  it('每個 tick 崩落中的格子 t 減 1：踩到之後第 44 個 tick 還剩 1，第 45 個 tick 變 gone（不管上面有沒有人）', () => {
    const home = tileIndex(2, 3);
    // 兩個人都站在別處，這一格自己崩落
    const s = makeState({ tiles: { [home]: CRUMBLE_TICKS }, players: [at(7, 1), at(2, 12)] });
    const t44 = run(s, 44);
    expect(t44.tiles[home]).toBe(1);
    expect(t44.phase).toBe('play');
    const t45 = s9Game.step(t44, IDLE);
    expect(t45.tiles[home]).toBe(GONE);
    expect(t45.phase).toBe('play');
  });

  it('已經在崩落中的格子被別人踩到不重置（t 繼續照原本的減）', () => {
    const home = tileIndex(4, 5);
    const c = at(4, 5);
    const s = makeState({ tiles: { [home]: 20 }, players: [{ x: c.x, y: c.y }, at(8, 12)] });
    const after = s9Game.step(s, IDLE);
    expect(after.tiles[home]).toBe(19);
  });

  it('（邊界）往右走到 x = 15.0 剛好踩進第 1 欄；往左走到 x = 13.5 回到第 0 欄', () => {
    const s = makeState({ players: [{ x: 13.5, y: 7.5 }, { x: 140, y: 200 }] });
    const right = s9Game.step(s, [press({ right: true }), NONE]);
    expect(right.players[0].x).toBe(15);
    expect(right.tiles[1]).toBe(CRUMBLE_TICKS);
    expect(right.tiles[0]).toBe(0);
    const back = makeState({ players: [{ x: 15, y: 7.5 }, { x: 140, y: 200 }] });
    const left = s9Game.step(back, [press({ left: true }), NONE]);
    expect(left.players[0].x).toBe(13.5);
    expect(left.tiles[0]).toBe(CRUMBLE_TICKS);
    expect(left.tiles[1]).toBe(0);
    const down = s9Game.step(
      makeState({ players: [{ x: 7.5, y: 13.5 }, { x: 140, y: 200 }] }),
      [press({ down: true }), NONE],
    );
    expect(down.tiles[tileIndex(0, 1)]).toBe(CRUMBLE_TICKS);
  });

  it('慢走（按住 a）一格要 25 個 tick，所以在同一格待更久', () => {
    let s = makeState({ players: [{ x: 0.1 + 3, y: 7.5 }, { x: 140, y: 200 }] });
    let ticks = 0;
    while (tileAt(s.players[0].x, s.players[0].y) === 0) {
      s = s9Game.step(s, [press({ right: true, a: true }), NONE]);
      ticks += 1;
    }
    expect(ticks).toBe(Math.ceil((15 - 3.1) / 0.6));
  });
});

// ---------------------------------------------------------------------------
// 掉下去
// ---------------------------------------------------------------------------

describe('S-9 縮小的場地｜掉下去', () => {
  it('腳下的格子掉了：這個人輸這一回合，對方得 1 分，進入停頓', () => {
    const c0 = at(2, 3);
    const s = makeState({
      tiles: { [tileIndex(2, 3)]: 1 },
      players: [{ x: c0.x, y: c0.y }, at(8, 10)],
    });
    const after = s9Game.step(s, IDLE);
    expect(after.fell).toEqual([true, false]);
    expect(after.outcome).toBe('side1');
    expect(after.wins).toEqual([0, 1]);
    expect(after.phase).toBe('rest');
    expect(after.roundTick).toBe(0);
  });

  it('走進洞（圓心進了已掉的格子）也算掉下去；AI 掉了就是人得分', () => {
    const hole = tileIndex(3, 3);
    // 1 號邊在第 2 欄的右緣內側（x = 42），往右走 2 步到 x = 45 進入第 3 欄（洞）
    const s = makeState({
      tiles: { [hole]: GONE },
      players: [at(8, 10), { x: 42, y: 52.5 }],
    });
    const one = s9Game.step(s, [NONE, press({ right: true })]);
    expect(one.phase).toBe('play');
    const after = s9Game.step(one, [NONE, press({ right: true })]);
    expect(after.fell).toEqual([false, true]);
    expect(after.outcome).toBe('side0');
    expect(after.wins).toEqual([1, 0]);
  });

  it('（邊界）同一個 tick 兩邊都掉：這一回合平手，沒有人得分', () => {
    const a = at(2, 3);
    const b = at(7, 10);
    const s = makeState({
      tiles: { [tileIndex(2, 3)]: 1, [tileIndex(7, 10)]: 1 },
      players: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
    });
    const after = s9Game.step(s, IDLE);
    expect(after.fell).toEqual([true, true]);
    expect(after.outcome).toBe('draw');
    expect(after.wins).toEqual([0, 0]);
    expect(after.phase).toBe('rest');
  });

  it('（邊界）一個人走進洞、另一個人腳下的格子同一個 tick 掉了：也是平手', () => {
    const hole = tileIndex(3, 3);
    const b = at(7, 10);
    const s = makeState({
      tiles: { [hole]: GONE, [tileIndex(7, 10)]: 1 },
      players: [{ x: 44.9, y: 52.5 }, { x: b.x, y: b.y }],
    });
    const after = s9Game.step(s, [press({ right: true }), NONE]);
    expect(after.fell).toEqual([true, true]);
    expect(after.outcome).toBe('draw');
  });

  it('（邊界）腳下的格子這個 tick 剛好掉，但人在同一個 tick 已經走出去了：沒事；站著不動才掉', () => {
    const c = at(2, 3);
    // 圓心在格子右緣內側 1 像素：往右走一步就離開這一格
    const x = (2 + 1) * CELL - 1;
    const s = makeState({
      tiles: { [tileIndex(2, 3)]: 1 },
      players: [{ x, y: c.y }, at(8, 10)],
    });
    const left = s9Game.step(s, [press({ right: true }), NONE]);
    expect(left.fell).toEqual([false, false]);
    expect(left.phase).toBe('play');
    const stayed = s9Game.step(s, IDLE);
    expect(stayed.fell).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// 回合與停頓
// ---------------------------------------------------------------------------

/** 讓 AI（1 號邊）腳下的格子在下一步掉下去，人安全。 */
function aiFallsNext(overrides: Parameters<typeof makeState>[0] = {}): S9State {
  const a = at(2, 3);
  const b = at(7, 10);
  return makeState({
    ...overrides,
    tiles: { [tileIndex(7, 10)]: 1, ...(overrides.tiles ?? {}) },
    players: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
  });
}

function humanFallsNext(overrides: Parameters<typeof makeState>[0] = {}): S9State {
  const a = at(2, 3);
  const b = at(7, 10);
  return makeState({
    ...overrides,
    tiles: { [tileIndex(2, 3)]: 1, ...(overrides.tiles ?? {}) },
    players: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
  });
}

describe('S-9 縮小的場地｜三戰兩勝、最多 4 回合、停頓', () => {
  it('先贏 2 回合的贏：1 比 0 領先再贏一回合 → 整場結束，贏家是 0 號邊', () => {
    const after = s9Game.step(aiFallsNext({ wins: [1, 0], round: 1 }), IDLE);
    expect(after.wins).toEqual([2, 0]);
    expect(after.phase).toBe('over');
    expect(s9Game.isOver(after)).toBe(true);
    expect(s9Game.winner(after)).toBe(0);
    expect(s9Game.score(after)).toEqual([2, 0]);
  });

  it('1 比 0 之後輸一回合 → 1 比 1，進入停頓，整場還沒結束', () => {
    const after = s9Game.step(humanFallsNext({ wins: [1, 0], round: 1 }), IDLE);
    expect(after.wins).toEqual([1, 1]);
    expect(after.phase).toBe('rest');
    expect(s9Game.isOver(after)).toBe(false);
    expect(s9Game.winner(after)).toBeNull();
  });

  it('1 比 1 的第 3 回合（索引 2）分出勝負 → 整場結束，不會有第 4 回合', () => {
    const after = s9Game.step(humanFallsNext({ wins: [1, 1], round: 2 }), IDLE);
    expect(after.wins).toEqual([1, 2]);
    expect(after.phase).toBe('over');
    expect(s9Game.winner(after)).toBe(1);
  });

  it('（邊界）打滿 4 回合：回合勝數多的贏；同數平手', () => {
    // 第 4 回合（索引 3）平手：1 比 0 領先 → 1 比 0 贏
    const a = at(2, 3);
    const b = at(7, 10);
    const bothFall = makeState({
      round: 3,
      wins: [1, 0],
      tiles: { [tileIndex(2, 3)]: 1, [tileIndex(7, 10)]: 1 },
      players: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
    });
    const drawn = s9Game.step(bothFall, IDLE);
    expect(drawn.phase).toBe('over');
    expect(drawn.wins).toEqual([1, 0]);
    expect(s9Game.winner(drawn)).toBe(0);
    // 四回合全平手：0 比 0，平手
    const allDrawn = s9Game.step({ ...bothFall, wins: [0, 0] }, IDLE);
    expect(allDrawn.phase).toBe('over');
    expect(s9Game.winner(allDrawn)).toBeNull();
    expect(MAX_ROUNDS).toBe(4);
  });

  it('1 比 1 的第 4 回合（索引 3）也只打到這裡：誰贏誰贏整場', () => {
    const after = s9Game.step(aiFallsNext({ wins: [1, 1], round: 3 }), IDLE);
    expect(after.wins).toEqual([2, 1]);
    expect(after.phase).toBe('over');
    expect(s9Game.winner(after)).toBe(0);
  });

  it('每回合之間停 60 tick：停頓期間整片地板與兩個人都不動；第 60 個 tick 開始下一回合（回合數加 1、地板重來）', () => {
    const ended = s9Game.step(humanFallsNext({ wins: [0, 0], round: 0 }), IDLE);
    expect(ended.phase).toBe('rest');
    const frozen = run(ended, REST_TICKS - 1, [press({ right: true }), press({ left: true })]);
    expect(frozen.phase).toBe('rest');
    expect(frozen.tiles).toEqual(ended.tiles);
    expect(frozen.players).toEqual(ended.players);
    expect(frozen.tick).toBe(ended.tick + REST_TICKS - 1);
    const next = s9Game.step(frozen, IDLE);
    expect(next.phase).toBe('play');
    expect(next.round).toBe(1);
    expect(next.roundTick).toBe(0);
    expect(next.wins).toEqual([0, 1]);
    expect(next.fell).toEqual([false, false]);
    expect(next.outcome).toBeNull();
    expect(next.tiles.filter((t) => t !== 0)).toHaveLength(2);
    const human = tileAt(next.players[0].x, next.players[0].y);
    expect(tileAt(next.players[1].x, next.players[1].y)).toBe(rotated(human));
  });

  it('新回合的起點由 state 裡的亂數再抽一次：種子 0 到 9 至少有 6 個種子的第二回合換了起點格', () => {
    let changed = 0;
    for (let seed = 0; seed < 10; seed += 1) {
      const first = s9Game.init(seed, CONFIG);
      const home = tileAt(first.players[0].x, first.players[0].y);
      // 讓人腳下的格子下一步就掉：第 0 回合結束，停頓 60 tick 後第 1 回合開始
      const ended = s9Game.step({ ...first, tiles: first.tiles.map((t, i) => (i === home ? 1 : t)) }, IDLE);
      const next = run(ended, REST_TICKS);
      expect(next.round).toBe(1);
      if (tileAt(next.players[0].x, next.players[0].y) !== home) {
        changed += 1;
      }
    }
    expect(changed).toBeGreaterThanOrEqual(6);
  });

  it('整場一定在 maxTicks 之前結束：進行到 maxTicks 還沒分出勝負 → 結束，用已經贏的回合數比', () => {
    const s = placed(2, 3, { maxTicks: 600, tick: 599, wins: [1, 0], round: 1 });
    const after = s9Game.step(s, IDLE);
    expect(after.phase).toBe('over');
    expect(s9Game.winner(after)).toBe(0);
  });

  it('一旦整場結束，再 step 什麼都不變', () => {
    const over = s9Game.step(aiFallsNext({ wins: [1, 0], round: 1 }), IDLE);
    expect(s9Game.step(over, [press({ up: true }), press({ down: true })])).toEqual(over);
  });
});

// ---------------------------------------------------------------------------
// 領地判定（回合上限）
// ---------------------------------------------------------------------------

/** 第 4 欄整排都掉了：左邊 4 欄（56 格）、右邊 5 欄（70 格）。 */
function wallAtColumn(col: number): Record<number, number> {
  const tiles: Record<number, number> = {};
  for (let row = 0; row < ROWS; row += 1) {
    tiles[tileIndex(col, row)] = GONE;
  }
  return tiles;
}

describe('S-9 縮小的場地｜領地判定', () => {
  const lastTick = roundLimit(4500) - 1;

  it('回合上限到了沒人掉：離誰比較近（走得到的時間內不會先掉）就歸誰，格子多的贏這一回合', () => {
    // 第 4 欄是洞：人在左邊 4 欄（56 格）、AI 在右邊 5 欄（70 格）→ AI 贏
    const s = makeState({
      roundTick: lastTick,
      tiles: wallAtColumn(4),
      players: [at(2, 6), at(7, 7)],
    });
    // 兩個人腳下的格子要先站得住：把腳下設成新鮮（makeState 預設新鮮）
    const after = s9Game.step(s, IDLE);
    expect(after.fell).toEqual([false, false]);
    expect(after.outcome).toBe('side1');
    expect(after.wins).toEqual([0, 1]);
    expect(after.phase).toBe('rest');
    // 反過來：第 5 欄是洞 → 左邊 5 欄（70 格）、右邊 4 欄（56 格）→ 人贏
    const flipped = s9Game.step(
      makeState({ roundTick: lastTick, tiles: wallAtColumn(5), players: [at(2, 6), at(7, 7)] }),
      IDLE,
    );
    expect(flipped.outcome).toBe('side0');
    expect(flipped.wins).toEqual([1, 0]);
  });

  it('（邊界）回合上限的前一個 tick 不判定：roundTick 比上限小 2 時還在進行', () => {
    const s = makeState({
      roundTick: lastTick - 1,
      tiles: wallAtColumn(4),
      players: [at(2, 6), at(7, 7)],
    });
    const after = s9Game.step(s, IDLE);
    expect(after.phase).toBe('play');
    expect(after.roundTick).toBe(lastTick);
  });

  it('（邊界）領地一樣大：這一回合平手，沒有人得分', () => {
    // 中間整欄都掉、其餘左右各 5 欄不可能（10 欄）：用第 4、5 欄之間不夾洞，而是把場地對半切成上下兩半
    const tiles: Record<number, number> = {};
    for (let col = 0; col < COLS; col += 1) {
      tiles[tileIndex(col, 6)] = GONE;
      tiles[tileIndex(col, 7)] = GONE;
    }
    const s = makeState({
      roundTick: lastTick,
      tiles,
      players: [at(2, 3), at(7, 10)],
    });
    const after = s9Game.step(s, IDLE);
    expect(after.outcome).toBe('draw');
    expect(after.wins).toEqual([0, 0]);
  });

  it('領地比的是「時間」不是格數距離：一格在我走到之前就會掉，就不算我的', () => {
    // 同一片地板，AI 被關在一個小格子裡 → 全部歸人
    const tiles: Record<number, number> = {};
    const aiCol = 8;
    const aiRow = 10;
    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        if (dc !== 0 || dr !== 0) {
          tiles[tileIndex(aiCol + dc, aiRow + dr)] = GONE;
        }
      }
    }
    const s = makeState({ tiles, players: [at(2, 3), at(aiCol, aiRow)] });
    const t = territory(s.tiles, s.players[0], s.players[1]);
    expect(t.owned[1]).toBe(1);
    expect(t.owned[0]).toBeGreaterThan(100);
    expect(t.reach[1]).toBe(1);
    expect(t.exits[1]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 時間感知的廣度優先搜尋
// ---------------------------------------------------------------------------

/** 除了指定的格子以外整片都掉了。 */
function onlyThese(cells: Record<number, number>): Record<number, number> {
  const tiles: Record<number, number> = {};
  for (let i = 0; i < TILES; i += 1) {
    tiles[i] = GONE;
  }
  return { ...tiles, ...cells };
}

describe('S-9 縮小的場地｜時間感知的廣度優先搜尋', () => {
  // 第 3 列一條走廊，人在第 0 欄；其他格子都掉了
  const row = 3;
  const corridor = (extra: Record<number, number>): Record<number, number> =>
    onlyThese({
      [tileIndex(0, row)]: 45,
      [tileIndex(1, row)]: 0,
      [tileIndex(2, row)]: 0,
      [tileIndex(3, row)]: 0,
      [tileIndex(4, row)]: 0,
      [tileIndex(5, row)]: 0,
      ...extra,
    });
  const me = (tiles: Record<number, number>): S9State =>
    makeState({ tiles, players: [{ ...at(0, row) }, at(9, 13)] });

  it('全部新鮮的走廊：整條都走得到（從腳下算起 6 格）', () => {
    const s = me(corridor({}));
    expect(soloReach(s.tiles, s.players[0]).reach).toBe(6);
  });

  it('某格 t = 5、距離 3 格：走到那裡要 20 多個 tick，早就掉了 → 走不到，它後面的格子也走不到', () => {
    const s = me(corridor({ [tileIndex(3, row)]: 5 }));
    // 能走到的只有第 0、1、2 欄
    expect(soloReach(s.tiles, s.players[0]).reach).toBe(3);
  });

  it('同一格 t 夠大（60）就走得到：整條 6 格', () => {
    const s = me(corridor({ [tileIndex(3, row)]: 60 }));
    expect(soloReach(s.tiles, s.players[0]).reach).toBe(6);
  });

  it('腳下的格子也在崩落：剩下的 tick 不夠走出第一步，就沒有出口（出口數 0）', () => {
    const s = me(corridor({ [tileIndex(0, row)]: 4 }));
    const solo = soloReach(s.tiles, s.players[0]);
    expect(solo.exits).toBe(0);
    expect(solo.reach).toBe(1);
  });

  it('被洞包住的人：reach 只有 1、danger 是 1', () => {
    const s = me(corridor({ [tileIndex(1, row)]: GONE }));
    expect(soloReach(s.tiles, s.players[0]).reach).toBe(1);
    expect(evaluateS9(s, 0).danger).toBe(1);
  });

  it('兩個人搶一條走廊：離誰近歸誰，同時到的不算；格子總數對得起來', () => {
    const tiles = onlyThese(Object.fromEntries(Array.from({ length: 10 }, (_, c) => [tileIndex(c, row), 0])));
    const s = makeState({ tiles, players: [at(0, row), at(9, row)] });
    const t = territory(s.tiles, s.players[0], s.players[1]);
    expect(t.reach).toEqual([10, 10]);
    expect(t.owned[0]).toBe(t.owned[1]);
    expect(t.owned[0] + t.owned[1]).toBeLessThanOrEqual(10);
    expect(t.owned[0]).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 評估
// ---------------------------------------------------------------------------

describe('S-9 縮小的場地｜評估', () => {
  it('開闊的地板、站得穩：danger 是 0', () => {
    const s = s9Game.init(0, CONFIG);
    expect(evaluateS9(s, 0).danger).toBe(0);
    expect(evaluateS9(s, 1).danger).toBe(0);
  });

  it('對稱的開局：兩邊的 gain 一樣、領地差是 0', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      const s = s9Game.init(seed, CONFIG);
      expect(evaluateS9(s, 0).gain).toBeCloseTo(evaluateS9(s, 1).gain, 8);
    }
  });

  it('領地大的一邊 gain 較高：把對手關進小區域，我的 gain 變大、對手的變小', () => {
    const tiles: Record<number, number> = {};
    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        if (dc !== 0 || dr !== 0) {
          tiles[tileIndex(8 + dc, 10 + dr)] = GONE;
        }
      }
    }
    const trapped = makeState({ tiles, players: [at(2, 3), at(8, 10)] });
    const open = makeState({ players: [at(2, 3), at(8, 10)] });
    expect(evaluateS9(trapped, 0).gain).toBeGreaterThan(evaluateS9(open, 0).gain);
    expect(evaluateS9(trapped, 1).gain).toBeLessThan(evaluateS9(open, 1).gain);
    expect(evaluateS9(trapped, 1).danger).toBe(1);
  });

  it('腳下的格子快掉了而且來不及離開：這個局面比站在新鮮格子差很多（gain 少一大截）', () => {
    const c = at(2, 3);
    const fresh = makeState({ players: [{ x: c.x, y: c.y }, at(8, 10)] });
    const doomed = makeState({ tiles: { [tileIndex(2, 3)]: 3 }, players: [{ x: c.x, y: c.y }, at(8, 10)] });
    expect(evaluateS9(doomed, 0).gain).toBeLessThan(evaluateS9(fresh, 0).gain - 100);
    expect(evaluateS9(doomed, 0).danger).toBe(1);
  });

  it('（邊界）兩邊贏的回合數不進進行中的評估（沒有橡皮筋）：勝數歸零前後 evaluate 與 actions 相同', () => {
    const base = s9Game.init(4, CONFIG);
    const ahead = { ...base, wins: [1, 0] as const };
    const behind = { ...base, wins: [0, 1] as const };
    for (const side of [0, 1] as const) {
      expect(evaluateS9(ahead, side)).toEqual(evaluateS9(base, side));
      expect(evaluateS9(behind, side)).toEqual(evaluateS9(base, side));
      expect(s9Game.actions(ahead, side)).toEqual(s9Game.actions(base, side));
    }
  });

  it('回合結束：贏的一邊 gain +1000、輸的 −1000、平手 0；腳下的格子掉了的 danger 是 1', () => {
    const won = s9Game.step(aiFallsNext(), IDLE);
    expect(evaluateS9(won, 0)).toEqual({ gain: 1000, danger: 0 });
    expect(evaluateS9(won, 1)).toEqual({ gain: -1000, danger: 1 });
    const a = at(2, 3);
    const b = at(7, 10);
    const draw = s9Game.step(
      makeState({
        tiles: { [tileIndex(2, 3)]: 1, [tileIndex(7, 10)]: 1 },
        players: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
      }),
      IDLE,
    );
    expect(evaluateS9(draw, 0).gain).toBe(0);
    expect(evaluateS9(draw, 1).gain).toBe(0);
  });

  it('照目前的速度再走一陣子會走進洞：danger 是 1；站著不動不算', () => {
    const hole = tileIndex(3, 3);
    const c = at(2, 3);
    const moving = makeState({
      tiles: { [hole]: GONE },
      players: [{ x: c.x, y: c.y, vx: 1.5, vy: 0 }, at(8, 10)],
    });
    expect(headingBlocked(moving.tiles, moving.players[0])).toBe(true);
    const standing = makeState({
      tiles: { [hole]: GONE },
      players: [{ x: c.x, y: c.y, vx: 0, vy: 0 }, at(8, 10)],
    });
    expect(headingBlocked(standing.tiles, standing.players[0])).toBe(false);
    // 走得到洞之前格子就會掉的（t ≤ 走過去的 tick 數）也算
    const soon = makeState({
      tiles: { [tileIndex(3, 3)]: 5 },
      players: [{ x: c.x, y: c.y, vx: 1.5, vy: 0 }, at(8, 10)],
    });
    expect(headingBlocked(soon.tiles, soon.players[0])).toBe(true);
    const far = makeState({
      tiles: { [tileIndex(3, 3)]: 100 },
      players: [{ x: c.x, y: c.y, vx: 1.5, vy: 0 }, at(8, 10)],
    });
    expect(headingBlocked(far.tiles, far.players[0])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 對稱與純度
// ---------------------------------------------------------------------------

/** 把整個局面轉 180 度並交換兩邊：格子 i → 139 − i、座標 → (150 − x, 210 − y)、人與 AI 互換。 */
function rotate(state: S9State): S9State {
  const flip = (p: { x: number; y: number; vx: number; vy: number }) => ({
    x: FIELD_W - p.x,
    y: FIELD_H - p.y,
    vx: -p.vx,
    vy: -p.vy,
  });
  return {
    ...state,
    tiles: [...state.tiles].reverse(),
    players: [flip(state.players[1]), flip(state.players[0])],
    wins: [state.wins[1], state.wins[0]],
    fell: [state.fell[1], state.fell[0]],
    outcome: state.outcome === null ? null : state.outcome === 'draw' ? 'draw' : state.outcome === 'side0' ? 'side1' : 'side0',
  };
}

describe('S-9 縮小的場地｜對稱', () => {
  it('地板轉 180 度、兩邊互換之後，同樣的規則得到轉過去的同一個結果（步長、邊界、崩落都對稱）', () => {
    const s = s9Game.init(11, CONFIG);
    const mirrorKey = (b: Buttons): Buttons => ({ ...b, up: b.down, down: b.up, left: b.right, right: b.left });
    const moves: Inputs[] = [
      [press({ right: true }), press({ left: true })],
      [press({ down: true }), press({ up: true })],
      [press({ right: true, a: true }), press({ left: true, a: true })],
      [NONE, press({ down: true })],
    ];
    let a = s;
    let b = rotate(s);
    for (let i = 0; i < 80; i += 1) {
      const inputs = moves[Math.floor(i / 10) % moves.length] as Inputs;
      a = s9Game.step(a, inputs);
      b = s9Game.step(b, [mirrorKey(inputs[1]), mirrorKey(inputs[0])]);
      expect(rotate(b).tiles, `tick ${i}`).toEqual(a.tiles);
      expect(rotate(b).players[0].x, `tick ${i}`).toBeCloseTo(a.players[0].x, 9);
      expect(rotate(b).players[1].y, `tick ${i}`).toBeCloseTo(a.players[1].y, 9);
      expect(rotate(b).phase).toBe(a.phase);
      if (a.phase !== 'play') {
        break;
      }
    }
  });

  it('評估也對稱：局面轉 180 度、兩邊互換，同一個人看到的 gain 與 danger 相同', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      const s = run(s9Game.init(seed, CONFIG), 25, [press({ right: true, down: true }), press({ left: true })]);
      const r = rotate(s);
      expect(evaluateS9(r, 1).gain).toBeCloseTo(evaluateS9(s, 0).gain, 8);
      expect(evaluateS9(r, 1).danger).toBeCloseTo(evaluateS9(s, 0).danger, 8);
      expect(evaluateS9(r, 0).gain).toBeCloseTo(evaluateS9(s, 1).gain, 8);
    }
  });
});

describe('S-9 縮小的場地｜step 是純的', () => {
  it('step 不改動傳進來的 state（深度凍結之後照樣能走，回傳新的物件）', () => {
    const s = deepFreeze(s9Game.init(2, CONFIG));
    const next = s9Game.step(s, [press({ right: true }), press({ up: true })]);
    expect(next).not.toBe(s);
    expect(next.tiles).not.toBe(s.tiles);
    expect(s.tick).toBe(0);
    expect(next.tick).toBe(1);
    const rest = deepFreeze(s9Game.step(humanFallsNext(), IDLE));
    expect(() => s9Game.step(rest, IDLE)).not.toThrow();
  });

  it('evaluate 與 actions 也不改 state', () => {
    const s = deepFreeze(s9Game.init(5, CONFIG));
    expect(() => {
      s9Game.evaluate(s, 0);
      s9Game.evaluate(s, 1);
      s9Game.actions(s, 0);
    }).not.toThrow();
  });

  it('同樣的種子與輸入得到同樣的 state（亂數只在每回合開始時抽起點）', () => {
    const inputs: Inputs = [press({ right: true }), press({ left: true })];
    expect(run(s9Game.init(9, CONFIG), 60, inputs)).toEqual(run(s9Game.init(9, CONFIG), 60, inputs));
  });
});
