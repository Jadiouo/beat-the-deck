import { intFrom, rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { AI_WAIT_TICKS, DECISION_TIMEOUT, IDLE, otherSide } from '../_hearts/logic';

/**
 * H-10 暗標（SPEC 第 9 節：「十件物品各有價值，同時出價，預算固定」；小規格 `docs/cards/H-10.md`）。
 *
 * 十件物品（價值 1 到 10 各一件，順序公開）。兩邊每件同時暗中選一個「出價檔位」（棄標、×0.5、×0.8、
 * 公平價、×1.3、×1.8），出價 = 檔位倍數 × 公平價；出價高的拿走物品並付自己的出價（第一價格），
 * 一樣高就作廢。十件之後價值多的贏。
 *
 * 這張牌是 `docs/DESIGN-AI-FUN.md` 第 10 節模板的驗證牌：玩家的出價紀錄是公開的信號，
 * AI 用最近幾件的檔位預測這件你會出什麼，選一個「剛好夠高」的檔位；它選的檔位是不可逆的承諾，
 * 讀錯了就丟掉整件物品。
 */

/** 檔位：0 棄標、1 保守（×0.5）、2 省（×0.8）、3 公平價、4 加價（×1.3）、5 重壓（×1.8）。 */
export type Level = 0 | 1 | 2 | 3 | 4 | 5;

export const ITEMS = 10;
export const BUDGET = 100;
/** 每個檔位的倍數（百分比）。 */
export const LEVEL_PCT: readonly number[] = [0, 50, 80, 100, 130, 180];
/** 公平價的檔位（反射規則出這一檔）。 */
export const FAIR_LEVEL = 3;
/** 兩邊都選好之後，鎖定幾個 tick 才揭示（選 1、鎖定 2、揭示 3：深度 3 以上走得到揭示）。 */
export const LOCK_TICKS = 2;
/** 揭示之後停幾個 tick 才入帳、進下一件。 */
export const RESULT_TICKS = 60;

/** 檔位對應的按鍵：b 棄標、左 ×0.5、下 ×0.8、a 公平價、右 ×1.3、上 ×1.8。公平價排在 actions 的第一個。 */
export const LEVEL_BUTTONS: readonly Buttons[] = Object.freeze([
  Object.freeze({ ...IDLE, b: true }),
  Object.freeze({ ...IDLE, left: true }),
  Object.freeze({ ...IDLE, down: true }),
  Object.freeze({ ...IDLE, a: true }),
  Object.freeze({ ...IDLE, right: true }),
  Object.freeze({ ...IDLE, up: true }),
]);

export type H10Phase = 'prep' | 'choose' | 'locked' | 'resolve';

/** 一件的結果。揭示時算出來，入帳之前只存在 `last`（`evaluate` 不可以讀）。 */
export interface H10Last {
  readonly levels: readonly [Level, Level];
  readonly bids: readonly [number, number];
  readonly winner: Side | null;
}

/** 已入帳的一件（公開）。 */
export interface H10Record extends H10Last {
  readonly value: number;
}

export interface H10State {
  readonly tick: number;
  readonly maxTicks: number;
  readonly over: boolean;
  readonly winner: Side | null;
  /** 現在第幾件（0 到 ITEMS − 1）。 */
  readonly item: number;
  /** 十件的價值（1 到 10 的排列，開局就全部公開）。 */
  readonly values: readonly number[];
  /** 兩邊剩下的預算。 */
  readonly budget: readonly [number, number];
  /** 兩邊已入帳的價值總和。 */
  readonly got: readonly [number, number];
  readonly phase: H10Phase;
  /** prep、locked、resolve 還剩幾個 tick。 */
  readonly wait: number;
  /** choose 階段已經過了幾個 tick（超時用）。 */
  readonly idle: number;
  /** 兩邊這件選的檔位（`null` 是還沒選）。選了不能改。對手的是隱藏資訊。 */
  readonly pending: readonly [Level | null, Level | null];
  /** 這件揭示的結果（入帳之前）。 */
  readonly last: H10Last | null;
  /** 已入帳的每一件，最多 ITEMS 筆。 */
  readonly history: readonly H10Record[];
  /** 對手模型開關（消融實驗用 `config.params.model = 0` 關掉）。 */
  readonly model: boolean;
}

/** 結束的局，勝負加成（比任何分差都大）。 */
const END_BONUS = 1000;
/** 反射規則的小加分：偏離公平價一檔扣這麼多（遠小於任何真正的期望值差）。 */
const HABIT = 0.01;

/** 對手模型的常數（小規格「對手模型」）。 */
export const WINDOW = 4;
export const DECAY = 0.6;
/** 先驗：沒有證據時對手出公平價（質量），另外每個檔位一點點底噪。 */
const PRIOR_FAIR = 0.3;
const NOISE = 0.02;
/** 畫面上「AI 的把握」：連續一致的件數越多越高。 */
const CONFIDENCE_CUTS: readonly [number, number, number] = [0.3, 0.55, 0.8];

const DEFAULT_VALUES: readonly number[] = [3, 8, 1, 6, 10, 2, 7, 4, 9, 5];

// ---------------------------------------------------------------------------
// 出價
// ---------------------------------------------------------------------------

/** 從第 `item` 件到最後一件的價值總和（含這一件）。 */
export function remainingValue(values: readonly number[], item: number): number {
  let total = 0;
  for (let i = item; i < values.length; i += 1) {
    total += values[i] as number;
  }
  return total;
}

/**
 * 出價 = 檔位倍數 × 公平價，公平價 = 價值 × 剩餘預算 ÷ 剩餘價值（含這件）。四捨五入、不超過剩餘預算；棄標是 0。
 * 最後一件的公平價就是全部預算。
 */
export function bidOf(level: Level, value: number, budget: number, valueRest: number): number {
  if (level === 0 || budget <= 0 || valueRest <= 0) {
    return 0;
  }
  const raw = ((LEVEL_PCT[level] as number) * value * budget) / (100 * valueRest);
  return Math.min(budget, Math.max(0, Math.round(raw)));
}

/** 一個 tick 的按鍵是哪個檔位：b 最優先，其次 上、右、下、左，a 最後。 */
function levelFromButtons(buttons: Buttons): Level | null {
  if (buttons.b) {
    return 0;
  }
  if (buttons.up) {
    return 5;
  }
  if (buttons.right) {
    return 4;
  }
  if (buttons.down) {
    return 2;
  }
  if (buttons.left) {
    return 1;
  }
  return buttons.a ? FAIR_LEVEL : null;
}

function bidsFor(state: H10State, levels: readonly [Level, Level]): readonly [number, number] {
  const value = state.values[state.item] as number;
  const rest = remainingValue(state.values, state.item);
  return [
    bidOf(levels[0], value, state.budget[0], rest),
    bidOf(levels[1], value, state.budget[1], rest),
  ];
}

function winnerOfBids(bids: readonly [number, number]): Side | null {
  if (bids[0] === bids[1]) {
    return null;
  }
  return bids[0] > bids[1] ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 對手模型：只讀 history。evaluate 與畫面共用。
// ---------------------------------------------------------------------------

type History = readonly H10Record[];

/** 最近 `WINDOW` 件裡 `side` 的對手各檔位的質量（越近越重），加上先驗。 */
function levelMass(
  history: History,
  side: Side,
  model: boolean,
): { mass: number[]; evidence: number } {
  const mass = new Array<number>(6).fill(NOISE);
  mass[FAIR_LEVEL] = (mass[FAIR_LEVEL] as number) + PRIOR_FAIR;
  let evidence = 0;
  if (model) {
    const them = otherSide(side);
    const from = Math.max(0, history.length - WINDOW);
    for (let t = history.length - 1; t >= from; t -= 1) {
      const weight = DECAY ** (history.length - 1 - t);
      const level = (history[t] as H10Record).levels[them];
      mass[level] = (mass[level] as number) + weight;
      evidence += weight;
    }
  }
  return { mass, evidence };
}

/**
 * 從歷史算「`side` 的對手」這件會選哪個檔位的機率（六個檔位，加起來是 1）。
 * 最近 `WINDOW = 4` 件，每早一件權重乘 `DECAY = 0.6`；先驗是出公平價。`model = false`（消融）時永遠是先驗。
 */
export function predictOpponent(history: History, side: Side, model: boolean): readonly number[] {
  const { mass } = levelMass(history, side, model);
  const total = mass.reduce((a, b) => a + b, 0);
  return mass.map((m) => m / total);
}

/**
 * 畫面上的「AI 對你的把握」：粗粒度的四級（0 沒把握到 3 很有把握）。
 * 看最近窗口裡最常出現的檔位占多少權重、乘上件數（最多 4 件）：一貫的對手越來越高，亂出的人停在 1 以下。
 * **不說是哪一個檔位**，也不說它會出什麼價（那還要看價值與預算）。
 */
export function confidenceLevel(history: History, side: Side, model: boolean): 0 | 1 | 2 | 3 {
  if (!model || history.length === 0) {
    return 0;
  }
  const them = otherSide(side);
  const from = Math.max(0, history.length - WINDOW);
  const byLevel = new Array<number>(6).fill(0);
  let total = 0;
  for (let t = history.length - 1; t >= from; t -= 1) {
    const weight = DECAY ** (history.length - 1 - t);
    const level = (history[t] as H10Record).levels[them];
    byLevel[level] = (byLevel[level] as number) + weight;
    total += weight;
  }
  const share = Math.max(...byLevel) / total;
  const score = (share * (history.length - from)) / WINDOW;
  return score < CONFIDENCE_CUTS[0]
    ? 0
    : score < CONFIDENCE_CUTS[1]
      ? 1
      : score < CONFIDENCE_CUTS[2]
        ? 2
        : 3;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** 測試用：從「第 0 件、準備剛開始、預算各 100」出發，用 overrides 覆蓋。 */
export function makeState(overrides: Partial<H10State> = {}): H10State {
  return {
    tick: 0,
    maxTicks: 3600,
    over: false,
    winner: null,
    item: 0,
    values: DEFAULT_VALUES,
    budget: [BUDGET, BUDGET],
    got: [0, 0],
    phase: 'prep',
    wait: AI_WAIT_TICKS,
    idle: 0,
    pending: [null, null],
    last: null,
    history: [],
    model: true,
    ...overrides,
  };
}

/** 種子洗出來的價值順序（Fisher–Yates，亂數狀態只在 init 用）。 */
function shuffledValues(seed: number): number[] {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  let rng = rngStateFor(seed, 'order');
  for (let i = values.length - 1; i > 0; i -= 1) {
    const [j, next] = intFrom(rng, i + 1);
    rng = next;
    const tmp = values[i] as number;
    values[i] = values[j] as number;
    values[j] = tmp;
  }
  return values;
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function winnerByTotals(totals: readonly [number, number]): Side | null {
  if (totals[0] === totals[1]) {
    return null;
  }
  return totals[0] > totals[1] ? 0 : 1;
}

/** 揭示：算出這件的結果，預算與分數都還沒動。 */
function reveal(state: H10State): H10State {
  const levels = state.pending as readonly [Level, Level];
  const bids = bidsFor(state, levels);
  return {
    ...state,
    phase: 'resolve',
    wait: RESULT_TICKS,
    last: { levels, bids, winner: winnerOfBids(bids) },
  };
}

/** 入帳：贏的人付自己的出價、拿走價值；歷史加一筆；進下一件。 */
function bank(state: H10State): H10State {
  const last = state.last;
  if (last === null) {
    return state;
  }
  const value = state.values[state.item] as number;
  const budget: [number, number] = [state.budget[0], state.budget[1]];
  const got: [number, number] = [state.got[0], state.got[1]];
  if (last.winner !== null) {
    budget[last.winner] -= last.bids[last.winner] as number;
    got[last.winner] += value;
  }
  return {
    ...state,
    budget,
    got,
    history: [...state.history, { ...last, value }],
    item: state.item + 1,
    last: null,
    pending: [null, null],
  };
}

function finish(state: H10State): H10State {
  return { ...state, over: true, winner: winnerByTotals(state.got) };
}

function stepChoose(state: H10State, inputs: Inputs, tick: number): H10State {
  const timeout = state.idle + 1 >= DECISION_TIMEOUT;
  const pending: (Level | null)[] = [state.pending[0], state.pending[1]];
  for (const side of [0, 1] as const) {
    if (pending[side] !== null) {
      continue;
    }
    const pressed = levelFromButtons(inputs[side]);
    if (pressed !== null) {
      pending[side] = pressed;
    } else if (timeout) {
      pending[side] = 0;
    }
  }
  const moved: H10State = {
    ...state,
    tick,
    pending: pending as [Level | null, Level | null],
    idle: state.idle + 1,
  };
  if (pending[0] !== null && pending[1] !== null) {
    return { ...moved, phase: 'locked', wait: LOCK_TICKS };
  }
  return moved;
}

function stepH10(state: H10State, inputs: Inputs): H10State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;
  let after: H10State;

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
      banked.item >= ITEMS
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
/** 六個檔位，公平價排第一（搜尋時模擬的對手按第一個）。 */
const CHOOSE_ACTIONS: readonly Buttons[] = Object.freeze([
  LEVEL_BUTTONS[FAIR_LEVEL] as Buttons,
  LEVEL_BUTTONS[0] as Buttons,
  LEVEL_BUTTONS[1] as Buttons,
  LEVEL_BUTTONS[2] as Buttons,
  LEVEL_BUTTONS[4] as Buttons,
  LEVEL_BUTTONS[5] as Buttons,
]);

function actionsH10(state: H10State, side: Side): readonly Buttons[] {
  // 只看自己有沒有選，不看對手的 pending（不偷看）。
  if (!state.over && state.phase === 'choose' && state.pending[side] === null) {
    return CHOOSE_ACTIONS;
  }
  return ONLY_IDLE;
}

/**
 * 揭示階段的期望：我選了 `mine`，對手的檔位由歷史建模（只讀公開資訊）。
 * 贏：價值減去付出的籌碼（籌碼的影子價格 ν = 之後還有多少價值 ÷ 我的預算：一個籌碼在公平價下買得到多少價值）；
 * 平手：0；輸：失去這件、但對手付了它的出價（對手的籌碼也值錢）。
 */
function resolveExpectation(state: H10State, side: Side, mine: Level): number {
  const opp = otherSide(side);
  const value = state.values[state.item] as number;
  const rest = remainingValue(state.values, state.item);
  const after = rest - value;
  const myBudget = state.budget[side];
  const oppBudget = state.budget[opp];
  const nuMe = myBudget > 0 ? after / myBudget : 0;
  const nuOpp = oppBudget > 0 ? after / oppBudget : 0;
  const myBid = bidOf(mine, value, myBudget, rest);
  const probs = predictOpponent(state.history, side, state.model);
  let expected = 0;
  for (let m = 0; m < 6; m += 1) {
    const theirBid = bidOf(m as Level, value, oppBudget, rest);
    const outcome =
      myBid > theirBid ? value - nuMe * myBid : myBid === theirBid ? 0 : -value + nuOpp * theirBid;
    expected += (probs[m] as number) * outcome;
  }
  return expected;
}

function evaluateH10(state: H10State, side: Side): { gain: number; danger: number } {
  const diff = state.got[side] - state.got[otherSide(side)];
  if (state.over) {
    const sign = state.winner === null ? 0 : state.winner === side ? 1 : -1;
    return { gain: diff + sign * END_BONUS, danger: 0 };
  }
  const mine = state.pending[side];
  switch (state.phase) {
    case 'prep':
      return { gain: diff, danger: 0 };
    case 'choose':
    case 'locked':
      // 只讀自己的 pending；淺搜尋（深度 1、2）只走到這裡，所以只剩反射規則：出公平價。
      return {
        gain: diff - HABIT * (mine === null ? 4 : Math.abs(mine - FAIR_LEVEL)),
        danger: 0,
      };
    case 'resolve':
      // 深度 3 以上走得到這裡。對「對手真的出了什麼、這件的結果」目盲：不讀 `last`、不讀對手的 pending，
      // 分數與預算用還沒入帳的，對手由歷史建模。
      return {
        gain: mine === null ? diff : diff + resolveExpectation(state, side, mine),
        danger: 0,
      };
  }
}

export const h10Game: Game<H10State> = {
  id: 'H-10',

  init(seed: number, config: GameConfig): H10State {
    return makeState({
      maxTicks: config.maxTicks,
      values: shuffledValues(seed),
      model: config.params['model'] !== 0,
    });
  },

  step(state: H10State, inputs: Inputs): H10State {
    return stepH10(state, inputs);
  },

  isOver(state: H10State): boolean {
    return state.over;
  },

  score(state: H10State): readonly [number, number] {
    return [state.got[0], state.got[1]];
  },

  winner(state: H10State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: H10State, side: Side): readonly Buttons[] {
    return actionsH10(state, side);
  },

  evaluate(state: H10State, side: Side): { gain: number; danger: number } {
    return evaluateH10(state, side);
  },
};
