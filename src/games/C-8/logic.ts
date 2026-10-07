import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  HEIGHT,
  LEFT,
  RIGHT,
  WIDTH,
  cell,
  cellX,
  cellY,
  steerSnake,
  winnerByScore,
} from '../_clubs/logic';
import type { ClubsState, Dir, Snake } from '../_clubs/logic';

/**
 * C-8 光軌（SPEC 第 9 節；小規格 `docs/cards/C-8.md`）。
 *
 * 兩條蛇都在身後留下永遠不消失的軌跡（蛇身只會變長），先撞到牆、撞到任何軌跡的輸這一局，一局接一局打滿 60 秒，
 * 贏的局數多的贏。格子、轉向沿用梅花共同設定；走格與碰撞自己寫（沒有尾巴豁免，同一個 tick 兩條都出局是平手）。
 *
 * `evaluate` 的 `gain` 是領地差（全場的曼哈頓分界，加上自己周圍還有多少空格），`danger` 是「快撞上去、被關進小區域、
 * 與對方蛇頭太近」：兩個數字刻意分開，四個性格才會真的不一樣。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 蛇每幾個 tick 走一格（比梅花共同設定的 6 慢：光軌的對撞很快，慢一點才有時間看軌跡、決定怎麼逼對手）。 */
export const MOVE_TICKS = 10;
/** 每一局開始前不動的 tick 數（可以先轉向，AI 也先看到新的局面）。 */
export const GRACE_TICKS = 30;
/** 一局結束後畫面停住的 tick 數（`maxTicks` 很小時縮短）。 */
export const PAUSE_TICKS = 40;
/** 一局最多幾個 tick（不含開局的不動時間）；到了沒人出局就比地盤（`territoryOutcome`）。 */
export const ROUND_TICKS = 720;
/** 起始位置離牆至少這麼多格。 */
export const START_MARGIN = 5;
/** 兩條蛇起始的蛇頭，曼哈頓距離至少這麼遠。 */
export const MIN_START_GAP = 18;
/** 算「附近的空間」的範圍：以蛇頭下一步為中心，切比雪夫距離這麼多格以內。 */
export const TERRITORY_RADIUS = 3;
/** 全場領地差（不看軌跡、只比曼哈頓距離，每隔一格取樣一次）的權重。 */
export const GLOBAL_WEIGHT = 1;
/** 洪水填充數到幾格就停：不到這麼多格就算「被關進小區域」。 */
export const ROOM_CAP = 40;
/** 被關進小區域時 danger 的最大值。 */
export const TRAP_DANGER = 0.9;
/** 對方鎖定的下一步與我的下一步同一格（頭對頭）的 danger。 */
export const HEAD_ON_DANGER = 0.8;
/** 對方的蛇頭離我的下一步 d 格（曼哈頓距離，d 從 1 算起）時的 danger。 */
export const NEAR_HEAD_DANGER: readonly number[] = [0.5, 0.25];
/** 沿著鎖定的轉向往前看幾格有沒有牆或軌跡；越短越危險：`FRONT_DANGER × (1 − 格數 / 這個數)²`。 */
export const FRONT_LOOK = 10;
export const FRONT_DANGER = 0.7;
/** 轉彎的小額扣分：剛轉過彎、或已經鎖定了下一次的轉向，`gain` 扣這麼多（打平時優先直走，不然兩個 AI 會走成鋸齒）。 */
export const TURN_PENALTY = 20;
/** 下一步就會出局的 gain（比任何領地差都低）。 */
export const CRASH_GAIN = 500;
/** 一局結束時評估的加減分。 */
export const ROUND_BONUS = 10_000;
/** 直線往前看幾格，決定兩個轉向哪一個排前面。 */
const RUN_LOOK = 30;

/** 剛結束的那一局誰贏。 */
export type RoundOutcome = 'side0' | 'side1' | 'draw';

export interface C8State extends ClubsState {
  /** 現在是第幾局（0 起算，沒有上限：60 秒內一局接一局）。 */
  readonly round: number;
  /** 這一局已經走了幾個 tick；開局的不動時間是負數，從 `-GRACE_TICKS` 數到 0。 */
  readonly roundTick: number;
  /** 一局最多幾個 tick（不含開局的不動時間）。 */
  readonly roundTicks: number;
  /** 一局結束後停住的剩餘 tick 數；大於 0 表示整個畫面凍結。 */
  readonly pause: number;
  readonly pauseTicks: number;
  /** 剛結束的那一局誰贏（平手是 'draw'）；局進行中是 null。 */
  readonly outcome: RoundOutcome | null;
}

