import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC } from '../../../tests/ai/probe-a.shared';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Side } from '../../core/types';
import { cell, nextCell } from '../_diamonds/logic';
import { dAGame, makeState } from './logic';
import type { DAState } from './logic';
import {
  B_FAMILY,
  BALLAST,
  CONFIG,
  C_FAMILY,
  EXTRA_TWINS,
  TWIN_OF,
  isPoint,
  member,
  playWith,
  score,
  selectBest,
  spec,
  withDelay,
} from './probe-a.test-helpers';

/**
 * D-A 探針 A（完整版）的工具測試（`docs/cards/D-A.md`「探針 A（完整版）」）。
 * 只測量測工具本身：族的定義、(b) 不讀對手、(c) 真的讀、雙胞胎、選法、反應延遲、分歧率的串接。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const idle = (b: Buttons): boolean => JSON.stringify(b) === JSON.stringify(NONE);
const dirOf = (b: Buttons): string =>
  b.up ? 'up' : b.right ? 'right' : b.down ? 'down' : b.left ? 'left' : 'none';

/** 我（0 號邊）在 (10, 12)。A 在右邊 4 步、B 在上面 7 步（B 的方向是上）。沒有牆。 */
const ME = cell(10, 12);
const A = cell(14, 12);
const B = cell(10, 5);
const FAR = cell(31, 0);

function at(me: number, opp: number, extra: Parameters<typeof makeState>[0] = {}): DAState {
  return makeState({
    tick: 200,
    coins: [A, B],
    players: [{ cell: me }, { cell: opp }],
    ...extra,
  });
}

/** 新的控制器連續問 `n` 個 tick（tick 遞增，世界不變）。 */
function asks(name: string, state: DAState, side: Side = 0, n = 6): Buttons[] {
  const ctl = member(name);
  return Array.from({ length: n }, (_v, k) =>
    ctl.decide({ ...state, tick: state.tick + k }, side, state.tick + k),
  );
}
const first = (name: string, state: DAState, side: Side = 0): string =>
  dirOf(asks(name, state, side, 1)[0] as Buttons);

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

  it('10.68 第六小節：每個 (b) 成員都有對應的 (c) 版本，只有明講的墊底成員（走不動／最遠先）例外', () => {
    for (const b of B_FAMILY) {
      const twin = TWIN_OF[b];
      if (BALLAST.includes(b)) {
        expect(twin).toBeNull();
      } else {
        expect(typeof twin).toBe('string');
        expect(C_FAMILY as readonly string[]).toContain(twin);
      }
    }
    // 沒有 (c) 成員是沒有雙胞胎的孤兒，也沒有 (b) 之外的鍵。
    expect(Object.keys(TWIN_OF).sort()).toEqual([...B_FAMILY].sort());
    const used = new Set([
      ...Object.values(TWIN_OF).filter((v) => v !== null),
      ...EXTRA_TWINS.map(([, c]) => c),
    ]);
    for (const c of C_FAMILY) {
      expect(used.has(c)).toBe(true);
    }
    for (const [b, c] of EXTRA_TWINS) {
      expect(B_FAMILY as readonly string[]).toContain(b);
      expect(C_FAMILY as readonly string[]).toContain(c);
    }
  });
});

