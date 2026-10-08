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
  nextCell,
  pickEmptyCells,
  steerWalker,
  winnerByScore,
} from '../_diamonds/logic';
import type { BaseOverrides, DiamondsBase, Walker } from '../_diamonds/logic';

/**
 * D-4 電池（SPEC 第 9 節一行方向；小規格 `docs/cards/D-4.md`）。
 * 規則同 D-A（搶金幣），但每走一格耗 1 電、沒電就動不了；場上有 4 個充電站，一次只有一個人能充，
 * 你站著的站，對手就用不了。沒電的人每 1 秒回 1 電（涓流），所以被擠死的人不會永遠卡住。
 * 地圖、牆、走格、補金幣的共用邏輯在 `_diamonds/logic.ts`。
 *
 * 這是一張「誠實的技術牌」：格子世界裡每個動作都有機會成本（走一步耗一格電），沒有免費的信號軸，
 * 所以不宣稱玩家騙得了 AI。它的賣點是互相牽制（站獨占）與技術有報酬（把電量與站算清楚就會贏）。
 */

/** 電量上限，開局滿電。 */
export const CAP = 40;
/** 站上的 holder 每次走格結算充幾電。 */
export const CHARGE = 2;
/** 電量是 0 的人，每幾個 tick 回 1 電。 */
export const TRICKLE_EVERY = 60;
/** 場上有幾個站（兩對 180 度旋轉對稱）。 */
export const STATION_COUNT = 4;
/** 任兩個站之間至少幾步（繞牆）。 */
export const STATION_GAP = 6;
/** 場上隨時有幾枚金幣（同 D-A）。 */
export const COIN_COUNT = 6;
/** 對手比我更靠近某一枚金幣時，我對那一枚的距離要加上這麼多（同 D-A）。 */
export const CONTEST_PENALTY = 8;

/**
 * AI 用的常數（起始值，量過之後的結果寫在 `docs/cards/D-4.md`）。
 * `BATT_WEIGHT` 是每 1 電的 gain：必須小於 1（走一步靠近目標 +1、耗 1 電 −BATT_WEIGHT，淨值要是正的，否則 AI 寧可站著不動），
 * 又必須大於 1/3（站上充一次 +2 電要贏過「離開靠近金幣一步」的淨值 1 − BATT_WEIGHT，所以電沒滿的時候 AI 會留在站上）。
 */
export const BATT_WEIGHT = 0.5;
/** 計畫一趟路時，到站之後要多留幾格電。 */
export const REFUEL_MARGIN = 4;
/** 擠它：對手快擱淺時，我占著它最近的站的最高 gain 加成。 */
export const SQUEEZE_BONUS = 25;
/** 對手的「到站後剩餘電量」低於這個數才開始擠它；也是 `danger` 的尺度。 */
export const STRAND_SCALE = 6;
/** 擠它的趕路：離那個站越近 gain 加成越高，超過這麼多步就不加。 */
export const SQUEEZE_REACH = 12;
/** 搶金幣的加罰在雙方計畫差 ±這麼多步之內平滑過渡。 */
export const CONTEST_RAMP = 4;
/** 沒有安全計畫（連滿電都撿不回來）的金幣，距離多加這麼多，排在所有安全的金幣後面。 */
export const UNSAFE_PENALTY = 40;
/** 站被對手搶先時 `danger` 加多少。 */
export const CONTEST_DANGER = 0.3;

export interface D4State extends DiamondsBase {
  /** 金幣所在的格子編號。 */
  readonly coins: readonly number[];
  /** 兩邊電量（0 到 `CAP`）。 */
  readonly battery: readonly [number, number];
  /** 4 個站的格子編號（開局決定，不變）；0、1 是一對旋轉對稱，2、3 是另一對。 */
  readonly stations: readonly number[];
  /** 每個站目前的 holder：−1 沒人、0 人、1 AI。 */
  readonly holder: readonly number[];
  /** 涓流計時：電量是 0 時每 tick 加 1，到 `TRICKLE_EVERY` 回 1 電並歸 0；電量大於 0 時歸 0。 */
  readonly trickle: readonly [number, number];
  /** 整場累計「電量是 0」的 tick 數（指紋量測與畫面用，不影響規則；AI 不看）。 */
  readonly stuck: readonly [number, number];
}

