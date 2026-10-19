import { describe, expect, it } from 'vitest';

import { deepFreeze } from '../../../tests/contract/freeze';
import type { Buttons, Inputs } from '../../core/types';
import { FIELD_H, FIELD_W } from '../_spades/logic';
import {
  BODY_DIST,
  CX,
  CY,
  DURATION_TICKS,
  HIT_PENALTY,
  HORIZON,
  INVULN_TICKS,
  LANE_TAU,
  MIN_TICKS,
  OMEGA_GAIN,
  OMEGA_START,
  R_MAX,
  R_MIN,
  SCORE_DIV,
  SLIT_HALF,
  START_R,
  inSlitAt,
  makeState,
  omegaAt,
  s8Game,
  slitCoords,
} from './logic';
import type { S8State } from './logic';

/**
 * S-8 掃射的規則測試（小規格 `docs/cards/S-8.md`）。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 0 號邊是人、1 號邊是 AI。
 *
 * 座標約定：`at(angle, along, lat)` 是縫的座標系裡的點（沿縫 `along`、橫向 `lat`）換成場地座標。
 * `PRE` 是「再 step 一次剛好轉到角度 0」的縫角度（tick 0 的角速度是 0.020，−0.02 + 0.02 精確等於 0），
 * 所以角度 0 的縫沿著 +x 軸、橫向就是 y：邊界測試因此是精確的數字，不是浮點碰運氣。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];
const press = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const CONFIG = { maxTicks: 3600, params: {} };
const PRE = -OMEGA_START;

function at(angle: number, along: number, lat: number): { x: number; y: number } {
  return {
    x: CX + along * Math.cos(angle) - lat * Math.sin(angle),
    y: CY + along * Math.sin(angle) + lat * Math.cos(angle),
  };
}

function xy(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}

function run(state: S8State, count: number, inputs: Inputs = IDLE): S8State {
  let s = state;
  for (let i = 0; i < count; i += 1) {
    s = s8Game.step(s, inputs);
  }
  return s;
}

/** 一步之後兩人在縫座標系裡的位置（縫剛好轉到角度 0）。 */
function after(state: S8State): S8State {
  return s8Game.step(state, IDLE);
}

describe('S-8 掃射｜初始', () => {
  it('開局：tick 0、一局 2700 tick、分數 0 比 0、兩人離中心 40 且相差 180 度、都沒有被打中也沒有無敵', () => {
    const s = s8Game.init(0, CONFIG);
    expect(s.tick).toBe(0);
    expect(s.maxTicks).toBe(DURATION_TICKS);
    expect(DURATION_TICKS).toBe(2700);
    expect(s8Game.score(s)).toEqual([0, 0]);
    expect(s8Game.isOver(s)).toBe(false);
    expect(s8Game.winner(s)).toBeNull();
    for (const p of s.players) {
      expect(Math.hypot(p.x - CX, p.y - CY)).toBeCloseTo(START_R, 9);
      expect(p.hits).toBe(0);
      expect(p.invuln).toBe(0);
      expect(p.pts).toBe(0);
      expect(p.bumpAt).toBe(-1);
      expect(p.lane).toBe(START_R);
      expect(p.hold).toBe(0);
    }
  });

  it('起始位置對稱（轉 180 度）：種子 0 到 49，1 號邊正好是 0 號邊繞中心轉 180 度', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const [a, b] = s8Game.init(seed, CONFIG).players;
      expect(b.x).toBeCloseTo(2 * CX - a.x, 9);
      expect(b.y).toBeCloseTo(2 * CY - a.y, 9);
    }
  });

  it('縫的起始角度由種子決定：種子 0 到 9 不全相同；同一個種子 init 兩次完全相同；起點偏移也不全相同', () => {
    const states = Array.from({ length: 10 }, (_, seed) => s8Game.init(seed, CONFIG));
    expect(new Set(states.map((s) => s.slit.angle)).size).toBeGreaterThan(5);
    expect(new Set(states.map((s) => s.players[0].x)).size).toBeGreaterThan(5);
    expect(s8Game.init(3, CONFIG)).toEqual(s8Game.init(3, CONFIG));
    expect(JSON.parse(JSON.stringify(states[4]))).toEqual(states[4]);
  });

  it('maxTicks：比 2700 短就用短的、比 2700 長還是 2700；小於 600 丟 RangeError（600 可以）', () => {
    expect(s8Game.init(0, { maxTicks: 3600, params: {} }).maxTicks).toBe(2700);
    expect(s8Game.init(0, { maxTicks: 1000, params: {} }).maxTicks).toBe(1000);
    expect(s8Game.init(0, { maxTicks: MIN_TICKS, params: {} }).maxTicks).toBe(600);
    expect(() => s8Game.init(0, { maxTicks: MIN_TICKS - 1, params: {} })).toThrow(RangeError);
  });
});

