import { levelController } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { copyButtons } from '../../core/match';
import type { Buttons, Controller, GameConfig, Inputs, Side } from '../../core/types';
import { IDLE, PRESS_A, PRESS_B, otherSide } from '../_hearts/logic';
import { EDGE, STAGES, hkGame } from './logic';
import type { HKState, Move } from './logic';

/**
 * H-K 的劇本玩家與量測用的小工具（給 `logic.test.ts`、`measure.test.ts` 與探針用）。
 *
 * H-K 的加倍層只有「開場決定」一個選擇，所以劇本玩家 = 一個內層控制器（打每一場被包的牌）
 * 加一條開場規則 `BetRule`。劇本玩家只在 `bet` 階段、自己還沒選時出手，其餘全部交給內層控制器。
 * 規則只讀公開資訊（籌碼、場次表、加倍牌剩幾張）；沒有亂數。
 */

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };

/** 開場規則：回傳 1 = 用加倍牌、0 = 不用。 */
export type BetRule = (state: HKState, side: Side) => Move;

/** 在 `bet` 階段、自己還沒選時用 `rule` 決定；其他時候交給 `inner`。 */
export function withBet(inner: Controller<HKState>, rule: BetRule): Controller<HKState> {
  return {
    decide(state: HKState, side: Side, tick: number): Buttons {
      if (state.phase === 'bet' && !state.over && state.pending[side] === null) {
        return rule(state, side) === 1 ? PRESS_A : PRESS_B;
      }
      return inner.decide(state, side, tick);
    },
  };
}

/** 內層：這張牌的預設性格（搜尋型）、指定的等級。 */
export function level(n: number, seed: number): Controller<HKState> {
  return levelController(hkGame, pathfinder, n, seed);
}

/** 永遠不用加倍牌。 */
export const never: BetRule = () => 0;
/** 第一場就用（有加倍牌的話）。 */
export const firstStage: BetRule = (s, side) => (s.stageIdx === 0 && s.doublers[side] > 0 ? 1 : 0);
/** 留到最後一場才用（反射規則，也是深度 1 到 2 的 AI）。 */
export const lastStage: BetRule = (s, side) =>
  s.stageIdx === STAGES - 1 && s.doublers[side] > 0 ? 1 : 0;
/** 領先（或平手）時留著當威脅、永遠不用；落後時到最後一場才用。 */
export const leadKeepTrailLast: BetRule = (s, side) =>
  s.doublers[side] > 0 && s.stageIdx === STAGES - 1 && s.chips[side] < s.chips[otherSide(side)]
    ? 1
    : 0;
/** 在剩下的場次裡，AI 自己的勝率表（EDGE）最高的那一場用；其餘場不用。只讀場次表。 */
export const bestEdge: BetRule = (s, side) => {
  if (s.doublers[side] === 0) {
    return 0;
  }
  let best = s.stageIdx;
  for (let j = s.stageIdx; j < STAGES; j += 1) {
    if (EDGE[s.stages[j] as keyof typeof EDGE][side] > EDGE[s.stages[best] as keyof typeof EDGE][side]) {
      best = j;
    }
  }
  return best === s.stageIdx ? 1 : 0;
};
/** 在剩下的場次裡，EDGE 最低的那一場用（刻意用在對自己最糟的一場）。 */
export const worstEdge: BetRule = (s, side) => {
  if (s.doublers[side] === 0) {
    return 0;
  }
  let worst = s.stageIdx;
  for (let j = s.stageIdx; j < STAGES; j += 1) {
    if (EDGE[s.stages[j] as keyof typeof EDGE][side] < EDGE[s.stages[worst] as keyof typeof EDGE][side]) {
      worst = j;
    }
  }
  return worst === s.stageIdx ? 1 : 0;
};
/** 落後就用、領先就留：籌碼比對手少就用，否則留到最後一場。 */
export const trailUse: BetRule = (s, side) => {
  if (s.doublers[side] === 0) {
    return 0;
  }
  if (s.chips[side] < s.chips[otherSide(side)]) {
    return 1;
  }
  return s.stageIdx === STAGES - 1 ? 1 : 0;
};

export interface FullMatch {
  readonly state: HKState;
  readonly ticks: number;
  readonly inputs: Inputs[];
}

/** 從 `start`（預設是 `init(seed)`）一直打到 `until` 為真或結束；回傳最後的 state 與吃掉的輸入。 */
export function playFrom(
  start: HKState,
  c0: Controller<HKState>,
  c1: Controller<HKState>,
  until: (state: HKState) => boolean = () => false,
): FullMatch {
  let state = start;
  const inputs: Inputs[] = [];
  while (!hkGame.isOver(state) && !until(state)) {
    const tick = state.tick;
    const pair: Inputs = [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ];
    inputs.push(pair);
    state = hkGame.step(state, pair);
    if (inputs.length > 4000) {
      throw new Error('H-K 走了超過 4000 個 tick 還沒結束');
    }
  }
  return { state, ticks: state.tick, inputs };
}

/** 一整場。 */
export function playFull(c0: Controller<HKState>, c1: Controller<HKState>, seed: number): FullMatch {
  return playFrom(hkGame.init(seed, CONFIG), c0, c1);
}

/** 一場裡 `side` 的得分：贏 1、平手 0.5、輸 0。 */
export function pointsOf(state: HKState, side: Side): number {
  return state.winner === null ? 0.5 : state.winner === side ? 1 : 0;
}

/** 兩邊都只按「全放開」的輸入。 */
export const IDLE_INPUTS: Inputs = [IDLE, IDLE];
