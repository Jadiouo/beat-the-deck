import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC, divergence } from '../../../tests/ai/probe-a.shared';
import type { Buttons, Controller, Side } from '../../core/types';
import { cell } from '../_diamonds/logic';
import { makeState } from './logic';
import type { D3State } from './logic';
import { B_FAMILY, C_FAMILY, TWINS, member, withDelay } from './probe-a.members.test-helpers';
import {
  AI_SEED_OFFSET,
  MAIN_CELL,
  isPoint,
  playWith,
  score,
  selectBest,
  spec,
} from './probe-a.test-helpers';

/**
 * D-3 探針 A（完整版）的工具測試（`docs/cards/D-3.md`「探針 A（完整版）」）。
 * 只測量測工具本身：族的定義、(b) 不讀對手、(c) 真的讀、雙胞胎、走路、反應延遲、選法、分歧率的串接。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const dirOf = (b: Buttons): number => (b.up ? 0 : b.right ? 1 : b.down ? 2 : b.left ? 3 : -1);

/** 沒有牆的局面：我（0 號邊）在 me、對手（1 號邊）在 opp。 */
function at(
  me: number,
  opp: number,
  gems: { cell: number; born: number }[],
  extra: Parameters<typeof makeState>[0] = {},
): D3State {
  return makeState({ tick: 100, players: [{ cell: me }, { cell: opp }], gems, ...extra });
}

const ask = (name: string, state: D3State, side: Side = 0): number => {
  const ctl = member(name);
  return dirOf(ctl.decide(state, side, state.tick));
};

/** 一個「對手不在附近、也不搶」的局面：三顆寶石離我近、對手很遠。 */
const calm = (): D3State =>
  at(cell(5, 12), cell(31, 0), [
    { cell: cell(8, 12), born: 0 },
    { cell: cell(5, 6), born: 40 },
    { cell: cell(2, 15), born: 90 },
  ]);

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
  // 同一個局面，只換對手的位置、待走方向、分數：(b) 的按鍵必須完全不變。
  const variants = (base: D3State): D3State[] => [
    base,
    { ...base, players: [base.players[0], { ...base.players[1], cell: cell(6, 12) }] },
    { ...base, players: [base.players[0], { ...base.players[1], cell: cell(5, 7), pending: 0 }] },
    { ...base, players: [base.players[0], { ...base.players[1], score: 40 }] },
  ];
  it('(b) 全部成員：對手的位置、待走方向、分數換掉，按鍵不變', () => {
    const base = at(cell(10, 10), cell(20, 10), [
      { cell: cell(14, 10), born: 0 },
      { cell: cell(10, 4), born: 30 },
      { cell: cell(2, 10), born: 60 },
    ]);
    for (const name of B_FAMILY) {
      const answers = variants(base).map((s) => ask(name, s));
      expect(new Set(answers).size, name).toBe(1);
    }
  });

  it('(c) 全部成員：至少有一個局面，換掉對手的狀態之後按鍵會變', () => {
    // 我在 (10,10)；寶石 A 在右邊 4 格、B 在上面 6 格。對手在 A 旁邊時搶得到 A，所以 (c) 會改去 B。
    const base = at(cell(10, 10), cell(31, 0), [
      { cell: cell(14, 10), born: 0 },
      { cell: cell(10, 4), born: 0 },
    ]);
    const near = {
      ...base,
      players: [base.players[0], { ...base.players[1], cell: cell(15, 10) }],
    } as D3State;
    const far = base;
    // c-pull2-lead 讀的是分數：落後時敢賭、領先時保守。
    // 近的那顆（右邊 2 格）已經貶到 4 分，遠的（上面 6 格）是新的 9 分：求近的去右邊、追價值的去上面。
    const behind = at(
      cell(10, 10),
      cell(31, 0),
      [
        { cell: cell(12, 10), born: 0 },
        { cell: cell(10, 4), born: 295 },
      ],
      { tick: 300 },
    );
    const behindState: D3State = {
      ...behind,
      players: [
        { ...behind.players[0], score: 0 },
        { ...behind.players[1], score: 30 },
      ],
    };
    const aheadState: D3State = {
      ...behind,
      players: [
        { ...behind.players[0], score: 30 },
        { ...behind.players[1], score: 0 },
      ],
    };
    // c-value-pen：價值優先，只有兩顆價值一樣時才看（加罰後的）距離。
    const tie = at(cell(10, 10), cell(31, 0), [
      { cell: cell(14, 10), born: 0 },
      { cell: cell(10, 4), born: 20 },
    ]);
    const tieNear = {
      ...tie,
      players: [tie.players[0], { ...tie.players[1], cell: cell(15, 10) }],
    } as D3State;
    for (const name of C_FAMILY) {
      const pairs: [D3State, D3State][] =
        name === 'c-pull2-lead'
          ? [[behindState, aheadState]]
          : name === 'c-value-pen'
            ? [[tieNear, tie]]
            : [[near, far]];
      const changed = pairs.some(([x, y]) => ask(name, x) !== ask(name, y));
      expect(changed, name).toBe(true);
    }
  });

  it('雙胞胎：沒有任何競爭的局面（對手很遠、不搶）下，(b) 與它的 (c) 雙胞胎按鍵相同', () => {
    for (const [b, c] of TWINS) {
      if (c === 'c-pull2-lead') {
        continue; // 讀分數的那個：分數差 < 門檻時行為等於 b-pull2，下面另測
      }
      expect(ask(c, calm()), `${b} → ${c}`).toBe(ask(b, calm()));
    }
    expect(ask('c-pull2-lead', calm())).toBe(ask('b-pull2', calm()));
  });
});

