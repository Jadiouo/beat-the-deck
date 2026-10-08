import { describe, expect, it } from 'vitest';

import { wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import type { Buttons, Game, Inputs, Side } from '../../core/types';
import { AI_WAIT_TICKS, DECISION_TIMEOUT, IDLE, PRESS_A, PRESS_B } from '../_hearts/logic';
import {
  BANK,
  cellIndex,
  COLS,
  confidenceLevel,
  DEFAULT_MINES,
  h6Game,
  leadRate,
  LOCK_TICKS,
  makeState,
  minesInRow,
  moveValue,
  RESULT_TICKS,
  reflexMove,
  rewardOf,
  ROUNDS,
  ROWS,
  safeProb,
  WAIT,
  WINDOW,
} from './logic';
import type { Act, H6State, Move } from './logic';

/**
 * H-6 地雷區的規則測試（規則見 `docs/cards/H-6.md`）。
 * 動作編碼：0 到 3 是欄（← ↑ → ↓），BANK = 4 存分（a），WAIT = 5 等（b）。
 * 全部用 `makeState` 直接構造局面（雷圖預設是 `DEFAULT_MINES`），不靠跑很多 tick 碰運氣。
 * 關鍵的幾組：規則（先到全額、後到一半、等待流失、已公開的格子沒有風險）、不偷看（`mines`、對手的 `pending`、`last`，
 * 含「加同一個常數」那型，同時測 decide、evaluate、actions）、等級曲線（深度 ≤ 2 只有反射、深度 ≥ 3 讀對手的領頭比例）、
 * 10.6 的兩個 pending 陷阱。
 */

const CONFIG = { maxTicks: 3600, params: {} };

const KEY: readonly Buttons[] = [
  { ...IDLE, left: true },
  { ...IDLE, up: true },
  { ...IDLE, right: true },
  { ...IDLE, down: true },
  PRESS_A,
  PRESS_B,
];

function key(move: Move): Buttons {
  return KEY[move] as Buttons;
}

function idle(): Inputs {
  return [IDLE, IDLE];
}

function both(m0: Move, m1: Move): Inputs {
  return [key(m0), key(m1)];
}

function stepN(state: H6State, n: number, inputs: Inputs = idle()): H6State {
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = h6Game.step(s, inputs);
  }
  return s;
}

function choosing(overrides: Partial<H6State> = {}): H6State {
  return makeState({ phase: 'choose', wait: 0, ...overrides });
}

/** 從 choose 開始，兩邊都按，走完鎖定到公開（resolve 階段）。 */
function toResolve(state: H6State, m0: Move, m1: Move): H6State {
  return stepN(h6Game.step(state, both(m0, m1)), LOCK_TICKS);
}

/** 走完整個一回合：兩邊都按、公開、30 tick 後入帳。 */
function playRound(state: H6State, m0: Move, m1: Move): H6State {
  return stepN(toResolve(state, m0, m1), RESULT_TICKS);
}

function sameButtons(x: Buttons, y: Buttons): boolean {
  return (
    x.up === y.up &&
    x.down === y.down &&
    x.left === y.left &&
    x.right === y.right &&
    x.a === y.a &&
    x.b === y.b
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key2 of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key2]);
    }
  }
  return value;
}

/** 把「已公開」的格子寫進 known：[排, 欄, 1 安全或 2 雷]。 */
function withKnown(triples: readonly (readonly [number, number, 1 | 2])[]): number[] {
  const known = new Array<number>(ROWS * COLS).fill(0);
  for (const [r, c, v] of triples) {
    known[cellIndex(r, c)] = v;
  }
  return known;
}

/** 歷史：對手（`who`）最近每回合的動作；另一邊一律等。 */
function histOf(who: Side, acts: readonly Act[]): H6State['history'] {
  return acts.map((a) => (who === 0 ? [a, 'wait'] : ['wait', a]) as readonly [Act, Act]);
}

// ---------------------------------------------------------------------------

