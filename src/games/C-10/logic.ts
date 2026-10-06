import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  HEIGHT,
  LEFT,
  MOVE_EVERY,
  RIGHT,
  WIDTH,
  cell,
  cellX,
  cellY,
  evaluateClubs,
  moveSnakes,
  orderedActions,
  steerSnake,
  winnerByScore,
} from '../_clubs/logic';
import type { ClubsState, Dir, Snake } from '../_clubs/logic';

/**
 * C-10 追與逃（SPEC 第 9 節；小規格 `docs/cards/C-10.md`）。
 *
 * 一條蛇逃、一條蛇追，兩條一樣快，兩局交換角色。逃的蛇撐得越久分越高，追的蛇抓得越快分越高。
 * 格子、轉向、走格、撞牆與撞身體全部用梅花共用的 `_clubs/logic.ts`；這裡只多了「兩局與角色」、
 * 「追的蛇每 24 個 tick 瞄準一次」，以及兩個角色各自的 `actions` 與 `evaluate`。
 *
 * 追的蛇的 AI 怎麼想事情，寫在 state 裡（`aim`）：它每隔一小段時間，假設逃的蛇「一直直走」，
 * 瞄準逃的蛇幾步之後會在的那一格，然後就只往那一格追，直到下一次瞄準。畫面把這一格標出來。
 * 這是搜尋型 AI 的破綻（它預測對手時假設對手維持「全放開」，見 `src/ai/policies/shared.ts` 的 `opponentAction`）
 * 的一個具體樣子：逃的蛇在瞄準之後轉彎，追的蛇就撲空。
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 逃的蛇的長度。沒有食物，所以一局裡長度不變。 */
export const RUNNER_LENGTH = 4;
/** 追的蛇的長度。只有一格：追的蛇不會撞到自己，也不會變成逃的蛇的牆。 */
export const CHASER_LENGTH = 1;
/** 每一局開始前不動的 tick 數（可以先轉向，AI 也先看到新的局面）。 */
export const GRACE_TICKS = 30;
/** 第一局結束後，停住畫面讓人看到怎麼結束的 tick 數。 */
export const PAUSE_TICKS = 60;
/** 兩條蛇起始的蛇頭，曼哈頓距離至少這麼遠。 */
export const MIN_START_GAP = 14;
/** 起始位置離牆至少這麼多格（讓長度 4 的蛇身放得下，也讓第一步不會撞牆）。 */
export const START_MARGIN = 6;
/** 追的蛇每幾個 tick 重新瞄準一次（4 步）。 */
export const AIM_EVERY = 24;
/** 瞄準逃的蛇再走幾步之後的位置（假設它一直直走）。 */
export const AIM_LEAD = 4;
/** 預測的路徑走到離牆這麼近就停（逃的蛇一定會在牆前轉彎，預測一路走到牆上只會害追的蛇撞牆）。 */
export const AIM_MARGIN = 2;
/** 追的蛇下一步就走出地圖時的 gain（比任何距離的平方都低）。 */
export const CHASER_OUT_GAIN = 2000;
/** 一局結束時評估的加減分（遠大於任何距離）。 */
export const ROUND_BONUS = 10_000;
/** 逃的蛇的 gain：離追的蛇每遠一格加多少、最多算幾格。 */
export const FLEE_WEIGHT = 10;
export const FLEE_CAP = 16;
/** 逃的蛇的 gain：離牆不到 `EDGE_CAP` 格時，扣 `EDGE_WEIGHT × (EDGE_CAP − 離牆格數)²`。 */
export const EDGE_WEIGHT = 6;
export const EDGE_CAP = 5;

/** 一局怎麼結束的：逃的蛇出局（被抓或自己撞）、追的蛇自己撞牆出局、時間到。 */
export type RoundOutcome = 'runnerOut' | 'chaserOut' | 'timeout';

/** 第一局的起始位置（第二局把它轉 180 度）。 */
export interface Spawn {
  readonly runnerHead: number;
  readonly runnerDir: Dir;
  readonly chaserHead: number;
  readonly chaserDir: Dir;
}

