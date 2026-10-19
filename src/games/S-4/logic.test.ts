import { describe, expect, it } from 'vitest';

import { deepFreeze } from '../../../tests/contract/freeze';
import type { Buttons, Inputs, Side } from '../../core/types';
import {
  BALL_SPEED,
  BRICK_COUNT,
  CONTACT_Y,
  DEFAULT_MAX_TICKS,
  MAX_ANGLE,
  MISS_PENALTY,
  PADDLE_REACH,
  PADDLE_SLOW,
  PADDLE_V,
  RESPAWN_TICKS,
  SERVE_ANGLE,
  blast,
  makeState,
  s4Game,
} from './logic';
import type { S4Ball, S4State } from './logic';

/**
 * S-4 打磚塊對決的規則測試（小規格 `docs/cards/S-4.md`）。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 0 號邊是人（下緣，板子 y = 212）、1 號邊是 AI（上緣，板子 y = 8）；磚的編號是 `列 × 10 + 欄`，
 * 第 0 列在最上面（y 89 到 96）、第 5 列在最下面（y 124 到 131），第 `c` 欄的 x 範圍是 `[15c, 15c + 15]`。
 *
 * 座標心算備忘：
 *  - 人的球碰板子：球心 y 從 < 208 走到 ≥ 208；AI：從 > 12 走到 ≤ 12。板子寬 28，球半徑 2，所以球心離板心 ≤ 16 算接到。
 *  - 球碰磚：球心到磚（矩形）最近點的距離嚴格小於 2 才算碰到。
 *  - 一塊磚被敲掉，球的主人得 1 分；炸彈磚連同周圍 8 格（連鎖也算）一起消失，全部算球的主人。
 *  - 球屬於「發球的那一邊」的格子：球穿過某一邊的底線，那一邊扣 2 分，45 tick 後這顆球從它自己那一邊的板子重發。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const press = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const IDLE: Inputs = [NONE, NONE];
const CONFIG = { maxTicks: 3600, params: {} };
const DEG = Math.PI / 180;

/** 一顆正在飛的球。 */
function live(x: number, y: number, vx: number, vy: number, owner: Side): Partial<S4Ball> {
  return { x, y, vx, vy, owner, respawn: 0 };
}
/** 停放的球：還要 500 tick 才會發出來，測試期間不參與任何事。 */
const PARK: Partial<S4Ball> = { respawn: 500 };

function run(state: S4State, count: number, inputs: Inputs = IDLE): S4State {
  let s = state;
  for (let i = 0; i < count; i += 1) {
    s = s4Game.step(s, inputs);
  }
  return s;
}

function dead(state: S4State): number[] {
  return state.bricks.flatMap((v, i) => (v === 1 ? [i] : []));
}

/** 某一欄整欄的 6 塊磚的編號。 */
const column = (c: number): number[] => [0, 1, 2, 3, 4, 5].map((r) => r * 10 + c);

/** 球正好在 0 號邊板子前一格（y 207，每 tick 往下 2），下一個 tick 會被判定。板子在 75。 */
const atHumanLine = (x: number, extra: Partial<S4Ball> = {}, paddleX = 75): S4State =>
  makeState({
    balls: [{ ...live(x, 207, 0, 2, 1), ...extra }, PARK],
    paddles: [{ x: paddleX }, {}],
  });

describe('S-4 打磚塊對決｜初始', () => {
  it('開局：tick 0、牆 60 塊都在、4 顆炸彈、兩塊板子在 75 不動、分數 0 比 0、兩顆球已經從各自的板子發出（速度 2、朝牆）', () => {
    const s = s4Game.init(0, CONFIG);
    expect(s.tick).toBe(0);
    expect(s.bricks).toHaveLength(BRICK_COUNT);
    expect(s.bricks.every((v) => v === 0)).toBe(true);
    expect(s.bombs).toHaveLength(4);
    expect(s.paddles[0]).toEqual({ x: 75, v: 0 });
    expect(s.paddles[1]).toEqual({ x: 75, v: 0 });
    expect(s.score).toEqual([0, 0]);
    const [a, b] = s.balls;
    expect([a.x, a.y, a.owner, a.respawn]).toEqual([75, CONTACT_Y[0], 0, 0]);
    expect([b.x, b.y, b.owner, b.respawn]).toEqual([75, CONTACT_Y[1], 1, 0]);
    expect(a.vy).toBeLessThan(0);
    expect(b.vy).toBeGreaterThan(0);
    expect(Math.hypot(a.vx, a.vy)).toBeCloseTo(BALL_SPEED, 10);
    expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(BALL_SPEED, 10);
    // 轉 180 度對稱：另一顆球的水平速度正好相反
    expect(b.vx).toBeCloseTo(-a.vx, 12);
    expect(Math.abs(a.vx)).toBeLessThanOrEqual(BALL_SPEED * Math.sin(SERVE_ANGLE) + 1e-12);
  });

  it('炸彈：4 顆互不相同，都在中間兩列（編號 20 到 39）；整面牆轉 180 度對稱（炸彈 i 的另一邊是 59 − i），種子 0 到 99', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const { bombs } = s4Game.init(seed, CONFIG);
      expect(new Set(bombs).size).toBe(4);
      for (const i of bombs) {
        expect(i).toBeGreaterThanOrEqual(20);
        expect(i).toBeLessThanOrEqual(39);
        expect(bombs).toContain(59 - i);
      }
    }
  });

  it('炸彈位置與發球角度由種子決定：種子 0 到 9 不全相同；同一個種子 init 兩次完全相同', () => {
    const states = Array.from({ length: 10 }, (_v, seed) => s4Game.init(seed, CONFIG));
    expect(
      new Set(states.map((s) => [...s.bombs].sort((a, b) => a - b).join(','))).size,
    ).toBeGreaterThan(1);
    expect(new Set(states.map((s) => s.balls[0].vx)).size).toBeGreaterThan(1);
    expect(s4Game.init(7, CONFIG)).toEqual(s4Game.init(7, CONFIG));
  });

  it('maxTicks：比 3000 短就用短的、比 3000 長還是 3000；小於 600 丟 RangeError（600 可以）', () => {
    expect(s4Game.init(0, { maxTicks: 3600, params: {} }).maxTicks).toBe(DEFAULT_MAX_TICKS);
    expect(DEFAULT_MAX_TICKS).toBe(3000);
    expect(s4Game.init(0, { maxTicks: 1000, params: {} }).maxTicks).toBe(1000);
    expect(s4Game.init(0, { maxTicks: 600, params: {} }).maxTicks).toBe(600);
    expect(() => s4Game.init(0, { maxTicks: 599, params: {} })).toThrow(RangeError);
    expect(() => s4Game.init(0, { maxTicks: Number.NaN, params: {} })).toThrow(RangeError);
  });
});

