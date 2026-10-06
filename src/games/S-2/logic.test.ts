import { describe, expect, it } from 'vitest';

import { nextFrom } from '../../core/rng';
import type { Buttons, Inputs } from '../../core/types';
import { describeSharedSpadesRules } from '../_spades/shared-rules.test-helpers';
import { s2Game, makeState } from './logic';
import type { SpadesState } from './logic';

/**
 * S-2 瞄準彈的規則測試（TEST_PLAN 第 6 節 S-2 的 7 條，外加邊界情況與種子）。
 * 第 7 條「S-A 的 2 到 7、9 成立」由 `_spades/shared-rules.test-helpers.ts` 的共用規則測試涵蓋（與 S-A 同一組）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];
const pressing = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const INVULNERABLE = 1_000_000;

interface Shot {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

const speedOf = (b: Shot): number => Math.sqrt(b.vx * b.vx + b.vy * b.vy);
/** 瞄準彈的速度是 1.6，一般子彈是 1.2（而且一定垂直往下）。 */
const isAimed = (b: Shot): boolean => Math.abs(speedOf(b) - 1.6) < 1e-9;
const isRegular = (b: Shot): boolean => b.vx === 0 && b.vy === 1.2;

/** 這個 tick 剛生成的子彈（生成在 tick 的最後，y 恰好是 0）。 */
function spawned(state: SpadesState, side: 0 | 1 = 0): readonly Shot[] {
  return state.fields[side].bullets.filter((b) => b.y === 0);
}

/** 從 init 開始跑 `ticks` 個 tick（兩邊都站著不動），回傳每個 tick 生成的一般子彈與瞄準彈的 x（0 號場地）。 */
function spawnLog(
  seed: number,
  ticks: number,
): { regular: { tick: number; x: number }[]; aimed: { tick: number; x: number }[] } {
  const regular: { tick: number; x: number }[] = [];
  const aimed: { tick: number; x: number }[] = [];
  let state = s2Game.init(seed, CONFIG);
  for (let t = 1; t <= ticks; t += 1) {
    state = s2Game.step(state, IDLE);
    for (const b of spawned(state)) {
      (isAimed(b) ? aimed : regular).push({ tick: t, x: b.x });
    }
  }
  return { regular, aimed };
}

/** 第 44 個 tick 之後的局面：下一個 tick 一定生成一般子彈與瞄準彈。 */
function beforeAimed(
  humanAt: [number, number],
  aiAt: [number, number],
  extra: { invuln?: number } = {},
): SpadesState {
  return makeState({
    tick: 44,
    fields: [
      { px: humanAt[0], py: humanAt[1], ...extra },
      { px: aiAt[0], py: aiAt[1], ...extra },
    ],
  });
}

describeSharedSpadesRules({
  label: 'S-2 瞄準彈',
  game: s2Game,
  makeState,
  busy: { min: 8, max: 50 },
});

