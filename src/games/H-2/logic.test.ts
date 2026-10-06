import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { playMatch } from '../../core/match';
import { rngStateFor } from '../../core/rng';
import type { Buttons, Inputs } from '../../core/types';
import { IDLE, PRESS_A, PRESS_B, ROUNDS, ROUND_PAUSE } from '../_hearts/logic';
import { FUSE_MAX, FUSE_MIN, h2Game, makeState, START_LIMIT } from './logic';
import type { H2State, Racer } from './logic';

/**
 * H-2 引信的規則測試（TEST_PLAN 第 6 節 H-2 的 10 條，加上邊界、不偷看引信、AI 能不能玩）。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 */

const CONFIG = { maxTicks: 3600, params: {} };

const holding = (acc: number): Racer => ({ status: 'holding', acc });
const waiting: Racer = { status: 'idle', acc: 0 };
const banked = (acc: number): Racer => ({ status: 'banked', acc });

function inputs(a0: boolean, a1: boolean): Inputs {
  return [a0 ? PRESS_A : IDLE, a1 ? PRESS_A : IDLE];
}

function stepN(state: H2State, n: number, input: Inputs): H2State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = h2Game.step(s, input);
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

describe('H-2 引信｜初始', () => {
  it('第 1 局、兩邊都還沒按、總分 0、引信在 120 到 600 之間而且還沒公開', () => {
    const s = h2Game.init(4, CONFIG);
    expect(s.round).toBe(0);
    expect(s.phase).toBe('play');
    expect(s.players[0].status).toBe('idle');
    expect(s.players[1].status).toBe('idle');
    expect(s.totals).toEqual([0, 0]);
    expect(s.revealed).toBe(false);
    expect(s.fuse).toBeGreaterThanOrEqual(FUSE_MIN);
    expect(s.fuse).toBeLessThanOrEqual(FUSE_MAX);
    expect(h2Game.isOver(s)).toBe(false);
    expect(h2Game.winner(s)).toBeNull();
  });
});

