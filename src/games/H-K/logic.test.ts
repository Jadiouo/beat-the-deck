import { describe, expect, it } from 'vitest';

import { pathfinder } from '../../ai/policies/pathfinder';
import { hashState } from '../../core/hash';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { deepFreeze } from '../../../tests/contract/freeze';
import { COLOR } from '../../shell/palette';
import { IDLE, PRESS_A, PRESS_B } from '../_hearts/logic';
import { registry } from '../registry';
import {
  BET_PREP,
  BET_TIMEOUT,
  EDGE,
  LOCK_TICKS,
  MIN_MAX_TICKS,
  RESULT_TICKS,
  REVEAL_TICKS,
  SLOPE,
  STAGES,
  STAGE_POOL,
  STAKE,
  hkGame,
  makeState,
  scheduleFor,
  stageSeedFor,
  stageTicksFor,
} from './logic';
import type { HKPhase, HKState, StageId } from './logic';
import { hkMeta } from './meta';
import { hkRender } from './render';
import { CONFIG, level, never, playFrom, playFull, withBet } from './players.test-helpers';

/**
 * H-K 紅心馬拉松的規則測試（小規格 `docs/cards/H-K.md`）。
 *
 * 這張牌是變化牌（DESIGN-AI-FUN 10.27）：加倍層沒有自己的 AI 互動，互動借自被包的牌。
 * 所以這裡的測試分三類：包裝層的結算（籌碼、方向、不重算）、委派（被包的牌原樣跑）、
 * 加倍牌的開場決定（不偷看、`actions()[0]` 推進結算、用在對自己最強的一場）。
 */

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q'];

const gameOf = (id: string): Game<unknown> =>
  (registry.find((entry) => entry.id === id) as unknown as { game: Game<unknown> }).game;

const B: Inputs = [PRESS_B, PRESS_B];
const IDLE_PAIR: Inputs = [IDLE, IDLE];

function run(state: HKState, ticks: number, inputs: Inputs = IDLE_PAIR): HKState {
  let current = state;
  for (let i = 0; i < ticks; i += 1) {
    current = hkGame.step(current, inputs);
  }
  return current;
}

/** 一個固定的場次表：從小到大，邊緣值（EDGE）高低都有。 */
const FOUR: readonly StageId[] = ['H-2', 'H-4', 'H-9', 'H-10'];

/** 在 `bet` 階段、兩邊都還沒選的局面。 */
function betState(overrides: Partial<HKState> = {}): HKState {
  return makeState({ phase: 'bet', wait: 0, idle: 0, ...overrides });
}

