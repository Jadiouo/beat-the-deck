import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { AI_WAIT_TICKS, DECISION_TIMEOUT, IDLE, otherSide } from '../_hearts/logic';

/**
 * H-7 血換分（SPEC 第 9 節：「紅球給分但扣血，血歸零分數全沒」；小規格 `docs/cards/H-7.md`）。
 *
 * 每回合桌上有一組共用的球：紅球（高分、扣血）、白球（1 分、免費）、綠球（補血）。兩邊同時各選一顆
 * （或不搶），搶同一顆就彈開、誰都拿不到。血量歸零，分數立刻歸零（昏倒），綠球補回血才能再搶紅球。
 * 12 回合後分數高的贏。
 *
 * 同時出手：`pending` 對 AI 是隱藏的，`evaluate`、`actions` 不可以讀對方這回合的 `pending`，也不可以讀 `last`
 * （揭示的結果，入帳之前）。AI 對對方會搶什麼的信念 `Q` 只從公開資訊算（血量、分數、本回合的紅球、歷史）。
 */

// ---------------------------------------------------------------------------
// 常數與型別
// ---------------------------------------------------------------------------

export const ROUNDS = 12;
export const HP_START = 5;
export const HP_MAX = 6;
export const HEAL = 2;
export const WHITE_POINTS = 1;
/** 紅球 `(分數, 血價)` 的四種組合，每回合抽一組；血價隨分數遞增。 */
export const RED_TABLE: readonly (readonly [number, number])[] = [
  [3, 1],
  [4, 1],
  [5, 2],
  [6, 2],
];
/** 兩邊都選好之後，鎖定幾個 tick 才揭示（選 1、鎖定 2、揭示 3：深度 3 以上走得到揭示）。 */
export const LOCK_TICKS = 2;
/** 揭示之後停幾個 tick 才入帳、進下一回合（讓人看清楚誰搶了什麼）。 */
export const RESULT_TICKS = 110;

/** 出手：0 不搶、1 白球、2 綠球、3 紅球。`actions()` 的第一個是「不搶」。 */
export const NONE = 0;
export const WHITE = 1;
export const GREEN = 2;
export const RED = 3;
export type Move = 0 | 1 | 2 | 3;

export type H7Phase = 'prep' | 'choose' | 'locked' | 'resolve';

/** 揭示的結果。入帳之前只存在 `last`（`evaluate` 不可以讀）。 */
export interface H7Last {
  readonly picks: readonly [Move, Move];
}

/** 已入帳的一回合（公開）。`hp`、`score` 是這回合開始時（出手前）的值。 */
export interface H7Record {
  readonly orb: readonly [number, number];
  readonly picks: readonly [Move, Move];
  readonly hp: readonly [number, number];
  readonly score: readonly [number, number];
}

export interface H7State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 現在第幾回合（0 到 ROUNDS − 1；結束後是 ROUNDS）。 */
  readonly round: number;
  /** 本回合的球（公開）；白球與綠球的數字固定。 */
  readonly orbs: { readonly red: readonly [number, number] };
  readonly hp: readonly [number, number];
  readonly score: readonly [number, number];
  /** 兩邊這回合選的球（`null` 是還沒選）。選了不能改。對手的是隱藏資訊。 */
  readonly pending: readonly [Move | null, Move | null];
  readonly phase: H7Phase;
  /** prep、locked、resolve 還剩幾個 tick。 */
  readonly wait: number;
  /** choose 階段已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  /** 這回合揭示的結果（入帳之前）。 */
  readonly last: H7Last | null;
  /** 已入帳的每一回合，最多 ROUNDS 筆。 */
  readonly history: readonly H7Record[];
  /** 每回合抽一次，給 `evaluate` 在期望值接近時做打破對稱的隨機（兩個一樣的 AI 才不會永遠撞球）。 */
  readonly salt: number;
  readonly rng: RngState;
  /** 對手模型開關（消融實驗用 `config.params.model = 0` 關掉）。 */
  readonly model: boolean;
  /**
   * 紅球撞球要不要扣血（預設要；消融用 `config.params.clash = 0` 關掉，就是小規格原本的「撞球什麼都沒有」）。
   * 為什麼要：撞球免費的時候，兩邊每回合都去搶紅球就是一個穩定的均衡（搶別的球都比撞球差），見小規格「撞球要付代價」。
   */
  readonly clash: boolean;
}

