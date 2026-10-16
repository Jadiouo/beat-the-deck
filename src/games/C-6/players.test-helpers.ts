import type { Buttons, Controller, Game, Side } from '../../core/types';
import { cell, cellX, cellY, HEIGHT, MOVE_EVERY, WIDTH } from '../_clubs/logic';
import { evaluateC6, fieldFor, isWall, partnerOf, facingOf, TRANSIT_MOVES, FAR } from './logic';
import type { C6State } from './logic';

/**
 * C-6 的劇本玩家與量測（DESIGN-AI-FUN 10.4、10.24、10.35）。都只讀 state，不是 `logic.ts`，不在純度掃描範圍。
 *
 * 劇本玩家（`scripted`）三種，只差「知道多少」，走路的方式（挑目標之後往最短路走、避開一步必死、保留一條活路）完全相同：
 * - `unaware`（a）：不知道有對手。只把自己的身體當障礙，不看對手的身體，也不看門的出口有沒有人。
 * - `aware`（b）：知道有對手存在。所有蛇身都是障礙；進門前確認出口沒被身體占著、出口前方 2 格不是死路。
 *   但不看對手「現在在做什麼」：不看它的蛇頭、不看它有沒有在傳送、挑目標只看自己的距離。
 * - `reads`（c）：（b）再加上讀 AI 的公開狀態：挑「我比它先到」的食物（AI 的距離含它傳送剩下的時間）；
 *   不進出口附近 4 格有 AI 蛇頭的門；不進 AI 正在傳送中的那一對；避開 AI 蛇頭下一步的格子。
 * 互動強度 ＝ （c）− （b）。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;

function press(dir: number): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

export type Awareness = 'unaware' | 'aware' | 'reads';

function bodyCells(state: C6State, side: Side, includeOther: boolean): Set<number> {
  const set = new Set<number>();
  state.snakes.forEach((snake, i) => {
    if (i !== side && !includeOther) {
      return;
    }
    for (let k = 0; k < snake.body.length - 1; k += 1) {
      set.add(snake.body[k] as number);
    }
  });
  return set;
}

function inside(x: number, y: number): boolean {
  return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT;
}

/** AI 離某個食物還要幾次走格（含傳送剩下的時間）。 */
function rivalDistance(state: C6State, rival: Side, food: number): number {
  const field = fieldFor([food]);
  const transit = state.transit[rival];
  if (transit !== null) {
    return (
      Math.max(1, Math.ceil((transit.until - state.tick) / MOVE_EVERY)) +
      (field[transit.to] as number)
    );
  }
  return field[state.snakes[rival].body[0] as number] as number;
}

