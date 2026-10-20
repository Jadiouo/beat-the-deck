import { HUMAN_PARAMS } from '../../ai/human-model';
import { levelController, policyByName, wrapPolicy } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import type { PolicyKey } from '../../ai/types';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import {
  FINAL_TICKS,
  HEIGHT,
  MOVE_EVERY,
  NOTICE_TICKS,
  PHASE_TICKS,
  WIDTH,
  cell,
  densestSpot,
  jkbGame,
} from './logic';
import type { JKBState, Want } from './logic';

/**
 * JK-B 的劇本玩家與量測工具（DESIGN-AI-FUN 10.20、10.24、10.35、10.40、10.54）。測試與量測用，不進遊戲，不在純度掃描範圍。
 *
 * 劇本玩家看完整的 state、每個 tick 都決定、不延遲、不失誤（比任何人都強的操作）；移動的方式完全一樣（`toward`）。
 * 它們都「知道規則」（每條規則下金幣值不值得撿）與「預告」（預告是公開的、兩邊都看得到）；
 * 差別只在「怎麼看對手」，見 `ScriptKind`。
 */

export const NEUTRAL: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};
/** 契約測試與 A1–A4 用的設定。 */
export const CONTRACT = { maxTicks: 3600, params: {} };

const KEYS: readonly Buttons[] = [
  { ...NEUTRAL, up: true },
  { ...NEUTRAL, right: true },
  { ...NEUTRAL, down: true },
  { ...NEUTRAL, left: true },
];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

export function press(w: Want): Buttons {
  return w < 0 ? NEUTRAL : (KEYS[w] as Buttons);
}

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

export function ai(
  level: number,
  seed: number,
  policy: PolicyKey = 'pathfinder',
  game: Game<JKBState> = jkbGame,
): Controller<JKBState> {
  return levelController(game, policyByName(policy), level, seed);
}

export function humanModel(seed: number, game: Game<JKBState> = jkbGame): Controller<JKBState> {
  return wrapPolicy(game, pathfinder, HUMAN_PARAMS, seed);
}

// ---------------------------------------------------------------------------
// 導航
// ---------------------------------------------------------------------------

const dist = (a: number, b: number): number =>
  Math.abs((a % WIDTH) - (b % WIDTH)) + Math.abs(Math.floor(a / WIDTH) - Math.floor(b / WIDTH));

/** 往 (tx, ty) 走：先走離得比較遠的那一軸；下一格被 `avoid` 擋住就換另一軸；都不行就不動。 */
export function toward(
  x: number,
  y: number,
  target: number,
  avoid: (c: number) => boolean = () => false,
): Want {
  const tx = target % WIDTH;
  const ty = Math.floor(target / WIDTH);
  const dx = tx - x;
  const dy = ty - y;
  const horizontal: Want = dx > 0 ? 1 : 3;
  const vertical: Want = dy > 0 ? 2 : 0;
  const order: Want[] = [];
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (dy !== 0) order.push(vertical);
    if (dx !== 0) order.push(horizontal);
  } else {
    if (dx !== 0) order.push(horizontal);
    if (dy !== 0) order.push(vertical);
  }
  for (const w of order) {
    const nx = x + (DX[w] as number);
    const ny = y + (DY[w] as number);
    if (nx >= 0 && nx < WIDTH && ny >= 0 && ny < HEIGHT && !avoid(cell(nx, ny))) {
      return w;
    }
  }
  return -1;
}