describe('H-6 地雷區｜初始與常數', () => {
  it('常數：4 欄 × 6 排、12 回合、鎖定 2 tick、公開後停 30 tick、歷史窗口 4 回合', () => {
    expect(COLS).toBe(4);
    expect(ROWS).toBe(6);
    expect(ROUNDS).toBe(12);
    expect(LOCK_TICKS).toBe(2);
    expect(RESULT_TICKS).toBe(30);
    expect(WINDOW).toBe(4);
  });

  it('雷數與獎勵都是公式：第 r 排有 ceil(r / 2) 顆雷（1、1、2、2、3、3）、獎勵 r；後到的拿 ceil(r / 2)', () => {
    expect([1, 2, 3, 4, 5, 6].map(minesInRow)).toEqual([1, 1, 2, 2, 3, 3]);
    expect([1, 2, 3, 4, 5, 6].map((r) => rewardOf(r, false))).toEqual([1, 2, 3, 4, 5, 6]);
    expect([1, 2, 3, 4, 5, 6].map((r) => rewardOf(r, true))).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('初始：第 0 回合、準備階段（等 45 tick）、比分 0:0、兩邊都在起點、什麼都沒公開', () => {
    const s = h6Game.init(5, CONFIG);
    expect(s.round).toBe(0);
    expect(s.phase).toBe('prep');
    expect(s.wait).toBe(AI_WAIT_TICKS);
    expect(s.totals).toEqual([0, 0]);
    expect(s.row).toEqual([0, 0]);
    expect(s.carry).toEqual([0, 0]);
    expect(s.pending).toEqual([null, null]);
    expect(s.known).toEqual(new Array(24).fill(0));
    expect(s.claimed).toEqual(new Array(6).fill([false, false]));
    expect(s.history).toEqual([]);
    expect(s.last).toBeNull();
    expect(s.over).toBe(false);
    expect(h6Game.winner(s)).toBeNull();
  });

  it('雷圖：每一排的雷數剛好是 ceil(r / 2)（共 12 顆）、只有 0 與 1；同一個種子同一張圖、不同種子（多數）不同', () => {
    const maps = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => h6Game.init(seed, CONFIG).mines);
    for (const mines of maps) {
      expect(mines).toHaveLength(24);
      for (let r = 1; r <= ROWS; r += 1) {
        const row = mines.slice((r - 1) * COLS, r * COLS);
        expect(row.every((v) => v === 0 || v === 1)).toBe(true);
        expect(row.reduce((a, b) => a + b, 0)).toBe(minesInRow(r));
      }
    }
    expect(h6Game.init(5, CONFIG).mines).toEqual(h6Game.init(5, CONFIG).mines);
    expect(new Set(maps.map((m) => m.join(''))).size).toBeGreaterThan(4);
  });

  it('預設雷圖 DEFAULT_MINES 自己也符合每排雷數', () => {
    for (let r = 1; r <= ROWS; r += 1) {
      const row = DEFAULT_MINES.slice((r - 1) * COLS, r * COLS);
      expect(row.reduce((a, b) => a + b, 0)).toBe(minesInRow(r));
    }
  });

  it('config.params：half = 0 關掉「後到拿一半」、decay 改變等待流失、model = 0 關掉讀對手的模型', () => {
    expect(h6Game.init(1, CONFIG).half).toBe(true);
    expect(h6Game.init(1, CONFIG).decay).toBe(1);
    expect(h6Game.init(1, CONFIG).model).toBe(true);
    const off = h6Game.init(1, { maxTicks: 3600, params: { half: 0, decay: 0, model: 0 } });
    expect(off.half).toBe(false);
    expect(off.decay).toBe(0);
    expect(off.model).toBe(false);
    expect(h6Game.init(1, { maxTicks: 3600, params: { decay: 2 } }).decay).toBe(2);
  });
});

describe('H-6 地雷區｜規則', () => {
  it('1. 準備 45 tick：這段時間輸入被忽略（第 45 個 tick 按無效，第 46 個 tick 才算）', () => {
    let s = makeState();
    s = stepN(s, AI_WAIT_TICKS - 1, both(1, 1));
    expect(s.phase).toBe('prep');
    s = h6Game.step(s, both(1, 1));
    expect(s.phase).toBe('choose');
    expect(s.pending).toEqual([null, null]);
    s = h6Game.step(s, both(1, 5));
    expect(s.pending).toEqual([1, 5]);
  });

  it('2. 只有一邊按：還在 choose，等另一邊；兩邊都按了才鎖定 2 tick，這段時間輸入被忽略', () => {
    const one = h6Game.step(choosing(), [key(1), IDLE]);
    expect(one.phase).toBe('choose');
    expect(one.pending).toEqual([1, null]);
    const two = h6Game.step(one, [IDLE, key(WAIT)]);
    expect(two.phase).toBe('locked');
    expect(two.wait).toBe(LOCK_TICKS);
    const locked = h6Game.step(two, both(2, 2));
    expect(locked.pending).toEqual([1, WAIT]);
  });

  it('3. 選了就不能改：之後再按別的鍵沒有用', () => {
    const s = h6Game.step(choosing(), [key(1), IDLE]);
    const s2 = h6Game.step(s, [key(WAIT), IDLE]);
    expect(s2.pending[0]).toBe(1);
  });

  it('4. 同時按多個鍵：b（等）優先，其次 a（存分），再來才是方向（左、上、右、下）', () => {
    const base = choosing({ carry: [3, 3] });
    const bAndA = h6Game.step(base, [{ ...IDLE, a: true, b: true }, IDLE]);
    expect(bAndA.pending[0]).toBe(WAIT);
    const aAndLeft = h6Game.step(base, [{ ...IDLE, a: true, left: true }, IDLE]);
    expect(aAndLeft.pending[0]).toBe(BANK);
    const upAndDown = h6Game.step(base, [{ ...IDLE, up: true, down: true }, IDLE]);
    expect(upAndDown.pending[0]).toBe(1);
  });

  it('5. 沒東西可存時按 a 沒有用（不算選擇）；踏上已公開的雷也沒有用；在最上排按方向也沒有用', () => {
    const noCarry = h6Game.step(choosing(), [PRESS_A, IDLE]);
    expect(noCarry.pending[0]).toBeNull();
    const knownMine = choosing({ known: withKnown([[1, 0, 2]]) });
    expect(h6Game.step(knownMine, [key(0), IDLE]).pending[0]).toBeNull();
    expect(h6Game.step(knownMine, [key(1), IDLE]).pending[0]).toBe(1);
    const top = choosing({ row: [6, 0], carry: [4, 0] });
    expect(h6Game.step(top, [key(1), IDLE]).pending[0]).toBeNull();
    expect(h6Game.step(top, [PRESS_A, IDLE]).pending[0]).toBe(BANK);
  });

  it('6. 鎖定中不入帳：known、row、carry 都不動；第 3 步公開（resolve），入帳要再等 30 tick', () => {
    const s0 = choosing();
    const locked = h6Game.step(s0, both(1, 3));
    const mid = h6Game.step(locked, idle());
    expect(mid.phase).toBe('locked');
    expect(mid.known).toEqual(s0.known);
    const resolved = h6Game.step(mid, idle());
    expect(resolved.phase).toBe('resolve');
    expect(resolved.wait).toBe(RESULT_TICKS);
    expect(resolved.known).toEqual(s0.known);
    expect(resolved.row).toEqual([0, 0]);
    expect(resolved.last).not.toBeNull();
    const nearly = stepN(resolved, RESULT_TICKS - 1);
    expect(nearly.phase).toBe('resolve');
    expect(nearly.row).toEqual([0, 0]);
    const done = h6Game.step(nearly, idle());
    expect(done.phase).toBe('prep');
    expect(done.row).toEqual([1, 1]);
  });

  it('7. 踏上安全格：前進一排，這排的獎勵（r 分）進手上的分，那格公開，這排記為我先到', () => {
    const s = playRound(choosing(), 1, WAIT);
    expect(s.row).toEqual([1, 0]);
    expect(s.carry).toEqual([1, 0]);
    expect(s.known[cellIndex(1, 1)]).toBe(1);
    expect(s.claimed[0]).toEqual([true, false]);
    expect(s.totals).toEqual([0, 0]);
  });

  it('8. 踩到雷：手上的分丟掉、回到起點，那格公開成雷；這排沒有人先到', () => {
    const s = playRound(choosing({ row: [3, 0], carry: [5, 0] }), 0, WAIT);
    // 第 4 排預設雷在欄 1、2；欄 0 安全。改踩欄 1。
    const boom = playRound(choosing({ row: [3, 0], carry: [5, 0] }), 1, WAIT);
    expect(boom.row).toEqual([0, 0]);
    expect(boom.carry).toEqual([0, 0]);
    expect(boom.totals).toEqual([0, 0]);
    expect(boom.known[cellIndex(4, 1)]).toBe(2);
    expect(boom.claimed[3]).toEqual([false, false]);
    expect(s.row[0]).toBe(4);
  });

  it('9. 先到拿全額、後到拿一半（向上取整）：第 3 排先到 3、後到 2；第 1 排後到仍是 1；第 5 排後到 3', () => {
    // 對手已經先到過第 3 排：我後到
    const claimed3 = new Array(6).fill(null).map((_v, i) => (i === 2 ? [false, true] : [false, false]));
    const late = playRound(
      choosing({ row: [2, 2], carry: [0, 0], claimed: claimed3 as H6State['claimed'] }),
      1,
      WAIT,
    );
    expect(late.carry[0]).toBe(2);
    // 沒有人先到過：全額
    const first = playRound(choosing({ row: [2, 2] }), 1, WAIT);
    expect(first.carry[0]).toBe(3);
    // 第 1 排：ceil(1/2) = 1
    const claimed1 = new Array(6).fill(null).map((_v, i) => (i === 0 ? [false, true] : [false, false]));
    expect(
      playRound(choosing({ claimed: claimed1 as H6State['claimed'] }), 1, WAIT).carry[0],
    ).toBe(1);
    // 第 5 排：ceil(5/2) = 3
    const claimed5 = new Array(6).fill(null).map((_v, i) => (i === 4 ? [false, true] : [false, false]));
    expect(
      playRound(
        choosing({ row: [4, 4], claimed: claimed5 as H6State['claimed'] }),
        3,
        WAIT,
      ).carry[0],
    ).toBe(3);
  });

  it('10. 同一回合同時踏上同一排的兩個人都拿全額（先到看的是回合開始時誰已經到過）', () => {
    const s = playRound(choosing({ row: [2, 2] }), 1, 2);
    expect(s.carry).toEqual([3, 3]);
    expect(s.claimed[2]).toEqual([true, true]);
  });

  it('11. 已公開的安全格踏上去沒有風險，而且是跟隨：同一格有人先到過，所以拿一半', () => {
    const s0 = choosing({
      known: withKnown([[1, 1, 1]]),
      claimed: new Array(6)
        .fill(null)
        .map((_v, i) => (i === 0 ? [false, true] : [false, false])) as H6State['claimed'],
    });
    const s = playRound(s0, 1, WAIT);
    expect(s.row[0]).toBe(1);
    expect(s.carry[0]).toBe(1);
    // 第 2 排的跟隨拿 ceil(2/2) = 1
    const s2 = playRound(
      choosing({
        row: [1, 1],
        known: withKnown([[2, 0, 1]]),
        claimed: new Array(6)
          .fill(null)
          .map((_v, i) => (i === 1 ? [false, true] : [false, false])) as H6State['claimed'],
      }),
      0,
      WAIT,
    );
    expect(s2.carry[0]).toBe(1);
  });

  it('12. 存分：手上的分進總分、手上歸零，不縮水；存分的回合沒有流失', () => {
    const s = playRound(choosing({ carry: [4, 0], row: [2, 0] }), BANK, WAIT);
    expect(s.totals[0]).toBe(4);
    expect(s.carry[0]).toBe(0);
    expect(s.row[0]).toBe(2);
  });

  it('13. 壓力：等的回合手上的分少 1（最少 0）；被擋在最上排只能存或等', () => {
    const s = playRound(choosing({ carry: [3, 1] }), WAIT, WAIT);
    expect(s.carry).toEqual([2, 0]);
    const zero = playRound(choosing({ carry: [0, 0] }), WAIT, WAIT);
    expect(zero.carry).toEqual([0, 0]);
    const top = playRound(choosing({ row: [6, 6], carry: [5, 5] }), WAIT, BANK);
    expect(top.carry).toEqual([4, 0]);
    expect(top.totals).toEqual([0, 5]);
  });

  it('14. 超時：choose 的第 300 個 tick 還沒按，自動等；第 300 個 tick 按了算按了', () => {
    let s = choosing();
    s = stepN(s, DECISION_TIMEOUT - 1);
    expect(s.pending).toEqual([null, null]);
    expect(h6Game.step(s, idle()).pending).toEqual([WAIT, WAIT]);
    const late = h6Game.step(s, [key(1), IDLE]);
    expect(late.pending[0]).toBe(1);
  });

  it('15. history 記每回合兩邊的動作類型：領頭（踏上沒公開的格）、跟隨（踏上已公開的安全格）、等、存分', () => {
    const s0 = choosing({
      carry: [0, 2],
      known: withKnown([[1, 1, 1]]),
    });
    const s = playRound(s0, 1, BANK);
    expect(s.history).toEqual([['follow', 'bank']]);
    const s1 = playRound(choosing(), 1, WAIT);
    expect(s1.history).toEqual([['lead', 'wait']]);
  });

  it('16. 12 回合後只算總分：手上沒存的作廢；高的贏、一樣多平手；結束之後 step 原樣回傳', () => {
    const near = makeState({
      round: ROUNDS - 1,
      phase: 'choose',
      wait: 0,
      carry: [9, 0],
      totals: [2, 3],
    });
    const end = playRound(near, WAIT, WAIT);
    expect(end.over).toBe(true);
    expect(end.totals).toEqual([2, 3]);
    expect(h6Game.isOver(end)).toBe(true);
    expect(h6Game.winner(end)).toBe(1);
    expect(h6Game.score(end)).toEqual([2, 3]);
    expect(h6Game.step(end, both(1, 1))).toBe(end);
    const tie = playRound({ ...near, totals: [3, 3] }, WAIT, WAIT);
    expect(tie.over).toBe(true);
    expect(h6Game.winner(tie)).toBeNull();
    // 最後一回合存分算數
    const banked = playRound({ ...near, totals: [2, 3], carry: [4, 0] }, BANK, WAIT);
    expect(banked.totals).toEqual([6, 3]);
    expect(h6Game.winner(banked)).toBe(0);
  });

  it('17. 結束前 winner 是 null；一回合一回合走，round 加一', () => {
    const s = playRound(choosing(), WAIT, WAIT);
    expect(s.round).toBe(1);
    expect(h6Game.winner(s)).toBeNull();
    expect(s.phase).toBe('prep');
    expect(s.pending).toEqual([null, null]);
    expect(s.wait).toBe(AI_WAIT_TICKS);
  });

  it('18.（邊界）時間到：已經公開的回合先入帳；還在 choose 或 locked 的這回合不算', () => {
    const resolving = toResolve(
      choosing({ maxTicks: 40, tick: 36, carry: [3, 0], row: [1, 0] }),
      BANK,
      WAIT,
    );
    expect(resolving.phase).toBe('resolve');
    const end = stepN(resolving, 5);
    expect(end.over).toBe(true);
    expect(end.totals[0]).toBe(3);
    const mid = stepN(choosing({ maxTicks: 10, tick: 5, carry: [3, 0] }), 20, [PRESS_A, PRESS_A]);
    expect(mid.over).toBe(true);
    expect(mid.totals).toEqual([0, 0]);
  });

  it('19. 沒有人按任何鍵：每個決定等 300 tick，用不完 12 回合也會在 3600 tick 內結束', () => {
    let s = h6Game.init(1, CONFIG);
    for (let i = 0; i < 3600 && !s.over; i += 1) {
      s = h6Game.step(s, idle());
    }
    expect(s.over).toBe(true);
  });

  it('20. step 不改動傳進來的 state 與輸入（深度凍結也不丟錯），各階段都一樣', () => {
    const states: H6State[] = [
      makeState(),
      choosing({ carry: [3, 2], row: [2, 1] }),
      h6Game.step(choosing(), both(1, 3)),
      toResolve(choosing(), 1, 3),
      stepN(toResolve(choosing(), 1, 3), RESULT_TICKS - 1),
    ];
    for (const s of states) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(s)) as H6State);
      const inputs = deepFreeze<Inputs>([key(1), key(WAIT)]);
      expect(() => h6Game.step(frozen, inputs)).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(JSON.stringify(s));
    }
  });

  it('21. 整場 JSON 來回不變；總分只會因為存分增加；手上的分不會是負的', () => {
    let s = h6Game.init(9, CONFIG);
    for (let i = 0; i < 3600 && !s.over; i += 1) {
      const move = (i * 7 + (i >> 4)) % 6;
      s = h6Game.step(s, [key(move as Move), key(((move + 2) % 6) as Move)]);
      expect(s.carry[0]).toBeGreaterThanOrEqual(0);
      expect(s.carry[1]).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    }
    expect(s.over).toBe(true);
  });

  it('22. 消融旗標：half = false 時後到的也拿全額；decay = 0 時等不縮水', () => {
    const claimed3 = new Array(6)
      .fill(null)
      .map((_v, i) => (i === 2 ? [false, true] : [false, false])) as H6State['claimed'];
    const noHalf = playRound(
      choosing({ row: [2, 2], claimed: claimed3, half: false }),
      1,
      WAIT,
    );
    expect(noHalf.carry[0]).toBe(3);
    const noDecay = playRound(choosing({ carry: [3, 3], decay: 0 }), WAIT, WAIT);
    expect(noDecay.carry).toEqual([3, 3]);
    const heavy = playRound(choosing({ carry: [3, 3], decay: 2 }), WAIT, WAIT);
    expect(heavy.carry).toEqual([1, 1]);
  });

  it('23. 兩邊對稱：把兩邊對調再走一回合，結果也是對調', () => {
    const a = choosing({ row: [1, 2], carry: [2, 5], totals: [1, 0] });
    const b = choosing({ row: [2, 1], carry: [5, 2], totals: [0, 1] });
    const ra = playRound(a, 1, WAIT);
    const rb = playRound(b, WAIT, 1);
    expect(ra.row).toEqual([rb.row[1], rb.row[0]]);
    expect(ra.carry).toEqual([rb.carry[1], rb.carry[0]]);
    expect(ra.totals).toEqual([rb.totals[1], rb.totals[0]]);
  });
});

