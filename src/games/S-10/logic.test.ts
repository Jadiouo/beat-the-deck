import { describe, expect, it } from 'vitest';

import { humanModel } from '../../ai/human-model';
import { levelController, policyByName, wrapPolicy } from '../../ai/level';
import { precise } from '../../ai/policies/precise';
import { playMatch } from '../../core/match';
import type { Buttons, Inputs } from '../../core/types';
import { deepFreeze } from '../../../tests/contract/freeze';
import {
  CLEAR_CAP,
  CLEAR_FROM,
  CLEAR_MIN,
  CLEARS,
  EXPOSURE_FAR,
  EXPOSURE_FULL,
  EXPOSURE_TAU,
  LAST_CLEAR_FROM,
  DURATION_TICKS,
  EMITTER_X,
  EMITTER_Y,
  FAN_BULLETS,
  FAN_SPEED,
  HIT_PENALTY,
  MIN_TICKS,
  QUIET_TICKS,
  SPIRAL_SPEED,
  SPIRAL_STEP,
  canClear,
  createS10Game,
  holdValue,
  makeState,
  predictCount,
  s10Game,
} from './logic';
import type { S10State } from './logic';
import {
  delayedView,
  feint,
  masher,
  player,
  playAgainstAi,
  summarize,
  uniform,
} from './players.test-helpers';

/**
 * S-10 彈幕的規則測試（小規格 `docs/cards/S-10.md`）。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 0 號邊是人（起點 (45, 190)）、1 號邊是 AI（起點 (105, 190)）；方向是畫面方向（上 = y 減少）。
 * `bulletsFar(n)` 是 n 顆不會碰到任何人的子彈（停在場地中段）。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];
const press = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const CONFIG = { maxTicks: 3600, params: {} };
const CLEAR0: Inputs = [press({ b: true }), NONE];
const CLEAR1: Inputs = [NONE, press({ b: true })];
const BOTH: Inputs = [press({ b: true }), press({ b: true })];

function run(state: S10State, count: number, inputs: Inputs = IDLE): S10State {
  let s = state;
  for (let i = 0; i < count; i += 1) {
    s = s10Game.step(s, inputs);
  }
  return s;
}

/** n 顆停在場地中段、不會碰到任何人的子彈（vy 為 0）。 */
function bulletsFar(n: number): { x: number; y: number; vx: number; vy: number }[] {
  return Array.from({ length: n }, (_, i) => ({ x: 2 + i * 1.8, y: 60 + (i % 3) * 20, vx: 0, vy: 0 }));
}

/** n 顆馬上就要飛出場地的子彈（現在算進清場的 N，但 30 tick 後不在了，所以「預測的子彈數」不會被它們墊高）。 */
function leaving(n: number): { x: number; y: number; vx: number; vy: number }[] {
  return Array.from({ length: n }, (_, i) => ({ x: 148, y: 20 + i * 3, vx: 1, vy: 0 }));
}

