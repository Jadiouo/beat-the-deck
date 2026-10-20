import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { cAGame } from '../C-A/logic';
import {
  c2Game,
  makeState as makeC2State,
  viewRotationAt,
  warningAt as c2WarningAt,
} from '../C-2/logic';
import {
  BLUE,
  FOODS_PER_COLOR,
  RED,
  c3Game,
  makeState as makeC3State,
  warningAt as c3WarningAt,
} from '../C-3/logic';
import type { C3State, FoodColor } from '../C-3/logic';
import { c4Game, makeState as makeC4State } from '../C-4/logic';
import type { C4State } from '../C-4/logic';
import {
  CELLS,
  FOOD_COUNT,
  initClubsState,
  makeState as makeClubsState,
  refillFoods,
  winnerByScore,
} from '../_clubs/logic';
import type { ClubsState, Snake, StateOverrides } from '../_clubs/logic';

/**
 * C-K 梅花馬拉松（SPEC 第 9 節；小規格 `docs/cards/C-K.md`）。
 *
 * 一條蛇、一個分數、一張地圖從頭用到尾；60 秒分四段（每段 `PHASE_TICKS` = 900 tick），
 * 第 0 段是普通的 C-A，後三段從 `PHASE_POOL` 不重複地抽（賽程在 `init` 抽好，寫進 `phases`）。
 * 離下一段 `NOTICE_TICKS` = 300 tick 起，`notice` 是 true（畫面亮出下一段）。
 *
 * **這一層沒有自己的 AI 互動**（DESIGN-AI-FUN 10.27：四張 K 是馬拉松包裝牌）：`step`、`actions`、`evaluate`、
 * `render` 全部委派給「目前這一段」的那張牌，C-K 自己的邏輯只有賽程、段計時、換段時的轉接。
 * `actions` 與 `evaluate` 只讀目前這一段的欄位，不讀 `phases[phase + 1]` 與 `notice`（AI 不看預告）。
 *
 * 委派的做法：把「共同欄位＋`sub`」合成那張牌自己的 state（`tick` 換成段內的 `phaseTick`，`maxTicks` 設成不會到），
 * 呼叫它的函式，再把結果拆回來。只合成目前這一段，所以 `evaluate` 的成本是「合成一個物件＋那張牌自己的 `evaluate`」，
 * 不會隨段數增加。全部不改動傳進來的 state。
 */

// ---------------------------------------------------------------------------
// 常數與型別
// ---------------------------------------------------------------------------

/** 每一段的 tick 數（15 秒）。 */
export const PHASE_TICKS = 900;
/** 離下一段還有這麼多 tick 起，畫面預告下一段（5 秒）。 */
export const NOTICE_TICKS = 300;
/** 段數。 */
export const PHASE_COUNT = 4;

/** 一段的規則來自哪張牌。 */
export type PhaseId = 'C-A' | 'C-2' | 'C-3' | 'C-4';
/**
 * 第 1 到 3 段從這裡抽（不重複）。只收「可以疊在同一條蛇與同一個分數上」的規則：
 * C-5（牆壓死）、C-6（改地圖）、C-7（縮水，分數就是長度）都能疊，但轉接層要多管牆、門、長度，
 * 小規格說「轉接層太脆弱就不要做」，所以暫不收（見 `docs/cards/C-K.md` 的依賴表）。
 */
export const PHASE_POOL: readonly PhaseId[] = ['C-2', 'C-3', 'C-4'];

/** 被委派的牌看到的 `maxTicks`：到不了。全場的時間由 C-K 自己判。 */
const NEVER = Number.MAX_SAFE_INTEGER;

/** 該段專屬的欄位（物件，全部可序列化；換段時整個換掉）。 */
export type Sub = Readonly<Record<string, unknown>>;

export interface CKState extends ClubsState {
  readonly phase: 0 | 1 | 2 | 3;
  /** 這一段已經走了幾個 tick（0 到 899；霧段有人死了停格時會超過 899，見 `step`）。 */
  readonly phaseTick: number;
  /** 長度 4 的賽程，`phases[0]` 是 `C-A`。 */
  readonly phases: readonly PhaseId[];
  /** 離下一段 ≤ `NOTICE_TICKS` tick（最後一段沒有下一段，永遠是 false）。 */
  readonly notice: boolean;
  /**
   * 人這一側的畫面轉了幾個 90 度：C-2 段是 `sub.viewRotation`，別的段是 0。
   * 為什麼放在最上層：外殼把按鍵轉回世界方向時讀 state 最上層的 `viewRotation`（`shell/match-session.ts`），
   * 遊戲邏輯本身完全不讀它（衍生欄位，和 `notice` 一樣由 `phase`、`sub` 推出來）。
   */
  readonly viewRotation: 0 | 1 | 2 | 3;
  readonly sub: Sub;
}

