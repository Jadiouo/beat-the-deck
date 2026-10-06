import { describe, expect, it } from 'vitest';

import type { Buttons, Inputs } from '../../core/types';
import { makeSpadesState, stepSpades } from '../_spades/logic';
import { describeSharedSpadesRules } from '../_spades/shared-rules.test-helpers';
import { s3Game, makeState } from './logic';
import type { SpadesState } from './logic';

/**
 * S-3 擦彈的規則測試（TEST_PLAN 第 6 節 S-3 的 6 條，外加邊界情況與種子）。
 * 子彈同 S-2，所以 S-A 的共用規則測試（移動、邊界、命中、無敵、離場、結束）也在這張牌上跑一次，
 * 只有「分數」那一條換成 `擦彈數 − 5 × 命中數`。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];
const pressing = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });

/** 玩家在 (75, 100)，子彈放在離它指定距離的右邊、不動。 */
function stationary(distance: number, extra: { invuln?: number } = {}): SpadesState {
  return makeState({
    fields: [
      {
        px: 75,
        py: 100,
        ...extra,
        bullets: [{ x: 75 + distance, y: 100, vx: 0, vy: 0 }],
      },
      {},
    ],
  });
}

function run(state: SpadesState, count: number, inputs: Inputs = IDLE): SpadesState {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = s3Game.step(current, inputs);
  }
  return current;
}

/** 這個 tick 剛生成的子彈（y 恰好是 0）。 */
function spawned(
  state: SpadesState,
  side: 0 | 1 = 0,
): readonly { x: number; vx: number; vy: number }[] {
  return state.fields[side].bullets.filter((b) => b.y === 0);
}

describeSharedSpadesRules({
  label: 'S-3 擦彈',
  game: s3Game,
  makeState,
  scoreOfHits: (hits) => 0 - 5 * hits,
  busy: { min: 8, max: 50 },
});