/** 在發射口發出的子彈：速度與螺旋（1.1）或扇形（1.6）相符。 */
function fromEmitter(s: S10State): { x: number; y: number; vx: number; vy: number }[] {
  return s.bullets.filter((b) => b.x === EMITTER_X && b.y === EMITTER_Y);
}
const speedOf = (b: { vx: number; vy: number }): number => Math.hypot(b.vx, b.vy);
const angleOf = (b: { vx: number; vy: number }): number => Math.atan2(b.vy, b.vx);
const deg = (rad: number): number => (rad * 180) / Math.PI;
/** 兩個角度差（度），夾在 −180 到 180。 */
function angleDiff(a: number, b: number): number {
  let d = deg(a - b);
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// ---------------------------------------------------------------------------
// 初始
// ---------------------------------------------------------------------------

describe('S-10 彈幕｜初始', () => {
  it('開局：兩人對稱的起點、沒有子彈、3 次清場、沒有無彈期、分數 0 比 0、一局 2700 tick', () => {
    const s = s10Game.init(3, CONFIG);
    expect(s.players.map((p) => [p.x, p.y, p.hits, p.invuln])).toEqual([
      [45, 190, 0, 0],
      [105, 190, 0, 0],
    ]);
    expect([s.tick, s.bullets.length, s.clears, s.quiet, s.fanCount]).toEqual([0, 0, 3, 0, 0]);
    expect(s.cleared).toEqual([0, 0]);
    expect(s.maxTicks).toBe(2700);
    expect(s10Game.score(s)).toEqual([0, 0]);
    expect(s10Game.isOver(s)).toBe(false);
    expect([CLEARS, DURATION_TICKS, MIN_TICKS]).toEqual([3, 2700, 600]);
  });

  it('maxTicks：比 2700 短就用短的；小於 600 丟 RangeError（600 可以）', () => {
    expect(s10Game.init(0, { maxTicks: 1000, params: {} }).maxTicks).toBe(1000);
    expect(s10Game.init(0, { maxTicks: 600, params: {} }).maxTicks).toBe(600);
    expect(() => s10Game.init(0, { maxTicks: 599, params: {} })).toThrow(RangeError);
  });

  it('同一個種子 init 兩次完全相同；種子 0 到 9 的螺旋起始角度不全相同、轉向兩種都出現', () => {
    expect(s10Game.init(7, CONFIG)).toEqual(s10Game.init(7, CONFIG));
    const states = Array.from({ length: 10 }, (_, seed) => s10Game.init(seed, CONFIG));
    expect(new Set(states.map((s) => s.angle)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(states.map((s) => s.spin))).toEqual(new Set([1, -1]));
  });
});

// ---------------------------------------------------------------------------
// 移動
// ---------------------------------------------------------------------------

describe('S-10 彈幕｜移動', () => {
  it('八方向 1.5（斜向合速度也是 1.5）、按住 a 是 0.6；上一個 tick 的速度記在 vx、vy', () => {
    const s = makeState({ players: [{ x: 75, y: 100 }, {}] });
    const right = s10Game.step(s, [press({ right: true }), NONE]);
    expect(right.players[0].x).toBeCloseTo(76.5, 10);
    expect([right.players[0].vx, right.players[0].vy]).toEqual([1.5, 0]);
    const diag = s10Game.step(s, [press({ left: true, up: true }), NONE]);
    expect(Math.hypot(diag.players[0].x - 75, diag.players[0].y - 100)).toBeCloseTo(1.5, 10);
    const slow = s10Game.step(s, [press({ down: true, a: true }), NONE]);
    expect(slow.players[0].y).toBeCloseTo(100.6, 10);
    expect(s10Game.step(right, IDLE).players[0].vx).toBe(0);
  });

  it('（邊界）夾在場地內：半徑 3，所以 x 在 [3, 147]、y 在 [3, 217]', () => {
    const corner = makeState({ players: [{ x: 4, y: 4 }, { x: 146, y: 216 }] });
    const moved = run(corner, 5, [press({ left: true, up: true }), press({ right: true, down: true })]);
    expect([moved.players[0].x, moved.players[0].y]).toEqual([3, 3]);
    expect([moved.players[1].x, moved.players[1].y]).toEqual([147, 217]);
  });

  it('兩人可以重疊（沒有碰撞）；對手的按鍵不會移動我', () => {
    const s = makeState({ players: [{ x: 60, y: 100 }, { x: 62, y: 100 }] });
    const moved = run(s, 3, [press({ right: true }), NONE]);
    expect(moved.players[0].x).toBeCloseTo(64.5, 10);
    expect(moved.players[1].x).toBe(62);
    expect(run(s, 3, [NONE, press({ left: true })]).players[0].x).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// 清場（共用資源）
// ---------------------------------------------------------------------------

describe('S-10 彈幕｜清場', () => {
  it('1. 第 300 tick 起才能按：tick 298、299 按 b 什麼都不發生，tick 300 才有效', () => {
    const early = s10Game.step(makeState({ tick: 298, bullets: bulletsFar(30) }), CLEAR0);
    expect([early.clears, early.cleared[0], early.bullets.length]).toEqual([3, 0, 30]);
    const edge = s10Game.step(makeState({ tick: 299, bullets: bulletsFar(30) }), CLEAR0);
    expect([edge.clears, edge.cleared[0]]).toEqual([3, 0]);
    const ok = s10Game.step(makeState({ tick: CLEAR_FROM, bullets: bulletsFar(30) }), CLEAR0);
    expect([ok.clears, ok.cleared[0], ok.bullets.length]).toEqual([2, 30, 0]);
  });

  it('2. 誰按誰得到被清掉的子彈數：0 號邊按 → 0 號邊得分；1 號邊按 → 1 號邊得分', () => {
    const s = makeState({ tick: 400, bullets: bulletsFar(22) });
    expect(s10Game.step(s, CLEAR0).cleared).toEqual([22, 0]);
    expect(s10Game.step(s, CLEAR1).cleared).toEqual([0, 22]);
    expect(s10Game.score(s10Game.step(s, CLEAR1))).toEqual([0, 22]);
  });

  it('3. N 最多算 60：場上 80 顆，按的人 +60，但 80 顆全部消失', () => {
    const s = s10Game.step(makeState({ tick: 400, bullets: bulletsFar(80) }), CLEAR0);
    expect(s.cleared).toEqual([60, 0]);
    expect(s.bullets).toHaveLength(0);
    expect(CLEAR_CAP).toBe(60);
  });

  it('4. 同一個 tick 兩邊都按：各得 floor(N / 2)，只用掉 1 次（N 是奇數時多出的 1 分沒有人拿）', () => {
    const s = s10Game.step(makeState({ tick: 400, bullets: bulletsFar(31) }), BOTH);
    expect(s.cleared).toEqual([15, 15]);
    expect(s.clears).toBe(2);
    expect(s.bullets).toHaveLength(0);
  });

  it('5. 先按先得：0 號邊按了之後的下一個 tick 1 號邊才按，1 號邊拿不到（無彈期）', () => {
    const first = s10Game.step(makeState({ tick: 400, bullets: bulletsFar(25) }), CLEAR0);
    const second = s10Game.step(first, CLEAR1);
    expect(second.cleared).toEqual([25, 0]);
    expect(second.clears).toBe(2);
  });

  it('6. 次數是兩邊共用的：0 號邊用一次、之後 1 號邊用一次，只剩 1 次；用完之後 b 無效', () => {
    let s = s10Game.step(makeState({ tick: 400, bullets: bulletsFar(20) }), CLEAR0);
    s = run(s, QUIET_TICKS + 1);
    s = { ...s, bullets: bulletsFar(18) };
    s = s10Game.step(s, CLEAR1);
    expect(s.clears).toBe(1);
    expect(s.cleared).toEqual([20, 18]);
    const empty = s10Game.step(makeState({ tick: 900, clears: 0, bullets: bulletsFar(40) }), CLEAR0);
    expect([empty.cleared, empty.bullets.length]).toEqual([[0, 0], 40]);
  });

  it('7. 場上沒有子彈、或在無彈期，按 b 無效，不消耗次數', () => {
    const none = s10Game.step(makeState({ tick: 400, bullets: [] }), CLEAR0);
    expect([none.clears, none.cleared]).toEqual([3, [0, 0]]);
    const quiet = s10Game.step(makeState({ tick: 400, quiet: 20, bullets: bulletsFar(5) }), CLEAR0);
    expect([quiet.clears, quiet.cleared, quiet.bullets.length]).toEqual([3, [0, 0], 5]);
  });

  it('8. 按下去的那一刻就保護了自己：這個 tick 本來會打中的子彈被清掉，沒有被打中', () => {
    const base = makeState({
      tick: 400,
      players: [{ x: 45, y: 190 }, { x: 105, y: 190 }],
      bullets: [{ x: 45, y: 185, vx: 0, vy: 1 }],
    });
    expect(s10Game.step(base, IDLE).players[0].hits).toBe(1);
    const pressed = s10Game.step(base, CLEAR0);
    expect(pressed.players[0].hits).toBe(0);
    expect(pressed.cleared).toEqual([1, 0]);
  });

  it('9. 清場之後（含按的那個 tick）共 45 個 tick 不發新子彈，第 46 個 tick 螺旋才又出現', () => {
    let s = s10Game.step(makeState({ tick: 300, bullets: bulletsFar(10) }), CLEAR0);
    expect(QUIET_TICKS).toBe(45);
    for (let tick = 301; tick <= 345; tick += 1) {
      expect(s.tick).toBe(tick);
      expect(s.bullets).toHaveLength(0);
      s = s10Game.step(s, IDLE);
    }
    // 現在是 tick 346；下一次螺旋在 348
    expect(s.bullets).toHaveLength(0);
    expect(run(s, 2).bullets).toHaveLength(1);
  });

  it('10. 無彈期只是不放出來：螺旋的角度、扇形的次數與亂數照時間表走（有沒有清場，之後的彈幕一樣）', () => {
    const base = makeState({ tick: 350, bullets: bulletsFar(10), fanCount: 2 });
    const pressed = run(s10Game.step(base, CLEAR0), 100);
    const idle = run(base, 101);
    expect(pressed.angle).toBe(idle.angle);
    expect(pressed.fanCount).toBe(idle.fanCount);
    expect(pressed.rng).toBe(idle.rng);
    expect(pressed.tick).toBe(idle.tick);
  });

  it('11. 最後一次清場要到第 1200 tick 才能按（小規格預先批准的補救：前兩次太早用完時）', () => {
    const last = (tick: number) => makeState({ tick, clears: 1, bullets: bulletsFar(30) });
    expect(LAST_CLEAR_FROM).toBe(1200);
    expect(canClear(last(1199))).toBe(false);
    expect(canClear(last(1200))).toBe(true);
    const early = s10Game.step(last(1100), CLEAR0);
    expect([early.clears, early.cleared[0], early.bullets.length]).toEqual([1, 0, 30]);
    const ok = s10Game.step(last(1200), CLEAR0);
    expect([ok.clears, ok.cleared[0]]).toEqual([0, 30]);
    // 還有兩次以上的時候，第 300 tick 起就能按
    expect(canClear(makeState({ tick: 300, clears: 2, bullets: bulletsFar(3) }))).toBe(true);
  });

  it('12. canClear：次數、tick、無彈期、場上有子彈，四個條件缺一不可', () => {
    const ok = makeState({ tick: 300, bullets: bulletsFar(1) });
    expect(canClear(ok)).toBe(true);
    expect(canClear({ ...ok, clears: 0 })).toBe(false);
    expect(canClear({ ...ok, tick: 299 })).toBe(false);
    expect(canClear({ ...ok, quiet: 1 })).toBe(false);
    expect(canClear({ ...ok, bullets: [] })).toBe(false);
  });
});

describe('S-10 彈幕｜清場門檻（老闆裁定：清場要場上至少 N 顆子彈才有效）', () => {
  const MIN = 8;
  const free = (extra: Partial<Parameters<typeof makeState>[0]> = {}): S10State =>
    makeState({ tick: 400, minBullets: MIN, ...extra });

  it('1. init：minBullets 預設是 CLEAR_MIN，可以用 options 改；burn 預設是 false', () => {
    expect(s10Game.init(0, CONFIG).minBullets).toBe(CLEAR_MIN);
    expect(createS10Game({ minBullets: 12 }).init(0, CONFIG).minBullets).toBe(12);
    expect(createS10Game({ minBullets: 12, burn: true }).init(0, CONFIG).burn).toBe(true);
    expect(s10Game.init(0, CONFIG).burn).toBe(false);
  });

  it('2. 不足 N 顆按 b 沒有用：子彈、次數、分數、無彈期都不變；剛好 N 顆就有效', () => {
    const short = s10Game.step(free({ bullets: bulletsFar(MIN - 1) }), CLEAR0);
    expect([short.clears, short.cleared, short.quiet]).toEqual([3, [0, 0], 0]);
    expect(short.bullets).toHaveLength(MIN - 1);
    const edge = s10Game.step(free({ bullets: bulletsFar(MIN) }), CLEAR0);
    expect([edge.clears, edge.cleared[0], edge.bullets.length]).toEqual([2, MIN, 0]);
  });

  it('3. 預設（不扣）：不足 N 顆的 b 不扣次數；之後子彈夠了照樣能清', () => {
    let s = free({ bullets: bulletsFar(MIN - 3) });
    for (let i = 0; i < 5; i += 1) {
      s = { ...s10Game.step(s, CLEAR0), bullets: s.bullets };
    }
    expect(s.clears).toBe(3);
    const ok = s10Game.step({ ...s, bullets: bulletsFar(MIN + 2) }, CLEAR0);
    expect([ok.clears, ok.cleared[0]]).toEqual([2, MIN + 2]);
  });

  it('4. N 看的是場上全部的子彈（含超過 60 的），分數仍最多算 60', () => {
    const s = s10Game.step(free({ minBullets: 70, bullets: bulletsFar(70) }), CLEAR0);
    expect([s.clears, s.cleared[0]]).toEqual([2, CLEAR_CAP]);
  });

  it('5. 同一個 tick 兩邊都按且子彈夠：照舊各得 floor(N / 2)；不夠：兩邊都沒有用', () => {
    const ok = s10Game.step(free({ bullets: bulletsFar(11) }), BOTH);
    expect([ok.cleared, ok.clears]).toEqual([[5, 5], 2]);
    const short = s10Game.step(free({ bullets: bulletsFar(MIN - 1) }), BOTH);
    expect([short.cleared, short.clears]).toEqual([[0, 0], 3]);
  });

  it('6. canClear 與 actions：子彈少於 N 顆時不能清場、動作只有 17 個；達到 N 顆有 34 個', () => {
    expect(canClear(free({ bullets: bulletsFar(MIN - 1) }))).toBe(false);
    expect(canClear(free({ bullets: bulletsFar(MIN) }))).toBe(true);
    expect(s10Game.actions(free({ bullets: bulletsFar(MIN - 1) }), 0)).toHaveLength(17);
    expect(s10Game.actions(free({ bullets: bulletsFar(MIN) }), 0)).toHaveLength(34);
  });

  it('7. 門檻和其他條件是「而且」：次數用完、無彈期、第 300 tick 之前，子彈再多也不行', () => {
    const many = bulletsFar(40);
    expect(canClear(free({ bullets: many, clears: 0 }))).toBe(false);
    expect(canClear(free({ bullets: many, quiet: 2 }))).toBe(false);
    expect(canClear(free({ bullets: many, tick: 299 }))).toBe(false);
    expect(canClear(free({ bullets: many, tick: 1199, clears: 1 }))).toBe(false);
  });

  it('8. 清場之後子彈從零長回來：無彈期過了之後要再等一陣子才到 N 顆', () => {
    let s = s10Game.step(free({ bullets: bulletsFar(20) }), CLEAR0);
    s = run(s, QUIET_TICKS + 6);
    expect(s.bullets.length).toBeLessThan(MIN);
    expect(canClear(s)).toBe(false);
  });

  it('9. 次數照扣的變體（burn）：不足 N 顆的 b 用掉一次共用的清場，沒有分數、子彈不消失、沒有無彈期', () => {
    const burn = createS10Game({ minBullets: MIN, burn: true });
    const base = free({ bullets: bulletsFar(MIN - 1), burn: true });
    const s = burn.step(base, CLEAR0);
    expect([s.clears, s.cleared, s.quiet, s.bullets.length]).toEqual([2, [0, 0], 0, MIN - 1]);
    // 兩邊同時按，也只扣 1 次
    expect(burn.step(base, BOTH).clears).toBe(2);
    // 子彈夠就是正常的清場，不多扣
    const ok = burn.step(free({ bullets: bulletsFar(MIN), burn: true }), CLEAR0);
    expect([ok.clears, ok.cleared[0]]).toEqual([2, MIN]);
  });

  it('10. burn 只在「按得下去」的時候扣：第 300 tick 之前、無彈期、次數用完、最後一次的 1200 之前，按了都不扣', () => {
    const burn = createS10Game({ minBullets: MIN, burn: true });
    const few = bulletsFar(2);
    expect(burn.step(free({ bullets: few, burn: true, tick: 299 }), CLEAR0).clears).toBe(3);
    expect(burn.step(free({ bullets: few, burn: true, quiet: 5 }), CLEAR0).clears).toBe(3);
    expect(burn.step(free({ bullets: few, burn: true, clears: 0 }), CLEAR0).clears).toBe(0);
    expect(burn.step(free({ bullets: few, burn: true, clears: 1, tick: 1100 }), CLEAR0).clears).toBe(1);
    expect(burn.step(free({ bullets: few, burn: true, clears: 1, tick: 1200 }), CLEAR0).clears).toBe(0);
  });

  it('11. 預設（不扣）時，狂按 b 不會把共用的次數按光', () => {
    const s = run(free({ bullets: bulletsFar(MIN - 5) }), 10, CLEAR0);
    expect(s.clears).toBe(3);
  });
});

describe('S-10 彈幕｜按早了會被鎖住（lockTicks：第三種變體，老闆指定的兩種之外）', () => {
  const MIN = 8;
  const LOCK = 120;
  const free = (extra: Partial<Parameters<typeof makeState>[0]> = {}): S10State =>
    makeState({ tick: 400, minBullets: MIN, ...extra });
  const locked = (extra: Partial<Parameters<typeof makeState>[0]> = {}): S10State =>
    makeState({ tick: 400, minBullets: MIN, lockTicks: LOCK, ...extra });

  it('1. init：lockTicks 預設是 0（關著），lock 是 [0, 0]；options 可以開', () => {
    const s = s10Game.init(0, CONFIG);
    expect([s.lockTicks, s.lock]).toEqual([0, [0, 0]]);
    expect(createS10Game({ lockTicks: 90 }).init(0, CONFIG).lockTicks).toBe(90);
  });

  it('2. 按早了（按得下去但子彈不足 N 顆）：只鎖按的那一邊，鎖 LOCK 個 tick；次數、分數、子彈都不變', () => {
    const s = s10Game.step(locked({ bullets: bulletsFar(MIN - 1) }), CLEAR0);
    expect(s.lock).toEqual([LOCK, 0]);
    expect([s.clears, s.cleared, s.bullets.length]).toEqual([3, [0, 0], MIN - 1]);
    expect(s10Game.step(locked({ bullets: bulletsFar(MIN - 1) }), CLEAR1).lock).toEqual([0, LOCK]);
    expect(s10Game.step(locked({ bullets: bulletsFar(MIN - 1) }), BOTH).lock).toEqual([LOCK, LOCK]);
  });

  it('3. 鎖住的期間按 b 沒有用，就算子彈夠；鎖每個 tick 減 1，歸 0 之後又能按', () => {
    const base = locked({ bullets: bulletsFar(MIN + 5), lock: [3, 0] });
    const blocked = s10Game.step(base, CLEAR0);
    expect([blocked.cleared, blocked.clears, blocked.lock]).toEqual([[0, 0], 3, [2, 0]]);
    // 對手沒被鎖，照樣能按
    expect(s10Game.step(base, CLEAR1).cleared).toEqual([0, MIN + 5]);
    const open = s10Game.step({ ...base, lock: [1, 0] }, CLEAR0);
    expect(open.cleared).toEqual([0, 0]);
    expect(s10Game.step(s10Game.step({ ...base, lock: [1, 0] }, IDLE), CLEAR0).cleared[0]).toBeGreaterThan(0);
  });

  it('4. 鎖住的期間再按不會延長鎖', () => {
    const s = s10Game.step(locked({ bullets: bulletsFar(MIN - 1), lock: [50, 0] }), CLEAR0);
    expect(s.lock).toEqual([49, 0]);
  });

  it('5. 第 300 tick 之前、無彈期、次數用完、最後一次的 1200 之前，按了不算按早，不鎖', () => {
    const few = bulletsFar(2);
    expect(s10Game.step(locked({ bullets: few, tick: 299 }), CLEAR0).lock).toEqual([0, 0]);
    expect(s10Game.step(locked({ bullets: few, quiet: 4 }), CLEAR0).lock).toEqual([0, 0]);
    expect(s10Game.step(locked({ bullets: few, clears: 0 }), CLEAR0).lock).toEqual([0, 0]);
    expect(s10Game.step(locked({ bullets: few, clears: 1, tick: 1100 }), CLEAR0).lock).toEqual([0, 0]);
    expect(s10Game.step(locked({ bullets: few, clears: 1, tick: 1200 }), CLEAR0).lock).toEqual([LOCK, 0]);
  });

  it('6. 子彈夠的時候按，照常清場、不鎖；lockTicks 是 0 時永遠不鎖', () => {
    const ok = s10Game.step(locked({ bullets: bulletsFar(MIN) }), CLEAR0);
    expect([ok.cleared[0], ok.lock]).toEqual([MIN, [0, 0]]);
    expect(s10Game.step(free({ bullets: bulletsFar(MIN - 1) }), CLEAR0).lock).toEqual([0, 0]);
  });

  it('7. actions：被鎖住的那一邊沒有 b（17 個），另一邊（子彈夠）有 34 個', () => {
    const s = locked({ bullets: bulletsFar(MIN + 2), lock: [10, 0] });
    expect(s10Game.actions(s, 0)).toHaveLength(17);
    expect(s10Game.actions(s, 1)).toHaveLength(34);
  });

  it('8. 狂按 b 的人被鎖得到、勸退：清場剛用完、子彈還沒長回 N 顆時按 b，之後 LOCK 個 tick 都按不到', () => {
    let s = s10Game.step(free({ bullets: bulletsFar(20), lockTicks: LOCK }), CLEAR0);
    s = run(s, QUIET_TICKS + 1, CLEAR0);
    expect(s.lock[0]).toBeGreaterThan(0);
    expect(s.bullets.length).toBeLessThan(MIN);
  });
});

// ---------------------------------------------------------------------------
// 險度（公開的，AI 讀它猜對手快不快撐不住）
// ---------------------------------------------------------------------------

describe('S-10 彈幕｜險度', () => {
  it('開局是 0；子彈離得遠，險度停在 0', () => {
    expect(s10Game.init(0, CONFIG).exposure).toEqual([0, 0]);
    const far = run(makeState({ bullets: bulletsFar(10) }), 60);
    expect(far.exposure).toEqual([0, 0]);
  });

  it('離最近的子彈越近險度越高（移動平均，時間常數 30 tick）；只算自己的，不受對手影響', () => {
    expect([EXPOSURE_FAR, EXPOSURE_TAU]).toEqual([12, 30]);
    // 子彈停在玩家 0 旁邊 6.5 像素：closeness = (12 − 6.5) / (12 − 5)
    const s = makeState({ bullets: [{ x: 51.5, y: 190, vx: 0, vy: 0 }], players: [{ x: 45, y: 190 }, { x: 105, y: 190 }] });
    const once = s10Game.step(s, IDLE);
    expect(once.exposure[0]).toBeCloseTo((5.5 / 7) / 30, 10);
    expect(once.exposure[1]).toBe(0);
    const long = run(s, 100);
    expect(long.exposure[0]).toBeGreaterThan(0.6);
    expect(long.exposure[0]).toBeLessThanOrEqual(1);
    // 子彈離開之後慢慢退回 0
    const gone = run({ ...long, bullets: [], quiet: 400 }, 400);
    expect(gone.exposure[0]).toBeLessThan(0.001);
  });

  it('小規格沒寫、我加的公開數字：清場讓子彈消失之後，險度只靠移動平均慢慢退，不會瞬間歸零', () => {
    const s = makeState({ tick: 400, bullets: [{ x: 51.5, y: 190, vx: 0, vy: 0 }, ...bulletsFar(20)] });
    const warmed = run(s, 100);
    const pressed = s10Game.step(warmed, CLEAR0);
    expect(pressed.exposure[0]).toBeGreaterThan(0.5 * warmed.exposure[0]);
  });
});
// ---------------------------------------------------------------------------
// 彈幕：螺旋與扇形
// ---------------------------------------------------------------------------

describe('S-10 彈幕｜螺旋', () => {
  it('每 6 tick 從發射口 (75, 12) 發 1 顆，速度 1.1，角度比上一發多 17 度', () => {
    const s0 = makeState({ tick: 5, angle: 0.4, spin: 1 });
    const s1 = s10Game.step(s0, IDLE);
    const [b] = fromEmitter(s1);
    expect(fromEmitter(s1)).toHaveLength(1);
    expect(speedOf(b as { vx: number; vy: number })).toBeCloseTo(SPIRAL_SPEED, 10);
    expect(angleDiff(angleOf(b as { vx: number; vy: number }), 0.4 + SPIRAL_STEP)).toBeCloseTo(0, 6);
    expect(deg(SPIRAL_STEP)).toBeCloseTo(17, 10);
    expect(s1.angle).toBeCloseTo(0.4 + SPIRAL_STEP, 10);
    // 中間的 5 個 tick 不發，第 12 個 tick 才又有一顆
    expect(run(makeState({ tick: 6 }), 5, IDLE).bullets).toHaveLength(0);
    expect(run(makeState({ tick: 6 }), 6, IDLE).bullets).toHaveLength(1);
  });

  it('發出的位置就是發射口（出生的那個 tick 還沒有飛）', () => {
    const s = s10Game.step(makeState({ tick: 5 }), IDLE);
    expect([s.bullets[0]?.x, s.bullets[0]?.y]).toEqual([EMITTER_X, EMITTER_Y]);
    expect(EMITTER_X).toBe(75);
    expect(EMITTER_Y).toBe(12);
  });

  it('第 2 階段（tick 900 起）雙臂：同一個 tick 發 2 顆、相隔 180 度；之前只有 1 顆', () => {
    const before = fromEmitter(s10Game.step(makeState({ tick: 893 }), IDLE));
    expect(before).toHaveLength(1);
    const after = fromEmitter(s10Game.step(makeState({ tick: 899 }), IDLE));
    expect(after).toHaveLength(2);
    const [a, b] = after;
    expect(Math.abs(angleDiff(angleOf(a as { vx: number; vy: number }), angleOf(b as { vx: number; vy: number })))).toBeCloseTo(180, 6);
  });

  it('第 3 階段（tick 1800 起）旋轉方向每 300 tick 反轉：1800 起反、2100 起回來、2400 起又反', () => {
    const turn = (tick: number, spin: 1 | -1): number => {
      const s = s10Game.step(makeState({ tick: tick - 1, angle: 0, spin }), IDLE);
      return deg(s.angle);
    };
    expect(turn(1794, 1)).toBeCloseTo(17, 6);
    expect(turn(1800, 1)).toBeCloseTo(-17, 6);
    expect(turn(2094, 1)).toBeCloseTo(-17, 6);
    expect(turn(2100, 1)).toBeCloseTo(17, 6);
    expect(turn(2400, 1)).toBeCloseTo(-17, 6);
    expect(turn(1800, -1)).toBeCloseTo(17, 6);
  });
});

describe('S-10 彈幕｜扇形', () => {
  const fanOf = (s: S10State): { vx: number; vy: number }[] =>
    fromEmitter(s).filter((b) => Math.abs(speedOf(b) - FAN_SPEED) < 1e-9);

  it('每 120 tick 發 9 顆、速度 1.6、張角 80 度（正負抖動 3 度之內），中心對準 0 號邊（偶數次）', () => {
    const s = s10Game.step(makeState({ tick: 119 }), IDLE);
    const fan = fanOf(s);
    expect(fan).toHaveLength(FAN_BULLETS);
    const aim = Math.atan2(190 - EMITTER_Y, 45 - EMITTER_X);
    const sorted = [...fan].sort((a, b) => angleOf(a) - angleOf(b));
    expect(Math.abs(angleDiff(angleOf(sorted[4] as { vx: number; vy: number }), aim))).toBeLessThanOrEqual(3.0001);
    const spread = deg(angleOf(sorted[8] as { vx: number; vy: number }) - angleOf(sorted[0] as { vx: number; vy: number }));
    expect(Math.abs(spread - 80)).toBeLessThanOrEqual(6.0001);
    expect(s.fanCount).toBe(1);
    // 不是 120 的倍數就沒有扇形
    expect(fanOf(s10Game.step(makeState({ tick: 120 }), IDLE))).toHaveLength(0);
  });

  it('輪流瞄準：fanCount 偶數瞄 0 號、奇數瞄 1 號；瞄的是這個 tick 移動之後的位置', () => {
    const odd = s10Game.step(makeState({ tick: 239, fanCount: 1 }), IDLE);
    const sorted = [...fanOf(odd)].sort((a, b) => angleOf(a) - angleOf(b));
    const aim = Math.atan2(190 - EMITTER_Y, 105 - EMITTER_X);
    expect(Math.abs(angleDiff(angleOf(sorted[4] as { vx: number; vy: number }), aim))).toBeLessThanOrEqual(3.0001);
    expect(odd.fanCount).toBe(2);
    // 0 號邊這個 tick 往右走 1.5，瞄準用走完之後的位置
    const moved = s10Game.step(makeState({ tick: 119, players: [{ x: 100, y: 100 }, {}] }), [press({ right: true }), NONE]);
    const mid = [...fanOf(moved)].sort((a, b) => angleOf(a) - angleOf(b))[4] as { vx: number; vy: number };
    expect(Math.abs(angleDiff(angleOf(mid), Math.atan2(100 - EMITTER_Y, 101.5 - EMITTER_X)))).toBeLessThanOrEqual(3.0001);
  });

  it('第 3 階段（tick 1800 起）每 90 tick 一次：1800 有、1890 有、1920（原本的 120 的倍數）沒有', () => {
    expect(fanOf(s10Game.step(makeState({ tick: 1799 }), IDLE))).toHaveLength(FAN_BULLETS);
    expect(fanOf(s10Game.step(makeState({ tick: 1889 }), IDLE))).toHaveLength(FAN_BULLETS);
    expect(fanOf(s10Game.step(makeState({ tick: 1919 }), IDLE))).toHaveLength(0);
    expect(fanOf(s10Game.step(makeState({ tick: 1829 }), IDLE))).toHaveLength(0);
  });

  it('抖動由種子決定：種子 0 到 9 的扇形中心角度不全相同，同一個種子兩次相同', () => {
    const centers = Array.from({ length: 10 }, (_, seed) => {
      let s = s10Game.init(seed, CONFIG);
      s = run(s, 120);
      const sorted = [...fanOf(s)].sort((a, b) => angleOf(a) - angleOf(b));
      return angleOf(sorted[4] as { vx: number; vy: number });
    });
    expect(new Set(centers.map((c) => c.toFixed(6))).size).toBeGreaterThanOrEqual(5);
    const again = (() => {
      const s = run(s10Game.init(4, CONFIG), 120);
      return angleOf([...fanOf(s)].sort((a, b) => angleOf(a) - angleOf(b))[4] as { vx: number; vy: number });
    })();
    expect(again).toBe(centers[4]);
  });
});

describe('S-10 彈幕｜子彈', () => {
  it('子彈每 tick 照速度飛；整顆離開場地（中心超出邊界 2 像素）就移除', () => {
    const s = makeState({ bullets: [{ x: 50, y: 50, vx: 1, vy: -0.5 }] });
    const moved = s10Game.step(s, IDLE);
    expect([moved.bullets[0]?.x, moved.bullets[0]?.y]).toEqual([51, 49.5]);
    expect(s10Game.step(makeState({ bullets: [{ x: 151.5, y: 50, vx: 1, vy: 0 }] }), IDLE).bullets).toHaveLength(0);
    expect(s10Game.step(makeState({ bullets: [{ x: -1.5, y: 50, vx: -1, vy: 0 }] }), IDLE).bullets).toHaveLength(0);
    expect(s10Game.step(makeState({ bullets: [{ x: 50, y: -1.5, vx: 0, vy: -1 }] }), IDLE).bullets).toHaveLength(0);
    expect(s10Game.step(makeState({ bullets: [{ x: 50, y: 221.5, vx: 0, vy: 1 }] }), IDLE).bullets).toHaveLength(0);
    expect(s10Game.step(makeState({ bullets: [{ x: 151, y: 50, vx: 0.5, vy: 0 }] }), IDLE).bullets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 命中與無敵
// ---------------------------------------------------------------------------

describe('S-10 彈幕｜命中', () => {
  const under = (x: number, y: number, extra: Partial<Parameters<typeof makeState>[0]> = {}): S10State =>
    makeState({ players: [{ x: 45, y: 190 }, { x: 105, y: 190 }], bullets: [{ x, y, vx: 0, vy: 1 }], ...extra });

  it('距離小於 5 才算：扣 10 分、子彈消失、無敵 60 tick；（邊界）剛好 5 不算', () => {
    const hit = s10Game.step(under(45, 185), IDLE);
    expect([hit.players[0].hits, hit.players[0].invuln, hit.bullets.length]).toEqual([1, 60, 0]);
    expect(s10Game.score(hit)).toEqual([-10, 0]);
    expect(HIT_PENALTY).toBe(10);
    const edge = s10Game.step(under(45, 184), IDLE);
    expect([edge.players[0].hits, edge.bullets.length]).toEqual([0, 1]);
  });

  it('無敵期間子彈照常飛過、不消失、不扣分；無敵每 tick 減 1，歸 0 之後又會被打中', () => {
    const shielded = s10Game.step(under(45, 185, { players: [{ x: 45, y: 190, invuln: 30 }, {}] }), IDLE);
    expect([shielded.players[0].hits, shielded.players[0].invuln, shielded.bullets.length]).toEqual([0, 29, 1]);
    const last = s10Game.step(under(45, 185, { players: [{ x: 45, y: 190, invuln: 1 }, {}] }), IDLE);
    expect([last.players[0].hits, last.players[0].invuln]).toEqual([0, 0]);
    const after = s10Game.step(under(45, 185, { players: [{ x: 45, y: 190, invuln: 0 }, {}] }), IDLE);
    expect(after.players[0].hits).toBe(1);
  });

  it('同一個 tick 兩顆子彈同時碰到：只算 1 次，第二顆照常飛過', () => {
    const s = makeState({
      players: [{ x: 45, y: 190 }, { x: 105, y: 190 }],
      bullets: [{ x: 45, y: 185, vx: 0, vy: 1 }, { x: 46, y: 185, vx: 0, vy: 1 }],
    });
    const hit = s10Game.step(s, IDLE);
    expect([hit.players[0].hits, hit.bullets.length]).toEqual([1, 1]);
  });

  it('兩個人重疊時，一顆子彈同時打中兩個人（兩邊都扣分，沒有偏袒）；一個人無敵就只打中另一個', () => {
    const both = makeState({
      players: [{ x: 60, y: 190 }, { x: 60, y: 190 }],
      bullets: [{ x: 60, y: 185, vx: 0, vy: 1 }],
    });
    const hit = s10Game.step(both, IDLE);
    expect([hit.players[0].hits, hit.players[1].hits, hit.bullets.length]).toEqual([1, 1, 0]);
    const oneShielded = s10Game.step(
      makeState({
        players: [{ x: 60, y: 190, invuln: 10 }, { x: 60, y: 190 }],
        bullets: [{ x: 60, y: 185, vx: 0, vy: 1 }],
      }),
      IDLE,
    );
    expect([oneShielded.players[0].hits, oneShielded.players[1].hits, oneShielded.bullets.length]).toEqual([0, 1, 0]);
  });

  it('命中的是被打中的那一個人：1 號邊被打中不影響 0 號邊', () => {
    const hit = s10Game.step(under(105, 185), IDLE);
    expect([hit.players[0].hits, hit.players[1].hits]).toEqual([0, 1]);
    expect(s10Game.score(hit)).toEqual([0, -10]);
  });
});

// ---------------------------------------------------------------------------
// 結束、分數、動作
// ---------------------------------------------------------------------------

describe('S-10 彈幕｜結束與分數', () => {
  it('分數 = 清場得到的 N 的總和 − 10 × 被打中次數；時間到分數高的贏、同分平手；結束前 winner 是 null', () => {
    const base = makeState({ tick: 2700, maxTicks: 2700 });
    expect(s10Game.isOver(base)).toBe(true);
    const lead = { ...base, cleared: [30, 20] as const, players: [{ ...base.players[0], hits: 1 }, base.players[1]] as const };
    expect(s10Game.score(lead)).toEqual([20, 20]);
    expect(s10Game.winner(lead)).toBeNull();
    expect(s10Game.winner({ ...base, cleared: [31, 20] })).toBe(0);
    expect(s10Game.winner({ ...base, cleared: [5, 20] })).toBe(1);
    expect(s10Game.winner({ ...base, tick: 2699 })).toBeNull();
  });

  it('結束之後再 step，state 原樣不變（同一個物件）', () => {
    const over = makeState({ tick: 2700, maxTicks: 2700, bullets: bulletsFar(3) });
    expect(s10Game.step(over, BOTH)).toBe(over);
  });

  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，含清場、命中、發射的那一次）', () => {
    const cases: S10State[] = [
      makeState({ tick: 400, bullets: bulletsFar(20) }),
      makeState({ tick: 119, bullets: [{ x: 45, y: 185, vx: 0, vy: 1 }] }),
      makeState({ tick: 899 }),
    ];
    for (const c of cases) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(c)) as S10State);
      expect(() => s10Game.step(frozen, BOTH)).not.toThrow();
    }
  });

  it('K1：同一個種子、同一串輸入跑兩次結果相同；整個 state 可以 JSON 來回', () => {
    const play = (): S10State => {
      let s = s10Game.init(5, CONFIG);
      for (let i = 0; i < 700; i += 1) {
        s = s10Game.step(s, [press({ left: i % 40 < 20, right: i % 40 >= 20, b: i === 400 }), NONE]);
      }
      return s;
    };
    expect(play()).toEqual(play());
    const s = play();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('S-10 彈幕｜actions', () => {
  it('不能清場時 17 個動作（全放開排第一、都沒有 b）；能清場時 34 個，後 17 個是同樣的移動加 b', () => {
    const plain = s10Game.actions(makeState({ tick: 100, bullets: bulletsFar(5) }), 0);
    expect(plain).toHaveLength(17);
    expect(plain[0]).toEqual(NONE);
    expect(plain.every((a) => !a.b)).toBe(true);
    const withClear = s10Game.actions(makeState({ tick: 400, bullets: bulletsFar(5) }), 1);
    expect(withClear).toHaveLength(34);
    expect(withClear.slice(17).every((a) => a.b)).toBe(true);
    expect(withClear.slice(0, 17).every((a) => !a.b)).toBe(true);
    expect(withClear.slice(17).map((a) => ({ ...a, b: false }))).toEqual(withClear.slice(0, 17));
  });

  it('次數用完、無彈期、場上沒有子彈：只有 17 個', () => {
    expect(s10Game.actions(makeState({ tick: 400, clears: 0, bullets: bulletsFar(5) }), 0)).toHaveLength(17);
    expect(s10Game.actions(makeState({ tick: 400, quiet: 3, bullets: bulletsFar(5) }), 0)).toHaveLength(17);
    expect(s10Game.actions(makeState({ tick: 400 }), 0)).toHaveLength(17);
  });
});

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

describe('S-10 彈幕｜evaluate', () => {
  /** 對 0 號邊：每個動作走一步（對手不動）之後的 gain 與 danger。 */
  function scores(state: S10State): { gain: number; danger: number; clear: boolean }[] {
    return s10Game.actions(state, 0).map((action) => {
      const next = s10Game.step(state, [action, NONE]);
      return { ...s10Game.evaluate(next, 0), clear: action.b };
    });
  }
  const bestOf = (xs: { gain: number; clear: boolean }[]): { gain: number; clear: boolean } =>
    xs.reduce((best, x) => (x.gain > best.gain ? x : best));

  it('danger 在 0 到 1、gain 是有限的數；子彈直接砸向自己時 danger 是 1，按 b 之後是 0', () => {
    const doomed = makeState({ tick: 400, bullets: [{ x: 45, y: 170, vx: 0, vy: 1.2 }], players: [{ x: 45, y: 190, vx: 0, vy: 0 }, {}] });
    const all = scores(doomed);
    for (const x of all) {
      expect(Number.isFinite(x.gain)).toBe(true);
      expect(x.danger).toBeGreaterThanOrEqual(0);
      expect(x.danger).toBeLessThanOrEqual(1);
    }
    expect(all[0]?.danger).toBe(1);
    expect(all.filter((x) => x.clear).every((x) => x.danger === 0)).toBe(true);
  });

  it('子彈很多（45 顆、3 次還在、tick 1000）：按 b 的 gain 最高；很少（8 顆）：不按', () => {
    expect(bestOf(scores(makeState({ tick: 1000, bullets: leaving(45) }))).clear).toBe(true);
    expect(bestOf(scores(makeState({ tick: 1000, bullets: leaving(8) }))).clear).toBe(false);
  });

  it('等待的價值看預測：場上的子彈 30 tick 後還在（加上新發的）時，值比「馬上要飛走」的高', () => {
    const stay = makeState({ tick: 1000, bullets: bulletsFar(30) });
    const go = makeState({ tick: 1000, bullets: leaving(30) });
    expect(predictCount(stay, 30)).toBeGreaterThan(predictCount(go, 30) + 25);
    expect(holdValue(stay, 3, 0.5)).toBeGreaterThan(holdValue(go, 3, 0.5));
  });

  it('門檻：時間充裕時，握著 1、2、3 次的門檻一樣（約 10 顆）；時間緊迫時，握著越多次越急', () => {
    const thresholdFor = (tick: number, clears: number): number => {
      for (let n = 1; n <= 60; n += 1) {
        if (bestOf(scores(makeState({ tick, clears, bullets: leaving(n) }))).clear) {
          return n;
        }
      }
      return 99;
    };
    const calmThresholds = [1, 2, 3].map((c) => thresholdFor(1300, c));
    expect(new Set(calmThresholds).size).toBe(1);
    expect(calmThresholds[0]).toBeGreaterThanOrEqual(8);
    expect(calmThresholds[0]).toBeLessThanOrEqual(12);
    expect(thresholdFor(2300, 3)).toBeLessThan(thresholdFor(2300, 1) - 5);
  });

  it('剩下的時間不夠再等：tick 2690 時，同樣 6 顆就該按；tick 1000 時 6 顆還在等', () => {
    expect(bestOf(scores(makeState({ tick: 1000, bullets: leaving(6) }))).clear).toBe(false);
    expect(bestOf(scores(makeState({ tick: 2690, clears: 1, bullets: leaving(6) }))).clear).toBe(true);
  });

  it('等待價值的 h 讀對手的險度：對手一直貼著子彈（險度高）時，同樣的子彈數更早該按；險度滿的時候門檻明顯降低', () => {
    const threshold = (oppExposure: number): number => {
      for (let n = 1; n <= 60; n += 1) {
        const s = { ...makeState({ tick: 1000, bullets: leaving(n) }), exposure: [0, oppExposure] as const };
        if (bestOf(scores(s)).clear) {
          return n;
        }
      }
      return 99;
    };
    expect(EXPOSURE_FULL).toBe(0.05);
    const calm = threshold(0);
    const edgy = threshold(EXPOSURE_FULL);
    expect(edgy).toBeLessThan(calm - 4);
    // 險度超過「滿」之後不再加碼
    expect(threshold(1)).toBe(edgy);
    // 我自己的險度不影響我的 h（讀的是對手的）
    const mine = { ...makeState({ tick: 1000, bullets: leaving(calm) }), exposure: [1, 0] as const };
    expect(bestOf(scores(mine)).clear).toBe(true);
  });

  it('h 只看公開的險度，不看對手的按鍵或速度：對手的 vx、vy 不同，evaluate 完全相同', () => {
    const a = makeState({ tick: 1000, bullets: bulletsFar(30), players: [{}, { x: 105, y: 190, vx: 0, vy: 0 }] });
    const b = makeState({ tick: 1000, bullets: bulletsFar(30), players: [{}, { x: 105, y: 190, vx: 1.5, vy: -1.5 }] });
    expect(s10Game.evaluate(a, 0)).toEqual(s10Game.evaluate(b, 0));
  });

  it('沒有橡皮筋：兩邊的清場分數同時加上同一個常數，evaluate 不變', () => {
    const a = makeState({ tick: 1000, bullets: bulletsFar(30) });
    const b = { ...a, cleared: [17, 17] as const };
    expect(s10Game.evaluate(b, 0)).toEqual(s10Game.evaluate(a, 0));
    expect(s10Game.evaluate(b, 1)).toEqual(s10Game.evaluate(a, 1));
  });

  it('領先越多 gain 越高，對方領先越多越低；結束的局 gain 是分差、danger 是 0', () => {
    const base = makeState({ tick: 1000, bullets: bulletsFar(10) });
    const ahead = { ...base, cleared: [20, 0] as const };
    expect(s10Game.evaluate(ahead, 0).gain).toBeGreaterThan(s10Game.evaluate(base, 0).gain);
    expect(s10Game.evaluate(ahead, 1).gain).toBeLessThan(s10Game.evaluate(base, 1).gain);
    const over = makeState({ tick: 2700, maxTicks: 2700, cleared: [20, 5] });
    expect(s10Game.evaluate(over, 0)).toEqual({ gain: 1500, danger: 0 });
    expect(s10Game.evaluate(over, 1)).toEqual({ gain: -1500, danger: 0 });
  });

  it('單位一致（不會讓 AI 站著不動）：沒有子彈威脅時，往中央移動的 gain 與站著的 gain 同一個量級，且按 b 與等待可以比', () => {
    const s = makeState({ tick: 1000, bullets: bulletsFar(30) });
    const xs = scores(s);
    const spread = Math.max(...xs.map((x) => x.gain)) - Math.min(...xs.map((x) => x.gain));
    expect(spread).toBeGreaterThan(0);
    // 按 b 得 30 分（= 3000）與等待的價值（至多約 60 分）是同一個量級，位置項小於 1 分
    const moves = xs.filter((x) => !x.clear).map((x) => x.gain);
    expect(Math.max(...moves) - Math.min(...moves)).toBeLessThan(100);
  });

  it('predictCount：沒有子彈、tick 130 往後 30 tick：照發射規則算出 5 顆螺旋（132 到 156）；有子彈飛出去的不算', () => {
    expect(predictCount(makeState({ tick: 130, angle: 0 }), 0)).toBe(0);
    expect(predictCount(makeState({ tick: 130, angle: 0 }), 30)).toBe(5);
    expect(predictCount(makeState({ tick: 100, angle: 0 }), 30)).toBe(5 + 9);
    const leaving = makeState({ tick: 100, bullets: [{ x: 149, y: 50, vx: 1, vy: 0 }] });
    expect(predictCount(leaving, 1)).toBe(1 + predictCount(makeState({ tick: 100 }), 1));
    expect(predictCount(leaving, 10)).toBe(predictCount(makeState({ tick: 100 }), 10));
  });

  it('predictCount：無彈期內不算新發的；無彈期過了才算', () => {
    expect(predictCount(makeState({ tick: 300, quiet: 30 }), 20)).toBe(0);
    expect(predictCount(makeState({ tick: 300, quiet: 10 }), 30)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AI（精準型）怎麼決定
// ---------------------------------------------------------------------------

describe('S-10 彈幕｜精準型的決定', () => {
  const decide = (state: S10State, side: 0 | 1 = 0): Buttons =>
    policyByName('precise').decide(s10Game, state, side, state.tick, { depth: 1, seed: 0 });

  it('子彈很多就按 b、很少就不按（b 在 evaluate 的單位裡可以和等待比）', () => {
    expect(decide(makeState({ tick: 1000, bullets: leaving(48) })).b).toBe(true);
    expect(decide(makeState({ tick: 1000, bullets: leaving(8) })).b).toBe(false);
  });

  it('子彈砸下來時閃開：往旁邊走，30 tick 之後沒有被打中', () => {
    let s = makeState({
      tick: 100,
      bullets: [0, 1, 2, 3].map((i) => ({ x: 45 + (i - 1.5) * 4, y: 120 - i * 8, vx: 0, vy: 1.2 })),
      players: [{ x: 45, y: 190 }, { x: 140, y: 100 }],
    });
    for (let i = 0; i < 80; i += 1) {
      s = s10Game.step(s, [decide(s), NONE]);
    }
    expect(s.players[0].hits).toBe(0);
    expect(s.players[0].x === 45 && s.players[0].y === 190).toBe(false);
  });

  it('危險逼近到每個移動都躲不掉的時候，按 b 保命（b 之後 danger 是 0）', () => {
    // 兩側都是牆，上方一整排子彈掉下來
    const wall = Array.from({ length: 30 }, (_, i) => ({ x: 3 + i * 4.8, y: 185, vx: 0, vy: 1.2 }));
    const s = makeState({ tick: 400, bullets: wall, players: [{ x: 70, y: 190 }, { x: 140, y: 200 }] });
    expect(decide(s).b).toBe(true);
  });
});

describe('S-10 彈幕｜變體（消融用）', () => {
  it('createS10Game 可以改次數與無彈期：clears 99 → init 就是 99；quiet 0 → 清場之後立刻可以再發', () => {
    const many = createS10Game({ clears: 99 });
    expect(many.init(0, CONFIG).clears).toBe(99);
    const noQuiet = createS10Game({ quiet: 0 });
    const s = noQuiet.step(makeState({ tick: 5, bullets: bulletsFar(3), quiet: 0 }), IDLE);
    expect(s.bullets.length).toBeGreaterThan(3);
    const state = { ...makeState({ tick: 400, bullets: bulletsFar(10) }), quietFor: 0 };
    const pressed = noQuiet.step(state, CLEAR0);
    expect(pressed.quiet).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 量測（DESIGN-AI-FUN 10.3、10.4、10.24；數字與解讀在 docs/cards/S-10.md）
// 對手是精準型等級 10；偶數種子坐 0 號邊；平手算半場；每格 16 場（標準誤約 12 個百分點），
// 所以斷言只放很寬的界線。更大的樣本（100 場）與探針 A 的數字在小規格裡。
// ---------------------------------------------------------------------------

describe('S-10 彈幕｜劇本玩家與消融（對精準型等級 10）', () => {
  const N = 16;
  const cache = new Map<string, ReturnType<typeof summarize>>();
  function row(
    key: string,
    make: (seed: number, side: 0 | 1) => ReturnType<typeof player>,
    game = s10Game,
  ): ReturnType<typeof summarize> {
    const hit = cache.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const records = Array.from({ length: N }, (_, seed) =>
      playAgainstAi(game, make, (s) => levelController(game, precise, 10, s), seed),
    );
    const result = summarize(records);
    cache.set(key, result);
    return result;
  }
  const habit = (): ReturnType<typeof summarize> => row('habit', (seed) => player('habit', seed));

  it('三列（強／人類型／弱，順序要看得到）：讀 AI 決定規則的狙擊手 > 人類模型 > 均勻亂決定；習慣玩家與 AI 幾乎全平手', () => {
    const sniper = row('sniper', (seed) => player('sniper', seed));
    const human = row('human', (seed) => humanModel(s10Game, seed));
    const random = row('uniform', (seed, side) => uniform(seed, side));
    expect(sniper.win).toBeGreaterThanOrEqual(90);
    expect(human.win).toBeGreaterThanOrEqual(25);
    expect(human.win).toBeLessThanOrEqual(70);
    expect(random.win).toBeLessThanOrEqual(10);
    expect(sniper.win).toBeGreaterThan(human.win + 25);
    expect(human.win).toBeGreaterThan(random.win + 25);
    expect(habit().win).toBeGreaterThanOrEqual(30);
    expect(habit().win).toBeLessThanOrEqual(70);
    // 均勻亂決定輸在被打中（每場約 11 次），不是輸在清場
    expect(random.hitsMe).toBeGreaterThan(5);
  }, 3_600_000);

  it('已知弱點（量到的，不是設計）：按住 b 的玩家（閃躲照精準型）贏 AI —— 它在無彈期一結束、只有 1 顆子彈時就搶走第二次', () => {
    const mash = row('masher', (seed) => masher(seed));
    expect(mash.win).toBeGreaterThanOrEqual(90);
    expect(mash.myClears).toBeGreaterThanOrEqual(0.9);
    expect(mash.aiClears).toBeLessThanOrEqual(0.1);
  }, 3_600_000);

  it('第一欄與第二欄：「假裝危險」做不出來 —— 貼近子彈的玩家，險度平均也不到 0.01，被打中次數沒增加，勝率與習慣玩家一樣', () => {
    const f = row('feint1', (seed) => feint(1, seed));
    expect(f.exposureMe).toBeLessThan(0.01);
    expect(f.hitsMe).toBeLessThanOrEqual(habit().hitsMe + 0.3);
    expect(Math.abs(f.win - habit().win)).toBeLessThanOrEqual(25);
  }, 3_600_000);

  it.todo('小規格：「餵了再破（騙一次、騙兩次）要明顯贏過不騙」（未達成：量到 51 比 51，見 docs/cards/S-10.md）');

  it('真人觀察模型（舊畫面、現在的自己，不重播，DESIGN-AI-FUN 9.8）：延遲 0 打平，延遲 1 個 tick 就輸光 —— 懸崖在搶清場的先後，不在閃躲', () => {
    const d0 = row('dv0', (seed) => delayedView(player('habit', seed), { delay: 0, decideEvery: 1, epsilon: 0 }, seed));
    const d1 = row('dv1', (seed) => delayedView(player('habit', seed), { delay: 1, decideEvery: 1, epsilon: 0 }, seed));
    expect(d0.win).toBeGreaterThanOrEqual(35);
    expect(d1.win).toBeLessThanOrEqual(10);
    expect(d1.hitsMe).toBeLessThan(0.5);
  }, 3_600_000);

  it('wrapPolicy 把反應延遲補償光了（子彈由種子決定）：反應延遲 0 與 12 對著不動的對手，輸出完全相同', () => {
    const play = (reactionTicks: number): S10State => {
      const c = wrapPolicy(s10Game, precise, { reactionTicks, decideEvery: 1, depth: 1, epsilon: 0 }, 3);
      let state = s10Game.init(3, CONFIG);
      for (let tick = 0; tick < 500; tick += 1) {
        state = s10Game.step(state, [c.decide(state, 0, tick), NONE]);
      }
      return state;
    };
    expect(play(12)).toEqual(play(0));
  }, 120_000);

  it('消融：關掉「AI 讀對手險度」、關掉無彈期，先按的好處都不變；只有關掉稀缺（99 次）才改變 —— 先按的價值全部來自「先按先得」本身', () => {
    const base = habit().win;
    const noListen = row('nolisten-habit', (seed) => player('habit', seed), createS10Game({ readsDanger: false })).win;
    const noQuiet = row('quiet0-habit', (seed) => player('habit', seed), createS10Game({ quiet: 0 })).win;
    const plenty = row('abundant-habit', (seed) => player('habit', seed), createS10Game({ clears: 99 })).win;
    expect(Math.abs(noListen - base)).toBeLessThanOrEqual(25);
    expect(Math.abs(noQuiet - base)).toBeLessThanOrEqual(25);
    expect(plenty).toBeLessThan(base - 30);
  }, 3_600_000);

  it('四個性格的指紋：賭徒型被打中的次數是精準型的 5 倍以上（命中數是唯一拉得開的指標）', () => {
    const hits = (name: 'precise' | 'gambler'): number =>
      row(`pol-${name}`, (seed) => levelController(s10Game, policyByName(name), 10, seed)).hitsMe;
    expect(hits('gambler')).toBeGreaterThanOrEqual(5 * Math.max(0.05, hits('precise')));
  }, 3_600_000);

  it('局長：每一局都跑滿 2700 tick（45 秒），在 30 到 90 秒之間', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      const r = playMatch(
        s10Game,
        seed,
        CONFIG,
        levelController(s10Game, precise, 5, seed),
        levelController(s10Game, precise, 5, seed + 1),
      );
      expect(r.ticks).toBe(2700);
      expect(r.ticks / 60).toBeGreaterThanOrEqual(30);
      expect(r.ticks / 60).toBeLessThanOrEqual(90);
    }
  }, 120_000);
});
