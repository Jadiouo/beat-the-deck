import { nextFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  FIELD_H,
  FIELD_W,
  PLAYER_R,
  SLOW_SPEED,
  SPEED,
  actionsSpades,
} from '../_spades/logic';

/**
 * S-8 掃射（小規格 `docs/cards/S-8.md`）。
 * 一片光幕繞場地中心轉，幕上只有一道窄縫；兩個人站在同一個場地裡，站在縫裡才安全、才得分，
 * 離中心越遠分越高，但越難跟上縫的轉速。純的：亂數只用 `RngState`（只在 `init` 抽縫的起始角度），時間只有 tick。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 場地中心。 */
export const CX = FIELD_W / 2;
export const CY = FIELD_H / 2;
/** 縫：以中心為起點的射線兩側各 4 像素（縫寬 8），半徑範圍 [10, 90]。 */
export const SLIT_HALF = 4;
export const R_MIN = 10;
export const R_MAX = 90;
/** 縫的角速度（rad/tick）：起始 0.020，爬升到結束時 0.032；爬升以 `maxTicks` 為基準。 */
export const OMEGA_START = 0.02;
export const OMEGA_GAIN = 0.012;
/** 一局的長度（45 秒）；`config.maxTicks` 比它短就用 `config.maxTicks`，但不可以短於 `MIN_TICKS`。 */
export const DURATION_TICKS = 2700;
export const MIN_TICKS = 600;
/** 兩個玩家的圓心距離小於這個值就算碰撞（碰撞半徑 4.5 的兩倍，大於縫寬 8）。 */
export const BODY_DIST = 9;
/** 每個 tick 在縫裡得 `r / SCORE_DIV` 分（等於每 10 tick 得 r / 20 分）。 */
export const SCORE_DIV = 200;
/** 被打中：扣的分數與無敵的 tick 數。 */
export const HIT_PENALTY = 5;
export const INVULN_TICKS = 45;
/** 起點：離中心 40，在縫的兩側（相差 180 度）。 */
export const START_R = 40;
/** 公開的移動平均（站的半徑、在縫裡的比例）的時間常數。 */
export const LANE_TAU = 30;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface S8Player {
  readonly x: number;
  readonly y: number;
  /** 上一個 tick 的速度（給 `evaluate` 預測用）。 */
  readonly vx: number;
  readonly vy: number;
  /** 還剩幾個 tick 無敵。 */
  readonly invuln: number;
  readonly hits: number;
  /** 縫內得分的總和（還沒扣被打中的分數）。 */
  readonly pts: number;
  /** 公開：最近站在縫裡的半徑（移動平均，只在縫裡時更新）。AI 讀它猜對手占的是縫的哪一段。 */
  readonly lane: number;
  /** 公開：最近「在縫裡」的比例（移動平均，0 到 1）。 */
  readonly hold: number;
  /** 最近一次被對手撞開是第幾個 tick（-1 是還沒有）。 */
  readonly bumpAt: number;
}

export interface S8State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly slit: { readonly angle: number };
  readonly players: readonly [S8Player, S8Player];
  readonly rng: RngState;
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** 這個 tick 的縫角速度：起始 0.020，隨 `tick / maxTicks` 線性爬升 0.012。 */
export function omegaAt(tick: number, maxTicks: number): number {
  return OMEGA_START + (OMEGA_GAIN * tick) / maxTicks;
}

export function initState(seed: number, config: GameConfig): S8State {
  if (config.maxTicks < MIN_TICKS) {
    throw new RangeError(`S-8 的 maxTicks 至少要 ${MIN_TICKS}，收到 ${String(config.maxTicks)}`);
  }
  const [roll, afterSlit] = nextFrom(rngStateFor(seed, 'slit'));
  const [offsetRoll, rng] = nextFrom(afterSlit);
  const angle = roll * Math.PI * 2;
  /** 兩人的起點偏移：兩人相差 180 度，整對繞中心轉一個由種子決定的角度（誰先被縫掃到由種子決定，不固定是人）。 */
  const offset = angle + offsetRoll * Math.PI * 2;
  const player = (a: number): S8Player => ({
    x: CX + START_R * Math.cos(a),
    y: CY + START_R * Math.sin(a),
    vx: 0,
    vy: 0,
    invuln: 0,
    hits: 0,
    pts: 0,
    lane: START_R,
    hold: 0,
    bumpAt: -1,
  });
  return {
    tick: 0,
    maxTicks: Math.min(config.maxTicks, DURATION_TICKS),
    slit: { angle },
    players: [player(offset), player(offset + Math.PI)],
    rng,
  };
}

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

