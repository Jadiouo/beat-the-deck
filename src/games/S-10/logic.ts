import { nextFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  BULLET_R,
  FIELD_H,
  FIELD_W,
  HIT_DIST,
  INVULN_TICKS,
  PLAYER_R,
  SLOW_SPEED,
  SPEED,
  START_Y,
  actionsSpades,
} from '../_spades/logic';

/**
 * S-10 彈幕（小規格 `docs/cards/S-10.md`）。
 * 兩個人站在同一個場地、面對同一組彈幕；全場 3 次「清場」共用、先按先得，按的人得到被清掉的子彈數。
 * 純的：亂數只用 `RngState`，時間只有 tick。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 一局的長度（45 秒）；`config.maxTicks` 比它短就用 `config.maxTicks`，但不可以短於 `MIN_TICKS`。 */
export const DURATION_TICKS = 2700;
export const MIN_TICKS = 600;

/** 發射口。 */
export const EMITTER_X = FIELD_W / 2;
export const EMITTER_Y = 12;

/** 螺旋：每 6 tick 一顆（第二階段起兩顆、相隔 180 度），每發轉 17 度，速度 1.1。 */
export const SPIRAL_EVERY = 6;
export const SPIRAL_STEP = (17 * Math.PI) / 180;
export const SPIRAL_SPEED = 1.1;
/** 扇形：九顆、張角 80 度、速度 1.6；每 120 tick（第三階段每 90 tick）一次，輪流瞄準兩個玩家。 */
export const FAN_BULLETS = 9;
export const FAN_SPREAD = (80 * Math.PI) / 180;
export const FAN_SPEED = 1.6;
export const FAN_EVERY = 120;
export const FAN_EVERY_LATE = 90;
/** 扇形每顆的抖動：正負這麼多度。 */
export const FAN_JITTER = (3 * Math.PI) / 180;
/** 階段：900 起雙臂；1800 起螺旋轉向每 300 tick 反轉，扇形加快。 */
export const PHASE_DOUBLE_AT = 900;
export const PHASE_LATE_AT = 1800;
export const REVERSE_EVERY = 300;

/** 清場。 */
export const CLEARS = 3;
export const CLEAR_FROM = 300;
/** 最後一次清場要到這個 tick 才能按（小規格「誠實的疑慮」預先批准的補救：前兩次太早用完時）。 */
export const LAST_CLEAR_FROM = 1200;
export const QUIET_TICKS = 45;
/** 清場要場上至少這麼多顆子彈才有效（老闆裁定；沒有達到時按 b 不發生任何事）。 */
export const CLEAR_MIN = 8;
/** 子彈不足就按，按的人被鎖住這麼多個 tick（2 秒）不能清場。 */
export const CLEAR_LOCK = 120;
export const CLEAR_CAP = 60;
export const HIT_PENALTY = 10;

export const START_X: readonly [number, number] = [45, 105];

