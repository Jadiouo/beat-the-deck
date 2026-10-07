import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  HEIGHT,
  MOVE_EVERY,
  WIDTH,
  cell,
  cellX,
  cellY,
  evaluateClubs,
  initClubsState,
  makeState as makeClubsState,
  orderedActions,
  steerSnake,
  stepClubs,
} from '../_clubs/logic';
import type { ClubsState, Dir, Snake, StateOverrides } from '../_clubs/logic';

/**
 * C-4 霧（SPEC 第 9 節；小規格 `docs/cards/C-4.md`）。
 * 規則與 C-A／C-2 相同（搶食物、撞牆撞身體的輸），多的是：兩條蛇都只看得到蛇頭附近 `FOG_RADIUS` 格。
 * state 裡仍是完整資訊（食物、兩條蛇）；霧是畫面層（`render`）與 AI（`evaluate`、`actions`）的自律：
 * AI 只讀自己的 `memory`（記得的食物、各格最後看見的時間、看到的對手），不讀 `state.foods`、對手的蛇、
 * 對手的分數與記憶、對手死了沒有。
 *
 * 防止搜尋型「往前模擬」時洩漏霧外的資訊（準則 4.2）靠三件事：
 * 1. 掃視（更新記憶）只在走格的那個 tick、用「走格之前」的蛇頭位置；
 * 2. `actions` 的順序只看自己的蛇，不看食物（模擬對手時取對手 `actions()` 的第一個）；
 * 3. 有人死了之後畫面停 `DEATH_FREEZE_TICKS` 個 tick 才結束，模擬裡對手撞牆不會讓遊戲提前結束。
 */

// ---------------------------------------------------------------------------
// 常數與型別
// ---------------------------------------------------------------------------

/** 看得到的範圍：離蛇頭的曼哈頓距離不超過這麼多格。 */
export const FOG_RADIUS = 4;
/** 一格超過這麼多個 tick 沒被看見，就算「很久沒看過」（探索的目標）。 */
export const STALE_TICKS = 600;
/** 有人死了之後，畫面停這麼多個 tick 才宣布結果。 */
export const DEATH_FREEZE_TICKS = 60;
/** 雷達每幾個 tick 亮一次、每次亮幾個 tick（只給人，畫面層）。 */
export const RADAR_CYCLE = 150;
export const RADAR_ON_TICKS = 40;
/** 雷達的三級距離：不超過這麼多格是「近」、「中」，其餘是「遠」。 */
export const RADAR_NEAR = 8;
export const RADAR_MID = 16;
/** 探索目標：在蛇頭背後的格子多算這麼多格。 */
export const BEHIND_PENALTY = 4;
/** 自己死了的 gain（有限，比任何正常局面都低）。 */
export const DEAD_GAIN = -1_000_000;

/** 一邊的記憶（state 裡的欄位，可序列化）。 */
export interface Memory {
  /** 記得的食物格子（可能其實已經被對手吃掉了）。 */
  readonly foods: readonly number[];
  /** 每一格最後被看見的 tick；從沒看過是 -1。長度 `CELLS`。 */
  readonly seen: readonly number[];
  /** 最近一次掃視看到的對手蛇身（含蛇頭，蛇頭在前）。 */
  readonly rival: readonly number[];
  /** 最近一次掃視看到的對手蛇頭；沒看到是 -1。 */
  readonly rivalHead: number;
  /** 對手蛇頭的行進方向。 */
  readonly rivalTurn: Dir;
}

export interface C4State extends ClubsState {
  /** 兩邊各自的記憶。 */
  readonly memory: readonly [Memory, Memory];
  /** 有人死了之後，畫面停到哪個 tick；沒有人死是 -1。 */
  readonly endAt: number;
  /** 停格結束時的贏家（只在 `endAt` ≥ 0 時有意義）。 */
  readonly pendingWinner: Side | null;
}

// ---------------------------------------------------------------------------
// 視野與記憶
// ---------------------------------------------------------------------------

/** `target` 在不在以 `head` 為中心的視野裡。 */
export function isVisible(head: number, target: number): boolean {
  return (
    Math.abs(cellX(head) - cellX(target)) + Math.abs(cellY(head) - cellY(target)) <= FOG_RADIUS
  );
}

