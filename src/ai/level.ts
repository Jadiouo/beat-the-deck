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
 * （延遲的語意見 `wrapPolicy`：世界是舊的、自己是現在的。）
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
  /** 自己在這個 tick 實際輸出的按鍵。 */
  output: Buttons;
}

const NEUTRAL: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};

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

/**
 * 僵局：世界（不算 tick 計數器）連續這麼多個 tick 都是「最近 STALL_WINDOW 個 tick 內出現過的樣子」，
 * 就算僵局。60 個 tick ＝ 1 秒。不是只比前一個 tick：頂著牆按方向鍵時，遊戲內部的計時會每幾個 tick
 * 來回跳一次（D-7 是移動週期的 pending），世界其實沒有前進，只是在原地繞一個很短的圈。
 */
export const STALL_TICKS = 60;
/** 往回看多少個 tick 找「出現過的樣子」。要比遊戲內部的週期長（120 能被 1 到 6、8、10、12 等整除）。 */
export const STALL_WINDOW = 120;
/** 偵測到僵局之後，接下來這麼多個 tick 都放下 danger 門檻，讓動作有時間走出幾格而不是走一步又退回去。 */
export const BOLD_TICKS = 90;

/** 世界的指紋：整個 state 的 JSON（`tick` 設成 0）再壓成兩條 32 位元雜湊加長度。state 是純資料，所以可以 JSON 化。 */
function worldFingerprint(state: unknown): string {
  const text = JSON.stringify(
    typeof state === 'object' && state !== null ? { ...state, tick: 0 } : state,
  );
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${text.length}`;
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
 * - **反應延遲**：延遲的是「對世界變化的反應」，不是「自己在哪裡」。性格看到的是 reactionTicks
 *   個 tick 以前的世界（對手、新出現的東西都是舊的），再把「自己這段時間輸出過的按鍵」用
 *   `game.step` 照原樣重播到現在（對手當作沒動）：自己的位置是現在的。
 *   人的 200 毫秒反應是看到現在的畫面、手慢一點；舊做法直接餵 t − reactionTicks 的舊 state，
 *   格子世界裡自己的位置也是舊的，延遲一旦跨過一個移動週期，就會從已經離開的格子算方向，導航失能。
 *   試過「性格看現在、決定延後生效」：回饋迴圈仍然會過衝震盪，同樣的斷崖，所以不用。
 *   不需要知道 state 的結構，也不動 core 的契約。
 *   t 還小於 reactionTicks 時，世界是起始 state，自己重播到現在。
 * - **僵局**：世界（不算 tick 計數器）連續 `STALL_TICKS` 個 tick 都只是重複最近 `STALL_WINDOW` 個 tick 內出現過的樣子，就在接下來 `BOLD_TICKS` 個 tick
 *   通知性格 `stalled`。這是從 state 的歷史算出來的，所以決定性與重播一致性都不變。
 * - **決定頻率**：第一個 tick 與之後每隔 decideEvery 個 tick 才重新決定，中間沿用上一個生效的按鍵。
 * - **亂選**：每次決定先擲一次骰，小於 epsilon 就從（現在這個 state 的）`actions()` 裡亂挑一個。
 *   epsilon = 0 時不擲骰，完全等於底層性格；epsilon = 1 時一定亂挑。
 * - **決定性**：骰子來自 `rngStateFor(seed, 邊)`，推進的狀態存在控制器裡。tick 回到 0（新的一場）
 *   就把歷史與亂數全部重設，所以同一個控制器重複用在多場上，每一場的結果都和新建的一樣。
 *
 * 這是有狀態的（要記歷史與目前的動作），所以每一場、每一邊都要用自己的控制器。
 * 只留最近 reactionTicks + 1 個 state（與各自的輸出），不是整場。
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
  let recent: string[] = [];
  let frozenFor = 0;
  let boldUntil = -1;

  /** 把最舊那筆 state 用自己輸出過的按鍵（對手放開）重播到現在。 */
  const believe = (side: Side): S => {
    const first = history[0] as Remembered<S>;
    let state = first.state;
    for (let i = 0; i < history.length - 1 && !game.isOver(state); i += 1) {
      const mine = (history[i] as Remembered<S>).output;
      state = game.step(state, side === 0 ? [mine, NEUTRAL] : [NEUTRAL, mine]);
    }
    return state;
  };

  const decideFrom = (seen: S, side: Side, tick: number): Buttons => {
    const policyParams = { depth: params.depth, seed, stalled: tick < boldUntil };
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
        recent = [];
        frozenFor = 0;
        boldUntil = -1;
        dice = rngStateFor(seed, `level-${side}`);
      } else if (history.length === 0) {
        dice = rngStateFor(seed, `level-${side}`);
      }
      lastTick = tick;

      // 僵局偵測：世界連續 STALL_TICKS 個 tick 沒變，接下來 BOLD_TICKS 個 tick 通知性格。
      if (policy.usesStall === true) {
        const fingerprint = worldFingerprint(state);
        frozenFor = recent.includes(fingerprint) ? frozenFor + 1 : 0;
        recent.push(fingerprint);
        if (recent.length > STALL_WINDOW) {
          recent.shift();
        }
        if (frozenFor >= STALL_TICKS) {
          boldUntil = tick + BOLD_TICKS;
        }
      }

      const entry: Remembered<S> = { tick, state, output: NEUTRAL };
      history.push(entry);
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
        const seen = params.reactionTicks === 0 ? state : believe(side);
        held = decideFrom(seen, side, tick);
        lastDecision = tick;
      }
      entry.output = held;
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