/** 險度：離最近的子彈中心小於 EXPOSURE_FAR 才算有險（碰到是 HIT_DIST），移動平均的時間常數是 EXPOSURE_TAU 個 tick。 */
export const EXPOSURE_FAR = 12;
export const EXPOSURE_TAU = 30;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface S10Bullet {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

export interface S10Player {
  readonly x: number;
  readonly y: number;
  /** 上一個 tick 的速度（給 `evaluate` 預測用）。 */
  readonly vx: number;
  readonly vy: number;
  /** 還剩幾個 tick 無敵。 */
  readonly invuln: number;
  readonly hits: number;
}

export interface S10State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly bullets: readonly S10Bullet[];
  readonly players: readonly [S10Player, S10Player];
  /** 全場還剩幾次清場（兩邊共用）。 */
  readonly clears: number;
  /** 清場之後還要幾個 tick 才會再發子彈。 */
  readonly quiet: number;
  /** 每次清場之後的無彈 tick 數（一局固定；消融用）。 */
  readonly quietFor: number;
  /** 最後一次清場從第幾個 tick 起才能按（一局固定；消融用）。 */
  readonly lastFrom: number;
  /** 清場要場上至少幾顆子彈才有效（一局固定）。 */
  readonly minBullets: number;
  /** 子彈不足門檻時按 b：true 是照扣一次共用的清場（沒有分數、子彈不消失），false 是無效、不扣。 */
  readonly burn: boolean;
  /** 子彈不足門檻就按，按的人被鎖住這麼多個 tick 不能清場（0 是關著；一局固定）。 */
  readonly lockTicks: number;
  /** 各自還要被鎖幾個 tick（公開）。 */
  readonly lock: readonly [number, number];
  /** 各自清場得到的分數總和。 */
  readonly cleared: readonly [number, number];
  /** 公開的「險度」：最近幾十個 tick 裡，離子彈有多近（0 到 1 的移動平均）。AI 讀它來猜對手快不快撐不住。 */
  readonly exposure: readonly [number, number];
  /** 扇形已經發了幾次（偶數次瞄 0 號、奇數次瞄 1 號）。 */
  readonly fanCount: number;
  /** 螺旋目前的角度（弧度）與最初的旋轉方向（1 或 −1，由種子決定）。 */
  readonly angle: number;
  readonly spin: 1 | -1;
  readonly rng: RngState;
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export interface S10Options {
  /** 全場共用幾次清場（預設 3）。 */
  readonly clears?: number;
  /** 清場之後幾個 tick 不發子彈（預設 45）。 */
  readonly quiet?: number;
  /** 最後一次清場從第幾個 tick 起才能按（預設 1200）。 */
  readonly lastFrom?: number;
  /** 清場要場上至少幾顆子彈才有效（預設 `CLEAR_MIN`）。 */
  readonly minBullets?: number;
  /** 子彈不足門檻時按 b 要不要照扣一次共用的清場（預設不扣）。 */
  readonly burn?: boolean;
  /** 子彈不足門檻就按要被鎖幾個 tick（預設 `CLEAR_LOCK`；0 是不鎖）。 */
  readonly lockTicks?: number;
  /** AI 的 `evaluate` 讀不讀對手的 danger（預設讀）。 */
  readonly readsDanger?: boolean;
}

export function initState(seed: number, config: GameConfig, options: S10Options = {}): S10State {
  if (config.maxTicks < MIN_TICKS) {
    throw new RangeError(`S-10 的 maxTicks 至少要 ${MIN_TICKS}，收到 ${String(config.maxTicks)}`);
  }
  const [r1, s1] = nextFrom(rngStateFor(seed, 'barrage'));
  const [r2, s2] = nextFrom(s1);
  const player = (x: number): S10Player => ({ x, y: START_Y, vx: 0, vy: 0, invuln: 0, hits: 0 });
  return {
    tick: 0,
    maxTicks: Math.min(config.maxTicks, DURATION_TICKS),
    bullets: [],
    players: [player(START_X[0]), player(START_X[1])],
    clears: options.clears ?? CLEARS,
    quiet: 0,
    quietFor: options.quiet ?? QUIET_TICKS,
    lastFrom: options.lastFrom ?? LAST_CLEAR_FROM,
    minBullets: options.minBullets ?? CLEAR_MIN,
    burn: options.burn ?? false,
    lockTicks: options.lockTicks ?? CLEAR_LOCK,
    lock: [0, 0],
    cleared: [0, 0],
    exposure: [0, 0],
    fanCount: 0,
    angle: r1 * Math.PI * 2,
    spin: r2 < 0.5 ? 1 : -1,
    rng: s2,
  };
}

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

/** 這個 tick 發射的螺旋轉哪個方向：1800 之前是最初的方向，之後每 300 tick 反轉（1800 那一刻就反轉）。 */
function spinAt(tick: number, spin: 1 | -1): number {
  if (tick < PHASE_LATE_AT) {
    return spin;
  }
  return Math.floor((tick - PHASE_LATE_AT) / REVERSE_EVERY) % 2 === 0 ? -spin : spin;
}

function fanEvery(tick: number): number {
  return tick >= PHASE_LATE_AT ? FAN_EVERY_LATE : FAN_EVERY;
}

function movePlayer(p: S10Player, buttons: Buttons): S10Player {
  const dx = (buttons.right ? 1 : 0) - (buttons.left ? 1 : 0);
  const dy = (buttons.down ? 1 : 0) - (buttons.up ? 1 : 0);
  const speed = buttons.a ? SLOW_SPEED : SPEED;
  const along = dx !== 0 && dy !== 0 ? speed * Math.SQRT1_2 : speed;
  const vx = dx === 0 ? 0 : dx * along;
  const vy = dy === 0 ? 0 : dy * along;
  return {
    ...p,
    x: clamp(p.x + vx, PLAYER_R, FIELD_W - PLAYER_R),
    y: clamp(p.y + vy, PLAYER_R, FIELD_H - PLAYER_R),
    vx,
    vy,
  };
}

function inField(x: number, y: number): boolean {
  return x >= -BULLET_R && x <= FIELD_W + BULLET_R && y >= -BULLET_R && y <= FIELD_H + BULLET_R;
}

/** 按得下去：次數還有、第 300 tick 起（最後一次到 lastFrom）、不在無彈期。不看子彈夠不夠。 */
function pressable(state: S10State): boolean {
  return (
    state.clears > 0 &&
    state.tick >= (state.clears === 1 ? state.lastFrom : CLEAR_FROM) &&
    state.quiet === 0
  );
}

/** 現在能不能清場：按得下去，而且場上至少有 `minBullets` 顆子彈（至少 1 顆）。 */
export function canClear(state: S10State): boolean {
  return pressable(state) && state.bullets.length >= Math.max(1, state.minBullets);
}

export function isOver(state: S10State): boolean {
  return state.tick >= state.maxTicks;
}

export function step(state: S10State, inputs: Inputs): S10State {
  if (isOver(state)) {
    return state;
  }
  const next = state.tick + 1;

  // 1. 移動
  const moved: [S10Player, S10Player] = [
    movePlayer(state.players[0], inputs[0]),
    movePlayer(state.players[1], inputs[1]),
  ];

  // 2. 清場：先於子彈移動與命中，所以按下去的那一刻就保護了自己。
  let bullets = state.bullets;
  let clears = state.clears;
  let quiet = state.quiet;
  let cleared = state.cleared;
  // 被鎖住的那一邊按 b 沒有用；鎖每個 tick 減 1（先減，再看這個 tick 有沒有新的鎖）。
  const press0 = inputs[0].b && state.lock[0] === 0;
  const press1 = inputs[1].b && state.lock[1] === 0;
  const lock: [number, number] = [Math.max(0, state.lock[0] - 1), Math.max(0, state.lock[1] - 1)];
  const pressed = press0 || press1;
  const early = pressed && !canClear(state) && pressable(state);
  if (early && state.burn) {
    // 照扣的變體：子彈不夠就按，白白用掉一次共用的清場（兩邊同時按也只扣 1 次）。
    clears -= 1;
  }
  if (early && state.lockTicks > 0) {
    // 鎖住的變體：按早了的人（只有按的那一邊）被鎖住，這段時間不能清場。
    if (press0) {
      lock[0] = state.lockTicks;
    }
    if (press1) {
      lock[1] = state.lockTicks;
    }
  }
  if (pressed && canClear(state)) {
    const n = Math.min(bullets.length, CLEAR_CAP);
    if (press0 && press1) {
      const half = Math.floor(n / 2);
      cleared = [cleared[0] + half, cleared[1] + half];
    } else if (press0) {
      cleared = [cleared[0] + n, cleared[1]];
    } else {
      cleared = [cleared[0], cleared[1] + n];
    }
    bullets = [];
    clears -= 1;
    quiet = state.quietFor;
  }

  // 3. 子彈移動、離場、命中（一顆子彈同時碰到兩個沒有無敵的玩家，兩個都被打中）；
  //    同時量每個玩家離（剛飛完、還在的）子彈最近有多近，給險度用。
  const p0 = moved[0];
  const p1 = moved[1];
  let hit0 = false;
  let hit1 = false;
  let shield0 = p0.invuln > 0;
  let shield1 = p1.invuln > 0;
  let near0 = Number.POSITIVE_INFINITY;
  let near1 = Number.POSITIVE_INFINITY;
  const kept: S10Bullet[] = [];
  for (const b of bullets) {
    const x = b.x + b.vx;
    const y = b.y + b.vy;
    if (!inField(x, y)) {
      continue;
    }
    const d0x = x - p0.x;
    const d0y = y - p0.y;
    const d1x = x - p1.x;
    const d1y = y - p1.y;
    const d0 = d0x * d0x + d0y * d0y;
    const d1 = d1x * d1x + d1y * d1y;
    let consumed = false;
    if (!shield0 && d0 < HIT_DIST * HIT_DIST) {
      hit0 = true;
      consumed = true;
    }
    if (!shield1 && d1 < HIT_DIST * HIT_DIST) {
      hit1 = true;
      consumed = true;
    }
    shield0 = shield0 || hit0;
    shield1 = shield1 || hit1;
    if (!consumed) {
      kept.push({ x, y, vx: b.vx, vy: b.vy });
      if (d0 < near0) {
        near0 = d0;
      }
      if (d1 < near1) {
        near1 = d1;
      }
    }
  }
  const players: [S10Player, S10Player] = [
    {
      ...p0,
      hits: p0.hits + (hit0 ? 1 : 0),
      invuln: hit0 ? INVULN_TICKS : Math.max(0, p0.invuln - 1),
    },
    {
      ...p1,
      hits: p1.hits + (hit1 ? 1 : 0),
      invuln: hit1 ? INVULN_TICKS : Math.max(0, p1.invuln - 1),
    },
  ];

  // 險度：移動平均，每個 tick 看離最近的子彈有多近（EXPOSURE_FAR 以外算 0，碰到算 1）
  const close0 = clamp((EXPOSURE_FAR - Math.sqrt(near0)) / (EXPOSURE_FAR - HIT_DIST), 0, 1);
  const close1 = clamp((EXPOSURE_FAR - Math.sqrt(near1)) / (EXPOSURE_FAR - HIT_DIST), 0, 1);
  const exposure: [number, number] = [
    state.exposure[0] + (close0 - state.exposure[0]) / EXPOSURE_TAU,
    state.exposure[1] + (close1 - state.exposure[1]) / EXPOSURE_TAU,
  ];

  // 4. 發射：螺旋與扇形的時間表只看 tick；無彈期只是不放出來，角度、次數與亂數照走。
  const silent = quiet > 0;
  if (silent) {
    quiet -= 1;
  }
  let angle = state.angle;
  let rng = state.rng;
  let fanCount = state.fanCount;
  if (next % SPIRAL_EVERY === 0) {
    angle += spinAt(next, state.spin) * SPIRAL_STEP;
    if (!silent) {
      const arms = next >= PHASE_DOUBLE_AT ? 2 : 1;
      for (let arm = 0; arm < arms; arm += 1) {
        const a = angle + arm * Math.PI;
        kept.push({
          x: EMITTER_X,
          y: EMITTER_Y,
          vx: SPIRAL_SPEED * Math.cos(a),
          vy: SPIRAL_SPEED * Math.sin(a),
        });
      }
    }
  }
  if (next % fanEvery(next) === 0) {
    const target = players[fanCount % 2 === 0 ? 0 : 1];
    const dx = target.x - EMITTER_X;
    const dy = target.y - EMITTER_Y;
    const aim = dx === 0 && dy === 0 ? Math.PI / 2 : Math.atan2(dy, dx);
    for (let i = 0; i < FAN_BULLETS; i += 1) {
      const [roll, after] = nextFrom(rng);
      rng = after;
      if (!silent) {
        const a = aim + ((i - (FAN_BULLETS - 1) / 2) * FAN_SPREAD) / (FAN_BULLETS - 1) + (roll * 2 - 1) * FAN_JITTER;
        kept.push({
          x: EMITTER_X,
          y: EMITTER_Y,
          vx: FAN_SPEED * Math.cos(a),
          vy: FAN_SPEED * Math.sin(a),
        });
      }
    }
    fanCount += 1;
  }

  return {
    ...state,
    tick: next,
    bullets: kept,
    players,
    clears,
    quiet,
    lock,
    cleared,
    exposure,
    fanCount,
    angle,
    rng,
  };
}

export function score(state: S10State): readonly [number, number] {
  return [
    state.cleared[0] - HIT_PENALTY * state.players[0].hits,
    state.cleared[1] - HIT_PENALTY * state.players[1].hits,
  ];
}

export function winner(state: S10State): Side | null {
  if (!isOver(state)) {
    return null;
  }
  const [a, b] = score(state);
  return a > b ? 0 : b > a ? 1 : null;
}

// ---------------------------------------------------------------------------
// 動作
// ---------------------------------------------------------------------------

const MOVES: readonly Buttons[] = actionsSpades();
const MOVES_WITH_CLEAR: readonly Buttons[] = MOVES.map((m): Buttons => ({ ...m, b: true }));
const ALL_ACTIONS: readonly Buttons[] = [...MOVES, ...MOVES_WITH_CLEAR];

/** 17 個移動動作（全放開排第一）；現在能清場時再加上同樣 17 個加 b 的。 */
export function actions(state: S10State, side: Side): readonly Buttons[] {
  return canClear(state) && state.lock[side] === 0 ? ALL_ACTIONS : MOVES;
}

// ---------------------------------------------------------------------------
// 評估（給 AI）
// ---------------------------------------------------------------------------

/** 一分的 gain。 */
export const POINT = 100;
/** danger：往前預測幾個 tick，最近距離小於等於 HIT_DIST 是 1，大於等於 D_FAR 是 0。 */
export const HORIZON = 24;
export const D_FAR = 14;
/** 等待的價值：預測幾個 tick 後的子彈數。 */
export const WAIT_TICKS = 30;
/** 對手搶先按的機率：底數，加上對手 danger 的權重。 */
export const H_BASE = 0.5;
export const H_WEIGHT = 0.6;
/** h 的上限（1 − h 要留一點正的，不然等待的價值變成負的）。 */
export const H_MAX = 0.9;
/** 險度到這個值就算「滿」。 */
export const EXPOSURE_FULL = 0.05;
/** 「再等一次高峰」的預留價值：各階段子彈數的典型高峰，乘以 KAPPA。 */
export const REF_DENSITY = 40;
export const KAPPA = 0.5;
/** 剩下的時間不夠等一次高峰（每次清場留這麼多 tick）時，預留價值逐漸降到 0。 */
export const TICKS_PER_CLEAR = 100;
export const URGENCY_SPAN = 300;

/** 對手在 WAIT_TICKS 之內搶先按的機率：底數，加上對手險度（滿的時候最多加 H_WEIGHT），不超過 H_MAX。 */
export function opponentPressChance(exposure: number): number {
  return Math.min(H_MAX, H_BASE + H_WEIGHT * clamp(exposure / EXPOSURE_FULL, 0, 1));
}

const REACH = (SPIRAL_SPEED > FAN_SPEED ? SPIRAL_SPEED : FAN_SPEED) + SPEED;

/** 往前 HORIZON 個 tick，這個玩家照目前的速度一直走，離任何一顆子彈最近會靠到多近（沒有子彈是無限大）。 */
function nearestApproach(state: S10State, side: Side): number {
  const me = state.players[side];
  const start = me.invuln + 1;
  if (start > HORIZON) {
    return Number.POSITIVE_INFINITY;
  }
  const cut = REACH * HORIZON + D_FAR;
  const cut2 = cut * cut;
  let best = Number.POSITIVE_INFINITY;
  for (const b of state.bullets) {
    const ex = b.x - me.x;
    const ey = b.y - me.y;
    if (ex * ex + ey * ey > cut2) {
      continue;
    }
    for (let t = start; t <= HORIZON; t += 1) {
      const px = clamp(me.x + me.vx * t, PLAYER_R, FIELD_W - PLAYER_R);
      const py = clamp(me.y + me.vy * t, PLAYER_R, FIELD_H - PLAYER_R);
      const dx = b.x + b.vx * t - px;
      const dy = b.y + b.vy * t - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
      }
    }
  }
  return Math.sqrt(best);
}