describe('S-4 打磚塊對決｜板子', () => {
  it('沒有慣性：按右每 tick 走 2.4、按左 −2.4、按住 a 慢速 1.0；速度記在 v', () => {
    const s = makeState({});
    expect(s4Game.step(s, [press({ right: true }), NONE]).paddles[0]).toEqual({ x: 77.4, v: 2.4 });
    expect(s4Game.step(s, [press({ left: true }), NONE]).paddles[0]).toEqual({ x: 72.6, v: -2.4 });
    expect(s4Game.step(s, [press({ right: true, a: true }), NONE]).paddles[0]).toEqual({
      x: 76,
      v: PADDLE_SLOW,
    });
    expect(s4Game.step(s, [press({ left: true, a: true }), NONE]).paddles[0]).toEqual({
      x: 74,
      v: -PADDLE_SLOW,
    });
    expect(PADDLE_V).toBe(2.4);
  });

  it('放開立刻停（沒有慣性）；只按 a、只按 b、上下鍵、左右一起按：都不動', () => {
    const moving = makeState({
      paddles: [
        { x: 90, v: 2.4 },
        { x: 60, v: -2.4 },
      ],
    });
    const stopped = s4Game.step(moving, IDLE);
    expect(stopped.paddles[0]).toEqual({ x: 90, v: 0 });
    expect(stopped.paddles[1]).toEqual({ x: 60, v: 0 });
    for (const keys of [
      { a: true },
      { b: true },
      { up: true },
      { down: true },
      { left: true, right: true },
    ]) {
      expect(s4Game.step(makeState({}), [press(keys), NONE]).paddles[0]).toEqual({ x: 75, v: 0 });
    }
  });

  it('（邊界）板子中心夾在 [14, 136]：貼著邊再往外按不會出界', () => {
    const s = makeState({ paddles: [{ x: 135 }, { x: 15 }] });
    const next = s4Game.step(s, [press({ right: true }), press({ left: true })]);
    expect(next.paddles[0].x).toBe(136);
    expect(next.paddles[1].x).toBe(14);
    const again = s4Game.step(next, [press({ right: true }), press({ left: true })]);
    expect(again.paddles[0].x).toBe(136);
    expect(again.paddles[1].x).toBe(14);
  });

  it('兩邊各自移動：1 號邊的左右鍵一樣是場地座標的左右', () => {
    const s = s4Game.step(makeState({}), [NONE, press({ right: true })]);
    expect(s.paddles[1].x).toBeCloseTo(77.4, 12);
    expect(s.paddles[0].x).toBe(75);
  });
});

describe('S-4 打磚塊對決｜球碰側牆與板子', () => {
  it('碰左右側牆：x 往內反彈（球心超出 2 或 148 的部分折回去），vx 反號', () => {
    const left = s4Game.step(makeState({ balls: [live(2.5, 150, -1, -1.7, 0), PARK] }), IDLE)
      .balls[0];
    expect(left.x).toBeCloseTo(2.5, 12);
    expect(left.vx).toBe(1);
    const right = s4Game.step(makeState({ balls: [live(147.5, 150, 1, -1.7, 0), PARK] }), IDLE)
      .balls[0];
    expect(right.x).toBeCloseTo(147.5, 12);
    expect(right.vx).toBe(-1);
    // 沒碰到就不變
    const free = s4Game.step(makeState({ balls: [live(100, 150, 1, -1.7, 0), PARK] }), IDLE)
      .balls[0];
    expect(free.x).toBeCloseTo(101, 10);
    expect(free.y).toBeCloseTo(148.3, 10);
    expect(free.vx).toBe(1);
  });

  it.each([
    [0, 0],
    [8, 25],
    [16, 50],
    [-8, -25],
    [-16, -50],
  ])(
    '擊球角度：球落在板心右邊 %s 像素 → 離開時偏 %s 度（o = 偏移 ÷ 16，角度 = o × 50°），朝對方、速度仍是 2',
    (offset, degrees) => {
      const { balls } = s4Game.step(atHumanLine(75 + offset), IDLE);
      const ball = balls[0];
      expect(ball.owner).toBe(0);
      expect(ball.y).toBe(CONTACT_Y[0]);
      expect(ball.vx).toBeCloseTo(BALL_SPEED * Math.sin(degrees * DEG), 8);
      expect(ball.vy).toBeCloseTo(-BALL_SPEED * Math.cos(degrees * DEG), 8);
      expect(Math.hypot(ball.vx, ball.vy)).toBeCloseTo(BALL_SPEED, 8);
      expect(MAX_ANGLE).toBeCloseTo(50 * DEG, 12);
    },
  );

  it('（邊界）離板心剛好 16 算接到；16.01 沒接到，球照原路穿過去、主人不變', () => {
    expect(s4Game.step(atHumanLine(91), IDLE).balls[0].owner).toBe(0);
    expect(PADDLE_REACH).toBe(16);
    const miss = s4Game.step(atHumanLine(91.01), IDLE).balls[0];
    expect(miss.owner).toBe(1);
    expect(miss.y).toBe(209);
    expect(miss.vy).toBe(2);
  });

  it('板子先動、球後判定：同一個 tick 按右，板子從 75 走到 77.4，離球 92 剛好 14.6 接得到；不按就差 17 接不到', () => {
    expect(s4Game.step(atHumanLine(92), [press({ right: true }), NONE]).balls[0].owner).toBe(0);
    expect(s4Game.step(atHumanLine(92), IDLE).balls[0].owner).toBe(1);
  });

  it('擊中的 x 是球穿過板子那條線的位置（內插）：球 (70, 207)、速度 (1.5, 2)、板子 62 → x 70.75、偏移 8.75', () => {
    const ball = s4Game.step(atHumanLine(70, { vx: 1.5 }, 62), IDLE).balls[0];
    expect(ball.x).toBeCloseTo(70.75, 10);
    expect(ball.y).toBe(208);
    const o = 8.75 / 16;
    expect(ball.vx).toBeCloseTo(BALL_SPEED * Math.sin(o * 50 * DEG), 8);
    expect(ball.owner).toBe(0);
  });

  it('1 號邊（AI，板子 y = 8）：球從下往上穿過 y = 12 被接住，往下彈；球在板心右邊偏右，與 0 號邊同一個公式', () => {
    const s = makeState({ balls: [PARK, live(83, 13, 0, -2, 0)], paddles: [{}, { x: 75 }] });
    const ball = s4Game.step(s, IDLE).balls[1];
    expect(ball.owner).toBe(1);
    expect(ball.y).toBe(CONTACT_Y[1]);
    expect(ball.vy).toBeGreaterThan(0);
    expect(ball.vx).toBeCloseTo(BALL_SPEED * Math.sin(25 * DEG), 8);
    expect(ball.vy).toBeCloseTo(BALL_SPEED * Math.cos(25 * DEG), 8);
  });

  it('剛彈出去的球（正好在接球線上、往外飛）不會被同一塊板子再碰一次', () => {
    const s = makeState({ balls: [live(75, 208, 0, -2, 0), PARK] });
    const next = s4Game.step(s, IDLE).balls[0];
    expect(next.y).toBe(206);
    expect(next.vy).toBe(-2);
  });
});