describe('S-3 擦彈｜TEST_PLAN 第 6 節', () => {
  it('1. 子彈與玩家距離小於 10 且沒有命中：擦彈數加 1，子彈還在，並且記下「已經擦過」', () => {
    const next = s3Game.step(stationary(8), IDLE);
    expect(next.fields[0].grazes).toBe(1);
    expect(next.fields[0].hits).toBe(0);
    expect(next.fields[0].bullets).toHaveLength(1);
    expect(next.fields[0].bullets[0]?.grazed).toBe(true);
    // 另一個場地沒有子彈：沒有擦彈。
    expect(next.fields[1].grazes).toBe(0);
  });

  it('1b. 擦彈用的是「這個 tick 移動之後」的位置：從 10.5 飛進 9.3 的那個 tick 就算', () => {
    const state = makeState({
      fields: [{ px: 75, py: 100, bullets: [{ x: 75, y: 89.5, vx: 0, vy: 1.2 }] }, {}],
    });
    expect(s3Game.step(state, IDLE).fields[0].grazes).toBe(1);
    // 距離 10.5 的子彈如果不動，就還沒擦到。
    expect(s3Game.step(stationary(10.5), IDLE).fields[0].grazes).toBe(0);
  });

  it('2. 同一顆子彈在範圍內停留很多 tick：只算一次', () => {
    const state = run(stationary(8), 60);
    expect(state.fields[0].grazes).toBe(1);
    expect(state.fields[0].hits).toBe(0);
    // 玩家在 10 以內來回走動，同一顆子彈也只算一次。
    const wiggle = run(stationary(8), 40, [pressing({ up: true, left: true }), NONE]);
    expect(wiggle.fields[0].grazes).toBeLessThanOrEqual(1);
  });

  it('3. 同一顆子彈先擦彈後命中：擦彈算 1 次，命中也算', () => {
    // 子彈從 (75, 90) 往下飛，玩家在 (75, 100) 站著：距離 8.8、7.6、6.4、5.2、4.0。
    let state = makeState({
      fields: [{ px: 75, py: 100, bullets: [{ x: 75, y: 90, vx: 0, vy: 1.2 }] }, {}],
    });
    state = s3Game.step(state, IDLE);
    expect([state.fields[0].grazes, state.fields[0].hits]).toEqual([1, 0]);
    state = run(state, 3);
    expect([state.fields[0].grazes, state.fields[0].hits]).toEqual([1, 0]);
    state = s3Game.step(state, IDLE);
    expect([state.fields[0].grazes, state.fields[0].hits]).toEqual([1, 1]);
    expect(state.fields[0].bullets).toHaveLength(0);
    // 擦彈 +1、命中 −5：分數是 −4（這一刻）。
    expect(s3Game.score(state)[0]).toBe(-4);
  });

  it('4. 無敵期間經過的子彈：不算擦彈（而且之後也不會補算）', () => {
    // 子彈穿過玩家的位置，玩家無敵 60 tick：一路飛過去都不算。
    let state = makeState({
      fields: [{ px: 75, py: 100, invuln: 60, bullets: [{ x: 75, y: 80, vx: 0, vy: 1.2 }] }, {}],
    });
    state = run(state, 30);
    expect(state.fields[0].hits).toBe(0);
    expect(state.fields[0].grazes).toBe(0);
  });

  it('4b. 邊界：無敵剩 1 個 tick 時進入範圍的子彈不算，無敵結束之後即使還在 10 以內也不補算；剩 0 就算', () => {
    const during = run(stationary(8, { invuln: 1 }), 5);
    expect(during.fields[0].invuln).toBe(0);
    expect(during.fields[0].grazes).toBe(0);
    expect(during.fields[0].bullets[0]?.grazed).toBe(true);
    const after = run(stationary(8, { invuln: 0 }), 5);
    expect(after.fields[0].grazes).toBe(1);
  });

  it('5. 分數 ＝ 擦彈數 − 5 × 命中數；高的贏，剛好抵消是平手', () => {
    const last = (
      a: { hits: number; grazes: number },
      b: { hits: number; grazes: number },
    ): SpadesState => s3Game.step(makeState({ tick: 3599, fields: [a, b] }), IDLE);
    const end = last({ hits: 2, grazes: 3 }, { hits: 0, grazes: 1 });
    expect(s3Game.isOver(end)).toBe(true);
    expect(s3Game.score(end)).toEqual([-7, 1]);
    expect(s3Game.winner(end)).toBe(1);
    // 擦彈多但被打得更多：還是輸。
    expect(s3Game.winner(last({ hits: 3, grazes: 14 }, { hits: 0, grazes: 0 }))).toBe(1);
    // 擦 5 次、被打 1 次：0 分；與什麼都沒發生一樣，平手。
    const draw = last({ hits: 1, grazes: 5 }, { hits: 0, grazes: 0 });
    expect(s3Game.score(draw)).toEqual([0, 0]);
    expect(s3Game.winner(draw)).toBeNull();
    // 分數可以是負的，也可以是正的。
    expect(s3Game.score(last({ hits: 0, grazes: 9 }, { hits: 4, grazes: 0 }))).toEqual([9, -20]);
  });

  it('6. 站著不動被打中 2 次、擦彈 3 次：分數是 −7', () => {
    // 玩家在場地最底下 (75, 217)，站著不動。
    //  A：從 (75, 170.5) 直直飛來，第 31 個 tick 擦到、第 35 個 tick 命中（先擦後中，擦 1 中 1）。
    //  B：從 (75, 60.5) 直直飛來，要等 A 的 60 tick 無敵結束之後才到：第 123 個 tick 擦到、第 127 個 tick 命中（擦 1 中 1）。
    //  C：從 (82, 80) 飛來，從旁邊 7 像素擦過去（第 109 個 tick，不在無敵裡）：擦 1。
    // 擦彈共 3 次、命中 2 次。跑 150 個 tick：落雨新生成的子彈最快也要 170 個 tick 以後才飛得到最底下，不會干擾。
    let state = makeState({
      fields: [
        {
          px: 75,
          py: 217,
          bullets: [
            { x: 75, y: 170.5 },
            { x: 75, y: 60.5 },
            { x: 82, y: 80 },
          ],
        },
        {},
      ],
    });
    state = run(state, 34);
    expect([state.fields[0].grazes, state.fields[0].hits]).toEqual([1, 0]);
    state = s3Game.step(state, IDLE);
    expect([state.fields[0].grazes, state.fields[0].hits]).toEqual([1, 1]);
    state = run(state, 150 - 35);
    expect(state.tick).toBe(150);
    expect(state.fields[0].hits).toBe(2);
    expect(state.fields[0].grazes).toBe(3);
    expect(s3Game.score(state)[0]).toBe(-7);
    expect(state.fields[0].px).toBe(75);
    expect(state.fields[0].py).toBe(217);
  });
});