describe('S-8 掃射｜縫的轉速', () => {
  it('ω(t) = 0.020 + 0.012 × t / maxTicks：起始 0.020、一半 0.026、結束 0.032', () => {
    expect(omegaAt(0, 2700)).toBe(0.02);
    expect(omegaAt(1350, 2700)).toBeCloseTo(0.026, 12);
    expect(omegaAt(2700, 2700)).toBeCloseTo(0.032, 12);
    expect(OMEGA_START).toBe(0.02);
    expect(OMEGA_GAIN).toBe(0.012);
  });

  it('maxTicks 不是 2700 時爬升按比例：maxTicks 600 的一半（300）也是 0.026', () => {
    expect(omegaAt(300, 600)).toBeCloseTo(0.026, 12);
    expect(omegaAt(600, 600)).toBeCloseTo(0.032, 12);
  });

  it('縫每個 tick 轉 ω(tick)（順時針：角度增加）；整場轉了 ω 的總和，不受玩家影響', () => {
    let s = makeState({ tick: 100, angle: 1 });
    const start = s.slit.angle;
    let expected = 0;
    for (let i = 0; i < 50; i += 1) {
      expected += omegaAt(s.tick, s.maxTicks);
      s = s8Game.step(s, [press({ up: true }), press({ left: true })]);
    }
    expect(s.slit.angle - start).toBeCloseTo(expected, 12);
    expect(s.slit.angle).toBeGreaterThan(start);
  });

  it('要一直跟上縫需要切向速度 ω × r：起始時 r = 75 剛好 1.5（最大速度），結束時 r = 47 約 1.5', () => {
    expect(omegaAt(0, 2700) * 75).toBeCloseTo(1.5, 9);
    expect(omegaAt(2700, 2700) * 47).toBeCloseTo(1.5, 1);
  });
});

describe('S-8 掃射｜縫內／縫外判定', () => {
  it('（邊界）橫向距離剛好 4 在縫裡，多一點點就不在；兩側對稱', () => {
    expect(inSlitAt(...xy(at(0, 40, 4)), 0)).toBe(true);
    expect(inSlitAt(...xy(at(0, 40, -4)), 0)).toBe(true);
    expect(inSlitAt(...xy(at(0, 40, 4.001)), 0)).toBe(false);
    expect(inSlitAt(...xy(at(0, 40, -4.001)), 0)).toBe(false);
    expect(SLIT_HALF).toBe(4);
  });

  it('（邊界）沿縫的距離剛好 10 與剛好 90 在縫裡，10 以內、90 以外不在', () => {
    expect(inSlitAt(...xy(at(Math.PI / 2, R_MIN, 0)), Math.PI / 2)).toBe(true);
    expect(inSlitAt(...xy(at(Math.PI / 2, R_MIN - 0.01, 0)), Math.PI / 2)).toBe(false);
    expect(inSlitAt(...xy(at(Math.PI / 2, R_MAX, 0)), Math.PI / 2)).toBe(true);
    expect(inSlitAt(...xy(at(Math.PI / 2, R_MAX + 0.01, 0)), Math.PI / 2)).toBe(false);
    expect(R_MIN).toBe(10);
    expect(R_MAX).toBe(90);
  });

  it('縫是一條射線，不是穿過中心的直線：中心另一側（沿縫的距離是負的）不在縫裡', () => {
    expect(inSlitAt(...xy(at(0, -40, 0)), 0)).toBe(false);
    expect(inSlitAt(...xy(at(0, 0, 0)), 0)).toBe(false);
  });

  it('slitCoords：沿縫是離中心的投影、橫向是垂直的距離（正的是縫轉向的那一側）', () => {
    const c = slitCoords(CX + 30, CY + 3, 0);
    expect(c.along).toBeCloseTo(30, 12);
    expect(c.lat).toBeCloseTo(3, 12);
    const d = slitCoords(CX, CY + 30, Math.PI / 2);
    expect(d.along).toBeCloseTo(30, 12);
    expect(d.lat).toBeCloseTo(0, 12);
  });

  it('step 用縫「轉完這個 tick 之後」的角度判定：橫向距離剛好 4 在縫裡不被打中，4.001 被打中', () => {
    const edge = makeState({ angle: PRE, players: [at(0, 40, 4), at(0, 70, 0)] });
    expect(after(edge).players[0].hits).toBe(0);
    const outside = makeState({ angle: PRE, players: [at(0, 40, 4.001), at(0, 70, 0)] });
    expect(after(outside).players[0].hits).toBe(1);
    const inner = makeState({ angle: PRE, players: [at(0, R_MIN, 0), at(0, 70, 0)] });
    expect(after(inner).players[0].hits).toBe(0);
    // 縫朝下（角度 π / 2）才放得下 r = 90：往右最遠只到 x = 147
    const down = Math.PI / 2;
    const tooFar = makeState({ angle: down - OMEGA_START, players: [at(down, 40, 0), at(down, R_MAX + 0.01, 0)] });
    expect(after(tooFar).players[1].hits).toBe(1);
    const farthest = makeState({ angle: down - OMEGA_START, players: [at(down, 40, 0), at(down, R_MAX - 0.01, 0)] });
    expect(after(farthest).players[1].hits).toBe(0);
  });
});

