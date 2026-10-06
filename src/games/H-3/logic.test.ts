import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { playMatch } from '../../core/match';
import type { Buttons, Inputs } from '../../core/types';
import { IDLE, PRESS_A, ROUNDS, ROUND_PAUSE } from '../_hearts/logic';
import { brakeDistance, h3Game, makeState, TRACK, V0_MAX, V0_MIN } from './logic';
import type { H3State, Runner } from './logic';

/**
 * H-3 懸崖的規則測試（TEST_PLAN 第 6 節 H-3 的 8 條，加上邊界、煞車距離的公式、AI 能不能玩）。
 * 全部用 `makeState` 直接構造局面。位置與速度的單位是「千分之一像素」（1 像素 = 1000）。
 */

const CONFIG = { maxTicks: 3600, params: {} };

const running = (pos: number, speed: number, age = 0): Runner => ({
  status: 'running',
  pos,
  speed,
  age,
});
const braking = (pos: number, speed: number): Runner => ({ status: 'braking', pos, speed, age: 0 });
const stopped = (pos: number): Runner => ({ status: 'stopped', pos, speed: 0, age: 0 });
const fallen = (pos: number): Runner => ({ status: 'fallen', pos, speed: 0, age: 0 });

function inputs(a0: boolean, a1: boolean): Inputs {
  return [a0 ? PRESS_A : IDLE, a1 ? PRESS_A : IDLE];
}

function stepN(state: H3State, n: number, input: Inputs): H3State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = h3Game.step(s, input);
  }
  return s;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** 單一跑者從 0 出發、第 `pressAt` 個 tick（從 1 算）按下 a（0 是從來不按），跑到結束：回傳最後的狀態與花了幾個 tick。 */
function runOne(v0: number, pressAt: number): { runner: Runner; ticks: number } {
  let s = makeState({ v0, runners: [running(0, v0), fallen(0)] });
  let ticks = 0;
  while (s.runners[0].status === 'running' || s.runners[0].status === 'braking') {
    ticks += 1;
    s = h3Game.step(s, inputs(pressAt !== 0 && ticks >= pressAt, false));
    if (ticks > 2000) {
      throw new Error('跑不完');
    }
  }
  return { runner: s.runners[0], ticks };
}

describe('H-3 懸崖｜初始', () => {
  it('第 1 局、兩邊從 0 出發、速度等於起始速度、總分 0', () => {
    const s = h3Game.init(4, CONFIG);
    expect(s.round).toBe(0);
    expect(s.phase).toBe('run');
    expect(s.runners[0]).toEqual(running(0, s.v0));
    expect(s.runners[1]).toEqual(running(0, s.v0));
    expect(s.totals).toEqual([0, 0]);
    expect(h3Game.isOver(s)).toBe(false);
    expect(h3Game.winner(s)).toBeNull();
  });
});