/** 0 到 1：預測最近距離小於 5 是 1，大於 14 是 0。 */
export function dangerOf(state: S10State, side: Side): number {
  return clamp((D_FAR - nearestApproach(state, side)) / (D_FAR - HIT_DIST), 0, 1);
}

/** 嚴格晚於 `t` 的下一個扇形發射 tick（120 的倍數，1800 起改成 90 的倍數）。 */
function nextFanAfter(t: number): number {
  if (t < PHASE_LATE_AT) {
    return (Math.floor(t / FAN_EVERY) + 1) * FAN_EVERY;
  }
  return (Math.floor(t / FAN_EVERY_LATE) + 1) * FAN_EVERY_LATE;
}

/** `ticks` 個 tick 之後場上會有幾顆子彈：現有的照原方向飛，加上照發射規則（不含抖動）發出來的。 */
export function predictCount(state: S10State, ticks: number): number {
  let count = 0;
  for (const b of state.bullets) {
    if (inField(b.x + b.vx * ticks, b.y + b.vy * ticks)) {
      count += 1;
    }
  }
  const end = state.tick + ticks;
  // 螺旋：6 的倍數的 tick。無彈期內（前 quiet 個 tick）只轉角度，不放出來。
  let angle = state.angle;
  for (let t = (Math.floor(state.tick / SPIRAL_EVERY) + 1) * SPIRAL_EVERY; t <= end; t += SPIRAL_EVERY) {
    angle += spinAt(t, state.spin) * SPIRAL_STEP;
    if (t - state.tick <= state.quiet) {
      continue;
    }
    const flight = end - t;
    const dx = SPIRAL_SPEED * Math.cos(angle) * flight;
    const dy = SPIRAL_SPEED * Math.sin(angle) * flight;
    if (inField(EMITTER_X + dx, EMITTER_Y + dy)) {
      count += 1;
    }
    if (t >= PHASE_DOUBLE_AT && inField(EMITTER_X - dx, EMITTER_Y - dy)) {
      count += 1;
    }
  }
  // 扇形：瞄準現在的位置，輪流瞄兩個人。
  let fan = state.fanCount;
  for (let t = nextFanAfter(state.tick); t <= end; t = nextFanAfter(t)) {
    if (t - state.tick > state.quiet) {
      const target = state.players[fan % 2 === 0 ? 0 : 1];
      const aim = Math.atan2(target.y - EMITTER_Y, target.x - EMITTER_X);
      const flight = end - t;
      for (let i = 0; i < FAN_BULLETS; i += 1) {
        const a = aim + ((i - (FAN_BULLETS - 1) / 2) * FAN_SPREAD) / (FAN_BULLETS - 1);
        if (
          inField(
            EMITTER_X + FAN_SPEED * Math.cos(a) * flight,
            EMITTER_Y + FAN_SPEED * Math.sin(a) * flight,
          )
        ) {
          count += 1;
        }
      }
    }
    fan += 1;
  }
  return count;
}

