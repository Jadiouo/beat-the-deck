import { rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  GAIN_PER_POINT,
  MOVE_EVERY,
  START_CELLS,
  WIN_BONUS,
  actionsToward,
  cellX,
  cellY,
  clamp01,
  generateWalls,
  makeBase,
  moveWalker,
  nextCell,
  pressedDir,
  steerWalker,
  stepTarget,
  winnerByScore,
} from '../_diamonds/logic';
import type { BaseOverrides, DiamondsBase, Dir, Walker } from '../_diamonds/logic';

/**
 * D-8 塗地（SPEC 第 9 節一行方向；小規格 `docs/cards/D-8.md`）。
 * 走到的格子變成你的顏色（對手塗過的也能塗回來）；你塗完一格之後，四周「不是你的顏色」的格子連成的一塊，
 * 如果一共 ≤ `POCKET_MAX` 格、而且對手本人不在裡面，整塊歸你（圈地、切斷）。顏色格子多的贏。
 * 地圖、牆、走格的共用邏輯在 `_diamonds/logic.ts`。
 */

/** 圈地的上限：圍起來的一塊最多幾格。 */
export const POCKET_MAX = 40;
/** 剛塗上去的顏色，這麼多個 tick 之內不能被對手塗掉（避免兩個人在相鄰的格子互相塗回來、整場原地打轉）。 */
export const PROTECT_TICKS = 60;
/** 沒有被保護的舊顏色用的時間戳（比任何 tick 都早）。 */
const LONG_AGO = -1_000_000;
/** AI：對手塗過的格子，距離算近這麼多步（切進對手的地盤一步就是 +1/−1，比擴張值錢）。 */
export const OPP_BONUS = -6;
/** AI 的 `gain` 裡，對手少一格算多少格（1 是照實；小於 1 時，塗回對手的格子不比塗沒人塗過的格子值錢太多，AI 不會整場都在互相塗來塗去）。 */
export const OPP_WEIGHT = 0.5;
/** AI 的遠程目標不選離對手這麼近（曼哈頓距離）以內的格子：那一帶是接觸區，貪心型只在經過時順手塗回來，不特地衝過去；精準型也不會因為目標在對手身後而原地等。 */
export const AVOID_RADIUS = 4;
/** AI 的 `danger`：離對手這麼遠（曼哈頓距離）以上，就算沒有接觸的風險。 */
export const CONTACT_SPAN = 6;

/** 一格的顏色：0 沒人塗過、1 人（0 號邊）、2 AI（1 號邊）。 */
export type Paint = 0 | 1 | 2;

export interface D8State extends DiamondsBase {
  /** 長度 `CELLS`，每格的顏色。 */
  readonly paint: readonly number[];
  /** 長度 `CELLS`，每格最後一次換顏色的 tick（沒塗過是很早以前）。 */
  readonly stamp: readonly number[];
  /** 兩邊上一次走格走的方向（0 上、1 右、2 下、3 左；還沒走過或撞牆沒走成是 -1）。只給 AI 的 `evaluate` 用（保持方向）。 */
  readonly heading: readonly [number, number];
}

export interface StateOverrides extends BaseOverrides {
  /** 人（0 號邊）塗過的格子編號。 */
  readonly paint0?: readonly number[];
  /** AI（1 號邊）塗過的格子編號。 */
  readonly paint1?: readonly number[];
  /** 某幾格最後一次換顏色的 tick（[格子編號, tick]）；沒給的格子是「很早以前」，不受保護。 */
  readonly stamps?: readonly (readonly [number, number])[];
}

/** 每一邊的顏色格子數。 */
function countPaint(paint: readonly number[]): [number, number] {
  let a = 0;
  let b = 0;
  for (let i = 0; i < CELLS; i += 1) {
    const p = paint[i];
    if (p === 1) {
      a += 1;
    } else if (p === 2) {
      b += 1;
    }
  }
  return [a, b];
}

/** 測試輔助：預設沒有牆、沒有任何顏色、兩人在起點；`players[i].score` 一律由顏色格子數算出。 */
export function makeState(overrides: StateOverrides = {}): D8State {
  const base = makeBase(overrides);
  const paint = new Array<number>(CELLS).fill(0);
  for (const c of overrides.paint0 ?? []) {
    paint[c] = 1;
  }
  for (const c of overrides.paint1 ?? []) {
    paint[c] = 2;
  }
  const stamp = new Array<number>(CELLS).fill(LONG_AGO);
  for (const [c, t] of overrides.stamps ?? []) {
    stamp[c] = t;
  }
  const [a, b] = countPaint(paint);
  return {
    ...base,
    players: [
      { ...base.players[0], score: a },
      { ...base.players[1], score: b },
    ],
    paint,
    stamp,
    heading: [-1, -1],
  };
}

