import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  GRAZE_DIST,
  HORIZON,
  PLAYER_R,
  FIELD_H,
  FIELD_W,
  actionsSpades,
  evaluateSpades,
  initSpadesState,
  isOverSpades,
  makeSpadesState,
  scoreSpades,
  stepSpades,
  winnerSpades,
} from '../_spades/logic';
import type { SpadesState, StateOverrides as SpadesOverrides } from '../_spades/logic';

/**
 * S-Q 鏡像（小規格 `docs/cards/S-Q.md`）。擦彈、子彈、計分都用 S-3 的（`_spades/logic.ts`，`mode: 'graze'`）；
 * 這裡只多一層：你擦到彈，對方的左右在預告之後反轉。反轉的是「這一步怎麼解讀按鍵」，所以 AI 的 `decide`
 * （試每個動作、看 `step` 之後的 state）不需要知道它，也不是免費的：等級的反應延遲就是代價。
 */

export const PENDING_TICKS = 30;
export const ACTIVE_TICKS = 120;
export const IMMUNE_TICKS = 120;
/** 對方可以被觸發時，每顆預測會擦到的子彈多加的 gain（遠小於一分的 1000）。 */
export const TRIGGER_BONUS = 40;

export interface Mirror {
  readonly pending: number;
  readonly active: number;
  readonly immune: number;
}

export interface SQState extends SpadesState {
  readonly mirror: readonly [Mirror, Mirror];
  /** 每一邊用自己的擦彈反轉了對方幾次。 */
  readonly triggers: readonly [number, number];
}

const CALM: Mirror = { pending: 0, active: 0, immune: 0 };
const other = (side: Side): Side => (side === 0 ? 1 : 0);
const isCalm = (m: Mirror): boolean => m.pending === 0 && m.active === 0 && m.immune === 0;

export function init(seed: number, config: GameConfig): SQState {
  return { ...initSpadesState('graze', seed, config), mirror: [CALM, CALM], triggers: [0, 0] };
}

function swap(b: Buttons): Buttons {
  return { ...b, left: b.right, right: b.left };
}

function tickTimers(m: Mirror): Mirror {
  if (m.pending > 0) {
    return m.pending === 1
      ? { pending: 0, active: ACTIVE_TICKS, immune: 0 }
      : { ...m, pending: m.pending - 1 };
  }
  if (m.active > 0) {
    return m.active === 1
      ? { pending: 0, active: 0, immune: IMMUNE_TICKS }
      : { ...m, active: m.active - 1 };
  }
  return m.immune > 0 ? { ...m, immune: m.immune - 1 } : m;
}

export function step(s: SQState, inputs: Inputs): SQState {
  if (isOverSpades(s)) {
    return s;
  }
  const effective: Inputs = [
    s.mirror[0].active > 0 ? swap(inputs[0]) : inputs[0],
    s.mirror[1].active > 0 ? swap(inputs[1]) : inputs[1],
  ];
  const base = stepSpades(s, effective);
  const timers: [Mirror, Mirror] = [tickTimers(s.mirror[0]), tickTimers(s.mirror[1])];
  const triggers: [number, number] = [s.triggers[0], s.triggers[1]];
  const grazed = [
    base.fields[0].grazes > s.fields[0].grazes,
    base.fields[1].grazes > s.fields[1].grazes,
  ];
  const result: [Mirror, Mirror] = [timers[0], timers[1]];
  for (const side of [0, 1] as const) {
    const target = other(side);
    if (grazed[side] === true && isCalm(timers[target])) {
      result[target] = { pending: PENDING_TICKS, active: 0, immune: 0 };
      triggers[side] += 1;
    }
  }
  return { ...base, mirror: result, triggers };
}

export function evaluate(s: SQState, side: Side): { gain: number; danger: number } {
  const base = evaluateSpades(s, side);
  if (isOverSpades(s) || !isCalm(s.mirror[other(side)])) {
    return base;
  }
  const me = s.fields[side];
  let prospects = 0;
  for (const b of me.bullets) {
    if (b.grazed) {
      continue;
    }
    for (let t = me.invuln + 1; t <= HORIZON; t += 1) {
      const px = Math.max(PLAYER_R, Math.min(FIELD_W - PLAYER_R, me.px + me.vx * t));
      const py = Math.max(PLAYER_R, Math.min(FIELD_H - PLAYER_R, me.py + me.vy * t));
      const dx = b.x + b.vx * t - px;
      const dy = b.y + b.vy * t - py;
      if (dx * dx + dy * dy < GRAZE_DIST * GRAZE_DIST) {
        prospects += 1;
        break;
      }
    }
  }
  return { gain: base.gain + TRIGGER_BONUS * prospects, danger: base.danger };
}

export interface StateOverrides extends SpadesOverrides {
  readonly mirror?: readonly [Partial<Mirror>, Partial<Mirror>];
  readonly triggers?: readonly [number, number];
}

/** 測試用：直接構造局面（`_spades/logic.ts` 的 `makeSpadesState('graze')` 加上 `mirror`、`triggers`）。 */
export function makeState(o: StateOverrides = {}): SQState {
  return {
    ...makeSpadesState('graze', o),
    mirror: [
      { ...CALM, ...(o.mirror?.[0] ?? {}) },
      { ...CALM, ...(o.mirror?.[1] ?? {}) },
    ],
    triggers: o.triggers ?? [0, 0],
  };
}

export const sQGame: Game<SQState> = {
  id: 'S-Q',
  init,
  step,
  isOver: isOverSpades,
  score: scoreSpades,
  winner: winnerSpades,
  actions: (): readonly Buttons[] => actionsSpades(),
  evaluate,
};
