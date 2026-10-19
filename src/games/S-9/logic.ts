import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { PLAYER_R, SLOW_SPEED, SPEED, actionsSpades } from '../_spades/logic';

/**
 * S-9 縮小的場地（SPEC 第 9 節；小規格 `docs/cards/S-9.md`）。
 *
 * 一片共用的地板，10 欄 × 14 列、每格 15×15。圓心所在的格子被踩到之後 45 tick 掉下去、再也不回來；
 * 圓心所在的格子是「已掉」的那個人輸這一回合。三戰兩勝，最多 4 回合。
 *
 * 模擬層是純的：亂數只用 state 裡的 `RngState`（只在每一回合開始時決定起點），時間只有 tick 數。
 * `evaluate` 的核心是一個「時間感知的廣度優先搜尋」：走到距離 d 格的格子要花的時間，
 * 若那一格在那個時間點已經掉了就走不到；我與對手各算一次，早到的歸誰（領地）。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

export const COLS = 10;
export const ROWS = 14;
export const CELL = 15;
export const TILES = COLS * ROWS;
export const FIELD_W = COLS * CELL;
export const FIELD_H = ROWS * CELL;

/** 踩到之後幾個 tick 掉下去。 */
export const CRUMBLE_TICKS = 45;
/** 格子的狀態：已掉。0 是新鮮、大於 0 是崩落中剩下的 tick 數。 */
export const GONE = -1;

/** 每兩回合之間停住的 tick 數。 */
export const REST_TICKS = 60;
/** 一回合最長的 tick 數（上限；`maxTicks` 小時縮短，見 `roundLimit`）。 */
export const ROUND_CAP = 1200;
export const MAX_ROUNDS = 4;
export const WINS_NEEDED = 2;
/** `init` 接受的最小 `maxTicks`：四回合各至少 `roundLimit` 加三次停頓。 */
export const MIN_MAX_TICKS = 600;
/** 預設的 `maxTicks`（外殼讀 `meta.defaultMaxTicks`）。 */
export const DEFAULT_MAX_TICKS = 4500;

/** 評估：穿過一格大約要幾個 tick（直線 15 像素 ÷ 1.5）。 */
export const STEP_TICKS = 10;
/** 評估：領地差每一格的權重。 */
export const TERRITORY_WEIGHT = 10;
/** 評估：走得到的格子少於這麼多就開始算危險。 */
export const REACH_SAFE = 12;
/** 評估：腳下的格子「剩下的 tick 減走出去要的 tick」少於這麼多，就開始算危險（越少越危險）。 */
export const STAY_SAFE = 20;
/** 評估：餘裕不夠的扣分上限（餘裕 0 以下扣滿）；扣的是 gain，不是 danger（來不及不是「有風險」，是確定的損失）。 */
export const STAY_PENALTY = 400;
/** 評估：照現在的速度再走這麼多個 tick，若會走進（或來不及走到）已經掉的格子，danger = 1。 */
export const HEADING_LOOK = 12;
/** 評估：走到一格要比它掉下去的時間至少早這麼多個 tick 才算走得到（走位不會剛好是直線）。 */
export const SAFETY_TICKS = 4;
/** 評估：腳下格子的上下左右每有一格已經掉了（站在洞的邊上，踩錯一步就掉下去），danger 加這個值的四分之一。 */
export const EDGE_DANGER = 0.8;
/** 評估：一回合的輸贏值多少。 */
export const ROUND_VALUE = 1000;

const NEVER = 30000;

