import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  AI_WAIT_TICKS,
  DECISION_TIMEOUT,
  IDLE,
  PRESS_A,
  PRESS_B,
  otherSide,
} from '../_hearts/logic';

/**
 * H-J 三張牌撲克（Kuhn 撲克；SPEC 第 9 節；小規格 `docs/cards/H-J.md`）。
 *
 * 三張牌 J < Q < K，每手每人一張暗牌、一輪下注。每手兩個動作者輪流，只有兩個鍵：
 * a ＝ 下注／跟（積極）、b ＝ 過牌／棄牌（消極）。10 手，先後手每手交替，起始 20 籌碼。
 *
 * 等級曲線從結算流程長出來（DESIGN-AI-FUN 5.1）：按鍵 → 鎖定 2 tick → 第 3 步生效。
 * 深度 1 到 2 走不到生效，`evaluate` 在 `locked` 只剩「均衡抽籤」的小加分，所以打的是 α = 1/6 的均衡混合策略，
 * 不讀你；深度 3 以上走得到生效（換對方、或攤牌），`evaluate` 用「對手模型」算一手的期望，剝削你的毛病。
 * 沒有證據時對手模型就是均衡先驗，所有均衡支持裡的動作打平，由均衡抽籤決定，所以開局的等級 10 也打均衡。
 */

/** 牌：0 = J、1 = Q、2 = K。 */
export type Card = 0 | 1 | 2;
/** 動作：0 = b（過牌／棄牌）、1 = a（下注／跟）。 */
export type Act = 0 | 1;

export const HANDS = 10;
export const CHIPS = 20;
/** 按鍵之後鎖定幾個 tick 才生效（按 1、鎖定 2、生效 3：深度 3 以上走得到生效）。 */
export const LOCK_TICKS = 2;
/** 攤牌之後停幾個 tick 才入帳。 */
export const RESULT_TICKS = 30;
/** 對手模型只看最近幾手。 */
export const WINDOW = 5;
/** 均衡抽籤的小加分（遠小於任何真正的期望值差）。 */
export const HABIT = 0.01;
/** 均衡抽籤的解析度：抽 0 到 9999 的整數。 */
export const DRAW_RESOLUTION = 10000;

const END_BONUS = 1000;

export type HJPhase = 'prep' | 'choose' | 'locked' | 'showdown';

/** 這手的結果（攤牌階段，入帳之前）。`evaluate` 不可以讀。 */
export interface HJLast {
  readonly kind: 'fold' | 'showdown';
  readonly winner: Side;
  readonly stake: number;
  /** 兩邊這手的淨籌碼。 */
  readonly net: readonly [number, number];
  /** 亮出的牌；棄牌時兩邊都是 null。 */
  readonly shown: readonly [Card | null, Card | null];
}

/** 已結束的一手（公開）。 */
export interface HJRecord {
  readonly first: Side;
  readonly acts: readonly Act[];
  readonly shown: readonly [Card | null, Card | null];
}

export interface HJState {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 現在第幾手（0 到 HANDS − 1）。 */
  readonly hand: number;
  /** 這手誰先動作。 */
  readonly first: Side;
  /** 兩邊的暗牌（對方的是隱藏資訊）。 */
  readonly cards: readonly [Card, Card];
  /** 這手到目前為止的動作序列。 */
  readonly acts: readonly Act[];
  /** 輪到誰。 */
  readonly turn: Side;
  readonly phase: HJPhase;
  /** prep、locked、showdown 還剩幾個 tick。 */
  readonly wait: number;
  /** choose 階段已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  readonly chips: readonly [number, number];
  /** 輪到的那邊剛按的動作（鎖定中）。單人動作，不是同時。 */
  readonly pending: Act | null;
  readonly last: HJLast | null;
  /** 已結束的手，最多 HANDS 筆（公開）。 */
  readonly hands: readonly HJRecord[];
  /** 兩邊這手的均衡抽籤（0 到 9999 的整數）。每邊只讀自己那一欄。 */
  readonly eqDraw: readonly [number, number];
  readonly rng: RngState;
  /** 對手模型開關（消融實驗用 `config.params.model = 0` 關掉）。 */
  readonly model: boolean;
  /**
   * 淺層（深度 1、2）的反射規則：false ＝ 均衡抽籤（預設，小規格）；true ＝ 老實牌（只用 K 下注／跟，其餘過牌／棄）。
   * `config.params.reflex = 1` 打開。量測用，見小規格。
   */
  readonly reflex: boolean;
}

