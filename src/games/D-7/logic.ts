import { rngStateFor, intFrom } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  GAIN_PER_POINT,
  HEIGHT,
  MOVE_EVERY,
  START_CELLS,
  WIDTH,
  WIN_BONUS,
  cell,
  clamp01,
  generateWalls,
  makeBase,
  steerWalker,
  stepTarget,
  winnerByScore,
} from '../_diamonds/logic';
import type { BaseOverrides, DiamondsBase, Dir, Walker } from '../_diamonds/logic';

// 被測試的環境（vite-node）把匯入的名字改成每次存取都查一次模組物件，熱迴圈裡很慢，所以先抄一份到本地。
const CELL_COUNT = CELLS;
const ROW_LENGTH = WIDTH;
const MOVE_PERIOD = MOVE_EVERY;
const colOf = (index: number): number => index % ROW_LENGTH;
const rowOf = (index: number): number => Math.floor(index / ROW_LENGTH);

/**
 * D-7 挖礦（SPEC 第 9 節一行方向；小規格 `docs/cards/D-7.md`）。
 * 整張地圖是岩石，朝岩石按住方向就是鑿（每 5 個 tick 一鑿），鑿穿的那一格永久是路、對兩個人都是。
 * 礦藏在岩石裡，鑿穿之後留在那一格，有人走進去（而且背包有空位）才撿起來；背回自己的基地才算分。
 * 這張牌沒有任何隨機事件：亂數只在開局決定礦的位置，之後 `rng` 不再使用。
 * 地圖、牆、走格、距離的共用邏輯在 `_diamonds/logic.ts`；岩石與鑿開是這張牌自己的規則。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 各深度帶的岩石硬度：要鑿幾次（一次是一個走格週期，5 個 tick）。 */
export const HARD: readonly number[] = [1, 2, 4, 6];
/** 各深度帶的礦價值。 */
export const VALUE: readonly number[] = [1, 3, 6, 10];
/** 深度帶的寬度：`band = min(3, ⌊depth / BAND_WIDTH⌋)`。 */
export const BAND_WIDTH = 7;
/** 每格岩石藏著礦的機率（百分比）。 */
export const ORE_RATE = 25;
/** 背包最多幾塊礦（不論價值）。 */
export const BAG = 4;
/** 兩個基地周圍曼哈頓距離這麼近以內，開局就是空的洞穴。 */
export const CAVE_RADIUS = 2;

/** AI 用的常數（起始值，量測後調整，見小規格「量測」）。 */
/** 「最好的礦的每週期價值」在 `gain` 裡的權重。 */
export const RATE_WEIGHT = 30;
/** `rate` 的分母裡，「礦到基地的週期」算幾倍。 */
export const TRIP_WEIGHT = 1;
/** 往前走進對手鑿穿的路（而且是朝目標前進），多給 `FREE_RIDE_BONUS × RATE_WEIGHT × bestRate`。 */
export const FREE_RIDE_BONUS = 0.5;
/** 剩下的 tick 少於「走回基地要的 tick」加上這麼多，背著礦就該回家了。 */
export const LATE_TICKS = 300;
/** 躺在對手也到得了的地方的礦（它會在我鑿穿的那一刻站在旁邊、跟著踩進去各撿一份），我算它值多少折：0.5 就是少一半。 */
/** 對手與我到同一顆礦的時間差（週期）：超過 ±這麼多，要嘛全歸我、要嘛幾乎全歸它。 */
export const COPY_SLACK = 3;
/** 對手比我晚這麼多個週期到，還是算「差不多同時」（鑿穿的聲響與它的位置：它會在隔壁等著）。 */
export const COPY_LAG = 2;
/** 對手早到很多時，這顆礦對我的價值最少還剩幾成（它的背包也許滿了、也許它不去撿）。 */
export const COPY_FLOOR = 0.1;
/** 我鑿的那一格，對手在 `GIVE_RANGE` 個週期以內走得到：最多扣這麼多（替對手鋪路）。 */
export const GIVE_WEIGHT = 6;
export const GIVE_RANGE = 12;
/** 被對手搶先的礦，導航分數再扣這麼多（相當於多走這麼多個週期的路），所以對手在哪一側會改變我挑哪一顆。 */
export const CONTEST_COST = 80;
/** 對手這一鑿就要鑿穿一格有礦的岩石，而我站在那一格旁邊（下一次走格一起踩進去各撿一份）：每 1 分價值給這麼多。 */
export const RIDE_WAIT_PER_VALUE = 20;
/** 背包裡的礦在 `gain` 裡一分算幾（存起來的是 100，所以比較少）。 */
export const BAG_WEIGHT = 60;
/** 對手鑿開、丟在路上的礦（它的背包滿了或它比較遠），我去撿：每 1 分價值多算這麼多。 */
export const RACE_PER_VALUE = 15;
/** `danger` 的第二項：背包價值的尺度與離基地週期數的尺度。 */
export const DANGER_BAG_SCALE = 20;
export const DANGER_TRIP_SCALE = 40;

