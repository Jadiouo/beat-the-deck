import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { copyButtons } from '../../core/match';
import type { Buttons, Controller, Game, GameConfig, Side } from '../../core/types';
import { distFrom, mazeInfo, layoutOf } from './logic';
import type { C9State, RoundOutcome } from './logic';

/**
 * C-9 的劇本玩家與量測工具（DESIGN-AI-FUN 10.4、10.24、10.35、10.40、10.54）。
 * 都只讀 state，不是 `logic.ts`，不在純度掃描範圍。
 *
 * 劇本玩家只用「最短路表」走路：每次可選的方向（順時針、逆時針、直走）中，挑下一格離目標最近的；
 * 平手順時針在前。他們沒有反應延遲、每個 tick 都看得到現在的世界（比 AI 強的是這一點，不是策略）。
 *
 * 探針 A 的三組（**定義在量之前固定**，DESIGN-AI-FUN 10.54；改定義要另外標「敏感度分析，不是標籤」）：
 * - `unaware`（a）：不知道有對手存在。只把自己的身體當障礙；目標固定「鑰匙，叼著就門」；
 *   對手叼走鑰匙之後仍然走向鑰匙原本的位置（它不知道鑰匙會被拿走）。
 * - `aware`（b）：知道有對手存在。**任何蛇身都是障礙**（下一格有蛇身就不走）；目標同樣固定「鑰匙，叼著就門」。
 *   不看對手的位置、方向、有沒有叼鑰匙來挑目標或路線。
 * - `reads`（c）：（b）再加上讀對手的公開狀態來決定策略：
 *   對手叼著鑰匙 → 守門（走向門前的路口，不進門前的死路）；
 *   鑰匙在地上而且對手比我近、又正在走向鑰匙 → 守門，否則去拿；
 *   叼著鑰匙時，避開「對手 2 步內到得了」的格子（有別條路就繞）。
 * 互動強度 ＝ （c）− （b）；（b）− （a）是「知道有對手」本身的價值。
 *
 * 另外三個簡單劇本，量「有沒有支配策略」（> 90% 就是，10.40）：
 * - `guard`（站在門口）：永遠守門，不去拿鑰匙（蛇不能停，所以是在門前路口繞圈）。
 * - `bluff`（假裝拿鑰匙再折回）：走向鑰匙到 8 步內就折回守門；對手叼著鑰匙時守門；自己叼著鑰匙時走向門。
 * - `rusher` 就是 `aware`。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

function press(dir: number): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

export type PlayerKind = 'unaware' | 'aware' | 'reads' | 'guard' | 'bluff';

/** 下一步可以走的方向：走得通、不是確定會死（沒鑰匙進門、走進出不來的死路）；`avoid` 指定哪些蛇身算障礙。 */
function candidates(state: C9State, side: Side, avoid: 'own' | 'all'): number[] {
  const layout = layoutOf(state);
  const info = mazeInfo(layout);
  const me = state.snakes[side];
  const head = me.body[0] as number;
  const holds = state.keyHolder === side;
  const out: number[] = [];
  for (const dir of [(me.dir + 1) % 4, (me.dir + 3) % 4, me.dir]) {
    const target = info.next[head * 4 + dir] as number;
    if (target === -1) {
      continue;
    }
    if (target === layout.door && !holds) {
      continue;
    }
    if (info.fringe[target] === 1 && !(holds && info.doorPath[target] === 1)) {
      continue;
    }
    let blocked = false;
    state.snakes.forEach((snake, i) => {
      if (avoid === 'own' && i !== side) {
        return;
      }
      const last = snake.alive ? snake.body.length - 1 : snake.body.length;
      for (let k = 0; k < last; k += 1) {
        if (snake.body[k] === target) {
          blocked = true;
        }
      }
    });
    if (!blocked) {
      out.push(dir);
    }
  }
  return out;
}

/** 門前的路口：從門往外走，第一個不在死路上的格子。 */
function pocketEntrance(state: C9State): number {
  const layout = layoutOf(state);
  const info = mazeInfo(layout);
  let cursor = layout.door;
  const seen = new Set<number>([cursor]);
  for (let guard = 0; guard < 60; guard += 1) {
    let step = -1;
    for (let d = 0; d < 4; d += 1) {
      const n = info.next[cursor * 4 + d] as number;
      if (n !== -1 && !seen.has(n)) {
        step = n;
        break;
      }
    }
    if (step === -1) {
      return cursor;
    }
    if (info.fringe[step] === 0) {
      return step;
    }
    seen.add(step);
    cursor = step;
  }
  return cursor;
}

function pick(
  state: C9State,
  side: Side,
  table: Int16Array,
  avoid: 'own' | 'all',
  penalty?: (cell: number) => number,
): Buttons {
  const info = mazeInfo(layoutOf(state));
  const head = state.snakes[side].body[0] as number;
  const options = candidates(state, side, avoid);
  let best = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const dir of options) {
    const target = info.next[head * 4 + dir] as number;
    const cost = (table[target] as number) + (penalty === undefined ? 0 : penalty(target));
    if (cost < bestCost) {
      bestCost = cost;
      best = dir;
    }
  }
  return best === -1 ? NONE : press(best);
}

