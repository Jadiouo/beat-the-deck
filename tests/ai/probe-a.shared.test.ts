import { describe, expect, it } from 'vitest';

import { levelController } from '../../src/ai/level';
import { MATCH_CONFIG } from '../../src/ai/evolution';
import { pathfinder } from '../../src/ai/policies/pathfinder';
import { playMatch } from '../../src/core/match';
import type { Buttons, Controller, Game, GameConfig, Inputs, Side } from '../../src/core/types';
import { registry } from '../../src/games/registry';
import type { MatchOutcome } from './probe-a.shared';
import {
  compareBC,
  divergence,
  formatProbeA,
  outcomeOf,
  pairedStats,
  shadow,
} from './probe-a.shared';

/**
 * 探針 A 共用工具的測試（DESIGN-AI-FUN 10.59 的決策分歧率前置檢查）。
 *
 * 全部用一張很小的假遊戲，不依賴任何一張真牌的規則，所以很快（light project）。
 * 例外是「影子不影響對局」那一條：它另外用 registry 的第一張真牌與等級控制器再驗一次。
 */

// ---------------------------------------------------------------------------
// 假遊戲：4 個 tick。每個 tick 按 a 得 1 分。state 帶一串「可見的亂數位」bits，讓控制器有東西可讀。
// ---------------------------------------------------------------------------
const TICKS = 4;
interface TapState {
  readonly t: number;
  readonly bits: readonly number[];
  readonly points: readonly [number, number];
}
const NO: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const A: Buttons = { ...NO, a: true };

const tap: Game<TapState> = {
  id: 'tap-fixture',
  init(seed) {
    // 簡單的線性同餘；seed 相同位就相同。
    let x = (seed * 2654435761 + 12345) >>> 0;
    const bits: number[] = [];
    for (let i = 0; i < TICKS; i += 1) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      bits.push((x >>> 16) & 1);
    }
    return { t: 0, bits, points: [0, 0] };
  },
  step(state, inputs: Inputs) {
    return {
      t: state.t + 1,
      bits: state.bits,
      points: [
        state.points[0] + (inputs[0].a ? 1 : 0),
        state.points[1] + (inputs[1].a ? 1 : 0),
      ] as const,
    };
  },
  isOver: (state) => state.t >= TICKS,
  score: (state) => state.points,
  winner(state) {
    if (state.points[0] === state.points[1]) return null;
    return state.points[0] > state.points[1] ? 0 : 1;
  },
  actions: () => [NO, A],
  evaluate: (state, side) => ({ gain: state.points[side] - state.points[1 - side], danger: 0 }),
};

const CONFIG: GameConfig = { maxTicks: 10, params: {} };
const fn = (f: (s: TapState, side: Side, tick: number) => boolean): Controller<TapState> => ({
  decide: (s, side, tick) => (f(s, side, tick) ? A : NO),
});
/** 對手：只在 tick 0 按一次，得 1 分。 */
const oppOnce = fn((_s, _side, tick) => tick === 0);
const seat0 = (ctl: Controller<TapState>, seed: number): MatchOutcome => {
  const r = playMatch(tap, seed, CONFIG, ctl, oppOnce);
  return outcomeOf(r, 0);
};
const SEEDS = Array.from({ length: 60 }, (_v, i) => i);

describe('outcomeOf', () => {
  it('勝 1、敗 0、平 0.5，分差是我方減對方', () => {
    const win = playMatch(tap, 0, CONFIG, fn(() => true), fn(() => false));
    const lose = playMatch(tap, 0, CONFIG, fn(() => false), fn(() => true));
    const draw = playMatch(tap, 0, CONFIG, fn(() => true), fn(() => true));
    expect(outcomeOf(win, 0)).toEqual({ win: 1, margin: TICKS });
    expect(outcomeOf(lose, 0)).toEqual({ win: 0, margin: -TICKS });
    expect(outcomeOf(draw, 0)).toEqual({ win: 0.5, margin: 0 });
    // 坐另一邊時視角要翻過來
    expect(outcomeOf(win, 1)).toEqual({ win: 0, margin: -TICKS });
  });
});