export interface StateOverrides extends BaseOverrides {
  readonly coins?: readonly number[];
  readonly battery?: readonly [number, number];
  readonly stations?: readonly number[];
  readonly holder?: readonly number[];
  readonly trickle?: readonly [number, number];
  readonly stuck?: readonly [number, number];
}

/** 測試用的預設金幣位置：同 D-A。 */
const DEFAULT_COINS: readonly number[] = [
  cell(10, 5),
  cell(20, 5),
  cell(10, 18),
  cell(20, 18),
  cell(15, 12),
  cell(16, 12),
];

/** 測試用的預設站：兩對 180 度旋轉對稱。 */
const DEFAULT_STATIONS: readonly number[] = [cell(8, 6), cell(23, 17), cell(23, 6), cell(8, 17)];

/** 測試輔助：預設局面（沒有牆、4 個站在固定位置、`holder` 全 −1、兩邊電 30、金幣同 D-A）加上 overrides。 */
export function makeState(overrides: StateOverrides = {}): D4State {
  return {
    ...makeBase(overrides),
    coins: overrides.coins ?? DEFAULT_COINS,
    battery: overrides.battery ?? [CAP, CAP],
    stations: overrides.stations ?? DEFAULT_STATIONS,
    holder: overrides.holder ?? [-1, -1, -1, -1],
    trickle: overrides.trickle ?? [0, 0],
    stuck: overrides.stuck ?? [0, 0],
  };
}

// ---------------------------------------------------------------------------
// 站的位置
// ---------------------------------------------------------------------------

/** 180 度旋轉的對應格：(x, y) ↔ (31 − x, 23 − y)。 */
function mirrorCell(index: number): number {
  return CELLS - 1 - index;
}

/**
 * 挑 4 個站：兩對 180 度旋轉對稱，不在牆上、不在兩個起點，任兩站之間至少 `STATION_GAP` 步。
 * 先挑一對，再挑另一對；重挑有次數上限，用完就退回第一個合格的（再不行就放寬到任何對稱的一對），`init` 不會有無窮迴圈。
 */
function pickStations(
  walls: readonly number[],
  rng: RngState,
): { stations: number[]; rng: RngState } {
  const pairs: number[] = [];
  for (let c = 0; c < CELLS / 2; c += 1) {
    const m = mirrorCell(c);
    if (walls[c] === 0 && walls[m] === 0 && c !== START_CELLS[0] && c !== START_CELLS[1]) {
      pairs.push(c);
    }
  }
  const farEnough = (taken: readonly number[], c: number): boolean => {
    const field = bfsDistances(walls, c);
    const mine = [c, mirrorCell(c)];
    if ((field[mirrorCell(c)] as number) < STATION_GAP) {
      return false;
    }
    return taken.every((t) =>
      mine.every((m) => (bfsDistances(walls, t)[m] as number) >= STATION_GAP),
    );
  };
  let state = rng;
  const chosen: number[] = [];
  for (let round = 0; round < 2; round += 1) {
    let pick = -1;
    for (let attempt = 0; attempt < 64 && pick < 0; attempt += 1) {
      let k: number;
      [k, state] = intFrom(state, pairs.length);
      const candidate = pairs[k] as number;
      if (!chosen.includes(candidate) && farEnough(chosen, candidate)) {
        pick = candidate;
      }
    }
    if (pick < 0) {
      pick = pairs.find((c) => !chosen.includes(c) && farEnough(chosen, c)) ?? -1;
    }
    if (pick < 0) {
      pick = pairs.find((c) => !chosen.includes(c) && !chosen.includes(mirrorCell(c))) ?? 0;
    }
    chosen.push(pick, mirrorCell(pick));
  }
  return { stations: chosen, rng: state };
}

// ---------------------------------------------------------------------------
// 規則用的小工具
// ---------------------------------------------------------------------------

function playerCells(players: readonly [Walker, Walker]): number[] {
  return [players[0].cell, players[1].cell];
}