/** 一回合最多幾個 tick：四回合加三次停頓要放得進 `maxTicks`。 */
export function roundLimit(maxTicks: number): number {
  return Math.min(ROUND_CAP, Math.floor((maxTicks - (MAX_ROUNDS - 1) * REST_TICKS) / MAX_ROUNDS));
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface S9Player {
  /** 圓心（場地座標，左上角是 (0, 0)）。 */
  readonly x: number;
  readonly y: number;
  /** 上一個 tick 的速度。 */
  readonly vx: number;
  readonly vy: number;
}

export type S9Phase = 'play' | 'rest' | 'over';
/** 剛結束的那一回合誰贏（平手是 'draw'）；進行中是 null。 */
export type S9Outcome = 'side0' | 'side1' | 'draw';

export interface S9State {
  readonly tick: number;
  readonly maxTicks: number;
  /** 現在是第幾回合（0 起算）；停頓與結束時是剛打完的那一回合。 */
  readonly round: number;
  /** 'play'：這一回合已經走了幾個 tick；'rest'：停頓已經過了幾個 tick。 */
  readonly roundTick: number;
  readonly phase: S9Phase;
  /** 140 格：-1 已掉、0 新鮮、t 崩落中剩下的 tick。列優先（index = 列 × 10 + 欄）。 */
  readonly tiles: readonly number[];
  readonly players: readonly [S9Player, S9Player];
  /** 兩邊贏的回合數。 */
  readonly wins: readonly [number, number];
  /** 這一回合誰腳下的格子掉了。 */
  readonly fell: readonly [boolean, boolean];
  readonly outcome: S9Outcome | null;
  /** 只在每一回合開始時用來決定起點。 */
  readonly rng: RngState;
}

// ---------------------------------------------------------------------------
// 格子的座標
// ---------------------------------------------------------------------------

export function tileIndex(col: number, row: number): number {
  return row * COLS + col;
}

/** 圓心所在的格子：`floor(x / 15)`、`floor(y / 15)`，邊界上的算右邊／下邊那一格。 */
export function tileAt(x: number, y: number): number {
  return Math.floor(y / CELL) * COLS + Math.floor(x / CELL);
}

export function tileCenter(index: number): { x: number; y: number } {
  return { x: (index % COLS) * CELL + CELL / 2, y: Math.floor(index / COLS) * CELL + CELL / 2 };
}

/** 轉 180 度之後的格子。 */
export function rotated(index: number): number {
  return TILES - 1 - index;
}

const NEIGHBORS = new Int16Array(TILES * 4).fill(-1);
for (let i = 0; i < TILES; i += 1) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  if (row > 0) NEIGHBORS[i * 4] = i - COLS;
  if (col < COLS - 1) NEIGHBORS[i * 4 + 1] = i + 1;
  if (row < ROWS - 1) NEIGHBORS[i * 4 + 2] = i + COLS;
  if (col > 0) NEIGHBORS[i * 4 + 3] = i - 1;
}

// ---------------------------------------------------------------------------
// 一回合的開頭
// ---------------------------------------------------------------------------

/** 從亂數挑人的起點格：左上四分之一（5 欄 × 7 列）裡均勻挑一格；AI 是轉 180 度的格子。 */
function drawStart(rng: RngState): { index: number; rng: RngState } {
  const [col, afterCol] = intFrom(rng, 5);
  const [row, afterRow] = intFrom(afterCol, 7);
  return { index: tileIndex(col, row), rng: afterRow };
}

/**
 * 起點：格子中心偏 0.75 像素（人偏右下、AI 轉 180 度所以偏左上）。步長是 1.5 的倍數，
 * 格子中心加上整數個步長會剛好落在格邊界（15 的倍數）上，而「邊界算右邊／下邊那一格」
 * 對轉 180 度不對稱；偏 0.75 之後全速的步長不會踩到邊界。
 */
const START_OFFSET = 0.75;

function freshPlayer(index: number, side: Side): S9Player {
  const c = tileCenter(index);
  const offset = side === 0 ? START_OFFSET : -START_OFFSET;
  return { x: c.x + offset, y: c.y + offset, vx: 0, vy: 0 };
}

function beginRound(state: S9State, round: number, crumble: number): S9State {
  const drawn = drawStart(state.rng);
  const tiles = new Array<number>(TILES).fill(0);
  tiles[drawn.index] = crumble;
  tiles[rotated(drawn.index)] = crumble;
  return {
    ...state,
    round,
    roundTick: 0,
    phase: 'play',
    tiles,
    players: [freshPlayer(drawn.index, 0), freshPlayer(rotated(drawn.index), 1)],
    fell: [false, false],
    outcome: null,
    rng: drawn.rng,
  };
}

export function initS9State(
  seed: number,
  config: GameConfig,
  crumble: number = CRUMBLE_TICKS,
): S9State {
  if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks < MIN_MAX_TICKS) {
    throw new RangeError(
      `config.maxTicks 必須是 ${MIN_MAX_TICKS} 以上的整數，收到 ${String(config.maxTicks)}`,
    );
  }
  const blank: S9State = {
    tick: 0,
    maxTicks: config.maxTicks,
    round: 0,
    roundTick: 0,
    phase: 'play',
    tiles: [],
    players: [freshPlayer(0, 0), freshPlayer(0, 1)],
    wins: [0, 0],
    fell: [false, false],
    outcome: null,
    rng: rngStateFor(seed, 'start'),
  };
  return beginRound(blank, 0, crumble);
}

