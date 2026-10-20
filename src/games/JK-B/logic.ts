import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { CELLS, HEIGHT, WIDTH, cell, cellX, cellY } from '../_clubs/logic';

/**
 * JK-B 規則壞掉了（小規格 `docs/cards/JK-B.md`）。
 * 兩個點在 32×24 的格子場上搶金幣，可以互相推擠；每 10 秒換一條「壞掉的規則」，下一條在換之前 3 秒公開；
 * 60 秒結束時分數高的贏。純的：亂數只用 state 裡的 `RngState`，時間只有 tick。
 * 這張牌不是蛇（沒有身體、沒有死亡），只借 `_clubs/logic.ts` 的格子常數與 `cell`／`cellX`／`cellY`（唯讀）。
 */

export { HEIGHT, WIDTH, cell, cellX, cellY };

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 每幾個 tick 走一格（15 格／秒）。 */
export const MOVE_EVERY = 4;
/** 推擠成功之後，推的人要等幾個 tick 才能再推。 */
export const SHOVE_CD = 30;
/** 場上隨時有幾個金幣。 */
export const COINS = 5;
/** 一段規則的長度（10 秒）與一局的長度（6 段，60 秒）。 */
export const PHASE_TICKS = 600;
export const PHASES = 6;
export const DURATION_TICKS = PHASE_TICKS * PHASES;
/** 預告：離下一段還有這麼多 tick 起，下一條規則（與標記格）公開、固定不變。 */
export const NOTICE_TICKS = 180;
/** 重力：每幾個 tick 所有點被強迫飄一格；每幾個 tick 反轉一次。 */
export const DRIFT_EVERY = 12;
export const GRAVITY_FLIP = 180;
/** 金幣雨：額外金幣的數量，與標記格周圍的半徑（2 ＝ 5×5）。 */
export const RAIN_COINS = 8;
export const RAIN_RADIUS = 2;
/** 標記格離兩個點都不能超過這個曼哈頓距離（3 秒內走得到：36 格 × 4 tick ＝ 144 < 180）。 */
export const RAIN_MAX_DIST = 36;
/** 分數互換的時間項看的長度（最後 1 秒）。 */
export const FINAL_TICKS = 60;

/** 規則池（不含只在第 0 段出現的 `normal`）。 */
export const RULE_POOL = ['poison', 'gift', 'rain', 'gravity', 'rob', 'exchange'] as const;
export type Rule = 'normal' | (typeof RULE_POOL)[number];
export type NextRule = Rule | 'none';

/** 方向：0 上、1 右、2 下、3 左；−1 是沒有按。 */
export type Want = -1 | 0 | 1 | 2 | 3;
const DX: readonly number[] = [0, 1, 0, -1];
const DY: readonly number[] = [-1, 0, 1, 0];

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface JKBAvatar {
  readonly x: number;
  readonly y: number;
  /** 還要幾個 tick 才能再推（0 ＝ 可以推）。 */
  readonly shoveCd: number;
  /** 這個 tick 按著的方向（−1 ＝ 沒按）；`evaluate` 用它推「下一格會走到哪」。 */
  readonly want: Want;
}

export interface JKBState {
  readonly tick: number;
  readonly maxTicks: number;
  readonly avatars: readonly [JKBAvatar, JKBAvatar];
  /** 格子編號（`y × 32 + x`）。 */
  readonly coins: readonly number[];
  /** 金幣雨的額外金幣（撿了不補，這一段結束就消失）。 */
  readonly extra: readonly number[];
  readonly scores: readonly [number, number];
  readonly rng: RngState;
  /** 現在是第幾段（0 到 5）與段內第幾個 tick（0 到 599）。 */
  readonly phase: number;
  readonly ruleTick: number;
  /** 長度 6，`schedule[0] ＝ 'normal'`。 */
  readonly schedule: readonly Rule[];
  /** `schedule[phase]` 與 `schedule[phase + 1]`（沒有下一段是 `'none'`），存起來給 `evaluate` 與畫面讀。 */
  readonly rule: Rule;
  readonly next: NextRule;
  readonly gravity: 'down' | 'up';
  /** 金幣雨的標記格（預告開始時決定；沒有金幣雨是 −1）。 */
  readonly rainCell: number;
  /** 累計推擠成功次數、搶劫偷到的分（量測用）。 */
  readonly shoves: readonly [number, number];
  readonly stolen: readonly [number, number];
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);