describe('H-3 懸崖｜TEST_PLAN 第 6 節', () => {
  it('1. 不煞車：一定掉下去，這一局 0 分（不管起始速度）', () => {
    for (const v0 of [800, 900, 1000, 1100, 1200, 801, 1199]) {
      const { runner } = runOne(v0, 0);
      expect(runner.status).toBe('fallen');
      expect(runner.pos).toBeGreaterThan(TRACK);
    }
    // 整局：兩邊都不按，5 局都掉下去，總分 0。
    let s = h3Game.init(3, CONFIG);
    for (let t = 0; t < 3600 && !s.over; t += 1) {
      s = h3Game.step(s, inputs(false, false));
    }
    expect(s.over).toBe(true);
    expect(s.totals).toEqual([0, 0]);
    expect(s.roundScores).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(h3Game.winner(s)).toBeNull();
  });

  it('2. 速度每 30 tick 加 0.1（0.1 = 100）；位置每 tick 加目前的速度', () => {
    let s = makeState({ v0: 1000, runners: [running(0, 1000), running(0, 1000)] });
    let pos = 0;
    for (let t = 1; t <= 90; t += 1) {
      s = h3Game.step(s, inputs(false, false));
      pos += 1000 + 100 * Math.floor((t - 1) / 30);
      expect(s.runners[0].pos).toBe(pos);
      expect(s.runners[0].speed).toBe(1000 + 100 * Math.floor(t / 30));
    }
    expect(s.runners[0].speed).toBe(1300);
  });

  it('3. 按下 a 之後：每 tick 速度減 0.05（50），到 0 為止；之後放開或再按都沒有作用', () => {
    let s = makeState({ v0: 1000, runners: [running(0, 1000, 12), running(0, 1000, 12)] });
    s = h3Game.step(s, inputs(true, false)); // 按下
    expect(s.runners[0].status).toBe('braking');
    expect(s.runners[0].speed).toBe(950);
    expect(s.runners[1].status).toBe('running'); // 另一邊沒按，照跑
    // 放開、再按、亂按：煞車照常，每個 tick 減 50。
    const pattern = [false, true, true, false, true, false, false, true];
    let speed = 950;
    for (const pressed of pattern) {
      s = h3Game.step(s, inputs(pressed, false));
      speed -= 50;
      expect(s.runners[0].speed).toBe(speed);
      expect(s.runners[0].status).toBe('braking');
    }
    s = stepN(s, 12, inputs(false, false));
    expect(s.runners[0].status).toBe('stopped');
    expect(s.runners[0].speed).toBe(0);
    const at = s.runners[0].pos;
    // 停下來之後怎麼按都沒用。
    for (const pressed of [true, false, true, true]) {
      s = h3Game.step(s, inputs(pressed, false));
      expect(s.runners[0].pos).toBe(at);
      expect(s.runners[0].status).toBe('stopped');
    }
  });

  it('4. 停下的位置是 287.6：得 287 分（取整數部分，不四捨五入）', () => {
    // 煞車中、速度 50、位置 287.55：這個 tick 走 50 之後停在 287.6。
    const s = makeState({ runners: [braking(287550, 50), running(0, 1000)] });
    const done = h3Game.step(s, inputs(false, false));
    expect(done.runners[0]).toEqual(stopped(287600));
    expect(done.totals[0]).toBe(287);
    // 287.999 也是 287。
    const high = h3Game.step(
      makeState({ runners: [braking(287949, 50), running(0, 1000)] }),
      inputs(false, false),
    );
    expect(high.runners[0].pos).toBe(287999);
    expect(high.totals[0]).toBe(287);
  });

  it('5.（邊界）停在剛好 300.0：得 300 分；超過 300（再多 0.001）：掉下去，0 分', () => {
    const exact = h3Game.step(
      makeState({ runners: [braking(299950, 50), running(0, 1000)] }),
      inputs(false, false),
    );
    expect(exact.runners[0]).toEqual(stopped(300000));
    expect(exact.totals[0]).toBe(300);

    const over = h3Game.step(
      makeState({ runners: [braking(299951, 50), running(0, 1000)] }),
      inputs(false, false),
    );
    expect(over.runners[0].status).toBe('fallen');
    expect(over.totals[0]).toBe(0);

    // 還在跑、剛好踩在 300.0：還沒掉；再走一步才掉。
    let s = makeState({ runners: [running(299200, 800), running(0, 1000)] });
    s = h3Game.step(s, inputs(false, false));
    expect(s.runners[0].pos).toBe(300000);
    expect(s.runners[0].status).toBe('running');
    s = h3Game.step(s, inputs(false, false));
    expect(s.runners[0].status).toBe('fallen');

    // 煞車中衝過邊緣也是掉下去（不是等停下來才算）。
    const crossing = h3Game.step(
      makeState({ runners: [braking(299600, 500), running(0, 1000)] }),
      inputs(false, false),
    );
    expect(crossing.runners[0].status).toBe('fallen');
    expect(crossing.totals[0]).toBe(0);
  });

  it('6. 兩邊同一局的起始速度相同，在 0.8 到 1.2 之間（1000 個種子；之後每一局也是）', () => {
    for (let seed = 0; seed < 1000; seed += 1) {
      const s = h3Game.init(seed, CONFIG);
      expect(s.v0).toBeGreaterThanOrEqual(V0_MIN);
      expect(s.v0).toBeLessThanOrEqual(V0_MAX);
      expect(s.runners[0].speed).toBe(s.v0);
      expect(s.runners[1].speed).toBe(s.v0);
    }
    for (let seed = 0; seed < 30; seed += 1) {
      let s = h3Game.init(seed, CONFIG);
      let round = 0;
      const seen = [s.v0];
      for (let t = 0; t < 3600 && !s.over; t += 1) {
        s = h3Game.step(s, inputs(s.roundTick > 40, s.roundTick > 60));
        if (s.round !== round) {
          round = s.round;
          seen.push(s.v0);
          expect(s.runners[0].speed).toBe(s.v0);
          expect(s.runners[1].speed).toBe(s.v0);
        }
      }
      expect(seen).toHaveLength(ROUNDS);
      for (const v of seen) {
        expect(v).toBeGreaterThanOrEqual(800);
        expect(v).toBeLessThanOrEqual(1200);
      }
    }
  });

  it('7. 煞車距離的公式與模擬結果一致（5 個起始速度，誤差小於 1 像素；精確公式誤差是 0）', () => {
    const speeds = [800, 900, 1000, 1100, 1200];
    for (const v of speeds) {
      // 逐 tick 模擬：從 0 出發、第一個 tick 就按下 a。
      const { runner } = runOne(v, 1);
      expect(runner.status).toBe('stopped');
      const simulated = runner.pos / 1000;
      const exact = brakeDistance(v) / 1000;
      const speedPx = v / 1000;
      const continuous = (speedPx * speedPx) / (2 * 0.05) + speedPx / 2;
      const plain = (speedPx * speedPx) / (2 * 0.05);
      expect(exact).toBe(simulated);
      expect(Math.abs(continuous - simulated)).toBeLessThan(0.01);
      expect(Math.abs(plain - simulated)).toBeLessThan(1);
    }
    // 除不盡的速度（不是 50 的倍數）也一致。
    for (const v of [801, 873, 937, 1037, 1163, 1199]) {
      const { runner } = runOne(v, 1);
      expect(brakeDistance(v)).toBe(runner.pos);
      expect(Math.abs((v * v) / 100 + v / 2 - runner.pos)).toBeLessThan(7);
    }
    // 路上已經加速過：從跑了 100 tick 的局面按下。
    const v = 1300;
    const start = makeState({ runners: [running(150000, v, 100), fallen(0)] });
    let s = start;
    s = h3Game.step(s, inputs(true, false));
    while (s.runners[0].status === 'braking') {
      s = h3Game.step(s, inputs(false, false));
    }
    expect(s.runners[0].pos).toBe(150000 + brakeDistance(v));
  });

  it('8. 5 局結束：isOver，比總分；同分平手', () => {
    const base = makeState({
      round: ROUNDS - 1,
      v0: 1000,
      runners: [stopped(200000), running(250000, 1000)],
    });
    // 1 號邊這個 tick 煞車前還在跑：先讓 1 號邊停下來。
    const almost = {
      ...base,
      totals: [500, 400] as const,
      runners: [stopped(200000), braking(250900, 50)] as const,
    };
    const done = h3Game.step(almost, inputs(false, false));
    expect(done.over).toBe(true);
    expect(h3Game.isOver(done)).toBe(true);
    expect(done.phase).toBe('run');
    expect(h3Game.score(done)).toEqual([500, 400 + 250]);
    expect(h3Game.winner(done)).toBe(1);

    const tie = h3Game.step({ ...almost, totals: [500, 250] as const }, inputs(false, false));
    expect(tie.totals).toEqual([500, 500]);
    expect(h3Game.winner(tie)).toBeNull();

    const win = h3Game.step({ ...almost, totals: [900, 100] as const }, inputs(false, false));
    expect(h3Game.winner(win)).toBe(0);
    expect(h3Game.step(win, inputs(true, true))).toBe(win);
  });
});

