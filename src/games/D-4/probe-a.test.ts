import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC, divergence, pairedStats, shadow } from '../../../tests/ai/probe-a.shared';
import { deepFreeze } from '../../../tests/contract/freeze';
import { levelController, policyByName } from '../../ai/level';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Side } from '../../core/types';
import { cell } from '../_diamonds/logic';
import { d4Game, makeState } from './logic';
import type { D4State } from './logic';
import { B_FAMILY, C_FAMILY, makeMember } from './probe-a.members.test-helpers';
import {
  CELLS,
  PRIMARY_CELL,
  isSettlePoint,
  playWith,
  selectBest,
  d4Spec,
} from './probe-a.test-helpers';
import type { Cell } from './probe-a.test-helpers';

/**
 * D-4 探針 A（完整版）的工具測試（`docs/cards/D-4.md`「探針 A（完整版）」）。
 * 只測量測工具本身：族的定義、(b) 不讀對手的狀態（包含 `holder` 只准讀 `=== side`）、(c) 真的讀、
 * 延遲、偵測被擋、分歧率與影子不影響對局。大場次的量測在 `measure.test.ts`。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const same = (x: Buttons, y: Buttons): boolean =>
  x.up === y.up && x.down === y.down && x.left === y.left && x.right === y.right;
const dirOf = (b: Buttons): string =>
  b.up ? 'up' : b.right ? 'right' : b.down ? 'down' : b.left ? 'left' : 'none';

type Overrides = Parameters<typeof makeState>[0];

/** 讓成員在 tick 0 看一次這個 state，回傳按鍵。`delay` 0 時舊畫面就是現在。 */
function decideOnce(name: string, state: D4State, side: Side = 0, delay: 0 | 12 = 0): Buttons {
  return makeMember(name, 1, delay).decide(state, side, 0);
}

const at = (x: number, y: number): number => cell(x, y);

describe('族的定義', () => {
  it('(b) 族 11 個、(c) 族 7 個，名字不重複，前綴是 b- 或 c-', () => {
    expect(B_FAMILY).toHaveLength(11);
    expect(C_FAMILY).toHaveLength(7);
    expect(new Set([...B_FAMILY, ...C_FAMILY]).size).toBe(18);
    expect(B_FAMILY.every((n) => n.startsWith('b-'))).toBe(true);
    expect(C_FAMILY.every((n) => n.startsWith('c-'))).toBe(true);
  });

  it('格子：9 格（貪心／精準 × L7／L10 × 延遲 0／12，加貪心 L5 延遲 12），主格是貪心 L7 延遲 12', () => {
    expect(CELLS).toHaveLength(9);
    expect(PRIMARY_CELL).toEqual({ policy: 'greedy', level: 7, delay: 12 });
    expect(CELLS).toContainEqual(PRIMARY_CELL);
    expect(CELLS).toContainEqual({ policy: 'greedy', level: 5, delay: 12 });
    expect(new Set(CELLS.map((c) => JSON.stringify(c))).size).toBe(9);
  });

  it('成員檔不 import AI 的 evaluate、predictOpponent、等級控制器，也不 import 現成的 calculator 與時鐘亂數', () => {
    const text = readFileSync(
      new URL('./probe-a.members.test-helpers.ts', import.meta.url),
      'utf8',
    );
    for (const banned of [
      'evaluate',
      'predictOpponent',
      'levelController',
      'wrapPolicy',
      'policyByName',
      'calculator',
      'players.test-helpers',
      'Math.random',
      'Date.now',
      'performance.now',
    ]) {
      expect(text, banned).not.toContain(banned);
    }
  });
});