// ---------------------------------------------------------------------------
// 地形
// ---------------------------------------------------------------------------

/** 深度：到最近的基地的曼哈頓距離（不看牆，靜態、可以預先畫在畫面上）。 */
export function depthOf(index: number): number {
  const x = colOf(index);
  const y = rowOf(index);
  return Math.min(x + (HEIGHT - 1 - y), WIDTH - 1 - x + y);
}

/** 深度帶 0 到 3（地圖正中央最深）。 */
export function bandOf(index: number): number {
  return Math.min(3, Math.floor(depthOf(index) / BAND_WIDTH));
}

/** 開局就是空的洞穴（兩個基地周圍）。 */
export function isCave(index: number): boolean {
  return depthOf(index) <= CAVE_RADIUS;
}

export interface D7State extends DiamondsBase {
  /** 長度 768：每格還要鑿幾次（0 是空的或牆）。 */
  readonly rock: readonly number[];
  /** 長度 768：這一格有多少價值的礦（0 沒有；撿走就歸 0）。 */
  readonly ore: readonly number[];
  /** 兩邊背包裡的礦的價值（最多 `BAG` 個）。 */
  readonly bag: readonly [readonly number[], readonly number[]];
  /** 累計鑿穿幾格（指紋用）。 */
  readonly dug: readonly [number, number];
  /** 累計走進「對手鑿穿的空格」幾次（搭便車，指紋用）。 */
  readonly rode: readonly [number, number];
  /** 每格是誰鑿穿的：−1 開局就是空的（或還沒鑿），0 人，1 AI，2 兩邊同一次一起鑿穿。 */
  readonly opened: readonly number[];
}

type Pair = readonly (readonly [number, number])[];

export interface StateOverrides extends BaseOverrides {
  /** 「[格子編號, hp]」的清單。 */
  readonly rock?: Pair;
  /** 「[格子編號, 價值]」的清單。 */
  readonly ore?: Pair;
  /** 「[格子編號, 誰鑿穿的]」的清單。 */
  readonly opened?: Pair;
  readonly bag?: readonly [readonly number[], readonly number[]];
  readonly dug?: readonly [number, number];
  readonly rode?: readonly [number, number];
}

/** 測試輔助：沒有牆、全岩石（hp 1）、沒有礦、兩個基地周圍的洞穴，用 overrides 覆蓋。 */
export function makeState(overrides: StateOverrides = {}): D7State {
  const base = makeBase(overrides);
  const rock = new Array<number>(CELL_COUNT).fill(0);
  for (let c = 0; c < CELL_COUNT; c += 1) {
    rock[c] = base.walls[c] === 1 || isCave(c) ? 0 : 1;
  }
  for (const [c, hp] of overrides.rock ?? []) {
    rock[c] = hp;
  }
  const ore = new Array<number>(CELL_COUNT).fill(0);
  for (const [c, value] of overrides.ore ?? []) {
    ore[c] = value;
  }
  const opened = new Array<number>(CELL_COUNT).fill(-1);
  for (const [c, who] of overrides.opened ?? []) {
    opened[c] = who;
  }
  return {
    ...base,
    rock,
    ore,
    opened,
    bag: overrides.bag ?? [[], []],
    dug: overrides.dug ?? [0, 0],
    rode: overrides.rode ?? [0, 0],
  };
}

// ---------------------------------------------------------------------------
// 時間成本圖（加權最短路徑）
// ---------------------------------------------------------------------------

/** 到不了。 */
const FAR = 1 << 30;

export interface Field {
  /** 從出發格走到每一格的時間成本（週期）：空格一步 1，岩石一步 `1 + hp`（鑿完再走進去），牆走不過；到不了是 `FAR`。 */
  readonly cost: Int32Array;
  /** 最便宜的那條路有幾步（成本相同時取步數少的）。 */
  readonly steps: Int32Array;
}