/** 還握著 `c` 次清場、剩下 `left` tick 時，每一次「再等一次高峰」值多少分。 */
export function reserveFor(left: number, c: number): number {
  const urgency = clamp((left - TICKS_PER_CLEAR * c) / URGENCY_SPAN, 0, 1);
  return KAPPA * REF_DENSITY * urgency;
}

/**
 * 握著 `c` 次清場的等待價值（單位：分）：下一次要等到的子彈數（預測 30 tick 後的，或預留的高峰，取大的），
 * 乘上「對手沒搶先按」的機率 1 − h；其餘的次數各算一次預留價值。
 */
export function holdValue(state: S10State, c: number, h: number): number {
  if (c <= 0) {
    return 0;
  }
  const left = state.maxTicks - state.tick;
  const horizon = clamp(left - 1, 0, WAIT_TICKS);
  const ahead = Math.min(predictCount(state, horizon), CLEAR_CAP);
  const r = reserveFor(left, c);
  return (1 - h) * (Math.max(ahead, r) + (c - 1) * r);
}

const CLEARANCE_CAP = 40;
const CLEARANCE_WEIGHT = 0.5;

export function evaluate(
  state: S10State,
  side: Side,
  options: S10Options = {},
): { gain: number; danger: number } {
  const [s0, s1] = score(state);
  const lead = side === 0 ? s0 - s1 : s1 - s0;
  if (isOver(state)) {
    return { gain: POINT * lead, danger: 0 };
  }
  const me = state.players[side];
  const distance = nearestApproach(state, side);
  const danger = clamp((D_FAR - distance) / (D_FAR - HIT_DIST), 0, 1);
  const h = opponentPressChance(options.readsDanger === false ? 0 : state.exposure[other(side)]);
  const hold = holdValue(state, state.clears, h);
  const gain =
    POINT * (lead + hold) +
    CLEARANCE_WEIGHT * Math.min(distance, CLEARANCE_CAP) -
    0.05 * Math.abs(me.x - EMITTER_X) -
    0.02 * (FIELD_H - me.y);
  return { gain, danger };
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export function createS10Game(options: S10Options = {}): Game<S10State> {
  return {
    id: 'S-10',
    init: (seed, config) => initState(seed, config, options),
    step,
    isOver,
    score,
    winner,
    actions,
    evaluate: (state, side) => evaluate(state, side, options),
  };
}

export const s10Game: Game<S10State> = createS10Game();

// ---------------------------------------------------------------------------
// 測試用：直接構造局面
// ---------------------------------------------------------------------------

export interface BulletInit {
  readonly x: number;
  readonly y: number;
  /** 預設 0。 */
  readonly vx?: number;
  /** 預設 1。 */
  readonly vy?: number;
}

export interface PlayerOverrides {
  readonly x?: number;
  readonly y?: number;
  readonly vx?: number;
  readonly vy?: number;
  readonly invuln?: number;
  readonly hits?: number;
}

export interface StateOverrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly bullets?: readonly BulletInit[];
  readonly players?: readonly [PlayerOverrides, PlayerOverrides];
  readonly clears?: number;
  readonly quiet?: number;
  readonly minBullets?: number;
  readonly burn?: boolean;
  readonly lockTicks?: number;
  readonly lock?: readonly [number, number];
  readonly cleared?: readonly [number, number];
  readonly exposure?: readonly [number, number];
  readonly fanCount?: number;
  readonly angle?: number;
  readonly spin?: 1 | -1;
}

