import { levelController, policyByName } from '../../ai/level';
import { precise } from '../../ai/policies/precise';
import { createRng } from '../../core/rng';
import type { Buttons, Game, Side } from '../../core/types';
import type { PolicyKey } from '../../ai/types';
import { actionsSpades } from '../_spades/logic';
import { CLEAR_CAP, CLEARS, canClear, dangerOf, opponentPressChance, s10Game } from './logic';
import type { S10State } from './logic';
import { pressDecision, wantsPress } from './players.test-helpers';

/**
 * S-10 探針 A 重做的量測工具（`docs/cards/S-10.md`「探針 A 重做」；DESIGN-AI-FUN 10.54、10.59、10.61）。
 * 這個檔案只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。
 *
 * - (b) 族：知道有對手存在，但不讀對手的任何狀態。
 * - (c) 族：讀對手的公開狀態；不用 AI 的評估函式與對手預測函式，也不拿 AI 的控制器當成員。
 * - (d)：上限（讀 AI 的規則、按鍵時刻掃描），不是 (c)。
 *
 * 所有玩家的**移動**都一樣（精準型、depth 1、看完整的現在畫面），只差「這個 tick 要不要按 b」。
 */

export const B_FAMILY = [
  'b-habit',
  'b-hlow',
  'b-hhigh',
  'b-wait1',
  'b-wait3',
  'b-wait10',
  'b-wait30',
  'b-dense16',
  'b-dense24',
  'b-dense32',
  'b-prob25',
  'b-selfdanger',
] as const;

export const C_FAMILY = [
  'c-reader',
  'c-expfull',
  'c-oppdanger',
  'c-lock',
  'c-lead',
  'c-oppinvuln',
  'c-learn',
  'c-wait-opp-far',
] as const;

