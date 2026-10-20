import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC } from '../../../tests/ai/probe-a.shared';
import type { Buttons, Controller, Side } from '../../core/types';
import { cell, cellX, cellY, stepTarget } from '../_diamonds/logic';
import type { Dir } from '../_diamonds/logic';
import { makeState } from './logic';
import type { D8State } from './logic';
import {
  B_FAMILY,
  C_FAMILY,
  isPoint,
  member,
  playWith,
  score,
  selectBest,
  spec,
  tilesOf,
  withDelay,
} from './probe-a.test-helpers';

/**
 * D-8 探針 A（完整版）的工具測試（`docs/cards/D-8.md`「探針 A（完整版）」）。
 * 只測量測工具本身：族的定義、(b) 不讀對手、(c) 真的讀、走路、反應延遲、選法、分歧率的串接。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const dirOf = (b: Buttons): number => (b.up ? 0 : b.right ? 1 : b.down ? 2 : b.left ? 3 : -1);

/** 沒有牆的局面，我（0 號邊）在 me、對手（1 號邊）在 opp；paint0 是我的格子、paint1 是對手的格子。 */
function at(me: number, opp: number, extra: Parameters<typeof makeState>[0] = {}): D8State {
  return makeState({ tick: 300, players: [{ cell: me }, { cell: opp }], ...extra });
}

/** 新的控制器連續問 `n` 個 tick（世界不變）。 */
function asks(name: string, state: D8State, side: Side = 0, n = 5): number[] {
  const ctl = member(name);
  return Array.from({ length: n }, (_v, k) =>
    dirOf(ctl.decide({ ...state, tick: state.tick + k }, side, state.tick + k)),
  );
}

/** 一整排我的格子：y 列、x 從 x0 到 x1。 */
const row = (y: number, x0: number, x1: number): number[] =>
  Array.from({ length: x1 - x0 + 1 }, (_v, i) => cell(x0 + i, y));

