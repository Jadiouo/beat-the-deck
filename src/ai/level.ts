import { intFrom, nextFrom, rngStateFor } from '../core/rng';
import type { RngState } from '../core/rng';
import type { Buttons, Controller, Game, Side } from '../core/types';
import { gambler } from './policies/gambler';
import { greedy } from './policies/greedy';
import { pathfinder } from './policies/pathfinder';
import { precise } from './policies/precise';
import { random } from './policies/random';
import type { LevelParams, Policy, PolicyKey } from './types';

/**
 * 等級（SPEC 7.2）：把任何性格包成控制器，並控制「多強」。
 *
 * 所有東西都由 tick 數與種子決定，沒有時鐘、沒有 `Math` 的亂數。
 */

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 10;

/**
 * 所有等級共用的反應延遲：12 個 tick（0.2 秒），與人類模型（SPEC 7.3）相同。
 *
 * 為什麼不再隨等級下降：量測顯示等級的差別幾乎全部來自「看得比較快」（快而淺對慢而深在黑桃是
 * 99% 到 100%；人類模型對乒乓等級 5 是 52%、等級 7 是 1%），而不是「想得比較好」。
 * 延遲固定之後，等級的差別只能來自決定頻率、失誤率與搜尋深度。
 */
const REACTION_TICKS = 12;

/** 等級 1 與等級 10 的參數。中間等級在這兩端之間線性內插。 */
const AT_LEVEL_1: LevelParams = {
  reactionTicks: REACTION_TICKS,
  decideEvery: 12,
  depth: 1,
  epsilon: 0.25,
};
const AT_LEVEL_10: LevelParams = {
  reactionTicks: REACTION_TICKS,
  decideEvery: 1,
  depth: 6,
  epsilon: 0,
};

function lerpRound(from: number, to: number, level: number): number {
  return Math.round(from + ((to - from) * (level - MIN_LEVEL)) / (MAX_LEVEL - MIN_LEVEL));
}

/**
 * 等級 → 四個參數。reactionTicks 對所有等級都一樣；decideEvery、depth 線性內插後四捨五入成整數。
 * epsilon 是機率，不是整數，不取整：直接線性內插（等級 1 是 0.25、等級 10 是 0，每級少 0.25/9）。
 */
export function levelParams(level: number): LevelParams {
  if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new RangeError(`等級必須是 1 到 10 的整數，收到 ${String(level)}`);
  }
  return {
    reactionTicks: lerpRound(AT_LEVEL_1.reactionTicks, AT_LEVEL_10.reactionTicks, level),
    decideEvery: lerpRound(AT_LEVEL_1.decideEvery, AT_LEVEL_10.decideEvery, level),
    depth: lerpRound(AT_LEVEL_1.depth, AT_LEVEL_10.depth, level),
    epsilon: (AT_LEVEL_1.epsilon * (MAX_LEVEL - level)) / (MAX_LEVEL - MIN_LEVEL),
  };
}

/** 全域 AI 等級：每翻開 3 張牌加 1，上限 10（SPEC 7.2）。 */
export function globalLevel(revealedCount: number): number {
  const count = Math.max(0, Math.floor(revealedCount));
  return Math.min(MAX_LEVEL, MIN_LEVEL + Math.floor(count / 3));
}

/** 某張牌的實際等級 ＝ 夾在 1 到 10 的（全域等級 ＋ 這張牌的基礎等級 − 1）。 */
export function effectiveLevel(global: number, baseLevel: number): number {
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, global + baseLevel - 1));
}

const POLICIES: Readonly<Record<PolicyKey, Policy>> = {
  pathfinder,
  precise,
  greedy,
  gambler,
  random,
};

/** 用名字找性格（meta.defaultPolicy 的值，或 `random`）。 */
export function policyByName(name: PolicyKey): Policy {
  return POLICIES[name];
}

export interface WrapOptions {
  /**
   * true：亂選的時候排除「性格原本要按的」那個動作（人類模型的「按錯」一定是真的按錯）。
   * false（預設，SPEC 7.2 的 epsilon）：從所有動作裡均勻亂選，可能剛好選到對的。
   */
  readonly avoidIntended?: boolean;
}

/** 包裝後的控制器。`retainedStates` 只給測試看記憶體用。 */
export interface WrappedController<S> extends Controller<S> {
  retainedStates(): number;
}

interface Remembered<S> {
  readonly tick: number;
  readonly state: S;
}

function sameButtons(a: Buttons, b: Buttons): boolean {
  return (
    a.up === b.up &&
    a.down === b.down &&
    a.left === b.left &&
    a.right === b.right &&
    a.a === b.a &&
    a.b === b.b
  );
}