/** 出手對應的按鍵：b 或 ↓ 不搶、← 紅、↑ 白、→ 綠。`actions()` 的順序是 不搶、白、綠、紅。 */
export const MOVE_BUTTONS: readonly Buttons[] = Object.freeze([
  Object.freeze({ ...IDLE, b: true }),
  Object.freeze({ ...IDLE, up: true }),
  Object.freeze({ ...IDLE, right: true }),
  Object.freeze({ ...IDLE, left: true }),
]);

const SALT_RANGE = 1 << 20;

/** 結束的局，勝負加成（比任何分差都大）。 */
const END_BONUS = 1000;

// ---------------------------------------------------------------------------
// 價值與對手模型（只讀公開資訊）
// ---------------------------------------------------------------------------

/** 天真價值裡一點血等於幾分（小規格 `λ`）。 */
export const LAMBDA = 1.2;
/** 對手選擇的 softmax 溫度。 */
export const TEMPERATURE = 1;
/** 歷史修正：看最近幾次「同類狀況」，與自我模型的混合比例 7:3。 */
export const HISTORY_LENGTH = 3;
export const HISTORY_WEIGHT = 0.3;
/** 一點「還能用來搶紅球」的血值幾分（真價值）。 */
export const HP_VALUE = 1.4;
/** 落後一分，天真價值裡紅球多值幾分（對手模型用，上限 `CHASE_CAP`）。 */
export const CHASE = 0.1;
export const CHASE_CAP = 1.5;
/** 反射規則的小加分比例：遠小於任何真正的期望值差。 */
const HABIT = 0.01;
/** 期望值噪音的大小（分）。 */
const TAU = 0.3;
/** 鎖定階段（反射）對「搶了會昏倒的紅球」的 danger：不看對方，固定一個數字。 */
export const REFLEX_DANGER = 0.6;
/** 不能選的出手（昏倒的人搶紅球）的價值。 */
const FORBIDDEN = -99;

/** 血量的天真權重：快沒有以後的回合，血就不值錢。 */
function lambdaFor(roundsAfter: number): number {
  return roundsAfter >= 2 ? LAMBDA : roundsAfter === 1 ? 0.8 : 0.3;
}

/** 這一回合結束後還剩幾回合。 */
function roundsAfterOf(state: H7State): number {
  return Math.max(0, ROUNDS - 1 - state.round);
}

/** 剩 `roundsAfter` 回合時，血量 `h` 的價值：`h − 1` 點能用來搶紅球的血，最多用得完 1.5 × 剩餘回合。 */
export function hpValue(h: number, roundsAfter: number): number {
  return HP_VALUE * Math.min(Math.max(h - 1, 0), 1.5 * roundsAfter);
}

/** 紅球撞球時這一邊掉的血：血價，但最多掉到 1（撞球只傷不昏）。 */
export function clashLoss(hp: number, red: readonly [number, number]): number {
  return Math.max(0, Math.min(red[1], hp - 1));
}

/**
 * 反射價值：自己最想要的球，**完全不管對方、也不管會不會昏倒**（昏倒由 danger 管）。
 * 分數加 `λ ×` 血量變化；血 ≤ 2 的時候綠球多加 1（急著補血）。
 */
export function reflexValue(
  hp: number,
  ball: Move,
  red: readonly [number, number],
  roundsAfter: number,
): number {
  const lam = lambdaFor(roundsAfter);
  switch (ball) {
    case NONE:
      return 0;
    case WHITE:
      return WHITE_POINTS;
    case GREEN:
      return lam * Math.min(HEAL, HP_MAX - hp) + (hp <= 2 ? 1 : 0);
    default:
      return hp <= 0 ? FORBIDDEN : red[0] - lam * red[1];
  }
}