const DX: readonly number[] = [0, 1, 0, -1];
const DY: readonly number[] = [-1, 0, 1, 0];

/** 從格子 `index` 往 `dir` 走一格；走出地圖是 -1。 */
function neighbor(index: number, dir: Dir): number {
  const x = cellX(index) + (DX[dir] as number);
  const y = cellY(index) + (DY[dir] as number);
  return x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT ? -1 : cell(x, y);
}

function opposite(dir: Dir): Dir {
  return ((dir + 2) % 4) as Dir;
}

function other(side: Side): Side {
  return side === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 起始位置與每一局的開頭
// ---------------------------------------------------------------------------

interface Spawn {
  readonly head: number;
  readonly dir: Dir;
}

/** 從亂數狀態抽人的起始位置與方向；AI 是把它轉 180 度，所以兩邊遇到的局面等價。 */
function drawSpawn(rng: RngState): { spawn: Spawn; rng: RngState } {
  let state = rng;
  const draw = (n: number): number => {
    const [value, next] = intFrom(state, n);
    state = next;
    return value;
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const x = START_MARGIN + draw(WIDTH - 2 * START_MARGIN);
    const y = START_MARGIN + draw(HEIGHT - 2 * START_MARGIN);
    const dir = draw(4) as Dir;
    if (Math.abs(WIDTH - 1 - 2 * x) + Math.abs(HEIGHT - 1 - 2 * y) >= MIN_START_GAP) {
      return { spawn: { head: cell(x, y), dir }, rng: state };
    }
  }
  return { spawn: { head: cell(6, 12), dir: RIGHT }, rng: state };
}

function freshSnake(head: number, dir: Dir, score: number): Snake {
  return { body: [head], dir, turn: dir, alive: true, score };
}

function startRound(state: C8State, round: number): C8State {
  const drawn = drawSpawn(state.rng);
  const { head, dir } = drawn.spawn;
  return {
    ...state,
    round,
    roundTick: -GRACE_TICKS,
    pause: 0,
    outcome: null,
    rng: drawn.rng,
    snakes: [
      freshSnake(head, dir, state.snakes[0].score),
      freshSnake(CELLS - 1 - head, opposite(dir), state.snakes[1].score),
    ],
  };
}

/** 兩局之間的停頓（`maxTicks` 很小時縮短）。 */
function pauseFor(maxTicks: number): number {
  return Math.min(PAUSE_TICKS, Math.floor(maxTicks / 40));
}

export function initC8State(seed: number, config: GameConfig): C8State {
  if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks < 200) {
    throw new RangeError(`config.maxTicks 必須是 200 以上的整數，收到 ${String(config.maxTicks)}`);
  }
  const blank: C8State = {
    tick: 0,
    maxTicks: config.maxTicks,
    snakes: [freshSnake(0, RIGHT, 0), freshSnake(0, LEFT, 0)],
    foods: [],
    rng: rngStateFor(seed, 'spawn'),
    over: false,
    winner: null,
    round: 0,
    roundTick: -GRACE_TICKS,
    roundTicks: ROUND_TICKS,
    pause: 0,
    pauseTicks: pauseFor(config.maxTicks),
    outcome: null,
  };
  return startRound(blank, 0);
}

// ---------------------------------------------------------------------------
// 暫存格子表（評估一次要在微秒內完成，搜尋型一次決策會呼叫上百次，所以不每次配置）
// ---------------------------------------------------------------------------

const blockedStamp = new Uint32Array(CELLS);
const seenRoom = new Uint32Array(CELLS);
const queueRoom = new Int16Array(CELLS);
const columnGap = new Int8Array(WIDTH);
let blockedGeneration = 0;
let scanGeneration = 0;
let cachedFirst: readonly number[] | null = null;
let cachedSecond: readonly number[] | null = null;

/**
 * 兩條蛇的全部軌跡都是牆；回傳這一次的世代。軌跡陣列沒有變（搜尋型在同一個走格週期裡會呼叫上百次）就不重蓋章：
 * 結果只由兩個陣列的內容決定（陣列從不被改動），與呼叫過幾次無關。
 */
