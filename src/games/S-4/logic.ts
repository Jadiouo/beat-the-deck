import { intFrom, nextFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { FIELD_H, FIELD_W, SCORE_UNIT } from '../_spades/logic';

/**
 * S-4 打磚塊對決（小規格 `docs/cards/S-4.md`）。
 * 兩塊板子隔著一面共用的磚牆（10 欄 × 6 列），各打一顆球；磚算「最後碰到球的那塊板子」的分，
 * 一欄打通之後球可以穿到對方那一半，穿過底線的球讓那一邊扣 2 分。牆敲光或 `maxTicks` 到了就結束。
 * 純的：亂數只用 `RngState`（發球角度與炸彈位置），時間只有 tick。
 *
 * 場地是垂直的：0 號邊（人）的板子在下緣 y = 212，1 號邊（AI）在上緣 y = 8。整個場地轉 180 度
 * （x → 150 − x、y → 220 − y、磚 i → 59 − i、兩邊互換）規則不變，K12 靠這個。
 */

// ---------------------------------------------------------------------------
// 常數（小規格的起始值；量測後調整的在 docs/cards/S-4.md 的「實作與量測」一節說明）
// ---------------------------------------------------------------------------

export const COLS = 10;
export const ROWS = 6;
export const BRICK_COUNT = COLS * ROWS;
export const BRICK_W = 15;
export const BRICK_H = 7;
/** 牆佔 y ∈ [WALL_TOP, WALL_BOTTOM]。 */
export const WALL_TOP = 89;
export const WALL_BOTTOM = WALL_TOP + ROWS * BRICK_H;

export const BALL_R = 2;
export const BALL_SPEED = 2;

/** 板子：寬 28（半寬 14）、厚 4；人在 y = 212、AI 在 y = 8。 */
export const PADDLE_HALF = 14;
export const PADDLE_Y: readonly [number, number] = [212, 8];
export const PADDLE_V = 2.4;
export const PADDLE_SLOW = 1.0;
export const PADDLE_MIN_X = PADDLE_HALF;
export const PADDLE_MAX_X = FIELD_W - PADDLE_HALF;
export const START_X = FIELD_W / 2;
/** 球心離板心不超過這個值就算接到（板半寬加球半徑）；也是 `o` 的分母。 */
export const PADDLE_REACH = PADDLE_HALF + BALL_R;
/** 球心走到這個 y 就算碰到板子（人：板子上緣 210 再減球半徑；AI：下緣 10 再加球半徑）。 */
export const CONTACT_Y: readonly [number, number] = [
  PADDLE_Y[0] - 2 - BALL_R,
  PADDLE_Y[1] + 2 + BALL_R,
];
export const MAX_ANGLE = (50 * Math.PI) / 180;
export const SERVE_ANGLE = (30 * Math.PI) / 180;

export const MISS_PENALTY = 2;
export const RESPAWN_TICKS = 45;
export const DEFAULT_MAX_TICKS = 3000;
export const MIN_MAX_TICKS = 600;
/** 預測球飛行最久往前看幾個 tick。 */
const MAX_FLIGHT = 220;

const other = (side: Side): Side => (side === 0 ? 1 : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface S4Paddle {
  readonly x: number;
  /** 上一個 tick 的指令速度（0、±1.0、±2.4）；板子沒有慣性，所以這只是「它正往哪邊走」，公開。 */
  readonly v: number;
}

export interface S4Ball {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** 最後碰到這顆球的板子；等待發球時是發球的那一邊。 */
  readonly owner: Side;
  /** > 0：球還在等待重發，剩幾個 tick。 */
  readonly respawn: number;
}

export interface S4State {
  readonly tick: number;
  readonly maxTicks: number;
  /** 60 個旗標，編號 = 列 × 10 + 欄（第 0 列在最上面）；0 在、1 沒了。 */
  readonly bricks: readonly number[];
  /** 炸彈磚的編號（遊戲中不變；有沒有被炸掉看 `bricks`）。 */
  readonly bombs: readonly number[];
  readonly paddles: readonly [S4Paddle, S4Paddle];
  /** 固定兩格：第 `i` 格是 `i` 號邊發的球，它穿過哪一邊的底線都回到第 `i` 號邊的板子重發。 */
  readonly balls: readonly [S4Ball, S4Ball];
  /** 敲掉的磚 − 2 × 被穿底線次數。 */
  readonly score: readonly [number, number];
  readonly rng: RngState;
}

// ---------------------------------------------------------------------------
// 磚與炸彈
// ---------------------------------------------------------------------------

/** 炸彈磚炸開的範圍：它與周圍 8 格，裡面還在的炸彈也會炸（連鎖）。回傳這次消失的磚（原本還在的），由小到大。 */
export function blast(
  bricks: readonly number[],
  bombs: readonly number[],
  origin: number,
): number[] {
  const gone = new Set<number>();
  const queue = [origin];
  const exploded = new Set<number>([origin]);
  while (queue.length > 0) {
    const at = queue.pop() as number;
    const row = Math.floor(at / COLS);
    const col = at % COLS;
    for (let r = Math.max(0, row - 1); r <= Math.min(ROWS - 1, row + 1); r += 1) {
      for (let c = Math.max(0, col - 1); c <= Math.min(COLS - 1, col + 1); c += 1) {
        const i = r * COLS + c;
        if (bricks[i] === 0 && !gone.has(i)) {
          gone.add(i);
          if (bombs.includes(i) && !exploded.has(i)) {
            exploded.add(i);
            queue.push(i);
          }
        }
      }
    }
  }
  return Array.from(gone).sort((a, b) => a - b);
}

/** 球心 (x, y) 碰到的磚：球心到磚的最近點距離嚴格小於球半徑，取最近的；一樣近取編號小的。沒有回傳 −1。 */
function nearestBrick(bricks: readonly number[], x: number, y: number): number {
  const c0 = Math.max(0, Math.floor((x - BALL_R) / BRICK_W));
  const c1 = Math.min(COLS - 1, Math.floor((x + BALL_R) / BRICK_W));
  const r0 = Math.max(0, Math.floor((y - BALL_R - WALL_TOP) / BRICK_H));
  const r1 = Math.min(ROWS - 1, Math.floor((y + BALL_R - WALL_TOP) / BRICK_H));
  let best = -1;
  let bestD2 = BALL_R * BALL_R;
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const i = r * COLS + c;
      if (bricks[i] !== 0) {
        continue;
      }
      const px = clamp(x, c * BRICK_W, c * BRICK_W + BRICK_W);
      const py = clamp(y, WALL_TOP + r * BRICK_H, WALL_TOP + r * BRICK_H + BRICK_H);
      const d2 = (x - px) * (x - px) + (y - py) * (y - py);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
  }
  return best;
}

interface Motion {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

interface Moved extends Motion {
  /** 這個 tick 碰到的磚（−1：沒有）。 */
  readonly brick: number;
}

/** 球自由飛一個 tick：側牆反彈，碰到磚就依碰到的面反彈並被推開到剛好離磚一個球半徑。不處理板子與底線。 */
function moveFree(b: Motion, bricks: readonly number[]): Moved {
  let vx = b.vx;
  let vy = b.vy;
  let x = b.x + vx;
  let y = b.y + vy;
  if (x < BALL_R) {
    x = 2 * BALL_R - x;
    vx = -vx;
  } else if (x > FIELD_W - BALL_R) {
    x = 2 * (FIELD_W - BALL_R) - x;
    vx = -vx;
  }
  let brick = -1;
  if (y > WALL_TOP - BALL_R && y < WALL_BOTTOM + BALL_R) {
    brick = nearestBrick(bricks, x, y);
    if (brick >= 0) {
      const row = Math.floor(brick / COLS);
      const col = brick % COLS;
      const px = clamp(x, col * BRICK_W, col * BRICK_W + BRICK_W);
      const py = clamp(y, WALL_TOP + row * BRICK_H, WALL_TOP + row * BRICK_H + BRICK_H);
      const nx = x - px;
      const ny = y - py;
      const d = Math.sqrt(nx * nx + ny * ny);
      if (d < 1e-9) {
        // 球心正好壓在磚的邊上（走不到的退化情形）：當作從正面撞上。
        vy = -vy;
      } else {
        const ax = Math.abs(nx);
        const ay = Math.abs(ny);
        if (ax >= ay) {
          vx = (nx < 0 ? -1 : 1) * Math.abs(vx);
        }
        if (ay >= ax) {
          vy = (ny < 0 ? -1 : 1) * Math.abs(vy);
        }
        const push = (BALL_R - d) / d;
        x += nx * push;
        y += ny * push;
      }
    }
  }
  return { x, y, vx, vy, brick };
}

// ---------------------------------------------------------------------------
// 球與板子
// ---------------------------------------------------------------------------

/** 球從 `prevY` 走到 `y`（方向 `vy`），這個 tick 有沒有穿過 `side` 那一邊的板子接球線。 */
function crossesContact(side: Side, prevY: number, y: number, vy: number): boolean {
  const line = CONTACT_Y[side];
  return side === 0 ? vy > 0 && prevY < line && y >= line : vy < 0 && prevY > line && y <= line;
}

/** 被板子擊中之後的球：離板心偏 `offset`，角度 = o × 50°，朝對方，速度固定。 */
function struck(side: Side, x: number, offset: number): S4Ball {
  const o = clamp(offset / PADDLE_REACH, -1, 1);
  const angle = o * MAX_ANGLE;
  return {
    x,
    y: CONTACT_Y[side],
    vx: BALL_SPEED * Math.sin(angle),
    vy: (side === 0 ? -1 : 1) * BALL_SPEED * Math.cos(angle),
    owner: side,
    respawn: 0,
  };
}

/** 發球：從 `side` 的板子（x）往牆發，角度在 ±30° 內由亂數決定。 */
function serve(side: Side, x: number, rng: RngState): readonly [S4Ball, RngState] {
  const [roll, next] = nextFrom(rng);
  const angle = (roll * 2 - 1) * SERVE_ANGLE;
  return [
    {
      x,
      y: CONTACT_Y[side],
      vx: BALL_SPEED * Math.sin(angle),
      vy: (side === 0 ? -1 : 1) * BALL_SPEED * Math.cos(angle),
      owner: side,
      respawn: 0,
    },
    next,
  ];
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/** 4 顆炸彈：2 個隨機（中間兩列，編號 20 到 39），另外 2 個是它們轉 180 度的位置（i → 59 − i）。 */
function pickBombs(seed: number): number[] {
  const [a, rest] = intFrom(rngStateFor(seed, 's4-bombs'), 20);
  const first = 20 + a;
  const pool: number[] = [];
  for (let i = 20; i <= 39; i += 1) {
    if (i !== first && i !== 59 - first) {
      pool.push(i);
    }
  }
  const [k] = intFrom(rest, pool.length);
  const second = pool[k] as number;
  return [first, 59 - first, second, 59 - second].sort((x, y) => x - y);
}

function init(seed: number, config: GameConfig): S4State {
  if (!Number.isFinite(config.maxTicks) || config.maxTicks < MIN_MAX_TICKS) {
    throw new RangeError(
      `S-4 的 maxTicks 至少要 ${MIN_MAX_TICKS}，收到 ${String(config.maxTicks)}`,
    );
  }
  const [roll, rng] = nextFrom(rngStateFor(seed, 's4-serve'));
  const angle = (roll * 2 - 1) * SERVE_ANGLE;
  const vx = BALL_SPEED * Math.sin(angle);
  const vy = BALL_SPEED * Math.cos(angle);
  return {
    tick: 0,
    maxTicks: Math.min(config.maxTicks, DEFAULT_MAX_TICKS),
    bricks: Array.from({ length: BRICK_COUNT }, () => 0),
    bombs: pickBombs(seed),
    paddles: [
      { x: START_X, v: 0 },
      { x: START_X, v: 0 },
    ],
    // 轉 180 度對稱：另一顆球的水平與垂直速度正好相反。
    balls: [
      { x: START_X, y: CONTACT_Y[0], vx, vy: -vy, owner: 0, respawn: 0 },
      { x: START_X, y: CONTACT_Y[1], vx: -vx, vy, owner: 1, respawn: 0 },
    ],
    score: [0, 0],
    rng,
  };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function movePaddle(p: S4Paddle, keys: Buttons): S4Paddle {
  const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const v = dir === 0 ? 0 : dir * (keys.a ? PADDLE_SLOW : PADDLE_V);
  return { x: clamp(p.x + v, PADDLE_MIN_X, PADDLE_MAX_X), v };
}

function allGone(bricks: readonly number[]): boolean {
  for (const v of bricks) {
    if (v === 0) {
      return false;
    }
  }
  return true;
}

export function isOver(s: S4State): boolean {
  return s.tick >= s.maxTicks || allGone(s.bricks);
}

export function step(s: S4State, inputs: Inputs): S4State {
  if (isOver(s)) {
    return s;
  }
  const tick = s.tick + 1;
  const paddles: readonly [S4Paddle, S4Paddle] = [
    movePaddle(s.paddles[0], inputs[0]),
    movePaddle(s.paddles[1], inputs[1]),
  ];
  let bricks: readonly number[] = s.bricks;
  let mutable: number[] | null = null;
  const points: [number, number] = [s.score[0], s.score[1]];
  let rng = s.rng;
  const balls: [S4Ball, S4Ball] = [s.balls[0], s.balls[1]];

  for (const i of [0, 1] as const) {
    const b = s.balls[i];
    if (b.respawn > 0) {
      if (b.respawn > 1) {
        balls[i] = { ...b, respawn: b.respawn - 1 };
      } else {
        const [launched, next] = serve(i, paddles[i].x, rng);
        balls[i] = launched;
        rng = next;
      }
      continue;
    }
    const m = moveFree(b, bricks);
    if (m.brick >= 0) {
      const gone = s.bombs.includes(m.brick) ? blast(bricks, s.bombs, m.brick) : [m.brick];
      mutable ??= s.bricks.slice();
      for (const k of gone) {
        mutable[k] = 1;
      }
      bricks = mutable;
      points[b.owner] += gone.length;
    }
    const side: Side = m.vy > 0 ? 0 : 1;
    if (crossesContact(side, b.y, m.y, m.vy)) {
      const line = CONTACT_Y[side];
      const arriveX = b.x + (m.x - b.x) * ((line - b.y) / (m.y - b.y));
      if (Math.abs(arriveX - paddles[side].x) <= PADDLE_REACH) {
        balls[i] = struck(side, arriveX, arriveX - paddles[side].x);
        continue;
      }
    }
    if (side === 0 ? m.y > FIELD_H : m.y < 0) {
      // 球穿過 `side` 那一邊的底線：那一邊扣 2 分；這顆球 45 tick 後從它自己那一邊（第 i 格）的板子重發。
      points[side] -= MISS_PENALTY;
      balls[i] = {
        x: paddles[i].x,
        y: CONTACT_Y[i],
        vx: 0,
        vy: 0,
        owner: i,
        respawn: RESPAWN_TICKS,
      };
      continue;
    }
    balls[i] = { x: m.x, y: m.y, vx: m.vx, vy: m.vy, owner: b.owner, respawn: 0 };
  }

  return { ...s, tick, bricks, paddles, balls, score: points, rng };
}

export function score(s: S4State): readonly [number, number] {
  return s.score;
}

export function winner(s: S4State): Side | null {
  if (!isOver(s)) {
    return null;
  }
  const [a, b] = s.score;
  return a > b ? 0 : b > a ? 1 : null;
}

// ---------------------------------------------------------------------------
// 動作
// ---------------------------------------------------------------------------

const R: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
/** 全放開（排第一）、左、右、a＋左、a＋右。 */
const ACTIONS: readonly Buttons[] = [
  R,
  { ...R, left: true },
  { ...R, right: true },
  { ...R, left: true, a: true },
  { ...R, right: true, a: true },
];

export function actions(): readonly Buttons[] {
  return ACTIONS;
}

// ---------------------------------------------------------------------------
// 預測（給 AI 的 evaluate 用；和 step 用同一套 moveFree，所以預測是精確的）
// ---------------------------------------------------------------------------

export interface Arrival {
  /** 幾個 tick 之後球穿過那條接球線。 */
  readonly ticks: number;
  /** 穿過線的那一刻球心的 x。 */
  readonly x: number;
}

interface Flight {
  /** 到達 `target` 那一邊接球線的時間與位置；半路碰到別的東西、或先到了另一邊的線，就是 null。 */
  readonly arrival: Arrival | null;
  /** 路上碰到的第一塊磚（−1：沒有）與碰到的時間。 */
  readonly brick: number;
  readonly brickTicks: number;
}

/**
 * 球照目前的速度一直飛（含側牆與碰磚反彈；碰過的磚在預測裡當作沒了），什麼時候、在哪個 x 抵達 `target` 的接球線。
 * `stopAtBrick`：碰到第一塊磚就停（算「這一擊會敲到哪塊磚」用）。球先到了另一邊的接球線（那邊的板子會怎麼做不知道）或飛出場地，arrival 是 null。
 */
function flight(
  ball: Motion,
  bricks: readonly number[],
  bombs: readonly number[],
  target: Side,
  stopAtBrick: boolean,
): Flight {
  let x = ball.x;
  let y = ball.y;
  let vx = ball.vx;
  let vy = ball.vy;
  let local = bricks;
  let copied = false;
  let firstBrick = -1;
  let firstTicks = 0;
  for (let t = 1; t <= MAX_FLIGHT; t += 1) {
    const px = x;
    const py = y;
    const m = moveFree({ x, y, vx, vy }, local);
    x = m.x;
    y = m.y;
    vx = m.vx;
    vy = m.vy;
    if (m.brick >= 0) {
      if (firstBrick < 0) {
        firstBrick = m.brick;
        firstTicks = t;
      }
      if (stopAtBrick) {
        return { arrival: null, brick: firstBrick, brickTicks: firstTicks };
      }
      const gone = bombs.includes(m.brick) ? blast(local, bombs, m.brick) : [m.brick];
      if (!copied) {
        local = local.slice();
        copied = true;
      }
      for (const k of gone) {
        (local as number[])[k] = 1;
      }
    }
    const side: Side = vy > 0 ? 0 : 1;
    if (crossesContact(side, py, y, vy)) {
      if (side !== target) {
        return { arrival: null, brick: firstBrick, brickTicks: firstTicks };
      }
      const line = CONTACT_Y[side];
      return {
        arrival: { ticks: t, x: px + (x - px) * ((line - py) / (y - py)) },
        brick: firstBrick,
        brickTicks: firstTicks,
      };
    }
    if (y > FIELD_H || y < 0) {
      break;
    }
  }
  return { arrival: null, brick: firstBrick, brickTicks: firstTicks };
}

/** 第 `index` 格的球什麼時候、在哪個 x 抵達 `side` 那一邊的接球線（精確物理；測試的劇本玩家也用它）。到不了是 null。 */
export function predictArrival(s: S4State, index: 0 | 1, side: Side): Arrival | null {
  const ball = s.balls[index];
  if (ball.respawn > 0) {
    return null;
  }
  return flight(ball, s.bricks, s.bombs, side, false).arrival;
}

export interface StrikeOutcome {
  /** 這一擊之後球碰到的第一塊磚（−1：沒有，球穿過洞到對方那一半）與幾個 tick 之後。 */
  readonly brick: number;
  readonly ticks: number;
  /** 穿牆時：抵達對方接球線的 x 與幾個 tick 之後（沒穿牆是 null）。 */
  readonly exit: Arrival | null;
}

/** 板子在 `side` 這一邊，球在 x = `hitX` 離板心 `offset` 的地方被擊中之後，球會怎麼飛（測試的劇本玩家用）。 */
export function strikeOutcome(s: S4State, side: Side, hitX: number, offset: number): StrikeOutcome {
  const f = flight(struck(side, hitX, offset), s.bricks, s.bombs, other(side), true);
  return { brick: f.brick, ticks: f.brickTicks, exit: f.arrival };
}

// ---------------------------------------------------------------------------
// 評估（給 AI）
// ---------------------------------------------------------------------------

/** 搶到對手的球再打回去（偷球）被扣的分（小規格：−3）。 */
const STEAL_PENALTY = 3;
/** 45 tick 沒有球可打大約少敲多少塊磚（一來回約 80 tick 一塊）。 */
const BALL_LOSS = 0.6;
/** 對手的球預計先到同一塊磚時，這塊磚只算多少（小規格：0.4）。 */
const CONTEST_FACTOR = 0.4;
/** 對手有一欄快被挖通而我可以守（小規格：8）。 */
const GUARD_WEIGHT = 8;
/** 「快被挖通」：這一欄還剩幾塊以內。 */
const NEARLY_OPEN = 1;
/** 沒有球要接的時候，守的誘因最多算到球還有幾 tick 抵達。 */
const GUARD_UNTIL = 30;
/** 接不到的時候，離板子能碰到的範圍每多一像素扣多少 gain（讓離得遠的動作也有往球靠近的梯度）。 */
const MISS_SLOPE = 0.1;
const MISS_VALUE = -(MISS_PENALTY + BALL_LOSS);
/** 偏好板心：|o| 每 1 扣多少（只用來在價值一樣的落點之間挑靠中間的）。 */
const CENTER_BIAS = 0.3;
/** 擊球落點超過 |o| = 0.7 的漏接風險：到 |o| = 1 扣滿這麼多。 */
const RIM_RISK = MISS_PENALTY + BALL_LOSS;
/** 瞄準的格數（o 從 −1 到 1，每格 1 / PLAN_STEPS）與「板子現在的位置離最好落點每一像素」扣多少。 */
const PLAN_STEPS = 10;
const PLAN_PULL = 0.03;
/** 球還有幾個 tick 以內抵達，才依候選動作的方向分開算落點。 */
const NEAR_TICKS = 50;

interface Incoming {
  readonly arrival: Arrival;
  /** 這顆球是 `balls` 的第幾格。 */
  readonly index: 0 | 1;
}

function activeBalls(s: S4State): (0 | 1)[] {
  const out: (0 | 1)[] = [];
  for (const i of [0, 1] as const) {
    if (s.balls[i].respawn === 0) {
      out.push(i);
    }
  }
  return out;
}

/** 某一格的球「如果繼續飛」會先碰到哪塊磚、什麼時候；沒有就 null。 */
function firstContact(s: S4State, index: 0 | 1): { brick: number; ticks: number } | null {
  const f = flight(s.balls[index], s.bricks, s.bombs, 0, true);
  return f.brick >= 0 ? { brick: f.brick, ticks: f.brickTicks } : null;
}

/** 跟 `mine` 這塊磚「同一塊」：同一塊，或對手那顆球碰到的是它旁邊的炸彈。 */
function sameTarget(s: S4State, theirs: number, mine: number): boolean {
  if (theirs === mine) {
    return true;
  }
  return (
    s.bombs.includes(theirs) &&
    Math.abs(Math.floor(theirs / COLS) - Math.floor(mine / COLS)) <= 1 &&
    Math.abs((theirs % COLS) - (mine % COLS)) <= 1
  );
}

/** 這顆球穿過洞到對方那一邊，對方的板子接得到的機率（0 到 1）：離落點越遠越低；對方還要忙著接自己的球時更低。 */
function catchProbability(
  s: S4State,
  side: Side,
  exit: Arrival,
  delay: number,
  skip: 0 | 1,
): number {
  const opp = other(side);
  const them = s.paddles[opp];
  const time = delay + exit.ticks;
  const span = PADDLE_V * time + PADDLE_REACH;
  let p = 1 - 0.5 * clamp(Math.abs(exit.x - them.x) / span, 0, 1);
  for (const i of activeBalls(s)) {
    if (i === skip) {
      continue;
    }
    const f = flight(s.balls[i], s.bricks, s.bombs, opp, false);
    if (f.arrival === null) {
      continue;
    }
    const need = Math.max(0, Math.abs(f.arrival.x - exit.x) - 2 * PADDLE_REACH);
    if (need > PADDLE_V * Math.abs(f.arrival.ticks - time)) {
      p *= 0.4;
    }
  }
  return p;
}

/**
 * 一顆我的球接下來的第一個結果值多少：碰到的磚數（炸彈算整片、對手的球預計先到同一塊就打折），
 * 或穿過洞到對方那一半的賭注（對手接不到 +1.4，被接住 −3）。`delay` 是這顆球出發之前還要等幾個 tick。
 */
function outcomeValue(s: S4State, side: Side, f: Flight, delay: number, own: 0 | 1): number {
  if (f.brick >= 0) {
    const count = s.bombs.includes(f.brick) ? blast(s.bricks, s.bombs, f.brick).length : 1;
    const when = delay + f.brickTicks;
    for (const i of activeBalls(s)) {
      if (i === own) {
        continue;
      }
      const theirs = firstContact(s, i);
      if (theirs !== null && theirs.ticks < when && sameTarget(s, theirs.brick, f.brick)) {
        return count * CONTEST_FACTOR;
      }
    }
    return count;
  }
  if (f.arrival !== null) {
    const p = catchProbability(s, side, f.arrival, delay, own);
    return (1 - p) * (MISS_PENALTY - BALL_LOSS) - p * STEAL_PENALTY;
  }
  return 0;
}

/** 這一擊（板子落在離球 `offset` 的地方）預計換來多少。 */
function returnValue(s: S4State, side: Side, incoming: Incoming, offset: number): number {
  const hit = struck(side, incoming.arrival.x, offset);
  const f = flight(hit, s.bricks, s.bombs, other(side), true);
  return outcomeValue(s, side, f, incoming.arrival.ticks, incoming.index);
}

/** 我已經打出去、正飛向牆（或對方）的球：它的第一個結果值多少。剛打出去的那個 tick，擊球的好壞就是從這裡算進 gain。 */
function pendingValue(s: S4State, side: Side): number {
  let total = 0;
  for (const i of activeBalls(s)) {
    const ball = s.balls[i];
    const away = side === 0 ? ball.vy < 0 : ball.vy > 0;
    if (ball.owner === side && away) {
      total += outcomeValue(s, side, flight(ball, s.bricks, s.bombs, other(side), true), 0, i);
    }
  }
  return total;
}

/**
 * 同一個局面的五個候選動作（以及搜尋型往前看的好幾步）會重複問同一批「球在離板心 `offset` 的地方被擊中值多少」，
 * 答案只跟球、磚、對手的板子有關，跟候選動作無關，所以記在一個小表裡。表是純函式的快取：鍵包含所有會影響答案的東西，
 * 命中與重算的結果逐位元相同（`logic.test.ts` 比對過）。以磚的陣列為索引：磚沒變，陣列就是同一個物件。
 */
const SCORE_MEMO = new WeakMap<readonly number[], Map<string, Map<number, number>>>();

function memoFor(s: S4State, side: Side, incoming: Incoming): Map<number, number> {
  let byContext = SCORE_MEMO.get(s.bricks);
  if (byContext === undefined) {
    byContext = new Map();
    SCORE_MEMO.set(s.bricks, byContext);
  }
  const rival = s.balls[incoming.index === 0 ? 1 : 0];
  const key = `${side}|${incoming.index}|${incoming.arrival.x}|${incoming.arrival.ticks}|${rival.x}|${rival.y}|${rival.vx}|${rival.vy}|${rival.respawn}|${s.paddles[other(side)].x}|${s.bombs.join(',')}`;
  let table = byContext.get(key);
  if (table === undefined) {
    if (byContext.size >= 64) {
      byContext.clear();
    }
    table = new Map();
    byContext.set(key, table);
  }
  return table;
}

/** 一擊的價值（含一點偏好板心）：`offset` 是球離板心的距離。擊球越靠邊越有漏接的風險，所以 |o| 超過 0.7 要扣一點。 */
function strikeScore(
  s: S4State,
  side: Side,
  incoming: Incoming,
  offset: number,
  table: Map<number, number>,
): number {
  const known = table.get(offset);
  if (known !== undefined) {
    return known;
  }
  const reach = Math.abs(offset) / PADDLE_REACH;
  const value =
    returnValue(s, side, incoming, offset) -
    CENTER_BIAS * reach -
    RIM_RISK * clamp((reach - 0.7) / 0.3, 0, 1);
  table.set(offset, value);
  return value;
}

interface Spot {
  /** 板子最後站的位置。 */
  readonly spot: number;
  /** 這個落點的價值（已扣掉從現在的位置走過去的一點成本）。 */
  readonly value: number;
  /** 球抵達之前這個方向上怎麼走都接不到。 */
  readonly miss: boolean;
}

/**
 * 這個候選動作（state 裡板子的指令速度 `v` 就是它）的最好落點：板子往 `v` 的方向（`v` = 0 就是留在原地）走，
 * 球抵達之前走得到的範圍裡，掃 o ∈ [−1, 1]（21 格，再加範圍的兩端與正對球的位置），取價值最高的。
 * 價值 = 這一擊換來的（`strikeScore`）− `PLAN_PULL` × 要走的距離。
 *
 * 為什麼是「往這個方向的最好落點」而不是「照現在的速度走到球抵達」：後者每個候選動作的落點會隨每個 tick 一起平移，
 * 窄窄的炸彈窗口（約 4 像素寬）只會被碰巧踩到，每個 tick 重新決定的玩家（等級 10）根本瞄不準；
 * 前者每個方向各有一個固定的目標，往目標走的動作價值一樣高、走過頭的動作看不到目標，所以會在目標上停下來。
 */
function chooseSpot(s: S4State, side: Side, incoming: Incoming, me: S4Paddle): Spot {
  // 球還遠（多於 NEAR_TICKS）：不分方向，整個走得到的範圍都算（現在不必決定要往哪邊走，走幾步之後再說）；
  // 球近了：只算這個候選動作的方向，這時候選哪個動作才是承諾。
  const far = incoming.arrival.ticks > NEAR_TICKS;
  const reach = (far ? PADDLE_V : Math.abs(me.v)) * incoming.arrival.ticks;
  const lo = far || me.v < 0 ? Math.max(PADDLE_MIN_X, me.x - reach) : me.x;
  const hi = far || me.v > 0 ? Math.min(PADDLE_MAX_X, me.x + reach) : me.x;
  const table = memoFor(s, side, incoming);
  const xa = incoming.arrival.x;
  const spots: number[] = [lo, hi, clamp(xa, lo, hi)];
  for (let k = -PLAN_STEPS; k <= PLAN_STEPS; k += 1) {
    const spot = xa - (k / PLAN_STEPS) * PADDLE_REACH;
    if (spot >= lo && spot <= hi) {
      spots.push(spot);
    }
  }
  let best: Spot | null = null;
  for (const spot of spots) {
    const offset = xa - spot;
    if (Math.abs(offset) > PADDLE_REACH) {
      continue;
    }
    const value = strikeScore(s, side, incoming, offset, table) - PLAN_PULL * Math.abs(spot - me.x);
    if (best === null || value > best.value + 1e-9) {
      best = { spot, value, miss: false };
    }
  }
  if (best !== null) {
    return best;
  }
  const nearest = clamp(xa, lo, hi);
  return {
    spot: nearest,
    value: MISS_VALUE - MISS_SLOPE * (Math.abs(xa - nearest) - PADDLE_REACH),
    miss: true,
  };
}

/** 還剩 `NEARLY_OPEN` 塊以內的欄（含已經通了的），回傳欄中心的 x。 */
function nearlyOpenColumns(bricks: readonly number[]): number[] {
  const out: number[] = [];
  for (let c = 0; c < COLS; c += 1) {
    let alive = 0;
    for (let r = 0; r < ROWS; r += 1) {
      alive += bricks[r * COLS + c] === 0 ? 1 : 0;
    }
    if (alive <= NEARLY_OPEN) {
      out.push(c * BRICK_W + BRICK_W / 2);
    }
  }
  return out;
}

/**
 * 給 AI 的評估（小規格「動作與評估」）。
 *
 * gain（以「磚」為單位，一分 = 1000）：
 *  - 分差 × 1000（結束的局只剩這一項）；
 *  - 我已經打出去的球，第一個結果值多少（`pendingValue`）：敲到幾塊磚（炸彈算整片、對手的球預計先到同一塊就打折 0.4），
 *    或穿過洞到對方那一半的賭注（對手接不到 +1.4、被接住 −3）；
 *  - 下一顆要接的球，在「這個候選動作的方向上最好的落點」擊中會換來什麼（`chooseSpot`），再扣一點走過去的距離；
 *  - 閒著的時候往中間靠，對手有一欄快通了、它又有球在打，站到那一欄底下（+8）。
 * danger：接球落點的 |o| 超過 0.7 起上升、到 1 為 1；球抵達之前這個方向上怎麼走都接不到是 1；後面還有球要接而來不及走過去也算。
 *
 * 不讀：`rng`（還沒發生的發球）。兩邊分數同時加上同一個常數 evaluate 不變（沒有依分差的分支）。
 * 對手的板子（位置）、對手的球只用在「對手接不接得到穿牆球」與「對手的球會不會先到同一塊磚」。
 */
function evaluateS4(s: S4State, side: Side): { gain: number; danger: number } {
  const opp = other(side);
  const base = SCORE_UNIT * (s.score[side] - s.score[opp]);
  if (isOver(s)) {
    return { gain: base, danger: 0 };
  }
  const me = s.paddles[side];
  const incoming: Incoming[] = [];
  for (const i of activeBalls(s)) {
    const f = flight(s.balls[i], s.bricks, s.bombs, side, false);
    if (f.arrival !== null) {
      incoming.push({ arrival: f.arrival, index: i });
    }
  }
  incoming.sort((a, b) => a.arrival.ticks - b.arrival.ticks);

  let gain = base + pendingValue(s, side);
  let danger = 0;
  const first = incoming[0];
  if (first !== undefined) {
    const plan = chooseSpot(s, side, first, me);
    gain += plan.value;
    danger = plan.miss
      ? 1
      : first.arrival.ticks > NEAR_TICKS
        ? 0
        : clamp((Math.abs(first.arrival.x - plan.spot) / PADDLE_REACH - 0.7) / 0.3, 0, 1);
    // 後面還有球要接：接完前一顆之後，來得及走到嗎。
    let at = plan.spot;
    let when = first.arrival.ticks;
    for (const next of incoming.slice(1)) {
      const need = Math.max(0, Math.abs(next.arrival.x - at) - 0.7 * PADDLE_REACH);
      const can = PADDLE_V * (next.arrival.ticks - when);
      const d = need <= 0 ? 0 : clamp((need / Math.max(can, 1e-9) - 0.7) / 0.3, 0, 1);
      danger = Math.max(danger, d);
      at = next.arrival.x;
      when = next.arrival.ticks;
    }
  }

  if (first === undefined || first.arrival.ticks > GUARD_UNTIL) {
    // 閒著：往中間靠，對手有一欄快通了而且它有球在打的時候，站到那一欄底下。
    gain -= 0.02 * Math.abs(me.x - START_X);
    if (activeBalls(s).length > 0) {
      let guard = 0;
      for (const cx of nearlyOpenColumns(s.bricks)) {
        guard = Math.max(guard, 1 - clamp(Math.abs(me.x - cx) / 60, 0, 1));
      }
      gain += GUARD_WEIGHT * guard;
    }
  }
  return { gain, danger };
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export const s4Game: Game<S4State> = {
  id: 'S-4',
  init,
  step,
  isOver,
  score,
  winner,
  actions,
  evaluate: evaluateS4,
};

// ---------------------------------------------------------------------------
// 測試用：直接構造局面
// ---------------------------------------------------------------------------

export interface S4StateOverrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  /** 已經被敲掉的磚。 */
  readonly gone?: readonly number[];
  /** 炸彈磚；預設沒有。 */
  readonly bombs?: readonly number[];
  readonly paddles?: readonly [Partial<S4Paddle>, Partial<S4Paddle>];
  readonly balls?: readonly [Partial<S4Ball>, Partial<S4Ball>];
  readonly score?: readonly [number, number];
  readonly rng?: RngState;
}

/**
 * 測試用：預設是「牆 60 塊都在、沒有炸彈、兩塊板子在 75 不動、分數 0 比 0」，兩顆球都停放（還要 500 tick 才發）。
 * 球只要給了就是你給的樣子，沒寫的欄位用預設（`respawn` 沒寫也是 500，要讓球在飛要寫 `respawn: 0`）。
 */
export function makeState(o: S4StateOverrides = {}): S4State {
  const gone = new Set(o.gone ?? []);
  const paddle = (p: Partial<S4Paddle> | undefined): S4Paddle => ({
    x: p?.x ?? START_X,
    v: p?.v ?? 0,
  });
  const ball = (slot: Side, p: Partial<S4Ball> | undefined): S4Ball => ({
    x: p?.x ?? START_X,
    y: p?.y ?? CONTACT_Y[slot],
    vx: p?.vx ?? 0,
    vy: p?.vy ?? 0,
    owner: p?.owner ?? slot,
    respawn: p?.respawn ?? 500,
  });
  return {
    tick: o.tick ?? 0,
    maxTicks: o.maxTicks ?? DEFAULT_MAX_TICKS,
    bricks: Array.from({ length: BRICK_COUNT }, (_v, i) => (gone.has(i) ? 1 : 0)),
    bombs: o.bombs ?? [],
    paddles: [paddle(o.paddles?.[0]), paddle(o.paddles?.[1])],
    balls: [ball(0, o.balls?.[0]), ball(1, o.balls?.[1])],
    score: o.score ?? [0, 0],
    rng: o.rng ?? rngStateFor(0, 's4-serve'),
  };
}