describe('S-3 擦彈｜邊界與細節', () => {
  it('距離剛好 10 不算擦彈（與命中的「小於」一致）；9.999 算', () => {
    expect(s3Game.step(stationary(10), IDLE).fields[0].grazes).toBe(0);
    expect(s3Game.step(stationary(9.999), IDLE).fields[0].grazes).toBe(1);
    // 剛好 5：不是命中，是擦彈。
    const five = s3Game.step(stationary(5), IDLE);
    expect(five.fields[0].hits).toBe(0);
    expect(five.fields[0].grazes).toBe(1);
  });

  it('同一個 tick 一顆命中、一顆在 10 以內：後被判定的那顆在無敵裡，不算擦彈；順序反過來就先擦後中', () => {
    const hitter = { x: 76, y: 100, vx: 0, vy: 0 };
    const near = { x: 83, y: 100, vx: 0, vy: 0 };
    const hitFirst = s3Game.step(
      makeState({ fields: [{ px: 75, py: 100, bullets: [hitter, near] }, {}] }),
      IDLE,
    );
    expect([hitFirst.fields[0].hits, hitFirst.fields[0].grazes]).toEqual([1, 0]);
    expect(hitFirst.fields[0].bullets).toHaveLength(1);
    const nearFirst = s3Game.step(
      makeState({ fields: [{ px: 75, py: 100, bullets: [near, hitter] }, {}] }),
      IDLE,
    );
    expect([nearFirst.fields[0].hits, nearFirst.fields[0].grazes]).toEqual([1, 1]);
  });

  it('兩個場地各自算各自的擦彈（玩家位置不同）', () => {
    const bullet = { x: 75, y: 100, vx: 0, vy: 0 };
    const state = makeState({
      fields: [
        { px: 75, py: 108, bullets: [bullet] },
        { px: 75, py: 130, bullets: [bullet] },
      ],
    });
    const next = s3Game.step(state, IDLE);
    expect(next.fields[0].grazes).toBe(1);
    expect(next.fields[1].grazes).toBe(0);
  });

  it('只有 S-3 才算擦彈：S-A、S-2 的 state（mode 不是 graze）同樣的局面擦彈數與分數都不變', () => {
    const rainState = makeSpadesState('rain', {
      fields: [{ px: 75, py: 100, bullets: [{ x: 83, y: 100, vx: 0, vy: 0 }] }, {}],
    });
    const next = stepSpades(rainState, IDLE);
    expect(next.fields[0].grazes).toBe(0);
    expect(next.fields[0].bullets[0]?.grazed).toBe(false);
    const aimedState = makeSpadesState('aimed', {
      fields: [{ px: 75, py: 100, bullets: [{ x: 83, y: 100, vx: 0, vy: 0 }] }, {}],
    });
    expect(stepSpades(aimedState, IDLE).fields[0].grazes).toBe(0);
  });

  it('都不動的兩邊：分數相同，平手；而且擦彈與命中都真的發生過', () => {
    let grazes = 0;
    let hits = 0;
    for (const seed of [0, 1, 2, 3]) {
      let state = s3Game.init(seed, CONFIG);
      while (!s3Game.isOver(state)) {
        state = s3Game.step(state, IDLE);
      }
      expect(s3Game.score(state)[0]).toBe(s3Game.score(state)[1]);
      expect(s3Game.winner(state)).toBeNull();
      grazes += state.fields[0].grazes;
      hits += state.fields[0].hits;
    }
    expect(grazes).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
  });

  it('初始：mode 是 graze，沒有擦彈、沒有命中，分數 [0, 0]（不是 -0）', () => {
    const state = s3Game.init(0, CONFIG);
    expect(state.mode).toBe('graze');
    expect(state.fields[0].grazes).toBe(0);
    expect(Object.is(s3Game.score(state)[0], 0)).toBe(true);
    expect(Object.is(s3Game.score(state)[1], 0)).toBe(true);
  });
});