describe('(b) 不讀對手的任何狀態', () => {
  const bases: readonly DAState[] = [
    at(ME, FAR),
    at(cell(20, 20), FAR, { players: [{ cell: cell(20, 20) }, { cell: FAR }] }),
    at(cell(14, 11), FAR),
    at(cell(3, 3), FAR, { coins: [cell(5, 3), cell(5, 5), cell(9, 9), cell(2, 15)] }),
  ];
  const vary = (s: DAState): DAState[] => [
    { ...s, players: [s.players[0], { cell: A, pending: 3, score: 9 }] },
    { ...s, players: [s.players[0], { cell: B, pending: 2, score: 0 }] },
    { ...s, players: [s.players[0], { cell: s.players[0].cell, pending: 1, score: 40 }] },
    {
      ...s,
      players: [
        { ...s.players[0], score: 7 },
        { cell: cell(12, 12), pending: 0, score: 1 },
      ],
    },
  ];

  it.each(B_FAMILY.map((name) => [name]))(
    '%s：換掉對手的位置、待走方向、分數，每個 tick 的決定都一樣',
    (name) => {
      for (const base of bases) {
        const plain = asks(name, base);
        for (const v of vary(base).slice(0, 3)) {
          expect(asks(name, v)).toEqual(plain);
        }
      }
    },
  );

  it('(b) 的規則函式拿不到對手的視野：原始碼裡 ruleB 沒有對手的欄位', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    const ruleB = text.slice(text.indexOf('function ruleB'), text.indexOf('/** (c) 的規則'));
    expect(ruleB.length).toBeGreaterThan(200);
    expect(ruleB).not.toMatch(/OppView|oppOf|\.players\[|\bopp\b|oppNext|nextCell/);
  });

  it('1 號邊也不讀（鏡像局面）', () => {
    const s = makeState({
      tick: 200,
      coins: [cell(17, 12), cell(21, 20)],
      players: [{ cell: cell(0, 23) }, { cell: cell(21, 12) }],
    });
    for (const name of B_FAMILY) {
      const plain = asks(name, s, 1);
      const moved = {
        ...s,
        players: [{ cell: cell(17, 12), pending: 1, score: 5 }, s.players[1]],
      } as DAState;
      expect(asks(name, moved, 1)).toEqual(plain);
    }
  });
});

describe('(c) 真的讀了對手（只換它讀的那一項，決定會變）', () => {
  // 對手貼著 A（它到 A 1 步、我 4 步）：搶不到 A；對手在地圖另一端：A 沒有爭議。
  const contested = at(ME, cell(15, 12));
  const calm = at(ME, FAR);

  it.each(['c-pos4', 'c-pos8', 'c-pos16', 'c-chain-pos8', 'c-dense-pos8'])(
    '%s：對手貼著 A 就改去 B（上），對手很遠就去 A（右）',
    (name) => {
      expect(first(name, calm)).toBe('right');
      expect(first(name, contested)).toBe('up');
    },
  );

  it('c-next8：看對手鎖定的方向——現在的位置不比我近、但下一步會比我近，就讓出', () => {
    // 對手在 (18, 12)，離 A 4 步（和我一樣近，不算搶先）；鎖定向左，下一步 (17, 12) 離 A 3 步。
    const idleOpp = at(ME, cell(18, 12));
    const heading = at(ME, cell(18, 12), {
      players: [{ cell: ME }, { cell: cell(18, 12), pending: 3 }],
    });
    expect(first('c-next8', idleOpp)).toBe('right');
    expect(first('c-next8', heading)).toBe('up');
    // c-pos8（只看現在的位置）兩者一樣。
    expect(first('c-pos8', idleOpp)).toBe(first('c-pos8', heading));
  });

  it('c-lead：領先時照 16 步算（讓出）、落後時只算 2 步（敢搶），差不多時 8 步', () => {
    const opp = cell(15, 12);
    const ahead = at(ME, opp, {
      players: [
        { cell: ME, score: 5 },
        { cell: opp, score: 0 },
      ],
    });
    const behind = at(ME, opp, {
      players: [
        { cell: ME, score: 0 },
        { cell: opp, score: 5 },
      ],
    });
    const even = at(ME, opp);
    expect(first('c-lead', ahead)).toBe('up');
    expect(first('c-lead', behind)).toBe('right');
    expect(first('c-lead', even)).toBe('up');
  });

  it('c-adv：去「我比對手早到最多」的那一枚', () => {
    expect(first('c-adv', contested)).toBe('up');
    expect(first('c-adv', calm)).toBe('right');
  });

  it('每個 (c) 成員至少有一個測試讀到它的輸入（上面的案例涵蓋整個族）', () => {
    const covered = [
      'c-pos4',
      'c-pos8',
      'c-pos16',
      'c-chain-pos8',
      'c-dense-pos8',
      'c-next8',
      'c-lead',
      'c-adv',
    ];
    expect([...covered].sort()).toEqual([...C_FAMILY].sort());
  });
});

