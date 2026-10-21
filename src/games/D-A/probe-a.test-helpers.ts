import { levelController, policyByName } from '../../ai/level';
import type { PolicyKey } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Game, GameConfig, Side } from '../../core/types';
import { outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { IsPoint, MatchOutcome, ProbeSpec } from '../../../tests/ai/probe-a.shared';
import {
  CELLS,
  MOVE_EVERY,
  START_CELLS,
  UNREACHABLE,
  bfsDistances,
  cellX,
  cellY,
  nextCell,
  stepTarget,
} from '../_diamonds/logic';
import type { Dir } from '../_diamonds/logic';
import { dAGame } from './logic';
import type { DAState } from './logic';

/**
 * D-A 探針 A（完整版）的量測工具（`docs/cards/D-A.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61、10.70）。
 * 只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。**(b)、(c) 兩族與選法在量之前寫進小規格並 push，量完不改。**
 *
 * 所有成員共用同一台機器：每個 tick 在場上的金幣裡挑一枚「目標」，沿繞牆最短路走過去
 * （同樣近的方向優先沿著上一次走的方向直走）。差別只在**怎麼給每一枚金幣打分數**：
 *   分數 ＝ 我到它的步數 ＋ 鏈 × 它旁邊最近的另一枚的步數 − 密 × 它附近的金幣數 ＋ 罰 × [對手到它比我近]
 * 挑分數最小的；現在的目標沒有比最好的差超過「黏」就不換（避免來回跳）。
 * - (b) 族：知道有對手（所以有「搶輸要罰」這一項），但**不讀對手的任何狀態**：「對手在哪」用的是
 *   對手的**起點**（地圖上的常數，180 度對稱），不是它現在的位置。只准讀牆、自己的位置、場上的金幣。
 * - (c) 族：同一台機器，但「對手在哪」換成對手現在的位置（或鎖定方向走一步之後的位置、或再看分數）。
 *   **沒有 import `evaluate`、`predictOpponent`、`opponentAction`，也沒有拿 AI 的控制器當成員。**
 */

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };
/** AI 的種子 ＝ 玩家種子 ＋ 這個數（慣例同 D-10、S-10、D-Q、D-8 的探針）。 */
export const AI_SEED_OFFSET = 1_000_003;

export const B_FAMILY = [
  'b-nearest',
  'b-stick',
  'b-start4',
  'b-start8',
  'b-start16',
  'b-chain',
  'b-chain-start8',
  'b-dense',
  'b-far',
  'b-stay',
] as const;

export const C_FAMILY = [
  'c-pos4',
  'c-pos8',
  'c-pos16',
  'c-chain-pos8',
  'c-dense-pos8',
  'c-next8',
  'c-lead',
  'c-adv',
] as const;

/** 沒有 (c) 版本的 (b) 成員：只為了看動態範圍（站著不動、最遠先）。其餘每個 (b) 都要有雙胞胎（10.68 第六小節）。 */
export const BALLAST: readonly string[] = ['b-far', 'b-stay'];

/**
 * 雙胞胎：機器一樣、只差「讀不讀對手」。`b-nearest`、`b-stick` 沒有罰（不認為對手會搶），
 * 它們的 (c) 版本是「加上讀對手的罰」的 `c-pos8`（黏著度相同）；其餘一對一。
 */
export const TWIN_OF: Readonly<Record<string, string | null>> = {
  'b-nearest': 'c-pos8',
  'b-stick': 'c-pos8',
  'b-start4': 'c-pos4',
  'b-start8': 'c-pos8',
  'b-start16': 'c-pos16',
  'b-chain': 'c-chain-pos8',
  'b-chain-start8': 'c-chain-pos8',
  'b-dense': 'c-dense-pos8',
  'b-far': null,
  'b-stay': null,
};

/** 額外的同基底配對（一個 (b) 對多個 (c)）：c-next8 與 c-lead 的基底都是 b-start8。 */
export const EXTRA_TWINS: readonly (readonly [string, string])[] = [
  ['b-start8', 'c-next8'],
  ['b-start8', 'c-lead'],
  ['b-nearest', 'c-adv'],
];

// ---------------------------------------------------------------------------
// 走路
// ---------------------------------------------------------------------------

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const ORDER: Readonly<Record<Side, readonly Dir[]>> = { 0: [0, 1, 2, 3], 1: [2, 3, 0, 1] };

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);
const manhattan = (a: number, b: number): number =>
  Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
/** 同分時的破平：自己這一邊數起編號小的（1 號邊轉 180 度）。 */
const rank = (c: number, side: Side): number => (side === 0 ? c : CELLS - 1 - c);