describe('S-8 掃射｜移動', () => {
  it('八方向 1.5（斜向合速度也是 1.5）、按住 a 是 0.6；上一個 tick 的速度記在 vx、vy', () => {
    const base = makeState({ angle: PRE, players: [{ x: 40, y: 40 }, { x: 110, y: 180 }] });
    const right = s8Game.step(base, [press({ right: true }), NONE]).players[0];
    expect(right.x).toBeCloseTo(41.5, 9);
    expect(right.vx).toBeCloseTo(1.5, 9);
    const diagonal = s8Game.step(base, [press({ right: true, down: true }), NONE]).players[0];
    expect(Math.hypot(diagonal.x - 40, diagonal.y - 40)).toBeCloseTo(1.5, 9);
    expect(diagonal.vx).toBeCloseTo(diagonal.vy, 9);
    const slow = s8Game.step(base, [press({ left: true, a: true }), NONE]).players[0];
    expect(slow.x).toBeCloseTo(39.4, 9);
    const stopped = s8Game.step(s8Game.step(base, [press({ right: true }), NONE]), IDLE).players[0];
    expect(stopped.vx).toBe(0);
  });

  it('（邊界）夾在場地內：半徑 3，所以 x 在 [3, 147]、y 在 [3, 217]', () => {
    const corner = makeState({ angle: PRE, players: [{ x: 4, y: 4 }, { x: 146, y: 216 }] });
    const s = run(corner, 5, [press({ left: true, up: true }), press({ right: true, down: true })]);
    expect(s.players[0].x).toBe(3);
    expect(s.players[0].y).toBe(3);
    expect(s.players[1].x).toBe(FIELD_W - 3);
    expect(s.players[1].y).toBe(FIELD_H - 3);
  });

  it('b 鍵沒有作用（沒有別的鍵）', () => {
    const base = makeState({ angle: PRE, players: [{ x: 40, y: 40 }, { x: 110, y: 180 }] });
    const s = s8Game.step(base, [press({ b: true }), press({ b: true })]);
    expect(s.players[0].x).toBe(40);
    expect(s.players[0].y).toBe(40);
  });
});