type Delegate = Game<unknown>;
const DELEGATES: Readonly<Record<PhaseId, Delegate>> = {
  'C-A': cAGame as unknown as Delegate,
  'C-2': c2Game as unknown as Delegate,
  'C-3': c3Game as unknown as Delegate,
  'C-4': c4Game as unknown as Delegate,
};

// ---------------------------------------------------------------------------
// 賽程
// ---------------------------------------------------------------------------

/** 這個種子的賽程：`C-A`，加上從池裡不重複地抽出的三段（洗牌，`rngStateFor(seed, 'phases')`）。 */
export function scheduleFor(seed: number): readonly PhaseId[] {
  const rest = [...PHASE_POOL];
  let rng: RngState = rngStateFor(seed, 'phases');
  const picked: PhaseId[] = [];
  while (picked.length < PHASE_COUNT - 1 && rest.length > 0) {
    const [index, following] = intFrom(rng, rest.length);
    rng = following;
    picked.push(rest.splice(index, 1)[0] as PhaseId);
  }
  return ['C-A', ...picked];
}

function rotationOf(phases: readonly PhaseId[], phase: number, sub: Sub): 0 | 1 | 2 | 3 {
  return phases[phase] === 'C-2' ? (sub as { viewRotation: 0 | 1 | 2 | 3 }).viewRotation : 0;
}

function noticeAt(phase: number, phaseTick: number): boolean {
  return phase < PHASE_COUNT - 1 && phaseTick >= PHASE_TICKS - NOTICE_TICKS;
}

// ---------------------------------------------------------------------------
// 合成與拆回
// ---------------------------------------------------------------------------

/** 把 C-K 的 state 合成「目前這一段那張牌自己的 state」：`tick` 是段內的、`maxTicks` 到不了、`sub` 攤平。 */
export function composeState(state: CKState): unknown {
  return {
    ...state.sub,
    tick: state.phaseTick,
    maxTicks: NEVER,
    snakes: state.snakes,
    foods: state.foods,
    rng: state.rng,
    over: state.over,
    winner: state.winner,
  };
}

