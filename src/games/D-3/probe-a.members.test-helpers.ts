import type { Buttons, Controller, Side } from '../../core/types';
import { CELLS, MOVE_EVERY, UNREACHABLE, bfsDistances, stepTarget } from '../_diamonds/logic';
import type { Dir } from '../_diamonds/logic';
import { LIFETIME, gemValue } from './logic';
import type { D3State, Gem } from './logic';

/**
 * D-3 探針 A（完整版）的 (b)(c) 兩族（`docs/cards/D-3.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61、10.70）。
 * 只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。**兩族與雙胞胎在量之前寫進小規格並 push，量完不改。**
 *
 * 這個檔案不准碰 AI 的任何東西（沒有引擎的評估函數、沒有控制器、沒有各性格）：(c) 不是 AI（10.61 第二個陷阱），
 * `probe-a.test.ts` 掃這個檔案的原始碼擋住。對局的接線（需要 AI 當對手）在 `probe-a.test-helpers.ts`。
 *
 * 所有成員共用同一套走路：選一顆目標寶石，沿繞牆最短路走過去。差別只在**怎麼選目標**：
 * - (b) 族：知道有對手存在（寶石會被搶走、補新的），但**不讀對手的任何狀態**：只准讀牆、寶石、tick、自己的位置與分數。
 * - (c) 族：讀對手的公開狀態（位置、待走方向、分數）。每個 (c) 都是某個 (b) 加上「讀對手」那一項（雙胞胎）。
 */

/** (c) 的 pen／skip 對「對手比我近」的寶石的距離加罰（手訂的，沒有調過；不是 AI 的那個常數）。 */
export const PEN = 6;

export const B_FAMILY = [
  'b-near',
  'b-value',
  'b-pull1',
  'b-pull2',
  'b-pull4',
  'b-pull2sq',
  'b-route2',
  'b-pull2-stick',
  'b-stay',
] as const;

export const C_FAMILY = [
  'c-near-pen',
  'c-value-pen',
  'c-pull1-pen',
  'c-pull2-pen',
  'c-pull4-pen',
  'c-pull2sq-pen',
  'c-route2-pen',
  'c-pull2-stick-pen',
  'c-pull2-skip',
  'c-pull2-next-pen',
  'c-pull2-lead',
] as const;

/**
 * 雙胞胎（量之前固定）：機器完全一樣、只差「讀對手」那一項的 [(b), (c)]。
 * 每個 (b)（b-stay 除外）都有，所以不論訓練種子上誰是 (b\*)，它都有對應的 (c) 版本（10.68 第六小節）。
 * `c-pull2-skip` 的基底是 `b-pull2`（pen 與 skip 是「讀」的兩種寫法）；`c-pull2-next-pen` 讀的是對手待走方向；
 * `c-pull2-lead` 讀的是分數。
 */
