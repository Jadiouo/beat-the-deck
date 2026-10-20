import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { copyButtons } from '../../core/match';
import type { Buttons, Controller, Game, GameConfig, Side } from '../../core/types';
import { CELLS, HEIGHT, WIDTH, cell, cellX, cellY } from '../_clubs/logic';
import type { CQState } from './logic';

/**
 * C-Q 的劇本玩家與量測工具（DESIGN-AI-FUN 10.4、10.24、10.40、10.54）。都只讀 state，不是 `logic.ts`，
 * 不在純度掃描範圍。
 *
 * 所有劇本玩家的「走路」都是同一個 S4 式的移動：直衝最近的食物、避開蛇身（尾巴不算）、不走進沒有出口的死路；
 * 沒有反應延遲、每個 tick 看得到現在的世界（比 AI 強的是這一點，不是策略）。差別只在「怎麼用僚機」與「知道多少」。
 *
 * 探針 A 的三組（**定義在量之前固定**，DESIGN-AI-FUN 10.54；改定義要另外標「敏感度分析，不是標籤」）：
 * - `unaware`（a）：不知道有對手。對手的蛇身不是障礙（只避自己的身體與牆），不放僚機，不躲對手的僚機。
 * - `aware`（b）：知道有對手、但不讀它的狀態。任何蛇身都是障礙；只要能放就放（放出去的時機與對手的位置、
 *   對手的僚機、鎖定、冷卻都無關）；不躲對手的僚機。
 * - `reads`（c）：（b）再加上讀對手的公開狀態：只在對手最近的一格離我的尾端 ≤ `NEAR_TAIL` 格時才放；
 *   躲對手的僚機（下一步的候選裡，離僚機 2 次走格之後的位置太近的扣分）。
 * 互動強度 ＝ （c）− （b）。
 *
 * 另外的簡單劇本，量「有沒有支配策略」（> 90% 就是，10.40）：
 * - `eater`：永遠不放僚機、只吃食物（任務指定的劇本，直接量「等待不花任何東西」）。
 * - `spam`：＝ `aware`（能放就放）。
 * - `dodger`：`eater`，加上躲對手的僚機（＝ 只拿 `reads` 的躲，不放僚機）。
 */

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

/** `reads` 放僚機的條件：對手最近的一格離我的尾端幾格以內。 */
export const NEAR_TAIL = 8;
/** 躲僚機：候選的下一格離僚機 2 次走格之後的位置小於這麼多格就扣分。 */
const DODGE_RANGE = 4;
const DODGE_WEIGHT = 3;

function press(dir: number): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT;
}

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

export type PlayerKind = 'eater' | 'spam' | 'dodger' | 'unaware' | 'aware' | 'reads';

interface Traits {
  /** 對手的蛇身算不算障礙。 */
  readonly seesOpponent: boolean;
  /** 躲對手的僚機。 */
  readonly dodges: boolean;
  /** 放僚機：never 不放；ready 能放就放；near 對手靠近尾端才放。 */
  readonly launch: 'never' | 'ready' | 'near';
}

const TRAITS: Readonly<Record<PlayerKind, Traits>> = {
  eater: { seesOpponent: true, dodges: false, launch: 'never' },
  spam: { seesOpponent: true, dodges: false, launch: 'ready' },
  dodger: { seesOpponent: true, dodges: true, launch: 'never' },
  unaware: { seesOpponent: false, dodges: false, launch: 'never' },
  aware: { seesOpponent: true, dodges: false, launch: 'ready' },
  reads: { seesOpponent: true, dodges: true, launch: 'near' },
};

/** 對手的僚機 2 次走格之後的位置（往它的 aim 走）。 */
function futureDrone(state: CQState, side: Side): number | null {
  const drone = state.drone[side === 0 ? 1 : 0];
  if (drone === null) {
    return null;
  }
  let at = drone.cell;
  for (let i = 0; i < 2; i += 1) {
    const dx = cellX(drone.aim) - cellX(at);
    const dy = cellY(drone.aim) - cellY(at);
    if (dx === 0 && dy === 0) {
      break;
    }
    at =
      Math.abs(dx) >= Math.abs(dy) && dx !== 0
        ? cell(cellX(at) + Math.sign(dx), cellY(at))
        : cell(cellX(at), cellY(at) + Math.sign(dy));
  }
  return at;
}