/** 這一格現在能不能被 `mine` 塗掉：本來是對手的顏色而且還在保護期，不行。 */
function isProtected(
  paint: readonly number[],
  stamp: readonly number[],
  c: number,
  mine: number,
  now: number,
): boolean {
  const p = paint[c];
  return p !== 0 && p !== mine && now - (stamp[c] as number) < PROTECT_TICKS;
}

// ---------------------------------------------------------------------------
// 搜尋用的暫存（每次呼叫都從頭寫，同步用完就丟，所以共用不會互相影響）
// ---------------------------------------------------------------------------

/**
 * 每一格往四個方向的鄰格（沒有路是 -1），依牆陣列快取：同一張牆只算一次。搜尋最內圈就不用一直呼叫 `stepTarget`。
 * 回傳的陣列是共用的，呼叫端只能讀。
 */
const NEIGHBORS = new WeakMap<readonly number[], Int16Array>();
function neighborTable(walls: readonly number[]): Int16Array {
  let table = NEIGHBORS.get(walls);
  if (table === undefined) {
    table = new Int16Array(CELLS * 4);
    for (let c = 0; c < CELLS; c += 1) {
      for (let d = 0; d < 4; d += 1) {
        const n = stepTarget(walls, c, d as Dir);
        table[c * 4 + d] = n === c ? -1 : n;
      }
    }
    NEIGHBORS.set(walls, table);
  }
  return table;
}

const QUEUE = new Int32Array(CELLS);
const MARK = new Int32Array(CELLS);
const DIST = new Int32Array(CELLS);
let markId = 0;

function nextMark(): number {
  markId += 1;
  if (markId > 2_000_000_000) {
    MARK.fill(0);
    markId = 1;
  }
  return markId;
}

/**
 * 圈地：`owner` 剛塗完 `from` 之後，看 `from` 四周「不是 owner 的顏色、不是牆」的格子，
 * 各自往外連成一塊（只走不是 owner 的顏色、不是牆的格子）；一共 ≤ POCKET_MAX 格、而且不含 `opponentCell` 的，整塊回傳。
 * 超過 POCKET_MAX 就停（成本最多約 4 × 41 步）。
 */
export function pocketsAround(
  walls: readonly number[],
  paint: readonly number[],
  owner: number,
  from: number,
  opponentCell: number,
): number[] {
  const out: number[] = [];
  const near = neighborTable(walls);
  const claimed = nextMark();
  for (let d = 0; d < 4; d += 1) {
    const start = near[from * 4 + d] as number;
    if (start < 0 || paint[start] === owner || MARK[start] === claimed) {
      continue;
    }
    const id = nextMark();
    let head = 0;
    let tail = 0;
    QUEUE[tail] = start;
    tail += 1;
    MARK[start] = id;
    let big = false;
    let hasOpponent = false;
    while (head < tail) {
      const c = QUEUE[head] as number;
      head += 1;
      if (c === opponentCell) {
        hasOpponent = true;
      }
      for (let e = 0; e < 4; e += 1) {
        const n = near[c * 4 + e] as number;
        if (n >= 0 && paint[n] !== owner && MARK[n] !== id) {
          if (tail >= POCKET_MAX) {
            big = true;
            break;
          }
          MARK[n] = id;
          QUEUE[tail] = n;
          tail += 1;
        }
      }
      if (big) {
        break;
      }
    }
    if (!big && !hasOpponent) {
      for (let i = 0; i < tail; i += 1) {
        const c = QUEUE[i] as number;
        out.push(c);
        MARK[c] = claimed; // 這一塊已經算過，別的鄰格走到它不要重複
      }
    }
  }
  return out;
}