/**
 * 天真價值（自我模型：站在對方的位置，它「想要」什麼）：反射價值，但是搶了會昏倒的紅球要賠掉全部分數，
 * 而且落後越多越想要紅球（`behind` 是它落後的分數）。
 */
export function naiveValue(
  hp: number,
  score: number,
  behind: number,
  ball: Move,
  red: readonly [number, number],
  roundsAfter: number,
): number {
  if (ball !== RED) {
    return reflexValue(hp, ball, red, roundsAfter);
  }
  if (hp <= 0) {
    return FORBIDDEN;
  }
  if (hp <= red[1]) {
    return -score - lambdaFor(roundsAfter) * hp;
  }
  return reflexValue(hp, ball, red, roundsAfter) + Math.min(CHASE_CAP, CHASE * Math.max(0, behind));
}

/** 真價值：分數變化加血量價值變化；昏倒賠掉全部分數。 */
export function trueValue(
  hp: number,
  score: number,
  ball: Move,
  red: readonly [number, number],
  roundsAfter: number,
): number {
  switch (ball) {
    case NONE:
      return 0;
    case WHITE:
      return WHITE_POINTS;
    case GREEN:
      return hpValue(Math.min(HP_MAX, hp + HEAL), roundsAfter) - hpValue(hp, roundsAfter);
    default: {
      if (hp <= 0) {
        return FORBIDDEN;
      }
      if (hp <= red[1]) {
        return -score - hpValue(hp, roundsAfter);
      }
      return red[0] + hpValue(hp - red[1], roundsAfter) - hpValue(hp, roundsAfter);
    }
  }
}

/** 「同類狀況」：紅球便宜或貴（血價 1 或 2）、對方血量高或低（≥ 4）。 */
function situationOf(red: readonly [number, number], hp: number): number {
  return (red[1] >= 2 ? 2 : 0) + (hp >= 4 ? 1 : 0);
}

/**
 * 站在 `side` 的位置，預測對方這回合搶什麼：四個機率（不搶、白、綠、紅），加起來是 1。
 * 只讀公開資訊：對方的血量與分數、本回合的紅球、歷史。
 * 自我模型 `Q_self(x) ∝ exp(V_opp(x) / T)`；歷史修正：對方在同類狀況下最近 `HISTORY_LENGTH` 次搶了什麼，
 * 與自我模型 7:3 混合（沒有紀錄就只有自我模型）。`model = false`（消融）時永遠只有自我模型。
 */
export function predictOpp(state: H7State, side: Side): readonly number[] {
  const opp = otherSide(side);
  const roundsAfter = roundsAfterOf(state);
  const hp = state.hp[opp];
  const score = state.score[opp];
  const behind = state.score[side] - score;
  const values = [NONE, WHITE, GREEN, RED].map((ball) =>
    ball === RED && hp <= 0
      ? Number.NEGATIVE_INFINITY
      : naiveValue(hp, score, behind, ball as Move, state.orbs.red, roundsAfter),
  );
  const top = Math.max(...values);
  const weights = values.map((v) => Math.exp((v - top) / TEMPERATURE));
  const total = weights.reduce((a, b) => a + b, 0);
  const self = weights.map((w) => w / total);
  if (!state.model) {
    return self;
  }
  const kind = situationOf(state.orbs.red, hp);
  const counts = [0, 0, 0, 0];
  let seen = 0;
  for (let i = state.history.length - 1; i >= 0 && seen < HISTORY_LENGTH; i -= 1) {
    const record = state.history[i] as H7Record;
    if (situationOf(record.orb, record.hp[opp]) === kind) {
      const pick = record.picks[opp];
      counts[pick] = (counts[pick] as number) + 1;
      seen += 1;
    }
  }
  if (seen === 0) {
    return self;
  }
  return self.map(
    (p, i) => (1 - HISTORY_WEIGHT) * p + (HISTORY_WEIGHT * (counts[i] as number)) / seen,
  );
}

