import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC, divergence } from '../../../tests/ai/probe-a.shared';
import type { Buttons, Controller, Side } from '../../core/types';
import { START_CELLS, cell } from '../_diamonds/logic';
import { makeState } from './logic';
import type { D2State } from './logic';
import {
  B_FAMILY,
  C_FAMILY,
  TWINS,
  isPoint,
  member,
  withDelay,
} from './probe-a.members.test-helpers';
import {
  AI_SEED_OFFSET,
  MAIN_CELL,
  playWith,
  score,
  selectBest,
  spec,
} from './probe-a.test-helpers';

/**
 * D-2 探針 A（完整版）的工具測試（`docs/cards/D-2.md`「探針 A（完整版）」）。
 * 只測量測工具本身：族的定義、(b) 不讀對手、(c) 真的讀、雙胞胎、走路、背包規則、反應延遲、選法、分歧率的串接。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const dirOf = (b: Buttons): number => (b.up ? 0 : b.right ? 1 : b.down ? 2 : b.left ? 3 : -1);
const HOME0 = START_CELLS[0]; // (0, 23)
const HOME1 = START_CELLS[1]; // (31, 0)

/** 沒有牆的局面：我（0 號邊）在 me、對手（1 號邊）在 opp。 */
function at(
  me: number,
  opp: number,
  coins: number[],
  extra: Parameters<typeof makeState>[0] = {},
): D2State {
  return makeState({ tick: 100, players: [{ cell: me }, { cell: opp }], coins, ...extra });
}

const ask = (name: string, state: D2State, side: Side = 0): number =>
  dirOf(member(name).decide(state, side, state.tick));

/** 對手很遠、背包空：沒有任何競爭。 */
const calm = (bags: [number, number] = [0, 0]): D2State =>
  at(cell(5, 12), cell(31, 0), [cell(8, 12), cell(5, 6), cell(2, 15)], { bags });