describe('H-3 懸崖｜其他規則', () => {
  it('一邊已經結束、另一邊還在跑：這一局還沒結束；兩邊都結束才記分、停頓、進下一局（新的起始速度）', () => {
    let s = makeState({
      v0: 900,
      totals: [100, 100],
      runners: [stopped(120000), braking(299900, 100)],
    });
    s = h3Game.step(s, inputs(false, false)); // 1 號邊走 100 → 300000，速度 50
    expect(s.runners[1].status).toBe('braking');
    expect(s.phase).toBe('run');
    s = h3Game.step(s, inputs(false, false)); // 再走 50 → 300050，掉下去
    expect(s.runners[1].status).toBe('fallen');
    expect(s.phase).toBe('pause');
    expect(s.totals).toEqual([100, 100]);
    expect(s.roundScores).toEqual([[120], [0]]);

    // 停頓期間輸入被忽略。
    const paused = stepN(s, ROUND_PAUSE - 1, inputs(true, true));
    expect(paused.phase).toBe('pause');
    const next = h3Game.step(paused, inputs(true, true));
    expect(next.phase).toBe('run');
    expect(next.round).toBe(1);
    expect(next.runners[0]).toEqual(running(0, next.v0));
    expect(next.runners[1]).toEqual(running(0, next.v0));
    expect(next.roundTick).toBe(0);
  });

  it('得分在跑者結束的那個 tick 就加進總分；兩邊同一個 tick 各算各的', () => {
    const s = makeState({
      totals: [10, 20],
      runners: [braking(150950, 50), braking(299950, 50)],
    });
    const done = h3Game.step(s, inputs(false, false));
    expect(done.totals).toEqual([10 + 151, 20 + 300]);
    expect(done.phase).toBe('pause');
    expect(done.roundScores).toEqual([[151], [300]]);
  });

  it('最壞的一局（窮舉起始速度與按下的 tick）不超過 270 個 tick；5 局最壞 1530 個 tick', () => {
    let worst = 0;
    for (const v0 of [800, 801, 900, 1000, 1100, 1200]) {
      for (let pressAt = 0; pressAt <= 300; pressAt += 1) {
        worst = Math.max(worst, runOne(v0, pressAt).ticks);
      }
    }
    expect(worst).toBeLessThanOrEqual(270);
    expect(5 * 270 + 4 * ROUND_PAUSE).toBeLessThan(3600);
  });

  it('時間到（第 maxTicks 個 tick）：結束，比總分，還在跑的不算', () => {
    const s = makeState({
      maxTicks: 50,
      tick: 49,
      totals: [5, 9],
      runners: [running(100000, 1000), running(100000, 1000)],
    });
    const done = h3Game.step(s, inputs(false, false));
    expect(done.over).toBe(true);
    expect(done.totals).toEqual([5, 9]);
    expect(h3Game.winner(done)).toBe(1);
  });

  it('step 不改動傳進來的 state 與輸入（深度凍結也不丟錯）', () => {
    const s = deepFreeze(makeState({ runners: [running(10000, 1000, 3), running(0, 900)] }));
    const input = deepFreeze<Inputs>([{ ...PRESS_A }, { ...IDLE }]);
    const next = h3Game.step(s, input);
    expect(next.runners[0].status).toBe('braking');
    expect(s.runners[0].status).toBe('running');
    expect(() => h3Game.step(deepFreeze(next), input)).not.toThrow();
  });

  it('隨機事件：每局的起始速度由 RngState 推進（同一個種子的 5 局不全相同；不同種子的序列不全相同）', () => {
    const speedsOf = (seed: number): number[] => {
      let s = h3Game.init(seed, CONFIG);
      const seen = [s.v0];
      let round = 0;
      for (let t = 0; t < 3600 && !s.over; t += 1) {
        s = h3Game.step(s, inputs(s.roundTick > 20, s.roundTick > 20));
        if (s.round !== round) {
          round = s.round;
          seen.push(s.v0);
        }
      }
      return seen;
    };
    const a = speedsOf(0);
    expect(a).toHaveLength(ROUNDS);
    expect(new Set(a).size).toBeGreaterThan(1);
    expect(speedsOf(0)).toEqual(a);
    const sequences = Array.from({ length: 10 }, (_, seed) => speedsOf(seed).join(','));
    expect(new Set(sequences).size).toBeGreaterThan(1);
  });
});