describe('族的定義', () => {
  it('(b) 族至少 5 個、(c) 族至少 5 個，名字不重複', () => {
    expect(B_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(C_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(new Set([...B_FAMILY, ...C_FAMILY]).size).toBe(B_FAMILY.length + C_FAMILY.length);
  });

  it('(b) 都以 b- 開頭、(c) 都以 c- 開頭；每個都做得出控制器；不在族裡的名字丟錯', () => {
    for (const name of B_FAMILY) {
      expect(name.startsWith('b-')).toBe(true);
      expect(typeof member(name).decide).toBe('function');
    }
    for (const name of C_FAMILY) {
      expect(name.startsWith('c-')).toBe(true);
      expect(typeof member(name).decide).toBe('function');
    }
    expect(() => member('x-nothing')).toThrow();
    expect(() => member('b-nothing')).toThrow();
    expect(() => member('c-nothing')).toThrow();
  });
});

describe('框（box）的幾何', () => {
  it('間隔 7：邊界線 x ＝ 0、7、14、21、28、31，y ＝ 23、16、9、2、0；共 20 個框，相鄰的共用邊界', () => {
    const tiles = tilesOf(7);
    expect(tiles).toHaveLength(20);
    expect(tiles[0]).toEqual({ x0: 0, x1: 7, y0: 16, y1: 23 });
    // 蛇行：第一列由左往右、第二列由右往左。
    expect(tiles[4]).toEqual({ x0: 28, x1: 31, y0: 16, y1: 23 });
    expect(tiles[5]).toEqual({ x0: 28, x1: 31, y0: 9, y1: 16 });
    expect(tiles[1]?.x0).toBe(tiles[0]?.x1);
  });

  it('間隔 7 的標準框內部是 6×6 ＝ 36 格（≤ 40，圍起來整塊歸你）', () => {
    const t = tilesOf(7)[0] as { x0: number; x1: number; y0: number; y1: number };
    expect((t.x1 - t.x0 - 1) * (t.y1 - t.y0 - 1)).toBe(36);
  });
});

describe('走路', () => {
  it('兩個方向一樣近時，優先上一次走的方向（直走）', () => {
    // 整張圖只有 (7,8) 沒塗（我在 (5,10)）：往右或往上一樣近。
    const everything = Array.from({ length: 768 }, (_v, c) => c).filter(
      (c) => c !== cell(7, 8) && c !== cell(31, 0),
    );
    const state = at(cell(5, 10), cell(31, 0), { paint0: everything });
    const right = { ...state, heading: [1, -1] as [number, number] };
    const up = { ...state, heading: [0, -1] as [number, number] };
    expect(dirOf(member('b-nearest').decide(right, 0, 300))).toBe(1);
    expect(dirOf(member('b-nearest').decide(up, 0, 300))).toBe(0);
  });

  it('目標只在背後（要掉頭）：照樣按反方向（遊戲會停一拍，不是控制器繞路）', () => {
    // 我被圍在 (5,10)，只有 (4,10) 是沒塗的，上一次往右走。
    const mine = [cell(5, 9), cell(5, 11), cell(6, 10), cell(5, 10)];
    const state = at(cell(5, 10), cell(30, 1), {
      walls: [cell(4, 9), cell(4, 11), cell(3, 10)],
      paint0: mine,
    });
    const s = { ...state, heading: [1, -1] as [number, number] };
    expect(dirOf(member('b-nearest').decide(s, 0, 300))).toBe(3);
  });

  it('1 號邊的清單是 0 號邊轉 180 度：起點 (31,0) 的第一步 b-snake1 往左、b-snake2v 往下', () => {
    const start = makeState({ tick: 0, paint0: [cell(0, 23)], paint1: [cell(31, 0)] });
    expect(dirOf(member('b-snake1').decide(start, 1, 0))).toBe(3);
    expect(dirOf(member('b-snake2v').decide(start, 1, 0))).toBe(2);
    expect(dirOf(member('b-snake1').decide(start, 0, 0))).toBe(1);
    expect(dirOf(member('b-snake2v').decide(start, 0, 0))).toBe(0);
  });

  it('站在目標上就不動；全部塗完退回最近的沒塗格（沒有可去的就不動）', () => {
    const everything = Array.from({ length: 768 }, (_v, c) => c);
    const full = makeState({ tick: 100, paint0: everything });
    expect(dirOf(member('b-nearest').decide(full, 0, 100))).toBe(-1);
    expect(dirOf(member('b-box7').decide(full, 0, 100))).toBe(-1);
  });

  it('每一步都走得動（不撞牆）：任一成員的按鍵會讓我真的離開現在的格子（除了停一拍的掉頭）', () => {
    const state = at(cell(10, 10), cell(30, 1), {
      walls: [cell(11, 10), cell(10, 9)],
    });
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      const d = dirOf(member(name).decide(state, 0, 300));
      if (d >= 0) {
        expect(stepTarget(state.walls, cell(10, 10), d as Dir)).not.toBe(cell(10, 10));
      }
    }
  });
});

describe('(b) 的動態挑框（不讀對手）跟固定順序的差別', () => {
  it('b-box7-near 挑離我最近的框；b-box7 照蛇行順序（第一個還沒做完的）', () => {
    const ring: number[] = [];
    for (let x = 0; x <= 7; x += 1) {
      ring.push(cell(x, 16), cell(x, 23));
    }
    for (let y = 17; y <= 22; y += 1) {
      ring.push(cell(0, y), cell(7, y));
    }
    // 左下角的框做完了；我在它上面一格的 (3,15)：離上面那個框的左邊界最近，離右邊的框遠。
    const state = at(cell(3, 15), cell(30, 1), { paint0: ring });
    expect(asks('b-box7-near', state)[0]).toBe(3);
    expect(asks('b-box7', state)[0]).toBe(1);
  });

  it('b-box7-fill 不分格子是誰的：對手的格子和沒人塗過的格子價值一樣', () => {
    const ring: number[] = [];
    for (let x = 0; x <= 7; x += 1) {
      ring.push(cell(x, 16), cell(x, 23));
    }
    for (let y = 17; y <= 22; y += 1) {
      ring.push(cell(0, y), cell(7, y));
    }
    const upperInside: number[] = [];
    for (let y = 10; y <= 15; y += 1) {
      for (let x = 1; x <= 6; x += 1) {
        upperInside.push(cell(x, y));
      }
    }
    const empty = at(cell(7, 16), cell(30, 1), { paint0: ring });
    const theirs = at(cell(7, 16), cell(30, 1), { paint0: ring, paint1: upperInside });
    expect(asks('b-box7-fill', theirs)).toEqual(asks('b-box7-fill', empty));
  });
});

describe('(b) 不讀對手的任何狀態', () => {
  const mineA = [...row(12, 3, 9), ...row(11, 3, 9), cell(9, 10)];
  const bases: readonly D8State[] = [
    at(cell(0, 23), cell(31, 0)),
    at(cell(9, 10), cell(31, 0), { paint0: mineA }),
    at(cell(9, 10), cell(31, 0), { paint0: mineA, paint1: row(8, 5, 20), tick: 120 }),
    at(cell(2, 20), cell(31, 0), { paint0: row(23, 0, 6) }),
  ];
  const vary = (s: D8State): D8State[] => [
    // 對手的位置與待走方向換掉。
    { ...s, players: [s.players[0], { ...s.players[1], cell: cell(10, 10), pending: 2 }] },
    {
      ...s,
      players: [s.players[0], { ...s.players[1], cell: cell(4, 20), pending: 0 }],
      heading: [s.heading[0], 3],
    },
    // 對手的格子與沒人塗過的格子對調（「不是我的」裡誰是誰）。
    {
      ...s,
      paint: s.paint.map((p) => (p === 2 ? 0 : p === 0 ? p : p)),
    },
    // 保護期的時間戳換掉（對手剛塗上去或很久以前）。
    { ...s, stamp: s.stamp.map((t, c) => (s.paint[c] === 2 ? s.tick - 1 : t)) },
    { ...s, stamp: s.stamp.map((t, c) => (s.paint[c] === 2 ? -1_000_000 : t)) },
  ];

  it.each(B_FAMILY.map((name) => [name]))(
    '%s：換掉對手的位置、待走方向、方向、它塗的格子是誰的、保護期，每個 tick 的決定都一樣',
    (name) => {
      for (const base of bases) {
        const plain = asks(name, base);
        for (const v of vary(base)) {
          expect(asks(name, v)).toEqual(plain);
        }
      }
    },
  );

  it('(b) 的程式碼區段沒有對手的欄位（原始碼裡 chooserB 之前的共用函式與 chooserB 本身不碰對手）', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    const shared = text.slice(text.indexOf('// 目標清單'), text.indexOf('/** 框離對手多近'));
    expect(shared.length).toBeGreaterThan(2000);
    expect(shared).not.toMatch(/other\(|\bopp\b|stamp|protectedByOpp|players\[other/);
  });
});

describe('(c) 真的讀了對手（只換它讀的那一項，決定會變）', () => {
  const differs = (name: string, a: D8State, b: D8State): boolean =>
    JSON.stringify(asks(name, a)) !== JSON.stringify(asks(name, b));

  it('c-nearest-avoid：最近的沒塗格離對手 ≤ 4 就不去', () => {
    // 我在 (10,10)，四周塗滿我的格子，除了 (11,10)（右邊，最近）和 (6,10)（左邊，遠 4）。
    const around: number[] = [];
    for (let y = 6; y <= 14; y += 1) {
      for (let x = 6; x <= 14; x += 1) {
        around.push(cell(x, y));
      }
    }
    const paint0 = around.filter((c) => c !== cell(11, 10) && c !== cell(7, 10));
    const near = at(cell(10, 10), cell(13, 10), { paint0 });
    const far = at(cell(10, 10), cell(30, 1), { paint0 });
    expect(differs('c-nearest-avoid', near, far)).toBe(true);
  });

  it('c-nearest-swing：對手塗的、過了保護期的格子價值 2，在保護期內價值 0', () => {
    // 我在 (10,10)；(10,12) 沒人塗過（往下，距離 2，價值 1/3）；(10,7) 是對手的（往上，距離 3，價值 2/4）。其餘周圍都是我的。
    const around: number[] = [];
    for (let y = 4; y <= 16; y += 1) {
      for (let x = 6; x <= 14; x += 1) {
        around.push(cell(x, y));
      }
    }
    const paint0 = around.filter((c) => c !== cell(10, 12) && c !== cell(10, 7));
    const old = at(cell(10, 10), cell(30, 1), { paint0, paint1: [cell(10, 7)] });
    const fresh = at(cell(10, 10), cell(30, 1), {
      paint0,
      paint1: [cell(10, 7)],
      stamps: [[cell(10, 7), 290]],
    });
    expect(asks('c-nearest-swing', old)[0]).toBe(0);
    expect(asks('c-nearest-swing', fresh)[0]).toBe(2);
  });

  it('c-nearest-chase：過了保護期的對手格子少算 6 步', () => {
    const around: number[] = [];
    for (let y = 2; y <= 18; y += 1) {
      for (let x = 6; x <= 14; x += 1) {
        around.push(cell(x, y));
      }
    }
    // (10,12) 沒人塗過（距離 2）；(10,5) 是對手的（距離 5，打折後 −1）。
    const paint0 = around.filter((c) => c !== cell(10, 12) && c !== cell(10, 5));
    const old = at(cell(10, 10), cell(30, 1), { paint0, paint1: [cell(10, 5)] });
    const fresh = at(cell(10, 10), cell(30, 1), {
      paint0,
      paint1: [cell(10, 5)],
      stamps: [[cell(10, 5), 295]],
    });
    expect(differs('c-nearest-chase', old, fresh)).toBe(true);
  });

  it('c-snake2-flee：清單上的下一格離對手 ≤ 3 就先跳過', () => {
    // 第一列 (y 23) 全做完，我在最右邊 (31,23)，上一次往左走；清單的下一格是接到第二列的 (31,22)。
    const base = { paint0: row(23, 0, 31) };
    const near = { ...at(cell(31, 23), cell(31, 21), base), heading: [3, -1] as [number, number] };
    const far = { ...at(cell(31, 23), cell(2, 2), base), heading: [3, -1] as [number, number] };
    expect(asks('c-snake2-flee', far)[0]).toBe(0);
    expect(asks('c-snake2-flee', near)[0]).toBe(3);
  });

  it('c-box7-away：還沒做完的框裡，對手靠近的那個框分數低', () => {
    // 左下角的框（x 0..7、y 16..23）只差 (3,16)；我在 (4,17)，上一次往右走。對手在 (3,14)（離那個框 2 格）或很遠。
    const ring: number[] = [];
    for (let x = 0; x <= 7; x += 1) {
      ring.push(cell(x, 16), cell(x, 23));
    }
    for (let y = 17; y <= 22; y += 1) {
      ring.push(cell(0, y), cell(7, y));
    }
    const paint0 = ring.filter((c) => c !== cell(3, 16));
    const alone = {
      ...at(cell(4, 17), cell(30, 1), { paint0 }),
      heading: [1, -1] as [number, number],
    };
    const crowded = {
      ...at(cell(4, 17), cell(3, 14), { paint0 }),
      heading: [1, -1] as [number, number],
    };
    expect(asks('c-box7-away', alone)[0]).toBe(0);
    expect(asks('c-box7-away', crowded)[0]).toBe(1);
  });

  it('c-box7-cut：內部有對手的格子的框價值高（我 +1、它 −1），先去那一個', () => {
    const ring = (x0: number, x1: number, y0: number, y1: number): number[] => {
      const out: number[] = [];
      for (let x = x0; x <= x1; x += 1) {
        out.push(cell(x, y0), cell(x, y1));
      }
      for (let y = y0; y <= y1; y += 1) {
        out.push(cell(x0, y), cell(x1, y));
      }
      return out;
    };
    // 左下角的框（x 0..7、y 16..23）做完了；我站在它的右上角 (7,16)，旁邊有兩個沒做的框：
    // 右邊的 (x 7..14、y 16..23) 與上面的 (x 0..7、y 9..16)。
    const upperInside: number[] = [];
    for (let y = 10; y <= 15; y += 1) {
      for (let x = 1; x <= 6; x += 1) {
        upperInside.push(cell(x, y));
      }
    }
    const paint0 = ring(0, 7, 16, 23);
    const empty = at(cell(7, 16), cell(30, 1), { paint0 });
    const rich = at(cell(7, 16), cell(30, 1), { paint0, paint1: upperInside });
    expect(differs('c-box7-cut', empty, rich)).toBe(true);
    // 對手站在上面那個框附近（≤ 3）時不去：決定回到跟內部沒有對手格子時一樣。
    const guarded = at(cell(7, 16), cell(4, 12), { paint0, paint1: upperInside });
    expect(asks('c-box7-cut', guarded)).toEqual(asks('c-box7-cut', empty));
  });

  it('c-box6-away：間隔 6 的框，同一個道理', () => {
    // 左下角的框（x 0..6、y 17..23）只差 (3,17)；我在 (4,18)，上一次往右走。
    const ring: number[] = [];
    for (let x = 0; x <= 6; x += 1) {
      ring.push(cell(x, 17), cell(x, 23));
    }
    for (let y = 18; y <= 22; y += 1) {
      ring.push(cell(0, y), cell(6, y));
    }
    const paint0 = ring.filter((c) => c !== cell(3, 17));
    const alone = {
      ...at(cell(4, 18), cell(30, 1), { paint0 }),
      heading: [1, -1] as [number, number],
    };
    const crowded = {
      ...at(cell(4, 18), cell(3, 15), { paint0 }),
      heading: [1, -1] as [number, number],
    };
    expect(asks('c-box6-away', alone)[0]).toBe(0);
    expect(asks('c-box6-away', crowded)[0]).toBe(1);
  });

  it('c-box6-cut：間隔 6 的框，內部有對手的格子的那個框先去', () => {
    const ring: number[] = [];
    for (let x = 0; x <= 6; x += 1) {
      ring.push(cell(x, 17), cell(x, 23));
    }
    for (let y = 18; y <= 22; y += 1) {
      ring.push(cell(0, y), cell(6, y));
    }
    const upperInside: number[] = [];
    for (let y = 12; y <= 16; y += 1) {
      for (let x = 1; x <= 5; x += 1) {
        upperInside.push(cell(x, y));
      }
    }
    const empty = at(cell(6, 17), cell(30, 1), { paint0: ring });
    const rich = at(cell(6, 17), cell(30, 1), { paint0: ring, paint1: upperInside });
    expect(asks('c-box6-cut', empty)[0]).toBe(1);
    expect(asks('c-box6-cut', rich)[0]).toBe(0);
  });

  it('每個 (c) 成員至少有一個測試讀到它的輸入', () => {
    const covered = [
      'c-nearest-avoid',
      'c-nearest-swing',
      'c-nearest-chase',
      'c-snake2-flee',
      'c-box7-away',
      'c-box6-away',
      'c-box7-cut',
      'c-box6-cut',
    ];
    expect([...covered].sort()).toEqual([...C_FAMILY].sort());
  });
});

describe('反應延遲', () => {
  const recorder = (seen: D8State[]): Controller<D8State> => ({
    decide(state) {
      seen.push(state);
      return NONE;
    },
  });

  it('世界是 delay 個 tick 前的（對手的位置），自己的位置與方向是現在的，現在是我的格子一律算我的', () => {
    const seen: D8State[] = [];
    const delayed = withDelay(recorder(seen), 12);
    for (let t = 0; t < 30; t += 1) {
      const base = makeState({
        tick: t,
        players: [{ cell: 100 + t }, { cell: 500 + t }],
        paint0: t >= 20 ? [cell(3, 3)] : [],
      });
      delayed.decide({ ...base, heading: [t % 4, 3] }, 0, t);
    }
    const last = seen[seen.length - 1] as D8State;
    expect(last.players[0].cell).toBe(129);
    expect(last.players[1].cell).toBe(500 + 29 - 12);
    expect(last.heading[0]).toBe(29 % 4);
    expect(last.paint[cell(3, 3)]).toBe(1);
    // 12 個 tick 前還沒有塗：舊的世界看不到，但現在是我的，所以算我的。
    expect(seen[22]?.paint[cell(3, 3)]).toBe(1);
  });

  it('delay ＝ 0 就是原本的控制器；1 號邊的延遲：自己是 players[1]、現在的格子算 2', () => {
    const inner = member('b-nearest');
    expect(withDelay(inner, 0)).toBe(inner);
    const seen: D8State[] = [];
    const delayed = withDelay(recorder(seen), 5);
    for (let t = 0; t < 12; t += 1) {
      delayed.decide(
        makeState({
          tick: t,
          players: [{ cell: 100 + t }, { cell: 500 + t }],
          paint1: [cell(4, 4)],
        }),
        1,
        t,
      );
    }
    const last = seen[seen.length - 1] as D8State;
    expect(last.players[1].cell).toBe(511);
    expect(last.players[0].cell).toBe(100 + 11 - 5);
    expect(last.paint[cell(4, 4)]).toBe(2);
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
});

describe('決策點與串接', () => {
  it('isPoint：每個走格週期的第一個 tick', () => {
    const s = makeState({ tick: 10 });
    expect(isPoint(s, 0, 10)).toBe(true);
    expect(isPoint({ ...s, tick: 13 }, 0, 13)).toBe(false);
  });

  it('(c) 的原始碼沒有 import evaluate、predictOpponent，也沒有拿 AI 的控制器當成員', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bevaluate\b|predictOpponent|opponentAction|policies\/shared|humanModel|human-model|wrapPolicy/);
    expect(code.match(/levelController\(/g)?.length).toBe(1);
    const members = code.slice(
      code.indexOf('export function member'),
      code.indexOf('export function withDelay'),
    );
    expect(members).not.toMatch(/levelController|policyByName/);
  });

  it('compareBC 串得起來：影子不影響對局（(b) 驅動的勝率與分差等於單獨跑 (b)）；勝率差不超過場級分歧率', () => {
    const seeds = [3, 4];
    const at12 = { policy: 'greedy', level: 5, delay: 12 } as const;
    const r = compareBC(spec('b-box7', 'c-box7-away', seeds, at12));
    expect(r.n).toBe(2);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
    const alone = seeds.map((seed) => playWith(seed, member('b-box7'), at12));
    expect(r.win.b).toBe(alone.reduce((a, o) => a + o.win, 0) / seeds.length);
    expect(r.margin.b.mean).toBe(alone.reduce((a, o) => a + o.margin, 0) / seeds.length);
    expect(r.divergence.pointBasis).toBe('isPoint');
  }, 300_000);

  it('score 與 playWith 一致', () => {
    const seeds = [3, 4];
    const cellAt = { policy: 'greedy', level: 3, delay: 0 } as const;
    const s = score('b-nearest', seeds, cellAt);
    const direct = seeds.map((x) => playWith(x, member('b-nearest'), cellAt));
    expect(s.win).toBe(direct.reduce((a, o) => a + o.win, 0) / seeds.length);
    expect(s.margin).toBe(direct.reduce((a, o) => a + o.margin, 0) / seeds.length);
    expect(cellX(cell(3, 4))).toBe(3);
    expect(cellY(cell(3, 4))).toBe(4);
  }, 300_000);
});