describe('族的定義', () => {
  it('(b) 至少 5 個、(c) 至少 5 個，名字不重複，前綴對', () => {
    expect(B_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(C_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(new Set([...B_FAMILY, ...C_FAMILY]).size).toBe(B_FAMILY.length + C_FAMILY.length);
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
  });

  it('每個 (b) 成員（站著不動的 b-stay 除外）都有一個 (c) 雙胞胎；雙胞胎名字都在族裡', () => {
    for (const name of B_FAMILY) {
      if (name === 'b-stay') {
        continue;
      }
      expect(TWINS.some(([b]) => b === name)).toBe(true);
    }
    for (const [b, c] of TWINS) {
      expect((B_FAMILY as readonly string[]).includes(b)).toBe(true);
      expect((C_FAMILY as readonly string[]).includes(c)).toBe(true);
    }
  });
});

describe('(b) 不讀對手，(c) 讀', () => {
  const variants = (base: D2State): D2State[] => [
    base,
    { ...base, players: [base.players[0], { ...base.players[1], cell: cell(11, 10) }] } as D2State,
    {
      ...base,
      players: [base.players[0], { ...base.players[1], cell: cell(10, 6), pending: 0 }],
    } as D2State,
    { ...base, players: [base.players[0], { ...base.players[1], score: 9 }] } as D2State,
    { ...base, bags: [base.bags[0], 3] } as D2State,
  ];

  it('(b) 全部成員：對手的位置、待走方向、分數、背包換掉，按鍵不變', () => {
    const bases = [
      at(cell(10, 10), cell(20, 10), [cell(14, 10), cell(10, 4), cell(2, 10)], { bags: [1, 0] }),
      at(cell(10, 10), cell(20, 10), [cell(14, 10), cell(10, 4)], { bags: [0, 0] }),
      at(cell(10, 10), cell(20, 10), [cell(14, 10)], { bags: [2, 0] }),
    ];
    for (const name of B_FAMILY) {
      for (const base of bases) {
        const answers = variants(base).map((s) => ask(name, s));
        expect(new Set(answers).size, name).toBe(1);
      }
    }
  });

  it('(c) 全部成員：至少有一個局面，換掉對手的狀態之後按鍵會變', () => {
    // 我在 (10,10)，背包空；金幣 A 在右邊 4 格、B 在下面 6 格。對手在 A 旁邊（背包空，搶得到）時 (c) 改去 B。
    const base = at(cell(10, 10), cell(31, 0), [cell(14, 10), cell(10, 16)], { bags: [0, 0] });
    const near = {
      ...base,
      players: [base.players[0], { ...base.players[1], cell: cell(15, 10) }],
    } as D2State;
    // 讀分數的 c-N3-lead：領先時保守（一枚就回家）、落後時貪（裝滿）。
    const mid = at(cell(10, 10), cell(31, 0), [cell(14, 10)], { bags: [1, 0] });
    const behind = {
      ...mid,
      players: [
        { ...mid.players[0], score: 0 },
        { ...mid.players[1], score: 12 },
      ],
    } as D2State;
    const ahead = {
      ...mid,
      players: [
        { ...mid.players[0], score: 12 },
        { ...mid.players[1], score: 0 },
      ],
    } as D2State;
    // 讀對手背包的那個（c-N3-pen 對 c-N3-pen-nobag 的差別）：對手背包滿了就搶不了金幣。
    const oppFull = { ...near, bags: [0, 3] } as D2State;
    for (const name of C_FAMILY) {
      const pairs: [D2State, D2State][] =
        name === 'c-N3-lead'
          ? [[behind, ahead]]
          : name === 'c-N3-pen'
            ? [[near, oppFull]]
            : [[near, base]];
      const changed = pairs.some(([x, y]) => ask(name, x) !== ask(name, y));
      expect(changed, name).toBe(true);
    }
    // 不讀對手背包的版本：對手背包滿了也照樣避開。
    expect(ask('c-N3-pen-nobag', near)).toBe(ask('c-N3-pen-nobag', oppFull));
  });

  it('雙胞胎：沒有任何競爭的局面下，(b) 與它的 (c) 雙胞胎按鍵相同（讀分數的 c-N3-lead 分差小時也一樣）', () => {
    for (const bags of [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ] as [number, number][]) {
      for (const [b, c] of TWINS) {
        expect(ask(c, calm(bags)), `${b} → ${c} bags=${String(bags[0])}`).toBe(ask(b, calm(bags)));
      }
    }
  });
});

describe('走路、背包與回基地', () => {
  it('背包空、只有一枚金幣在右邊：非 stay 成員都往右；1 號邊往自己的方向', () => {
    const s = at(cell(5, 12), cell(31, 0), [cell(9, 12)]);
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      if (name === 'b-stay') {
        continue;
      }
      expect(ask(name, s), name).toBe(1);
    }
    const s1 = at(cell(0, 23), cell(20, 5), [cell(16, 5)]);
    expect(ask('b-N3', s1, 1)).toBe(3);
  });

  it('b-N1：背包有 1 枚就回基地（基地在左下，我在右上方 → 往下或往左）', () => {
    const s = at(cell(10, 10), cell(31, 0), [cell(11, 10)], { bags: [1, 0] });
    expect([2, 3]).toContain(ask('b-N1', s));
    expect(ask('b-N3', s)).toBe(1); // b-N3 繼續裝：金幣在右邊
  });

  it('背包滿了（3 枚）：所有成員都往基地走，不理金幣', () => {
    const s = at(cell(10, 10), cell(31, 0), [cell(11, 10)], { bags: [3, 0] });
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      if (name === 'b-stay') {
        continue;
      }
      expect([2, 3], name).toContain(ask(name, s));
    }
  });

  it('時間快到、背包裡有東西：回基地，即使金幣就在旁邊（時間到時還在背包裡的不算分）', () => {
    // 離基地 (0,23) 的距離 10 + 13 = 23 步 ≈ 115 個 tick；剩 120 個 tick，還是要立刻走。
    const s = at(cell(10, 10), cell(31, 0), [cell(11, 10)], { bags: [1, 0], tick: 3480 });
    for (const name of ['b-N3', 'b-N2', 'b-N3-K5', 'c-N3-pen']) {
      expect([2, 3], name).toContain(ask(name, s));
    }
  });

  it('時間快到、背包空：不去撿「撿了也來不及存」的金幣（站著不動）', () => {
    const s = at(cell(10, 10), cell(31, 0), [cell(11, 10)], { bags: [0, 0], tick: 3590 });
    expect(ask('b-N3', s)).toBe(-1);
  });

  it('b-N3-K2：背包有東西時，繞太遠的金幣不撿、直接回家；b-N3 照撿', () => {
    // 我在 (3,20)，基地 (0,23)（6 步）。金幣在 (3,10)（10 步，還要 +13+... 回基地）→ 繞很遠。
    const s = at(cell(3, 20), cell(31, 0), [cell(3, 10)], { bags: [1, 0] });
    expect(ask('b-N3', s)).toBe(0);
    expect([2, 3]).toContain(ask('b-N3-K2', s));
  });

  it('不被動到：問成員不會改動傳進來的 state', () => {
    const s = Object.freeze(calm([1, 0]));
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      expect(() => member(name).decide(s, 0, s.tick)).not.toThrow();
    }
  });

  it('(c) 的 pen：對手比我近而且背包有空位的金幣被降級；對手背包滿了就不降', () => {
    const s = at(cell(10, 10), cell(15, 10), [cell(13, 10), cell(10, 14)]);
    expect(ask('b-N3', s)).toBe(1);
    expect(ask('c-N3-pen', s)).toBe(2);
    expect(ask('c-N3-pen', { ...s, bags: [0, 3] } as D2State)).toBe(1);
  });
});