/** 離 `from` 最遠的那個鄰格方向（逃）。 */
function awayFrom(x: number, y: number, from: number, avoid: (c: number) => boolean): Want {
  let best: Want = -1;
  let bestD = dist(cell(x, y), from);
  for (const w of [0, 1, 2, 3] as const) {
    const nx = x + (DX[w] as number);
    const ny = y + (DY[w] as number);
    if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT || avoid(cell(nx, ny))) {
      continue;
    }
    const d = dist(cell(nx, ny), from);
    if (d > bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 劇本玩家
// ---------------------------------------------------------------------------

export type ScriptKind =
  /** 站著不動。 */
  | 'idle'
  /** 永遠撿最近的金幣，不管規則、不管預告（毒藥也撿）。 */
  | 'coin'
  /** (a) 不知道有對手：知道規則與預告，自己撿金幣、布局；從不看對手、不推、不躲；搶劫期間金幣沒分、它沒事做就站著。 */
  | 'a'
  /**
   * (b) 知道有對手、不讀它的狀態（這個定義在量之前固定）：(a) 的一切，加上知道「對手會來推、會去搶金幣、
   * 預告期會去布局」這些規則層面的事實，所以：搶劫的預告期離開自己原地、搶劫期間不停地來回走（走動的點推不動）、
   * 不會把自己停在別人會推到金幣上的位置；但不看對手現在在哪、冷卻多少、分數多少。
   */
  | 'b'
  /**
   * (c) 讀它的狀態：(b) 加上讀對手現在的位置與冷卻與預告期的習慣——搶金幣時挑對手搆不到的、
   * 毒藥／送禮快結束時不去它要去的最密處而去第二密處、搶劫時對手停著就推、對手能推就躲、
   * 分數互換最後一秒看對手搆不搆得到金幣。
   */
  | 'c'
  /** 搶劫期間一直貼著對手推（其他時候像 (b)）：10.40 的候選支配策略。 */
  | 'chase'
  /** 任何規則下都貼著對手、只要推得動就推（把它推離金幣、推到毒藥上）。 */
  | 'stalk'
  /** 永遠待在金幣最密處（10.40 的另一個候選）；不撿被毒藥／送禮／搶劫指定不能撿的。 */
  | 'camp';

export interface Pick {
  readonly want: Want;
}

function valuableCoins(state: JKBState): readonly number[] {
  const r = state.rule;
  return r === 'normal' || r === 'rain' || r === 'gravity' || r === 'exchange'
    ? [...state.coins, ...state.extra]
    : [];
}

function nearestOf(from: number, cells: readonly number[], weight?: (c: number) => number): number {
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of cells) {
    const d = dist(from, c) + (weight === undefined ? 0 : weight(c));
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** 第二密處：把最密處那一群金幣拿掉，剩下的再找一次最密處。 */
function secondDensest(coins: readonly number[], from: number): number {
  const first = densestSpot(coins, from);
  if (first < 0) {
    return -1;
  }
  const rest = coins.filter((c) => dist(c, first) > 2);
  const second = densestSpot(rest, from);
  return second >= 0 ? second : first;
}

export function scripted(kind: ScriptKind): Controller<JKBState> {
  return {
    decide(state: JKBState, side: Side): Buttons {
      return press(wantFor(kind, state, side));
    },
  };
}

export function wantFor(kind: ScriptKind, state: JKBState, side: Side): Want {
  const me = state.avatars[side];
  const opp = state.avatars[side === 0 ? 1 : 0];
  const here = cell(me.x, me.y);
  const theirs = cell(opp.x, opp.y);
  const { rule, ruleTick } = state;
  const coinCells = new Set(state.coins);
  const preview = ruleTick >= PHASE_TICKS - NOTICE_TICKS && state.next !== 'none';
  const myScore = state.scores[side];
  const oppScore = state.scores[side === 0 ? 1 : 0];

  if (kind === 'idle') {
    return -1;
  }
  const noCoins = (c: number): boolean => coinCells.has(c) || state.extra.includes(c);
  if (kind === 'coin') {
    const target = nearestOf(here, [...state.coins, ...state.extra]);
    return target < 0 ? -1 : toward(me.x, me.y, target);
  }
  if (kind === 'camp') {
    const spot = densestSpot(state.coins, here);
    const avoid =
      rule === 'normal' || rule === 'rain' || rule === 'gravity' ? () => false : noCoins;
    if (rule === 'normal' || rule === 'rain' || rule === 'gravity') {
      const target = nearestOf(here, valuableCoins(state));
      return target < 0 ? -1 : toward(me.x, me.y, target);
    }
    return spot < 0 ? -1 : toward(me.x, me.y, spot, avoid);
  }
  if (kind === 'stalk') {
    if (rule === 'poison' || rule === 'gift') {
      // 把對手推到金幣上：站到對手的一側，使得推過去的下一格是金幣
      return toward(me.x, me.y, theirs, (c) => coinCells.has(c));
    }
    return toward(me.x, me.y, theirs);
  }
  if (kind === 'chase' && rule === 'rob') {
    return me.shoveCd === 0
      ? toward(me.x, me.y, theirs)
      : awayFrom(me.x, me.y, theirs, () => false);
  }

  // ---- a / b / c（以及 chase 在搶劫以外的時候像 b）----
  const level: 'a' | 'b' | 'c' = kind === 'a' ? 'a' : kind === 'c' ? 'c' : 'b';
  const avoidPoison = rule === 'poison' || rule === 'gift' ? noCoins : () => false;

  // 預告期的布局（預告是公開的，三組都做）
  if (preview) {
    if (state.next === 'rain' && state.rainCell >= 0) {
      const d = dist(here, state.rainCell);
      if (d * MOVE_EVERY <= PHASE_TICKS - ruleTick + 120) {
        return d === 0 ? -1 : toward(me.x, me.y, state.rainCell, avoidPoison);
      }
    } else if (state.next === 'gravity' && me.y > 6) {
      return toward(me.x, me.y, cell(me.x, 6), avoidPoison);
    } else if (state.next === 'rob' && level !== 'a') {
      if (dist(here, theirs) < 8 && level === 'c') {
        return awayFrom(me.x, me.y, theirs, avoidPoison);
      }
    }
    if (rule === 'poison' || rule === 'gift') {
      const spot =
        level === 'c' ? secondDensest(state.coins, here) : densestSpot(state.coins, here);
      if (spot >= 0 && dist(here, spot) > 0) {
        return toward(me.x, me.y, spot, avoidPoison);
      }
      return -1;
    }
  }

  switch (rule) {
    case 'normal':
    case 'rain':
    case 'gravity': {
      const cells = valuableCoins(state);
      const target =
        level === 'c'
          ? nearestOf(here, cells, (c) => (dist(theirs, c) < dist(here, c) ? 6 : 0))
          : nearestOf(here, cells);
      return target < 0 ? -1 : toward(me.x, me.y, target);
    }
    case 'poison':
    case 'gift':
      return -1;
    case 'rob': {
      if (level === 'a') {
        return -1;
      }
      if (level === 'b') {
        // 不停地來回走：走動的點推不動
        return Math.floor(state.tick / 24) % 2 === 0 ? 1 : 3;
      }
      // c：能推就追停著的對手，對手能推就躲
      if (me.shoveCd === 0 && opp.want < 0) {
        return toward(me.x, me.y, theirs);
      }
      if (opp.shoveCd === 0 && dist(here, theirs) <= 2) {
        return awayFrom(me.x, me.y, theirs, () => false);
      }
      return Math.floor(state.tick / 24) % 2 === 0 ? 1 : 3;
    }
    case 'exchange': {
      const behind = oppScore - myScore;
      const left = Math.min(PHASE_TICKS - ruleTick, state.maxTicks - state.tick);
      const nearest = nearestOf(here, state.coins);
      if (level === 'c' && ruleTick >= PHASE_TICKS - FINAL_TICKS) {
        // 最後 1 秒：落後 ≥ 2 而且對手搶不到就撿；領先而且對手搆得到就貼著金幣擋
        const oppReach = dist(theirs, nearestOf(theirs, state.coins)) * MOVE_EVERY <= left;
        if (behind >= 2 && !oppReach) {
          return nearest < 0 ? -1 : toward(me.x, me.y, nearest);
        }
      }
      if (behind >= 2 || (level === 'c' && behind >= 1 && ruleTick < PHASE_TICKS - FINAL_TICKS)) {
        return nearest < 0 ? -1 : toward(me.x, me.y, nearest);
      }
      // 不撿：留在最近的金幣旁（距離 2），不踩到
      if (nearest >= 0 && dist(here, nearest) > 2) {
        return toward(me.x, me.y, nearest, noCoins);
      }
      return -1;
    }
    default:
      return -1;
  }
}

// ---------------------------------------------------------------------------
// 量測
// ---------------------------------------------------------------------------

export function seedRange(n: number, from = 0): number[] {
  return Array.from({ length: n }, (_v, i) => from + i);
}

export const sideOf = (seed: number): Side => (seed % 2 === 0 ? 0 : 1);

export interface MatchRecord {
  readonly seed: number;
  /** 被測的那一邊（偶數種子 0、奇數種子 1）。 */
  readonly mySide: Side;
  readonly winner: Side | null;
  readonly score: readonly [number, number];
  readonly ticks: number;
  readonly shoves: readonly [number, number];
  readonly stolen: readonly [number, number];
  readonly schedule: readonly string[];
  /** 每一段結束時我方的分數差（我 − 對手）。 */
  readonly phaseLead: readonly number[];
}

/** 打一場並記錄（與 `playMatch` 同樣的迴圈，多拿到終局的 state）；`me` 坐 `sideOf(seed)`。 */
export function record(
  seed: number,
  me: Controller<JKBState>,
  rival: Controller<JKBState>,
  game: Game<JKBState> = jkbGame,
): MatchRecord {
  const mySide = sideOf(seed);
  const phaseLead: number[] = [];
  const c0 = mySide === 0 ? me : rival;
  const c1 = mySide === 0 ? rival : me;
  let s = game.init(seed, CONTRACT);
  const schedule = s.schedule;
  let tick = 0;
  while (!game.isOver(s)) {
    if (s.ruleTick === PHASE_TICKS - 1) {
      phaseLead.push(s.scores[mySide] - s.scores[mySide === 0 ? 1 : 0]);
    }
    s = game.step(s, [c0.decide(s, 0, tick), c1.decide(s, 1, tick)]);
    tick += 1;
  }
  return {
    seed,
    mySide,
    winner: game.winner(s),
    score: s.scores,
    ticks: tick,
    shoves: s.shoves,
    stolen: s.stolen,
    schedule,
    phaseLead,
  };
}

/** 被測那一邊的得分（贏 1、平手 0.5、輸 0）。 */
export const pointsOf = (r: MatchRecord): number =>
  r.winner === null ? 0.5 : r.winner === r.mySide ? 1 : 0;

export function winPercent(
  me: (seed: number) => Controller<JKBState>,
  rival: (seed: number) => Controller<JKBState>,
  seeds: readonly number[],
): number {
  let total = 0;
  for (const seed of seeds) {
    total += pointsOf(record(seed, me(seed), rival(seed + 1_000_003)));
  }
  return (100 * total) / seeds.length;
}

export function quantile(xs: readonly number[], q: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}
