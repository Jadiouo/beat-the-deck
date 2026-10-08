import { createRng } from '../../core/rng';
import type { Buttons, Controller, Side } from '../../core/types';
import { bfsDistances, stepTarget } from '../_diamonds/logic';
import type { Dir } from '../_diamonds/logic';
import { CAP } from './logic';
import type { D4State } from './logic';

/**
 * D-4 的劇本玩家（DESIGN-AI-FUN 5.2、10.4）：證明「技術有報酬、運氣沒有」用的固定規則玩家。
 * 都是 Controller，只看 state（完整資訊），不用任何隱藏資訊；不是 `logic.ts`，不在純度掃描範圍。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

/** 往 `target` 走一步的方向（沒有更近的走法就全放開）。 */
function toward(state: D4State, from: number, target: number): Buttons {
  if (from === target) {
    return NONE;
  }
  const field = bfsDistances(state.walls, target);
  let best: Dir | null = null;
  let bestDistance = field[from] as number;
  for (const dir of [0, 1, 2, 3] as const) {
    const next = stepTarget(state.walls, from, dir);
    if (next !== from && (field[next] as number) < bestDistance) {
      bestDistance = field[next] as number;
      best = dir;
    }
  }
  return best === null ? NONE : press(best);
}

function nearest(state: D4State, from: number, cells: readonly number[]): number | null {
  const field = bfsDistances(state.walls, from);
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const c of cells) {
    if ((field[c] as number) < bestDistance) {
      bestDistance = field[c] as number;
      best = c;
    }
  }
  return best;
}

/** 對手占著的站（holder 是對手，或對手站在上面）：不能用。 */
function freeStations(state: D4State, side: Side): number[] {
  const other = side === 0 ? 1 : 0;
  return state.stations.filter(
    (s, i) => state.holder[i] !== other && state.players[other].cell !== s,
  );
}

/** 會算電量與充電站的玩家：撿得到、回得了（餘裕 3）才去；不然去最近的、沒被占的站充到快滿；避開對手搶得比我快的金幣。 */
export function calculator(): Controller<D4State> {
  return {
    decide(state: D4State, side: Side): Buttons {
      const me = state.players[side];
      const opp = state.players[side === 0 ? 1 : 0];
      const battery = state.battery[side] as number;
      const free = freeStations(state, side);
      const mine = bfsDistances(state.walls, me.cell);
      const theirs = bfsDistances(state.walls, opp.cell);
      let target: number | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const coin of state.coins) {
        const d = mine[coin] as number;
        if ((theirs[coin] as number) < d) {
          continue; // 對手比我近：不爭
        }
        let home = Number.POSITIVE_INFINITY;
        for (const s of free) {
          home = Math.min(home, bfsDistances(state.walls, s)[coin] as number);
        }
        if (battery >= d + home + 3 && d < bestDistance) {
          bestDistance = d;
          target = coin;
        }
      }
      const onStation = free.includes(me.cell) && state.stations.includes(me.cell);
      if (onStation && battery < CAP - 2) {
        return NONE; // 在站上：充到快滿
      }
      if (target !== null) {
        return toward(state, me.cell, target);
      }
      const station = nearest(state, me.cell, free);
      return station === null ? NONE : toward(state, me.cell, station);
    },
  };
}

/** 只往最近金幣走、不管電量的玩家。 */
export function chaser(): Controller<D4State> {
  return {
    decide(state: D4State, side: Side): Buttons {
      const me = state.players[side];
      const coin = nearest(state, me.cell, state.coins);
      return coin === null ? NONE : toward(state, me.cell, coin);
    },
  };
}

/** 均勻亂按：每個 tick 從五個動作（四方向與放開）均勻挑一個。 */
export function uniform(seed: number, side: Side): Controller<D4State> {
  const rng = createRng(seed).fork(`d4-uniform-${side}`);
  return {
    decide(): Buttons {
      const k = rng.int(5);
      return k === 4 ? NONE : press(k as Dir);
    },
  };
}

/** 只收金幣、電量到 6 才去最近的站（不看站被不被占）、站上充到滿。 */
export function threshold(level = 6): Controller<D4State> {
  return {
    decide(state: D4State, side: Side): Buttons {
      const me = state.players[side];
      const battery = state.battery[side] as number;
      const onStation = state.stations.includes(me.cell);
      if (onStation && battery < CAP) {
        return NONE;
      }
      if (battery <= level) {
        const station = nearest(state, me.cell, state.stations);
        return station === null ? NONE : toward(state, me.cell, station);
      }
      const coin = nearest(state, me.cell, state.coins);
      return coin === null ? NONE : toward(state, me.cell, coin);
    },
  };
}

/** 一開局走到最近的站就站著不動（占站不走）。 */
export function camper(): Controller<D4State> {
  return {
    decide(state: D4State, side: Side): Buttons {
      const me = state.players[side];
      const station = nearest(state, me.cell, state.stations);
      return station === null ? NONE : toward(state, me.cell, station);
    },
  };
}
