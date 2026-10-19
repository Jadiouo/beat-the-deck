import { levelController, policyByName, wrapPolicy } from '../../ai/level';
import { precise } from '../../ai/policies/precise';
import { HUMAN_PARAMS } from '../../ai/human-model';
import { pathfinder } from '../../ai/policies/pathfinder';
import { copyButtons } from '../../core/match';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import type { LevelParams } from '../../ai/types';
import {
  FIELD_H,
  FIELD_W,
  GONE,
  TILES,
  evaluateS9,
  evaluateWithRival,
  s9Game,
  tileAt,
  tileCenter,
} from './logic';
import type { S9Player, S9State } from './logic';

/**
 * S-9 的劇本玩家與量測工具（DESIGN-AI-FUN 5.2、10.4、10.24、10.35）。都是 Controller／Game 的包裝，只讀完整的 state，
 * 不是 `logic.ts`，不在純度掃描範圍。移動的規則全部一樣（精準型、同一個等級的決定頻率與反應延遲），
 * 劇本玩家之間只差「規劃時怎麼看對手」或「怎麼看崩落的格子」。
 */

/** 玩家真正玩到的設定（`meta.defaultMaxTicks`）；局長用它。 */
export const CONFIG = { maxTicks: 4500, params: {} };
/** 契約測試與 A1–A4 用的設定；勝率量測用它，才跟小規格的數字一致。 */
export const CONTRACT_MAX_TICKS = 3600;
export const NEUTRAL: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};

// ---------------------------------------------------------------------------
// 探針 A 的三種讀法（DESIGN-AI-FUN 10.35）
// ---------------------------------------------------------------------------

export type Reading = 'a' | 'b' | 'c';

/**
 * (b) 的預期：對手站在「我的位置轉 180 度」最近一個還站得住的格子（一個固定的先驗：對手在場地的另一邊），
 * 完全不讀它真正在哪裡。
 */
export function mirrorRival(state: S9State, side: Side): S9Player {
  const me = state.players[side];
  const mx = FIELD_W - me.x;
  const my = FIELD_H - me.y;
  if ((state.tiles[tileAt(mx, my)] as number) !== GONE) {
    return { x: mx, y: my, vx: 0, vy: 0 };
  }
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < TILES; i += 1) {
    if ((state.tiles[i] as number) === GONE) {
      continue;
    }
    const c = tileCenter(i);
    const d = (c.x - mx) ** 2 + (c.y - my) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  const c = tileCenter(best < 0 ? 0 : best);
  return { x: c.x, y: c.y, vx: 0, vy: 0 };
}

/**
 * 三種讀法的遊戲：只有 `evaluate` 不同，`step`、`actions` 與 `s9Game` 一樣。
 * a＝不知道有對手（只剩自己走得到幾格）；b＝知道有對手、但不讀它的狀態（以為它在我的對面）；c＝讀它真正的位置。
 */
export function readingGame(kind: Reading, world: Game<S9State> = s9Game): Game<S9State> {
  return {
    ...world,
    evaluate(state: S9State, side: Side) {
      if (state.phase !== 'play' || kind === 'c') {
        return evaluateS9(state, side);
      }
      return evaluateWithRival(state, side, kind === 'a' ? null : mirrorRival(state, side));
    },
  };
}

// ---------------------------------------------------------------------------
// C-8 的世界觀
// ---------------------------------------------------------------------------

/**
 * C-8 光軌的世界觀（`docs/cards/S-9.md` 與 C-8 的區隔）：任何已經被踩過、還在崩落的格子都當永久的牆；
 * 只有兩個人腳下的格子照實算（腳下的格子要在掉下去之前離開，這是在 C-8 裡「一直往前走」換來的本能，保留）。
 */
export function wallView(state: S9State): S9State {
  const own0 = tileAt(state.players[0].x, state.players[0].y);
  const own1 = tileAt(state.players[1].x, state.players[1].y);
  const tiles = state.tiles.map((t, i) => (i === own0 || i === own1 ? t : t > 0 ? GONE : t));
  return { ...state, tiles };
}