function moveTowardFood(state: CQState, side: Side, traits: Traits): Buttons {
  const me = state.snakes[side];
  if (state.over || !me.alive || me.turn !== me.dir || state.lock[side] > 0) {
    return NONE;
  }
  const head = me.body[0] as number;
  const blocked = new Uint8Array(CELLS);
  state.snakes.forEach((snake, i) => {
    if (i !== side && !traits.seesOpponent) {
      return;
    }
    for (let k = 0; k < snake.body.length - 1; k += 1) {
      blocked[snake.body[k] as number] = 1;
    }
  });
  const candidates = [me.dir, (me.dir + 1) % 4, (me.dir + 3) % 4].map((d) => {
    const nx = cellX(head) + (DX[d] as number);
    const ny = cellY(head) + (DY[d] as number);
    const inside = inBounds(nx, ny);
    let free = inside && blocked[cell(nx, ny)] === 0;
    if (free) {
      let exit = false;
      for (let e = 0; e < 4; e += 1) {
        const ex = nx + (DX[e] as number);
        const ey = ny + (DY[e] as number);
        if (inBounds(ex, ey) && blocked[cell(ex, ey)] === 0 && cell(ex, ey) !== head) {
          exit = true;
        }
      }
      free = exit;
    }
    return { d, nx, ny, inside, free };
  });
  let pool = candidates.filter((c) => c.free);
  if (pool.length === 0) {
    pool = candidates.filter((c) => c.inside);
  }
  if (pool.length === 0) {
    return NONE;
  }
  const threat = traits.dodges ? futureDrone(state, side) : null;
  let pick = pool[0] as (typeof pool)[number];
  let best = Number.POSITIVE_INFINITY;
  for (const c of pool) {
    let distance = Number.POSITIVE_INFINITY;
    for (const food of state.foods) {
      distance = Math.min(distance, Math.abs(cellX(food) - c.nx) + Math.abs(cellY(food) - c.ny));
    }
    if (!Number.isFinite(distance)) {
      distance = 0;
    }
    if (threat !== null) {
      distance += DODGE_WEIGHT * Math.max(0, DODGE_RANGE - manhattan(cell(c.nx, c.ny), threat));
    }
    if (distance < best) {
      best = distance;
      pick = c;
    }
  }
  return press(pick.d);
}

/** 劇本玩家。`game` 只用來問「現在能不能放」（`actions` 有沒有帶 a 的）。 */
export function scripted(game: Game<CQState>, kind: PlayerKind): Controller<CQState> {
  const traits = TRAITS[kind];
  return {
    decide(state: CQState, side: Side): Buttons {
      const move = moveTowardFood(state, side, traits);
      if (traits.launch === 'never' || state.over) {
        return move;
      }
      if (!game.actions(state, side).some((b) => b.a)) {
        return move;
      }
      if (traits.launch === 'near') {
        const tail = state.snakes[side].body[state.snakes[side].body.length - 1] as number;
        let nearest = Number.POSITIVE_INFINITY;
        for (const c of state.snakes[side === 0 ? 1 : 0].body) {
          nearest = Math.min(nearest, manhattan(tail, c));
        }
        if (nearest > NEAR_TAIL) {
          return move;
        }
      }
      return { ...move, a: true };
    },
  };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** 第 10 百分位（升冪排序後取索引 floor(n/10)）。 */
export function p10(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 10)] as number;
}

export interface PlayedGame {
  readonly winner: Side | null;
  readonly ticks: number;
  readonly final: CQState;
}

export function playPair(
  game: Game<CQState>,
  seed: number,
  config: GameConfig,
  c0: Controller<CQState>,
  c1: Controller<CQState>,
  onTick?: (after: CQState, before: CQState) => void,
): PlayedGame {
  let state = game.init(seed, config);
  let tick = 0;
  while (!game.isOver(state)) {
    const before = state;
    state = game.step(state, [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ]);
    tick += 1;
    onTick?.(state, before);
  }
  return { winner: game.winner(state), ticks: state.tick, final: state };
}

/**
 * 劇本玩家對搜尋型的勝率（平手算半場）。種子 `seeds`，偶數種子坐 0 號邊、奇數坐 1 號邊；
 * AI 的亂數種子是 `seed + 1_000_003`（與 `winRate` 同一個約定）。
 */
export function scriptedWinRate(
  game: Game<CQState>,
  kind: PlayerKind,
  seeds: readonly number[],
  config: GameConfig,
  aiLevel = 10,
): number {
  let points = 0;
  for (const seed of seeds) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const player = scripted(game, kind);
    const ai = levelController(game, pathfinder, aiLevel, seed + 1_000_003);
    const result = playPair(game, seed, config, side === 0 ? player : ai, side === 0 ? ai : player);
    points += result.winner === null ? 0.5 : result.winner === side ? 1 : 0;
  }
  return points / seeds.length;
}

// ---------------------------------------------------------------------------
// 「誤放」的期望分差（DESIGN-AI-FUN 10.19 的第 4 題判準：每次 ≥ 0.5）
// ---------------------------------------------------------------------------

export interface ForcedLaunch {
  /** 被強迫放出的那一邊。 */
  readonly side: Side;
  /** 放出的那個 tick 起，被強迫放出的那一邊的分差（我 − 對手）比不強迫時多多少：放出後 `horizon` tick 時量。 */
  readonly deltaHorizon: number;
  /** 同上，整場結束時量。 */
  readonly deltaFinal: number;
  /** 勝負（贏 1、平 0.5、輸 0）比不強迫時多多少。 */
  readonly deltaWin: number;
  /** 這台僚機有沒有命中（鎖定生效）。 */
  readonly hit: boolean;
  /** 放出時，放的人的尾端離對手蛇身最近一格的曼哈頓距離。 */
  readonly near: number;
}