describe('S-2 瞄準彈｜TEST_PLAN 第 6 節（1 到 6 條）', () => {
  it('1. 一般子彈每 15 tick 一顆：第 15、30、45……個 tick，全場 240 顆；到最後間隔也不縮短', () => {
    const { regular } = spawnLog(0, 3600);
    expect(regular).toHaveLength(240);
    expect(regular.map((e) => e.tick)).toEqual(
      Array.from({ length: 240 }, (_v, i) => (i + 1) * 15),
    );
    // 與 S-A 不同：最後一段的間隔也是 15（不是 5）。
    const last = regular.slice(-10).map((e) => e.tick);
    for (let i = 1; i < last.length; i += 1) {
      expect((last[i] as number) - (last[i - 1] as number)).toBe(15);
    }
  });

  it('2. 每 45 tick 一顆瞄準彈（第 45、90……個 tick，全場 80 顆）；兩個場地的生成位置相同', () => {
    let state = s2Game.init(2, CONFIG);
    const xs: [number[], number[]] = [[], []];
    const ticks: number[] = [];
    for (let t = 1; t <= 3600; t += 1) {
      // 兩邊走不一樣的路，瞄準的方向才會不同；都不會被打中。
      const human = pressing({ left: t % 120 < 60, right: t % 120 >= 60 });
      const ai = pressing({ up: t % 90 < 45, down: t % 90 >= 45, right: true });
      state = s2Game.step(state, [human, ai]);
      for (const side of [0, 1] as const) {
        for (const b of spawned(state, side).filter(isAimed)) {
          xs[side].push(b.x);
          if (side === 0) {
            ticks.push(t);
          }
        }
      }
    }
    expect(ticks).toEqual(Array.from({ length: 80 }, (_v, i) => (i + 1) * 45));
    expect(xs[0]).toEqual(xs[1]);
  });

  it('3. 瞄準彈的速度向量指向該場地玩家在生成當下的位置，大小 1.6', () => {
    const next = s2Game.step(beforeAimed([30, 150], [120, 60]), IDLE);
    const humanShot = spawned(next, 0).find(isAimed) as Shot;
    const aiShot = spawned(next, 1).find(isAimed) as Shot;
    expect(humanShot).toBeDefined();
    expect(speedOf(humanShot)).toBeCloseTo(1.6, 12);
    expect(speedOf(aiShot)).toBeCloseTo(1.6, 12);
    // 沿著速度飛 len / 1.6 個 tick，剛好到玩家的位置。
    for (const [shot, target] of [
      [humanShot, [30, 150]],
      [aiShot, [120, 60]],
    ] as const) {
      const len = Math.sqrt((target[0] - shot.x) ** 2 + (target[1] - shot.y) ** 2);
      const ticks = len / 1.6;
      expect(shot.x + shot.vx * ticks).toBeCloseTo(target[0], 9);
      expect(shot.y + shot.vy * ticks).toBeCloseTo(target[1], 9);
    }
    // 同一個 tick 生成的一般子彈還是垂直往下 1.2。
    expect(spawned(next, 0).filter(isRegular)).toHaveLength(1);
  });

  it('3b. 瞄準的是「這個 tick 移動之後」的位置（生成在 tick 的最後）', () => {
    // 玩家在 (30, 150)，這個 tick 往右走 1.5：目標是 (31.5, 150)。
    const next = s2Game.step(beforeAimed([30, 150], [30, 150]), [pressing({ right: true }), NONE]);
    const moved = spawned(next, 0).find(isAimed) as Shot;
    const still = spawned(next, 1).find(isAimed) as Shot;
    expect(moved.x).toBe(still.x);
    const len = Math.sqrt((31.5 - moved.x) ** 2 + 150 ** 2);
    expect(moved.vx).toBeCloseTo(((31.5 - moved.x) / len) * 1.6, 12);
    expect(moved.vx).not.toBeCloseTo(still.vx, 6);
  });

  it('4. 玩家在生成之後移動：瞄準彈不轉彎（速度向量不變，位置是直線）', () => {
    let state = s2Game.step(beforeAimed([30, 150], [120, 60], { invuln: INVULNERABLE }), IDLE);
    const born = spawned(state, 0).find(isAimed) as Shot;
    for (let t = 0; t < 40; t += 1) {
      // 玩家往右上亂跑。
      state = s2Game.step(state, [
        pressing({ right: true, up: t % 2 === 0 }),
        pressing({ left: true }),
      ]);
    }
    const flown = state.fields[0].bullets.find((b) => b.vx === born.vx && b.vy === born.vy) as Shot;
    expect(flown).toBeDefined();
    expect(flown.x).toBeCloseTo(born.x + born.vx * 40, 9);
    expect(flown.y).toBeCloseTo(born.y + born.vy * 40, 9);
    // 玩家確實已經不在原來瞄準的位置。
    expect(state.fields[0].px).toBeGreaterThan(30);
  });

  it('5. 兩邊玩家位置不同時：兩個場地的瞄準彈方向不同（生成的 x 相同）', () => {
    const next = s2Game.step(beforeAimed([20, 170], [130, 90]), IDLE);
    const human = spawned(next, 0).find(isAimed) as Shot;
    const ai = spawned(next, 1).find(isAimed) as Shot;
    expect(human.x).toBe(ai.x);
    expect(human.vx).not.toBeCloseTo(ai.vx, 3);
    expect(human.vy).not.toBeCloseTo(ai.vy, 3);
    // 玩家在同一個位置時，兩邊的瞄準彈一模一樣。
    const same = s2Game.step(beforeAimed([60, 120], [60, 120]), IDLE);
    expect(spawned(same, 0)).toEqual(spawned(same, 1));
  });

  it('6. 玩家剛好在生成點正下方：方向是正下（vx 是 0、vy 是 1.6），不會除以零', () => {
    // 先用任何位置的玩家找出這一個 tick 會生成的 x（x 與玩家的位置無關）。
    const probe = s2Game.step(beforeAimed([75, 100], [75, 100]), IDLE);
    const x = (spawned(probe, 0).find(isAimed) as Shot).x;
    for (const py of [3, 100, 217]) {
      const next = s2Game.step(beforeAimed([x, py], [x, py]), IDLE);
      const shot = spawned(next, 0).find(isAimed) as Shot;
      expect(shot.x).toBe(x);
      expect(shot.vx).toBe(0);
      expect(Object.is(shot.vx, -0)).toBe(false);
      expect(shot.vy).toBe(1.6);
      expect(JSON.stringify(next)).not.toMatch(/null|NaN|Infinity/);
    }
  });

  it('6b. 邊界：玩家貼著場地的最上緣（y = 3）、正好在生成點旁邊：向量仍然有限，大小仍然是 1.6', () => {
    const probe = s2Game.step(beforeAimed([75, 100], [75, 100]), IDLE);
    const x = (spawned(probe, 0).find(isAimed) as Shot).x;
    const next = s2Game.step(beforeAimed([Math.max(3, x - 2), 3], [Math.min(147, x + 2), 3]), IDLE);
    for (const side of [0, 1] as const) {
      const shot = spawned(next, side).find(isAimed) as Shot;
      expect(Number.isFinite(shot.vx) && Number.isFinite(shot.vy)).toBe(true);
      expect(speedOf(shot)).toBeCloseTo(1.6, 12);
      expect(shot.vy).toBeGreaterThan(0);
    }
  });
});