export interface C10State extends ClubsState {
  /** 現在是第幾局：0 或 1。 */
  readonly round: 0 | 1;
  /** 這一局誰在逃。第一局是 0 號邊（人），第二局是 1 號邊。 */
  readonly runner: Side;
  /** 一局最多幾個 tick（不含開局的不動時間）。 */
  readonly roundTicks: number;
  /** 這一局已經走了幾個 tick；開局的不動時間是負數，從 `-GRACE_TICKS` 數到 0。 */
  readonly roundTick: number;
  /** 兩局之間停住的剩餘 tick 數；大於 0 表示整個畫面凍結。 */
  readonly pause: number;
  readonly pauseTicks: number;
  readonly spawn: Spawn;
  /** 追的蛇現在瞄準的那一格：每 `AIM_EVERY` 個 tick 重新瞄準一次，兩次之間它只往這一格追。 */
  readonly aim: number;
  /** 每一邊「當逃的人」撐了幾個 tick；還沒逃過是 -1。 */
  readonly runnerTicks: readonly [number, number];
  /** 剛結束的那一局怎麼結束的；局進行中是 null。 */
  readonly outcome: RoundOutcome | null;
}

/** 預測模型：逃的蛇再走 `moves` 步之後，蛇頭會在哪一格。追的蛇用它決定瞄準哪裡。 */
export type RunnerModel = (state: C10State, moves: number) => number;

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

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

/** 格子離最近的牆幾格（最外圈是 0）。 */
export function edgeDistance(index: number): number {
  const x = cellX(index);
  const y = cellY(index);
  return Math.min(x, WIDTH - 1 - x, y, HEIGHT - 1 - y);
}

// ---------------------------------------------------------------------------
// 預測與瞄準
// ---------------------------------------------------------------------------

/**
 * 預設的預測模型：逃的蛇一直往它現在要走的方向直走；快走到牆的時候停在牆前 `AIM_MARGIN` 格。
 * 追的蛇的瞄準（`aim`）用的就是它。逃的蛇只要在瞄準之後轉彎，預測就偏了。
 */
export const straightModel: RunnerModel = (state, moves) => {
  const runner = state.snakes[state.runner];
  let at = runner.body[0] as number;
  for (let i = 0; i < moves; i += 1) {
    const next = neighbor(at, runner.turn);
    if (next === -1 || (edgeDistance(next) < AIM_MARGIN && edgeDistance(next) < edgeDistance(at))) {
      break;
    }
    at = next;
  }
  return at;
};

/** 每 `AIM_EVERY` 個 tick（開局之後）重新瞄準；兩次之間 `aim` 不變。 */
function refreshAim(state: C10State, model: RunnerModel): C10State {
  if (state.roundTick > 0 && state.roundTick % AIM_EVERY === 0) {
    return { ...state, aim: model(state, AIM_LEAD) };
  }
  return state;
}

// ---------------------------------------------------------------------------
// 起始位置與每一局的開頭
// ---------------------------------------------------------------------------

function snakeAt(head: number, dir: Dir, score: number, length: number): Snake {
  const body = [head];
  let at = head;
  for (let i = 1; i < length; i += 1) {
    at = neighbor(at, opposite(dir));
    body.push(at);
  }
  return { body, dir, turn: dir, alive: true, score };
}

/** 第 `round` 局的位置：第二局把第一局的位置轉 180 度，所以兩邊遇到的局面完全等價。 */
function spawnFor(spawn: Spawn, round: 0 | 1): Spawn {
  if (round === 0) {
    return spawn;
  }
  return {
    runnerHead: CELLS - 1 - spawn.runnerHead,
    runnerDir: opposite(spawn.runnerDir),
    chaserHead: CELLS - 1 - spawn.chaserHead,
    chaserDir: opposite(spawn.chaserDir),
  };
}

function startRound(state: C10State, round: 0 | 1, model: RunnerModel): C10State {
  const runner: Side = round === 0 ? 0 : 1;
  const chaser = other(runner);
  const place = spawnFor(state.spawn, round);
  const runnerSnake = snakeAt(
    place.runnerHead,
    place.runnerDir,
    state.snakes[runner].score,
    RUNNER_LENGTH,
  );
  const chaserSnake = snakeAt(
    place.chaserHead,
    place.chaserDir,
    state.snakes[chaser].score,
    CHASER_LENGTH,
  );
  const started: C10State = {
    ...state,
    round,
    runner,
    roundTick: -GRACE_TICKS,
    pause: 0,
    outcome: null,
    snakes: runner === 0 ? [runnerSnake, chaserSnake] : [chaserSnake, runnerSnake],
  };
  return { ...started, aim: model(started, AIM_LEAD) };
}

