import { describe, expect, it } from 'vitest';
import { policyByName } from '../../ai/level';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import { createRng } from '../../core/rng';
import { createS5Game, guessReturn, makeState, predictArrival, s5Game } from './logic';
import type { S5State } from './logic';

/**
 * S-5 乒乓的規則測試。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 0 號邊是人（下緣，y = 210）、1 號邊是 AI（上緣，y = 10）。
 */
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const press = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const IDLE: Inputs = [NONE, NONE];
const RIGHT: Inputs = [press({ right: true }), NONE];
const LEFT: Inputs = [press({ left: true }), NONE];
const CONFIG = { maxTicks: 5400, params: {} };
const DEG = Math.PI / 180;

function run(state: S5State, count: number, inputs: Inputs = IDLE): S5State {
  let s = state;
  for (let i = 0; i < count; i += 1) {
    s = s5Game.step(s, inputs);
  }
  return s;
}

/** 一直 step 到條件成立（最多 max 個 tick）。 */
function until(
  state: S5State,
  done: (s: S5State) => boolean,
  inputs: Inputs = IDLE,
  max = 400,
): S5State {
  let s = state;
  for (let i = 0; i < max && !done(s); i += 1) {
    s = s5Game.step(s, inputs);
  }
  return s;
}
const notPlaying = (s: S5State): boolean => s.phase !== 'play';

/** 球在 0 號邊那條線前一格（y = 209，每 tick 往下 2.2），穿過 y = 210：下一個 tick 會被判定。 */
const atLine = (offsetFromPaddle: number, extra = {}): S5State =>
  makeState({
    ball: { x: 75 + offsetFromPaddle, y: 209, vx: 0, vy: 2.2, lastHit: 1, ...extra },
    paddles: [{ x: 75 }, { x: 75 }],
  });

describe('S-5 乒乓｜板子的慣性', () => {
  it('1a. 從靜止按住右：每 tick 速度加 0.2，12 tick 到全速 2.4、走了約 15.6 像素', () => {
    const one = s5Game.step(makeState({}), RIGHT);
    expect(one.paddles[0].vx).toBeCloseTo(0.2, 10);
    expect(one.paddles[0].x).toBeCloseTo(75.2, 10);
    const full = run(makeState({}), 12, RIGHT);
    expect(full.paddles[0].vx).toBeCloseTo(2.4, 10);
    expect(full.paddles[0].x).toBeCloseTo(75 + 0.2 * 78, 10);
    expect(run(makeState({}), 11, RIGHT).paddles[0].vx).toBeCloseTo(2.2, 10);
    // 全速之後不再加
    expect(run(makeState({}), 20, RIGHT).paddles[0].vx).toBeCloseTo(2.4, 10);
  });

  it('1b. 反轉要 24 tick：從 +2.4 按住左，12 tick 才停下來、24 tick 才到 −2.4', () => {
    const start = makeState({ paddles: [{ x: 75, vx: 2.4, target: 2.4 }, {}] });
    expect(run(start, 12, LEFT).paddles[0].vx).toBeCloseTo(0, 10);
    expect(run(start, 23, LEFT).paddles[0].vx).toBeGreaterThan(-2.4 + 0.1);
    expect(run(start, 24, LEFT).paddles[0].vx).toBeCloseTo(-2.4, 10);
  });

  it('1c. 放開：目標速度是 0，從全速 12 tick 慢下來停住（還會滑出去一段）', () => {
    const start = makeState({ paddles: [{ x: 75, vx: 2.4, target: 2.4 }, {}] });
    const stopped = run(start, 12, IDLE);
    expect(stopped.paddles[0].vx).toBeCloseTo(0, 10);
    expect(stopped.paddles[0].x).toBeCloseTo(
      75 + 0.2 * (11 + 10 + 9 + 8 + 7 + 6 + 5 + 4 + 3 + 2 + 1),
      8,
    );
  });

  it('1d. 按住 a 是慢速：目標速度 ±1.0；只按 a 等於放開', () => {
    const slow = run(makeState({}), 10, [press({ right: true, a: true }), NONE]);
    expect(slow.paddles[0].vx).toBeCloseTo(1.0, 10);
    const slowLeft = run(makeState({}), 10, [press({ left: true, a: true }), NONE]);
    expect(slowLeft.paddles[0].vx).toBeCloseTo(-1.0, 10);
    const stopping = run(slow, 5, [press({ a: true }), NONE]);
    expect(stopping.paddles[0].vx).toBeCloseTo(0, 10);
  });

  it('1e.（邊界）中心 x 夾在 [15, 135]，撞牆速度歸零；兩邊同時按左右等於放開', () => {
    const wall = makeState({
      paddles: [
        { x: 134, vx: 2.4, target: 2.4 },
        { x: 16, vx: -2.4, target: -2.4 },
      ],
    });
    const next = s5Game.step(wall, [press({ right: true }), press({ left: true })]);
    expect(next.paddles[0]).toMatchObject({ x: 135, vx: 0 });
    expect(next.paddles[1]).toMatchObject({ x: 15, vx: 0 });
    const both = s5Game.step(makeState({}), [press({ left: true, right: true }), NONE]);
    expect(both.paddles[0].vx).toBe(0);
  });

  it('1f. 兩塊板子各自移動：1 號邊的左右鍵也一樣', () => {
    const s = s5Game.step(makeState({}), [NONE, press({ left: true })]);
    expect(s.paddles[1].vx).toBeCloseTo(-0.2, 10);
    expect(s.paddles[0].vx).toBe(0);
  });
});