/** 往 `target` 走一步的方向：最短路的方向裡優先上一次走的方向（直走），否則依這一邊的預設順序。 */
function toward(
  walls: readonly number[],
  from: number,
  side: Side,
  target: number,
  heading: Dir | null,
): Dir | null {
  if (from === target) {
    return null;
  }
  const field = bfsDistances(walls, target);
  const here = field[from] as number;
  const good: Dir[] = [];
  for (const dir of ORDER[side]) {
    const next = stepTarget(walls, from, dir);
    if (next !== from && (field[next] as number) < here) {
      good.push(dir);
    }
  }
  if (good.length === 0) {
    return null;
  }
  if (heading !== null && good.includes(heading)) {
    return heading;
  }
  return good[0] as Dir;
}

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

/** 一個成員的打分數規則（同一台機器的參數）。 */
interface Rule {
  /** 「搶輸要罰」的步數；0 ＝ 不罰。 */
  readonly pen: number;
  /** 鏈：旁邊最近的另一枚的步數的權重。 */
  readonly chain: number;
  /** 密：半徑 7（曼哈頓）內的其他金幣數的權重（每枚抵幾步）。 */
  readonly dense: number;
  /** 現在的目標沒有比最好的差超過這麼多就不換。 */
  readonly stick: number;
  /** 去最遠的（只為了看動態範圍）。 */
  readonly far?: boolean;
  /** 不動（只為了看動態範圍）。 */
  readonly stay?: boolean;
}

/** (b) 的規則：只有參數，沒有任何對手的資料。 */
function ruleB(name: string): Rule & { readonly ref: 'none' | 'start' } {
  switch (name) {
    case 'b-nearest':
      return { ref: 'none', pen: 0, chain: 0, dense: 0, stick: 0 };
    case 'b-stick':
      return { ref: 'none', pen: 0, chain: 0, dense: 0, stick: 3 };
    case 'b-start4':
      return { ref: 'start', pen: 4, chain: 0, dense: 0, stick: 3 };
    case 'b-start8':
      return { ref: 'start', pen: 8, chain: 0, dense: 0, stick: 3 };
    case 'b-start16':
      return { ref: 'start', pen: 16, chain: 0, dense: 0, stick: 3 };
    case 'b-chain':
      return { ref: 'none', pen: 0, chain: 0.5, dense: 0, stick: 3 };
    case 'b-chain-start8':
      return { ref: 'start', pen: 8, chain: 0.5, dense: 0, stick: 3 };
    case 'b-dense':
      return { ref: 'none', pen: 0, chain: 0, dense: 2, stick: 3 };
    case 'b-far':
      return { ref: 'none', pen: 0, chain: 0, dense: 0, stick: 0, far: true };
    case 'b-stay':
      return { ref: 'none', pen: 0, chain: 0, dense: 0, stick: 0, stay: true };
    default:
      throw new Error(`不是 (b) 的成員：${name}`);
  }
}

/** (c) 的規則：多一個「對手在哪」怎麼讀。 */
interface RuleC extends Rule {
  /** pos ＝ 對手現在的位置；next ＝ 對手鎖定方向走一步之後；adv ＝ 不用門檻，去「我比對手早到最多」的那一枚。 */
  readonly ref: 'pos' | 'next';
  /** 看分數：領先 ≥ 2 照 16 步罰（讓出）、落後 ≥ 2 照 2 步（敢搶）、其餘照 `pen`。 */
  readonly lead?: boolean;
  readonly adv?: boolean;
}

/** (c) 的規則。 */
function ruleC(name: string): RuleC {
  switch (name) {
    case 'c-pos4':
      return { ref: 'pos', pen: 4, chain: 0, dense: 0, stick: 3 };
    case 'c-pos8':
      return { ref: 'pos', pen: 8, chain: 0, dense: 0, stick: 3 };
    case 'c-pos16':
      return { ref: 'pos', pen: 16, chain: 0, dense: 0, stick: 3 };
    case 'c-chain-pos8':
      return { ref: 'pos', pen: 8, chain: 0.5, dense: 0, stick: 3 };
    case 'c-dense-pos8':
      return { ref: 'pos', pen: 8, chain: 0, dense: 2, stick: 3 };
    case 'c-next8':
      return { ref: 'next', pen: 8, chain: 0, dense: 0, stick: 3 };
    case 'c-lead':
      return { ref: 'pos', pen: 8, chain: 0, dense: 0, stick: 3, lead: true };
    case 'c-adv':
      return { ref: 'pos', pen: 0, chain: 0, dense: 0, stick: 3, adv: true };
    default:
      throw new Error(`不是 (c) 的成員：${name}`);
  }
}