describe('H-2 引信｜TEST_PLAN 第 6 節', () => {
  it('1. 一局開始，按住 a：累積每 tick 加 1', () => {
    let s = makeState({ fuse: 500 });
    for (let k = 1; k <= 30; k += 1) {
      s = h2Game.step(s, inputs(true, false));
      expect(s.players[0].status).toBe('holding');
      expect(s.players[0].acc).toBe(k);
    }
    expect(s.players[1].status).toBe('idle');
  });

  it('2. 放開：累積加進總分，這一局對自己結束，再按沒有作用', () => {
    const s = makeState({ fuse: 500, totals: [100, 20], players: [holding(40), waiting] });
    const released = h2Game.step(s, inputs(false, false));
    expect(released.players[0].status).toBe('banked');
    expect(released.players[0].acc).toBe(40);
    expect(released.totals).toEqual([140, 20]);
    const again = stepN(released, 10, inputs(true, false));
    expect(again.players[0].status).toBe('banked');
    expect(again.totals).toEqual([140, 20]);
  });

  it('3. 累積的 tick 數達到引信長度：爆炸，這一局得 0；連續按著，第 fuse 個 tick 炸', () => {
    let s = makeState({ fuse: 150, totals: [30, 30] });
    s = stepN(s, 149, inputs(true, false));
    expect(s.players[0].status).toBe('holding');
    expect(s.players[0].acc).toBe(149);
    s = h2Game.step(s, inputs(true, false)); // 第 150 個 tick
    expect(s.players[0].status).toBe('boom');
    expect(s.players[0].acc).toBe(0);
    expect(s.totals).toEqual([30, 30]);
    // 炸了之後再按、放開都沒有用。
    const after = stepN(s, 5, inputs(true, false));
    expect(after.players[0].status).toBe('boom');
    expect(after.totals).toEqual([30, 30]);
  });

  it('4.（邊界）開始後 60 tick 內沒按：這一局得 0；第 60 個 tick 才按下還算數', () => {
    const s = makeState({ fuse: 500, totals: [10, 10] });
    const almost = stepN(s, START_LIMIT - 1, inputs(false, false));
    expect(almost.players[0].status).toBe('idle');
    const late = h2Game.step(almost, inputs(false, false));
    expect(late.players[0].status).toBe('late');
    expect(late.players[0].acc).toBe(0);
    expect(late.totals).toEqual([10, 10]);
    // 太晚按了沒有用。
    const tooLate = stepN(late, 20, inputs(true, false));
    expect(tooLate.players[0].status).toBe('late');
    expect(tooLate.totals).toEqual([10, 10]);

    // 第 60 個 tick 剛好按下：開始累積，不算 late。
    const pressedAtLast = h2Game.step(almost, inputs(true, false));
    expect(pressedAtLast.players[0].status).toBe('holding');
    expect(pressedAtLast.players[0].acc).toBe(1);
  });

  it('5. 兩邊同一局的引信長度相同：兩邊從第一個 tick 一起按住，在同一個 tick 爆炸', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      let s = h2Game.init(seed, CONFIG);
      const fuse = s.fuse;
      let boomTick0 = 0;
      let boomTick1 = 0;
      for (let t = 1; t <= 700 && s.phase === 'play'; t += 1) {
        s = h2Game.step(s, inputs(true, true));
        if (s.players[0].status === 'boom' && boomTick0 === 0) {
          boomTick0 = t;
        }
        if (s.players[1].status === 'boom' && boomTick1 === 0) {
          boomTick1 = t;
        }
      }
      expect(boomTick0).toBe(fuse);
      expect(boomTick1).toBe(fuse);
    }
  });

  it('6. 引信長度在 120 到 600 之間：1000 個種子的範圍與平均（340 到 380）；每一局都在範圍內', () => {
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let seed = 0; seed < 1000; seed += 1) {
      const fuse = h2Game.init(seed, CONFIG).fuse;
      sum += fuse;
      min = Math.min(min, fuse);
      max = Math.max(max, fuse);
    }
    expect(min).toBeGreaterThanOrEqual(120);
    expect(max).toBeLessThanOrEqual(600);
    const mean = sum / 1000;
    expect(mean).toBeGreaterThan(340);
    expect(mean).toBeLessThan(380);

    // 之後每一局的引信（用快速放開、跑完 5 局）也在範圍內。
    for (let seed = 0; seed < 100; seed += 1) {
      let s = h2Game.init(seed, CONFIG);
      const seen = [s.fuse];
      let last = s.round;
      for (let t = 0; t < 3600 && !s.over; t += 1) {
        s = h2Game.step(s, inputs(t % 2 === 0, t % 2 === 0));
        if (s.round !== last) {
          last = s.round;
          seen.push(s.fuse);
        }
      }
      expect(seen).toHaveLength(ROUNDS);
      for (const f of seen) {
        expect(f).toBeGreaterThanOrEqual(120);
        expect(f).toBeLessThanOrEqual(600);
      }
    }
  });

  it('7. 一邊已經結束、另一邊還按著：這一局還沒結束', () => {
    let s = makeState({ fuse: 500, players: [holding(10), holding(10)] });
    s = h2Game.step(s, inputs(false, true)); // 0 號邊放開入袋
    expect(s.players[0].status).toBe('banked');
    expect(s.players[1].status).toBe('holding');
    expect(s.phase).toBe('play');
    expect(s.revealed).toBe(false);
    s = stepN(s, 50, inputs(false, true));
    expect(s.phase).toBe('play');
    expect(s.players[1].acc).toBe(11 + 50);
    expect(s.round).toBe(0);
  });

  it('8. 兩邊都結束：這一局的引信長度公開，停一下，然後進下一局（新的引信、兩邊重新開始）', () => {
    const s = makeState({
      fuse: 321,
      totals: [50, 40],
      players: [banked(50), holding(5)],
    });
    const ended = h2Game.step(s, inputs(false, false)); // 1 號邊放開
    expect(ended.players[1].status).toBe('banked');
    expect(ended.revealed).toBe(true);
    expect(ended.fuses).toEqual([321]);
    expect(ended.phase).toBe('pause');
    expect(ended.round).toBe(0);
    expect(ended.totals).toEqual([50, 45]);
    expect(h2Game.isOver(ended)).toBe(false);

    // 停頓期間輸入被忽略。
    let p = stepN(ended, ROUND_PAUSE - 1, inputs(true, true));
    expect(p.phase).toBe('pause');
    expect(p.revealed).toBe(true);
    expect(p.players[0].status).toBe('banked');
    p = h2Game.step(p, inputs(false, false));
    expect(p.phase).toBe('play');
    expect(p.round).toBe(1);
    expect(p.revealed).toBe(false);
    expect(p.players[0].status).toBe('idle');
    expect(p.players[1].status).toBe('idle');
    expect(p.roundTick).toBe(0);
    expect(p.fuses).toEqual([321]);
    expect(p.fuse).toBeGreaterThanOrEqual(120);
    expect(p.fuse).toBeLessThanOrEqual(600);
    expect(p.totals).toEqual([50, 45]);
  });

  it('9. 5 局結束：isOver，總分高的贏；同分平手；最後一局沒有停頓', () => {
    const base = makeState({
      round: ROUNDS - 1,
      fuse: 400,
      fuses: [200, 300, 250, 350],
      players: [banked(30), holding(10)],
    });
    const win = h2Game.step({ ...base, totals: [100, 60] }, inputs(false, false));
    expect(win.over).toBe(true);
    expect(h2Game.isOver(win)).toBe(true);
    expect(win.phase).toBe('play');
    expect(win.revealed).toBe(true);
    expect(win.fuses).toHaveLength(ROUNDS);
    expect(h2Game.score(win)).toEqual([100, 70]);
    expect(h2Game.winner(win)).toBe(0);

    const lose = h2Game.step({ ...base, totals: [60, 80] }, inputs(false, false));
    expect(h2Game.winner(lose)).toBe(1);

    const tie = h2Game.step({ ...base, totals: [100, 90] }, inputs(false, false));
    expect(tie.totals).toEqual([100, 100]);
    expect(h2Game.winner(tie)).toBeNull();

    // 結束之後 step 原樣回傳。
    expect(h2Game.step(win, inputs(true, true))).toBe(win);
  });

  it('9b. 完整跑 5 局：兩邊各自按住固定的 tick 數再放開，總分是 5 局的加總', () => {
    let s = h2Game.init(11, CONFIG);
    for (let t = 0; t < 3600 && !s.over; t += 1) {
      s = h2Game.step(s, inputs(s.roundTick < 100, s.roundTick < 50));
    }
    expect(s.over).toBe(true);
    expect(s.round).toBe(ROUNDS - 1);
    // 兩邊每局入袋的是 100 與 50（引信最短 120，一定撐得過）。
    expect(h2Game.score(s)).toEqual([500, 250]);
    expect(h2Game.winner(s)).toBe(0);
  });

  it('10.（邊界）剛好在達到引信長度的同一個 tick 放開：算爆炸；再早一個 tick 放開才入袋', () => {
    const fuse = 300;
    const atFuse = h2Game.step(
      makeState({ fuse, totals: [7, 7], players: [holding(fuse - 1), waiting] }),
      inputs(false, false),
    );
    expect(atFuse.players[0].status).toBe('boom');
    expect(atFuse.players[0].acc).toBe(0);
    expect(atFuse.totals).toEqual([7, 7]);

    const justBefore = h2Game.step(
      makeState({ fuse, totals: [7, 7], players: [holding(fuse - 2), waiting] }),
      inputs(false, false),
    );
    expect(justBefore.players[0].status).toBe('banked');
    expect(justBefore.totals).toEqual([7 + fuse - 2, 7]);

    // 還按著的話，acc = fuse − 2 的下一個 tick 是 fuse − 1，再下一個 tick 爆炸。
    let s = makeState({ fuse, players: [holding(fuse - 2), waiting] });
    s = h2Game.step(s, inputs(true, false));
    expect(s.players[0].acc).toBe(fuse - 1);
    s = h2Game.step(s, inputs(true, false));
    expect(s.players[0].status).toBe('boom');
  });
});

