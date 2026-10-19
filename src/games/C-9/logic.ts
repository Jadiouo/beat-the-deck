import { intFrom, nextFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  HEIGHT,
  MOVE_EVERY,
  WIDTH,
  cell,
  cellX,
  cellY,
  winnerByScore,
} from '../_clubs/logic';
import type { ClubsState, Dir, Snake } from '../_clubs/logic';

/**
 * C-9 鑰匙與門（SPEC 第 9 節；小規格 `docs/cards/C-9.md`）。
 *
 * 一座隨機迷宮、一把鑰匙、一扇門：叼著鑰匙走進門的蛇得這一局 1 分；對手死了，活著的得 1 分；
 * 時間到沒人進門也沒人死是僵局，平手。一場四局：兩座迷宮各打兩次，第二次兩邊交換起點。
 * 格子、蛇每 6 個 tick 走一格、不能掉頭沿用梅花共同設定；沒有食物、蛇不長長。
 *
 * 規格沒寫、我補的規則（理由與量測見小規格「實作與量測」）：
 * - 轉向是「按了就記著，走到能轉的路口才轉」，前面是牆就自動沿著通道轉彎（`headingFor`）。
 *   1 格寬的迷宮裡幾乎每 2 格就要轉一次，原本「每個走格週期內鎖定一次」讓決定頻率低於走格頻率的 AI 全部撞牆。
 * - 鑰匙到兩個起點的距離差至少 `KEY_MIN_DIFF` 步（規格是「差最小」，差 0 就是同時抵達同一格、兩邊一起死）。
 * - 門前 6 步內沒有環的迷宮，在門附近打通一道牆補一個環（`withRingNear`）；補不出來就換一座迷宮。
 * - 規格的 `KEY_DELAY`（鑰匙持有者死亡後 2 秒才能再拿）不實作：持有者死亡這一局就結束，下一局鑰匙重置，延遲沒有可觀察的效果。
 * - 最短路表不放進 state，而是用 `WeakMap` 依迷宮物件記住（同一座迷宮只算一次），state 保持小而且可序列化。
 * - 鑰匙漂移（DESIGN-AI-FUN 10.19 的改法）做成選用的設定 `params.driftCells`／`params.driftEvery`，預設關閉；量測見小規格。
 *
 * AI 的 `evaluate`（`scoreMove`）：
 * - `gain`：鑰匙在地上時，離鑰匙比較近的（或對手不是在往鑰匙走的）去拿，gain ＝ −到鑰匙的步數；比較遠的去守門，
 *   gain ＝ `GUARD × (對手到門的步數 − 我到門的步數)`（夾在 ±`GUARD_CAP`）。叼著鑰匙的 gain ＝ −到門的步數；對手叼著鑰匙就守門。
 *   總分差只出現在 `100 × 差` 這一項（沒有領先者懲罰）。
 * - `danger`：對手的蛇頭下一格與我同一格 0.8；對手正在接近我的下一格時依距離 0.8／0.5／0.3。確定會死的（牆、蛇身、
 *   沒鑰匙進門、走進出不來的死路）不用 danger 表達，而是在 gain 扣 `DEATH_GAIN`（10.38、10.54）。
 * - 蛇頭在通道上時，下一格一定是節點，不用選；真正的決定是到節點之後走哪個出口，所以評估與 `actions` 往前多看一格
 *   （`scoreMove` 的 `pre`）：不管哪個 tick 決定，按的方向都在下一個節點生效，決定頻率低的 AI 也來得及。
 * - `actions` 的排序用同一個 `scoreMove` 的 gain，所以平手時搜尋型取到的第一個動作與 `evaluate` 的偏好一致（10.54）。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

export const MAZE_W = 16;
export const MAZE_H = 12;
export const BRAID = 0.12;
export const MIN_CYCLES = 10;
export const SNAKE_LEN = 4;
export const KEY_MIN_PATH = 35;
/** 鑰匙到兩個起點的最短路步數，差至少這麼多（差 0 是同時抵達）。 */
export const KEY_MIN_DIFF = 2;
export const START_GAP = 30;
export const START_MIN_STEPS = 12;
export const RING_RADIUS = 6;
export const ROUND_FREEZE = 30;
export const PAUSE = 40;
export const ROUNDS = 4;
/** 守位：離門比對手近一步的 gain，上限 `GUARD_CAP` 步。 */
export const GUARD = 15;
export const GUARD_CAP = 8;
/** 叼著鑰匙的下一步是門：這一步的 gain（比任何距離與守位都大）。 */
export const WIN_GAIN = 1000;
/**
 * 下一步確定會死（走進牆、蛇身、沒鑰匙進門、走進出不來的死路）的 gain 扣分。
 * 為什麼是 100 不是梅花共用的 10_000：搜尋型把 danger 乘上「這一層 gain 的範圍」的 2 倍，範圍裡只要有一個
 * 必死的節點，範圍就是扣分本身；10_000 會讓任何一點 danger（0.3）都壓過所有距離梯度（DESIGN-AI-FUN 10.54）。
 * 同一層的兄弟節點之間距離梯度最多約 30，所以 100 已經足夠讓必死永遠輸給任何活路。
 */
export const DEATH_GAIN = 100;
export const GAIN_PER_ROUND = 100;
export const RESULT_BONUS = 1_000_000;
/**
 * 靠近的 danger 把「對手舊位置到我的下一格的距離」減去這麼多再查表。
 * AI 看到的對手是 12 個 tick（2 次走格）以前的，所以理論上對手可能已經多走 2 步；但實測 2 讓兩邊都太謹慎
 * （搜尋型對打的僵局 27.8%，1 是 18.2%、0 是 18.0%，見小規格「實作與量測」），所以取 1。
 */