/** 我選 `x`、對方的出手由 `q` 分佈時，我這回合淨賺的期望值（我拿到的減去對方拿到的；同一顆誰都拿不到）。 */
export function expectedNet(state: H7State, side: Side, x: Move, q: readonly number[]): number {
  const opp = otherSide(side);
  const roundsAfter = roundsAfterOf(state);
  const red = state.orbs.red;
  const mine = trueValue(state.hp[side], state.score[side], x, red, roundsAfter);
  let total = 0;
  for (let y = 0; y < 4; y += 1) {
    const p = q[y] as number;
    if (p <= 0) {
      continue;
    }
    if (y !== x) {
      total += p * (mine - trueValue(state.hp[opp], state.score[opp], y as Move, red, roundsAfter));
    } else if (x === RED && state.clash) {
      // 紅球撞球：各自掉血價（淨值是我掉的減對方掉的）
      const myHp = state.hp[side];
      const theirHp = state.hp[opp];
      total +=
        p *
        (hpValue(myHp - clashLoss(myHp, red), roundsAfter) -
          hpValue(myHp, roundsAfter) -
          (hpValue(theirHp - clashLoss(theirHp, red), roundsAfter) -
            hpValue(theirHp, roundsAfter)));
    }
  }
  return total;
}

/** 搶了紅球而昏倒的機率：血不夠付血價時，對方沒搶紅球（沒撞球）就必然昏倒。 */
export function faintChance(state: H7State, side: Side, x: Move, q: readonly number[]): number {
  if (x !== RED || state.hp[side] > state.orbs.red[1]) {
    return 0;
  }
  return 1 - (q[RED] as number);
}