export function wallGame(world: Game<S9State> = s9Game): Game<S9State> {
  return {
    ...world,
    evaluate(state: S9State, side: Side) {
      if (state.phase !== 'play') {
        return evaluateS9(state, side);
      }
      // 只換「領地與餘裕怎麼算」（gain）；danger（走進洞、站在洞邊、被困）照真的地板算，這樣差別只來自時間這一件事。
      return {
        gain: evaluateS9(wallView(state), side).gain,
        danger: evaluateS9(state, side).danger,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

/** 這張牌的預設 AI（精準型）在某個等級。 */
export function ai(
  level: number,
  seed: number,
  world: Game<S9State> = s9Game,
): Controller<S9State> {
  return levelController(world, policyByName('precise'), level, seed);
}

/** 人類模型（SPEC 7.3）。 */
export function humanModel(seed: number, world: Game<S9State> = s9Game): Controller<S9State> {
  return wrapPolicy(world, pathfinder, HUMAN_PARAMS, seed);
}

/** 不會按錯的人：人類模型的反應延遲與換動作頻率，但不亂按（ε = 0）、底層是精準型。 */
export const NO_BLUNDER: LevelParams = { reactionTicks: 12, decideEvery: 6, depth: 1, epsilon: 0 };

export function strongHuman(seed: number, world: Game<S9State> = s9Game): Controller<S9State> {
  return wrapPolicy(world, precise, NO_BLUNDER, seed);
}

/** 用某種讀法、某組參數的精準型。 */
export function reader(
  kind: Reading,
  params: LevelParams,
  seed: number,
  world: Game<S9State> = s9Game,
): Controller<S9State> {
  return wrapPolicy(readingGame(kind, world), precise, params, seed);
}

/** 站著不動（腳下的格子 45 tick 後掉）。 */
export const idler: Controller<S9State> = {
  decide: (): Buttons => ({ ...NEUTRAL }),
};

/** 一直往一個方向走，碰到場地邊緣就換個方向（不看格子）。 */
export function straightRunner(): Controller<S9State> {
  const turns = ['right', 'down', 'left', 'up'] as const;
  return {
    decide(state: S9State, side: Side): Buttons {
      const p = state.players[side];
      const turn = Math.floor(state.roundTick / 90) % 4;
      const key = turns[(turn + (side === 0 ? 0 : 2)) % 4] as 'right' | 'down' | 'left' | 'up';
      const blocked =
        (key === 'right' && p.x > FIELD_W - 8) ||
        (key === 'left' && p.x < 8) ||
        (key === 'down' && p.y > FIELD_H - 8) ||
        (key === 'up' && p.y < 8);
      return { ...NEUTRAL, [key]: !blocked };
    },
  };
}

// ---------------------------------------------------------------------------
// 量測工具
// ---------------------------------------------------------------------------

export interface RoundRecord {
  readonly length: number;
  readonly outcome: 'side0' | 'side1' | 'draw';
  readonly fell: readonly [boolean, boolean];
}

export interface MatchRecord {
  readonly rounds: readonly RoundRecord[];
  readonly ticks: number;
  readonly winner: Side | null;
}

export type MakeController = (seed: number) => Controller<S9State>;

/**
 * 打一場並記下每一回合（長度、誰贏、誰掉了）。`first` 坐 0 號邊、`second` 坐 1 號邊。
 * 兩邊的控制器各用自己的種子（第二個加 1_000_003）。
 */
export function playRecorded(
  seed: number,
  first: MakeController,
  second: MakeController,
  world: Game<S9State> = s9Game,
  maxTicks: number = CONFIG.maxTicks,
): MatchRecord {
  const config = { maxTicks, params: {} };
  const c0 = first(seed);
  const c1 = second(seed + 1_000_003);
  let state = world.init(seed, config);
  const rounds: RoundRecord[] = [];
  let tick = 0;
  while (!world.isOver(state)) {
    const inputs = [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ] as const;
    const before = state;
    state = world.step(state, inputs);
    tick += 1;
    if (before.phase === 'play' && state.phase !== 'play') {
      rounds.push({
        length: before.roundTick + 1,
        outcome: state.outcome ?? 'draw',
        fell: state.fell,
      });
    }
  }
  return { rounds, ticks: state.tick, winner: world.winner(state) };
}

/** 每個 tick 前後各一個 state 與這個 tick 的輸入；`playObserved` 用。 */
export type TickObserver = (
  before: S9State,
  after: S9State,
  inputs: readonly [Buttons, Buttons],
) => void;

/** 跟 `playRecorded` 一樣打一場，但每個 tick 把前後的 state 與輸入交給 `observe`（量走位、尾跡之類）。 */
export function playObserved(
  seed: number,
  first: MakeController,
  second: MakeController,
  observe: TickObserver,
  world: Game<S9State> = s9Game,
  maxTicks: number = CONFIG.maxTicks,
): MatchRecord {
  const config = { maxTicks, params: {} };
  const c0 = first(seed);
  const c1 = second(seed + 1_000_003);
  let state = world.init(seed, config);
  const rounds: RoundRecord[] = [];
  let tick = 0;
  while (!world.isOver(state)) {
    const inputs = [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ] as const;
    const before = state;
    state = world.step(state, inputs);
    tick += 1;
    observe(before, state, inputs);
    if (before.phase === 'play' && state.phase !== 'play') {
      rounds.push({
        length: before.roundTick + 1,
        outcome: state.outcome ?? 'draw',
        fell: state.fell,
      });
    }
  }
  return { rounds, ticks: state.tick, winner: world.winner(state) };
}

/**
 * `subject` 對 `rival` 的勝率（平手算半場）：偶數種子 `subject` 坐 0 號邊、奇數坐 1 號邊。
 */
export function winPercent(
  subject: MakeController,
  rival: MakeController,
  seeds: readonly number[],
  world: Game<S9State> = s9Game,
  maxTicks: number = CONTRACT_MAX_TICKS,
): number {
  let points = 0;
  for (const seed of seeds) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const m =
      side === 0
        ? playRecorded(seed, subject, rival, world, maxTicks)
        : playRecorded(seed, rival, subject, world, maxTicks);
    points += m.winner === null ? 0.5 : m.winner === side ? 1 : 0;
  }
  return (100 * points) / seeds.length;
}

/** 一串數字的百分位（0 到 1）。 */
export function quantile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] as number;
}
