import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { deepFreeze } from '../../../tests/contract/freeze';
import { CLEAR_CAP, makeState } from './logic';
import type { S10State } from './logic';
import {
  B_FAMILY,
  C_FAMILY,
  makeRule,
  pairedStats,
  playMulti,
  playPair,
  selectBest,
} from './probe-a.test-helpers';

/**
 * S-10 探針 A 重做（`docs/cards/S-10.md`「探針 A 重做」）的工具測試。
 * 這支檔案只測量測工具本身（族的定義、(b) 不讀對手、(c) 真的讀、分歧率、配對標準誤、選法）。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const bullets = (n: number): { x: number; y: number }[] =>
  Array.from({ length: n }, (_v, i) => ({ x: 10 + (i % 20) * 6, y: 40 + Math.floor(i / 20) * 6 }));

/** 第 `tick` 個 tick、場上 n 顆子彈、還有 `clears` 次清場的局面（兩人都離子彈遠）。 */
const at = (tick: number, n: number, extra: Parameters<typeof makeState>[0] = {}): S10State =>
  makeState({
    tick,
    bullets: bullets(n),
    clears: 3,
    players: [{ x: 20, y: 120 }, { x: 130, y: 120 }],
    ...extra,
  });

describe('族的定義', () => {
  it('(b) 族 12 個、(c) 族 8 個，名字不重複', () => {
    expect(B_FAMILY).toHaveLength(12);
    expect(C_FAMILY).toHaveLength(8);
    expect(new Set([...B_FAMILY, ...C_FAMILY]).size).toBe(20);
  });
});

describe('(b) 不讀對手的任何狀態', () => {
  const variants: readonly ((s: S10State) => S10State)[] = [
    (s) => ({ ...s, players: [s.players[0], { ...s.players[1], x: 5, y: 5, invuln: 40, hits: 3, vx: 1, vy: -1 }] }),
    (s) => ({ ...s, exposure: [s.exposure[0], 0.04] }),
    (s) => ({ ...s, lock: [s.lock[0], 90] }),
    (s) => ({ ...s, cleared: [s.cleared[0], 50] }),
  ];
  const sample = (): S10State[] => [at(300, 24), at(330, 30), at(360, 12), at(400, 30, { clears: 2 }), at(1200, 40, { clears: 1 })];

  it.each(B_FAMILY.map((name) => [name]))('%s：換掉對手的位置、險度、鎖、分數，每個 tick 的決定都一樣', (name) => {
    for (const vary of variants) {
      const plain = makeRule(name, 3);
      const varied = makeRule(name, 3);
      for (const s of sample()) {
        for (let k = 0; k < 40; k += 1) {
          const base = { ...s, tick: s.tick + k };
          expect(varied.press(vary(base), 0, base.tick)).toBe(plain.press(base, 0, base.tick));
        }
      }
    }
  });
});

describe('(c) 真的讀了對手（換掉它讀的東西，決定會變）', () => {
  const differs = (name: string, make: (n: number) => [S10State, S10State]): boolean => {
    for (let n = 8; n <= CLEAR_CAP; n += 1) {
      const [a, b] = make(n);
      const ra = makeRule(name, 1);
      const rb = makeRule(name, 1);
      for (let k = 0; k < 80; k += 1) {
        if (ra.press({ ...a, tick: a.tick + k }, 0, a.tick + k) !== rb.press({ ...b, tick: b.tick + k }, 0, b.tick + k)) {
          return true;
        }
      }
    }
    return false;
  };
  const pair = (tick: number, other: Partial<S10State>): ((n: number) => [S10State, S10State]) => (n) => [
    at(tick, n, { clears: 2 }),
    { ...at(tick, n, { clears: 2 }), ...other },
  ];

  it('c-reader 與 c-expfull 讀險度', () => {
    expect(differs('c-reader', pair(400, { exposure: [0, 0.05] }))).toBe(true);
    expect(differs('c-expfull', pair(400, { exposure: [0, 0.05] }))).toBe(true);
  });
  it('c-lock 讀對手的鎖', () => {
    expect(differs('c-lock', pair(360, { lock: [0, 100] }))).toBe(true);
  });
  it('c-lead 讀分數', () => {
    expect(differs('c-lead', pair(400, { cleared: [30, 0] }))).toBe(true);
  });
  it('c-oppinvuln 讀對手的無敵', () => {
    expect(
      differs('c-oppinvuln', (n) => [at(360, n), { ...at(360, n), players: [at(360, n).players[0], { ...at(360, n).players[1], invuln: 30 }] }]),
    ).toBe(true);
  });
  it('c-oppdanger 讀對手此刻的危險（對手貼著子彈）', () => {
    const near = (n: number): S10State => {
      const s = at(400, n, { clears: 2 });
      return { ...s, bullets: [...s.bullets, { x: 130, y: 118, vx: 0, vy: 1 }], players: [s.players[0], { ...s.players[1], x: 130, y: 121 }] };
    };
    expect(differs('c-oppdanger', (n) => [at(400, n, { clears: 2 }), near(n)])).toBe(true);
  });
  it('c-wait-opp-far 讀對手的位置與險度', () => {
    const near = (n: number): S10State => {
      const s = at(360, n);
      return { ...s, bullets: [...s.bullets, { x: 130, y: 118, vx: 0, vy: 1 }], players: [s.players[0], { ...s.players[1], x: 130, y: 121 }] };
    };
    expect(differs('c-wait-opp-far', (n) => [at(360, n), near(n)])).toBe(true);
  });
});

