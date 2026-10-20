import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import type { Buttons, Inputs } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { deepFreeze } from '../../../tests/contract/freeze';
import { COLOR } from '../../shell/palette';
import { cAGame } from '../C-A/logic';
import { c2Game } from '../C-2/logic';
import { BLUE, RED, c3Game } from '../C-3/logic';
import { c4Game } from '../C-4/logic';
import type { C4State } from '../C-4/logic';
import { cell } from '../_clubs/logic';
import {
  NOTICE_TICKS,
  PHASE_COUNT,
  PHASE_POOL,
  PHASE_TICKS,
  ckGame,
  composeState,
  makeState,
  scheduleFor,
} from './logic';
import type { CKState, PhaseId } from './logic';
import { ckMeta } from './meta';
import { ckRender } from './render';

/**
 * C-K 梅花馬拉松的規則測試（小規格 `docs/cards/C-K.md`「量測計畫與先寫的測試」）。
 *
 * 蛇每 6 個 tick 走一格；`phaseTick` 與全場 `tick` 同步走（第 0 段兩者相等），
 * 所以 `tick % 6 === 0` 的那一個 tick 走格，也是每一段的最後一個 tick（900 是 6 的倍數）。
 * `makeState` 的預設：第 0 段、`phaseTick` 0、賽程 `C-A, C-2, C-3, C-4`；
 * 蛇與食物同 C-A 的預設（人 (5,12) 往右、AI (26,11) 往左，食物 (15,3) 與 (15,20)）。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];

const ORDER: readonly PhaseId[] = ['C-A', 'C-2', 'C-3', 'C-4'];
/** 賽程 C-A → C-3 → C-4 → C-2：測試用的另一種排列。 */
const ORDER_3_4_2: readonly PhaseId[] = ['C-A', 'C-3', 'C-4', 'C-2'];

function run(state: CKState, ticks: number, inputs: Inputs = IDLE): CKState {
  let current = state;
  for (let i = 0; i < ticks; i += 1) {
    current = ckGame.step(current, inputs);
  }
  return current;
}

/** 只留 `ClubsState` 的那幾個欄位，拿來和被委派的牌比。 */
function core(state: {
  snakes: unknown;
  foods: unknown;
  rng: unknown;
  over: unknown;
  winner: unknown;
}): unknown {
  return {
    snakes: state.snakes,
    foods: state.foods,
    rng: state.rng,
    over: state.over,
    winner: state.winner,
  };
}

