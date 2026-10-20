import type { Buttons, Controller, Side } from '../../core/types';
import {
  CELLS,
  MOVE_EVERY,
  START_CELLS,
  UNREACHABLE,
  bfsDistances,
  stepTarget,
} from '../_diamonds/logic';
import type { Dir } from '../_diamonds/logic';
import { BAG_LIMIT } from './logic';
import type { D2State } from './logic';

/**
 * D-2 探針 A（完整版）的 (b)(c) 兩族（`docs/cards/D-2.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61、10.70）。
 * 只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。**兩族與雙胞胎在量之前寫進小規格並 push，量完不改。**
 *
 * 這個檔案不准碰 AI 的任何東西（沒有引擎的評估函數、沒有控制器、沒有各性格）：(c) 不是 AI（10.61 第二個陷阱），
 * `probe-a.test.ts` 掃這個檔案的原始碼擋住。對局的接線（需要 AI 當對手）在 `probe-a.test-helpers.ts`。
 *
 * 所有成員共用同一套走路與兩個決定：**`N`**（背包裝到幾枚就回基地）與 **`K`**（背包有東西時，下一枚金幣要「順路」到什麼程度才去撿：
 * 去撿再回基地的路，比直接回基地最多多 K 步；K 沒給就是不限）。最後時段（背包裡的東西再不走就來不及存）一律回基地；
 * 「撿了也來不及存」的金幣不去撿。
 * - (b) 族：知道有對手存在（金幣會被搶走），但**不讀對手的任何狀態**：只准讀牆、金幣、tick、自己的位置、背包與分數。
 * - (c) 族：讀對手的公開狀態（位置、待走方向、背包、分數）。每個 (c) 都是某個 (b) 加上「讀對手」那一項（雙胞胎）。
 */

/** (c) 的 pen／skip 對「對手搶得到」的金幣的距離加罰（手訂的，沒有調過；不是 AI 的那個常數）。 */
export const PEN = 6;

export const B_FAMILY = [
  'b-N1',
  'b-N2',
  'b-N3',
  'b-N2-K5',
  'b-N3-K5',
  'b-N3-K2',
  'b-N3-home',
  'b-stay',
] as const;

export const C_FAMILY = [
  'c-N1-pen',
  'c-N2-pen',
  'c-N3-pen',
  'c-N2-K5-pen',
  'c-N3-K5-pen',
  'c-N3-K2-pen',
  'c-N3-home-pen',
  'c-N3-skip',
  'c-N3-pen-nobag',
  'c-N3-next-pen',
  'c-N3-lead',
] as const;

/**
 * 雙胞胎（量之前固定）：機器完全一樣、只差「讀對手」那一項的 [(b), (c)]。
 * 每個 (b)（b-stay 除外）都有 `-pen` 雙胞胎，所以不論訓練種子上誰是 (b\*)，它都有對應的 (c) 版本（10.68 第六小節）。
 * 其餘四個的基底都是 `b-N3`：`-skip` 是讀的另一種寫法（搶得到的金幣一律不去）、`-pen-nobag` 不讀對手背包
 * （只讀位置，拿來和 `c-N3-pen` 對照，分出「讀背包」值多少）、`-next-pen` 讀對手待走方向、`-lead` 讀分數。
 */
export const TWINS: readonly (readonly [string, string])[] = [
  ['b-N1', 'c-N1-pen'],
  ['b-N2', 'c-N2-pen'],
  ['b-N3', 'c-N3-pen'],
  ['b-N2-K5', 'c-N2-K5-pen'],
  ['b-N3-K5', 'c-N3-K5-pen'],
  ['b-N3-K2', 'c-N3-K2-pen'],
  ['b-N3-home', 'c-N3-home-pen'],
  ['b-N3', 'c-N3-skip'],
  ['b-N3', 'c-N3-pen-nobag'],
  ['b-N3', 'c-N3-next-pen'],
  ['b-N3', 'c-N3-lead'],
];

// ---------------------------------------------------------------------------
// 走路
// ---------------------------------------------------------------------------

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const DIRS_FIRST: readonly Dir[] = [0, 1, 2, 3];
const DIRS_SECOND: readonly Dir[] = [2, 3, 0, 1];

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);