describe('S-2 瞄準彈｜邊界與生成', () => {
  it('同一個 tick（第 45 個）同時生成一般子彈與瞄準彈：先一般、後瞄準，各用一個亂數，x 不同', () => {
    const before = beforeAimed([75, 100], [75, 100]);
    const next = s2Game.step(before, IDLE);
    const [first, afterFirst] = nextFrom(before.fields[0].rng);
    const [second, afterSecond] = nextFrom(afterFirst);
    expect(next.fields[0].rng).toBe(afterSecond);
    expect(next.fields[1].rng).toBe(afterSecond);
    const regular = spawned(next, 0).find(isRegular) as Shot;
    const aimed = spawned(next, 0).find(isAimed) as Shot;
    expect(regular.x).toBeCloseTo(2 + first * 146, 12);
    expect(aimed.x).toBeCloseTo(2 + second * 146, 12);
    expect(regular.x).not.toBe(aimed.x);
  });

  it('第 15 個 tick 只生成一般子彈、第 44 與 46 個 tick 什麼都不生成（亂數也不動）', () => {
    const at15 = s2Game.step(makeState({ tick: 14 }), IDLE);
    expect(spawned(at15)).toHaveLength(1);
    expect(spawned(at15).every(isRegular)).toBe(true);
    const at44 = s2Game.step(makeState({ tick: 43 }), IDLE);
    expect(spawned(at44)).toHaveLength(0);
    expect(at44.fields[0].rng).toBe(makeState().fields[0].rng);
    const at46 = s2Game.step(makeState({ tick: 45 }), IDLE);
    expect(spawned(at46)).toHaveLength(0);
  });

  it('子彈離開場地的左右兩側也會被移除；剛好到 x = 152 還在，超過就移除', () => {
    const state = makeState({
      fields: [
        {
          px: 75,
          py: 200,
          bullets: [
            { x: 151, y: 50, vx: 1, vy: 0 }, // 152：還在
            { x: 151.1, y: 50, vx: 1, vy: 0 }, // 152.1：移除
            { x: -1, y: 50, vx: -1, vy: 0 }, // -2：還在
            { x: -1.1, y: 50, vx: -1, vy: 0 }, // -2.1：移除
          ],
        },
        {},
      ],
    });
    const next = s2Game.step(state, IDLE);
    expect(next.fields[0].bullets.map((b) => b.x)).toEqual([152, -2]);
  });

  it('瞄準彈打到玩家：命中數加 1、那顆消失（與一般子彈同一套命中規則）', () => {
    // 玩家在 (75, 100)；一顆瞄準彈在 (75, 90)，速度 (0, 1.6)：下一個 tick 到 91.6，距離 8.4；再下一個 93.2……
    let state = makeState({
      fields: [{ px: 75, py: 100, bullets: [{ x: 75, y: 90, vx: 0, vy: 1.6 }] }, {}],
    });
    for (let t = 0; t < 5; t += 1) {
      state = s2Game.step(state, IDLE);
    }
    expect(state.fields[0].hits).toBe(1);
    expect(state.fields[0].bullets.filter((b) => b.vy === 1.6)).toHaveLength(0);
  });

  it('都不動的兩邊：命中數相同，平手（瞄準彈各瞄各的、位置一樣所以一樣）', () => {
    let total = 0;
    for (const seed of [0, 1, 2, 3]) {
      let state = s2Game.init(seed, CONFIG);
      while (!s2Game.isOver(state)) {
        state = s2Game.step(state, IDLE);
      }
      expect(state.fields[0].hits).toBe(state.fields[1].hits);
      expect(s2Game.winner(state)).toBeNull();
      total += state.fields[0].hits;
    }
    expect(total).toBeGreaterThan(0);
  });

  it('初始：mode 是 aimed，沒有子彈、玩家在 (75, 190)', () => {
    const state = s2Game.init(0, CONFIG);
    expect(state.mode).toBe('aimed');
    expect(state.fields[0].bullets).toEqual([]);
    expect([state.fields[0].px, state.fields[0].py]).toEqual([75, 190]);
    expect(s2Game.score(state)).toEqual([0, 0]);
  });
});