function stampBlocked(first: readonly number[], second: readonly number[]): number {
  if (first === cachedFirst && second === cachedSecond) {
    return blockedGeneration;
  }
  blockedGeneration += 1;
  for (const c of first) {
    blockedStamp[c] = blockedGeneration;
  }
  for (const c of second) {
    blockedStamp[c] = blockedGeneration;
  }
  cachedFirst = first;
  cachedSecond = second;
  return blockedGeneration;
}

// ---------------------------------------------------------------------------
// 一個 tick
// ---------------------------------------------------------------------------

/**
 * 走一個 tick。順序：
 * 1. 兩局之間的停頓：只倒數，倒數完開始下一局（重新抽起始位置）。
 * 2. 讀兩邊的輸入鎖定轉向（開局的不動時間也可以轉向）。
 * 3. 每 `MOVE_TICKS` 個 tick 兩條蛇同時走一格：新蛇頭走出地圖、走進任何一條蛇的任何一格、或兩個新蛇頭同一格就出局。
 *    沒有尾巴豁免。兩條都出局：平手。出局的蛇停在原地，另一條照樣走進它的新格子。
 * 4. 沒人出局而 `roundTick` 到上限：比地盤，大的贏、一樣大平手（見 `territoryOutcome`）。
 * 5. 一局結束：贏的人加 1 分，停頓之後下一局。
 * 6. 整場是 `maxTicks`（60 秒）：到了就結束，進行到一半的那一局不算分；贏的局數多的贏，同分平手。
 */
export function stepC8(state: C8State, inputs: Inputs): C8State {
  if (state.over) {
    return state;
  }
  const next = advance(state, inputs);
  if (next.tick >= next.maxTicks) {
    return { ...next, over: true, winner: winnerByScore(next.snakes) };
  }
  return next;
}

/**
 * 時間到時誰贏這一局：從兩個蛇頭同時往外一圈一圈走（軌跡擋路），先走到的格子算誰的地盤（同時到的不算），地盤大的贏，一樣大是平手。
 * 一局只算一次，所以直接用新配置的陣列，不用共用的暫存格子表。
 */
export function territoryOutcome(snakes: readonly [Snake, Snake]): RoundOutcome {
  const owner = new Int8Array(CELLS).fill(-1);
  const blocked = new Uint8Array(CELLS);
  for (const snake of snakes) {
    for (const c of snake.body) {
      blocked[c] = 1;
    }
  }
  let frontier: number[][] = [[], []];
  const count = [0, 0];
  for (const i of [0, 1] as const) {
    const head = snakes[i].body[0] as number;
    owner[head] = i;
    frontier[i] = [head];
  }
  while ((frontier[0] as number[]).length + (frontier[1] as number[]).length > 0) {
    const claims = new Map<number, number>();
    for (const i of [0, 1] as const) {
      for (const at of frontier[i] as number[]) {
        for (let dir = 0; dir < 4; dir += 1) {
          const next = neighbor(at, dir as Dir);
          if (next !== -1 && blocked[next] === 0 && owner[next] === -1) {
            claims.set(next, claims.has(next) && claims.get(next) !== i ? 2 : i);
          }
        }
      }
    }
    const grown: number[][] = [[], []];
    for (const [c, who] of claims) {
      owner[c] = who === 2 ? -2 : who;
      if (who !== 2) {
        count[who] = (count[who] as number) + 1;
        (grown[who] as number[]).push(c);
      }
    }
    frontier = grown;
  }
  const a = count[0] as number;
  const b = count[1] as number;
  return a === b ? 'draw' : a > b ? 'side0' : 'side1';
}

