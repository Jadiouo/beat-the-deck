import { levelController, policyByName } from '../../ai/level';
import type { PolicyKey } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, GameConfig, Side } from '../../core/types';
import { outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { IsPoint, MatchOutcome, ProbeSpec } from '../../../tests/ai/probe-a.shared';
import {
  CELLS,
  HEIGHT,
  MOVE_EVERY,
  WIDTH,
  bfsDistances,
  cellX,
  cellY,
  stepTarget,
} from '../_diamonds/logic';
import type { Dir } from '../_diamonds/logic';
import { PROTECT_TICKS, d8Game } from './logic';
import type { D8State } from './logic';

/**
 * D-8 探針 A（完整版）的量測工具（`docs/cards/D-8.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61）。
 * 只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。**(b)、(c) 兩族與選法在量之前寫進小規格並 push，量完不改。**
 *
 * 所有成員共用同一套走路：選一個「目標格」，沿繞牆最短路走過去（同樣近的方向優先沿著上一次走的方向直走；
 * 不能直接掉頭的規則由遊戲處理，目標在背後時按反方向會停一拍）。差別只在**怎麼選目標格**：
 * - (b) 族：知道有對手（對手塗過的格子也要塗回來、自己的格子會被塗掉），但**不讀對手的任何狀態**：
 *   只准讀牆、自己的位置與方向、「這格是不是我的」（我的顏色／不是我的），不分辨「不是我的」是沒人塗過還是對手的，
 *   也不讀對手的位置、方向、保護期。
 * - (c) 族：讀對手的公開狀態（位置、待走方向、格子是誰的、保護期）。**沒有 import `evaluate`、`predictOpponent`，
 *   也沒有拿 AI 的控制器當成員。**
 */

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };
/** AI 的種子 ＝ 玩家種子 ＋ 這個數（慣例同 D-10、S-10 與 D-Q 的探針）。 */
export const AI_SEED_OFFSET = 1_000_003;

export const B_FAMILY = [
  'b-nearest',
  'b-snake1',
  'b-snake2',
  'b-snake2v',
  'b-box7',
  'b-box6',
  'b-box5',
  'b-box7-near',
  'b-box6-near',
  'b-box7-fill',
  'b-box6-fill',
  'b-spiral-out',
] as const;

export const C_FAMILY = [
  'c-nearest-avoid',
  'c-nearest-swing',
  'c-nearest-chase',
  'c-box7-away',
  'c-box6-away',
  'c-box7-cut',
  'c-box6-cut',
  'c-snake2-flee',
] as const;

// ---------------------------------------------------------------------------
// 走路
// ---------------------------------------------------------------------------

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const DIRS: readonly Dir[] = [0, 1, 2, 3];

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

const FIELDS = new WeakMap<readonly number[], Map<number, Int32Array>>();
/** 到 `target` 的繞牆步數場（依牆陣列與目標快取；只讀）。 */
function fieldTo(walls: readonly number[], target: number): Int32Array {
  let byTarget = FIELDS.get(walls);
  if (byTarget === undefined) {
    byTarget = new Map();
    FIELDS.set(walls, byTarget);
  }
  let field = byTarget.get(target);
  if (field === undefined) {
    field = bfsDistances(walls, target);
    byTarget.set(target, field);
  }
  return field;
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);
const manhattan = (a: number, b: number): number =>
  Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));

/** 往 `target` 走一步的方向：最短路的方向裡優先上一次走的方向（直走），其次不是反方向的，最後才是反方向（會停一拍）。 */
function toward(state: D8State, side: Side, target: number): Buttons {
  const from = state.players[side].cell;
  if (from === target) {
    return NONE;
  }
  const field = fieldTo(state.walls, target);
  const here = field[from] as number;
  const good: Dir[] = [];
  for (const dir of DIRS) {
    const next = stepTarget(state.walls, from, dir);
    if (next !== from && (field[next] as number) < here) {
      good.push(dir);
    }
  }
  if (good.length === 0) {
    return NONE;
  }
  const heading = state.heading[side] as number;
  if (heading >= 0 && good.includes(heading as Dir)) {
    return press(heading as Dir);
  }
  const forward = good.find((d) => heading < 0 || d !== (heading + 2) % 4);
  return press(forward ?? (good[0] as Dir));
}

// ---------------------------------------------------------------------------
// 讀局面
// ---------------------------------------------------------------------------

