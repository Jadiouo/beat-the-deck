import { levelController, policyByName } from '../../ai/level';
import type { PolicyKey } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, GameConfig, Side } from '../../core/types';
import { outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { IsPoint, MatchOutcome, ProbeSpec } from '../../../tests/ai/probe-a.shared';
import { MOVE_EVERY, bfsDistances, nextCell, stepTarget } from '../_diamonds/logic';
import type { Dir, Walker } from '../_diamonds/logic';
import { MINE_REACH, SOLO_YIELD, ZONE_RADIUS, dQGame, hazardPermille, zoneDistance } from './logic';
import type { DQState } from './logic';

/**
 * D-Q 探針 A（完整版）的量測工具（`docs/cards/D-Q.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61）。
 * 只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。**(b)、(c) 兩族與選法在量之前寫進小規格並 push，量完不改。**
 *
 * 所有成員共用同一套「走路」（走到礦邊、走出礦坑範圍存礦、走到下一個礦等著），差別只在兩個決定：
 *   `leave`：身上有礦石時，現在要不要往外走存起來；
 *   `camp`：身上沒有礦石時，要回礦邊再挖，還是先去下一個礦等著（卡位）。
 * - (b) 族：知道有對手（所以挖礦量可能被分走、塌了之後要搶下一個礦），但**不讀對手的任何狀態**
 *   （位置、身上的礦石、分數、礦石被埋的紀錄）。只准讀：tick、礦與下一個礦的位置、`age`、自己的位置與礦石。
 * - (c) 族：讀對手的公開狀態（位置、分數、身上的礦石）。**沒有 import `evaluate`、`predictOpponent`，也沒有拿 AI 的控制器當成員。**
 */

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };
/** AI 的種子 ＝ 玩家種子 ＋ 這個數（慣例同 D-10 與 S-10 的探針）。 */
export const AI_SEED_OFFSET = 1_000_003;
/** 最後這麼多個 tick 之內，身上有礦石就一律往外走（時間到身上的礦石不算分）。 */
export const ENDGAME_TICKS = 60;

export const B_FAMILY = [
  'b-N4W12',
  'b-N6W12',
  'b-N8W15',
  'b-N10W25',
  'b-N3W8',
  'b-ev2',
  'b-ev15',
  'b-ev1',
  'b-ev1-camp10',
  'b-ev1-camp20',
  'b-ev2-camp10',
  'b-stay',
] as const;

export const C_FAMILY = [
  'c-ev-yield',
  'c-ev-yield-low',
  'c-thr-yield',
  'c-opp-left',
  'c-race',
  'c-race-ev1',
  'c-lead',
  'c-lead-ev1',
  'c-ev-yield-race',
] as const;

export type MemberName = (typeof B_FAMILY)[number] | (typeof C_FAMILY)[number];

// ---------------------------------------------------------------------------
// 走路
// ---------------------------------------------------------------------------

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const DIRS: readonly Dir[] = [0, 1, 2, 3];

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

const FIELDS = new WeakMap<readonly number[], Map<number, Int32Array>>();
/** 到 `target` 的繞牆步數場（依牆陣列與目標快取；只讀）。 */
function fieldTo(walls: readonly number[], target: number): Int32Array {
  let byTarget = FIELDS.get(walls);
  if (byTarget === undefined) {
    byTarget = new Map();
    FIELDS.set(walls, byTarget);
  }
  let field = byTarget.get(target);
  if (field === undefined) {
    field = bfsDistances(walls, target);
    byTarget.set(target, field);
  }
  return field;
}

/** 往 `target` 走一步的方向（已經在上面或沒有更近的走法就全放開）。 */
function toward(walls: readonly number[], from: number, target: number): Buttons {
  if (from === target) {
    return NONE;
  }
  const field = fieldTo(walls, target);
  let best: Dir | null = null;
  let bestDistance = field[from] as number;
  for (const dir of DIRS) {
    const next = stepTarget(walls, from, dir);
    if (next !== from && (field[next] as number) < bestDistance) {
      bestDistance = field[next] as number;
      best = dir;
    }
  }
  return best === null ? NONE : press(best);
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);

