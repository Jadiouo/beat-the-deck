import { copyButtons, playMatch } from '../../core/match';
import type { MatchResult } from '../../core/match';
import type { Buttons, Controller, GameConfig, Side } from '../../core/types';
import { d2Game } from '../D-2/logic';
import { d3Game, gemValue } from '../D-3/logic';
import { d8Game } from '../D-8/logic';
import { dJGame } from '../D-J/logic';
import {
  actionsToward,
  bfsDistances,
  cellX,
  cellY,
  CELLS,
  MOVE_EVERY,
  START_CELLS,
  UNREACHABLE,
} from '../_diamonds/logic';
import { dKGame, stageOf } from './logic';
import type { DKState } from './logic';

/**
 * D-K 的劇本玩家與量測工具（DESIGN-AI-FUN 5.2、10.35、10.40）。不是 `logic.ts`，不在純度掃描範圍。
 *
 * 劇本玩家是固定規則的 Controller：沒有反應延遲，只看公開資訊（地盤、寶石、金幣、背包、位置、分數）。
 * 每一段各有幾種寫法，`script(s1, s2, s3)` 把三段接起來；過場一律全放開。
 * 第 1 段：`greedy`（D-8 的最近目標）、`wander`（亂走）、`home`（先鋪家附近 40 格再貪心）、`outward`（只塗離家 > 12 的格子）。
 * 第 2 段：`nearest`（最近的寶石）、`plain`（D-3 的吸引力，不看顏色）、`turf`（吸引力把地盤紅利算進價值）、
 *   `turfContest`（再加：對手比我近的寶石距離加 8）。
 * 第 3 段：`dj`（D-J 的目標：金幣、存、偷）、`coins`（D-2：只撿存、不偷）、`lurk`（站在對手基地旁邊等，不撿金幣）、
 *   `smart`（讀對手的狀態：對手在偷我就退回自己的顏色上；對手站在自己的顏色上就不去偷，改撿金幣；否則 `dj`）。
 */

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };
const NONE: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};

export type Stage1Mode = 'greedy' | 'wander' | 'home' | 'outward' | 'center';
export type Stage2Mode = 'nearest' | 'plain' | 'turf' | 'turfContest';
export type Stage3Mode = 'dj' | 'coins' | 'lurk' | 'smart';

export const HOME_RADIUS = 10;
export const HOME_CELLS = 40;
const OUTWARD_MIN = 12;

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

/** 這個人在家附近（曼哈頓距離 ≤ HOME_RADIUS）有幾格自己的顏色。 */
export function homeCells(state: DKState, side: Side): number {
  const base = START_CELLS[side];
  let n = 0;
  for (let c = 0; c < CELLS; c += 1) {
    if (state.paint[c] === side + 1 && manhattan(c, base) <= HOME_RADIUS) {
      n += 1;
    }
  }
  return n;
}

