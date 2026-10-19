import type { Buttons, Controller, Game, Side } from '../../core/types';
import { FIELD_H, FIELD_W, PLAYER_R, SLOW_SPEED, SPEED, actionsSpades } from '../_spades/logic';
import { R_MAX, R_MIN, inSlitAt, omegaAt, slitCoords } from './logic';
import type { S8State } from './logic';

/**
 * S-8 的劇本玩家（DESIGN-AI-FUN 10.24、10.35、10.4）。測試與量測用，不進遊戲。
 *
 * 全部共用同一個「追縫」的核心 `track`（用現在的完整 state、每個 tick 都決定、不延遲、不失誤），
 * 只差「想站在縫的哪個半徑」（`target`）：
 *   - a：不知道有對手存在 —— 永遠站在自己追得動的最外側。
 *   - b：知道有對手（兩個人擠不下並排，會被撞開），但不讀它的狀態 —— 站最外側，被撞過就退內側一陣子。
 *   - c：讀對手公開的 lane／hold —— 對手在外側就站它內側 12 像素，對手在內側就搶它外側 12 像素。
 *   - inner：只守內側。
 *   - squeeze：對手在外側時貼到離它 7 像素（擠它），其餘像 c。
 * 互動強度 ＝ c − b（10.35）。
 */

const ACTIONS = actionsSpades();

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function velocityOf(b: Buttons): readonly [number, number] {
  const dx = (b.right ? 1 : 0) - (b.left ? 1 : 0);
  const dy = (b.down ? 1 : 0) - (b.up ? 1 : 0);
  const speed = b.a ? SLOW_SPEED : SPEED;
  const along = dx !== 0 && dy !== 0 ? speed * Math.SQRT1_2 : speed;
  return [dx * along, dy * along];
}

/** 這個時刻追得動的最大半徑：切向速度 ω × r ≈ 1.1（八方向斜走的 1.06 附近追得最準），夾在 20 到 58。 */
export function feasibleRadius(tick: number, maxTicks: number): number {
  return clamp(1.1 / omegaAt(tick, maxTicks), 20, 58);
}

/** 追縫的核心：往前 10 個 tick（直線）預測，選偏離縫最小、其次靠近 `target` 半徑的動作。 */
export function track(state: S8State, side: Side, target: number, horizon = 10): Buttons {
  const me = state.players[side];
  let best = ACTIONS[0] as Buttons;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const action of ACTIONS) {
    const [vx, vy] = velocityOf(action);
    let angle = state.slit.angle;
    let dev = 0;
    let alongSum = 0;
    let counted = 0;
    const last = Math.min(me.invuln + horizon, state.maxTicks - state.tick);
    for (let t = 1; t <= last; t += 1) {
      angle += omegaAt(state.tick + t - 1, state.maxTicks);
      if (t <= me.invuln) {
        continue;
      }
      const px = clamp(me.x + vx * t, PLAYER_R, FIELD_W - PLAYER_R);
      const py = clamp(me.y + vy * t, PLAYER_R, FIELD_H - PLAYER_R);
      const c = slitCoords(px, py, angle);
      const outRadial = Math.max(0, R_MIN - c.along, c.along - R_MAX);
      const d = outRadial > 0 ? Math.max(Math.abs(c.lat), 4 + outRadial) : Math.abs(c.lat);
      dev = Math.max(dev, d);
      alongSum += c.along;
      counted += 1;
    }
    const cost =
      50 * Math.max(0, dev - 3) ** 2 +
      0.05 * dev +
      (counted > 0 ? 0.4 * Math.abs(alongSum / counted - target) : 0);
    if (cost < bestCost - 1e-12) {
      bestCost = cost;
      best = action;
    }
  }
  return { ...best };
}

export type ScriptKind = 'a' | 'b' | 'c' | 'inner' | 'squeeze';

export function scripted(kind: ScriptKind): Controller<S8State> {
  return {
    decide(state: S8State, side: Side): Buttons {
      const me = state.players[side];
      const opp = state.players[side === 0 ? 1 : 0];
      const reach = feasibleRadius(state.tick, state.maxTicks);
      let target = reach;
      if (kind === 'b') {
        // 被撞過（自己的 bumpAt）就退內側一陣子：不讀對手，只感覺到自己被撞
        if (me.bumpAt >= 0 && state.tick - me.bumpAt < 60) {
          target = Math.max(20, reach - 20);
        }
      } else if (kind === 'c') {
        if (opp.hold > 0.5) {
          target = opp.lane >= 38 ? Math.max(20, opp.lane - 12) : Math.min(reach, opp.lane + 12);
        }
      } else if (kind === 'inner') {
        target = opp.hold > 0.5 ? clamp(opp.lane - 12, 20, reach) : Math.min(reach, 30);
      } else if (kind === 'squeeze') {
        if (opp.hold > 0.5) {
          target = opp.lane >= 38 ? Math.max(20, opp.lane - 7) : Math.min(reach, opp.lane + 12);
        }
      }
      return track(state, side, target);
    },
  };
}

// ---------------------------------------------------------------------------
// 量測用
// ---------------------------------------------------------------------------

export interface MatchRecord {
  /** 被測的這一邊的得分：贏 1、平手 0.5、輸 0。 */
  readonly points: number;
  readonly hitsMe: number;
  readonly hitsOpp: number;
  readonly scoreMe: number;
  readonly scoreOpp: number;
  /** 兩人同時在縫裡的 tick 占一場的比例。 */
  readonly bothIn: number;
  /** 兩人互相推開的 tick 占一場的比例。 */
  readonly bumped: number;
  /** 被測的這一邊在縫裡的 tick 占一場的比例。 */
  readonly inMe: number;
  readonly ticks: number;
}

/** 打一場：`mySide` 是被測的那一邊（偶數種子 0 號邊、奇數種子 1 號邊是慣例）。 */
export function playRecord(
  me: Controller<S8State>,
  opp: Controller<S8State>,
  seed: number,
  mySide: Side,
  game: Game<S8State>,
  maxTicks = 3600,
): MatchRecord {
  let state = game.init(seed, { maxTicks, params: {} });
  let both = 0;
  let bumped = 0;
  let inMe = 0;
  let tick = 0;
  while (!game.isOver(state)) {
    const a = me.decide(state, mySide, tick);
    const b = opp.decide(state, mySide === 0 ? 1 : 0, tick);
    state = game.step(state, mySide === 0 ? [a, b] : [b, a]);
    tick += 1;
    const mine = state.players[mySide];
    const theirs = state.players[mySide === 0 ? 1 : 0];
    const mineIn = inSlitAt(mine.x, mine.y, state.slit.angle);
    const theirsIn = inSlitAt(theirs.x, theirs.y, state.slit.angle);
    if (mineIn) {
      inMe += 1;
    }
    if (mineIn && theirsIn) {
      both += 1;
    }
    if (mine.bumpAt === state.tick) {
      bumped += 1;
    }
  }
  const [s0, s1] = game.score(state);
  const winner = game.winner(state);
  return {
    points: winner === null ? 0.5 : winner === mySide ? 1 : 0,
    hitsMe: state.players[mySide].hits,
    hitsOpp: state.players[mySide === 0 ? 1 : 0].hits,
    scoreMe: mySide === 0 ? s0 : s1,
    scoreOpp: mySide === 0 ? s1 : s0,
    bothIn: both / tick,
    bumped: bumped / tick,
    inMe: inMe / tick,
    ticks: tick,
  };
}

export function mean(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}