/** 礦坑範圍外、離 `from` 最近的格子（同距離取離下一個礦近的）：存礦要走到的地方。 */
function exitCell(state: DQState, from: number): number {
  const mine = state.mine;
  const mineField = fieldTo(state.walls, from);
  const nextField = fieldTo(state.walls, state.next);
  let best = -1;
  let bestKey = Number.POSITIVE_INFINITY;
  for (let c = 0; c < state.walls.length; c += 1) {
    if (state.walls[c] !== 0 || zoneDistance(c, mine) <= ZONE_RADIUS) {
      continue;
    }
    const d = mineField[c] as number;
    const key = d * 10_000 + (nextField[c] as number);
    if (key < bestKey) {
      bestKey = key;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 規則的情境（成員只能從這裡讀東西）
// ---------------------------------------------------------------------------

export interface Ctx {
  readonly state: DQState;
  readonly side: Side;
  readonly me: Walker;
  /** 我身上的礦石。 */
  readonly carried: number;
  /** 這個礦已經開挖幾次。 */
  readonly age: number;
  /** 下一次開挖塌的機率（0 到 1）。 */
  readonly p: number;
}

/** (c) 才准用：對手的公開狀態。(b) 的規則函式拿不到它（型別上就沒有）。 */
export interface OppView {
  readonly opp: Walker;
  readonly oppCarried: number;
}

const ctxOf = (state: DQState, side: Side): Ctx => ({
  state,
  side,
  me: state.players[side],
  carried: state.carried[side],
  age: state.age,
  p: hazardPermille(state.age + 1) / 1000,
});

const oppOf = (state: DQState, side: Side): OppView => ({
  opp: state.players[other(side)],
  oppCarried: state.carried[other(side)],
});

/** 對手下一步會不會在挖礦範圍裡（挖礦量被分走）。 */
const oppOnMine = (state: DQState, view: OppView): boolean =>
  zoneDistance(nextCell(state.walls, view.opp), state.mine) <= MINE_REACH;

/** 一次多挖的期望收益對上塌的期望損失：留一次不如走時就走。`y` 是假設的每次挖礦量，`k` 是怕的程度。 */
const evLeave = (ctx: Ctx, y: number, k: number): boolean => k * ctx.p * (ctx.carried + y) > y;

interface Rule {
  /** 身上有礦石時：要不要往外走。 */
  leave(ctx: Ctx): boolean;
  /** 身上沒有礦石時：要不要先去下一個礦等著（否則回礦邊）。 */
  camp(ctx: Ctx): boolean;
}

const thresholds = (n: number, w: number): Rule => ({
  leave: (ctx) => ctx.carried >= n || ctx.age >= w,
  camp: (ctx) => ctx.age >= w,
});

const expectedValue = (y: number, campAge: number): Rule => ({
  leave: (ctx) => evLeave(ctx, y, 1),
  camp: (ctx) => ctx.age >= campAge,
});

/** (b) 的規則：只拿得到 `Ctx`。 */
function ruleB(name: string): Rule {
  switch (name) {
    case 'b-N4W12':
      return thresholds(4, 12);
    case 'b-N6W12':
      return thresholds(6, 12);
    case 'b-N8W15':
      return thresholds(8, 15);
    case 'b-N10W25':
      return thresholds(10, 25);
    case 'b-N3W8':
      return thresholds(3, 8);
    case 'b-ev2':
      return expectedValue(SOLO_YIELD, 15);
    case 'b-ev15':
      return expectedValue(1.5, 15);
    case 'b-ev1':
      return expectedValue(1, 15);
    case 'b-ev1-camp10':
      return expectedValue(1, 10);
    case 'b-ev1-camp20':
      return expectedValue(1, 20);
    case 'b-ev2-camp10':
      return expectedValue(SOLO_YIELD, 10);
    case 'b-stay':
      return { leave: () => false, camp: () => false };
    default:
      throw new Error(`不是 (b) 的成員：${name}`);
  }
}

/** (c) 的規則：多拿到 `OppView`。 */
function ruleC(name: string): {
  leave(ctx: Ctx, view: OppView): boolean;
  camp(ctx: Ctx, view: OppView): boolean;
} {
  const sameMineAs = (ctx: Ctx, view: OppView): boolean => oppOnMine(ctx.state, view);
  const myLead = (ctx: Ctx, view: OppView): number => ctx.me.score - view.opp.score;
  const toNext = (ctx: Ctx, c: number): number =>
    fieldTo(ctx.state.walls, ctx.state.next)[c] as number;
  switch (name) {
    // 對手也在礦邊就只挖得到 1，否則 2：用當下看到的挖礦量算期望。
    case 'c-ev-yield':
      return {
        leave: (ctx, view) => evLeave(ctx, sameMineAs(ctx, view) ? 1 : SOLO_YIELD, 1),
        camp: (ctx) => ctx.age >= 15,
      };
    // 同上，但整個縮一檔（對手也在礦邊算 0.7，只有我一個人算 1.5）：延遲 12 的格子上保守比較好。
    case 'c-ev-yield-low':
      return {
        leave: (ctx, view) => evLeave(ctx, sameMineAs(ctx, view) ? 0.7 : 1.5, 1),
        camp: (ctx) => ctx.age >= 15,
      };
    // 同上，但用存量門檻：對手也在礦邊存 3 塊就走，只有我一個人存到 8 塊才走。
    case 'c-thr-yield':
      return {
        leave: (ctx, view) => ctx.carried >= (sameMineAs(ctx, view) ? 3 : 8) || ctx.age >= 15,
        camp: (ctx) => ctx.age >= 15,
      };
    // 對手已經離開礦坑範圍（存礦去了）：礦邊只剩我一個，獨吞，比較敢留；它還在範圍裡：照 1.2 塊算。
    case 'c-opp-left':
      return {
        leave: (ctx, view) => {
          const left = zoneDistance(view.opp.cell, ctx.state.mine) > ZONE_RADIUS;
          return left ? evLeave(ctx, SOLO_YIELD, 0.8) : evLeave(ctx, 1.2, 1);
        },
        camp: (ctx) => ctx.age >= 15,
      };
    // 搶下一個礦：我比對手更近（繞牆步數）而且礦已經 8 次以上就先去卡位，否則 18 次才去。
    case 'c-race':
      return {
        leave: (ctx) => evLeave(ctx, SOLO_YIELD, 1),
        camp: (ctx, view) => {
          const ahead = toNext(ctx, ctx.me.cell) <= toNext(ctx, view.opp.cell);
          return ctx.age >= (ahead ? 8 : 18);
        },
      };
    // c-race 的存礦規則換成 y ＝ 1。
    case 'c-race-ev1':
      return {
        leave: (ctx) => evLeave(ctx, 1, 1),
        camp: (ctx, view) => {
          const ahead = toNext(ctx, ctx.me.cell) <= toNext(ctx, view.opp.cell);
          return ctx.age >= (ahead ? 8 : 18);
        },
      };
    // 領先 6 分以上就保守（怕 1.5 倍），落後 6 分以上就賭（怕 0.7 倍），否則 1 倍。
    case 'c-lead':
      return {
        leave: (ctx, view) => {
          const lead = myLead(ctx, view);
          return evLeave(ctx, SOLO_YIELD, lead >= 6 ? 1.5 : lead <= -6 ? 0.7 : 1);
        },
        camp: (ctx) => ctx.age >= 15,
      };
    // c-lead 的基準換成 y ＝ 1。
    case 'c-lead-ev1':
      return {
        leave: (ctx, view) => {
          const lead = myLead(ctx, view);
          return evLeave(ctx, 1, lead >= 6 ? 1.5 : lead <= -6 ? 0.7 : 1);
        },
        camp: (ctx) => ctx.age >= 15,
      };
    // c-ev-yield ＋ c-race 的卡位。
    case 'c-ev-yield-race':
      return {
        leave: (ctx, view) => evLeave(ctx, sameMineAs(ctx, view) ? 1 : SOLO_YIELD, 1),
        camp: (ctx, view) => {
          const ahead = toNext(ctx, ctx.me.cell) <= toNext(ctx, view.opp.cell);
          return ctx.age >= (ahead ? 8 : 18);
        },
      };
    default:
      throw new Error(`不是 (c) 的成員：${name}`);
  }
}

// ---------------------------------------------------------------------------
// 成員 → 控制器
// ---------------------------------------------------------------------------

/**
 * 把規則變成控制器。「往外走」一旦開始就走到存進去為止（身上的礦石歸零才重算），
 * 免得規則在走出去的半路上來回翻。
 */
function walker(
  leaveRule: (ctx: Ctx, state: DQState, side: Side) => boolean,
  campRule: (ctx: Ctx, state: DQState, side: Side) => boolean,
): Controller<DQState> {
  let leaving = false;
  return {
    decide(state: DQState, side: Side): Buttons {
      if (state.over) {
        return NONE;
      }
      const ctx = ctxOf(state, side);
      const from = ctx.me.cell;
      if (ctx.carried === 0) {
        leaving = false;
      } else if (!leaving) {
        leaving = state.maxTicks - state.tick <= ENDGAME_TICKS || leaveRule(ctx, state, side);
      }
      if (leaving) {
        return toward(state.walls, from, exitCell(state, from));
      }
      if (
        ctx.carried === 0 &&
        state.maxTicks - state.tick > ENDGAME_TICKS &&
        campRule(ctx, state, side)
      ) {
        return toward(state.walls, from, state.next);
      }
      // 回礦邊（或留在礦邊）挖。
      if (zoneDistance(from, state.mine) <= MINE_REACH) {
        return NONE;
      }
      return toward(state.walls, from, state.mine);
    },
  };
}

/** 一個成員的控制器（每次呼叫都是全新的）。 */
export function member(name: string): Controller<DQState> {
  if ((B_FAMILY as readonly string[]).includes(name)) {
    const rule = ruleB(name);
    return walker(
      (ctx) => rule.leave(ctx),
      (ctx) => rule.camp(ctx),
    );
  }
  const rule = ruleC(name);
  return walker(
    (ctx, state, side) => rule.leave(ctx, oppOf(state, side)),
    (ctx, state, side) => rule.camp(ctx, oppOf(state, side)),
  );
}

/** 反應延遲：世界是 `delay` 個 tick 前的，自己的位置與待走方向是現在的（同 AI 的 `wrapPolicy`）。 */
export function withDelay(inner: Controller<DQState>, delay: number): Controller<DQState> {
  if (delay <= 0) {
    return inner;
  }
  const seen = new Map<number, DQState>();
  return {
    decide(state: DQState, side: Side, tick: number): Buttons {
      seen.set(tick, state);
      seen.delete(tick - delay - 1);
      const old = seen.get(tick - delay) ?? seen.get(Math.max(0, tick - delay)) ?? state;
      const players = [old.players[0], old.players[1]] as [Walker, Walker];
      players[side] = state.players[side];
      return inner.decide({ ...old, players }, side, tick);
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

export const MAIN_CELL: Cell = { policy: 'precise', level: 10, delay: 0 };

/** 玩家（`ctl`）對 AI 跑一場；偶數種子玩家坐 0 號邊，奇數種子坐 1 號邊。 */
export function playWith(seed: number, ctl: Controller<DQState>, at: Cell): MatchOutcome {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const ai = levelController(dQGame, policyByName(at.policy), at.level, seed + AI_SEED_OFFSET);
  const mine = withDelay(ctl, at.delay);
  const result =
    side === 0
      ? playMatch(dQGame, seed, CONFIG, mine, ai)
      : playMatch(dQGame, seed, CONFIG, ai, mine);
  return outcomeOf(result, side);
}

/**
 * D-Q 的「一次決策」：每個走格週期的第一個 tick（上一次走格剛結算完、新的方向還沒按）。
 * 玩家每個走格週期選一次方向（或不動），其餘 4 個 tick 只是同一個決定的重複。
 */
export const isPoint: IsPoint<DQState> = (state) => state.tick % MOVE_EVERY === 0;

/** 把兩個成員接成一份 `ProbeSpec`。 */
export function spec(
  b: string,
  c: string,
  seeds: readonly number[],
  at: Cell,
  withPoint = true,
): ProbeSpec<DQState> {
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