export function choose(state: C6State, side: Side, mode: Awareness): number {
  const me = state.snakes[side];
  const rival: Side = side === 0 ? 1 : 0;
  const other = state.snakes[rival];
  const head = me.body[0] as number;
  const hx = cellX(head);
  const hy = cellY(head);
  const blocked = bodyCells(state, side, mode !== 'unaware');
  for (const own of me.body.slice(0, -1)) {
    blocked.add(own);
  }

  // 目標：最近的食物；（c）挑「我比它先到」的。
  let target = -1;
  let best = Number.POSITIVE_INFINITY;
  for (const food of state.foods) {
    const mine = fieldFor([food])[head] as number;
    let score = mine;
    if (mode === 'reads' && other.alive) {
      const theirs = rivalDistance(state, rival, food);
      score = mine <= theirs ? mine : 1000 + (mine - theirs);
    }
    if (score < best) {
      best = score;
      target = food;
    }
  }
  const field = target >= 0 ? fieldFor([target]) : null;
  const otherHead = other.body[0] as number;
  const otherNext = cell(
    Math.min(WIDTH - 1, Math.max(0, cellX(otherHead) + (DX[other.turn] as number))),
    Math.min(HEIGHT - 1, Math.max(0, cellY(otherHead) + (DY[other.turn] as number))),
  );

  const safeContinuation = (n: number, d: number): boolean => {
    const exit = partnerOf(n) >= 0 ? partnerOf(n) : -1;
    const base = exit >= 0 ? exit : n;
    const dirs = exit >= 0 ? [facingOf(exit)] : [d, (d + 1) % 4, (d + 3) % 4];
    return dirs.some((k) => {
      const x = cellX(base) + (DX[k] as number);
      const y = cellY(base) + (DY[k] as number);
      return inside(x, y) && !isWall(cell(x, y)) && !blocked.has(cell(x, y));
    });
  };

  const candidates: { d: number; cost: number }[] = [];
  for (const d of [me.dir, (me.dir + 1) % 4, (me.dir + 3) % 4]) {
    const x = hx + (DX[d] as number);
    const y = hy + (DY[d] as number);
    if (!inside(x, y) || isWall(cell(x, y))) {
      continue;
    }
    const n = cell(x, y);
    if (blocked.has(n)) {
      continue;
    }
    const partner = partnerOf(n);
    let cost: number;
    if (partner >= 0) {
      if (blocked.has(partner)) {
        continue;
      }
      if (mode !== 'unaware') {
        const f = facingOf(partner);
        let deadEnd = false;
        for (let r = 1; r <= 2; r += 1) {
          const ex = cellX(partner) + r * (DX[f] as number);
          const ey = cellY(partner) + r * (DY[f] as number);
          if (!inside(ex, ey) || isWall(cell(ex, ey)) || blocked.has(cell(ex, ey))) {
            deadEnd = true;
          }
        }
        if (deadEnd) {
          continue;
        }
      }
      if (mode === 'reads' && other.alive) {
        const theirs = state.transit[rival];
        if (
          theirs !== null &&
          (theirs.from === partner || theirs.to === partner || theirs.from === n)
        ) {
          continue;
        }
        const dist =
          Math.abs(cellX(otherHead) - cellX(partner)) + Math.abs(cellY(otherHead) - cellY(partner));
        if (dist <= 4) {
          continue;
        }
      }
      cost = field === null ? 0 : Math.min(FAR, TRANSIT_MOVES + (field[partner] as number));
    } else {
      cost = field === null ? 0 : (field[n] as number);
    }
    if (mode === 'reads' && other.alive && n === otherNext) {
      continue;
    }
    if (!safeContinuation(n, d)) {
      cost += 50;
    }
    candidates.push({ d, cost: cost + (d === me.dir ? 0 : 0.01) });
  }
  if (candidates.length === 0) {
    return me.dir;
  }
  candidates.sort((p, q) => p.cost - q.cost);
  return (candidates[0] as { d: number }).d;
}

export function scripted(mode: Awareness): Controller<C6State> {
  let held = NONE;
  let heldAt = -1;
  return {
    decide(state, side): Buttons {
      if (state.tick % MOVE_EVERY !== 0 || heldAt === state.tick) {
        return held;
      }
      heldAt = state.tick;
      if (state.transit[side] !== null || !state.snakes[side].alive) {
        held = NONE;
        return held;
      }
      const d = choose(state, side, mode);
      held = d === state.snakes[side].dir ? NONE : press(d);
      return held;
    },
  };
}

// ---------------------------------------------------------------------------
// 量測
// ---------------------------------------------------------------------------

export interface Tracked {
  readonly ticks: number;
  readonly winner: Side | null;
  readonly score: readonly [number, number];
  readonly uses: readonly [number, number];
  /** 因為出口被佔用而死的次數（state.blocks）。 */
  readonly blocks: number;
  /** 「走到被堵住的門前」：蛇頭貼著門口、朝著它，而配對的出口被身體占著或有傳送中的蛇頭（每次接近算一次）。 */
  readonly softBlocks: number;
  /** 死在出口：出口被佔用而死，或冒出來之後 2 次走格內撞死；每邊 0 或 1。 */
  readonly exitAccidents: readonly [number, number];
  /** 對手正在傳送中的時候，這條蛇撞上它（靜止的牆）死掉。 */
  readonly hitFrozen: number;
  /** 每邊進門時「出口 4 格內有對手蛇頭」的次數。 */
  readonly riskyUses: readonly [number, number];
  /** 每邊每次「決定走進門口」那一刻的出口 danger（`evaluateC6`）；性格指紋的機制量（10.48）。 */
  readonly entryDangers: readonly [readonly number[], readonly number[]];
  /** 死因分類（每條死掉的蛇一筆）：edge 出界、midwall 中間的牆、self、other、frozen 撞上傳送中的蛇、exit 出口被佔用、head 頭對頭。 */
  readonly causes: Readonly<Record<string, number>>;
  readonly reason: 'time' | 'crash' | 'exit';
}

