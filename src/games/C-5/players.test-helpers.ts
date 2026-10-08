import { createRng } from '../../core/rng';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import { cell, cellX, cellY, HEIGHT, MOVE_EVERY, WIDTH } from '../_clubs/logic';
import type { Dir } from '../_clubs/logic';
import type { C5State } from './logic';

/**
 * C-5 的劇本玩家與逐 tick 的量測（DESIGN-AI-FUN 5.2、10.4）：證明「技術有報酬、運氣沒有」用的固定規則玩家，
 * 以及量「進入預告區、被壓死、搶到誘餌」的追蹤器。都只讀 state（完整資訊），不是 `logic.ts`，不在純度掃描範圍。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;

function neighbor(index: number, dir: Dir): number | null {
  const x = cellX(index) + DX[dir];
  const y = cellY(index) + DY[dir];
  return x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT ? null : cell(x, y);
}

/** 被擋住的格子：牆、兩條蛇的身體（不含尾巴）。 */
function blockedCells(state: C5State): Set<number> {
  const blocked = new Set<number>(state.bars.flat());
  for (const snake of state.snakes) {
    for (let i = 0; i < snake.body.length - 1; i += 1) {
      blocked.add(snake.body[i] as number);
    }
  }
  return blocked;
}

/** 落點的格子（沒有預告是空集合）。 */
export function zoneOf(state: C5State): Set<number> {
  return new Set<number>(state.landing === null ? [] : state.landing.bars.flat());
}

interface Path {
  /** 第一步的方向。 */
  readonly first: Dir;
  /** 到最近的目標要幾步。 */
  readonly steps: number;
}

/** 從 `from` 出發，BFS 找最近的 `goals`；`avoid` 是不准走的格子。找不到是 null。 */
function pathTo(
  state: C5State,
  from: number,
  goals: ReadonlySet<number>,
  avoid: ReadonlySet<number>,
): Path | null {
  const blocked = blockedCells(state);
  const seen = new Map<number, { first: Dir; steps: number }>();
  let frontier: number[] = [];
  for (const d of [0, 1, 2, 3] as const) {
    const next = neighbor(from, d);
    if (next !== null && !blocked.has(next) && !avoid.has(next) && !seen.has(next)) {
      seen.set(next, { first: d, steps: 1 });
      frontier.push(next);
    }
  }
  while (frontier.length > 0) {
    for (const c of frontier) {
      if (goals.has(c)) {
        return seen.get(c) as Path;
      }
    }
    const following: number[] = [];
    for (const c of frontier) {
      const info = seen.get(c) as Path;
      for (const d of [0, 1, 2, 3] as const) {
        const next = neighbor(c, d);
        if (next !== null && !blocked.has(next) && !avoid.has(next) && !seen.has(next)) {
          seen.set(next, { first: info.first, steps: info.steps + 1 });
          following.push(next);
        }
      }
    }
    frontier = following;
  }
  return null;
}

/** 朝某個方向走一步不會立刻死（不撞牆、牆格、身體），而且不是掉頭。 */
function safeDirections(state: C5State, side: Side): Dir[] {
  const me = state.snakes[side];
  const head = me.body[0] as number;
  const blocked = blockedCells(state);
  return ([0, 1, 2, 3] as const).filter((d) => {
    if (d === (me.dir + 2) % 4) {
      return false;
    }
    const next = neighbor(head, d);
    return next !== null && !blocked.has(next);
  });
}

function steer(state: C5State, side: Side, path: Path | null): Buttons {
  const me = state.snakes[side];
  if (path !== null) {
    return press(path.first);
  }
  const safe = safeDirections(state, side);
  if (safe.length === 0 || safe.includes(me.turn)) {
    return NONE;
  }
  return press(safe[0] as Dir);
}

function normalFoods(state: C5State): Set<number> {
  return new Set<number>(state.foods);
}