/** 往 `target` 走一步：最短路的方向裡優先已經鎖定的方向（直走），其次依這一邊的預設順序。 */
function toward(state: D2State, side: Side, target: number): Buttons {
  const from = state.players[side].cell;
  if (from === target) {
    return NONE;
  }
  const field = bfsDistances(state.walls, target);
  const here = field[from] as number;
  const good: Dir[] = [];
  for (const dir of side === 0 ? DIRS_FIRST : DIRS_SECOND) {
    const next = stepTarget(state.walls, from, dir);
    if (next !== from && (field[next] as number) < here) {
      good.push(dir);
    }
  }
  if (good.length === 0) {
    return NONE;
  }
  const pending = state.players[side].pending;
  return press(pending >= 0 && good.includes(pending as Dir) ? (pending as Dir) : (good[0] as Dir));
}

/** 兩邊的平手規則對稱：從自己這一邊數起編號小的先。 */
const rank = (c: number, side: Side): number => (side === 0 ? c : CELLS - 1 - c);

// ---------------------------------------------------------------------------
// 成員
// ---------------------------------------------------------------------------

type Mode = 'none' | 'pen' | 'skip';

interface MemberSpec {
  /** 背包裝到幾枚就回基地。 */
  readonly n: number;
  /** 順路的容許（多走幾步）；`Infinity` ＝ 不限。 */
  readonly k: number;
  /** 挑金幣的方式：只看距離，或同時看離基地多遠（`dist + 0.5 × 離基地的距離`）。 */
  readonly form: 'near' | 'home';
  readonly mode: Mode;
  /** 對手背包滿了就搶不了金幣，不算「搶得到」（讀對手背包）。 */
  readonly bagAware: boolean;
  /** 對手的位置用「下一步會在哪」（讀待走方向）。 */
  readonly next: boolean;
  /** 讀分數：領先 3 分以上就一枚也回基地（n ＝ 1）。 */
  readonly lead: boolean;
  readonly stay: boolean;
}

const base: MemberSpec = {
  n: 3,
  k: Number.POSITIVE_INFINITY,
  form: 'near',
  mode: 'none',
  bagAware: false,
  next: false,
  lead: false,
  stay: false,
};
const pen: Partial<MemberSpec> = { mode: 'pen', bagAware: true };

function specOf(name: string): MemberSpec {
  const make = (p: Partial<MemberSpec>): MemberSpec => ({ ...base, ...p });
  switch (name) {
    case 'b-N1':
      return make({ n: 1 });
    case 'b-N2':
      return make({ n: 2 });
    case 'b-N3':
      return base;
    case 'b-N2-K5':
      return make({ n: 2, k: 5 });
    case 'b-N3-K5':
      return make({ k: 5 });
    case 'b-N3-K2':
      return make({ k: 2 });
    case 'b-N3-home':
      return make({ form: 'home' });
    case 'b-stay':
      return make({ stay: true });
    case 'c-N1-pen':
      return make({ n: 1, ...pen });
    case 'c-N2-pen':
      return make({ n: 2, ...pen });
    case 'c-N3-pen':
      return make(pen);
    case 'c-N2-K5-pen':
      return make({ n: 2, k: 5, ...pen });
    case 'c-N3-K5-pen':
      return make({ k: 5, ...pen });
    case 'c-N3-K2-pen':
      return make({ k: 2, ...pen });
    case 'c-N3-home-pen':
      return make({ form: 'home', ...pen });
    case 'c-N3-skip':
      return make({ mode: 'skip', bagAware: true });
    case 'c-N3-pen-nobag':
      return make({ mode: 'pen', bagAware: false });
    case 'c-N3-next-pen':
      return make({ ...pen, next: true });
    case 'c-N3-lead':
      return make({ lead: true });
    default:
      throw new Error(`不是族裡的成員：${name}`);
  }
}

interface Cand {
  readonly cell: number;
  readonly d: number;
  readonly eff: number;
  readonly toHome: number;
  readonly contested: boolean;
}

/** 對手下一步會在哪（待走方向已鎖定就走一格，走不動就是原地）。 */
function oppNextCell(state: D2State, side: Side): number {
  const opp = state.players[other(side)];
  return opp.pending < 0 ? opp.cell : stepTarget(state.walls, opp.cell, opp.pending as Dir);
}