// ---------------------------------------------------------------------------
// 時間感知的廣度優先搜尋
// ---------------------------------------------------------------------------

const timesA = new Int16Array(TILES);
const timesB = new Int16Array(TILES);
const doneStamp = new Uint32Array(TILES);
const candStamp = new Uint32Array(TILES);
const cand = new Int16Array(TILES);
const layerA = new Int16Array(TILES);
const layerB = new Int16Array(TILES);
const pending = new Int16Array(TILES);
let doneGeneration = 0;
let layerGeneration = 0;

/** 最近一次 `flood` 有幾個可以走的鄰格（腳下的格子撐得到、鄰格撐得到）。 */
let lastExits = 0;
/**
 * 最近一次 `flood` 的「餘裕」：走到任何一個新鮮格子（踩上去就有 45 tick 的地方）的最好一條路上，
 * 每一格「剩下的 tick 減去走到它的 tick」的最小值（腳下那一格也算）。越小越接近「來不及」；
 * 沒有新鮮格子走得到時，取走得到的格子裡最好的那條路；沒有出口是 -1。
 */
let lastSlack = -1;
const BIG = 1000;
const pathMargin = new Int16Array(TILES);
const candMargin = new Int16Array(TILES);
let bestFresh = -1;
let bestAny = -1;

let seedDone = 0;
let seedTiles: readonly number[] = [];
let seedTimes: Int16Array = timesA;
let seedLayer: Int16Array = layerA;
let seedLen = 0;
let seedOwn = 0;
let seedCount = 0;

/** 第一步：從腳下的格子走到鄰格 `nb`，要 `cost` 個 tick。 */
function seedEdge(nb: number, distance: number): void {
  if (nb < 0) {
    return;
  }
  const cost = Math.max(1, Math.ceil((distance + 1e-6) / SPEED));
  const own = seedOwn;
  doneStamp[nb] = seedDone;
  const t = seedTiles[nb] as number;
  if (t === GONE || (own > 0 && cost + SAFETY_TICKS >= own)) {
    return;
  }
  if (t === 0 || t > cost + SAFETY_TICKS) {
    seedTimes[nb] = cost;
    const margin = Math.min(own > 0 ? own - cost : BIG, t === 0 ? BIG : t - cost);
    pathMargin[nb] = margin;
    if (t === 0) {
      bestFresh = Math.max(bestFresh, margin);
    } else {
      bestAny = Math.max(bestAny, margin);
    }
    seedLayer[seedLen] = nb;
    seedLen += 1;
    seedCount += 1;
  }
}

/**
 * 從 (x, y) 出發，每一格最早什麼時候走得到；走不到是 `NEVER`。回傳走得到的格子數（含腳下那一格）。
 * 第一步要花多久由圓心離格邊的距離決定（全速），之後每一格 `STEP_TICKS`。
 * 一格若在走到的時間點（含）之前已經掉了，就走不到，也不能經過它。
 * 腳下的格子自己也在崩落：第一步的時間要小於它剩下的 tick，否則在走出去之前就掉了。
 */
