import { intFrom, rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { FINAL, POOL, poolEntry } from './pool';
import type { PoolEntry } from './pool';

/**
 * S-K 黑桃馬拉松（小規格 `docs/cards/S-K.md`）。
 *
 * 變化牌（DESIGN-AI-FUN 10.27）：5 段，前 4 段雙方輪流從 4 張候選牌裡挑一張，第 5 段固定是 S-5（權重 2）。
 * 每段的規則與 AI 全部借自被包的牌：`step`／`actions`／`evaluate` 在遊戲階段原樣轉發。
 * 選牌層自己的 `evaluate` 讀 ledger（我在哪一家族贏得多），但一場只有 4 次決定，沒有宣稱互動強度。
 *
 * 純的：亂數只用 `rngStateFor`／`intFrom`（由種子與標籤推導），時間只有 tick；
 * `step` 不改傳入的 state（遞迴成立：被包的牌的 `step` 也是純的）。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

export const SEGMENTS = 5;
export const FINAL_WEIGHT = 2;
/** 選牌階段最多 120 tick，逾時自動鎖定第一張。 */
export const PICK_TICKS = 120;
/** 鎖定之後公開 30 tick（雙方都不能動），才開始那一段。 */
export const SHOW_TICKS = 30;
/** 一段結束後停 45 tick 看結果。 */
export const REST_TICKS = 45;

const MAX_SPRINT = Math.max(...POOL.map((entry) => entry.sprintTicks));
/** 最壞的一場總長：4 段（最長的衝刺）＋決勝。 */
export const FULL_TICKS =
  (SEGMENTS - 1) * (PICK_TICKS + SHOW_TICKS + MAX_SPRINT + REST_TICKS) +
  SHOW_TICKS +
  FINAL.sprintTicks;
/** `maxTicks` 的下限：比這短，連一次挑牌加一個衝刺都不夠。 */
export const MIN_MAX_TICKS = 1800;

const OFFER_SIZE = 4;
/** 選牌的 `evaluate`：鎖定比等著至少高這麼多（嚴格大於，拖延不是平手）。 */
const LOCK_EDGE = 0.05;
/** E 裡「大贏機會」先驗的權重。 */
const UPSIDE_WEIGHT = 0.1;

const NONE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});
const KEYS = ['up', 'down', 'left', 'right'] as const;
const IDLE_ACTIONS: readonly Buttons[] = [NONE];

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export type SKPhase = 'pick' | 'show' | 'play' | 'rest' | 'over';

/** 一段的結算。`mm` 是 0 號邊的差距，千分位、偶數、夾在 ±1000；結算之後永遠不重算。 */
export interface SKLedgerEntry {
  readonly cardId: string;
  readonly family: string;
  /** 這一段是誰挑的；決勝是 null。 */
  readonly picker: Side | null;
  readonly weight: number;
  readonly mm: number;
}