describe('S-8 掃射｜得分（與離中心的距離成正比）', () => {
  it('在縫裡每個 tick 得 r / 200 分（每 10 tick 得 r / 20）：r = 20、40、60 各得 0.1、0.2、0.3，不取整', () => {
    for (const r of [20, 40, 60]) {
      const s = after(makeState({ angle: PRE, players: [at(0, r, 0), at(0, r + 20, 0)] }));
      expect(s.players[0].pts).toBeCloseTo(r / SCORE_DIV, 12);
    }
    expect(SCORE_DIV).toBe(200);
  });

  it('r = 60 的 10 個 tick 是 3 分、r = 20 的 10 個 tick 是 1 分（3 倍）', () => {
    let far = 0;
    let near = 0;
    for (let i = 0; i < 10; i += 1) {
      const a = -omegaAt(i, 2700);
      const s = s8Game.step(
        makeState({ tick: i, angle: a, players: [at(0, 60, 0), at(0, 20, 0)] }),
        IDLE,
      );
      far += s.players[0].pts;
      near += s.players[1].pts;
    }
    expect(far).toBeCloseTo(3, 9);
    expect(near).toBeCloseTo(1, 9);
  });

  it('不在縫裡不得分；累計是疊加的（上一個 tick 的 pts 保留）', () => {
    const s = after(makeState({ angle: PRE, players: [{ x: CX + 2, y: CY + 2, pts: 1.5 }, { ...at(0, 40, 0), pts: 2 }] }));
    expect(s.players[0].pts).toBe(1.5);
    expect(s.players[1].pts).toBeCloseTo(2.2, 12);
  });

  it('分數 = 縫內得分 − 5 × 被打中次數（兩邊各算各的）', () => {
    const s = makeState({
      players: [
        { pts: 12.5, hits: 2 },
        { pts: 3, hits: 0 },
      ],
    });
    expect(s8Game.score(s)).toEqual([12.5 - HIT_PENALTY * 2, 3]);
    expect(HIT_PENALTY).toBe(5);
  });
});

describe('S-8 掃射｜被打中與無敵', () => {
  it('不在縫裡又沒有無敵：命中數 +1、扣 5 分、接下來 45 tick 無敵；在縫裡的另一個人不受影響', () => {
    const s = after(makeState({ angle: PRE, players: [{ x: CX + 2, y: CY + 2 }, at(0, 40, 0)] }));
    expect(s.players[0].hits).toBe(1);
    expect(s.players[0].invuln).toBe(INVULN_TICKS);
    expect(INVULN_TICKS).toBe(45);
    expect(s8Game.score(s)[0]).toBe(-5);
    expect(s.players[1].hits).toBe(0);
    expect(s.players[1].invuln).toBe(0);
  });

  it('無敵 45 個 tick：第 2 到 46 個 tick 不會再被打中，第 47 個 tick 又被打中（站在中心附近不動）', () => {
    let s = makeState({ angle: PRE, players: [{ x: CX + 2, y: CY + 2 }, { x: 140, y: 20 }] });
    s = run(s, 1);
    expect(s.players[0].hits).toBe(1);
    s = run(s, 45);
    expect(s.players[0].hits).toBe(1);
    expect(s.players[0].invuln).toBe(0);
    s = run(s, 1);
    expect(s.players[0].hits).toBe(2);
    expect(s.players[0].invuln).toBe(INVULN_TICKS);
  });

  it('無敵期間不得分（就算人在縫裡），每個 tick 無敵減 1；無敵結束後的下一個 tick 又開始得分', () => {
    const shielded = after(makeState({ angle: PRE, players: [{ ...at(0, 40, 0), invuln: 2 }, at(0, 70, 0)] }));
    expect(shielded.players[0].pts).toBe(0);
    expect(shielded.players[0].invuln).toBe(1);
    expect(shielded.players[0].hits).toBe(0);
    const last = s8Game.step(
      makeState({ tick: 1, angle: -omegaAt(1, 2700), players: [{ ...at(0, 40, 0), invuln: 1 }, at(0, 70, 0)] }),
      IDLE,
    );
    expect(last.players[0].pts).toBe(0);
    expect(last.players[0].invuln).toBe(0);
    const resumed = s8Game.step(
      makeState({ tick: 2, angle: -omegaAt(2, 2700), players: [at(0, 40, 0), at(0, 70, 0)] }),
      IDLE,
    );
    expect(resumed.players[0].pts).toBeCloseTo(0.2, 12);
  });

  it('無敵期間可以任意走位，穿過光幕回到縫裡；無敵剛好結束時人已經在縫裡，就不會被打中、之後照常得分', () => {
    // 縫每個 tick 被歸位成「這一步剛好轉到角度 0」，人從橫向 −14（縫外）起走：無敵 8 個 tick，往縫走 1.5 × 8 = 12 像素，到橫向 −2
    const pin = (s: S8State): S8State => ({ ...s, tick: 0, slit: { angle: PRE } });
    let s = makeState({ angle: PRE, players: [{ ...at(0, 40, -14), invuln: 8 }, at(0, 70, 0)] });
    for (let i = 0; i < 8; i += 1) {
      s = pin(s8Game.step(s, [press({ down: true }), NONE]));
    }
    expect(s.players[0].hits).toBe(0);
    expect(s.players[0].invuln).toBe(0);
    expect(slitCoords(s.players[0].x, s.players[0].y, 0).lat).toBeCloseTo(-2, 9);
    for (let i = 0; i < 5; i += 1) {
      s = pin(s8Game.step(s, IDLE));
    }
    expect(s.players[0].hits).toBe(0);
    expect(s.players[0].pts).toBeCloseTo(5 * 0.2, 9);
  });

  it('命中是各算各的：1 號邊被打中不影響 0 號邊', () => {
    const s = after(makeState({ angle: PRE, players: [at(0, 40, 0), { x: CX + 2, y: CY - 2 }] }));
    expect(s.players[0].hits).toBe(0);
    expect(s.players[1].hits).toBe(1);
  });
});