export const STALE_MOVES = 1;

export type RoundOutcome = 'side0' | 'side1' | 'draw' | 'stalemate';

export interface Layout {
  readonly walls: string;
  readonly key: number;
  readonly door: number;
  readonly starts: readonly [readonly number[], readonly number[]];
}

export interface C9State extends ClubsState {
  readonly round: 0 | 1 | 2 | 3;
  readonly roundTick: number;
  readonly roundTicks: number;
  readonly pause: number;
  readonly pauseTicks: number;
  readonly outcome: RoundOutcome | null;
  readonly layouts: readonly [Layout, Layout];
  readonly key: number;
  readonly keyHolder: Side | null;
  readonly keyTicks: readonly [number, number];
  readonly stalemates: number;
  /** 每條蛇記著的「想去的方向」（-1 沒有）：按了就記著，走到能轉的路口才轉。 */
  readonly wants: readonly [number, number];
  readonly driftCells: number;
  readonly driftEvery: number;
}

const DX: readonly number[] = [0, 1, 0, -1];
const DY: readonly number[] = [-1, 0, 1, 0];

function otherSide(side: Side): Side {
  return side === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 迷宮分析
// ---------------------------------------------------------------------------

interface MazeInfo {
  readonly open: Uint8Array;
  /** CELLS × 4：往 d 方向走一格的格子編號；牆或出界是 -1。 */
  readonly next: Int16Array;
  /** 反覆拿掉死胡同之後被拿掉的格子（走進去就出不來）。 */
  readonly fringe: Uint8Array;
  /** 從門到核心的那一條死胡同路徑（持鑰匙的人可以走）。 */
  readonly doorPath: Uint8Array;
  readonly dist: Map<number, Int16Array>;
}

function buildNext(open: Uint8Array): Int16Array {
  const next = new Int16Array(CELLS * 4).fill(-1);
  for (let c = 0; c < CELLS; c += 1) {
    if (open[c] === 0) {
      continue;
    }
    const x = cellX(c);
    const y = cellY(c);
    for (let d = 0; d < 4; d += 1) {
      const nx = x + (DX[d] as number);
      const ny = y + (DY[d] as number);
      if (nx >= 0 && nx < WIDTH && ny >= 0 && ny < HEIGHT && open[cell(nx, ny)] === 1) {
        next[c * 4 + d] = cell(nx, ny);
      }
    }
  }
  return next;
}

function bfs(next: Int16Array, from: number): Int16Array {
  const dist = new Int16Array(CELLS).fill(-1);
  const queue = new Int16Array(CELLS);
  let head = 0;
  let tail = 0;
  queue[tail] = from;
  tail += 1;
  dist[from] = 0;
  while (head < tail) {
    const c = queue[head] as number;
    head += 1;
    for (let d = 0; d < 4; d += 1) {
      const n = next[c * 4 + d] as number;
      if (n !== -1 && dist[n] === -1) {
        dist[n] = (dist[c] as number) + 1;
        queue[tail] = n;
        tail += 1;
      }
    }
  }
  return dist;
}

function fringeOf(open: Uint8Array, next: Int16Array): Uint8Array {
  const degree = new Int8Array(CELLS);
  const removed = new Uint8Array(CELLS);
  const queue: number[] = [];
  for (let c = 0; c < CELLS; c += 1) {
    if (open[c] === 1) {
      let n = 0;
      for (let d = 0; d < 4; d += 1) {
        if ((next[c * 4 + d] as number) !== -1) {
          n += 1;
        }
      }
      degree[c] = n;
      if (n <= 1) {
        queue.push(c);
        removed[c] = 1;
      }
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    const c = queue[i] as number;
    for (let d = 0; d < 4; d += 1) {
      const n = next[c * 4 + d] as number;
      if (n !== -1 && removed[n] === 0) {
        degree[n] = (degree[n] as number) - 1;
        if ((degree[n] as number) <= 1) {
          removed[n] = 1;
          queue.push(n);
        }
      }
    }
  }
  return removed;
}

function doorPathOf(
  open: Uint8Array,
  next: Int16Array,
  fringe: Uint8Array,
  door: number,
): Uint8Array {
  const path = new Uint8Array(CELLS);
  // 從核心（開著、不在 fringe 的格子）一路向外的距離
  const dist = new Int16Array(CELLS).fill(-1);
  const queue: number[] = [];
  for (let c = 0; c < CELLS; c += 1) {
    if (open[c] === 1 && fringe[c] === 0) {
      dist[c] = 0;
      queue.push(c);
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    const c = queue[i] as number;
    for (let d = 0; d < 4; d += 1) {
      const n = next[c * 4 + d] as number;
      if (n !== -1 && dist[n] === -1) {
        dist[n] = (dist[c] as number) + 1;
        queue.push(n);
      }
    }
  }
  let cursor = door;
  path[cursor] = 1;
  while (fringe[cursor] === 1 && (dist[cursor] as number) > 0) {
    let step = -1;
    for (let d = 0; d < 4; d += 1) {
      const n = next[cursor * 4 + d] as number;
      if (n !== -1 && (dist[n] as number) === (dist[cursor] as number) - 1) {
        step = n;
        break;
      }
    }
    if (step === -1) {
      break;
    }
    cursor = step;
    path[cursor] = 1;
  }
  return path;
}

function wallsToOpen(walls: string): Uint8Array {
  const open = new Uint8Array(CELLS);
  for (let c = 0; c < CELLS; c += 1) {
    open[c] = walls.charCodeAt(c) === 46 ? 1 : 0;
  }
  return open;
}

function openToWalls(open: Uint8Array): string {
  let text = '';
  for (let c = 0; c < CELLS; c += 1) {
    text += open[c] === 1 ? '.' : '#';
  }
  return text;
}

const INFO = new WeakMap<object, MazeInfo>();

function infoOf(layout: Layout): MazeInfo {
  const cached = INFO.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  const open = wallsToOpen(layout.walls);
  const next = buildNext(open);
  const fringe = fringeOf(open, next);
  const info: MazeInfo = {
    open,
    next,
    fringe,
    doorPath: doorPathOf(open, next, fringe, layout.door),
    dist: new Map(),
  };
  INFO.set(layout, info);
  return info;
}

const DIST_CACHE_CAP = 96;

/** 從 `from` 出發的最短路步數表（只看牆，不看蛇身）；同一座迷宮、同一個起點只算一次。 */
function distFrom(info: MazeInfo, from: number): Int16Array {
  const hit = info.dist.get(from);
  if (hit !== undefined) {
    return hit;
  }
  if (info.dist.size >= DIST_CACHE_CAP) {
    info.dist.clear();
  }
  const table = bfs(info.next, from);
  info.dist.set(from, table);
  return table;
}

// ---------------------------------------------------------------------------
// 迷宮生成
// ---------------------------------------------------------------------------

function nodeCell(i: number, j: number): number {
  return cell(2 * i, 2 * j);
}

function carve(rng0: RngState): { open: Uint8Array; rng: RngState } {
  let rng = rng0;
  const open = new Uint8Array(CELLS);
  for (let j = 0; j < MAZE_H; j += 1) {
    for (let i = 0; i < MAZE_W; i += 1) {
      open[nodeCell(i, j)] = 1;
    }
  }
  const seen = new Uint8Array(MAZE_W * MAZE_H);
  const stack: number[] = [0];
  seen[0] = 1;
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as number;
    const i = top % MAZE_W;
    const j = Math.floor(top / MAZE_W);
    const options: number[] = [];
    for (let d = 0; d < 4; d += 1) {
      const ni = i + (DX[d] as number);
      const nj = j + (DY[d] as number);
      if (ni >= 0 && ni < MAZE_W && nj >= 0 && nj < MAZE_H && seen[nj * MAZE_W + ni] === 0) {
        options.push(d);
      }
    }
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const [pick, following] = intFrom(rng, options.length);
    rng = following;
    const d = options[pick] as number;
    const ni = i + (DX[d] as number);
    const nj = j + (DY[d] as number);
    open[cell(2 * i + (DX[d] as number), 2 * j + (DY[d] as number))] = 1;
    seen[nj * MAZE_W + ni] = 1;
    stack.push(nj * MAZE_W + ni);
  }
  // 打通額外的牆
  const closed: number[] = [];
  for (let j = 0; j < MAZE_H; j += 1) {
    for (let i = 0; i < MAZE_W; i += 1) {
      for (const d of [1, 2]) {
        const ni = i + (DX[d] as number);
        const nj = j + (DY[d] as number);
        if (ni < MAZE_W && nj < MAZE_H) {
          const between = cell(2 * i + (DX[d] as number), 2 * j + (DY[d] as number));
          if (open[between] === 0) {
            closed.push(between);
          }
        }
      }
    }
  }
  let opened = 0;
  const left: number[] = [];
  for (const between of closed) {
    const [roll, following] = nextFrom(rng);
    rng = following;
    if (roll < BRAID) {
      open[between] = 1;
      opened += 1;
    } else {
      left.push(between);
    }
  }
  while (opened < MIN_CYCLES && left.length > 0) {
    const [pick, following] = intFrom(rng, left.length);
    rng = following;
    open[left[pick] as number] = 1;
    left.splice(pick, 1);
    opened += 1;
  }
  return { open, rng };
}

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

function openNeighbors(next: Int16Array, c: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < 4; d += 1) {
    const n = next[c * 4 + d] as number;
    if (n !== -1) {
      out.push(n);
    }
  }
  return out;
}

function hasRingNear(next: Int16Array, door: number, radius: number): boolean {
  const dist = bfs(next, door);
  let cells = 0;
  let edges = 0;
  for (let c = 0; c < CELLS; c += 1) {
    const dc = dist[c] as number;
    if (dc >= 0 && dc <= radius) {
      cells += 1;
      for (const n of openNeighbors(next, c)) {
        const dn = dist[n] as number;
        if (dn >= 0 && dn <= radius && n > c) {
          edges += 1;
        }
      }
    }
  }
  return edges >= cells;
}

function bodyAt(
  next: Int16Array,
  fringe: Uint8Array,
  head: number,
  forbid: readonly number[],
): number[] | null {
  const path = [head];
  const extend = (): boolean => {
    if (path.length === SNAKE_LEN) {
      return true;
    }
    const last = path[path.length - 1] as number;
    for (let d = 0; d < 4; d += 1) {
      const n = next[last * 4 + d] as number;
      if (n === -1 || fringe[n] === 1 || path.includes(n) || forbid.includes(n)) {
        continue;
      }
      path.push(n);
      if (extend()) {
        return true;
      }
      path.pop();
    }
    return false;
  };
  return extend() ? path : null;
}

/**
 * 門前 6 步內要有環（小規格：沒有環就守不了門）。這座迷宮的門前沒有環時，在門附近打通一道牆：
 * 找兩個相鄰的節點（離門 2 到 6 步、不含門本身），把它們之間的牆打通，兩個節點本來就在門的 6 步範圍裡互相連通，
 * 所以打通之後範圍內多了一個環。多個選擇時取離門最近的；門本身還是只有一條通道。
 * 回傳新的 open（原本就有環時就是原來那一個），打不出環回傳 null。
 */
function withRingNear(open: Uint8Array, door: number): Uint8Array | null {
  const next = buildNext(open);
  if (hasRingNear(next, door, RING_RADIUS)) {
    return open;
  }
  const dist = bfs(next, door);
  let best = -1;
  let bestReach = Number.POSITIVE_INFINITY;
  for (let j = 0; j < MAZE_H; j += 1) {
    for (let i = 0; i < MAZE_W; i += 1) {
      for (const d of [1, 2]) {
        const ni = i + (DX[d] as number);
        const nj = j + (DY[d] as number);
        if (ni >= MAZE_W || nj >= MAZE_H) {
          continue;
        }
        const u = nodeCell(i, j);
        const v = nodeCell(ni, nj);
        const between = cell(2 * i + (DX[d] as number), 2 * j + (DY[d] as number));
        if (open[between] === 1 || u === door || v === door) {
          continue;
        }
        const du = dist[u] as number;
        const dv = dist[v] as number;
        if (du < 0 || dv < 0 || du > RING_RADIUS || dv > RING_RADIUS) {
          continue;
        }
        const reach = Math.max(du, dv);
        if (reach < bestReach) {
          bestReach = reach;
          best = between;
        }
      }
    }
  }
  if (best === -1) {
    return null;
  }
  const carved = new Uint8Array(open);
  carved[best] = 1;
  return hasRingNear(buildNext(carved), door, RING_RADIUS) ? carved : null;
}

function chooseLayout(open0: Uint8Array, rng0: RngState, relaxedOnly: boolean): Layout | null {
  let rng = rng0;
  const next0 = buildNext(open0);
  const fringe0 = fringeOf(open0, next0);
  const coreNodes: number[] = [];
  const deadEnds: number[] = [];
  for (let j = 0; j < MAZE_H; j += 1) {
    for (let i = 0; i < MAZE_W; i += 1) {
      const c = nodeCell(i, j);
      if (fringe0[c] === 0) {
        coreNodes.push(c);
      }
      if (openNeighbors(next0, c).length === 1) {
        deadEnds.push(c);
      }
    }
  }
  // 每個候選的門各自的迷宮（門前保證有環）；不隨起點變，所以只算一次
  const mazes = new Map<number, { open: Uint8Array; next: Int16Array } | null>();
  const mazeFor = (door: number): { open: Uint8Array; next: Int16Array } | null => {
    let entry = mazes.get(door);
    if (entry === undefined) {
      const carved = withRingNear(open0, door);
      entry = carved === null ? null : { open: carved, next: buildNext(carved) };
      mazes.set(door, entry);
    }
    return entry;
  };

  if (!deadEnds.some((door) => mazeFor(door) !== null)) {
    return null; // 每個死胡同的門前都打不出環：換一座迷宮
  }

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const relaxed = relaxedOnly;
    const gap = relaxed ? START_GAP - 10 : START_GAP;
    const minSteps = relaxed ? 6 : START_MIN_STEPS;
    const minKey = relaxed ? 20 : KEY_MIN_PATH;
    let pick: number;
    [pick, rng] = intFrom(rng, coreNodes.length);
    const s0 = coreNodes[pick] as number;
    const far = coreNodes.filter((c) => manhattan(c, s0) >= gap);
    if (far.length === 0) {
      continue;
    }
    [pick, rng] = intFrom(rng, far.length);
    const s1 = far[pick] as number;

    // 門：死胡同、離兩個起點的最短路步數之差最小
    let bestDoors: number[] = [];
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const door of deadEnds) {
      const maze = mazeFor(door);
      if (maze === null) {
        continue;
      }
      const d0 = bfs(maze.next, s0);
      const d1 = bfs(maze.next, s1);
      if ((d0[door] as number) < minSteps || (d1[door] as number) < minSteps) {
        continue;
      }
      const diff = Math.abs((d0[door] as number) - (d1[door] as number));
      if (diff < bestDiff) {
        bestDiff = diff;
        bestDoors = [door];
      } else if (diff === bestDiff) {
        bestDoors.push(door);
      }
    }
    if (bestDoors.length === 0) {
      continue;
    }
    [pick, rng] = intFrom(rng, bestDoors.length);
    const door = bestDoors[pick] as number;
    const maze = mazeFor(door) as { open: Uint8Array; next: Int16Array };
    const next = maze.next;
    const fringe = fringeOf(maze.open, next);
    const d0 = bfs(next, s0);
    const d1 = bfs(next, s1);
    const dd = bfs(next, door);

    // 鑰匙：核心（不在死胡同支路）、離門至少 minKey 步、離兩個起點的步數之差最小（至少 KEY_MIN_DIFF）
    let bestKeys: number[] = [];
    let bestKeyDiff = Number.POSITIVE_INFINITY;
    for (const k of coreNodes) {
      if (
        fringe[k] === 1 ||
        (dd[k] as number) < minKey ||
        (d0[k] as number) < minSteps ||
        (d1[k] as number) < minSteps
      ) {
        continue;
      }
      const diff = Math.abs((d0[k] as number) - (d1[k] as number));
      if (!relaxed && diff < KEY_MIN_DIFF) {
        continue;
      }
      if (diff < bestKeyDiff) {
        bestKeyDiff = diff;
        bestKeys = [k];
      } else if (diff === bestKeyDiff) {
        bestKeys.push(k);
      }
    }
    if (bestKeys.length === 0) {
      continue;
    }
    [pick, rng] = intFrom(rng, bestKeys.length);
    const key = bestKeys[pick] as number;

    const b0 = bodyAt(next, fringe, s0, []);
    const b1 = bodyAt(next, fringe, s1, b0 ?? []);
    if (b0 === null || b1 === null) {
      continue;
    }
    return { walls: openToWalls(maze.open), key, door, starts: [b0, b1] };
  }
  return null;
}