/** 從亂數狀態抽第一局的起始位置：兩條蛇都離牆至少 `START_MARGIN` 格，蛇頭至少相距 `MIN_START_GAP`。 */
function drawSpawn(rng: RngState): { spawn: Spawn; rng: RngState } {
  let state = rng;
  const draw = (n: number): number => {
    const [value, next] = intFrom(state, n);
    state = next;
    return value;
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const runnerHead = cell(
      START_MARGIN + draw(WIDTH - 2 * START_MARGIN),
      START_MARGIN + draw(HEIGHT - 2 * START_MARGIN),
    );
    const runnerDir = draw(4) as Dir;
    const chaserHead = cell(
      START_MARGIN + draw(WIDTH - 2 * START_MARGIN),
      START_MARGIN + draw(HEIGHT - 2 * START_MARGIN),
    );
    const chaserDir = draw(4) as Dir;
    if (manhattan(runnerHead, chaserHead) >= MIN_START_GAP) {
      return { spawn: { runnerHead, runnerDir, chaserHead, chaserDir }, rng: state };
    }
  }
  // 100 次都抽不到（機率可以忽略）：用固定的位置，仍然是合法的。
  return { spawn: fallbackSpawn(), rng: state };
}

function fallbackSpawn(): Spawn {
  return {
    runnerHead: cell(8, 12),
    runnerDir: RIGHT,
    chaserHead: cell(24, 12),
    chaserDir: LEFT,
  };
}

/** 兩局各自的 tick 上限：扣掉兩局的開局不動時間與兩局之間的停頓，平分。 */
function budget(maxTicks: number): { roundTicks: number; pauseTicks: number } {
  const pauseTicks = Math.min(PAUSE_TICKS, Math.floor(maxTicks / 20));
  const roundTicks = Math.floor((maxTicks - pauseTicks - 2 * GRACE_TICKS) / 2);
  return { roundTicks, pauseTicks };
}

export function initC10State(
  seed: number,
  config: GameConfig,
  model: RunnerModel = straightModel,
): C10State {
  if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks < 200) {
    throw new RangeError(`config.maxTicks 必須是 200 以上的整數，收到 ${String(config.maxTicks)}`);
  }
  const drawn = drawSpawn(rngStateFor(seed, 'spawn'));
  const { roundTicks, pauseTicks } = budget(config.maxTicks);
  const blank: C10State = {
    tick: 0,
    maxTicks: config.maxTicks,
    snakes: [snakeAt(0, RIGHT, 0, 1), snakeAt(0, RIGHT, 0, 1)],
    foods: [],
    rng: drawn.rng,
    over: false,
    winner: null,
    round: 0,
    runner: 0,
    roundTicks,
    roundTick: -GRACE_TICKS,
    pause: 0,
    pauseTicks,
    spawn: drawn.spawn,
    aim: 0,
    runnerTicks: [-1, -1],
    outcome: null,
  };
  return startRound(blank, 0, model);
}

// ---------------------------------------------------------------------------
// 一個 tick
// ---------------------------------------------------------------------------

/**
 * 走一個 tick。順序：
 * 1. 兩局之間的停頓：只倒數，倒數完開始第二局。
 * 2. 讀兩邊的輸入鎖定轉向（開局的不動時間也可以轉向）。
 * 3. 每 `MOVE_EVERY` 個 tick 兩條蛇同時走一格（`moveSnakes`）。逃的蛇死了（撞牆、撞自己、撞到追的蛇，
 *    或被追的蛇撞到）就是被抓；追的蛇走進逃的蛇的身體也是抓到，不是追的蛇死；追的蛇自己撞牆才是它出局。
 *    兩條同時死：逃的蛇先算（被抓）。
 * 4. 一局結束：逃的人撐了幾個 tick 就得幾分，追的人得「一局的長度減掉那個數字」。
 * 5. 沒人出局而時間到：逃的人撐滿。出局優先於時間到。
 */
