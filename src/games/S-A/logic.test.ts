import { describe, expect, it } from 'vitest';

import type { Buttons, Inputs } from '../../core/types';
import { describeDelayedView } from '../_spades/delayed-view-suite.test-helpers';
import { describeSharedSpadesRules } from '../_spades/shared-rules.test-helpers';
import { sAGame, makeState } from './logic';
import type { SpadesState } from './logic';

/**
 * S-A 落雨的規則測試（TEST_PLAN 第 6 節 S-A 的 10 條，外加邊界情況與種子）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];
const pressing = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const both = (buttons: Buttons): Inputs => [buttons, buttons];

/** 這個 tick 剛生成的子彈（生成在 tick 的最後，y 恰好是 0）。 */
function spawned(state: SpadesState, side: 0 | 1 = 0): readonly { x: number; y: number }[] {
  return state.fields[side].bullets.filter((b) => b.y === 0);
}

/** 跑 n 個 tick，每個 tick 都給同一組輸入。 */
function run(state: SpadesState, count: number, inputs: Inputs = IDLE): SpadesState {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = sAGame.step(current, inputs);
  }
  return current;
}

/** 從 init 開始跑 `ticks` 個 tick，回傳每個生成的 tick 與 x（0 號場地）。 */
function spawnLog(seed: number, ticks: number): { tick: number; x: number }[] {
  const log: { tick: number; x: number }[] = [];
  let state = sAGame.init(seed, CONFIG);
  for (let t = 1; t <= ticks; t += 1) {
    state = sAGame.step(state, IDLE);
    for (const b of spawned(state)) {
      log.push({ tick: t, x: b.x });
    }
  }
  return log;
}

/** 一個很大的無敵值：玩家整場不會被打中，所以子彈不會因為命中而消失。 */
const INVULNERABLE = 1_000_000;

describeSharedSpadesRules({ label: 'S-A 落雨', game: sAGame, makeState });
describeDelayedView({ label: 'S-A 落雨', game: sAGame, makeState });

