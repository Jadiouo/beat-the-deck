import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';

/**
 * S-7 拔槍（小規格 `docs/cards/S-7.md`）。
 *
 * 中間的光「亮起來而且一直亮著」才是真訊號；假動作是一道只亮 30 tick 的假光，外表與真光一樣。
 * 訊號前按（搶拍）或按了假光都輸。按下去 8 tick 後才揭曉。
 * 純的：亂數只用 `RngState`，時間只有 tick。
 *
 * 隱藏資訊（`evaluate`、`actions` 一律不讀）：`flash.real`、`flash.makers` 裡對手的那一格、`waitLeft`、
 * 對手這一輪的 `twitches`、對手按下去的 `press.valid` 與 `press.own`、`rng`。
 */

export const ROUNDS = 9;
export const WIN_ROUNDS = 5;
export const WAIT_MIN = 90;
export const WAIT_SPAN = 280;
export const WAIT_MAX = WAIT_MIN + WAIT_SPAN - 1;
export const FAKE_TICKS = 30;
export const REAL_TIMEOUT = 150;
export const RESOLVE_TICKS = 8;
export const RESULT_TICKS = 120;
export const FEINTS = 6;
export const TWITCH_PER_ROUND = 2;
export const TWITCH_AFTER = WAIT_MIN;
export const WINDOW = 6;
export const UNIT = 1000;
export const FEINT_COST = 0.25;

/** 中間的光。`makers` 是誰抽動的（真光是兩個 false）；`real` 是這道光是不是真訊號。 */
export interface Flash {
  readonly age: number;
  readonly makers: readonly [boolean, boolean];
  readonly real: boolean;
}

/** 一次按 a：`valid` 是按下去那一刻光是不是真的（揭曉前隱藏）；`flashAge` 是當時光亮了多久（沒有光是 null）。 */
export interface Press {
  readonly at: number;
  readonly valid: boolean;
  readonly flashAge: number | null;
  /** 按的人自己抽過這道光（只有按的人自己知道）。 */
  readonly own: boolean;
}

export interface RoundRecord {
  readonly twitches: readonly [number, number];
  /** 每一次假動作是這一輪第幾 tick 亮起來的（公開，輪結束後才進歷史）。 */
  readonly twitchAt: readonly [readonly number[], readonly number[]];
  readonly baited: readonly [number, number];
  readonly winner: Side | null;
}

export interface LastRound {
  readonly winner: Side | null;
  readonly early: readonly [boolean, boolean];
  readonly baited: readonly [boolean, boolean];
}

export interface S7State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly round: number;
  readonly phase: 'wait' | 'result';
  /** 這一輪開始之後過了幾 tick。 */
  readonly elapsed: number;
  /** 真訊號還有幾 tick（隱藏）；0 表示已經亮了。 */
  readonly waitLeft: number;
  readonly flash: Flash | null;
  readonly press: readonly [Press | null, Press | null];
  /** 第一個人按下去之後倒數到揭曉；沒有人按是 null。 */
  readonly resolveIn: number | null;
  readonly resultLeft: number;
  readonly wins: readonly [number, number];
  /** 已經結束的輪數裡，每人用掉的假動作（公開）。 */
  readonly spent: readonly [number, number];
  /** 這一輪每人抽了幾次（隱藏，輪結束才進歷史）。 */
  readonly twitches: readonly [number, number];
  /** 這一輪每人每次抽動亮起來的時間（隱藏，輪結束才進歷史）。 */
  readonly twitchAt: readonly [readonly number[], readonly number[]];
  readonly heldA: readonly [boolean, boolean];
  readonly heldB: readonly [boolean, boolean];
  /** 最近 WINDOW 輪（公開）。 */
  readonly history: readonly RoundRecord[];
  readonly last: LastRound | null;
  readonly done: boolean;
  readonly rng: RngState;
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);

const IDLE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const DRAW: Buttons = { ...IDLE, a: true };
const TWITCH: Buttons = { ...IDLE, b: true };