/** 四個鄰格：每格 4 個（上、右、下、左），出界是 −1。 */
const NEIGHBORS = ((): Int16Array => {
  const table = new Int16Array(CELL_COUNT * 4).fill(-1);
  for (let c = 0; c < CELL_COUNT; c += 1) {
    const x = colOf(c);
    const y = rowOf(c);
    if (y > 0) {
      table[c * 4] = cell(x, y - 1);
    }
    if (x < WIDTH - 1) {
      table[c * 4 + 1] = cell(x + 1, y);
    }
    if (y < HEIGHT - 1) {
      table[c * 4 + 2] = cell(x, y + 1);
    }
    if (x > 0) {
      table[c * 4 + 3] = cell(x - 1, y);
    }
  }
  return table;
})();

/** 成本圖只算到這麼多個週期（約 7 秒的路）；更遠的格子視為到不了。 */
const FIELD_BOUND = 90;

/** 桶佇列（Dial 的最短路徑演算法）：一步最多 `1 + 6 = 7` 週期，所以 8 個桶輪著用就夠了。 */
const BUCKETS = 8;
/** 桶裡的節點串列：每格最多被放進去 4 次（每個鄰格各一次）。 */
const ENTRY_CAPACITY = CELL_COUNT * 4 + 4;
const BUCKET_HEAD = new Int32Array(BUCKETS);
const ENTRY_CELL = new Int32Array(ENTRY_CAPACITY);
const ENTRY_NEXT = new Int32Array(ENTRY_CAPACITY);

/**
 * 時間成本圖：成本相同時取步數少的。成本一步至少 1，所以同一個桶裡的格子之間沒有邊，
 * 處理某個桶的時候，它的步數已經是定案的（所有成本更低的前驅都處理過了）。
 */
function computeField(walls: readonly number[], rock: readonly number[], from: number): Field {
  const cost = new Int32Array(CELL_COUNT).fill(FAR);
  const steps = new Int32Array(CELL_COUNT).fill(FAR);
  BUCKET_HEAD.fill(-1);
  cost[from] = 0;
  steps[from] = 0;
  ENTRY_CELL[0] = from;
  ENTRY_NEXT[0] = -1;
  BUCKET_HEAD[0] = 0;
  let used = 1;
  let pending = 1;
  for (let level = 0; pending > 0 && level <= FIELD_BOUND; level += 1) {
    const bucket = level % BUCKETS;
    let entry = BUCKET_HEAD[bucket] as number;
    BUCKET_HEAD[bucket] = -1;
    while (entry >= 0) {
      pending -= 1;
      const current = ENTRY_CELL[entry] as number;
      entry = ENTRY_NEXT[entry] as number;
      if (cost[current] !== level) {
        continue; // 後來找到更便宜的路，這是舊的紀錄
      }
      const nextSteps = (steps[current] as number) + 1;
      for (let k = 0; k < 4; k += 1) {
        const next = NEIGHBORS[current * 4 + k] as number;
        if (next < 0 || walls[next] === 1) {
          continue;
        }
        const nd = level + 1 + (rock[next] as number);
        const known = cost[next] as number;
        if (nd < known) {
          cost[next] = nd;
          steps[next] = nextSteps;
          const slot = nd % BUCKETS;
          ENTRY_CELL[used] = next;
          ENTRY_NEXT[used] = BUCKET_HEAD[slot] as number;
          BUCKET_HEAD[slot] = used;
          used += 1;
          pending += 1;
        } else if (nd === known && nextSteps < (steps[next] as number)) {
          steps[next] = nextSteps;
        }
      }
    }
  }
  // 超過上限的是還沒定案的暫定值，一律當作到不了。
  for (let c = 0; c < CELL_COUNT; c += 1) {
    if ((cost[c] as number) > FIELD_BOUND) {
      cost[c] = FAR;
      steps[c] = FAR;
    }
  }
  return { cost, steps };
}

/**
 * 距離場的快取：同一張牆、同一組岩石（陣列物件）、同一個出發格，結果永遠一樣。
 * `step` 沒有鑿穿或撿礦時不複製 `rock`，所以搜尋型一次決定會問上百次，幾乎都命中。
 * 以岩石陣列為鑰匙（WeakMap），岩石不再被用到時整份一起被回收；回傳的欄位是共用的，呼叫端只能讀。
 */