export function stepC10(
  state: C10State,
  inputs: Inputs,
  model: RunnerModel = straightModel,
): C10State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;

  if (state.pause > 0) {
    const pause = state.pause - 1;
    return pause > 0 ? { ...state, tick, pause } : startRound({ ...state, tick }, 1, model);
  }

  const runner = state.runner;
  const chaser = other(runner);
  const roundTick = state.roundTick + 1;
  let snakes: readonly [Snake, Snake] = [
    steerSnake(state.snakes[0], inputs[0]),
    steerSnake(state.snakes[1], inputs[1]),
  ];
  let outcome: RoundOutcome | null = null;

  if (roundTick > 0 && roundTick % MOVE_EVERY === 0) {
    const steered = snakes;
    const moved = moveSnakes(steered, [], undefined);
    snakes = moved.snakes;
    // 追的蛇這一步要走進哪一格（`moveSnakes` 對「死掉的蛇」不移動，所以自己再算一次）。
    const chaserHead = neighbor(steered[chaser].body[0] as number, steered[chaser].turn);
    const caught =
      moved.dead[chaser] && chaserHead !== -1 && snakes[runner].body.includes(chaserHead);
    if (moved.dead[runner] || caught) {
      outcome = 'runnerOut';
      // 追的蛇如果是走進逃的蛇的身體才「死」，那是抓到了：它照樣走進那一格，不算死。
      if (moved.dead[chaser] && chaserHead !== -1) {
        const advanced: Snake = {
          ...steered[chaser],
          alive: true,
          body: [chaserHead, ...steered[chaser].body.slice(0, -1)],
          dir: steered[chaser].turn,
        };
        snakes = chaser === 0 ? [advanced, snakes[1]] : [snakes[0], advanced];
      } else if (moved.dead[chaser]) {
        const stay: Snake = { ...snakes[chaser], alive: true };
        snakes = chaser === 0 ? [stay, snakes[1]] : [snakes[0], stay];
      }
      const down: Snake = { ...snakes[runner], alive: false };
      snakes = runner === 0 ? [down, snakes[1]] : [snakes[0], down];
    } else if (moved.dead[chaser]) {
      outcome = 'chaserOut';
    }
  }
  if (outcome === null && roundTick >= state.roundTicks) {
    outcome = 'timeout';
  }

  if (outcome === null) {
    return refreshAim({ ...state, tick, roundTick, snakes }, model);
  }

  // 一局結束：逃的人撐了 `survived` 個 tick。逃的蛇出局就是 roundTick；追的蛇自己出局或時間到，逃的人撐滿。
  const survived = outcome === 'runnerOut' ? Math.max(0, roundTick) : state.roundTicks;
  const scored: readonly [Snake, Snake] = [
    {
      ...snakes[0],
      score: snakes[0].score + (runner === 0 ? survived : state.roundTicks - survived),
    },
    {
      ...snakes[1],
      score: snakes[1].score + (runner === 1 ? survived : state.roundTicks - survived),
    },
  ];
  const runnerTicks: [number, number] = [state.runnerTicks[0], state.runnerTicks[1]];
  runnerTicks[runner] = survived;
  const ended: C10State = { ...state, tick, roundTick, snakes: scored, runnerTicks, outcome };
  if (state.round === 1) {
    return { ...ended, over: true, winner: winnerByScore(scored) };
  }
  return state.pauseTicks > 0
    ? { ...ended, pause: state.pauseTicks }
    : startRound({ ...ended, outcome: null }, 1, model);
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
const PAUSED_ACTIONS: readonly Buttons[] = Object.freeze([NONE]);

/** 一局結束（或整場結束、或兩局之間停頓）：畫面凍結，沒有動作可選。 */
function frozen(state: C10State): boolean {
  return state.over || state.pause > 0 || state.outcome !== null;
}

/**
 * 逃的蛇「往哪邊轉」排前面的依據：以自己為中心、追的蛇的另一邊的那一格（夾在地圖裡）。
 * 轉向排在「全放開」前面，搜尋型才不會一直拖延轉彎（原因見 `docs/cards/C-A.md` 決定 12）。
 */
function fleePoint(state: C10State, side: Side): number {
  const me = state.snakes[side].body[0] as number;
  const chaser = state.snakes[other(side)].body[0] as number;
  const x = Math.min(WIDTH - 1, Math.max(0, 2 * cellX(me) - cellX(chaser)));
  const y = Math.min(HEIGHT - 1, Math.max(0, 2 * cellY(me) - cellY(chaser)));
  return cell(x, y);
}