/** 迷宮生成最多換幾座候選迷宮（門前打不出環、或找不到合格的門與鑰匙時換一座）。 */
const MAZE_TRIES = 12;

export function buildLayout(seed: number, index: 0 | 1): Layout {
  for (const relaxedOnly of [false, true]) {
    for (let attempt = 0; attempt < MAZE_TRIES; attempt += 1) {
      const label = attempt === 0 ? `maze-${index}` : `maze-${index}-${attempt}`;
      const carved = carve(rngStateFor(seed, label));
      const layout = chooseLayout(carved.open, carved.rng, relaxedOnly);
      if (layout !== null) {
        return layout;
      }
    }
  }
  throw new Error('C-9：產生不出合格的迷宮');
}

// ---------------------------------------------------------------------------
// 局的開頭
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 轉向：按了就記著，走到能轉的路口才轉；前面是牆就自動沿著通道轉彎
// ---------------------------------------------------------------------------

function opposite(dir: number): number {
  return (dir + 2) % 4;
}

/** 這個 tick 的按鍵對「想去的方向」的影響：按了另一個有效方向就記著；按原本的前進方向是取消；沒按不變。 */
function wantAfter(dir: number, want: number, buttons: Buttons): number {
  const pressed = [buttons.up, buttons.right, buttons.down, buttons.left];
  for (let d = 0; d < 4; d += 1) {
    if (pressed[d] === true && d !== dir && d !== opposite(dir)) {
      return d;
    }
  }
  return pressed[dir] === true ? -1 : want;
}