function causeOf(before: C6State, after: C6State, i: 0 | 1): string {
  if (after.exitDeaths[i] > before.exitDeaths[i]) {
    return 'exit';
  }
  const sn = before.snakes[i];
  const head = sn.body[0] as number;
  const x = cellX(head) + (DX[sn.turn] as number);
  const y = cellY(head) + (DY[sn.turn] as number);
  if (!inside(x, y)) {
    return 'edge';
  }
  const c = cell(x, y);
  if (isWall(c)) {
    return 'midwall';
  }
  const j = i === 0 ? 1 : 0;
  if (sn.body.includes(c)) {
    return 'self';
  }
  if (before.snakes[j].body.includes(c)) {
    return before.transit[j] !== null ? 'frozen' : 'other';
  }
  return 'head';
}

export function playTracked(
  game: Game<C6State>,
  seed: number,
  maxTicks: number,
  c0: Controller<C6State>,
  c1: Controller<C6State>,
): Tracked {
  let state = game.init(seed, { maxTicks, params: {} });
  let tick = 0;
  let softBlocks = 0;
  let hitFrozen = 0;
  const riskyUses: [number, number] = [0, 0];
  const lastEmerged: [number, number] = [-1000, -1000];
  const exitAccidents: [number, number] = [0, 0];
  const near: [boolean, boolean] = [false, false];
  const entryDangers: [number[], number[]] = [[], []];
  const causes: Record<string, number> = {};
  while (!game.isOver(state)) {
    const a = c0.decide(state, 0, tick);
    const b = c1.decide(state, 1, tick);
    const before = state;
    if (before.tick % MOVE_EVERY === MOVE_EVERY - 1) {
      for (const i of [0, 1] as const) {
        const sn = before.snakes[i];
        if (!sn.alive || before.transit[i] !== null) {
          continue;
        }
        const head = sn.body[0] as number;
        const x = cellX(head) + (DX[sn.turn] as number);
        const y = cellY(head) + (DY[sn.turn] as number);
        if (inside(x, y) && partnerOf(cell(x, y)) >= 0) {
          entryDangers[i].push(evaluateC6(before, i).danger);
        }
      }
    }
    state = game.step(state, [a, b]);
    tick += 1;
    for (const i of [0, 1] as const) {
      if (before.transit[i] !== null && state.transit[i] === null && state.snakes[i].alive) {
        lastEmerged[i] = state.tick;
      }
      if (state.portalUses[i] > before.portalUses[i]) {
        const to = state.transit[i]?.to ?? -1;
        const rival = state.snakes[i === 0 ? 1 : 0];
        if (to >= 0 && rival.alive) {
          const r = rival.body[0] as number;
          if (Math.abs(cellX(r) - cellX(to)) + Math.abs(cellY(r) - cellY(to)) <= 4) {
            riskyUses[i] += 1;
          }
        }
      }
      if (before.snakes[i].alive && !state.snakes[i].alive) {
        const cause = causeOf(before, state, i);
        causes[cause] = (causes[cause] ?? 0) + 1;
        if (
          state.exitDeaths[i] > before.exitDeaths[i] ||
          state.tick - lastEmerged[i] <= 2 * MOVE_EVERY
        ) {
          exitAccidents[i] = 1;
        }
        const rivalTransit = before.transit[i === 0 ? 1 : 0];
        if (rivalTransit !== null && state.exitDeaths[i] === before.exitDeaths[i]) {
          hitFrozen += 1;
        }
      }
    }
    if (state.tick % MOVE_EVERY === 0) {
      for (const i of [0, 1] as const) {
        const s = state.snakes[i];
        if (!s.alive || state.transit[i] !== null) {
          near[i] = false;
          continue;
        }
        const head = s.body[0] as number;
        const x = cellX(head) + (DX[s.dir] as number);
        const y = cellY(head) + (DY[s.dir] as number);
        let isNear = false;
        if (inside(x, y)) {
          const d = cell(x, y);
          const p = partnerOf(d);
          if (p >= 0) {
            isNear = state.snakes.some((sn) => sn.body.slice(0, -1).includes(p));
          }
        }
        if (isNear && !near[i]) {
          softBlocks += 1;
        }
        near[i] = isNear;
      }
    }
  }
  const s0 = state.snakes[0];
  const s1 = state.snakes[1];
  const reason =
    state.exitDeaths[0] + state.exitDeaths[1] > 0
      ? 'exit'
      : !s0.alive || !s1.alive
        ? 'crash'
        : 'time';
  return {
    ticks: state.tick,
    winner: state.winner,
    score: [s0.score, s1.score],
    uses: [state.portalUses[0], state.portalUses[1]],
    blocks: state.blocks,
    softBlocks,
    exitAccidents,
    hitFrozen,
    riskyUses,
    entryDangers,
    causes,
    reason,
  };
}