describe('S-4 打磚塊對決｜磚與反彈', () => {
  it('從下面敲磚（0 號邊的球）：磚消失、球的主人得 1 分、球往下彈，被推回離磚剛好 2 像素的地方', () => {
    const s = makeState({ balls: [live(67.5, 134.5, 0, -2, 0), PARK] });
    const next = s4Game.step(s, IDLE);
    expect(dead(next)).toEqual([54]);
    expect(next.score).toEqual([1, 0]);
    expect(next.balls[0].vy).toBe(2);
    expect(next.balls[0].y).toBeCloseTo(133, 10);
    expect(next.balls[0].x).toBeCloseTo(67.5, 10);
  });

  it('從上面敲磚（1 號邊的球）：分數記在球的主人（1 號邊）', () => {
    const s = makeState({ balls: [PARK, live(67.5, 85.5, 0, 2, 1)] });
    const next = s4Game.step(s, IDLE);
    expect(dead(next)).toEqual([4]);
    expect(next.score).toEqual([0, 1]);
    expect(next.balls[1].vy).toBe(-2);
    expect(next.balls[1].y).toBeCloseTo(87, 10);
  });

  it('撞到磚的側面：水平速度反向，垂直速度不變，被推開到離磚 2 像素', () => {
    const s = makeState({ gone: [53], balls: [live(57.5, 127.5, 1.5, 0, 0), PARK] });
    const next = s4Game.step(s, IDLE);
    expect(dead(next)).toEqual([53, 54]);
    expect(next.score).toEqual([1, 0]);
    expect(next.balls[0].vx).toBe(-1.5);
    expect(next.balls[0].vy).toBe(0);
    expect(next.balls[0].x).toBeCloseTo(58, 10);
  });

  it('（邊界）同時碰到兩塊磚：一個 tick 只敲最近的一塊，距離一樣取編號小的（53），54 還在', () => {
    const s = makeState({ balls: [live(60, 134.5, 0, -2, 0), PARK] });
    const next = s4Game.step(s, IDLE);
    expect(dead(next)).toEqual([53]);
    expect(next.score).toEqual([1, 0]);
  });

  it('已經沒了的磚球直接穿過去，不算分；往上走到下一塊才敲（54 沒了，球先穿過去敲 44）', () => {
    let s = makeState({ gone: [54], balls: [live(67.5, 134.5, 0, -2, 0), PARK] });
    s = s4Game.step(s, IDLE);
    expect(s.score).toEqual([0, 0]);
    expect(s.balls[0].vy).toBe(-2);
    for (let i = 0; i < 10 && s.score[0] === 0; i += 1) {
      s = s4Game.step(s, IDLE);
    }
    expect(dead(s)).toEqual([44, 54]);
    expect(s.score).toEqual([1, 0]);
  });

  it('一欄的 6 塊都被敲掉就是洞：球直直穿過去，磚與分數都不變；穿到對方那一半', () => {
    const s = makeState({ gone: column(4), balls: [live(67.5, 140, 0, -2, 0), PARK] });
    const next = run(s, 30);
    expect(next.balls[0].y).toBeCloseTo(80, 10);
    expect(next.balls[0].vy).toBe(-2);
    expect(dead(next)).toEqual(column(4));
    expect(next.score).toEqual([0, 0]);
  });

  it('（邊界）洞只有 15 寬：球心離洞邊剛好 2 不碰（x = 62 穿過去）；差一點點（61.9）就敲到旁邊那一欄的磚', () => {
    const through = run(makeState({ gone: column(4), balls: [live(62, 140, 0, -2, 0), PARK] }), 30);
    expect(through.score).toEqual([0, 0]);
    expect(through.balls[0].y).toBeCloseTo(80, 10);
    const clip = run(makeState({ gone: column(4), balls: [live(61.9, 140, 0, -2, 0), PARK] }), 12);
    expect(clip.score[0]).toBeGreaterThanOrEqual(1);
  });

  it('速度不會因為反彈改變：敲磚、撞側牆、被板子打回，速度一直是 2', () => {
    let s = makeState({ balls: [live(3, 200, -1.2, -1.6, 0), PARK], paddles: [{ x: 75 }, {}] });
    for (let i = 0; i < 120; i += 1) {
      s = s4Game.step(s, IDLE);
      const b = s.balls[0];
      if (b.respawn === 0) {
        expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(BALL_SPEED, 9);
      }
    }
  });
});