/** 從該段那張牌的 state 取出它專屬的欄位。 */
function subOf(id: PhaseId, whole: unknown): Sub {
  switch (id) {
    case 'C-A':
      return {};
    case 'C-2': {
      const s = whole as { viewRotation: number; warning: boolean };
      return { viewRotation: s.viewRotation, warning: s.warning };
    }
    case 'C-3': {
      const s = whole as C3State;
      return { foodColors: s.foodColors, correct: s.correct, warning: s.warning };
    }
    case 'C-4': {
      const s = whole as C4State;
      return {
        memory: s.memory,
        ateAt: s.ateAt,
        prevDir: s.prevDir,
        endAt: s.endAt,
        pendingWinner: s.pendingWinner,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// 換段的轉接（exit 與 enter）
// ---------------------------------------------------------------------------

/**
 * 離開 C-3：4 顆食物收回 `FOOD_COUNT` 顆。留現在正確顏色的（它們是還有分數的）；不夠再補格子編號小的；
 * 留下的依格子編號排。只看 state，沒有亂數。
 */
function trimAfterC3(
  foods: readonly number[],
  colors: readonly number[],
  correct: number,
): readonly number[] {
  const order = foods.map((_food, index) => index);
  order.sort((a, b) => {
    const right = Number(colors[b] === correct) - Number(colors[a] === correct);
    return right !== 0 ? right : (foods[a] as number) - (foods[b] as number);
  });
  return order
    .slice(0, FOOD_COUNT)
    .map((index) => foods[index] as number)
    .sort((a, b) => a - b);
}

/** 進入 C-3：現有食物依序分配紅、藍、紅、藍……，再補到紅藍各 `FOODS_PER_COLOR` 顆；正確顏色由亂數抽。 */
function enterC3(
  rng: RngState,
  snakes: readonly [Snake, Snake],
  foods: readonly number[],
): { foods: readonly number[]; sub: Sub; rng: RngState } {
  let nextFoods = foods;
  let colors: FoodColor[] = foods.map((_food, index) => (index % 2 === 0 ? RED : BLUE));
  let nextRng = rng;
  for (const color of [RED, BLUE] as const) {
    while (colors.filter((c) => c === color).length < FOODS_PER_COLOR) {
      const filled = refillFoods(nextRng, snakes, nextFoods, nextFoods.length + 1);
      nextRng = filled.rng;
      if (filled.foods.length === nextFoods.length) {
        break; // 沒有空格了
      }
      nextFoods = filled.foods;
      colors = [...colors, color];
    }
  }
  const [pick, following] = intFrom(nextRng, 2);
  return {
    foods: nextFoods,
    rng: following,
    sub: { foodColors: colors, correct: pick as FoodColor, warning: c3WarningAt(0) },
  };
}

/**
 * 進入 C-4：兩邊的記憶都記得換段那一刻場上所有的食物、所有格子都「剛看過」（進霧之前大家都看過整張圖）；
 * 對手只記視野內的部分（用 C-4 自己掃視的結果，範圍外的蛇身不進 `rival`），所以不洩漏對手的位置。
 */
function enterC4(rng: RngState, snakes: readonly [Snake, Snake], foods: readonly number[]): Sub {
  const seen = Array.from({ length: CELLS }, () => 0);
  const memory = { foods, seen, goal: -1 };
  const made = makeC4State({
    tick: 0,
    maxTicks: NEVER,
    snakes,
    foods,
    rng,
    memory: [memory, memory],
  });
  return subOf('C-4', made);
}

function advance(state: CKState): CKState {
  const from = state.phases[state.phase] as PhaseId;
  const to = state.phases[state.phase + 1] as PhaseId;
  // exit
  let foods = state.foods;
  if (from === 'C-3') {
    const sub = state.sub as { foodColors: readonly number[]; correct: number };
    foods = trimAfterC3(foods, sub.foodColors, sub.correct);
  }
  const refilled = refillFoods(state.rng, state.snakes, foods, FOOD_COUNT);
  foods = refilled.foods;
  let rng = refilled.rng;
  // enter
  let sub: Sub;
  switch (to) {
    case 'C-A':
      sub = {};
      break;
    case 'C-2':
      sub = { viewRotation: viewRotationAt(0), warning: c2WarningAt(0) };
      break;
    case 'C-3': {
      const entered = enterC3(rng, state.snakes, foods);
      foods = entered.foods;
      rng = entered.rng;
      sub = entered.sub;
      break;
    }
    case 'C-4':
      sub = enterC4(rng, state.snakes, foods);
      break;
  }
  return {
    ...state,
    phase: (state.phase + 1) as CKState['phase'],
    phaseTick: 0,
    notice: false,
    viewRotation: rotationOf(state.phases, state.phase + 1, sub),
    foods,
    rng,
    sub,
  };
}

// ---------------------------------------------------------------------------
// 一個 tick
// ---------------------------------------------------------------------------

/** 沒有人死、也沒有人「死了正在停格」。 */
function everyoneAlive(snakes: readonly [Snake, Snake]): boolean {
  return snakes[0].alive && snakes[1].alive;
}

/** 時間到時的贏家：有人死了（霧段停格中）活著的贏，兩邊都死比分數；沒人死比分數。 */
function winnerAtTimeout(snakes: readonly [Snake, Snake]): Side | null {
  if (snakes[0].alive !== snakes[1].alive) {
    return snakes[0].alive ? 0 : 1;
  }
  return winnerByScore(snakes);
}

function stepCK(state: CKState, inputs: Inputs): CKState {
  if (state.over) {
    return state;
  }
  const id = state.phases[state.phase] as PhaseId;
  const whole = (DELEGATES[id] as Game<unknown>).step(composeState(state), inputs) as ClubsState;
  const tick = state.tick + 1;
  const phaseTick = state.phaseTick + 1;
  const sub = subOf(id, whole);
  const next: CKState = {
    tick,
    maxTicks: state.maxTicks,
    snakes: whole.snakes,
    foods: whole.foods,
    rng: whole.rng,
    over: whole.over,
    winner: whole.winner,
    phase: state.phase,
    phaseTick,
    phases: state.phases,
    notice: noticeAt(state.phase, phaseTick),
    viewRotation: rotationOf(state.phases, state.phase, sub),
    sub,
  };
  if (next.over) {
    return next;
  }
  if (tick >= state.maxTicks) {
    return { ...next, over: true, winner: winnerAtTimeout(next.snakes) };
  }
  // 有人死了（霧段的停格）就不換段：先把停格走完、宣布結果。
  if (phaseTick >= PHASE_TICKS && state.phase < PHASE_COUNT - 1 && everyoneAlive(next.snakes)) {
    return advance(next);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export const ckGame: Game<CKState> = {
  id: 'C-K',

  init(seed: number, config: GameConfig): CKState {
    // `initClubsState` 檢查 config 並放好兩條蛇與 2 顆食物。
    const base = initClubsState(seed, config);
    return {
      ...base,
      phase: 0,
      phaseTick: 0,
      phases: scheduleFor(seed),
      notice: false,
      viewRotation: 0,
      sub: {},
    };
  },

  step(state: CKState, inputs: Inputs): CKState {
    return stepCK(state, inputs);
  },

  isOver(state: CKState): boolean {
    return state.over;
  },

  score(state: CKState): readonly [number, number] {
    return [state.snakes[0].score, state.snakes[1].score];
  },

  winner(state: CKState): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: CKState, side: Side): readonly Buttons[] {
    return (DELEGATES[state.phases[state.phase] as PhaseId] as Delegate).actions(
      composeState(state),
      side,
    );
  },

  evaluate(state: CKState, side: Side): { gain: number; danger: number } {
    return (DELEGATES[state.phases[state.phase] as PhaseId] as Delegate).evaluate(
      composeState(state),
      side,
    );
  },
};

// ---------------------------------------------------------------------------
// 測試輔助
// ---------------------------------------------------------------------------

export interface CKOverrides extends StateOverrides {
  readonly phase?: 0 | 1 | 2 | 3;
  readonly phaseTick?: number;
  readonly phases?: readonly PhaseId[];
  /** 該段專屬欄位要覆蓋的部分；沒給的欄位是那張牌在這個局面的預設值。 */
  readonly sub?: Partial<Record<string, unknown>>;
}

/**
 * 直接構造一個局面。預設是第 0 段、`phaseTick` 0、賽程 `C-A, C-2, C-3, C-4`、C-A 的起始局面；
 * `tick` 沒給就是 `phase × 900 + phaseTick`。該段專屬欄位由那張牌自己的 `makeState` 在「段內 tick」造出來
 * （C-3 預設有 4 顆食物、C-4 的記憶是在這個局面掃視一次的結果）。
 */
export function makeState(overrides: CKOverrides = {}): CKState {
  const phase = overrides.phase ?? 0;
  const phaseTick = overrides.phaseTick ?? 0;
  const phases = overrides.phases ?? ['C-A', 'C-2', 'C-3', 'C-4'];
  const id = phases[phase] as PhaseId;
  const local: StateOverrides = {
    snakes: overrides.snakes,
    foods: overrides.foods,
    rng: overrides.rng,
    over: overrides.over,
    winner: overrides.winner,
    tick: phaseTick,
    maxTicks: overrides.maxTicks ?? 3600,
  };
  let base: ClubsState;
  let sub: Sub;
  switch (id) {
    case 'C-A':
      base = makeClubsState(local);
      sub = {};
      break;
    case 'C-2': {
      const made = makeC2State(local);
      base = made;
      sub = subOf('C-2', made);
      break;
    }
    case 'C-3': {
      const made = makeC3State(local);
      base = made;
      sub = subOf('C-3', made);
      break;
    }
    case 'C-4': {
      const made = makeC4State(local);
      base = made;
      sub = subOf('C-4', made);
      break;
    }
  }
  const merged: Sub = { ...sub, ...overrides.sub };
  return {
    ...base,
    tick: overrides.tick ?? phase * PHASE_TICKS + phaseTick,
    maxTicks: overrides.maxTicks ?? 3600,
    phase,
    phaseTick,
    phases,
    notice: noticeAt(phase, phaseTick),
    viewRotation: rotationOf(phases, phase, merged),
    sub: merged,
  };
}