/** 站的 holder 結算：離開的 holder 讓站變空；空站上只有一個人就由他接手；充電。就地修改傳進來的（新建的）陣列。 */
function settleStations(
  stations: readonly number[],
  holder: number[],
  battery: number[],
  players: readonly [Walker, Walker],
): void {
  for (let i = 0; i < stations.length; i += 1) {
    const station = stations[i] as number;
    const on = [players[0].cell === station, players[1].cell === station];
    let h = holder[i] as number;
    if (h >= 0 && !on[h]) {
      h = -1;
    }
    if (h < 0 && on[0] !== on[1]) {
      h = on[0] ? 0 : 1;
    }
    holder[i] = h;
    if (h >= 0) {
      battery[h] = Math.min(CAP, (battery[h] as number) + CHARGE);
    }
  }
}

// ---------------------------------------------------------------------------
// 給 AI 的看法
// ---------------------------------------------------------------------------

/**
 * 這一邊在這個局面下一步會在哪：沒電動不了；對手若正站在某個站上（不管是不是 holder），就當作它留在站上——
 * 對手在模擬裡的動作只是 `actions()[0]`（它「可能想去的方向」），不是承諾；若把它當真，站上的人一直被預測成「馬上離開」，
 * 旁邊等著的 AI 就會永遠等下去（兩個人同時踩進空站時更是互相等對方先走）。`committed` 是我自己的動作（真的按下去的），照 `pending` 算。
 */
function predictedNext(state: D4State, who: Side, committed: boolean): number {
  const walker = state.players[who];
  if ((state.battery[who] as number) <= 0) {
    return walker.cell;
  }
  if (!committed) {
    if (state.stations.includes(walker.cell)) {
      return walker.cell;
    }
  }
  return nextCell(state.walls, walker);
}

interface View {
  /** 下一步之後的電量（扣掉走的、加上站上的虛擬充電）。 */
  readonly battery: number;
  /** 我能用的最近的站的步數與編號（沒有是 `UNREACHABLE`、−1）。 */
  readonly reach: number;
  readonly station: number;
  /** 下一步就站在我能用的站上。 */
  readonly onStation: boolean;
  /** 每個站我能不能用。 */
  readonly usable: readonly boolean[];
}

/**
 * 一邊的「下一步之後」：站我能不能用——`holder` 是我，或對手下一步不在那個站上（空站、或對手已經走了）。
 * 兩個人下一步同時踩進空站，誰也不是 holder，所以那個站兩邊都不算能用。
 */
function viewOf(
  state: D4State,
  who: Side,
  whoNext: number,
  otherNext: number,
  field: Int32Array,
): View {
  const other: Side = who === 0 ? 1 : 0;
  const usable = state.stations.map((s, i) => {
    if (state.holder[i] === who) {
      return true;
    }
    // 兩個人同時站在沒有 holder 的站上（同時走進來）：總要有一個人先讓。電少的留下充電，一樣就由 0 號邊留下。
    if (state.holder[i] < 0 && state.players[who].cell === s && state.players[other].cell === s) {
      const mine = state.battery[who] as number;
      const theirs = state.battery[other] as number;
      return mine < theirs || (mine === theirs && who === 0);
    }
    return otherNext !== s;
  });
  let battery = (state.battery[who] as number) - (whoNext !== state.players[who].cell ? 1 : 0);
  let onStation = false;
  let reach = UNREACHABLE;
  let station = -1;
  state.stations.forEach((s, i) => {
    if (!usable[i]) {
      return;
    }
    if (s === whoNext) {
      onStation = true;
    }
    const d = field[s] as number;
    if (d < reach) {
      reach = d;
      station = i;
    }
  });
  if (onStation) {
    battery = Math.min(CAP, battery + CHARGE);
  }
  return { battery, reach, station, onStation, usable };
}

/** 從我下一步的位置，繞過「我能用的站」撿這一枚金幣再回到最近的站，最少要幾步（站不能用就是 `UNREACHABLE`）。 */
function stationToCoin(state: D4State, view: View, coin: number): number {
  let best = UNREACHABLE;
  state.stations.forEach((s, i) => {
    if (view.usable[i]) {
      const d = bfsDistances(state.walls, s)[coin] as number;
      if (d < best) {
        best = d;
      }
    }
  });
  return best;
}

interface Plan {
  /** 這個計畫還要「花幾步的時間」（走路的步數＋站上等充電的結算次數）。 */
  readonly cost: number;
  /** 先往哪個格子走：電夠就是金幣本身，不夠就是要先去充電的站。 */
  readonly target: number;
}