describe('H-3 懸崖｜actions 與 evaluate', () => {
  it('還在跑的一邊是 [全放開, a]，全放開排第一；煞車中、停下、掉下去、停頓、整局結束時只有 [全放開]', () => {
    const live = makeState({ runners: [running(0, 1000), braking(5000, 500)] });
    expect(h3Game.actions(live, 0)).toEqual([IDLE, PRESS_A]);
    expect(h3Game.actions(live, 1)).toEqual([IDLE]);
    const ended = makeState({ runners: [stopped(1000), fallen(300500)] });
    expect(h3Game.actions(ended, 0)).toEqual([IDLE]);
    expect(h3Game.actions(ended, 1)).toEqual([IDLE]);
    expect(h3Game.actions(makeState({ phase: 'pause', pause: 5 }), 0)).toEqual([IDLE]);
    expect(h3Game.actions(makeState({ over: true }), 0)).toEqual([IDLE]);
  });

  it('evaluate：danger 在 0 到 1，gain 有限；結束的局有勝負加成', () => {
    for (const pos of [0, 100000, 250000, 290000, 299000, 300000]) {
      for (const speed of [800, 1200, 1700]) {
        const s = makeState({
          totals: [100, 50],
          runners: [running(pos, speed), braking(pos, speed)],
        });
        for (const side of [0, 1] as const) {
          const { gain, danger } = h3Game.evaluate(s, side);
          expect(Number.isFinite(gain)).toBe(true);
          expect(danger).toBeGreaterThanOrEqual(0);
          expect(danger).toBeLessThanOrEqual(1);
        }
      }
    }
    const won = makeState({ over: true, winner: 0, totals: [900, 500] });
    expect(h3Game.evaluate(won, 0).gain).toBeGreaterThan(900000);
    expect(h3Game.evaluate(won, 1).gain).toBeLessThan(-900000);
  });

  it('danger：離邊緣越近越大；煞車中的跑者「會衝出去」是 1、「停得下來」是 0', () => {
    const d = (pos: number): number =>
      h3Game.evaluate(makeState({ runners: [running(pos, 1000), running(0, 1000)] }), 0).danger;
    expect(d(50000)).toBe(0);
    expect(d(250000)).toBeLessThan(d(280000));
    expect(d(280000)).toBeLessThanOrEqual(d(290000));
    expect(d(290000)).toBe(1);
    const brake = (pos: number): number =>
      h3Game.evaluate(makeState({ runners: [braking(pos, 1000), running(0, 1000)] }), 0).danger;
    expect(brake(200000)).toBe(0);
    expect(brake(295000)).toBe(1);
  });

  it('賭徒型（領先或打平）：離邊緣還遠時不煞車，再等就會掉下去時煞車', () => {
    const decide = (pos: number, speed: number): Buttons =>
      gambler.decide(
        h3Game,
        makeState({ runners: [running(pos, speed), running(pos, speed)] }),
        0,
        0,
        { depth: 1, seed: 0 },
      );
    expect(decide(0, 1000).a).toBe(false);
    expect(decide(100000, 1000).a).toBe(false);
    expect(decide(200000, 1200).a).toBe(false);
    // 速度 1.0：煞車距離 10.5 像素；再加 16 個 tick 的延遲（16 像素）= 26.5，
    // 所以位置超過 273.5 之後再等就會掉下去。
    expect(decide(265000, 1000).a).toBe(false);
    expect(decide(280000, 1000).a).toBe(true);
    // 速度越快，煞車越早。
    expect(decide(250000, 1700).a).toBe(true);
  });

  it('已經煞車、停下、掉下去的一邊不亂按', () => {
    const s = makeState({ runners: [braking(100000, 800), running(0, 1000)] });
    expect(gambler.decide(h3Game, s, 0, 0, { depth: 1, seed: 0 })).toEqual(IDLE);
  });
});

