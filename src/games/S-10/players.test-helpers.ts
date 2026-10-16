import { precise } from '../../ai/policies/precise';
import { createRng } from '../../core/rng';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import { actionsSpades } from '../_spades/logic';
import {
  CLEAR_CAP,
  CLEAR_FROM,
  CLEARS,
  H_BASE,
  canClear,
  dangerOf,
  holdValue,
  opponentPressChance,
  s10Game,
  step,
} from './logic';
import type { S10State } from './logic';

/**
 * S-10 的劇本玩家（DESIGN-AI-FUN 5.2、10.4、10.24）。都是 Controller，只讀 state（完整資訊），
 * 不是 `logic.ts`，不在純度掃描範圍。移動的規則全部一樣（精準型、不看清場），只差「按清場的規則」，
 * 這樣兩個玩家之間的差只來自那一件事。
 *
 * - `absent`：把 AI 整個拿掉：按的規則假設沒有人會搶（h = 0），也不看 AI。
 * - `habit`：照習慣打：知道有人會搶（h = 底數），但不看 AI 現在在做什麼。
 * - `reader`：讀 AI 公開的險度（它貼著子彈的程度）：它快撐不住就會先按，我的 h 跟著升高。
 * - `sniper`：讀 AI 公開的決定規則（診斷用的上界）：如果 AI 下一個 tick 就會按，我現在先按。
 * - `feint(k)`：照習慣打，但在清場用掉 k 次之前，故意貼近子彈（又閃得開），讓 AI 讀到「你很險」。
 * - `masher`：一直按住 b，能按就按。
 * - `uniform`：每個 tick 從 `actions()` 均勻亂挑。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const MOVES = actionsSpades();
const other = (side: Side): Side => (side === 0 ? 1 : 0);

/** 沒有清場的遊戲：移動的決定一律用同一套。 */
const MOVE_GAME: Game<S10State> = { ...s10Game, actions: () => MOVES };

/** 現在按下去比再等好嗎（用 `h` 當「對手搶先按」的機率）。與 AI 的 evaluate 同一把尺。 */
export function wantsPress(state: S10State, h: number): boolean {
  if (!canClear(state)) {
    return false;
  }
  const n = Math.min(state.bullets.length, CLEAR_CAP);
  const post: S10State = { ...state, bullets: [], quiet: state.quietFor, clears: state.clears - 1 };
  return n + holdValue(post, post.clears, h) > holdValue(state, state.clears, h);
}

export type PressRule = 'absent' | 'habit' | 'reader' | 'sniper';

const hFrom = (state: S10State, side: Side): number => opponentPressChance(state.exposure[side]);

/** 這一邊在這個局面按不按。 */
export function pressDecision(rule: PressRule, state: S10State, side: Side): boolean {
  if (rule === 'absent') {
    return wantsPress(state, 0);
  }
  if (rule === 'habit') {
    return wantsPress(state, H_BASE);
  }
  if (rule === 'reader') {
    return wantsPress(state, hFrom(state, other(side)));
  }
  // 狙擊：AI 的規則是公開的；如果 AI 下一個 tick 就會按，我現在先按。
  const next = step(state, [NONE, NONE]);
  const hAi = hFrom(state, side);
  return wantsPress(state, 0) || wantsPress(state, hAi) || wantsPress(next, hAi);
}

const asInputs = (move: Buttons, side: Side): [Buttons, Buttons] =>
  side === 0 ? [move, NONE] : [NONE, move];

export function player(rule: PressRule, seed: number): Controller<S10State> {
  return {
    decide(state: S10State, side: Side, tick: number): Buttons {
      const move = precise.decide(MOVE_GAME, state, side, tick, { depth: 1, seed });
      return pressDecision(rule, state, side) ? { ...move, b: true } : move;
    },
  };
}

/** 離最近的一顆子彈的距離（沒有子彈是無限大）。 */
function nearestBullet(state: S10State, side: Side): number {
  const p = state.players[side];
  let best = Number.POSITIVE_INFINITY;
  for (const b of state.bullets) {
    best = Math.min(best, Math.hypot(b.x - p.x, b.y - p.y));
  }
  return best;
}

/** 假裝險的時候不靠近到比這個更近（命中是 5）。 */
const FEINT_FLOOR = 6.5;

/**
 * 在清場被用掉 `times` 次之前，貼近子彈：在動態上仍然閃得開（預測路徑 danger ≤ 0.3）的動作裡，
 * 挑離最近的子彈最近、但不小於 FEINT_FLOOR 的；其餘跟 `habit` 一樣。
 */