function gravityAt(ruleTick: number): 'down' | 'up' {
  return Math.floor(ruleTick / GRAVITY_FLIP) % 2 === 0 ? 'down' : 'up';
}

/** 從一個隨機狀態挑出一個空格（不在 `blocked` 裡）；沒有空格回傳 −1。 */
function pickFree(
  rng: RngState,
  blocked: (index: number) => boolean,
): { readonly cell: number; readonly rng: RngState } {
  let state = rng;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const [index, after] = intFrom(state, CELLS);
    state = after;
    if (!blocked(index)) {
      return { cell: index, rng: state };
    }
  }
  const free: number[] = [];
  for (let index = 0; index < CELLS; index += 1) {
    if (!blocked(index)) {
      free.push(index);
    }
  }
  if (free.length === 0) {
    return { cell: -1, rng: state };
  }
  const [pick, after] = intFrom(state, free.length);
  return { cell: free[pick] as number, rng: after };
}

export function initState(seed: number, config: GameConfig): JKBState {
  if (config.maxTicks < PHASE_TICKS) {
    throw new RangeError(`JK-B 的 maxTicks 至少要 ${PHASE_TICKS}，收到 ${String(config.maxTicks)}`);
  }
  // 賽程：規則池洗牌，取前 5 條（不重複），第 0 段固定是 normal。
  const pool: Rule[] = [...RULE_POOL];
  let shuffle = rngStateFor(seed, 'rules');
  for (let i = pool.length - 1; i >= 1; i -= 1) {
    const [j, after] = intFrom(shuffle, i + 1);
    shuffle = after;
    const keep = pool[i] as Rule;
    pool[i] = pool[j] as Rule;
    pool[j] = keep;
  }
  const schedule: Rule[] = ['normal', ...pool.slice(0, PHASES - 1)];
  const avatars: [JKBAvatar, JKBAvatar] = [
    { x: 6, y: 12, shoveCd: 0, want: -1 },
    { x: 25, y: 11, shoveCd: 0, want: -1 },
  ];
  const taken = [cell(6, 12), cell(25, 11)];
  const coins: number[] = [];
  let rng = rngStateFor(seed, 'coins');
  for (let i = 0; i < COINS; i += 1) {
    const free = pickFree(rng, (c) => taken.includes(c) || coins.includes(c));
    rng = free.rng;
    coins.push(free.cell);
  }
  return {
    tick: 0,
    maxTicks: Math.min(config.maxTicks, DURATION_TICKS),
    avatars,
    coins,
    extra: [],
    scores: [0, 0],
    rng,
    phase: 0,
    ruleTick: 0,
    schedule,
    rule: 'normal',
    next: schedule[1] as Rule,
    gravity: 'down',
    rainCell: -1,
    shoves: [0, 0],
    stolen: [0, 0],
  };
}

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

export function isOver(state: JKBState): boolean {
  return state.tick >= state.maxTicks;
}

/** 一組按鍵的方向：上下優先於左右；相反的兩個鍵互相抵消；什麼都沒按是 −1。 */
export function wantOf(buttons: Buttons): Want {
  if (buttons.up && !buttons.down) {
    return 0;
  }
  if (buttons.down && !buttons.up) {
    return 2;
  }
  if (buttons.right && !buttons.left) {
    return 1;
  }
  if (buttons.left && !buttons.right) {
    return 3;
  }
  return -1;
}

/** 從 (x, y) 往 `dir` 走一格的格子編號；出界或沒有方向是 −1。 */
function stepCell(x: number, y: number, dir: number): number {
  if (dir < 0) {
    return -1;
  }
  const nx = x + (DX[dir] as number);
  const ny = y + (DY[dir] as number);
  return nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT ? -1 : ny * WIDTH + nx;
}