const FIELD_CACHE = new WeakMap<
  readonly number[],
  WeakMap<readonly number[], Map<number, Field>>
>();

/** 這一版岩石是從哪一版、改了哪幾格得來的（`step` 鑿岩石時登記；只是快取的線索，不影響結果）。 */
const LINEAGE = new WeakMap<
  readonly number[],
  { readonly prev: readonly number[]; readonly cells: readonly number[] }
>();
/** 往前找幾版。 */
const LINEAGE_HOPS = 8;

export function fieldFrom(walls: readonly number[], rock: readonly number[], from: number): Field {
  let byWalls = FIELD_CACHE.get(rock);
  if (byWalls === undefined) {
    byWalls = new WeakMap<readonly number[], Map<number, Field>>();
    FIELD_CACHE.set(rock, byWalls);
  }
  let byCell = byWalls.get(walls);
  if (byCell === undefined) {
    byCell = new Map<number, Field>();
    byWalls.set(walls, byCell);
  }
  const cached = byCell.get(from);
  if (cached !== undefined) {
    return cached;
  }
  const field = reusedField(walls, rock, from) ?? computeField(walls, rock, from);
  byCell.set(from, field);
  return field;
}

/**
 * 從 `from` 出發的最短路徑不會經過 `from` 自己，所以只有 `from` 這一格的岩石變了（有人在鑿它），
 * 從它出發的成本圖不變：沿著 `LINEAGE` 往前找，找到同一張牆、同一個出發格、而且之後只動過 `from` 的那一版岩石，直接借它的結果。
 */