/** 下一次走格要走的方向：想去的方向走得通就去；否則直走；直走是牆就轉進唯一（或順時針那一個）出口。 */
function headingFor(info: MazeInfo, head: number, dir: number, want: number): Dir {
  if (want !== -1 && want !== opposite(dir) && (info.next[head * 4 + want] as number) !== -1) {
    return want as Dir;
  }
  if ((info.next[head * 4 + dir] as number) !== -1) {
    return dir as Dir;
  }
  const cw = (dir + 1) % 4;
  if ((info.next[head * 4 + cw] as number) !== -1) {
    return cw as Dir;
  }
  const ccw = (dir + 3) % 4;
  return ((info.next[head * 4 + ccw] as number) !== -1 ? ccw : dir) as Dir;
}

function dirBetween(from: number, to: number): Dir {
  const dx = cellX(to) - cellX(from);
  const dy = cellY(to) - cellY(from);
  if (dx === 1) return 1;
  if (dx === -1) return 3;
  return dy === 1 ? 2 : 0;
}

function freshSnake(body: readonly number[], score: number): Snake {
  const dir = dirBetween(body[1] as number, body[0] as number);
  return { body, dir, turn: dir, alive: true, score };
}

export function roundTicksFor(maxTicks: number): number {
  return Math.floor((maxTicks - (ROUNDS - 1) * PAUSE - ROUNDS * ROUND_FREEZE) / ROUNDS);
}

