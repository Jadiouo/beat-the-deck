import { describe, expect, it } from 'vitest';

import { hashState } from '../../core/hash';
import { createRng } from '../../core/rng';
import type { Buttons, GameConfig, Inputs } from '../../core/types';
import {
  COMPLEMENT,
  DURATION_TICKS,
  FIRST_COLOR,
  FOLLOW_DELAY,
  HEIGHT,
  LAST_COLOR,
  STOP_TICKS,
  WIDTH,
  aiSpeed,
  canvasToPixels,
  getPixel,
  jkrGame,
  makeState,
  mirrorPoint,
  pngFileName,
} from './logic';
import type { JkrState } from './logic';

/**
 * JK-R 一起亂畫的規則測試（docs/TASKS.md 列的 7 條，加上邊界情況）。
 * 規則的精確定義在 `docs/cards/JK-R.md`。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const press = (overrides: Partial<Buttons>): Buttons => ({ ...NONE, ...overrides });
const input = (human: Buttons): Inputs => [human, NONE];
const IDLE: Inputs = [NONE, NONE];

const CONFIG: GameConfig = { maxTicks: DURATION_TICKS, params: {} };

function start(seed = 0): JkrState {
  return jkrGame.init(seed, CONFIG);
}

/** 每個 tick 的輸入由 `inputsAt(tick)` 給（tick 是 step 之前 state 的 tick）。 */
function run(state: JkrState, ticks: number, inputsAt: (tick: number) => Inputs): JkrState {
  let current = state;
  for (let i = 0; i < ticks; i += 1) {
    current = jkrGame.step(current, inputsAt(current.tick));
  }
  return current;
}

/** 記錄每個 tick（含初始）的 state。 */
function trace(state: JkrState, ticks: number, inputsAt: (tick: number) => Inputs): JkrState[] {
  const states = [state];
  for (let i = 0; i < ticks; i += 1) {
    states.push(jkrGame.step(states[states.length - 1] as JkrState, inputsAt(i)));
  }
  return states;
}

const ACTION_POOL = jkrGame.actions(start(), 0);

/** 隨機輸入：每個 tick 從 `actions` 裡挑一個，由種子決定。 */
function randomInputs(seed: number): (tick: number) => Inputs {
  const rng = createRng(seed).fork('test-inputs');
  const cache: Inputs[] = [];
  return (tick) => {
    while (cache.length <= tick) {
      cache.push(input(ACTION_POOL[rng.int(ACTION_POOL.length)] as Buttons));
    }
    return cache[tick] as Inputs;
  };
}

/** 有劇本的人：每 40 tick 換一個方向，一直按著 a；中間按幾次 b。 */
function scriptedHuman(tick: number): Inputs {
  const legs: Partial<Buttons>[] = [
    { right: true },
    { down: true },
    { left: true, down: true },
    { up: true },
    { right: true, up: true },
    { left: true },
  ];
  const leg = legs[Math.floor(tick / 40) % legs.length] as Partial<Buttons>;
  return input(press({ ...leg, a: tick % 120 < 90, b: tick % 97 === 0 }));
}

function countColor(state: JkrState, color: number): number {
  return canvasToPixels(state).pixels.filter((c) => c === color).length;
}

