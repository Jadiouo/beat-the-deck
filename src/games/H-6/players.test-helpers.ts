import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { copyButtons } from '../../core/match';
import { createRng } from '../../core/rng';
import type { Buttons, Controller, Side } from '../../core/types';
import { IDLE } from '../_hearts/logic';
import { BANK, h6Game, legalCols, moveValue, safeProb, WAIT } from './logic';
import type { Act, H6State, Move } from './logic';

/**
 * H-6 的劇本玩家與對局層量測（DESIGN-AI-FUN 5.2、10.4）。都是 Controller，只讀公開資訊（`known`、`claimed`、`history`、
 * 自己的位置與手上的分），不讀 `mines`、對手的 `pending`；不是 `logic.ts`，不在純度掃描範圍。
 * 亂數只來自種子。
 */

const KEYS: readonly Buttons[] = [
  { ...IDLE, left: true },
  { ...IDLE, up: true },
  { ...IDLE, right: true },
  { ...IDLE, down: true },
  { ...IDLE, a: true },
  { ...IDLE, b: true },
];

/** 這個玩家現在能選的動作：等、可以踏的欄、（有東西可存時）存分。 */
export function legalMoves(state: H6State, side: Side): Move[] {
  const moves: Move[] = [WAIT];
  for (const c of legalCols(state, side)) {
    moves.push(c as Move);
  }
  if (state.carry[side] > 0) {
    moves.push(BANK);
  }
  return moves;
}

/** 一回合選一個動作。`next` 是 [0, 1) 的亂數。 */
export type Chooser = (state: H6State, side: Side, next: () => number) => Move;

/** 劇本玩家：每回合在 choose 階段、還沒出手時決定一次並按下去。 */
export function scripted(choose: Chooser, seed: number): Controller<H6State> {
  const rng = createRng(seed * 7919 + 17);
  let decidedRound = -1;
  let picked: Move = WAIT;
  return {
    decide(state: H6State, side: Side): Buttons {
      if (state.phase !== 'choose' || state.pending[side] !== null) {
        return IDLE;
      }
      if (state.round !== decidedRound) {
        decidedRound = state.round;
        picked = choose(state, side, () => rng.next());
      }
      return KEYS[picked] as Buttons;
    },
  };
}

/**
 * 強：照這張牌自己的評估（`moveValue`）選最大的；與最大值差不到 1e-3 的動作（同安全率的欄）隨機挑一個，
 * 才不會跟 AI 走同一格同生同死（試過：沒有這一步，強玩家對等級 10 是 200 場全平手）。
 * 評估時把對手模型固定開著，消融開關只改 AI 那一側，不改玩家自己。
 */
export const strongChooser: Chooser = (state, side, next) => {
  const fixed: H6State = { ...state, model: true };
  const scored = legalMoves(state, side).map((m) => [m, moveValue(fixed, side, m)] as const);
  const top = Math.max(...scored.map((x) => x[1]));
  const near = scored.filter((x) => x[1] >= top - 1e-3).map((x) => x[0]);
  return near[Math.floor(next() * near.length)] as Move;
};

/** 弱：從所有合法動作均勻亂選。 */
export const uniformChooser: Chooser = (state, side, next) => {
  const moves = legalMoves(state, side);
  return moves[Math.floor(next() * moves.length)] as Move;
};

/** 人類型：每回合有 `eps` 的機率亂選，其餘照強玩家。 */
export function noisyChooser(eps: number): Chooser {
  return (state, side, next) =>
    next() < eps ? uniformChooser(state, side, next) : strongChooser(state, side, next);
}

/** 人類型（只看一步）：選這回合期望立即得分最大的。踏格 ＝ 安全率 · 獎勵 − (1 − 安全率) · 手上的分；存分 ＝ 手上的分；等 ＝ 流失。 */
export const oneStepChooser: Chooser = (state, side) => {
  const carry = state.carry[side];
  const row = state.row[side];
  const opp: Side = side === 0 ? 1 : 0;
  let best: Move = WAIT;
  let bestV = -Math.min(carry, state.decay);
  for (const m of legalMoves(state, side)) {
    let v: number;
    if (m === BANK) {
      v = carry;
    } else if (m === WAIT) {
      v = -Math.min(carry, state.decay);
    } else {
      const p = safeProb(state, row + 1, m);
      const second = state.claimed[row]?.[opp] === true;
      const reward = second && state.half ? Math.ceil((row + 1) / 2) : row + 1;
      v = p * reward - (1 - p) * carry;
    }
    if (v > bestV + 1e-12) {
      bestV = v;
      best = m;
    }
  }
  return best;
};