describe('C-K 梅花馬拉松｜init 與賽程', () => {
  it('開局：第 0 段、phaseTick 0、tick 0、沒有預告、賽程長度 4 而且 phases[0] 是 C-A、2 個食物、sub 是空的', () => {
    const state = ckGame.init(0, CONFIG);
    expect(state.phase).toBe(0);
    expect(state.phaseTick).toBe(0);
    expect(state.tick).toBe(0);
    expect(state.notice).toBe(false);
    expect(state.phases).toHaveLength(PHASE_COUNT);
    expect(state.phases[0]).toBe('C-A');
    expect(state.foods).toHaveLength(2);
    expect(state.sub).toEqual({});
    expect(state.over).toBe(false);
    expect(state.snakes[0].body).toHaveLength(3);
  });

  it('常數：一段 900 tick（15 秒）、預告 300 tick（5 秒）、池是 C-2、C-3、C-4', () => {
    expect(PHASE_TICKS).toBe(900);
    expect(NOTICE_TICKS).toBe(300);
    expect(PHASE_POOL).toEqual(['C-2', 'C-3', 'C-4']);
  });

  it('第 1、2、3 段從池裡不重複地抽（種子 0..49 全部檢查）', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const { phases } = ckGame.init(seed, CONFIG);
      const rest = phases.slice(1);
      expect(new Set(rest).size, `種子 ${seed}`).toBe(3);
      for (const id of rest) {
        expect(PHASE_POOL as readonly string[]).toContain(id);
      }
    }
  });

  it('種子 0..9 的賽程不全相同；種子 0..99 六種排列都出現過', () => {
    const first10 = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      first10.add(ckGame.init(seed, CONFIG).phases.join(','));
    }
    expect(first10.size).toBeGreaterThan(1);
    const all = new Set<string>();
    for (let seed = 0; seed < 100; seed += 1) {
      all.add(ckGame.init(seed, CONFIG).phases.join(','));
    }
    expect(all.size).toBe(6);
  });

  it('賽程只由種子決定：scheduleFor 與 init 一致、與 maxTicks 無關、重複呼叫相同', () => {
    for (const seed of [0, 1, 7, 123]) {
      expect(ckGame.init(seed, CONFIG).phases).toEqual(scheduleFor(seed));
      expect(ckGame.init(seed, { maxTicks: 1000, params: {} }).phases).toEqual(scheduleFor(seed));
      expect(scheduleFor(seed)).toEqual(scheduleFor(seed));
    }
  });

  it('maxTicks 不是正整數丟 RangeError；maxTicks 小於 3600 不丟錯', () => {
    expect(() => ckGame.init(0, { maxTicks: 0, params: {} })).toThrow(RangeError);
    expect(() => ckGame.init(0, { maxTicks: 1.5, params: {} })).toThrow(RangeError);
    expect(() => ckGame.init(0, { maxTicks: 500, params: {} })).not.toThrow();
  });

  it('食物位置由種子決定：種子 0..9 的開局食物不全相同', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 10; seed += 1) {
      seen.add(ckGame.init(seed, CONFIG).foods.join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('C-K 梅花馬拉松｜段與段的計時、預告', () => {
  it('phaseTick 從 0 數到 899，tick 899 → 900 換段：phase 加 1、phaseTick 回到 0、tick 照樣往前', () => {
    const before = makeState({ phase: 0, phaseTick: 899 });
    expect(before.tick).toBe(899);
    const after = ckGame.step(before, IDLE);
    expect(after.tick).toBe(900);
    expect(after.phase).toBe(1);
    expect(after.phaseTick).toBe(0);
    const mid = run(after, 5);
    expect(mid.phaseTick).toBe(5);
    expect(mid.phase).toBe(1);
  });

  it('第 1→2、2→3 段也在 tick 1800、2700 換；第 3 段到 3600 結束，不會有第 4 段', () => {
    const toTwo = ckGame.step(makeState({ phase: 1, phaseTick: 899 }), IDLE);
    expect([toTwo.phase, toTwo.phaseTick, toTwo.tick]).toEqual([2, 0, 1800]);
    const toThree = ckGame.step(makeState({ phase: 2, phaseTick: 899 }), IDLE);
    expect([toThree.phase, toThree.phaseTick, toThree.tick]).toEqual([3, 0, 2700]);
    const end = ckGame.step(makeState({ phase: 3, phaseTick: 899 }), IDLE);
    expect(end.tick).toBe(3600);
    expect(end.over).toBe(true);
    expect(end.phase).toBe(3);
  });

  it('預告：離下一段 ≤ 300 tick（phaseTick ≥ 600）起 notice 是 true，599 是 false；最後一段沒有預告', () => {
    const at599 = ckGame.step(makeState({ phase: 0, phaseTick: 598 }), IDLE);
    expect(at599.phaseTick).toBe(599);
    expect(at599.notice).toBe(false);
    const at600 = ckGame.step(makeState({ phase: 0, phaseTick: 599 }), IDLE);
    expect(at600.phaseTick).toBe(600);
    expect(at600.notice).toBe(true);
    const lastPhase = ckGame.step(makeState({ phase: 3, phaseTick: 700 }), IDLE);
    expect(lastPhase.notice).toBe(false);
    const newPhase = ckGame.step(makeState({ phase: 0, phaseTick: 899 }), IDLE);
    expect(newPhase.notice).toBe(false);
  });

  it('預告型：下一段是什麼（phases）在整場不變，預告期間 phases[phase + 1] 一直在 state 裡', () => {
    let state = makeState({ phase: 0, phaseTick: 590, phases: ORDER_3_4_2 });
    const phases = state.phases;
    for (let i = 0; i < 300; i += 1) {
      state = ckGame.step(state, IDLE);
      expect(state.phases).toEqual(phases);
      if (state.notice) {
        expect(state.phases[state.phase + 1]).toBe('C-3');
      }
    }
  });

  it('maxTicks 小於 3600：時間到就結束，分數高的贏（跨過第一個邊界也一樣）', () => {
    const state = makeState({
      phase: 1,
      phaseTick: 98,
      maxTicks: 1000,
      snakes: [{ score: 3, body: [cell(10, 5), cell(9, 5), cell(8, 5)] }, { score: 1 }],
    });
    const end = run(state, 2);
    expect(end.tick).toBe(1000);
    expect(end.over).toBe(true);
    expect(end.winner).toBe(0);
    expect(ckGame.isOver(end)).toBe(true);
  });
});

describe('C-K 梅花馬拉松｜委派：每一段的 step 就是那張牌的 step', () => {
  const ID_GAME = { 'C-A': cAGame, 'C-2': c2Game, 'C-3': c3Game, 'C-4': c4Game } as const;

  it.each([0, 1, 2, 3] as const)(
    '第 %i 段（%s）：走 12 個 tick 後蛇、食物、亂數與被委派的牌自己走的一致',
    (phase) => {
      const id = ORDER[phase] as PhaseId;
      const state = makeState({ phase, phaseTick: 100, phases: ORDER });
      let ours = state;
      let theirs = composeState(state) as never;
      const game = ID_GAME[id] as unknown as {
        step: (s: never, i: Inputs) => never;
      };
      for (let i = 0; i < 12; i += 1) {
        ours = ckGame.step(ours, IDLE);
        theirs = game.step(theirs, IDLE);
      }
      expect(core(ours)).toEqual(core(theirs));
    },
  );

  it('C-3 段：吃到錯誤顏色扣 2 分、長度不變（C-3 的規則，不是 C-A 的 +1）', () => {
    const state = makeState({
      phase: 1,
      phaseTick: 5,
      phases: ORDER_3_4_2,
      foods: [cell(6, 12), cell(20, 3), cell(15, 20), cell(25, 20)],
      sub: { foodColors: [BLUE, RED, BLUE, RED], correct: RED },
    });
    const after = ckGame.step(state, IDLE);
    expect(after.snakes[0].score).toBe(-2);
    expect(after.snakes[0].body).toHaveLength(3);
  });

  it('C-3 段：正確顏色每 480 個「段內 tick」換一次，不是全場的 480（第 2 次換在 phaseTick 960，段已經結束，所以一段只換一次）', () => {
    const state = makeState({ phase: 1, phaseTick: 479, phases: ORDER_3_4_2 });
    const sub = state.sub as { correct: number };
    const after = ckGame.step(state, IDLE);
    expect((after.sub as { correct: number }).correct).toBe(1 - sub.correct);
    const early = ckGame.step(makeState({ phase: 1, phaseTick: 10, phases: ORDER_3_4_2 }), IDLE);
    expect((early.sub as { correct: number }).correct).toBe(
      (makeState({ phase: 1, phaseTick: 10, phases: ORDER_3_4_2 }).sub as { correct: number })
        .correct,
    );
  });

  it('C-2 段：viewRotation 由 phaseTick 算（段內 tick 600 轉成 1），第一個 tick 就是 0', () => {
    const state = makeState({ phase: 1, phaseTick: 599, phases: ORDER });
    expect((state.sub as { viewRotation: number }).viewRotation).toBe(0);
    const after = ckGame.step(state, IDLE);
    expect((after.sub as { viewRotation: number }).viewRotation).toBe(1);
    // 全場 tick 是 1500，如果用全場 tick 算，viewRotation 會是 2。
    expect(after.tick).toBe(1500);
  });

  it('外殼把按鍵轉回世界方向時讀的是 state 最上層的 viewRotation：C-2 段跟著 sub 走，別的段永遠是 0，換段時歸零', () => {
    const c2 = makeState({ phase: 1, phaseTick: 599, phases: ORDER });
    expect(c2.viewRotation).toBe(0);
    expect(ckGame.step(c2, IDLE).viewRotation).toBe(1);
    for (const phase of [0, 2, 3] as const) {
      const other = ckGame.step(makeState({ phase, phaseTick: 700, phases: ORDER }), IDLE);
      expect(other.viewRotation).toBe(0);
    }
    // C-2 在第 3 段、phaseTick 600 之後轉成 1，段結束（時間到）前都維持；換進 C-2 時從 0 開始。
    const late = makeState({ phase: 3, phaseTick: 700, phases: ['C-A', 'C-3', 'C-4', 'C-2'] });
    expect(late.viewRotation).toBe(1);
    const entering = ckGame.step(makeState({ phase: 0, phaseTick: 899, phases: ORDER }), IDLE);
    expect(entering.phases[entering.phase]).toBe('C-2');
    expect(entering.viewRotation).toBe(0);
  });

  it('C-4 段：每 6 個 tick 掃視一次，吃到的食物從自己的記憶拿掉（用段內 tick）', () => {
    const state = makeState({ phase: 3, phaseTick: 5, phases: ORDER });
    const after = ckGame.step(state, IDLE);
    const sub = after.sub as unknown as C4State;
    expect(sub.memory[0].seen[after.snakes[0].body[0] as number]).toBe(6);
  });

  it('C-4 段：有人撞死不立刻結束，停格 60 個 tick 才宣布，贏家是活著的那一邊', () => {
    // 人在 (0,5) 往左，下一格走出地圖。
    const state = makeState({
      phase: 3,
      phaseTick: 5,
      phases: ORDER,
      snakes: [{ body: [cell(0, 5), cell(1, 5), cell(2, 5)], dir: 3 }],
    });
    const dead = ckGame.step(state, IDLE);
    expect(dead.snakes[0].alive).toBe(false);
    expect(dead.over).toBe(false);
    const frozen = run(dead, 59);
    expect(frozen.over).toBe(false);
    const done = ckGame.step(frozen, IDLE);
    expect(done.over).toBe(true);
    expect(done.winner).toBe(1);
  });

  it.each([0, 1, 2] as const)('第 %i 段（非霧）：撞死立刻結束，另一邊贏（不看分數）', (phase) => {
    const state = makeState({
      phase,
      phaseTick: 5,
      phases: ORDER,
      snakes: [{ body: [cell(0, 5), cell(1, 5), cell(2, 5)], dir: 3, score: 9 }, { score: 0 }],
    });
    const after = ckGame.step(state, IDLE);
    expect(after.over).toBe(true);
    expect(after.winner).toBe(1);
  });

  it('時間到：兩邊都活著，分數高的贏；同分平手', () => {
    const base = makeState({ phase: 3, phaseTick: 899, phases: ORDER });
    const win = ckGame.step(
      { ...base, snakes: [{ ...base.snakes[0], score: 4 }, base.snakes[1]] },
      IDLE,
    );
    expect(win.over).toBe(true);
    expect(win.winner).toBe(0);
    const tie = ckGame.step(base, IDLE);
    expect(tie.over).toBe(true);
    expect(tie.winner).toBeNull();
  });
});

describe('C-K 梅花馬拉松｜換段的轉接（enter／exit）', () => {
  it('蛇、分數一路帶著走：C-A → C-2 換段前後蛇的身體與分數和 C-A 自己走一步的結果相同，食物數量補到 2', () => {
    const before = makeState({
      phase: 0,
      phaseTick: 899,
      phases: ORDER,
      snakes: [{ score: 5 }, { score: 2 }],
    });
    const after = ckGame.step(before, IDLE);
    const reference = cAGame.step(composeState(before) as never, IDLE);
    expect(after.snakes).toEqual((reference as { snakes: unknown }).snakes);
    expect(after.snakes[0].score).toBe(5);
    expect(after.snakes[1].score).toBe(2);
    expect(after.foods).toHaveLength(2);
    expect(after.sub).toEqual({ viewRotation: 0, warning: false });
  });

  it('進入 C-3：場上食物變成紅藍各 2 顆，原本的 2 顆留在原位、顏色依序紅藍；正確顏色是 0 或 1；蛇與分數不變', () => {
    const before = makeState({
      phase: 0,
      phaseTick: 899,
      phases: ORDER_3_4_2,
      foods: [cell(15, 3), cell(15, 20)],
      snakes: [{ score: 3 }, { score: 1 }],
    });
    const after = ckGame.step(before, IDLE);
    const sub = after.sub as { foodColors: number[]; correct: number; warning: boolean };
    expect(after.phase).toBe(1);
    expect(after.foods).toHaveLength(4);
    expect(after.foods.slice(0, 2)).toEqual([cell(15, 3), cell(15, 20)]);
    expect(sub.foodColors.filter((c) => c === RED)).toHaveLength(2);
    expect(sub.foodColors.filter((c) => c === BLUE)).toHaveLength(2);
    expect(sub.foodColors.slice(0, 2)).toEqual([RED, BLUE]);
    expect([0, 1]).toContain(sub.correct);
    expect(sub.warning).toBe(false);
    expect(new Set(after.foods).size).toBe(4);
    expect(after.snakes[0].score).toBe(3);
    expect(after.snakes[1].score).toBe(1);
  });

  it('進入 C-3：新補的食物不會落在蛇身上', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const before = makeState({
        phase: 0,
        phaseTick: 899,
        phases: ORDER_3_4_2,
        rng: scheduleSeed(seed),
      });
      const after = ckGame.step(before, IDLE);
      const bodies = new Set([...after.snakes[0].body, ...after.snakes[1].body]);
      for (const food of after.foods) {
        expect(bodies.has(food), `種子 ${seed}`).toBe(false);
      }
    }
  });

  it('離開 C-3：食物收回 2 顆，留下現在正確顏色的食物；分數（含吃錯扣的負分）不被重算', () => {
    const before = makeState({
      phase: 1,
      phaseTick: 899,
      phases: ORDER_3_4_2,
      foods: [cell(15, 3), cell(20, 3), cell(15, 20), cell(25, 20)],
      sub: { foodColors: [RED, BLUE, RED, BLUE], correct: BLUE },
      snakes: [{ score: -4 }, { score: 6 }],
    });
    const after = ckGame.step(before, IDLE);
    expect(after.phase).toBe(2);
    expect(after.foods).toHaveLength(2);
    expect([...after.foods].sort((a, b) => a - b)).toEqual([cell(20, 3), cell(25, 20)]);
    expect(after.snakes[0].score).toBe(-4);
    expect(after.snakes[1].score).toBe(6);
    expect(Object.keys(after.sub).sort()).toEqual(
      ['ateAt', 'endAt', 'memory', 'pendingWinner', 'prevDir'].sort(),
    );
  });

  it('離開 C-3：正確顏色的食物不足 2 顆時，補上格子編號小的錯誤顏色食物，結果決定性（重算兩次相同）', () => {
    const before = makeState({
      phase: 1,
      phaseTick: 899,
      phases: ORDER_3_4_2,
      foods: [cell(15, 3), cell(20, 3), cell(15, 20), cell(25, 20)],
      sub: { foodColors: [RED, BLUE, RED, BLUE], correct: BLUE },
    });
    const eaten = {
      ...before,
      foods: [cell(15, 3), cell(20, 3), cell(15, 20)],
      sub: {
        foodColors: [RED, BLUE, RED],
        correct: BLUE,
      },
    };
    const a = ckGame.step(eaten, IDLE);
    const b = ckGame.step(eaten, IDLE);
    expect(a.foods).toEqual(b.foods);
    expect(a.foods).toHaveLength(2);
    expect(a.foods).toContain(cell(20, 3));
  });

  it('進入 C-4：兩邊的記憶都記得換段那一刻場上所有的食物，所有格子「剛看過」（seen = 0）', () => {
    const before = makeState({ phase: 0, phaseTick: 899, phases: ['C-A', 'C-4', 'C-3', 'C-2'] });
    const after = ckGame.step(before, IDLE);
    expect(after.phases[after.phase]).toBe('C-4');
    const sub = after.sub as unknown as C4State;
    for (const side of [0, 1] as const) {
      expect([...sub.memory[side].foods].sort((a, b) => a - b)).toEqual(
        [...after.foods].sort((a, b) => a - b),
      );
      expect(sub.memory[side].seen.every((t) => t === 0)).toBe(true);
    }
    expect(sub.endAt).toBe(-1);
    expect(sub.pendingWinner).toBeNull();
  });

  it('進入 C-4：快照不洩漏對手的位置，範圍外的對手蛇身不進 rival（兩條蛇相距遠，雙方 rivalHead 都是 -1、rival 是空的）', () => {
    const before = makeState({
      phase: 0,
      phaseTick: 899,
      phases: ['C-A', 'C-4', 'C-2', 'C-3'],
    });
    const after = ckGame.step(before, IDLE);
    const sub = after.sub as unknown as C4State;
    expect(sub.memory[0].rivalHead).toBe(-1);
    expect(sub.memory[0].rival).toEqual([]);
    expect(sub.memory[1].rivalHead).toBe(-1);
    expect(sub.memory[1].rival).toEqual([]);
  });

  it('進入 C-4：對手在視野內時，rival 只記視野內的格子', () => {
    const before = makeState({
      phase: 0,
      phaseTick: 899,
      phases: ['C-A', 'C-4', 'C-2', 'C-3'],
      snakes: [
        { body: [cell(10, 10), cell(9, 10), cell(8, 10)], dir: 1 },
        { body: [cell(14, 10), cell(15, 10), cell(16, 10)], dir: 3 },
      ],
    });
    const after = ckGame.step(before, IDLE);
    const sub = after.sub as unknown as C4State;
    const rivalHead = after.snakes[1].body[0] as number;
    expect(sub.memory[0].rivalHead).toBe(rivalHead);
    for (const c of sub.memory[0].rival) {
      expect(after.snakes[1].body).toContain(c);
    }
  });

  it('離開 C-4 回到別的段：sub 換成新那一段的，記憶丟掉；分數不變', () => {
    const mid = makeState({
      phase: 2,
      phaseTick: 899,
      phases: ['C-A', 'C-3', 'C-4', 'C-2'],
      snakes: [{ score: 2 }, { score: 7 }],
    });
    const after = ckGame.step(mid, IDLE);
    expect(after.phase).toBe(3);
    expect(Object.keys(after.sub).sort()).toEqual(['viewRotation', 'warning']);
    expect(after.snakes[0].score).toBe(2);
    expect(after.snakes[1].score).toBe(7);
    expect(mid.phases[2]).toBe('C-4');
  });

  it('邊界那個 tick 的走格仍照舊那一段的規則算：C-3 段最後一個 tick 吃到錯誤顏色，扣 2 分（不會變成 C-A 的 +1）', () => {
    const before = makeState({
      phase: 1,
      phaseTick: 899,
      phases: ORDER_3_4_2,
      snakes: [{ body: [cell(5, 12), cell(4, 12), cell(3, 12)], dir: 1, score: 1 }],
      foods: [cell(6, 12), cell(20, 3), cell(15, 20), cell(25, 20)],
      sub: { foodColors: [BLUE, RED, BLUE, RED], correct: RED },
    });
    const after = ckGame.step(before, IDLE);
    expect(after.phase).toBe(2);
    expect(after.snakes[0].score).toBe(-1);
    expect(after.snakes[0].body).toHaveLength(3);
  });

  it('霧段有人撞死、停格中不換段（phaseTick 超過 899 也繼續停格，最後才宣布）', () => {
    const state = makeState({
      phase: 1,
      phaseTick: 893,
      phases: ['C-A', 'C-4', 'C-2', 'C-3'],
      snakes: [{ body: [cell(0, 5), cell(1, 5), cell(2, 5)], dir: 3 }],
    });
    // 全場 tick 1793 → 1794 是走格的 tick：人走出地圖，停格從 phaseTick 894 開始，到 954 宣布。
    const dead = ckGame.step(state, IDLE);
    expect(dead.snakes[0].alive).toBe(false);
    expect(dead.over).toBe(false);
    const past = run(dead, 30); // phaseTick 924，已經超過原本換段的 900
    expect(past.phaseTick).toBe(924);
    expect(past.phase).toBe(1);
    expect(past.over).toBe(false);
    const end = run(past, 40);
    expect(end.over).toBe(true);
    expect(end.winner).toBe(1);
    expect(end.phase).toBe(1);
  });

  it('換段不改動傳進來的 state（深度凍結後呼叫 step 不丟錯，前後 JSON 相同）', () => {
    for (const phase of [0, 1, 2] as const) {
      const state = deepFreeze(makeState({ phase, phaseTick: 899, phases: ORDER_3_4_2 }));
      const json = JSON.stringify(state);
      expect(() => ckGame.step(state, IDLE)).not.toThrow();
      expect(JSON.stringify(state)).toBe(json);
    }
  });
});