describe('S-A 落雨｜TEST_PLAN 第 6 節（1、8、10 條與初始）', () => {
  it('1. 兩個場地在任何 tick 的子彈位置完全相同（玩家各走各的、都不會被打中時）', () => {
    // 兩邊都無敵，所以沒有子彈因為命中而消失；玩家各走各的路線，子彈仍然要逐 tick 完全相同。
    let state = makeState({
      fields: [{ invuln: INVULNERABLE }, { invuln: INVULNERABLE }],
    });
    for (let t = 0; t < 1500; t += 1) {
      const human = pressing({ left: t % 90 < 45, right: t % 90 >= 45, up: t % 200 < 100 });
      const ai = pressing({ down: t % 70 < 35, up: t % 70 >= 35, a: t % 30 < 10 });
      state = sAGame.step(state, [human, ai]);
      expect(state.fields[0].bullets).toEqual(state.fields[1].bullets);
      expect(state.fields[0].rng).toBe(state.fields[1].rng);
    }
    expect(state.fields[0].bullets.length).toBeGreaterThan(10);
    // 玩家真的走到不同的地方，不是兩邊一樣的輸入。
    expect(state.fields[0].px).not.toBe(state.fields[1].px);
  });

  it('1b. 有人被打中、子彈因此消失時，兩個場地的亂數狀態與每一顆生成的 x 仍然相同', () => {
    let state = sAGame.init(7, CONFIG);
    const xs: [number[], number[]] = [[], []];
    for (let t = 0; t < 3600; t += 1) {
      // 人往左右掃、AI 站著：兩邊的命中不同。
      const human = pressing({ left: t % 100 < 50, right: t % 100 >= 50 });
      state = sAGame.step(state, [human, NONE]);
      expect(state.fields[0].rng).toBe(state.fields[1].rng);
      for (const side of [0, 1] as const) {
        for (const b of spawned(state, side)) {
          xs[side].push(b.x);
        }
      }
    }
    expect(xs[0].length).toBeGreaterThan(300);
    expect(xs[0]).toEqual(xs[1]);
    expect(state.fields[0].hits).not.toBe(state.fields[1].hits);
  });

  it('8. 生成間隔：第 0 tick 附近每 20 tick 一顆，第 3600 tick 附近每 5 tick 一顆', () => {
    const log = spawnLog(0, 3600);
    const ticks = log.map((e) => e.tick);
    expect(ticks[0]).toBe(20);
    const gaps = ticks.slice(1).map((t, i) => t - (ticks[i] as number));
    const early = gaps.filter((_g, i) => (ticks[i + 1] as number) <= 100);
    expect(early.length).toBeGreaterThanOrEqual(3);
    for (const gap of early) {
      expect(gap).toBeGreaterThanOrEqual(19);
      expect(gap).toBeLessThanOrEqual(20);
    }
    const late = gaps.filter((_g, i) => (ticks[i] as number) >= 3500);
    expect(late.length).toBeGreaterThanOrEqual(15);
    for (const gap of late) {
      expect(gap).toBeGreaterThanOrEqual(5);
      expect(gap).toBeLessThanOrEqual(6);
    }
    // 間隔是單調縮短的：每 900 個 tick 裡的子彈數一段比一段多。
    const perBlock = [0, 1, 2, 3].map(
      (k) => ticks.filter((t) => t > k * 900 && t <= (k + 1) * 900).length,
    );
    for (let k = 1; k < perBlock.length; k += 1) {
      expect(perBlock[k] as number).toBeGreaterThan(perBlock[k - 1] as number);
    }
  });

  it('8b. 全場總數：預期 240 × ln4 ≈ 332.7 顆，正負 2 顆之內', () => {
    const expected = 240 * Math.log(4);
    for (const seed of [0, 1, 2]) {
      const total = spawnLog(seed, 3600).length;
      expect(Math.abs(total - expected)).toBeLessThanOrEqual(2);
    }
  });

  it('8c. 生成的 x 都在 [2, 148]（整顆在場內），y 是 0，速度是往下 1.2', () => {
    let state = sAGame.init(5, CONFIG);
    let seen = 0;
    for (let t = 0; t < 600; t += 1) {
      state = sAGame.step(state, IDLE);
      for (const b of state.fields[0].bullets.filter((c) => c.y === 0)) {
        seen += 1;
        expect(b.x).toBeGreaterThanOrEqual(2);
        expect(b.x).toBeLessThanOrEqual(148);
        expect(b.vx).toBe(0);
        expect(b.vy).toBe(1.2);
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it('10. 都不動的兩邊：命中數相同，平手', () => {
    let total = 0;
    for (const seed of [0, 1, 2, 3, 4]) {
      let state = sAGame.init(seed, CONFIG);
      while (!sAGame.isOver(state)) {
        state = sAGame.step(state, IDLE);
      }
      expect(state.fields[0].hits).toBe(state.fields[1].hits);
      expect(sAGame.winner(state)).toBeNull();
      total += state.fields[0].hits;
    }
    // 不是 0 比 0 的空轉：站著不動會被打中。
    expect(total).toBeGreaterThan(0);
  });

  it('11. 初始：玩家在場地底部中間，沒有子彈、沒有命中，兩個場地一樣', () => {
    const state = sAGame.init(0, CONFIG);
    expect(state.tick).toBe(0);
    for (const field of state.fields) {
      expect([field.px, field.py]).toEqual([75, 190]);
      expect(field.hits).toBe(0);
      expect(field.invuln).toBe(0);
      expect(field.bullets).toEqual([]);
    }
    expect(state.fields[0]).toEqual(state.fields[1]);
    expect(sAGame.score(state)).toEqual([0, 0]);
    expect(sAGame.isOver(state)).toBe(false);
  });
});

describe('S-A 落雨｜種子與亂數（擋「忘了把新的 RngState 寫回 state」）', () => {
  it('不同種子：前 60 個 tick 生成的子彈 x 座標序列不全相同（10 個種子）', () => {
    const sequences = Array.from({ length: 10 }, (_v, seed) =>
      spawnLog(seed, 60)
        .map((e) => e.x.toFixed(6))
        .join(','),
    );
    expect(sequences[0]?.split(',').length).toBe(3);
    expect(new Set(sequences).size).toBeGreaterThan(1);
    expect(new Set(sequences).size).toBe(10);
  });

  it('同一個種子：連續生成的子彈 x 座標不會一直一樣（每次生成都把新亂數狀態寫回）', () => {
    const xs = spawnLog(4, 600).map((e) => e.x);
    expect(xs.length).toBeGreaterThanOrEqual(20);
    expect(new Set(xs).size).toBeGreaterThanOrEqual(xs.length - 1);
    // 亂數狀態每次生成都在前進。
    const first = run(sAGame.init(4, CONFIG), 19);
    const second = sAGame.step(first, IDLE);
    expect(first.fields[0].rng).not.toBe(second.fields[0].rng);
    // 沒有生成的 tick 不動亂數。
    const third = sAGame.step(second, IDLE);
    expect(third.fields[0].rng).toBe(second.fields[0].rng);
  });

  it('同一個種子跑兩次：完全一樣（決定性）', () => {
    const a = run(sAGame.init(9, CONFIG), 700, both(pressing({ right: true })));
    const b = run(sAGame.init(9, CONFIG), 700, both(pressing({ right: true })));
    expect(a).toEqual(b);
  });

  it('state 可以 JSON 來回，而且沒有 NaN 或無限大', () => {
    const state = run(sAGame.init(2, CONFIG), 400, both(pressing({ left: true, up: true })));
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    const bad = JSON.stringify(state).match(/null|NaN|Infinity/);
    expect(bad).toBeNull();
  });
});