function advance(state: C8State, inputs: Inputs): C8State {
  const tick = state.tick + 1;

  if (state.pause > 0) {
    const pause = state.pause - 1;
    return pause > 0
      ? { ...state, tick, pause }
      : startRound({ ...state, tick, pause: 0 }, state.round + 1);
  }

  const roundTick = state.roundTick + 1;
  let snakes: readonly [Snake, Snake] = [
    steerSnake(state.snakes[0], inputs[0]),
    steerSnake(state.snakes[1], inputs[1]),
  ];
  let outcome: RoundOutcome | null = null;

  if (roundTick > 0 && roundTick % MOVE_TICKS === 0) {
    const heads = [
      neighbor(snakes[0].body[0] as number, snakes[0].turn),
      neighbor(snakes[1].body[0] as number, snakes[1].turn),
    ] as const;
    const gen = stampBlocked(snakes[0].body, snakes[1].body);
    const crashed = ([0, 1] as const).map(
      (i) => heads[i] === -1 || blockedStamp[heads[i]] === gen || heads[0] === heads[1],
    ) as [boolean, boolean];
    snakes = ([0, 1] as const).map((i): Snake => {
      const snake = snakes[i];
      return crashed[i]
        ? { ...snake, alive: false }
        : { ...snake, body: [heads[i], ...snake.body], dir: snake.turn };
    }) as [Snake, Snake];
    if (crashed[0] && crashed[1]) {
      outcome = 'draw';
    } else if (crashed[0] || crashed[1]) {
      outcome = crashed[0] ? 'side1' : 'side0';
    }
  }
  if (outcome === null && roundTick >= state.roundTicks) {
    outcome = territoryOutcome(snakes);
  }

  if (outcome === null) {
    return { ...state, tick, roundTick, snakes };
  }

  const scored: readonly [Snake, Snake] = [
    outcome === 'side0' ? { ...snakes[0], score: snakes[0].score + 1 } : snakes[0],
    outcome === 'side1' ? { ...snakes[1], score: snakes[1].score + 1 } : snakes[1],
  ];
  const ended: C8State = { ...state, tick, roundTick, snakes: scored, outcome };
  return state.pauseTicks > 0
    ? { ...ended, pause: state.pauseTicks }
    : startRound({ ...ended, outcome: null }, state.round + 1);
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

/** 一局結束、整場結束、兩局之間的停頓：畫面凍結，沒有動作可選。 */
function frozen(state: C8State): boolean {
  return state.over || state.pause > 0 || state.outcome !== null;
}

/** 從格子 `at` 沿著 `dir` 直走，連續幾格是空的（最多看 `RUN_LOOK` 格）。 */
function runLength(gen: number, at: number, dir: Dir): number {
  let run = 0;
  let cursor = at;
  while (run < RUN_LOOK) {
    cursor = neighbor(cursor, dir);
    if (cursor === -1 || blockedStamp[cursor] === gen) {
      break;
    }
    run += 1;
  }
  return run;
}

/** 以 `at` 為中心、`TERRITORY_RADIUS` 格以內（切比雪夫距離）還有幾格是空的。 */
function openCells(gen: number, at: number): number {
  const x0 = cellX(at);
  const y0 = cellY(at);
  const yEnd = Math.min(HEIGHT - 1, y0 + TERRITORY_RADIUS);
  const xEnd = Math.min(WIDTH - 1, x0 + TERRITORY_RADIUS);
  let count = 0;
  for (let y = Math.max(0, y0 - TERRITORY_RADIUS); y <= yEnd; y += 1) {
    for (let x = Math.max(0, x0 - TERRITORY_RADIUS); x <= xEnd; x += 1) {
      if (blockedStamp[y * WIDTH + x] !== gen) {
        count += 1;
      }
    }
  }
  return count;
}

/** 洪水填充：從 `start` 出發能走到幾格（含 `start`），數到 `cap` 就停；`blockedExtra` 這一格也擋路。 */
function room(gen: number, scan: number, start: number, blockedExtra: number, cap: number): number {
  let head = 0;
  let tail = 1;
  queueRoom[0] = start;
  seenRoom[start] = scan;
  while (head < tail && tail < cap) {
    const current = queueRoom[head] as number;
    head += 1;
    const x = cellX(current);
    const y = cellY(current);
    for (let dir = 0; dir < 4; dir += 1) {
      const nx = x + (DX[dir] as number);
      const ny = y + (DY[dir] as number);
      if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) {
        continue;
      }
      const next = cell(nx, ny);
      if (seenRoom[next] !== scan && blockedStamp[next] !== gen && next !== blockedExtra) {
        seenRoom[next] = scan;
        queueRoom[tail] = next;
        tail += 1;
      }
    }
  }
  return Math.min(tail, cap);
}