/** 打破對稱的小隨機：由 salt、邊、出手雜湊出 [0, 1)，只在 resolve 階段加。 */
function jitterOf(salt: number, side: Side, move: Move): number {
  let h =
    Math.imul(salt | 0, 0x9e3779b1) ^
    Math.imul(side + 1, 0x85ebca6b) ^
    Math.imul(move + 1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Gumbel 噪音：`argmax(EV + τ · Gumbel)` 等於從 `softmax(EV / τ)` 抽樣（量子化反應：期望值差不多的選項輪流出現）。
 * 同時出手的牌沒有純策略的均衡：兩個一模一樣的 AI 在對稱的局面裡會永遠選同一顆而撞球。τ 小，只有差距小的選項會輪流。
 */
function gumbelOf(salt: number, side: Side, move: Move): number {
  const u = Math.min(1 - 1e-9, Math.max(1e-9, jitterOf(salt, side, move)));
  return -Math.log(-Math.log(u));
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** 測試用：從「第 0 回合、準備剛開始、血各 5」出發，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<H7State> = {}): H7State {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    round: 0,
    orbs: { red: [4, 1] },
    hp: [HP_START, HP_START],
    score: [0, 0],
    pending: [null, null],
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    last: null,
    history: [],
    salt: 1,
    rng: rngStateFor(0, 'orbs'),
    model: true,
    clash: true,
    ...overrides,
  };
}

/** 抽下一回合的紅球與 salt，亂數狀態寫回。 */
function drawRound(rng: RngState): {
  red: readonly [number, number];
  salt: number;
  rng: RngState;
} {
  const [index, afterRed] = intFrom(rng, RED_TABLE.length);
  const [salt, afterSalt] = intFrom(afterRed, SALT_RANGE);
  return { red: RED_TABLE[index] as readonly [number, number], salt, rng: afterSalt };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

/** 一個 tick 的按鍵是哪個出手：b 最優先，其次 ←（紅，昏倒時略過）、↑、→、↓；a 沒有作用。 */
function moveFromButtons(buttons: Buttons, canRed: boolean): Move | null {
  if (buttons.b) {
    return NONE;
  }
  if (buttons.left && canRed) {
    return RED;
  }
  if (buttons.up) {
    return WHITE;
  }
  if (buttons.right) {
    return GREEN;
  }
  return buttons.down ? NONE : null;
}

function winnerByTotals(totals: readonly [number, number]): Side | null {
  if (totals[0] === totals[1]) {
    return null;
  }
  return totals[0] > totals[1] ? 0 : 1;
}

/** 揭示：記下兩邊搶了什麼，分數與血都還沒動。 */
function reveal(state: H7State): H7State {
  const picks = state.pending as readonly [Move, Move];
  return { ...state, phase: 'resolve', wait: RESULT_TICKS, last: { picks } };
}

/** 一個人這回合實際拿到什麼：撞球或不搶就是什麼都沒有。 */
function gotBall(mine: Move, theirs: Move): Move {
  return mine === theirs ? NONE : mine;
}

/** 入帳：算分、扣血、補血、昏倒；歷史加一筆；進下一回合（抽新的紅球）。 */
function bank(state: H7State): H7State {
  const picks = (state.last?.picks ?? state.pending) as readonly [Move, Move];
  const [p, c] = state.orbs.red;
  const hp: [number, number] = [state.hp[0], state.hp[1]];
  const score: [number, number] = [state.score[0], state.score[1]];
  if (state.clash && picks[0] === RED && picks[1] === RED) {
    hp[0] -= clashLoss(hp[0], state.orbs.red);
    hp[1] -= clashLoss(hp[1], state.orbs.red);
  }
  for (const side of [0, 1] as const) {
    const got = gotBall(picks[side], picks[otherSide(side)]);
    if (got === RED) {
      score[side] += p;
      hp[side] -= c;
      if (hp[side] <= 0) {
        hp[side] = 0;
        score[side] = 0;
      }
    } else if (got === WHITE) {
      score[side] += WHITE_POINTS;
    } else if (got === GREEN) {
      hp[side] = Math.min(HP_MAX, hp[side] + HEAL);
    }
  }
  const next = drawRound(state.rng);
  return {
    ...state,
    hp,
    score,
    history: [...state.history, { orb: state.orbs.red, picks, hp: state.hp, score: state.score }],
    round: state.round + 1,
    orbs: { red: next.red },
    salt: next.salt,
    rng: next.rng,
    pending: [null, null],
    last: null,
  };
}

function finish(state: H7State): H7State {
  return { ...state, over: true, winner: winnerByTotals(state.score) };
}

function stepChoose(state: H7State, inputs: Inputs, tick: number): H7State {
  const timeout = state.idle + 1 >= DECISION_TIMEOUT;
  const pending: (Move | null)[] = [state.pending[0], state.pending[1]];
  for (const side of [0, 1] as const) {
    if (pending[side] !== null) {
      continue;
    }
    const pressed = moveFromButtons(inputs[side], state.hp[side] > 0);
    if (pressed !== null) {
      pending[side] = pressed;
    } else if (timeout) {
      pending[side] = NONE;
    }
  }
  const moved: H7State = {
    ...state,
    tick,
    pending: pending as [Move | null, Move | null],
    idle: state.idle + 1,
  };
  if (pending[0] !== null && pending[1] !== null) {
    return { ...moved, phase: 'locked', wait: LOCK_TICKS };
  }
  return moved;
}

function stepH7(state: H7State, inputs: Inputs): H7State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: H7State;

  if (state.phase === 'prep') {
    after =
      state.wait <= 1
        ? { ...state, tick, phase: 'choose', wait: 0, idle: 0 }
        : { ...state, tick, wait: state.wait - 1 };
  } else if (state.phase === 'choose') {
    after = stepChoose(state, inputs, tick);
  } else if (state.phase === 'locked') {
    after = state.wait <= 1 ? reveal({ ...state, tick }) : { ...state, tick, wait: state.wait - 1 };
  } else if (state.wait <= 1) {
    const banked = bank({ ...state, tick });
    after =
      banked.round >= ROUNDS
        ? finish(banked)
        : { ...banked, phase: 'prep', wait: AI_WAIT_TICKS, idle: 0 };
  } else {
    after = { ...state, tick, wait: state.wait - 1 };
  }

  if (!after.over && tick >= state.maxTicks) {
    // 時間到：已經揭示的先入帳；還在 choose 或 locked 的不算。
    return finish(after.phase === 'resolve' ? bank(after) : after);
  }
  return after;
}

// ---------------------------------------------------------------------------
// actions 與 evaluate
// ---------------------------------------------------------------------------

const ONLY_IDLE: readonly Buttons[] = Object.freeze([IDLE]);
/** 不搶排第一（搜尋時模擬的對手按第一個：它會推進結算）；昏倒的人沒有紅球。 */
const CHOOSE_ACTIONS: readonly Buttons[] = Object.freeze([
  MOVE_BUTTONS[NONE] as Buttons,
  MOVE_BUTTONS[WHITE] as Buttons,
  MOVE_BUTTONS[GREEN] as Buttons,
  MOVE_BUTTONS[RED] as Buttons,
]);
const CHOOSE_ACTIONS_FAINTED: readonly Buttons[] = Object.freeze(CHOOSE_ACTIONS.slice(0, 3));

function actionsH7(state: H7State, side: Side): readonly Buttons[] {
  // 只看自己有沒有選、自己的血，不看對手的 pending（不偷看）。
  if (!state.over && state.phase === 'choose' && state.pending[side] === null) {
    return state.hp[side] > 0 ? CHOOSE_ACTIONS : CHOOSE_ACTIONS_FAINTED;
  }
  return ONLY_IDLE;
}

function evaluateH7(state: H7State, side: Side): { gain: number; danger: number } {
  const opp = otherSide(side);
  const diff = state.score[side] - state.score[opp];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: diff + sign * END_BONUS, danger: 0 };
  }
  const mine = state.pending[side];
  if (state.phase === 'prep' || mine === null) {
    return { gain: diff, danger: 0 };
  }
  const red = state.orbs.red;
  if (state.phase === 'choose' || state.phase === 'locked') {
    // 只讀自己的 pending；淺搜尋（深度 1、2）只走到這裡，所以只剩反射規則：搶自己最想要的，不管對方。
    return {
      gain: diff + HABIT * reflexValue(state.hp[side], mine, red, roundsAfterOf(state)),
      danger: mine === RED && state.hp[side] <= red[1] ? REFLEX_DANGER : 0,
    };
  }
  // resolve：深度 3 以上走得到這裡。對「對手真的搶了什麼、這回合的結果」目盲：不讀 `last`、不讀對手的 pending，
  // 分數與血用還沒入帳的，對手由 Q 建模。
  const q = predictOpp(state, side);
  return {
    gain: diff + expectedNet(state, side, mine, q) + TAU * gumbelOf(state.salt, side, mine),
    danger: faintChance(state, side, mine, q),
  };
}

export const h7Game: Game<H7State> = {
  id: 'H-7',

  init(seed: number, config: GameConfig): H7State {
    const first = drawRound(rngStateFor(seed, 'orbs'));
    return makeState({
      maxTicks: config.maxTicks,
      orbs: { red: first.red },
      salt: first.salt,
      rng: first.rng,
      model: config.params['model'] !== 0,
      clash: config.params['clash'] !== 0,
    });
  },

  step(state: H7State, inputs: Inputs): H7State {
    return stepH7(state, inputs);
  },

  isOver(state: H7State): boolean {
    return state.over;
  },

  score(state: H7State): readonly [number, number] {
    return [state.score[0], state.score[1]];
  },

  winner(state: H7State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: H7State, side: Side): readonly Buttons[] {
    return actionsH7(state, side);
  },

  evaluate(state: H7State, side: Side): { gain: number; danger: number } {
    return evaluateH7(state, side);
  },
};
