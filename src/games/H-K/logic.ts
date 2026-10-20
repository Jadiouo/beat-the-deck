import { intFrom, rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { IDLE, PRESS_A, PRESS_B, otherSide } from '../_hearts/logic';
import { h4Game } from '../H-4/logic';
import { h5Game } from '../H-5/logic';
import { h6Game } from '../H-6/logic';
import { h9Game } from '../H-9/logic';
import { h10Game } from '../H-10/logic';
import { hJGame } from '../H-J/logic';
import { hQGame } from '../H-Q/logic';

/**
 * H-K 紅心馬拉松（SPEC 第 9 節；小規格 `docs/cards/H-K.md`）。
 *
 * 同一筆籌碼連打四場縮短版的紅心牌；每場開打前兩邊同時暗中決定要不要用掉自己唯一的加倍牌，
 * 贏的人按賭注（`STAKE × 倍數`）拿走輸的人的籌碼，四場後籌碼多的贏。
 *
 * **這一層沒有自己的 AI 互動**（DESIGN-AI-FUN 10.27 的裁定：四張 K 是馬拉松包裝牌）：加倍層整場只有 4 次決定，
 * 互動全部借自被包的牌。`step`、`actions`、`evaluate` 在 `play` 階段原樣委派給目前這一場的那張牌；
 * 只有 `bet` 階段（開場決定）是 H-K 自己的。
 *
 * **成本**：`evaluate` 只算目前這一場（呼叫一次被包的牌的 `evaluate`，再加一個最多 16 × 5 種情形的小列舉），
 * 不隨場數增加，因為搜尋深度會把它乘上去（DESIGN-AI-FUN 10.44）。
 *
 * **資訊限制**：`evaluate` 與 `actions` 不讀對方的 `pending`，也不讀它造成的 `used`、`mult`、揭示時才扣的 `doublers`
 * （搜尋裡「對方已經選好」的局面，這些會洩漏它選了什麼）。`play` 階段起倍數公開，才讀 `mult`。
 */

// ---------------------------------------------------------------------------
// 常數與型別
// ---------------------------------------------------------------------------

export const STAGES = 4;
export const STAKE = 10;
export const DOUBLERS = 1;
export const START_CHIPS = 100;
/** 每場開打前的準備（輸入忽略；AI 與人一樣）。 */
export const BET_PREP = 45;
/** 開場決定最多等幾個 tick，超時自動不用。 */
export const BET_TIMEOUT = 120;
/** 兩邊都選好之後，鎖定幾個 tick 才揭示。 */
export const LOCK_TICKS = 2;
/** 揭示之後停幾個 tick 才開打（讓人看清楚倍數）。 */
export const REVEAL_TICKS = 30;
/** 一場結束之後停幾個 tick 才換下一場（讓人看清楚結果）。 */
export const RESULT_TICKS = 30;
/** `maxTicks` 小於這個數 `init` 丟 `RangeError`。 */
export const MIN_MAX_TICKS = STAGES * 400;
/** 反射規則的小加分：遠小於任何真正的期望值差。 */
export const HABIT = 0.01;

/** 場次池，依牌面由小到大。為什麼是這幾張、為什麼不含 H-7 與 H-8：見小規格「場次池」。 */
export type StageId = 'H-4' | 'H-5' | 'H-6' | 'H-9' | 'H-10' | 'H-J' | 'H-Q';
export const STAGE_POOL: readonly StageId[] = ['H-4', 'H-5', 'H-6', 'H-9', 'H-10', 'H-J', 'H-Q'];

/**
 * edge 表：站在 `side` 這一邊、用搜尋型等級 10 打那張牌的縮短版（`maxTicks = 673`），
 * 對人類模型（SPEC 7.3）的實測勝率（平手算半場，兩個座位各 500 場合併，限制在 [0.05, 0.95]；兩個座位的差在雜訊內，所以兩格填同一個數）。
 * 它代表「AI 對一個一般的人，在這一場有多大的優勢」，不是「兩個 AI 打」的勝率（鏡像牌兩個 AI 打必然 0.5）。
 * 量法與每一個數字：`docs/cards/H-K.md`「edge 表」。
 */
export const EDGE: Readonly<Record<StageId, readonly [number, number]>> = {
  'H-4': [0.57, 0.57],
  'H-5': [0.53, 0.53],
  'H-6': [0.53, 0.53],
  'H-9': [0.57, 0.57],
  'H-10': [0.95, 0.95],
  'H-J': [0.48, 0.48],
  'H-Q': [0.95, 0.95],
};

/**
 * 斜率表：打到一半時，被包的牌的 `evaluate` gain 換成勝率的斜率。
 * 勝率 = σ(logit(edge) + SLOPE × gain)；每張牌的 gain 單位不同，所以逐張用對局資料做有偏移量的 logistic 迴歸。
 */
export const SLOPE: Readonly<Record<StageId, number>> = {
  'H-4': 0.492,
  'H-5': 1.055,
  'H-6': 0.047,
  'H-9': 2.335,
  'H-10': 0.317,
  'H-J': 0.46,
  'H-Q': 0.077,
};

/** 開場的選擇：0 不用、1 用掉加倍牌。 */
export type Move = 0 | 1;
export type HKPhase = 'betPrep' | 'bet' | 'betLocked' | 'betReveal' | 'play' | 'stageResult';

/** 被包的牌的 state（完整放進來，JSON 可序列化）。 */
export type Sub = unknown;

/** 已結束的一場（公開）。 */
export interface HKResult {
  readonly id: StageId;
  /** 被包的牌的贏家；平手是 `null`。 */
  readonly winner: Side | null;
  readonly mult: number;
  /** 贏的人拿走多少（平手 0）。 */
  readonly delta: number;
  readonly used: readonly [boolean, boolean];
}

export interface HKState {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  readonly seed: number;
  /** 每一場被包的牌的 `maxTicks`。 */
  readonly stageTicks: number;
  /** 現在第幾場（0 到 3；最後一場結算完就結束）。 */
  readonly stageIdx: 0 | 1 | 2 | 3;
  /** 四場的牌 id（公開）。 */
  readonly stages: readonly StageId[];
  readonly chips: readonly [number, number];
  /** 各剩幾張加倍牌（公開）。揭示時不扣，進 `play` 才扣。 */
  readonly doublers: readonly [number, number];
  readonly phase: HKPhase;
  /** betPrep、betLocked、betReveal、stageResult 還剩幾個 tick。 */
  readonly wait: number;
  /** bet 階段已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  /** 這場兩邊的選擇（`null` 是還沒選）。對手的是隱藏資訊。 */
  readonly pending: readonly [Move | null, Move | null];
  /** 揭示之後：兩邊有沒有用加倍牌。 */
  readonly used: readonly [boolean, boolean];
  /** 揭示之後：這場的倍數（1 + 用的人數）。 */
  readonly mult: number;
  /** 這場被包的牌的 state。 */
  readonly sub: Sub;
  readonly results: readonly HKResult[];
  /** 消融開關（`config.params.flat = 1`）：edge 表全當 0.5，就是 DESIGN-AI-FUN 10.19 的第一版（量鑑別力用）。 */
  readonly flat: boolean;
}

type Delegate = Game<unknown>;
const DELEGATES: Readonly<Record<StageId, Delegate>> = {
  'H-4': h4Game as unknown as Delegate,
  'H-5': h5Game as unknown as Delegate,
  'H-6': h6Game as unknown as Delegate,
  'H-9': h9Game as unknown as Delegate,
  'H-10': h10Game as unknown as Delegate,
  'H-J': hJGame as unknown as Delegate,
  'H-Q': hQGame as unknown as Delegate,
};

// ---------------------------------------------------------------------------
// 賽程與時間
// ---------------------------------------------------------------------------

/** 每場被包的牌的 `maxTicks`：最壞情況（每場都等滿）四場剛好用完 `maxTicks`。 */
export function stageTicksFor(maxTicks: number): number {
  const overhead = BET_PREP + BET_TIMEOUT + LOCK_TICKS + REVEAL_TICKS + RESULT_TICKS;
  return Math.floor((maxTicks - STAGES * overhead) / STAGES);
}

/** 這個種子的賽程：從池裡不重複地抽 4 張，再依牌面由小到大排。 */
export function scheduleFor(seed: number): readonly StageId[] {
  const rest = [...STAGE_POOL];
  let rng = rngStateFor(seed, 'stages');
  const picked: StageId[] = [];
  while (picked.length < STAGES) {
    const [index, following] = intFrom(rng, rest.length);
    rng = following;
    picked.push(rest.splice(index, 1)[0] as StageId);
  }
  return picked.sort((a, b) => STAGE_POOL.indexOf(a) - STAGE_POOL.indexOf(b));
}

/** 第 `idx` 場被包的牌用的種子（由 H-K 的種子與場序導出，各場獨立）。 */
export function stageSeedFor(seed: number, idx: number): number {
  return intFrom(rngStateFor(seed, `stage${idx}`), 2 ** 30)[0];
}

function openStage(seed: number, id: StageId, idx: number, stageTicks: number): Sub {
  return DELEGATES[id].init(stageSeedFor(seed, idx), { maxTicks: stageTicks, params: {} });
}

/** 測試用：從「第 0 場、準備剛開始、兩邊 100」出發，用 overrides 覆蓋；沒給 `sub` 就開那一場的新局。 */
export function makeState(overrides: Partial<HKState> = {}): HKState {
  const seed = overrides.seed ?? 0;
  const maxTicks = overrides.maxTicks ?? 3600;
  const stageTicks = overrides.stageTicks ?? stageTicksFor(maxTicks);
  const stages = overrides.stages ?? scheduleFor(seed);
  const stageIdx = overrides.stageIdx ?? 0;
  return {
    tick: 0,
    maxTicks,
    over: false,
    winner: null,
    seed,
    stageTicks,
    stageIdx,
    stages,
    chips: [START_CHIPS, START_CHIPS],
    doublers: [DOUBLERS, DOUBLERS],
    phase: 'betPrep',
    wait: BET_PREP,
    idle: 0,
    pending: [null, null],
    used: [false, false],
    mult: 1,
    results: [],
    flat: false,
    ...overrides,
    sub: overrides.sub ?? openStage(seed, stages[stageIdx] as StageId, stageIdx, stageTicks),
  };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

/** 這個 tick 的按鍵是哪個選擇：b 最優先（同按算不用），其次 a；其他鍵沒有作用。 */
function moveFromButtons(buttons: Buttons): Move | null {
  if (buttons.b) {
    return 0;
  }
  return buttons.a ? 1 : null;
}

function winnerByChips(chips: readonly [number, number]): Side | null {
  if (chips[0] === chips[1]) {
    return null;
  }
  return chips[0] > chips[1] ? 0 : 1;
}

function finish(state: HKState): HKState {
  return { ...state, over: true, winner: winnerByChips(state.chips) };
}

/** 進 bet：沒有加倍牌的那一邊自動「不用」；兩邊都沒有就直接鎖定。 */
function enterBet(state: HKState, tick: number): HKState {
  const pending: [Move | null, Move | null] = [
    state.doublers[0] > 0 ? null : 0,
    state.doublers[1] > 0 ? null : 0,
  ];
  const next: HKState = { ...state, tick, phase: 'bet', wait: 0, idle: 0, pending };
  return pending[0] !== null && pending[1] !== null
    ? { ...next, phase: 'betLocked', wait: LOCK_TICKS }
    : next;
}

function stepBet(state: HKState, inputs: Inputs, tick: number): HKState {
  const timeout = state.idle + 1 >= BET_TIMEOUT;
  const pending: [Move | null, Move | null] = [state.pending[0], state.pending[1]];
  for (const side of [0, 1] as const) {
    if (pending[side] !== null) {
      continue;
    }
    const pressed = moveFromButtons(inputs[side]);
    if (pressed !== null) {
      pending[side] = pressed;
    } else if (timeout) {
      pending[side] = 0;
    }
  }
  const moved: HKState = { ...state, tick, pending, idle: state.idle + 1 };
  return pending[0] !== null && pending[1] !== null
    ? { ...moved, phase: 'betLocked', wait: LOCK_TICKS }
    : moved;
}

/** 揭示：公開兩邊有沒有用、倍數是多少。加倍牌這時還不扣（進 play 才扣）。 */
function reveal(state: HKState, tick: number): HKState {
  const used: [boolean, boolean] = [state.pending[0] === 1, state.pending[1] === 1];
  return {
    ...state,
    tick,
    phase: 'betReveal',
    wait: REVEAL_TICKS,
    used,
    mult: 1 + (used[0] ? 1 : 0) + (used[1] ? 1 : 0),
  };
}

function toPlay(state: HKState, tick: number): HKState {
  return {
    ...state,
    tick,
    phase: 'play',
    wait: 0,
    pending: [null, null],
    doublers: [
      state.doublers[0] - (state.used[0] ? 1 : 0),
      state.doublers[1] - (state.used[1] ? 1 : 0),
    ],
  };
}

/** 被包的牌這一場結束：贏的人從輸的人拿走 `STAKE × 倍數`（平手不動）。只在這裡動籌碼，所以不會被重算。 */
function settle(state: HKState, sub: Sub, tick: number): HKState {
  const id = state.stages[state.stageIdx] as StageId;
  const winner = DELEGATES[id].winner(sub);
  const delta = winner === null ? 0 : STAKE * state.mult;
  const chips: [number, number] = [state.chips[0], state.chips[1]];
  if (winner !== null) {
    chips[winner] += delta;
    chips[otherSide(winner)] -= delta;
  }
  return {
    ...state,
    tick,
    sub,
    chips,
    phase: 'stageResult',
    wait: RESULT_TICKS,
    results: [...state.results, { id, winner, mult: state.mult, delta, used: state.used }],
  };
}

function nextStage(state: HKState, tick: number): HKState {
  const idx = (state.stageIdx + 1) as 1 | 2 | 3;
  return {
    ...state,
    tick,
    stageIdx: idx,
    phase: 'betPrep',
    wait: BET_PREP,
    idle: 0,
    pending: [null, null],
    used: [false, false],
    mult: 1,
    sub: openStage(state.seed, state.stages[idx] as StageId, idx, state.stageTicks),
  };
}

function stepHK(state: HKState, inputs: Inputs): HKState {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: HKState;
  switch (state.phase) {
    case 'betPrep':
      after = state.wait <= 1 ? enterBet(state, tick) : { ...state, tick, wait: state.wait - 1 };
      break;
    case 'bet':
      after = stepBet(state, inputs, tick);
      break;
    case 'betLocked':
      after = state.wait <= 1 ? reveal(state, tick) : { ...state, tick, wait: state.wait - 1 };
      break;
    case 'betReveal':
      after = state.wait <= 1 ? toPlay(state, tick) : { ...state, tick, wait: state.wait - 1 };
      break;
    case 'play': {
      const game = DELEGATES[state.stages[state.stageIdx] as StageId];
      const sub = game.step(state.sub, inputs);
      after = game.isOver(sub) ? settle(state, sub, tick) : { ...state, tick, sub };
      break;
    }
    default:
      if (state.wait > 1) {
        after = { ...state, tick, wait: state.wait - 1 };
      } else {
        after = state.stageIdx >= STAGES - 1 ? finish({ ...state, tick }) : nextStage(state, tick);
      }
  }
  // 最壞情況也剛好在 maxTicks 內走完（見 `stageTicksFor`）；這一行只擋被改過的 maxTicks 之類的意外。
  return !after.over && tick >= state.maxTicks ? finish(after) : after;
}

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);
/** 不用排第一：搜尋時模擬的對手按第一個，那是會登記的按鍵，會推進結算（DESIGN-AI-FUN 10.6 陷阱二）。 */
const BET_ACTIONS: readonly Buttons[] = Object.freeze([PRESS_B, PRESS_A]);

function actionsHK(state: HKState, side: Side): readonly Buttons[] {
  if (state.over) {
    return ONLY_IDLE;
  }
  if (state.phase === 'bet') {
    // 只看自己有沒有選，不看對手的 pending（不偷看）。
    return state.pending[side] === null && state.doublers[side] > 0 ? BET_ACTIONS : ONLY_IDLE;
  }
  if (state.phase === 'play') {
    return DELEGATES[state.stages[state.stageIdx] as StageId].actions(state.sub, side);
  }
  return ONLY_IDLE;
}

const LAST = STAGES - 1;
/** 對手領先或落後這麼多籌碼以上，才調整它用加倍牌的意願（一場最少轉移 20）。 */
const LEAD_MARGIN = 2 * STAKE;
const WIN_SCALE = 100;
const MU_WEIGHT = 0.01;
const SUB_TAIL = 0.01;
const SUB_TAIL_CAP = 50;
const P_MIN = 1e-6;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function logit(p: number): number {
  return Math.log(p / (1 - p));
}

/**
 * 站在 `side` 看：對手的加倍牌在第 `from` 場起各場被用掉的機率（只讀公開資訊）。
 * 對手沒有加倍牌就是 0；有的話，一半均勻分在剩下的場次、一半放在「對我最弱的那一場」（它的最佳場次）；
 * 對手領先 ≥ 20 較不用（最後一場不用），落後 ≥ 20 較用。
 */
function opponentUse(state: HKState, side: Side, from: number): number[] {
  const q = [0, 0, 0, 0];
  const opp = otherSide(side);
  if (state.doublers[opp] <= 0 || from > LAST) {
    return q;
  }
  let smart = from;
  let weakest = 2;
  for (let j = from; j <= LAST; j += 1) {
    const mine = edgeOf(state, side, j);
    if (mine < weakest) {
      weakest = mine;
      smart = j;
    }
  }
  const lead = state.chips[opp] - state.chips[side];
  const count = STAGES - from;
  for (let j = from; j <= LAST; j += 1) {
    const base = 0.5 / count + (j === smart ? 0.5 : 0);
    const factor = lead >= LEAD_MARGIN ? (j === LAST ? 0 : 0.25) : lead <= -LEAD_MARGIN ? 1.5 : 1;
    q[j] = Math.min(1, base * factor);
  }
  return q;
}

interface Outlook {
  /** 最後籌碼比對手多的機率（平手算半）。 */
  readonly win: number;
  /** 最後籌碼差的期望值。 */
  readonly mean: number;
}

/**
 * 從第 `open` 場起（含），我的加倍牌用在 `use` 場（-1 是不用）的最後結果。
 * `ps[j]` 是我贏第 j 場的機率；`fixedMult` 不是 null 時，第 `open` 場的倍數已定（play 階段，公開）。
 * 沒贏也沒輸的平手場按 0 計，所以 `ps` 是「贏的份額」（平手算半），這是一個近似。
 * 場次最多 4 場，直接列舉 2^k 種輸贏。
 */
function enumerate(
  diff: number,
  open: number,
  use: number,
  ps: readonly number[],
  q: readonly number[],
  fixedMult: number | null,
): Outlook {
  const k = STAGES - open;
  const t = [0, 0, 0, 0];
  let mean = diff;
  for (let i = 0; i < k; i += 1) {
    const j = open + i;
    const mult =
      i === 0 && fixedMult !== null ? fixedMult : 1 + (use === j ? 1 : 0) + (q[j] as number);
    t[i] = 2 * STAKE * mult;
    mean += (t[i] as number) * (2 * (ps[j] as number) - 1);
  }
  let win = 0;
  for (let mask = 0; mask < 1 << k; mask += 1) {
    let weight = 1;
    let total = diff;
    for (let i = 0; i < k; i += 1) {
      const p = ps[open + i] as number;
      if ((mask >> i) & 1) {
        weight *= p;
        total += t[i] as number;
      } else {
        weight *= 1 - p;
        total -= t[i] as number;
      }
    }
    win += weight * (total > 1e-9 ? 1 : total < -1e-9 ? 0 : 0.5);
  }
  return { win, mean };
}

/** 候選的用法（我的加倍牌用在哪一場；-1 不用）裡最好的那個：先比最後贏的機率，再比期望籌碼差；同分取不用。 */
function bestPlan(
  diff: number,
  open: number,
  candidates: readonly number[],
  ps: readonly number[],
  q: readonly number[],
  fixedMult: number | null,
): Outlook {
  let best: Outlook | null = null;
  for (const use of candidates) {
    const outlook = enumerate(diff, open, use, ps, q, fixedMult);
    if (
      best === null ||
      outlook.win > best.win + 1e-12 ||
      (Math.abs(outlook.win - best.win) <= 1e-12 && outlook.mean > best.mean + 1e-12)
    ) {
      best = outlook;
    }
  }
  return best as Outlook;
}

/** 自己的 edge 表：第 j 場我贏的機率（沒打到一半的場次）。 */
function edgeOf(state: HKState, side: Side, j: number): number {
  if (state.flat) {
    return 0.5;
  }
  return (EDGE[state.stages[j] as StageId] as readonly [number, number])[side];
}

function gainFrom(outlook: Outlook, tail: number): number {
  return WIN_SCALE * (2 * outlook.win - 1) + MU_WEIGHT * outlook.mean + tail;
}

/**
 * 結算之後、還沒打的場次：我最後贏的機率與期望籌碼差。
 * `decided`：目前這場我的選擇（`null` = 還沒決定，候選裡包含「現在用」）。
 */
function outlookBefore(state: HKState, side: Side, decided: Move | null): Outlook {
  const cur = state.stageIdx;
  const diff = state.chips[side] - state.chips[otherSide(side)];
  const ps = [0, 0, 0, 0];
  for (let j = cur; j <= LAST; j += 1) {
    ps[j] = edgeOf(state, side, j);
  }
  const q = opponentUse(state, side, cur);
  const holds = state.doublers[side] > 0;
  const candidates: number[] = [];
  if (decided === 1) {
    candidates.push(cur);
  } else {
    candidates.push(-1);
    if (holds) {
      for (let j = decided === 0 ? cur + 1 : cur; j <= LAST; j += 1) {
        candidates.push(j);
      }
    }
  }
  return bestPlan(diff, cur, candidates, ps, q, null);
}

function evaluateHK(state: HKState, side: Side): { gain: number; danger: number } {
  const opp = otherSide(side);
  const diff = state.chips[side] - state.chips[opp];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: diff + sign * 1000, danger: 0 };
  }
  const mine = state.pending[side];
  switch (state.phase) {
    case 'betPrep':
      return { gain: gainFrom(outlookBefore(state, side, null), 0), danger: 0 };
    case 'bet':
    case 'betLocked': {
      if (mine === null) {
        return { gain: gainFrom(outlookBefore(state, side, null), 0), danger: 0 };
      }
      // 淺搜尋（深度 1、2）只走到這裡：只剩反射規則，加倍牌留到最後一場。
      const reflex: Move = state.stageIdx === LAST && state.doublers[side] > 0 ? 1 : 0;
      return { gain: diff + (mine === reflex ? HABIT : 0), danger: 0 };
    }
    case 'betReveal':
      // 對方這場選了什麼、倍數、對方的 used 都不讀（搜尋裡它們會洩漏 pending）；對手用模型。
      return { gain: gainFrom(outlookBefore(state, side, mine ?? 0), 0), danger: 0 };
    case 'play': {
      const cur = state.stageIdx;
      const id = state.stages[cur] as StageId;
      const inner = DELEGATES[id].evaluate(state.sub, side);
      const edge = edgeOf(state, side, cur);
      const pCur = Math.min(
        1 - P_MIN,
        Math.max(P_MIN, sigmoid(logit(edge) + SLOPE[id] * inner.gain)),
      );
      const ps = [0, 0, 0, 0];
      ps[cur] = pCur;
      for (let j = cur + 1; j <= LAST; j += 1) {
        ps[j] = edgeOf(state, side, j);
      }
      const q = opponentUse(state, side, cur + 1);
      const candidates = [-1];
      if (state.doublers[side] > 0) {
        for (let j = cur + 1; j <= LAST; j += 1) {
          candidates.push(j);
        }
      }
      const outlook = bestPlan(diff, cur, candidates, ps, q, state.mult);
      const tail = SUB_TAIL * Math.min(SUB_TAIL_CAP, Math.max(-SUB_TAIL_CAP, inner.gain));
      return { gain: gainFrom(outlook, tail), danger: inner.danger };
    }
    default: {
      // stageResult：這一場已經結算，剩下 stageIdx + 1 起的場次
      const open = state.stageIdx + 1;
      if (open > LAST) {
        const win = diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
        return { gain: gainFrom({ win, mean: diff }, 0), danger: 0 };
      }
      const ps = [0, 0, 0, 0];
      for (let j = open; j <= LAST; j += 1) {
        ps[j] = edgeOf(state, side, j);
      }
      const q = opponentUse(state, side, open);
      const candidates = [-1];
      if (state.doublers[side] > 0) {
        for (let j = open; j <= LAST; j += 1) {
          candidates.push(j);
        }
      }
      return { gain: gainFrom(bestPlan(diff, open, candidates, ps, q, null), 0), danger: 0 };
    }
  }
}

export const hkGame: Game<HKState> = {
  id: 'H-K',

  init(seed: number, config: GameConfig): HKState {
    if (!Number.isInteger(config.maxTicks) || config.maxTicks < MIN_MAX_TICKS) {
      throw new RangeError(
        `config.maxTicks 必須是 ${MIN_MAX_TICKS} 以上的整數，收到 ${String(config.maxTicks)}`,
      );
    }
    return makeState({ seed, maxTicks: config.maxTicks, flat: config.params['flat'] === 1 });
  },

  step(state: HKState, inputs: Inputs): HKState {
    return stepHK(state, inputs);
  },

  isOver(state: HKState): boolean {
    return state.over;
  },

  score(state: HKState): readonly [number, number] {
    return [state.chips[0], state.chips[1]];
  },

  winner(state: HKState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: HKState, side: Side): readonly Buttons[] {
    return actionsHK(state, side);
  },

  evaluate(state: HKState, side: Side): { gain: number; danger: number } {
    return evaluateHK(state, side);
  },
};