function knownSafeCol(state: H6State, side: Side): Move | null {
  const row = state.row[side] + 1;
  if (row > 6) {
    return null;
  }
  for (const c of legalCols(state, side)) {
    if (safeProb(state, row, c) === 1) {
      return c as Move;
    }
  }
  return null;
}

function bestOpenCol(state: H6State, side: Side): Move | null {
  const cols = legalCols(state, side);
  if (cols.length === 0) {
    return null;
  }
  const row = state.row[side] + 1;
  let best = cols[0] as number;
  let bestP = -1;
  for (let i = 0; i < cols.length; i += 1) {
    const c = cols[(i + state.round + side) % cols.length] as number;
    const p = safeProb(state, row, c);
    if (p > bestP) {
      bestP = p;
      best = c;
    }
  }
  return best as Move;
}

/** 寄生：手上的分 ≥ k 就存；只踏已公開的安全格，沒有就等。 */
export function parasiteChooser(k: number): Chooser {
  return (state, side) => {
    const carry = state.carry[side];
    if (carry >= k) {
      return BANK;
    }
    const c = knownSafeCol(state, side);
    if (c !== null) {
      return c;
    }
    if (state.row[side] >= 6) {
      return carry > 0 ? BANK : WAIT;
    }
    return WAIT;
  };
}

/** 餵了再破：前 `feed` 回合一律領頭（讓 AI 的 leadRate 認定你會領頭），之後改成寄生（等、跟隨、存分）。 */
export function feedThenBreakChooser(feed: number, k: number): Chooser {
  const rest = parasiteChooser(k);
  return (state, side, next) => {
    if (state.round < feed) {
      return bestOpenCol(state, side) ?? WAIT;
    }
    return rest(state, side, next);
  };
}

/** 反射式的「走到手上有 k 分就存」。 */
export function marchBankChooser(k: number): Chooser {
  return (state, side) => {
    const carry = state.carry[side];
    if (carry >= k) {
      return BANK;
    }
    const c = bestOpenCol(state, side);
    return c === null ? (carry > 0 ? BANK : WAIT) : c;
  };
}

/** 對手：預設性格（搜尋型）在某個等級。 */
export function aiController(level: number): (seed: number) => Controller<H6State> {
  return (seed) => levelController(h6Game, pathfinder, level, seed);
}

export interface Summary {
  /** 玩家的勝率（平手算半場）。 */
  readonly rate: number;
  /** 玩家與 AI 的平均總分。 */
  readonly meanPlayer: number;
  readonly meanAi: number;
  /** 每場一個簽章：所有 tick 的輸入序列的雜湊加最後比分。 */
  readonly signatures: readonly string[];
  /** 兩邊同一回合都在等的回合比例。 */
  readonly bothWaitShare: number;
}

function buttonCode(b: Buttons): number {
  return (
    (b.up ? 1 : 0) |
    (b.down ? 2 : 0) |
    (b.left ? 4 : 0) |
    (b.right ? 8 : 0) |
    (b.a ? 16 : 0) |
    (b.b ? 32 : 0)
  );
}

/**
 * 玩家（種子奇偶決定坐哪邊，與 `winRate` 相同）對 AI，每個種子打一場。
 * `params` 是 `config.params`（消融開關 half、decay、model）。
 */