describe('S-4 打磚塊對決｜炸彈', () => {
  it('blast：炸彈與周圍 8 格一起消失（已經沒了的不算）；炸彈在邊上的時候不繞到另一邊', () => {
    const none = Array.from({ length: 60 }, () => 0);
    expect(blast(none, [34], 34)).toEqual([23, 24, 25, 33, 34, 35, 43, 44, 45]);
    expect(blast(none, [20], 20)).toEqual([10, 11, 20, 21, 30, 31]);
    expect(blast(none, [29], 29)).toEqual([18, 19, 28, 29, 38, 39]);
    expect(blast(none, [5], 5)).toEqual([4, 5, 6, 14, 15, 16]);
    expect(blast(none, [55], 55)).toEqual([44, 45, 46, 54, 55, 56]);
    const some = [...none];
    some[11] = 1;
    expect(blast(some, [20], 20)).toEqual([10, 20, 21, 30, 31]);
  });

  it('blast：連鎖 —— 範圍裡有別的炸彈就一起炸；兩顆互相在對方範圍裡不會無限遞迴；範圍外的炸彈不連鎖', () => {
    const none = Array.from({ length: 60 }, () => 0);
    const chain = blast(none, [34, 25], 34);
    expect(chain).toEqual([14, 15, 16, 23, 24, 25, 26, 33, 34, 35, 36, 43, 44, 45]);
    expect(blast(none, [34, 35], 34)).toEqual(blast(none, [34, 35], 35));
    expect(blast(none, [34, 38], 34)).toEqual([23, 24, 25, 33, 34, 35, 43, 44, 45]);
  });

  it('球敲到炸彈磚：整片消失、全部算球的主人；範圍裡還有炸彈就連鎖，連鎖的也算（13 塊 = 8 + 5）', () => {
    const s = makeState({
      gone: [44],
      bombs: [34, 25],
      balls: [live(67.5, 120.5, 0, -2, 0), PARK],
    });
    const next = s4Game.step(s, IDLE);
    expect(dead(next)).toEqual([14, 15, 16, 23, 24, 25, 26, 33, 34, 35, 36, 43, 44, 45]);
    expect(next.score).toEqual([13, 0]);
    expect(next.balls[0].vy).toBe(2);
  });

  it('搶炸彈：同一顆炸彈，誰的球先碰到就是誰的（1 號邊的球穿過第 0 列的洞往下碰到第 1 列的炸彈磚，周圍 8 塊（4 已經沒了）全算 1 號邊）', () => {
    const s = makeState({ bombs: [14], balls: [PARK, live(67.5, 89.5, 0, 2, 1)], gone: [4] });
    const next = run(s, 3);
    expect(next.score).toEqual([0, 8]);
    expect(next.bricks[14]).toBe(1);
    expect(dead(next)).toEqual([3, 4, 5, 13, 14, 15, 23, 24, 25]);
  });

  it('沒有被球碰到的炸彈磚好好的：球只敲了旁邊的普通磚，炸彈不會自己炸', () => {
    const s = makeState({ bombs: [34, 25], balls: [live(67.5, 134.5, 0, -2, 0), PARK] });
    const next = s4Game.step(s, IDLE);
    expect(dead(next)).toEqual([54]);
    expect(next.score).toEqual([1, 0]);
  });
});