describe('反應延遲', () => {
  const asked = (delay: number, states: D2State[]): D2State[] => {
    const seen: D2State[] = [];
    const spy: Controller<D2State> = {
      decide(s) {
        seen.push(s);
        return NONE;
      },
    };
    const ctl = withDelay(spy, delay);
    states.forEach((s) => ctl.decide(s, 0, s.tick));
    return seen;
  };

  it('delay 0 就是原控制器本身', () => {
    const inner = member('b-N3');
    expect(withDelay(inner, 0)).toBe(inner);
  });

  it('世界是 delay 個 tick 前的，自己的位置、背包、分數是現在的', () => {
    const base = calm();
    const states: D2State[] = Array.from({ length: 20 }, (_v, i) => ({
      ...base,
      tick: 100 + i,
      bags: [i % 4, 3 - (i % 4)],
      players: [
        { ...base.players[0], cell: cell(5, 12) + i, score: i },
        { ...base.players[1], cell: cell(31, 0) - i, score: 2 * i },
      ],
    })) as D2State[];
    const seen = asked(12, states);
    const last = seen[seen.length - 1] as D2State;
    expect(last.players[0].cell).toBe(cell(5, 12) + 19);
    expect(last.players[0].score).toBe(19);
    expect(last.bags[0]).toBe(19 % 4);
    expect(last.players[1].cell).toBe(cell(31, 0) - 7);
    expect(last.players[1].score).toBe(14);
    expect(last.bags[1]).toBe(3 - (7 % 4));
    expect(last.tick).toBe(119);
  });

  it('自己剛踩過的金幣（延遲看到的世界裡還在）不再當目標', () => {
    const states: D2State[] = [];
    for (let i = 0; i < 14; i += 1) {
      const mine = i >= 3 ? cell(8, 12) : cell(7, 12);
      states.push(
        at(mine, cell(31, 0), i >= 3 ? [cell(5, 4)] : [cell(8, 12), cell(5, 4)], {
          tick: 200 + i,
        }),
      );
    }
    const last = asked(12, states).pop() as D2State;
    expect(last.coins).toEqual([cell(5, 4)]);
  });
});