export function playSeeds(
  makePlayer: (seed: number) => Controller<H6State>,
  makeAi: (seed: number) => Controller<H6State>,
  seeds: readonly number[],
  params: Readonly<Record<string, number>>,
): Summary {
  let points = 0;
  let playerTotal = 0;
  let aiTotal = 0;
  let bothWait = 0;
  let rounds = 0;
  const signatures: string[] = [];
  for (const seed of seeds) {
    const mine: Side = seed % 2 === 0 ? 0 : 1;
    const player = makePlayer(seed);
    const ai = makeAi(seed + 1_000_003);
    const controllers = mine === 0 ? [player, ai] : [ai, player];
    let state = h6Game.init(seed, { maxTicks: 3600, params });
    let hash = 2166136261;
    let tick = 0;
    while (!h6Game.isOver(state)) {
      const i0 = copyButtons((controllers[0] as Controller<H6State>).decide(state, 0, tick));
      const i1 = copyButtons((controllers[1] as Controller<H6State>).decide(state, 1, tick));
      hash = Math.imul(hash ^ (buttonCode(i0) * 64 + buttonCode(i1)), 16777619) >>> 0;
      state = h6Game.step(state, [i0, i1]);
      tick += 1;
    }
    const winner = h6Game.winner(state);
    points += winner === null ? 0.5 : winner === mine ? 1 : 0;
    playerTotal += state.totals[mine];
    aiTotal += state.totals[mine === 0 ? 1 : 0];
    signatures.push(`${hash}:${state.totals[0]}-${state.totals[1]}`);
    for (const round of state.history) {
      rounds += 1;
      if (round[0] === 'wait' && round[1] === 'wait') {
        bothWait += 1;
      }
    }
  }
  const n = seeds.length;
  return {
    rate: points / n,
    meanPlayer: playerTotal / n,
    meanAi: aiTotal / n,
    signatures,
    bothWaitShare: rounds === 0 ? 0 : bothWait / rounds,
  };
}

export interface HistoryProbe {
  /** AI 一共做了幾次決定（每回合開頭一次）。 */
  readonly decisions: number;
  /** 把玩家的歷史換成別的之後，AI 的最佳動作（`moveValue` 最大）真的變了幾次。 */
  readonly flips: number;
  /** 歷史讓「等」的價值有變動的決定點數（證明歷史有接進數字）。 */
  readonly waitValueMoved: number;
}

/**
 * 真實對局（玩家對等級 10）裡，AI 每回合開頭的決定點：把玩家（對手）過去的動作換成全領頭、全等、全存分、全跟隨，
 * 看 AI 的最佳動作會不會變。AI 的決定在公開之後的局面是 `moveValue` 的最大值（`evaluateH6` 的 resolve），所以拿它當 AI 的選擇。
 */
export function counterfactualHistories(chooser: Chooser, seeds: readonly number[]): HistoryProbe {
  let decisions = 0;
  let flips = 0;
  let waitValueMoved = 0;
  for (const seed of seeds) {
    const aiSide: Side = seed % 2 === 0 ? 1 : 0;
    const me: Side = aiSide === 0 ? 1 : 0;
    const controllers: Controller<H6State>[] = [];
    controllers[me] = scripted(chooser, seed);
    controllers[aiSide] = aiController(10)(seed + 1_000_003);
    let state = h6Game.init(seed, { maxTicks: 3600, params: {} });
    let tick = 0;
    let probedRound = -1;
    while (!h6Game.isOver(state)) {
      if (
        state.phase === 'choose' &&
        state.round !== probedRound &&
        state.pending[aiSide] === null
      ) {
        probedRound = state.round;
        const ranked = (history: H6State['history']): [Move, number][] => {
          const s: H6State = { ...state, history };
          return legalMoves(s, aiSide)
            .map((m) => [m, moveValue(s, aiSide, m)] as [Move, number])
            .sort((a, b) => b[1] - a[1]);
        };
        const replaced = (act: Act): H6State['history'] =>
          state.history.map((r) => {
            const x: [Act, Act] = [r[0], r[1]];
            x[me] = act;
            return x;
          });
        const base = ranked(state.history);
        const best = (base[0] as [Move, number])[1];
        const baseWait = base.find((x) => x[0] === WAIT)?.[1] ?? 0;
        decisions += 1;
        let moved = false;
        for (const act of ['lead', 'wait', 'bank', 'follow'] as const) {
          const alt = ranked(replaced(act));
          const altBest = (alt[0] as [Move, number])[1];
          const baseMoveValue = alt.find((x) => x[0] === (base[0] as [Move, number])[0])?.[1] ?? 0;
          if (altBest - baseMoveValue > 1e-9) {
            flips += 1;
            break;
          }
          if (Math.abs((alt.find((x) => x[0] === WAIT)?.[1] ?? 0) - baseWait) > 1e-9) {
            moved = true;
          }
        }
        if (moved && best >= baseWait) {
          waitValueMoved += 1;
        }
      }
      const i0 = copyButtons((controllers[0] as Controller<H6State>).decide(state, 0, tick));
      const i1 = copyButtons((controllers[1] as Controller<H6State>).decide(state, 1, tick));
      state = h6Game.step(state, [i0, i1]);
      tick += 1;
    }
  }
  return { decisions, flips, waitValueMoved };
}