describe('H-6 地雷區｜safeProb 與 leadRate（AI 只用公開資訊）', () => {
  it('沒有公開任何格子：該排每格的安全率是 1 − 雷數 / 4', () => {
    const s = makeState();
    expect(safeProb(s, 1, 0)).toBeCloseTo(0.75, 10);
    expect(safeProb(s, 3, 2)).toBeCloseTo(0.5, 10);
    expect(safeProb(s, 6, 1)).toBeCloseTo(0.25, 10);
  });

  it('已知安全是 1、已知雷是 0；同一排公開一顆雷之後，其餘格子的雷率是 (雷數 − 已公開的雷) / 還沒公開的格數', () => {
    const s = makeState({ known: withKnown([[3, 0, 2], [3, 1, 1]]) });
    expect(safeProb(s, 3, 1)).toBe(1);
    expect(safeProb(s, 3, 0)).toBe(0);
    // 第 3 排兩顆雷，公開了一顆雷與一格安全：剩 2 格沒公開、1 顆雷 → 安全率 1/2
    expect(safeProb(s, 3, 2)).toBeCloseTo(0.5, 10);
    expect(safeProb(s, 3, 3)).toBeCloseTo(0.5, 10);
  });

  it('雷都找出來了：剩下沒公開的格子一定安全；沒公開的格數等於剩下的雷數：一定是雷', () => {
    const allFound = makeState({ known: withKnown([[1, 0, 2]]) });
    expect(safeProb(allFound, 1, 2)).toBe(1);
    const forced = makeState({ known: withKnown([[5, 3, 1]]) });
    expect(safeProb(forced, 5, 0)).toBe(0);
    expect(safeProb(forced, 5, 1)).toBe(0);
    expect(safeProb(forced, 5, 2)).toBe(0);
  });

  it('safeProb 不讀 mines：只有 mines 不同的兩個 state 回傳一樣', () => {
    const other = DEFAULT_MINES.slice();
    other[cellIndex(2, 1)] = 0;
    other[cellIndex(2, 2)] = 1;
    const a = makeState({ mines: DEFAULT_MINES });
    const b = makeState({ mines: other });
    for (let r = 1; r <= ROWS; r += 1) {
      for (let c = 0; c < COLS; c += 1) {
        expect(safeProb(a, r, c)).toBe(safeProb(b, r, c));
      }
    }
  });

  it('leadRate = (領頭 + 1) / (回合 + 3)，只看最近 4 回合；沒有歷史是 1/3', () => {
    expect(leadRate(makeState(), 0)).toBeCloseTo(1 / 3, 10);
    expect(leadRate(makeState({ history: histOf(0, ['lead', 'lead']) }), 0)).toBeCloseTo(3 / 5, 10);
    expect(leadRate(makeState({ history: histOf(0, ['wait', 'wait', 'wait']) }), 0)).toBeCloseTo(
      1 / 6,
      10,
    );
    // 窗口 4：更早的領頭被擠掉
    const long = histOf(0, ['lead', 'lead', 'lead', 'wait', 'wait', 'wait', 'wait']);
    expect(leadRate(makeState({ history: long }), 0)).toBeCloseTo(1 / 7, 10);
    // 看的是指定那一邊
    const mixed = histOf(0, ['lead', 'lead']);
    expect(leadRate(makeState({ history: mixed }), 1)).toBeCloseTo(1 / 5, 10);
  });

  it('模型關掉（消融）：leadRate 永遠是先驗 1/3，不管歷史', () => {
    expect(
      leadRate(makeState({ model: false, history: histOf(0, ['lead', 'lead', 'lead']) }), 0),
    ).toBeCloseTo(1 / 3, 10);
  });

  it('confidenceLevel：看對手歷史有幾回合，0 到 3 格；模型關掉是 0', () => {
    expect(confidenceLevel(makeState(), 1)).toBe(0);
    expect(confidenceLevel(makeState({ history: histOf(0, ['lead']) }), 1)).toBe(1);
    expect(confidenceLevel(makeState({ history: histOf(0, ['lead', 'wait']) }), 1)).toBe(2);
    expect(
      confidenceLevel(makeState({ history: histOf(0, ['lead', 'wait', 'wait', 'lead', 'lead']) }), 1),
    ).toBe(3);
    expect(confidenceLevel(makeState({ model: false, history: histOf(0, ['lead']) }), 1)).toBe(0);
  });
});