describe('S-4 打磚塊對決｜底線與重發', () => {
  it('球穿過自己的底線（0 號邊，y > 220）：自己扣 2 分，這顆球進入等待 45 tick，主人回到發球的這一邊', () => {
    const s = makeState({ balls: [live(140, 219, 0, 2, 0), PARK], paddles: [{ x: 75 }, {}] });
    const next = s4Game.step(s, IDLE);
    expect(next.score).toEqual([-MISS_PENALTY, 0]);
    expect(next.balls[0].respawn).toBe(RESPAWN_TICKS);
    expect(next.balls[0].owner).toBe(0);
    expect(MISS_PENALTY).toBe(2);
    expect(RESPAWN_TICKS).toBe(45);
  });

  it('（邊界）球心剛好 y = 220 還沒穿過；再下一個 tick 才算', () => {
    const s = makeState({ balls: [live(140, 218, 0, 2, 0), PARK] });
    const on = s4Game.step(s, IDLE);
    expect(on.balls[0].y).toBe(220);
    expect(on.balls[0].respawn).toBe(0);
    expect(on.score).toEqual([0, 0]);
    const over = s4Game.step(on, IDLE);
    expect(over.score).toEqual([-2, 0]);
  });

  it('穿牆球穿過對方的底線（y < 0）：對方（1 號邊）扣 2 分，攻擊的人不扣；攻擊的人那顆球 45 tick 後從自己的板子重發', () => {
    const s = makeState({ balls: [live(140, 1, 0, -2, 0), PARK], paddles: [{}, { x: 75 }] });
    const next = s4Game.step(s, IDLE);
    expect(next.score).toEqual([0, -2]);
    expect(next.balls[0].respawn).toBe(RESPAWN_TICKS);
    expect(next.balls[0].owner).toBe(0);
  });

  it('被對方偷走的球穿過偷球的人的底線：偷球的人扣 2 分，這顆球還是回到原本發球的那一邊重發', () => {
    // 1 號邊的球（第二格）被 0 號邊接住（owner 0），然後 0 號邊沒接到、穿過 0 號邊的底線
    const s = makeState({ balls: [PARK, live(140, 219, 0, 2, 0)], paddles: [{ x: 75 }, {}] });
    const next = s4Game.step(s, IDLE);
    expect(next.score).toEqual([-2, 0]);
    expect(next.balls[1].respawn).toBe(RESPAWN_TICKS);
    expect(next.balls[1].owner).toBe(1);
  });

  it('等待的球不動；等待 45 tick 之後在板子上發出，角度由亂數決定（最多偏 30 度）、朝牆、速度 2，主人是發球的那一邊', () => {
    let s = makeState({
      balls: [{ x: 10, y: 10, vx: 0, vy: 0, owner: 0, respawn: 3 }, PARK],
      paddles: [{ x: 90 }, {}],
    });
    s = s4Game.step(s, IDLE);
    expect(s.balls[0]).toMatchObject({ x: 10, y: 10, respawn: 2 });
    s = s4Game.step(s, IDLE);
    expect(s.balls[0]).toMatchObject({ x: 10, y: 10, respawn: 1 });
    const rngBefore = s.rng;
    s = s4Game.step(s, IDLE);
    const b = s.balls[0];
    expect(b.respawn).toBe(0);
    expect(b.x).toBe(90);
    expect(b.y).toBe(CONTACT_Y[0]);
    expect(b.owner).toBe(0);
    expect(b.vy).toBeLessThan(0);
    expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(BALL_SPEED, 10);
    expect(Math.abs(b.vx)).toBeLessThanOrEqual(BALL_SPEED * Math.sin(SERVE_ANGLE) + 1e-12);
    expect(s.rng).not.toBe(rngBefore);
  });

  it('發球的位置是那一刻板子的位置（板子在等待期間可以走動）；1 號邊從 y = 12 往下發', () => {
    let s = makeState({
      balls: [PARK, { x: 0, y: 0, vx: 0, vy: 0, owner: 1, respawn: 2 }],
      paddles: [{}, { x: 100 }],
    });
    s = s4Game.step(s, [NONE, press({ left: true })]);
    s = s4Game.step(s, [NONE, press({ left: true })]);
    const b = s.balls[1];
    expect(b.respawn).toBe(0);
    expect(b.x).toBeCloseTo(95.2, 10);
    expect(b.y).toBe(CONTACT_Y[1]);
    expect(b.vy).toBeGreaterThan(0);
    expect(b.owner).toBe(1);
  });

  it('等待中的球不碰任何東西，也不被板子接住', () => {
    const s = makeState({ balls: [{ x: 75, y: 207, vx: 0, vy: 2, owner: 1, respawn: 9 }, PARK] });
    const next = s4Game.step(s, IDLE);
    expect(next.balls[0]).toMatchObject({ y: 207, owner: 1, respawn: 8 });
  });
});

describe('S-4 打磚塊對決｜穿牆與球的歸屬', () => {
  it('穿牆球被對方板子接住時歸屬改變：1 號邊的球穿過洞到人這邊，被人接住變 0 號邊的；彈回去穿過洞，被 AI 接住又變回 1 號邊的', () => {
    const s = makeState({
      gone: column(4),
      balls: [PARK, live(67.5, 150, 0, 2, 1)],
      paddles: [{ x: 67.5 }, { x: 67.5 }],
    });
    const stolen = run(s, 29);
    expect(stolen.balls[1].owner).toBe(0);
    expect(stolen.balls[1].vy).toBe(-2);
    expect(stolen.balls[1].y).toBe(208);
    const back = run(stolen, 98);
    expect(back.balls[1].owner).toBe(1);
    expect(back.balls[1].vy).toBe(2);
    expect(back.balls[1].y).toBe(12);
    expect(back.score).toEqual([0, 0]);
  });

  it('偷來的球敲的磚算偷球的人的分（歸屬改變之後，分數跟著走）', () => {
    // 1 號邊發的球被 0 號邊偷走後往牆飛，敲到磚
    const s = makeState({
      balls: [PARK, live(67.5, 207, 0, 2, 1)],
      paddles: [{ x: 67.5 }, {}],
    });
    let t = s4Game.step(s, IDLE);
    expect(t.balls[1].owner).toBe(0);
    t = run(t, 40);
    expect(t.score).toEqual([1, 0]);
  });

  it('兩顆球可以同時敲不同的磚；分數各算各的', () => {
    const s = makeState({
      balls: [live(67.5, 134.5, 0, -2, 0), live(127.5, 85.5, 0, 2, 1)],
    });
    const next = s4Game.step(s, IDLE);
    expect(dead(next)).toEqual([8, 54]);
    expect(next.score).toEqual([1, 1]);
  });
});