export function scripted(kind: PlayerKind): Controller<C9State> {
  let pocket = -1;
  let pocketRound = -1;
  return {
    decide(state: C9State, side: Side): Buttons {
      if (state.over || state.pause > 0 || state.outcome !== null) {
        return NONE;
      }
      const layout = layoutOf(state);
      const info = mazeInfo(layout);
      if (state.round !== pocketRound) {
        pocket = pocketEntrance(state);
        pocketRound = state.round;
      }
      const other: Side = side === 0 ? 1 : 0;
      const me = state.snakes[side];
      const opp = state.snakes[other];
      const head = me.body[0] as number;
      const oppHead = opp.body[0] as number;
      const holds = state.keyHolder === side;
      const oppHolds = state.keyHolder === other;
      const toDoor = distFrom(info, layout.door);
      const toKey = distFrom(info, state.key);
      const toPocket = distFrom(info, pocket);

      if (kind === 'unaware') {
        return pick(state, side, holds ? toDoor : toKey, 'own');
      }
      if (kind === 'aware') {
        return pick(state, side, holds ? toDoor : toKey, 'all');
      }
      if (kind === 'guard') {
        return pick(state, side, holds ? toDoor : toPocket, 'all');
      }
      if (kind === 'bluff') {
        if (holds) {
          return pick(state, side, toDoor, 'all');
        }
        if (oppHolds || (toKey[head] as number) <= 8) {
          return pick(state, side, toPocket, 'all');
        }
        return pick(state, side, toKey, 'all');
      }
      // reads
      const fromOpp = distFrom(info, oppHead);
      if (holds) {
        return pick(state, side, toDoor, 'all', (cell) =>
          (fromOpp[cell] as number) <= 2 ? 12 : 0,
        );
      }
      if (oppHolds) {
        return pick(state, side, toPocket, 'all');
      }
      const oppNext = info.next[oppHead * 4 + opp.turn] as number;
      const approaching = oppNext !== -1 && (toKey[oppNext] as number) < (toKey[oppHead] as number);
      const favorite = (toKey[head] as number) <= (toKey[oppHead] as number) || !approaching;
      return favorite
        ? pick(state, side, toKey, 'all', (cell) => ((fromOpp[cell] as number) <= 1 ? 12 : 0))
        : pick(state, side, toPocket, 'all');
    },
  };
}

// ---------------------------------------------------------------------------
// 對局紀錄
// ---------------------------------------------------------------------------

export interface RoundLog {
  readonly round: number;
  readonly outcome: RoundOutcome;
  /** 這一局結束時的 `roundTick`。 */
  readonly endTick: number;
  /** 兩邊拿到鑰匙的 `roundTick`（沒拿到是 -1）。 */
  readonly keyTicks: readonly [number, number];
  /** 結束時有沒有人在門格上（叼著鑰匙進門）。 */
  readonly atDoor: boolean;
  /** 死亡的蛇（0、1 或兩條都在）。 */
  readonly dead: readonly Side[];
}

export interface TrackedGame {
  readonly rounds: readonly RoundLog[];
  readonly ticks: number;
  readonly winner: Side | null;
  readonly final: C9State;
}

/** 打完一場，每局結束時記一筆。 */
export function playTracked(
  game: Game<C9State>,
  seed: number,
  config: GameConfig,
  c0: Controller<C9State>,
  c1: Controller<C9State>,
  onTick?: (state: C9State, before: C9State) => void,
): TrackedGame {
  let state = game.init(seed, config);
  const rounds: RoundLog[] = [];
  let tick = 0;
  while (!game.isOver(state)) {
    const before = state;
    state = game.step(state, [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ]);
    tick += 1;
    if (state.outcome !== null && before.outcome === null) {
      const layout = layoutOf(state);
      rounds.push({
        round: state.round,
        outcome: state.outcome,
        endTick: state.roundTick,
        keyTicks: state.keyTicks,
        atDoor: state.snakes.some((snake) => snake.alive && snake.body[0] === layout.door),
        dead: ([0, 1] as const).filter((i) => !state.snakes[i].alive),
      });
    }
    onTick?.(state, before);
  }
  return { rounds, ticks: state.tick, winner: game.winner(state), final: state };
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

/**
 * 劇本玩家對搜尋型的勝率（平手算半場）。種子 `seeds`，偶數種子坐 0 號邊、奇數坐 1 號邊；
 * AI 的亂數種子是 `seed + 1_000_003`（與 `winRate` 同一個約定）。
 */
export function scriptedWinRate(
  game: Game<C9State>,
  kind: PlayerKind,
  seeds: readonly number[],
  config: GameConfig,
  aiLevel = 10,
): number {
  let points = 0;
  for (const seed of seeds) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const player = scripted(kind);
    const ai = levelController(game, pathfinder, aiLevel, seed + 1_000_003);
    const result = playTracked(
      game,
      seed,
      config,
      side === 0 ? player : ai,
      side === 0 ? ai : player,
    );
    points += result.winner === null ? 0.5 : result.winner === side ? 1 : 0;
  }
  return points / seeds.length;
}