describe('對局與分歧率的串接', () => {
  it('playWith 跑得完一整場；同一個種子兩次結果相同', () => {
    const a = playWith(3, member('b-N3'), MAIN_CELL);
    const b = playWith(3, member('b-N3'), MAIN_CELL);
    expect(a).toEqual(b);
    expect(Number.isFinite(a.margin)).toBe(true);
  });

  it('isPoint：每個走格週期的最後一個 tick（它按的鍵決定這一次走哪）', () => {
    expect(isPoint(makeState({ tick: 4 }), 0, 4)).toBe(true);
    expect(isPoint(makeState({ tick: 9 }), 0, 9)).toBe(true);
    expect(isPoint(makeState({ tick: 5 }), 0, 5)).toBe(false);
  });

  it('compareBC：自己對自己 → 分歧率 0、勝率差 0；上限成立、沒有一致性違規', () => {
    const r = compareBC(spec('b-N3', 'b-N3', [1, 2], MAIN_CELL));
    expect(r.divergence.gamesDiffer).toBe(0);
    expect(r.win.diff.mean).toBe(0);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
  });

  it('divergence：用的是自己的 isPoint，點級分母 > 0', () => {
    const d = divergence(spec('b-N3', 'c-N3-pen', [1], MAIN_CELL));
    expect(d.pointBasis).toBe('isPoint');
    expect(d.points).toBeGreaterThan(0);
  });

  it('(b) 驅動的對局與單獨的 (b) 對局逐位元相同（影子不影響對局）', () => {
    const plain = playWith(5, member('b-N3'), MAIN_CELL);
    const r = compareBC(spec('b-N3', 'c-N3-pen', [5], MAIN_CELL));
    expect(r.margin.b.mean).toBe(plain.margin);
    expect(r.win.b).toBe(plain.win);
  });

  it('選法：勝率最高；同勝率取分差高；再同取靠前', () => {
    expect(
      selectBest([
        { name: 'a', win: 0.5, margin: 1 },
        { name: 'b', win: 0.7, margin: -5 },
        { name: 'c', win: 0.7, margin: 3 },
        { name: 'd', win: 0.7, margin: 3 },
      ]).name,
    ).toBe('c');
  });

  it('score：站著不動的成員拿到的勝率與分差有意義（有限數字）', () => {
    const row = score('b-stay', [11, 12], MAIN_CELL);
    expect(row.win).toBeGreaterThanOrEqual(0);
    expect(row.win).toBeLessThanOrEqual(1);
    expect(Number.isFinite(row.margin)).toBe(true);
  });

  it('AI 的種子約定（慣例同 D-Q、D-8）', () => {
    expect(AI_SEED_OFFSET).toBe(1_000_003);
    expect(HOME1).toBeGreaterThanOrEqual(0);
    expect(HOME0).toBeGreaterThanOrEqual(0);
  });
});

describe('(c) 不是 AI（10.61 第二個陷阱）', () => {
  it('成員檔的原始碼沒有 import evaluate、opponentAction、levelController、policyByName、各性格檔', () => {
    const text = readFileSync(
      new URL('./probe-a.members.test-helpers.ts', import.meta.url),
      'utf8',
    );
    const code = text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(
      /\bevaluate\b|predictOpponent|opponentAction|levelController|policyByName|wrapPolicy|humanModel|human-model|policies\/|ai\/level|ai\/policies|ai\/human/,
    );
    expect(code).not.toMatch(/from ['"][^'"]*\/ai\//);
  });

  it('成員檔與 logic.ts 都沒有時鐘與亂數', () => {
    for (const file of ['./probe-a.members.test-helpers.ts', './logic.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text).not.toMatch(/Math\.random|Date\.now|performance\.now|setTimeout|setInterval/);
    }
  });
});