export function feint(times: number, seed: number): Controller<S10State> {
  return {
    decide(state: S10State, side: Side, tick: number): Buttons {
      const base = precise.decide(MOVE_GAME, state, side, tick, { depth: 1, seed });
      let move = base;
      if (CLEARS - state.clears < times && state.tick >= 200 && state.bullets.length > 0) {
        let bestDistance = nearestBullet(step(state, asInputs(base, side)), side);
        if (bestDistance > FEINT_FLOOR) {
          for (const candidate of MOVES) {
            const next = step(state, asInputs(candidate, side));
            if (dangerOf(next, side) > 0.3) {
              continue;
            }
            const distance = nearestBullet(next, side);
            if (distance >= FEINT_FLOOR && distance < bestDistance) {
              bestDistance = distance;
              move = candidate;
            }
          }
        }
      }
      return pressDecision('habit', state, side) ? { ...move, b: true } : move;
    },
  };
}

/** 一直按住 b：能按就按。移動同其他玩家。 */
export function masher(seed: number): Controller<S10State> {
  return {
    decide(state: S10State, side: Side, tick: number): Buttons {
      return { ...precise.decide(MOVE_GAME, state, side, tick, { depth: 1, seed }), b: true };
    },
  };
}

/**
 * 真人觀察模型（DESIGN-AI-FUN 9.8；不用 `wrapPolicy`，因為它用 `step` 把舊畫面重播到現在，
 * 子彈由種子決定的牌上會連 d 個 tick 內才冒出來的子彈一起補回來，延遲等於零）：
 * 畫面上的東西（子彈、對手、次數、分數）是 `delay` 個 tick 以前的，自己的位置、速度、命中與無敵是現在的。
 * 不呼叫 `step`、不外推。每 `decideEvery` 個 tick 才換一次動作，每次有 `epsilon` 的機率從 `actions()` 亂挑。
 */
export function observeWithDelay(seen: S10State, now: S10State, side: Side): S10State {
  const players: [S10State['players'][0], S10State['players'][1]] =
    side === 0 ? [now.players[0], seen.players[1]] : [seen.players[0], now.players[1]];
  return { ...seen, players };
}

export function delayedView(
  inner: Controller<S10State>,
  params: { readonly delay: number; readonly decideEvery: number; readonly epsilon: number },
  seed: number,
): Controller<S10State> {
  let history: S10State[] = [];
  let held: Buttons | null = null;
  let lastDecision = 0;
  let dice = createRng(seed).fork('s10-delayed-view');
  return {
    decide(state: S10State, side: Side, tick: number): Buttons {
      if (tick === 0) {
        history = [];
        held = null;
        dice = createRng(seed).fork('s10-delayed-view');
      }
      history.push(state);
      if (history.length > params.delay + 1) {
        history.shift();
      }
      if (held === null || tick - lastDecision >= params.decideEvery) {
        const seen = observeWithDelay(history[0] as S10State, state, side);
        held =
          params.epsilon > 0 && dice.next() < params.epsilon
            ? (() => {
                const list = s10Game.actions(seen, side);
                return list[dice.int(list.length)] as Buttons;
              })()
            : inner.decide(seen, side, tick);
        lastDecision = tick;
      }
      return { ...held };
    },
  };
}

/**
 * 最簡單的合理策略（DESIGN-AI-FUN 10.14 量 A4 用）：一行規則、不做搜尋、不看 AI：
 * 閃躲照精準型，場上的子彈數達到 `threshold` 顆就按清場。
 */
export function threshold(limit: number, seed: number): Controller<S10State> {
  return {
    decide(state: S10State, side: Side, tick: number): Buttons {
      const move = precise.decide(MOVE_GAME, state, side, tick, { depth: 1, seed });
      return canClear(state) && Math.min(state.bullets.length, CLEAR_CAP) >= limit
        ? { ...move, b: true }
        : move;
    },
  };
}

/**
 * 看不見門檻的簡單玩法：不看 `minBullets`，只要按得下去（第 300 tick 起、不在無彈期、還有次數）而且場上子彈數
 * 達到 `limit` 顆就按。`limit` = 1 就是「子彈 ≥ 1 顆就按」。門檻不夠時它會按早（照規則被鎖或被扣）。
 */
export function blindThreshold(limit: number, seed: number): Controller<S10State> {
  return {
    decide(state: S10State, side: Side, tick: number): Buttons {
      const move = precise.decide(MOVE_GAME, state, side, tick, { depth: 1, seed });
      const open =
        state.clears > 0 &&
        state.tick >= (state.clears === 1 ? state.lastFrom : CLEAR_FROM) &&
        state.quiet === 0;
      return open && state.bullets.length >= limit ? { ...move, b: true } : move;
    },
  };
}

/** 均勻亂決定。 */
export function uniform(seed: number, side: Side): Controller<S10State> {
  const rng = createRng(seed).fork(`s10-uniform-${side}`);
  return {
    decide(state: S10State, who: Side): Buttons {
      const list = s10Game.actions(state, who);
      return list[rng.int(list.length)] as Buttons;
    },
  };
}