describe('成員的動作（走路與選目標）', () => {
  it('b-nearest：去最近的金幣（A，右）；1 號邊鏡像', () => {
    expect(first('b-nearest', at(ME, FAR))).toBe('right');
    // 1 號邊：我在 (21, 11)，A' 在左 4 步、B' 在下 8 步。
    const s = makeState({
      tick: 200,
      coins: [cell(17, 11), cell(21, 19)],
      players: [{ cell: cell(0, 23) }, { cell: cell(21, 11) }],
    });
    expect(first('b-nearest', s, 1)).toBe('left');
  });

  it('站在金幣上的那一格不算目標（延遲時舊世界可能還有我剛撿的那一枚）', () => {
    const s = makeState({
      tick: 200,
      coins: [ME, B],
      players: [{ cell: ME }, { cell: FAR }],
    });
    expect(first('b-nearest', s)).toBe('up');
  });

  it('沒有金幣：不動', () => {
    expect(idle(asks('b-nearest', at(ME, FAR, { coins: [] }))[0] as Buttons)).toBe(true);
  });

  it('b-stay：永遠不動', () => {
    for (const b of asks('b-stay', at(ME, FAR))) {
      expect(idle(b)).toBe(true);
    }
  });

  it('b-far：去最遠的那一枚（B，上）', () => {
    expect(first('b-far', at(ME, FAR))).toBe('up');
  });

  it('b-stick：目標還在而且沒有差超過黏著的量就不換；b-nearest 會換', () => {
    // 第一個 tick 看到 A（右 4 步）、B（上 8 步）。第二個 tick 我走到 (10, 8)，B 近了（4）、A 變遠（8），差 4 > 3 就換。
    // 用小一點的差距：我走到 (10, 11)：A 5 步、B 7 步；沒換。再走到 (10, 10)：A 6、B 6，b-nearest 平手取先出現的 A；
    // 我們要測的是黏著：從 B 當目標開始，我在 (10, 9)：B 5 步、A 7 步（差 2 ≤ 3 → 黏著 B），再讓 A 變成 4 步（差 -1）。
    const T = cell(10, 4);
    const stick = member('b-stick');
    const nearest = member('b-nearest');
    const s0 = makeState({
      tick: 200,
      coins: [T],
      players: [{ cell: cell(10, 9) }, { cell: FAR }],
    });
    expect(dirOf(stick.decide(s0, 0, 200))).toBe('up');
    expect(dirOf(nearest.decide(s0, 0, 200))).toBe('up');
    // 新出現 A' 離我 4 步、B 離我 5 步（A' 好 1 步，在黏著的量之內）。
    const A2 = cell(14, 9);
    const s1 = makeState({
      tick: 201,
      coins: [T, A2],
      players: [{ cell: cell(10, 9) }, { cell: FAR }],
    });
    expect(dirOf(stick.decide(s1, 0, 201))).toBe('up');
    expect(dirOf(nearest.decide(s1, 0, 201))).toBe('right');
  });

  it('b-start8：用對手的起點（常數）當對手在哪——起點離某枚金幣比我近，那一枚就多算 8 步', () => {
    // 我在 (25, 8)。P 在 (28, 3)：離我 8 步、離對手起點 (31, 0) 6 步（比我近，加 8 ＝ 16）。Q 在 (15, 8)：離我 10 步。
    const s = makeState({
      tick: 200,
      coins: [cell(28, 3), cell(15, 8)],
      players: [{ cell: cell(25, 8) }, { cell: FAR }],
    });
    expect(first('b-start8', s)).toBe('left');
    expect(first('b-nearest', s)).not.toBe('left');
    // 起點是常數：對手人在 P 上也不改變決定（(b) 不讀）。
    const onP = {
      ...s,
      players: [s.players[0], { cell: cell(28, 3), pending: -1, score: 0 }],
    } as DAState;
    expect(first('b-start8', onP)).toBe('left');
  });

  it('b-chain：看一枚金幣旁邊還有沒有別的金幣', () => {
    // 我在 (10, 12)。X 在右 4 步旁邊沒有別人；Y 在上 5 步旁邊緊貼著 Z。chain 0.5：X = 4 + 0.5×(離最近的別枚)，Y = 5 + 0.5×1。
    const X = cell(14, 12);
    const Y = cell(10, 7);
    const Z = cell(10, 6);
    const s = makeState({ tick: 200, coins: [X, Y, Z], players: [{ cell: ME }, { cell: FAR }] });
    expect(first('b-nearest', s)).toBe('right');
    expect(first('b-chain', s)).toBe('up');
  });

  it('b-dense：金幣擠在一起的地方先去', () => {
    const X = cell(14, 12);
    const Y = cell(10, 6);
    const Z = cell(10, 4);
    const W = cell(12, 5);
    const s = makeState({
      tick: 200,
      coins: [X, Y, Z, W],
      players: [{ cell: ME }, { cell: FAR }],
    });
    expect(first('b-nearest', s)).toBe('right');
    expect(first('b-dense', s)).toBe('up');
  });

  it('朝金幣走：繞牆的最短路（中間有牆就繞，不撞）', () => {
    // 我 (10, 12)、金幣 (14, 12)，牆在 (12, 11) 到 (12, 13) 擋住直線：走到 x = 12 之前直走，牆前要繞。
    const walls = [cell(11, 12), cell(11, 11), cell(11, 13)];
    const s = makeState({
      tick: 200,
      walls,
      coins: [A],
      players: [{ cell: ME }, { cell: FAR }],
    });
    const d = first('b-nearest', s);
    expect(['up', 'down']).toContain(d);
  });
});