describe('走路與選目標', () => {
  it('只有一顆寶石在右邊：每個非 stay 成員都往右走；1 號邊同樣往目標走', () => {
    const s = at(cell(5, 12), cell(31, 0), [{ cell: cell(9, 12), born: 0 }]);
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      if (name === 'b-stay') {
        continue;
      }
      expect(ask(name, s), name).toBe(1);
    }
    const s1 = at(cell(0, 23), cell(20, 5), [{ cell: cell(16, 5), born: 0 }]);
    expect(ask('b-near', s1, 1)).toBe(3);
  });

  it('b-stay 一直不動；沒有寶石時大家都不動', () => {
    expect(ask('b-stay', calm())).toBe(-1);
    const empty = at(cell(5, 12), cell(31, 0), []);
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      expect(ask(name, empty), name).toBe(-1);
    }
  });

  it('b-near 挑最近的；b-value 挑現在值最高的（即使遠）', () => {
    const s = at(
      cell(10, 10),
      cell(31, 0),
      [
        { cell: cell(12, 10), born: 0 }, // 近，但出生很久了：到手時價值低
        { cell: cell(10, 2), born: 95 }, // 遠，但新鮮
      ],
      { tick: 300 },
    );
    expect(ask('b-near', s)).toBe(1);
    expect(ask('b-value', s)).toBe(0);
  });

  it('(c) 的 pen 避開對手比我近的寶石；skip 全被搶時退回照樣去', () => {
    const s = at(
      cell(10, 10),
      cell(15, 10),
      [
        { cell: cell(13, 10), born: 90 }, // 對手離它 2、我 3：對手搶得到
        { cell: cell(10, 14), born: 90 }, // 我 4、對手 9
      ],
      { tick: 100 },
    );
    expect(ask('b-near', s)).toBe(1);
    expect(ask('c-near-pen', s)).toBe(2);
    const onlyContested = at(cell(10, 10), cell(15, 10), [{ cell: cell(13, 10), born: 90 }]);
    expect(ask('c-pull2-skip', onlyContested)).toBe(1);
  });

  it('不被動到：問成員不會改動傳進來的 state', () => {
    const s = Object.freeze(calm());
    for (const name of [...B_FAMILY, ...C_FAMILY]) {
      expect(() => member(name).decide(s, 0, s.tick)).not.toThrow();
    }
  });
});

