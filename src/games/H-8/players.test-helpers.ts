import { copyButtons, playMatch } from '../../core/match';
import type { Controller, GameConfig, Side } from '../../core/types';
import { IDLE, PRESS_A, PRESS_B, otherSide } from '../_hearts/logic';
import { CLIMB, STOP, h8Game, ladderPoints, ladderValue, successProb } from './logic';
import type { Act, H8State } from './logic';

/**
 * H-8 的劇本玩家與量測用的小工具（給 `logic.test.ts`、`measure.test.ts` 與探針用）。
 * 劇本玩家只在 choose 階段、自己還在爬、還沒決定時出手，只讀公開資訊與自己的 q；沒有亂數。
 * 所有劇本玩家的「不讀什麼」都在各自的註解裡寫明（探針 A 的定義事先固定，見小規格）。
 */

export const CONFIG: GameConfig = { maxTicks: 5400, params: {} };

/** 一個劇本玩家：choose 階段、還在爬、還沒決定時，用 `choose` 選爬或停，其餘時間放開。 */
export function scripted(choose: (state: H8State, side: Side) => Act): Controller<H8State> {
  return {
    decide(state: H8State, side: Side) {
      if (
        state.phase === 'choose' &&
        !state.over &&
        state.status[side] === 'active' &&
        state.pending[side] === null
      ) {
        return choose(state, side) === CLIMB ? PRESS_A : PRESS_B;
      }
      return IDLE;
    },
  };
}

/** 自己這層的實際成功率。 */
export function myP(state: H8State, side: Side): number {
  return successProb(state.level[side], state.q[side]);
}

/** 自己這層實際成功率 ≥ t 就爬（不讀對方）。 */
export function threshold(t: number): Controller<H8State> {
  return scripted((s, side) => (myP(s, side) >= t ? CLIMB : STOP));
}

/** 爬到第 n 層就停（不讀對方、不讀自己的 q）。 */
export function stopAt(n: number): Controller<H8State> {
  return scripted((s, side) => (s.level[side] < n ? CLIMB : STOP));
}

export const alwaysClimb = scripted(() => CLIMB);
export const alwaysStop = scripted(() => STOP);

/** 平手取停（與 `actions()[0]` 一致）。 */
function better(climb: number, stop: number): Act {
  return climb > stop + 1e-12 ? CLIMB : STOP;
}

/**
 * 探針 A 的三層劇本玩家（DESIGN-AI-FUN 10.35；定義在量之前固定）。三者都只讀自己的 q 與公開資訊，
 * 差別只在「知道多少」：
 * - (a) 不知道有對手：把賭注期望值最大化，每層 `2p > 1`（p > 0.5）就爬。
 * - (b) 知道有對手、但不讀它的任何狀態（不讀它的賭注與狀態、這座梯子的紀錄、過去梯子）：
 *   對一個「q 均勻、門檻 0.5、永遠與我同層」的一般對手，最大化這座梯子的期望得分。
 * - (b') 敏感度分析（事後另加，不是主要讀法）：(b) 再加上讀它的賭注與狀態（它停了或出局之後，
 *   它的賭注是公開的目標），但不讀這座梯子的紀錄與過去梯子。
 * - (c) 讀它的狀態：用 AI 自己的對手模型（賭注與狀態、這座梯子的紀錄、過去梯子的公開 q 與門檻）。
 * 互動強度 = (c) − (b) 的勝率差。
 */
export const planAlone = scripted((s, side) => (myP(s, side) > 0.5 ? CLIMB : STOP));
export const planKnowing = scripted((s, side) =>
  better(ladderValue(s, side, CLIMB, false), ladderValue(s, side, STOP, false)),
);
export const planKnowingStatus = scripted((s, side) => {
  const blind: H8State = { ...s, log: [], past: [] };
  return better(ladderValue(blind, side, CLIMB, true), ladderValue(blind, side, STOP, true));
});
export const planReading = scripted((s, side) =>
  better(ladderValue(s, side, CLIMB, true), ladderValue(s, side, STOP, true)),
);

/**
 * 假訊號劇本（10.7）：在前 `fakeLadders` 座梯子裡，把自己的 q 假裝成另一種。其餘時間 = 基準 `base`。
 * - 假好梯子：q ≤ 0 的梯子（實際成功率不高），不管 p 一路爬到第 `target` 層。
 * - 假爛梯子：q ≥ 0.1 的梯子（實際成功率高），爬到第 `target` 層就停（早停）。
 */
export function bluffGood(
  base: Controller<H8State>,
  fakeLadders: number,
  target: number,
): Controller<H8State> {
  return {
    decide(state: H8State, side: Side, tick: number) {
      if (state.ladder < fakeLadders && state.q[side] <= 0) {
        if (
          state.phase === 'choose' &&
          state.status[side] === 'active' &&
          state.pending[side] === null
        ) {
          return state.level[side] < target ? PRESS_A : PRESS_B;
        }
        return IDLE;
      }
      return base.decide(state, side, tick);
    },
  };
}

export function bluffBad(
  base: Controller<H8State>,
  fakeLadders: number,
  target: number,
): Controller<H8State> {
  return {
    decide(state: H8State, side: Side, tick: number) {
      if (state.ladder < fakeLadders && state.q[side] >= 0.1) {
        if (
          state.phase === 'choose' &&
          state.status[side] === 'active' &&
          state.pending[side] === null
        ) {
          return state.level[side] < target ? PRESS_A : PRESS_B;
        }
        return IDLE;
      }
      return base.decide(state, side, tick);
    },
  };
}

/** 打一場，回傳 A 的得分（贏 1、平 0.5、輸 0）。偶數種子 A 坐 0 號邊。 */
export function playAs(
  a: Controller<H8State>,
  b: Controller<H8State>,
  seed: number,
  config: GameConfig = CONFIG,
): number {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const r =
    side === 0 ? playMatch(h8Game, seed, config, a, b) : playMatch(h8Game, seed, config, b, a);
  return r.winner === null ? 0.5 : r.winner === side ? 1 : 0;
}

/** 跑一場並回傳最終 state 與 tick 數（為了讀 past）。A 坐 `sideA`。 */
export function playFull(
  c0: Controller<H8State>,
  c1: Controller<H8State>,
  seed: number,
  config: GameConfig = CONFIG,
): { state: H8State; ticks: number } {
  let state = h8Game.init(seed, config);
  let tick = 0;
  while (!state.over && tick < config.maxTicks) {
    state = h8Game.step(state, [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ]);
    tick += 1;
  }
  return { state, ticks: tick };
}

/** 一座已結束的梯子，`side` 得幾分。 */
export function pointsOf(past: H8State['past'][number], side: Side): number {
  return ladderPoints(past.pots[0], past.pots[1])[side];
}

export { otherSide };