describe('反應延遲', () => {
  it('delay ＝ 0 就是原本的控制器（同一個物件）', () => {
    const inner = member('b-nearest');
    expect(withDelay(inner, 0, dAGame)).toBe(inner);
  });

  it('世界是 delay 個 tick 前的（對手的位置），自己的位置是現在的（重播自己的按鍵），自己撿過的金幣已經不在', () => {
    const seen: DAState[] = [];
    const real: DAState[] = [];
    const right: Buttons = { ...NONE, right: true };
    const left: Buttons = { ...NONE, left: true };
    const recorder: Controller<DAState> = {
      decide(state) {
        seen.push(state);
        real.push(state);
        return right;
      },
    };
    const opp: Controller<DAState> = {
      decide() {
        return left;
      },
    };
    const delayed = withDelay(recorder, 12, dAGame);
    // 我（0 號邊）在左下角往右走。把種子的金幣換成「我正前方」沒辦法，所以只驗位置與對手的舊。
    const result = playMatch(dAGame, 3, { ...CONFIG, maxTicks: 60 }, delayed, opp);
    expect(result.ticks).toBe(60);
    // 真實的世界：重跑一次，拿到每個 tick 的真實 state。
    let state = dAGame.init(3, { ...CONFIG, maxTicks: 60 });
    const truth: DAState[] = [state];
    for (let t = 0; t < 59; t += 1) {
      state = dAGame.step(state, [right, left]);
      truth.push(state);
    }
    for (const t of [12, 30, 45, 59]) {
      const view = seen[t] as DAState;
      expect(view.tick).toBe(t);
      expect(view.players[0].cell).toBe((truth[t] as DAState).players[0].cell);
      // 對手：舊世界裡它鎖定的方向在重播（它「沒按鍵」）裡走掉一次，之後不動。
      const old = truth[t - 12] as DAState;
      expect(view.players[1].cell).toBe(nextCell(old.walls, old.players[1]));
    }
    // 前 12 個 tick 沒有更舊的世界：對手還在起點。
    expect((seen[5] as DAState).players[1].cell).toBe((truth[0] as DAState).players[1].cell);
    // 自己撿過的金幣在重播裡已經不在（沒有「幽靈金幣」）：任何時刻 view 的金幣都不在我現在站的格子上。
    for (const view of seen) {
      expect(view.coins).not.toContain(view.players[0].cell);
    }
  });

  it('1 號邊的延遲：自己是 players[1]', () => {
    const seen: DAState[] = [];
    const left: Buttons = { ...NONE, left: true };
    const right: Buttons = { ...NONE, right: true };
    const recorder: Controller<DAState> = {
      decide(state) {
        seen.push(state);
        return left;
      },
    };
    const delayed = withDelay(recorder, 10, dAGame);
    playMatch(dAGame, 5, { ...CONFIG, maxTicks: 40 }, { decide: () => right }, delayed);
    let state = dAGame.init(5, { ...CONFIG, maxTicks: 40 });
    const truth: DAState[] = [state];
    for (let t = 0; t < 39; t += 1) {
      state = dAGame.step(state, [right, left]);
      truth.push(state);
    }
    const view = seen[30] as DAState;
    expect(view.players[1].cell).toBe((truth[30] as DAState).players[1].cell);
    const old = truth[20] as DAState;
    expect(view.players[0].cell).toBe(nextCell(old.walls, old.players[0]));
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

  it('(c) 的原始碼沒有 import evaluate、predictOpponent、opponentAction，也沒有拿 AI 的控制器當成員', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(
      /\bevaluate\b|predictOpponent|opponentAction|policies\/shared|humanModel|human-model|wrapPolicy|\.actions\(/,
    );
    // levelController 只用來做「對手」（playWith 裡一次）。
    expect(code.match(/levelController\(/g)?.length).toBe(1);
    const member_ = code.slice(
      code.indexOf('export function member'),
      code.indexOf('export function withDelay'),
    );
    expect(member_.length).toBeGreaterThan(100);
    expect(member_).not.toMatch(/levelController|policyByName/);
  });

  it('compareBC 串得起來：影子不影響對局（(b) 驅動的勝率與分差等於單獨跑 (b)）；勝率差不超過場級分歧率', () => {
    const seeds = [3, 4];
    const at12 = { policy: 'greedy', level: 10, delay: 12 } as const;
    const r = compareBC(spec('b-start8', 'c-pos8', seeds, at12));
    expect(r.n).toBe(2);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
    const alone = seeds.map((seed) => playWith(seed, member('b-start8'), at12));
    expect(r.win.b).toBe(alone.reduce((a, o) => a + o.win, 0) / seeds.length);
    expect(r.margin.b.mean).toBe(alone.reduce((a, o) => a + o.margin, 0) / seeds.length);
    expect(r.divergence.pointBasis).toBe('isPoint');
  }, 120_000);

  it('score 與 playWith 一致；b-stay（站著不走）比 b-nearest 差（等級 5、沒有延遲，4 場）', () => {
    const seeds = [3, 4, 5, 6];
    const easy = { policy: 'greedy', level: 5, delay: 0 } as const;
    const good = score('b-nearest', seeds, easy);
    const bad = score('b-stay', seeds, easy);
    expect(good.win).toBeGreaterThan(bad.win);
    expect(good.margin).toBeGreaterThan(bad.margin);
    const direct = seeds.map((s) => playWith(s, member('b-nearest'), easy));
    expect(good.win).toBe(direct.reduce((a, o) => a + o.win, 0) / seeds.length);
  }, 120_000);
});