const ALL_CARDS: readonly Card[] = [0, 1, 2];

// ---------------------------------------------------------------------------
// 局面：誰動作、怎麼結束
// ---------------------------------------------------------------------------

function actorAt(first: Side, index: number): Side {
  return index % 2 === 0 ? first : otherSide(first);
}

type Outcome =
  | { readonly kind: 'fold'; readonly folder: 'first' | 'second' }
  | { readonly kind: 'showdown'; readonly stake: number };

/** 動作序列有沒有結束這一手；沒結束回傳 null。 */
export function outcomeOf(acts: readonly Act[]): Outcome | null {
  if (acts.length === 2) {
    if (acts[0] === 1) {
      return acts[1] === 0 ? { kind: 'fold', folder: 'second' } : { kind: 'showdown', stake: 2 };
    }
    return acts[1] === 0 ? { kind: 'showdown', stake: 1 } : null;
  }
  if (acts.length === 3) {
    return acts[2] === 0 ? { kind: 'fold', folder: 'first' } : { kind: 'showdown', stake: 2 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 均衡（α = 1/6）：每個局面「積極」的機率，與抽籤對應的動作
// ---------------------------------------------------------------------------

/** 局面：先手開口、後手面對過牌、後手面對下注、先手過牌後被下注。 */
type Spot = 'open' | 'stab' | 'faceBet' | 'recall';

function spotOf(prefix: readonly Act[]): Spot {
  if (prefix.length === 0) {
    return 'open';
  }
  if (prefix.length === 1) {
    return prefix[0] === 0 ? 'stab' : 'faceBet';
  }
  return 'recall';
}

/** 均衡表（α = 1/6）。每個局面 [J, Q, K] 的積極機率。 */
const EQ_TABLE: Readonly<Record<Spot, readonly [number, number, number]>> = {
  open: [1 / 6, 0, 1 / 2],
  stab: [1 / 3, 0, 1],
  faceBet: [0, 1 / 3, 1],
  recall: [0, 1 / 2, 1],
};

/** 均衡裡，這張牌在這個局面（`prefix` 是之前的動作）積極（a）的機率。 */
export function eqAggressiveProb(card: Card, prefix: readonly Act[]): number {
  return EQ_TABLE[spotOf(prefix)][card];
}

/** 老實牌的反射：只用 K 積極（下注／跟），J、Q 一律消極。 */
export function reflexAction(card: Card): Act {
  return card === 2 ? 1 : 0;
}

/** 用抽籤（0 到 9999）決定均衡動作：抽籤小於機率就是 a。 */
export function eqAction(card: Card, prefix: readonly Act[], draw: number): Act {
  return draw / DRAW_RESOLUTION < eqAggressiveProb(card, prefix) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 對手模型：只讀公開的 hands（動作序列與攤牌亮出的牌），最近 WINDOW 手
// ---------------------------------------------------------------------------

/** 各局面「對手整體積極率」的均衡值（三張牌平均）。 */
const SPOT_RATE: Readonly<Record<Spot, number>> = {
  open: (1 / 6 + 0 + 1 / 2) / 3,
  stab: (1 / 3 + 0 + 1) / 3,
  faceBet: (0 + 1 / 3 + 1) / 3,
  recall: (0 + 1 / 2 + 1) / 3,
};

/** 均衡裡，亮出來的下注有幾成是弱牌（J）：1/6 對 1/2。 */
const PRIOR_WEAK_SHARE = 1 / 4;

export interface OppModel {
  /** 對手「下注」（先手開口、後手面對過牌）的頻率比均衡多多少（平滑後，可為負）。 */
  readonly deltaBet: number;
  /** 對手「跟注」（面對下注）的頻率比均衡多多少。 */
  readonly deltaCall: number;
  /** 攤牌亮出的對手下注，有幾成是弱牌（平滑後）。 */
  readonly weakShare: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * 從歷史算 `side` 的對手的模型。每個頻率都是「均衡值加 1 次觀察」平滑：
 * 差值 = (實際積極次數 − 均衡預期次數) ÷ (機會數 + 1)；沒有資料就是 0（均衡）。
 * 詐唬比例只看**攤牌亮出的**下注（棄牌的牌不亮，所以看不到）。`enabled = false`（消融）時永遠是先驗。
 */
export function opponentModel(hands: readonly HJRecord[], side: Side, enabled: boolean): OppModel {
  if (!enabled) {
    return { deltaBet: 0, deltaCall: 0, weakShare: PRIOR_WEAK_SHARE };
  }
  const opp = otherSide(side);
  let betN = 0;
  let betK = 0;
  let betExpected = 0;
  let callN = 0;
  let callK = 0;
  let callExpected = 0;
  let shownBets = 0;
  let weakBets = 0;
  const from = Math.max(0, hands.length - WINDOW);
  for (let h = from; h < hands.length; h += 1) {
    const record = hands[h] as HJRecord;
    for (let i = 0; i < record.acts.length; i += 1) {
      if (actorAt(record.first, i) !== opp) {
        continue;
      }
      const spot = spotOf(record.acts.slice(0, i));
      const aggressive = record.acts[i] as Act;
      if (spot === 'open' || spot === 'stab') {
        betN += 1;
        betK += aggressive;
        betExpected += SPOT_RATE[spot];
        const shown = record.shown[opp];
        if (aggressive === 1 && shown !== null) {
          shownBets += 1;
          weakBets += shown < 2 ? 1 : 0;
        }
      } else {
        callN += 1;
        callK += aggressive;
        callExpected += SPOT_RATE[spot];
      }
    }
  }
  return {
    deltaBet: (betK - betExpected) / (betN + 1),
    deltaCall: (callK - callExpected) / (callN + 1),
    weakShare: (weakBets + PRIOR_WEAK_SHARE) / (shownBets + 1),
  };
}

/**
 * 模型裡，對手拿 `card`、在 `prefix` 之後這個局面積極的機率。
 * 下注局面：J 的詐唬與 K 的價值下注按 weakShare 分配整體下注率，Q 不下注；跟注局面：J 不跟、K 一定跟、Q 的跟注率隨 deltaCall 移動。
 */
export function oppAggressiveProb(model: OppModel, card: Card, prefix: readonly Act[]): number {
  const spot = spotOf(prefix);
  if (spot === 'open' || spot === 'stab') {
    const rate = clamp01(SPOT_RATE[spot] + model.deltaBet);
    if (card === 0) {
      return clamp01(3 * rate * model.weakShare);
    }
    return card === 1 ? 0 : clamp01(3 * rate * (1 - model.weakShare));
  }
  if (card === 0) {
    return 0;
  }
  if (card === 2) {
    return 1;
  }
  return clamp01(EQ_TABLE[spot][1] + 3 * model.deltaCall);
}

/** 畫面上「AI 的把握」：窗口裡攤牌（亮出對手牌）的手數，粗粒度映射到 0 到 3 格。不說它認為你是什麼樣的人。 */
export function confidenceLevel(
  hands: readonly HJRecord[],
  side: Side,
  enabled: boolean,
): 0 | 1 | 2 | 3 {
  if (!enabled) {
    return 0;
  }
  const opp = otherSide(side);
  const from = Math.max(0, hands.length - WINDOW);
  let shows = 0;
  for (let h = from; h < hands.length; h += 1) {
    if ((hands[h] as HJRecord).shown[opp] !== null) {
      shows += 1;
    }
  }
  return shows === 0 ? 0 : shows === 1 ? 1 : shows <= 3 ? 2 : 3;
}

// ---------------------------------------------------------------------------
// 一手牌的期望（evaluate 與測試共用）：我的牌已知，對手的牌由模型與已出現的動作推論
// ---------------------------------------------------------------------------

function normalize(post: number[], mine: Card): number[] {
  const total = post.reduce((a, b) => a + b, 0);
  if (total > 0) {
    return post.map((p) => p / total);
  }
  // 不可能的動作序列（模型說機率 0）：退回均匀
  const others = ALL_CARDS.filter((c) => c !== mine);
  return post.map((_p, c) => (c === mine ? 0 : 1 / others.length));
}

/**
 * 這手到目前為止（`state.acts`）之後，我（`side`）的期望淨籌碼：我之後的決定取最大，對手的動作用模型。
 * 只讀我自己的牌、公開的動作與歷史；不讀對方的牌、不讀 `last`。
 */
export function expectedHand(state: HJState, side: Side): number {
  const opp = otherSide(side);
  const mine = state.cards[side];
  const model = opponentModel(state.hands, side, state.model);
  const first = state.first;

  const oppProb = (card: Card, prefix: readonly Act[], act: Act): number => {
    const p = oppAggressiveProb(model, card, prefix);
    return act === 1 ? p : 1 - p;
  };

  const value = (acts: readonly Act[], post: readonly number[]): number => {
    const outcome = outcomeOf(acts);
    if (outcome !== null) {
      if (outcome.kind === 'fold') {
        const folder = outcome.folder === 'first' ? first : otherSide(first);
        return folder === side ? -1 : 1;
      }
      let win = 0;
      for (const c of ALL_CARDS) {
        win += (post[c] as number) * (mine > c ? 1 : -1);
      }
      return outcome.stake * win;
    }
    if (actorAt(first, acts.length) === side) {
      return Math.max(value([...acts, 0], post), value([...acts, 1], post));
    }
    let total = 0;
    for (const act of [0, 1] as const) {
      const weights = post.map((p, c) => (c === mine ? 0 : p * oppProb(c as Card, acts, act)));
      const mass = weights.reduce((a, b) => a + b, 0);
      if (mass > 0) {
        total +=
          mass *
          value(
            [...acts, act],
            weights.map((w) => w / mass),
          );
      }
    }
    return total;
  };

  // 先把已經發生的動作餵進去，得到對手牌的後驗
  let post = normalize(
    ALL_CARDS.map((c) => (c === mine ? 0 : 1)),
    mine,
  );
  for (let i = 0; i < state.acts.length; i += 1) {
    if (actorAt(first, i) === opp) {
      const prefix = state.acts.slice(0, i);
      const act = state.acts[i] as Act;
      post = normalize(
        post.map((p, c) => (c === mine ? 0 : p * oppProb(c as Card, prefix, act))),
        mine,
      );
    }
  }
  return value(state.acts, post);
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** 發這一手的牌與兩個均衡抽籤。 */
function deal(rng: RngState): {
  cards: readonly [Card, Card];
  eqDraw: readonly [number, number];
  rng: RngState;
} {
  const [c0, r1] = intFrom(rng, 3);
  const [k, r2] = intFrom(r1, 2);
  const [d0, r3] = intFrom(r2, DRAW_RESOLUTION);
  const [d1, r4] = intFrom(r3, DRAW_RESOLUTION);
  const second = (c0 + 1 + k) % 3;
  return { cards: [c0 as Card, second as Card], eqDraw: [d0, d1], rng: r4 };
}

/** 測試用：從「第 0 手、準備剛開始、籌碼各 20」出發，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<HJState> = {}): HJState {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    hand: 0,
    first: 0,
    cards: [2, 0],
    acts: [],
    turn: 0,
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    chips: [CHIPS, CHIPS],
    pending: null,
    last: null,
    hands: [],
    eqDraw: [5000, 5000],
    rng: 12345,
    model: true,
    reflex: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function winnerByChips(chips: readonly [number, number]): Side | null {
  if (chips[0] === chips[1]) {
    return null;
  }
  return chips[0] > chips[1] ? 0 : 1;
}

/** 按鍵 → 動作：b 優先（保守），其次 a；都沒按是 null。 */
function actFromButtons(buttons: Buttons): Act | null {
  if (buttons.b) {
    return 0;
  }
  return buttons.a ? 1 : null;
}

/** 動作生效：這手結束就算結果（攤牌階段），沒結束就換對方。 */
function applyAct(state: HJState): HJState {
  const act = state.pending as Act;
  const acts = [...state.acts, act];
  const outcome = outcomeOf(acts);
  if (outcome === null) {
    return {
      ...state,
      acts,
      turn: otherSide(state.turn),
      phase: 'prep',
      wait: AI_WAIT_TICKS,
      idle: 0,
      pending: null,
    };
  }
  let winner: Side;
  let stake: number;
  let shown: readonly [Card | null, Card | null];
  if (outcome.kind === 'fold') {
    winner = outcome.folder === 'first' ? otherSide(state.first) : state.first;
    stake = 1;
    shown = [null, null];
  } else {
    winner = state.cards[0] > state.cards[1] ? 0 : 1;
    stake = outcome.stake;
    shown = [state.cards[0], state.cards[1]];
  }
  const net: readonly [number, number] = winner === 0 ? [stake, -stake] : [-stake, stake];
  return {
    ...state,
    acts,
    phase: 'showdown',
    wait: RESULT_TICKS,
    pending: null,
    last: { kind: outcome.kind, winner, stake, net, shown },
  };
}

/** 入帳：籌碼更新、歷史加一筆。還沒進下一手。 */
function bankHand(state: HJState): HJState {
  const last = state.last;
  if (last === null) {
    return state;
  }
  return {
    ...state,
    chips: [state.chips[0] + last.net[0], state.chips[1] + last.net[1]],
    hands: [...state.hands, { first: state.first, acts: state.acts, shown: last.shown }],
    hand: state.hand + 1,
    last: null,
  };
}

function finish(state: HJState): HJState {
  return { ...state, over: true, winner: winnerByChips(state.chips) };
}

/** 進下一手：先後手對調、重新發牌。 */
function startNextHand(state: HJState): HJState {
  const first = otherSide(state.first);
  const dealt = deal(state.rng);
  return {
    ...state,
    first,
    turn: first,
    cards: dealt.cards,
    eqDraw: dealt.eqDraw,
    rng: dealt.rng,
    acts: [],
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    pending: null,
    last: null,
  };
}

function stepChoose(state: HJState, inputs: Inputs, tick: number): HJState {
  const timeout = state.idle + 1 >= DECISION_TIMEOUT;
  const pressed = actFromButtons(inputs[state.turn]);
  const act: Act | null = pressed !== null ? pressed : timeout ? 0 : null;
  if (act === null) {
    return { ...state, tick, idle: state.idle + 1 };
  }
  return { ...state, tick, pending: act, phase: 'locked', wait: LOCK_TICKS };
}

function stepHJ(state: HJState, inputs: Inputs): HJState {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: HJState;

  if (state.phase === 'prep') {
    after =
      state.wait <= 1
        ? { ...state, tick, phase: 'choose', wait: 0, idle: 0 }
        : { ...state, tick, wait: state.wait - 1 };
  } else if (state.phase === 'choose') {
    after = stepChoose(state, inputs, tick);
  } else if (state.phase === 'locked') {
    after =
      state.wait <= 1 ? applyAct({ ...state, tick }) : { ...state, tick, wait: state.wait - 1 };
  } else if (state.wait <= 1) {
    const banked = bankHand({ ...state, tick });
    after = banked.hand >= HANDS ? finish(banked) : startNextHand(banked);
  } else {
    after = { ...state, tick, wait: state.wait - 1 };
  }

  if (!after.over && tick >= state.maxTicks) {
    // 時間到：已經攤牌的先入帳；還在 choose 或 locked 的這手不算。
    return finish(after.phase === 'showdown' ? bankHand(after) : after);
  }
  return after;
}

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);
/** 消極（b）排第一：搜尋時模擬的對手按第一個，它是會推進結算的動作。 */
const CHOOSE_ACTIONS: readonly Buttons[] = Object.freeze([PRESS_B, PRESS_A]);

function actionsHJ(state: HJState, side: Side): readonly Buttons[] {
  if (!state.over && state.phase === 'choose' && state.turn === side) {
    return CHOOSE_ACTIONS;
  }
  return ONLY_IDLE;
}

/** 淺層反射要的動作：預設是均衡抽籤，`reflex` 打開時是老實牌。 */
function habitTarget(state: HJState, card: Card, prefix: readonly Act[], draw: number): Act {
  return state.reflex ? reflexAction(card) : eqAction(card, prefix, draw);
}

/**
 * 均衡抽籤的小加分：我剛做的那個動作，和「用我自己的抽籤查均衡表」得到的動作一樣，就加 HABIT。
 * 只讀我自己的牌與我自己的抽籤。
 */
function habitBonus(state: HJState, side: Side): number {
  const mine = state.cards[side];
  const draw = state.eqDraw[side];
  if (state.phase === 'locked') {
    if (state.turn !== side || state.pending === null) {
      return 0;
    }
    return state.pending === habitTarget(state, mine, state.acts, draw) ? HABIT : 0;
  }
  if ((state.phase === 'prep' || state.phase === 'showdown') && state.acts.length > 0) {
    const index = state.acts.length - 1;
    if (actorAt(state.first, index) !== side) {
      return 0;
    }
    return state.acts[index] === habitTarget(state, mine, state.acts.slice(0, index), draw)
      ? HABIT
      : 0;
  }
  return 0;
}

function evaluateHJ(state: HJState, side: Side): { gain: number; danger: number } {
  const diff = state.chips[side] - state.chips[otherSide(side)];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: diff + sign * END_BONUS, danger: 0 };
  }
  if (state.phase === 'locked') {
    // 淺搜尋（深度 1、2）只走到這裡：不讀對手，只剩均衡抽籤，所以打的是均衡混合策略。
    return { gain: diff + habitBonus(state, side), danger: 0 };
  }
  // choose、prep、showdown：一手牌的期望（深度 3 以上走得到）。對方的牌與 last 一律目盲。
  return { gain: diff + expectedHand(state, side) + habitBonus(state, side), danger: 0 };
}

export const hJGame: Game<HJState> = {
  id: 'H-J',

  init(seed: number, config: GameConfig): HJState {
    const dealt = deal(rngStateFor(seed, 'deal'));
    return makeState({
      maxTicks: config.maxTicks,
      cards: dealt.cards,
      eqDraw: dealt.eqDraw,
      rng: dealt.rng,
      model: config.params['model'] !== 0,
      reflex: config.params['reflex'] === 1,
    });
  },

  step(state: HJState, inputs: Inputs): HJState {
    return stepHJ(state, inputs);
  },

  isOver(state: HJState): boolean {
    return state.over;
  },

  score(state: HJState): readonly [number, number] {
    return [state.chips[0], state.chips[1]];
  },

  winner(state: HJState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: HJState, side: Side): readonly Buttons[] {
    return actionsHJ(state, side);
  },

  evaluate(state: HJState, side: Side): { gain: number; danger: number } {
    return evaluateHJ(state, side);
  },
};