describe('C-K 梅花馬拉松｜整場跑一遍（不變量）', () => {
  it('兩個搜尋型等級 10 對打：phase 與 phaseTick 隨 tick 前進、賽程與 maxTicks 不變、每 60 tick 可 JSON 往返、局終分數照蛇', () => {
    for (const seed of [0, 1, 2]) {
      let state = ckGame.init(seed, CONFIG);
      const phases = state.phases;
      const controllers = [
        levelController(ckGame, pathfinder, 10, seed + 1),
        levelController(ckGame, pathfinder, 10, seed + 1_000_003),
      ] as const;
      let guard = 0;
      while (!ckGame.isOver(state) && guard < 4000) {
        const inputs: Inputs = [
          controllers[0].decide(state, 0, state.tick),
          controllers[1].decide(state, 1, state.tick),
        ];
        state = ckGame.step(state, inputs);
        guard += 1;
        expect(state.phases).toEqual(phases);
        expect(state.maxTicks).toBe(3600);
        const dead = state.snakes.some((s) => !s.alive);
        if (!dead) {
          expect(state.phase).toBe(Math.min(3, Math.floor(state.tick / PHASE_TICKS)));
          expect(state.phaseTick).toBe(state.tick - PHASE_TICKS * state.phase);
        }
        if (state.tick % 60 === 0) {
          expect(JSON.parse(JSON.stringify(state))).toEqual(state);
        }
      }
      expect(ckGame.isOver(state)).toBe(true);
      expect(ckGame.score(state)).toEqual([state.snakes[0].score, state.snakes[1].score]);
    }
  }, 120_000);
});