describe('S-4 打磚塊對決｜結束與分數', () => {
  it('牆被敲光就結束：最後一塊被敲掉的那個 tick，isOver 為 true，分數高的贏；結束之後再 step，state 原樣不變', () => {
    const rest = Array.from({ length: 60 }, (_v, i) => i).filter((i) => i !== 54);
    const s = makeState({ gone: rest, score: [10, 8], balls: [live(67.5, 134.5, 0, -2, 0), PARK] });
    expect(s4Game.isOver(s)).toBe(false);
    expect(s4Game.winner(s)).toBeNull();
    const next = s4Game.step(s, IDLE);
    expect(next.bricks.every((v) => v === 1)).toBe(true);
    expect(s4Game.isOver(next)).toBe(true);
    expect(s4Game.score(next)).toEqual([11, 8]);
    expect(s4Game.winner(next)).toBe(0);
    expect(s4Game.step(next, IDLE)).toBe(next);
  });

  it('時間到（tick = maxTicks）才結束；結束前 winner 是 null；同分平手', () => {
    const s = makeState({ tick: 2998, maxTicks: 3000, score: [3, 3] });
    expect(s4Game.isOver(s)).toBe(false);
    const one = s4Game.step(s, IDLE);
    expect(one.tick).toBe(2999);
    expect(s4Game.isOver(one)).toBe(false);
    expect(s4Game.winner(one)).toBeNull();
    const two = s4Game.step(one, IDLE);
    expect(two.tick).toBe(3000);
    expect(s4Game.isOver(two)).toBe(true);
    expect(s4Game.winner(two)).toBeNull();
  });

  it('分數 = 敲掉的磚 − 2 × 被穿底線次數，可以是負的；高的贏', () => {
    const over = (score: readonly [number, number]): S4State =>
      makeState({ tick: 3000, maxTicks: 3000, score });
    expect(s4Game.winner(over([1, -2]))).toBe(0);
    expect(s4Game.winner(over([-4, -2]))).toBe(1);
    expect(s4Game.winner(over([-2, -2]))).toBeNull();
    expect(s4Game.score(over([-4, 7]))).toEqual([-4, 7]);
  });

  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，含敲磚、炸彈、擊球、穿過底線與發球那幾次）', () => {
    const scenes: S4State[] = [
      makeState({
        bombs: [34, 25],
        gone: [44],
        balls: [live(67.5, 120.5, 0, -2, 0), live(140, 1, 0, -2, 0)],
      }),
      atHumanLine(80),
      makeState({
        balls: [live(140, 219, 0, 2, 0), { x: 1, y: 1, vx: 0, vy: 0, owner: 1, respawn: 1 }],
      }),
    ];
    for (const scene of scenes) {
      const frozen = deepFreeze(scene);
      expect(() =>
        s4Game.step(frozen, [press({ right: true }), press({ left: true, a: true })]),
      ).not.toThrow();
    }
    const first = scenes[0] as S4State;
    expect(first.score).toEqual([0, 0]);
    expect(first.bricks[34]).toBe(0);
  });

  it('K1：同一個種子、同一串輸入跑兩次結果相同；整個 state 可以 JSON 來回', () => {
    const play = (): S4State => {
      let s = s4Game.init(5, CONFIG);
      for (let t = 0; t < 400; t += 1) {
        const k = (t * 7) % 5;
        s = s4Game.step(s, [
          press({ left: k === 1 || k === 3, right: k === 2 || k === 4, a: k >= 3 }),
          press({ left: k === 2, right: k === 1 }),
        ]);
      }
      return s;
    };
    expect(play()).toEqual(play());
    const s = play();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('整場跑完：不管輸入，maxTicks 之內一定 isOver，分數是有限的整數', () => {
    let s = s4Game.init(3, { maxTicks: 3000, params: {} });
    let t = 0;
    while (!s4Game.isOver(s)) {
      const k = (t * 13) % 5;
      s = s4Game.step(s, [
        press({ left: k === 1, right: k === 2 }),
        press({ left: k === 3, right: k === 4 }),
      ]);
      t += 1;
      expect(t).toBeLessThanOrEqual(3000);
    }
    for (const v of s4Game.score(s)) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 轉 180 度對稱（K12 的前提）
// ---------------------------------------------------------------------------

const flip = (b: Buttons): Buttons => ({ ...b, left: b.right, right: b.left });

function rotateBall(b: S4Ball): S4Ball {
  return {
    x: 150 - b.x,
    y: 220 - b.y,
    vx: -b.vx,
    vy: -b.vy,
    owner: b.owner === 0 ? 1 : 0,
    respawn: b.respawn,
  };
}

/** 整個局面轉 180 度：兩邊互換，x → 150 − x，y → 220 − y，磚 i → 59 − i。 */
function rotate(s: S4State): S4State {
  const [p0, p1] = s.paddles;
  const [b0, b1] = s.balls;
  return {
    ...s,
    bricks: [...s.bricks].reverse(),
    bombs: s.bombs.map((i) => 59 - i).sort((a, b) => a - b),
    paddles: [
      { x: 150 - p1.x, v: -p1.v },
      { x: 150 - p0.x, v: -p0.v },
    ],
    balls: [rotateBall(b1), rotateBall(b0)],
    score: [s.score[1], s.score[0]],
  };
}
const rotateInputs = (i: Inputs): Inputs => [flip(i[1]), flip(i[0])];

function expectClose(actual: unknown, expected: unknown, path = 'state'): void {
  if (typeof expected === 'number') {
    expect(actual, path).toBeCloseTo(expected, 8);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((v, i) => expectClose((actual as unknown[])[i], v, `${path}[${i}]`));
  } else if (typeof expected === 'object' && expected !== null) {
    for (const key of Object.keys(expected)) {
      expectClose(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    }
  } else {
    expect(actual, path).toEqual(expected);
  }
}

/** 一組「一般」的局面：數字刻意不整，沒有平手；牆缺幾塊、有炸彈，兩顆球一顆往上撞牆、一顆往下撞牆。 */
function generic(): S4State {
  return makeState({
    gone: [54, 53, 23, 6],
    bombs: [34, 25],
    paddles: [
      { x: 40.3, v: 0 },
      { x: 109.7, v: 0 },
    ],
    balls: [live(54.3, 195.4, 0.6, 1.7, 0), live(101.7, 79.9, -0.7, 1.8, 1)],
    score: [2, 1],
  });
}

describe('S-4 打磚塊對決｜轉 180 度對稱', () => {
  it('step 對稱：整個局面轉 180 度、兩邊的輸入互換（左右也互換）再 step，等於 step 之後再轉 180 度（60 個 tick，含擊球、敲磚、撞側牆）', () => {
    const inputs: Inputs = [press({ right: true }), press({ left: true })];
    let s = generic();
    let r = rotate(s);
    for (let t = 0; t < 60; t += 1) {
      s = s4Game.step(s, inputs);
      r = s4Game.step(r, rotateInputs(inputs));
      expectClose(r, rotate(s), `tick ${t + 1}`);
    }
    expect(dead(s).length).toBeGreaterThan(4); // 真的有敲到磚，不是空轉
  });

  it('evaluate 對稱：同一個局面，0 號邊的評估等於轉 180 度後 1 號邊的評估（反之亦然）', () => {
    const scenes: S4State[] = [
      generic(),
      makeState({
        gone: [53, 43, 33, 14, 15],
        bombs: [31, 28],
        paddles: [
          { x: 61.3, v: 2.4 },
          { x: 97.1, v: -1 },
        ],
        balls: [live(48.3, 150.7, 0.6, -1.9, 0), live(90.2, 60.2, -0.5, -1.9, 1)],
        score: [3, 1],
      }),
      makeState({
        paddles: [
          { x: 90.7, v: -2.4 },
          { x: 20.9, v: 1 },
        ],
        balls: [
          live(70.1, 180.3, -0.4, 1.9, 1),
          { x: 0, y: 0, vx: 0, vy: 0, owner: 1, respawn: 20 },
        ],
      }),
    ];
    for (const scene of scenes) {
      for (const side of [0, 1] as const) {
        const here = s4Game.evaluate(scene, side);
        const there = s4Game.evaluate(rotate(scene), side === 0 ? 1 : 0);
        expect(there.gain).toBeCloseTo(here.gain, 6);
        expect(there.danger).toBeCloseTo(here.danger, 6);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

describe('S-4 打磚塊對決｜actions', () => {
  it('5 個動作：全放開（排第一）、左、右、a＋左、a＋右；兩邊一樣，沒有 b、上、下', () => {
    const s = makeState({});
    for (const side of [0, 1] as const) {
      const a = s4Game.actions(s, side);
      expect(a).toHaveLength(5);
      expect(a[0]).toEqual(NONE);
      expect(a.filter((x) => x.left && !x.a)).toHaveLength(1);
      expect(a.filter((x) => x.right && !x.a)).toHaveLength(1);
      expect(a.filter((x) => x.left && x.a)).toHaveLength(1);
      expect(a.filter((x) => x.right && x.a)).toHaveLength(1);
      expect(a.every((x) => !x.b && !x.up && !x.down)).toBe(true);
    }
    expect(s4Game.actions(s, 0)).toEqual(s4Game.actions(s, 1));
  });
});

/** 球從 (x, 180) 往下，14 tick 後到 0 號邊的板子線；板子在 75 不動。另一顆球停放。 */
const incoming = (x: number, extra: Partial<S4State> = {}): S4State =>
  ({
    ...makeState({ balls: [live(x, 180, 0, 2, 1), PARK], paddles: [{ x: 75, v: 0 }, {}] }),
    ...extra,
  }) as S4State;

describe('S-4 打磚塊對決｜evaluate', () => {
  it('結束的局：gain 是分差 × 1000、danger 是 0（兩邊相反）', () => {
    const over = makeState({
      tick: 3000,
      maxTicks: 3000,
      score: [5, 2],
      balls: [live(140, 190, 0, 2, 1), PARK],
    });
    expect(s4Game.evaluate(over, 0)).toEqual({ gain: 3000, danger: 0 });
    expect(s4Game.evaluate(over, 1)).toEqual({ gain: -3000, danger: 0 });
  });

  it('danger = 接不到的程度：球到板子線時離板心 o × 16，|o| ≤ 0.7 是 0，|o| = 0.85 是 0.5，|o| ≥ 1 是 1（左右對稱）', () => {
    const danger = (x: number): number => s4Game.evaluate(incoming(x), 0).danger;
    expect(danger(75)).toBe(0);
    expect(danger(75 + 11.2)).toBeCloseTo(0, 10);
    expect(danger(75 + 13.6)).toBeCloseTo(0.5, 8);
    expect(danger(75 - 13.6)).toBeCloseTo(0.5, 8);
    expect(danger(75 + 16)).toBe(1);
    expect(danger(75 + 30)).toBe(1);
    expect(danger(75 - 30)).toBe(1);
  });

  it('danger 看的是板子「預計」站的位置：球會落在 105，板子往右走 danger 就低，往左走就高', () => {
    const s = incoming(105);
    const right = s4Game.step(s, [press({ right: true }), NONE]);
    const left = s4Game.step(s, [press({ left: true }), NONE]);
    const idle = s4Game.step(s, IDLE);
    expect(s4Game.evaluate(right, 0).danger).toBeLessThan(0.3);
    expect(s4Game.evaluate(left, 0).danger).toBe(1);
    expect(s4Game.evaluate(idle, 0).danger).toBe(1);
  });

  it('沒有球飛向我、我的球也還在遠方時 danger 是 0；兩顆球都在等待發球時也是 0', () => {
    const waiting = makeState({ balls: [{ respawn: 30 }, { respawn: 30 }] });
    expect(s4Game.evaluate(waiting, 0).danger).toBe(0);
    expect(s4Game.evaluate(waiting, 1).danger).toBe(0);
    const away = makeState({ balls: [live(75, 150, 0, -2, 0), PARK] });
    expect(s4Game.evaluate(away, 0).danger).toBe(0);
  });

  it('不論球是誰的，飛向我的球都要接：對手的球穿牆過來、接不到的 danger 一樣是 1', () => {
    const s = makeState({ balls: [PARK, live(120, 150, 0, 2, 1)], paddles: [{ x: 75 }, {}] });
    expect(s4Game.evaluate(s, 0).danger).toBe(1);
  });

  it('領先 1 分，gain 多 1000，danger 不變；對方領先則少 1000', () => {
    const base = incoming(80);
    const ahead = { ...base, score: [3, 2] } as S4State;
    const level = { ...base, score: [2, 2] } as S4State;
    const behind = { ...base, score: [2, 3] } as S4State;
    expect(s4Game.evaluate(ahead, 0).gain - s4Game.evaluate(level, 0).gain).toBeCloseTo(1000, 8);
    expect(s4Game.evaluate(behind, 0).gain - s4Game.evaluate(level, 0).gain).toBeCloseTo(-1000, 8);
    expect(s4Game.evaluate(ahead, 0).danger).toBe(s4Game.evaluate(level, 0).danger);
    expect(s4Game.evaluate(ahead, 1).gain - s4Game.evaluate(level, 1).gain).toBeCloseTo(-1000, 8);
  });

  it('沒有橡皮筋：兩邊的分數同時加上同一個常數，evaluate 與 actions 完全不變', () => {
    const scenes: S4State[] = [generic(), incoming(90)];
    for (const scene of scenes) {
      const shifted = { ...scene, score: [scene.score[0] + 7, scene.score[1] + 7] } as S4State;
      for (const side of [0, 1] as const) {
        expect(s4Game.evaluate(shifted, side)).toEqual(s4Game.evaluate(scene, side));
        expect(s4Game.actions(shifted, side)).toEqual(s4Game.actions(scene, side));
      }
    }
  });

  it('AI 只讀公開的東西：亂數狀態不同，evaluate 完全相同', () => {
    const a = { ...generic(), rng: 123 } as S4State;
    const b = { ...generic(), rng: 987654 } as S4State;
    for (const side of [0, 1] as const) {
      expect(s4Game.evaluate(a, side)).toEqual(s4Game.evaluate(b, side));
    }
  });

  it('gain 偏好炸彈：球直直落在板心，彈出去會敲到炸彈磚（連同周圍 6 塊）比偏 25 度去敲普通磚多 3 以上，danger 兩邊都是 0', () => {
    const aim = (paddleX: number): S4State =>
      makeState({
        bombs: [55],
        balls: [live(82.5, 180, 0, 2, 1), PARK],
        paddles: [{ x: paddleX, v: 0 }, {}],
      });
    const onBomb = s4Game.evaluate(aim(82.5), 0);
    const offBomb = s4Game.evaluate(aim(74.5), 0);
    expect(onBomb.danger).toBe(0);
    expect(offBomb.danger).toBe(0);
    expect(onBomb.gain - offBomb.gain).toBeGreaterThan(3);
  });

  it('搶磚：對手的球預計先到同一欄，這顆球的磚只算 0.4（gain 比對手的球在別處時低）', () => {
    const lone = [5, 15, 25, 35, 45]; // 第 5 欄只剩最下面一塊（55）
    const contested = makeState({
      gone: lone,
      balls: [live(82.5, 180, 0, 2, 1), live(82.5, 100, 0, 2, 1)],
      paddles: [
        { x: 82.5, v: 0 },
        { x: 20, v: 0 },
      ],
    });
    const free = makeState({
      gone: lone,
      balls: [live(82.5, 180, 0, 2, 1), live(7.5, 60, 0, 2, 1)],
      paddles: [
        { x: 82.5, v: 0 },
        { x: 20, v: 0 },
      ],
    });
    expect(s4Game.evaluate(free, 0).gain - s4Game.evaluate(contested, 0).gain).toBeGreaterThan(0.3);
  });

  it('穿牆之後會被擊回：我的球會從洞穿到對方那一半，對方的板子剛好在那裡等著的 gain，比對方板子離得遠時低', () => {
    const open = [5, 15, 25, 35, 45, 55];
    const waiting = (oppX: number): S4State =>
      makeState({
        gone: open,
        balls: [live(82.5, 180, 0, 2, 1), PARK],
        paddles: [
          { x: 82.5, v: 0 },
          { x: oppX, v: 0 },
        ],
      });
    expect(s4Game.evaluate(waiting(82.5), 0).gain).toBeLessThan(
      s4Game.evaluate(waiting(14), 0).gain,
    );
  });

  it('守：對手的球正朝一欄「只剩一塊」的洞飛去、我沒有別的事的時候，我的板子站在那一欄底下的 gain 比站在別處高', () => {
    const nearlyOpen = [5, 15, 25, 35, 45]; // 第 5 欄只剩第 5 列；AI 的球從上面飛下來，敲掉它就通了
    const guard = (x: number): S4State =>
      makeState({
        gone: nearlyOpen,
        balls: [PARK, live(82.5, 100, 0, 2, 1)],
        paddles: [
          { x, v: 0 },
          { x: 82.5, v: 0 },
        ],
      });
    expect(s4Game.evaluate(guard(82.5), 0).gain).toBeGreaterThan(
      s4Game.evaluate(guard(20), 0).gain + 1,
    );
  });

  it('gain 與 danger 永遠是有限的數、danger 在 0 到 1：種子 0 到 4 各跑 400 tick，每個 tick 兩邊都檢查', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      let s = s4Game.init(seed, CONFIG);
      for (let t = 0; t < 400 && !s4Game.isOver(s); t += 1) {
        const k = (t + seed) % 5;
        s = s4Game.step(s, [
          press({ left: k === 1, right: k === 2 }),
          press({ left: k === 3, right: k === 4 }),
        ]);
        for (const side of [0, 1] as const) {
          const e = s4Game.evaluate(s, side);
          expect(Number.isFinite(e.gain)).toBe(true);
          expect(e.danger).toBeGreaterThanOrEqual(0);
          expect(e.danger).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('S-4 打磚塊對決｜selfFromPresent（沒有宣告）', () => {
  it('球與對手都推不動我的板子（板子只由自己的輸入決定位置），所以不宣告 selfFromPresent；量測在小規格', () => {
    expect('selfFromPresent' in s4Game).toBe(false);
  });
});