/**
 * 強迫放出的對照實驗。每個種子：兩個等級 10 搜尋型對打（種子 s 與 s + 1_000_003）；
 * 先跑一場不干預的，記下「被測的那一邊可以放、而且 300 tick 之後」的所有 tick，用種子雜湊挑一個 tick T；
 * 再跑一場完全一樣的，只在 T 那個 tick 替被測的一邊多按一個 a。比較兩場：
 * 放出後 `horizon` tick 時的分差、整場結束的分差、勝負。偶數種子被測的是 0 號邊，奇數是 1 號邊。
 *
 * 這量的是「在一個隨機時刻多放一台」的淨效果：AI 自己之後本來也會放，所以強迫放出佔用了冷卻，
 * 淨效果包含「少了一次它自己挑的放法」。這正是 10.19 第 4 題問的「放錯的代價」。
 */
export function forcedLaunches(
  game: Game<CQState>,
  seeds: readonly number[],
  config: GameConfig,
  horizon = 900,
): ForcedLaunch[] {
  const rows: ForcedLaunch[] = [];
  for (const seed of seeds) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const other: Side = side === 0 ? 1 : 0;
    const run = (forceTick: number | null) => {
      const controllers = [
        levelController(game, pathfinder, 10, seed),
        levelController(game, pathfinder, 10, seed + 1_000_003),
      ] as const;
      let state = game.init(seed, config);
      const ready: number[] = [];
      let tick = 0;
      let forced = false;
      let hitsAt = 0;
      let hit = false;
      let near = -1;
      let atHorizon: number | null = null;
      while (!game.isOver(state)) {
        const b0 = copyButtons(controllers[0].decide(state, 0, tick));
        const b1 = copyButtons(controllers[1].decide(state, 1, tick));
        const can = game.actions(state, side).some((b) => b.a);
        if (forceTick === null && can && tick >= 300) {
          ready.push(tick);
        }
        if (forceTick === tick && can) {
          (side === 0 ? b0 : b1).a = true;
          forced = true;
          hitsAt = state.hits[side];
          const mine = state.snakes[side].body;
          const tail = mine[mine.length - 1] as number;
          near = Math.min(...state.snakes[other].body.map((c) => manhattan(tail, c)));
        }
        state = game.step(state, [b0, b1]);
        tick += 1;
        hit = hit || (forced && state.hits[side] > hitsAt);
        if (forceTick !== null && tick === forceTick + horizon) {
          atHorizon = state.snakes[side].score - state.snakes[other].score;
        }
      }
      const final = state.snakes[side].score - state.snakes[other].score;
      const winner = game.winner(state);
      return {
        ready,
        final,
        atHorizon: atHorizon ?? final,
        win: winner === null ? 0.5 : winner === side ? 1 : 0,
        forced,
        hit,
        near,
      };
    };
    const base = run(null);
    if (base.ready.length === 0) {
      continue;
    }
    const mix = Math.imul(seed + 1, 2654435761) >>> 0;
    const pickTick = base.ready[((mix ^ (mix >>> 15)) >>> 0) % base.ready.length] as number;
    // 不干預的那場在 horizon 時的分差：同樣的對局再跑一次，在 pickTick + horizon 取值
    const controllers = [
      levelController(game, pathfinder, 10, seed),
      levelController(game, pathfinder, 10, seed + 1_000_003),
    ] as const;
    let state = game.init(seed, config);
    let baseHorizon: number | null = null;
    let tick = 0;
    while (!game.isOver(state)) {
      state = game.step(state, [
        copyButtons(controllers[0].decide(state, 0, tick)),
        copyButtons(controllers[1].decide(state, 1, tick)),
      ]);
      tick += 1;
      if (tick === pickTick + horizon) {
        baseHorizon = state.snakes[side].score - state.snakes[other].score;
      }
    }
    const forced = run(pickTick);
    if (!forced.forced) {
      continue;
    }
    rows.push({
      side,
      deltaHorizon: forced.atHorizon - (baseHorizon ?? base.final),
      deltaFinal: forced.final - base.final,
      deltaWin: forced.win - base.win,
      hit: forced.hit,
      near: forced.near,
    });
  }
  return rows;
}

export interface Summary {
  readonly n: number;
  readonly mean: number;
  readonly se: number;
}

export function summarize(values: readonly number[]): Summary {
  const n = values.length;
  const mean = n === 0 ? 0 : values.reduce((a, b) => a + b, 0) / n;
  const variance = n < 2 ? 0 : values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return { n, mean, se: Math.sqrt(variance / Math.max(1, n)) };
}