/** 去收一枚金幣的最省計畫：電夠就直接去；不夠就先去某個站充到夠再去。沒有安全的計畫也照往那個方向走，只是排在後面。 */
function coinPlan(
  state: D4State,
  view: View,
  from: Int32Array,
  battery: number,
  coin: number,
): Plan {
  const toCoin = from[coin] as number;
  const home = stationToCoin(state, view, coin);
  // 這枚金幣離我能用的站有多遠：從最近的站出發、撿了再回最近的站，最少要幾格電（不看我現在在哪）。
  let roundTrip = UNREACHABLE;
  state.stations.forEach((station, i) => {
    if (view.usable[i]) {
      roundTrip = Math.min(roundTrip, (bfsDistances(state.walls, station)[coin] as number) + home);
    }
  });
  // 餘裕通常是 REFUEL_MARGIN；離站很遠的金幣（來回快要用完滿電）餘裕縮小，但來回本身超過滿電就不算安全的計畫。
  const margin = Math.min(REFUEL_MARGIN, Math.max(0, CAP - roundTrip));
  let cost = UNREACHABLE;
  let target = coin;
  if (roundTrip <= CAP && battery >= toCoin + home + margin) {
    cost = toCoin; // 電夠：撿得到、回得了站
  } else if (roundTrip <= CAP) {
    state.stations.forEach((station, i) => {
      if (!view.usable[i]) {
        return;
      }
      const leg1 = from[station] as number;
      const leg2 = bfsDistances(state.walls, station)[coin] as number;
      const required = Math.min(CAP, leg2 + home + margin);
      const deficit = Math.max(0, required - (battery - leg1));
      const total = leg1 + Math.ceil(deficit / CHARGE) + leg2;
      if (total < cost) {
        cost = total;
        target = station;
      }
    });
  }
  if (cost >= UNREACHABLE) {
    cost = toCoin + UNSAFE_PENALTY; // 沒有安全的計畫：還是往那個方向走，只是排在所有安全的金幣後面
    target = coin;
  }
  return { cost, target };
}

/**
 * 所有金幣裡最省的計畫（用「走幾步＋站上等幾次結算」當單位，所以連續：電剛好夠與剛好不夠的差別只在多等幾次充電）。
 * - 電夠：走到金幣，再留得下回最近的站的餘裕（`REFUEL_MARGIN`）→ 花 `toCoin` 步。
 * - 電不夠：先走到某個我能用的站、充到夠（上限 `CAP`）、再走去金幣 → 花 走去站 + 充電次數 + 站到金幣。
 * `penalty(i, cost)` 是第 i 枚金幣被對手搶先的加罰（用雙方各自的計畫比，不是比直線距離）。
 */
function bestPlan(
  state: D4State,
  view: View,
  from: Int32Array,
  battery: number,
  skip: (coin: number) => boolean,
  penalty: (index: number, cost: number) => number,
): Plan | null {
  let best: Plan | null = null;
  state.coins.forEach((coin, index) => {
    if (skip(coin)) {
      return;
    }
    const plan = coinPlan(state, view, from, battery, coin);
    const effective = plan.cost + penalty(index, plan.cost);
    if (best === null || effective < best.cost) {
      best = { cost: effective, target: plan.target };
    }
  });
  return best;
}

/** 對手的計畫比我的省多少（我的 − 對手的，步）→ 我對這枚金幣要加多少距離。 */
function contest(lead: number): number {
  return CONTEST_PENALTY * clamp01((lead + CONTEST_RAMP) / (2 * CONTEST_RAMP));
}