/** 一局結束的局面：抓到的人大加分，被抓的人大扣分；追的蛇越早抓到越好、逃的蛇撐越久越好。 */
function evaluateEnded(state: C10State, side: Side): { gain: number; danger: number } {
  const meRunner = side === state.runner;
  const runnerWon = state.outcome !== 'runnerOut';
  const survived = state.runnerTicks[state.runner] as number;
  const sign = meRunner === runnerWon ? 1 : -1;
  const timing = meRunner ? survived : state.roundTicks - survived;
  return { gain: sign * ROUND_BONUS + timing, danger: state.snakes[side].alive ? 0 : 1 };
}

/** 給 `evaluateClubs` 看的局面：兩邊的分數歸零（累積的分數對這一局的決定沒有影響）。 */
function withoutScores(state: C10State): C10State {
  return {
    ...state,
    snakes: [
      { ...state.snakes[0], score: 0 },
      { ...state.snakes[1], score: 0 },
    ],
  };
}

/**
 * 追的蛇：`gain` 是「下一步離瞄準點有多近」（距離的平方，所以先補「差比較多的那一軸」，兩軸一起收攏），
 * `danger` 是自己快撞牆了：下一步走出地圖是 1；往前再走不到 3 格就是牆，依剩下幾格給 0.75、0.5、0.25。
 * 追的蛇沒有身體可撞（長度 1），逃的蛇對它也不是障礙（碰到就是抓到），所以不用共用的評估（`evaluateClubs`）：
 * 它的「離牆太近」「前方 20 格有牆」是給要吃食物的蛇用的，會讓追的蛇不敢靠近貼著牆跑的逃的蛇。
 */
function evaluateChaser(state: C10State, side: Side): { gain: number; danger: number } {
  const me = state.snakes[side];
  const head = me.body[0] as number;
  const next = neighbor(head, me.turn);
  if (next === -1) {
    return { gain: -CHASER_OUT_GAIN, danger: 1 };
  }
  const dx = cellX(next) - cellX(state.aim);
  const dy = cellY(next) - cellY(state.aim);
  let run = 0;
  let at = next;
  for (; run < 3; run += 1) {
    const ahead = neighbor(at, me.turn);
    if (ahead === -1) {
      break;
    }
    at = ahead;
  }
  return { gain: -(dx * dx + dy * dy), danger: run < 3 ? (3 - run) / 4 : 0 };
}

/**
 * 逃的蛇：`gain` = 離追的蛇有多遠（最多算 16 格）− 離牆太近的扣分 + 共用評估的扣分（兩側有牆、追的蛇太近）；
 * `danger` 是共用評估的（撞牆、撞身體、前方有牆、快被困死）。
 */
function evaluateRunner(state: C10State, side: Side): { gain: number; danger: number } {
  const bare = withoutScores(state);
  const me = state.snakes[side];
  const chaserHead = state.snakes[other(side)].body[0] as number;
  const next = neighbor(me.body[0] as number, me.turn);
  if (next === -1) {
    return evaluateClubs({ ...bare, foods: [] }, side);
  }
  // 共用的評估會扣「兩側有牆」的分，但那一項只有在「離食物還遠」時才全額扣。逃的蛇沒有食物，
  // 所以放一個假的食物在離它最遠的角落（一定超過 8 格），評估之後再把「離假食物的距離」加回來。
  const corner = cell(
    cellX(next) < WIDTH / 2 ? WIDTH - 1 : 0,
    cellY(next) < HEIGHT / 2 ? HEIGHT - 1 : 0,
  );
  const base = evaluateClubs({ ...bare, foods: [corner] }, side);
  const away = Math.min(manhattan(next, chaserHead), FLEE_CAP);
  const edge = edgeDistance(next);
  const wall = edge < EDGE_CAP ? (EDGE_CAP - edge) * (EDGE_CAP - edge) : 0;
  return {
    gain: base.gain + manhattan(next, corner) + FLEE_WEIGHT * away - EDGE_WEIGHT * wall,
    danger: base.danger,
  };
}

