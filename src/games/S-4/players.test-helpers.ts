import { HUMAN_PARAMS } from '../../ai/human-model';
import { levelController, policyByName, wrapPolicy } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import type { PolicyKey } from '../../ai/types';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import {
  BALL_SPEED,
  BRICK_W,
  COLS,
  MAX_ANGLE,
  PADDLE_REACH,
  PADDLE_V,
  ROWS,
  START_X,
  WALL_BOTTOM,
  WALL_TOP,
  blast,
  predictArrival,
  s4Game,
  strikeOutcome,
} from './logic';
import type { S4State } from './logic';

/**
 * S-4 的劇本玩家與量測工具（DESIGN-AI-FUN 10.20、10.24、10.35、10.40、10.54）。測試與量測用，不進遊戲，不在純度掃描範圍。
 *
 * 劇本玩家看完整的 state、每個 tick 都決定、不延遲、不失誤（比任何人都強的操作），只差「瞄哪裡」：
 * 移動的方式完全一樣（`steer`：算好板子要站的位置，快走到 2.4 以內再慢走微調）。
 */

export const NEUTRAL: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};
/** 契約測試與 A1–A4 用的設定（meta.defaultMaxTicks 會把它截成 3000）。 */
export const CONTRACT = { maxTicks: 3600, params: {} };

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

export function ai(
  level: number,
  seed: number,
  policy: PolicyKey = 'precise',
  game: Game<S4State> = s4Game,
): Controller<S4State> {
  return levelController(game, policyByName(policy), level, seed);
}

export function humanModel(seed: number, game: Game<S4State> = s4Game): Controller<S4State> {
  return wrapPolicy(game, pathfinder, HUMAN_PARAMS, seed);
}

// ---------------------------------------------------------------------------
// 劇本玩家
// ---------------------------------------------------------------------------

const KEYS = {
  idle: NEUTRAL,
  left: { ...NEUTRAL, left: true },
  right: { ...NEUTRAL, right: true },
  slowLeft: { ...NEUTRAL, left: true, a: true },
  slowRight: { ...NEUTRAL, right: true, a: true },
} as const;

/** 往 `target` 走：離得遠就全速，進到 2.4 以內改慢走，離 0.5 以內放開。 */
export function steer(x: number, target: number): Buttons {
  const dx = target - x;
  if (Math.abs(dx) < 0.5) {
    return KEYS.idle;
  }
  if (Math.abs(dx) > PADDLE_V) {
    return dx > 0 ? KEYS.right : KEYS.left;
  }
  return dx > 0 ? KEYS.slowRight : KEYS.slowLeft;
}

export type ScriptKind =
  /** 站著不動。 */
  | 'idle'
  /** 只接飛向自己的球，永遠用板心（o = 0）；不瞄準。 */
  | 'center'
  /** (a) 不知道有對手：只管自己發的球，瞄炸彈，穿牆沒有成本。 */
  | 'a'
  /** (b) 知道有對手、不讀它的狀態：什麼球都接，瞄炸彈，不把球打進洞（洞會被接回來）。 */
  | 'b'
  /** (c) 讀它的狀態：(b) 加上搶磚（它的球先到就換目標）、對手接不到時才穿牆、守快通的欄。 */
  | 'c'
  /** 只挖：永遠瞄「剩最少磚」的那一欄，通了就往洞裡打。 */
  | 'tunnel'
  /** 只守：板心接球，球會打進洞就偏開；閒著站在快通的欄底下。 */
  | 'guard'
  /** 只瞄炸彈，別的都用板心；洞不避。 */
  | 'bomb'
  /** 一直用邊緣（|o| = 0.85）左右交替擊球。 */
  | 'edge';

const GRID: readonly number[] = Array.from({ length: 33 }, (_v, i) => -0.8 + i * 0.05);