/** 離 `from` 最近的「不是 mine 的顏色」的格子：沒人塗過的（`unpainted`）與對手的（`opponent`）各一個，距離是繞牆的步數。 */
function nearestTargets(
  walls: readonly number[],
  paint: readonly number[],
  stamp: readonly number[],
  mine: number,
  from: number,
  now: number,
  avoid: number,
): { unpaintedDist: number; unpaintedCell: number; opponentDist: number; opponentCell: number } {
  const near = neighborTable(walls);
  const id = nextMark();
  let head = 0;
  let tail = 0;
  QUEUE[tail] = from;
  tail += 1;
  MARK[from] = id;
  DIST[from] = 0;
  let unpaintedDist = -1;
  let unpaintedCell = -1;
  let opponentDist = -1;
  let opponentCell = -1;
  let stopAt = Number.POSITIVE_INFINITY;
  while (head < tail) {
    const c = QUEUE[head] as number;
    head += 1;
    const d = DIST[c] as number;
    if (d > stopAt) {
      break;
    }
    const p = paint[c];
    if (
      p !== mine &&
      !isProtected(paint, stamp, c, mine, now) &&
      manhattan(c, avoid) > AVOID_RADIUS
    ) {
      if (p === 0 && unpaintedDist < 0) {
        unpaintedDist = d;
        unpaintedCell = c;
      } else if (p !== 0 && opponentDist < 0) {
        opponentDist = d;
        opponentCell = c;
      }
      if (stopAt === Number.POSITIVE_INFINITY) {
        stopAt = d + Math.abs(OPP_BONUS) + 1; // 另一種再近也不會近過這個範圍
      }
      if (unpaintedDist >= 0 && opponentDist >= 0) {
        break;
      }
    }
    for (let e = 0; e < 4; e += 1) {
      const n = near[c * 4 + e] as number;
      if (n >= 0 && MARK[n] !== id) {
        MARK[n] = id;
        DIST[n] = d + 1;
        QUEUE[tail] = n;
        tail += 1;
      }
    }
  }
  return { unpaintedDist, unpaintedCell, opponentDist, opponentCell };
}

/** 兩種目標合起來看，哪一個比較近（對手的格子算近 OPP_BONUS 步）；沒有任何目標回 null。 */
function pickTarget(t: ReturnType<typeof nearestTargets>): { cell: number; term: number } | null {
  const u = t.unpaintedDist >= 0 ? t.unpaintedDist : Number.POSITIVE_INFINITY;
  const o = t.opponentDist >= 0 ? t.opponentDist - OPP_BONUS : Number.POSITIVE_INFINITY;
  if (u === Number.POSITIVE_INFINITY && o === Number.POSITIVE_INFINITY) {
    return null;
  }
  return o < u
    ? { cell: t.opponentCell, term: Math.max(0, o) }
    : { cell: t.unpaintedCell, term: u };
}

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

// ---------------------------------------------------------------------------
// 遊戲
// ---------------------------------------------------------------------------

/**
 * 轉向：同 `steerWalker`（走格之間最後按的方向算），但不能直接掉頭：按的方向跟上一次走格的方向相反就當作沒按。
 * （要掉頭得先轉 90 度。上一次沒走成、也就是撞牆或還沒走過，不受限制，所以死巷走得出來。）
 */
function steerAhead(walker: Walker, buttons: Buttons, heading: number): Walker {
  const pressed = pressedDir(buttons);
  if (pressed >= 0 && heading >= 0 && pressed === (heading + 2) % 4) {
    return walker;
  }
  return steerWalker(walker, buttons);
}

