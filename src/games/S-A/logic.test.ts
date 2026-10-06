import { describe, expect, it } from 'vitest';

import type { Buttons, Inputs } from '../../core/types';
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

describe('S-A 落雨｜TEST_PLAN 第 6 節', () => {
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

  it('2. 按右：每 tick x 加 1.5；同時按右與上：斜向移動，速度仍是 1.5（不是 1.5×√2）', () => {
    const start = makeState();
    const right = sAGame.step(start, both(pressing({ right: true })));
    expect(right.fields[0].px - start.fields[0].px).toBeCloseTo(1.5, 10);
    expect(right.fields[0].py).toBe(start.fields[0].py);

    const diagonal = sAGame.step(start, both(pressing({ right: true, up: true })));
    const dx = diagonal.fields[0].px - start.fields[0].px;
    const dy = diagonal.fields[0].py - start.fields[0].py;
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeLessThan(0);
    expect(Math.hypot(dx, dy)).toBeCloseTo(1.5, 10);
    expect(Math.hypot(dx, dy)).not.toBeCloseTo(1.5 * Math.SQRT2, 3);
  });

  it('2b. 八個方向的合速度都是 1.5；同時按相反的兩個方向互相抵消', () => {
    const start = makeState();
    const dirs: Partial<Buttons>[] = [
      { up: true },
      { down: true },
      { left: true },
      { right: true },
      { up: true, left: true },
      { up: true, right: true },
      { down: true, left: true },
      { down: true, right: true },
    ];
    for (const dir of dirs) {
      const next = sAGame.step(start, both(pressing(dir)));
      const moved = Math.hypot(
        next.fields[0].px - start.fields[0].px,
        next.fields[0].py - start.fields[0].py,
      );
      expect(moved).toBeCloseTo(1.5, 10);
    }
    const cancelled = sAGame.step(start, both(pressing({ left: true, right: true })));
    expect(cancelled.fields[0].px).toBe(start.fields[0].px);
    const cancelledDiagonal = sAGame.step(
      start,
      both(pressing({ left: true, right: true, up: true })),
    );
    expect(start.fields[0].py - cancelledDiagonal.fields[0].py).toBeCloseTo(1.5, 10);
    expect(cancelledDiagonal.fields[0].px).toBe(start.fields[0].px);
  });

  it('3. 按住 a：速度變成 0.6（斜向也是 0.6）', () => {
    const start = makeState();
    const slow = sAGame.step(start, both(pressing({ right: true, a: true })));
    expect(slow.fields[0].px - start.fields[0].px).toBeCloseTo(0.6, 10);
    const diagonal = sAGame.step(start, both(pressing({ left: true, down: true, a: true })));
    const moved = Math.hypot(
      diagonal.fields[0].px - start.fields[0].px,
      diagonal.fields[0].py - start.fields[0].py,
    );
    expect(moved).toBeCloseTo(0.6, 10);
    // 只按 a 不動。
    const still = sAGame.step(start, both(pressing({ a: true })));
    expect(still.fields[0].px).toBe(start.fields[0].px);
    expect(still.fields[0].py).toBe(start.fields[0].py);
  });

  it('4. 走到場地邊緣：停在邊緣，不出界（玩家的圓整個在 150×220 之內）', () => {
    const edge = makeState({
      fields: [
        { px: 147, py: 217 },
        { px: 3, py: 3 },
      ],
    });
    const pushed = run(edge, 20, [
      pressing({ right: true, down: true }),
      pressing({ left: true, up: true }),
    ]);
    expect(pushed.fields[0].px).toBe(147);
    expect(pushed.fields[0].py).toBe(217);
    expect(pushed.fields[1].px).toBe(3);
    expect(pushed.fields[1].py).toBe(3);
  });

  it('4b. 邊界：離邊緣不到一步時夾在邊緣上（不是停在原地、也不是出界）；貼牆時另一軸照常滑行', () => {
    const near = makeState({ fields: [{ px: 146.5, py: 100 }, {}] });
    const next = sAGame.step(near, both(pressing({ right: true })));
    expect(next.fields[0].px).toBe(147);
    // 貼著右牆按「右＋上」：x 停在牆上，y 以斜向分量（1.5/√2）往上走。
    const wall = makeState({ fields: [{ px: 147, py: 100 }, {}] });
    const slid = sAGame.step(wall, both(pressing({ right: true, up: true })));
    expect(slid.fields[0].px).toBe(147);
    expect(100 - slid.fields[0].py).toBeCloseTo(1.5 * Math.SQRT1_2, 10);
    // 四個邊都試一次。
    const corners = makeState({
      fields: [
        { px: 3, py: 217 },
        { px: 147, py: 3 },
      ],
    });
    const out = run(corners, 5, [
      pressing({ left: true, down: true }),
      pressing({ right: true, up: true }),
    ]);
    expect([out.fields[0].px, out.fields[0].py]).toEqual([3, 217]);
    expect([out.fields[1].px, out.fields[1].py]).toEqual([147, 3]);
  });

  it('5. 子彈與玩家的中心距離小於 5（3＋2）：命中數加 1，那顆子彈消失，並且無敵 60 tick', () => {
    const state = makeState({
      fields: [
        { px: 75, py: 100, bullets: [{ x: 75, y: 96, vy: 0 }] },
        { px: 75, py: 100, bullets: [{ x: 75, y: 90, vy: 0 }] },
      ],
    });
    const next = sAGame.step(state, IDLE);
    expect(next.fields[0].hits).toBe(1);
    expect(next.fields[0].bullets).toHaveLength(0);
    expect(next.fields[0].invuln).toBe(60);
    // 距離 10：沒有命中，子彈還在。
    expect(next.fields[1].hits).toBe(0);
    expect(next.fields[1].bullets).toHaveLength(1);
  });

  it('5b. 邊界：距離剛好 5 不算命中；4.999 算', () => {
    const exact = makeState({
      fields: [{ px: 75, py: 100, bullets: [{ x: 80, y: 100, vx: 0, vy: 0 }] }, {}],
    });
    const miss = sAGame.step(exact, IDLE);
    expect(miss.fields[0].hits).toBe(0);
    expect(miss.fields[0].bullets).toHaveLength(1);

    const inside = makeState({
      fields: [{ px: 75, py: 100, bullets: [{ x: 79.999, y: 100, vx: 0, vy: 0 }] }, {}],
    });
    expect(sAGame.step(inside, IDLE).fields[0].hits).toBe(1);
  });

  it('5c. 命中是用「這個 tick 移動之後」的位置判定：迎面飛來的子彈在這個 tick 就打到', () => {
    // 子彈在 y=96.5，下一個 tick 移到 97.7，距離 2.3；玩家站著。
    const state = makeState({
      fields: [{ px: 75, py: 100, bullets: [{ x: 75, y: 96.5 }] }, {}],
    });
    expect(sAGame.step(state, IDLE).fields[0].hits).toBe(1);
  });

  it('6. 命中後 60 tick 內再碰到子彈：不算，子彈也不消失；第 61 個 tick 才又會被打中', () => {
    // 一顆不動的子彈壓在玩家身上，玩家剛被打中（invuln = 60）。
    let state = makeState({
      fields: [{ px: 75, py: 100, hits: 1, invuln: 60, bullets: [{ x: 75, y: 100, vy: 0 }] }, {}],
    });
    for (let t = 1; t <= 60; t += 1) {
      state = sAGame.step(state, IDLE);
      expect(state.fields[0].hits).toBe(1);
      expect(state.fields[0].bullets).toHaveLength(1);
    }
    expect(state.fields[0].invuln).toBe(0);
    state = sAGame.step(state, IDLE);
    expect(state.fields[0].hits).toBe(2);
    expect(state.fields[0].bullets).toHaveLength(0);
    expect(state.fields[0].invuln).toBe(60);
  });

  it('6b. 邊界：invuln 剩 1 還是無敵、剩 0 就會被打中', () => {
    const hit = (invuln: number): SpadesState =>
      sAGame.step(
        makeState({
          fields: [{ px: 75, py: 100, invuln, bullets: [{ x: 75, y: 100, vy: 0 }] }, {}],
        }),
        IDLE,
      );
    expect(hit(1).fields[0].hits).toBe(0);
    expect(hit(1).fields[0].invuln).toBe(0);
    expect(hit(0).fields[0].hits).toBe(1);
  });

  it('6c. 邊界：同一個 tick 同時碰到兩顆：只算一次命中，依陣列順序第一顆消失、第二顆留著', () => {
    const state = makeState({
      fields: [
        {
          px: 75,
          py: 100,
          bullets: [
            { x: 73, y: 100, vy: 0 },
            { x: 77, y: 100, vy: 0 },
          ],
        },
        {},
      ],
    });
    const next = sAGame.step(state, IDLE);
    expect(next.fields[0].hits).toBe(1);
    expect(next.fields[0].bullets).toEqual([expect.objectContaining({ x: 77 })]);
  });

  it('7. 子彈離開下緣：從 state 移除（陣列不會無限長）', () => {
    const state = makeState({
      fields: [
        {
          px: 10,
          py: 10,
          bullets: [
            { x: 100, y: 221 }, // 下一個 tick 到 222.2，整顆都出了下緣
            { x: 100, y: 200 }, // 還在場內
          ],
        },
        {},
      ],
    });
    const next = sAGame.step(state, IDLE);
    expect(next.fields[0].bullets).toHaveLength(1);
    expect(next.fields[0].bullets[0]?.y).toBeCloseTo(201.2, 10);
  });

  it('7b. 整場跑完：任何時刻場上的子彈數都有上限、而且都在場內', () => {
    let state = sAGame.init(3, CONFIG);
    let most = 0;
    for (let t = 0; t < 3600; t += 1) {
      state = sAGame.step(state, IDLE);
      for (const field of state.fields) {
        most = Math.max(most, field.bullets.length);
        for (const b of field.bullets) {
          expect(b.y).toBeLessThanOrEqual(222);
        }
      }
    }
    // 一顆子彈在場內最多 ~185 個 tick，最密時每 5 個 tick 一顆：不會超過 50。
    expect(most).toBeGreaterThan(20);
    expect(most).toBeLessThan(50);
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
    // 間隔是單調縮短的：每一百個 tick 裡的子彈數只增不減。
    const perHundred = Array.from(
      { length: 36 },
      (_, k) => ticks.filter((t) => t > k * 100 && t <= (k + 1) * 100).length,
    );
    for (let k = 1; k < perHundred.length; k += 1) {
      expect(perHundred[k] as number).toBeGreaterThanOrEqual(perHundred[k - 1] as number);
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

  it('9. 分數是負的命中數；命中數少的贏，一樣多是平手', () => {
    const last = (hits0: number, hits1: number): SpadesState =>
      sAGame.step(makeState({ tick: 3599, fields: [{ hits: hits0 }, { hits: hits1 }] }), IDLE);
    const lose = last(3, 1);
    expect(sAGame.isOver(lose)).toBe(true);
    expect(sAGame.score(lose)).toEqual([-3, -1]);
    expect(sAGame.winner(lose)).toBe(1);
    const win = last(0, 2);
    expect(sAGame.score(win)).toEqual([0, -2]);
    expect(sAGame.winner(win)).toBe(0);
    const draw = last(2, 2);
    expect(sAGame.winner(draw)).toBeNull();
    // 0 分是最高分：沒被打中的贏過被打中的。
    expect(sAGame.winner(last(1, 0))).toBe(1);
  });

  it('9b. 邊界：第 3599 個 tick 還沒結束，第 3600 個 tick 結束；結束後 step 不改變任何東西', () => {
    const before = makeState({ tick: 3598 });
    const middle = sAGame.step(before, IDLE);
    expect(middle.tick).toBe(3599);
    expect(sAGame.isOver(middle)).toBe(false);
    expect(sAGame.winner(middle)).toBeNull();
    const end = sAGame.step(middle, IDLE);
    expect(sAGame.isOver(end)).toBe(true);
    expect(sAGame.step(end, both(pressing({ left: true })))).toBe(end);
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