describe('(b) 的基本動作', () => {
  // 我在 (15,12)，站在 (8,6)(23,17)(23,6)(8,17)，最近的站是 (8,17)（12 步）；唯一的金幣在 (15,8)（4 步，往上）。
  const base = (battery: number, extra: Overrides = {}): D4State =>
    makeState({
      players: [{ cell: at(15, 12) }, { cell: at(31, 0) }],
      coins: [at(15, 8)],
      battery: [battery, 40],
      ...extra,
    });

  it('thr(12)：電量 ≤ 12 去最近的站，> 12 去最近的金幣', () => {
    expect(dirOf(decideOnce('b-thr12', base(12)))).toBe('down');
    expect(dirOf(decideOnce('b-thr12', base(13)))).toBe('up');
    expect(dirOf(decideOnce('b-thr8', base(9)))).toBe('up');
    expect(dirOf(decideOnce('b-thr8', base(8)))).toBe('down');
    expect(dirOf(decideOnce('b-thr20', base(20)))).toBe('down');
    expect(dirOf(decideOnce('b-thr20', base(21)))).toBe('up');
  });

  it('站上而且電量沒到 chargeTo 就不動；thr16-to30 充到 30 就走', () => {
    const onStation = (battery: number): D4State =>
      makeState({
        players: [{ cell: at(8, 6) }, { cell: at(31, 0) }],
        coins: [at(8, 2)],
        battery: [battery, 40],
      });
    expect(dirOf(decideOnce('b-thr12', onStation(39)))).toBe('none');
    expect(dirOf(decideOnce('b-thr12', onStation(40)))).toBe('up');
    expect(dirOf(decideOnce('b-thr16-to30', onStation(29)))).toBe('none');
    expect(dirOf(decideOnce('b-thr16-to30', onStation(30)))).toBe('up');
  });

  it('plan(m)：電量 ≥ 到金幣 ＋ 金幣到最近的站 ＋ m 才去撿，不然去最近的站', () => {
    // d = 4，金幣 (15,8) 到最近的站 (8,6) 是 9 步：m=2 要 15 電、m=8 要 21 電
    expect(dirOf(decideOnce('b-plan-m2', base(15)))).toBe('up');
    expect(dirOf(decideOnce('b-plan-m2', base(14)))).toBe('down');
    expect(dirOf(decideOnce('b-plan-m4', base(17)))).toBe('up');
    expect(dirOf(decideOnce('b-plan-m4', base(16)))).toBe('down');
    expect(dirOf(decideOnce('b-plan-m8', base(21)))).toBe('up');
    expect(dirOf(decideOnce('b-plan-m8', base(20)))).toBe('down');
  });

  it('偵測被擋：站上連續 10 個 tick 電量沒有上升就把這個站標成不能用、離開；沒有偵測的留在原地', () => {
    const onStation = makeState({
      players: [{ cell: at(8, 6) }, { cell: at(31, 0) }],
      coins: [at(8, 2)],
      battery: [20, 40],
    });
    const det = makeMember('b-thr12-det', 1, 0);
    const plain = makeMember('b-thr12', 1, 0);
    const outs: string[] = [];
    const outsPlain: string[] = [];
    for (let t = 0; t < 16; t += 1) {
      outs.push(dirOf(det.decide({ ...onStation, tick: t }, 0, t)));
      outsPlain.push(dirOf(plain.decide({ ...onStation, tick: t }, 0, t)));
    }
    expect(outs.slice(0, 10).every((d) => d === 'none')).toBe(true);
    expect(outs.slice(10).some((d) => d !== 'none')).toBe(true);
    expect(outsPlain.every((d) => d === 'none')).toBe(true);
  });

  it('電量有在上升（我是 holder）就不會被當成被擋', () => {
    const det = makeMember('b-thr12-det', 1, 0);
    for (let t = 0; t < 40; t += 1) {
      const s = makeState({
        players: [{ cell: at(8, 6) }, { cell: at(31, 0) }],
        coins: [at(8, 2)],
        battery: [Math.min(39, 10 + 2 * Math.floor(t / 5)), 40],
        holder: [0, -1, -1, -1],
        tick: t,
      });
      expect(dirOf(det.decide(s, 0, t))).toBe('none');
    }
  });
});

