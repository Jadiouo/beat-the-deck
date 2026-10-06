import { nextFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, GameConfig, Inputs, Side } from '../../core/types';

/**
 * 黑桃三張牌（S-A、S-2、S-3）共用的場地邏輯：場地、玩家移動、子彈、命中與無敵、給 AI 的評估。
 * 全部是純的：亂數只用 `RngState`（`nextFrom`），沒有時鐘、沒有 `Math` 的亂數。
 *
 * 規則的出處是 SPEC 第 10 節「黑桃共同設定」；SPEC 沒寫到的細節（座標、順序、生成間隔的算法、
 * 評估的公式）寫在 `docs/cards/S-A.md` 的「我做的決定」。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 場地大小（SPEC 第 10 節）。 */
export const FIELD_W = 150;
export const FIELD_H = 220;
/** 兩個場地在 320×240 畫布上的左上角（人在左、AI 在右，中間隔 10 像素，上方留 10 像素放分數）。 */
export const FIELD_ORIGIN: readonly [{ x: number; y: number }, { x: number; y: number }] = [
  { x: 5, y: 10 },
  { x: 165, y: 10 },
];

export const PLAYER_R = 3;
export const BULLET_R = 2;
/** 命中：中心距離小於 3 + 2。 */
export const HIT_DIST = PLAYER_R + BULLET_R;
/** 玩家每 tick 的速度：全速與按住 a 的慢速。 */
export const SPEED = 1.5;
export const SLOW_SPEED = 0.6;
/** 一般子彈的速度。 */
export const BULLET_SPEED = 1.2;
/** 命中之後無敵的 tick 數。 */
export const INVULN_TICKS = 60;

/** 玩家的起點（場地座標），兩邊一樣。 */
export const START_X = FIELD_W / 2;
export const START_Y = 190;

/** 落雨的生成間隔：第 0 tick 是 20，線性縮短到第 3600 tick 是 5。 */
export const RAIN_START_INTERVAL = 20;
export const RAIN_END_INTERVAL = 5;
export const RAMP_TICKS = 3600;

/** 子彈離開場地多遠就移除（左右兩側也一樣）：整顆都在場地外。 */
const BULLET_LEAVE = FIELD_H + BULLET_R;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** 哪一張牌：落雨（S-A）、瞄準彈（S-2）、擦彈（S-3）。 */
export type Mode = 'rain' | 'aimed' | 'graze';

export interface Bullet {
  /** 場地座標：左上角是 (0, 0)。 */
  readonly x: number;
  readonly y: number;
  /** 每 tick 的位移。 */
  readonly vx: number;
  readonly vy: number;
  /** 已經算過擦彈（或在無敵期間經過）：S-3 用，其他牌恆為 false。 */
  readonly grazed: boolean;
}

export interface Field {
  /** 玩家中心（場地座標）。 */
  readonly px: number;
  readonly py: number;
  /** 玩家上一個 tick 的速度（給 `evaluate` 預測用）。 */
  readonly vx: number;
  readonly vy: number;
  readonly hits: number;
  /** 擦彈數（S-3 才會增加）。 */
  readonly grazes: number;
  /** 還剩幾個 tick 無敵。 */
  readonly invuln: number;
  /** 這個場地的子彈亂數狀態：兩邊都從 `rngStateFor(seed, 'bullets')` 開始，各自推進。 */
  readonly rng: RngState;
  readonly bullets: readonly Bullet[];
}

export interface SpadesState {
  readonly mode: Mode;
  /** 已經 step 的次數。 */
  readonly tick: number;
  readonly maxTicks: number;
  /** 落雨生成間隔的累加器（S-A 用）。 */
  readonly phase: number;
  /** 0 是人、1 是 AI。 */
  readonly fields: readonly [Field, Field];
}

export function initSpadesState(mode: Mode, seed: number, config: GameConfig): SpadesState {
  const field: Field = {
    px: START_X,
    py: START_Y,
    vx: 0,
    vy: 0,
    hits: 0,
    grazes: 0,
    invuln: 0,
    rng: rngStateFor(seed, 'bullets'),
    bullets: [],
  };
  return { mode, tick: 0, maxTicks: config.maxTicks, phase: 0, fields: [field, field] };
}

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** 玩家依按鍵移動一個 tick：八方向、合速度固定、夾在場地內。 */
function movePlayer(field: Field, buttons: Buttons): Field {
  const dx = (buttons.right ? 1 : 0) - (buttons.left ? 1 : 0);
  const dy = (buttons.down ? 1 : 0) - (buttons.up ? 1 : 0);
  const speed = buttons.a ? SLOW_SPEED : SPEED;
  const along = dx !== 0 && dy !== 0 ? speed * Math.SQRT1_2 : speed;
  const vx = dx === 0 ? 0 : dx * along;
  const vy = dy === 0 ? 0 : dy * along;
  return {
    ...field,
    px: clamp(field.px + vx, PLAYER_R, FIELD_W - PLAYER_R),
    py: clamp(field.py + vy, PLAYER_R, FIELD_H - PLAYER_R),
    vx,
    vy,
  };
}

