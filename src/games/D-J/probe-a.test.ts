import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compareBC } from '../../../tests/ai/probe-a.shared';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Side } from '../../core/types';
import { START_CELLS, cell, nextCell } from '../_diamonds/logic';
import { dJGame, makeState } from './logic';
import type { DJState } from './logic';
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
 * D-J 探針 A（完整版）的工具測試（`docs/cards/D-J.md`「探針 A（完整版）」）。
 * 只測量測工具本身：族的定義與雙胞胎、(b) 不讀對手、(c) 真的讀、各成員的動作、反應延遲、串接。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const dirOf = (b: Buttons): string =>
  b.up ? 'up' : b.right ? 'right' : b.down ? 'down' : b.left ? 'left' : 'none';

/** 0 號邊的基地在左下 (0, 23)；對手（1 號邊）的基地在右上 (31, 0)。 */
const HOME = START_CELLS[0];
const RIVAL = START_CELLS[1];
const MID = cell(15, 12);

function at(me: number, opp: number, extra: Parameters<typeof makeState>[0] = {}): DJState {
  return makeState({
    tick: 1300,
    coins: [cell(20, 12), cell(5, 5)],
    players: [{ cell: me }, { cell: opp }],
    ...extra,
  });
}

/** 新的控制器連續問 `n` 個 tick（tick 遞增，世界不變）。 */
function asks(name: string, state: DJState, side: Side = 0, n = 6): Buttons[] {
  const ctl = member(name);
  return Array.from({ length: n }, (_v, k) =>
    ctl.decide({ ...state, tick: state.tick + k }, side, state.tick + k),
  );
}
const first = (name: string, state: DJState, side: Side = 0): string =>
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

  it('10.68 第六小節：每個 (b) 成員都有對應的 (c) 版本，只有明講的墊底成員例外；每個 (c) 都有基底', () => {
    for (const b of B_FAMILY) {
      const twin = TWIN_OF[b];
      if (BALLAST.includes(b)) {
        expect(twin).toBeNull();
      } else {
        expect(typeof twin).toBe('string');
        expect(C_FAMILY as readonly string[]).toContain(twin);
      }
    }
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
  const bases: readonly DJState[] = [
    at(cell(10, 12), RIVAL),
    at(HOME, RIVAL, { players: [{ cell: HOME, score: 2 }, { cell: RIVAL }] }),
    at(cell(8, 20), RIVAL, { bags: [2, 0] }),
    at(cell(25, 5), RIVAL, { tick: 1310 }),
    at(cell(3, 21), RIVAL, {
      tick: 650,
      players: [{ cell: cell(3, 21), score: 1 }, { cell: RIVAL }],
    }),
  ];
  const vary = (s: DJState): DJState[] => [
    {
      ...s,
      players: [s.players[0], { cell: HOME, pending: 1, score: 9 }],
      bags: [s.bags[0], 3],
      lurk: [s.lurk[0], 30],
    },
    {
      ...s,
      players: [s.players[0], { cell: MID, pending: 2, score: 0 }],
      bags: [s.bags[0], 0],
      lurk: [s.lurk[0], 0],
      stolen: [s.stolen[0], 5],
    },
    {
      ...s,
      players: [s.players[0], { cell: cell(2, 21), pending: 0, score: 4 }],
      lurk: [s.lurk[0], 59],
    },
  ];

  it.each(B_FAMILY.map((name) => [name]))(
    '%s：換掉對手的位置、待走方向、分數、背包、偷竊倒數，每個 tick 的決定都一樣',
    (name) => {
      for (const base of bases) {
        const plain = asks(name, base, 0, 8);
        for (const v of vary(base)) {
          expect(asks(name, v, 0, 8)).toEqual(plain);
        }
      }
    },
  );

  it('(b) 的規則函式拿不到對手的視野：原始碼裡 ruleB 沒有對手的欄位', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    const ruleB = text.slice(text.indexOf('function ruleB'), text.indexOf('/** (c) 的規則'));
    expect(ruleB.length).toBeGreaterThan(200);
    expect(ruleB).not.toMatch(/OppView|oppOf|\.players\[|\bopp\b|\.lurk|\.bags\[/);
  });

  it('1 號邊也不讀（鏡像局面）', () => {
    const s = makeState({
      tick: 1300,
      coins: [cell(11, 12), cell(26, 5)],
      players: [{ cell: cell(10, 12) }, { cell: cell(28, 3), score: 1 }],
    });
    for (const name of B_FAMILY) {
      const plain = asks(name, s, 1, 8);
      const moved = {
        ...s,
        players: [{ cell: HOME, pending: 1, score: 5 }, s.players[1]],
        bags: [3, s.bags[1]],
        lurk: [40, 0],
      } as DJState;
      expect(asks(name, moved, 1, 8)).toEqual(plain);
    }
  });
});

describe('(c) 真的讀了對手（只換它讀的那一項，決定會變）', () => {
  const differs = (name: string, a: DJState, b: DJState, n = 6): boolean =>
    JSON.stringify(asks(name, a, 0, n)) !== JSON.stringify(asks(name, b, 0, n));
  /** 我在地圖中間、有存分數；對手離我的基地很遠 vs 很近。 */
  const mine = { cell: MID, score: 2 };
  const calm = at(MID, RIVAL, { players: [mine, { cell: RIVAL, score: 0 }] });
  const inbound = at(MID, cell(4, 20), { players: [mine, { cell: cell(4, 20), score: 0 }] });

  it.each(['c-g3', 'c-g2', 'c-g1'])(
    '%s：對手逼近我的基地（而且我有存分數）就回家守，對手很遠就照常撿金幣',
    (name) => {
      // 回家 ＝ 往左下（基地在 (0, 23)）；撿金幣 ＝ 往 (20, 12) 或 (5, 5)。
      const home = asks(name, inbound)[0] as Buttons;
      expect(home.left || home.down).toBe(true);
      expect(differs(name, calm, inbound)).toBe(true);
    },
  );

  it('守家的條件包括「我有存分數」：沒有存分數就不守（沒東西可偷）', () => {
    const broke = at(MID, cell(4, 20), {
      players: [{ cell: MID, score: 0 }, { cell: cell(4, 20) }],
    });
    const alone = at(MID, RIVAL, { players: [{ cell: MID, score: 0 }, { cell: RIVAL }] });
    expect(asks('c-g3', broke)).toEqual(asks('c-g3', alone));
  });

  it('c-lurk3：對手的偷竊倒數已經在跑（而且我有存分數）就回家', () => {
    const stealing = at(MID, cell(1, 22), {
      lurk: [0, 20],
      players: [mine, { cell: cell(1, 22) }],
    });
    const quiet = at(MID, cell(1, 22), { players: [mine, { cell: cell(1, 22) }] });
    expect(differs('c-lurk3', stealing, quiet)).toBe(true);
  });

  it.each(['c-raid1-read', 'c-raid-rep-read', 'c-raid-free'])(
    '%s：對手有存分數而且不在它的基地附近才去偷；對手沒分數或守在家就不去',
    (name) => {
      // 我在地圖中間、背包空的、時間夠；排程允許（tick 1600 在第二個窗口裡，也過了單次偷的最早時間）。
      const away = at(MID, cell(10, 12), {
        tick: 1600,
        players: [
          { cell: MID, score: 0 },
          { cell: cell(10, 12), score: 3 },
        ],
      });
      const broke = at(MID, cell(10, 12), {
        players: [
          { cell: MID, score: 0 },
          { cell: cell(10, 12), score: 0 },
        ],
      });
      const home = at(MID, cell(30, 1), {
        tick: 1600,
        players: [
          { cell: MID, score: 0 },
          { cell: cell(30, 1), score: 3 },
        ],
      });
      const raid = asks(name, away)[0] as Buttons;
      // 對手基地在右上：偷的路是往右或往上。
      expect(raid.right || raid.up).toBe(true);
      expect(differs(name, away, broke)).toBe(true);
      expect(differs(name, away, home)).toBe(true);
    },
  );

  it('c-turtle-roam：對手離我的基地很遠時敢走得更遠', () => {
    const far = at(cell(0, 12), RIVAL, {
      coins: [cell(0, 9)],
      players: [{ cell: cell(0, 12) }, { cell: RIVAL }],
    });
    const near = at(cell(0, 12), cell(3, 18), {
      coins: [cell(0, 9)],
      players: [{ cell: cell(0, 12) }, { cell: cell(3, 18) }],
    });
    expect(differs('c-turtle-roam', far, near)).toBe(true);
  });

  it('每個 (c) 成員至少有一個測試讀到它的輸入（上面的案例涵蓋整個族）', () => {
    const covered = [
      'c-g3',
      'c-g2',
      'c-g1',
      'c-lurk3',
      'c-raid1-read',
      'c-raid-rep-read',
      'c-raid-free',
      'c-turtle-roam',
    ];
    expect([...covered].sort()).toEqual([...C_FAMILY].sort());
  });
});

describe('成員的動作', () => {
  it('b-n3：背包 0 就去最近的金幣；背包 3 就回家；背包 2 還繼續撿', () => {
    const s = at(MID, RIVAL);
    expect(first('b-n3', s)).toBe('right');
    const full = at(MID, RIVAL, { bags: [3, 0] });
    const home = asks('b-n3', full)[0] as Buttons;
    expect(home.left || home.down).toBe(true);
    const two = at(MID, RIVAL, { bags: [2, 0] });
    expect(first('b-n3', two)).toBe('right');
  });

  it('b-n1：背包有 1 枚就回家；b-n2：2 枚才回家', () => {
    const one = at(MID, RIVAL, { bags: [1, 0] });
    const toHome = (name: string, s: DJState): boolean => {
      const b = asks(name, s)[0] as Buttons;
      return b.left || b.down;
    };
    expect(toHome('b-n1', one)).toBe(true);
    expect(toHome('b-n2', one)).toBe(false);
    expect(toHome('b-n2', at(MID, RIVAL, { bags: [2, 0] }))).toBe(true);
  });

  it('最後來不及存的時候：背包有東西就一律回家，沒有東西就不再去撿來不及存的金幣', () => {
    // MID 離基地 26 步：5 × 26 + 10 = 140 個 tick 才走得回去，剩 139 個 tick 就來不及再撿了。
    const late = at(MID, RIVAL, { tick: 3600 - 139, bags: [1, 0] });
    for (const name of ['b-n3', 'b-n2', 'b-turtle']) {
      const b = asks(name, late, 0, 1)[0] as Buttons;
      expect(b.left || b.down).toBe(true);
    }
  });

  it('站在金幣上的那一格不算目標（延遲時舊世界可能還有我剛撿的那一枚）', () => {
    const s = at(MID, RIVAL, { coins: [MID, cell(5, 5)] });
    expect(first('b-n3', s)).not.toBe('none');
    // 目標是 (5, 5)：左上。
    const b = asks('b-n3', s)[0] as Buttons;
    expect(b.left || b.up).toBe(true);
  });

  it('b-stay：永遠不動（站在基地也不動）', () => {
    for (const b of asks('b-stay', at(MID, RIVAL))) {
      expect(dirOf(b)).toBe('none');
    }
  });

  it('b-turtle：只撿離自己的基地 8 步以內的金幣；沒有就在基地附近等著', () => {
    const farCoin = at(cell(2, 22), RIVAL, { coins: [cell(20, 12)] });
    expect(first('b-turtle', farCoin)).toBe('none');
    const nearCoin = at(cell(2, 22), RIVAL, { coins: [cell(3, 18)] });
    expect(first('b-turtle', nearCoin)).not.toBe('none');
    // 離基地遠的時候先回基地附近。
    const away = at(cell(14, 12), RIVAL, { coins: [cell(20, 12)] });
    const b = asks('b-turtle', away)[0] as Buttons;
    expect(b.left || b.down).toBe(true);
  });

  it('b-raid1：tick 1200 之前不去偷；之後背包空的就往對手的基地走；到了就待著，待滿 130 個 tick 才離開', () => {
    const early = at(MID, RIVAL, { tick: 1000 });
    const b0 = asks('b-raid1', early, 0, 1)[0] as Buttons;
    expect(b0.right).toBe(true); // 照常撿金幣 (20, 12)
    const ctl = member('b-raid1');
    const late = at(cell(25, 6), RIVAL, { tick: 1300, coins: [cell(5, 5)] });
    const toward = ctl.decide(late, 0, 1300);
    expect(toward.right || toward.up).toBe(true);
    // 已經在對手基地旁邊：不動，一直待到 130 個 tick。
    const there = at(cell(30, 0), RIVAL, { tick: 1300, coins: [cell(5, 5)] });
    let waited = 0;
    for (let k = 0; k < 120; k += 1) {
      const b = ctl.decide({ ...there, tick: 1300 + k }, 0, 1300 + k);
      if (dirOf(b) === 'none') {
        waited += 1;
      }
    }
    expect(waited).toBeGreaterThanOrEqual(115);
    // 待滿之後離開（往左或往下，回去撿金幣）。
    let left = false;
    for (let k = 120; k < 160; k += 1) {
      const b = ctl.decide({ ...there, tick: 1300 + k }, 0, 1300 + k);
      if (b.left || b.down) {
        left = true;
      }
    }
    expect(left).toBe(true);
  });

  it('b-raid1 只偷一次（離開之後不再回去）', () => {
    const ctl = member('b-raid1');
    const there = at(cell(30, 0), RIVAL, { tick: 1300, coins: [cell(5, 5)] });
    for (let k = 0; k < 200; k += 1) {
      ctl.decide({ ...there, tick: 1300 + k }, 0, 1300 + k);
    }
    const later = at(cell(15, 12), RIVAL, { tick: 1600, coins: [cell(5, 5)] });
    const b = ctl.decide(later, 0, 1600);
    expect(b.left || b.up || b.down).toBe(true);
    expect(b.right).toBe(false);
  });

  it('b-guard：在守家窗口（tick % 600 < 100）而且自己有存分數就回家待著；窗口外照常撿', () => {
    const inWindow = at(MID, RIVAL, {
      tick: 1210,
      players: [{ cell: MID, score: 2 }, { cell: RIVAL }],
    });
    const outside = at(MID, RIVAL, {
      tick: 1350,
      players: [{ cell: MID, score: 2 }, { cell: RIVAL }],
    });
    const goHome = asks('b-guard', inWindow, 0, 1)[0] as Buttons;
    expect(goHome.left || goHome.down).toBe(true);
    expect(first('b-guard', outside)).toBe('right');
    // 沒有存分數就不守。
    const broke = at(MID, RIVAL, { tick: 1210 });
    expect(first('b-guard', broke)).toBe('right');
  });

  it('1 號邊的基地在右上：b-n3 背包滿了往右上走', () => {
    const s = makeState({
      tick: 1300,
      coins: [cell(5, 5)],
      bags: [0, 3],
      players: [{ cell: cell(0, 23) }, { cell: MID }],
    });
    const b = asks('b-n3', s, 1)[0] as Buttons;
    expect(b.right || b.up).toBe(true);
  });
});

describe('反應延遲', () => {
  it('delay ＝ 0 就是原本的控制器（同一個物件）', () => {
    const inner = member('b-n3');
    expect(withDelay(inner, 0, dJGame)).toBe(inner);
  });

  it('世界是 delay 個 tick 前的（對手的位置），自己的位置、背包是現在的（重播自己的按鍵）', () => {
    const seen: DJState[] = [];
    const right: Buttons = { ...NONE, right: true };
    const left: Buttons = { ...NONE, left: true };
    const recorder: Controller<DJState> = {
      decide(state) {
        seen.push(state);
        return right;
      },
    };
    const delayed = withDelay(recorder, 12, dJGame);
    const result = playMatch(dJGame, 3, { ...CONFIG, maxTicks: 60 }, delayed, {
      decide: () => left,
    });
    expect(result.ticks).toBe(60);
    let state = dJGame.init(3, { ...CONFIG, maxTicks: 60 });
    const truth: DJState[] = [state];
    for (let t = 0; t < 59; t += 1) {
      state = dJGame.step(state, [right, left]);
      truth.push(state);
    }
    for (const t of [12, 30, 45, 59]) {
      const view = seen[t] as DJState;
      expect(view.tick).toBe(t);
      expect(view.players[0].cell).toBe((truth[t] as DJState).players[0].cell);
      expect(view.bags[0]).toBe((truth[t] as DJState).bags[0]);
      const old = truth[t - 12] as DJState;
      expect(view.players[1].cell).toBe(nextCell(old.walls, old.players[1]));
    }
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
  it('isPoint：走格週期的第一個 tick，而且至少一邊已經存了分數（偷與守才有東西可談）', () => {
    const none = makeState({ tick: 10 });
    expect(isPoint(none, 0, 10)).toBe(false);
    const scored = makeState({ tick: 10, players: [{ score: 1 }, {}] });
    expect(isPoint(scored, 0, 10)).toBe(true);
    expect(isPoint({ ...scored, tick: 11 }, 0, 11)).toBe(false);
    const theirs = makeState({ tick: 15, players: [{}, { score: 2 }] });
    expect(isPoint(theirs, 0, 15)).toBe(true);
  });

  it('(c) 的原始碼沒有 import evaluate、predictOpponent、opponentAction，也沒有拿 AI 的控制器當成員', () => {
    const text = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(
      /\bevaluate\b|predictOpponent|opponentAction|policies\/shared|humanModel|human-model|wrapPolicy|\.actions\(/,
    );
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
    const r = compareBC(spec('b-n3', 'c-g3', seeds, at12));
    expect(r.n).toBe(2);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
    const alone = seeds.map((seed) => playWith(seed, member('b-n3'), at12));
    expect(r.win.b).toBe(alone.reduce((a, o) => a + o.win, 0) / seeds.length);
    expect(r.margin.b.mean).toBe(alone.reduce((a, o) => a + o.margin, 0) / seeds.length);
    expect(r.divergence.pointBasis).toBe('isPoint');
  }, 120_000);

  it('score 與 playWith 一致；b-stay（站著不走）比 b-n3 差（等級 5、沒有延遲，4 場）', () => {
    const seeds = [3, 4, 5, 6];
    const easy = { policy: 'greedy', level: 5, delay: 0 } as const;
    const good = score('b-n3', seeds, easy);
    const bad = score('b-stay', seeds, easy);
    expect(good.win).toBeGreaterThan(bad.win);
    expect(good.margin).toBeGreaterThan(bad.margin);
    const direct = seeds.map((s) => playWith(s, member('b-n3'), easy));
    expect(good.win).toBe(direct.reduce((a, o) => a + o.win, 0) / seeds.length);
  }, 120_000);
});
