import { copyButtons, playMatch } from '../../core/match';
import type { Buttons, Controller, GameConfig, Side } from '../../core/types';
import { IDLE, otherSide } from '../_hearts/logic';
import {
  GREEN,
  MOVE_BUTTONS,
  NONE,
  RED,
  WHITE,
  ROUNDS,
  clashLoss,
  expectedNet,
  h7Game,
  hpValue,
  predictOpp,
  trueValue,
} from './logic';
import type { H7State, Move } from './logic';

/**
 * H-7 的劇本玩家與量測用的小工具（給 `logic.test.ts`、`measure.test.ts` 與探針用）。
 * 劇本玩家看到的是 choose 階段、自己還沒出手的 state，只讀公開資訊；亂數沒有，全部是確定的規則。
 */

export const CONFIG: GameConfig = { maxTicks: 3600, params: {} };

/** 一個劇本玩家：choose 階段、還沒出手時，用 `choose` 選一個出手，其餘時間放開。 */
export function scripted(choose: (state: H7State, side: Side) => Move): Controller<H7State> {
  return {
    decide(state: H7State, side: Side): Buttons {
      if (state.phase === 'choose' && !state.over && state.pending[side] === null) {
        return MOVE_BUTTONS[choose(state, side)] as Buttons;
      }
      return IDLE;
    },
  };
}

/** 昏倒時不能搶紅球：把紅球換成綠球。 */
function legal(state: H7State, side: Side, move: Move): Move {
  return move === RED && state.hp[side] <= 0 ? GREEN : move;
}

export const alwaysRed = scripted((s, side) => legal(s, side, RED));
export const alwaysWhite = scripted(() => WHITE);
export const alwaysGreen = scripted(() => GREEN);
export const alwaysNone = scripted(() => NONE);

/** 習慣：血 ≤ `limit` 搶綠球，否則搶紅球（不管會不會昏倒）。 */
export function lowHpGreen(limit: number): Controller<H7State> {
  return scripted((s, side) => (s.hp[side] <= limit ? GREEN : legal(s, side, RED)));
}

/** 自私的期望值：只算我自己拿到什麼（撞球時紅球各掉血價，其他球什麼都沒有），不算對方拿到什麼。 */
export function ownValue(state: H7State, side: Side, x: Move, q: readonly number[]): number {
  const roundsAfter = Math.max(0, ROUNDS - 1 - state.round);
  const red = state.orbs.red;
  const hp = state.hp[side];
  let total = 0;
  for (let y = 0; y < 4; y += 1) {
    const p = q[y] as number;
    if (y !== x) {
      total += p * trueValue(hp, state.score[side], x, red, roundsAfter);
    } else if (x === RED && state.clash) {
      total += p * (hpValue(hp - clashLoss(hp, red), roundsAfter) - hpValue(hp, roundsAfter));
    }
  }
  return total;
}

/**
 * 對手的出手分佈 `q` 之下，我「自己」賺最多的出手（避開它會搶的球，不算封鎖它的價值；平手取索引小的；昏倒時沒有紅球）。
 * 劇本玩家用這個，不是 AI 的 `expectedNet`（那個會算「封鎖對方」，兩個一樣的規劃者會永遠撞球）。
 */
export function bestAgainst(
  state: H7State,
  side: Side,
  q: readonly number[],
  selfish = true,
): Move {
  let best: Move = NONE;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const move of [NONE, WHITE, GREEN, RED] as const) {
    if (move === RED && state.hp[side] <= 0) {
      continue;
    }
    const value = selfish ? ownValue(state, side, move, q) : expectedNet(state, side, move, q);
    if (value > bestValue + 1e-12) {
      best = move;
      bestValue = value;
    }
  }
  return best;
}

/**
 * 三層劇本玩家（DESIGN-AI-FUN 10.35）。`selfish = false`（主要讀法，事先訂好）：用跟 AI 一樣的期望淨值算術
 * （我拿到的減對方拿到的，所以會算「封鎖」）；`selfish = true`（第二種讀法）：只算自己拿到什麼、避開它會搶的球。
 * 第二種是看到主要讀法在對稱局面裡兩邊互相撞球、大半打成平手之後才加的，不是標籤數字。
 */
export function planAloneWith(selfish: boolean): Controller<H7State> {
  // (a) 不知道有對手：AI 整個拿掉（它永遠不搶），只看自己拿什麼最划算。
  return scripted((s, side) => bestAgainst(s, side, [1, 0, 0, 0], selfish));
}

/** (b) 知道有對手會搶，但不讀它的狀態：用一個固定的「一般對手」分佈。 */
export function planKnowingWith(prior: readonly number[], selfish: boolean): Controller<H7State> {
  return scripted((s, side) => bestAgainst(s, side, prior, selfish));
}

/** (c) 讀它的狀態：用 AI 自己的對手模型（對方的血量、分數、紅球、歷史）預測它搶什麼。 */
export function planReadingWith(selfish: boolean): Controller<H7State> {
  return scripted((s, side) => bestAgainst(s, side, predictOpp(s, side), selfish));
}

export const planAlone = planAloneWith(false);
export const planReading = planReadingWith(false);
export function planKnowing(prior: readonly number[]): Controller<H7State> {
  return planKnowingWith(prior, false);
}

/** 打一場，回傳 A 的得分（贏 1、平 0.5、輸 0）。偶數種子 A 坐 0 號邊。 */
export function playAs(
  a: Controller<H7State>,
  b: Controller<H7State>,
  seed: number,
  config: GameConfig = CONFIG,
): number {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const r =
    side === 0 ? playMatch(h7Game, seed, config, a, b) : playMatch(h7Game, seed, config, b, a);
  return r.winner === null ? 0.5 : r.winner === side ? 1 : 0;
}

/** 一場對局的紀錄（逐回合的出手與血量），從 history 讀。 */
export interface RoundRecord {
  readonly picks: readonly [Move, Move];
  readonly hp: readonly [number, number];
  readonly score: readonly [number, number];
  readonly orb: readonly [number, number];
}

export interface PlayLog {
  readonly state: H7State;
  readonly ticks: number;
  readonly copy: Buttons[];
}

/** 跑一場並回傳最終 state 與 tick 數（為了讀 history）。 */
export function playFull(
  c0: Controller<H7State>,
  c1: Controller<H7State>,
  seed: number,
  config: GameConfig = CONFIG,
): { state: H7State; ticks: number } {
  let state = h7Game.init(seed, config);
  let tick = 0;
  while (!state.over && tick < config.maxTicks) {
    state = h7Game.step(state, [
      copyButtons(c0.decide(state, 0, tick)),
      copyButtons(c1.decide(state, 1, tick)),
    ]);
    tick += 1;
  }
  return { state, ticks: tick };
}

export { otherSide, trueValue };