describe('(c) 各自讀的東西（對準的局面）', () => {
  it('free：對手站在我最近的站上，我改去另一個站（thr12 不改）', () => {
    // 我在 (8,10) 電 8；最近的站 (8,6)（4 步），次近 (8,17)（7 步）
    const s = makeState({
      players: [{ cell: at(8, 10) }, { cell: at(8, 6) }],
      coins: [at(30, 20)],
      battery: [8, 40],
    });
    expect(dirOf(decideOnce('b-thr12', s))).toBe('up');
    expect(dirOf(decideOnce('c-free-thr12', s))).toBe('down');
    // holder 是對手也一樣（對手不在上面但 holder 還記著）
    const held = makeState({
      players: [{ cell: at(8, 10) }, { cell: at(8, 7) }],
      coins: [at(30, 20)],
      battery: [8, 40],
      holder: [1, -1, -1, -1],
    });
    expect(dirOf(decideOnce('c-free-thr12', held))).toBe('down');
    expect(dirOf(decideOnce('c-free-thr20', held))).toBe('down');
  });

  it('contest：對手到這枚金幣比我近，我不選它', () => {
    const s = makeState({
      players: [{ cell: at(10, 10) }, { cell: at(10, 6) }],
      coins: [at(10, 5), at(10, 18)],
      battery: [40, 40],
    });
    expect(dirOf(decideOnce('b-thr12', s))).toBe('up');
    expect(dirOf(decideOnce('c-contest-thr12', s))).toBe('down');
  });

  it('squeeze：對手電量低、離它最近的站比我遠，我去占那個站（thr12 去撿金幣）', () => {
    // 我 (10,15)、電 40；對手 (8,12)、電 5；對手最近的站是 (8,17)（5 步），我 4 步
    const s = makeState({
      players: [{ cell: at(10, 15) }, { cell: at(8, 12) }],
      coins: [at(10, 10)],
      battery: [40, 5],
    });
    expect(dirOf(decideOnce('b-thr12', s))).toBe('up');
    expect(['down', 'left']).toContain(dirOf(decideOnce('c-squeeze-thr12', s)));
    // 對手電量夠就不擠
    const healthy = { ...s, battery: [40, 30] as const };
    expect(dirOf(decideOnce('c-squeeze-thr12', healthy))).toBe('up');
  });

  it('squeeze：到了就站著不動，直到對手電量 ≥ 16', () => {
    const m = makeMember('c-squeeze-thr12', 1, 0);
    const mk = (oppBattery: number, t: number): D4State =>
      makeState({
        players: [{ cell: at(8, 17) }, { cell: at(8, 12) }],
        coins: [at(10, 10)],
        battery: [40, oppBattery],
        holder: [-1, -1, -1, 0],
        tick: t,
      });
    expect(dirOf(m.decide(mk(5, 0), 0, 0))).toBe('none');
    expect(dirOf(m.decide(mk(15, 1), 0, 1))).toBe('none');
    expect(dirOf(m.decide(mk(16, 2), 0, 2))).not.toBe('none');
  });

  it('squeeze：站了 100 個 tick 就放手（防僵局）', () => {
    const m = makeMember('c-squeeze-thr12', 1, 0);
    let last = 'none';
    for (let t = 0; t <= 130; t += 1) {
      const s = makeState({
        players: [{ cell: at(8, 17) }, { cell: at(8, 12) }],
        coins: [at(10, 10)],
        battery: [40, 5],
        holder: [-1, -1, -1, 0],
        tick: t,
      });
      last = dirOf(m.decide(s, 0, t));
    }
    expect(last).not.toBe('none');
  });

  it('c-calc 與 c-all 兩個都讀（free ＋ contest）', () => {
    const s = makeState({
      players: [{ cell: at(8, 10) }, { cell: at(8, 6) }],
      coins: [at(30, 20)],
      battery: [8, 40],
    });
    expect(dirOf(decideOnce('b-plan-m4', s))).toBe('up');
    expect(dirOf(decideOnce('c-calc', s))).toBe('down');
    expect(dirOf(decideOnce('c-all', s))).toBe('down');
    const contested = makeState({
      players: [{ cell: at(10, 10) }, { cell: at(10, 6) }],
      coins: [at(10, 5), at(10, 18)],
      battery: [40, 40],
    });
    expect(dirOf(decideOnce('b-plan-m4', contested))).toBe('up');
    expect(dirOf(decideOnce('c-calc', contested))).toBe('down');
    expect(dirOf(decideOnce('c-all', contested))).toBe('down');
  });

  it('延遲 12：(c) 讀對手的是 12 tick 前的畫面，自己的位置與電量是即時的', () => {
    const m = makeMember('c-free-thr12', 1, 12);
    const at12 = (t: number): D4State =>
      makeState({
        players: [{ cell: at(8, 10) }, { cell: t >= 1 ? at(8, 6) : at(20, 20) }],
        coins: [at(30, 20)],
        battery: [8, 40],
        tick: t,
      });
    const outs: string[] = [];
    for (let t = 0; t <= 13; t += 1) {
      outs.push(dirOf(m.decide(at12(t), 0, t)));
    }
    expect(outs[12]).toBe('up'); // 舊畫面（tick 0）對手還不在站上
    expect(outs[13]).toBe('down'); // 舊畫面（tick 1）對手已經在站上
  });
});

// ---------------------------------------------------------------------------
// 邊界：雙胞胎重播
// ---------------------------------------------------------------------------