function aliveInColumn(bricks: readonly number[], c: number): number {
  let alive = 0;
  for (let r = 0; r < ROWS; r += 1) {
    alive += bricks[r * COLS + c] === 0 ? 1 : 0;
  }
  return alive;
}

function columnOf(brick: number): number {
  return brick % COLS;
}

interface Pick {
  readonly index: 0 | 1;
  readonly ticks: number;
  readonly x: number;
}

/** 最先到我這條線的球（`own` 只算自己發的球）。 */
function soonest(state: S4State, side: Side, own: boolean): Pick | null {
  let best: Pick | null = null;
  for (const index of [0, 1] as const) {
    if (own && state.balls[index].owner !== side) {
      continue;
    }
    const a = predictArrival(state, index, side);
    if (a !== null && (best === null || a.ticks < best.ticks)) {
      best = { index, ticks: a.ticks, x: a.x };
    }
  }
  return best;
}

/** 一擊的價值：敲到的磚（炸彈算整片），或穿牆（`hole` 是穿牆的價值）。 */
function strikeValue(
  state: S4State,
  outcome: ReturnType<typeof strikeOutcome>,
  hole: number,
): number {
  if (outcome.brick < 0) {
    return outcome.exit === null ? 0 : hole;
  }
  return state.bombs.includes(outcome.brick)
    ? blast(state.bricks, state.bombs, outcome.brick).length
    : 1;
}

export interface ScriptOptions {
  /** 板子反應延遲以外的限制：每幾個 tick 才重算目標（預設 1）。 */
  readonly every?: number;
}

/** 劇本玩家：回傳一個每個 tick 都決定的控制器。 */
export function scripted(kind: ScriptKind): Controller<S4State> {
  let planKey = '';
  let planO = 0;
  let flip = 1;
  return {
    decide(state: S4State, side: Side): Buttons {
      const me = state.paddles[side];
      if (kind === 'idle') {
        return KEYS.idle;
      }
      const opp: Side = side === 0 ? 1 : 0;
      const pick = soonest(state, side, kind === 'a');
      if (pick === null) {
        return steer(me.x, restingSpot(kind, state, side));
      }
      const alive = state.bricks.reduce((sum, v) => sum + v, 0);
      const key = `${pick.index}:${state.tick + pick.ticks}:${alive}`;
      if (key !== planKey) {
        planKey = key;
        planO = chooseOffset(kind, state, side, opp, pick, flip);
        flip = -flip;
      }
      return steer(me.x, pick.x - planO * PADDLE_REACH);
    },
  };
}

/** 沒有球要接的時候站哪裡。 */
function restingSpot(kind: ScriptKind, state: S4State, side: Side): number {
  if (kind === 'guard' || kind === 'c') {
    const opponentPlaying = state.balls.some((b) => b.respawn === 0);
    if (opponentPlaying) {
      let best = START_X;
      let bestAlive = 2;
      for (let c = 0; c < COLS; c += 1) {
        const alive = aliveInColumn(state.bricks, c);
        if (alive <= 1 && alive < bestAlive + 1) {
          const cx = c * BRICK_W + BRICK_W / 2;
          if (
            alive < bestAlive ||
            Math.abs(cx - state.paddles[side].x) < Math.abs(best - state.paddles[side].x)
          ) {
            best = cx;
            bestAlive = alive;
          }
        }
      }
      return best;
    }
  }
  return START_X;
}