describe('H-3 懸崖｜AI 在同時進行的牌裡', () => {
  it('等級 10 的賭徒型：起始速度 0.8 到 1.2 的每一種都能在邊緣前停下來，而且停得夠近（大於 240 分）', () => {
    for (const v0 of [800, 900, 1000, 1100, 1200]) {
      let s = makeState({ v0, runners: [running(0, v0), running(0, v0)] });
      const ai = levelController(h3Game, gambler, 10, 1);
      for (let tick = 0; tick < 600 && s.phase === 'run'; tick += 1) {
        s = h3Game.step(s, [ai.decide(s, 0, tick), IDLE]);
        if (s.runners[0].status === 'stopped' || s.runners[0].status === 'fallen') {
          break;
        }
      }
      expect(s.runners[0].status).toBe('stopped');
      expect(s.runners[0].pos).toBeGreaterThan(240000);
      expect(s.runners[0].pos).toBeLessThanOrEqual(300000);
    }
  });

  it('兩個等級 5 的賭徒型打完一整場：在 maxTicks 之內結束', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      const a = levelController(h3Game, gambler, 5, seed);
      const b = levelController(h3Game, gambler, 5, seed + 1_000_003);
      const result = playMatch(h3Game, seed, CONFIG, a, b);
      expect(result.ticks).toBeLessThanOrEqual(3600);
    }
  });
});