describe('H-2 引信｜其他規則', () => {
  it('同一個 tick 兩邊一個爆炸、一個放開：各算各的，局結束', () => {
    const s = makeState({
      fuse: 200,
      totals: [0, 0],
      players: [holding(199), holding(80)],
    });
    const done = h2Game.step(s, inputs(true, false));
    expect(done.players[0].status).toBe('boom');
    expect(done.players[1].status).toBe('banked');
    expect(done.totals).toEqual([0, 80]);
    expect(done.phase).toBe('pause');
    expect(done.roundScores).toEqual([[0], [80]]);
  });

  it('只有 a 算按住（SPEC 第 10 節）：b 不累積；按著 a 的時候同時按 b 也只是按住 a', () => {
    let s = makeState({ fuse: 500 });
    s = h2Game.step(s, [PRESS_B, PRESS_A]);
    // b 不是按住：還是 idle，另一邊按 a 才開始。
    expect(s.players[0]).toEqual({ status: 'idle', acc: 0 });
    expect(s.players[1]).toEqual({ status: 'holding', acc: 1 });
    s = h2Game.step(s, [PRESS_A, { ...PRESS_A, b: true }]);
    expect(s.players[0]).toEqual({ status: 'holding', acc: 1 });
    expect(s.players[1].acc).toBe(2);
    // 按著 a 的時候改按 b：算放開，入袋。
    s = h2Game.step(s, [PRESS_B, PRESS_A]);
    expect(s.players[0].status).toBe('banked');
    expect(s.players[1].acc).toBe(3);
    expect(s.totals).toEqual([1, 0]);
  });

  it('兩邊都沒按（都 late）：一局以 60 個 tick 結束，兩邊都 0 分', () => {
    let s = makeState({ fuse: 500 });
    s = stepN(s, START_LIMIT, inputs(false, false));
    expect(s.players[0].status).toBe('late');
    expect(s.players[1].status).toBe('late');
    expect(s.phase).toBe('pause');
    expect(s.totals).toEqual([0, 0]);
  });

  it('時間到（第 maxTicks 個 tick）：結束，比總分，還按著、沒入袋的不算', () => {
    const s = makeState({
      maxTicks: 100,
      tick: 99,
      fuse: 500,
      totals: [5, 9],
      players: [holding(80), waiting],
    });
    const done = h2Game.step(s, inputs(true, false));
    expect(done.over).toBe(true);
    expect(done.totals).toEqual([5, 9]);
    expect(h2Game.winner(done)).toBe(1);
  });

  it('最壞的對局（每一局都最晚按下、引信 600、一直按到炸）也在 3600 個 tick 之內結束', () => {
    let s = makeState({ fuse: 600 });
    let ticks = 0;
    // 每一局：第 60 個 tick 才按下，之後一直按著；引信強制設成 600。
    while (!s.over && ticks < 5000) {
      const press = s.phase === 'play' && s.roundTick >= START_LIMIT - 1;
      const next = h2Game.step(s, inputs(press, press));
      s = next.round !== s.round && !next.over ? { ...next, fuse: 600 } : next;
      ticks += 1;
    }
    expect(s.over).toBe(true);
    expect(ticks).toBe(5 * (START_LIMIT - 1 + 600) + 4 * ROUND_PAUSE);
    expect(ticks).toBeLessThan(3600);
  });

  it('step 不改動傳進來的 state 與輸入（深度凍結也不丟錯）', () => {
    const s = deepFreeze(makeState({ fuse: 200, players: [holding(10), waiting] }));
    const input = deepFreeze<Inputs>([{ ...PRESS_A }, { ...PRESS_A }]);
    const next = h2Game.step(s, input);
    expect(next.players[0].acc).toBe(11);
    expect(next.players[1].status).toBe('holding');
    expect(s.players[0].acc).toBe(10);
    expect(s.players[1].status).toBe('idle');
    const frozenNext = deepFreeze(next);
    expect(() => h2Game.step(frozenNext, input)).not.toThrow();
  });

  it('隨機事件：引信的新 RngState 有寫回 state（同一個種子的 5 局引信不全相同；不同種子的序列不全相同）', () => {
    const fusesOf = (seed: number): number[] => {
      let s = h2Game.init(seed, CONFIG);
      for (let t = 0; t < 3600 && !s.over; t += 1) {
        s = h2Game.step(s, inputs(s.roundTick < 20, s.roundTick < 20));
      }
      return [...s.fuses];
    };
    const a = fusesOf(0);
    expect(a).toHaveLength(ROUNDS);
    expect(new Set(a).size).toBeGreaterThan(1);
    expect(fusesOf(0)).toEqual(a);
    const sequences = Array.from({ length: 10 }, (_, seed) => fusesOf(seed).join(','));
    expect(new Set(sequences).size).toBeGreaterThan(1);
    // 第 1 局的引信由 `rngStateFor(seed, 'fuse')` 決定。
    expect(h2Game.init(3, CONFIG).rng).not.toBe(rngStateFor(3, 'fuse'));
  });
});