function startRound(state: C9State, round: 0 | 1 | 2 | 3): C9State {
  const layout = state.layouts[round >> 1] as Layout;
  const swapped = (round & 1) === 1;
  const a = layout.starts[swapped ? 1 : 0];
  const b = layout.starts[swapped ? 0 : 1];
  const info = infoOf(layout);
  const resolve = (snake: Snake): Snake => ({
    ...snake,
    turn: headingFor(info, snake.body[0] as number, snake.dir, -1),
  });
  return {
    ...state,
    round,
    roundTick: -ROUND_FREEZE,
    pause: 0,
    outcome: null,
    key: layout.key,
    keyHolder: null,
    keyTicks: [-1, -1],
    wants: [-1, -1],
    snakes: [
      resolve(freshSnake(a, state.snakes[0].score)),
      resolve(freshSnake(b, state.snakes[1].score)),
    ],
  };
}

export function initC9State(seed: number, config: GameConfig): C9State {
  if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks < 400) {
    throw new RangeError(`config.maxTicks 必須是 400 以上的整數，收到 ${String(config.maxTicks)}`);
  }
  const layouts: readonly [Layout, Layout] = [buildLayout(seed, 0), buildLayout(seed, 1)];
  const blank: C9State = {
    tick: 0,
    maxTicks: config.maxTicks,
    snakes: [freshSnake(layouts[0].starts[0], 0), freshSnake(layouts[0].starts[1], 0)],
    foods: [],
    rng: rngStateFor(seed, 'maze'),
    over: false,
    winner: null,
    round: 0,
    roundTick: -ROUND_FREEZE,
    roundTicks: roundTicksFor(config.maxTicks),
    pause: 0,
    pauseTicks: PAUSE,
    outcome: null,
    layouts,
    key: layouts[0].key,
    keyHolder: null,
    keyTicks: [-1, -1],
    stalemates: 0,
    wants: [-1, -1],
    driftCells: config.params.driftCells ?? 0,
    driftEvery: config.params.driftEvery ?? 300,
  };
  return startRound(blank, 0);
}

// ---------------------------------------------------------------------------
// 一個 tick
// ---------------------------------------------------------------------------

function layoutOf(state: C9State): Layout {
  return state.layouts[state.round >> 1] as Layout;
}