/** 以 `head` 為中心、視野內的所有格子（在地圖內的）。 */
function visibleCells(head: number): number[] {
  const x = cellX(head);
  const y = cellY(head);
  const cells: number[] = [];
  for (let dy = -FOG_RADIUS; dy <= FOG_RADIUS; dy += 1) {
    const span = FOG_RADIUS - Math.abs(dy);
    for (let dx = -span; dx <= span; dx += 1) {
      const cx = x + dx;
      const cy = y + dy;
      if (cx >= 0 && cx < WIDTH && cy >= 0 && cy < HEIGHT) {
        cells.push(cell(cx, cy));
      }
    }
  }
  return cells;
}

function emptyMemory(): Memory {
  return {
    foods: [],
    seen: Array.from({ length: CELLS }, () => -1),
    rival: [],
    rivalHead: -1,
    rivalTurn: 0,
  };
}

/**
 * 掃視一次：用 `state` 裡「現在」的蛇頭位置看範圍內有什麼，更新 `side` 的記憶。
 * 範圍內的食物記下來；之前記著、現在在範圍內卻不是食物的忘掉；範圍內每一格的最後看見時間改成 `tick`；
 * 範圍內的對手蛇身與蛇頭記下來（看不到就清空）。
 */
function sweep(state: ClubsState, side: Side, tick: number, previous: Memory): Memory {
  const head = state.snakes[side].body[0] as number;
  const rival = state.snakes[side === 0 ? 1 : 0];
  const seen = previous.seen.slice();
  for (const c of visibleCells(head)) {
    seen[c] = tick;
  }
  const visibleFoods = state.foods.filter((food) => isVisible(head, food));
  const foods = [...previous.foods.filter((food) => !isVisible(head, food)), ...visibleFoods];
  const rivalCells = rival.body.filter((c) => isVisible(head, c));
  const rivalHead =
    rival.body.length > 0 && isVisible(head, rival.body[0] as number)
      ? (rival.body[0] as number)
      : -1;
  return { foods, seen, rival: rivalCells, rivalHead, rivalTurn: rival.dir };
}

/**
 * 探索目標：「很久沒看過」（從沒看過、或超過 `STALE_TICKS` 沒看過）的格子裡，離蛇頭最近的；
 * 在蛇頭背後的格子多算 `BEHIND_PENALTY` 格（讓它往前探索、不要一直回頭）；平手取編號小的。
 * 全部都看過就是地圖中心。
 */
