import type { Buttons, Controller, Side } from '../../core/types';
import { bfsDistances, cell, MOVE_EVERY, stepTarget } from '../_diamonds/logic';
import type { Dir } from '../_diamonds/logic';
import { bagWeight, CAP, catchTable, SHIP_TICKS } from './logic';
import type { CatchRow, D10State } from './logic';

/**
 * D-10 的劇本玩家（DESIGN-AI-FUN 5.2、10.4、10.35）：固定規則的 Controller，只看 state（完整資訊）。
 * 都不是 `logic.ts`，不在純度掃描範圍；沒有用 AI 的 `evaluate`，規則寫在這裡，人腦做得到。
 * 攔截時刻（誰最早站得到貨所在的格子）用 `catchTable`：那是幾何，不是策略。
 *
 * 所有玩家共用同一套「走路」與「出貨」，差別只在「攔哪一件」：
 * - 探針 A 的三組：`probe('unaware')`（不知道有對手）、`probe('aware')`（知道有對手、不讀它的狀態）、
 *   `probe('reads')`（讀它的位置與背包）。
 * - 小規格要驗的四個劇本：`center`、`dense`、`upcomingChaser`、`watchBag`。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const SHIP: Buttons = { ...NONE, b: true };

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

/** 往 `target` 走一步的方向（沒有更近的走法就全放開）。 */
function toward(state: D10State, from: number, target: number): Buttons {
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

/** 背包超過這個重量就出貨。 */
export const SHIP_WEIGHT = 6;
/** 知道有人在搶、但不看它的狀態時，遠的貨一律打折：每遠 1 tick 少 1/`HAZARD`，最低留一成。 */
export const HAZARD = 300;
/** 對手放得下的貨，只攔自己這麼近（tick）就站得到的。 */
export const NEAR_TICKS = 75;

/**
 * 共用的出貨規則：背包重 ≥ 6，或剩下的時間剛好夠出一次貨。
 * `reads` 多一條：背包至少 3 重，而且接下來 1 秒內沒有一件「我確定先到」的貨（出貨不會損失什麼）就出貨——
 * 這要讀對手的位置與背包才知道。
 */
function shipRule(state: D10State, side: Side, reads: boolean, rows: Rows): boolean {
  const bag = state.bag[side];
  if (bag.length === 0) {
    return false;
  }
  const left = state.maxTicks - state.tick;
  if (left < SHIP_TICKS + 2) {
    return false;
  }
  if (bagWeight(bag) >= SHIP_WEIGHT || left <= SHIP_TICKS + 15) {
    return true;
  }
  return (
    reads &&
    bagWeight(bag) >= 3 &&
    !rows.some((r) => r.mineTau <= SHIP_TICKS && r.mineTau < r.theirsTau)
  );
}

type Rows = readonly CatchRow[];

/** 一件貨的分數：價值 ÷（還要幾步才攔得到 + 2）。 */
function worth(row: CatchRow): number {
  return row.v / (row.mineTau / MOVE_EVERY + 2);
}

function bestRow(
  rows: Rows,
  ok: (row: CatchRow) => boolean,
  score: (row: CatchRow) => number = worth,
): CatchRow | null {
  let best: CatchRow | null = null;
  for (const row of rows) {
    if (row.mineTau === Number.POSITIVE_INFINITY || !ok(row)) {
      continue;
    }
    if (best === null || score(row) > score(best)) {
      best = row;
    }
  }
  return best;
}

/** 走到最近的一格帶子上（沒有貨可攔時待命）。 */
function nearestRingCell(state: D10State, from: number): number {
  const field = bfsDistances(state.walls, from);
  let best = state.ring[0] as number;
  for (const c of state.ring) {
    if ((field[c] as number) < (field[best] as number)) {
      best = c;
    }
  }
  return best;
}

type Chooser = (state: D10State, side: Side, rows: Rows) => number | null;

/** 組一個劇本玩家：出貨規則 + 「挑一個要站的格子」+ 走過去。 */
function player(choose: Chooser, reads = false): Controller<D10State> {
  return {
    decide(state: D10State, side: Side): Buttons {
      if ((state.ship[side] as number) > 0) {
        return NONE;
      }
      const rows = catchTable(state, side);
      if (shipRule(state, side, reads, rows)) {
        return SHIP;
      }
      const me = state.players[side].cell;
      const target = choose(state, side, rows);
      return toward(state, me, target ?? nearestRingCell(state, me));
    },
  };
}

const opponentFits = (state: D10State, side: Side, w: number): boolean => {
  const opp = other(side);
  return (state.ship[opp] as number) === 0 && bagWeight(state.bag[opp]) + w <= CAP;
};

/**
 * 探針 A 的三組玩家（DESIGN-AI-FUN 10.35）：規劃的方式完全一樣（挑「價值 ÷ 時間」最高的貨去攔），
 * 只差「規劃時有沒有把對手放進去」。
 * - `unaware`（a）：不知道有對手，什麼貨都去攔。
 * - `aware`（b）：知道有人會搶，但不看它在哪、背什麼：越遠的貨越可能被搶，所以遠的貨一律打折（`HAZARD`）。
 * - `reads`（c）：讀對手的位置、背包、出貨倒數：只攔自己確定先到的（對手放不下、站不到、或比我晚）。
 */
export type ProbeKind =
  'unaware' | 'aware' | 'reads' | 'readsShip' | 'readsTie' | 'readsBoth' | 'readsLead' | 'readsBag';
export function probe(kind: ProbeKind): Controller<D10State> {
  return player(
    (state, side, rows) => {
      let row: CatchRow | null;
      if (kind === 'unaware' || kind === 'readsShip') {
        row = bestRow(rows, () => true);
      } else if (kind === 'readsTie' || kind === 'readsBoth') {
        row = bestRow(rows, (r) => r.mineTau !== r.theirsTau);
      } else if (kind === 'readsBag') {
        row = bestRow(
          rows,
          () => true,
          (r) => worth(r) * (opponentFits(state, side, r.w) ? 1 : 0.5),
        );
      } else if (kind === 'readsLead') {
        row = bestRow(rows, (r) => !(r.theirsTau + 10 < r.mineTau));
      } else if (kind === 'aware') {
        row = bestRow(
          rows,
          () => true,
          (r) => worth(r) * Math.max(0.1, 1 - r.mineTau / HAZARD),
        );
      } else {
        // 讀對手：它最想攔的是哪一件（它自己的 worth 最高的），那一件如果它比我先到或同時到，我就讓。
        const theirs = catchTable(state, other(side));
        let aim = -1;
        let aimWorth = Number.NEGATIVE_INFINITY;
        theirs.forEach((r, i) => {
          if (r.mineTau !== Number.POSITIVE_INFINITY && worth(r) > aimWorth) {
            aim = i;
            aimWorth = worth(r);
          }
        });
        row = bestRow(rows, (r) => rows.indexOf(r) !== aim || r.mineTau < r.theirsTau);
      }
      return row === null ? null : row.mineAt;
    },
    kind === 'reads' || kind === 'readsShip' || kind === 'readsBoth',
  );
}

/** 站在圈中央待命，只有攔得到（站得到）才出去，攔完回中央。 */
export function center(): Controller<D10State> {
  const middle = cell(16, 12);
  return player((_state, _side, rows) => {
    const row = bestRow(rows, (r) => r.mineTau <= 4 * MOVE_EVERY * 4);
    return row === null ? middle : row.mineAt;
  });
}

/** 只攔價值密度 v / w ≥ 2 的貨，不看對手。 */
export function dense(): Controller<D10State> {
  return player((_state, _side, rows) => {
    const row = bestRow(rows, (r) => r.v / r.w >= 2);
    return row === null ? null : row.mineAt;
  });
}

/** 追預告的下一件：有預告就去它出現的那一格等著（貨一出現就拿），沒有預告時照 `unaware`。 */
export function upcomingChaser(): Controller<D10State> {
  return player((state, _side, rows) => {
    const up = rows.find((r) => r.kind === 'upcoming');
    if (up !== undefined && up.mineTau !== Number.POSITIVE_INFINITY) {
      return up.mineAt;
    }
    const row = bestRow(rows, () => true);
    return row === null ? null : row.mineAt;
  });
}

/** 盯對手的背包：對手放得下的貨，只攔自己 `NEAR_TICKS` 以內站得到的；對手放不下（滿了、出貨中）的貨，直接去拿。 */
export function watchBag(): Controller<D10State> {
  return player((state, side, rows) => {
    const row = bestRow(rows, (r) => !opponentFits(state, side, r.w) || r.mineTau <= NEAR_TICKS);
    return row === null ? null : row.mineAt;
  });
}