interface MoveResult {
  readonly c0: number;
  readonly c1: number;
  /** 誰推成功了（−1 ＝ 沒有）。 */
  readonly shover: -1 | 0 | 1;
}

/**
 * 走格（兩個點同時算新位置，不分先後）：
 * - 同時走進同一格，或迎面互相走進對方的格子：兩個都不動。
 * - 走進對方「現在所在」的格子，而對方同時走開：走進去的人成功，不算推擠。
 * - 走進沒有在走的對手：冷卻是 0 而且對手後面有格子，就推（對手到後面一格、自己前進）；否則走不動。
 */
function resolveMoves(
  p0: number,
  p1: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w0: number,
  w1: number,
  cd0: number,
  cd1: number,
): MoveResult {
  const t0 = stepCell(x0, y0, w0);
  const t1 = stepCell(x1, y1, w1);
  if (t0 >= 0 && t0 === t1) {
    return { c0: p0, c1: p1, shover: -1 };
  }
  if (t0 === p1 && t1 === p0 && t0 >= 0) {
    return { c0: p0, c1: p1, shover: -1 };
  }
  if (t0 >= 0 && t0 === p1) {
    if (t1 >= 0) {
      return { c0: t0, c1: t1, shover: -1 };
    }
    const beyond = stepCell(x1, y1, w0);
    return cd0 === 0 && beyond >= 0
      ? { c0: p1, c1: beyond, shover: 0 }
      : { c0: p0, c1: p1, shover: -1 };
  }
  if (t1 >= 0 && t1 === p0) {
    if (t0 >= 0) {
      return { c0: t0, c1: t1, shover: -1 };
    }
    const beyond = stepCell(x0, y0, w1);
    return cd1 === 0 && beyond >= 0
      ? { c0: beyond, c1: p0, shover: 1 }
      : { c0: p0, c1: p1, shover: -1 };
  }
  return { c0: t0 >= 0 ? t0 : p0, c1: t1 >= 0 ? t1 : p1, shover: -1 };
}

/** 撿到金幣時，每個人這一次的分數變化（撿的人在 `picker` 邊）。 */
function pickValue(rule: Rule, picks: readonly [number, number]): [number, number] {
  const d: [number, number] = [0, 0];
  for (const side of [0, 1] as const) {
    const n = picks[side];
    if (n === 0) {
      continue;
    }
    switch (rule) {
      case 'poison':
        d[side] -= n;
        break;
      case 'gift':
        d[other(side)] += n;
        break;
      case 'rob':
        break;
      default:
        d[side] += n;
    }
  }
  return d;
}

/** 以 (cx, cy) 為中心、半徑 `RAIN_RADIUS` 的格子（地圖內的），照格子編號排。 */
function rainArea(center: number): number[] {
  const cx = cellX(center);
  const cy = cellY(center);
  const cells: number[] = [];
  for (let y = Math.max(0, cy - RAIN_RADIUS); y <= Math.min(HEIGHT - 1, cy + RAIN_RADIUS); y += 1) {
    for (
      let x = Math.max(0, cx - RAIN_RADIUS);
      x <= Math.min(WIDTH - 1, cx + RAIN_RADIUS);
      x += 1
    ) {
      cells.push(cell(x, y));
    }
  }
  return cells;
}

/** 標記格：5×5 整個在地圖內、兩個點到它的曼哈頓距離之差最小（公平）、3 秒內兩邊都走得到；同樣好的格子用亂數挑一個。 */
function chooseRainCell(
  avatars: readonly [JKBAvatar, JKBAvatar],
  rng: RngState,
): { readonly cell: number; readonly rng: RngState } {
  const [a, b] = avatars;
  let best = Number.POSITIVE_INFINITY;
  let ties: number[] = [];
  for (let y = RAIN_RADIUS; y <= HEIGHT - 1 - RAIN_RADIUS; y += 1) {
    for (let x = RAIN_RADIUS; x <= WIDTH - 1 - RAIN_RADIUS; x += 1) {
      const d0 = Math.abs(x - a.x) + Math.abs(y - a.y);
      const d1 = Math.abs(x - b.x) + Math.abs(y - b.y);
      if (Math.max(d0, d1) > RAIN_MAX_DIST) {
        continue;
      }
      const diff = Math.abs(d0 - d1);
      if (diff < best) {
        best = diff;
        ties = [cell(x, y)];
      } else if (diff === best) {
        ties.push(cell(x, y));
      }
    }
  }
  if (ties.length === 0) {
    return { cell: cell(WIDTH >> 1, HEIGHT >> 1), rng };
  }
  const [pick, after] = intFrom(rng, ties.length);
  return { cell: ties[pick] as number, rng: after };
}