export interface PressRule {
  /** 這一邊在這個 tick 按不按 b。每個 tick 都要呼叫（規則自己會記準備時刻與對手過去的按法）。 */
  press(state: S10State, side: Side, tick: number): boolean;
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const count = (state: S10State): number => Math.min(state.bullets.length, CLEAR_CAP);

/** 準備時刻追蹤：回傳「準備後第幾個 tick」（準備好的第一個 tick 是 0），還沒準備好是 −1。 */
function readyTracker(): { waited(state: S10State, side: Side, tick: number): number; since(): number | null } {
  let since: number | null = null;
  return {
    waited(state, side, tick): number {
      if (!canClear(state) || state.lock[side] !== 0) {
        since = null;
        return -1;
      }
      if (since === null) {
        since = tick;
      }
      return tick - since;
    },
    since: () => since,
  };
}

/** 用 `holdValue` 的尺（與 AI 同一把尺），h 由呼叫者給。 */
const byScale = (state: S10State, h: number): boolean => wantsPress(state, h);

export function makeRule(name: string, seed: number): PressRule {
  const ready = readyTracker();
  const dice = createRng(seed).fork('s10-probe-a-prob');

  const waitRule = (k: number): PressRule => ({
    press: (state, side, tick) => ready.waited(state, side, tick) >= k,
  });
  const denseRule = (limit: number): PressRule => ({
    press: (state, side, tick) => ready.waited(state, side, tick) >= 0 && count(state) >= limit,
  });
  const scaleRule = (h: number): PressRule => ({
    press: (state, side, tick) => ready.waited(state, side, tick) >= 0 && byScale(state, h),
  });

  switch (name) {
    case 'absent':
      return scaleRule(0);
    case 'b-habit':
      return scaleRule(0.5);
    case 'b-hlow':
      return scaleRule(0.2);
    case 'b-hhigh':
      return scaleRule(0.9);
    case 'b-wait1':
      return waitRule(1);
    case 'b-wait3':
      return waitRule(3);
    case 'b-wait10':
      return waitRule(10);
    case 'b-wait30':
      return waitRule(30);
    case 'b-dense16':
      return denseRule(16);
    case 'b-dense24':
      return denseRule(24);
    case 'b-dense32':
      return denseRule(32);
    case 'b-prob25':
      return {
        press(state, side, tick): boolean {
          if (ready.waited(state, side, tick) < 0) {
            return false;
          }
          return dice.next() < 0.25;
        },
      };
    case 'b-selfdanger':
      return {
        press(state, side, tick): boolean {
          const w = ready.waited(state, side, tick);
          return w >= 0 && (dangerOf(state, side) >= 0.2 || w >= 15);
        },
      };
    case 'c-reader':
      return {
        press(state, side, tick): boolean {
          return (
            ready.waited(state, side, tick) >= 0 &&
            byScale(state, opponentPressChance(state.exposure[other(side)]))
          );
        },
      };
    case 'c-expfull':
      return {
        press(state, side, tick): boolean {
          if (ready.waited(state, side, tick) < 0) {
            return false;
          }
          return byScale(state, 0.2 + 0.7 * clamp(state.exposure[other(side)] / 0.01, 0, 1));
        },
      };
    case 'c-oppdanger':
      return {
        press(state, side, tick): boolean {
          if (ready.waited(state, side, tick) < 0) {
            return false;
          }
          return byScale(state, 0.5 + 0.4 * dangerOf(state, other(side)));
        },
      };
    case 'c-lock':
      return {
        press(state, side, tick): boolean {
          const w = ready.waited(state, side, tick);
          if (w < 0) {
            return false;
          }
          if (state.lock[other(side)] > 0) {
            return count(state) >= 24 || w >= 60;
          }
          return byScale(state, 0.5);
        },
      };
    case 'c-lead':
      return {
        press(state, side, tick): boolean {
          if (ready.waited(state, side, tick) < 0) {
            return false;
          }
          const lead = state.cleared[side] - state.cleared[other(side)];
          return byScale(state, lead >= 12 ? 0.2 : 0.5);
        },
      };
    case 'c-oppinvuln':
      return {
        press(state, side, tick): boolean {
          const w = ready.waited(state, side, tick);
          return w >= (state.players[other(side)].invuln > 0 ? 3 : 0);
        },
      };
    case 'c-learn': {
      // 記對手上一次清場相對準備時刻晚了幾個 tick（同刻按是 0）；我自己單獨先按就不知道（null）。
      let previous: { clears: number; cleared: readonly [number, number]; tick: number; since: number } | null = null;
      let oppLag: number | null = null;
      return {
        press(state, side, tick): boolean {
          if (previous !== null && state.clears < previous.clears) {
            const o = other(side);
            oppLag = state.cleared[o] > previous.cleared[o] ? previous.tick - previous.since : null;
          }
          const w = ready.waited(state, side, tick);
          const since = ready.since();
          previous =
            since === null
              ? previous === null
                ? null
                : { ...previous, clears: state.clears, cleared: state.cleared, tick }
              : { clears: state.clears, cleared: state.cleared, tick, since };
          if (w < 0) {
            return false;
          }
          return oppLag !== null && oppLag >= 2 ? w >= oppLag - 1 : true;
        },
      };
    }
    case 'c-wait-opp-far':
      return {
        press(state, side, tick): boolean {
          const w = ready.waited(state, side, tick);
          const o = other(side);
          const calm = dangerOf(state, o) === 0 && state.exposure[o] === 0;
          return w >= (calm ? 6 : 0);
        },
      };
    case 'd-sniper':
      return {
        press: (state, side, tick) => ready.waited(state, side, tick) >= 0 && pressDecision('sniper', state, side),
      };
    default: {
      const sweep = /^d-sweep(\d+)$/.exec(name);
      if (sweep !== null) {
        // 第一次清場在準備後第 k 個 tick 才按，其餘照 b-habit。
        const k = Number(sweep[1]);
        return {
          press(state, side, tick): boolean {
            const w = ready.waited(state, side, tick);
            if (w < 0) {
              return false;
            }
            return state.clears === CLEARS ? w >= k : byScale(state, 0.5);
          },
        };
      }
      throw new RangeError(`不認得的規則 ${name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 對局：驅動者＋影子
// ---------------------------------------------------------------------------

const MOVES = actionsSpades();
const MOVE_GAME: Game<S10State> = { ...s10Game, actions: () => MOVES };
const TRAINING_SEED_OFFSET = 1_000_003;

export interface PairOptions {
  readonly level: number;
  readonly policy?: PolicyKey;
}

export interface PairResult {
  /** 玩家坐哪一邊。 */
  readonly side: Side;
  /** 驅動者這邊的結果：1 贏、0.5 平手、0 輸。 */
  readonly win: number;
  /** 玩家分數 − AI 分數。 */
  readonly margin: number;
  /** 決策點（按得下去的 tick）數。 */
  readonly points: number;
  /** 其中驅動者與影子要不要按不同的決策點數。 */
  readonly diffPoints: number;
  /** 第一個決定不同的 tick，沒有是 −1。 */
  readonly firstDiffTick: number;
  readonly hitsMe: number;
  readonly hitsAi: number;
  /** 每次清場：誰按的、按下去那一刻的子彈數、第幾個 tick。 */
  readonly clears: readonly { readonly who: 'me' | 'ai' | 'both'; readonly n: number; readonly tick: number }[];
}

/**
 * 驅動者 `driver` 真正操作對局；影子 `shadow` 在每個 tick 對同一個 state 回答但不被採用。
 * 偶數種子坐 0 號邊；AI 是 `policy`（預設精準型）的等級 `level`，種子是玩家種子 ＋ 1,000,003。
 * 驅動者是 (b*) 時，這就是真正的 (b) 對局，第一個分歧的 tick 就是 (b)、(c) 兩條對局真正分開的地方。
 */
export function playPair(driver: string, shadow: string, seed: number, options: PairOptions): PairResult {
  const { shadows, ...result } = playMulti(driver, [shadow], seed, options);
  return { ...result, ...(shadows[0] as ShadowStat) };
}

export interface ShadowStat {
  readonly points: number;
  readonly diffPoints: number;
  readonly firstDiffTick: number;
}

export interface MultiResult extends Omit<PairResult, keyof ShadowStat> {
  /** 每個影子各自的決策點與分歧（與 `shadows` 參數同順序）。 */
  readonly shadows: readonly ShadowStat[];
}

/** 同一場對局配多個影子（影子的回答不被採用，所以驅動者的對局與影子的數量無關）。 */
export function playMulti(driver: string, shadowNames: readonly string[], seed: number, options: PairOptions): MultiResult {
  const me: Side = seed % 2 === 0 ? 0 : 1;
  const opp = other(me);
  const drive = makeRule(driver, seed);
  const shades = shadowNames.map((n) => makeRule(n, seed));
  const stats = shadowNames.map(() => ({ points: 0, diffPoints: 0, firstDiffTick: -1 }));
  const ai = levelController(s10Game, policyByName(options.policy ?? 'precise'), options.level, seed + TRAINING_SEED_OFFSET);
  let state = s10Game.init(seed, { maxTicks: 3600, params: {} });
  const clears: { who: 'me' | 'ai' | 'both'; n: number; tick: number }[] = [];
  for (let tick = 0; !s10Game.isOver(state); tick += 1) {
    const pd = drive.press(state, me, tick);
    const decisionPoint = canClear(state) && state.lock[me] === 0;
    shades.forEach((shade, i) => {
      const ps = shade.press(state, me, tick);
      const stat = stats[i] as { points: number; diffPoints: number; firstDiffTick: number };
      if (decisionPoint) {
        stat.points += 1;
        if (pd !== ps) {
          stat.diffPoints += 1;
          if (stat.firstDiffTick < 0) {
            stat.firstDiffTick = tick;
          }
        }
      }
    });
    const move = precise.decide(MOVE_GAME, state, me, tick, { depth: 1, seed });
    const mine: Buttons = pd ? { ...move, b: true } : move;
    const theirs = ai.decide(state, opp, tick);
    const before = state;
    state = s10Game.step(state, me === 0 ? [mine, { ...theirs }] : [{ ...theirs }, mine]);
    if (state.clears < before.clears) {
      const mineGain = state.cleared[me] - before.cleared[me];
      const theirGain = state.cleared[opp] - before.cleared[opp];
      clears.push({
        who: mineGain > 0 && theirGain > 0 ? 'both' : mineGain > 0 ? 'me' : 'ai',
        n: Math.min(before.bullets.length, CLEAR_CAP),
        tick,
      });
    }
  }
  const winner = s10Game.winner(state);
  const [s0, s1] = s10Game.score(state);
  return {
    side: me,
    win: winner === null ? 0.5 : winner === me ? 1 : 0,
    margin: me === 0 ? s0 - s1 : s1 - s0,
    shadows: stats,
    hitsMe: state.players[me].hits,
    hitsAi: state.players[opp].hits,
    clears,
  };
}

// ---------------------------------------------------------------------------
// 統計
// ---------------------------------------------------------------------------

/** 同種子配對差 a − b 的平均與標準誤（樣本標準差 ÷ √n）。 */
export function pairedStats(a: readonly number[], b: readonly number[]): { mean: number; se: number } {
  const n = Math.min(a.length, b.length);
  if (n === 0) {
    return { mean: 0, se: 0 };
  }
  const d = Array.from({ length: n }, (_v, i) => (a[i] as number) - (b[i] as number));
  const mean = d.reduce((acc, x) => acc + x, 0) / n;
  if (n < 2) {
    return { mean, se: 0 };
  }
  const variance = d.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1);
  return { mean, se: Math.sqrt(variance / n) };
}

export interface TrainingRow {
  readonly name: string;
  readonly win: number;
  readonly margin: number;
}

/** 勝率高者；同勝率取分差高；再同取排在前面的。 */
export function selectBest(rows: readonly TrainingRow[]): string {
  let best = rows[0] as TrainingRow;
  for (const row of rows.slice(1)) {
    const dw = row.win - best.win;
    if (dw > 1e-9 || (Math.abs(dw) <= 1e-9 && row.margin - best.margin > 1e-9)) {
      best = row;
    }
  }
  return best.name;
}