function canvasHash(state: JkrState): string {
  return hashState(state.canvas);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('JK-R 一起亂畫：docs/TASKS.md 列的規則', () => {
  it('1. 同一個種子與輸入畫出同一張圖（畫布雜湊相同）；不同的種子畫出不同的圖', () => {
    const inputs = randomInputs(11);
    const a = run(start(7), 900, inputs);
    const b = run(start(7), 900, inputs);
    expect(canvasHash(a)).toBe(canvasHash(b));
    expect(hashState(a)).toBe(hashState(b));
    expect(countColor(a, 0)).toBeLessThan(WIDTH * HEIGHT); // 真的畫了東西
    const other = run(start(8), 900, inputs);
    expect(canvasHash(other)).not.toBe(canvasHash(a));
  });

  it('2. 人不下筆時畫布上沒有人的顏色（人一直在動、但沒按 a）', () => {
    const humanColor = start().human.color;
    const moving = (tick: number): Inputs =>
      input(press({ right: tick % 80 < 40, left: tick % 80 >= 40, down: tick % 50 < 25 }));
    const end = run(start(3), 600, moving);
    expect(countColor(end, humanColor)).toBe(0);
    // 這個測試有意義：AI 的筆確實畫了東西。
    expect(countColor(end, 0)).toBeLessThan(WIDTH * HEIGHT);
    // 換了顏色再動也一樣：畫布上不會出現人當下的顏色。
    const recolored = run(start(3), 600, (tick) => input(press({ right: true, b: tick === 0 })));
    expect(countColor(recolored, recolored.human.color)).toBe(0);
  });

  it('2. 人下筆時，畫布上就有人的顏色（對照組）', () => {
    const humanColor = start().human.color;
    const end = run(start(3), 30, () => input(press({ right: true, a: true })));
    expect(countColor(end, humanColor)).toBeGreaterThan(0);
  });

  it('3. 人停筆超過 180 tick 後，三支 AI 筆的速度降到 0，而且一步也不再走', () => {
    const states = trace(start(5), 400, () => IDLE);
    const at = (t: number): JkrState => states[t] as JkrState;
    expect(at(100).idle).toBe(100);
    expect(at(100).filler.speed).toBeGreaterThan(0);
    expect(at(100).contrarian.speed).toBeGreaterThan(0);
    for (const t of [181, 182, 250, 400]) {
      expect(at(t).filler.speed).toBe(0);
      expect(at(t).contrarian.speed).toBe(0);
    }
    // 三支筆的位置從第 181 個 tick 起完全不動，畫布也不再變。
    for (let t = 181; t <= 400; t += 1) {
      for (const pen of ['follower', 'filler', 'contrarian'] as const) {
        expect(at(t)[pen].x).toBe(at(181)[pen].x);
        expect(at(t)[pen].y).toBe(at(181)[pen].y);
      }
      expect(canvasHash(at(t))).toBe(canvasHash(at(181)));
    }
  });

  it('4. 跟隨者在第 t 個 tick 的位置，是人在第 t−60 個 tick 的位置對畫布中心的鏡射（顏色與下筆也照抄）', () => {
    const states = trace(start(2), 500, scriptedHuman);
    expect(new Set(states.map((s) => s.human.color)).size).toBeGreaterThan(1); // 劇本真的換過色
    for (let t = FOLLOW_DELAY; t < states.length; t += 1) {
      const then = (states[t - FOLLOW_DELAY] as JkrState).human;
      const [mx, my] = mirrorPoint(then.x, then.y);
      const follower = (states[t] as JkrState).follower;
      expect([t, follower.x, follower.y]).toEqual([t, mx, my]);
      expect([t, follower.down, follower.color]).toEqual([t, then.down, then.color]);
    }
  });

  it('5. 填充者不會走出畫布（種子 0 到 4，隨機輸入，每個 tick 都檢查）', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      for (const s of trace(start(seed), 1500, randomInputs(seed))) {
        expect(s.filler.x).toBeGreaterThanOrEqual(0);
        expect(s.filler.x).toBeLessThan(WIDTH);
        expect(s.filler.y).toBeGreaterThanOrEqual(0);
        expect(s.filler.y).toBeLessThan(HEIGHT);
      }
    }
  });

  it('5. 填充者在畫布角落、流場指向畫布外：留在畫布內', () => {
    // 方向 7 是左上；每格都指向左上，筆在 (0, 0)。
    const state = makeState({ filler: { x: 0, y: 0 }, flowAll: { dir: 7, color: 5 } });
    const states = trace(state, 50, () => IDLE);
    for (const s of states) {
      expect(s.filler.x).toBeGreaterThanOrEqual(0);
      expect(s.filler.y).toBeGreaterThanOrEqual(0);
    }
    const end = states[states.length - 1] as JkrState;
    expect(end.filler.x + end.filler.y).toBeGreaterThan(10); // 轉了彎、走得動
  });

  it('6. 唱反調的與人的距離平均大於畫布對角線的四分之一（種子 0 到 4，人亂走）', () => {
    const diagonal = Math.hypot(WIDTH, HEIGHT);
    expect(diagonal).toBe(400);
    for (let seed = 0; seed < 5; seed += 1) {
      const rng = createRng(seed).fork('walker');
      const heading: Partial<Buttons>[] = [];
      const walker = (tick: number): Inputs => {
        if (tick % 40 === 0) {
          heading[tick / 40] = {
            up: rng.int(3) === 0,
            down: rng.int(3) === 0,
            left: rng.int(3) === 0,
            right: rng.int(3) === 0,
          };
        }
        return input(press({ ...(heading[Math.floor(tick / 40)] ?? {}), a: true }));
      };
      const states = trace(start(seed), 1800, walker);
      let total = 0;
      for (const s of states) {
        total += Math.hypot(s.contrarian.x - s.human.x, s.contrarian.y - s.human.y);
      }
      expect(total / states.length).toBeGreaterThan(diagonal / 4);
    }
  });

  it('7. score 固定是 [0, 0]、winner 固定是 null（開頭、中途、結束後）', () => {
    let state = start(1);
    expect(jkrGame.score(state)).toEqual([0, 0]);
    expect(jkrGame.winner(state)).toBeNull();
    state = run(state, 700, randomInputs(1));
    expect(jkrGame.score(state)).toEqual([0, 0]);
    expect(jkrGame.winner(state)).toBeNull();
    const small = jkrGame.init(1, { maxTicks: 120, params: {} });
    const over = run(small, 120, randomInputs(1));
    expect(jkrGame.isOver(over)).toBe(true);
    expect(jkrGame.score(over)).toEqual([0, 0]);
    expect(jkrGame.winner(over)).toBeNull();
  });
});