/**
 * 測試用：從「沒有子彈、兩人在起點、種子 0」的局面出發，用 overrides 覆蓋。
 * 子彈只要給 x、y，`vx` 預設 0、`vy` 預設 1。
 */
export function makeState(overrides: StateOverrides = {}): S10State {
  const base = initState(0, { maxTicks: overrides.maxTicks ?? DURATION_TICKS, params: {} });
  const player = (p: S10Player, o: PlayerOverrides | undefined): S10Player => ({ ...p, ...o });
  return {
    ...base,
    tick: overrides.tick ?? 0,
    bullets: (overrides.bullets ?? []).map(
      (b): S10Bullet => ({ x: b.x, y: b.y, vx: b.vx ?? 0, vy: b.vy ?? 1 }),
    ),
    players: [
      player(base.players[0], overrides.players?.[0]),
      player(base.players[1], overrides.players?.[1]),
    ],
    clears: overrides.clears ?? base.clears,
    quiet: overrides.quiet ?? 0,
    minBullets: overrides.minBullets ?? base.minBullets,
    burn: overrides.burn ?? base.burn,
    lockTicks: overrides.lockTicks ?? base.lockTicks,
    lock: overrides.lock ?? base.lock,
    cleared: overrides.cleared ?? [0, 0],
    exposure: overrides.exposure ?? [0, 0],
    fanCount: overrides.fanCount ?? 0,
    angle: overrides.angle ?? 0,
    spin: overrides.spin ?? 1,
  };
}