export function step(state: JKBState, inputs: Inputs): JKBState {
  if (isOver(state)) {
    return state;
  }
  const { rule, tick, ruleTick } = state;
  const [s0, s1] = state.avatars;
  const w0 = wantOf(inputs[0]);
  const w1 = wantOf(inputs[1]);
  let x0 = s0.x;
  let y0 = s0.y;
  let x1 = s1.x;
  let y1 = s1.y;
  let cd0 = s0.shoveCd > 0 ? s0.shoveCd - 1 : 0;
  let cd1 = s1.shoveCd > 0 ? s1.shoveCd - 1 : 0;
  let scores = state.scores;
  let shoves = state.shoves;
  let stolen = state.stolen;
  let coins = state.coins;
  let extra = state.extra;
  let rng = state.rng;

  // 1. 走格與推擠
  if (tick % MOVE_EVERY === 0 && (w0 >= 0 || w1 >= 0)) {
    const moved = resolveMoves(y0 * WIDTH + x0, y1 * WIDTH + x1, x0, y0, x1, y1, w0, w1, cd0, cd1);
    x0 = moved.c0 % WIDTH;
    y0 = (moved.c0 - x0) / WIDTH;
    x1 = moved.c1 % WIDTH;
    y1 = (moved.c1 - x1) / WIDTH;
    if (moved.shover >= 0) {
      const who = moved.shover;
      shoves = who === 0 ? [shoves[0] + 1, shoves[1]] : [shoves[0], shoves[1] + 1];
      if (who === 0) {
        cd0 = SHOVE_CD;
      } else {
        cd1 = SHOVE_CD;
      }
      if (rule === 'rob') {
        scores = who === 0 ? [scores[0] + 1, scores[1] - 1] : [scores[0] - 1, scores[1] + 1];
        stolen = who === 0 ? [stolen[0] + 1, stolen[1]] : [stolen[0], stolen[1] + 1];
      }
    }
  }

  // 撿金幣（走格、被推）；撿完補金幣
  const collect = (): void => {
    const picks: [number, number] = [0, 0];
    let regular = coins;
    let bonus = extra;
    let refill = 0;
    for (const side of [0, 1] as const) {
      const c = side === 0 ? y0 * WIDTH + x0 : y1 * WIDTH + x1;
      const ri = regular.indexOf(c);
      if (ri >= 0) {
        regular = regular.filter((_v, i) => i !== ri);
        picks[side] += 1;
        refill += 1;
      }
      const ei = bonus.indexOf(c);
      if (ei >= 0) {
        bonus = bonus.filter((_v, i) => i !== ei);
        picks[side] += 1;
      }
    }
    if (picks[0] === 0 && picks[1] === 0) {
      return;
    }
    const d = pickValue(rule, picks);
    let a = scores[0] + d[0];
    let b = scores[1] + d[1];
    if (rule === 'exchange') {
      [a, b] = [b, a];
    }
    scores = [a, b];
    const here = [y0 * WIDTH + x0, y1 * WIDTH + x1];
    const placed: number[] = [...regular];
    for (let i = 0; i < refill; i += 1) {
      const free = pickFree(
        rng,
        (c) => here.includes(c) || placed.includes(c) || bonus.includes(c),
      );
      rng = free.rng;
      if (free.cell >= 0) {
        placed.push(free.cell);
      }
    }
    coins = placed;
    extra = bonus;
  };
  collect();

  // 2. 重力：所有點被強迫往重力方向飄一格（前面的先走，後面的跟上；牆擋住就留在原地）
  if (rule === 'gravity' && ruleTick % DRIFT_EVERY === 0) {
    const dir = state.gravity === 'down' ? 2 : 0;
    const frontFirst = state.gravity === 'down' ? y0 >= y1 : y0 <= y1;
    const driftOne = (side: 0 | 1): void => {
      const x = side === 0 ? x0 : x1;
      const y = side === 0 ? y0 : y1;
      const to = stepCell(x, y, dir);
      const blocker = side === 0 ? y1 * WIDTH + x1 : y0 * WIDTH + x0;
      if (to >= 0 && to !== blocker) {
        if (side === 0) {
          y0 = (to - (to % WIDTH)) / WIDTH;
        } else {
          y1 = (to - (to % WIDTH)) / WIDTH;
        }
      }
    };
    if (frontFirst) {
      driftOne(0);
      driftOne(1);
    } else {
      driftOne(1);
      driftOne(0);
    }
    collect();
  }

  // 3. 段切換與預告
  let phase = state.phase;
  let nextTick = ruleTick + 1;
  let curRule = rule;
  let nextRule = state.next;
  let gravity = state.gravity;
  let rainCell = state.rainCell;
  const avatars: [JKBAvatar, JKBAvatar] = [
    { x: x0, y: y0, shoveCd: cd0, want: w0 },
    { x: x1, y: y1, shoveCd: cd1, want: w1 },
  ];
  if (nextTick >= PHASE_TICKS) {
    if (phase < PHASES - 1) {
      // 進下一段
      phase += 1;
      nextTick = 0;
      curRule = state.schedule[phase] as Rule;
      nextRule = (state.schedule[phase + 1] ?? 'none') as NextRule;
      if (rule === 'rain') {
        extra = [];
        rainCell = -1;
      }
      if (curRule === 'rain') {
        if (rainCell < 0) {
          const chosen = chooseRainCell(avatars, rng);
          rainCell = chosen.cell;
          rng = chosen.rng;
        }
        const area = rainArea(rainCell).filter(
          (c) =>
            c !== cell(avatars[0].x, avatars[0].y) &&
            c !== cell(avatars[1].x, avatars[1].y) &&
            !coins.includes(c),
        );
        const spawned: number[] = [];
        for (let i = 0; i < RAIN_COINS && area.length > 0; i += 1) {
          const [pick, after] = intFrom(rng, area.length);
          rng = after;
          spawned.push(area[pick] as number);
          area.splice(pick, 1);
        }
        extra = spawned;
      }
    } else {
      nextTick = PHASE_TICKS - 1;
    }
  }
  if (curRule === 'gravity') {
    gravity = gravityAt(nextTick);
  }
  if (nextRule === 'rain' && nextTick === PHASE_TICKS - NOTICE_TICKS && nextTick !== ruleTick) {
    const chosen = chooseRainCell(avatars, rng);
    rainCell = chosen.cell;
    rng = chosen.rng;
  }

  return {
    tick: tick + 1,
    maxTicks: state.maxTicks,
    avatars,
    coins,
    extra,
    scores,
    rng,
    phase,
    ruleTick: nextTick,
    schedule: state.schedule,
    rule: curRule,
    next: nextRule,
    gravity,
    rainCell,
    shoves,
    stolen,
  };
}

