import { humanModel } from '../../ai/human-model';
import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, GameConfig, Side } from '../../core/types';
import {
  BUY,
  CASH,
  FEE,
  GOODS,
  IDLE,
  PASS,
  ROUNDS,
  SELL,
  TRADE_BUTTONS,
  d6Game,
  otherSide,
  priceOf,
} from './logic';
import type { D6State, Trade } from './logic';

/**
 * D-6 的劇本玩家與量測工具（DESIGN-AI-FUN 5.2、10.35、10.54）。都不是 `logic.ts`，不在純度掃描範圍。
 *
 * 劇本玩家是固定規則的 Controller，只看 state（完整資訊，沒有反應延遲：choose 一開始就出手）；
 * 都不用 AI 的 `evaluate`（除了明說是「同一個引擎、拿掉一部分資訊」的 `engine`），規則寫在這裡，人腦做得到。
 *
 * 探針 A 的三組（對等級 10 的搜尋型，**定義在量之前固定**）：
 * - (a) 不知道有對手：`oracle`——已知整條曲線的單人最佳規劃（動態規劃），不看對手、也不算自己的買賣會推價；
 *   眼前這一手用真實價格，未來用曲線。
 * - (b) 知道價格是共用的、不讀它的狀態：`engine('noModel')`——等級 10 搜尋型，`evaluate` 看到的 `model` 設成 false：
 *   仍然算自己的買賣對下一回合價格的推力、看得到現在的價格（裡面已經有對手過去推的），但不用對手的存貨、
 *   不用歷史、不算對手手上存貨的價值。
 * - (c) 讀它的狀態：`engine('reads')`——AI 自己的引擎（鏡像：與對手完全相同，所以對打是一場場平手）。
 */

export type Make = (seed: number) => Controller<D6State>;
export type Script = (state: D6State, side: Side) => Trade;

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };

export function sameButtons(a: Buttons, b: Buttons): boolean {
  return (
    a.up === b.up &&
    a.down === b.down &&
    a.left === b.left &&
    a.right === b.right &&
    a.a === b.a &&
    a.b === b.b
  );
}

/** 動作編號對應的按鍵；合法才回傳，不合法回傳 `null`。 */
function legalButtons(state: D6State, side: Side, trade: Trade): Buttons | null {
  const want = TRADE_BUTTONS[trade] as Buttons;
  return d6Game.actions(state, side).some((a) => sameButtons(a, want)) ? want : null;
}

/** 把腳本變成控制器：choose 階段、自己還沒鎖定時立刻出手；非法的動作改成不動。 */
export function scripted(script: Script): Controller<D6State> {
  return {
    decide(state, side) {
      if (state.phase !== 'choose' || state.pending[side] !== null) {
        return IDLE;
      }
      return legalButtons(state, side, script(state, side)) ?? (TRADE_BUTTONS[PASS] as Buttons);
    },
  };
}

export const S =
  (script: Script): Make =>
  () =>
    scripted(script);

// ---------------------------------------------------------------------------
// AI 與消融（同一個引擎，拿掉一部分資訊）
// ---------------------------------------------------------------------------

type Tweak = (state: D6State, side: Side) => D6State;

function withEvaluate(tweak: Tweak): typeof d6Game {
  return { ...d6Game, evaluate: (s, side) => d6Game.evaluate(tweak(s, side), side) };
}

const GAMES = {
  reads: d6Game,
  /** (b)：不讀對手（`model` 關掉）。 */
  noModel: withEvaluate((s) => ({ ...s, model: false })),
  /** 只拿掉歷史（習慣）。 */
  hideHistory: withEvaluate((s) => ({ ...s, history: [] })),
  /** 只拿掉對手的存貨（它在囤什麼）。 */
  hideStock: withEvaluate((s, side) => ({
    ...s,
    inv: s.inv.map((v, i) => (i === side ? v : [0, 0, 0])),
  })),
} as const;

export type EngineKind = keyof typeof GAMES;

/** 搜尋型引擎，等級 `level`（預設 10）。`kind` 決定它看得到多少對手的資訊。 */
export function engine(kind: EngineKind, level = 10): Make {
  return (seed) => levelController(GAMES[kind], pathfinder, level, seed);
}

export const L10 = engine('reads', 10);
export const HUMAN: Make = (seed) => humanModel(d6Game, seed);

// ---------------------------------------------------------------------------
// 對打
// ---------------------------------------------------------------------------

export interface Batch {
  /** A 的勝率（平手算半場）。 */
  readonly rate: number;
  /** A 平均現金 − B 平均現金。 */
  readonly diff: number;
  readonly cashA: number;
  readonly cashB: number;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  /** 每場的 tick 數。 */
  readonly ticks: readonly number[];
}