describe('H-K 紅心馬拉松｜常數、賽程、init', () => {
  it('常數：4 場、賭注 10、起始 100、準備 45、等 120、鎖定 2、揭示 30、結果 30', () => {
    expect(STAGES).toBe(4);
    expect(STAKE).toBe(10);
    expect(BET_PREP).toBe(45);
    expect(BET_TIMEOUT).toBe(120);
    expect(LOCK_TICKS).toBe(2);
    expect(REVEAL_TICKS).toBe(30);
    expect(RESULT_TICKS).toBe(30);
    expect(MIN_MAX_TICKS).toBe(STAGES * 400);
  });

  it('每場的上限：3600 是 673；最壞情況（每場都等滿）四場剛好不超過 maxTicks', () => {
    expect(stageTicksFor(3600)).toBe(673);
    expect(stageTicksFor(MIN_MAX_TICKS)).toBe(173);
    for (const maxTicks of [1600, 2000, 2500, 3000, 3600, 4001]) {
      const stage = stageTicksFor(maxTicks);
      const worst =
        STAGES * (BET_PREP + BET_TIMEOUT + LOCK_TICKS + REVEAL_TICKS + stage + RESULT_TICKS);
      expect(worst, `maxTicks ${maxTicks}`).toBeLessThanOrEqual(maxTicks);
    }
  });

  it('maxTicks 小於 STAGES × 400 丟 RangeError；剛好 1600 可以', () => {
    expect(() => hkGame.init(0, { maxTicks: MIN_MAX_TICKS - 1, params: {} })).toThrow(RangeError);
    expect(() => hkGame.init(0, { maxTicks: MIN_MAX_TICKS, params: {} })).not.toThrow();
  });

  it('開局：籌碼 100／100、各一張加倍牌、第 0 場、準備階段 45 tick、沒有結果、JSON 可序列化', () => {
    const state = hkGame.init(0, CONFIG);
    expect(state.chips).toEqual([100, 100]);
    expect(state.doublers).toEqual([1, 1]);
    expect(state.stageIdx).toBe(0);
    expect(state.phase).toBe('betPrep');
    expect(state.wait).toBe(BET_PREP);
    expect(state.tick).toBe(0);
    expect(state.over).toBe(false);
    expect(state.winner).toBeNull();
    expect(state.stages).toHaveLength(STAGES);
    expect(state.results).toEqual([]);
    expect(state.pending).toEqual([null, null]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('賽程：4 張不重複、都在池裡、依牌面由小到大；種子 0..99 至少有 20 種不同的賽程', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 100; seed += 1) {
      const stages = scheduleFor(seed);
      expect(stages).toHaveLength(STAGES);
      expect(new Set(stages).size).toBe(STAGES);
      const ranks = stages.map((id) => RANKS.indexOf(id.slice(2)));
      for (const id of stages) {
        expect(STAGE_POOL).toContain(id);
      }
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      expect(hkGame.init(seed, CONFIG).stages).toEqual(stages);
      seen.add(stages.join(','));
    }
    expect(seen.size).toBeGreaterThanOrEqual(20);
  });

  it('第 0 場的 sub 就是那張牌自己用「場種子」與 maxTicks = 673 開出來的 state（沒有被動過）', () => {
    for (const seed of [0, 1, 2, 7]) {
      const state = hkGame.init(seed, CONFIG);
      const id = state.stages[0] as StageId;
      expect(state.sub).toEqual(
        gameOf(id).init(stageSeedFor(seed, 0), { maxTicks: 673, params: {} }),
      );
    }
  });

  it('場種子：同一個種子不同場不同；不同種子不同', () => {
    expect(new Set([0, 1, 2, 3].map((i) => stageSeedFor(5, i))).size).toBe(4);
    expect(stageSeedFor(5, 0)).not.toBe(stageSeedFor(6, 0));
    expect(stageSeedFor(5, 2)).toBe(stageSeedFor(5, 2));
  });
});

describe('H-K 紅心馬拉松｜場次池與 edge 表', () => {
  it('池裡每一張都在登記表、是紅心、不含自己，而且依牌面由小到大排列、不重複', () => {
    expect(new Set(STAGE_POOL).size).toBe(STAGE_POOL.length);
    expect(STAGE_POOL).not.toContain('H-K' as StageId);
    const ranks = STAGE_POOL.map((id) => RANKS.indexOf(id.slice(2)));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    for (const id of STAGE_POOL) {
      const entry = registry.find((e) => e.id === id);
      expect(entry, id).toBeDefined();
      expect(entry?.kind).toBe('card');
      expect(entry?.meta.suit).toBe('H');
    }
    expect(STAGE_POOL.length).toBeGreaterThanOrEqual(STAGES);
  });

  it('每個進池的牌，用 maxTicks = 673 跑，兩邊都不動也一定在 673 個 tick 內結束（縮短是合法的）', () => {
    for (const id of STAGE_POOL) {
      const game = gameOf(id);
      for (const seed of [0, 1, 2]) {
        let state = game.init(seed, { maxTicks: 673, params: {} });
        let ticks = 0;
        while (!game.isOver(state) && ticks < 673) {
          state = game.step(state, IDLE_PAIR);
          ticks += 1;
        }
        expect(game.isOver(state), `${id} 種子 ${seed}`).toBe(true);
      }
    }
  });

  it('edge 表：池裡每張牌都有兩個座位的勝率，在 [0.05, 0.95]，不是全部 0.5（是量出來的）', () => {
    const all: number[] = [];
    for (const id of STAGE_POOL) {
      const edge = EDGE[id];
      expect(edge, id).toBeDefined();
      for (const side of [0, 1] as const) {
        expect(edge[side]).toBeGreaterThanOrEqual(0.05);
        expect(edge[side]).toBeLessThanOrEqual(0.95);
        all.push(edge[side]);
      }
    }
    expect(all.some((v) => v !== 0.5)).toBe(true);
    expect(new Set(all).size).toBeGreaterThanOrEqual(5);
  });

  it('slope 表：池裡每張牌都有一個有限的正數（子遊戲 gain 換成勝率的斜率）', () => {
    for (const id of STAGE_POOL) {
      const slope = SLOPE[id];
      expect(Number.isFinite(slope), id).toBe(true);
      expect(slope, id).toBeGreaterThan(0);
    }
  });
});

describe('H-K 紅心馬拉松｜開場決定（bet）的流程', () => {
  it('準備階段 45 tick 內的輸入全部忽略；第 45 步之後進 bet', () => {
    let state = hkGame.init(0, CONFIG);
    const pressA: Inputs = [PRESS_A, PRESS_A];
    for (let i = 0; i < BET_PREP - 1; i += 1) {
      state = hkGame.step(state, pressA);
      expect(state.phase).toBe('betPrep');
      expect(state.pending).toEqual([null, null]);
    }
    state = hkGame.step(state, IDLE_PAIR);
    expect(state.phase).toBe('bet');
    expect(state.pending).toEqual([null, null]);
  });

  it('按 a 是用加倍牌、按 b 是不用；選了不能改；b 優先於 a', () => {
    let state = betState();
    state = hkGame.step(state, [PRESS_A, IDLE]);
    expect(state.pending).toEqual([1, null]);
    expect(state.phase).toBe('bet');
    state = hkGame.step(state, [PRESS_B, IDLE]);
    expect(state.pending).toEqual([1, null]);
    const both: Buttons = { ...IDLE, a: true, b: true };
    state = hkGame.step(state, [IDLE, both]);
    expect(state.pending).toEqual([1, 0]);
    expect(state.phase).toBe('betLocked');
    expect(state.wait).toBe(LOCK_TICKS);
  });

  it('倍數 = 1 + 這場用加倍牌的人數：不用不用 1、用不用 2、不用用 2、用用 3', () => {
    const cases: [Inputs, number][] = [
      [[PRESS_B, PRESS_B], 1],
      [[PRESS_A, PRESS_B], 2],
      [[PRESS_B, PRESS_A], 2],
      [[PRESS_A, PRESS_A], 3],
    ];
    for (const [inputs, mult] of cases) {
      let state = hkGame.step(betState(), inputs);
      expect(state.phase).toBe('betLocked');
      state = run(state, LOCK_TICKS);
      expect(state.phase).toBe('betReveal');
      expect(state.mult).toBe(mult);
      expect(state.used).toEqual([inputs[0].a && !inputs[0].b, inputs[1].a && !inputs[1].b]);
      expect(state.wait).toBe(REVEAL_TICKS);
    }
  });

  it('加倍牌在揭示時不扣、進 play 才扣（揭示前後 evaluate 不能靠它偷看對方）', () => {
    let state = hkGame.step(betState(), [PRESS_A, PRESS_B]);
    state = run(state, LOCK_TICKS);
    expect(state.phase).toBe('betReveal');
    expect(state.doublers).toEqual([1, 1]);
    state = run(state, REVEAL_TICKS);
    expect(state.phase).toBe('play');
    expect(state.doublers).toEqual([0, 1]);
    expect(state.pending).toEqual([null, null]);
    expect(state.mult).toBe(2);
  });

  it('等滿 120 tick 沒人按：自動「不用」，倍數 1', () => {
    let state = betState();
    for (let i = 0; i < BET_TIMEOUT - 1; i += 1) {
      state = hkGame.step(state, IDLE_PAIR);
      expect(state.phase).toBe('bet');
    }
    state = hkGame.step(state, IDLE_PAIR);
    expect(state.phase).toBe('betLocked');
    expect(state.pending).toEqual([0, 0]);
    state = run(state, LOCK_TICKS);
    expect(state.mult).toBe(1);
    expect(state.used).toEqual([false, false]);
  });

  it('沒有加倍牌的那一邊：進 bet 時自動選「不用」、不用按、按 a 也沒用；兩邊都沒有就直接跳過 bet', () => {
    const one = makeState({ phase: 'betPrep', wait: 1, doublers: [0, 1] });
    const entered = hkGame.step(one, IDLE_PAIR);
    expect(entered.phase).toBe('bet');
    expect(entered.pending).toEqual([0, null]);
    expect(hkGame.actions(entered, 0)).toEqual([IDLE]);
    const pressed = hkGame.step(entered, [PRESS_A, PRESS_A]);
    expect(pressed.pending).toEqual([0, 1]);
    const none = makeState({ phase: 'betPrep', wait: 1, doublers: [0, 0] });
    const skipped = hkGame.step(none, IDLE_PAIR);
    expect(skipped.phase).toBe('betLocked');
    expect(skipped.pending).toEqual([0, 0]);
  });

  it('走完 betReveal 之後進 play，sub 沒被動過（還是剛開出來的樣子）', () => {
    const start = hkGame.init(3, CONFIG);
    let state = run(start, BET_PREP);
    state = hkGame.step(state, B);
    state = run(state, LOCK_TICKS + REVEAL_TICKS);
    expect(state.phase).toBe('play');
    expect(state.sub).toEqual(start.sub);
  });
});

describe('H-K 紅心馬拉松｜委派：被包的牌原樣跑', () => {
  const ticksToCheck = 250;
  /** 一個固定的輸入圖樣（不用亂數）：三種輸入輪流，兩邊錯開。 */
  const pattern = (tick: number): Inputs => {
    const pick = (n: number): Buttons => (n % 3 === 0 ? IDLE : n % 3 === 1 ? PRESS_A : PRESS_B);
    return [pick(Math.floor(tick / 7)), pick(Math.floor(tick / 5) + 1)];
  };

  it.each(STAGE_POOL)(
    '%s：play 階段每個 tick，H-K 的 sub 都等於那張牌自己跑同樣輸入的 state',
    (id) => {
      const stages = [id, ...STAGE_POOL.filter((x) => x !== id).slice(0, 3)] as StageId[];
      let wrapped = makeState({ stages, stageIdx: 0, phase: 'play', wait: 0 });
      const game = gameOf(id);
      let direct = game.init(stageSeedFor(0, 0), { maxTicks: 673, params: {} });
      expect(wrapped.sub).toEqual(direct);
      for (let t = 0; t < ticksToCheck && wrapped.phase === 'play'; t += 1) {
        const inputs = pattern(t);
        wrapped = hkGame.step(wrapped, inputs);
        direct = game.step(direct, inputs);
        if (wrapped.phase !== 'play') {
          expect(game.isOver(direct)).toBe(true);
          break;
        }
        expect(wrapped.sub, `${id} tick ${t}`).toEqual(direct);
        if (t % 25 === 0) {
          for (const side of [0, 1] as const) {
            expect(hkGame.actions(wrapped, side)).toEqual(game.actions(direct, side));
          }
        }
      }
    },
  );

  it('step 不改動傳進來的 state（play 階段，深度凍結）', () => {
    const state = deepFreeze(makeState({ stages: FOUR, phase: 'play', wait: 0 }));
    const before = JSON.stringify(state);
    const next = hkGame.step(state, [PRESS_A, PRESS_B]);
    expect(JSON.stringify(state)).toBe(before);
    expect(next).not.toBe(state);
  });
});

describe('H-K 紅心馬拉松｜段與段之間的籌碼結算（方向、金額、不重算）', () => {
  /** 打到第 0 場的 play 開始，記下 play 階段吃掉的輸入，到 stageResult 為止。 */
  function stageZero(seed: number, rule0: (s: HKState, side: Side) => 0 | 1, rule1: typeof rule0) {
    const c0 = withBet(level(10, seed * 2 + 1), rule0);
    const c1 = withBet(level(3, seed * 2 + 2), rule1);
    const start = hkGame.init(seed, CONFIG);
    const toPlay = playFrom(start, c0, c1, (s) => s.phase === 'play');
    const play = playFrom(toPlay.state, c0, c1, (s) => s.phase === 'stageResult');
    return { start, toPlay: toPlay.state, played: play };
  }

  it('贏的人從輸的人拿走 STAKE × 倍數；方向對（0 贏則 0 增 1 減）；和被包的牌直接跑出來的贏家一致；兩邊總和永遠 200', () => {
    const wins = [0, 0];
    const rules: [typeof never, typeof never][] = [
      [never, never],
      [() => 1, never],
      [never, () => 1],
      [() => 1, () => 1],
    ];
    for (let seed = 0; seed < 24; seed += 1) {
      const [r0, r1] = rules[seed % 4] as [typeof never, typeof never];
      const { start, toPlay, played } = stageZero(seed, r0, r1);
      const id = start.stages[0] as StageId;
      const game = gameOf(id);
      let direct = game.init(stageSeedFor(seed, 0), { maxTicks: 673, params: {} });
      for (const inputs of played.inputs) {
        if (game.isOver(direct)) {
          break;
        }
        direct = game.step(direct, inputs);
      }
      expect(game.isOver(direct), `種子 ${seed}`).toBe(true);
      const w = game.winner(direct);
      const after = played.state;
      expect(after.phase).toBe('stageResult');
      const mult = toPlay.mult;
      expect(after.results).toHaveLength(1);
      expect(after.results[0]?.winner).toBe(w);
      expect(after.results[0]?.mult).toBe(mult);
      const expected: [number, number] = [100, 100];
      if (w !== null) {
        expected[w] += STAKE * mult;
        expected[w === 0 ? 1 : 0] -= STAKE * mult;
        wins[w] += 1;
      }
      expect(after.chips, `種子 ${seed}`).toEqual(expected);
      expect(after.chips[0] + after.chips[1]).toBe(200);
      expect(after.results[0]?.delta).toBe(w === null ? 0 : STAKE * mult);
    }
    expect(wins[0]).toBeGreaterThan(0);
    expect(wins[1]).toBeGreaterThan(0);
  });

  it('結算只發生一次：stageResult 裡再走 29 步籌碼不動、結果只有一筆；走完換下一場，sub 是新開的', () => {
    const { played } = stageZero(4, never, never);
    const result = played.state;
    const chips = result.chips;
    let state = run(result, RESULT_TICKS - 1);
    expect(state.phase).toBe('stageResult');
    expect(state.chips).toEqual(chips);
    expect(state.results).toHaveLength(1);
    state = hkGame.step(state, IDLE_PAIR);
    expect(state.phase).toBe('betPrep');
    expect(state.stageIdx).toBe(1);
    expect(state.chips).toEqual(chips);
    expect(state.mult).toBe(1);
    expect(state.used).toEqual([false, false]);
    expect(state.sub).toEqual(
      gameOf(state.stages[1] as StageId).init(stageSeedFor(4, 1), { maxTicks: 673, params: {} }),
    );
  });

  it('平手不動籌碼：被包的牌平手 = delta 0、winner null', () => {
    // H-2 兩邊都不動（鏡像骰子、同樣的輸入）一定平手。
    let state = makeState({ stages: ['H-2', 'H-4', 'H-9', 'H-10'], phase: 'play', wait: 0 });
    for (let i = 0; i < 700 && state.phase === 'play'; i += 1) {
      state = hkGame.step(state, IDLE_PAIR);
    }
    expect(state.phase).toBe('stageResult');
    expect(state.results[0]?.winner).toBeNull();
    expect(state.results[0]?.delta).toBe(0);
    expect(state.chips).toEqual([100, 100]);
  });

  it('最後一場結算完：結束、贏家是籌碼多的、平手是 null、score 就是籌碼', () => {
    const last = (chips: [number, number]) =>
      hkGame.step(
        makeState({ stages: FOUR, stageIdx: 3, phase: 'stageResult', wait: 1, chips }),
        IDLE_PAIR,
      );
    const a = last([110, 90]);
    expect(hkGame.isOver(a)).toBe(true);
    expect(hkGame.winner(a)).toBe(0);
    expect(hkGame.score(a)).toEqual([110, 90]);
    expect(hkGame.winner(last([80, 120]))).toBe(1);
    expect(hkGame.winner(last([100, 100]))).toBeNull();
  });

  it('整場：每個 tick 兩邊籌碼總和 200，任何時刻每邊至少 40（最多輸 60），結束時 winner 與 score 一致', () => {
    for (let seed = 0; seed < 6; seed += 1) {
      let state = hkGame.init(seed, CONFIG);
      const c0 = withBet(level(6, seed * 2 + 1), () => 1);
      const c1 = withBet(level(6, seed * 2 + 2), () => 1);
      while (!hkGame.isOver(state)) {
        const inputs: Inputs = [c0.decide(state, 0, state.tick), c1.decide(state, 1, state.tick)];
        state = hkGame.step(state, inputs);
        expect(state.chips[0] + state.chips[1]).toBe(200);
        expect(Math.min(...state.chips)).toBeGreaterThanOrEqual(40);
      }
      const [s0, s1] = hkGame.score(state);
      expect(hkGame.winner(state)).toBe(s0 === s1 ? null : s0 > s1 ? 0 : 1);
      expect(state.results).toHaveLength(STAGES);
      expect(state.tick).toBeLessThanOrEqual(3600);
    }
  });

  it('一場完整的對局不超過 3600 tick，且種子相同結果逐位元相同', () => {
    const one = playFull(level(10, 11), level(10, 12), 5);
    const two = playFull(level(10, 11), level(10, 12), 5);
    expect(one.ticks).toBeLessThanOrEqual(3600);
    expect(hashState(one.state)).toBe(hashState(two.state));
  });
});

describe('H-K 紅心馬拉松｜evaluate：零和方向與籌碼', () => {
  it('結束：領先的拿 +1000、落後的拿 −1000，平手 0；兩邊的 gain 恰好相反', () => {
    const over = (chips: [number, number], winner: Side | null) =>
      makeState({ stages: FOUR, stageIdx: 3, phase: 'stageResult', over: true, chips, winner });
    const win0 = over([120, 80], 0);
    expect(hkGame.evaluate(win0, 0).gain).toBe(40 + 1000);
    expect(hkGame.evaluate(win0, 1).gain).toBe(-40 - 1000);
    const draw = over([100, 100], null);
    expect(hkGame.evaluate(draw, 0).gain).toBe(0);
    expect(hkGame.evaluate(draw, 1).gain).toBe(0);
  });

  it('最後一場已結算、還沒結束：兩邊的 gain 恰好相反（沒有剩下的場次，不靠 edge 表）', () => {
    for (const chips of [
      [110, 90],
      [90, 110],
      [100, 100],
      [130, 70],
    ] as [number, number][]) {
      const state = makeState({ stages: FOUR, stageIdx: 3, phase: 'stageResult', wait: 10, chips });
      const g0 = hkGame.evaluate(state, 0).gain;
      const g1 = hkGame.evaluate(state, 1).gain;
      expect(g0 + g1).toBeCloseTo(0, 9);
    }
  });

  it('同一個局面，自己籌碼越多 gain 越高（兩邊都是）', () => {
    for (const side of [0, 1] as const) {
      const gains = [70, 85, 100, 115, 130].map((mine) => {
        const chips: [number, number] = side === 0 ? [mine, 200 - mine] : [200 - mine, mine];
        return hkGame.evaluate(
          makeState({ stages: FOUR, stageIdx: 1, phase: 'stageResult', wait: 10, chips }),
          side,
        ).gain;
      });
      for (let i = 1; i < gains.length; i += 1) {
        expect(gains[i] as number).toBeGreaterThan(gains[i - 1] as number);
      }
    }
  });

  it('evaluate 的 danger 在開場決定與結算階段是 0（失敗已算在期望裡，不重複扣）', () => {
    for (const phase of ['betPrep', 'bet', 'betLocked', 'betReveal', 'stageResult'] as HKPhase[]) {
      const state = makeState({
        stages: FOUR,
        phase,
        wait: 5,
        pending: phase === 'betLocked' || phase === 'betReveal' ? [0, 0] : [null, null],
      });
      for (const side of [0, 1] as const) {
        expect(hkGame.evaluate(state, side).danger).toBe(0);
      }
    }
  });
});

describe('H-K 紅心馬拉松｜加倍牌的開場決定：用在對自己最強的一場', () => {
  /** 站在 side 看：開場選 move 之後，揭示階段（走完鎖定）的 gain。對手用最保守的「不用」。 */
  function gainAfter(base: HKState, side: Side, move: 0 | 1): number {
    const mine = move === 1 ? PRESS_A : PRESS_B;
    const inputs: Inputs = side === 0 ? [mine, PRESS_B] : [PRESS_B, mine];
    const locked = hkGame.step(base, inputs);
    const revealed = run(locked, LOCK_TICKS);
    expect(revealed.phase).toBe('betReveal');
    return hkGame.evaluate(revealed, side).gain;
  }

  it('最後一場、落後 30（不用加倍牌翻不了盤）：用 > 不用', () => {
    for (const side of [0, 1] as const) {
      const chips: [number, number] = side === 0 ? [85, 115] : [115, 85];
      const state = betState({ stages: FOUR, stageIdx: 3, chips });
      expect(gainAfter(state, side, 1)).toBeGreaterThan(gainAfter(state, side, 0));
    }
  });

  it('第一場是對自己最強的一場（H-2），後面都比較弱、籌碼持平：用 > 不用', () => {
    const state = betState({ stages: ['H-2', 'H-4', 'H-5', 'H-6'] });
    for (const side of [0, 1] as const) {
      expect(gainAfter(state, side, 1)).toBeGreaterThan(gainAfter(state, side, 0));
    }
  });

  it('第一場是對自己最弱的一場（H-J），後面有很強的 H-10：留著 > 現在用', () => {
    const state = betState({ stages: ['H-J', 'H-4', 'H-9', 'H-10'] });
    for (const side of [0, 1] as const) {
      expect(gainAfter(state, side, 0)).toBeGreaterThan(gainAfter(state, side, 1));
    }
  });

  it('深度 3 的搜尋型照這個比較選：H-2 先、H-J 先、落後 30 的最後一場', () => {
    const decide = (state: HKState, side: Side, depth: number): Buttons =>
      pathfinder.decide(hkGame, state, side, 0, { depth, seed: 0 });
    const strongFirst = betState({ stages: ['H-2', 'H-4', 'H-5', 'H-6'] });
    const weakFirst = betState({ stages: ['H-J', 'H-4', 'H-9', 'H-10'] });
    const trailing = betState({ stages: FOUR, stageIdx: 3, chips: [85, 115] });
    expect(decide(strongFirst, 0, 3)).toEqual(PRESS_A);
    expect(decide(weakFirst, 0, 3)).toEqual(PRESS_B);
    expect(decide(trailing, 0, 3)).toEqual(PRESS_A);
    expect(decide(strongFirst, 1, 6)).toEqual(PRESS_A);
    expect(decide(weakFirst, 1, 6)).toEqual(PRESS_B);
  });

  it('深度 1 到 2 只剩反射規則：除了最後一場都不用；最後一場還有加倍牌就用；沒有加倍牌就沒得選', () => {
    const decide = (state: HKState, side: Side, depth: number): Buttons =>
      pathfinder.decide(hkGame, state, side, 0, { depth, seed: 0 });
    for (const depth of [1, 2]) {
      for (const idx of [0, 1, 2] as const) {
        expect(decide(betState({ stages: FOUR, stageIdx: idx }), 1, depth), `場 ${idx}`).toEqual(
          PRESS_B,
        );
      }
      expect(decide(betState({ stages: FOUR, stageIdx: 3 }), 1, depth)).toEqual(PRESS_A);
      // 即使第一場是 H-2（對自己最強）也一樣：反射規則不看 edge
      expect(decide(betState({ stages: ['H-2', 'H-4', 'H-5', 'H-6'] }), 1, depth)).toEqual(PRESS_B);
    }
    const spent = betState({ stages: FOUR, stageIdx: 3, doublers: [1, 0] });
    expect(hkGame.actions(spent, 1)).toEqual([IDLE]);
  });
});

describe('H-K 紅心馬拉松｜資訊限制：AI 看不到對方的 pending，也看不到它造成的倍數', () => {
  const phasesToCheck = ['bet', 'betLocked'] as const;

  it('只有對方 pending 不同：evaluate 與 actions 相等（bet、betLocked）', () => {
    for (const phase of phasesToCheck) {
      for (const stageIdx of [0, 1, 2, 3] as const) {
        for (const side of [0, 1] as const) {
          const opp = side === 0 ? 1 : 0;
          const mine: 0 | 1 | null = phase === 'betLocked' ? 0 : null;
          const make = (theirs: 0 | 1): HKState => {
            const pending: [0 | 1 | null, 0 | 1 | null] = [null, null];
            pending[side] = mine;
            pending[opp] = theirs;
            return makeState({ stages: FOUR, stageIdx, phase, wait: 2, pending, chips: [95, 105] });
          };
          const stay = make(0);
          const use = make(1);
          expect(hkGame.evaluate(use, side)).toEqual(hkGame.evaluate(stay, side));
          expect(hkGame.actions(use, side)).toEqual(hkGame.actions(stay, side));
        }
      }
    }
  });

  it('只有對方 pending 不同、自己做同一個選擇、走完鎖定到 betReveal：evaluate 相等（倍數與對方的 used 都不能漏）', () => {
    for (const stageIdx of [0, 2, 3] as const) {
      for (const side of [0, 1] as const) {
        for (const move of [0, 1] as const) {
          const opp = side === 0 ? 1 : 0;
          const reveal = (theirs: 0 | 1): HKState => {
            const pending: [0 | 1 | null, 0 | 1 | null] = [null, null];
            pending[opp] = theirs;
            const start = makeState({
              stages: FOUR,
              stageIdx,
              phase: 'bet',
              pending,
              chips: [92, 108],
            });
            const mine = move === 1 ? PRESS_A : PRESS_B;
            const next = hkGame.step(start, side === 0 ? [mine, IDLE] : [IDLE, mine]);
            return run(next, LOCK_TICKS);
          };
          const a = reveal(0);
          const b = reveal(1);
          expect(a.phase).toBe('betReveal');
          expect(a.mult).not.toBe(b.mult); // 確實是兩個不同的局面
          expect(hkGame.evaluate(b, side)).toEqual(hkGame.evaluate(a, side));
        }
      }
    }
  });

  it('黑箱：只有對方 pending 不同，深度 1、3、6 的 decide 回傳同一個按鍵', () => {
    for (const depth of [1, 3, 6]) {
      for (const stageIdx of [0, 1, 2, 3] as const) {
        for (const chips of [
          [100, 100],
          [80, 120],
          [120, 80],
        ] as [number, number][]) {
          for (const side of [0, 1] as const) {
            const opp = side === 0 ? 1 : 0;
            const make = (theirs: 0 | 1): HKState => {
              const pending: [0 | 1 | null, 0 | 1 | null] = [null, null];
              pending[opp] = theirs;
              return makeState({ stages: FOUR, stageIdx, phase: 'bet', pending, chips });
            };
            const params = { depth, seed: 0 };
            expect(
              pathfinder.decide(hkGame, make(1), side, 0, params),
              `深度 ${depth} 場 ${stageIdx} 籌碼 ${chips.join('/')} 邊 ${side}`,
            ).toEqual(pathfinder.decide(hkGame, make(0), side, 0, params));
          }
        }
      }
    }
  });

  it('只有對方的加倍牌張數不同是公開資訊：它沒有加倍牌時，AI 對它的模型跟著變（gain 不同）', () => {
    const holds = betState({ stages: FOUR, stageIdx: 2, pending: [0, null] });
    const spent = betState({ stages: FOUR, stageIdx: 2, pending: [0, null], doublers: [1, 0] });
    const reveal = (state: HKState): HKState =>
      run(hkGame.step(state, [IDLE, PRESS_B]), LOCK_TICKS);
    const a = hkGame.evaluate(reveal(holds), 0).gain;
    const b = hkGame.evaluate(reveal(spent), 0).gain;
    expect(a).not.toBe(b);
  });
});

describe('H-K 紅心馬拉松｜DESIGN-AI-FUN 10.6 的兩個 pending 陷阱', () => {
  it('actions()[0] 是 b（不用）：是會登記的按鍵；兩邊都取 actions()[0]，bet 一步就推進到 betLocked', () => {
    const state = betState({ stages: FOUR });
    for (const side of [0, 1] as const) {
      const actions = hkGame.actions(state, side);
      expect(actions).toEqual([PRESS_B, PRESS_A]);
    }
    const first0 = hkGame.actions(state, 0)[0] as Buttons;
    const first1 = hkGame.actions(state, 1)[0] as Buttons;
    const next = hkGame.step(state, [first0, first1]);
    expect(next.phase).toBe('betLocked');
    expect(next.pending).toEqual([0, 0]);
  });

  it('其他階段 actions 只有「全放開」，play 階段是被包的牌的 actions', () => {
    for (const phase of ['betPrep', 'betLocked', 'betReveal', 'stageResult'] as HKPhase[]) {
      const state = makeState({ stages: FOUR, phase, wait: 5, pending: [0, 0] });
      expect(hkGame.actions(state, 0)).toEqual([IDLE]);
      expect(hkGame.actions(state, 1)).toEqual([IDLE]);
    }
  });

  it('陷阱一：鎖定到揭示只要 3 步；深度 3 的搜尋走得到 betReveal，深度 2 走不到', () => {
    const reach = (depth: number): Set<HKPhase> => {
      const seen = new Set<HKPhase>();
      const spy: Game<HKState> = {
        ...hkGame,
        evaluate: (state, side) => {
          seen.add(state.phase);
          return hkGame.evaluate(state, side);
        },
      };
      pathfinder.decide(spy, betState({ stages: FOUR }), 0, 0, { depth, seed: 0 });
      return seen;
    };
    expect(reach(2).has('betReveal')).toBe(false);
    expect(reach(3).has('betReveal')).toBe(true);
    expect(reach(6).has('betReveal')).toBe(true);
  });

  it('陷阱二：搜尋裡的對手永遠取 actions()[0]，結算不會原地空轉：深度 6 的最深局面已經過了鎖定', () => {
    const phases = new Set<HKPhase>();
    const spy: Game<HKState> = {
      ...hkGame,
      evaluate: (state, side) => {
        phases.add(state.phase);
        return hkGame.evaluate(state, side);
      },
    };
    pathfinder.decide(spy, betState({ stages: FOUR }), 1, 0, { depth: 6, seed: 0 });
    expect(phases.has('bet')).toBe(false);
    expect(phases.has('betLocked')).toBe(true);
    expect(phases.has('betReveal')).toBe(true);
  });
});

describe('H-K 紅心馬拉松｜純度、不可變、結束', () => {
  it('step 不改動傳進來的 state：整場（凍結過的 state）都不丟錯', () => {
    let state = deepFreeze(hkGame.init(2, CONFIG));
    const c0 = withBet(level(8, 3), () => 1);
    const c1 = withBet(level(8, 4), never);
    let guard = 0;
    while (!hkGame.isOver(state) && guard < 3600) {
      const inputs: Inputs = [c0.decide(state, 0, state.tick), c1.decide(state, 1, state.tick)];
      state = deepFreeze(hkGame.step(state, inputs));
      guard += 1;
    }
    expect(hkGame.isOver(state)).toBe(true);
  });

  it('兩邊都不按也會在 3600 tick 之內結束（每場等 120 tick 自動不用）', () => {
    let state = hkGame.init(0, CONFIG);
    let ticks = 0;
    while (!hkGame.isOver(state) && ticks < 3600) {
      state = hkGame.step(state, IDLE_PAIR);
      ticks += 1;
    }
    expect(hkGame.isOver(state)).toBe(true);
    expect(state.results).toHaveLength(STAGES);
  });

  it('maxTicks 比預設小也會在 maxTicks 之內結束（1600）', () => {
    let state = hkGame.init(1, { maxTicks: 1600, params: {} });
    let ticks = 0;
    while (!hkGame.isOver(state) && ticks < 1600) {
      state = hkGame.step(state, IDLE_PAIR);
      ticks += 1;
    }
    expect(hkGame.isOver(state)).toBe(true);
  });
});

describe('H-K 紅心馬拉松｜meta 與登記', () => {
  it('meta：H-K、搜尋型、baseLevel 4、不對稱（H-A 的先後手）、說明裡寫明互動借自被包的牌', () => {
    expect(hkMeta.id).toBe('H-K');
    expect(hkMeta.suit).toBe('H');
    expect(hkMeta.rank).toBe('K');
    expect(hkMeta.defaultPolicy).toBe('pathfinder');
    expect(hkMeta.baseLevel).toBe(4);
    expect(hkMeta.symmetric).toBeFalsy();
    expect(hkMeta.description).toMatch(/借自/);
    expect(hkMeta.description).toMatch(/沒有自己的/);
  });

  it('登記表有 H-K，而且沒有宣告 selfFromPresent', () => {
    const entry = registry.find((e) => e.id === 'H-K');
    expect(entry).toBeDefined();
    expect(entry?.game).toBe(hkGame);
    expect('selfFromPresent' in hkGame).toBe(false);
  });
});

describe('H-K 紅心馬拉松｜render', () => {
  const phases: HKPhase[] = ['betPrep', 'bet', 'betLocked', 'betReveal', 'play', 'stageResult'];

  it.each(phases)('%s：不丟錯、不改 state、只用色盤、畫在 320×240 之內', (phase) => {
    for (const id of STAGE_POOL) {
      const stages = [id, ...STAGE_POOL.filter((x) => x !== id).slice(0, 3)] as StageId[];
      const state = deepFreeze(
        makeState({
          stages,
          phase,
          wait: 5,
          pending: phase === 'betLocked' || phase === 'betReveal' ? [1, 0] : [null, null],
          used: phase === 'betReveal' || phase === 'play' ? [true, false] : [false, false],
          mult: phase === 'betReveal' || phase === 'play' ? 2 : 1,
          chips: [95, 105],
        }),
      );
      const context = createFakeContext();
      expect(() => hkRender(asRenderingContext(context), state)).not.toThrow();
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
  });

  it('結束的局面也能畫', () => {
    const state = deepFreeze(
      makeState({
        stages: FOUR,
        stageIdx: 3,
        phase: 'stageResult',
        over: true,
        winner: 0,
        chips: [120, 80],
      }),
    );
    const context = createFakeContext();
    expect(() => hkRender(asRenderingContext(context), state)).not.toThrow();
  });
});