export function score(state: JKBState): readonly [number, number] {
  return state.scores;
}

export function winner(state: JKBState): Side | null {
  if (!isOver(state)) {
    return null;
  }
  const [a, b] = state.scores;
  return a > b ? 0 : b > a ? 1 : null;
}

// ---------------------------------------------------------------------------
// 動作
// ---------------------------------------------------------------------------

const NO_KEYS: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const ACTIONS: readonly Buttons[] = [
  NO_KEYS,
  { ...NO_KEYS, up: true },
  { ...NO_KEYS, right: true },
  { ...NO_KEYS, down: true },
  { ...NO_KEYS, left: true },
];

/** 5 個動作，兩邊一樣：全放開排第一（搜尋型假設對手不動），再來上、右、下、左。沒有 a、b。 */
export function actions(_state: JKBState, _side: Side): readonly Buttons[] {
  return ACTIONS;
}

// ---------------------------------------------------------------------------
// 評估（給 AI）
// ---------------------------------------------------------------------------

/**
 * 一分的 gain。其他項的單位是「格」：往有價值的金幣走近一格 ＝ 1（`COIN_W`），所以撿到一個金幣（100）永遠比
 * 多走近幾格重要，而距離只在視野（搜尋型最多往前看 6 個 tick，約 1 到 2 次走格）之外的時候決定往哪走。
 */