/**
 * 事後的敏感度分析成員（不在 (b)(c) 兩族裡，不參與 (b\*)(c\*) 的選擇；名字以 x- 開頭）：
 * 看讀對手的罰再加大會不會繼續單調變好（本檔雙胞胎表的趨勢外推），只用來標示機制。
 */
function ruleX(name: string): RuleC {
  switch (name) {
    case 'x-chain-pos16':
      return { ref: 'pos', pen: 16, chain: 0.5, dense: 0, stick: 3 };
    case 'x-chain-pos24':
      return { ref: 'pos', pen: 24, chain: 0.5, dense: 0, stick: 3 };
    default:
      throw new Error(`不是敏感度分析的成員：${name}`);
  }
}

// ---------------------------------------------------------------------------
// 機器
// ---------------------------------------------------------------------------

/**
 * 把規則變成控制器。`refOf` 回傳「對手在哪」的格子（或 null ＝ 不認為有人會搶）；
 * `penOf` 回傳這一刻的罰。(b) 與 (c) 唯一的差別就是這兩個函式從哪裡拿資料。
 */
function walker(
  rule: Rule & { readonly adv?: boolean },
  refOf: (state: DAState, side: Side) => number | null,
  penOf: (state: DAState, side: Side) => number,
): Controller<DAState> {
  let target: number | null = null;
  let heading: Dir | null = null;
  return {
    decide(state: DAState, side: Side): Buttons {
      if (state.over || rule.stay === true) {
        return NONE;
      }
      const from = state.players[side].cell;
      // 站在金幣上的那一格不算目標（延遲時舊世界可能還有我剛撿的那一枚）。
      const coins = state.coins.filter((c) => c !== from);
      const dMe = bfsDistances(state.walls, from);
      const ref = refOf(state, side);
      const dRef = ref === null ? null : bfsDistances(state.walls, ref);
      const pen = penOf(state, side);
      let best = -1;
      let bestScore = Number.POSITIVE_INFINITY;
      let bestMine = UNREACHABLE;
      const scores = new Map<number, number>();
      for (const coin of coins) {
        const mine = dMe[coin] as number;
        if (mine >= UNREACHABLE) {
          continue;
        }
        let score = rule.far === true ? -mine : mine;
        if (rule.chain > 0) {
          const near = bfsDistances(state.walls, coin);
          let nearest = Number.POSITIVE_INFINITY;
          for (const o of coins) {
            if (o !== coin) {
              nearest = Math.min(nearest, near[o] as number);
            }
          }
          score += rule.chain * (Number.isFinite(nearest) ? nearest : 0);
        }
        if (rule.dense > 0) {
          let count = 0;
          for (const o of coins) {
            if (o !== coin && manhattan(o, coin) <= 7) {
              count += 1;
            }
          }
          score -= rule.dense * count;
        }
        if (dRef !== null) {
          const theirs = dRef[coin] as number;
          if (rule.adv === true) {
            score = mine - theirs;
          } else if (pen > 0 && theirs < mine) {
            score += pen;
          }
        }
        scores.set(coin, score);
        if (
          score < bestScore ||
          (score === bestScore &&
            (mine < bestMine || (mine === bestMine && rank(coin, side) < rank(best, side))))
        ) {
          best = coin;
          bestScore = score;
          bestMine = mine;
        }
      }
      if (best < 0) {
        target = null;
        return NONE;
      }
      const kept = target === null ? undefined : scores.get(target);
      if (kept === undefined || kept > bestScore + rule.stick) {
        target = best;
      }
      const dir = toward(state.walls, from, side, target as number, heading);
      heading = dir;
      return dir === null ? NONE : press(dir);
    },
  };
}

/** 一個成員的控制器（每次呼叫都是全新的）。 */
export function member(name: string): Controller<DAState> {
  if ((B_FAMILY as readonly string[]).includes(name)) {
    const rule = ruleB(name);
    return walker(
      rule,
      // 「對手在哪」：對手的起點（地圖常數），不是它現在的位置。
      (_state, side) => (rule.ref === 'start' ? START_CELLS[other(side)] : null),
      () => rule.pen,
    );
  }
  const rule = name.startsWith('x-') ? ruleX(name) : ruleC(name);
  return walker(
    rule,
    (state, side) => {
      const opp = state.players[other(side)];
      return rule.ref === 'next' ? nextCell(state.walls, opp) : opp.cell;
    },
    (state, side) => {
      if (rule.lead !== true) {
        return rule.pen;
      }
      const lead = state.players[side].score - state.players[other(side)].score;
      return lead >= 2 ? 16 : lead <= -2 ? 2 : rule.pen;
    },
  );
}