type Scramble = (s: D4State, side: Side) => D4State;

/** 對手的狀態全部換掉：位置、待走方向、分數、電量、涓流、stuck；holder 裡「是我」以外的全部交換（對手的↔沒人的）。 */
const scrambleOpponent: Scramble = (s, side) => {
  const opp = side === 0 ? 1 : 0;
  const players: [D4State['players'][0], D4State['players'][1]] =
    side === 0
      ? [s.players[0], { cell: at(5, 5), pending: 2, score: 77 }]
      : [{ cell: at(5, 5), pending: 2, score: 77 }, s.players[1]];
  const battery: [number, number] = side === 0 ? [s.battery[0], 1] : [1, s.battery[1]];
  const trickle: [number, number] = side === 0 ? [s.trickle[0], 17] : [17, s.trickle[1]];
  const stuck: [number, number] = side === 0 ? [s.stuck[0], 500] : [500, s.stuck[1]];
  const holder = s.holder.map((v) => (v === side ? side : v === opp ? -1 : opp));
  return { ...s, players, battery, trickle, stuck, holder };
};

/** 兩邊都不該讀的欄位：亂數、對手的 stuck。 */
const scrambleHidden: Scramble = (s, side) => ({
  ...s,
  rng: s.rng + 999,
  stuck: side === 0 ? [s.stuck[0] + 3, s.stuck[1] + 3] : [s.stuck[0] + 3, s.stuck[1] + 3],
});

function recordRun(
  name: string,
  seed: number,
  delay: 0 | 12,
): { states: D4State[]; outs: Buttons[]; side: Side } {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const states: D4State[] = [];
  const outs: Buttons[] = [];
  const member = makeMember(name, seed, delay);
  const spy: Controller<D4State> = {
    decide(state, s, tick) {
      const out = member.decide(state, s, tick);
      states.push(state);
      outs.push(out);
      return out;
    },
  };
  const ai = levelController(d4Game, policyByName('greedy'), 7, seed + 1_000_003);
  const cfg = { maxTicks: 900, params: {} };
  if (side === 0) {
    playMatch(d4Game, seed, cfg, spy, ai);
  } else {
    playMatch(d4Game, seed, cfg, ai, spy);
  }
  return { states, outs, side };
}

function replayWith(
  name: string,
  seed: number,
  delay: 0 | 12,
  run: ReturnType<typeof recordRun>,
  f: Scramble,
): number {
  const twin = makeMember(name, seed, delay);
  let differ = 0;
  run.states.forEach((state, tick) => {
    const out = twin.decide(f(state, run.side), run.side, tick);
    if (!same(out, run.outs[tick] as Buttons)) {
      differ += 1;
    }
  });
  return differ;
}

describe('對手狀態的邊界（雙胞胎重播，真實對局的前 900 tick）', () => {
  it.each(B_FAMILY.map((n) => [n]))(
    '(b) %s 不讀對手的狀態（位置、電量、涓流、holder 裡不是我的）',
    (name) => {
      for (const delay of [0, 12] as const) {
        for (const seed of [3, 4]) {
          const run = recordRun(name, seed, delay);
          expect(run.states.length).toBe(900);
          expect(replayWith(name, seed, delay, run, scrambleOpponent)).toBe(0);
        }
      }
    },
    60_000,
  );

  it.each([...B_FAMILY, ...C_FAMILY].map((n) => [n]))(
    '%s 不讀亂數與 stuck',
    (name) => {
      const run = recordRun(name, 3, 0);
      expect(replayWith(name, 3, 0, run, scrambleHidden)).toBe(0);
    },
    60_000,
  );

  it('(c) 的雙胞胎重播確實會讓決定變（free 與 calc 在真實對局裡讀 holder 與對手的位置）', () => {
    let total = 0;
    for (const name of ['c-free-thr12', 'c-calc', 'c-all']) {
      for (const seed of [3, 4, 5, 6]) {
        total += replayWith(name, seed, 0, recordRun(name, seed, 0), scrambleOpponent);
      }
    }
    expect(total).toBeGreaterThan(0);
  }, 60_000);
});

describe('凍結的 state 上不寫 state', () => {
  it('所有成員在深度凍結的 state 上跑不丟錯', () => {
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      const m = makeMember(name, 2, 12);
      for (let t = 0; t < 40; t += 1) {
        const s = deepFreeze(
          makeState({
            tick: t,
            players: [{ cell: at(8 + (t % 5), 10) }, { cell: at(20, 12 - (t % 4)) }],
            battery: [Math.max(0, 40 - t), Math.max(0, 30 - t)],
            holder: [-1, t % 2 === 0 ? 1 : 0, -1, -1],
          }),
        );
        expect(() => m.decide(s, t % 2 === 0 ? 0 : 1, t)).not.toThrow();
      }
    }
  });
});