// ---------------------------------------------------------------------------
// 量測用的對局
// ---------------------------------------------------------------------------

export interface MatchRecord {
  /** 劇本玩家這邊的結果：1 贏、0.5 平手、0 輸。 */
  readonly points: number;
  /** 劇本玩家這邊與 AI 這邊各自被打中幾次。 */
  readonly hitsMe: number;
  readonly hitsAi: number;
  /** 每次清場：按的是誰（'me'、'ai'、'both'）、按下去那一刻場上的子彈數、第幾個 tick。 */
  readonly clears: readonly { readonly who: 'me' | 'ai' | 'both'; readonly n: number; readonly tick: number }[];
  /** 劇本玩家從 tick 300 到 1200 的平均險度。 */
  readonly exposureMe: number;
  readonly scoreMe: number;
  readonly scoreAi: number;
  readonly ticks: number;
}

/**
 * 劇本玩家對 AI（`policy` 的等級 `level`）打一場；偶數種子坐 0 號邊。回傳這一場的紀錄。
 * `makeAi` 讓呼叫者換掉 AI 的控制器（例如消融時換成別的遊戲變體的 AI）。
 */
export function playAgainstAi(
  game: Game<S10State>,
  makeMe: (seed: number, side: Side) => Controller<S10State>,
  makeAi: (seed: number) => Controller<S10State>,
  seed: number,
): MatchRecord {
  const me: Side = seed % 2 === 0 ? 0 : 1;
  const opp = other(me);
  const mine = makeMe(seed, me);
  const ai = makeAi(seed + 1_000_003);
  let state = game.init(seed, { maxTicks: 3600, params: {} });
  const clears: { who: 'me' | 'ai' | 'both'; n: number; tick: number }[] = [];
  let exposure = 0;
  let exposureTicks = 0;
  for (let tick = 0; !game.isOver(state); tick += 1) {
    const a = mine.decide(state, me, tick);
    const b = ai.decide(state, opp, tick);
    const before = state;
    state = game.step(state, me === 0 ? [a, b] : [b, a]);
    if (tick >= 300 && tick < 1200) {
      exposure += state.exposure[me];
      exposureTicks += 1;
    }
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
  const winner = game.winner(state);
  const score = game.score(state);
  return {
    points: winner === null ? 0.5 : winner === me ? 1 : 0,
    hitsMe: state.players[me].hits,
    hitsAi: state.players[opp].hits,
    clears,
    exposureMe: exposureTicks === 0 ? 0 : exposure / exposureTicks,
    scoreMe: score[me],
    scoreAi: score[opp],
    ticks: state.tick,
  };
}

/** 一組種子的平均：勝率（%）與各項平均。 */
export function summarize(records: readonly MatchRecord[]): {
  readonly win: number;
  readonly hitsMe: number;
  readonly hitsAi: number;
  readonly myClears: number;
  readonly aiClears: number;
  readonly aiFirstDensity: number;
  readonly aiMeanDensity: number;
  /** 劇本玩家（或被測的性格）自己按的時候，場上平均有幾顆子彈（含兩邊同時按的那幾次）。 */
  readonly myMeanDensity: number;
  /** 劇本玩家第一次按（含同時按）的平均 tick。 */
  readonly myFirstTick: number;
  readonly exposureMe: number;
  readonly scoreMe: number;
  readonly scoreAi: number;
} {
  const n = records.length;
  const sum = (f: (r: MatchRecord) => number): number => records.reduce((acc, r) => acc + f(r), 0) / n;
  const aiPresses = records.flatMap((r) => r.clears.filter((c) => c.who === 'ai'));
  const mine = records.flatMap((r) => r.clears.filter((c) => c.who !== 'ai'));
  const myFirst = records.flatMap((r) => r.clears.filter((c) => c.who !== 'ai').slice(0, 1));
  const aiFirst = records.flatMap((r) => r.clears.filter((c) => c.who === 'ai').slice(0, 1));
  const mean = (xs: readonly { n: number }[]): number =>
    xs.length === 0 ? 0 : xs.reduce((acc, c) => acc + c.n, 0) / xs.length;
  return {
    win: 100 * sum((r) => r.points),
    hitsMe: sum((r) => r.hitsMe),
    hitsAi: sum((r) => r.hitsAi),
    myClears: sum((r) => r.clears.filter((c) => c.who === 'me').length),
    aiClears: sum((r) => r.clears.filter((c) => c.who === 'ai').length),
    aiFirstDensity: mean(aiFirst),
    aiMeanDensity: mean(aiPresses),
    myMeanDensity: mean(mine),
    myFirstTick: myFirst.length === 0 ? 0 : myFirst.reduce((acc, c) => acc + c.tick, 0) / myFirst.length,
    exposureMe: sum((r) => r.exposureMe),
    scoreMe: sum((r) => r.scoreMe),
    scoreAi: sum((r) => r.scoreAi),
  };
}