describe('H-6 地雷區｜actions 與 evaluate', () => {
  it('actions：choose、我還沒按 → [等, 合法的方向…, 存分]（等排第一，沒東西可存時沒有存分）', () => {
    const s = choosing({ carry: [0, 3] });
    const mine = h6Game.actions(s, 0);
    expect(mine).toHaveLength(1 + COLS);
    expect(sameButtons(mine[0] as Buttons, PRESS_B)).toBe(true);
    expect(mine.some((b) => sameButtons(b, PRESS_A))).toBe(false);
    const theirs = h6Game.actions(s, 1);
    expect(theirs).toHaveLength(2 + COLS);
    expect(sameButtons(theirs[theirs.length - 1] as Buttons, PRESS_A)).toBe(true);
  });

  it('actions：已公開的雷、最上排的方向不在清單裡；其他狀態只有 [全放開]', () => {
    const s = choosing({ known: withKnown([[1, 0, 2]]) });
    expect(h6Game.actions(s, 0).some((b) => b.left)).toBe(false);
    expect(h6Game.actions(s, 0).some((b) => b.up)).toBe(true);
    const top = choosing({ row: [6, 0], carry: [2, 0] });
    expect(h6Game.actions(top, 0).some((b) => b.up || b.down || b.left || b.right)).toBe(false);
    expect(h6Game.actions(top, 0)).toHaveLength(2);
    for (const other of [
      makeState(),
      h6Game.step(choosing(), [key(1), IDLE]),
      toResolve(choosing(), 1, 1),
    ]) {
      expect(h6Game.actions(other, 0)).toHaveLength(
        other.phase === 'choose' && other.pending[0] === null ? 5 : 1,
      );
    }
    const pressed = h6Game.step(choosing(), [key(1), IDLE]);
    expect(h6Game.actions(pressed, 0)).toEqual([IDLE]);
  });

  it('evaluate：每個階段 gain 有限、danger 是 0；結束的局有勝負加成', () => {
    const states = [
      makeState(),
      choosing({ carry: [3, 1], row: [2, 3], totals: [4, 2] }),
      h6Game.step(choosing(), both(1, WAIT)),
      toResolve(choosing(), 1, WAIT),
      toResolve(choosing({ carry: [4, 0] }), BANK, WAIT),
    ];
    for (const s of states) {
      for (const side of [0, 1] as const) {
        const e = h6Game.evaluate(s, side);
        expect(Number.isFinite(e.gain)).toBe(true);
        expect(e.danger).toBe(0);
      }
    }
    const won = playRound(
      makeState({ round: ROUNDS - 1, phase: 'choose', wait: 0, totals: [3, 0] }),
      WAIT,
      WAIT,
    );
    expect(h6Game.evaluate(won, 0).gain).toBeGreaterThan(500);
    expect(h6Game.evaluate(won, 1).gain).toBeLessThan(-500);
  });

  it('evaluate：locked 階段只有分差、手上的分與反射規則的小加分（我選的和反射一樣才加）', () => {
    const base = choosing({ carry: [3, 0], row: [1, 0] });
    const reflex = reflexMove(base, 0);
    const other = ([0, 1, 2, 3, BANK, WAIT] as Move[]).find((m) => m !== reflex) as Move;
    const a = h6Game.step(base, [key(reflex), key(WAIT)]);
    const b = h6Game.step(base, [key(other), key(WAIT)]);
    expect(a.phase).toBe('locked');
    const ga = h6Game.evaluate(a, 0).gain;
    const gb = h6Game.evaluate(b, 0).gain;
    expect(ga).toBeGreaterThan(gb);
    expect(ga - gb).toBeLessThan(0.1);
  });

  it('reflexMove：手上的分 ≥ 5 就存；否則往安全率最高的格走（同分取最左）；最上排只能存或等', () => {
    expect(reflexMove(choosing({ carry: [5, 0] }), 0)).toBe(BANK);
    expect(reflexMove(choosing({ carry: [9, 0], row: [2, 0] }), 0)).toBe(BANK);
    expect(reflexMove(choosing(), 0)).toBe(0);
    // 欄 2 已公開安全：安全率 1，最高
    expect(reflexMove(choosing({ known: withKnown([[1, 2, 1]]) }), 0)).toBe(2);
    // 欄 0 是已公開的雷：略過
    expect(reflexMove(choosing({ known: withKnown([[1, 0, 2]]) }), 0)).toBe(1);
    expect(reflexMove(choosing({ row: [6, 0], carry: [2, 0] }), 0)).toBe(BANK);
    expect(reflexMove(choosing({ row: [6, 0], carry: [0, 0] }), 0)).toBe(WAIT);
  });

  it('moveValue（公開之後）：手上的分很多、前面是高雷率的排 → 存分比往前踏好；一無所有 → 往前踏比等好', () => {
    const rich = choosing({ row: [4, 4], carry: [8, 0] });
    expect(moveValue(rich, 0, BANK)).toBeGreaterThan(moveValue(rich, 0, 0));
    expect(moveValue(rich, 0, BANK)).toBeGreaterThan(moveValue(rich, 0, WAIT));
    const poor = choosing();
    expect(moveValue(poor, 0, 1)).toBeGreaterThan(moveValue(poor, 0, WAIT));
  });

  it('moveValue：同一排，已公開的安全格比沒公開的格好（沒有風險），已公開的雷不在選項裡', () => {
    const s = choosing({
      row: [2, 3],
      carry: [2, 0],
      known: withKnown([[3, 1, 1]]),
      claimed: new Array(6)
        .fill(null)
        .map((_v, i) => (i === 2 ? [false, true] : [false, false])) as H6State['claimed'],
    });
    expect(moveValue(s, 0, 1)).toBeGreaterThan(moveValue(s, 0, 0));
  });

  it('moveValue：對手同一排、常領頭 → 等比較值得（會有人替我踩出路）；對手不在同一排時歷史沒有差', () => {
    const leads = histOf(1, ['lead', 'lead', 'lead', 'lead']);
    const waits = histOf(1, ['wait', 'wait', 'wait', 'wait']);
    const sameRow = (history: H6State['history']): H6State =>
      choosing({ row: [2, 2], carry: [3, 3], history });
    expect(moveValue(sameRow(leads), 0, WAIT)).toBeGreaterThan(moveValue(sameRow(waits), 0, WAIT));
    const apart = (history: H6State['history']): H6State =>
      choosing({ row: [2, 4], carry: [3, 3], history });
    expect(moveValue(apart(leads), 0, WAIT)).toBeCloseTo(moveValue(apart(waits), 0, WAIT), 10);
  });

  it('moveValue：每多等一回合就多一分流失，等的價值隨手上的分變少而變少', () => {
    const rich = choosing({ row: [2, 2], carry: [6, 0] });
    const poor = choosing({ row: [2, 2], carry: [1, 0] });
    expect(moveValue(rich, 0, WAIT)).toBeGreaterThan(moveValue(poor, 0, WAIT));
  });
});

