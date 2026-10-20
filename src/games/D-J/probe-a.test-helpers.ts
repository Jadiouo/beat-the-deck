import { levelController, policyByName } from '../../ai/level';
import type { PolicyKey } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Game, GameConfig, Side } from '../../core/types';
import { outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { IsPoint, MatchOutcome, ProbeSpec } from '../../../tests/ai/probe-a.shared';
import {
  CELLS,
  MOVE_EVERY,
  START_CELLS,
  UNREACHABLE,
  bfsDistances,
  cellX,
  cellY,
  stepTarget,
} from '../_diamonds/logic';
import type { Dir } from '../_diamonds/logic';
import { BAG_LIMIT } from '../D-2/logic';
import { GUARD_RANGE, STEAL_RANGE, dJGame } from './logic';
import type { DJState } from './logic';

/**
 * D-J 探針 A（完整版）的量測工具（`docs/cards/D-J.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61、10.70）。
 * 只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。**(b)、(c) 兩族與選法在量之前寫進小規格並 push，量完不改。**
 *
 * 所有成員共用同一台「跑腿」機器：三種狀態——
 *   撿（collect）：去最近、來得及存的金幣；背包到 `n` 枚就回基地存；快沒時間了背包有東西就回基地；
 *   偷（raid）：背包空的時候走到對手基地旁邊（曼哈頓距離 ≤ 1）待著，待滿 130 個 tick、背包滿了、或條件不成立就離開；
 *   守（guard）：走回自己的基地待著。
 * 成員的差別只在：`n`、撿的範圍（龜縮半徑）、**什麼時候進入偷／守、什麼時候離開**。
 * - (b) 族：知道有對手（所以有偷與守這兩件事），但**不讀對手的任何狀態**：進入偷／守只看 tick 與自己的分數；
 *   機器收到的「對手視野」是 null。
 * - (c) 族：同一台機器，但進入／離開偷與守、龜縮半徑改看對手的位置、分數、背包、偷竊倒數。
 *   **沒有 import `evaluate`、`predictOpponent`、`opponentAction`，也沒有拿 AI 的控制器當成員。**
 */

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };
/** AI 的種子 ＝ 玩家種子 ＋ 這個數（慣例同 D-10、S-10、D-Q、D-8 的探針）。 */
export const AI_SEED_OFFSET = 1_000_003;

export const B_FAMILY = [
  'b-n3',
  'b-n2',
  'b-n1',
  'b-turtle',
  'b-guard',
  'b-raid1',
  'b-raid-rep',
  'b-stay',
] as const;

export const C_FAMILY = [
  'c-g3',
  'c-g2',
  'c-g1',
  'c-turtle-roam',
  'c-raid1-read',
  'c-raid-rep-read',
  'c-raid-free',
  'c-lurk3',
] as const;

/** 沒有 (c) 版本的 (b) 成員：只為了看動態範圍（站著不動）。其餘每個 (b) 都要有雙胞胎（10.68 第六小節）。 */
export const BALLAST: readonly string[] = ['b-stay'];

/**
 * 雙胞胎：機器一樣、只差「讀不讀對手」。
 * `b-n*` 沒有守家，它們的 (c) 版本是「加上看對手逼近就回家守」的 `c-g*`（`n` 相同）；`b-guard`（固定時段守）也對 `c-g3`（看對手逼近才守）。
 */
export const TWIN_OF: Readonly<Record<string, string | null>> = {
  'b-n3': 'c-g3',
  'b-n2': 'c-g2',
  'b-n1': 'c-g1',
  'b-turtle': 'c-turtle-roam',
  'b-guard': 'c-g3',
  'b-raid1': 'c-raid1-read',
  'b-raid-rep': 'c-raid-rep-read',
  'b-stay': null,
};

/** 額外的同基底配對：c-raid-free（偷不看排程、只看對手）與 c-lurk3（看對手的偷竊倒數）的基底。 */
export const EXTRA_TWINS: readonly (readonly [string, string])[] = [
  ['b-raid-rep', 'c-raid-free'],
  ['b-n3', 'c-lurk3'],
];