function drawWait(rng: RngState): readonly [number, RngState] {
  const [roll, next] = intFrom(rng, WAIT_SPAN);
  return [WAIT_MIN + roll, next];
}

export function init(seed: number, config: GameConfig): S7State {
  const [waitLeft, rng] = drawWait(rngStateFor(seed, 's7'));
  return {
    tick: 0,
    maxTicks: config.maxTicks,
    round: 0,
    phase: 'wait',
    elapsed: 0,
    waitLeft,
    flash: null,
    press: [null, null],
    resolveIn: null,
    resultLeft: 0,
    wins: [0, 0],
    spent: [0, 0],
    twitches: [0, 0],
    twitchAt: [[], []],
    heldA: [false, false],
    heldB: [false, false],
    history: [],
    last: null,
    done: false,
    rng,
  };
}

export function isOver(s: S7State): boolean {
  return s.done || s.tick >= s.maxTicks;
}

/** 這一邊現在可以假動作嗎（`step` 與 `actions` 共用）。 */
function canTwitch(s: S7State, side: Side): boolean {
  return (
    s.phase === 'wait' &&
    s.flash === null &&
    s.press[0] === null &&
    s.press[1] === null &&
    s.elapsed >= TWITCH_AFTER &&
    s.twitches[side] < TWITCH_PER_ROUND &&
    s.spent[side] + s.twitches[side] < FEINTS
  );
}

/**
 * 兩邊按的結算：回傳贏的人（平手 null）。
 * 揭曉前（第一個人按下去之後 RESOLVE_TICKS tick）另一邊也按了：兩邊都有效算同時開槍，平手（不是誰比較快）；
 * 一邊有效一邊搶拍，有效的贏；兩邊都搶拍平手；只有一邊按：有效贏、搶拍輸。
 */
function settle(press: readonly [Press | null, Press | null]): Side | null {
  const [p0, p1] = press;
  if (p0 !== null && p1 !== null) {
    return p0.valid === p1.valid ? null : p0.valid ? 0 : 1;
  }
  if (p0 !== null) {
    return p0.valid ? 0 : 1;
  }
  if (p1 !== null) {
    return p1.valid ? 1 : 0;
  }
  return null;
}