/**
 * 反應延遲：世界是 `delay` 個 tick 前的（對手、新出現的金幣都是舊的），自己的按鍵用 `game.step` 照原樣重播到現在
 * （對手當作沒動），所以自己的位置、撿過的金幣是現在的——和 AI 的 `wrapPolicy` 同一個語意，但這裡是自己的包裝，
 * 不是 `wrapPolicy`。注意：對手的待走方向在重播裡只會走掉一次（走格時），所以讀「對手鎖定方向」的成員在延遲格幾乎是惰性的。
 */
export function withDelay<S>(inner: Controller<S>, delay: number, game: Game<S>): Controller<S> {
  if (delay <= 0) {
    return inner;
  }
  const states = new Map<number, S>();
  const outputs = new Map<number, Buttons>();
  return {
    decide(state: S, side: Side, tick: number): Buttons {
      states.set(tick, state);
      const from = Math.max(0, tick - delay);
      let view = states.get(from) ?? state;
      for (let k = from; k < tick && !game.isOver(view); k += 1) {
        const mine = outputs.get(k) ?? NONE;
        view = game.step(view, side === 0 ? [mine, NONE] : [NONE, mine]);
      }
      const out = { ...inner.decide(view, side, tick) };
      outputs.set(tick, out);
      states.delete(tick - delay - 1);
      outputs.delete(tick - delay - 1);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// 對局
// ---------------------------------------------------------------------------

/** 一格：AI 的性格、等級；玩家的反應延遲（tick）。 */
export interface Cell {
  readonly policy: PolicyKey;
  readonly level: number;
  readonly delay: number;
}

export const MAIN_CELL: Cell = { policy: 'greedy', level: 10, delay: 12 };

/** 玩家（`ctl`）對 AI 跑一場；偶數種子玩家坐 0 號邊，奇數種子坐 1 號邊。 */
export function playWith(seed: number, ctl: Controller<DAState>, at: Cell): MatchOutcome {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const ai = levelController(dAGame, policyByName(at.policy), at.level, seed + AI_SEED_OFFSET);
  const mine = withDelay(ctl, at.delay, dAGame);
  const result =
    side === 0
      ? playMatch(dAGame, seed, CONFIG, mine, ai)
      : playMatch(dAGame, seed, CONFIG, ai, mine);
  return outcomeOf(result, side);
}

/**
 * D-A 的「一次決策」：每個走格週期的第一個 tick（上一次走格剛結算完、新的方向還沒按）。
 * 玩家每個走格週期選一次方向，其餘 4 個 tick 是同一個決定的重複。
 */
export const isPoint: IsPoint<DAState> = (state) => state.tick % MOVE_EVERY === 0;

/** 把兩個成員接成一份 `ProbeSpec`。 */
export function spec(
  b: string,
  c: string,
  seeds: readonly number[],
  at: Cell,
  withPoint = true,
): ProbeSpec<DAState> {
  return {
    makeB: () => member(b),
    makeC: () => member(c),
    seeds,
    play: (seed, ctl) => playWith(seed, ctl, at),
    isPoint: withPoint ? isPoint : undefined,
  };
}

// ---------------------------------------------------------------------------
// 選法
// ---------------------------------------------------------------------------

export interface Row {
  readonly name: string;
  /** 勝率（0 到 1，和局 0.5）。 */
  readonly win: number;
  /** 平均分差（我方 − AI）。 */
  readonly margin: number;
}

/** 一個成員在一組種子上的勝率與平均分差。 */
export function score(name: string, seeds: readonly number[], at: Cell): Row {
  let win = 0;
  let margin = 0;
  for (const seed of seeds) {
    const o = playWith(seed, member(name), at);
    win += o.win;
    margin += o.margin;
  }
  return { name, win: win / seeds.length, margin: margin / seeds.length };
}

/**
 * 選最強的（量之前固定的規則）：勝率最高；同勝率取平均分差高的；再同就取表中靠前的。
 * 「同」比較的是四捨五入到 1e-9 之後的值，免得浮點誤差破平。
 */
export function selectBest(rows: readonly Row[]): Row {
  let best = rows[0] as Row;
  const eq = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
  for (const row of rows.slice(1)) {
    if (row.win > best.win + 1e-9 || (eq(row.win, best.win) && row.margin > best.margin + 1e-9)) {
      best = row;
    }
  }
  return best;
}