/** 偷：待滿這麼多個 tick 就離開（兩次偷成功是 120 個 tick，多留 10 個）。 */
export const RAID_WAIT = 130;
/** 守：最多待這麼多個 tick，之後冷卻 `GUARD_COOLDOWN` 個 tick 才會再守。 */
export const GUARD_MAX = 300;
export const GUARD_COOLDOWN = 120;
/** 偷：離開之後這麼多個 tick 內不再出發（只有 c-raid-free 用，其餘靠排程）。 */
export const RAID_COOLDOWN = 300;
/** (c) 的威脅半徑：對手離我的基地這麼多步（繞牆）以內就算逼近。 */
export const THREAT_STEPS = 14;
/** 龜縮半徑：只撿離自己的基地這麼多步以內的金幣。 */
export const TURTLE_STEPS = 8;
/** c-turtle-roam 在對手離我的基地很遠（超過 `ROAM_FAR` 步）時放寬到這麼多步。 */
export const ROAM_STEPS = 16;
export const ROAM_FAR = 30;

// ---------------------------------------------------------------------------
// 走路
// ---------------------------------------------------------------------------

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const ORDER: Readonly<Record<Side, readonly Dir[]>> = { 0: [0, 1, 2, 3], 1: [2, 3, 0, 1] };

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);
const manhattan = (a: number, b: number): number =>
  Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
const rank = (c: number, side: Side): number => (side === 0 ? c : CELLS - 1 - c);

/** 往 `target` 走一步的方向：最短路的方向裡優先上一次走的方向（直走），否則依這一邊的預設順序。 */
function toward(
  walls: readonly number[],
  from: number,
  side: Side,
  target: number,
  heading: Dir | null,
): Dir | null {
  if (from === target) {
    return null;
  }
  const field = bfsDistances(walls, target);
  const here = field[from] as number;
  const good: Dir[] = [];
  for (const dir of ORDER[side]) {
    const next = stepTarget(walls, from, dir);
    if (next !== from && (field[next] as number) < here) {
      good.push(dir);
    }
  }
  if (good.length === 0) {
    return null;
  }
  if (heading !== null && good.includes(heading)) {
    return heading;
  }
  return good[0] as Dir;
}

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

type RaidMode = 'none' | 'blind1' | 'blindRep' | 'read1' | 'readRep' | 'readFree';
type GuardMode = 'none' | 'blind' | 'threat' | 'lurk';

interface Config {
  /** 背包到這麼多枚就回基地存。 */
  readonly n: number;
  /** 龜縮：只撿離自己的基地這麼多步以內的；null ＝ 不限。 */
  readonly radius: number | null;
  /** 對手很遠時放寬龜縮半徑（讀對手）。 */
  readonly roam?: boolean;
  readonly raid: RaidMode;
  readonly guard: GuardMode;
  readonly stay?: boolean;
}

/** (b) 的規則：只有參數，沒有任何對手的資料。 */
function ruleB(name: string): Config {
  switch (name) {
    case 'b-n3':
      return { n: 3, radius: null, raid: 'none', guard: 'none' };
    case 'b-n2':
      return { n: 2, radius: null, raid: 'none', guard: 'none' };
    case 'b-n1':
      return { n: 1, radius: null, raid: 'none', guard: 'none' };
    case 'b-turtle':
      return { n: 2, radius: TURTLE_STEPS, raid: 'none', guard: 'none' };
    case 'b-guard':
      return { n: 3, radius: null, raid: 'none', guard: 'blind' };
    case 'b-raid1':
      return { n: 3, radius: null, raid: 'blind1', guard: 'none' };
    case 'b-raid-rep':
      return { n: 3, radius: null, raid: 'blindRep', guard: 'none' };
    case 'b-stay':
      return { n: 3, radius: null, raid: 'none', guard: 'none', stay: true };
    default:
      throw new Error(`不是 (b) 的成員：${name}`);
  }
}

/** (c) 的規則：同一台機器，進入／離開偷與守改看對手。 */
function ruleC(name: string): Config {
  switch (name) {
    case 'c-g3':
      return { n: 3, radius: null, raid: 'none', guard: 'threat' };
    case 'c-g2':
      return { n: 2, radius: null, raid: 'none', guard: 'threat' };
    case 'c-g1':
      return { n: 1, radius: null, raid: 'none', guard: 'threat' };
    case 'c-turtle-roam':
      return { n: 2, radius: TURTLE_STEPS, roam: true, raid: 'none', guard: 'none' };
    case 'c-raid1-read':
      return { n: 3, radius: null, raid: 'read1', guard: 'none' };
    case 'c-raid-rep-read':
      return { n: 3, radius: null, raid: 'readRep', guard: 'none' };
    case 'c-raid-free':
      return { n: 3, radius: null, raid: 'readFree', guard: 'none' };
    case 'c-lurk3':
      return { n: 3, radius: null, raid: 'none', guard: 'lurk' };
    default:
      throw new Error(`不是 (c) 的成員：${name}`);
  }
}