describe('S-2 瞄準彈｜種子與亂數（擋「忘了把新的 RngState 寫回 state」）', () => {
  it('不同種子：前 60 個 tick 生成的子彈 x 座標序列不全相同（10 個種子）', () => {
    const sequences = Array.from({ length: 10 }, (_v, seed) => {
      const { regular, aimed } = spawnLog(seed, 60);
      expect(regular).toHaveLength(4);
      expect(aimed).toHaveLength(1);
      return [...regular, ...aimed].map((e) => e.x.toFixed(6)).join(',');
    });
    expect(new Set(sequences).size).toBeGreaterThan(1);
    expect(new Set(sequences).size).toBe(10);
  });

  it('同一個種子：連續生成的一般子彈與瞄準彈 x 座標不會一直一樣', () => {
    const { regular, aimed } = spawnLog(4, 900);
    expect(regular.length).toBe(60);
    expect(aimed.length).toBe(20);
    expect(new Set(regular.map((e) => e.x)).size).toBe(regular.length);
    expect(new Set(aimed.map((e) => e.x)).size).toBe(aimed.length);
    // 一般子彈與瞄準彈用同一串亂數（交錯取用），所以兩者的 x 也不會重複。
    expect(new Set([...regular, ...aimed].map((e) => e.x)).size).toBe(
      regular.length + aimed.length,
    );
  });

  it('同一個種子跑兩次：完全一樣（決定性）；state 可以 JSON 來回，沒有 NaN 或無限大', () => {
    const play = (): SpadesState => {
      let state = s2Game.init(9, CONFIG);
      for (let t = 0; t < 700; t += 1) {
        state = s2Game.step(state, [
          pressing({ right: t % 50 < 25, left: t % 50 >= 25, up: t % 7 === 0 }),
          NONE,
        ]);
      }
      return state;
    };
    const a = play();
    expect(a).toEqual(play());
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(JSON.stringify(a)).not.toMatch(/null|NaN|Infinity/);
  });
});