describe('H-2 引信｜actions 與 evaluate', () => {
  it('還在玩的一邊是 [全放開, a]，全放開排第一；結束、停頓、整局結束時只有 [全放開]', () => {
    const live = makeState({ players: [waiting, holding(3)] });
    expect(h2Game.actions(live, 0)).toEqual([IDLE, PRESS_A]);
    expect(h2Game.actions(live, 1)).toEqual([IDLE, PRESS_A]);
    const ended = makeState({ players: [banked(3), { status: 'boom', acc: 0 }] });
    expect(h2Game.actions(ended, 0)).toEqual([IDLE]);
    expect(h2Game.actions(ended, 1)).toEqual([IDLE]);
    expect(h2Game.actions(makeState({ phase: 'pause', pause: 10 }), 0)).toEqual([IDLE]);
    expect(h2Game.actions(makeState({ over: true }), 0)).toEqual([IDLE]);
  });

  it('evaluate：danger 在 0 到 1，gain 有限；結束的局有勝負加成', () => {
    for (const acc of [0, 1, 50, 119, 120, 300, 599, 600]) {
      const s = makeState({ totals: [100, 200], players: [holding(acc), waiting] });
      for (const side of [0, 1] as const) {
        const { gain, danger } = h2Game.evaluate(s, side);
        expect(Number.isFinite(gain)).toBe(true);
        expect(danger).toBeGreaterThanOrEqual(0);
        expect(danger).toBeLessThanOrEqual(1);
      }
    }
    const won = makeState({ over: true, winner: 0, totals: [900, 500] });
    expect(h2Game.evaluate(won, 0).gain).toBeGreaterThan(900000);
    expect(h2Game.evaluate(won, 1).gain).toBeLessThan(-900000);
  });

  it('danger 隨著累積變大（越晚越危險）；已經入袋、爆炸、沒開始的局面 danger 是 0', () => {
    const d = (acc: number): number =>
      h2Game.evaluate(makeState({ players: [holding(acc), waiting] }), 0).danger;
    expect(d(10)).toBeLessThan(d(150));
    expect(d(150)).toBeLessThan(d(300));
    expect(d(300)).toBeLessThan(d(450));
    expect(d(599)).toBeGreaterThan(0.9);
    expect(h2Game.evaluate(makeState({ players: [banked(50), waiting] }), 0).danger).toBe(0);
    expect(h2Game.evaluate(makeState(), 0).danger).toBe(0);
  });

  it('evaluate 與一步看的性格不讀 fuse（AI 不偷看）：只有引信不同的兩個局面，結果完全相同', () => {
    for (const acc of [5, 100, 250]) {
      const a = makeState({ fuse: 400, players: [holding(acc), waiting] });
      const b = makeState({ fuse: 599, players: [holding(acc), waiting] });
      expect(h2Game.evaluate(a, 0)).toEqual(h2Game.evaluate(b, 0));
      for (const policy of [gambler, precise, pathfinder]) {
        const pa = policy.decide(h2Game, a, 0, 0, { depth: 1, seed: 0 });
        const pb = policy.decide(h2Game, b, 0, 0, { depth: 1, seed: 0 });
        expect(pa).toEqual(pb);
      }
    }
  });

  it('賭徒型與精準型的停止點不同：精準型約在 110 放開，賭徒型撐到 240 左右（gain 的視野 120：停在 300 − 120/2）', () => {
    const decide = (policy: typeof gambler, acc: number): Buttons =>
      policy.decide(h2Game, makeState({ players: [holding(acc), waiting] }), 0, 0, {
        depth: 1,
        seed: 0,
      });
    for (const acc of [20, 60, 100]) {
      expect(decide(precise, acc).a).toBe(true);
    }
    for (const acc of [130, 200, 280]) {
      expect(decide(precise, acc).a).toBe(false);
    }
    for (const acc of [20, 100, 200, 230]) {
      expect(decide(gambler, acc).a).toBe(true);
    }
    for (const acc of [255, 300, 400]) {
      expect(decide(gambler, acc).a).toBe(false);
    }
  });

  it('一局剛開始（idle）：賭徒型、精準型、搜尋型都會按下 a；已經結束的一邊不亂按', () => {
    const idleState = makeState();
    for (const policy of [gambler, precise, pathfinder]) {
      expect(policy.decide(h2Game, idleState, 0, 0, { depth: 1, seed: 0 }).a).toBe(true);
    }
    const ended = makeState({ players: [banked(10), waiting] });
    expect(gambler.decide(h2Game, ended, 0, 0, { depth: 1, seed: 0 })).toEqual(IDLE);
  });
});