function flood(tiles: readonly number[], x: number, y: number, times: Int16Array): number {
  times.fill(NEVER);
  const origin = tileAt(x, y);
  const own = tiles[origin] as number;
  lastExits = 0;
  lastSlack = -1;
  bestFresh = -1;
  bestAny = -1;
  if (own === GONE) {
    return 0;
  }
  doneGeneration += 1;
  const done = doneGeneration;
  doneStamp[origin] = done;
  times[origin] = 0;

  seedDone = done;
  seedTiles = tiles;
  seedTimes = times;
  seedLayer = layerA;
  seedLen = 0;
  seedOwn = own;
  seedCount = 1;
  const col = origin % COLS;
  const row = Math.floor(origin / COLS);
  seedEdge(NEIGHBORS[origin * 4] as number, y - row * CELL);
  seedEdge(NEIGHBORS[origin * 4 + 1] as number, (col + 1) * CELL - x);
  seedEdge(NEIGHBORS[origin * 4 + 2] as number, (row + 1) * CELL - y);
  seedEdge(NEIGHBORS[origin * 4 + 3] as number, x - col * CELL);
  lastExits = seedLen;

  let count = seedCount;
  let current = layerA;
  let next = layerB;
  let length = seedLen;
  while (length > 0) {
    layerGeneration += 1;
    const gen = layerGeneration;
    let pendingLength = 0;
    for (let i = 0; i < length; i += 1) {
      const p = current[i] as number;
      const arrive = (times[p] as number) + STEP_TICKS;
      const base = p * 4;
      for (let k = 0; k < 4; k += 1) {
        const n = NEIGHBORS[base + k] as number;
        if (n < 0 || doneStamp[n] === done || (tiles[n] as number) === GONE) {
          continue;
        }
        const through = pathMargin[p] as number;
        if (candStamp[n] !== gen) {
          candStamp[n] = gen;
          cand[n] = arrive;
          candMargin[n] = through;
          pending[pendingLength] = n;
          pendingLength += 1;
        } else {
          if (arrive < (cand[n] as number)) {
            cand[n] = arrive;
          }
          if (through > (candMargin[n] as number)) {
            candMargin[n] = through;
          }
        }
      }
    }
    let nextLength = 0;
    for (let j = 0; j < pendingLength; j += 1) {
      const n = pending[j] as number;
      doneStamp[n] = done;
      const t = tiles[n] as number;
      const arrive = cand[n] as number;
      if (t === 0 || t > arrive + SAFETY_TICKS) {
        times[n] = arrive;
        const margin = Math.min(candMargin[n] as number, t === 0 ? BIG : t - arrive);
        pathMargin[n] = margin;
        if (t === 0) {
          bestFresh = Math.max(bestFresh, margin);
        } else {
          bestAny = Math.max(bestAny, margin);
        }
        next[nextLength] = n;
        nextLength += 1;
        count += 1;
      }
    }
    const swap = current;
    current = next;
    next = swap;
    length = nextLength;
  }
  lastSlack = bestFresh >= 0 ? bestFresh : bestAny;
  return count;
}

export interface Territory {
  /** 各自走得到幾格（含腳下那一格）。 */
  readonly reach: readonly [number, number];
  /** 各自歸屬的格子數：比對手早到、或對手走不到。同時到的不算。 */
  readonly owned: readonly [number, number];
  /** 各自腳下那一格撐得到、能走出去的方向數。 */
  readonly exits: readonly [number, number];
  /** 各自腳下的格子剩下的 tick，減去走出去最快要幾個 tick：越小越接近「來不及離開」；格子不會掉或沒有出口時是很大的數。 */
  readonly slack: readonly [number, number];
}

/** 兩個玩家在 `tiles` 這片地板上的走得到與領地（時間感知）。 */
export function territory(tiles: readonly number[], first: S9Player, second: S9Player): Territory {
  const reachFirst = flood(tiles, first.x, first.y, timesA);
  const exitsFirst = lastExits;
  const slackFirst = lastSlack;
  const reachSecond = flood(tiles, second.x, second.y, timesB);
  const exitsSecond = lastExits;
  const slackSecond = lastSlack;
  let ownedFirst = 0;
  let ownedSecond = 0;
  for (let i = 0; i < TILES; i += 1) {
    const a = timesA[i] as number;
    const b = timesB[i] as number;
    if (a < b) {
      ownedFirst += 1;
    } else if (b < a) {
      ownedSecond += 1;
    }
  }
  return {
    reach: [reachFirst, reachSecond],
    owned: [ownedFirst, ownedSecond],
    exits: [exitsFirst, exitsSecond],
    slack: [slackFirst, slackSecond],
  };
}

/** 只算一個人（沒有對手）：走得到幾格、能走出去的方向數、餘裕。 */
export function soloReach(
  tiles: readonly number[],
  player: S9Player,
): { reach: number; exits: number; slack: number } {
  const reach = flood(tiles, player.x, player.y, timesA);
  return { reach, exits: lastExits, slack: lastSlack };
}

