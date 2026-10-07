import { nextFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { FIELD_H, FIELD_W, SCORE_UNIT } from '../_spades/logic';

/**
 * S-5 乒乓（小規格 `docs/cards/S-5.md`）。
 * 兩塊有慣性的板子隔著球場對打，板子移動中擊球會給球加旋，先得 `target`（預設 6）分的贏。
 * 純的：亂數只用 `RngState`（發球角度），時間只有 tick。
 *
 * 場地是垂直的：0 號邊（人）的板子在下緣 y = 210，1 號邊（AI）在上緣 y = 10。
 */

// ---------------------------------------------------------------------------
// 常數（小規格的起始值；量測後調整的在 docs/cards/S-5.md 的「量測」一節說明）
// ---------------------------------------------------------------------------

/** 兩條板子線的 y：[0 號邊, 1 號邊]。 */
export const LINE_Y: readonly [number, number] = [FIELD_H - 10, 10];
export const PADDLE_HALF = 15;
export const BALL_R = 3;
/** 球與板子中心的橫向距離不超過這個值就算擊中（板半寬加球半徑）。 */
export const HIT_REACH = PADDLE_HALF + BALL_R;
export const PADDLE_MIN_X = PADDLE_HALF;
export const PADDLE_MAX_X = FIELD_W - PADDLE_HALF;
export const START_X = FIELD_W / 2;

/** 板子：目標速度（全速與按住 a 的慢速）與每 tick 往目標靠近多少。 */
export const MAX_V = 2.4;
export const SLOW_V = 1.0;
export const ACCEL = 0.2;

/** 球：發球的起始速度、每次擊球加速多少、上限、擊球角度的上限（弧度）。 */
export const SERVE_SPEED = 2.2;
export const SPEED_STEP = 0.35;
export const MAX_SPEED = 6.5;
export const MAX_ANGLE = (50 * Math.PI) / 180;
export const SERVE_ANGLE = (20 * Math.PI) / 180;
/** 旋 ＝ 擊球那一刻的板速 × SPIN_K；每 tick 衰減；碰側牆減半。 */
export const SPIN_K = 0.012;
export const SPIN_DECAY = 0.99;

export const DEFAULT_TARGET = 6;
export const MIN_MAX_TICKS = 600;
export const DEAD_TICKS = 30;
export const SERVE_TICKS = 45;
export const RALLY_LIMIT = 1200;
export const HABIT_SIZE = 5;
export const TRAIL_SIZE = 10;
/** 預測最久往前看幾個 tick（球最慢 1.4 px/tick，穿過 200 像素最多約 145 tick）。 */
const MAX_FLIGHT = 300;
/** 評估時假設「板子照候選動作按這麼多 tick，然後放開」。 */
const HOLD_TICKS = 8;
const WAIT_TICKS = 30;
const CENTER_Y = FIELD_H / 2;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface S5Paddle {
  readonly x: number;
  readonly vx: number;
  /** 目前按著的目標速度（0、±1.0、±2.4）。自己的看得到；對手的不公開，AI 的 evaluate 不讀。 */
  readonly target: number;
}

export interface S5Ball {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly spin: number;
  /** 這一球已被擊球幾次（決定球速）。 */
  readonly hits: number;
  /** 最後一個擊球的邊；發球後還沒人碰是 null。 */
  readonly lastHit: Side | null;
}

export type S5Phase = 'serve' | 'play' | 'dead' | 'over';

export interface S5State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly target: number;
  readonly phase: S5Phase;
  /** 這個階段還剩幾 tick。 */
  readonly phaseLeft: number;
  readonly server: Side;
  readonly points: readonly [number, number];
  readonly rallyTicks: number;
  readonly paddles: readonly [S5Paddle, S5Paddle];
  readonly ball: S5Ball;
  /** 每一邊最近 5 次回球，球抵達對方那條線時的 x（新的在後面）。公開。 */
  readonly habit: readonly [readonly number[], readonly number[]];
  /** 球最近 10 個取樣位置（每 2 tick 一次），只給畫面畫尾跡。 */
  readonly trail: readonly (readonly [number, number])[];
  /** 發球角度的亂數狀態。 */
  readonly rng: RngState;
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function centerBall(): S5Ball {
  return { x: START_X, y: CENTER_Y, vx: 0, vy: 0, spin: 0, hits: 0, lastHit: null };
}

export interface S5Options {
  /** 關掉「讀對手的習慣」（只給測試：量這件事本身有沒有價值）。預設 true。 */
  readonly readHabit?: boolean;
}

function readTarget(config: GameConfig): number {
  const raw = config.params['target'];
  const target = raw === undefined ? DEFAULT_TARGET : raw;
  if (!Number.isInteger(target) || target < 1) {
    throw new RangeError(`S-5 的 params.target 必須是 1 以上的整數，收到 ${String(raw)}`);
  }
  return target;
}

function init(seed: number, config: GameConfig): S5State {
  if (!Number.isFinite(config.maxTicks) || config.maxTicks < MIN_MAX_TICKS) {
    throw new RangeError(
      `S-5 的 maxTicks 至少要 ${MIN_MAX_TICKS}，收到 ${String(config.maxTicks)}`,
    );
  }
  const paddle: S5Paddle = { x: START_X, vx: 0, target: 0 };
  return {
    tick: 0,
    maxTicks: config.maxTicks,
    target: readTarget(config),
    phase: 'serve',
    phaseLeft: SERVE_TICKS,
    server: ((seed % 2) + 2) % 2 === 0 ? 0 : 1,
    points: [0, 0],
    rallyTicks: 0,
    paddles: [paddle, paddle],
    ball: centerBall(),
    habit: [[], []],
    trail: [],
    rng: rngStateFor(seed, 's5-serve'),
  };
}

// ---------------------------------------------------------------------------
// 物理
// ---------------------------------------------------------------------------

function movePaddle(p: S5Paddle, keys: Buttons): S5Paddle {
  const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const target = dir === 0 ? 0 : dir * (keys.a ? SLOW_V : MAX_V);
  let vx = p.vx + clamp(target - p.vx, -ACCEL, ACCEL);
  let x = p.x + vx;
  if (x < PADDLE_MIN_X) {
    x = PADDLE_MIN_X;
    vx = 0;
  } else if (x > PADDLE_MAX_X) {
    x = PADDLE_MAX_X;
    vx = 0;
  }
  return { x, vx, target };
}

/** 板子照 `target` 按 `HOLD_TICKS` tick 然後放開，`ticks` 個 tick 之後的位置與速度（和 movePaddle 同一套算法）。 */
function paddleAfter(
  x0: number,
  v0: number,
  target: number,
  ticks: number,
): { x: number; v: number } {
  let x = x0;
  let v = v0;
  for (let t = 1; t <= ticks; t += 1) {
    v += clamp((t <= HOLD_TICKS ? target : 0) - v, -ACCEL, ACCEL);
    x += v;
    if (x < PADDLE_MIN_X) {
      x = PADDLE_MIN_X;
      v = 0;
    } else if (x > PADDLE_MAX_X) {
      x = PADDLE_MAX_X;
      v = 0;
    }
  }
  return { x, v };
}

export interface Arrival {
  /** 幾個 tick 之後球穿過那條線。 */
  readonly ticks: number;
  /** 穿過線的那一刻球的 x。 */
  readonly x: number;
}

/**
 * 球照目前的速度與旋一直飛（含側牆反彈），什麼時候、在哪個 x 穿過 `side` 那一邊的板子線。
 * 這是「精確物理」：算法與 `step` 逐行相同，測試證明兩者的 tick 與 x 完全一致。
 * 球不朝那條線飛、或已經在線外，回傳 null。
 */
export function predictArrival(ball: S5Ball, side: Side): Arrival | null {
  const line = LINE_Y[side];
  const down = side === 0;
  if (down ? ball.vy <= 0 || ball.y >= line : ball.vy >= 0 || ball.y <= line) {
    return null;
  }
  let { x, y, vx, spin } = ball;
  for (let t = 1; t <= MAX_FLIGHT; t += 1) {
    const px = x;
    const py = y;
    vx += spin;
    spin *= SPIN_DECAY;
    x += vx;
    y += ball.vy;
    if (x < BALL_R) {
      x = 2 * BALL_R - x;
      vx = -vx;
      spin /= 2;
    } else if (x > FIELD_W - BALL_R) {
      x = 2 * (FIELD_W - BALL_R) - x;
      vx = -vx;
      spin /= 2;
    }
    if (down ? y >= line : y <= line) {
      return { ticks: t, x: px + (x - px) * ((line - py) / (y - py)) };
    }
  }
  return null;
}

/** 在線上被板子擊中之後的球：角度由落點決定、球速由擊球數決定、旋由板速決定。 */
export function struck(
  side: Side,
  x: number,
  offset: number,
  paddleVx: number,
  hits: number,
): S5Ball {
  const o = clamp(offset / HIT_REACH, -1, 1);
  const speed = Math.min(SERVE_SPEED + SPEED_STEP * hits, MAX_SPEED);
  const angle = o * MAX_ANGLE;
  return {
    x,
    y: LINE_Y[side],
    vx: speed * Math.sin(angle),
    vy: (side === 0 ? -1 : 1) * speed * Math.cos(angle),
    spin: SPIN_K * paddleVx,
    hits,
    lastHit: side,
  };
}

const pushHabit = (list: readonly number[], x: number): number[] => [...list, x].slice(-HABIT_SIZE);

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

export function isOver(s: S5State): boolean {
  return s.phase === 'over' || s.tick >= s.maxTicks;
}

/** 發球：用亂數決定角度（±20°），朝接球的一方。 */
function launch(s: S5State): S5State {
  const [roll, rng] = nextFrom(s.rng);
  const angle = (roll * 2 - 1) * SERVE_ANGLE;
  const receiver = other(s.server);
  const vy = (receiver === 0 ? 1 : -1) * SERVE_SPEED * Math.cos(angle);
  return {
    ...s,
    phase: 'play',
    phaseLeft: 0,
    rallyTicks: 0,
    rng,
    ball: { ...centerBall(), vx: SERVE_SPEED * Math.sin(angle), vy },
  };
}

/** 一個 tick 的球：移動、擊球或沒接到、得分、作廢。 */
function stepBall(s: S5State, paddles: readonly [S5Paddle, S5Paddle], tick: number): S5State {
  const b = s.ball;
  const rallyTicks = s.rallyTicks + 1;
  let vx = b.vx + b.spin;
  let spin = b.spin * SPIN_DECAY;
  let x = b.x + vx;
  const y = b.y + b.vy;
  if (x < BALL_R) {
    x = 2 * BALL_R - x;
    vx = -vx;
    spin /= 2;
  } else if (x > FIELD_W - BALL_R) {
    x = 2 * (FIELD_W - BALL_R) - x;
    vx = -vx;
    spin /= 2;
  }

  const side: Side = b.vy > 0 ? 0 : 1;
  const line = LINE_Y[side];
  const crossed = side === 0 ? b.y < line && y >= line : b.y > line && y <= line;
  let ball: S5Ball = { ...b, x, y, vx, spin };
  let habit = s.habit;
  if (crossed) {
    const arriveX = b.x + (x - b.x) * ((line - b.y) / (y - b.y));
    if (b.lastHit !== null) {
      const owner = b.lastHit;
      habit =
        owner === 0
          ? [pushHabit(habit[0], arriveX), habit[1]]
          : [habit[0], pushHabit(habit[1], arriveX)];
    }
    const paddle = paddles[side];
    if (Math.abs(arriveX - paddle.x) <= HIT_REACH) {
      ball = struck(side, arriveX, arriveX - paddle.x, paddle.vx, b.hits + 1);
    }
  }

  const trail =
    tick % 2 === 0 ? [...s.trail, [ball.x, ball.y] as const].slice(-TRAIL_SIZE) : s.trail;
  const next: S5State = { ...s, ball, habit, trail, rallyTicks };

  if (ball.y > FIELD_H || ball.y < 0) {
    // 球穿過底線沒被接到：另一邊得分。
    const scorer: Side = ball.y > FIELD_H ? 1 : 0;
    const points: [number, number] = [s.points[0], s.points[1]];
    points[scorer] += 1;
    if (points[scorer] >= s.target) {
      return { ...next, points, phase: 'over', phaseLeft: 0 };
    }
    return { ...next, points, phase: 'dead', phaseLeft: DEAD_TICKS, server: other(s.server) };
  }
  if (rallyTicks >= RALLY_LIMIT) {
    return { ...next, phase: 'dead', phaseLeft: DEAD_TICKS };
  }
  return next;
}

export function step(s: S5State, inputs: Inputs): S5State {
  if (isOver(s)) {
    return s;
  }
  const tick = s.tick + 1;
  const paddles: readonly [S5Paddle, S5Paddle] = [
    movePaddle(s.paddles[0], inputs[0]),
    movePaddle(s.paddles[1], inputs[1]),
  ];
  const moved: S5State = { ...s, tick, paddles };
  switch (s.phase) {
    case 'play':
      return stepBall(moved, paddles, tick);
    case 'serve':
      return s.phaseLeft <= 1 ? launch(moved) : { ...moved, phaseLeft: s.phaseLeft - 1 };
    case 'dead':
      return s.phaseLeft <= 1
        ? { ...moved, phase: 'serve', phaseLeft: SERVE_TICKS, ball: centerBall(), trail: [] }
        : { ...moved, phaseLeft: s.phaseLeft - 1 };
    default:
      return moved;
  }
}

export function score(s: S5State): readonly [number, number] {
  return s.points;
}

export function winner(s: S5State): Side | null {
  if (!isOver(s)) {
    return null;
  }
  const [a, b] = s.points;
  return a > b ? 0 : b > a ? 1 : null;
}

// ---------------------------------------------------------------------------
// 動作
// ---------------------------------------------------------------------------

const R: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
/** 全放開（排第一）、左、右、a＋左、a＋右、a（慢速停住）。 */
const ACTIONS: readonly Buttons[] = [
  R,
  { ...R, left: true },
  { ...R, right: true },
  { ...R, left: true, a: true },
  { ...R, right: true, a: true },
  { ...R, a: true },
];

export function actions(): readonly Buttons[] {
  return ACTIONS;
}

// ---------------------------------------------------------------------------
// 評估（給 AI）
// ---------------------------------------------------------------------------

/**
 * 讀對手的習慣：最近幾次回球抵達這一邊的 x。
 * 把握 `conf` 從「落點有多整齊」來：整齊（平均離差小）才有把握，最多 0.8；沒有歷史是 0。
 * 先加兩個「離差 30」的先驗，所以樣本少時把握也低（3 次同一點約 0.56、5 次約 0.63）。
 * 預測的落點 `x`：中央往習慣的平均偏過去，把握 0.8 時整個走到平均那裡（`conf × 1.25` 夾在 1 以內）。
 * 與小規格起始值的差別（量測後的調整，理由寫在小規格的「量測」一節）：平均用資料本身、不往中央收，
 * 偏的幅度是 `1.25 × conf`；起始值只換到約 14 像素的歪，玩家養出習慣的回報太小，反打不會成立。
 */
export function guessReturn(habit: readonly number[]): { x: number; conf: number } {
  const n = habit.length;
  if (n === 0) {
    return { x: START_X, conf: 0 };
  }
  const mean = habit.reduce((sum, v) => sum + v, 0) / n;
  const mad = (habit.reduce((sum, v) => sum + Math.abs(v - mean), 0) + 2 * 30) / (n + 2);
  const conf = 0.8 * clamp(1 - mad / 40, 0, 1);
  return { x: START_X + Math.min(1, conf * 1.25) * (mean - START_X), conf };
}

/**
 * 不讀：對手板子的 `target`（按鍵不公開）、`rng`（還沒發生的發球）、`trail`（只給畫面）。
 * 自己的 `target` 可以讀：模擬一步之後它就是「候選動作」。
 * 沒有任何依分差或等級的分支：兩邊分數歸零之後 evaluate 與 actions 完全相同（沒有橡皮筋）。
 */
function evaluateS5(s: S5State, side: Side, readHabit: boolean): { gain: number; danger: number } {
  const opp = other(side);
  const base = SCORE_UNIT * (s.points[side] - s.points[opp]);
  if (isOver(s)) {
    return { gain: base, danger: 0 };
  }
  const me = s.paddles[side];
  if (s.phase !== 'play') {
    // 停頓與發球：回中央等球。
    const settled = paddleAfter(me.x, me.vx, me.target, WAIT_TICKS);
    return { gain: base - 0.3 * Math.abs(settled.x - START_X), danger: 0 };
  }
  const ball = s.ball;
  const toward = side === 0 ? ball.vy > 0 : ball.vy < 0;

  if (!toward) {
    // 球飛向對手：預先靠位。
    const arrival = predictArrival(ball, opp);
    const spot = paddleAfter(me.x, me.vx, me.target, arrival === null ? WAIT_TICKS : arrival.ticks);
    const guess = readHabit ? guessReturn(s.habit[opp]) : { x: START_X, conf: 0 };
    return {
      gain: base - Math.abs(spot.x - guess.x),
      danger: clamp((Math.abs(spot.x - START_X) / 60) * (1 - guess.conf), 0, 1),
    };
  }

  // 球飛向我：選落點與滑不滑。
  const arrival = predictArrival(ball, side);
  if (arrival === null) {
    return { gain: base - 60, danger: 1 };
  }
  const spot = paddleAfter(me.x, me.vx, me.target, arrival.ticks);
  const offset = arrival.x - spot.x;
  const reach = Math.abs(offset) / HIT_REACH;
  const danger = clamp((reach - 0.7) / 0.3, 0, 1);
  if (reach > 1) {
    return { gain: base - 60 - 0.5 * (Math.abs(offset) - HIT_REACH), danger: 1 };
  }
  const returned = struck(side, arrival.x, offset, spot.v, ball.hits + 1);
  const back = predictArrival(returned, opp);
  const straight = predictArrival({ ...returned, spin: 0 }, opp);
  let margin = 0;
  let spinEffect = 0;
  if (back !== null && straight !== null) {
    const them = s.paddles[opp];
    const stop = clamp(
      them.x + (them.vx * Math.abs(them.vx)) / (2 * ACCEL),
      PADDLE_MIN_X,
      PADDLE_MAX_X,
    );
    const dir = back.x >= stop ? 1 : -1;
    const sweep = paddleAfter(them.x, them.vx, dir * MAX_V, back.ticks);
    // 他們全力衝過去之後，離球還差多少（扣掉半個板寬）：正的表示來不及。
    margin = dir > 0 ? back.x - sweep.x - PADDLE_HALF : sweep.x - back.x - PADDLE_HALF;
    spinEffect = Math.abs(back.x - straight.x) / 20;
  }
  const speed = Math.hypot(returned.vx, returned.vy);
  const gain =
    base +
    0.6 * clamp(margin, -120, 60) +
    6 * spinEffect -
    0.15 * Math.abs(spot.x - START_X) * (speed / 3);
  return { gain, danger };
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export function createS5Game(options: S5Options = {}): Game<S5State> {
  const readHabit = options.readHabit !== false;
  return {
    id: 'S-5',
    init,
    step,
    isOver,
    score,
    winner,
    actions,
    evaluate: (s, side) => evaluateS5(s, side, readHabit),
  };
}

export const s5Game: Game<S5State> = createS5Game();

// ---------------------------------------------------------------------------
// 測試用：直接構造局面
// ---------------------------------------------------------------------------

export interface S5StateOverrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly target?: number;
  readonly phase?: S5Phase;
  readonly phaseLeft?: number;
  readonly server?: Side;
  readonly points?: readonly [number, number];
  readonly rallyTicks?: number;
  readonly paddles?: readonly [Partial<S5Paddle>, Partial<S5Paddle>];
  readonly ball?: Partial<S5Ball>;
  readonly habit?: readonly [readonly number[], readonly number[]];
  readonly trail?: readonly (readonly [number, number])[];
  readonly rng?: RngState;
}

/** 測試用：預設是「球在中央、往 1 號邊飛（vy = −2.2）、兩塊板子在 75 不動、0 比 0、正在比賽」。 */
export function makeState(o: S5StateOverrides = {}): S5State {
  const paddle = (p: Partial<S5Paddle> | undefined): S5Paddle => ({
    x: p?.x ?? START_X,
    vx: p?.vx ?? 0,
    target: p?.target ?? 0,
  });
  return {
    tick: o.tick ?? 0,
    maxTicks: o.maxTicks ?? 5400,
    target: o.target ?? DEFAULT_TARGET,
    phase: o.phase ?? 'play',
    phaseLeft: o.phaseLeft ?? 0,
    server: o.server ?? 0,
    points: o.points ?? [0, 0],
    rallyTicks: o.rallyTicks ?? 0,
    paddles: [paddle(o.paddles?.[0]), paddle(o.paddles?.[1])],
    ball: {
      x: o.ball?.x ?? START_X,
      y: o.ball?.y ?? CENTER_Y,
      vx: o.ball?.vx ?? 0,
      vy: o.ball?.vy ?? -SERVE_SPEED,
      spin: o.ball?.spin ?? 0,
      hits: o.ball?.hits ?? 0,
      lastHit: o.ball?.lastHit ?? null,
    },
    habit: o.habit ?? [[], []],
    trail: o.trail ?? [],
    rng: o.rng ?? rngStateFor(0, 's5-serve'),
  };
}