describe('JK-R 一起亂畫：其他規則', () => {
  it('人：每軸每 tick 2 像素；左右同時按抵銷；按 a 才在畫布上留下人的顏色', () => {
    const s = start();
    const moved = jkrGame.step(s, input(press({ right: true, down: true })));
    expect([moved.human.x, moved.human.y]).toEqual([s.human.x + 2, s.human.y + 2]);
    const cancelled = jkrGame.step(s, input(press({ left: true, right: true })));
    expect([cancelled.human.x, cancelled.human.y]).toEqual([s.human.x, s.human.y]);
    expect(getPixel(moved, moved.human.x, moved.human.y)).not.toBe(s.human.color);
    const drew = jkrGame.step(s, input(press({ a: true })));
    expect(getPixel(drew, s.human.x, s.human.y)).toBe(s.human.color);
    // 3×3 筆刷
    expect(getPixel(drew, s.human.x + 1, s.human.y + 1)).toBe(s.human.color);
    expect(getPixel(drew, s.human.x - 1, s.human.y - 1)).toBe(s.human.color);
    expect(getPixel(drew, s.human.x + 2, s.human.y)).not.toBe(s.human.color);
  });

  it('人下筆後 60 tick，跟隨者在鏡射的位置用同一個顏色畫出同樣的一筆', () => {
    const s0 = start(0);
    const color = s0.human.color;
    // 第 1 個 tick：往右 2 像素並下筆；之後不動。
    const states = trace(s0, 61, (tick) =>
      tick === 0 ? input(press({ right: true, a: true })) : IDLE,
    );
    const [mx, my] = mirrorPoint(s0.human.x + 2, s0.human.y);
    expect(getPixel(states[60] as JkrState, mx, my)).not.toBe(color);
    expect(getPixel(states[61] as JkrState, mx, my)).toBe(color);
  });

  it('邊界：跟隨者在第 59、60、61 個 tick', () => {
    // 人在第 1 個 tick 往右走 2 像素（P[1] = (162, 120)），之後不動。
    const states = trace(start(0), 61, (tick) =>
      tick === 0 ? input(press({ right: true })) : IDLE,
    );
    const home = mirrorPoint(160, 120); // 人的起點的鏡射 = (159, 119)
    const moved = mirrorPoint(162, 120); // P[1] 的鏡射 = (157, 119)
    const pos = (t: number): number[] => {
      const f = (states[t] as JkrState).follower;
      return [f.x, f.y];
    };
    expect(pos(59)).toEqual([...home]); // 還沒有歷史：停在起點的鏡射
    expect(pos(60)).toEqual([...home]); // t−60 = 0：P[0]
    expect(pos(61)).toEqual([...moved]); // t−60 = 1：P[1]
    expect((states[59] as JkrState).follower.down).toBe(false);
  });

  it('邊界：idle 剛好在 179、180、181，以及人一有輸入就回到全速', () => {
    const at = (idle: number): JkrState => jkrGame.step(makeState({ idle: idle - 1 }), IDLE); // step 之後的 idle 就是 `idle`
    expect(at(60).filler.speed).toBe(aiSpeed(60));
    expect(aiSpeed(60)).toBe(2000);
    expect(aiSpeed(61)).toBe(1983);
    expect(at(179).filler.speed).toBe(16);
    expect(at(179).contrarian.speed).toBe(16);
    expect(at(STOP_TICKS).filler.speed).toBe(0);
    expect(at(STOP_TICKS).contrarian.speed).toBe(0);
    expect(at(STOP_TICKS + 1).filler.speed).toBe(0);
    // 速度單調不增
    for (let idle = 1; idle < 400; idle += 1) {
      expect(aiSpeed(idle)).toBeLessThanOrEqual(aiSpeed(idle - 1));
    }
    // 在 179 時人按了任何一個鍵：idle 歸零、速度回到 2000
    const woke = jkrGame.step(makeState({ idle: 179 }), input(press({ b: true })));
    expect(woke.idle).toBe(0);
    expect(woke.filler.speed).toBe(2000);
    expect(woke.contrarian.speed).toBe(2000);
  });

  it('邊界：人走到畫布邊緣就停在邊緣（四個角），在角落下筆不會出界也不丟錯', () => {
    const topLeft = makeState({ human: { x: 0, y: 0 } });
    const a = jkrGame.step(topLeft, input(press({ up: true, left: true, a: true })));
    expect([a.human.x, a.human.y]).toEqual([0, 0]);
    expect(getPixel(a, 0, 0)).toBe(a.human.color);
    expect(getPixel(a, 1, 1)).toBe(a.human.color);
    const bottomRight = makeState({ human: { x: WIDTH - 1, y: HEIGHT - 1 } });
    const b = jkrGame.step(bottomRight, input(press({ down: true, right: true, a: true })));
    expect([b.human.x, b.human.y]).toEqual([WIDTH - 1, HEIGHT - 1]);
    expect(getPixel(b, WIDTH - 1, HEIGHT - 1)).toBe(b.human.color);
    expect(b.canvas).toHaveLength(HEIGHT);
    // 差 1 像素到邊：走 2 像素會被夾在邊上
    const near = makeState({ human: { x: WIDTH - 2, y: 5 } });
    expect(jkrGame.step(near, input(press({ right: true }))).human.x).toBe(WIDTH - 1);
  });

  it('邊界：b 換色 1→15→1（最後一色繞回第一色），按住不連換', () => {
    expect(FIRST_COLOR).toBe(1);
    expect(LAST_COLOR).toBe(15);
    const last = makeState({ human: { color: LAST_COLOR } });
    const wrapped = jkrGame.step(last, input(press({ b: true })));
    expect(wrapped.human.color).toBe(FIRST_COLOR);
    const held = jkrGame.step(wrapped, input(press({ b: true })));
    expect(held.human.color).toBe(FIRST_COLOR); // 還按著：不再換
    const released = jkrGame.step(held, IDLE);
    const again = jkrGame.step(released, input(press({ b: true })));
    expect(again.human.color).toBe(FIRST_COLOR + 1);
    // 走完一圈 15 次回到原色
    let state = start();
    const original = state.human.color;
    for (let i = 0; i < 15; i += 1) {
      state = jkrGame.step(state, input(press({ b: true })));
      state = jkrGame.step(state, IDLE);
    }
    expect(state.human.color).toBe(original);
  });

  it('填充者遇到已經有顏色的地方就轉彎，而且不蓋掉有顏色的像素', () => {
    // 每格都指向東（方向 2）；idle = 119 → 這個 tick 的速度剛好 1000，走 1 步。
    const base = makeState({
      idle: 119,
      filler: { x: 100, y: 100, acc: 0 },
      flowAll: { dir: 2, color: 5 },
      paint: [{ x: 102, y: 100, color: 3 }],
    });
    const next = jkrGame.step(base, IDLE);
    expect(next.filler.speed).toBe(1000);
    expect([next.filler.x, next.filler.y]).toEqual([101, 101]); // 前方 2 像素（東邊）有色：轉到「方向 + 1」（東南）
    expect(getPixel(next, 102, 100)).toBe(3); // 沒被蓋掉
    expect(getPixel(next, 101, 101)).toBe(5); // 在空白處畫了自己的顏色
    // 沒有阻擋時就照流場走
    const clear = jkrGame.step(
      makeState({ idle: 119, filler: { x: 100, y: 100 }, flowAll: { dir: 2, color: 5 } }),
      IDLE,
    );
    expect([clear.filler.x, clear.filler.y]).toEqual([101, 100]);
  });

  it('填充者的顏色避開人當下的顏色', () => {
    const state = makeState({
      idle: 119,
      human: { color: 5 },
      filler: { x: 100, y: 100 },
      flowAll: { dir: 2, color: 5 },
    });
    const next = jkrGame.step(state, IDLE);
    expect(getPixel(next, 101, 100)).toBe(6);
  });

  it('唱反調的：目標是離人最遠的空白取樣點；用與人當下顏色互補的顏色畫', () => {
    const state = makeState({
      idle: 119,
      human: { x: 10, y: 10, color: 9 },
      contrarian: { x: 160, y: 120 },
    });
    const next = jkrGame.step(state, IDLE);
    expect([next.contrarian.tx, next.contrarian.ty]).toEqual([318, 238]);
    expect([next.contrarian.x, next.contrarian.y]).toEqual([161, 121]); // 往目標走一步（八方向）
    expect(getPixel(next, 161, 121)).toBe(COMPLEMENT[9]);
    for (let color = FIRST_COLOR; color <= LAST_COLOR; color += 1) {
      expect(COMPLEMENT[color]).not.toBe(color);
      expect(COMPLEMENT[color]).toBeGreaterThanOrEqual(FIRST_COLOR);
      expect(COMPLEMENT[color]).toBeLessThanOrEqual(LAST_COLOR);
    }
  });

  it('唱反調的不選已經畫滿的地方', () => {
    const paint: { x: number; y: number; color: number }[] = [];
    for (let y = 120; y < HEIGHT; y += 1) {
      for (let x = 200; x < WIDTH; x += 1) {
        paint.push({ x, y, color: 3 });
      }
    }
    const state = makeState({
      idle: 119,
      human: { x: 10, y: 10 },
      contrarian: { x: 160, y: 120 },
      paint,
    });
    const next = jkrGame.step(state, IDLE);
    expect(getPixel(state, next.contrarian.tx, next.contrarian.ty)).toBe(0);
    expect(next.contrarian.tx < 200 || next.contrarian.ty < 120).toBe(true);
  });

  it('結束：tick 到 maxTicks 才 isOver（5400 與 3600 都對）；結束後 step 不改變 state', () => {
    let state = jkrGame.init(0, CONFIG);
    state = run(state, DURATION_TICKS - 1, () => IDLE);
    expect(jkrGame.isOver(state)).toBe(false);
    state = jkrGame.step(state, IDLE);
    expect(jkrGame.isOver(state)).toBe(true);
    expect(state.tick).toBe(DURATION_TICKS);
    expect(jkrGame.step(state, input(press({ a: true, right: true })))).toBe(state);
    // config.maxTicks 比 5400 小時以它為準（契約測試給 3600）
    const short = run(jkrGame.init(0, { maxTicks: 3600, params: {} }), 3599, () => IDLE);
    expect(jkrGame.isOver(short)).toBe(false);
    expect(jkrGame.isOver(jkrGame.step(short, IDLE))).toBe(true);
    // config.maxTicks 比 5400 大時最多 5400
    expect(jkrGame.init(0, { maxTicks: 99999, params: {} }).maxTicks).toBe(DURATION_TICKS);
  });

  it('step 不改動傳進來的 state（深度凍結），JSON 來回之後繼續走結果相同', () => {
    const inputs = randomInputs(4);
    const mid = run(start(4), 130, inputs);
    const frozen = deepFreeze(JSON.parse(JSON.stringify(mid)) as JkrState);
    const before = hashState(frozen);
    const next = jkrGame.step(frozen, inputs(130));
    expect(hashState(frozen)).toBe(before);
    expect(hashState(next)).toBe(hashState(jkrGame.step(mid, inputs(130))));
  });

  it('沒有任何東西改變畫布的 tick，沿用同一個畫布陣列（效能設計）；有改變時才換新的', () => {
    const quiet = makeState({ idle: 400 });
    expect(jkrGame.step(quiet, IDLE).canvas).toBe(quiet.canvas);
    const drawing = jkrGame.step(quiet, input(press({ a: true })));
    expect(drawing.canvas).not.toBe(quiet.canvas);
    // 沒被改到的列共用同一個字串
    expect(drawing.canvas.filter((row, i) => row === quiet.canvas[i]).length).toBeGreaterThan(
      HEIGHT - 20,
    );
  });

  it('畫布是 240 列純字串，JSON 來回不變；canvasToPixels 與 getPixel 一致、尺寸 320×240', () => {
    const state = run(start(9), 400, randomInputs(9));
    expect(state.canvas).toHaveLength(HEIGHT);
    expect(JSON.parse(JSON.stringify(state)) as JkrState).toEqual(state);
    const image = canvasToPixels(state);
    expect([image.width, image.height, image.pixels.length]).toEqual([
      WIDTH,
      HEIGHT,
      WIDTH * HEIGHT,
    ]);
    for (const [x, y] of [
      [0, 0],
      [319, 239],
      [160, 120],
      [1, 2],
      [318, 5],
      [317, 100],
    ] as const) {
      expect(image.pixels[y * WIDTH + x]).toBe(getPixel(state, x, y));
    }
    expect(image.pixels.every((c) => c <= 15)).toBe(true);
  });

  it('邊界：畫布的編碼與樸素的二維陣列一致（隨機塗 600 個像素，含蓋掉舊色、跨列、四個角），而且同一張圖只有一種編碼', () => {
    const rng = createRng(77).fork('paint');
    const paint: { x: number; y: number; color: number }[] = [];
    for (let i = 0; i < 600; i += 1) {
      const corner =
        i < 4
          ? [
              [0, 0],
              [WIDTH - 1, 0],
              [0, HEIGHT - 1],
              [WIDTH - 1, HEIGHT - 1],
            ][i]
          : null;
      paint.push({
        x: corner ? (corner[0] as number) : rng.int(24) * 13 + rng.int(8),
        y: corner ? (corner[1] as number) : rng.int(HEIGHT),
        color: rng.int(16),
      });
    }
    const model = new Uint8Array(WIDTH * HEIGHT);
    for (const p of paint) {
      model[p.y * WIDTH + p.x] = p.color;
    }
    const state = makeState({ paint });
    expect(Array.from(canvasToPixels(state).pixels)).toEqual(Array.from(model));
    // 順序顛倒但最後的圖相同（只留每個像素最後一次的顏色）：字串必須完全相同。
    const last = new Map<number, { x: number; y: number; color: number }>();
    for (const p of paint) {
      last.set(p.y * WIDTH + p.x, p);
    }
    const shuffled = makeState({ paint: [...last.values()].reverse() });
    expect(shuffled.canvas).toEqual(state.canvas);
    // 整列塗同一色與整列空白，都是一個字元
    const solid = makeState({
      paint: Array.from({ length: WIDTH }, (_, x) => ({ x, y: 7, color: 5 })),
    });
    expect((solid.canvas[7] as string).length).toBe(1);
    expect((start().canvas[7] as string).length).toBe(1);
  });

  it('PNG 檔名帶種子', () => {
    expect(pngFileName(start(42))).toBe('JK-R-seed-42.png');
    expect(pngFileName(start(-3))).toBe('JK-R-seed--3.png');
  });

  it('actions：兩邊都至少一個；0 號邊涵蓋 a、b 與八個方向', () => {
    const state = start();
    expect(jkrGame.actions(state, 1).length).toBeGreaterThanOrEqual(1);
    const actions = jkrGame.actions(state, 0);
    expect(actions.some((b) => b.a)).toBe(true);
    expect(actions.some((b) => b.b)).toBe(true);
    expect(new Set(actions.map((b) => `${b.up}${b.down}${b.left}${b.right}`)).size).toBe(9);
    expect(jkrGame.evaluate(state, 0)).toEqual({ gain: 0, danger: 0 });
  });
});