function driftKey(info: MazeInfo, layout: Layout, key: number, cells: number): number {
  const toDoor = distFrom(info, layout.door);
  let cursor = key;
  for (let n = 0; n < cells; n += 1) {
    let step = -1;
    for (let d = 0; d < 4; d += 1) {
      const c = info.next[cursor * 4 + d] as number;
      if (c !== -1 && (toDoor[c] as number) < (toDoor[cursor] as number)) {
        step = c;
        break;
      }
    }
    if (step === -1 || (info.fringe[step] as number) === 1) {
      break;
    }
    cursor = step;
  }
  return cursor;
}

function advance(state: C9State, inputs: Inputs): C9State {
  const tick = state.tick + 1;

  if (state.pause > 0) {
    const pause = state.pause - 1;
    return pause > 0
      ? { ...state, tick, pause }
      : startRound({ ...state, tick, pause: 0 }, (state.round + 1) as 1 | 2 | 3);
  }

  const roundTick = state.roundTick + 1;
  const layout = layoutOf(state);
  const info = infoOf(layout);
  const wants: [number, number] = [state.wants[0], state.wants[1]];
  let snakes: readonly [Snake, Snake] = ([0, 1] as const).map((i): Snake => {
    const snake = state.snakes[i];
    if (!snake.alive) {
      return snake;
    }
    wants[i] = wantAfter(snake.dir, wants[i], inputs[i]);
    const turn = headingFor(info, snake.body[0] as number, snake.dir, wants[i]);
    return turn === snake.turn ? snake : { ...snake, turn };
  }) as [Snake, Snake];
  let key = state.key;
  let holder = state.keyHolder;
  let keyTicks = state.keyTicks;
  let outcome: RoundOutcome | null = null;

  if (
    state.driftCells > 0 &&
    holder === null &&
    roundTick > 0 &&
    roundTick % state.driftEvery === 0
  ) {
    key = driftKey(info, layout, key, state.driftCells);
    for (const i of [0, 1] as const) {
      if (key === (snakes[i].body[0] as number) && holder === null) {
        holder = i;
        keyTicks = i === 0 ? [roundTick, keyTicks[1]] : [keyTicks[0], roundTick];
      }
    }
  }

  if (roundTick > 0 && roundTick % MOVE_EVERY === 0) {
    const heads: [number, number] = [-1, -1];
    for (const i of [0, 1] as const) {
      heads[i] = info.next[(snakes[i].body[0] as number) * 4 + snakes[i].turn] as number;
    }
    const occupies = (i: 0 | 1, target: number): boolean => {
      const body = snakes[i].body;
      const at = body.indexOf(target);
      return at !== -1 && at !== body.length - 1;
    };
    const dead: [boolean, boolean] = [false, false];
    for (const i of [0, 1] as const) {
      const h = heads[i];
      dead[i] =
        h === -1 ||
        (h === layout.door && holder !== i) ||
        occupies(0, h) ||
        occupies(1, h) ||
        heads[0] === heads[1];
    }
    snakes = ([0, 1] as const).map((i): Snake => {
      const snake = snakes[i];
      if (dead[i]) {
        return { ...snake, alive: false };
      }
      if (wants[i] === snake.turn) {
        wants[i] = -1;
      }
      const moved = [heads[i], ...snake.body.slice(0, -1)];
      const turn = headingFor(info, heads[i], snake.turn, wants[i]);
      return { ...snake, body: moved, dir: snake.turn, turn };
    }) as [Snake, Snake];
    if (dead[0] && dead[1]) {
      outcome = 'draw';
    } else if (dead[0] || dead[1]) {
      outcome = dead[0] ? 'side1' : 'side0';
    } else {
      for (const i of [0, 1] as const) {
        if (holder === null && heads[i] === key) {
          holder = i;
          keyTicks = i === 0 ? [roundTick, keyTicks[1]] : [keyTicks[0], roundTick];
        } else if (holder === i && heads[i] === layout.door) {
          outcome = i === 0 ? 'side0' : 'side1';
        }
      }
    }
  }
  if (outcome === null && roundTick >= state.roundTicks) {
    outcome = 'stalemate';
  }

  if (outcome === null) {
    return { ...state, tick, roundTick, snakes, key, keyHolder: holder, keyTicks, wants };
  }

  const scored: readonly [Snake, Snake] = [
    outcome === 'side0' ? { ...snakes[0], score: snakes[0].score + 1 } : snakes[0],
    outcome === 'side1' ? { ...snakes[1], score: snakes[1].score + 1 } : snakes[1],
  ];
  const ended: C9State = {
    ...state,
    tick,
    roundTick,
    snakes: scored,
    key,
    keyHolder: holder,
    keyTicks,
    wants,
    outcome,
    stalemates: state.stalemates + (outcome === 'stalemate' ? 1 : 0),
  };
  if (state.round === ROUNDS - 1) {
    return { ...ended, over: true, winner: winnerByScore(scored) };
  }
  return { ...ended, pause: state.pauseTicks };
}

export function stepC9(state: C9State, inputs: Inputs): C9State {
  if (state.over) {
    return state;
  }
  const next = advance(state, inputs);
  if (next.tick >= next.maxTicks && !next.over) {
    return { ...next, over: true, winner: winnerByScore(next.snakes) };
  }
  return next;
}

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const NONE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});
const FROZEN_ACTIONS: readonly Buttons[] = Object.freeze([NONE]);

function press(dir: Dir): Buttons {
  return Object.freeze({
    ...NONE,
    up: dir === 0,
    right: dir === 1,
    down: dir === 2,
    left: dir === 3,
  });
}
const PRESS: readonly Buttons[] = [press(0), press(1), press(2), press(3)];