describe('(b) 族不會全部飽和在「準備好就按」', () => {
  const firstPress = (name: string): number => {
    const rule = makeRule(name, 5);
    for (let t = 300; t < 420; t += 1) {
      if (rule.press(at(t, 24), 0, t)) {
        return t;
      }
    }
    return -1;
  };
  it('固定延遲：wait k 在準備後第 k 個 tick 按', () => {
    expect(firstPress('b-habit')).toBe(300);
    expect(firstPress('b-wait1')).toBe(301);
    expect(firstPress('b-wait3')).toBe(303);
    expect(firstPress('b-wait10')).toBe(310);
    expect(firstPress('b-wait30')).toBe(330);
  });
  it('至少有 5 種不同的第一次按的時刻', () => {
    expect(new Set(B_FAMILY.map(firstPress)).size).toBeGreaterThanOrEqual(5);
  });
  it('準備時刻每次清場重算（第二次清場也是準備後才開始等）', () => {
    const rule = makeRule('b-wait3', 1);
    // 先讓第一次清場的等待走完，再切到第二次清場的準備時刻
    expect(rule.press(at(300, 24), 0, 300)).toBe(false);
    expect(rule.press(at(303, 24), 0, 303)).toBe(true);
    expect(rule.press(at(330, 3, { clears: 2, quiet: 15 }), 0, 330)).toBe(false); // 無彈期，不是準備
    expect(rule.press(at(360, 12, { clears: 2 }), 0, 360)).toBe(false); // 準備 tick
    expect(rule.press(at(362, 12, { clears: 2 }), 0, 362)).toBe(false);
    expect(rule.press(at(363, 12, { clears: 2 }), 0, 363)).toBe(true);
  });
  it('機率型：同種子同序列，不同種子不同', () => {
    const run = (seed: number): boolean[] => {
      const r = makeRule('b-prob25', seed);
      return Array.from({ length: 40 }, (_v, i) => r.press(at(300 + i, 24), 0, 300 + i));
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });
});

describe('對局、分歧率與統計', () => {
  it('同一個規則當驅動者與影子：決策點有，分歧 0，結果與分差相同', () => {
    const r = playPair('b-habit', 'b-habit', 3, { level: 5 });
    expect(r.points).toBeGreaterThanOrEqual(3);
    expect(r.diffPoints).toBe(0);
    expect(r.firstDiffTick).toBe(-1);
  });
  it('b-habit 與 b-wait10：第一個分歧就在第 300 tick', () => {
    const r = playPair('b-habit', 'b-wait10', 3, { level: 5 });
    expect(r.firstDiffTick).toBe(300);
    expect(r.diffPoints).toBeGreaterThanOrEqual(1);
  });
  it('驅動者決定對局：b-wait10 驅動的結果與 b-habit 驅動的不同（等了就被 AI 搶走）', () => {
    const slow = playPair('b-wait10', 'b-habit', 4, { level: 10 });
    const fast = playPair('b-habit', 'b-wait10', 4, { level: 10 });
    expect(fast.margin).toBeGreaterThan(slow.margin);
  });
  it('配對差與標準誤', () => {
    const { mean, se } = pairedStats([1, 0, 0.5, 1], [0.5, 0, 0.5, 0]);
    expect(mean).toBeCloseTo(0.375, 10);
    // 差 = [0.5, 0, 0, 1]，平均 0.375，樣本標準差 sqrt(((0.125)^2+(0.375)^2*2+(0.625)^2)/3)，除以 sqrt(4)
    const sd = Math.sqrt((0.125 ** 2 + 0.375 ** 2 * 2 + 0.625 ** 2) / 3);
    expect(se).toBeCloseTo(sd / 2, 10);
    expect(pairedStats([1, 1], [1, 1])).toEqual({ mean: 0, se: 0 });
  });
  it('選法：勝率高者；同勝率取分差高；再同取排在前面的', () => {
    expect(selectBest([{ name: 'x', win: 40, margin: 9 }, { name: 'y', win: 51, margin: 1 }])).toBe('y');
    expect(selectBest([{ name: 'x', win: 51, margin: 1 }, { name: 'y', win: 51, margin: 2 }])).toBe('y');
    expect(selectBest([{ name: 'x', win: 51, margin: 2 }, { name: 'y', win: 51, margin: 2 }])).toBe('x');
  });
});

describe('(c) 不用 AI 的引擎', () => {
  it('工具檔不 import evaluate、predictOpponent，也不拿 levelController 的 AI 當 (c) 成員', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    const imports = text.split('\n').filter((l) => /^\s*(import|\}\s*from|\s+\w+,?\s*$)/.test(l)).join('\n');
    expect(imports).not.toMatch(/\bevaluate\b/);
    expect(text).not.toMatch(/predictOpponent/);
    // 工具檔不呼叫 s10Game.evaluate / evaluate(
    expect(text).not.toMatch(/\.evaluate\(|\bevaluate\(/);
  });
});

describe('影子不影響對局', () => {
  it('同一個驅動者配三個不同的影子：對局的結果、分差、清場紀錄逐項相同，而分歧點數確實不同', () => {
    for (const driver of ['b-wait3', 'c-learn']) {
      const runs = ['b-habit', 'b-prob25', 'c-oppinvuln'].map((shadow) => playPair(driver, shadow, 3, { level: 5 }));
      const [first, ...rest] = runs;
      for (const r of rest) {
        expect(r.win).toBe(first?.win);
        expect(r.margin).toBe(first?.margin);
        expect(r.hitsMe).toBe(first?.hitsMe);
        expect(r.clears).toEqual(first?.clears);
      }
    }
    const diffs = ['b-habit', 'b-wait10'].map((shadow) => playPair('b-wait3', shadow, 3, { level: 5 }).diffPoints);
    expect(diffs[0]).not.toBe(diffs[1]);
  }, 120_000);
  it('20 個成員在凍結的 state 上跑，沒有任何一個會寫 state（寫了會丟錯）', () => {
    for (const name of [...B_FAMILY, ...C_FAMILY, 'absent', 'd-sniper', 'd-sweep3']) {
      const rule = makeRule(name, 2);
      for (let k = 0; k < 70; k += 1) {
        const s = deepFreeze(at(300 + k, 24 + (k % 9), { lock: [0, k % 3 === 0 ? 5 : 0], exposure: [0, 0.01] }));
        expect(() => rule.press(s, k % 2 === 0 ? 0 : 1, s.tick)).not.toThrow();
      }
    }
  });
});

describe('playMulti', () => {
  it('多個影子與逐個 playPair 的分歧完全一致，驅動者的對局不變', () => {
    const multi = playMulti('b-habit', ['b-wait3', 'c-reader'], 3, { level: 5 });
    const a = playPair('b-habit', 'b-wait3', 3, { level: 5 });
    const b = playPair('b-habit', 'c-reader', 3, { level: 5 });
    expect(multi.shadows[0]).toEqual({ points: a.points, diffPoints: a.diffPoints, firstDiffTick: a.firstDiffTick });
    expect(multi.shadows[1]).toEqual({ points: b.points, diffPoints: b.diffPoints, firstDiffTick: b.firstDiffTick });
    expect(multi.margin).toBe(a.margin);
    expect(multi.margin).toBe(b.margin);
  }, 120_000);
});