// ---------------------------------------------------------------------------
// 機器
// ---------------------------------------------------------------------------

/** 對手的公開狀態（只有 (c) 拿得到）。 */
interface OppView {
  readonly cell: number;
  readonly score: number;
  readonly bag: number;
  /** 對手正在偷我的倒數。 */
  readonly lurk: number;
}

/** 第一個窗口從這個 tick 開始，之後每 `WINDOW_EVERY` 個 tick 一個，每個窗口開 `WINDOW_OPEN` 個 tick。 */
const WINDOW_FROM = 600;
const WINDOW_EVERY = 900;
const WINDOW_OPEN = 300;
/** b-raid1／c-raid1-read 最早在這個 tick 出發。 */
const RAID1_FROM = 1200;
/** b-guard 的守家窗口：每 600 個 tick 的前 100 個。 */
const GUARD_EVERY = 600;
const GUARD_OPEN = 100;

/**
 * 把設定變成控制器。`withOpp` 為 false 時機器看不到對手（(b)）；為 true 時多一份對手的公開狀態（(c)）。
 */
function machine(cfg: Config, withOpp: boolean): Controller<DJState> {
  let phase: 'collect' | 'raid' | 'guard' = 'collect';
  let waited = 0;
  let lastWindow = -1;
  let raid1Done = false;
  let guardedTicks = 0;
  let raidCooldownUntil = 0;
  let guardCooldownUntil = 0;
  let target: number | null = null;
  let heading: Dir | null = null;

  const read = (state: DJState, side: Side): OppView | null => {
    if (!withOpp) {
      return null;
    }
    const opp = state.players[other(side)];
    return {
      cell: opp.cell,
      score: opp.score,
      bag: state.bags[other(side)],
      lurk: state.lurk[other(side)],
    };
  };

  return {
    decide(state: DJState, side: Side): Buttons {
      if (state.over || cfg.stay === true) {
        return NONE;
      }
      const walls = state.walls;
      const me = state.players[side];
      const bag = state.bags[side];
      const base = START_CELLS[side];
      const rival = START_CELLS[other(side)];
      const t = state.tick;
      const left = state.maxTicks - t;
      const dMe = bfsDistances(walls, me.cell);
      const fromBase = bfsDistances(walls, base);
      const dBase = dMe[base] as number;
      const opp = read(state, side);
      const forced = bag > 0 && MOVE_EVERY * dBase + 10 >= left;
      const oppToBase = opp === null ? null : (fromBase[opp.cell] as number);
      const gate =
        opp !== null && opp.score >= 1 && manhattan(opp.cell, rival) > STEAL_RANGE + GUARD_RANGE;

      const go = (goal: number): Buttons => {
        const dir = toward(walls, me.cell, side, goal, heading);
        heading = dir;
        return dir === null ? NONE : press(dir);
      };

      // ---- 離開偷／守 ----
      if (phase === 'raid') {
        const atRival = manhattan(me.cell, rival) <= STEAL_RANGE;
        if (atRival) {
          waited += 1;
        }
        if (opp !== null && manhattan(opp.cell, rival) <= GUARD_RANGE) {
          guardedTicks += 1;
        } else {
          guardedTicks = 0;
        }
        const keep =
          opp === null || cfg.raid === 'blind1' || cfg.raid === 'blindRep'
            ? true
            : opp.score >= 1 && guardedTicks < 30;
        if (forced || bag >= BAG_LIMIT || waited >= RAID_WAIT || !keep) {
          phase = 'collect';
          waited = 0;
          guardedTicks = 0;
          raidCooldownUntil = t + RAID_COOLDOWN;
        }
      } else if (phase === 'guard') {
        const atHome = manhattan(me.cell, base) <= 1;
        if (atHome) {
          waited += 1;
        }
        let keep: boolean;
        if (cfg.guard === 'blind') {
          keep = t % GUARD_EVERY < GUARD_OPEN;
        } else if (opp === null) {
          keep = false;
        } else if (cfg.guard === 'lurk') {
          keep = opp.lurk >= 1 || waited < 60;
        } else {
          keep = me.score >= 1 && (oppToBase as number) <= THREAT_STEPS + 4;
        }
        if (waited >= GUARD_MAX || !keep) {
          phase = 'collect';
          waited = 0;
          guardCooldownUntil = t + GUARD_COOLDOWN;
        }
      }

      // ---- 進入偷／守 ----
      if (phase === 'collect' && !forced) {
        let guardNow = false;
        if (t >= guardCooldownUntil && me.score >= 1) {
          if (cfg.guard === 'blind') {
            guardNow = t % GUARD_EVERY < GUARD_OPEN;
          } else if (cfg.guard === 'threat' && opp !== null) {
            guardNow = opp.bag < BAG_LIMIT && (oppToBase as number) <= THREAT_STEPS;
          } else if (cfg.guard === 'lurk' && opp !== null) {
            guardNow = opp.lurk >= 1;
          }
        }
        if (guardNow) {
          phase = 'guard';
          waited = 0;
        } else if (bag === 0 && cfg.raid !== 'none') {
          const reach = MOVE_EVERY * ((dMe[rival] as number) + (fromBase[rival] as number));
          const fits = left >= reach + RAID_WAIT + 20;
          const window = Math.floor((t - WINDOW_FROM) / WINDOW_EVERY);
          const open = window >= 0 && t - WINDOW_FROM - WINDOW_EVERY * window < WINDOW_OPEN;
          let start = false;
          if (fits) {
            if (cfg.raid === 'blind1') {
              start = !raid1Done && t >= RAID1_FROM;
            } else if (cfg.raid === 'blindRep') {
              start = open && window > lastWindow;
            } else if (cfg.raid === 'read1') {
              start = !raid1Done && t >= RAID1_FROM && gate;
            } else if (cfg.raid === 'readRep') {
              start = open && window > lastWindow && gate;
            } else {
              start = t >= WINDOW_FROM && t >= raidCooldownUntil && gate;
            }
          }
          if (start) {
            phase = 'raid';
            waited = 0;
            guardedTicks = 0;
            if (cfg.raid === 'blind1' || cfg.raid === 'read1') {
              raid1Done = true;
            }
            if (cfg.raid === 'blindRep' || cfg.raid === 'readRep') {
              lastWindow = window;
            }
          }
        }
      }

      // ---- 動作 ----
      if (phase === 'raid') {
        return manhattan(me.cell, rival) <= STEAL_RANGE ? NONE : go(rival);
      }
      if (phase === 'guard') {
        if (me.cell === base || (bag === 0 && manhattan(me.cell, base) <= 1)) {
          return NONE;
        }
        return go(base);
      }
      // 撿。
      if (bag > 0 && (forced || bag >= cfg.n)) {
        return me.cell === base ? NONE : go(base);
      }
      let radius = cfg.radius;
      if (radius !== null && cfg.roam === true && oppToBase !== null && oppToBase > ROAM_FAR) {
        radius = ROAM_STEPS;
      }
      let best = -1;
      let bestD = UNREACHABLE;
      const kept: number[] = [];
      for (const coin of state.coins) {
        if (coin === me.cell) {
          continue; // 站在金幣上的那一格不算目標（延遲時舊世界可能還有我剛撿的那一枚）
        }
        const d = dMe[coin] as number;
        const home = fromBase[coin] as number;
        if (d >= UNREACHABLE || MOVE_EVERY * (d + home) + 10 > left) {
          continue;
        }
        if (radius !== null && home > radius) {
          continue;
        }
        kept.push(coin);
        if (d < bestD || (d === bestD && rank(coin, side) < rank(best, side))) {
          best = coin;
          bestD = d;
        }
      }
      if (best < 0) {
        target = null;
        if (bag > 0) {
          return me.cell === base ? NONE : go(base);
        }
        if (radius !== null && dBase > 3) {
          return go(base);
        }
        return NONE;
      }
      if (target === null || !kept.includes(target) || (dMe[target] as number) > bestD + 2) {
        target = best;
      }
      return go(target);
    },
  };
}