export const POINT = 100;
/** 離最近的有價值金幣每一格的扣分。 */
export const COIN_W = 1;
/** 重力下的走路成本：順風（往重力方向）一格 0.75、逆風一格 1.5（飄移每 12 tick 一格，走格每 4 tick 一格）。 */
export const WIND_WITH = 0.75;
export const WIND_AGAINST = 1.5;
/** 搶劫期間：我可以推時，離對手每一格的扣分（追）；我在冷卻、對手能推時，離對手每一格的加分（躲，最多算 8 格）。 */
export const ROB_CHASE_W = 2;
export const ROB_FLEE_W = 2;
export const ROB_FLEE_RANGE = 8;
/** 準備項（只在預告期 `ruleTick ≥ 600 − 180` 生效；寫死的、人可以預測的習慣）。 */
/** next ＝ 金幣雨：離標記格每一格的扣分；來得及（走過去的 tick ≤ 剩餘 tick ＋ 這個寬限）才有。 */
export const RAIN_PREP_W = 2;
export const RAIN_SLACK = 120;
/** 毒藥／送禮快結束：離「5×5 內金幣最多的地方」每一格的扣分。 */
export const DENSE_PREP_W = 2;
/** next ＝ 搶劫：離對手不到這麼多格，每近一格扣 `ROB_PREP_W`。 */
export const ROB_PREP_RANGE = 6;
export const ROB_PREP_W = 10;
/** next ＝ 重力：站得比這一列低（y 大）的每一列扣的分。 */
export const GRAVITY_PREP_ROW = 6;
export const GRAVITY_PREP_W = 1;
/** 分數互換最後 1 秒：領先、而且對手搆不到任何金幣時的加成。 */
export const FINAL_BONUS = 30;
/** 相鄰、對手能推、我被推走並不致命時的 danger（推走我只是換了位置）。 */
export const DANGER_PUSH = 0.4;
/**
 * 我剛推完人，對手要看到才能推回來：對手的反應延遲（12 tick）內它推不回來，我有時間走開，
 * 所以推完的這段時間不算「相鄰就會被推」。
 */
export const SAFE_AFTER_SHOVE = 12;

function projectedCell(av: JKBAvatar): number {
  const to = stepCell(av.x, av.y, av.want);
  return to >= 0 ? to : av.y * WIDTH + av.x;
}

/** 走路成本（格）：重力段順風便宜、逆風貴，其他段是曼哈頓距離。 */
function travel(state: JKBState, fromCell: number, toCell: number): number {
  const dx = Math.abs((toCell % WIDTH) - (fromCell % WIDTH));
  const dy = Math.floor(toCell / WIDTH) - Math.floor(fromCell / WIDTH);
  if (state.rule !== 'gravity') {
    return dx + Math.abs(dy);
  }
  const withWind = state.gravity === 'down' ? dy > 0 : dy < 0;
  return dx + Math.abs(dy) * (withWind ? WIND_WITH : WIND_AGAINST);
}

function manhattan(a: number, b: number): number {
  return (
    Math.abs((a % WIDTH) - (b % WIDTH)) + Math.abs(Math.floor(a / WIDTH) - Math.floor(b / WIDTH))
  );
}

/**
 * 「5×5 內金幣最多的地方」：以每個金幣為中心數 5×5 內有幾個金幣，最多的（同樣多取離 `from` 最近的）；
 * 站的位置是那一群金幣的重心（四捨五入）。沒有金幣回傳 −1。
 */
