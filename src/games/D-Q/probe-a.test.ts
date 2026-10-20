import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC } from '../../../tests/ai/probe-a.shared';
import type { Buttons, Controller, Side } from '../../core/types';
import { cell } from '../_diamonds/logic';
import { makeState } from './logic';
import type { DQState } from './logic';
import {
  B_FAMILY,
  C_FAMILY,
  ENDGAME_TICKS,
  isPoint,
  member,
  playWith,
  score,
  selectBest,
  spec,
  withDelay,
} from './probe-a.test-helpers';

/**
 * D-Q 探針 A（完整版）的工具測試（`docs/cards/D-Q.md`「探針 A（完整版）」）。
 * 只測量測工具本身：族的定義、(b) 不讀對手、(c) 真的讀、選法、反應延遲、分歧率的串接。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const MINE = cell(15, 12);
const NEXT = cell(25, 20);
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const idle = (b: Buttons): boolean => JSON.stringify(b) === JSON.stringify(NONE);

/** 我（0 號邊）在 `me`，對手在 `opp`；礦在 (15, 12)、下一個礦在 (25, 20)；沒有牆。 */
function at(me: number, opp: number, extra: Parameters<typeof makeState>[0] = {}): DQState {
  return makeState({
    tick: 200,
    mine: MINE,
    next: NEXT,
    players: [{ cell: me }, { cell: opp }],
    ...extra,
  });
}

/** 新的控制器連續問 `n` 個 tick（tick 遞增，世界不變）。 */
function asks(name: string, state: DQState, side: Side = 0, n = 6): Buttons[] {
  const ctl = member(name);
  return Array.from({ length: n }, (_v, k) =>
    ctl.decide({ ...state, tick: state.tick + k }, side, state.tick + k),
  );
}