const rankTie = (c: number, side: Side): number => {
  const dx = 2 * cellX(c) - (WIDTH - 1);
  const dy = 2 * cellY(c) - (HEIGHT - 1);
  const index = side === 0 ? c : CELLS - 1 - c;
  return (dx * dx + dy * dy) * CELLS + index;
};

/** 這一格現在是不是「對手塗的、而且還在保護期」（(c) 才准讀）。 */
const protectedByOpp = (state: D8State, c: number, mark: number): boolean => {
  const p = state.paint[c] as number;
  return p !== 0 && p !== mark && state.tick - (state.stamp[c] as number) < PROTECT_TICKS;
};

/** 我的格子以外、不是牆的格子，依 `cost` 取最小的（同分取離中心近、再取從自己這邊數起編號小的）。`cost` 回 null ＝ 不考慮。 */
function pickMin(
  state: D8State,
  side: Side,
  cost: (c: number, dist: number) => number | null,
): number | null {
  const mark = side + 1;
  const field = fieldTo(state.walls, state.players[side].cell);
  let best = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  let bestTie = Number.POSITIVE_INFINITY;
  for (let c = 0; c < CELLS; c += 1) {
    if (state.walls[c] !== 0 || state.paint[c] === mark) {
      continue;
    }
    const d = field[c] as number;
    if (d >= 9999) {
      continue;
    }
    const k = cost(c, d);
    if (k === null) {
      continue;
    }
    const tie = rankTie(c, side);
    if (k < bestCost || (k === bestCost && tie < bestTie)) {
      best = c;
      bestCost = k;
      bestTie = tie;
    }
  }
  return best < 0 ? null : best;
}

// ---------------------------------------------------------------------------
// 目標清單（都在「0 號邊」的座標系裡寫，1 號邊轉 180 度：格子編號 c 換成 CELLS − 1 − c）
// ---------------------------------------------------------------------------

const atFrame = (side: Side, c: number): number => (side === 0 ? c : CELLS - 1 - c);
const idx = (x: number, y: number): number => y * WIDTH + x;

/** 橫掃：從下往上，每隔 `stride` 列掃一列（左右來回），列與列之間用最右（或最左）那一欄接起來。 */
function snakeRows(stride: number): number[] {
  const out: number[] = [];
  let leftToRight = true;
  const ys: number[] = [];
  for (let y = HEIGHT - 1; y >= 0; y -= stride) {
    ys.push(y);
  }
  if (ys[ys.length - 1] !== 0) {
    ys.push(0);
  }
  ys.forEach((y, k) => {
    for (let i = 0; i < WIDTH; i += 1) {
      const x = leftToRight ? i : WIDTH - 1 - i;
      out.push(idx(x, y));
    }
    const nextY = ys[k + 1];
    if (nextY !== undefined) {
      const x = leftToRight ? WIDTH - 1 : 0;
      for (let yy = y - 1; yy > nextY; yy -= 1) {
        out.push(idx(x, yy));
      }
    }
    leftToRight = !leftToRight;
  });
  return out;
}

/** 直掃：從左到右，每隔 `stride` 欄掃一欄（上下來回）。 */
function snakeColumns(stride: number): number[] {
  const out: number[] = [];
  let upward = true;
  const xs: number[] = [];
  for (let x = 0; x < WIDTH; x += stride) {
    xs.push(x);
  }
  if (xs[xs.length - 1] !== WIDTH - 1) {
    xs.push(WIDTH - 1);
  }
  xs.forEach((x, k) => {
    for (let i = 0; i < HEIGHT; i += 1) {
      const y = upward ? HEIGHT - 1 - i : i;
      out.push(idx(x, y));
    }
    const nextX = xs[k + 1];
    if (nextX !== undefined) {
      const y = upward ? 0 : HEIGHT - 1;
      for (let xx = x + 1; xx < nextX; xx += 1) {
        out.push(idx(xx, y));
      }
    }
    upward = !upward;
  });
  return out;
}

/** 從中心往外（離地圖中心近的先）。 */
function spiralOut(): number[] {
  const cells = Array.from({ length: CELLS }, (_v, c) => c);
  const key = (c: number): number => {
    const dx = 2 * cellX(c) - (WIDTH - 1);
    const dy = 2 * cellY(c) - (HEIGHT - 1);
    return dx * dx + dy * dy;
  };
  return cells.sort((a, b) => key(a) - key(b) || a - b);
}