// ---------------------------------------------------------------------------
// 一個 tick
// ---------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function movePlayer(p: S9Player, buttons: Buttons): S9Player {
  const dx = (buttons.right ? 1 : 0) - (buttons.left ? 1 : 0);
  const dy = (buttons.down ? 1 : 0) - (buttons.up ? 1 : 0);
  const speed = buttons.a ? SLOW_SPEED : SPEED;
  const along = dx !== 0 && dy !== 0 ? speed * Math.SQRT1_2 : speed;
  const vx = dx === 0 ? 0 : dx * along;
  const vy = dy === 0 ? 0 : dy * along;
  return {
    x: clamp(p.x + vx, PLAYER_R, FIELD_W - PLAYER_R),
    y: clamp(p.y + vy, PLAYER_R, FIELD_H - PLAYER_R),
    vx,
    vy,
  };
}

function matchWinner(wins: readonly [number, number]): Side | null {
  return wins[0] > wins[1] ? 0 : wins[1] > wins[0] ? 1 : null;
}

/** 這一回合結束：記分，決定是停頓還是整場結束。 */
function finishRound(
  state: S9State,
  tick: number,
  tiles: readonly number[],
  players: readonly [S9Player, S9Player],
  fell: readonly [boolean, boolean],
  outcome: S9Outcome,
): S9State {
  const wins: readonly [number, number] = [
    state.wins[0] + (outcome === 'side0' ? 1 : 0),
    state.wins[1] + (outcome === 'side1' ? 1 : 0),
  ];
  const decided = wins[0] >= WINS_NEEDED || wins[1] >= WINS_NEEDED || state.round + 1 >= MAX_ROUNDS;
  return {
    ...state,
    tick,
    tiles,
    players,
    wins,
    fell,
    outcome,
    phase: decided ? 'over' : 'rest',
    roundTick: 0,
  };
}

function stepWith(state: S9State, inputs: Inputs, crumble: number): S9State {
  if (state.phase === 'over') {
    return state;
  }
  const tick = state.tick + 1;

  if (state.phase === 'rest') {
    if (tick >= state.maxTicks) {
      return { ...state, tick, phase: 'over' };
    }
    return state.roundTick + 1 >= REST_TICKS
      ? beginRound({ ...state, tick }, state.round + 1, crumble)
      : { ...state, tick, roundTick: state.roundTick + 1 };
  }

  const players: readonly [S9Player, S9Player] = [
    movePlayer(state.players[0], inputs[0]),
    movePlayer(state.players[1], inputs[1]),
  ];
  const tiles = state.tiles.slice();
  for (let i = 0; i < TILES; i += 1) {
    const t = tiles[i] as number;
    if (t > 0) {
      tiles[i] = t === 1 ? GONE : t - 1;
    }
  }
  const at0 = tileAt(players[0].x, players[0].y);
  const at1 = tileAt(players[1].x, players[1].y);
  if (tiles[at0] === 0) {
    tiles[at0] = crumble;
  }
  if (tiles[at1] === 0) {
    tiles[at1] = crumble;
  }
  const fell: readonly [boolean, boolean] = [tiles[at0] === GONE, tiles[at1] === GONE];

  if (fell[0] || fell[1]) {
    const outcome: S9Outcome = fell[0] && fell[1] ? 'draw' : fell[0] ? 'side1' : 'side0';
    return finishRound(state, tick, tiles, players, fell, outcome);
  }
  const roundTick = state.roundTick + 1;
  if (roundTick >= roundLimit(state.maxTicks)) {
    const own = territory(tiles, players[0], players[1]).owned;
    const outcome: S9Outcome = own[0] === own[1] ? 'draw' : own[0] > own[1] ? 'side0' : 'side1';
    return finishRound(state, tick, tiles, players, fell, outcome);
  }
  if (tick >= state.maxTicks) {
    return { ...state, tick, tiles, players, roundTick, phase: 'over' };
  }
  return { ...state, tick, roundTick, tiles, players };
}

export function stepS9(state: S9State, inputs: Inputs): S9State {
  return stepWith(state, inputs, CRUMBLE_TICKS);
}

// ---------------------------------------------------------------------------
// 動作與評估
// ---------------------------------------------------------------------------

const NEUTRAL: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});
const FROZEN_ACTIONS: readonly Buttons[] = Object.freeze([NEUTRAL]);

/** 轉 180 度：上下互換、左右互換。 */
function mirrored(b: Buttons): Buttons {
  return Object.freeze({ ...b, up: b.down, down: b.up, left: b.right, right: b.left });
}
const ACTIONS_SIDE0: readonly Buttons[] = actionsSpades();
const ACTIONS_SIDE1: readonly Buttons[] = Object.freeze(ACTIONS_SIDE0.map(mirrored));