function reusedField(
  walls: readonly number[],
  rock: readonly number[],
  from: number,
): Field | undefined {
  let version = rock;
  for (let hops = 0; hops < LINEAGE_HOPS; hops += 1) {
    const link = LINEAGE.get(version);
    if (link === undefined || !link.cells.every((c) => c === from)) {
      return undefined;
    }
    version = link.prev;
    const found = FIELD_CACHE.get(version)?.get(walls)?.get(from);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 走格的結算
// ---------------------------------------------------------------------------

interface Intent {
  /** 0 原地、1 走進空格、2 鑿岩石。 */
  readonly kind: 0 | 1 | 2;
  /** 鎖定方向指向的格子（原地時是自己腳下）。 */
  readonly to: number;
}

/** 鎖定的方向在這個局面上是什麼意思：朝牆或出界是原地，朝岩石是鑿，朝空格是走。 */
function intentOf(walls: readonly number[], rock: readonly number[], walker: Walker): Intent {
  if (walker.pending < 0) {
    return { kind: 0, to: walker.cell };
  }
  const to = stepTarget(walls, walker.cell, walker.pending as Dir);
  if (to === walker.cell) {
    return { kind: 0, to };
  }
  return { kind: (rock[to] as number) > 0 ? 2 : 1, to };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 遊戲
// ---------------------------------------------------------------------------

export const d7Game: Game<D7State> = {
  id: 'D-7',

  init(seed: number, config: GameConfig): D7State {
    const walls = generateWalls(seed).walls;
    const rock = new Array<number>(CELL_COUNT).fill(0);
    for (let c = 0; c < CELL_COUNT; c += 1) {
      if (walls[c] === 0 && !isCave(c)) {
        rock[c] = HARD[bandOf(c)] as number;
      }
    }
    // 礦：每一對 180 度旋轉對應的格子擲一次骰，兩邊的格子都放同價值的礦（深度、hp 本來就對稱），所以兩個人的礦脈一樣多。
    const ore = new Array<number>(CELL_COUNT).fill(0);
    let rng: RngState = rngStateFor(seed, 'ore');
    for (let c = 0; c < CELL_COUNT / 2; c += 1) {
      let roll: number;
      [roll, rng] = intFrom(rng, 100);
      if (roll < ORE_RATE) {
        const twin = CELL_COUNT - 1 - c;
        for (const target of [c, twin]) {
          if ((rock[target] as number) > 0) {
            ore[target] = VALUE[bandOf(target)] as number;
          }
        }
      }
    }
    return {
      tick: 0,
      maxTicks: config.maxTicks,
      walls,
      players: [
        { cell: START_CELLS[0], pending: -1, score: 0 },
        { cell: START_CELLS[1], pending: -1, score: 0 },
      ],
      rng,
      over: false,
      winner: null,
      rock,
      ore,
      bag: [[], []],
      dug: [0, 0],
      rode: [0, 0],
      opened: new Array<number>(CELL_COUNT).fill(-1),
    };
  },

  step(state: D7State, inputs: Inputs): D7State {
    if (state.over) {
      return state;
    }
    const tick = state.tick + 1;
    let players: readonly [Walker, Walker] = [
      steerWalker(state.players[0], inputs[0]),
      steerWalker(state.players[1], inputs[1]),
    ];
    let { rock, ore, opened, bag, dug, rode } = state;

    if (tick % MOVE_PERIOD === 0) {
      const intents = [
        intentOf(state.walls, state.rock, players[0]),
        intentOf(state.walls, state.rock, players[1]),
      ] as const;
      // 鑿：兩邊都用走格之前的岩石結算；同一格被兩個人鑿，hp 一次 −2。
      const digging = [intents[0].kind === 2, intents[1].kind === 2] as const;
      let nextRock: number[] | null = null;
      let nextOpened: number[] | null = null;
      const nextDug = [dug[0], dug[1]];
      if (digging[0] || digging[1]) {
        const dugRock = rock.slice();
        nextRock = dugRock;
        const hits = new Map<number, number[]>();
        for (const side of [0, 1] as const) {
          if (digging[side]) {
            const list = hits.get(intents[side].to) ?? [];
            list.push(side);
            hits.set(intents[side].to, list);
          }
        }
        LINEAGE.set(dugRock, { prev: rock, cells: [...hits.keys()] });
        for (const [target, sides] of hits) {
          const left = Math.max(0, (rock[target] as number) - sides.length);
          dugRock[target] = left;
          if (left === 0) {
            nextOpened ??= opened.slice();
            nextOpened[target] = sides.length === 2 ? 2 : (sides[0] as number);
            for (const side of sides) {
              nextDug[side] = (nextDug[side] as number) + 1;
            }
          }
        }
      }
      // 走：走進走格之前就是空的格子；撿礦（有空位的人各撿一份，礦歸 0）、搭便車、存進基地。
      let nextOre: number[] | null = null;
      const nextBag: number[][] = [bag[0].slice(), bag[1].slice()];
      const scores = [players[0].score, players[1].score];
      const nextRode = [rode[0], rode[1]];
      const cells = [players[0].cell, players[1].cell];
      const takers = new Map<number, boolean>();
      for (const side of [0, 1] as const) {
        const intent = intents[side];
        if (intent.kind !== 1) {
          continue;
        }
        const to = intent.to;
        cells[side] = to;
        const mine = nextBag[side] as number[];
        const value = ore[to] as number;
        if (value > 0 && mine.length < BAG) {
          mine.push(value);
          takers.set(to, true);
        }
        if (opened[to] === 1 - side) {
          nextRode[side] = (nextRode[side] as number) + 1;
        }
        if (to === START_CELLS[side]) {
          scores[side] = (scores[side] as number) + sum(mine);
          nextBag[side] = [];
        }
      }
      if (takers.size > 0) {
        const taken = ore.slice();
        for (const c of takers.keys()) {
          taken[c] = 0;
        }
        nextOre = taken;
      }
      rock = nextRock ?? rock;
      opened = nextOpened ?? opened;
      ore = nextOre ?? ore;
      bag = [nextBag[0] as number[], nextBag[1] as number[]];
      dug = [nextDug[0] as number, nextDug[1] as number];
      rode = [nextRode[0] as number, nextRode[1] as number];
      players = [
        { cell: cells[0] as number, pending: -1, score: scores[0] as number },
        { cell: cells[1] as number, pending: -1, score: scores[1] as number },
      ];
    }

    const over = tick >= state.maxTicks;
    return {
      ...state,
      tick,
      players,
      rock,
      ore,
      opened,
      bag,
      dug,
      rode,
      over,
      winner: over ? winnerByScore(players) : null,
    };
  },

  isOver(state: D7State): boolean {
    return state.over;
  },

  score(state: D7State): readonly [number, number] {
    return [state.players[0].score, state.players[1].score];
  },

  winner(state: D7State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: D7State, side: Side): readonly Buttons[] {
    const me = state.players[side];
    const other: Side = side === 0 ? 1 : 0;
    const pick = chooseTarget({
      state,
      side,
      field: fieldFrom(state.walls, state.rock, me.cell),
      oppField: fieldFrom(state.walls, state.rock, state.players[other].cell),
      bagLength: state.bag[side].length,
      oppBagLength: state.bag[other].length,
      dug: null,
      taken: [-1, -1],
    });
    const dirs = side === 0 ? DIRS_FIRST : DIRS_SECOND;
    // 從鄰格走到目標的成本 = 從目標走到鄰格的成本 + 目標那一格的進入成本（路徑反過來，中間每一格的成本一樣，兩端各差一格），
    // 所以只要算一張從目標出發的成本圖，不用算四張從鄰格出發的。
    const fromTarget = pick.target >= 0 ? fieldFrom(state.walls, state.rock, pick.target) : null;
    const scored = dirs.map((dir, order) => {
      const next = stepTarget(state.walls, me.cell, dir);
      let via = Number.POSITIVE_INFINITY;
      if (fromTarget !== null && next !== me.cell) {
        const back = fromTarget.cost[next] as number;
        via =
          back >= FAR ? Number.POSITIVE_INFINITY : back + 1 + (state.rock[pick.target] as number);
      } else if (pick.target >= 0 && me.cell === pick.target) {
        via = 0.5;
      }
      return { dir, order, via };
    });
    // 通往目標的最便宜的方向排最前面（走向岩石就是鑿）；走不動的（牆、出界）與沒有目標時照預設順序。
    scored.sort((x, y) => x.via - y.via || x.order - y.order);
    return [...scored.map((entry) => press(entry.dir)), NONE];
  },

  evaluate(state: D7State, side: Side): { gain: number; danger: number } {
    const other: Side = side === 0 ? 1 : 0;
    const me = state.players[side];
    const opponent = state.players[other];
    if (state.over) {
      const difference = me.score - opponent.score;
      const sign = difference === 0 ? 0 : difference > 0 ? 1 : -1;
      return { gain: GAIN_PER_POINT * difference + sign * WIN_BONUS, danger: 0 };
    }
    const myBase = START_CELLS[side];
    const oppBase = START_CELLS[other];
    // 下一次走格會發生什麼：只模擬已鎖定的方向（同 D-A 的「下一步」），兩邊一起算。
    const mine = intentOf(state.walls, state.rock, me);
    const theirs = intentOf(state.walls, state.rock, opponent);
    const myPos = mine.kind === 1 ? mine.to : me.cell;
    const oppPos = theirs.kind === 1 ? theirs.to : opponent.cell;
    const myBag = state.bag[side].slice();
    const oppBag = state.bag[other].slice();
    let myScore = me.score;
    let oppScore = opponent.score;
    const taken: [number, number] = [-1, -1];
    if (mine.kind === 1) {
      const value = state.ore[mine.to] as number;
      if (value > 0 && myBag.length < BAG) {
        myBag.push(value);
        taken[0] = mine.to;
      }
      if (mine.to === myBase) {
        myScore += sum(myBag);
        myBag.length = 0;
      }
    }
    if (theirs.kind === 1) {
      const value = state.ore[theirs.to] as number;
      if (value > 0 && oppBag.length < BAG) {
        oppBag.push(value);
        taken[1] = theirs.to;
      }
      if (theirs.to === oppBase) {
        oppScore += sum(oppBag);
        oppBag.length = 0;
      }
    }
    // 我鑿的那一格（兩個人鑿同一格，一次 −2；最多扣到 0）。
    const dug: DugCell | null =
      mine.kind === 2
        ? {
            cell: mine.to,
            enter:
              1 +
              Math.max(
                0,
                (state.rock[mine.to] as number) -
                  (theirs.kind === 2 && theirs.to === mine.to ? 2 : 1),
              ),
          }
        : null;
    const here = fieldFrom(state.walls, state.rock, me.cell);
    const field = myPos === me.cell ? here : fieldFrom(state.walls, state.rock, myPos);
    const input: PlanInput = {
      state,
      side,
      field,
      oppField: fieldFrom(state.walls, state.rock, oppPos),
      bagLength: myBag.length,
      oppBagLength: oppBag.length,
      dug,
      taken,
    };
    const pick = chooseTarget(input);
    // 搭便車：這一步走進對手鑿穿的格子、而且是在朝目標前進（導航項比留在原地高）。
    let ride = 0;
    if (mine.kind === 1 && state.opened[mine.to] === other && pick.target >= 0) {
      const stay = chooseTarget({ ...input, field: here });
      if (pick.nav > stay.nav) {
        ride = FREE_RIDE_BONUS * RATE_WEIGHT * pick.rate;
      }
    }
    // 等它鑿穿：對手這一鑿就會鑿穿一格有礦的岩石，而我（走完之後）站在那一格旁邊：下一次走格一起踩進去，各撿一份。
    let wait = 0;
    if (theirs.kind === 2 && myBag.length < BAG) {
      const value = state.ore[theirs.to] as number;
      if (
        value > 0 &&
        (state.rock[theirs.to] as number) <= (mine.kind === 2 && mine.to === theirs.to ? 2 : 1)
      ) {
        const near =
          Math.abs(colOf(myPos) - colOf(theirs.to)) + Math.abs(rowOf(myPos) - rowOf(theirs.to));
        if (near === 1) {
          wait = RIDE_WAIT_PER_VALUE * value;
        }
      }
    }
    // 鑿出來的路是公共財：我鑿的那一格離對手越近（它走得到的週期越少），它越是白白搭我的便車。
    let give = 0;
    if (dug !== null) {
      const theirReach = (input.oppField.cost[dug.cell] as number) ?? FAR;
      give =
        (GIVE_WEIGHT * Math.max(0, GIVE_RANGE - Math.min(theirReach, GIVE_RANGE))) / GIVE_RANGE;
    }
    const myValue = sum(myBag);
    const gain =
      GAIN_PER_POINT * (myScore - oppScore) +
      BAG_WEIGHT * (myValue - sum(oppBag)) +
      pick.nav +
      ride +
      wait -
      give;
    // danger：背著礦卻回不去（背包越值錢、離基地越遠、時間越少越高）；背包是空的沒有東西可以丟。
    let danger = 0;
    if (myBag.length > 0) {
      const homeCost = Math.min(pick.homeCost, 1000);
      const remaining = state.maxTicks - state.tick;
      danger = clamp01(
        Math.max(0, homeCost * MOVE_PERIOD - remaining * 0.8) / 300 +
          (myValue / DANGER_BAG_SCALE) * (homeCost / DANGER_TRIP_SCALE),
      );
    }
    return { gain, danger };
  },
};

// ---------------------------------------------------------------------------
// 目標：去撿哪一顆礦、還是回家
// ---------------------------------------------------------------------------

/** 0 號邊的方向順序：上、右、下、左；1 號邊轉 180 度（下、左、上、右），與兩個起點對稱。 */
const DIRS_FIRST: readonly Dir[] = [0, 1, 2, 3];
const DIRS_SECOND: readonly Dir[] = [2, 3, 0, 1];

const NONE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});

function press(dir: Dir): Buttons {
  return Object.freeze({
    ...NONE,
    up: dir === 0,
    right: dir === 1,
    down: dir === 2,
    left: dir === 3,
  });
}

/** 我這一步在鑿的那一格，與鑿完之後走進它要花的成本（`1 + 剩下的 hp`）。 */
interface DugCell {
  readonly cell: number;
  readonly enter: number;
}

interface PlanInput {
  readonly state: D7State;
  readonly side: Side;
  /** 從我（下一步之後）的位置出發的時間成本圖。 */
  readonly field: Field;
  /** 從對手（下一步之後）的位置出發。 */
  readonly oppField: Field;
  readonly bagLength: number;
  readonly oppBagLength: number;
  /** 我這一步在鑿的那一格（沒有是 null）：鑿完以後經過它的路變便宜。 */
  readonly dug: DugCell | null;
  /** 這一步被我或對手撿走的礦所在的格子（沒有是 −1）。 */
  readonly taken: readonly [number, number];
}

interface Pick {
  /** 目標格（礦所在、或自己的基地）；沒有目標是 −1。 */
  readonly target: number;
  /** 目標是不是回家。 */
  readonly home: boolean;
  /** `gain` 的導航項。 */
  readonly nav: number;
  /** 目標礦的每週期價值（回家時是 0）。 */
  readonly rate: number;
  /** 我到自己基地的時間成本（週期）。 */
  readonly homeCost: number;
}

/**
 * 目標與導航項。礦的 `rate` ＝ 價值 ÷（我到礦的週期 ＋ 礦到我基地的步數 × `TRIP_WEIGHT`）；
 * 每顆礦的分數 `RATE_WEIGHT × rate − 我到礦的週期`，取最高的那顆（每一步都往最高的那顆靠近，所以不會在兩顆礦之間抖動）。
 * 搭便車的外部性：還在岩石裡的礦，如果對手比我早（或同時）站到它旁邊，我鑿穿的那一刻它也踩進去各撿一份，這顆礦對我的價值打 `COPY_DISCOUNT` 折。
 * 躺在空格裡的礦：對手背包有空位而且比我先到，就不去搶（輸定了）；對手鑿開、而它背包滿了或比較遠，加 `RACE_PER_VALUE × 價值`（搶它丟下的）。
 * 背包滿了、或快沒時間了而且背著礦：目標是自己的基地，導航項是「離基地還有幾個週期」的負值。
 * 我這一步在鑿的那一格 `dug`：經過它的路，成本改用「鑿完之後」的（`enter` ＋ 從那一格出發的成本），取較小的。
 */
function chooseTarget(input: PlanInput): Pick {
  const { state, side, field, oppField, dug, taken } = input;
  const other: Side = side === 0 ? 1 : 0;
  const myBase = START_CELLS[side];
  const through = dug === null ? null : fieldFrom(state.walls, state.rock, dug.cell);
  const costOf = (c: number): number => {
    const direct = field.cost[c] as number;
    if (dug === null || through === null) {
      return direct;
    }
    const rest = through.cost[c] as number;
    return rest >= FAR ? direct : Math.min(direct, dug.enter + rest);
  };
  const homeCost = costOf(myBase);
  const remaining = state.maxTicks - state.tick;
  const goHome =
    input.bagLength >= BAG ||
    (input.bagLength > 0 && remaining < LATE_TICKS + MOVE_PERIOD * Math.min(homeCost, 1000));
  if (goHome && homeCost < FAR) {
    return { target: myBase, home: true, nav: -homeCost, rate: 0, homeCost };
  }
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestTarget = -1;
  let bestRate = 0;
  for (let c = 0; c < CELL_COUNT; c += 1) {
    const value = state.ore[c] as number;
    if (value === 0 || c === taken[0] || c === taken[1]) {
      continue;
    }
    const cost = costOf(c);
    if (cost >= FAR) {
      continue;
    }
    const theirCost = oppField.cost[c] as number;
    const theyCan = input.oppBagLength < BAG;
    let worth = value;
    let race = 0;
    let contest = 0;
    if (state.rock[c] === 0) {
      if (theyCan && theirCost < cost) {
        continue;
      }
      if (state.opened[c] === other && (!theyCan || theirCost > cost)) {
        race = RACE_PER_VALUE * value;
      }
    } else if (theyCan && theirCost < FAR) {
      // 還在岩石裡的礦：對手比我早到（`margin` < 0），它自己鑿穿、撿走，我到的時候已經沒了；
      // 差不多同時到（`margin` ≈ 0），我鑿穿的那一刻它也踩進去，各撿一份；我早到就是我的。
      // 時間差 `margin` 在 ±`COPY_SLACK` 個週期之內線性過渡，所以對手在我旁邊的哪一側，會改變我該往哪個方向鑿。
      const margin = theirCost - cost - COPY_LAG;
      const mine = Math.min(1, Math.max(0, 0.5 + margin / (2 * COPY_SLACK)));
      worth = value * (COPY_FLOOR + (1 - COPY_FLOOR) * mine);
      contest = CONTEST_COST * (1 - mine);
    }
    const trip = Math.max(
      1,
      cost +
        TRIP_WEIGHT * (Math.abs(colOf(c) - colOf(myBase)) + Math.abs(rowOf(c) - rowOf(myBase))),
    );
    const rate = worth / trip;
    const score = RATE_WEIGHT * rate - cost + race - contest;
    if (score > bestScore || (score === bestScore && rate > bestRate)) {
      bestScore = score;
      bestTarget = c;
      bestRate = rate;
    }
  }
  if (bestTarget >= 0) {
    return { target: bestTarget, home: false, nav: bestScore, rate: bestRate, homeCost };
  }
  if (input.bagLength > 0 && homeCost < FAR) {
    return { target: myBase, home: true, nav: -homeCost, rate: 0, homeCost };
  }
  return { target: -1, home: false, nav: 0, rate: 0, homeCost };
}