describe('C-K 梅花馬拉松｜AI（委派，不看預告）', () => {
  it.each([0, 1, 2, 3] as const)(
    '第 %i 段：只有 phases[phase + 1] 與 notice 不同的兩個 state，evaluate 與 actions 完全相等（AI 不讀預告）',
    (phase) => {
      const a = makeState({ phase, phaseTick: 700, phases: ORDER });
      const other: PhaseId[] = [...ORDER];
      if (phase < 3) {
        other[phase + 1] = ORDER[phase + 1] === 'C-3' ? 'C-4' : 'C-3';
      }
      const b: CKState = { ...a, phases: other, notice: !a.notice };
      for (const side of [0, 1] as const) {
        expect(ckGame.evaluate(b, side)).toEqual(ckGame.evaluate(a, side));
        expect(ckGame.actions(b, side)).toEqual(ckGame.actions(a, side));
      }
    },
  );

  it('evaluate 與 actions 就是被委派的牌在「合成後的 state」上的 evaluate 與 actions', () => {
    const games = { 'C-A': cAGame, 'C-2': c2Game, 'C-3': c3Game, 'C-4': c4Game } as const;
    for (const phase of [0, 1, 2, 3] as const) {
      const state = makeState({ phase, phaseTick: 123, phases: ORDER });
      const id = ORDER[phase] as PhaseId;
      const game = games[id] as unknown as {
        evaluate: (s: never, side: 0 | 1) => unknown;
        actions: (s: never, side: 0 | 1) => unknown;
      };
      for (const side of [0, 1] as const) {
        expect(ckGame.evaluate(state, side)).toEqual(
          game.evaluate(composeState(state) as never, side),
        );
        expect(ckGame.actions(state, side)).toEqual(
          game.actions(composeState(state) as never, side),
        );
      }
    }
  });

  it('霧段的偷看測試（準則 4.3）：霧外的食物與對手位置不同、其餘相同的兩個 state，evaluate 與 actions 相等', () => {
    const a = makeState({
      phase: 3,
      phaseTick: 120,
      phases: ORDER,
      foods: [cell(28, 2), cell(28, 20)],
    });
    const sub = a.sub as unknown as C4State;
    const b: CKState = {
      ...a,
      foods: [cell(29, 3), cell(2, 20)],
      snakes: [a.snakes[0], { ...a.snakes[1], body: [cell(27, 2), cell(28, 2), cell(29, 2)] }],
      sub: { ...sub, memory: [sub.memory[0], { ...sub.memory[1], foods: [] }] },
    };
    // 自己（0 號邊）：食物、對手的真實位置不同，記憶相同。
    expect(ckGame.evaluate(b, 0)).toEqual(ckGame.evaluate(a, 0));
    expect(ckGame.actions(b, 0)).toEqual(ckGame.actions(a, 0));
  });

  it('預設的四個性格都選得出動作（四種性格在每一段、一個 state 上不丟錯、按鍵屬於 actions）', () => {
    for (const phase of [0, 1, 2, 3] as const) {
      const state = makeState({ phase, phaseTick: 50, phases: ORDER });
      for (const side of [0, 1] as const) {
        const pressed = levelController(ckGame, pathfinder, 10, 5).decide(state, side, state.tick);
        expect(pressed).toBeDefined();
      }
    }
  });
});