describe('S-8 掃射｜兩個玩家互相是實心的', () => {
  it('圓心距離小於 9 就把重疊平分地推開：各退一半，中點不動，推完距離剛好 9', () => {
    const s = after(makeState({ angle: PRE, players: [{ x: 60, y: 150 }, { x: 65, y: 150 }] }));
    const [a, b] = s.players;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(BODY_DIST, 9);
    expect(a.x).toBeCloseTo(58, 9);
    expect(b.x).toBeCloseTo(67, 9);
    expect((a.x + b.x) / 2).toBeCloseTo(62.5, 9);
    expect(a.y).toBeCloseTo(150, 9);
    expect(BODY_DIST).toBe(9);
  });

  it('（邊界）距離剛好 9 不碰撞；8.99 碰撞；碰撞時兩邊的 bumpAt 都記下這個 tick', () => {
    const exact = after(makeState({ angle: PRE, players: [{ x: 60, y: 150 }, { x: 69, y: 150 }] }));
    expect(exact.players[0].x).toBe(60);
    expect(exact.players[0].bumpAt).toBe(-1);
    const close = after(makeState({ tick: 7, angle: PRE, players: [{ x: 60, y: 150 }, { x: 68.99, y: 150 }] }));
    expect(close.players[0].x).toBeLessThan(60);
    expect(close.players[0].bumpAt).toBe(8);
    expect(close.players[1].bumpAt).toBe(8);
  });

  it('兩人在同一點：推開的方向是決定的，不會出現 NaN，推完距離 9', () => {
    const s = after(makeState({ angle: PRE, players: [{ x: 70, y: 150 }, { x: 70, y: 150 }] }));
    const [a, b] = s.players;
    expect(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(BODY_DIST, 9);
  });

  it('推開之後仍在場地內（兩人擠在角落）', () => {
    const s = run(
      makeState({ angle: PRE, players: [{ x: 4, y: 4 }, { x: 6, y: 4 }] }),
      10,
      [press({ left: true }), press({ left: true })],
    );
    for (const p of s.players) {
      expect(p.x).toBeGreaterThanOrEqual(3);
      expect(p.y).toBeGreaterThanOrEqual(3);
    }
  });

  it('縫裡擠不下並排：兩人在同一個沿縫位置、橫向各 3.9，被推開之後兩人都出了縫、都被打中', () => {
    const s = after(makeState({ angle: PRE, players: [at(0, 40, -3.9), at(0, 40, 3.9)] }));
    expect(s.players[0].hits).toBe(1);
    expect(s.players[1].hits).toBe(1);
    expect(s8Game.score(s)).toEqual([-5, -5]);
  });

  it('一前一後擠得下：沿縫相差 10（≥ 9）、都在中線上，兩人都在縫裡、都得分、沒有人被打中', () => {
    const s = after(makeState({ angle: PRE, players: [at(0, 40, 0), at(0, 50, 0)] }));
    expect(s.players[0].hits + s.players[1].hits).toBe(0);
    expect(s.players[0].pts).toBeCloseTo(0.2, 12);
    expect(s.players[1].pts).toBeCloseTo(0.25, 12);
  });

  it('用身體擠：內側的人從後面貼上來，外側的人被推得更外側（各退一半），內側的人也被往回推', () => {
    // 內側 31、外側 40（差 9），內側往外走 1.5 之後差 7.5，推開 0.75 各
    const s = after(
      makeState({ angle: PRE, players: [at(0, 31, 0), at(0, 40, 0)] }),
    );
    expect(slitCoords(s.players[1].x, s.players[1].y, 0).along).toBeCloseTo(40, 9);
    const pushed = s8Game.step(
      makeState({ angle: PRE, players: [at(0, 31, 0), at(0, 40, 0)] }),
      [press({ right: true }), NONE],
    );
    expect(slitCoords(pushed.players[1].x, pushed.players[1].y, 0).along).toBeCloseTo(40.75, 9);
    expect(slitCoords(pushed.players[0].x, pushed.players[0].y, 0).along).toBeCloseTo(31.75, 9);
  });
});

describe('S-8 掃射｜公開的數字（AI 讀對手用，不讀對手「現在」的位置）', () => {
  it('lane 是在縫裡的半徑的移動平均（時間常數 30 tick），只在縫裡更新；不在縫裡不變', () => {
    const inside = after(makeState({ angle: PRE, players: [{ ...at(0, 50, 0), lane: 20 }, at(0, 80, 0)] }));
    expect(inside.players[0].lane).toBeCloseTo(20 + (50 - 20) / LANE_TAU, 9);
    const outside = after(makeState({ angle: PRE, players: [{ x: CX + 2, y: CY + 2, lane: 20 }, at(0, 80, 0)] }));
    expect(outside.players[0].lane).toBe(20);
  });

  it('hold 是「在縫裡」的移動平均（0 到 1）：在縫裡往 1 走、不在縫裡往 0 走', () => {
    const up = after(makeState({ angle: PRE, players: [{ ...at(0, 50, 0), hold: 0.4 }, at(0, 80, 0)] }));
    expect(up.players[0].hold).toBeCloseTo(0.4 + 0.6 / LANE_TAU, 9);
    const down = after(makeState({ angle: PRE, players: [{ x: CX + 2, y: CY + 2, hold: 0.4 }, at(0, 80, 0)] }));
    expect(down.players[0].hold).toBeCloseTo(0.4 - 0.4 / LANE_TAU, 9);
  });
});

describe('S-8 掃射｜結束與分數', () => {
  it('時間到（tick = maxTicks）才結束；結束前 winner 是 null；分數高的贏、同分平手', () => {
    const early = makeState({ tick: 2699, players: [{ pts: 9 }, { pts: 3 }] });
    expect(s8Game.isOver(early)).toBe(false);
    expect(s8Game.winner(early)).toBeNull();
    const done = makeState({ tick: 2700, players: [{ pts: 9 }, { pts: 3 }] });
    expect(s8Game.isOver(done)).toBe(true);
    expect(s8Game.winner(done)).toBe(0);
    expect(s8Game.winner(makeState({ tick: 2700, players: [{ pts: 3 }, { pts: 9 }] }))).toBe(1);
    expect(s8Game.winner(makeState({ tick: 2700, players: [{ pts: 5 }, { pts: 5 }] }))).toBeNull();
    // 得分多但被打中更多：看 score
    expect(s8Game.winner(makeState({ tick: 2700, players: [{ pts: 20, hits: 4 }, { pts: 3 }] }))).toBe(1);
  });

  it('結束之後再 step，state 原樣不變（同一個物件）', () => {
    const done = makeState({ tick: 2700 });
    expect(s8Game.step(done, IDLE)).toBe(done);
  });

  it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，含碰撞與被打中的那一次）', () => {
    const s = deepFreeze(makeState({ angle: PRE, players: [{ x: 60, y: 150 }, { x: 64, y: 150 }] }));
    expect(() => s8Game.step(s, [press({ right: true }), press({ left: true })])).not.toThrow();
    expect(s.players[0].x).toBe(60);
    expect(s.players[0].hits).toBe(0);
  });

  it('K1：同一個種子、同一串輸入跑兩次結果相同；整個 state 可以 JSON 來回', () => {
    const play = (): S8State => {
      let s = s8Game.init(5, CONFIG);
      for (let i = 0; i < 300; i += 1) {
        s = s8Game.step(s, [press({ right: i % 3 === 0, up: i % 5 === 0 }), press({ left: i % 4 === 0 })]);
      }
      return s;
    };
    expect(play()).toEqual(play());
    expect(JSON.parse(JSON.stringify(play()))).toEqual(play());
  });

  it('整場跑完：2700 個 tick 之後 isOver，score 是有限的數', () => {
    let s = s8Game.init(1, CONFIG);
    for (let i = 0; i < 3000 && !s8Game.isOver(s); i += 1) {
      s = s8Game.step(s, IDLE);
    }
    expect(s.tick).toBe(2700);
    expect(s8Game.isOver(s)).toBe(true);
    for (const v of s8Game.score(s)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('S-8 掃射｜actions', () => {
  it('17 個動作（全放開排第一、八方向全速、八方向加 a），沒有 b；兩邊一樣', () => {
    const s = makeState();
    const a = s8Game.actions(s, 0);
    expect(a).toHaveLength(17);
    expect(Object.values(a[0] as Buttons).every((v) => v === false)).toBe(true);
    expect(a.every((x) => x.b === false)).toBe(true);
    expect(a.filter((x) => x.a)).toHaveLength(8);
    expect(s8Game.actions(s, 1)).toEqual(a);
    expect(new Set(a.map((x) => JSON.stringify(x))).size).toBe(17);
  });
});

describe('S-8 掃射｜evaluate', () => {
  /** 縫在角度 0、tick 500；人（0 號）在縫裡沿縫 `along`、橫向 `lat`，速度 (0, ω r) 剛好跟著縫走；AI 公開的 lane／hold 自己給。 */
  function scene(
    me: { along: number; lat: number },
    opp: { lane: number; hold: number; x?: number; y?: number; vx?: number; vy?: number; invuln?: number },
    extra: Partial<{ pts: [number, number]; hits: [number, number] }> = {},
  ): S8State {
    const w = omegaAt(500, 2700);
    return makeState({
      tick: 500,
      angle: 0,
      players: [
        { ...at(0, me.along, me.lat), vx: 0, vy: w * me.along, hold: 1, lane: me.along, pts: extra.pts?.[0] ?? 0, hits: extra.hits?.[0] ?? 0 },
        {
          x: opp.x ?? at(0, opp.lane, 0).x,
          y: opp.y ?? at(0, opp.lane, 0).y,
          vx: opp.vx ?? 0,
          vy: opp.vy ?? 0,
          lane: opp.lane,
          hold: opp.hold,
          invuln: opp.invuln ?? 0,
          pts: extra.pts?.[1] ?? 0,
          hits: extra.hits?.[1] ?? 0,
        },
      ],
    });
  }
  const ABSENT = { lane: 40, hold: 0, x: 140, y: 20 };

  it('danger 在 0 到 1、gain 是有限的數；往縫外走到底的人 danger 是 1', () => {
    const e = s8Game.evaluate(scene({ along: 40, lat: 0 }, ABSENT), 0);
    expect(e.danger).toBeGreaterThanOrEqual(0);
    expect(e.danger).toBeLessThanOrEqual(1);
    expect(Number.isFinite(e.gain)).toBe(true);
    const lost = makeState({ tick: 500, angle: 0, players: [{ x: 20, y: 200, vx: 0, vy: 0 }, { x: 140, y: 20 }] });
    expect(s8Game.evaluate(lost, 0).danger).toBe(1);
  });

  it('跟著縫走的人 danger 低；站著不動的人（縫轉走）danger 是 1', () => {
    const tracking = scene({ along: 40, lat: 0 }, ABSENT);
    expect(s8Game.evaluate(tracking, 0).danger).toBeLessThan(0.3);
    const standing = { ...tracking, players: [{ ...tracking.players[0], vx: 0, vy: 0 }, tracking.players[1]] } as S8State;
    expect(s8Game.evaluate(standing, 0).danger).toBe(1);
  });

  it('領先 1 分，gain 多 1000（單位是分），danger 不變；對方領先則少 1000', () => {
    const base = s8Game.evaluate(scene({ along: 40, lat: 0 }, ABSENT), 0);
    const ahead = s8Game.evaluate(scene({ along: 40, lat: 0 }, ABSENT, { pts: [3, 0] }), 0);
    expect(ahead.gain - base.gain).toBeCloseTo(3000, 6);
    expect(ahead.danger).toBe(base.danger);
    const behind = s8Game.evaluate(scene({ along: 40, lat: 0 }, ABSENT, { pts: [0, 3] }), 0);
    expect(behind.gain - base.gain).toBeCloseTo(-3000, 6);
    // 被打中扣的 5 分也是同一把尺
    const hit = s8Game.evaluate(scene({ along: 40, lat: 0 }, ABSENT, { hits: [1, 0] }), 0);
    expect(hit.gain - base.gain).toBeCloseTo(-5000, 6);
  });

  it('沒有橡皮筋：兩邊的分數同時加上同一個常數（含被打中次數），evaluate 與 actions 完全不變', () => {
    const a = scene({ along: 40, lat: 1 }, { lane: 55, hold: 1 });
    const b = scene({ along: 40, lat: 1 }, { lane: 55, hold: 1 }, { pts: [50, 50], hits: [2, 2] });
    for (const side of [0, 1] as const) {
      expect(s8Game.evaluate(b, side)).toEqual(s8Game.evaluate(a, side));
      expect(s8Game.actions(b, side)).toEqual(s8Game.actions(a, side));
    }
  });

  it('AI 只讀對手公開的 lane 與 hold，不讀它「現在」的位置與速度（AI 看到的對手是舊的）：改 x、y、vx、vy，evaluate 完全相同', () => {
    const near = scene({ along: 40, lat: 1 }, { lane: 55, hold: 1 });
    const moved = scene({ along: 40, lat: 1 }, { lane: 55, hold: 1, x: 20, y: 200, vx: 1.5, vy: -1.5 });
    expect(s8Game.evaluate(moved, 0)).toEqual(s8Game.evaluate(near, 0));
  });

  it('對手貼上來，danger 上升：同樣的位置與速度，對手占著離我 5 像素的外側時，預測會被擠出縫，danger 比沒有對手時高', () => {
    const alone = s8Game.evaluate(scene({ along: 45, lat: 2.4 }, ABSENT), 0);
    const squeezed = s8Game.evaluate(scene({ along: 45, lat: 2.4 }, { lane: 50, hold: 1 }), 0);
    expect(alone.danger).toBeLessThanOrEqual(0.3);
    expect(squeezed.danger).toBeGreaterThan(alone.danger + 0.1);
  });

  it('對手離得遠（超過 9 像素的外側或內側）不影響 danger', () => {
    const alone = s8Game.evaluate(scene({ along: 45, lat: 2.4 }, ABSENT), 0);
    const farOut = s8Game.evaluate(scene({ along: 45, lat: 2.4 }, { lane: 70, hold: 1 }), 0);
    const farIn = s8Game.evaluate(scene({ along: 45, lat: 2.4 }, { lane: 25, hold: 1 }), 0);
    expect(farOut.danger).toBe(alone.danger);
    expect(farIn.danger).toBe(alone.danger);
  });

  it('搶位的誘因：兩人都在縫裡，我在外側的 gain 比對手不在縫裡時多（最多 6）；我在內側則沒有', () => {
    const none = s8Game.evaluate(scene({ along: 50, lat: 0 }, { lane: 35, hold: 0.2 }), 0).gain;
    const outer = s8Game.evaluate(scene({ along: 50, lat: 0 }, { lane: 35, hold: 1 }), 0).gain;
    expect(outer - none).toBeGreaterThan(5);
    expect(outer - none).toBeLessThanOrEqual(6 + 1e-9);
    const noneIn = s8Game.evaluate(scene({ along: 30, lat: 0 }, { lane: 50, hold: 0.2 }), 0).gain;
    const inner = s8Game.evaluate(scene({ along: 30, lat: 0 }, { lane: 50, hold: 1 }), 0).gain;
    expect(inner - noneIn).toBeCloseTo(0, 9);
  });

  it('預測的窗口是「無敵結束之後的 HORIZON 個 tick」：無敵 30 個 tick（比 HORIZON 長）、站在縫外的人，danger 仍然是 1（不是因為無敵就當作安全）', () => {
    const shielded = makeState({ tick: 500, angle: 0, players: [{ x: 20, y: 200, invuln: 30 }, { x: 140, y: 20 }] });
    expect(s8Game.evaluate(shielded, 0).danger).toBe(1);
    expect(HORIZON).toBe(10); // 小規格的起始值是 24；實測改成 10（docs/cards/S-8.md「HORIZON」）
  });

  it('結束的局：gain 是分差 × 1000、danger 是 0', () => {
    const done = makeState({ tick: 2700, players: [{ pts: 10 }, { pts: 4 }] });
    expect(s8Game.evaluate(done, 0)).toEqual({ gain: 6000, danger: 0 });
    expect(s8Game.evaluate(done, 1)).toEqual({ gain: -6000, danger: 0 });
  });
});