/** 點在縫的座標系裡：`along` 是沿著縫（離中心的距離），`lat` 是橫向（正的是縫轉向的那一側）。 */
export function slitCoords(x: number, y: number, angle: number): { along: number; lat: number } {
  const rx = x - CX;
  const ry = y - CY;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { along: rx * c + ry * s, lat: -rx * s + ry * c };
}

/** 圓心在縫裡：橫向距離 ≤ 4，而且沿縫的距離在 [10, 90]（邊界都算在裡面）。 */
export function inSlitAt(x: number, y: number, angle: number): boolean {
  const { along, lat } = slitCoords(x, y, angle);
  return Math.abs(lat) <= SLIT_HALF && along >= R_MIN && along <= R_MAX;
}

export function inSlit(state: S8State, side: Side): boolean {
  const p = state.players[side];
  return inSlitAt(p.x, p.y, state.slit.angle);
}

function movePlayer(p: S8Player, buttons: Buttons): S8Player {
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

export function isOver(state: S8State): boolean {
  return state.tick >= state.maxTicks;
}

export function step(state: S8State, inputs: Inputs): S8State {
  if (isOver(state)) {
    return state;
  }
  const next = state.tick + 1;
  const angle = state.slit.angle + omegaAt(state.tick, state.maxTicks);

  // 1. 移動
  let a = movePlayer(state.players[0], inputs[0]);
  let b = movePlayer(state.players[1], inputs[1]);

  // 2. 兩人互相是實心的：重疊就平分地推開（各退一半）
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < BODY_DIST) {
    const nx = dist > 0 ? dx / dist : 1;
    const ny = dist > 0 ? dy / dist : 0;
    const shift = (BODY_DIST - dist) / 2;
    a = {
      ...a,
      x: clamp(a.x - nx * shift, PLAYER_R, FIELD_W - PLAYER_R),
      y: clamp(a.y - ny * shift, PLAYER_R, FIELD_H - PLAYER_R),
      bumpAt: next,
    };
    b = {
      ...b,
      x: clamp(b.x + nx * shift, PLAYER_R, FIELD_W - PLAYER_R),
      y: clamp(b.y + ny * shift, PLAYER_R, FIELD_H - PLAYER_R),
      bumpAt: next,
    };
  }

  // 3. 縫轉到新的角度之後，逐人判定：在縫裡得分、不在縫裡又沒有無敵就被打中
  const judge = (p: S8Player): S8Player => {
    const { along, lat } = slitCoords(p.x, p.y, angle);
    const inside = Math.abs(lat) <= SLIT_HALF && along >= R_MIN && along <= R_MAX;
    const shielded = p.invuln > 0;
    const hitNow = !shielded && !inside;
    return {
      ...p,
      invuln: hitNow ? INVULN_TICKS : Math.max(0, p.invuln - 1),
      hits: p.hits + (hitNow ? 1 : 0),
      pts: p.pts + (!shielded && inside ? along / SCORE_DIV : 0),
      lane: inside ? p.lane + (along - p.lane) / LANE_TAU : p.lane,
      hold: p.hold + ((inside ? 1 : 0) - p.hold) / LANE_TAU,
    };
  };

  return { ...state, tick: next, slit: { angle }, players: [judge(a), judge(b)] };
}

export function score(state: S8State): readonly [number, number] {
  const [a, b] = state.players;
  return [a.pts - HIT_PENALTY * a.hits, b.pts - HIT_PENALTY * b.hits];
}