/** A 對 B，種子 `seeds`；偶數種子 A 坐 0 號邊（邊輪流）。 */
export function batch(
  a: Make,
  b: Make,
  seeds: readonly number[],
  config: GameConfig = CONFIG,
): Batch {
  let points = 0;
  let cashA = 0;
  let cashB = 0;
  let wins = 0;
  let ties = 0;
  let losses = 0;
  const ticks: number[] = [];
  for (const seed of seeds) {
    const sideA: Side = seed % 2 === 0 ? 0 : 1;
    const ca = a(seed);
    const cb = b(seed + 1_000_003);
    const r =
      sideA === 0
        ? playMatch(d6Game, seed, config, ca, cb)
        : playMatch(d6Game, seed, config, cb, ca);
    const point = r.winner === null ? 0.5 : r.winner === sideA ? 1 : 0;
    points += point;
    cashA += r.score[sideA];
    cashB += r.score[otherSide(sideA)];
    ticks.push(r.ticks);
    if (point === 1) {
      wins += 1;
    } else if (point === 0) {
      losses += 1;
    } else {
      ties += 1;
    }
  }
  const n = seeds.length;
  return {
    rate: points / n,
    diff: (cashA - cashB) / n,
    cashA: cashA / n,
    cashB: cashB / n,
    wins,
    ties,
    losses,
    ticks,
  };
}

export const seeds = (n: number, from = 0): number[] =>
  Array.from({ length: n }, (_v, i) => from + i);

// ---------------------------------------------------------------------------
// 劇本玩家
// ---------------------------------------------------------------------------

const CAP = 6;
const IDX = (r: number, a: number, b: number, c: number): number =>
  ((r * (CAP + 1) + a) * (CAP + 1) + b) * (CAP + 1) + c;
const dpCache = new WeakMap<object, Float64Array>();

/** 單人最佳規劃：已知曲線、不計偏移；V[r][存貨] ＝ 從第 r 回合開始最多還能賺多少現金。 */
function planTable(base: readonly (readonly number[])[]): Float64Array {
  const hit = dpCache.get(base);
  if (hit !== undefined) {
    return hit;
  }
  const V = new Float64Array((ROUNDS + 1) * (CAP + 1) ** 3);
  for (let r = ROUNDS - 1; r >= 0; r -= 1) {
    for (let a = 0; a <= CAP; a += 1) {
      for (let b = 0; b <= CAP; b += 1) {
        for (let c = 0; c <= CAP; c += 1) {
          const inv = [a, b, c];
          let best = V[IDX(r + 1, a, b, c)] as number;
          for (let g = 0; g < GOODS; g += 1) {
            const p = (base[g] as readonly number[])[r] as number;
            if ((inv[g] as number) < CAP) {
              const n = [...inv];
              n[g] = (n[g] as number) + 1;
              best = Math.max(
                best,
                -(p + FEE) +
                  (V[IDX(r + 1, n[0] as number, n[1] as number, n[2] as number)] as number),
              );
            }
            if ((inv[g] as number) > 0) {
              const n = [...inv];
              n[g] = (n[g] as number) - 1;
              best = Math.max(
                best,
                Math.max(1, p - FEE) +
                  (V[IDX(r + 1, n[0] as number, n[1] as number, n[2] as number)] as number),
              );
            }
          }
          V[IDX(r, a, b, c)] = best;
        }
      }
    }
  }
  dpCache.set(base, V);
  return V;
}

/** 單人最佳規劃的現金增加量（不計偏移、不計對手）：這張曲線的上限。 */
export function soloOptimum(base: readonly (readonly number[])[]): number {
  return (planTable(base) as Float64Array)[IDX(0, 0, 0, 0)] as number;
}

/** (a)：單人最佳規劃玩家。眼前這一手用真實價格（含偏移），未來用曲線。 */
export const oracle: Script = (s, side) => {
  const V = planTable(s.base);
  const inv = s.inv[side] as readonly number[];
  const r = s.round;
  let best: Trade = PASS;
  let bestValue = V[IDX(r + 1, inv[0] as number, inv[1] as number, inv[2] as number)] as number;
  for (let g = 0; g < GOODS; g += 1) {
    const p = priceOf(s, g);
    if ((inv[g] as number) < CAP && (s.cash[side] as number) >= p + FEE) {
      const n = [...inv];
      n[g] = (n[g] as number) + 1;
      const v =
        -(p + FEE) + (V[IDX(r + 1, n[0] as number, n[1] as number, n[2] as number)] as number);
      if (v > bestValue + 1e-9) {
        bestValue = v;
        best = BUY(g);
      }
    }
    if ((inv[g] as number) > 0) {
      const n = [...inv];
      n[g] = (n[g] as number) - 1;
      const v =
        Math.max(1, p - FEE) +
        (V[IDX(r + 1, n[0] as number, n[1] as number, n[2] as number)] as number);
      if (v > bestValue + 1e-9) {
        bestValue = v;
        best = SELL(g);
      }
    }
  }
  return best;
};