describe('族的定義', () => {
  it('(b) 族至少 5 個、(c) 族至少 5 個，名字不重複', () => {
    expect(B_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(C_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(new Set([...B_FAMILY, ...C_FAMILY]).size).toBe(B_FAMILY.length + C_FAMILY.length);
  });

  it('(b) 的名字都以 b- 開頭、(c) 的都以 c- 開頭；每個都做得出控制器', () => {
    for (const name of B_FAMILY) {
      expect(name.startsWith('b-')).toBe(true);
      expect(typeof member(name).decide).toBe('function');
    }
    for (const name of C_FAMILY) {
      expect(name.startsWith('c-')).toBe(true);
      expect(typeof member(name).decide).toBe('function');
    }
  });

  it('不是族裡的名字就丟錯（不默默當成別的成員）', () => {
    expect(() => member('x-nothing')).toThrow();
  });
});

describe('(b) 不讀對手的任何狀態', () => {
  const bases: readonly DQState[] = [
    at(MINE, cell(2, 2), { age: 3, carried: [0, 0] }),
    at(MINE, cell(2, 2), { age: 5, carried: [2, 0] }),
    at(MINE, cell(2, 2), { age: 9, carried: [5, 0] }),
    at(cell(14, 12), cell(2, 2), { age: 14, carried: [8, 0] }),
    at(cell(18, 12), cell(2, 2), { age: 20, carried: [3, 0] }),
    at(cell(22, 18), cell(2, 2), { age: 12, carried: [0, 0] }),
    at(cell(10, 10), cell(2, 2), { age: 7, carried: [0, 0] }),
  ];
  const vary = (s: DQState): DQState[] => [
    { ...s, players: [s.players[0], { ...s.players[1], cell: MINE, pending: 1, score: 40 }] },
    { ...s, players: [s.players[0], { ...s.players[1], cell: NEXT, pending: 2, score: 0 }] },
    { ...s, carried: [s.carried[0], 11] },
    { ...s, lost: [s.lost[0], 30] },
    {
      ...s,
      players: [s.players[0], { ...s.players[1], cell: cell(15, 13), pending: 0, score: 12 }],
    },
  ];

  it.each(B_FAMILY.map((name) => [name]))(
    '%s：換掉對手的位置、待走方向、分數、身上的礦石、被埋掉的礦石，每個 tick 的決定都一樣',
    (name) => {
      for (const base of bases) {
        const plain = asks(name, base);
        for (const v of vary(base)) {
          expect(asks(name, v)).toEqual(plain);
        }
      }
    },
  );

  it('(b) 的規則函式拿不到對手的視野（型別上就沒有）：原始碼裡 ruleB 沒有 OppView', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    const ruleB = text.slice(text.indexOf('function ruleB'), text.indexOf('/** (c) 的規則'));
    expect(ruleB.length).toBeGreaterThan(200);
    expect(ruleB).not.toMatch(/OppView|oppOf|\.players\[|opp\b/);
  });
});

describe('(c) 真的讀了對手（只換它讀的那一項，決定會變）', () => {
  const differs = (name: string, a: DQState, b: DQState): boolean =>
    JSON.stringify(asks(name, a)) !== JSON.stringify(asks(name, b));
  const far = cell(2, 2);

  it('c-ev-yield：對手也在礦邊（只挖得到 1）就走，只有我一個就留', () => {
    const base = { age: 8, carried: [5, 0] as [number, number] };
    const shared = at(MINE, MINE, base);
    const solo = at(MINE, far, base);
    expect(idle(asks('c-ev-yield', solo)[0] as Buttons)).toBe(true);
    expect(idle(asks('c-ev-yield', shared)[0] as Buttons)).toBe(false);
  });

  it('c-ev-yield-low：同上，整個縮一檔', () => {
    const base = { age: 8, carried: [4, 0] as [number, number] };
    expect(differs('c-ev-yield-low', at(MINE, MINE, base), at(MINE, far, base))).toBe(true);
  });

  it('c-thr-yield：對手也在礦邊存 3 塊就走；只有我一個要 8 塊', () => {
    const base = { age: 5, carried: [3, 0] as [number, number] };
    expect(differs('c-thr-yield', at(MINE, MINE, base), at(MINE, far, base))).toBe(true);
  });

  it('c-opp-left：對手已經離開礦坑範圍就比較敢留', () => {
    const base = { age: 10, carried: [6, 0] as [number, number] };
    const inside = at(MINE, cell(16, 12), base);
    const left = at(MINE, cell(2, 2), base);
    expect(differs('c-opp-left', inside, left)).toBe(true);
  });

  it.each(['c-race', 'c-race-ev1', 'c-ev-yield-race'])(
    '%s：礦老了、我比對手更靠近下一個礦就先去卡位；對手更近就回礦邊',
    (name) => {
      const me = cell(20, 16);
      const base = { age: 10, carried: [0, 0] as [number, number] };
      const ahead = at(me, cell(2, 2), base);
      const behind = at(me, cell(24, 19), base);
      expect(differs(name, ahead, behind)).toBe(true);
    },
  );

  it('c-lead：領先 6 分以上就保守（早走）', () => {
    const base = { age: 8, carried: [5, 0] as [number, number] };
    const ahead = at(MINE, far, { ...base, players: [{ cell: MINE, score: 10 }, { cell: far }] });
    const even = at(MINE, far, base);
    expect(differs('c-lead', ahead, even)).toBe(true);
  });

  it('c-lead-ev1：同上，基準 y ＝ 1', () => {
    const base = { age: 8, carried: [3, 0] as [number, number] };
    const ahead = at(MINE, far, { ...base, players: [{ cell: MINE, score: 10 }, { cell: far }] });
    const even = at(MINE, far, base);
    expect(differs('c-lead-ev1', ahead, even)).toBe(true);
  });

  it('每個 (c) 成員至少有一個測試讀到它的輸入（上面的案例涵蓋整個族）', () => {
    const covered = [
      'c-ev-yield',
      'c-ev-yield-low',
      'c-thr-yield',
      'c-opp-left',
      'c-race',
      'c-race-ev1',
      'c-ev-yield-race',
      'c-lead',
      'c-lead-ev1',
    ];
    expect([...covered].sort()).toEqual([...C_FAMILY].sort());
  });
});

describe('成員的動作（走路與存礦）', () => {
  it('b-N4W12：身上 3 塊留在礦邊、4 塊往外走；礦的年紀 ≥ 12 也往外走', () => {
    expect(
      idle(asks('b-N4W12', at(MINE, cell(2, 2), { age: 5, carried: [3, 0] }))[0] as Buttons),
    ).toBe(true);
    expect(
      idle(asks('b-N4W12', at(MINE, cell(2, 2), { age: 5, carried: [4, 0] }))[0] as Buttons),
    ).toBe(false);
    expect(
      idle(asks('b-N4W12', at(MINE, cell(2, 2), { age: 12, carried: [1, 0] }))[0] as Buttons),
    ).toBe(false);
  });

  it('往外走是往礦坑範圍外（距離 ≥ 4）的方向：站在礦上時走出去的第一步離礦更遠', () => {
    const state = at(MINE, cell(2, 2), { age: 5, carried: [4, 0] });
    const first = asks('b-N4W12', state)[0] as Buttons;
    expect(first.up || first.down || first.left || first.right).toBe(true);
  });

  it('身上沒有礦石而且礦還年輕：離礦邊遠就往礦走，到了就不動', () => {
    const far = asks('b-N6W12', at(cell(5, 5), cell(2, 2), { age: 2 }))[0] as Buttons;
    expect(idle(far)).toBe(false);
    expect(idle(asks('b-N6W12', at(MINE, cell(2, 2), { age: 2 }))[0] as Buttons)).toBe(true);
  });

  it('礦老了（≥ 15）身上沒礦：去下一個礦等著（b-ev2）；到了就不動', () => {
    const toward = asks('b-ev2', at(cell(22, 18), cell(2, 2), { age: 16 }))[0] as Buttons;
    expect(toward.right || toward.down).toBe(true);
    expect(idle(asks('b-ev2', at(NEXT, cell(2, 2), { age: 16 }))[0] as Buttons)).toBe(true);
  });

  it('最後 ENDGAME_TICKS 個 tick：身上有礦石就一律往外走（b-stay 也一樣）', () => {
    const state = at(MINE, cell(2, 2), { tick: 3600 - ENDGAME_TICKS + 1, age: 1, carried: [1, 0] });
    for (const name of ['b-stay', 'b-N10W25']) {
      expect(idle(asks(name, state)[0] as Buttons)).toBe(false);
    }
  });

  it('往外走一旦開始就走到存進去為止（身上的礦石歸零才重算）', () => {
    const ctl = member('b-N4W12');
    const start = at(MINE, cell(2, 2), { age: 5, carried: [4, 0] });
    expect(idle(ctl.decide(start, 0, 200))).toBe(false);
    // 規則已經不成立（身上只剩 1 塊、礦很年輕），但還沒存進去，繼續往外走。
    const mid = at(cell(17, 12), cell(2, 2), { tick: 205, age: 1, carried: [1, 0] });
    expect(idle(ctl.decide(mid, 0, 205))).toBe(false);
    // 存進去之後（身上 0）才回頭。
    const done = at(cell(19, 12), cell(2, 2), { tick: 220, age: 1, carried: [0, 0] });
    expect(idle(ctl.decide(done, 0, 220))).toBe(false);
    const toMine = ctl.decide(done, 0, 221);
    expect(toMine.left).toBe(true);
  });

  it('1 號邊也一樣（side 參數）：礦邊不動、身上 4 塊往外走', () => {
    const state = at(cell(2, 2), MINE, { age: 5, carried: [0, 4] });
    expect(idle(asks('b-N4W12', state, 1)[0] as Buttons)).toBe(false);
    const calm = at(cell(2, 2), MINE, { age: 5, carried: [0, 3] });
    expect(idle(asks('b-N4W12', calm, 1)[0] as Buttons)).toBe(true);
  });
});

describe('反應延遲', () => {
  it('世界是 delay 個 tick 前的（對手的位置），自己的位置是現在的', () => {
    const seen: DQState[] = [];
    const recorder: Controller<DQState> = {
      decide(state) {
        seen.push(state);
        return NONE;
      },
    };
    const delayed = withDelay(recorder, 12);
    for (let t = 0; t < 30; t += 1) {
      delayed.decide(makeState({ tick: t, players: [{ cell: 100 + t }, { cell: 500 + t }] }), 0, t);
    }
    const last = seen[seen.length - 1] as DQState;
    expect(last.players[0].cell).toBe(129);
    expect(last.players[1].cell).toBe(500 + 29 - 12);
    // 前 12 個 tick 沒有更舊的世界可看：用最早看到的那一個。
    expect((seen[3] as DQState).players[1].cell).toBe(500);
  });

  it('delay ＝ 0 就是原本的控制器（同一個物件）', () => {
    const inner = member('b-ev2');
    expect(withDelay(inner, 0)).toBe(inner);
  });

  it('1 號邊的延遲：自己是 players[1]', () => {
    const seen: DQState[] = [];
    const recorder: Controller<DQState> = {
      decide(state) {
        seen.push(state);
        return NONE;
      },
    };
    const delayed = withDelay(recorder, 5);
    for (let t = 0; t < 12; t += 1) {
      delayed.decide(makeState({ tick: t, players: [{ cell: 100 + t }, { cell: 500 + t }] }), 1, t);
    }
    const last = seen[seen.length - 1] as DQState;
    expect(last.players[1].cell).toBe(511);
    expect(last.players[0].cell).toBe(100 + 11 - 5);
  });
});

describe('選法（量之前固定）', () => {
  it('勝率最高的；同勝率取平均分差高的；再同取表中靠前的', () => {
    expect(
      selectBest([
        { name: 'a', win: 0.5, margin: 9 },
        { name: 'b', win: 0.6, margin: -3 },
        { name: 'c', win: 0.6, margin: 2 },
        { name: 'd', win: 0.6, margin: 2 },
      ]).name,
    ).toBe('c');
  });
  it('浮點誤差不算不同', () => {
    expect(
      selectBest([
        { name: 'a', win: 0.1 + 0.2, margin: 1 },
        { name: 'b', win: 0.3, margin: 1 },
      ]).name,
    ).toBe('a');
  });
});

describe('決策點與串接', () => {
  it('isPoint：每個走格週期的第一個 tick', () => {
    const s = makeState({ tick: 10 });
    expect(isPoint(s, 0, 10)).toBe(true);
    expect(isPoint({ ...s, tick: 11 }, 0, 11)).toBe(false);
    expect(isPoint({ ...s, tick: 0 }, 0, 0)).toBe(true);
  });

  it('(c) 的原始碼沒有 import evaluate、predictOpponent，也沒有拿 AI 的控制器當成員', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bevaluate\b|predictOpponent|humanModel|human-model|wrapPolicy/);
    // levelController 只用來做「對手」（playWith 裡一次）。
    expect(code.match(/levelController\(/g)?.length).toBe(1);
    const member_ = code.slice(
      code.indexOf('export function member'),
      code.indexOf('export function withDelay'),
    );
    expect(member_).not.toMatch(/levelController|policyByName/);
  });

  it('compareBC 串得起來：影子不影響對局（(b) 驅動的勝率與分差等於單獨跑 (b)）；勝率差不超過場級分歧率', () => {
    const seeds = [3, 4];
    const at12 = { policy: 'precise', level: 10, delay: 12 } as const;
    const r = compareBC(spec('b-ev1', 'c-ev-yield', seeds, at12));
    expect(r.n).toBe(2);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
    const alone = seeds.map((seed) => playWith(seed, member('b-ev1'), at12));
    expect(r.win.b).toBe(alone.reduce((a, o) => a + o.win, 0) / seeds.length);
    expect(r.margin.b.mean).toBe(alone.reduce((a, o) => a + o.margin, 0) / seeds.length);
    expect(r.divergence.pointBasis).toBe('isPoint');
  }, 120_000);

  it('score 與 playWith 一致；b-stay（站著不走）比 b-N6W12 差（等級 5、沒有延遲，4 場）', () => {
    const seeds = [3, 4, 5, 6];
    const easy = { policy: 'precise', level: 5, delay: 0 } as const;
    const good = score('b-N6W12', seeds, easy);
    const bad = score('b-stay', seeds, easy);
    expect(good.win).toBeGreaterThan(bad.win);
    expect(good.margin).toBeGreaterThan(bad.margin);
    const direct = seeds.map((s) => playWith(s, member('b-N6W12'), easy));
    expect(good.win).toBe(direct.reduce((a, o) => a + o.win, 0) / seeds.length);
  }, 120_000);
});