export function densestSpot(coins: readonly number[], from: number): number {
  let bestCount = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  let spot = -1;
  for (const center of coins) {
    const cx = center % WIDTH;
    const cy = Math.floor(center / WIDTH);
    let count = 0;
    let sx = 0;
    let sy = 0;
    for (const c of coins) {
      const x = c % WIDTH;
      const y = Math.floor(c / WIDTH);
      if (Math.abs(x - cx) <= RAIN_RADIUS && Math.abs(y - cy) <= RAIN_RADIUS) {
        count += 1;
        sx += x;
        sy += y;
      }
    }
    const here = cell(Math.round(sx / count), Math.round(sy / count));
    const dist = manhattan(from, here);
    if (count > bestCount || (count === bestCount && dist < bestDist)) {
      bestCount = count;
      bestDist = dist;
      spot = here;
    }
  }
  return spot;
}

export function evaluate(state: JKBState, side: Side): { gain: number; danger: number } {
  const me = state.avatars[side];
  const opp = state.avatars[other(side)];
  const lead = state.scores[side] - state.scores[other(side)];
  if (isOver(state)) {
    return { gain: POINT * lead, danger: 0 };
  }
  const { rule, ruleTick } = state;
  const here = projectedCell(me);
  const theirs = opp.y * WIDTH + opp.x;
  let gain = POINT * lead;

  // 有價值的金幣：近一格 ＋1。毒藥、送禮、搶劫的金幣沒有價值（撿了不賺）。
  if (rule === 'normal' || rule === 'rain' || rule === 'gravity' || rule === 'exchange') {
    let best = Number.POSITIVE_INFINITY;
    for (const c of state.coins) {
      best = Math.min(best, travel(state, here, c));
    }
    for (const c of state.extra) {
      best = Math.min(best, travel(state, here, c));
    }
    if (best !== Number.POSITIVE_INFINITY) {
      gain -= COIN_W * best;
    }
  }

  // 搶劫：我能推就追，我在冷卻而它能推就躲
  if (rule === 'rob') {
    const d = manhattan(here, theirs);
    if (me.shoveCd === 0) {
      gain -= ROB_CHASE_W * d;
    } else if (opp.shoveCd === 0) {
      gain += ROB_FLEE_W * Math.min(d, ROB_FLEE_RANGE);
    }
  }

  // 準備項：只在預告期
  const preview = ruleTick >= PHASE_TICKS - NOTICE_TICKS && state.next !== 'none';
  if (preview) {
    if (state.next === 'rain' && state.rainCell >= 0) {
      const d = manhattan(here, state.rainCell);
      if (d * MOVE_EVERY <= PHASE_TICKS - ruleTick + RAIN_SLACK) {
        gain -= RAIN_PREP_W * d;
      }
    } else if (state.next === 'rob') {
      gain -= ROB_PREP_W * Math.max(0, ROB_PREP_RANGE - manhattan(here, theirs));
    } else if (state.next === 'gravity') {
      gain -= GRAVITY_PREP_W * Math.max(0, Math.floor(here / WIDTH) - GRAVITY_PREP_ROW);
    }
    if (rule === 'poison' || rule === 'gift') {
      const spot = densestSpot(state.coins, here);
      if (spot >= 0) {
        gain -= DENSE_PREP_W * manhattan(here, spot);
      }
    }
  }

  // 分數互換的時間項：最後 1 秒，領先而且對手搆不到任何金幣（走過去要的 tick 比剩下的多）才算數
  if (rule === 'exchange' && ruleTick >= PHASE_TICKS - FINAL_TICKS && lead > 0) {
    const left = Math.min(PHASE_TICKS - ruleTick, state.maxTicks - state.tick);
    let reach = Number.POSITIVE_INFINITY;
    for (const c of state.coins) {
      reach = Math.min(reach, manhattan(theirs, c));
    }
    if (reach * MOVE_EVERY > left) {
      gain += FINAL_BONUS;
    }
  }

  // danger：對手相鄰、冷卻是 0、而且推得動我（我後面有格子）
  let danger = 0;
  if (opp.shoveCd === 0 && manhattan(here, theirs) === 1) {
    const hx = here % WIDTH;
    const hy = Math.floor(here / WIDTH);
    const dir = hx > opp.x ? 1 : hx < opp.x ? 3 : hy > opp.y ? 2 : 0;
    const behind = stepCell(hx, hy, dir);
    if (behind >= 0) {
      if (rule === 'rob') {
        danger = me.shoveCd > SHOVE_CD - SAFE_AFTER_SHOVE ? 0 : 1;
      } else if ((rule === 'poison' || rule === 'gift') && state.coins.includes(behind)) {
        danger = 1;
      } else {
        danger = DANGER_PUSH;
      }
    }
  }
  return { gain, danger };
}