describe('S-5 乒乓｜擊球', () => {
  it.each([
    [0, 0],
    [9, 25],
    [18, 50],
    [-18, -50],
    [-9, -25],
  ])(
    '2. 球落在板子 %s 像素處：擊球角度 %s 度（中心 0°、邊緣 50°），朝對方、球速 2.55',
    (offset, degrees) => {
      const s = s5Game.step(atLine(offset), IDLE);
      const { ball } = s;
      expect(ball.lastHit).toBe(0);
      expect(ball.hits).toBe(1);
      expect(ball.y).toBe(210);
      expect(ball.vy).toBeLessThan(0);
      expect(ball.vx).toBeCloseTo(2.55 * Math.sin(degrees * DEG), 8);
      expect(ball.vy).toBeCloseTo(-2.55 * Math.cos(degrees * DEG), 8);
      expect(Math.hypot(ball.vx, ball.vy)).toBeCloseTo(2.55, 8);
    },
  );

  it('2b.（邊界）距離剛好 18 算擊中；18.01 沒接到，球照原路穿過去', () => {
    expect(s5Game.step(atLine(18), IDLE).ball.lastHit).toBe(0);
    const miss = s5Game.step(atLine(18.01), IDLE);
    expect(miss.ball.lastHit).toBe(1);
    expect(miss.ball.hits).toBe(0);
    expect(miss.ball.vy).toBeCloseTo(2.2, 10);
  });

  it('2c. 1 號邊擊球：球往下（朝人）、對稱', () => {
    const s = makeState({
      ball: { x: 84, y: 11, vx: 0, vy: -2.2, lastHit: 0 },
      paddles: [{ x: 75 }, { x: 75 }],
    });
    const hit = s5Game.step(s, IDLE).ball;
    expect(hit.lastHit).toBe(1);
    expect(hit.y).toBe(10);
    expect(hit.vy).toBeGreaterThan(0);
    expect(hit.vx).toBeCloseTo(2.55 * Math.sin(25 * DEG), 8);
  });

  it('3a. 旋＝擊球那一刻板速 × 0.012：右滑 +0.0288、靜止 0、左滑 −0.0288；舊的旋被取代', () => {
    const sliding = makeState({
      ball: { x: 77.4, y: 209, vx: 0, vy: 2.2, lastHit: 1 },
      paddles: [{ x: 75, vx: 2.4, target: 2.4 }, {}],
    });
    expect(s5Game.step(sliding, RIGHT).ball.spin).toBeCloseTo(0.0288, 10);
    const left = makeState({
      ball: { x: 72.6, y: 209, vx: 0, vy: 2.2, lastHit: 1 },
      paddles: [{ x: 75, vx: -2.4, target: -2.4 }, {}],
    });
    expect(s5Game.step(left, LEFT).ball.spin).toBeCloseTo(-0.0288, 10);
    expect(s5Game.step(atLine(0), IDLE).ball.spin).toBeCloseTo(0, 12);
    expect(s5Game.step(atLine(0, { spin: 0.05 }), IDLE).ball.spin).toBeCloseTo(0, 12);
  });

  it('3b. 飛行時每 tick：vx += spin、spin ×= 0.99', () => {
    const s = makeState({ ball: { x: 75, y: 110, vx: 1, vy: -2.2, spin: 0.02 } });
    const next = s5Game.step(s, IDLE);
    expect(next.ball.vx).toBeCloseTo(1.02, 10);
    expect(next.ball.spin).toBeCloseTo(0.0198, 10);
    expect(next.ball.x).toBeCloseTo(76.02, 10);
  });

  it('3c. 碰側牆：vx 反向、spin 減半、球不會跑出場地', () => {
    const s = makeState({ ball: { x: 146, y: 110, vx: 2, vy: -2.2, spin: 0.01 } });
    const next = s5Game.step(s, IDLE);
    expect(next.ball.vx).toBeCloseTo(-2.01, 10);
    expect(next.ball.spin).toBeCloseTo((0.01 * 0.99) / 2, 12);
    expect(next.ball.x).toBeLessThanOrEqual(147);
    expect(next.ball.x).toBeCloseTo(2 * 147 - 148.01, 10);
    const left = s5Game.step(makeState({ ball: { x: 4, y: 110, vx: -2, vy: -2.2 } }), IDLE);
    expect(left.ball.vx).toBeCloseTo(2, 10);
    expect(left.ball.x).toBeCloseTo(2 * 3 - 2, 10);
  });

  it('3d. 旋是看得到的差別：同樣的擊球位置，全速滑著打與站穩打，球抵達對方那條線時差 20 像素以上', () => {
    const arrive = (paddleVx: number): number => {
      const keys: Inputs = paddleVx > 0 ? RIGHT : paddleVx < 0 ? LEFT : IDLE;
      const s = makeState({
        // 板子這個 tick 移動之後在 75 + paddleVx，球正好落在那裡（o = 0）
        ball: { x: 75 + paddleVx, y: 209, vx: 0, vy: 2.2, lastHit: 1 },
        paddles: [{ x: 75, vx: paddleVx, target: paddleVx }, { x: 75 }],
      });
      const hit = s5Game.step(s, keys).ball;
      expect(hit.lastHit).toBe(0);
      const arrival = predictArrival(hit, 1);
      expect(arrival).not.toBeNull();
      return (arrival as { x: number }).x;
    };
    const still = arrive(0);
    expect(Math.abs(arrive(2.4) - still)).toBeGreaterThan(20);
    expect(Math.abs(arrive(-2.4) - still)).toBeGreaterThan(20);
    expect(arrive(2.4) - still).toBeGreaterThan(0);
    expect(arrive(-2.4) - still).toBeLessThan(0);
  });

  it('4. 每次擊球加速 0.35、上限 6.5', () => {
    const speedAfter = (hits: number): number => {
      const ball = s5Game.step(atLine(0, { hits }), IDLE).ball;
      return Math.hypot(ball.vx, ball.vy);
    };
    expect(speedAfter(0)).toBeCloseTo(2.55, 8);
    expect(speedAfter(5)).toBeCloseTo(4.3, 8);
    expect(speedAfter(11)).toBeCloseTo(6.4, 8);
    expect(speedAfter(12)).toBeCloseTo(6.5, 8);
    expect(speedAfter(40)).toBeCloseTo(6.5, 8);
  });

  it('5. 掃掠判定：一個 tick 跨過整塊板子（速度 6，板厚 4）也算擊中，不會穿透', () => {
    const fast = makeState({
      ball: { x: 75, y: 207, vx: 0, vy: 6, lastHit: 1, hits: 15 },
      paddles: [{ x: 75 }, { x: 75 }],
    });
    expect(s5Game.step(fast, IDLE).ball.lastHit).toBe(0);
    const exact = makeState({
      ball: { x: 75, y: 204, vx: 0, vy: 6, lastHit: 1 },
      paddles: [{ x: 75 }, { x: 75 }],
    });
    expect(s5Game.step(exact, IDLE).ball.lastHit).toBe(0);
    // 還沒到線：不算
    const before = makeState({
      ball: { x: 75, y: 203, vx: 0, vy: 6, lastHit: 1 },
      paddles: [{ x: 75 }, { x: 75 }],
    });
    expect(s5Game.step(before, IDLE).ball.lastHit).toBe(1);
  });

  it('5b. 擊球位置用的是這個 tick 移動之後的板子（板子往球的方向滑，球就接得到）', () => {
    const s = makeState({
      ball: { x: 95.3, y: 209, vx: 0, vy: 2.2, lastHit: 1 },
      paddles: [{ x: 75, vx: 2.4, target: 2.4 }, {}],
    });
    // 繼續按右：板子到 77.4，距離 17.9，擊中；放開：只到 77.1，距離 18.2，沒接到
    expect(s5Game.step(s, RIGHT).ball.lastHit).toBe(0);
    expect(s5Game.step(s, IDLE).ball.lastHit).toBe(1);
  });
});

