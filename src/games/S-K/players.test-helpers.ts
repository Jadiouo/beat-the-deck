import { levelController, wrapPolicy } from '../../ai/level';
import { HUMAN_PARAMS } from '../../ai/human-model';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { LevelParams } from '../../ai/types';
import { copyButtons, playMatch } from '../../core/match';
import type { Buttons, Controller, Side } from '../../core/types';
import { marginMilli, skGame } from './logic';
import type { SKState } from './logic';
import { poolEntry, POOL } from './pool';

/**
 * S-K 的劇本玩家與量測工具（DESIGN-AI-FUN 5.2、10.4、10.24、10.35、10.40）。
 * 都是 Controller 的包裝，只讀完整的 state，不是 `logic.ts`，不在純度掃描範圍。
 * 劇本玩家之間「打的時候」完全一樣，只差「挑牌的時候怎麼挑」，所以差異只來自選牌層。
 */

/** 玩家真正玩到的設定（`meta.defaultMaxTicks`）。 */
export const CONFIG = { maxTicks: 5400, params: {} };
/** 契約測試與 A1–A4 用的設定。 */
export const CONTRACT_MAX_TICKS = 3600;
export const NEUTRAL: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};
const KEYS = ['up', 'down', 'left', 'right'] as const;

export type MakeController = (seed: number) => Controller<SKState>;

export const NO_BLUNDER: LevelParams = { reactionTicks: 12, decideEvery: 6, depth: 1, epsilon: 0 };

export function ai(level: number, seed: number): Controller<SKState> {
  return levelController(skGame, precise, level, seed);
}

export const level =
  (n: number): MakeController =>
  (seed) =>
    ai(n, seed);

export function humanModel(seed: number): Controller<SKState> {
  return wrapPolicy(skGame, pathfinder, HUMAN_PARAMS, seed);
}

/** 不會按錯的人：人類模型的反應延遲與換動作頻率，但不亂按、底層是精準型。 */
export function strongHuman(seed: number): Controller<SKState> {
  return wrapPolicy(skGame, precise, NO_BLUNDER, seed);
}

// ---------------------------------------------------------------------------
// 劇本玩家：打的時候用 `play`，輪到自己挑牌時照 `rule` 按
// ---------------------------------------------------------------------------

/** 選牌規則：回傳第幾張候選牌（0 到 3）。 */
export type PickRule = (state: SKState, side: Side) => number;

/** 挑牌階段先等 12 tick 再按（人看到候選牌要時間；AI 的反應延遲也是 12）。 */
export const PICK_DELAY = 12;

/**
 * 包一個「打的時候」的控制器：每個 tick 都照問它（它自己的歷史要連續），
 * 只有輪到自己挑牌時才把輸出換成 `rule` 的選擇。
 */
export function scripted(play: Controller<SKState>, rule: PickRule): Controller<SKState> {
  return {
    decide(state: SKState, side: Side, tick: number): Buttons {
      const played = play.decide(state, side, tick);
      if (state.phase === 'pick' && state.picker === side) {
        if (state.phaseTick < PICK_DELAY) {
          return { ...NEUTRAL };
        }
        const index = rule(state, side);
        return { ...NEUTRAL, [KEYS[index] as string]: true };
      }
      return copyButtons(played);
    },
  };
}

const sigmaOf = (id: string): number => poolEntry(id).sigma;

export const ruleFirst: PickRule = () => 0;
export const ruleStable: PickRule = (state) => {
  let best = 0;
  state.offer.forEach((id, i) => {
    if (sigmaOf(id) < sigmaOf(state.offer[best] as string)) {
      best = i;
    }
  });
  return best;
};
export const ruleRisky: PickRule = (state) => {
  let best = 0;
  state.offer.forEach((id, i) => {
    if (sigmaOf(id) > sigmaOf(state.offer[best] as string)) {
      best = i;
    }
  });
  return best;
};
/** AI 自己的挑牌規則（貪心型：挑 E 最高的，也就是我在成績最好的那個家族）。 */
export const ruleOwnBestFamily: PickRule = (state, side) => {
  const pressed = greedy.decide(skGame, state, side, 0, { depth: 1, seed: 0 });
  const index = KEYS.findIndex((k) => pressed[k]);
  return index < 0 ? 0 : index;
};
/** 查表：挑表裡數字最大的那張（表裡沒有的牌是 −∞）。 */
export function ruleTable(table: Readonly<Record<string, number>>): PickRule {
  return (state) => {
    let best = 0;
    state.offer.forEach((id, i) => {
      if ((table[id] ?? -Infinity) > (table[state.offer[best] as string] ?? -Infinity)) {
        best = i;
      }
    });
    return best;
  };
}