export function explorationTarget(
  seen: readonly number[],
  head: number,
  dir: Dir,
  tick: number,
): number {
  const hx = cellX(head);
  const hy = cellY(head);
  const forwardX = dir === 1 ? 1 : dir === 3 ? -1 : 0;
  const forwardY = dir === 2 ? 1 : dir === 0 ? -1 : 0;
  const staleBefore = tick - STALE_TICKS;
  let best = cell(16, 12);
  let bestCost = Number.POSITIVE_INFINITY;
  // 從近到遠一圈一圈找（第 d 圈是曼哈頓距離 d 的格子）；第 d 圈的格子花費至少是 d，超過目前最好的就不用找了。
  for (let d = 0; d <= WIDTH + HEIGHT && d <= bestCost; d += 1) {
    for (let dy = -d; dy <= d; dy += 1) {
      const y = hy + dy;
      if (y < 0 || y >= HEIGHT) {
        continue;
      }
      const span = d - Math.abs(dy);
      for (let dx = -span; dx <= span; dx += span === 0 ? 1 : 2 * span) {
        const x = hx + dx;
        if (x < 0 || x >= WIDTH) {
          continue;
        }
        const c = y * WIDTH + x;
        const last = seen[c] as number;
        if (last >= 0 && last >= staleBefore) {
          continue;
        }
        const cost = d + (dx * forwardX + dy * forwardY < 0 ? BEHIND_PENALTY : 0);
        if (cost < bestCost || (cost === bestCost && c < best)) {
          bestCost = cost;
          best = c;
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 雷達（只給人，畫面層；`step`、`actions`、`evaluate` 都不碰）
// ---------------------------------------------------------------------------

export interface Radar {
  /** 這一刻雷達有沒有亮。 */
  readonly lit: boolean;
  /** 最近的食物的方位：0 北、1 東北、2 東、3 東南、4 南、5 西南、6 西、7 西北。 */
  readonly dir: number;
  /** 距離級別：0 近（≤ 8 格）、1 中（≤ 16 格）、2 遠。 */
  readonly band: number;
}

/** 人（0 號邊）的蛇頭離最近的食物的方位與距離級別；每 `RADAR_CYCLE` 個 tick 亮 `RADAR_ON_TICKS` 個 tick。 */
export function radarOf(state: ClubsState): Radar {
  const lit = state.tick % RADAR_CYCLE < RADAR_ON_TICKS;
  const head = state.snakes[0].body[0] as number;
  let nearest = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const food of state.foods) {
    const distance = Math.abs(cellX(food) - cellX(head)) + Math.abs(cellY(food) - cellY(head));
    if (distance < nearestDistance) {
      nearest = food;
      nearestDistance = distance;
    }
  }
  if (nearest === -1) {
    return { lit, dir: 0, band: 2 };
  }
  const dx = cellX(nearest) - cellX(head);
  const dy = cellY(nearest) - cellY(head);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  let dir: number;
  if (2 * ay <= ax) {
    dir = dx > 0 ? 2 : 6;
  } else if (2 * ax <= ay) {
    dir = dy < 0 ? 0 : 4;
  } else if (dx > 0) {
    dir = dy < 0 ? 1 : 3;
  } else {
    dir = dy > 0 ? 5 : 7;
  }
  const band = nearestDistance <= RADAR_NEAR ? 0 : nearestDistance <= RADAR_MID ? 1 : 2;
  return { lit, dir, band };
}

// ---------------------------------------------------------------------------
// 一個 tick
// ---------------------------------------------------------------------------

/**
 * 走一個 tick：先決定這個 tick 要不要掃視（走格的那一次，用走格之前的位置），再用 C-A 的規則走（`stepClubs`），
 * 然後把「自己吃到的食物」從記憶裡拿掉。有人死了：不立刻結束，停 `DEATH_FREEZE_TICKS` 個 tick 才宣布。
 */
export function stepC4(state: C4State, inputs: Inputs): C4State {
  if (state.over) {
    return state;
  }
  const tick = state.tick + 1;

  if (state.endAt >= 0) {
    // 停格：蛇不動、不吃、不掃視，但還活著的蛇照樣鎖定轉向（和停格之前的 tick 一樣，
    // 所以搜尋型在模擬裡看到的「對手撞牆之後」與「對手沒撞牆」，自己能做的事一模一樣）。
    if (tick >= state.endAt || tick >= state.maxTicks) {
      return { ...state, tick, over: true, winner: state.pendingWinner };
    }
    return {
      ...state,
      tick,
      snakes: [steerSnake(state.snakes[0], inputs[0]), steerSnake(state.snakes[1], inputs[1])],
    };
  }

  const sweeping = tick % MOVE_EVERY === 0;
  const swept: readonly [Memory, Memory] = sweeping
    ? [sweep(state, 0, tick, state.memory[0]), sweep(state, 1, tick, state.memory[1])]
    : state.memory;
  const next = stepClubs(state, inputs);

  let memory = swept;
  if (sweeping) {
    const forget = (side: Side): Memory => {
      const mine = swept[side];
      if (next.snakes[side].score <= state.snakes[side].score) {
        return mine;
      }
      const head = next.snakes[side].body[0] as number;
      return { ...mine, foods: mine.foods.filter((food) => food !== head) };
    };
    memory = [forget(0), forget(1)];
  }

  const someoneDied = !next.snakes[0].alive || !next.snakes[1].alive;
  if (next.over && someoneDied && tick < state.maxTicks) {
    return {
      ...next,
      memory,
      over: false,
      winner: null,
      endAt: tick + DEATH_FREEZE_TICKS,
      pendingWinner: next.winner,
    };
  }
  return { ...next, memory };
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
const IDLE_ONLY: readonly Buttons[] = Object.freeze([NONE]);

/**
 * 動作：已經鎖定轉向、自己死了、結束：只有「全放開」；否則三個（順時針轉向、逆時針轉向、全放開）。
 * 順序只看自己的蛇（順時針在前，除非那一邊會直接走出地圖），**不看食物**：搜尋型模擬對手時取對手
 * `actions()` 的第一個，順序若依食物排，就會把對手記得的食物洩漏出來。
 */
function actionsOf(state: C4State, side: Side): readonly Buttons[] {
  const me = state.snakes[side];
  if (state.over || !me.alive || me.turn !== me.dir) {
    return IDLE_ONLY;
  }
  const ordered = orderedActions({ ...state, foods: [] }, side);
  return [ordered[0] as Buttons, ordered[1] as Buttons, NONE];
}

/**
 * 評估：把「`side` 自己看得到的世界」組成一個梅花共用的局面交給 `evaluateClubs`。
 * 自己的蛇是真的；對手只有記憶裡看到的身體（頭有看到才算活著）、分數當 0；食物是記得的食物，
 * 沒有的時候用探索目標；`over`／`winner` 一律當沒結束。自己死了是 `DEAD_GAIN`、danger 1。
 */
function evaluateOf(state: C4State, side: Side): { gain: number; danger: number } {
  const me = state.snakes[side];
  if (!me.alive) {
    return { gain: DEAD_GAIN, danger: 1 };
  }
  const memory = state.memory[side];
  const head = me.body[0] as number;
  const foods =
    memory.foods.length > 0
      ? memory.foods
      : [explorationTarget(memory.seen, head, me.dir, state.tick)];
  const headSeen = memory.rivalHead >= 0;
  const rivalBody = headSeen
    ? [memory.rivalHead, ...memory.rival.filter((c) => c !== memory.rivalHead)]
    : memory.rival;
  const rival: Snake = {
    body: rivalBody,
    dir: memory.rivalTurn,
    turn: memory.rivalTurn,
    alive: headSeen,
    score: 0,
  };
  const world: ClubsState = {
    tick: state.tick,
    maxTicks: state.maxTicks,
    snakes: side === 0 ? [me, rival] : [rival, me],
    foods,
    rng: state.rng,
    over: false,
    winner: null,
  };
  return evaluateClubs(world, side);
}

export const c4Game: Game<C4State> = {
  id: 'C-4',

  init(seed: number, config: GameConfig): C4State {
    const base = initClubsState(seed, config);
    const blank = emptyMemory();
    return {
      ...base,
      memory: [sweep(base, 0, 0, blank), sweep(base, 1, 0, blank)],
      endAt: -1,
      pendingWinner: null,
    };
  },

  step(state: C4State, inputs: Inputs): C4State {
    return stepC4(state, inputs);
  },

  isOver(state: C4State): boolean {
    return state.over;
  },

  score(state: C4State): readonly [number, number] {
    return [state.snakes[0].score, state.snakes[1].score];
  },

  winner(state: C4State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: C4State, side: Side): readonly Buttons[] {
    return actionsOf(state, side);
  },

  evaluate(state: C4State, side: Side): { gain: number; danger: number } {
    return evaluateOf(state, side);
  },
};

// ---------------------------------------------------------------------------
// 測試輔助
// ---------------------------------------------------------------------------

export interface C4Overrides extends StateOverrides {
  /** 兩邊的記憶要覆蓋的欄位；沒給的欄位是「在這個局面掃視一次」的結果。 */
  readonly memory?: readonly [Partial<Memory>?, Partial<Memory>?];
  readonly endAt?: number;
  readonly pendingWinner?: Side | null;
}

/**
 * 直接構造一個局面。預設是 C-A 的起始局面（人 (5,12) 往右、AI (26,11) 往左、食物 (15,3) 與 (15,20)），
 * 記憶預設是「在這個局面（`tick`）掃視一次」的結果；`memory` 可以只給要改的欄位。
 */
export function makeState(overrides: C4Overrides = {}): C4State {
  const base = makeClubsState(overrides);
  const blank = emptyMemory();
  const patch = (side: Side): Memory => ({
    ...sweep(base, side, base.tick, blank),
    ...(overrides.memory?.[side] ?? {}),
  });
  return {
    ...base,
    memory: [patch(0), patch(1)],
    endAt: overrides.endAt ?? -1,
    pendingWinner: overrides.pendingWinner ?? null,
  };
}