describe('S-5 乒乓｜得分、發球與結束', () => {
  it('6. 一球最長 1200 tick：作廢，不計分、同一邊重發', () => {
    const s = makeState({ rallyTicks: 1199, server: 1, points: [2, 3] });
    const voided = s5Game.step(s, IDLE);
    expect(voided.phase).toBe('dead');
    expect(voided.points).toEqual([2, 3]);
    expect(voided.server).toBe(1);
    const served = run(voided, 30 + 45, IDLE);
    expect(served.phase).toBe('play');
    expect(served.ball.hits).toBe(0);
    expect(served.points).toEqual([2, 3]);
    expect(Math.hypot(served.ball.vx, served.ball.vy)).toBeCloseTo(2.2, 10);
    // 差一 tick 還沒作廢
    expect(s5Game.step(makeState({ rallyTicks: 1198 }), IDLE).phase).toBe('play');
  });

  it('7a. 沒接到：球穿過底線，對方得 1 分；habit 記下球抵達那條線的 x；停頓 30 tick、發球前 45 tick 球不動', () => {
    const miss = makeState({
      ball: { x: 20, y: 209, vx: 0, vy: 2.2, lastHit: 1 },
      paddles: [{ x: 135 }, { x: 75 }],
      server: 0,
    });
    const lost = until(miss, notPlaying);
    expect(lost.phase).toBe('dead');
    expect(lost.points).toEqual([0, 1]);
    expect(lost.habit[1]).toEqual([20]);
    expect(lost.phaseLeft).toBe(30);
    expect(lost.server).toBe(1);
    const afterDead = run(lost, 30);
    expect(afterDead.phase).toBe('serve');
    expect(afterDead.phaseLeft).toBe(45);
    expect(afterDead.ball).toMatchObject({ x: 75, y: 110, vx: 0, vy: 0, hits: 0, lastHit: null });
    const mid = run(afterDead, 44);
    expect(mid.phase).toBe('serve');
    expect(mid.ball.x).toBe(75);
    const play = s5Game.step(mid, IDLE);
    expect(play.phase).toBe('play');
    // 1 號邊發球，朝接球的 0 號邊（往下）、角度在 ±20° 內、球速 2.2
    expect(play.ball.vy).toBeGreaterThan(0);
    expect(Math.abs(Math.atan(play.ball.vx / play.ball.vy))).toBeLessThanOrEqual(20 * DEG + 1e-9);
    expect(Math.hypot(play.ball.vx, play.ball.vy)).toBeCloseTo(2.2, 10);
  });

  it('7b. 1 號邊沒接到：0 號邊得分；發球方每分輪流', () => {
    const miss = makeState({
      ball: { x: 20, y: 11, vx: 0, vy: -2.2, lastHit: 0 },
      paddles: [{ x: 75 }, { x: 135 }],
      server: 1,
    });
    const lost = until(miss, notPlaying);
    expect(lost.points).toEqual([1, 0]);
    expect(lost.habit[0]).toEqual([20]);
    expect(lost.server).toBe(0);
  });

  it('7c. 擊中也記 habit：記的是球抵達那條線的 x，新的在後面，最多 5 個', () => {
    const s = makeState({
      ball: { x: 84, y: 209, vx: 0, vy: 2.2, lastHit: 1 },
      paddles: [{ x: 75 }, { x: 75 }],
      habit: [[], [1, 2, 3, 4, 5]],
    });
    expect(s5Game.step(s, IDLE).habit[1]).toEqual([2, 3, 4, 5, 84]);
    // 發球不記
    const serve = makeState({ ball: { x: 84, y: 209, vx: 0, vy: 2.2, lastHit: null } });
    expect(s5Game.step(serve, IDLE).habit).toEqual([[], []]);
  });

  it('7d. 先得 target 分結束：6 分；結束後 step 原樣回傳；贏家與分數', () => {
    const last = makeState({
      points: [5, 2],
      ball: { x: 20, y: 11, vx: 0, vy: -2.2, lastHit: 0 },
      paddles: [{ x: 75 }, { x: 135 }],
    });
    const done = until(last, notPlaying);
    expect(done.phase).toBe('over');
    expect(s5Game.isOver(done)).toBe(true);
    expect(s5Game.score(done)).toEqual([6, 2]);
    expect(s5Game.winner(done)).toBe(0);
    expect(s5Game.step(done, IDLE)).toBe(done);
    expect(s5Game.isOver(makeState({ points: [5, 5] }))).toBe(false);
  });

  it('7e. params.target 可以改（S-K 的決勝段用 3 分）；預設 6；不合理的值丟 RangeError', () => {
    expect(s5Game.init(0, CONFIG).target).toBe(6);
    expect(s5Game.init(0, { maxTicks: 1500, params: { target: 3 } }).target).toBe(3);
    expect(() => s5Game.init(0, { maxTicks: 1500, params: { target: 0 } })).toThrow(RangeError);
    expect(() => s5Game.init(0, { maxTicks: 1500, params: { target: 2.5 } })).toThrow(RangeError);
    const last = makeState({
      target: 3,
      points: [2, 0],
      ball: { x: 20, y: 11, vx: 0, vy: -2.2, lastHit: 0 },
      paddles: [{ x: 75 }, { x: 135 }],
    });
    expect(until(last, notPlaying).phase).toBe('over');
  });

  it('7f. 時間到：分數高的贏、同分平手；maxTicks 小於 600 丟 RangeError', () => {
    const end = (points: [number, number]): S5State =>
      s5Game.step(makeState({ tick: 5399, points }), IDLE);
    const a = end([3, 2]);
    expect(s5Game.isOver(a)).toBe(true);
    expect(s5Game.winner(a)).toBe(0);
    expect(s5Game.winner(end([1, 4]))).toBe(1);
    expect(s5Game.winner(end([2, 2]))).toBeNull();
    expect(s5Game.winner(makeState({ tick: 100, points: [5, 0] }))).toBeNull();
    expect(() => s5Game.init(0, { maxTicks: 599, params: {} })).toThrow(RangeError);
    expect(s5Game.init(0, { maxTicks: 600, params: {} }).maxTicks).toBe(600);
  });

  it('7g. 初始局面：板子在 x = 75、0 比 0、先發球 45 tick；第一個發球方由種子的奇偶決定', () => {
    const s = s5Game.init(4, CONFIG);
    expect(s.phase).toBe('serve');
    expect(s.phaseLeft).toBe(45);
    expect(s.points).toEqual([0, 0]);
    expect(s.paddles.map((p) => p.x)).toEqual([75, 75]);
    expect(s.ball).toMatchObject({ x: 75, y: 110, hits: 0, lastHit: null });
    expect(s5Game.init(4, CONFIG).server).toBe(0);
    expect(s5Game.init(5, CONFIG).server).toBe(1);
    expect(s5Game.init(-3, CONFIG).server).toBe(1);
    expect(s5Game.score(s)).toEqual([0, 0]);
  });

  it('10. 發球角度由種子決定：種子 0..9 不全相同；同一場連續兩次發球不同', () => {
    const launch = (seed: number): number => {
      const s = run(s5Game.init(seed, CONFIG), 45);
      return s.ball.vx;
    };
    const angles = Array.from({ length: 10 }, (_, seed) => launch(seed));
    expect(new Set(angles).size).toBeGreaterThan(5);
    const first = run(s5Game.init(3, CONFIG), 45);
    const second = run(
      { ...first, phase: 'dead', phaseLeft: 1, ball: { ...first.ball, y: 225 } },
      1 + 45,
    );
    expect(second.ball.vx).not.toBe(first.ball.vx);
    expect(second.rng).not.toBe(first.rng);
    expect(first.rng).not.toBe(s5Game.init(3, CONFIG).rng);
  });

  it('10b. 同一個種子永遠同樣的發球', () => {
    expect(run(s5Game.init(7, CONFIG), 45).ball).toEqual(run(s5Game.init(7, CONFIG), 45).ball);
  });

  it('11. step 不改動傳進來的 state（凍結也能 step），JSON 來回不變', () => {
    const deep = (o: unknown): void => {
      if (typeof o === 'object' && o !== null) {
        Object.freeze(o);
        Object.values(o).forEach(deep);
      }
    };
    const s = makeState({ ball: { x: 50, y: 100, vx: 1, vy: -2, spin: 0.01 }, habit: [[1], [2]] });
    deep(s);
    expect(() => s5Game.step(s, RIGHT)).not.toThrow();
    const next = s5Game.step(s, RIGHT);
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
    const served = s5Game.init(1, CONFIG);
    deep(served);
    expect(() => run(served, 50)).not.toThrow();
  });

  it('12. 尾跡：每 2 tick 取一次球的位置，最多 10 個，發球時清空', () => {
    const flying = run(makeState({ ball: { x: 75, y: 150, vx: 0, vy: -2.2 } }), 40);
    expect(flying.trail.length).toBe(10);
    const early = run(makeState({ ball: { x: 75, y: 150, vx: 0, vy: -2.2 } }), 4);
    expect(early.trail.length).toBe(2);
    const dead = until(
      makeState({
        ball: { x: 20, y: 11, vx: 0, vy: -2.2, lastHit: 0 },
        paddles: [{ x: 75 }, { x: 135 }],
        trail: [[1, 1]],
      }),
      notPlaying,
    );
    const serving = run(dead, 30);
    expect(serving.phase).toBe('serve');
    expect(serving.trail).toEqual([]);
  });
});