/** 落雨在第 `tick` 個 tick 的生成間隔。 */
export function rainInterval(tick: number): number {
  const t = Math.min(tick, RAMP_TICKS);
  return RAIN_START_INTERVAL + ((RAIN_END_INTERVAL - RAIN_START_INTERVAL) * t) / RAMP_TICKS;
}

/** 在上緣隨機位置生成一顆往下的子彈：x 在 [2, 148]，y 是 0。回傳子彈與新的亂數狀態。 */
function spawnRain(rng: RngState): readonly [Bullet, RngState] {
  const [roll, next] = nextFrom(rng);
  const x = BULLET_R + roll * (FIELD_W - 2 * BULLET_R);
  return [{ x, y: 0, vx: 0, vy: BULLET_SPEED, grazed: false }, next];
}

interface Spawns {
  readonly rain: boolean;
}

/** 一個場地走一個 tick：玩家移動、子彈移動並移除、命中判定、無敵倒數、生成新的子彈。 */
function stepField(field: Field, buttons: Buttons, spawns: Spawns): Field {
  const player = movePlayer(field, buttons);

  let hits = player.hits;
  let invulnerable = player.invuln > 0;
  let hitNow = false;
  const kept: Bullet[] = [];
  for (const bullet of player.bullets) {
    const moved: Bullet = { ...bullet, x: bullet.x + bullet.vx, y: bullet.y + bullet.vy };
    if (moved.y > BULLET_LEAVE || moved.x < -BULLET_R || moved.x > FIELD_W + BULLET_R) {
      continue;
    }
    const dx = moved.x - player.px;
    const dy = moved.y - player.py;
    if (!invulnerable && dx * dx + dy * dy < HIT_DIST * HIT_DIST) {
      hits += 1;
      invulnerable = true;
      hitNow = true;
      continue;
    }
    kept.push(moved);
  }
  const invuln = hitNow ? INVULN_TICKS : Math.max(0, player.invuln - 1);

  // 重要：生成用掉亂數，新的 RngState 一定要寫回這個場地。
  let rng = player.rng;
  if (spawns.rain) {
    const [bullet, next] = spawnRain(rng);
    kept.push(bullet);
    rng = next;
  }
  return { ...player, hits, invuln, rng, bullets: kept };
}

export function isOverSpades(state: SpadesState): boolean {
  return state.tick >= state.maxTicks;
}

/** 一個 tick。不改動傳進來的 state。 */
export function stepSpades(state: SpadesState, inputs: Inputs): SpadesState {
  if (isOverSpades(state)) {
    return state;
  }
  const tick = state.tick + 1;
  // 落雨：累加器每個 tick 加 1 / 當下的間隔，滿 1 就生成一顆。
  let phase = state.phase + 1 / rainInterval(tick);
  const rain = phase >= 1 - 1e-9;
  if (rain) {
    phase -= 1;
  }
  const spawns: Spawns = { rain };
  return {
    ...state,
    tick,
    phase,
    fields: [
      stepField(state.fields[0], inputs[0], spawns),
      stepField(state.fields[1], inputs[1], spawns),
    ],
  };
}

export function scoreSpades(state: SpadesState): readonly [number, number] {
  // 用 0 減而不是取負號，免得 0 變成 -0。
  return [0 - state.fields[0].hits, 0 - state.fields[1].hits];
}

export function winnerSpades(state: SpadesState): Side | null {
  if (!isOverSpades(state)) {
    return null;
  }
  const [a, b] = scoreSpades(state);
  return a > b ? 0 : b > a ? 1 : null;
}

// ---------------------------------------------------------------------------
// 動作
// ---------------------------------------------------------------------------

const RELEASED: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

const DIRECTIONS: readonly Partial<Buttons>[] = [
  { up: true },
  { down: true },
  { left: true },
  { right: true },
  { up: true, left: true },
  { up: true, right: true },
  { down: true, left: true },
  { down: true, right: true },
];