describe('對局、分歧率與統計', () => {
  const primary: Cell = { policy: 'greedy', level: 7, delay: 12 };
  const cell7: Cell = { policy: 'greedy', level: 7, delay: 0 };

  it('決策點是走格結算前的那個 tick', () => {
    expect(isSettlePoint(makeState({ tick: 4 }), 0, 4)).toBe(true);
    expect(isSettlePoint(makeState({ tick: 5 }), 0, 5)).toBe(false);
    expect(isSettlePoint(makeState({ tick: 9 }), 0, 9)).toBe(true);
  });

  it('同一個成員當驅動者與影子：決策點有、分歧 0', () => {
    const r = divergence(d4Spec('b-thr12', 'b-thr12', [3, 4], primary));
    expect(r.pointBasis).toBe('isPoint');
    expect(r.points).toBeGreaterThan(0);
    expect(r.pointsDiff).toBe(0);
    expect(r.gamesDiffer).toBe(0);
  }, 120_000);

  it('b-thr8 與 b-thr20 的決策確實不同', () => {
    const r = divergence(d4Spec('b-thr8', 'b-thr20', [3, 4], primary));
    expect(r.gamesDiffer).toBeGreaterThan(0);
    expect(r.pointsDiff).toBeGreaterThan(0);
  }, 120_000);

  it('影子不影響對局（逐位元）：帶影子與不帶影子的 inputs 與 finalHash 相同，而不同的影子真的做了不同的決定', () => {
    const seed = 4;
    for (const driver of ['b-thr12', 'c-free-thr12']) {
      const plain = playWith(seed, makeMember(driver, seed, 12), primary);
      const { ctl, stat } = shadow(
        makeMember(driver, seed, 12),
        makeMember('b-thr20', seed, 12),
        isSettlePoint,
      );
      const shadowed = playWith(seed, ctl, primary);
      expect(stat.diffTicks).toBeGreaterThan(0);
      expect(shadowed.match.inputs).toEqual(plain.match.inputs);
      expect(shadowed.match.finalHash).toBe(plain.match.finalHash);
    }
  }, 120_000);

  it('compareBC：|(c)−(b) 勝率| ≤ 場級分歧率，沒有一致性違規；配對 SE 是配對差的標準誤', () => {
    const seeds = [10, 11, 12, 13];
    const r = compareBC(d4Spec('b-thr12', 'c-free-thr12', seeds, cell7));
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
    const bs = seeds.map((s) => playWith(s, makeMember('b-thr12', s, 0), cell7));
    const cs = seeds.map((s) => playWith(s, makeMember('c-free-thr12', s, 0), cell7));
    const diffs = cs.map((c, i) => c.margin - (bs[i] as { margin: number }).margin);
    expect(r.margin.diff.mean).toBeCloseTo(pairedStats(diffs).mean, 12);
    expect(r.margin.diff.se).toBeCloseTo(pairedStats(diffs).se, 12);
  }, 120_000);

  it('選法：勝率高者；同勝率取分差高；再同取排在前面的', () => {
    expect(
      selectBest([
        { name: 'x', win: 40, margin: 9 },
        { name: 'y', win: 51, margin: 1 },
      ]),
    ).toBe('y');
    expect(
      selectBest([
        { name: 'x', win: 51, margin: 1 },
        { name: 'y', win: 51, margin: 2 },
      ]),
    ).toBe('y');
    expect(
      selectBest([
        { name: 'x', win: 51, margin: 2 },
        { name: 'y', win: 51, margin: 2 },
      ]),
    ).toBe('x');
  });

  it('工具檔 import 共用的影子與統計，不再自己定義 pairedStats 或逐 tick 的分歧計數', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    expect(text).toMatch(/from '\.\.\/\.\.\/\.\.\/tests\/ai\/probe-a\.shared'/);
    expect(text).not.toMatch(/export function pairedStats/);
    expect(text).not.toMatch(/diffTicks \+= 1/);
  });
});

describe('NONE 按鍵的基本確認', () => {
  it('全放開就是 none', () => {
    expect(dirOf(NONE)).toBe('none');
  });
});
