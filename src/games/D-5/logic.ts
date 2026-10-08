import { intFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import {
  CELLS,
  GAIN_PER_POINT,
  MOVE_EVERY,
  START_CELLS,
  UNREACHABLE,
  WIN_BONUS,
  actionsToward,
  bfsDistances,
  cell,
  clamp01,
  distanceFields,
  generateWalls,
  makeBase,
  moveWalker,
  pickEmptyCells,
  steerWalker,
  winnerByScore,
} from '../_diamonds/logic';
import type { BaseOverrides, DiamondsBase, Walker } from '../_diamonds/logic';

/**
 * D-5 送貨（SPEC 第 9 節一行方向；小規格 `docs/cards/D-5.md`）。
 * 場上有三種顏色的包裹與三個同色的倉庫，一次只能背一件，送到同色倉庫得分（越遠越值錢）；
 * 倉庫收一件貨要休息 `COOL` tick，休息中誰都送不進去。所以「它背著什麼顏色」是公開的情報：
 * 你背紅貨衝向紅倉庫、它剛好先到，你就得乾等。地圖、牆、走格、補東西、距離都沿用 `_diamonds/logic.ts`。
 *
 * 這是一張「誠實的技術牌」：格子世界裡每個動作都有機會成本，沒有免費的信號軸，
 * 所以不宣稱玩家騙得了 AI（DESIGN-AI-FUN 10.7、10.8）。賣點是互相牽制（倉庫的休息是共用資源）與技術有報酬。
 */

/** 場上隨時有幾件包裹。 */
export const PARCEL_COUNT = 5;
/** 倉庫數，也是包裹的顏色數（0 紅、1 綠、2 藍）。 */
export const DEPOT_COUNT = 3;
/** 倉庫收一件貨之後休息幾個 tick（150 tick = 2.5 秒，30 次走格）。 */
export const COOL = 150;
/** 每離倉庫 `WORTH_STEP` 步，包裹多值 1 分。 */
export const WORTH_STEP = 8;
/** 任兩個倉庫之間至少幾步（繞牆）。 */
export const DEPOT_GAP = 8;
/** 兩個起點到倉庫的步數差最多幾步。 */
export const DEPOT_BALANCE = 2;

/**
 * AI 用的常數（起始值，量過之後的結果寫在 `docs/cards/D-5.md`）。
 * gain 的單位：走一步 = 1；得一分 = `GAIN_PER_POINT` = 100。
 */
/** 背著一件價值 w 的貨，gain 加 `CARRY_WEIGHT × w`（撿起來的那一步會得到它）。 */
export const CARRY_WEIGHT = 40;
/** 空手時，一件價值 w 的包裹在「目標」裡值 `VALUE_STEPS × w` 步（必須小於 `CARRY_WEIGHT`，撿起來才是淨賺）。 */
export const VALUE_STEPS = 12;
/** 到倉庫要等的每一步（5 tick）扣多少 gain。 */
export const WAIT_PENALTY = 1;
/** 對手比我更靠近某件包裹時，我對那一件的成本要加上這麼多（同 D-A）。 */
export const CONTEST_PENALTY = 8;
/** 搶包裹的加罰在雙方距離差 ±這麼多步之內平滑過渡。 */
export const CONTEST_RAMP = 4;

export interface Parcel {
  readonly cell: number;
  /** 0 紅、1 綠、2 藍。 */
  readonly colour: number;
}

export interface Carry {
  readonly colour: number;
  /** 撿起來那一刻的價值，之後不變。 */
  readonly worth: number;
}

export interface D5State extends DiamondsBase {
  /** 場上的包裹（`PARCEL_COUNT` 件）。 */
  readonly parcels: readonly Parcel[];
  /** 三個倉庫的格子編號（紅、綠、藍），開局決定，整場不變。 */
  readonly depots: readonly number[];
  /** 三個倉庫的休息倒數（tick）；0 是可以收貨。 */
  readonly cool: readonly number[];
  /** 兩邊背著的貨（空手是 null）。 */
  readonly carry: readonly [Carry | null, Carry | null];
  /** 累計送了幾件（指紋量測用，AI 不看）。 */
  readonly delivered: readonly [number, number];
  /** 累計「背著貨站在休息中的同色倉庫上」的 tick 數（指紋量測用，AI 不看）。 */
  readonly waited: readonly [number, number];
}

export interface StateOverrides extends BaseOverrides {
  readonly parcels?: readonly Parcel[];
  readonly depots?: readonly number[];
  readonly cool?: readonly number[];
  readonly carry?: readonly [Carry | null, Carry | null];
  readonly delivered?: readonly [number, number];
  readonly waited?: readonly [number, number];
}

/** 測試用的預設包裹：同 D-A 的金幣位置的近似，顏色 紅、綠、藍、紅、綠。 */
const DEFAULT_PARCELS: readonly Parcel[] = [
  { cell: cell(12, 4), colour: 0 },
  { cell: cell(20, 4), colour: 1 },
  { cell: cell(12, 19), colour: 2 },
  { cell: cell(20, 19), colour: 0 },
  { cell: cell(16, 12), colour: 1 },
];

/** 測試用的預設倉庫：紅 (8,6)、綠 (23,17)、藍 (23,6)。 */
const DEFAULT_DEPOTS: readonly number[] = [cell(8, 6), cell(23, 17), cell(23, 6)];

/** 測試輔助：預設局面（沒有牆、固定的包裹與倉庫、兩邊空手、倉庫都沒在休息）加上 overrides。 */
export function makeState(overrides: StateOverrides = {}): D5State {
  return {
    ...makeBase(overrides),
    parcels: overrides.parcels ?? DEFAULT_PARCELS,
    depots: overrides.depots ?? DEFAULT_DEPOTS,
    cool: overrides.cool ?? [0, 0, 0],
    carry: overrides.carry ?? [null, null],
    delivered: overrides.delivered ?? [0, 0],
    waited: overrides.waited ?? [0, 0],
  };
}

// ---------------------------------------------------------------------------
// 價值
// ---------------------------------------------------------------------------

/** 一件包裹送到它的倉庫值幾分：`1 + ⌊倉庫到包裹的繞牆步數 / 8⌋`。 */
export function worthOf(walls: readonly number[], depot: number, parcelCell: number): number {
  const steps = Math.min(bfsDistances(walls, depot)[parcelCell] as number, UNREACHABLE);
  return 1 + Math.floor(steps / WORTH_STEP);
}

// ---------------------------------------------------------------------------
// 倉庫與包裹的產生
// ---------------------------------------------------------------------------

/**
 * 挑三個倉庫：從「到人起點與到 AI 起點的步數差 ≤ `DEPOT_BALANCE`」的格子裡，逐個均勻挑，
 * 而且和已經挑的每一個至少 `DEPOT_GAP` 步；這樣的格子不夠就放寬到任何非牆、非起點的格子。
 */
function pickDepots(walls: readonly number[], rng: RngState): { depots: number[]; rng: RngState } {
  const fromHuman = bfsDistances(walls, START_CELLS[0]);
  const fromAi = bfsDistances(walls, START_CELLS[1]);
  const open: number[] = [];
  const balanced: number[] = [];
  for (let c = 0; c < CELLS; c += 1) {
    if (walls[c] === 0 && c !== START_CELLS[0] && c !== START_CELLS[1]) {
      open.push(c);
      if (Math.abs((fromHuman[c] as number) - (fromAi[c] as number)) <= DEPOT_BALANCE) {
        balanced.push(c);
      }
    }
  }
  const chosen: number[] = [];
  let state = rng;
  for (let i = 0; i < DEPOT_COUNT; i += 1) {
    const apart = (c: number): boolean =>
      !chosen.includes(c) &&
      chosen.every((d) => (bfsDistances(walls, d)[c] as number) >= DEPOT_GAP);
    let pool = balanced.filter(apart);
    if (pool.length === 0) {
      pool = open.filter((c) => !chosen.includes(c));
    }
    let k: number;
    [k, state] = intFrom(state, pool.length);
    chosen.push(pool[k] as number);
  }
  return { depots: chosen, rng: state };
}

/** 場上最少的那種顏色；平手用 rng 挑。 */
function leastColour(parcels: readonly Parcel[], rng: RngState): { colour: number; rng: RngState } {
  const counts = new Array<number>(DEPOT_COUNT).fill(0);
  for (const p of parcels) {
    counts[p.colour] = (counts[p.colour] as number) + 1;
  }
  const fewest = Math.min(...counts);
  const ties: number[] = [];
  counts.forEach((n, colour) => {
    if (n === fewest) {
      ties.push(colour);
    }
  });
  if (ties.length === 1) {
    return { colour: ties[0] as number, rng };
  }
  const [k, next] = intFrom(rng, ties.length);
  return { colour: ties[k] as number, rng: next };
}

/** 補包裹到 `PARCEL_COUNT` 件：顏色挑最少的，位置從空格均勻挑（不是牆、倉庫、別的包裹、角色所在）。 */
function refillParcels(
  rng: RngState,
  walls: readonly number[],
  depots: readonly number[],
  parcels: readonly Parcel[],
  occupied: readonly number[],
): { parcels: Parcel[]; rng: RngState } {
  const out = [...parcels];
  let state = rng;
  while (out.length < PARCEL_COUNT) {
    const coloured = leastColour(out, state);
    state = coloured.rng;
    const placed = pickEmptyCells(
      state,
      walls,
      [...depots, ...out.map((p) => p.cell), ...occupied],
      1,
    );
    state = placed.rng;
    if (placed.cells.length === 0) {
      break;
    }
    out.push({ cell: placed.cells[0] as number, colour: coloured.colour });
  }
  return { parcels: out, rng: state };
}

// ---------------------------------------------------------------------------
// 給 AI 的看法
// ---------------------------------------------------------------------------

/** 一個「去哪裡、值多少」的目標。 */
interface Plan {
  /** 要走去的格子：背著貨是倉庫、空手是包裹。 */
  readonly target: number;
  /** 這個目標的 gain 貢獻（越大越好）。 */
  readonly value: number;
  /** 從現在的位置到把貨送進倉庫還要走幾步（空手包含去撿的路）。 */
  readonly steps: number;
  /** 這個目標的倉庫顏色。 */
  readonly colour: number;
}

/** 距離場裡的數字：到不了當作很遠。 */
function steps(field: Int32Array, target: number): number {
  return Math.min(field[target] as number, 200);
}

/** 走格結算前還有幾個 tick（1 到 5）。 */
function settleIn(tick: number): number {
  return MOVE_EVERY - (tick % MOVE_EVERY);
}

interface View {
  readonly state: D5State;
  readonly side: Side;
  /** 我下一次走格之後的格子，與它的距離場。 */
  readonly myNext: number;
  readonly mine: Int32Array;
  readonly oppNext: number;
  readonly theirs: Int32Array;
  /** 離下一次走格結算還有幾個 tick。 */
  readonly settle: number;
  /** 遊戲剩下的 tick。 */
  readonly left: number;
}

/**
 * 倉庫 `colour` 「現在看起來」還要休息幾步才能收貨（只看這一刻的倒數，不算對手要送、也不算我走過去的時間）。
 * 貪心型的 gain 只用這個：休息中的顏色先不撿，倒數快結束的不當一回事。
 */
function restSteps(view: View, colour: number): number {
  const remaining = Math.max(0, (view.state.cool[colour] as number) - view.settle);
  return Math.ceil(remaining / MOVE_EVERY);
}

/**
 * 我走 `mySteps` 步（從 `view.myNext` 算）到倉庫 `colour` 的時候，要白等幾步：算進對手背著同色貨、
 * 而且比我先到的情況（它送了，倉庫就休息 `coolTicks`）。我先到或同時到沒有問題（它去等）。
 */
function waitSteps(view: View, colour: number, mySteps: number, coolTicks: number): number {
  const rest = restSteps(view, colour);
  const theirCarry = view.state.carry[view.side === 0 ? 1 : 0];
  let ready = rest;
  if (theirCarry !== null && theirCarry.colour === colour) {
    const depot = view.state.depots[colour] as number;
    const theirDeliver = Math.max(steps(view.theirs, depot), rest);
    if (theirDeliver < mySteps) {
      ready = Math.max(ready, theirDeliver + Math.ceil(coolTicks / MOVE_EVERY));
    }
  }
  return Math.max(0, ready - mySteps);
}

/** 來不及送（走完還要等，剩下的 tick 不夠）。 */
function tooLate(view: View, totalSteps: number): boolean {
  return view.settle + MOVE_EVERY * totalSteps > view.left;
}

/** 搶包裹的加罰：對手比我近就偏高，差 ±`CONTEST_RAMP` 之內平滑。 */
function contest(lead: number): number {
  return CONTEST_PENALTY * clamp01((lead + CONTEST_RAMP) / (2 * CONTEST_RAMP));
}

/**
 * 空手時最想去的包裹：`VALUE_STEPS × 價值 − 把它送到倉庫的步數（休息還沒結束就等）− 搶包裹的加罰`。
 * 最大的那件；`skip` 的包裹不算（我下一步就踩到的、對手下一步就踩到的）。沒有就是 null。
 */
function bestParcel(view: View, skip: (p: Parcel) => boolean): Plan | null {
  const { state } = view;
  const oppEmpty = state.carry[view.side === 0 ? 1 : 0] === null;
  let best: Plan | null = null;
  for (const p of state.parcels) {
    if (skip(p)) {
      continue;
    }
    const depot = state.depots[p.colour] as number;
    const worth = worthOf(state.walls, depot, p.cell);
    const toParcel = steps(view.mine, p.cell);
    const total = toParcel + steps(bfsDistances(state.walls, depot), p.cell);
    const cost = Math.max(total, restSteps(view, p.colour));
    if (tooLate(view, cost)) {
      continue;
    }
    const rivalry = oppEmpty ? contest(toParcel - steps(view.theirs, p.cell)) : 0;
    const value = VALUE_STEPS * worth - WAIT_PENALTY * cost - rivalry;
    if (best === null || value > best.value) {
      best = { target: p.cell, value, steps: total, colour: p.colour };
    }
  }
  return best;
}

function viewOf(state: D5State, side: Side, atCurrent: boolean): View {
  const other: Side = side === 0 ? 1 : 0;
  const me = state.players[side];
  const opponent = state.players[other];
  const fields = distanceFields(state.walls, me, opponent);
  const myNext = atCurrent ? me.cell : fields.myNext;
  return {
    state,
    side,
    myNext,
    mine: atCurrent ? bfsDistances(state.walls, me.cell) : fields.mine,
    oppNext: fields.oppNext,
    theirs: fields.theirs,
    settle: settleIn(state.tick),
    left: state.maxTicks - state.tick,
  };
}

/** `actions` 用的目標：背著貨去同色倉庫、空手去最想去的包裹（用現在的位置，不是下一步）。 */
function focusOf(state: D5State, side: Side): number | null {
  const carry = state.carry[side];
  const view = viewOf(state, side, true);
  if (carry !== null) {
    return tooLate(view, steps(view.mine, state.depots[carry.colour] as number))
      ? null
      : (state.depots[carry.colour] as number);
  }
  const plan = bestParcel(view, () => false);
  return plan === null ? null : plan.target;
}

// ---------------------------------------------------------------------------
// 遊戲
// ---------------------------------------------------------------------------

/**
 * 做一個 D-5。`coolTicks` 是倉庫收貨後的休息時間，正式版是 `COOL`；
 * 消融實驗用 0（倉庫不休息）量「休息規則」對互動強度與劇本玩家的貢獻。
 */
export function createD5Game(coolTicks: number = COOL): Game<D5State> {
  return {
    id: 'D-5',

    init(seed: number, config: GameConfig): D5State {
      const walls = generateWalls(seed).walls;
      const players: readonly [Walker, Walker] = [
        { cell: START_CELLS[0], pending: -1, score: 0 },
        { cell: START_CELLS[1], pending: -1, score: 0 },
      ];
      const placed = pickDepots(walls, rngStateFor(seed, 'depots'));
      const filled = refillParcels(
        rngStateFor(seed, 'parcels'),
        walls,
        placed.depots,
        [],
        [START_CELLS[0], START_CELLS[1]],
      );
      return {
        tick: 0,
        maxTicks: config.maxTicks,
        walls,
        players,
        rng: filled.rng,
        over: false,
        winner: null,
        parcels: filled.parcels,
        depots: placed.depots,
        cool: [0, 0, 0],
        carry: [null, null],
        delivered: [0, 0],
        waited: [0, 0],
      };
    },

    step(state: D5State, inputs: Inputs): D5State {
      if (state.over) {
        return state;
      }
      const tick = state.tick + 1;
      let players: readonly [Walker, Walker] = [
        steerWalker(state.players[0], inputs[0]),
        steerWalker(state.players[1], inputs[1]),
      ];
      // 休息倒數每個 tick 都減 1（到 0 為止）。
      const cool = state.cool.map((c) => Math.max(0, c - 1));
      let carry: readonly [Carry | null, Carry | null] = state.carry;
      let parcels = state.parcels;
      let rng = state.rng;
      const delivered = [state.delivered[0], state.delivered[1]];

      if (tick % MOVE_EVERY === 0) {
        players = [moveWalker(state.walls, players[0]), moveWalker(state.walls, players[1])];
        // 送貨：背著貨站在同色、而且（減過 1 之後）沒在休息的倉庫上。兩個人同時都送，倉庫只休息一次。
        const scores = [players[0].score, players[1].score];
        const after: (Carry | null)[] = [carry[0], carry[1]];
        const resting = [...cool];
        for (const side of [0, 1] as const) {
          const held = carry[side];
          if (
            held !== null &&
            players[side].cell === state.depots[held.colour] &&
            (cool[held.colour] as number) === 0
          ) {
            scores[side] = (scores[side] as number) + held.worth;
            delivered[side] = (delivered[side] as number) + 1;
            after[side] = null;
            resting[held.colour] = coolTicks;
          }
        }
        for (let c = 0; c < cool.length; c += 1) {
          cool[c] = resting[c] as number;
        }
        // 撿貨：空手站在包裹上。兩個空手的人同一件：各撿一件。
        const picks: (Carry | null)[] = [null, null];
        const taken = new Set<number>();
        for (const p of parcels) {
          for (const side of [0, 1] as const) {
            if (after[side] === null && picks[side] === null && players[side].cell === p.cell) {
              picks[side] = {
                colour: p.colour,
                worth: worthOf(state.walls, state.depots[p.colour] as number, p.cell),
              };
              taken.add(p.cell);
            }
          }
        }
        // 同一件被兩個空手的人踩到：上面的迴圈對第二個人也成立（picks 各自獨立），所以各撿一件。
        for (const side of [0, 1] as const) {
          if (picks[side] !== null) {
            after[side] = picks[side];
          }
        }
        carry = [after[0] as Carry | null, after[1] as Carry | null];
        players = [
          { ...players[0], score: scores[0] as number },
          { ...players[1], score: scores[1] as number },
        ];
        if (taken.size > 0) {
          parcels = parcels.filter((p) => !taken.has(p.cell));
          // 重要：補包裹用掉亂數，新的 RngState 一定要寫回 state。
          const refilled = refillParcels(rng, state.walls, state.depots, parcels, [
            players[0].cell,
            players[1].cell,
          ]);
          parcels = refilled.parcels;
          rng = refilled.rng;
        }
      }

      // 等待：背著貨站在休息中的同色倉庫上（每個 tick 都算）。
      const waited = [state.waited[0], state.waited[1]];
      for (const side of [0, 1] as const) {
        const held = carry[side];
        if (
          held !== null &&
          players[side].cell === state.depots[held.colour] &&
          (cool[held.colour] as number) > 0
        ) {
          waited[side] = (waited[side] as number) + 1;
        }
      }

      const over = tick >= state.maxTicks;
      return {
        ...state,
        tick,
        players,
        parcels,
        cool,
        carry,
        rng,
        delivered: [delivered[0] as number, delivered[1] as number],
        waited: [waited[0] as number, waited[1] as number],
        over,
        winner: over ? winnerByScore(players) : null,
      };
    },

    isOver(state: D5State): boolean {
      return state.over;
    },

    score(state: D5State): readonly [number, number] {
      return [state.players[0].score, state.players[1].score];
    },

    winner(state: D5State): Side | null {
      return state.over ? state.winner : null;
    },

    actions(state: D5State, side: Side): readonly Buttons[] {
      return actionsToward(state.walls, state.players[side], side, focusOf(state, side));
    },

    evaluate(state: D5State, side: Side): { gain: number; danger: number } {
      const other: Side = side === 0 ? 1 : 0;
      const me = state.players[side];
      const opponent = state.players[other];
      const difference = me.score - opponent.score;
      if (state.over) {
        const sign = difference === 0 ? 0 : difference > 0 ? 1 : -1;
        return { gain: GAIN_PER_POINT * difference + sign * WIN_BONUS, danger: 0 };
      }
      const view = viewOf(state, side, false);
      const moving = view.myNext !== me.cell;

      // 下一次走格會發生的事（虛擬）：踩進沒在休息的同色倉庫就送達；空手踩到包裹就撿起。
      let held = state.carry[side];
      let virtual = 0;
      let pickedUp = false;
      if (held !== null) {
        const depot = state.depots[held.colour] as number;
        if (view.myNext === depot && (state.cool[held.colour] as number) <= view.settle) {
          virtual = held.worth;
          held = null;
        }
      } else if (moving) {
        const p = state.parcels.find((q) => q.cell === view.myNext);
        if (p !== undefined) {
          held = {
            colour: p.colour,
            worth: worthOf(state.walls, state.depots[p.colour] as number, p.cell),
          };
          pickedUp = true;
        }
      }
      const theirHeld = state.carry[other];

      let potential = 0;
      let danger = 0;
      if (held !== null) {
        const depot = state.depots[held.colour] as number;
        const toDepot = steps(view.mine, depot);
        const cost = Math.max(toDepot, restSteps(view, held.colour));
        if (tooLate(view, cost)) {
          held = null; // 來不及送：背著的貨不算數
        } else {
          potential = -WAIT_PENALTY * cost;
          // 已經背著的貨，白等的估計用「現在的位置」算（五個動作都一樣，不會逼人倒退著走）；
          // 剛要撿起的那一步用撿起來的格子算，兩者在撿起來的前後是同一個數字。
          const from = pickedUp ? toDepot : steps(bfsDistances(state.walls, me.cell), depot);
          danger = clamp01(waitSteps(view, held.colour, from, coolTicks) / (COOL / MOVE_EVERY));
        }
      } else {
        const oppTakes = (p: Parcel): boolean => view.oppNext === p.cell && theirHeld === null;
        const plan = bestParcel(view, (p) => oppTakes(p) || (moving && p.cell === view.myNext));
        if (plan !== null) {
          potential = plan.value;
          danger = clamp01(
            waitSteps(view, plan.colour, plan.steps, coolTicks) / (COOL / MOVE_EVERY),
          );
        }
      }

      const gain =
        GAIN_PER_POINT * (difference + virtual) +
        CARRY_WEIGHT *
          ((held === null ? 0 : held.worth) - (theirHeld === null ? 0 : theirHeld.worth)) +
        potential;
      return { gain, danger };
    },
  };
}

export const d5Game: Game<D5State> = createD5Game();