/** 一個成員的控制器（每次呼叫都是全新的）。 */
export function member(name: string): Controller<DJState> {
  if ((B_FAMILY as readonly string[]).includes(name)) {
    return machine(ruleB(name), false);
  }
  return machine(ruleC(name), true);
}

/**
 * 反應延遲：世界是 `delay` 個 tick 前的（對手、新出現的金幣都是舊的），自己的按鍵用 `game.step` 照原樣重播到現在
 * （對手當作沒動），所以自己的位置、背包、撿過的金幣是現在的——和 AI 的 `wrapPolicy` 同一個語意，但這裡是自己的包裝，
 * 不是 `wrapPolicy`。
 */
export function withDelay<S>(inner: Controller<S>, delay: number, game: Game<S>): Controller<S> {
  if (delay <= 0) {
    return inner;
  }
  const states = new Map<number, S>();
  const outputs = new Map<number, Buttons>();
  return {
    decide(state: S, side: Side, tick: number): Buttons {
      states.set(tick, state);
      const from = Math.max(0, tick - delay);
      let view = states.get(from) ?? state;
      for (let k = from; k < tick && !game.isOver(view); k += 1) {
        const mine = outputs.get(k) ?? NONE;
        view = game.step(view, side === 0 ? [mine, NONE] : [NONE, mine]);
      }
      const out = { ...inner.decide(view, side, tick) };
      outputs.set(tick, out);
      states.delete(tick - delay - 1);
      outputs.delete(tick - delay - 1);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// 對局
// ---------------------------------------------------------------------------

/** 一格：AI 的性格、等級；玩家的反應延遲（tick）。 */
export interface Cell {
  readonly policy: PolicyKey;
  readonly level: number;
  readonly delay: number;
}

export const MAIN_CELL: Cell = { policy: 'greedy', level: 10, delay: 12 };

/** 玩家（`ctl`）對 AI 跑一場；偶數種子玩家坐 0 號邊，奇數種子坐 1 號邊。 */
export function playWith(seed: number, ctl: Controller<DJState>, at: Cell): MatchOutcome {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const ai = levelController(dJGame, policyByName(at.policy), at.level, seed + AI_SEED_OFFSET);
  const mine = withDelay(ctl, at.delay, dJGame);
  const result =
    side === 0
      ? playMatch(dJGame, seed, CONFIG, mine, ai)
      : playMatch(dJGame, seed, CONFIG, ai, mine);
  return outcomeOf(result, side);
}

/**
 * D-J 的「一次決策」：走格週期的第一個 tick，而且至少一邊已經存了分數（沒有人存過分數時沒有偷也沒有守可談）。
 * 玩家每個走格週期選一次方向，其餘 4 個 tick 是同一個決定的重複。
 */
export const isPoint: IsPoint<DJState> = (state) =>
  state.tick % MOVE_EVERY === 0 && state.players[0].score + state.players[1].score >= 1;

/** 把兩個成員接成一份 `ProbeSpec`。 */
export function spec(
  b: string,
  c: string,
  seeds: readonly number[],
  at: Cell,
  withPoint = true,
): ProbeSpec<DJState> {
  return {
    makeB: () => member(b),
    makeC: () => member(c),
    seeds,
    play: (seed, ctl) => playWith(seed, ctl, at),
    isPoint: withPoint ? isPoint : undefined,
  };
}

// ---------------------------------------------------------------------------
// 選法
// ---------------------------------------------------------------------------

export interface Row {
  readonly name: string;
  /** 勝率（0 到 1，和局 0.5）。 */
  readonly win: number;
  /** 平均分差（我方 − AI）。 */
  readonly margin: number;
}

/** 一個成員在一組種子上的勝率與平均分差。 */
export function score(name: string, seeds: readonly number[], at: Cell): Row {
  let win = 0;
  let margin = 0;
  for (const seed of seeds) {
    const o = playWith(seed, member(name), at);
    win += o.win;
    margin += o.margin;
  }
  return { name, win: win / seeds.length, margin: margin / seeds.length };
}

/**
 * 選最強的（量之前固定的規則）：勝率最高；同勝率取平均分差高的；再同就取表中靠前的。
 * 「同」比較的是四捨五入到 1e-9 之後的值，免得浮點誤差破平。
 */
export function selectBest(rows: readonly Row[]): Row {
  let best = rows[0] as Row;
  const eq = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
  for (const row of rows.slice(1)) {
    if (row.win > best.win + 1e-9 || (eq(row.win, best.win) && row.margin > best.margin + 1e-9)) {
      best = row;
    }
  }
  return best;
}