function frozen(state: C9State): boolean {
  return state.over || state.pause > 0 || state.outcome !== null;
}

interface Scored {
  gain: number;
  danger: number;
  lethal: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function isNodeCell(c: number): boolean {
  return cellX(c) % 2 === 0 && cellY(c) % 2 === 0;
}

/**
 * 這一邊往 `dir` 走下一格的評分。
 *
 * 蛇頭在節點上（(偶, 偶) 的格子）時，下一格是通道，要選的是現在往哪個方向走：評分看下一格。
 * 蛇頭在通道上時，下一格一定是節點、而且不用選；真正的決定是到了節點之後走哪一個出口，所以往前多看一格：
 * 評分看「下一次走格之後再走一格」的格子（`pre` 是在那個節點要走的出口；沒給就是按已經記著的方向決定的結果）。
 * 這讓決定頻率低的 AI 也來得及：不管哪個 tick 決定，按的方向都會在下一個節點生效。
 */
function scoreMove(state: C9State, side: Side, dir: Dir, pre: number = -1): Scored {
  const layout = layoutOf(state);
  const info = infoOf(layout);
  const me = state.snakes[side];
  const opp = state.snakes[otherSide(side)];
  const lead = GAIN_PER_ROUND * (me.score - opp.score);
  const head = me.body[0] as number;
  const first = info.next[head * 4 + dir] as number;
  const holder = state.keyHolder;
  const lethal: Scored = { gain: lead - DEATH_GAIN, danger: 1, lethal: true };

  const occupied = (cellIndex: number, trimmed: number): boolean => {
    for (const snake of state.snakes) {
      const last = snake.alive ? snake.body.length - trimmed : snake.body.length;
      for (let i = 0; i < last; i += 1) {
        if (snake.body[i] === cellIndex) {
          return true;
        }
      }
    }
    return false;
  };
  const blocked = (cellIndex: number, holds: boolean, trimmed: number): boolean =>
    (info.fringe[cellIndex] === 1 && !(holds && info.doorPath[cellIndex] === 1)) ||
    occupied(cellIndex, trimmed);

  if (first === -1) {
    return lethal;
  }
  let holds = holder === side;
  if (first === layout.door) {
    return holds ? { gain: lead + GAIN_PER_ROUND + WIN_GAIN, danger: 0, lethal: false } : lethal;
  }
  if (blocked(first, holds, 1)) {
    return lethal;
  }

  let target = first;
  if (!isNodeCell(head)) {
    holds = holds || (holder === null && first === state.key);
    const exit = pre !== -1 ? pre : headingFor(info, first, dir, state.wants[side] as number);
    const second = info.next[first * 4 + exit] as number;
    if (second === -1) {
      return lethal;
    }
    if (second === layout.door) {
      return holds ? { gain: lead + GAIN_PER_ROUND + WIN_GAIN, danger: 0, lethal: false } : lethal;
    }
    if (blocked(second, holds, 2)) {
      return lethal;
    }
    target = second;
  }

  const oppHead = opp.body[0] as number;
  let oppNext = oppHead;
  if (opp.alive) {
    const n = info.next[oppHead * 4 + opp.turn] as number;
    if (n !== -1) {
      oppNext = n;
    }
  }
  const toDoor = distFrom(info, layout.door);
  const md = toDoor[target] as number;
  const od = toDoor[oppNext] as number;
  let gain = lead;
  if (holder === null && !holds) {
    // 鑰匙還在地上：離鑰匙比較近的去拿（對手不是在往鑰匙走也算我近），比較遠的去守門
    const toKey = distFrom(info, state.key);
    const oppApproaching = (toKey[oppNext] as number) < (toKey[oppHead] as number);
    if ((toKey[head] as number) <= (toKey[oppHead] as number) || !oppApproaching) {
      gain -= toKey[target] as number;
    } else {
      gain += GUARD * clamp(od - md, -GUARD_CAP, GUARD_CAP);
    }
  } else if (holds) {
    gain -= md;
  } else {
    gain += GUARD * clamp(od - md, -GUARD_CAP, GUARD_CAP);
  }

  let danger = 0;
  if (opp.alive) {
    const fromOpp = distFrom(info, oppHead);
    const here = fromOpp[head] as number;
    const there = fromOpp[first] as number;
    if (oppNext === first) {
      danger = 0.8;
    } else if (there < here) {
      const gap = there - STALE_MOVES;
      danger = gap <= 1 ? 0.8 : gap === 2 ? 0.5 : gap === 3 ? 0.3 : 0;
    }
  }
  return { gain, danger, lethal: false };
}

/**
 * 這一邊可以選的方向，由好到壞（含確定會死的，排在最後）；平手順時針在前。
 * 蛇頭在節點上：順時針、逆時針、直走三個出口。蛇頭在通道上：到下一個節點要走的三個出口（先按，到了節點生效）。
 */
function rankMoves(state: C9State, side: Side): { dir: Dir; scored: Scored }[] {
  const me = state.snakes[side];
  const info = infoOf(layoutOf(state));
  const head = me.body[0] as number;
  const ranked: { dir: Dir; scored: Scored }[] = [];
  const options = [(me.dir + 1) % 4, (me.dir + 3) % 4, me.dir] as Dir[];
  if (isNodeCell(head)) {
    for (const dir of options) {
      if ((info.next[head * 4 + dir] as number) !== -1) {
        ranked.push({ dir, scored: scoreMove(state, side, dir) });
      }
    }
  } else {
    const first = info.next[head * 4 + me.dir] as number;
    if (first !== -1) {
      for (const exit of options) {
        if ((info.next[first * 4 + exit] as number) !== -1) {
          ranked.push({ dir: exit, scored: scoreMove(state, side, me.dir, exit) });
        }
      }
    }
  }
  ranked.sort((x, y) => y.scored.gain - x.scored.gain);
  return ranked;
}

function evaluateEnded(state: C9State, side: Side): { gain: number; danger: number } {
  const me = state.snakes[side];
  const lead = GAIN_PER_ROUND * (me.score - state.snakes[otherSide(side)].score);
  const bonus =
    state.over && state.winner !== null
      ? state.winner === side
        ? RESULT_BONUS
        : -RESULT_BONUS
      : 0;
  return { gain: lead + bonus, danger: me.alive ? 0 : 1 };
}

export const c9Game: Game<C9State> = {
  id: 'C-9',

  init(seed: number, config: GameConfig): C9State {
    return initC9State(seed, config);
  },

  step(state: C9State, inputs: Inputs): C9State {
    return stepC9(state, inputs);
  },

  isOver(state: C9State): boolean {
    return state.over;
  },

  score(state: C9State): readonly [number, number] {
    return [state.snakes[0].score, state.snakes[1].score];
  },

  winner(state: C9State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: C9State, side: Side): readonly Buttons[] {
    const me = state.snakes[side];
    if (frozen(state) || !me.alive) {
      return FROZEN_ACTIONS;
    }
    const ranked = rankMoves(state, side);
    if (ranked.length > 0) {
      return ranked.map((entry) => PRESS[entry.dir] as Buttons);
    }
    const info = infoOf(layoutOf(state));
    const open = [(me.dir + 1) % 4, (me.dir + 3) % 4, me.dir]
      .filter((d) => (info.next[(me.body[0] as number) * 4 + d] as number) !== -1)
      .map((d) => PRESS[d] as Buttons);
    return open.length > 0 ? open : FROZEN_ACTIONS;
  },

  evaluate(state: C9State, side: Side): { gain: number; danger: number } {
    const me = state.snakes[side];
    if (frozen(state) || !me.alive) {
      return evaluateEnded(state, side);
    }
    const s = scoreMove(state, side, me.turn);
    return { gain: s.gain, danger: s.danger };
  },
};

// ---------------------------------------------------------------------------
// 測試與量測用
// ---------------------------------------------------------------------------

export { infoOf as mazeInfo, distFrom, layoutOf };
export type { MazeInfo };

export interface C9Overrides {
  /** 兩座迷宮都用這一個；沒給就是種子 0 的第一座。 */
  readonly layout?: Layout;
  readonly round?: 0 | 1 | 2 | 3;
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly roundTick?: number;
  readonly pause?: number;
  readonly outcome?: RoundOutcome | null;
  /** 兩條蛇各自要覆蓋的欄位；沒給的欄位用這一局的起點，`dir` 沒給就由身體推出，`turn` 沒給就是自動轉向的結果。 */
  readonly snakes?: readonly [Partial<Snake>?, Partial<Snake>?];
  readonly key?: number;
  readonly keyHolder?: Side | null;
  readonly wants?: readonly [number, number];
  readonly stalemates?: number;
  readonly driftCells?: number;
  readonly driftEvery?: number;
  readonly over?: boolean;
  readonly winner?: Side | null;
}

/** 直接構造一個局面（預設：種子 0 的第一座迷宮、第一局、已過開局不動時間）。 */
export function makeState(overrides: C9Overrides = {}): C9State {
  const layout = overrides.layout ?? buildLayout(0, 0);
  const maxTicks = overrides.maxTicks ?? 3600;
  const round = overrides.round ?? 0;
  const base = startRound(
    {
      tick: 0,
      maxTicks,
      snakes: [freshSnake(layout.starts[0], 0), freshSnake(layout.starts[1], 0)],
      foods: [],
      rng: rngStateFor(0, 'maze'),
      over: false,
      winner: null,
      round: 0,
      roundTick: -ROUND_FREEZE,
      roundTicks: roundTicksFor(maxTicks),
      pause: 0,
      pauseTicks: PAUSE,
      outcome: null,
      layouts: [layout, layout],
      key: layout.key,
      keyHolder: null,
      keyTicks: [-1, -1],
      stalemates: 0,
      wants: [-1, -1],
      driftCells: overrides.driftCells ?? 0,
      driftEvery: overrides.driftEvery ?? 300,
    },
    round,
  );
  const info = infoOf(layout);
  const wants = overrides.wants ?? base.wants;
  const pick = (i: 0 | 1): Snake => {
    const patch = overrides.snakes?.[i] ?? {};
    const body = patch.body ?? base.snakes[i].body;
    const dir =
      patch.dir ??
      (patch.body !== undefined
        ? dirBetween(body[1] as number, body[0] as number)
        : base.snakes[i].dir);
    const turn = patch.turn ?? headingFor(info, body[0] as number, dir, wants[i] as number);
    return { ...base.snakes[i], ...patch, body, dir, turn };
  };
  return {
    ...base,
    tick: overrides.tick ?? 0,
    roundTick: overrides.roundTick ?? 0,
    pause: overrides.pause ?? 0,
    outcome: overrides.outcome ?? null,
    snakes: [pick(0), pick(1)],
    key: overrides.key ?? base.key,
    keyHolder: overrides.keyHolder ?? null,
    wants,
    stalemates: overrides.stalemates ?? 0,
    over: overrides.over ?? false,
    winner: overrides.winner ?? null,
  };
}