/**
 * 進行中是 17 個動作（同 S-A）；AI 那一邊的順序是人那一邊轉 180 度（第 k 個動作互為鏡像），
 * 這樣「平手取索引最小」在兩邊也是對稱的；否則平手時兩邊會往不同的方向偏。
 */
export function actionsS9(state: S9State, side: Side): readonly Buttons[] {
  if (state.phase !== 'play') {
    return FROZEN_ACTIONS;
  }
  return side === 0 ? ACTIONS_SIDE0 : ACTIONS_SIDE1;
}

/**
 * 評估。進行中：
 * - `gain = 10 × (我的領地 − 對手的領地) + 我走得到的格子數 − 400 × 來不及²`。領地與走得到的格子數都是時間感知的廣度優先搜尋算的；
 *   「來不及」是 `clamp((20 − 餘裕) / 20, 0, 1.5)`，餘裕是走到一個新鮮格子的最好一條路上每一格「剩下的 tick 減走到它的 tick」的最小值
 *   （腳下的格子也算）。來不及是確定的損失，不是風險，所以扣在 gain，不放進 danger（賭徒型把 danger 當加成，放進去它會等到來不及）。
 * - `danger`：腳下的格子撐不到任何一個鄰格、或照目前的速度再走 12 個 tick 會走進（或來不及走到）已掉的格子：1；
 *   否則取兩者較大的：被困的風險 `clamp((12 − 走得到的格子數) / 12, 0, 1)`、站在洞邊的風險（上下左右每一格已掉的鄰格 0.2）。
 * 一回合結束（停頓、整場結束）：`gain = ±1000`（我贏這一回合 / 我輸 / 平手 0），
 * 我腳下的格子掉了時 `danger = 1`，否則 0。兩邊贏的回合數不進進行中的評估（沒有橡皮筋）。
 */
export function evaluateS9(state: S9State, side: Side): { gain: number; danger: number } {
  if (state.phase !== 'play') {
    const outcome = state.outcome;
    let sign = 0;
    if (outcome === null) {
      const winner = matchWinner(state.wins);
      sign = winner === null ? 0 : winner === side ? 1 : -1;
    } else if (outcome !== 'draw') {
      sign = (outcome === 'side0') === (side === 0) ? 1 : -1;
    }
    return { gain: ROUND_VALUE * sign, danger: state.fell[side] ? 1 : 0 };
  }
  return evaluateWithRival(state, side, state.players[side === 0 ? 1 : 0]);
}

/**
 * 進行中的評估，對手的位置另外給（劇本玩家用）：真的評估傳的是對手真正的位置；
 * 傳 `null` 是「沒有對手」（只剩自己走得到幾格），傳別的位置是「以為對手站在那裡」。
 */
export function evaluateWithRival(
  state: S9State,
  side: Side,
  rival: S9Player | null,
): { gain: number; danger: number } {
  const me = state.players[side];
  let reach: number;
  let owned: number;
  let exits: number;
  let slack: number;
  if (rival === null) {
    const solo = soloReach(state.tiles, me);
    reach = solo.reach;
    owned = 0;
    exits = solo.exits;
    slack = solo.slack;
  } else {
    const t = side === 0 ? territory(state.tiles, me, rival) : territory(state.tiles, rival, me);
    reach = t.reach[side];
    owned = t.owned[side] - t.owned[side === 0 ? 1 : 0];
    exits = t.exits[side];
    slack = t.slack[side];
  }
  const late = clamp((STAY_SAFE - slack) / STAY_SAFE, 0, 1.5);
  const edge = (EDGE_DANGER * holeNeighbors(state.tiles, me)) / 4;
  const gain = TERRITORY_WEIGHT * owned + reach - STAY_PENALTY * late * late;
  const danger =
    exits === 0 || headingBlocked(state.tiles, me)
      ? 1
      : Math.max(clamp((REACH_SAFE - reach) / REACH_SAFE, 0, 1), edge);
  return { gain, danger };
}

/** 腳下格子的上下左右有幾格已經掉了（場地邊緣不算，崩落中還沒掉的也不算）。 */
export function holeNeighbors(tiles: readonly number[], p: S9Player): number {
  const at = tileAt(p.x, p.y);
  let count = 0;
  for (let k = 0; k < 4; k += 1) {
    const n = NEIGHBORS[at * 4 + k] as number;
    if (n >= 0 && (tiles[n] as number) === GONE) {
      count += 1;
    }
  }
  return count;
}