export function step(s: S7State, inputs: Inputs): S7State {
  if (isOver(s)) {
    return s;
  }
  const tick = s.tick + 1;
  const heldA: readonly [boolean, boolean] = [inputs[0].a, inputs[1].a];
  const heldB: readonly [boolean, boolean] = [inputs[0].b, inputs[1].b];

  if (s.phase === 'result') {
    const left = s.resultLeft - 1;
    if (left > 0) {
      return { ...s, tick, resultLeft: left, heldA, heldB };
    }
    const [waitLeft, rng] = drawWait(s.rng);
    return {
      ...s,
      tick,
      round: s.round + 1,
      phase: 'wait',
      elapsed: 0,
      waitLeft,
      flash: null,
      press: [null, null],
      resolveIn: null,
      resultLeft: 0,
      twitches: [0, 0],
      twitchAt: [[], []],
      last: null,
      heldA,
      heldB,
      rng,
    };
  }

  // 等待階段。先看按鍵（對照的是這個 tick 開始之前看得到的光）。
  const press: [Press | null, Press | null] = [s.press[0], s.press[1]];
  let resolveIn = s.resolveIn === null ? null : s.resolveIn - 1;
  for (const side of [0, 1] as const) {
    if (inputs[side].a && !s.heldA[side] && press[side] === null) {
      const f = s.flash;
      press[side] = {
        at: s.elapsed,
        valid: f !== null && f.real,
        flashAge: f === null ? null : f.age,
        own: f !== null && f.makers[side],
      };
      if (resolveIn === null) {
        resolveIn = RESOLVE_TICKS - 1;
      }
    }
  }

  // 假動作。
  const twitchNow: [boolean, boolean] = [
    inputs[0].b && !s.heldB[0] && canTwitch(s, 0),
    inputs[1].b && !s.heldB[1] && canTwitch(s, 1),
  ];
  const twitches: [number, number] = [
    s.twitches[0] + (twitchNow[0] ? 1 : 0),
    s.twitches[1] + (twitchNow[1] ? 1 : 0),
  ];
  const twitchAt: [readonly number[], readonly number[]] = [
    twitchNow[0] ? [...s.twitchAt[0], s.elapsed] : s.twitchAt[0],
    twitchNow[1] ? [...s.twitchAt[1], s.elapsed] : s.twitchAt[1],
  ];

  // 光：老的長一歲、假光亮滿就熄；沒有光而有人抽動就亮一道新的假光。
  let flash: Flash | null = s.flash === null ? null : { ...s.flash, age: s.flash.age + 1 };
  if (flash !== null && !flash.real && flash.age >= FAKE_TICKS) {
    flash = null;
  }
  if (s.flash === null && (twitchNow[0] || twitchNow[1])) {
    flash = { age: 0, makers: [twitchNow[0], twitchNow[1]], real: false };
  }

  // 真訊號：時間到了，假光就地變成真光（age 連續），沒有光就亮一道新的。
  let waitLeft = s.waitLeft;
  if (waitLeft > 0) {
    waitLeft -= 1;
    if (waitLeft === 0) {
      flash =
        flash === null ? { age: 0, makers: [false, false], real: true } : { ...flash, real: true };
    }
  }

  const elapsed = s.elapsed + 1;
  const timedOut = resolveIn === null && flash !== null && flash.real && flash.age >= REAL_TIMEOUT;
  if (resolveIn === 0 || timedOut) {
    const winner = settle(press);
    const early: [boolean, boolean] = [
      press[0] !== null && press[0].flashAge === null,
      press[1] !== null && press[1].flashAge === null,
    ];
    const baited: [boolean, boolean] = [
      press[0] !== null && !press[0].valid && press[0].flashAge !== null,
      press[1] !== null && !press[1].valid && press[1].flashAge !== null,
    ];
    const wins: [number, number] = [
      s.wins[0] + (winner === 0 ? 1 : 0),
      s.wins[1] + (winner === 1 ? 1 : 0),
    ];
    const record: RoundRecord = {
      twitches,
      twitchAt,
      baited: [baited[0] ? 1 : 0, baited[1] ? 1 : 0],
      winner,
    };
    return {
      ...s,
      tick,
      phase: 'result',
      elapsed,
      waitLeft,
      flash: null,
      press,
      resolveIn: null,
      resultLeft: RESULT_TICKS,
      wins,
      spent: [s.spent[0] + twitches[0], s.spent[1] + twitches[1]],
      twitches,
      twitchAt,
      heldA,
      heldB,
      history: [...s.history, record].slice(-WINDOW),
      last: { winner, early, baited },
      done: wins[0] >= WIN_ROUNDS || wins[1] >= WIN_ROUNDS || s.round + 1 >= ROUNDS,
    };
  }

  return {
    ...s,
    tick,
    elapsed,
    waitLeft,
    flash,
    press,
    resolveIn,
    twitches,
    twitchAt,
    heldA,
    heldB,
  };
}

export function score(s: S7State): readonly [number, number] {
  return s.wins;
}

export function winner(s: S7State): Side | null {
  if (!isOver(s)) {
    return null;
  }
  return s.wins[0] > s.wins[1] ? 0 : s.wins[1] > s.wins[0] ? 1 : null;
}

export function actions(s: S7State, side: Side): readonly Buttons[] {
  if (isOver(s) || s.phase === 'result' || s.press[side] !== null) {
    return [IDLE];
  }
  if (s.flash !== null) {
    return [IDLE, DRAW];
  }
  return canTwitch(s, side) ? [IDLE, TWITCH] : [IDLE];
}

