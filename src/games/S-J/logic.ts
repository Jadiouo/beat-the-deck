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
  SCORE_UNIT,
  SLOW_SPEED,
  SPEED,
  START_Y,
  actionsSpades,
} from '../_spades/logic';

/**
 * S-J 射手與靶（小規格 `docs/cards/S-J.md`）。
 * 一邊在上緣射、一邊在場地裡躲，射的人彈藥有上限而且公開，兩局交換。
 * 純的：亂數只用 `RngState`，時間只有 tick。
 */

export const ROUND_TICKS = 1500;
export const CURSOR_SPEED = 2.5;
export const CURSOR_MIN = 2;
export const CURSOR_MAX = FIELD_W - 2;
export const BULLET_V = 2;
export const AMMO_CAP = 5;
export const REGEN_TICKS = 90;
export const COOLDOWN_TICKS = 20;
export const JITTER = 8;
export const HIT_POINTS = 10;
export const ZONE_Y = 80;
export const ZONE_DIV = 10;
const BULLET_LEAVE = FIELD_H + BULLET_R;
const HORIZON = 24;
const D_FAR = 14;

export interface SJBullet {
  readonly x: number;
  readonly y: number;
}

export interface SJState {
  readonly tick: number;
  readonly maxTicks: number;
  readonly roundTicks: number;
  /** 0 第一局、1 第二局。 */
  readonly round: 0 | 1;
  /** 這一局誰在射。 */
  readonly shooter: Side;
  /** 第一局的起始位置（第二局鏡射）。 */
  readonly spawn: { readonly cursor: number; readonly px: number };
  /** 射手的游標、冷卻、公開的彈藥與離下一發補充還有幾個 tick。 */
  readonly cursor: number;
  readonly cooldown: number;
  readonly ammo: number;
  readonly regen: number;
  /** 躲的人。 */
  readonly px: number;
  readonly py: number;
  readonly vx: number;
  readonly vy: number;
  readonly invuln: number;
  readonly bullets: readonly SJBullet[];
  /** 每一邊當射手時的命中數、當躲的人時待在上半場的 tick 數。 */
  readonly hits: readonly [number, number];
  readonly zone: readonly [number, number];
  readonly rng: RngState;
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function init(seed: number, config: GameConfig): SJState {
  const [r1, s1] = nextFrom(rngStateFor(seed, 'sj'));
  const [r2, s2] = nextFrom(s1);
  const cursor = 30 + r1 * 90;
  const px = 30 + r2 * 90;
  return {
    tick: 0,
    maxTicks: config.maxTicks,
    roundTicks: Math.min(ROUND_TICKS, Math.floor(config.maxTicks / 2)),
    round: 0,
    shooter: 0,
    spawn: { cursor, px },
    cursor,
    cooldown: 0,
    ammo: AMMO_CAP,
    regen: REGEN_TICKS,
    px,
    py: START_Y,
    vx: 0,
    vy: 0,
    invuln: 0,
    bullets: [],
    hits: [0, 0],
    zone: [0, 0],
    rng: s2,
  };
}

function startSecondRound(s: SJState): SJState {
  return {
    ...s,
    round: 1,
    shooter: 1,
    cursor: FIELD_W - s.spawn.cursor,
    cooldown: 0,
    ammo: AMMO_CAP,
    regen: REGEN_TICKS,
    px: FIELD_W - s.spawn.px,
    py: START_Y,
    vx: 0,
    vy: 0,
    invuln: 0,
    bullets: [],
  };
}

export function isOver(s: SJState): boolean {
  return s.tick >= 2 * s.roundTicks;
}

export function step(s: SJState, inputs: Inputs): SJState {
  if (isOver(s)) {
    return s;
  }
  const shooterSide = s.shooter;
  const dodgerSide = other(shooterSide);
  const sIn = inputs[shooterSide];
  const dIn = inputs[dodgerSide];

  const cursor = clamp(
    s.cursor + ((sIn.right ? 1 : 0) - (sIn.left ? 1 : 0)) * CURSOR_SPEED,
    CURSOR_MIN,
    CURSOR_MAX,
  );

  const dx = (dIn.right ? 1 : 0) - (dIn.left ? 1 : 0);
  const dy = (dIn.down ? 1 : 0) - (dIn.up ? 1 : 0);
  const speed = dIn.a ? SLOW_SPEED : SPEED;
  const along = dx !== 0 && dy !== 0 ? speed * Math.SQRT1_2 : speed;
  const vx = dx * along;
  const vy = dy * along;
  const px = clamp(s.px + vx, PLAYER_R, FIELD_W - PLAYER_R);
  const py = clamp(s.py + vy, PLAYER_R, FIELD_H - PLAYER_R);

  let invulnerable = s.invuln > 0;
  let hitNow = false;
  let hitCount = 0;
  const kept: SJBullet[] = [];
  for (const b of s.bullets) {
    const y = b.y + BULLET_V;
    if (y > BULLET_LEAVE) {
      continue;
    }
    const ddx = b.x - px;
    const ddy = y - py;
    if (!invulnerable && ddx * ddx + ddy * ddy < HIT_DIST * HIT_DIST) {
      hitCount += 1;
      invulnerable = true;
      hitNow = true;
      continue;
    }
    kept.push({ x: b.x, y });
  }

  let rng = s.rng;
  let ammo = s.ammo;
  let cooldown = Math.max(0, s.cooldown - 1);
  if (sIn.a && s.ammo > 0 && s.cooldown === 0) {
    const [roll, next] = nextFrom(rng);
    rng = next;
    kept.push({ x: clamp(cursor + (roll - 0.5) * JITTER, CURSOR_MIN, CURSOR_MAX), y: 0 });
    ammo -= 1;
    cooldown = COOLDOWN_TICKS;
  }
  let regen = s.regen;
  if (ammo < AMMO_CAP) {
    regen -= 1;
    if (regen <= 0) {
      ammo += 1;
      regen = REGEN_TICKS;
    }
  } else {
    regen = REGEN_TICKS;
  }

  const hits: [number, number] = [s.hits[0], s.hits[1]];
  hits[shooterSide] += hitCount;
  const zone: [number, number] = [s.zone[0], s.zone[1]];
  if (py < ZONE_Y) {
    zone[dodgerSide] += 1;
  }

  const next: SJState = {
    ...s,
    tick: s.tick + 1,
    cursor,
    cooldown,
    ammo,
    regen,
    px,
    py,
    vx,
    vy,
    invuln: hitNow ? INVULN_TICKS : Math.max(0, s.invuln - 1),
    bullets: kept,
    hits,
    zone,
    rng,
  };
  return next.round === 0 && next.tick >= next.roundTicks ? startSecondRound(next) : next;
}

export function score(s: SJState): readonly [number, number] {
  return [
    HIT_POINTS * s.hits[0] + Math.floor(s.zone[0] / ZONE_DIV),
    HIT_POINTS * s.hits[1] + Math.floor(s.zone[1] / ZONE_DIV),
  ];
}

export function winner(s: SJState): Side | null {
  if (!isOver(s)) {
    return null;
  }
  const [a, b] = score(s);
  return a > b ? 0 : b > a ? 1 : null;
}

const R: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const SHOOTER_ACTIONS: readonly Buttons[] = [
  R,
  { ...R, left: true },
  { ...R, right: true },
  { ...R, a: true },
  { ...R, left: true, a: true },
  { ...R, right: true, a: true },
];

export function actions(s: SJState, side: Side): readonly Buttons[] {
  return side === s.shooter ? SHOOTER_ACTIONS : actionsSpades();
}

/** 躲的人照上一個 tick 的速度繼續走 t 個 tick 之後的位置。 */
function dodgerAt(s: SJState, t: number): { x: number; y: number } {
  return {
    x: clamp(s.px + s.vx * t, PLAYER_R, FIELD_W - PLAYER_R),
    y: clamp(s.py + s.vy * t, PLAYER_R, FIELD_H - PLAYER_R),
  };
}

/**
 * 手上的子彈值多少（射手的 `gain`）：第 k 發的邊際價值遞減（220、121、67、36、20），所以最後一發最貴：
 * 只剩 1 發的射手要預測命中度超過 0.55 才開火，滿彈時超過 0.05 就開火。這就是「留一發」。
 */
export function ammoValue(ammo: number): number {
  return (220 * (1 - 0.55 ** Math.max(0, ammo))) / 0.45;
}

export function evaluate(s: SJState, side: Side): { gain: number; danger: number } {
  const sc = score(s);
  const lead = sc[side] - sc[other(side)];
  if (isOver(s)) {
    return { gain: SCORE_UNIT * lead, danger: 0 };
  }
  if (side === s.shooter) {
    let prospects = 0;
    for (const b of s.bullets) {
      let closest = Number.POSITIVE_INFINITY;
      for (let t = s.invuln + 1; t <= (BULLET_LEAVE - b.y) / BULLET_V; t += 1) {
        const d = dodgerAt(s, t);
        const ex = b.x - d.x;
        const ey = b.y + BULLET_V * t - d.y;
        closest = Math.min(closest, ex * ex + ey * ey);
      }
      prospects += clamp((12 - Math.sqrt(closest)) / 7, 0, 1);
    }
    const lead2 = dodgerAt(s, s.py / BULLET_V).x;
    const aim = s.ammo > 0 ? 0.4 * Math.abs(s.cursor - lead2) : 0;
    return {
      gain: SCORE_UNIT * lead + 400 * prospects - aim + ammoValue(s.ammo),
      danger: 0,
    };
  }
  let nearest = Number.POSITIVE_INFINITY;
  for (const b of s.bullets) {
    for (let t = s.invuln + 1; t <= HORIZON; t += 1) {
      const d = dodgerAt(s, t);
      const ex = b.x - d.x;
      const ey = b.y + BULLET_V * t - d.y;
      nearest = Math.min(nearest, ex * ex + ey * ey);
    }
  }
  const distance = Math.sqrt(nearest);
  const flying = clamp((D_FAR - distance) / (D_FAR - HIT_DIST), 0, 1);
  const latent =
    s.py < ZONE_Y + 15
      ? 0.5 * clamp(s.ammo / 3, 0, 1) * clamp(1 - Math.abs(s.px - s.cursor) / 12, 0, 1)
      : 0;
  const gain =
    SCORE_UNIT * lead +
    (s.py < ZONE_Y ? 8 : 0) -
    0.12 * Math.max(0, s.py - ZONE_Y) +
    0.3 * Math.min(distance, 40) -
    0.05 * Math.abs(s.px - FIELD_W / 2);
  return { gain, danger: Math.max(flying, latent) };
}

export interface StateOverrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly round?: 0 | 1;
  readonly shooter?: Side;
  readonly cursor?: number;
  readonly cooldown?: number;
  readonly ammo?: number;
  readonly regen?: number;
  readonly px?: number;
  readonly py?: number;
  readonly vx?: number;
  readonly vy?: number;
  readonly invuln?: number;
  readonly bullets?: readonly SJBullet[];
  readonly hits?: readonly [number, number];
  readonly zone?: readonly [number, number];
  readonly rng?: RngState;
}

