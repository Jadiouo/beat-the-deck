import { createRng } from '../../core/rng';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import { cell, cellX, cellY, HEIGHT, MOVE_EVERY, WIDTH } from '../_clubs/logic';
import type { C7State } from './logic';
import { SPRINT_MIN_LEN } from './logic';

/**
 * C-7 的劇本玩家與量測（DESIGN-AI-FUN 10.4、10.24）。都只讀 state，不是 `logic.ts`，不在純度掃描範圍。
 *
 * 規劃型玩家（`planner`）：每次走格後用一個簡化模擬（自由格子、不計蛇身碰撞、值是長度差）往前看 10 次走格，
 * 在「去哪一顆食物 × 第幾次走格衝刺（或不衝）」之間選最好的。兩個版本只差一件事：
 * - `ability`（讀 AI）：模擬時把 AI 放進去（去它最近的那顆食物；它的衝刺冷卻是 0 且夠長就假設它這一格會衝）。
 * - `absent`（不讀）：模擬時把 AI 整個拿掉，照自己的幾何選目標與衝刺。
 * 真正走的時候兩者完全一樣：往選定目標的貪心方向走，避開牆與身體；要衝刺時兩格都要安全才按 a。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;

function press(dir: number, sprint: boolean): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3, a: sprint };
}

// ---------------------------------------------------------------------------
// 簡化模擬
// ---------------------------------------------------------------------------

interface Sim {
  x: number;
  y: number;
  d: number;
  len: number;
  /** 還要等幾次走格才能衝刺。 */
  cd: number;
}
type Food = [number, number];

const GAIN = 5;
const COST = 2;
const CD_MOVES = 5;
const HORIZON = 10;
/** 衝刺時機：不衝，或第 0、1、2 次走格衝。 */
const SPRINT_PLANS = [-1, 0, 1, 2] as const;

function manhattan(p: { x: number; y: number }, f: Food): number {
  return Math.abs(p.x - f[0]) + Math.abs(p.y - f[1]);
}

function greedyDir(p: Sim, f: Food): number {
  let best = p.d;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const d of [p.d, (p.d + 1) % 4, (p.d + 3) % 4]) {
    const nx = p.x + (DX[d] as number);
    const ny = p.y + (DY[d] as number);
    if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) {
      continue;
    }
    const dist = Math.abs(nx - f[0]) + Math.abs(ny - f[1]);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

function nearestIndex(p: { x: number; y: number }, foods: readonly (Food | null)[]): number {
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  foods.forEach((f, i) => {
    if (f !== null && manhattan(p, f) < bestDist) {
      bestDist = manhattan(p, f);
      best = i;
    }
  });
  return best;
}

/** AI 在模擬裡的樣子：不存在、或去它最近的食物（`sprintAt`：第幾次走格衝刺，-2 是只要能衝就衝）。 */
type Rival = { kind: 'absent' } | { kind: 'goes'; sprintAt: number };