function chooseOffset(
  kind: ScriptKind,
  state: S4State,
  side: Side,
  opp: Side,
  pick: Pick,
  flip: number,
): number {
  if (kind === 'center' || kind === 'guard') {
    return kind === 'guard' ? avoidHole(state, side, pick) : 0;
  }
  if (kind === 'edge') {
    return 0.85 * flip;
  }
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  const rival = kind === 'c' ? rivalContact(state, pick.index) : null;
  for (const o of GRID) {
    const outcome = strikeOutcome(state, side, pick.x, o * PADDLE_REACH);
    let value: number;
    if (kind === 'tunnel') {
      value = tunnelValue(state, outcome);
    } else if (kind === 'a' || kind === 'bomb') {
      value = strikeValue(state, outcome, 0);
    } else if (kind === 'b') {
      value = strikeValue(state, outcome, -3);
    } else {
      // c：讀它。對手（AI）接得到穿牆球的機率看它的板子在哪、手上有沒有別的球要接：
      // 板子夠不到落點，或它自己的球差不多同時抵達、而且落在離落點很遠的地方（兩邊顧不了），就當作接不到。
      let hole = -3;
      if (outcome.exit !== null) {
        const them = state.paddles[opp];
        const time = pick.ticks + outcome.exit.ticks;
        const unreachable = Math.abs(outcome.exit.x - them.x) > PADDLE_V * time + PADDLE_REACH;
        const theirs = predictArrival(state, pick.index === 0 ? 1 : 0, opp);
        const busy =
          theirs !== null &&
          Math.abs(theirs.ticks - time) <= 25 &&
          Math.abs(theirs.x - outcome.exit.x) > 40;
        hole = unreachable || busy ? 1.4 : -3;
      }
      value = strikeValue(state, outcome, hole);
      if (
        rival !== null &&
        outcome.brick >= 0 &&
        rival.ticks < pick.ticks + outcome.ticks &&
        rival.brick === outcome.brick
      ) {
        value *= 0.4;
      }
    }
    const score = value - 0.05 * Math.abs(o);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

/** 以板心接球會不會打進洞；會的話偏到最近一個不會的 o。 */
function avoidHole(state: S4State, side: Side, pick: Pick): number {
  const through = (o: number): boolean =>
    strikeOutcome(state, side, pick.x, o * PADDLE_REACH).brick < 0;
  if (!through(0)) {
    return 0;
  }
  for (let k = 1; k <= 16; k += 1) {
    for (const o of [k * 0.05, -k * 0.05]) {
      if (!through(o)) {
        return o;
      }
    }
  }
  return 0;
}

function tunnelValue(state: S4State, outcome: ReturnType<typeof strikeOutcome>): number {
  if (outcome.brick < 0) {
    return outcome.exit === null ? 0 : 5;
  }
  // 越接近通的欄越好：這一欄還剩幾塊。
  const alive = aliveInColumn(state.bricks, columnOf(outcome.brick));
  return 1 + (6 - alive) * 0.5;
}

/** 對手（另一邊）那顆球，繼續飛會先碰到哪塊磚、什麼時候。 */
function rivalContact(state: S4State, mine: 0 | 1): { brick: number; ticks: number } | null {
  const other: 0 | 1 = mine === 0 ? 1 : 0;
  const ball = state.balls[other];
  if (ball.respawn > 0) {
    return null;
  }
  // 往前模擬：用 step 讓兩塊板子放開，看哪塊磚先消失。
  let s = state;
  const idle: readonly [Buttons, Buttons] = [NEUTRAL, NEUTRAL];
  for (let t = 1; t <= 120; t += 1) {
    const next = s4Game.step(s, idle);
    for (let i = 0; i < state.bricks.length; i += 1) {
      if (s.bricks[i] === 0 && next.bricks[i] === 1) {
        return { brick: i, ticks: t };
      }
    }
    s = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 量測用
// ---------------------------------------------------------------------------

export interface MatchRecord {
  readonly ticks: number;
  readonly score: readonly [number, number];
  /** 贏家（平手 null）。 */
  readonly winner: Side | null;
  /** 第一次有一整欄被打通的 tick（沒有是 −1）。 */
  readonly firstHole: number;
  /** 第一次有球從一半穿到另一半的 tick（沒有是 −1）。 */
  readonly firstCross: number;
  /** 各邊的球穿牆的次數（以穿牆那一刻球的主人算）。 */
  readonly crossings: readonly [number, number];
  /** 各邊搶到的炸彈數（炸彈磚被球碰到、記在那一邊分數上）。 */
  readonly bombsWon: readonly [number, number];
  /** 各邊的板子擊球次數、邊緣（|o| ≥ 0.85）擊球次數、|o| 總和、偷球次數（擊中對手的球）。 */
  readonly hits: readonly [number, number];
  readonly rim: readonly [number, number];
  readonly absO: readonly [number, number];
  readonly steals: readonly [number, number];
  /** 各邊被穿底線的次數。 */
  readonly penalties: readonly [number, number];
  /** 被炸彈（含連鎖）炸掉的磚數，整場合計。 */
  readonly bombBricks: number;
  /** 各邊擊球時「落後」（自己的分數低於對方）的次數、其中邊緣擊球的次數；穿牆球的次數也依擊球前一刻的比分分開。 */
  readonly hitsBehind: readonly [number, number];
  readonly rimBehind: readonly [number, number];
  readonly hitsAhead: readonly [number, number];
  readonly rimAhead: readonly [number, number];
  readonly crossBehind: readonly [number, number];
  readonly crossAhead: readonly [number, number];
}

function halfOf(y: number): 0 | 1 | -1 {
  if (y > WALL_BOTTOM + 2) {
    return 0;
  }
  if (y < WALL_TOP - 2) {
    return 1;
  }
  return -1;
}

/** 打一場並記錄事件（逐 tick 比較前後兩個 state）。 */
export function record(
  seed: number,
  c0: Controller<S4State>,
  c1: Controller<S4State>,
  maxTicks = 3600,
  game: Game<S4State> = s4Game,
): MatchRecord {
  let s = game.init(seed, { maxTicks, params: {} });
  let firstHole = -1;
  let firstCross = -1;
  const crossings: [number, number] = [0, 0];
  const bombsWon: [number, number] = [0, 0];
  const hits: [number, number] = [0, 0];
  const rim: [number, number] = [0, 0];
  const absO: [number, number] = [0, 0];
  const steals: [number, number] = [0, 0];
  const penalties: [number, number] = [0, 0];
  let bombBricks = 0;
  const hitsBehind: [number, number] = [0, 0];
  const rimBehind: [number, number] = [0, 0];
  const hitsAhead: [number, number] = [0, 0];
  const rimAhead: [number, number] = [0, 0];
  const crossBehind: [number, number] = [0, 0];
  const crossAhead: [number, number] = [0, 0];
  const lastHalf: [number, number] = [0, 1];
  let tick = 0;
  while (!game.isOver(s)) {
    const a = c0.decide(s, 0, tick);
    const b = c1.decide(s, 1, tick);
    const n = game.step(s, [a, b]);
    tick += 1;
    for (const side of [0, 1] as const) {
      const d = n.score[side] - s.score[side];
      if (d < 0) {
        penalties[side] += 1;
      }
    }
    for (const bomb of s.bombs) {
      if (s.bricks[bomb] === 0 && n.bricks[bomb] === 1) {
        const gain0 = n.score[0] - s.score[0];
        const gain1 = n.score[1] - s.score[1];
        bombsWon[gain0 > gain1 ? 0 : 1] += 1;
        bombBricks += Math.max(gain0, gain1);
      }
    }
    if (firstHole < 0) {
      for (let c = 0; c < COLS; c += 1) {
        if (aliveInColumn(n.bricks, c) === 0) {
          firstHole = tick;
        }
      }
    }
    for (const i of [0, 1] as const) {
      const p = s.balls[i];
      const q = n.balls[i];
      if (q.respawn > 0) {
        lastHalf[i] = i;
        continue;
      }
      if (p.respawn > 0) {
        continue;
      }
      const hq = halfOf(q.y);
      if (hq !== -1) {
        if (hq !== lastHalf[i]) {
          crossings[q.owner] += 1;
          if (s.score[q.owner] < s.score[q.owner === 0 ? 1 : 0]) {
            crossBehind[q.owner] += 1;
          } else {
            crossAhead[q.owner] += 1;
          }
          if (firstCross < 0) {
            firstCross = tick;
          }
        }
        lastHalf[i] = hq;
      }
      // 擊球：垂直速度反向、而且剛好在接球線上
      if (Math.sign(p.vy) !== Math.sign(q.vy) && (q.y === 208 || q.y === 12)) {
        const side: Side = q.y === 208 ? 0 : 1;
        const o = Math.asin(Math.max(-1, Math.min(1, q.vx / BALL_SPEED))) / MAX_ANGLE;
        hits[side] += 1;
        absO[side] += Math.abs(o);
        const behind = s.score[side] < s.score[side === 0 ? 1 : 0];
        (behind ? hitsBehind : hitsAhead)[side] += 1;
        if (Math.abs(o) >= 0.85) {
          rim[side] += 1;
          (behind ? rimBehind : rimAhead)[side] += 1;
        }
        if (p.owner !== side) {
          steals[side] += 1;
        }
      }
    }
    s = n;
  }
  return {
    ticks: tick,
    score: s.score,
    winner: game.winner(s),
    firstHole,
    firstCross,
    crossings,
    bombsWon,
    hits,
    rim,
    absO,
    steals,
    penalties,
    bombBricks,
    hitsBehind,
    rimBehind,
    hitsAhead,
    rimAhead,
    crossBehind,
    crossAhead,
  };
}

/** 第一次有球從一半穿到另一半的 tick（沒有是 −1）；一出現就停，不打完整場。 */
export function firstCrossTick(
  seed: number,
  c0: Controller<S4State>,
  c1: Controller<S4State>,
  maxTicks = 3600,
  game: Game<S4State> = s4Game,
): number {
  let s = game.init(seed, { maxTicks, params: {} });
  const lastHalf: [number, number] = [0, 1];
  let tick = 0;
  while (!game.isOver(s)) {
    const n = game.step(s, [c0.decide(s, 0, tick), c1.decide(s, 1, tick)]);
    tick += 1;
    for (const i of [0, 1] as const) {
      const q = n.balls[i];
      if (q.respawn > 0) {
        lastHalf[i] = i;
        continue;
      }
      if (s.balls[i].respawn > 0) {
        continue;
      }
      const h = halfOf(q.y);
      if (h !== -1) {
        if (h !== lastHalf[i]) {
          return tick;
        }
        lastHalf[i] = h;
      }
    }
    s = n;
  }
  return -1;
}

/** `me` 在 `seed` 這一場的得分（贏 1、平手 0.5、輸 0）；偶數種子 `me` 坐 0 號邊、奇數坐 1 號邊。 */
export function pointsFor(
  seed: number,
  me: (seed: number) => Controller<S4State>,
  rival: (seed: number) => Controller<S4State>,
  maxTicks = 3600,
): { points: number; record: MatchRecord; mySide: Side } {
  const mySide: Side = seed % 2 === 0 ? 0 : 1;
  const m = me(seed);
  const r = rival(seed + 1_000_003);
  const rec = mySide === 0 ? record(seed, m, r, maxTicks) : record(seed, r, m, maxTicks);
  const points = rec.winner === null ? 0.5 : rec.winner === mySide ? 1 : 0;
  return { points, record: rec, mySide };
}

/** 勝率（百分比，平手算半場）。 */
export function winPercent(
  me: (seed: number) => Controller<S4State>,
  rival: (seed: number) => Controller<S4State>,
  seeds: readonly number[],
  maxTicks = 3600,
): number {
  let total = 0;
  for (const seed of seeds) {
    total += pointsFor(seed, me, rival, maxTicks).points;
  }
  return (100 * total) / seeds.length;
}

export const seedRange = (n: number, from = 0): number[] =>
  Array.from({ length: n }, (_v, i) => from + i);

export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}