describe('C-K 梅花馬拉松｜state 與 meta', () => {
  it('state 可 JSON 往返而且沒有函式、NaN、undefined（每一段）', () => {
    for (const phase of [0, 1, 2, 3] as const) {
      const state = makeState({ phase, phaseTick: 77, phases: ORDER });
      const round = JSON.parse(JSON.stringify(state)) as CKState;
      expect(round).toEqual(state);
    }
  });

  it('meta：預設性格搜尋型、baseLevel 4、對稱、死亡優先、不標 seedIndependent、不宣告 selfFromPresent', () => {
    expect(ckMeta.id).toBe('C-K');
    expect(ckMeta.suit).toBe('C');
    expect(ckMeta.rank).toBe('K');
    expect(ckMeta.defaultPolicy).toBe('pathfinder');
    expect(ckMeta.baseLevel).toBe(4);
    expect(ckMeta.symmetric).toBe(true);
    expect(ckMeta.winnerNotByScore).toBe(true);
    expect(ckMeta.seedIndependent).toBeUndefined();
    expect('selfFromPresent' in ckGame).toBe(false);
  });
});

describe('C-K 梅花馬拉松｜render', () => {
  it.each([0, 1, 2, 3] as const)(
    '第 %i 段（有預告與沒有預告）：不丟錯、不改 state、只用色盤、畫在 320×240 之內',
    (phase) => {
      for (const phaseTick of [10, 700]) {
        const state = deepFreeze(makeState({ phase, phaseTick, phases: ORDER }));
        const context = createFakeContext();
        expect(() => ckRender(asRenderingContext(context), state)).not.toThrow();
        for (const point of context.points) {
          expect(point.x).toBeGreaterThanOrEqual(-8);
          expect(point.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
          expect(point.y).toBeGreaterThanOrEqual(-8);
          expect(point.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
        }
        for (const record of context.colors) {
          expect(Object.values(COLOR)).toContain(record.value);
        }
      }
    },
  );
});

/** 一個與種子有關的亂數狀態（測試用，避免從 core/rng 重複 import）。 */
function scheduleSeed(seed: number): number {
  return (seed * 2654435761) >>> 0;
}