describe('pairedStats（同種子配對差的平均與配對標準誤）', () => {
  it('手算案例一：差 [1, 0, 0, 1] → 平均 0.5、樣本變異 1/3、SE = sqrt(1/12)', () => {
    const s = pairedStats([1, 0, 0, 1]);
    expect(s.n).toBe(4);
    expect(s.mean).toBeCloseTo(0.5, 12);
    expect(s.se).toBeCloseTo(Math.sqrt(1 / 12), 12);
  });

  it('手算案例二：差 [2, 4, 6] → 平均 4、樣本變異 4、SE = 2/sqrt(3)', () => {
    const s = pairedStats([2, 4, 6]);
    expect(s.mean).toBeCloseTo(4, 12);
    expect(s.se).toBeCloseTo(2 / Math.sqrt(3), 12);
  });

  it('全部相同 → SE = 0；樣本少於 2 個 → SE 不是數字（不假裝有）', () => {
    expect(pairedStats([3, 3, 3]).se).toBe(0);
    expect(pairedStats([5]).se).toBeNaN();
    expect(pairedStats([]).mean).toBeNaN();
  });
});

describe('divergence：兩個完全相同的控制器', () => {
  it('場級與點級分歧率都是 0（有 isPoint 與沒有 isPoint 兩種）', () => {
    const mk = (): Controller<TapState> => fn((s, _side, tick) => s.bits[tick] === 1);
    for (const isPoint of [undefined, (_s: TapState, _side: Side, tick: number) => tick === 0]) {
      const d = divergence({ makeB: mk, makeC: mk, seeds: SEEDS, play: seat0, isPoint });
      expect(d.games).toBe(SEEDS.length);
      expect(d.gamesDiffer).toBe(0);
      expect(d.gameRate).toBe(0);
      expect(d.pointRate).toBe(0);
      expect(d.diffTicks).toBe(0);
      expect(d.firstDiffs.every((x) => x === -1)).toBe(true);
    }
  });
});

describe('divergence：兩個明顯不同的控制器', () => {
  const makeB = (): Controller<TapState> => fn(() => false);
  const makeC = (): Controller<TapState> => fn(() => true);

  it('場級 100%、每個 tick 都不同、第一個分歧在 tick 0', () => {
    const d = divergence({ makeB, makeC, seeds: SEEDS, play: seat0 });
    expect(d.gameRate).toBe(1);
    expect(d.diffTicks).toBe(SEEDS.length * TICKS);
    expect(d.firstDiffs.every((x) => x === 0)).toBe(true);
    expect(d.pointBasis).toBe('episode');
    expect(d.pointRate).toBe(1);
  });

  it('isPoint 決定「點」是什麼：只數 tick 2，一場恰好一個點、全部不同', () => {
    const d = divergence({
      makeB,
      makeC,
      seeds: SEEDS,
      play: seat0,
      isPoint: (_s, _side, tick) => tick === 2,
    });
    expect(d.pointBasis).toBe('isPoint');
    expect(d.points).toBe(SEEDS.length);
    expect(d.pointsDiff).toBe(SEEDS.length);
  });

  it('isPoint 一個點都沒有的牌：點級是 NaN（n/a），不是 0', () => {
    const d = divergence({
      makeB,
      makeC,
      seeds: SEEDS,
      play: seat0,
      isPoint: () => false,
    });
    expect(d.points).toBe(0);
    expect(d.pointRate).toBeNaN();
  });
});