export const d8Game: Game<D8State> = {
  id: 'D-8',

  init(seed: number, config: GameConfig): D8State {
    const walls = generateWalls(seed).walls;
    const paint = new Array<number>(CELLS).fill(0);
    paint[START_CELLS[0]] = 1;
    paint[START_CELLS[1]] = 2;
    const stamp = new Array<number>(CELLS).fill(LONG_AGO);
    stamp[START_CELLS[0]] = 0;
    stamp[START_CELLS[1]] = 0;
    return {
      tick: 0,
      maxTicks: config.maxTicks,
      walls,
      players: [
        { cell: START_CELLS[0], pending: -1, score: 1 },
        { cell: START_CELLS[1], pending: -1, score: 1 },
      ],
      rng: rngStateFor(seed, 'paint'),
      over: false,
      winner: null,
      paint,
      stamp,
      heading: [-1, -1],
    };
  },

  step(state: D8State, inputs: Inputs): D8State {
    if (state.over) {
      return state;
    }
    const tick = state.tick + 1;
    let players: readonly [Walker, Walker] = [
      steerAhead(state.players[0], inputs[0], state.heading[0]),
      steerAhead(state.players[1], inputs[1], state.heading[1]),
    ];
    let paint = state.paint;
    let stamp = state.stamp;

    let heading = state.heading;
    if (tick % MOVE_EVERY === 0) {
      const before = players;
      players = [moveWalker(state.walls, players[0]), moveWalker(state.walls, players[1])];
      heading = [
        players[0].cell === before[0].cell ? -1 : before[0].pending,
        players[1].cell === before[1].cell ? -1 : before[1].pending,
      ];
      const c0 = players[0].cell;
      const c1 = players[1].cell;
      const next = state.paint.slice();
      const nextStamp = state.stamp.slice();
      const meet = c0 === c1;
      // 塗色：同一格誰也不塗；對手剛塗上去、還在保護期的格子塗不掉；自己的顏色不變、也不重新計時。
      if (!meet) {
        for (const side of [0, 1] as const) {
          const c = side === 0 ? c0 : c1;
          const mine = side + 1;
          if (next[c] !== mine && !isProtected(state.paint, state.stamp, c, mine, tick)) {
            next[c] = mine;
            nextStamp[c] = tick;
          }
        }
      }
      // 圈地：兩邊都用塗完之後的快照各自算，再同時套用；兩邊都圈到同一格就維持原狀。
      const caught0 = meet ? [] : pocketsAround(state.walls, next, 1, c0, c1);
      const caught1 = meet ? [] : pocketsAround(state.walls, next, 2, c1, c0);
      if (caught0.length > 0 || caught1.length > 0) {
        const first = new Set<number>(caught0);
        const shared = new Set<number>();
        for (const c of caught1) {
          if (first.has(c)) {
            shared.add(c);
          }
        }
        for (const c of caught0) {
          if (!shared.has(c)) {
            next[c] = 1;
            nextStamp[c] = tick;
          }
        }
        for (const c of caught1) {
          if (!shared.has(c)) {
            next[c] = 2;
            nextStamp[c] = tick;
          }
        }
      }
      paint = next;
      stamp = nextStamp;
      const [a, b] = countPaint(paint);
      players = [
        { ...players[0], score: a },
        { ...players[1], score: b },
      ];
    }

    const over = tick >= state.maxTicks;
    return {
      ...state,
      tick,
      players,
      paint,
      stamp,
      heading,
      over,
      winner: over ? winnerByScore(players) : null,
    };
  },

  isOver(state: D8State): boolean {
    return state.over;
  },

  score(state: D8State): readonly [number, number] {
    return [state.players[0].score, state.players[1].score];
  },

  winner(state: D8State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: D8State, side: Side): readonly Buttons[] {
    const me = state.players[side];
    const mine = side + 1;
    // 目標從「已鎖定的下一步走完之後的格子」找（目標不會跟著按鍵跳來跳去）；方向卻要從「現在的格子」排：
    // 走格的那一刻按了哪個方向，就是從現在的格子往那個方向走一格。（前一版連方向也從鎖定後的格子排，
    // 鎖定往右時排最前面的常是現在走不動的方向；搜尋型每個走格週期最後一下按到它，整場站在上緣原地不動。）
    const planned: Walker = { ...me, cell: nextCell(state.walls, me) };
    const target = pickTarget(
      nearestTargets(
        state.walls,
        state.paint,
        state.stamp,
        mine,
        planned.cell,
        state.tick,
        state.players[side === 0 ? 1 : 0].cell,
      ),
    );
    return actionsToward(state.walls, me, side, target === null ? null : target.cell);
  },

  evaluate(state: D8State, side: Side): { gain: number; danger: number } {
    const other: Side = side === 0 ? 1 : 0;
    const me = state.players[side];
    const opponent = state.players[other];
    if (state.over) {
      const difference = me.score - opponent.score;
      const sign = difference === 0 ? 0 : difference > 0 ? 1 : -1;
      return { gain: GAIN_PER_POINT * difference + sign * WIN_BONUS, danger: 0 };
    }
    const mine = side + 1;
    const theirs = other + 1;
    const myNext = nextCell(state.walls, me);
    const oppNext = nextCell(state.walls, opponent);
    let myCount = me.score;
    let oppCount = opponent.score;
    let paint: readonly number[] = state.paint;
    // 下一步就是走格的結算：我走進的那一格（對手不也走進同一格）變成我的顏色，圈到的一塊也算。
    if (
      myNext !== me.cell &&
      myNext !== oppNext &&
      paint[myNext] !== mine &&
      !isProtected(paint, state.stamp, myNext, mine, state.tick)
    ) {
      const virtual = paint.slice();
      if (virtual[myNext] === theirs) {
        oppCount -= 1;
      }
      myCount += 1;
      virtual[myNext] = mine;
      for (const c of pocketsAround(state.walls, virtual, mine, myNext, oppNext)) {
        if (virtual[c] === theirs) {
          oppCount -= 1;
        }
        if (virtual[c] !== mine) {
          myCount += 1;
          virtual[c] = mine;
        }
      }
      paint = virtual;
    }
    const target = pickTarget(
      nearestTargets(state.walls, paint, state.stamp, mine, myNext, state.tick, oppNext),
    );
    const gain =
      GAIN_PER_POINT * (myCount - OPP_WEIGHT * oppCount) - (target === null ? 0 : target.term);
    // danger：接觸的風險。我下一步的格子離對手越近，我塗的地越容易被塗回來。
    const danger = clamp01(1 - manhattan(myNext, oppNext) / CONTACT_SPAN);
    return { gain, danger };
  },
};