/**
 * 照目前的速度一直走 `HEADING_LOOK` 個 tick，圓心經過的格子是否撐得到：第 k 個 tick 到的格子若已經掉了
 * （`GONE`，或剩下的 tick 不超過 k），就是會掉下去。沒有速度（站著）時不算，站著的風險由「腳下的格子撐多久」管。
 */
export function headingBlocked(tiles: readonly number[], p: S9Player): boolean {
  if (p.vx === 0 && p.vy === 0) {
    return false;
  }
  let x = p.x;
  let y = p.y;
  for (let k = 1; k <= HEADING_LOOK; k += 1) {
    x = clamp(x + p.vx, PLAYER_R, FIELD_W - PLAYER_R);
    y = clamp(y + p.vy, PLAYER_R, FIELD_H - PLAYER_R);
    const t = tiles[tileAt(x, y)] as number;
    if (t === GONE || (t > 0 && t <= k)) {
      return true;
    }
  }
  return false;
}

export function createS9Game(crumble: number = CRUMBLE_TICKS): Game<S9State> {
  return {
    id: 'S-9',
    init(seed: number, config: GameConfig): S9State {
      return initS9State(seed, config, crumble);
    },
    step(state: S9State, inputs: Inputs): S9State {
      return stepWith(state, inputs, crumble);
    },
    isOver(state: S9State): boolean {
      return state.phase === 'over';
    },
    score(state: S9State): readonly [number, number] {
      return [state.wins[0], state.wins[1]];
    },
    winner(state: S9State): Side | null {
      return state.phase === 'over' ? matchWinner(state.wins) : null;
    },
    actions(state: S9State, side: Side): readonly Buttons[] {
      return actionsS9(state, side);
    },
    evaluate(state: S9State, side: Side): { gain: number; danger: number } {
      return evaluateS9(state, side);
    },
  };
}

export const s9Game: Game<S9State> = createS9Game();

// ---------------------------------------------------------------------------
// 測試用：直接構造局面
// ---------------------------------------------------------------------------

export interface S9Overrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly round?: number;
  readonly roundTick?: number;
  readonly phase?: S9Phase;
  /** 格子編號 → 狀態；沒寫到的都是新鮮（0）。 */
  readonly tiles?: Readonly<Record<number, number>>;
  /** 兩個玩家各自要覆蓋的欄位；沒寫的用預設（人在第 2 欄第 3 列的中心、AI 在轉 180 度的格子中心）。 */
  readonly players?: readonly [Partial<S9Player>?, Partial<S9Player>?];
  readonly wins?: readonly [number, number];
  readonly fell?: readonly [boolean, boolean];
  readonly outcome?: S9Outcome | null;
  readonly rng?: RngState;
}

/**
 * 測試用：整片地板新鮮（沒有任何格子在崩落）、第 0 回合進行中、0 比 0、兩個人站在轉 180 度對稱的格子中心，
 * 再用 overrides 覆蓋。注意兩個人腳下的格子是新鮮的（還沒被踩），第一個 step 才會變成崩落中。
 */
export function makeState(overrides: S9Overrides = {}): S9State {
  const home = tileCenter(tileIndex(2, 3));
  const away = tileCenter(rotated(tileIndex(2, 3)));
  const tiles = new Array<number>(TILES).fill(0);
  for (const [key, value] of Object.entries(overrides.tiles ?? {})) {
    tiles[Number(key)] = value;
  }
  const player = (
    base: { x: number; y: number },
    patch: Partial<S9Player> | undefined,
  ): S9Player => ({
    x: base.x,
    y: base.y,
    vx: 0,
    vy: 0,
    ...patch,
  });
  return {
    tick: overrides.tick ?? 0,
    maxTicks: overrides.maxTicks ?? DEFAULT_MAX_TICKS,
    round: overrides.round ?? 0,
    roundTick: overrides.roundTick ?? 0,
    phase: overrides.phase ?? 'play',
    tiles,
    players: [player(home, overrides.players?.[0]), player(away, overrides.players?.[1])],
    wins: overrides.wins ?? [0, 0],
    fell: overrides.fell ?? [false, false],
    outcome: overrides.outcome ?? null,
    rng: overrides.rng ?? rngStateFor(0, 'start'),
  };
}