function checkParams(params: LevelParams): void {
  if (!Number.isInteger(params.reactionTicks) || params.reactionTicks < 0) {
    throw new RangeError(`reactionTicks 必須是 0 以上的整數，收到 ${String(params.reactionTicks)}`);
  }
  if (!Number.isInteger(params.decideEvery) || params.decideEvery < 1) {
    throw new RangeError(`decideEvery 必須是 1 以上的整數，收到 ${String(params.decideEvery)}`);
  }
  if (!Number.isFinite(params.depth) || params.depth < 1) {
    throw new RangeError(`depth 必須是 1 以上的數，收到 ${String(params.depth)}`);
  }
  if (!(params.epsilon >= 0 && params.epsilon <= 1)) {
    throw new RangeError(`epsilon 必須在 0 到 1 之間，收到 ${String(params.epsilon)}`);
  }
}

/**
 * 把一個性格包成控制器。
 *
 * - **反應延遲**：第 t 個 tick，性格看到的是第 t − reactionTicks 個 tick 的 state；
 *   t 還小於 reactionTicks 時看到的是起始 state。只留最近 reactionTicks + 1 個 state
 *   （最多 19 個），不是整場 3600 個。
 * - **決定頻率**：第一個 tick 與之後每隔 decideEvery 個 tick 才重新決定，中間回傳同一組按鍵。
 * - **亂選**：每次決定先擲一次骰，小於 epsilon 就從（看到的那個 state 的）`actions()` 裡亂挑一個。
 *   epsilon = 0 時不擲骰，完全等於底層性格；epsilon = 1 時一定亂挑。
 * - **決定性**：骰子來自 `rngStateFor(seed, 邊)`，推進的狀態存在控制器裡。tick 回到 0（新的一場）
 *   就把歷史與亂數全部重設，所以同一個控制器重複用在多場上，每一場的結果都和新建的一樣。
 *
 * 這是有狀態的（要記歷史與目前的動作），所以每一場、每一邊都要用自己的控制器。
 */
export function wrapPolicy<S>(
  game: Game<S>,
  policy: Policy,
  params: LevelParams,
  seed: number,
  options: WrapOptions = {},
): WrappedController<S> {
  checkParams(params);
  const avoidIntended = options.avoidIntended === true;
  const keep = params.reactionTicks + 1;

  let history: Remembered<S>[] = [];
  let held: Buttons | null = null;
  let lastDecision = 0;
  let lastTick = -1;
  let dice: RngState = 0;

  const decideFrom = (seen: S, side: Side, tick: number): Buttons => {
    const policyParams = { depth: params.depth, seed };
    if (params.epsilon > 0) {
      const [roll, afterRoll] = nextFrom(dice);
      dice = afterRoll;
      if (roll < params.epsilon) {
        const actions = game.actions(seen, side);
        if (!avoidIntended) {
          const [index, afterPick] = intFrom(dice, actions.length);
          dice = afterPick;
          return actions[index] as Buttons;
        }
        const intended = policy.decide(game, seen, side, tick, policyParams);
        const others = actions.filter((action) => !sameButtons(action, intended));
        if (others.length === 0) {
          return intended;
        }
        const [index, afterPick] = intFrom(dice, others.length);
        dice = afterPick;
        return others[index] as Buttons;
      }
    }
    return policy.decide(game, seen, side, tick, policyParams);
  };

  return {
    decide(state: S, side: Side, tick: number): Buttons {
      if (tick <= lastTick) {
        // 新的一場（或同一個 tick 被重複問）：重設。
        history = [];
        held = null;
        dice = rngStateFor(seed, `level-${side}`);
      } else if (history.length === 0) {
        dice = rngStateFor(seed, `level-${side}`);
      }
      lastTick = tick;

      history.push({ tick, state });
      // 把「已經夠舊」的丟掉：只要第二筆也已經是 tick − reactionTicks 或更早，第一筆就沒用了。
      while (
        history.length > 1 &&
        (history[1] as Remembered<S>).tick <= tick - params.reactionTicks
      ) {
        history.shift();
      }
      if (history.length > keep) {
        history.splice(0, history.length - keep);
      }

      if (held === null || tick - lastDecision >= params.decideEvery) {
        const seen = (history[0] as Remembered<S>).state;
        held = decideFrom(seen, side, tick);
        lastDecision = tick;
      }
      return { ...held };
    },
    retainedStates(): number {
      return history.length;
    },
  };
}

/** 等級 1 到 10 的控制器：`wrapPolicy` ＋ `levelParams`。 */
export function levelController<S>(
  game: Game<S>,
  policy: Policy,
  level: number,
  seed: number,
): WrappedController<S> {
  return wrapPolicy(game, policy, levelParams(level), seed);
}