/** 蛇「正在轉彎」就是 `TURN_PENALTY`：鎖定的轉向與目前方向不同，或最後一步相對前一步轉了彎。 */
function turnPenalty(snake: Snake): number {
  if (snake.turn !== snake.dir) {
    return TURN_PENALTY;
  }
  const [a, b, c] = snake.body;
  if (a === undefined || b === undefined || c === undefined) {
    return 0;
  }
  const lastStep = a - b;
  const stepBefore = b - c;
  return lastStep === stepBefore ? 0 : TURN_PENALTY;
}

function evaluateEnded(state: C8State, side: Side): { gain: number; danger: number } {
  const winner =
    state.over || state.outcome === null
      ? state.winner
      : state.outcome === 'draw'
        ? null
        : state.outcome === 'side0'
          ? 0
          : 1;
  const sign = winner === null ? 0 : winner === side ? 1 : -1;
  return { gain: sign * ROUND_BONUS, danger: state.snakes[side].alive ? 0 : 1 };
}

/**
 * `gain` = 領地差：全場有多少格離我的下一步比離對方的下一步近（曼哈頓距離，不看軌跡，每隔一格取樣）減去反過來的格數，
 * 再加上「我下一步周圍 7×7 還有幾格是空的」減去對方的；下一步就出局：`gain = −500`、`danger = 1`。
 * `danger` 取最大的：頭對頭 0.8、對方蛇頭離我的下一步 1 或 2 格（0.5、0.25）、
 * 前方 10 格內有牆或軌跡（`0.7 × (1 − 格數 / 10)²`）、被關進小區域（洪水填充不到 40 格：`0.9 × (1 − 格數 / 40)`）。
 * 兩邊贏的局數不進評估（沒有橡皮筋）。
 */
function evaluateTron(state: C8State, side: Side): { gain: number; danger: number } {
  const me = state.snakes[side];
  const them = state.snakes[other(side)];
  const next = neighbor(me.body[0] as number, me.turn);
  const gen = stampBlocked(state.snakes[0].body, state.snakes[1].body);
  if (next === -1 || blockedStamp[next] === gen) {
    return { gain: -CRASH_GAIN, danger: 1 };
  }
  scanGeneration += 1;
  const scan = scanGeneration;
  const theirNext = them.alive ? neighbor(them.body[0] as number, them.turn) : -1;
  const theirsValid = theirNext !== -1 && blockedStamp[theirNext] !== gen;

  // 附近的空間：中心周圍的方形範圍裡還有幾格是空的（走出地圖、軌跡都不算）。我的與對方的相減，離牆、離軌跡越近越少。
  const mine = openCells(gen, next);
  const theirs = theirsValid ? openCells(gen, theirNext) : 0;

  // 全場的領地（不看軌跡，只比曼哈頓距離）：對方在哪裡，整張地圖的分界就跟著動。
  // 每一欄的 `|x − 我| − |x − 對方|` 先算好，每一列再跟「兩邊離這一列的距離差」比。
  let global = 0;
  if (theirsValid) {
    const mx = cellX(next);
    const my = cellY(next);
    const tx = cellX(theirNext);
    const ty = cellY(theirNext);
    for (let x = 0; x < WIDTH; x += 2) {
      columnGap[x] = Math.abs(x - mx) - Math.abs(x - tx);
    }
    for (let y = 0; y < HEIGHT; y += 2) {
      // 這一格算我的：|x − mx| + |y − my| < |x − tx| + |y − ty|，即 columnGap[x] < rowGap
      const rowGap = Math.abs(y - ty) - Math.abs(y - my);
      for (let x = 0; x < WIDTH; x += 2) {
        const gap = columnGap[x] as number;
        global += gap < rowGap ? 1 : gap > rowGap ? -1 : 0;
      }
    }
  }

  let danger = 0;
  if (theirsValid) {
    if (theirNext === next) {
      danger = HEAD_ON_DANGER;
    } else {
      const gap =
        Math.abs(cellX(theirNext) - cellX(next)) + Math.abs(cellY(theirNext) - cellY(next));
      danger = NEAR_HEAD_DANGER[gap - 1] ?? 0;
    }
  }
  const run = Math.min(runLength(gen, next, me.turn), FRONT_LOOK);
  if (run < FRONT_LOOK) {
    danger = Math.max(danger, FRONT_DANGER * (1 - run / FRONT_LOOK) ** 2);
  }
  const space = room(gen, scan, next, theirsValid ? theirNext : -1, ROOM_CAP);
  if (space < ROOM_CAP) {
    danger = Math.max(danger, TRAP_DANGER * (1 - space / ROOM_CAP));
  }
  return { gain: GLOBAL_WEIGHT * global + (mine - theirs) - turnPenalty(me), danger };
}