/** 測試用：直接構造局面（預設：第一局、游標與躲的人在 x = 75、躲的人在 y = 190、彈藥滿）。 */
export function makeState(o: StateOverrides = {}): SJState {
  const maxTicks = o.maxTicks ?? 3600;
  const round = o.round ?? 0;
  return {
    tick: o.tick ?? 0,
    maxTicks,
    roundTicks: Math.min(ROUND_TICKS, Math.floor(maxTicks / 2)),
    round,
    shooter: o.shooter ?? (round === 0 ? 0 : 1),
    spawn: { cursor: 75, px: 75 },
    cursor: o.cursor ?? 75,
    cooldown: o.cooldown ?? 0,
    ammo: o.ammo ?? AMMO_CAP,
    regen: o.regen ?? REGEN_TICKS,
    px: o.px ?? 75,
    py: o.py ?? START_Y,
    vx: o.vx ?? 0,
    vy: o.vy ?? 0,
    invuln: o.invuln ?? 0,
    bullets: o.bullets ?? [],
    hits: o.hits ?? [0, 0],
    zone: o.zone ?? [0, 0],
    rng: o.rng ?? rngStateFor(0, 'sj'),
  };
}

export const sJGame: Game<SJState> = {
  id: 'S-J',
  init,
  step,
  isOver,
  score,
  winner,
  actions,
  evaluate,
};