export const TWINS: readonly (readonly [string, string])[] = [
  ['b-near', 'c-near-pen'],
  ['b-value', 'c-value-pen'],
  ['b-pull1', 'c-pull1-pen'],
  ['b-pull2', 'c-pull2-pen'],
  ['b-pull4', 'c-pull4-pen'],
  ['b-pull2sq', 'c-pull2sq-pen'],
  ['b-route2', 'c-route2-pen'],
  ['b-pull2-stick', 'c-pull2-stick-pen'],
  ['b-pull2', 'c-pull2-skip'],
  ['b-pull2', 'c-pull2-next-pen'],
  ['b-pull2', 'c-pull2-lead'],
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
function toward(state: D3State, side: Side, target: number): Buttons {
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
// 候選寶石
// ---------------------------------------------------------------------------

interface Cand {
  readonly gem: Gem;
  /** 我走到它的繞牆步數。 */
  readonly d: number;
  /** 加罰之後的距離（(b) 永遠等於 d）。 */
  readonly eff: number;
  /** 到手時的價值。 */
  readonly v: number;
  readonly contested: boolean;
}

type Mode = 'none' | 'pen' | 'skip';

/** 我走得到、到手之前不會消失的寶石。`oppFrom` 是對手的位置（只有 (c) 才傳）。 */
function candidates(state: D3State, side: Side, mode: Mode, oppFrom: number): Cand[] {
  const mine = bfsDistances(state.walls, state.players[side].cell);
  const theirs = mode === 'none' ? null : bfsDistances(state.walls, oppFrom);
  const out: Cand[] = [];
  for (const gem of state.gems) {
    const d = mine[gem.cell] as number;
    if (d >= UNREACHABLE) {
      continue;
    }
    const arrival = state.tick + MOVE_EVERY * d;
    if (arrival - gem.born > LIFETIME) {
      continue;
    }
    const contested = theirs !== null && (theirs[gem.cell] as number) < d;
    out.push({
      gem,
      d,
      eff: d + (mode === 'pen' && contested ? PEN : 0),
      v: gemValue(Math.max(arrival - 1, gem.born), gem.born),
      contested,
    });
  }
  if (mode === 'skip') {
    const free = out.filter((x) => !x.contested);
    return free.length > 0 ? free : out;
  }
  return out;
}

type Form = 'near' | 'value' | 'pull1' | 'pull2' | 'pull4' | 'pull2sq' | 'route2' | 'stay';

/** 一顆候選的分數（越大越好）；同分的由呼叫端依價值、編號破平。 */
function formScore(form: Form, c: Cand): number {
  switch (form) {
    case 'near':
      return -c.eff;
    case 'value':
      return 10 * c.v - c.eff; // 價值優先，同價值的看（加罰後的）距離
    case 'pull1':
      return c.v / (c.eff + 1);
    case 'pull2':
    case 'route2':
      return c.v / (c.eff + 2);
    case 'pull4':
      return c.v / (c.eff + 4);
    case 'pull2sq':
      return c.v / (c.eff + 2) ** 2;
    case 'stay':
      return Number.NEGATIVE_INFINITY;
  }
}

/** 兩顆寶石的路線：先 g1 再 g2，（兩顆的價值和）÷（走過去的步數 ＋ 2）。g2 的價值照到手時間算。 */
function routeScore(state: D3State, cands: readonly Cand[], first: Cand): number {
  let best = first.v / (first.eff + 2);
  const fromFirst = bfsDistances(state.walls, first.gem.cell);
  for (const second of cands) {
    if (second.gem === first.gem) {
      continue;
    }
    const leg = fromFirst[second.gem.cell] as number;
    if (leg >= UNREACHABLE) {
      continue;
    }
    const arrival = state.tick + MOVE_EVERY * (first.d + leg);
    if (arrival - second.gem.born > LIFETIME) {
      continue;
    }
    const v2 = gemValue(Math.max(arrival - 1, second.gem.born), second.gem.born);
    best = Math.max(best, (first.v + v2) / (first.eff + leg + 2));
  }
  return best;
}

function pickBest(
  state: D3State,
  side: Side,
  form: Form,
  cands: readonly Cand[],
  pullK?: number,
): Cand | null {
  let best: Cand | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const c of cands) {
    let s = form === 'route2' ? routeScore(state, cands, c) : formScore(form, c);
    if (pullK !== undefined) {
      s = c.v / (c.eff + pullK);
    }
    const better =
      best === null ||
      s > bestScore + 1e-12 ||
      (Math.abs(s - bestScore) <= 1e-12 &&
        (c.v > best.v ||
          (c.v === best.v &&
            (c.eff < best.eff ||
              (c.eff === best.eff && rank(c.gem.cell, side) < rank(best.gem.cell, side))))));
    if (better) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 成員
// ---------------------------------------------------------------------------

interface MemberSpec {
  readonly form: Form;
  readonly stick: boolean;
  readonly mode: Mode;
  /** 對手的位置用「下一步會在哪」（讀待走方向）。 */
  readonly next: boolean;
  /** 讀分數：領先 10 分以上求近（k＝0.5），落後 10 分以上敢追高價值（k＝6）。 */
  readonly lead: boolean;
}

const plain: MemberSpec = { form: 'pull2', stick: false, mode: 'none', next: false, lead: false };

function specOf(name: string): MemberSpec {
  switch (name) {
    case 'b-near':
      return { ...plain, form: 'near' };
    case 'b-value':
      return { ...plain, form: 'value' };
    case 'b-pull1':
      return { ...plain, form: 'pull1' };
    case 'b-pull2':
      return plain;
    case 'b-pull4':
      return { ...plain, form: 'pull4' };
    case 'b-pull2sq':
      return { ...plain, form: 'pull2sq' };
    case 'b-route2':
      return { ...plain, form: 'route2' };
    case 'b-pull2-stick':
      return { ...plain, stick: true };
    case 'b-stay':
      return { ...plain, form: 'stay' };
    case 'c-near-pen':
      return { ...plain, form: 'near', mode: 'pen' };
    case 'c-value-pen':
      return { ...plain, form: 'value', mode: 'pen' };
    case 'c-pull1-pen':
      return { ...plain, form: 'pull1', mode: 'pen' };
    case 'c-pull2-pen':
      return { ...plain, mode: 'pen' };
    case 'c-pull4-pen':
      return { ...plain, form: 'pull4', mode: 'pen' };
    case 'c-pull2sq-pen':
      return { ...plain, form: 'pull2sq', mode: 'pen' };
    case 'c-route2-pen':
      return { ...plain, form: 'route2', mode: 'pen' };
    case 'c-pull2-stick-pen':
      return { ...plain, stick: true, mode: 'pen' };
    case 'c-pull2-skip':
      return { ...plain, mode: 'skip' };
    case 'c-pull2-next-pen':
      return { ...plain, mode: 'pen', next: true };
    case 'c-pull2-lead':
      return { ...plain, lead: true };
    default:
      throw new Error(`不是族裡的成員：${name}`);
  }
}

/** 對手下一步會在哪（待走方向已鎖定就走一格，走不動就是原地）。 */
function oppNextCell(state: D3State, side: Side): number {
  const opp = state.players[other(side)];
  return opp.pending < 0 ? opp.cell : stepTarget(state.walls, opp.cell, opp.pending as Dir);
}

/** 一個成員的控制器（每次呼叫都是全新的，有自己的內部狀態）。 */
export function member(name: string): Controller<D3State> {
  const m = specOf(name);
  let target: Gem | null = null;
  return {
    decide(state: D3State, side: Side): Buttons {
      if (state.over || m.form === 'stay') {
        return NONE;
      }
      const oppFrom = m.next ? oppNextCell(state, side) : state.players[other(side)].cell;
      const cands = candidates(state, side, m.mode, oppFrom);
      let pullK: number | undefined;
      if (m.lead) {
        const diff = state.players[side].score - state.players[other(side)].score;
        pullK = diff >= 10 ? 0.5 : diff <= -10 ? 6 : 2;
      }
      let chosen: Cand | null = null;
      if (m.stick && target !== null) {
        const held = cands.find((c) => c.gem.cell === target?.cell && c.gem.born === target.born);
        // (b) 一直到手或消失才換；(c) 在對手比我近（嚴格小於）時放棄重選。
        const lost = m.mode !== 'none' && held !== undefined && held.contested && held.eff > held.d;
        if (held !== undefined && !lost) {
          chosen = held;
        }
      }
      chosen ??= pickBest(state, side, m.form, cands, pullK);
      target = chosen === null ? null : chosen.gem;
      return chosen === null ? NONE : toward(state, side, chosen.gem.cell);
    },
  };
}

// ---------------------------------------------------------------------------
// 反應延遲
// ---------------------------------------------------------------------------

/**
 * 反應延遲：世界（對手的位置、待走方向、分數、寶石清單）是 `delay` 個 tick 前的；
 * 自己的位置、待走方向、分數與時間是現在的；延遲這段時間裡自己踩過的格子上的寶石，不再當寶石
 * （自己撿走的自己知道）。
 */
export function withDelay(inner: Controller<D3State>, delay: number): Controller<D3State> {
  if (delay <= 0) {
    return inner;
  }
  const seen = new Map<number, D3State>();
  return {
    decide(state: D3State, side: Side, tick: number): Buttons {
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
        D3State['players'][0],
        D3State['players'][0],
      ];
      players[side] = state.players[side];
      return inner.decide(
        {
          ...old,
          tick: state.tick,
          players,
          gems: old.gems.filter((gem) => !visited.has(gem.cell)),
        },
        side,
        tick,
      );
    },
  };
}