/** 17 個動作：全放開（排第一）、八方向全速、八方向加 a（慢速）。 */
const ACTIONS: readonly Buttons[] = [
  RELEASED,
  ...DIRECTIONS.map((d): Buttons => ({ ...RELEASED, ...d })),
  ...DIRECTIONS.map((d): Buttons => ({ ...RELEASED, ...d, a: true })),
];

export function actionsSpades(): readonly Buttons[] {
  return ACTIONS;
}

// ---------------------------------------------------------------------------
// 評估（給 AI）
// ---------------------------------------------------------------------------

/** 往前預測幾個 tick。 */
export const HORIZON = 24;
/** 預測的最近距離小於等於這個值：一定會被打中（danger = 1）。 */
const D_HIT = HIT_DIST;
/** 預測的最近距離大於等於這個值：完全安全（danger = 0）。 */
const D_FAR = 14;
/** 一分的 gain。 */
export const SCORE_UNIT = 1000;
/** 離子彈的距離超過這個值就不再加分。 */
const CLEAR_CAP = 40;

export function evaluateSpades(state: SpadesState, side: Side): { gain: number; danger: number } {
  const me = state.fields[side];
  const score = scoreSpades(state);
  const lead = score[side] - score[side === 0 ? 1 : 0];
  if (isOverSpades(state)) {
    return { gain: SCORE_UNIT * lead, danger: 0 };
  }

  // 預測：玩家照目前的速度一直走（碰到邊緣就停），每顆子彈照原本的方向飛，
  // 在接下來 HORIZON 個 tick 裡最近會靠到多近。無敵期間的 tick 不算（碰不到）。
  let nearest = Number.POSITIVE_INFINITY;
  for (let t = me.invuln + 1; t <= HORIZON; t += 1) {
    const px = clamp(me.px + me.vx * t, PLAYER_R, FIELD_W - PLAYER_R);
    const py = clamp(me.py + me.vy * t, PLAYER_R, FIELD_H - PLAYER_R);
    for (const b of me.bullets) {
      const dx = b.x + b.vx * t - px;
      const dy = b.y + b.vy * t - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearest) {
        nearest = d2;
      }
    }
  }
  const distance = Math.sqrt(nearest);
  const danger = clamp((D_FAR - distance) / (D_FAR - D_HIT), 0, 1);
  const clearance = Math.min(distance, CLEAR_CAP);
  const gain =
    SCORE_UNIT * lead + clearance - 0.05 * Math.abs(me.px - START_X) - 0.02 * (FIELD_H - me.py);
  return { gain, danger };
}

// ---------------------------------------------------------------------------
// 測試用：直接構造局面
// ---------------------------------------------------------------------------

export interface BulletInit {
  readonly x: number;
  readonly y: number;
  /** 預設 0。 */
  readonly vx?: number;
  /** 預設 1.2。 */
  readonly vy?: number;
  readonly grazed?: boolean;
}

export interface FieldOverrides {
  readonly px?: number;
  readonly py?: number;
  readonly vx?: number;
  readonly vy?: number;
  readonly hits?: number;
  readonly grazes?: number;
  readonly invuln?: number;
  readonly rng?: RngState;
  readonly bullets?: readonly BulletInit[];
}

export interface StateOverrides {
  readonly tick?: number;
  readonly phase?: number;
  readonly maxTicks?: number;
  readonly fields?: readonly [FieldOverrides, FieldOverrides];
}

/**
 * 測試用：從「沒有子彈、玩家在起點、種子 0 的子彈亂數」的局面出發，用 overrides 覆蓋。
 * 子彈只要給 x、y，`vy` 預設 1.2、`vx` 預設 0。
 */
export function makeSpadesState(mode: Mode, overrides: StateOverrides = {}): SpadesState {
  const base = initSpadesState(mode, 0, { maxTicks: overrides.maxTicks ?? 3600, params: {} });
  const patch = (field: Field, o: FieldOverrides | undefined): Field => {
    if (o === undefined) {
      return field;
    }
    const { bullets, ...rest } = o;
    return {
      ...field,
      ...rest,
      bullets: (bullets ?? []).map((b): Bullet => ({
        x: b.x,
        y: b.y,
        vx: b.vx ?? 0,
        vy: b.vy ?? BULLET_SPEED,
        grazed: b.grazed ?? false,
      })),
    };
  };
  return {
    ...base,
    tick: overrides.tick ?? 0,
    phase: overrides.phase ?? 0,
    fields: [
      patch(base.fields[0], overrides.fields?.[0]),
      patch(base.fields[1], overrides.fields?.[1]),
    ],
  };
}