/**
 * 做出一個 C-10 的遊戲。`model` 是追的蛇預測逃的蛇的方式（預設 `straightModel`：一直直走）。
 * 只有測試會傳別的：要證明「破綻是真的」，就把預測換成「知道逃的蛇會轉彎」的版本，對照追到的時間。
 * `step` 與 `init` 也要用同一個模型，因為 `aim` 是 state 的一部分。
 */
export function createC10Game(model: RunnerModel = straightModel): Game<C10State> {
  return {
    id: 'C-10',

    init(seed: number, config: GameConfig): C10State {
      return initC10State(seed, config, model);
    },

    step(state: C10State, inputs: Inputs): C10State {
      return stepC10(state, inputs, model);
    },

    isOver(state: C10State): boolean {
      return state.over;
    },

    /** 兩邊累積到目前為止的分數（只有 `isOver` 之後才是兩局的總分）。 */
    score(state: C10State): readonly [number, number] {
      return [state.snakes[0].score, state.snakes[1].score];
    },

    winner(state: C10State): Side | null {
      return state.over ? state.winner : null;
    },

    actions(state: C10State, side: Side): readonly Buttons[] {
      if (frozen(state)) {
        return PAUSED_ACTIONS;
      }
      const food = side === state.runner ? fleePoint(state, side) : state.aim;
      return orderedActions({ ...state, foods: [food] }, side);
    },

    evaluate(state: C10State, side: Side): { gain: number; danger: number } {
      if (frozen(state)) {
        return evaluateEnded(state, side);
      }
      return side === state.runner ? evaluateRunner(state, side) : evaluateChaser(state, side);
    },
  };
}

export const c10Game: Game<C10State> = createC10Game();

// ---------------------------------------------------------------------------
// 測試輔助
// ---------------------------------------------------------------------------

export interface C10Overrides {
  readonly round?: 0 | 1;
  readonly runner?: Side;
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly roundTick?: number;
  readonly pause?: number;
  readonly snakes?: readonly [Partial<Snake>?, Partial<Snake>?];
  readonly aim?: number;
  readonly runnerTicks?: readonly [number, number];
  readonly outcome?: RoundOutcome | null;
  readonly over?: boolean;
  readonly winner?: Side | null;
}

/**
 * 直接構造一個局面。預設：第一局、0 號邊逃，已經過了開局的不動時間（`roundTick` 0），
 * 逃的蛇頭在 (6,12) 往右、追的蛇頭在 (25,12) 往左，兩邊分數 0，`aim` 是逃的蛇再直走 4 步的位置。
 * `snakes` 可以只給要改的欄位（第 0 個是 0 號邊）；`turn` 沒給就等於 `dir`。
 */
export function makeState(overrides: C10Overrides = {}): C10State {
  const maxTicks = overrides.maxTicks ?? 3600;
  const { roundTicks, pauseTicks } = budget(maxTicks);
  const round = overrides.round ?? 0;
  const runner: Side = overrides.runner ?? (round === 0 ? 0 : 1);
  const chaser = other(runner);
  const spawn = fallbackSpawn();
  const base: [Snake, Snake] = [snakeAt(0, RIGHT, 0, 1), snakeAt(0, RIGHT, 0, 1)];
  base[runner] = snakeAt(cell(6, 12), RIGHT, 0, RUNNER_LENGTH);
  base[chaser] = snakeAt(cell(25, 12), LEFT, 0, CHASER_LENGTH);
  const pick = (i: 0 | 1): Snake => {
    const patch = overrides.snakes?.[i] ?? {};
    const merged = { ...base[i], ...patch };
    return { ...merged, turn: patch.turn ?? merged.dir };
  };
  const draft: C10State = {
    tick: overrides.tick ?? 0,
    maxTicks,
    snakes: [pick(0), pick(1)],
    foods: [],
    rng: rngStateFor(0, 'spawn'),
    over: overrides.over ?? false,
    winner: overrides.winner ?? null,
    round,
    runner,
    roundTicks,
    roundTick: overrides.roundTick ?? 0,
    pause: overrides.pause ?? 0,
    pauseTicks,
    spawn,
    aim: 0,
    runnerTicks: overrides.runnerTicks ?? [-1, -1],
    outcome: overrides.outcome ?? null,
  };
  return { ...draft, aim: overrides.aim ?? straightModel(draft, AIM_LEAD) };
}