/** 我選 `target`、第 `sprintAt` 次走格衝刺，往前 `HORIZON` 次走格，回傳「我的長度變化 − 對手的長度變化」。 */
function simulate(
  me0: Sim,
  rival0: Sim,
  foods0: readonly Food[],
  target: number,
  sprintAt: number,
  rival: Rival,
): number {
  const a = { ...me0 };
  const b = { ...rival0 };
  const foods: (Food | null)[] = foods0.map((f) => [f[0], f[1]] as Food);
  const absent = rival.kind === 'absent';
  const rivalSprintAt = rival.kind === 'goes' ? rival.sprintAt : -1;
  let da = 0;
  let db = 0;
  let ta = target;
  let tb = absent ? 0 : nearestIndex(b, foods);
  for (let m = 0; m < HORIZON; m += 1) {
    if (foods[ta] === null || foods[ta] === undefined) {
      ta = nearestIndex(a, foods);
    }
    if (!absent && (foods[tb] === null || foods[tb] === undefined)) {
      tb = nearestIndex(b, foods);
    }
    if (ta < 0 && (absent || tb < 0)) {
      break;
    }
    const sA = sprintAt === m && a.cd === 0 && a.len >= SPRINT_MIN_LEN;
    const sB =
      !absent &&
      (rivalSprintAt === -2 || rivalSprintAt === m) &&
      b.cd === 0 &&
      b.len >= SPRINT_MIN_LEN;
    const steps = [sA ? 2 : 1, absent ? 0 : sB ? 2 : 1];
    const players = [a, b];
    const targets = [ta, tb];
    const pos = [
      [a.x, a.y],
      [b.x, b.y],
    ];
    const dirs = [0, 1].map((i) => {
      const f = foods[targets[i] as number];
      const p = players[i] as Sim;
      return f === null || f === undefined ? p.d : greedyDir(p, f);
    });
    const ate = [-1, -1];
    for (let s = 0; s < 2; s += 1) {
      for (const i of [0, 1]) {
        if (s >= (steps[i] as number)) {
          continue;
        }
        const d = dirs[i] as number;
        const nx = (pos[i] as number[])[0]! + (DX[d] as number);
        const ny = (pos[i] as number[])[1]! + (DY[d] as number);
        if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) {
          return da - db - 50 * (i === 0 ? 1 : -1);
        }
        pos[i] = [nx, ny];
        (players[i] as Sim).d = d;
      }
      if (!absent && pos[0]![0] === pos[1]![0] && pos[0]![1] === pos[1]![1]) {
        return da - db;
      }
      for (const i of [0, 1]) {
        if (s >= (steps[i] as number) || (ate[i] as number) >= 0) {
          continue;
        }
        const k = foods.findIndex((f) => f !== null && f[0] === pos[i]![0] && f[1] === pos[i]![1]);
        if (k >= 0) {
          ate[i] = k;
        }
      }
      for (const i of [0, 1]) {
        const k = ate[i] as number;
        if (k >= 0 && foods[k] !== null) {
          if (i === 0) {
            da += GAIN;
          } else {
            db += GAIN;
          }
          foods[k] = null;
        }
      }
    }
    a.x = pos[0]![0] as number;
    a.y = pos[0]![1] as number;
    b.x = pos[1]![0] as number;
    b.y = pos[1]![1] as number;
    if (sA) {
      da -= COST;
      a.cd = CD_MOVES;
    } else if (a.cd > 0) {
      a.cd -= 1;
    }
    if (sB) {
      db -= COST;
      b.cd = CD_MOVES;
    } else if (b.cd > 0) {
      b.cd -= 1;
    }
    if ((ate[0] as number) >= 0) {
      ta = nearestIndex(a, foods);
    }
    if ((ate[1] as number) >= 0) {
      tb = nearestIndex(b, foods);
    }
  }
  return da - db;
}

// ---------------------------------------------------------------------------
// 真實局面 → 簡化模擬
// ---------------------------------------------------------------------------

function simOf(state: C7State, side: Side): Sim {
  const snake = state.snakes[side];
  const head = snake.body[0] as number;
  const cdTicks = state.sprintCd[side] as number;
  return {
    x: cellX(head),
    y: cellY(head),
    d: snake.dir,
    len: snake.body.length,
    cd: Math.ceil(Math.max(0, cdTicks - MOVE_EVERY) / MOVE_EVERY),
  };
}

function blockedCells(state: C7State): Set<number> {
  const blocked = new Set<number>();
  for (const snake of state.snakes) {
    for (let i = 0; i < snake.body.length - 1; i += 1) {
      blocked.add(snake.body[i] as number);
    }
  }
  return blocked;
}

function safe(blocked: ReadonlySet<number>, x: number, y: number): boolean {
  return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT && !blocked.has(cell(x, y));
}

export type PlannerMode = 'ability' | 'absent';

/**
 * 規劃型劇本玩家。`mode` 決定模擬裡有沒有 AI；`allowSprint: false` 時從不衝刺（消融用）。
 */