export const jkbGame: Game<JKBState> = {
  id: 'JK-B',
  init: initState,
  step,
  isOver,
  score,
  winner,
  actions,
  evaluate,
};

// ---------------------------------------------------------------------------
// 測試用：直接構造局面
// ---------------------------------------------------------------------------

export interface AvatarOverrides {
  readonly x?: number;
  readonly y?: number;
  readonly shoveCd?: number;
  readonly want?: Want;
}

export interface StateOverrides {
  readonly seed?: number;
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly phase?: number;
  readonly ruleTick?: number;
  readonly schedule?: readonly Rule[];
  /** 把 `schedule[phase]` 換成這條。 */
  readonly rule?: Rule;
  /** 把 `schedule[phase + 1]` 換成這條。 */
  readonly next?: NextRule;
  readonly avatars?: readonly [AvatarOverrides, AvatarOverrides];
  /** 預設是空的（不是 5 個）：測試要的金幣自己放。 */
  readonly coins?: readonly number[];
  readonly extra?: readonly number[];
  readonly scores?: readonly [number, number];
  readonly gravity?: 'down' | 'up';
  readonly rainCell?: number;
  readonly rng?: RngState;
}

/**
 * 測試用：從「種子 0 的賽程、兩個點在起始位置、沒有金幣、分數 0」出發，用 overrides 覆蓋。
 * `tick` 沒給就是 `phase × 600 + ruleTick`。
 */
export function makeState(overrides: StateOverrides = {}): JKBState {
  const base = initState(overrides.seed ?? 0, {
    maxTicks: overrides.maxTicks ?? DURATION_TICKS,
    params: {},
  });
  const schedule: Rule[] = [...(overrides.schedule ?? base.schedule)];
  const tickGiven = overrides.tick;
  const phase =
    overrides.phase ??
    (tickGiven === undefined ? 0 : Math.min(PHASES - 1, Math.floor(tickGiven / PHASE_TICKS)));
  const ruleTick =
    overrides.ruleTick ?? (tickGiven === undefined ? 0 : tickGiven - phase * PHASE_TICKS);
  if (overrides.rule !== undefined) {
    schedule[phase] = overrides.rule;
  }
  if (overrides.next !== undefined && overrides.next !== 'none' && phase + 1 < PHASES) {
    schedule[phase + 1] = overrides.next;
  }
  const rule = schedule[phase] as Rule;
  const av = (i: 0 | 1): JKBAvatar => ({
    x: overrides.avatars?.[i]?.x ?? (base.avatars[i] as JKBAvatar).x,
    y: overrides.avatars?.[i]?.y ?? (base.avatars[i] as JKBAvatar).y,
    shoveCd: overrides.avatars?.[i]?.shoveCd ?? 0,
    want: overrides.avatars?.[i]?.want ?? -1,
  });
  return {
    ...base,
    tick: tickGiven ?? phase * PHASE_TICKS + ruleTick,
    avatars: [av(0), av(1)],
    coins: overrides.coins ?? [],
    extra: overrides.extra ?? [],
    scores: overrides.scores ?? [0, 0],
    rng: overrides.rng ?? base.rng,
    phase,
    ruleTick,
    schedule,
    rule,
    next: overrides.next === 'none' ? 'none' : ((schedule[phase + 1] ?? 'none') as NextRule),
    gravity: overrides.gravity ?? (rule === 'gravity' ? gravityAt(ruleTick) : 'down'),
    rainCell: overrides.rainCell ?? -1,
  };
}