export interface SKState {
  readonly tick: number;
  readonly maxTicks: number;
  readonly seed: number;
  /** 步調：`min(1, maxTicks / FULL_TICKS)`；`maxTicks` 比最壞總長短時，各階段與衝刺按比例縮短。 */
  readonly pace: number;
  /** 第 1、3 段的挑牌人。 */
  readonly first: Side;
  readonly phase: SKPhase;
  /** 0 到 4。 */
  readonly seg: number;
  /** 這個階段已經過幾個 tick。 */
  readonly phaseTick: number;
  readonly picker: Side | null;
  /** 候選牌（公開）。 */
  readonly offer: readonly string[];
  readonly cardId: string | null;
  /**
   * 挑牌人已經放開過方向鍵：上一段按著的鍵（例如還在往左閃）不會一進挑牌階段就直接鎖定。
   * 開局的第一次挑牌是 true；之後每次挑牌階段開始是 false，要先有一個 tick 四個方向鍵都放開才變成 true。
   */
  readonly armed: boolean;
  /** 這一段傳給被包的牌的 `maxTicks`。 */
  readonly segMax: number;
  /** 被包的牌的 state（純 JSON）；挑牌與 show 階段是 null，rest 階段留著這一段的終局。 */
  readonly inner: unknown;
  readonly ledger: readonly SKLedgerEntry[];
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const other = (side: Side): Side => (side === 0 ? 1 : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** 一段的段種子（由種子與段序推導）。 */
export function segmentSeed(seed: number, seg: number): number {
  return rngStateFor(seed, `seg${String(seg)}`);
}

/** 差距換成千分位的 m：`clamp(差 / scale, −1, 1)`，四捨五入到偶數，所以兩邊的分數都是整數。 */
export function marginMilli(diff: number, scale: number): number {
  const value = 2 * Math.round(clamp(diff / scale, -1, 1) * 500);
  return value === 0 ? 0 : value;
}

function durations(pace: number): { pick: number; show: number; rest: number } {
  return {
    pick: Math.max(1, Math.round(PICK_TICKS * pace)),
    show: Math.max(1, Math.round(SHOW_TICKS * pace)),
    rest: Math.max(1, Math.round(REST_TICKS * pace)),
  };
}

function pickerOf(first: Side, seg: number): Side | null {
  if (seg >= SEGMENTS - 1) {
    return null;
  }
  return seg % 2 === 0 ? first : other(first);
}

/** 從「還沒打過的牌」抽最多 4 張當候選（Fisher–Yates，亂數由種子與段序推導）。 */
function offerFor(seed: number, seg: number, used: readonly string[]): string[] {
  const rest = POOL.map((entry) => entry.id).filter((id) => !used.includes(id));
  let rng = rngStateFor(seed, `offer${String(seg)}`);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const [j, next] = intFrom(rng, i + 1);
    rng = next;
    const a = rest[i] as string;
    rest[i] = rest[j] as string;
    rest[j] = a;
  }
  return rest.slice(0, OFFER_SIZE);
}

function lockedIndex(buttons: Buttons, offerLength: number): number {
  for (let i = 0; i < KEYS.length; i += 1) {
    if (buttons[KEYS[i] as (typeof KEYS)[number]]) {
      return i < offerLength ? i : -1;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 結算與計分
// ---------------------------------------------------------------------------

/** 0 號邊的總分（千分位 × 權重）：只由 ledger 決定，沒有別的來源。 */
function scoreOf(ledger: readonly SKLedgerEntry[]): readonly [number, number] {
  let a = 0;
  let b = 0;
  for (const entry of ledger) {
    a += (entry.weight * (1000 + entry.mm)) / 2;
    b += (entry.weight * (1000 - entry.mm)) / 2;
  }
  return [a, b];
}

function settle(state: SKState): SKLedgerEntry {
  const card = poolEntry(state.cardId as string);
  const raw = card.game.score(state.inner);
  // 標度跟著實際的衝刺長度走（步調小於 1 時分數差也比較小）。
  const scale = Math.max(1, (card.scale * state.segMax) / card.sprintTicks);
  return {
    cardId: card.id,
    family: card.family,
    picker: state.picker,
    weight: state.seg === SEGMENTS - 1 ? FINAL_WEIGHT : 1,
    mm: marginMilli(raw[0] - raw[1], scale),
  };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function toOver(state: SKState): SKState {
  return { ...state, phase: 'over', phaseTick: 0 };
}

function beginPlay(state: SKState): SKState {
  const card = poolEntry(state.cardId as string);
  const minTicks = card.minTicks ?? 1;
  const wanted = Math.max(minTicks, Math.round(card.sprintTicks * state.pace));
  const available = state.maxTicks - state.tick;
  const segMax = Math.min(wanted, available);
  if (segMax < minTicks) {
    return toOver(state); // 時間不夠開這一段
  }
  const inner = card.game.init(segmentSeed(state.seed, state.seg), {
    maxTicks: segMax,
    params: card.params ?? {},
  });
  return { ...state, phase: 'play', phaseTick: 0, segMax, inner };
}

function nextSegment(state: SKState): SKState {
  const seg = state.seg + 1;
  if (seg === SEGMENTS - 1) {
    return {
      ...state,
      seg,
      phase: 'show',
      phaseTick: 0,
      picker: null,
      offer: [],
      cardId: FINAL.id,
      inner: null,
    };
  }
  return {
    ...state,
    seg,
    phase: 'pick',
    phaseTick: 0,
    picker: pickerOf(state.first, seg),
    offer: offerFor(
      state.seed,
      seg,
      state.ledger.map((entry) => entry.cardId),
    ),
    cardId: null,
    armed: false,
    inner: null,
  };
}

function step(state: SKState, inputs: Inputs): SKState {
  if (state.phase === 'over') {
    return state;
  }
  const tick = state.tick + 1;
  const times = durations(state.pace);
  const base: SKState = { ...state, tick };
  let next: SKState;
  switch (state.phase) {
    case 'pick': {
      const pressed = state.picker === null ? NONE : inputs[state.picker];
      // 還沒放開過就不算挑牌（先放開一個 tick）；一直按著不放則逾時照樣鎖定第 0 張。
      const index = state.armed ? lockedIndex(pressed, state.offer.length) : -1;
      if (index >= 0 || state.phaseTick + 1 >= times.pick) {
        next = {
          ...base,
          phase: 'show',
          phaseTick: 0,
          cardId: state.offer[Math.max(0, index)] as string,
        };
      } else {
        next = {
          ...base,
          phaseTick: state.phaseTick + 1,
          armed: state.armed || !KEYS.some((k) => pressed[k]),
        };
      }
      break;
    }
    case 'show':
      next =
        state.phaseTick + 1 >= times.show
          ? beginPlay(base)
          : { ...base, phaseTick: state.phaseTick + 1 };
      break;
    case 'play': {
      const card = poolEntry(state.cardId as string);
      const inner = card.game.step(state.inner, inputs);
      const advanced: SKState = { ...base, inner, phaseTick: state.phaseTick + 1 };
      if (card.game.isOver(inner) || tick >= state.maxTicks) {
        const ledger = [...state.ledger, settle(advanced)];
        next =
          state.seg === SEGMENTS - 1
            ? { ...advanced, ledger, phase: 'over', phaseTick: 0 }
            : { ...advanced, ledger, phase: 'rest', phaseTick: 0 };
      } else {
        next = advanced;
      }
      break;
    }
    default:
      next =
        state.phaseTick + 1 >= times.rest
          ? nextSegment(base)
          : { ...base, phaseTick: state.phaseTick + 1 };
  }
  return tick >= state.maxTicks && next.phase !== 'over' ? toOver(next) : next;
}

// ---------------------------------------------------------------------------
// 選牌的 evaluate（讀 ledger）
// ---------------------------------------------------------------------------

/** 我（`side`）目前的領先，單位是「段的 m」（權重已乘進去）。 */
function leadOf(ledger: readonly SKLedgerEntry[], side: Side): number {
  let lead = 0;
  for (const entry of ledger) {
    lead += (entry.weight * (side === 0 ? entry.mm : -entry.mm)) / 1000;
  }
  return lead;
}

/**
 * 挑這張牌的期望 E：`n/(n+1) × m̄ ＋ 0.1 × upside`。
 * m̄ 是我在這個家族過去各段的 m 平均（我的視角），n 是段數；沒打過就只剩 upside 項。
 */
function expectedOf(card: PoolEntry, ledger: readonly SKLedgerEntry[], side: Side): number {
  let n = 0;
  let sum = 0;
  for (const entry of ledger) {
    if (entry.family === card.family) {
      n += 1;
      sum += (side === 0 ? entry.mm : -entry.mm) / 1000;
    }
  }
  const history = n === 0 ? 0 : (n / (n + 1)) * (sum / n);
  return history + UPSIDE_WEIGHT * card.upside;
}

function lockGain(state: SKState, side: Side, cardId: string): number {
  const energies = state.offer.map((id) => expectedOf(poolEntry(id), state.ledger, side));
  const floor = Math.min(...energies);
  const mine = expectedOf(poolEntry(cardId), state.ledger, side);
  return leadOf(state.ledger, side) + (mine - floor) + LOCK_EDGE;
}

function evaluate(state: SKState, side: Side): { gain: number; danger: number } {
  if (state.inner !== null && state.cardId !== null) {
    // 遊戲階段（含 rest）：只算「目前這一段」那張牌，成本不隨段數累加，也沒有 S-K 自己的項。
    return poolEntry(state.cardId).game.evaluate(state.inner, side);
  }
  const lead = leadOf(state.ledger, side);
  if (state.phase === 'show' && state.picker === side && state.cardId !== null) {
    return {
      gain: lockGain(state, side, state.cardId),
      danger: poolEntry(state.cardId).sigma,
    };
  }
  // 等著：逾時會被強制鎖定第一張（失去選擇），所以 danger 是 1。這是為了精準型：它的 danger 門檻
  // 會把每一張「中」「險」的鎖定判成不安全，如果等著是 0，它就永遠選等著、拖到逾時（C-Q 放僚機的同一個病）。
  return { gain: lead, danger: state.phase === 'pick' && state.picker === side ? 1 : 0 };
}

function actions(state: SKState, side: Side): readonly Buttons[] {
  if (state.phase === 'play' && state.inner !== null && state.cardId !== null) {
    return poolEntry(state.cardId).game.actions(state.inner, side);
  }
  // 非挑牌人、或挑牌人還沒放開過鍵（這時按什麼都不算）：只有「全放開」，搜尋才不會在原地按著不放。
  if (state.phase !== 'pick' || state.picker !== side || !state.armed) {
    return IDLE_ACTIONS;
  }
  // 挑牌人：鎖定的動作依 evaluate 的偏好排（gain 高的在前，同分取候選順序），等著（全放開）排最後，
  // 這樣搜尋型平手時取到的是鎖定，不是拖延。
  const order = state.offer
    .map((id, index) => ({ index, gain: lockGain(state, side, id) }))
    .sort((a, b) => b.gain - a.gain || a.index - b.index);
  return [...order.map(({ index }): Buttons => ({ ...NONE, [KEYS[index] as string]: true })), NONE];
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

function init(seed: number, config: GameConfig): SKState {
  if (!Number.isFinite(config.maxTicks) || config.maxTicks < MIN_MAX_TICKS) {
    throw new RangeError(
      `S-K 的 maxTicks 至少要 ${MIN_MAX_TICKS}，收到 ${String(config.maxTicks)}`,
    );
  }
  const first = intFrom(rngStateFor(seed, 'first'), 2)[0] as Side;
  return {
    tick: 0,
    maxTicks: config.maxTicks,
    seed,
    pace: Math.min(1, config.maxTicks / FULL_TICKS),
    first,
    phase: 'pick',
    seg: 0,
    phaseTick: 0,
    picker: first,
    offer: offerFor(seed, 0, []),
    cardId: null,
    armed: true,
    segMax: 0,
    inner: null,
    ledger: [],
  };
}

function winner(state: SKState): Side | null {
  const [a, b] = scoreOf(state.ledger);
  return a > b ? 0 : b > a ? 1 : null;
}

export const skGame: Game<SKState> = {
  id: 'S-K',
  init,
  step,
  isOver: (state) => state.phase === 'over',
  score: (state) => scoreOf(state.ledger),
  winner,
  actions,
  evaluate,
};

/** 測試用：從種子 0 的開局出發，用 overrides 覆蓋欄位。 */
export function makeState(overrides: Partial<SKState> = {}): SKState {
  return { ...init(0, { maxTicks: 5400, params: {} }), ...overrides };
}
