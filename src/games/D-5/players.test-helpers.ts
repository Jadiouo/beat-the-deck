import { createRng } from '../../core/rng';
import type { Buttons, Controller, Side } from '../../core/types';
import { bfsDistances, MOVE_EVERY, stepTarget } from '../_diamonds/logic';
import type { Dir } from '../_diamonds/logic';
import { COOL, worthOf } from './logic';
import type { D5State } from './logic';

/**
 * D-5 的劇本玩家（DESIGN-AI-FUN 5.2、10.4）：證明「技術有報酬、運氣沒有」用的固定規則玩家。
 * 都是 Controller，只看 state（完整資訊），不用任何隱藏資訊；不是 `logic.ts`，不在純度掃描範圍。
 * 沒有用 AI 的 `evaluate`：規則寫在這裡，人腦做得到。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

/** 往 `target` 走一步的方向（沒有更近的走法就全放開）。 */
function toward(state: D5State, from: number, target: number): Buttons {
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

const other = (side: Side): Side => (side === 0 ? 1 : 0);

/** 背著貨：往同色倉庫走（休息中也照走：不能丟貨，沒有別的選擇）。 */
function deliver(state: D5State, side: Side): Buttons | null {
  const held = state.carry[side];
  if (held === null) {
    return null;
  }
  return toward(state, state.players[side].cell, state.depots[held.colour] as number);
}

interface Option {
  readonly parcel: number;
  readonly colour: number;
  readonly worth: number;
  /** 我走去撿再送到倉庫要幾步。 */
  readonly steps: number;
  /** 到的時候倉庫還在休息、或被對手先送了而要白等的步數。 */
  readonly wait: number;
  /** 對手比我先到這件包裹（它空手的話）。 */
  readonly rivalFirst: boolean;
  /** 我會比背著同色貨的對手先送進倉庫（它會被我堵住）。 */
  readonly blocksRival: boolean;
}

/** 每件包裹的算計：路程、白等、對手搶不搶得到、堵不堵得到對手。 */
function options(state: D5State, side: Side): Option[] {
  const me = state.players[side];
  const opp = state.players[other(side)];
  const mine = bfsDistances(state.walls, me.cell);
  const theirs = bfsDistances(state.walls, opp.cell);
  const rivalCarry = state.carry[other(side)];
  return state.parcels.map((p) => {
    const depot = state.depots[p.colour] as number;
    const toParcel = mine[p.cell] as number;
    const steps = toParcel + (bfsDistances(state.walls, depot)[p.cell] as number);
    const rest = Math.ceil((state.cool[p.colour] as number) / MOVE_EVERY);
    let ready = rest;
    let blocksRival = false;
    if (rivalCarry !== null && rivalCarry.colour === p.colour) {
      const rivalDeliver = Math.max(theirs[depot] as number, rest);
      if (rivalDeliver < steps) {
        ready = Math.max(ready, rivalDeliver + COOL / MOVE_EVERY);
      } else if (rivalDeliver > steps) {
        blocksRival = true;
      }
    }
    return {
      parcel: p.cell,
      colour: p.colour,
      worth: worthOf(state.walls, depot, p.cell),
      steps,
      wait: Math.max(0, ready - steps),
      rivalFirst: state.carry[other(side)] === null && (theirs[p.cell] as number) < toParcel,
      blocksRival,
    };
  });
}

function best(list: readonly Option[], score: (o: Option) => number): Option | null {
  let pick: Option | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const o of list) {
    const value = score(o);
    if (value > bestScore) {
      bestScore = value;
      pick = o;
    }
  }
  return pick;
}

/** 只撿離自己最近的包裹，不看顏色、不看倉庫有沒有在休息。 */
export function nearest(): Controller<D5State> {
  return {
    decide(state: D5State, side: Side): Buttons {
      const carrying = deliver(state, side);
      if (carrying !== null) {
        return carrying;
      }
      const me = state.players[side];
      const field = bfsDistances(state.walls, me.cell);
      let target: number | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const p of state.parcels) {
        if ((field[p.cell] as number) < bestDistance) {
          bestDistance = field[p.cell] as number;
          target = p.cell;
        }
      }
      return target === null ? NONE : toward(state, me.cell, target);
    },
  };
}

/** 永遠挑最值錢的包裹（不管多遠、不管顏色）。 */
export function greedyWorth(): Controller<D5State> {
  return {
    decide(state: D5State, side: Side): Buttons {
      const carrying = deliver(state, side);
      if (carrying !== null) {
        return carrying;
      }
      const pick = best(options(state, side), (o) => o.worth * 1000 - o.steps);
      return pick === null ? NONE : toward(state, state.players[side].cell, pick.parcel);
    },
  };
}

/**
 * 看顏色的玩家：挑「每走一步（含白等）得分最多」的包裹，也就是 `價值 / (路程 + 白等 + 2)`；
 * 對手背著同色貨而且比我先到倉庫，那一色的白等會算進去，所以自然改撿別的顏色；對手比我先到的空手包裹降權。
 * 這就是「讀它身上的顏色，避開它的倉庫」。
 */
export function reader(): Controller<D5State> {
  return {
    decide(state: D5State, side: Side): Buttons {
      const carrying = deliver(state, side);
      if (carrying !== null) {
        return carrying;
      }
      const pick = best(
        options(state, side),
        (o) => (o.worth / (o.steps + o.wait + 2)) * (o.rivalFirst ? 0.6 : 1),
      );
      return pick === null ? NONE : toward(state, state.players[side].cell, pick.parcel);
    },
  };
}

/**
 * 看顏色，而且會設陷阱：對手背著某色的貨、我撿得到同色的包裹並且比它先送進倉庫，
 * 就撿那一件（便宜的也好）——倉庫在它到達之前休息，它要白等。其餘時候同 `reader`。
 */
export function trapper(): Controller<D5State> {
  return {
    decide(state: D5State, side: Side): Buttons {
      const carrying = deliver(state, side);
      if (carrying !== null) {
        return carrying;
      }
      const list = options(state, side);
      const trap = best(
        list.filter((o) => o.blocksRival && o.wait === 0),
        (o) => -o.steps,
      );
      const pick =
        trap ?? best(list, (o) => (o.worth / (o.steps + o.wait + 2)) * (o.rivalFirst ? 0.6 : 1));
      return pick === null ? NONE : toward(state, state.players[side].cell, pick.parcel);
    },
  };
}

/** 均勻亂按：每個 tick 從五個動作（四方向與放開）均勻挑一個。 */
export function uniform(seed: number, side: Side): Controller<D5State> {
  const rng = createRng(seed).fork(`d5-uniform-${side}`);
  return {
    decide(): Buttons {
      const k = rng.int(5);
      return k === 4 ? NONE : press(k as Dir);
    },
  };
}