/** 一個成員的控制器（每次呼叫都是全新的）。 */
export function member(name: string): Controller<D2State> {
  const m = specOf(name);
  return {
    decide(state: D2State, side: Side): Buttons {
      if (state.over || m.stay) {
        return NONE;
      }
      const me = state.players[side];
      const opp = state.players[other(side)];
      const home = START_CELLS[side];
      const bag = state.bags[side];
      const ticksLeft = state.maxTicks - state.tick;
      const fromHome = bfsDistances(state.walls, home);
      const homeD = fromHome[me.cell] as number;

      // 背包裡有東西、再不走就來不及存：回基地。
      if (bag > 0 && MOVE_EVERY * homeD + 3 * MOVE_EVERY >= ticksLeft) {
        return toward(state, side, home);
      }
      const n = m.lead && me.score - opp.score >= 3 ? 1 : m.n;
      if (bag >= n || bag >= BAG_LIMIT) {
        return toward(state, side, home);
      }

      // 候選金幣：走得到、撿了還來得及存。
      const mine = bfsDistances(state.walls, me.cell);
      const oppFrom = m.next ? oppNextCell(state, side) : opp.cell;
      const theirs = m.mode === 'none' ? null : bfsDistances(state.walls, oppFrom);
      const oppCanTake = !m.bagAware || state.bags[other(side)] < BAG_LIMIT;
      let cands: Cand[] = [];
      for (const coin of state.coins) {
        const d = mine[coin] as number;
        const toHome = fromHome[coin] as number;
        if (d >= UNREACHABLE || MOVE_EVERY * (d + toHome) + 2 * MOVE_EVERY >= ticksLeft) {
          continue;
        }
        const contested = theirs !== null && oppCanTake && (theirs[coin] as number) < d;
        cands.push({
          cell: coin,
          d,
          eff: d + (m.mode === 'pen' && contested ? PEN : 0),
          toHome,
          contested,
        });
      }
      if (m.mode === 'skip') {
        const free = cands.filter((c) => !c.contested);
        cands = free.length > 0 ? free : cands;
      }
      if (cands.length === 0) {
        return bag > 0 ? toward(state, side, home) : NONE;
      }
      let best = cands[0] as Cand;
      const key = (c: Cand): number => (m.form === 'home' ? c.eff + 0.5 * c.toHome : c.eff);
      for (const c of cands) {
        if (
          key(c) < key(best) - 1e-12 ||
          (Math.abs(key(c) - key(best)) <= 1e-12 && rank(c.cell, side) < rank(best.cell, side))
        ) {
          best = c;
        }
      }
      // 順路嗎：背包有東西時，去撿再回基地比直接回基地最多多 K 步。
      if (bag > 0 && best.d + best.toHome > homeD + m.k) {
        return toward(state, side, home);
      }
      return toward(state, side, best.cell);
    },
  };
}

// ---------------------------------------------------------------------------
// 反應延遲
// ---------------------------------------------------------------------------

/**
 * 反應延遲：世界（對手的位置、待走方向、背包、分數、金幣清單）是 `delay` 個 tick 前的；
 * 自己的位置、待走方向、背包、分數與時間是現在的；延遲這段時間裡自己踩過的格子上的金幣不再當金幣
 * （自己撿走的自己知道）。
 */
export function withDelay(inner: Controller<D2State>, delay: number): Controller<D2State> {
  if (delay <= 0) {
    return inner;
  }
  const seen = new Map<number, D2State>();
  return {
    decide(state: D2State, side: Side, tick: number): Buttons {
      seen.set(tick, state);
      seen.delete(tick - delay - 1);
      const old = seen.get(tick - delay) ?? seen.get(Math.max(0, tick - delay)) ?? state;
      const visited = new Set<number>();
      for (let t = tick - delay + 1; t <= tick; t += 1) {
        const there = seen.get(t);
        if (there !== undefined) {
          visited.add(there.players[side].cell);
        }
      }
      const players = [old.players[0], old.players[1]] as [
        D2State['players'][0],
        D2State['players'][0],
      ];
      players[side] = state.players[side];
      const bags = [old.bags[0], old.bags[1]] as [number, number];
      bags[side] = state.bags[side];
      return inner.decide(
        {
          ...old,
          tick: state.tick,
          players,
          bags,
          coins: old.coins.filter((coin) => !visited.has(coin)),
        },
        side,
        tick,
      );
    },
  };
}