describe('H-2 引信｜AI 在同時進行的牌裡', () => {
  it('等級 5 的賭徒型一直按住 a：不需要邊緣觸發，每一局都在 60 tick 內按下', () => {
    const a = levelController(h2Game, gambler, 5, 1);
    const b = levelController(h2Game, gambler, 5, 2);
    let s = h2Game.init(2, CONFIG);
    const lateRounds: number[] = [];
    for (let tick = 0; tick < 3600 && !s.over; tick += 1) {
      const next = h2Game.step(s, [a.decide(s, 0, tick), b.decide(s, 1, tick)]);
      for (const side of [0, 1] as const) {
        if (next.players[side].status === 'late' && s.players[side].status !== 'late') {
          lateRounds.push(next.round);
        }
      }
      s = next;
    }
    expect(s.over).toBe(true);
    expect(lateRounds).toEqual([]);
  });

  it('兩個等級 5 的賭徒型打完一整場：在 maxTicks 之內結束，比總分', () => {
    for (let seed = 0; seed < 5; seed += 1) {
      const a = levelController(h2Game, gambler, 5, seed);
      const b = levelController(h2Game, gambler, 5, seed + 1_000_003);
      const result = playMatch(h2Game, seed, CONFIG, a, b);
      expect(result.ticks).toBeLessThanOrEqual(3600);
      expect(result.score[0] + result.score[1]).toBeGreaterThanOrEqual(0);
    }
  });
});