export function winner(state: S8State): Side | null {
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

/** 17 個動作（同 S-A）：全放開排第一，八方向全速，八方向加 a（慢速）。沒有別的鍵。 */
export function actions(_state: S8State, _side: Side): readonly Buttons[] {
  return MOVES;
}

// ---------------------------------------------------------------------------
// 評估（給 AI）
// ---------------------------------------------------------------------------

/**
 * 往前預測幾個 tick（無敵結束之後算起）。小規格的起始值是 24，實測太長（`docs/cards/S-8.md`「HORIZON」一節）：
 * 預測假設我照上一個 tick 的速度走直線，24 個 tick 之後直線與縫的弧差了 2 到 3 像素，剛好吃掉安全門檻 (3.4)，
 * 精準型於是只敢待在 r ≈ 22 的地方（單人 289 分，輸給貪心型）。10 個 tick 的直線與弧只差零點幾像素。
 */
export const HORIZON = 10;
/** 一分的 gain。 */
export const POINT = 1000;
/** 預測的最大橫向距離 ≤ D_OK 完全安全（danger 0），≥ D_OK + D_SPAN 一定出事（danger 1）。 */
export const D_OK = 2.5;
export const D_SPAN = 3;
/** 搶位的誘因：兩人都在縫裡、我比對手外側時給的 gain。 */
export const OUTER_BONUS = 6;
/** 橫向偏離的小小扣分，讓同樣安全時偏好待在縫的中線。 */
export const LAT_PENALTY = 0.02;
/** 對手的 `hold`（在縫裡的比例）到這個值，才當它占著縫的一段。 */
export const OPP_PRESENT = 0.5;

export function evaluate(state: S8State, side: Side): { gain: number; danger: number } {
  const [s0, s1] = score(state);
  const lead = side === 0 ? s0 - s1 : s1 - s0;
  if (isOver(state)) {
    return { gain: POINT * lead, danger: 0 };
  }
  const me = state.players[side];
  const opp = state.players[other(side)];
  // 對手：不看它「現在」的位置（AI 看到的是舊的），看它公開的 lane 與 hold。
  const oppPresent = opp.hold >= OPP_PRESENT;
  const lane = opp.lane;

  let angle = state.slit.angle;
  let maxDev = 0;
  let predicted = 0;
  let outer = 0;
  let counted = 0;
  const last = Math.min(me.invuln + HORIZON, state.maxTicks - state.tick);
  for (let t = 1; t <= last; t += 1) {
    angle += omegaAt(state.tick + t - 1, state.maxTicks);
    if (t <= me.invuln) {
      continue;
    }
    const px = clamp(me.x + me.vx * t, PLAYER_R, FIELD_W - PLAYER_R);
    const py = clamp(me.y + me.vy * t, PLAYER_R, FIELD_H - PLAYER_R);
    let { along, lat } = slitCoords(px, py, angle);
    if (oppPresent) {
      const da = along - lane;
      const d = Math.sqrt(da * da + lat * lat);
      if (d < BODY_DIST) {
        const shift = (BODY_DIST - d) / 2;
        const nx = d > 0 ? da / d : 1;
        const ny = d > 0 ? lat / d : 0;
        along += nx * shift;
        lat += ny * shift;
      }
    }
    // 偏離縫的程度：橫向距離；超出沿縫的範圍 [10, 90] 時，超出多少就算在縫邊 (4) 之外多少。
    const radialOut = Math.max(0, R_MIN - along, along - R_MAX);
    const dev = radialOut > 0 ? Math.max(Math.abs(lat), SLIT_HALF + radialOut) : Math.abs(lat);
    counted += 1;
    if (dev > maxDev) {
      maxDev = dev;
    }
    if (dev <= SLIT_HALF) {
      predicted += along / SCORE_DIV;
      if (oppPresent && along > lane) {
        outer += 1;
      }
    }
  }
  const danger = counted === 0 ? 0 : clamp((maxDev - D_OK) / D_SPAN, 0, 1);
  const here = slitCoords(me.x, me.y, state.slit.angle);
  const gain =
    POINT * lead +
    predicted +
    (counted === 0 ? 0 : (OUTER_BONUS * outer) / counted) -
    LAT_PENALTY * Math.abs(here.lat);
  return { gain, danger };
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export const s8Game: Game<S8State> = {
  id: 'S-8',
  init: initState,
  step,
  isOver,
  score,
  winner,
  actions,
  evaluate,
};

// ---------------------------------------------------------------------------
// 測試用：直接構造局面
// ---------------------------------------------------------------------------

export interface PlayerOverrides {
  readonly x?: number;
  readonly y?: number;
  readonly vx?: number;
  readonly vy?: number;
  readonly invuln?: number;
  readonly hits?: number;
  readonly pts?: number;
  readonly lane?: number;
  readonly hold?: number;
  readonly bumpAt?: number;
}

export interface StateOverrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  /** 縫現在的角度（弧度）。 */
  readonly angle?: number;
  readonly players?: readonly [PlayerOverrides, PlayerOverrides];
}

/**
 * 測試用：從「種子 0 的起點、縫在種子 0 的角度、分數 0」的局面出發，用 overrides 覆蓋。
 */
export function makeState(overrides: StateOverrides = {}): S8State {
  const base = initState(0, { maxTicks: overrides.maxTicks ?? DURATION_TICKS, params: {} });
  return {
    ...base,
    tick: overrides.tick ?? 0,
    slit: { angle: overrides.angle ?? base.slit.angle },
    players: [
      { ...base.players[0], ...overrides.players?.[0] },
      { ...base.players[1], ...overrides.players?.[1] },
    ],
  };
}