export function planner(
  mode: PlannerMode,
  options: { allowSprint?: boolean } = {},
): Controller<C7State> {
  const allowSprint = options.allowSprint ?? true;
  let held = NONE;
  let heldAt = -1;
  return {
    decide(state, side): Buttons {
      if (state.tick % MOVE_EVERY !== 0 || heldAt === state.tick) {
        return held;
      }
      heldAt = state.tick;
      const me = simOf(state, side);
      const otherSide = side === 0 ? 1 : 0;
      const foods: Food[] = state.foods.map((f) => [cellX(f), cellY(f)] as Food);
      if (foods.length === 0) {
        held = NONE;
        return held;
      }
      const rivalSim = simOf(state, otherSide);
      const rivalAlive = state.snakes[otherSide].alive;
      const rival: Rival =
        mode === 'absent' || !rivalAlive
          ? { kind: 'absent' }
          : {
              kind: 'goes',
              sprintAt: rivalSim.cd === 0 && rivalSim.len >= SPRINT_MIN_LEN ? 0 : -1,
            };
      // 候選：目標由近到遠、不衝在前；嚴格比較才換（平手取近的目標、不衝）。
      const order = foods
        .map((_f, i) => i)
        .sort((i, j) => manhattan(me, foods[i] as Food) - manhattan(me, foods[j] as Food) || i - j);
      let best = { target: order[0] as number, sprintAt: -1 };
      let bestValue = Number.NEGATIVE_INFINITY;
      for (const target of order) {
        for (const sprintAt of allowSprint ? SPRINT_PLANS : [-1]) {
          const value = simulate({ ...me }, { ...rivalSim }, foods, target, sprintAt, rival);
          if (value > bestValue + 1e-9) {
            bestValue = value;
            best = { target, sprintAt };
          }
        }
      }
      // 走：往目標的貪心方向，避開牆與身體；要衝刺時兩格都要安全。
      const blocked = blockedCells(state);
      const food = foods[best.target] as Food;
      const head = state.snakes[side].body[0] as number;
      const hx = cellX(head);
      const hy = cellY(head);
      const dir = state.snakes[side].dir;
      const candidates = [dir, (dir + 1) % 4, (dir + 3) % 4]
        .map((d) => ({
          d,
          dist:
            Math.abs(hx + (DX[d] as number) - food[0]) + Math.abs(hy + (DY[d] as number) - food[1]),
        }))
        .sort((p, q) => p.dist - q.dist);
      const choice =
        candidates.find((c) => safe(blocked, hx + (DX[c.d] as number), hy + (DY[c.d] as number))) ??
        (candidates[0] as { d: number });
      const d = choice.d;
      const first = safe(blocked, hx + (DX[d] as number), hy + (DY[d] as number));
      const second = safe(blocked, hx + 2 * (DX[d] as number), hy + 2 * (DY[d] as number));
      const wantSprint =
        allowSprint &&
        best.sprintAt === 0 &&
        first &&
        second &&
        (state.sprintCd[side] as number) <= MOVE_EVERY &&
        state.snakes[side].body.length >= SPRINT_MIN_LEN;
      held = d === dir ? { ...NONE, a: wantSprint } : press(d, wantSprint);
      return held;
    },
  };
}

/** 均勻亂決定：每 6 個 tick 從「不按、四個方向」亂選一個，一半的機會同時按住 a。 */
export function uniform(seed: number, side: Side): Controller<C7State> {
  const rng = createRng(seed * 2 + side + 17);
  let held = NONE;
  return {
    decide(_state, _side, tick): Buttons {
      if (tick % MOVE_EVERY === 0) {
        const pick = rng.int(5);
        held = pick === 0 ? NONE : press(pick - 1, false);
        held = { ...held, a: rng.int(2) === 0 };
      }
      return held;
    },
  };
}

// ---------------------------------------------------------------------------
// 量測
// ---------------------------------------------------------------------------

export type EndReason = 'starved' | 'crashed' | 'time';

export interface Tracked {
  readonly ticks: number;
  readonly winner: Side | null;
  readonly length: readonly [number, number];
  readonly sprints: readonly [number, number];
  readonly reason: EndReason;
  /** 每邊「衝刺那一格，這一邊同時吃到食物」的次數；沒有吃到的衝刺就是空衝。 */
  readonly sprintEats: readonly [number, number];
  /** 20 秒（1200 tick）時的長度；局在 20 秒前就結束是 null。 */
  readonly lengthAt20: readonly [number, number] | null;
}

/** 玩一局，記下結束原因、衝刺次數、衝刺有沒有吃到。 */
export function playTracked(
  game: Game<C7State>,
  seed: number,
  maxTicks: number,
  c0: Controller<C7State>,
  c1: Controller<C7State>,
): Tracked {
  let state = game.init(seed, { maxTicks, params: {} });
  const sprintEats: [number, number] = [0, 0];
  let lengthAt20: readonly [number, number] | null = null;
  let tick = 0;
  while (!game.isOver(state)) {
    const a = c0.decide(state, 0, tick);
    const b = c1.decide(state, 1, tick);
    const before = state;
    state = game.step(state, [a, b]);
    tick += 1;
    for (const i of [0, 1] as const) {
      if (state.sprints[i] > before.sprints[i]) {
        // 衝刺花 2 格；長度變化比 −2 多（或食物落在這一步）就是吃到了。
        const grew = state.snakes[i].body.length - before.snakes[i].body.length;
        if (grew > -2) {
          sprintEats[i] += 1;
        }
      }
    }
    if (state.tick === 1200) {
      lengthAt20 = [state.snakes[0].score, state.snakes[1].score];
    }
  }
  const reason: EndReason =
    state.starved[0] || state.starved[1]
      ? 'starved'
      : !state.snakes[0].alive || !state.snakes[1].alive
        ? 'crashed'
        : 'time';
  return {
    ticks: state.tick,
    winner: state.winner,
    length: [state.snakes[0].score, state.snakes[1].score],
    sprints: [state.sprints[0], state.sprints[1]],
    reason,
    sprintEats,
    lengthAt20,
  };
}