// ---------------------------------------------------------------------------
// 量測工具
// ---------------------------------------------------------------------------

export interface Played {
  readonly winner: Side | null;
  readonly ticks: number;
  readonly score: readonly [number, number];
  readonly final: SKState;
}

/** 打一整場（`first` 坐 0 號邊，`second` 坐 1 號邊），回傳終局。 */
export function playOne(
  seed: number,
  first: MakeController,
  second: MakeController,
  maxTicks: number = CONFIG.maxTicks,
): Played {
  const config = { maxTicks, params: {} };
  const c0 = first(seed);
  const c1 = second(seed + 1_000_003);
  let state = skGame.init(seed, config);
  let tick = 0;
  while (!skGame.isOver(state)) {
    state = skGame.step(state, [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ]);
    tick += 1;
  }
  return {
    winner: skGame.winner(state),
    ticks: state.tick,
    score: skGame.score(state),
    final: state,
  };
}

/** `subject` 對 `rival` 的結果：偶數種子 `subject` 坐 0 號邊、奇數坐 1 號邊。 */
export function playSeated(
  seed: number,
  subject: MakeController,
  rival: MakeController,
  maxTicks: number = CONFIG.maxTicks,
): { played: Played; side: Side; points: number; scoreDiff: number } {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const played =
    side === 0 ? playOne(seed, subject, rival, maxTicks) : playOne(seed, rival, subject, maxTicks);
  const points = played.winner === null ? 0.5 : played.winner === side ? 1 : 0;
  const mine = played.score[side] as number;
  const theirs = played.score[side === 0 ? 1 : 0] as number;
  return { played, side, points, scoreDiff: (mine - theirs) / 10 };
}

/** 勝率（平手算半場），百分比。 */
export function winPercent(
  subject: MakeController,
  rival: MakeController,
  seeds: readonly number[],
  maxTicks: number = CONFIG.maxTicks,
): number {
  let points = 0;
  for (const seed of seeds) {
    points += playSeated(seed, subject, rival, maxTicks).points;
  }
  return (100 * points) / seeds.length;
}

/** 一串數字的百分位（0 到 1）。 */
export function quantile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] as number;
}

export const mean = (values: readonly number[]): number =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

// ---------------------------------------------------------------------------
// 「這張牌單獨打」的表（探針 A 的 (b)、(c) 與「自己最強的牌」用）
// ---------------------------------------------------------------------------

/**
 * `mine` 這種玩家單獨打某張牌（衝刺長度）對 `rivalLevel` 的精準型，平均每段的 m（千分位 / 1000，自己的視角）。
 * 偶數種子坐 0 號邊。這是「這張牌我打得比對手好多少」的量，不經過選牌層。
 */
export function cardMargin(
  cardId: string,
  mine: (seed: number) => Controller<SKState>,
  rivalLevel: number,
  seeds: readonly number[],
): number {
  const card = poolEntry(cardId);
  const game = card.game;
  const scale = card.scale;
  const margins: number[] = [];
  for (const seed of seeds) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const a = mine(seed) as unknown as Controller<unknown>;
    const b = levelController(game, precise, rivalLevel, seed + 1_000_003);
    const config = { maxTicks: card.sprintTicks, params: card.params ?? {} };
    const r =
      side === 0 ? playMatch(game, seed, config, a, b) : playMatch(game, seed, config, b, a);
    const diff = (r.score[side] as number) - (r.score[side === 0 ? 1 : 0] as number);
    margins.push(marginMilli(diff, scale) / 1000);
  }
  return mean(margins);
}

/**
 * 「打單張牌」用的控制器：和 `strongHuman` 一樣的參數，但綁在那張牌自己的 Game 上
 * （S-K 的 state 不是它的 state），所以另外建。
 */
export function strongOn(cardId: string): (seed: number) => Controller<SKState> {
  const game = poolEntry(cardId).game;
  return (seed) => wrapPolicy(game, precise, NO_BLUNDER, seed) as unknown as Controller<SKState>;
}

/** 對每張池裡的牌量一次 `cardMargin`，回傳 id → 數字。 */
export function marginTable(rivalLevel: number, seeds: readonly number[]): Record<string, number> {
  const table: Record<string, number> = {};
  for (const card of POOL) {
    table[card.id] = cardMargin(card.id, strongOn(card.id), rivalLevel, seeds);
  }
  return table;
}