export const c8Game: Game<C8State> = {
  id: 'C-8',

  init(seed: number, config: GameConfig): C8State {
    return initC8State(seed, config);
  },

  step(state: C8State, inputs: Inputs): C8State {
    return stepC8(state, inputs);
  },

  isOver(state: C8State): boolean {
    return state.over;
  },

  /** 兩邊贏的局數。 */
  score(state: C8State): readonly [number, number] {
    return [state.snakes[0].score, state.snakes[1].score];
  },

  winner(state: C8State): Side | null {
    return state.over ? state.winner : null;
  },

  /**
   * 還沒鎖定轉向：較空的那一邊的轉向、另一邊的轉向、全放開（轉向排前面，搜尋型才不會拖延到走格前最後一刻，
   * 理由同 `docs/cards/C-A.md` 決定 12）。已鎖定或畫面凍結：只有全放開（其他按鍵都被忽略）。
   */
  actions(state: C8State, side: Side): readonly Buttons[] {
    const me = state.snakes[side];
    if (frozen(state) || !me.alive || me.turn !== me.dir) {
      return FROZEN_ACTIONS;
    }
    const gen = stampBlocked(state.snakes[0].body, state.snakes[1].body);
    const at = me.body[0] as number;
    const clockwise = ((me.dir + 1) % 4) as Dir;
    const anticlockwise = ((me.dir + 3) % 4) as Dir;
    const first =
      runLength(gen, at, anticlockwise) > runLength(gen, at, clockwise) ? anticlockwise : clockwise;
    const second = first === clockwise ? anticlockwise : clockwise;
    return [PRESS[first] as Buttons, PRESS[second] as Buttons, NONE];
  },

  evaluate(state: C8State, side: Side): { gain: number; danger: number } {
    return frozen(state) ? evaluateEnded(state, side) : evaluateTron(state, side);
  },
};

// ---------------------------------------------------------------------------
// 測試輔助
// ---------------------------------------------------------------------------

export interface C8Overrides {
  readonly round?: number;
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly roundTick?: number;
  readonly pause?: number;
  /** 兩條蛇各自要覆蓋的欄位；沒給的欄位用預設，`turn` 沒給就等於 `dir`。 */
  readonly snakes?: readonly [Partial<Snake>?, Partial<Snake>?];
  readonly outcome?: RoundOutcome | null;
  readonly over?: boolean;
  readonly winner?: Side | null;
  readonly rng?: RngState;
}

/**
 * 直接構造一個局面。預設：第一局，已經過了開局的不動時間（`roundTick` 0），
 * 人的蛇頭 (8,12) 往右、AI 的蛇頭 (23,11) 往左（兩者 180 度對稱），各只有 1 格，兩邊分數 0。
 */
export function makeState(overrides: C8Overrides = {}): C8State {
  const maxTicks = overrides.maxTicks ?? 3600;
  const base: readonly [Snake, Snake] = [
    freshSnake(cell(8, 12), RIGHT, 0),
    freshSnake(cell(23, 11), LEFT, 0),
  ];
  const pick = (i: 0 | 1): Snake => {
    const patch = overrides.snakes?.[i] ?? {};
    const merged = { ...base[i], ...patch };
    return { ...merged, turn: patch.turn ?? merged.dir };
  };
  return {
    tick: overrides.tick ?? 0,
    maxTicks,
    snakes: [pick(0), pick(1)],
    foods: [],
    rng: overrides.rng ?? rngStateFor(0, 'spawn'),
    over: overrides.over ?? false,
    winner: overrides.winner ?? null,
    round: overrides.round ?? 0,
    roundTick: overrides.roundTick ?? 0,
    roundTicks: ROUND_TICKS,
    pause: overrides.pause ?? 0,
    pauseTicks: pauseFor(maxTicks),
    outcome: overrides.outcome ?? null,
  };
}