const LISTS = new Map<string, number[]>();
function listOf(name: string): number[] {
  let list = LISTS.get(name);
  if (list === undefined) {
    list =
      name === 'snake1'
        ? snakeRows(1)
        : name === 'snake2'
          ? snakeRows(2)
          : name === 'snake2v'
            ? snakeColumns(2)
            : spiralOut();
    LISTS.set(name, list);
  }
  return list;
}

/** 清單裡第一個「不是我的、不是牆」的格子（`skip` 回 true 的跳過）。 */
function firstNotMine(
  state: D8State,
  side: Side,
  list: readonly number[],
  skip?: (c: number) => boolean,
): number | null {
  const mark = side + 1;
  for (const raw of list) {
    const c = atFrame(side, raw);
    if (state.walls[c] === 0 && state.paint[c] !== mark && (skip === undefined || !skip(c))) {
      return c;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 圍框（box）
// ---------------------------------------------------------------------------

/** 一個長方形框：左右上下的邊界格（含），0 號邊座標系，y 越小越上面。 */
export interface Tile {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** 邊界線：從 `from` 開始每隔 `stride` 一條，最後補到 `limit`。 */
function edges(from: number, limit: number, stride: number, down: boolean): number[] {
  const out = [from];
  for (
    let e = from + (down ? -stride : stride);
    down ? e > limit : e < limit;
    e += down ? -stride : stride
  ) {
    out.push(e);
  }
  out.push(limit);
  return out;
}

/** 框的清單（蛇行順序：由下往上一列一列，奇數列從右往左）。相鄰的框共用邊界格。 */
export function tilesOf(stride: number): Tile[] {
  const xs = edges(0, WIDTH - 1, stride, false);
  const ys = edges(HEIGHT - 1, 0, stride, true);
  const out: Tile[] = [];
  for (let j = 0; j + 1 < ys.length; j += 1) {
    const row: Tile[] = [];
    for (let i = 0; i + 1 < xs.length; i += 1) {
      row.push({
        x0: xs[i] as number,
        x1: xs[i + 1] as number,
        y0: ys[j + 1] as number,
        y1: ys[j] as number,
      });
    }
    out.push(...(j % 2 === 0 ? row : row.reverse()));
  }
  return out;
}

/** 框的邊界格（含四個角，不含牆），轉成 `side` 的座標系。 */
function ringOf(state: D8State, side: Side, t: Tile): number[] {
  const out: number[] = [];
  for (let x = t.x0; x <= t.x1; x += 1) {
    out.push(idx(x, t.y0), idx(x, t.y1));
  }
  for (let y = t.y0 + 1; y < t.y1; y += 1) {
    out.push(idx(t.x0, y), idx(t.x1, y));
  }
  return [...new Set(out)].map((c) => atFrame(side, c)).filter((c) => state.walls[c] === 0);
}

/** 框的內部格（不含邊界、不含牆）。 */
function interiorOf(state: D8State, side: Side, t: Tile): number[] {
  const out: number[] = [];
  for (let y = t.y0 + 1; y < t.y1; y += 1) {
    for (let x = t.x0 + 1; x < t.x1; x += 1) {
      out.push(atFrame(side, idx(x, y)));
    }
  }
  return out.filter((c) => state.walls[c] === 0);
}

const remaining = (state: D8State, side: Side, ring: readonly number[]): number[] =>
  ring.filter((c) => state.paint[c] !== side + 1);

/** 到框邊界最近的沒塗格的步數（繞牆）。 */
function stepsTo(state: D8State, side: Side, ring: readonly number[]): number {
  const left = remaining(state, side, ring);
  const field = fieldTo(state.walls, state.players[side].cell);
  return left.reduce((m, c) => Math.min(m, field[c] as number), 9999);
}

// ---------------------------------------------------------------------------
// 成員 → 目標
// ---------------------------------------------------------------------------

type Chooser = (state: D8State, side: Side) => number | null;

/** 最近的「不是我的」格子。 */
const nearest: Chooser = (state, side) => pickMin(state, side, (_c, d) => d);

/** 目標在一個框的邊界上：框內還有沒塗的邊界格就去最近的那一格；全塗完了回 null。 */
function inRing(state: D8State, side: Side, ring: readonly number[]): number | null {
  const left = remaining(state, side, ring);
  if (left.length === 0) {
    return null;
  }
  const field = fieldTo(state.walls, state.players[side].cell);
  let best = left[0] as number;
  for (const c of left) {
    const d = field[c] as number;
    const bd = field[best] as number;
    if (d < bd || (d === bd && rankTie(c, side) < rankTie(best, side))) {
      best = c;
    }
  }
  return best;
}

/** (b) 的框：照蛇行順序一個框一個框做，做完才做下一個；全部做完退回最近的不是我的格子。 */
function boxStatic(stride: number): Chooser {
  const tiles = tilesOf(stride);
  return (state, side) => {
    for (const t of tiles) {
      const goal = inRing(state, side, ringOf(state, side, t));
      if (goal !== null) {
        return goal;
      }
    }
    return nearest(state, side);
  };
}

/** 動態挑框的分數（不讀對手）：離我越近越好。 */
function nearScore(state: D8State, side: Side, _t: Tile, ring: readonly number[]): number {
  return -stepsTo(state, side, ring);
}

/** 動態挑框的分數（不讀對手）：框裡不是我的格子（邊界與內部）的數量 ÷（走過去的步數 ＋ 還沒塗的邊界格數）。 */
function fillScore(state: D8State, side: Side, t: Tile, ring: readonly number[]): number {
  const left = remaining(state, side, ring).length;
  const inner = interiorOf(state, side, t).filter((c) => state.paint[c] !== side + 1).length;
  return (left + inner) / (stepsTo(state, side, ring) + left);
}

function chooserB(name: string): Chooser {
  switch (name) {
    case 'b-nearest':
      return nearest;
    case 'b-snake1':
      return (state, side) => firstNotMine(state, side, listOf('snake1')) ?? nearest(state, side);
    case 'b-snake2':
      return (state, side) => firstNotMine(state, side, listOf('snake2')) ?? nearest(state, side);
    case 'b-snake2v':
      return (state, side) => firstNotMine(state, side, listOf('snake2v')) ?? nearest(state, side);
    case 'b-box7':
      return boxStatic(7);
    case 'b-box6':
      return boxStatic(6);
    case 'b-box5':
      return boxStatic(5);
    case 'b-spiral-out':
      return (state, side) => firstNotMine(state, side, listOf('spiral')) ?? nearest(state, side);
    // 動態挑框（不讀對手）：挑離我最近（繞牆步數）的還沒做完的框，做完才換。
    case 'b-box7-near':
      return boxDynamic(7, nearScore, false)();
    case 'b-box6-near':
      return boxDynamic(6, nearScore, false)();
    // 動態挑框（不讀對手）：框裡「不是我的」格子（不分沒人塗過或對手的）一共幾格，除以（走過去的步數 ＋ 還沒塗的邊界格數）。
    case 'b-box7-fill':
      return boxDynamic(7, fillScore, false)();
    case 'b-box6-fill':
      return boxDynamic(6, fillScore, false)();
    default:
      throw new Error(`不是 (b) 的成員：${name}`);
  }
}

/** 框離對手多近（曼哈頓距離，對手在框裡是 0）：(c) 才准讀。 */
function tileDistance(state: D8State, side: Side, t: Tile): number {
  const opp = state.players[other(side)].cell;
  const o = atFrame(side, opp);
  const x = cellX(o);
  const y = cellY(o);
  const dx = Math.max(t.x0 - x, 0, x - t.x1);
  const dy = Math.max(t.y0 - y, 0, y - t.y1);
  return dx + dy;
}

/**
 * 動態挑框：每次要換框時，依 `score`（越大越好）在還沒做完的框裡挑；做完才換。
 * `leaveWhenOppNear` 為真（只有 (c) 用）時，對手靠近（≤ 3）也換。
 */
function boxDynamic(
  stride: number,
  score: (state: D8State, side: Side, t: Tile, ring: readonly number[]) => number,
  leaveWhenOppNear: boolean,
): () => Chooser {
  const tiles = tilesOf(stride);
  return () => {
    let current: Tile | null = null;
    return (state, side) => {
      if (current !== null) {
        const ring = ringOf(state, side, current);
        if (
          remaining(state, side, ring).length === 0 ||
          (leaveWhenOppNear && tileDistance(state, side, current) <= 3)
        ) {
          current = null;
        }
      }
      if (current === null) {
        let best: Tile | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const t of tiles) {
          const ring = ringOf(state, side, t);
          if (remaining(state, side, ring).length === 0) {
            continue;
          }
          const s = score(state, side, t, ring);
          if (s > bestScore) {
            best = t;
            bestScore = s;
          }
        }
        current = best;
      }
      if (current === null) {
        return nearest(state, side);
      }
      return inRing(state, side, ringOf(state, side, current)) ?? nearest(state, side);
    };
  };
}

/** (c) 的規則：多拿到對手的公開狀態（程式碼裡直接讀 `state.players[對手]`、`paint`、`stamp`）。 */
function chooserC(name: string): Chooser {
  switch (name) {
    // 最近的沒塗格，但離對手 ≤ 4 格的不去（除非沒有別的）。
    case 'c-nearest-avoid':
      return (state, side) => {
        const opp = state.players[other(side)].cell;
        return (
          pickMin(state, side, (c, d) => (manhattan(c, opp) <= 4 ? null : d)) ??
          nearest(state, side)
        );
      };
    // 一步的價值：沒人塗過 1，對手塗的而且過了保護期 2（我 +1、它 −1），保護期內 0；每格價值 ÷（距離 ＋ 1）。
    case 'c-nearest-swing':
      return (state, side) => {
        const mark = side + 1;
        return pickMin(state, side, (c, d) => {
          const p = state.paint[c] as number;
          const swing = p === 0 ? 1 : protectedByOpp(state, c, mark) ? 0 : 2;
          return swing === 0 ? null : -swing / (d + 1);
        });
      };
    // 追著對手的地盤：對手塗的、過了保護期的格子，距離打 6 折（少算 6 步）。
    case 'c-nearest-chase':
      return (state, side) => {
        const mark = side + 1;
        return pickMin(state, side, (c, d) => {
          const p = state.paint[c] as number;
          return p !== 0 && p !== mark && !protectedByOpp(state, c, mark) ? d - 6 : d;
        });
      };
    // 蛇行掃（隔一列），但離對手 ≤ 3 格的格子先跳過。
    case 'c-snake2-flee':
      return (state, side) => {
        const opp = state.players[other(side)].cell;
        return (
          firstNotMine(state, side, listOf('snake2'), (c) => manhattan(c, opp) <= 3) ??
          firstNotMine(state, side, listOf('snake2')) ??
          nearest(state, side)
        );
      };
    default:
      throw new Error(`不是 (c) 的成員：${name}`);
  }
}

/** 做 (c) 的框：`away` 避開對手、`cut` 專挑裡面有對手格子的框。 */
function boxChooserC(name: string): () => Chooser {
  switch (name) {
    // 還沒做完的框裡：離對手越遠越好（> 10 的一律當 10），離我越近越好。
    case 'c-box7-away':
    case 'c-box6-away':
      return boxDynamic(
        name === 'c-box7-away' ? 7 : 6,
        (state, side, t, ring) =>
          Math.min(tileDistance(state, side, t), 10) * 2 - stepsTo(state, side, ring),
        true,
      );
    // 一個框的價值：沒塗的邊界格 ＋ 內部沒塗的格子 ＋ 內部對手的格子（算 2：我 +1、它 −1），對手在框裡或靠近（≤ 3）不去；價值 ÷（走過去的步數 ＋ 還沒塗的邊界格數）。
    case 'c-box7-cut':
    case 'c-box6-cut':
      return boxDynamic(
        name === 'c-box7-cut' ? 7 : 6,
        (state, side, t, ring) => {
          if (tileDistance(state, side, t) <= 3) {
            return Number.NEGATIVE_INFINITY;
          }
          const mark = side + 1;
          let value = 0;
          for (const c of remaining(state, side, ring)) {
            value += state.paint[c] === 0 ? 1 : 2;
          }
          for (const c of interiorOf(state, side, t)) {
            const p = state.paint[c] as number;
            value += p === 0 ? 1 : p === mark ? 0 : 2;
          }
          return value / (stepsTo(state, side, ring) + remaining(state, side, ring).length);
        },
        true,
      );
    default:
      throw new Error(`不是 (c) 的框成員：${name}`);
  }
}

/** 一個成員的控制器（每次呼叫都是全新的）。 */
export function member(name: string): Controller<D8State> {
  const choose: Chooser =
    name === 'c-box7-away' ||
    name === 'c-box6-away' ||
    name === 'c-box7-cut' ||
    name === 'c-box6-cut'
      ? boxChooserC(name)()
      : name.startsWith('b-')
        ? chooserB(name)
        : chooserC(name);
  if (
    !(B_FAMILY as readonly string[]).includes(name) &&
    !(C_FAMILY as readonly string[]).includes(name)
  ) {
    throw new Error(`不是族裡的成員：${name}`);
  }
  return {
    decide(state: D8State, side: Side): Buttons {
      if (state.over) {
        return NONE;
      }
      const target = choose(state, side);
      return target === null ? NONE : toward(state, side, target);
    },
  };
}

/**
 * 反應延遲：世界是 `delay` 個 tick 前的，自己的位置、待走方向、方向是現在的，
 * 而且「現在是我的顏色」的格子一律當成是我的（自己塗過的自己知道）。
 */
export function withDelay(inner: Controller<D8State>, delay: number): Controller<D8State> {
  if (delay <= 0) {
    return inner;
  }
  const seen = new Map<number, D8State>();
  return {
    decide(state: D8State, side: Side, tick: number): Buttons {
      seen.set(tick, state);
      seen.delete(tick - delay - 1);
      const old = seen.get(tick - delay) ?? seen.get(Math.max(0, tick - delay)) ?? state;
      const players = [old.players[0], old.players[1]] as [
        D8State['players'][0],
        D8State['players'][0],
      ];
      players[side] = state.players[side];
      const heading = [old.heading[0], old.heading[1]] as [number, number];
      heading[side] = state.heading[side] as number;
      const mark = side + 1;
      const paint = old.paint.map((p, c) => (state.paint[c] === mark ? mark : p));
      return inner.decide({ ...old, players, heading, paint }, side, tick);
    },
  };
}

// ---------------------------------------------------------------------------
// 對局
// ---------------------------------------------------------------------------

/** 一格：AI 的性格、等級；玩家的反應延遲（tick）。 */
export interface Cell {
  readonly policy: PolicyKey;
  readonly level: number;
  readonly delay: number;
}

export const MAIN_CELL: Cell = { policy: 'greedy', level: 10, delay: 12 };

/** 玩家（`ctl`）對 AI 跑一場；偶數種子玩家坐 0 號邊，奇數種子坐 1 號邊。 */
export function playWith(seed: number, ctl: Controller<D8State>, at: Cell): MatchOutcome {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const ai = levelController(d8Game, policyByName(at.policy), at.level, seed + AI_SEED_OFFSET);
  const mine = withDelay(ctl, at.delay);
  const result =
    side === 0
      ? playMatch(d8Game, seed, CONFIG, mine, ai)
      : playMatch(d8Game, seed, CONFIG, ai, mine);
  return outcomeOf(result, side);
}

/** D-8 的「一次決策」：每個走格週期的第一個 tick（玩家每個週期選一次方向）。 */
export const isPoint: IsPoint<D8State> = (state) => state.tick % MOVE_EVERY === 0;

/** 把兩個成員接成一份 `ProbeSpec`。 */
export function spec(
  b: string,
  c: string,
  seeds: readonly number[],
  at: Cell,
  withPoint = true,
): ProbeSpec<D8State> {
  return {
    makeB: () => member(b),
    makeC: () => member(c),
    seeds,
    play: (seed, ctl) => playWith(seed, ctl, at),
    isPoint: withPoint ? isPoint : undefined,
  };
}

// ---------------------------------------------------------------------------
// 選法
// ---------------------------------------------------------------------------

export interface Row {
  readonly name: string;
  /** 勝率（0 到 1，和局 0.5）。 */
  readonly win: number;
  /** 平均分差（我方 − AI，顏色格子數）。 */
  readonly margin: number;
}

/** 一個成員在一組種子上的勝率與平均分差。 */
export function score(name: string, seeds: readonly number[], at: Cell): Row {
  let win = 0;
  let margin = 0;
  for (const seed of seeds) {
    const o = playWith(seed, member(name), at);
    win += o.win;
    margin += o.margin;
  }
  return { name, win: win / seeds.length, margin: margin / seeds.length };
}

/**
 * 選最強的（量之前固定的規則）：勝率最高；同勝率取平均分差高的；再同就取表中靠前的。
 * 「同」比較的是 1e-9 以內，免得浮點誤差破平。
 */
export function selectBest(rows: readonly Row[]): Row {
  let best = rows[0] as Row;
  const eq = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
  for (const row of rows.slice(1)) {
    if (row.win > best.win + 1e-9 || (eq(row.win, best.win) && row.margin > best.margin + 1e-9)) {
      best = row;
    }
  }
  return best;
}