/** 手寫的「照曲線」：價格 ≤ 9 買（離旺季 2 到 8 回合、存貨不超過 5 件與剩餘回合）、價格 ≥ 12 賣。 */
export const curve: Script = (s, side) => {
  const inv = s.inv[side] as readonly number[];
  const r = s.round;
  let sellGood = -1;
  let sellPrice = -1;
  for (let g = 0; g < GOODS; g += 1) {
    if ((inv[g] as number) > 0 && priceOf(s, g) >= 12 && priceOf(s, g) > sellPrice) {
      sellGood = g;
      sellPrice = priceOf(s, g);
    }
  }
  if (sellGood >= 0) {
    return SELL(sellGood);
  }
  const total = (inv[0] as number) + (inv[1] as number) + (inv[2] as number);
  if (total >= ROUNDS - r - 2 || total >= 5) {
    return PASS;
  }
  let buyGood = -1;
  let buyPrice = 99;
  for (let g = 0; g < GOODS; g += 1) {
    const row = s.base[g] as readonly number[];
    const peak = row.indexOf(Math.max(...row));
    const p = priceOf(s, g);
    if (
      p <= 9 &&
      peak - r >= 2 &&
      peak - r <= 8 &&
      p < buyPrice &&
      (s.cash[side] as number) >= p + FEE
    ) {
      buyPrice = p;
      buyGood = g;
    }
  }
  return buyGood >= 0 ? BUY(buyGood) : PASS;
};

/** 買了下一回合就賣：偶數回合買穀、奇數回合賣穀。 */
export const roundTrip: Script = (s) => (s.round % 2 === 0 ? BUY(0) : SELL(0));

/** 永遠買布（買不起就不動）。 */
export const alwaysBuyCloth: Script = () => BUY(1);

/** 跟風：對手上一回合做什麼我也做什麼。 */
export const follower: Script = (s, side) => {
  const last = s.history[s.history.length - 1];
  return last === undefined ? PASS : (last[otherSide(side)] as Trade);
};

/** 刻意抬價再出貨：挑還沒過峰值的最早峰值那種貨，峰值前 k 回合起連買、峰值起連賣，其餘賣光。 */
export function pump(k: number): Script {
  return (s, side) => {
    const r = s.round;
    const inv = s.inv[side] as readonly number[];
    let good = -1;
    let peakRound = 99;
    for (let g = 0; g < GOODS; g += 1) {
      const row = s.base[g] as readonly number[];
      const peak = row.indexOf(Math.max(...row));
      if (peak >= r && peak < peakRound) {
        peakRound = peak;
        good = g;
      }
    }
    if (good < 0) {
      for (let g = 0; g < GOODS; g += 1) {
        if ((inv[g] as number) > 0) {
          return SELL(g);
        }
      }
      return PASS;
    }
    if (r >= peakRound - k && r < peakRound) {
      return BUY(good);
    }
    if (r >= peakRound && (inv[good] as number) > 0) {
      return SELL(good);
    }
    return PASS;
  };
}

/** 抬了就賣（極端版）：連買 k 回合、再連賣 k 回合，整局重複（每輪換一種貨）。 */
export function pumpDumpCycle(k: number): Script {
  return (s) => {
    const g = Math.floor(s.round / (2 * k)) % GOODS;
    return s.round % (2 * k) < k ? BUY(g) : SELL(g);
  };
}

/** 均勻亂選合法動作（xorshift，種子決定）。 */
export const uniform: Make = (seed) => {
  let x = (seed * 2654435761) >>> 0 || 1;
  const next = (): number => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
  return {
    decide(state, side) {
      if (state.phase !== 'choose' || state.pending[side] !== null) {
        return IDLE;
      }
      const acts = d6Game.actions(state, side);
      return acts[Math.floor(next() * acts.length)] as Buttons;
    },
  };
};

/**
 * 餵了再破：第 `from` 回合起連續 `k` 回合買進「餵完之後旺季最高」的貨；`dump` 為真就接著連賣 `k` 回合；
 * 其餘照 `base` 控制器。第二欄與第四欄的量法（小規格「第 10.3 節的四欄」）。
 */
export function withFeint(base: Make, from: number, k: number, dump: boolean): Make {
  return (seed) => {
    const inner = base(seed);
    return {
      decide(state, side, tick) {
        const normal = inner.decide(state, side, tick);
        if (state.phase !== 'choose' || state.pending[side] !== null) {
          return normal;
        }
        const r = state.round;
        let good = 0;
        let best = -1;
        for (let g = 0; g < GOODS; g += 1) {
          const v = (state.base[g] as readonly number[])[
            Math.min(ROUNDS - 1, from + k + 2)
          ] as number;
          if (v > best) {
            best = v;
            good = g;
          }
        }
        if (r >= from && r < from + k) {
          return legalButtons(state, side, BUY(good)) ?? normal;
        }
        if (dump && r >= from + k && r < from + 2 * k) {
          return legalButtons(state, side, SELL(good)) ?? normal;
        }
        return normal;
      },
    };
  };
}

/** 不讀對手的基準玩家（餵了再破的底）：等級 10 搜尋型、`model` 關掉。 */
export const H0: Make = engine('noModel', 10);

/** 起始現金（讓測試不用再 import）。 */
export const START_CASH = CASH;