// ---------------------------------------------------------------------------
// 不偷看
// ---------------------------------------------------------------------------

describe('H-6 地雷區｜不偷看（evaluate、actions、decide 都只讀公開資訊與自己的選擇）', () => {
  /** 兩張雷圖都和 known 一致：第 1 排的雷（欄 0）已公開；第 2 排的雷在欄 1 或欄 2；第 4 排的在欄 1、2 或欄 0、3。 */
  const knownCells = withKnown([
    [1, 0, 2],
    [1, 1, 1],
  ]);
  const mapA = DEFAULT_MINES.slice();
  const mapB = DEFAULT_MINES.slice();
  mapB[cellIndex(2, 1)] = 0;
  mapB[cellIndex(2, 3)] = 1;
  mapB[cellIndex(4, 0)] = 1;
  mapB[cellIndex(4, 1)] = 0;
  const maps = [mapA, mapB];
  const history = histOf(0, ['lead', 'lead', 'wait']);
  const shared = {
    known: knownCells,
    row: [1, 1] as readonly [number, number],
    carry: [2, 3] as readonly [number, number],
    totals: [1, 0] as readonly [number, number],
    claimed: new Array(6)
      .fill(null)
      .map((_v, i) => (i === 0 ? [true, true] : [false, false])) as H6State['claimed'],
    round: 3,
    history,
  };
  const oppMoves: (Move | null)[] = [null, 0, 1, BANK, WAIT];
  const fakeLasts = [
    null,
    {
      events: [
        { kind: 'mine', col: 1, reward: 0, lost: 4, banked: 0 },
        { kind: 'safe', col: 2, reward: 2, lost: 0, banked: 0 },
      ],
    },
    {
      events: [
        { kind: 'safe', col: 1, reward: 2, lost: 0, banked: 0 },
        { kind: 'mine', col: 2, reward: 0, lost: 3, banked: 0 },
      ],
    },
  ] as const;

  function variants(): { name: string; states: H6State[] }[] {
    const groups: { name: string; states: H6State[] }[] = [];
    groups.push({
      name: 'choose（我還沒按）：雷圖、對手的 pending 不同',
      states: maps.flatMap((mines) =>
        oppMoves.map((p) => choosing({ ...shared, mines, pending: [p, null] })),
      ),
    });
    groups.push({
      name: 'locked（我剛按了鍵）：雷圖、對手的 pending 不同',
      states: maps.flatMap((mines) =>
        ([0, 1, 2, BANK, WAIT] as const).flatMap((mine) =>
          oppMoves
            .filter((p): p is Move => p !== null)
            .map((p) =>
              makeState({
                ...shared,
                mines,
                phase: 'locked',
                wait: LOCK_TICKS,
                pending: [p, mine],
              }),
            ),
        ),
      ).filter((s) => s.pending[1] === 1),
    });
    groups.push({
      name: 'resolve（公開之後）：我的選擇固定，雷圖、對手的 pending、last 不同',
      states: maps.flatMap((mines) =>
        oppMoves
          .filter((p): p is Move => p !== null)
          .flatMap((p) =>
            fakeLasts.map((last) =>
              makeState({
                ...shared,
                mines,
                phase: 'resolve',
                wait: RESULT_TICKS,
                pending: [p, 1],
                last: last as H6State['last'],
              }),
            ),
          ),
      ),
    });
    groups.push({
      name: 'resolve：我存分，雷圖、對手的 pending、last 不同',
      states: maps.flatMap((mines) =>
        oppMoves
          .filter((p): p is Move => p !== null)
          .flatMap((p) =>
            fakeLasts.map((last) =>
              makeState({
                ...shared,
                mines,
                phase: 'resolve',
                wait: RESULT_TICKS,
                pending: [p, BANK],
                last: last as H6State['last'],
              }),
            ),
          ),
      ),
    });
    groups.push({
      name: 'prep：雷圖不同',
      states: maps.map((mines) => makeState({ ...shared, mines, phase: 'prep', wait: 20 })),
    });
    return groups;
  }

  function peeks(game: Game<H6State>, states: readonly H6State[], side: Side): boolean {
    const first = states[0] as H6State;
    const e0 = JSON.stringify(game.evaluate(first, side));
    const a0 = JSON.stringify(game.actions(first, side));
    return states.some(
      (s) =>
        JSON.stringify(game.evaluate(s, side)) !== e0 ||
        JSON.stringify(game.actions(s, side)) !== a0,
    );
  }

  /** 把 0 號邊與 1 號邊對調（AI 坐 0 號邊的鏡像）。last 是隱藏資訊，鏡像時直接清掉。 */
  function mirror(s: H6State): H6State {
    const swap = <T>(pair: readonly [T, T]): readonly [T, T] => [pair[1], pair[0]];
    return {
      ...s,
      row: swap(s.row),
      carry: swap(s.carry),
      totals: swap(s.totals),
      pending: swap(s.pending),
      claimed: s.claimed.map((c) => swap(c)),
      history: s.history.map((h) => swap(h)),
      last: null,
    };
  }

  function decideAtDepth(
    state: H6State,
    side: Side,
    depth: number,
    policy: Policy = pathfinder,
    game: Game<H6State> = h6Game,
  ): Buttons {
    return wrapPolicy(
      game,
      policy,
      { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
      7,
    ).decide(state, side, 0);
  }

  it('這些雷圖真的和 known 一致（測試自己的前提）', () => {
    for (const mines of maps) {
      expect(mines[cellIndex(1, 0)]).toBe(1);
      expect(mines[cellIndex(1, 1)]).toBe(0);
      for (let r = 1; r <= ROWS; r += 1) {
        expect(mines.slice((r - 1) * COLS, r * COLS).reduce((a, b) => a + b, 0)).toBe(minesInRow(r));
      }
    }
    expect(mapA.join('')).not.toBe(mapB.join(''));
  });

  it('每一組只有隱藏資訊不同的 state：AI 側的 evaluate 與 actions 完全相同', () => {
    for (const g of variants()) {
      expect(peeks(h6Game, g.states, 1), g.name).toBe(false);
    }
  });

  it('反過來也成立：AI 坐 0 號邊（鏡像）', () => {
    for (const g of variants()) {
      const mirrored = g.states.map(mirror);
      expect(peeks(h6Game, mirrored, 0), g.name).toBe(false);
    }
  });

  it('黑箱：四個性格在深度 1、3、6，只有隱藏資訊不同的 choose 局面，按的鍵都相同', () => {
    const policies: readonly Policy[] = [pathfinder, precise, greedy, gambler];
    const group = variants()[0] as { name: string; states: H6State[] };
    for (const policy of policies) {
      for (const depth of [1, 3, 6]) {
        const presses = group.states.map((s) => decideAtDepth(s, 1, depth, policy));
        for (const p of presses) {
          expect(p, `${policy.name} 深度 ${depth}`).toEqual(presses[0]);
        }
      }
    }
  });

  it('偵測器本身有效：故意洩漏（讀雷圖、讀對手的 pending、讀 last、讓 actions 多一個動作）一定被抓到', () => {
    const groups = variants();
    const leaks: Record<string, (s: H6State, side: Side) => number> = {
      '讀雷圖（所有階段，我的下一排）': (s, side) =>
        0.001 * (s.mines[cellIndex(s.row[side] + 1, 1)] as number),
      '讀雷圖（resolve）': (s, side) =>
        s.phase === 'resolve' ? 0.001 * (s.mines[cellIndex(Math.min(6, s.row[side] + 1), 1)] as number) : 0,
      '讀對手的 pending': (s, side) => (s.pending[1 - side] === 1 ? 0.001 : 0),
      '讀對手的 pending（resolve）': (s, side) =>
        s.phase === 'resolve' && s.pending[1 - side] === WAIT ? 0.001 : 0,
      '讀 last 的結局': (s) => (s.last === null ? 0 : 0.001 * s.last.events[1].reward),
    };
    for (const [name, extra] of Object.entries(leaks)) {
      const leaky: Game<H6State> = {
        ...h6Game,
        evaluate: (s, side) => {
          const e = h6Game.evaluate(s, side);
          return { gain: e.gain + extra(s, side), danger: e.danger };
        },
      };
      expect(
        groups.some((g) => peeks(leaky, g.states, 1)),
        `沒抓到洩漏：${name}`,
      ).toBe(true);
    }
    const leakyActions: Game<H6State> = {
      ...h6Game,
      actions: (s, side) =>
        s.pending[1 - side] === 1 ? [...h6Game.actions(s, side), IDLE] : h6Game.actions(s, side),
    };
    expect(groups.some((g) => peeks(leakyActions, g.states, 1))).toBe(true);
  });

  it('「對所有動作加同一個常數」的洩漏（10.9）：黑箱 decide 抓不到，只有 evaluate／actions 相等那兩條抓得到', () => {
    const leaky: Game<H6State> = {
      ...h6Game,
      evaluate: (s, side) => {
        const e = h6Game.evaluate(s, side);
        const peekedMines = s.mines.reduce((a, b) => a + b, 0) + (s.mines[cellIndex(2, 1)] as number);
        return { gain: e.gain + 0.37 * peekedMines, danger: e.danger };
      },
    };
    const group = variants()[0] as { states: H6State[] };
    expect(peeks(leaky, group.states, 1)).toBe(true);
    for (const depth of [1, 3, 6]) {
      const presses = group.states.map((s) =>
        JSON.stringify(decideAtDepth(s, 1, depth, pathfinder, leaky)),
      );
      expect(new Set(presses).size, `深度 ${depth}`).toBe(1);
    }
  });

  it('洩漏會改變選擇的那型：往前模擬時假裝知道雷在哪 → 黑箱 decide 也會不同', () => {
    const leakyChoice: Game<H6State> = {
      ...h6Game,
      evaluate: (s, side) => {
        const e = h6Game.evaluate(s, side);
        if (s.phase !== 'resolve') {
          return e;
        }
        const mv = s.pending[side];
        if (mv === null || mv > 3) {
          return e;
        }
        const isMine = s.mines[cellIndex(s.row[side] + 1, mv)] === 1;
        return { gain: e.gain + (isMine ? -5 : 5), danger: 0 };
      },
    };
    const decisions = maps.map((mines) =>
      JSON.stringify(
        decideAtDepth(
          choosing({ ...shared, mines, pending: [null, null], carry: [0, 0], row: [1, 1] }),
          1,
          3,
          pathfinder,
          leakyChoice,
        ),
      ),
    );
    expect(new Set(decisions).size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 等級曲線
// ---------------------------------------------------------------------------

describe('H-6 地雷區｜AI 怎麼打（等級曲線從結算流程長出來）', () => {
  function decideAtDepth(state: H6State, side: Side, depth: number): Buttons {
    return wrapPolicy(
      h6Game,
      pathfinder,
      { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
      7,
    ).decide(state, side, 0);
  }

  function moveOf(b: Buttons): Move | null {
    if (b.b) return WAIT;
    if (b.a) return BANK;
    if (b.left) return 0;
    if (b.up) return 1;
    if (b.right) return 2;
    if (b.down) return 3;
    return null;
  }

  const histories: H6State['history'][] = [
    [],
    histOf(0, ['lead', 'lead', 'lead', 'lead']),
    histOf(0, ['wait', 'wait', 'wait', 'wait']),
    histOf(0, ['bank', 'follow', 'wait', 'bank']),
  ];

  /** AI（1 號邊）的決定局面：兩邊同一排，AI 手上 `carry` 分。 */
  function scene(row: number, carry: number, history: H6State['history'] = []): H6State {
    return choosing({ row: [row, row], carry: [carry, carry], history });
  }

  it('深度 1、2（等級 1 到 3）是反射：手上的分 ≥ 5 存、否則往安全率最高的格走、不等，不管歷史、不管對手', () => {
    for (const depth of [1, 2]) {
      for (const row of [0, 1, 2, 3, 4, 5]) {
        for (const carry of [0, 1, 3, 4, 5, 7]) {
          for (const history of histories) {
            const s = scene(row, carry, history);
            const pressed = moveOf(decideAtDepth(s, 1, depth));
            expect(pressed, `深度 ${depth} 排 ${row} 分 ${carry}`).toBe(reflexMove(s, 1));
          }
        }
      }
    }
  });

  it('深度 ≥ 3 不是反射：存在局面，深度 6 的選擇和反射不同', () => {
    let differs = false;
    for (let row = 0; row <= 6 && !differs; row += 1) {
      for (let carry = 0; carry <= 8 && !differs; carry += 1) {
        const s = scene(row, carry);
        if (moveOf(decideAtDepth(s, 1, 6)) !== reflexMove(s, 1)) {
          differs = true;
        }
      }
    }
    expect(differs).toBe(true);
  });

  it('深度 ≥ 3：手上的分多、前面是高雷率的排 → 先存；一無所有的起點 → 往前走，不等', () => {
    for (const depth of [3, 4, 6]) {
      expect(moveOf(decideAtDepth(scene(4, 8), 1, depth)), `深度 ${depth}`).toBe(BANK);
      const start = moveOf(decideAtDepth(scene(0, 0), 1, depth));
      expect(start, `深度 ${depth}`).not.toBe(WAIT);
      expect(start, `深度 ${depth}`).not.toBe(BANK);
    }
  });

  it('等級曲線是階梯：深度 1、2 永遠一樣（讀不到歷史），深度 ≥ 3 存在同一個局面因為歷史不同而選不同的鍵', () => {
    const scenes: H6State[] = [];
    for (const row of [0, 1, 2, 3]) {
      for (const carry of [0, 1, 2, 3, 4]) {
        scenes.push(scene(row, carry));
      }
    }
    const differsAt = (depth: number): boolean =>
      scenes.some((s) => {
        const set = new Set(
          histories.map((history) =>
            JSON.stringify(decideAtDepth({ ...s, history }, 1, depth)),
          ),
        );
        return set.size > 1;
      });
    expect(differsAt(1)).toBe(false);
    expect(differsAt(2)).toBe(false);
    expect(differsAt(3)).toBe(true);
    expect(differsAt(6)).toBe(true);
  });

  it('模型關掉（消融）：深度 6 的 AI 對任何歷史都選一樣的鍵', () => {
    for (const row of [0, 1, 2, 3]) {
      for (const carry of [0, 1, 2, 3, 4]) {
        const set = new Set(
          histories.map((history) =>
            JSON.stringify(decideAtDepth({ ...scene(row, carry), history, model: false }, 1, 6)),
          ),
        );
        expect(set.size, `排 ${row} 分 ${carry}`).toBe(1);
      }
    }
  });

  it('DESIGN-AI-FUN 10.11 (a)(b)(c)：它讀錯你會不會領頭就賠錢——規則層面成立（不是靠參數）', () => {
    // 真實世界：對手（0 號邊）這回合一定等。AI 若以為對手常領頭（歷史全是領頭），會等著跟；
    // 真實的期望（用 leadRate 的先驗之外，把對手領頭的機率換成 0）比較低。
    const believedLeader = histOf(0, ['lead', 'lead', 'lead', 'lead']);
    const believedWaiter = histOf(0, ['wait', 'wait', 'wait', 'wait']);
    let found = 0;
    let worst = 0;
    for (let row = 0; row <= 4; row += 1) {
      for (let carry = 0; carry <= 6; carry += 1) {
        const lead = scene(row, carry, believedLeader);
        const wait = scene(row, carry, believedWaiter);
        const bestOf = (s: H6State): Move => {
          const options: Move[] = [0, 1, 2, 3, BANK, WAIT];
          let best: Move = WAIT;
          let bestV = Number.NEGATIVE_INFINITY;
          for (const m of options) {
            if (m === BANK && carry === 0) continue;
            const v = moveValue(s, 1, m);
            if (v > bestV) {
              bestV = v;
              best = m;
            }
          }
          return best;
        };
        const believedBest = bestOf(lead);
        const trueBest = bestOf(wait);
        if (believedBest === trueBest) {
          continue;
        }
        // (a)(b) 它真的會照信念選
        expect(moveOf(decideAtDepth(lead, 1, 6))).toBe(believedBest);
        // (c) 在真實世界（對手是個等待的人）裡照錯誤信念選期望比較低
        const loss = moveValue(wait, 1, trueBest) - moveValue(wait, 1, believedBest);
        expect(loss).toBeGreaterThan(0);
        worst = Math.max(worst, loss);
        found += 1;
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(worst).toBeGreaterThan(0.05);
  });

  describe('DESIGN-AI-FUN 10.6 的兩個 pending 陷阱', () => {
    function phasesSeen(depth: number, state: H6State, side: Side): Set<string> {
      const seen = new Set<string>();
      const spy: Game<H6State> = {
        ...h6Game,
        evaluate: (s, who) => {
          seen.add(s.phase);
          return h6Game.evaluate(s, who);
        },
      };
      wrapPolicy(
        spy,
        pathfinder,
        { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
        7,
      ).decide(state, side, 0);
      return seen;
    }

    it('陷阱二：actions()[0] 是等（b），一個會推進結算的動作，不是什麼都不按', () => {
      for (const s of [choosing(), choosing({ carry: [4, 4], row: [2, 2] })]) {
        for (const side of [0, 1] as const) {
          const list = h6Game.actions(s, side);
          expect(sameButtons(list[0] as Buttons, IDLE)).toBe(false);
          expect(sameButtons(list[0] as Buttons, PRESS_B)).toBe(true);
        }
      }
      const s = choosing();
      const mine = h6Game.actions(s, 0)[1] as Buttons;
      const theirs = h6Game.actions(s, 1)[0] as Buttons;
      expect(h6Game.step(s, [mine, theirs]).phase).toBe('locked');
    });

    it('陷阱一：按 → 鎖定 → 公開一共 3 步，在 depth 的 6 格額度之內', () => {
      let cur = h6Game.step(choosing(), both(1, 1));
      let steps = 1;
      while (cur.phase !== 'resolve') {
        cur = h6Game.step(cur, idle());
        steps += 1;
      }
      expect(steps).toBe(3);
      expect(steps).toBeLessThanOrEqual(6);
    });

    it('深度 1、2 的 decide 沒評估過公開之後的局面（resolve），深度 3 以上評估過', () => {
      const state = scene(2, 3);
      for (const depth of [1, 2]) {
        expect(phasesSeen(depth, state, 1).has('resolve'), `深度 ${depth}`).toBe(false);
      }
      for (const depth of [3, 4, 6]) {
        expect(phasesSeen(depth, state, 1).has('resolve'), `深度 ${depth}`).toBe(true);
      }
    });
  });
});