describe('S-5 乒乓｜預測用的精確物理', () => {
  it('13. predictArrival 與真的 step 一致：含旋、側牆反彈，球抵達那條線的 tick 與 x 完全相同', () => {
    const cases = [
      { x: 75, y: 110, vx: 0, vy: 2.2, spin: 0 },
      { x: 40, y: 60, vx: 1.7, vy: 3.1, spin: 0.0192 },
      { x: 130, y: 150, vx: 2.4, vy: 3.5, spin: -0.0192 },
      { x: 10, y: 190, vx: -3, vy: -2.6, spin: 0.01 },
      { x: 100, y: 30, vx: -2.9, vy: 4.4, spin: 0.015 },
    ];
    for (const c of cases) {
      for (const side of [0, 1] as const) {
        const vy = side === 0 ? Math.abs(c.vy) : -Math.abs(c.vy);
        const ball = { ...c, vy, hits: 3, lastHit: null };
        const predicted = predictArrival(ball, side);
        expect(predicted).not.toBeNull();
        // 用板子站得很遠（沒接到）真的跑一遍，看 habit 記下的 x 與 tick
        let s = makeState({
          ball: { ...ball, lastHit: side === 0 ? 1 : 0 },
          paddles: [{ x: side === 0 ? 135 : 15 }, { x: side === 0 ? 15 : 135 }],
        });
        // 球可能剛好落在板子旁；把兩塊板子移到最遠的那一邊以外不可能，所以改成直接比對 habit
        // 只在沒接到時成立：挑板子離到達點最遠的一側
        const arrivalX = (predicted as { x: number }).x;
        const far = arrivalX > 75 ? 15 : 135;
        s = {
          ...s,
          paddles: [
            { x: far, vx: 0, target: 0 },
            { x: far, vx: 0, target: 0 },
          ],
        };
        let ticks = 0;
        const owner = side === 0 ? 1 : 0;
        while (s.habit[owner].length === 0 && ticks < 400) {
          s = s5Game.step(s, IDLE);
          ticks += 1;
        }
        expect(ticks).toBe((predicted as { ticks: number }).ticks);
        expect(s.habit[owner][0]).toBeCloseTo(arrivalX, 9);
      }
    }
  });

  it('13b. 球已經在線外或不動：預測回 null', () => {
    expect(
      predictArrival({ x: 75, y: 215, vx: 0, vy: 2, spin: 0, hits: 1, lastHit: 1 }, 0),
    ).toBeNull();
    expect(
      predictArrival({ x: 75, y: 110, vx: 0, vy: 0, spin: 0, hits: 0, lastHit: null }, 0),
    ).toBeNull();
    expect(
      predictArrival({ x: 75, y: 110, vx: 0, vy: -2, spin: 0, hits: 1, lastHit: 0 }, 0),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AI 的選擇
// ---------------------------------------------------------------------------

type Name = 'precise' | 'greedy' | 'gambler' | 'pathfinder';
const decide = (
  name: Name,
  s: S5State,
  side: Side,
  depth = 1,
  game: Game<S5State> = s5Game,
): Buttons => policyByName(name).decide(game, s, side, 0, { depth, seed: 1 });

/** 球朝 1 號邊（AI）飛來的局面。 */
const incoming = (ballX: number, aiX: number, extra = {}): S5State =>
  makeState({
    ball: { x: ballX, y: 80, vx: 0, vy: -3, lastHit: 0, hits: 4, ...extra },
    paddles: [{ x: 75 }, { x: aiX }],
  });

describe('S-5 乒乓｜AI 的選擇', () => {
  it('A. 球飛向我：往球的方向走（球在右邊，往右；在左邊，往左）', () => {
    expect(decide('precise', incoming(125, 75), 1).right).toBe(true);
    expect(decide('precise', incoming(25, 75), 1).left).toBe(true);
    expect(decide('greedy', incoming(125, 75), 1).right).toBe(true);
  });

  it('B. 會瞄準：球飛向我、我能選擊球位置時，把球打向離對手遠的那一側（對手在右，球往左；對手在左，球往右）', () => {
    const play = (humanX: number): S5State => {
      let s = makeState({
        ball: { x: 75, y: 120, vx: 0, vy: -3, lastHit: 0, hits: 4 },
        paddles: [{ x: humanX }, { x: 75 }],
      });
      for (let i = 0; i < 80 && s.ball.lastHit !== 1; i += 1) {
        s = s5Game.step(s, [NONE, decide('precise', s, 1)]);
      }
      return s;
    };
    const awayFromRight = play(135);
    expect(awayFromRight.ball.lastHit).toBe(1);
    expect(awayFromRight.ball.vx).toBeLessThan(-0.5);
    const awayFromLeft = play(15);
    expect(awayFromLeft.ball.lastHit).toBe(1);
    expect(awayFromLeft.ball.vx).toBeGreaterThan(0.5);
  });

  it('C. 接不到的球也全力追：球離板子 40 像素、只剩 11 tick，精準型往球的方向', () => {
    const s = incoming(115, 75, { y: 70, vy: -5.6 });
    expect(decide('precise', s, 1).right).toBe(true);
  });

  it('9a. 讀習慣（剝削）：對手最近都打右邊時，球飛向對手期間 AI 靠近右邊的 gain 嚴格較大', () => {
    const toward = (aiX: number, habit: number[]): number =>
      s5Game.evaluate(
        makeState({
          ball: { x: 75, y: 120, vx: 0, vy: 3, lastHit: 1, hits: 3 },
          paddles: [{ x: 75 }, { x: aiX }],
          habit: [habit, []],
        }),
        1,
      ).gain;
    // 「球飛向對手」：對 1 號邊來說，球往下（vy > 0）。
    const right = [120, 120, 120, 120, 120];
    expect(toward(100, right)).toBeGreaterThan(toward(50, right));
    expect(toward(100, right)).toBeGreaterThan(toward(75, right));
    const left = [30, 30, 30, 30, 30];
    expect(toward(50, left)).toBeGreaterThan(toward(100, left));
  });

  it('9b. 冷啟動：habit 是中央散開（或沒有）時沒有偏好，左右對稱的位置 gain 相同', () => {
    const toward = (aiX: number, habit: number[]): number =>
      s5Game.evaluate(
        makeState({
          ball: { x: 75, y: 120, vx: 0, vy: 3, lastHit: 1, hits: 3 },
          paddles: [{ x: 75 }, { x: aiX }],
          habit: [habit, []],
        }),
        1,
      ).gain;
    for (const habit of [[], [30, 120, 40, 110, 75]]) {
      expect(toward(100, habit)).toBeCloseTo(toward(50, habit), 9);
    }
    expect(toward(75, [])).toBeGreaterThan(toward(100, []));
  });

  it('9c. 關掉讀習慣的 AI（createS5Game({ readHabit: false }）：habit 再整齊也沒有偏好', () => {
    const blind = createS5Game({ readHabit: false });
    const toward = (aiX: number): number =>
      blind.evaluate(
        makeState({
          ball: { x: 75, y: 120, vx: 0, vy: 3, lastHit: 1, hits: 3 },
          paddles: [{ x: 75 }, { x: aiX }],
          habit: [[120, 120, 120, 120, 120], []],
        }),
        1,
      ).gain;
    expect(toward(100)).toBeCloseTo(toward(50), 9);
  });

  it('9d. 把握從歷史來：越整齊越敢歪，歪的方向是對手習慣的方向，最多 0.8 的把握', () => {
    expect(guessReturn([]).conf).toBeCloseTo(0, 9);
    expect(guessReturn([]).x).toBe(75);
    const one = guessReturn([120]);
    const five = guessReturn([120, 120, 120, 120, 120]);
    expect(five.conf).toBeGreaterThan(one.conf);
    expect(five.x).toBeGreaterThan(one.x);
    expect(one.x).toBeGreaterThan(75);
    expect(five.conf).toBeLessThanOrEqual(0.8);
    expect(guessReturn([120, 30, 120, 30, 120]).conf).toBeLessThan(five.conf);
    expect(guessReturn([30, 30, 30, 30, 30]).x).toBeLessThan(75);
    const spread = guessReturn([30, 120, 40, 110, 75]);
    expect(spread.x).toBeCloseTo(75, 6);
  });

  it('9e. 精準型有把握才歪、貪心型一有習慣就歪：habit 整齊時兩者都往習慣那側走，habit 沒有時精準型不動', () => {
    const waiting = (habit: number[]): S5State =>
      makeState({
        ball: { x: 75, y: 120, vx: 0, vy: 3, lastHit: 1, hits: 3 },
        paddles: [{ x: 75 }, { x: 75 }],
        habit: [habit, []],
      });
    const lean = decide('precise', waiting([130, 130, 130, 130, 130]), 1);
    expect(lean.right).toBe(true);
    const calm = decide('precise', waiting([]), 1);
    expect(calm.left || calm.right).toBe(false);
    expect(decide('greedy', waiting([130, 130, 130, 130, 130]), 1).right).toBe(true);
  });

  it('D. 慣性是真的：同一個球（還有 25 tick、在右邊遠處），靜止的板子接得到，往左衝的板子先要煞車所以來不及', () => {
    const ball = { x: 140, y: 150, vx: 0, vy: -5.6, lastHit: 0 as Side, hits: 14 };
    const chase = (aiVx: number): boolean => {
      let s = makeState({ ball, paddles: [{ x: 75 }, { x: 90, vx: aiVx, target: aiVx }] });
      for (let i = 0; i < 40 && s.ball.lastHit !== 1 && s.phase === 'play'; i += 1) {
        s = s5Game.step(s, [NONE, press({ right: true })]);
      }
      return s.ball.lastHit === 1;
    };
    expect(chase(0)).toBe(true);
    expect(chase(-2.4)).toBe(false);
  });

  it('E. 沒有橡皮筋：兩邊分數歸零前後，evaluate 只差 1000 × 分差，actions 與選擇完全相同', () => {
    const base = makeState({
      ball: { x: 110, y: 90, vx: 0.5, vy: -3.3, lastHit: 0, hits: 5 },
      paddles: [
        { x: 60, vx: 1, target: 2.4 },
        { x: 80, vx: -1, target: -2.4 },
      ],
      habit: [
        [100, 110, 120],
        [40, 60],
      ],
    });
    for (const points of [
      [0, 0],
      [4, 1],
      [1, 4],
      [5, 5],
    ] as const) {
      const s = { ...base, points: [...points] as [number, number] };
      for (const side of [0, 1] as const) {
        const e0 = s5Game.evaluate(base, side);
        const e = s5Game.evaluate(s, side);
        const lead = side === 0 ? points[0] - points[1] : points[1] - points[0];
        expect(e.gain - e0.gain).toBeCloseTo(1000 * lead, 8);
        expect(e.danger).toBe(e0.danger);
        expect(s5Game.actions(s, side)).toEqual(s5Game.actions(base, side));
      }
      // 賭徒型的「落後多冒險」是 src/ai 的性格自己的，不是這張牌加的，所以不在這裡比
      for (const name of ['precise', 'greedy', 'pathfinder'] as const) {
        expect(decide(name, s, 1), `${name} ${points.join(':')}`).toEqual(decide(name, base, 1));
      }
    }
  });

  it('F. actions：兩邊都是 6 個，全放開排第一', () => {
    const s = makeState({});
    for (const side of [0, 1] as const) {
      const actions = s5Game.actions(s, side);
      expect(actions).toHaveLength(6);
      expect(actions[0]).toEqual(NONE);
    }
  });

  it('G. 對稱：把局面上下翻過來、兩邊對調，evaluate 的數字完全相同（K12 的基礎）', () => {
    const mirror = (s: S5State): S5State => ({
      ...s,
      server: s.server === 0 ? 1 : 0,
      points: [s.points[1], s.points[0]],
      paddles: [s.paddles[1], s.paddles[0]],
      habit: [s.habit[1], s.habit[0]],
      ball: {
        ...s.ball,
        y: 220 - s.ball.y,
        vy: -s.ball.vy,
        lastHit: s.ball.lastHit === null ? null : s.ball.lastHit === 0 ? 1 : 0,
      },
    });
    const rng = createRng(11);
    for (let i = 0; i < 40; i += 1) {
      const toward = rng.int(2) === 0 ? 1 : -1;
      const s = makeState({
        ball: {
          x: 10 + rng.next() * 130,
          y: 20 + rng.next() * 170,
          vx: (rng.next() - 0.5) * 5,
          vy: toward * (1.5 + rng.next() * 4),
          spin: (rng.next() - 0.5) * 0.04,
          hits: rng.int(12),
          lastHit: toward === 1 ? 1 : 0,
        },
        paddles: [
          {
            x: 15 + rng.next() * 120,
            vx: (rng.next() - 0.5) * 4.8,
            target: [0, 2.4, -2.4, 1, -1][rng.int(5)],
          },
          {
            x: 15 + rng.next() * 120,
            vx: (rng.next() - 0.5) * 4.8,
            target: [0, 2.4, -2.4, 1, -1][rng.int(5)],
          },
        ],
        habit: [
          Array.from({ length: rng.int(6) }, () => rng.next() * 150),
          Array.from({ length: rng.int(6) }, () => rng.next() * 150),
        ],
        points: [rng.int(6), rng.int(6)],
      });
      const m = mirror(s);
      for (const side of [0, 1] as const) {
        const a = s5Game.evaluate(s, side);
        const b = s5Game.evaluate(m, side === 0 ? 1 : 0);
        expect(b.gain).toBeCloseTo(a.gain, 9);
        expect(b.danger).toBeCloseTo(a.danger, 9);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// decide 層盲測：AI 不可以偷看它不該看的東西
// ---------------------------------------------------------------------------

/**
 * 它不該看的東西（state 裡有、但人看不到或還沒發生的）：
 * - `rng`：下一次發球的角度（未來）；
 * - `trail`：只給畫面用；
 * - 對手板子的 `target`：對手「正按著什麼鍵」，人只看得到板子的位置與速度。
 * 自己的 `target` 是自己按的鍵，可以看（模擬一步之後，它就是候選動作的結果）。
 *
 * 做法：同一個局面，只改這些欄位，四個性格 × depth 1／3／6 的 `decide` 必須完全一樣。
 * 為了確定這個測試測得出來，另外把「偷看」的 evaluate 注入進去，它必須被抓到。
 */
const NAMES: readonly Name[] = ['precise', 'greedy', 'gambler', 'pathfinder'];
const DEPTHS = [1, 3, 6] as const;

function snapshots(): S5State[] {
  const out: S5State[] = [];
  const rng = createRng(2024);
  for (const seed of [1, 2]) {
    let s = s5Game.init(seed, CONFIG);
    for (let t = 0; t < 1400 && !s5Game.isOver(s); t += 1) {
      if (t % 29 === 0) {
        out.push(s);
      }
      const pick = (): Buttons => s5Game.actions(s, 0)[rng.int(6)] as Buttons;
      // 比較有看頭的輸入：兩邊各自長按一陣子再換
      s = s5Game.step(
        s,
        t % 40 < 20
          ? [pick(), pick()]
          : [s5Game.actions(s, 0)[2] as Buttons, s5Game.actions(s, 1)[1] as Buttons],
      );
    }
  }
  return out;
}

/** 隱藏欄位換成別的值：`side` 這一邊看不到的（rng、trail、對手的按鍵）。 */
function scramble(s: S5State, side: Side, n: number): S5State {
  const opp = side === 0 ? 1 : 0;
  const theirs = s.paddles[opp];
  const flipped = theirs.target === 0 ? (n % 2 === 0 ? 2.4 : -2.4) : -theirs.target;
  const paddles: [S5State['paddles'][0], S5State['paddles'][1]] = [s.paddles[0], s.paddles[1]];
  paddles[opp] = { ...theirs, target: flipped };
  return {
    ...s,
    rng: (s.rng + 977 * (n + 1)) >>> 0,
    trail: [
      [1, 2],
      [3, 4],
    ],
    paddles,
  };
}

interface Leak {
  readonly name: Name;
  readonly depth: number;
  readonly phase: S5State['phase'];
  readonly phaseLeft: number;
}

/** 哪些（局面、邊、性格、depth）的 decide 因為隱藏欄位改變而不同。 */
function findLeaks(game: Game<S5State>, states: readonly S5State[]): Leak[] {
  const leaks: Leak[] = [];
  for (const s of states) {
    for (const side of [0, 1] as const) {
      for (const name of NAMES) {
        for (const depth of DEPTHS) {
          const seen = decide(name, s, side, depth, game);
          const scrambled = decide(name, scramble(s, side, 1 + depth), side, depth, game);
          if (JSON.stringify(seen) !== JSON.stringify(scrambled)) {
            leaks.push({ name, depth, phase: s.phase, phaseLeft: s.phaseLeft });
          }
        }
      }
    }
  }
  return leaks;
}

/**
 * 唯一已知、而且無害的管道：性格是用 `step` 往前模擬的，而 `step` 在發球那一刻會用掉 `rng`。
 * 所以搜尋型 depth = d 在發球倒數的最後 d 個 tick 裡，模擬得到「球之後會往哪裡飛」。
 * 這是框架的限制（state 裡有亂數、性格只能用 `step`），最多 6 個 tick（0.1 秒），
 * 而且發球之後球還要飛 40 個 tick 以上才到板子；`evaluate` 本身從來不讀 `rng`。
 */
const inLaunchTail = (leak: Leak): boolean =>
  leak.phase === 'serve' && leak.phaseLeft <= leak.depth;

/** 偷看 rng 與對手按鍵的 evaluate：把它們換成 gain 的一項，足以改變選擇。 */
function leaky(peek: 'rng' | 'opponent'): Game<S5State> {
  return {
    ...s5Game,
    evaluate(s: S5State, side: Side) {
      const base = s5Game.evaluate(s, side);
      const me = s.paddles[side];
      const opp = s.paddles[side === 0 ? 1 : 0];
      const bias = peek === 'rng' ? ((s.rng % 7) - 3) * 30 : opp.target * 30;
      return { gain: base.gain + bias * ((me.x - 75) / 60), danger: base.danger };
    },
  };
}

describe('S-5 乒乓｜decide 層盲測', () => {
  const states = snapshots();

  it('取樣到的局面涵蓋發球、飛行、停頓三種階段，兩邊的板子都有在動', () => {
    expect(new Set(states.map((s) => s.phase))).toEqual(new Set(['serve', 'play', 'dead']));
    expect(states.length).toBeGreaterThan(40);
    expect(states.some((s) => s.paddles[1].target !== 0)).toBe(true);
  });

  it('真的遊戲：只改 rng、trail、對手按鍵，四個性格 × depth 1／3／6 的 decide 完全不變（發球倒數最後 depth 個 tick 的模擬除外，見上）', () => {
    const leaks = findLeaks(s5Game, states);
    expect(leaks.filter((leak) => !inLaunchTail(leak))).toEqual([]);
    // 例外只可能是搜尋型：其他三個性格只看一步
    expect(leaks.filter((leak) => leak.name !== 'pathfinder')).toEqual([]);
  });

  it('把偷看 rng 的 evaluate 注入進去：測試抓得到', () => {
    expect(findLeaks(leaky('rng'), states).filter((l) => !inLaunchTail(l)).length).toBeGreaterThan(
      0,
    );
  });

  it('把偷看對手按鍵的 evaluate 注入進去：測試抓得到', () => {
    expect(
      findLeaks(leaky('opponent'), states).filter((l) => !inLaunchTail(l)).length,
    ).toBeGreaterThan(0);
  });
});