// ---------------------------------------------------------------------------
// 讀對手（4.1：歷史進 state，窗口 6 輪）。這幾個函式只讀公開的資訊。
// ---------------------------------------------------------------------------

/** `side` 的假動作率（每輪幾次）：窗口內的次數加 0.3 的平滑，除以（輪數 + 1）。 */
export function twitchRate(s: S7State, side: Side): number {
  let sum = 0;
  for (const r of s.history) {
    sum += r.twitches[side];
  }
  return (sum + 0.3) / (s.history.length + 1);
}

const KERNEL_HALF = 24;

/** 三角形的核：寬度 2 × KERNEL_HALF，面積 1。 */
function kernel(distance: number): number {
  return Math.max(0, 1 - Math.abs(distance) / KERNEL_HALF) / KERNEL_HALF;
}

/**
 * `side` 在這一輪第 `start` tick 抽動的密度（每輪、每 tick）：過去 6 輪裡它抽動的時間，疊成一座座小山，
 * 加上一點均勻的底（0.3 次／輪）。愛在同一個時間抽的人，那個時間的密度高。
 */
function fakeDensity(s: S7State, side: Side, start: number): number {
  let sum = 0.3 / WAIT_SPAN;
  for (const r of s.history) {
    for (const t of r.twitchAt[side]) {
      sum += kernel(start - t);
    }
  }
  return sum / (s.history.length + 1);
}

/**
 * `observer` 眼中，對手的一道亮了 `age` tick 的光是真訊號的機率。
 * 真訊號在 WAIT_SPAN 個 tick 裡均勻出現（每 tick 1/WAIT_SPAN），假光的密度看對手過去愛在什麼時候抽。
 * `start` 是這道光亮起的時間（預設從 `s.elapsed` 與 `age` 推出來）。
 */
export function pReal(s: S7State, observer: Side, age: number, start?: number): number {
  const opp = other(observer);
  if (age >= FAKE_TICKS || s.spent[opp] >= FEINTS) {
    return 1;
  }
  return 1 / (1 + WAIT_SPAN * fakeDensity(s, opp, start ?? s.elapsed - 1 - age));
}

/** `side` 眼中，對手看到自己的假光會上當的機率：（對手被騙的次數 + 1）÷（自己假動作的次數 + 3）。 */
export function pBite(s: S7State, side: Side): number {
  const opp = other(side);
  let bitten = 0;
  let faked = 0;
  for (const r of s.history) {
    bitten += r.baited[opp];
    faked += r.twitches[side];
  }
  return (bitten + 1) / (faked + 3);
}

/**
 * 對手上當的機會：過去上當的比例，乘上「它眼中我現在抽一道光有多可信」（我愛在這個時間抽，它就不信）。
 */
function biteChance(s: S7State, side: Side): number {
  return pBite(s, side) * (0.5 + pReal(s, other(side), 0, s.elapsed - 1));
}

/**
 * 我按下去（光已經亮了 `age` tick）之後，對手在揭曉前也按的機率（兩邊都按算平手）。
 * 光還沒亮滿 30 tick：對手信不信第一眼，取決於我的假動作率（我愛假動作，它就比較不會一看到就按）；
 * 亮滿之後，它多半也會馬上按。
 */
function otherPressesToo(s: S7State, side: Side, age: number): number {
  return age < FAKE_TICKS ? 0.2 / (1 + twitchRate(s, side)) : 0.5;
}

/** 真訊號在接下來 FAKE_TICKS tick 內出現的機率（只用公開的等待範圍推出來）。 */
function hazard(s: S7State): number {
  const remaining = WAIT_MAX + 1 - Math.max(s.elapsed, WAIT_MIN);
  return Math.min(1, FAKE_TICKS / Math.max(FAKE_TICKS, remaining));
}