export const d4Game: Game<D4State> = {
  id: 'D-4',

  init(seed: number, config: GameConfig): D4State {
    const walls = generateWalls(seed).walls;
    const players: readonly [Walker, Walker] = [
      { cell: START_CELLS[0], pending: -1, score: 0 },
      { cell: START_CELLS[1], pending: -1, score: 0 },
    ];
    const placed = pickStations(walls, rngStateFor(seed, 'stations'));
    const coins = pickEmptyCells(
      rngStateFor(seed, 'coins'),
      walls,
      playerCells(players),
      COIN_COUNT,
    );
    return {
      tick: 0,
      maxTicks: config.maxTicks,
      walls,
      players,
      rng: coins.rng,
      over: false,
      winner: null,
      coins: coins.cells,
      battery: [CAP, CAP],
      stations: placed.stations,
      holder: [-1, -1, -1, -1],
      trickle: [0, 0],
      stuck: [0, 0],
    };
  },

  step(state: D4State, inputs: Inputs): D4State {
    if (state.over) {
      return state;
    }
    const tick = state.tick + 1;
    let players: readonly [Walker, Walker] = [
      steerWalker(state.players[0], inputs[0]),
      steerWalker(state.players[1], inputs[1]),
    ];
    let coins = state.coins;
    let rng = state.rng;
    const battery = [state.battery[0], state.battery[1]];
    const trickle = [state.trickle[0], state.trickle[1]];
    const stuck = [state.stuck[0], state.stuck[1]];
    let holder = state.holder;

    if (tick % MOVE_EVERY === 0) {
      // 兩邊同時走：沒電的人動不了（待走方向照常歸零）；真的換到另一格才扣 1 電。
      const moved = [0, 1].map((side) => {
        const walker = players[side] as Walker;
        if ((battery[side] as number) <= 0) {
          return { ...walker, pending: -1 as const };
        }
        const after = moveWalker(state.walls, walker);
        if (after.cell !== walker.cell) {
          battery[side] = (battery[side] as number) - 1;
        }
        return after;
      });
      players = [moved[0] as Walker, moved[1] as Walker];
      // 撿金幣（同 D-A）。
      const gained = [0, 0];
      for (const coin of coins) {
        for (const side of [0, 1] as const) {
          if (players[side].cell === coin) {
            gained[side] = (gained[side] as number) + 1;
          }
        }
      }
      const kept = coins.filter((coin) => players[0].cell !== coin && players[1].cell !== coin);
      players = [
        { ...players[0], score: players[0].score + (gained[0] as number) },
        { ...players[1], score: players[1].score + (gained[1] as number) },
      ];
      coins = kept;
      if (coins.length < COIN_COUNT) {
        // 重要：補金幣用掉亂數，新的 RngState 一定要寫回 state。
        const refilled = pickEmptyCells(
          rng,
          state.walls,
          [...coins, ...playerCells(players)],
          COIN_COUNT - coins.length,
        );
        coins = [...coins, ...refilled.cells];
        rng = refilled.rng;
      }
      // 站：先走、再結算 holder、最後充電。
      const nextHolder = [...state.holder];
      settleStations(state.stations, nextHolder, battery, players);
      holder = nextHolder;
    }

    // 涓流與 stuck：每個 tick 都算。
    for (const side of [0, 1] as const) {
      if ((battery[side] as number) === 0) {
        stuck[side] = (stuck[side] as number) + 1;
        trickle[side] = (trickle[side] as number) + 1;
        if ((trickle[side] as number) >= TRICKLE_EVERY) {
          battery[side] = 1;
          trickle[side] = 0;
        }
      } else {
        trickle[side] = 0;
      }
    }

    const over = tick >= state.maxTicks;
    return {
      ...state,
      tick,
      players,
      coins,
      rng,
      holder,
      battery: [battery[0] as number, battery[1] as number],
      trickle: [trickle[0] as number, trickle[1] as number],
      stuck: [stuck[0] as number, stuck[1] as number],
      over,
      winner: over ? winnerByScore(players) : null,
    };
  },

  isOver(state: D4State): boolean {
    return state.over;
  },

  score(state: D4State): readonly [number, number] {
    return [state.players[0].score, state.players[1].score];
  },

  winner(state: D4State): Side | null {
    return state.over ? state.winner : null;
  },

  actions(state: D4State, side: Side): readonly Buttons[] {
    const other: Side = side === 0 ? 1 : 0;
    const me = state.players[side];
    const field = bfsDistances(state.walls, me.cell);
    const opponentCell = state.players[other].cell;
    // 現在的位置、現在的電量：目標是最省計畫的第一站（電夠是金幣，不夠是要先去充的站）。
    const view = viewOf(state, side, me.cell, opponentCell, field);
    const plan = bestPlan(
      state,
      view,
      field,
      state.battery[side],
      () => false,
      () => 0,
    );
    let focus: number | null = plan === null ? null : plan.target;
    if (focus === null && view.station >= 0) {
      focus = state.stations[view.station] as number;
    }
    return actionsToward(state.walls, me, side, focus);
  },

  evaluate(state: D4State, side: Side): { gain: number; danger: number } {
    const other: Side = side === 0 ? 1 : 0;
    const me = state.players[side];
    const opponent = state.players[other];
    const difference = me.score - opponent.score;
    if (state.over) {
      const sign = difference === 0 ? 0 : difference > 0 ? 1 : -1;
      return { gain: GAIN_PER_POINT * difference + sign * WIN_BONUS, danger: 0 };
    }
    const fields = distanceFields(state.walls, me, opponent);
    const myNext = (state.battery[side] as number) > 0 ? fields.myNext : me.cell;
    const oppNext = predictedNext(state, other, false);
    const mine = bfsDistances(state.walls, myNext);
    const theirs = bfsDistances(state.walls, oppNext);
    const mineView = viewOf(state, side, myNext, oppNext, mine);
    const theirView = viewOf(state, other, oppNext, myNext, theirs);
    const moving = myNext !== me.cell;
    const oppMoving = oppNext !== opponent.cell;

    // 金幣：同 D-A 的虛擬撿起；其餘的金幣用「最省計畫」算還要花幾步（會算電量、會算站被不被占）。
    let virtual = 0;
    for (const coin of state.coins) {
      if (moving && coin === myNext) {
        virtual += 1; // 下一步就踩到：當作已經撿到
      }
    }
    // 搶金幣：雙方各用自己的計畫比（對手沒電、或離站遠，就不算它在搶）；差 ±CONTEST_RAMP 之內是平滑的，不會在邊界上抖。
    const oppCosts = state.coins.map(
      (coin) => coinPlan(state, theirView, theirs, theirView.battery, coin).cost,
    );
    const plan = bestPlan(
      state,
      mineView,
      mine,
      mineView.battery,
      (coin) => (moving && coin === myNext) || (oppMoving && coin === oppNext),
      (index, cost) => contest(cost - (oppCosts[index] as number)),
    );
    const distance = Math.min(plan === null ? mineView.reach : plan.cost, 200);

    // 擠它：對手快擱淺，而且它最近的站我先到（或已經占著），我就去占那個站。
    // 只看對手的電與站的位置，不看分差（不是橡皮筋）。
    let squeeze = 0;
    const oppNeed = theirView.battery - theirView.reach;
    if (theirView.battery > 0 && oppNeed < STRAND_SCALE) {
      let nearestAll = UNREACHABLE;
      let nearestStation = -1;
      state.stations.forEach((s, i) => {
        const d = theirs[s] as number;
        if (d < nearestAll) {
          nearestAll = d;
          nearestStation = i;
        }
      });
      // 對手已經貼在站旁（1 步）就不擠了：擠到底只會變成兩邊誰都不動的僵局。
      if (nearestStation >= 0 && nearestAll > 1) {
        const target = state.stations[nearestStation] as number;
        const toTarget = mine[target] as number;
        const first = toTarget < nearestAll && mineView.battery >= toTarget + REFUEL_MARGIN;
        if (myNext === target || first) {
          const strand = clamp01((STRAND_SCALE - oppNeed) / STRAND_SCALE);
          squeeze =
            SQUEEZE_BONUS * strand * (1 - Math.min(toTarget, SQUEEZE_REACH) / SQUEEZE_REACH);
        }
      }
    }

    const gain =
      GAIN_PER_POINT * (difference + virtual) + BATT_WEIGHT * mineView.battery - distance + squeeze;

    // danger：擱淺的可能。去到最近的站之後還剩幾電（need）太少就高；那個站對手比我先到，再加一點。
    const need = mineView.battery - mineView.reach;
    let danger = clamp01((REFUEL_MARGIN + 1 - need) / STRAND_SCALE);
    if (danger > 0 && mineView.station >= 0) {
      const target = state.stations[mineView.station] as number;
      if ((theirs[target] as number) < mineView.reach) {
        danger = clamp01(danger + CONTEST_DANGER);
      }
    }
    return { gain, danger };
  },
};