describe('compareBC：場級分歧率是勝率差的上限（10.59）', () => {
  it('構造案例：(c)−(b) 的勝率差恰好等於場級分歧率（上限是緊的）', () => {
    // 對手只在 tick 0 得 1 分。B 從不按 → 0 比 1 必輸。
    // C 只在 bits[0] = 1 的局面按兩下 → 2 比 1 贏；其餘局面也不按 → 輸。
    // 所以 C 與 B 只在 bits[0] = 1 的場不同，而且每一場不同的都從輸變成贏。
    const makeB = (): Controller<TapState> => fn(() => false);
    const makeC = (): Controller<TapState> =>
      fn((s, _side, tick) => s.bits[0] === 1 && tick < 2);
    const r = compareBC({ makeB, makeC, seeds: SEEDS, play: seat0 });
    expect(r.divergence.gameRate).toBeGreaterThan(0);
    expect(r.divergence.gameRate).toBeLessThan(1);
    expect(r.win.b).toBe(0);
    expect(r.win.c).toBeCloseTo(r.divergence.gameRate, 12);
    expect(r.win.diff.mean).toBeCloseTo(r.divergence.gameRate, 12);
    expect(r.winBoundHolds).toBe(true);
  });

  it('不等式 |勝率差| ≤ 場級分歧率 在各種控制器配對上都成立，一致性檢查沒有違規', () => {
    const ctls: Array<() => Controller<TapState>> = [
      () => fn(() => false),
      () => fn(() => true),
      () => fn((s, _side, tick) => s.bits[tick] === 1),
      () => fn((s, _side, tick) => s.bits[tick] === 0),
      () => fn((_s, _side, tick) => tick === 0),
      () => fn((s, _side, tick) => tick === 3 && s.bits[3] === 1),
    ];
    for (const makeB of ctls) {
      for (const makeC of ctls) {
        const r = compareBC({ makeB, makeC, seeds: SEEDS, play: seat0 });
        expect(Math.abs(r.win.diff.mean)).toBeLessThanOrEqual(r.divergence.gameRate + 1e-12);
        expect(r.winBoundHolds).toBe(true);
        expect(r.inconsistentSeeds).toEqual([]);
      }
    }
  });

  it('同時回傳勝率與分差，分差是同種子配對差，並另報「有分歧的場」的分差', () => {
    const makeB = (): Controller<TapState> => fn(() => false);
    const makeC = (): Controller<TapState> =>
      fn((s, _side, tick) => s.bits[0] === 1 && tick < 2);
    const r = compareBC({ makeB, makeC, seeds: SEEDS, play: seat0 });
    // B 每場 0:1 → 分差 −1。C 在 bits[0]=1 的場 2:1 → +1，其餘 −1。
    const differing = r.divergence.gamesDiffer;
    expect(r.margin.b.mean).toBeCloseTo(-1, 12);
    expect(r.margin.diff.n).toBe(SEEDS.length);
    expect(r.margin.diff.mean).toBeCloseTo((2 * differing) / SEEDS.length, 12);
    // 有分歧的場：每一場配對差都是 +2，變異為 0
    expect(r.marginWhereDiffer.n).toBe(differing);
    expect(r.marginWhereDiffer.mean).toBeCloseTo(2, 12);
    expect(r.marginWhereDiffer.se).toBe(0);
    // 配對 SE 與手算一致：差是 {0, 2}，n 場、k 場為 2
    const n = SEEDS.length;
    const mean = (2 * differing) / n;
    const variance = (differing * (2 - mean) ** 2 + (n - differing) * mean ** 2) / (n - 1);
    expect(r.margin.diff.se).toBeCloseTo(Math.sqrt(variance / n), 12);
  });

  it('抓得到「影子比對沒看到分歧、兩條路徑結果卻不同」的非決定性（一致性檢查）', () => {
    const makeB = (): Controller<TapState> => fn(() => false);
    // 每次建構的 C 看一個全域計數器：奇數次（B 驅動時的影子）永遠不按，與 B 一致；
    // 偶數次（C 驅動時）永遠按。比對看不出分歧，但兩條路徑的結果不同。
    let built = 0;
    const flaky = (): Controller<TapState> => {
      built += 1;
      const pressing = built % 2 === 0;
      return fn(() => pressing);
    };
    const r = compareBC({ makeB, makeC: flaky, seeds: [0, 1, 2], play: seat0 });
    expect(r.divergence.gameRate).toBe(0);
    expect(r.inconsistentSeeds).toEqual([0, 1, 2]);
  });
});