export function evaluate(s: S7State, side: Side): { gain: number; danger: number } {
  const opp = other(side);
  const lead = s.wins[side] - s.wins[opp];
  if (isOver(s) || s.phase === 'result') {
    return { gain: UNIT * lead, danger: 0 };
  }
  const base = UNIT * lead - UNIT * FEINT_COST * (s.spent[side] + s.twitches[side]);

  const mine = s.press[side];
  if (mine !== null) {
    const pr =
      mine.flashAge === null
        ? 0
        : mine.own && mine.flashAge < FAKE_TICKS
          ? 0.1
          : pReal(s, side, mine.flashAge, mine.at - 1 - mine.flashAge);
    if (s.press[opp] !== null && mine.flashAge !== null) {
      // 兩邊都按了：同時開槍，平手。
      return { gain: base, danger: 1 - pr };
    }
    const q = otherPressesToo(s, side, mine.flashAge ?? 0);
    return { gain: base + UNIT * (pr * (1 - q) - (1 - pr)), danger: 1 - pr };
  }
  const theirs = s.press[opp];
  if (theirs !== null) {
    // 對手已經按了。如果它按的是我自己抽的假光（我自己知道），它一定是搶拍。
    const onMyFake =
      s.twitches[side] > 0 && theirs.flashAge !== null && theirs.flashAge < FAKE_TICKS;
    const pr = theirs.flashAge === null ? 0 : onMyFake ? 0.1 : pReal(s, side, theirs.flashAge);
    return { gain: base + UNIT * (1 - 2 * pr), danger: 0 };
  }
  const f = s.flash;
  if (f !== null && f.makers[side] && f.age < FAKE_TICKS) {
    const bite = biteChance(s, side);
    // 危險：假光沒有騙到人（對手不上當）、或假光撞上真訊號。
    const effective = Math.min(1, bite) * (1 - 0.5 * hazard(s));
    return { gain: base + UNIT * bite * (1 + f.age / 100), danger: 1 - effective };
  }
  return { gain: base, danger: 0 };
}

export interface StateOverrides {
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly round?: number;
  readonly phase?: 'wait' | 'result';
  readonly elapsed?: number;
  readonly waitLeft?: number;
  readonly flash?: Flash | null;
  readonly press?: readonly [Press | null, Press | null];
  readonly resolveIn?: number | null;
  readonly resultLeft?: number;
  readonly wins?: readonly [number, number];
  readonly spent?: readonly [number, number];
  readonly twitches?: readonly [number, number];
  readonly twitchAt?: readonly [readonly number[], readonly number[]];
  readonly heldA?: readonly [boolean, boolean];
  readonly heldB?: readonly [boolean, boolean];
  readonly history?: readonly RoundRecord[];
  readonly last?: LastRound | null;
  readonly done?: boolean;
  readonly rng?: RngState;
}

/** 測試用：直接構造局面（預設：第一輪、等待中、這輪已過 100 tick、真訊號還有 100 tick、沒有光；真光預設 `waitLeft` 是 0）。 */
export function makeState(o: StateOverrides = {}): S7State {
  const flash = o.flash ?? null;
  return {
    tick: o.tick ?? 0,
    maxTicks: o.maxTicks ?? 3600,
    round: o.round ?? 0,
    phase: o.phase ?? 'wait',
    elapsed: o.elapsed ?? 100,
    waitLeft: o.waitLeft ?? (flash !== null && flash.real ? 0 : 100),
    flash,
    press: o.press ?? [null, null],
    resolveIn: o.resolveIn ?? null,
    resultLeft: o.resultLeft ?? 0,
    wins: o.wins ?? [0, 0],
    spent: o.spent ?? [0, 0],
    twitches: o.twitches ?? [0, 0],
    twitchAt: o.twitchAt ?? [[], []],
    heldA: o.heldA ?? [false, false],
    heldB: o.heldB ?? [false, false],
    history: o.history ?? [],
    last: o.last ?? null,
    done: o.done ?? false,
    rng: o.rng ?? rngStateFor(0, 's7'),
  };
}

export const s7Game: Game<S7State> = {
  id: 'S-7',
  init,
  step,
  isOver,
  score,
  winner,
  actions,
  evaluate,
};