/** 離落下還有幾次走格（含下一次）。 */
function movesLeft(state: C5State): number {
  if (state.landing === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil((state.landing.at - state.tick) / MOVE_EVERY);
}

/** 只吃普通食物，絕不進落點、不碰誘餌（有預告時把落點整個當成牆）。 */
export function avoider(): Controller<C5State> {
  return {
    decide(state, side): Buttons {
      const head = state.snakes[side].body[0] as number;
      const zone = zoneOf(state);
      const food = normalFoods(state);
      const path =
        pathTo(state, head, food, zone) ??
        pathTo(state, head, food, new Set<number>()) ??
        null;
      return steer(state, side, path);
    },
  };
}

/** 每個誘餌都衝：直線（最短路）衝向誘餌；吃到之後（或沒有誘餌時）改追最近的普通食物，完全不管牆什麼時候落下。 */
export function rusher(): Controller<C5State> {
  return {
    decide(state, side): Buttons {
      const head = state.snakes[side].body[0] as number;
      const none = new Set<number>();
      if (state.bait !== null) {
        const path = pathTo(state, head, new Set<number>([state.bait.cell]), none);
        if (path !== null) {
          return steer(state, side, path);
        }
      }
      return steer(state, side, pathTo(state, head, normalFoods(state), none));
    },
  };
}

/** 退出落點：到最近的「不在落點裡」的格子的步數與方向。 */
function exitPath(state: C5State, from: number, zone: ReadonlySet<number>): Path | null {
  const blocked = blockedCells(state);
  const seen = new Map<number, Path>();
  let frontier: number[] = [from];
  seen.set(from, { first: 0, steps: 0 });
  while (frontier.length > 0) {
    const following: number[] = [];
    for (const c of frontier) {
      const info = seen.get(c) as Path;
      for (const d of [0, 1, 2, 3] as const) {
        const next = neighbor(c, d);
        if (next === null || blocked.has(next) || seen.has(next)) {
          continue;
        }
        const first = c === from ? d : info.first;
        const here = { first, steps: info.steps + 1 };
        if (!zone.has(next)) {
          return here;
        }
        seen.set(next, here);
        following.push(next);
      }
    }
    frontier = following;
  }
  return null;
}

/**
 * 會算時間的玩家：只在餘裕夠大時才衝誘餌。
 * 餘裕 ＝ 落下前還剩的走格數 − （走到誘餌 ＋ 從誘餌走出落點 ＋ 吃完之後的蛇身長度 − 1）；
 * 餘裕 ≥ `minMargin` 才衝，衝到一半餘裕變小就改成往外撤；人在落點裡又沒有誘餌了就趕快走出去。
 * 其他時候像 `avoider`（只吃落點外的普通食物）。
 */
export function timer(minMargin = 3): Controller<C5State> {
  return {
    decide(state, side): Buttons {
      const me = state.snakes[side];
      const head = me.body[0] as number;
      const zone = zoneOf(state);
      const none = new Set<number>();
      if (state.landing !== null) {
        const inZone = me.body.some((c) => zone.has(c));
        if (state.bait !== null) {
          const toBait = pathTo(state, head, new Set<number>([state.bait.cell]), none);
          const fromBait = exitPath(state, state.bait.cell, zone);
          if (toBait !== null && fromBait !== null) {
            const need = toBait.steps + fromBait.steps + (me.body.length + 2) - 1;
            const margin = movesLeft(state) - need;
            const committed = inZone;
            if (margin >= minMargin || (committed && margin >= 0)) {
              return steer(state, side, toBait);
            }
          }
        }
        if (inZone) {
          const out = headInZoneExit(state, head, zone);
          if (out !== null) {
            return steer(state, side, out);
          }
        }
      }
      const food = normalFoods(state);
      const path = pathTo(state, head, food, zone) ?? pathTo(state, head, food, none);
      return steer(state, side, path);
    },
  };
}

function headInZoneExit(state: C5State, head: number, zone: ReadonlySet<number>): Path | null {
  return zone.has(head) ? exitPath(state, head, zone) : null;
}

/** 均勻亂決定：每 6 個 tick 從「不按、四個方向」裡亂選一個（基準線）。 */
export function uniform(seed: number, side: Side): Controller<C5State> {
  const rng = createRng(seed * 2 + side + 17);
  const choices = [NONE, press(0), press(1), press(2), press(3)];
  let held = NONE;
  return {
    decide(_state, _side, tick): Buttons {
      if (tick % MOVE_EVERY === 0) {
        held = choices[rng.int(choices.length)] as Buttons;
      }
      return held;
    },
  };
}

// ---------------------------------------------------------------------------
// 量測
// ---------------------------------------------------------------------------

export interface Tracked {
  /** 一局走了幾個 tick。 */
  readonly ticks: number;
  readonly winner: Side | null;
  readonly score: readonly [number, number];
  /** 每邊「蛇頭從落點外走進落點」的次數（只算預告進行中）。 */
  readonly entries: readonly [number, number];
  /** 每邊吃到誘餌的次數。 */
  readonly baits: readonly [number, number];
  /** 每邊被壓死的次數（0 或 1）。 */
  readonly crushed: readonly [number, number];
  /** 每邊「撞死」的次數（牆、身體、頭對頭），不含被壓死。 */
  readonly crashed: readonly [number, number];
  /** 有預告的 tick 數（只用來看覆蓋率）。 */
  readonly previewTicks: number;
}

/** 玩一局，同時記下進入預告區、吃誘餌、被壓死的次數。 */
export function playTracked(
  game: Game<C5State>,
  seed: number,
  maxTicks: number,
  c0: Controller<C5State>,
  c1: Controller<C5State>,
): Tracked {
  let state = game.init(seed, { maxTicks, params: {} });
  const entries: [number, number] = [0, 0];
  const baits: [number, number] = [0, 0];
  let previewTicks = 0;
  let tick = 0;
  while (!game.isOver(state)) {
    const a = c0.decide(state, 0, tick);
    const b = c1.decide(state, 1, tick);
    const before = state;
    state = game.step(state, [a, b]);
    tick += 1;
    if (before.landing !== null) {
      previewTicks += 1;
      const zone = zoneOf(before);
      for (const i of [0, 1] as const) {
        const was = before.snakes[i].body[0] as number;
        const now = state.snakes[i].body[0] as number;
        if (now !== was && zone.has(now) && !zone.has(was) && state.snakes[i].alive) {
          entries[i] += 1;
        }
      }
    }
    for (const i of [0, 1] as const) {
      if (state.snakes[i].score - before.snakes[i].score === 2) {
        baits[i] += 1;
      }
    }
  }
  const crushedNow = state.crushed;
  return {
    ticks: state.tick,
    winner: state.winner,
    score: [state.snakes[0].score, state.snakes[1].score],
    entries,
    baits,
    crushed: [crushedNow[0] as number, crushedNow[1] as number],
    crashed: [
      !state.snakes[0].alive && crushedNow[0] === 0 ? 1 : 0,
      !state.snakes[1].alive && crushedNow[1] === 0 ? 1 : 0,
    ],
    previewTicks,
  };
}