describe('影子的回答不會影響對局（整個方法的正確性前提）', () => {
  // 影子故意很吵：有自己的狀態、每個 tick 回答都不同、而且與驅動者幾乎都不一樣。
  const noisyShadow = (): Controller<TapState> => {
    let x = 7;
    return {
      decide: (): Buttons => {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        return { ...NO, a: (x & 0x10000) !== 0, up: (x & 0x20000) !== 0 };
      },
    };
  };

  it('假遊戲：D 單獨跑與 D 帶著影子跑，輸入紀錄與終局雜湊逐位元相同', () => {
    for (const seed of SEEDS) {
      const driver = (): Controller<TapState> => fn((s, _side, tick) => s.bits[tick] === 1);
      const alone = playMatch(tap, seed, CONFIG, driver(), oppOnce);
      const { ctl, stat } = shadow(driver(), noisyShadow());
      const withShadow = playMatch(tap, seed, CONFIG, ctl, oppOnce);
      expect(withShadow.inputs).toEqual(alone.inputs);
      expect(withShadow.finalHash).toBe(alone.finalHash);
      expect(withShadow.score).toEqual(alone.score);
      expect(stat.ticks).toBe(alone.ticks);
    }
  });

  it('影子拿到的是和驅動者同一個 state、同一個 side、同一個 tick', () => {
    const seen: Array<[TapState, Side, number]> = [];
    const spy: Controller<TapState> = {
      decide(s, side, tick) {
        seen.push([s, side, tick]);
        return NO;
      },
    };
    const asked: Array<[TapState, Side, number]> = [];
    const driver: Controller<TapState> = {
      decide(s, side, tick) {
        asked.push([s, side, tick]);
        return NO;
      },
    };
    const { ctl } = shadow(driver, spy);
    playMatch(tap, 3, CONFIG, ctl, oppOnce);
    expect(seen.length).toBe(TICKS);
    expect(seen).toEqual(asked);
    seen.forEach((row, i) => {
      expect(row[0]).toBe(asked[i]?.[0]); // 同一個物件，不是複本
    });
  });

  it('真牌＋等級控制器（有自己的亂數）：帶影子與不帶影子，結果逐位元相同', () => {
    const entry = registry[0];
    if (entry === undefined) throw new Error('registry 是空的');
    const game = entry.game as Game<unknown>;
    for (const seed of [0, 1, 2]) {
      const mk = (s: number): Controller<unknown> => levelController(game, pathfinder, 10, s);
      const rival = (): Controller<unknown> => levelController(game, pathfinder, 10, seed + 1_000_003);
      const alone = playMatch(game, seed, MATCH_CONFIG, mk(seed), rival());
      // 影子是另一個種子的等級控制器，答案和驅動者會常常不同
      const { ctl, stat } = shadow(mk(seed), mk(seed + 99));
      const withShadow = playMatch(game, seed, MATCH_CONFIG, ctl, rival());
      expect(withShadow.finalHash).toBe(alone.finalHash);
      expect(withShadow.inputs).toEqual(alone.inputs);
      expect(stat.ticks).toBe(alone.ticks);
    }
  });
});

describe('formatProbeA', () => {
  it('一行字裡一定有 (c)−(b) 與場級分歧率這一對數字（單報 (c)−(b) 沒有意義）', () => {
    const makeB = (): Controller<TapState> => fn(() => false);
    const makeC = (): Controller<TapState> => fn((s, _side, tick) => s.bits[0] === 1 && tick < 2);
    const r = compareBC({ makeB, makeC, seeds: SEEDS, play: seat0 });
    const line = formatProbeA('fixture', r);
    expect(line).toContain('(c)−(b)');
    expect(line).toContain('場級分歧率');
    expect(line).toContain('點級');
    expect(line).toContain(`n=${SEEDS.length}`);
  });
});