describe('反應延遲', () => {
  const asked = (inner: Controller<D3State>, delay: number, states: D3State[]): D3State[] => {
    const seen: D3State[] = [];
    const spy: Controller<D3State> = {
      decide(s) {
        seen.push(s);
        return NONE;
      },
    };
    void inner;
    const ctl = withDelay(spy, delay);
    states.forEach((s) => ctl.decide(s, 0, s.tick));
    return seen;
  };

  it('delay 0 就是原控制器本身', () => {
    const inner = member('b-near');
    expect(withDelay(inner, 0)).toBe(inner);
  });

  it('世界是 delay 個 tick 前的（對手位置舊），自己的位置與分數是現在的', () => {
    const base = calm();
    const states: D3State[] = Array.from({ length: 20 }, (_v, i) => ({
      ...base,
      tick: 100 + i,
      players: [
        { ...base.players[0], cell: cell(5, 12) + i, score: i },
        { ...base.players[1], cell: cell(31, 0) - i, score: 2 * i },
      ],
    })) as D3State[];
    const seen = asked(member('b-near'), 12, states);
    const last = seen[seen.length - 1] as D3State;
    expect(last.players[0].cell).toBe(cell(5, 12) + 19);
    expect(last.players[0].score).toBe(19);
    expect(last.players[1].cell).toBe(cell(31, 0) - 7); // 19 − 12 個 tick 前
    expect(last.players[1].score).toBe(14);
    expect(last.tick).toBe(119);
  });

  it('自己剛撿走的寶石（延遲看到的世界裡還在）不再當目標', () => {
    const gem = { cell: cell(8, 12), born: 0 };
    const other = { cell: cell(5, 4), born: 0 };
    const states: D3State[] = [];
    for (let i = 0; i < 14; i += 1) {
      // 第 3 個 tick 起我站在 (8,12) 上（把它撿了：現在的世界已經沒有它了）
      const mine = i >= 3 ? cell(8, 12) : cell(7, 12);
      states.push(at(mine, cell(31, 0), i >= 3 ? [other] : [gem, other], { tick: 200 + i }));
    }
    const seen = asked(member('b-near'), 12, states);
    const last = seen[seen.length - 1] as D3State;
    expect(last.gems.map((g) => g.cell)).toEqual([other.cell]);
  });
});

describe('對局與分歧率的串接', () => {
  it('playWith 跑得完一整場；同一個種子兩次結果相同', () => {
    const a = playWith(3, member('b-pull2'), MAIN_CELL);
    const b = playWith(3, member('b-pull2'), MAIN_CELL);
    expect(a).toEqual(b);
    expect(Number.isFinite(a.margin)).toBe(true);
  });

  it('isPoint：每個走格週期的最後一個 tick（它按的鍵決定這一次走哪）', () => {
    expect(isPoint(makeState({ tick: 4 }), 0, 4)).toBe(true);
    expect(isPoint(makeState({ tick: 9 }), 0, 9)).toBe(true);
    expect(isPoint(makeState({ tick: 5 }), 0, 5)).toBe(false);
    expect(isPoint(makeState({ tick: 7 }), 0, 7)).toBe(false);
  });

  it('compareBC：自己對自己 → 分歧率 0、勝率差 0；上限成立、沒有一致性違規', () => {
    const r = compareBC(spec('b-pull2', 'b-pull2', [1, 2], MAIN_CELL));
    expect(r.divergence.gamesDiffer).toBe(0);
    expect(r.win.diff.mean).toBe(0);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
  });

  it('divergence：b-pull2 對 c-pull2-pen 會回傳點級分母 > 0（用的是自己的 isPoint）', () => {
    const d = divergence(spec('b-pull2', 'c-pull2-pen', [1], MAIN_CELL));
    expect(d.pointBasis).toBe('isPoint');
    expect(d.points).toBeGreaterThan(0);
  });

  it('(b) 驅動的對局與單獨的 (b) 對局逐位元相同（影子不影響對局）', () => {
    const plain = playWith(5, member('b-pull2'), MAIN_CELL);
    const r = compareBC(spec('b-pull2', 'c-pull2-pen', [5], MAIN_CELL));
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

  it('AI 的種子約定與訓練／量測種子不重疊（慣例同 D-Q、D-8）', () => {
    expect(AI_SEED_OFFSET).toBe(1_000_003);
  });
});

describe('(c) 不是 AI（10.61 第二個陷阱）', () => {
  it('成員檔的原始碼沒有 import evaluate、opponentAction、levelController、policyByName、各性格檔', () => {
    const text = readFileSync(
      new URL('./probe-a.members.test-helpers.ts', import.meta.url),
      'utf8',
    );
    // 只掃程式碼，不掃註解（註解裡可以寫「不 import 它們」這種說明）。
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