describe('S-3 擦彈｜子彈同 S-2（TEST_PLAN 第 6 節 S-3 的前提）', () => {
  it('一般子彈每 15 tick 一顆（240 顆）、瞄準彈每 45 tick 一顆（80 顆），兩個場地的生成位置相同', () => {
    let state = s3Game.init(1, CONFIG);
    const regular: number[] = [];
    const aimed: number[] = [];
    for (let t = 1; t <= 3600; t += 1) {
      state = s3Game.step(state, [pressing({ left: t % 100 < 50, right: t % 100 >= 50 }), NONE]);
      expect(spawned(state, 0).map((b) => b.x)).toEqual(spawned(state, 1).map((b) => b.x));
      for (const b of spawned(state, 0)) {
        (b.vx === 0 && b.vy === 1.2 ? regular : aimed).push(t);
      }
    }
    expect(regular).toEqual(Array.from({ length: 240 }, (_v, i) => (i + 1) * 15));
    expect(aimed).toEqual(Array.from({ length: 80 }, (_v, i) => (i + 1) * 45));
  });

  it('瞄準彈朝向各自玩家當下的位置，大小 1.6', () => {
    const before = makeState({
      tick: 44,
      fields: [
        { px: 30, py: 150 },
        { px: 120, py: 60 },
      ],
    });
    const next = s3Game.step(before, IDLE);
    for (const [side, target] of [
      [0, [30, 150]],
      [1, [120, 60]],
    ] as const) {
      const shot = spawned(next, side).find((b) => b.vx !== 0 || b.vy !== 1.2) as {
        x: number;
        vx: number;
        vy: number;
      };
      expect(Math.sqrt(shot.vx ** 2 + shot.vy ** 2)).toBeCloseTo(1.6, 12);
      const ticks = Math.sqrt((target[0] - shot.x) ** 2 + target[1] ** 2) / 1.6;
      expect(shot.x + shot.vx * ticks).toBeCloseTo(target[0], 9);
      expect(shot.vy * ticks).toBeCloseTo(target[1], 9);
    }
  });
});

describe('S-3 擦彈｜種子與亂數（擋「忘了把新的 RngState 寫回 state」）', () => {
  /** 前 `ticks` 個 tick 生成的子彈 x（含瞄準彈），0 號場地。 */
  function spawnXs(seed: number, ticks: number): number[] {
    const xs: number[] = [];
    let state = s3Game.init(seed, CONFIG);
    for (let t = 0; t < ticks; t += 1) {
      state = s3Game.step(state, IDLE);
      xs.push(...spawned(state).map((b) => b.x));
    }
    return xs;
  }

  it('不同種子：前 60 個 tick 生成的子彈 x 座標序列不全相同（10 個種子）', () => {
    const sequences = Array.from({ length: 10 }, (_v, seed) => {
      const xs = spawnXs(seed, 60);
      expect(xs).toHaveLength(5);
      return xs.map((x) => x.toFixed(6)).join(',');
    });
    expect(new Set(sequences).size).toBe(10);
  });

  it('同一個種子：連續生成的子彈 x 座標不會一直一樣', () => {
    const xs = spawnXs(6, 900);
    expect(xs).toHaveLength(60 + 20);
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('同一個種子跑兩次：完全一樣（決定性）；state 可以 JSON 來回，沒有 NaN 或無限大', () => {
    const play = (): SpadesState =>
      run(s3Game.init(9, CONFIG), 700, [
        pressing({ right: true, up: true }),
        pressing({ left: true }),
      ]);
    const a = play();
    expect(a).toEqual(play());
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(JSON.stringify(a)).not.toMatch(/null|NaN|Infinity/);
  });
});