/** 從我現在的格子出發最近的、符合條件的「還不是我的顏色」的格子。 */
function nearestCell(
  state: DKState,
  side: Side,
  accept: (c: number) => boolean,
): number | null {
  const dist = bfsDistances(state.walls, state.players[side].cell);
  let best: number | null = null;
  let bestD = UNREACHABLE;
  for (let c = 0; c < CELLS; c += 1) {
    const d = dist[c] as number;
    if (d < bestD && d > 0 && state.paint[c] !== side + 1 && accept(c)) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function toward(state: DKState, side: Side, target: number | null): Buttons {
  const actions = actionsToward(state.walls, state.players[side], side, target);
  return actions[0] as Buttons;
}

/** 亂走：每 8 格換一次方向（用 tick 和位置做的雜湊，不用亂數）。 */
function wander(state: DKState, side: Side): Buttons {
  const me = state.players[side];
  const phase = Math.floor(state.tick / (MOVE_EVERY * 8));
  const h = (((phase * 2654435761) ^ (me.cell * 40503) ^ (side * 977)) >>> 0) % 4;
  const dirs: Buttons[] = [
    { ...NONE, up: true },
    { ...NONE, right: true },
    { ...NONE, down: true },
    { ...NONE, left: true },
  ];
  return dirs[h] as Buttons;
}

function stage1(mode: Stage1Mode, state: DKState, side: Side): Buttons {
  const base = START_CELLS[side];
  if (mode === 'wander') {
    return wander(state, side);
  }
  if (mode === 'greedy') {
    return d8Game.actions(state as never, side)[0] as Buttons;
  }
  if (mode === 'home') {
    if (homeCells(state, side) < HOME_CELLS) {
      const target = nearestCell(state, side, (c) => manhattan(c, base) <= HOME_RADIUS);
      if (target !== null) {
        return toward(state, side, target);
      }
    }
    return d8Game.actions(state as never, side)[0] as Buttons;
  }
  if (mode === 'outward') {
    const target = nearestCell(state, side, (c) => manhattan(c, base) > OUTWARD_MIN);
    return toward(state, side, target);
  }
  // center
  const center = 12 * 32 + 16;
  const target = nearestCell(state, side, (c) => manhattan(c, center) <= 8);
  return toward(state, side, target);
}

function stage2(mode: Stage2Mode, state: DKState, side: Side): Buttons {
  if (mode === 'plain') {
    return d3Game.actions(state as never, side)[0] as Buttons;
  }
  const me = state.players[side];
  const dist = bfsDistances(state.walls, me.cell);
  const oppDist = bfsDistances(state.walls, state.players[side === 0 ? 1 : 0].cell);
  let best: number | null = null;
  let bestScore = -1;
  for (const gem of state.gems) {
    const d = dist[gem.cell] as number;
    if (d >= UNREACHABLE) {
      continue;
    }
    if (mode === 'nearest') {
      const score = 1000 - d;
      if (score > bestScore) {
        bestScore = score;
        best = gem.cell;
      }
      continue;
    }
    const arrival = state.tick + MOVE_EVERY * d;
    const v = gemValue(arrival - 1, gem.born);
    const bonus = state.paint[gem.cell] === side + 1 ? Math.ceil(v / 2) : 0;
    const theirs = oppDist[gem.cell] as number;
    const effective = mode === 'turfContest' && theirs < d ? d + 8 : d;
    const score = (100 * (v + bonus)) / (effective + 2);
    if (score > bestScore) {
      bestScore = score;
      best = gem.cell;
    }
  }
  return toward(state, side, best);
}

function stage3(mode: Stage3Mode, state: DKState, side: Side): Buttons {
  if (mode === 'dj') {
    return dJGame.actions(state as never, side)[0] as Buttons;
  }
  if (mode === 'coins') {
    return d2Game.actions(state as never, side)[0] as Buttons;
  }
  const other: Side = side === 0 ? 1 : 0;
  if (mode === 'smart') {
    const me = state.players[side];
    const mine = side + 1;
    const theyAtMyBase = manhattan(state.players[other].cell, START_CELLS[side]) <= 1;
    if (theyAtMyBase && state.paint[me.cell] === mine) {
      return NONE; // 對手貼著我的基地：我站在自己的顏色上，它偷不了，不要走開
    }
    if (theyAtMyBase) {
      // 對手貼著我的基地：退到最近的自己的顏色上
      const dist = bfsDistances(state.walls, me.cell);
      let best: number | null = null;
      let bestD = UNREACHABLE;
      for (let c = 0; c < CELLS; c += 1) {
        const d = dist[c] as number;
        if (state.paint[c] === mine && d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best !== null) {
        return toward(state, side, best);
      }
    }
    if (state.paint[state.players[other].cell] === other + 1) {
      return d2Game.actions(state as never, side)[0] as Buttons;
    }
    return dJGame.actions(state as never, side)[0] as Buttons;
  }
  return toward(state, side, START_CELLS[other]);
}

export interface ScriptSpec {
  readonly s1: Stage1Mode;
  readonly s2: Stage2Mode;
  readonly s3: Stage3Mode;
}

/** 三段接起來的劇本玩家。 */
export function script(spec: ScriptSpec): Controller<DKState> {
  return {
    decide(state: DKState, side: Side): Buttons {
      const stage = stageOf(state.tick);
      if (stage === 1) {
        return stage1(spec.s1, state, side);
      }
      if (stage === 2) {
        return stage2(spec.s2, state, side);
      }
      if (stage === 3) {
        return stage3(spec.s3, state, side);
      }
      return NONE;
    },
  };
}

export interface Trace {
  readonly result: MatchResult;
  /** 各段結束時的分數（第 1 段結束 tick 1080、第 2 段結束 tick 2520、結束 3600）。 */
  readonly s1: readonly [number, number];
  readonly s2: readonly [number, number];
  readonly final: DKState;
}

/** 跑一場並記下三個段落結束時的分數與最終 state。 */
export function playTraced(
  seed: number,
  c0: Controller<DKState>,
  c1: Controller<DKState>,
  game: typeof dKGame = dKGame,
): Trace {
  let state = game.init(seed, CONFIG);
  let s1: [number, number] = [0, 0];
  let s2: [number, number] = [0, 0];
  const inputs: [Buttons, Buttons][] = [];
  while (!game.isOver(state)) {
    const tick = state.tick;
    const pair: [Buttons, Buttons] = [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ];
    inputs.push(pair);
    state = game.step(state, pair);
    if (state.tick === 1080) {
      s1 = [state.players[0].score, state.players[1].score];
    }
    if (state.tick === 2520) {
      s2 = [state.players[0].score, state.players[1].score];
    }
  }
  const result: MatchResult = {
    winner: game.winner(state),
    score: game.score(state),
    ticks: inputs.length,
    finalHash: '',
    inputs,
  };
  return { result, s1, s2, final: state };
}

export { playMatch };
