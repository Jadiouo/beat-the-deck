import { copyButtons, playMatch } from '../../core/match';
import { intFrom, nextFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Controller, Game, GameConfig, Side } from '../../core/types';
import { levelController } from '../../ai/level';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import type { SpadesState } from './logic';

/**
 * 「真人觀察模型」（只給測試與量測用，不進遊戲）：
 * 畫面上看得到的東西是 d tick 以前的，自己在哪是現在的，那 d 個 tick 內才出現的子彈看不到。
 * 不呼叫 `game.step`，不外推：餵給性格的是 d tick 前的 state，只把自己的場地狀態（位置、速度、
 * 命中、無敵）換成現在的。
 * 為什麼不用 `wrapPolicy`：它把舊畫面用 `step` 重播到現在，子彈由種子決定的牌上，重播會把
 * 那 d 個 tick 內才生成的子彈也算出來（DESIGN-AI-FUN 9.8），延遲因此等於零。
 */
export function observeWithDelay(seen: SpadesState, now: SpadesState, side: Side): SpadesState {
  const mine = now.fields[side];
  const old = seen.fields[side];
  const field = {
    ...old,
    px: mine.px,
    py: mine.py,
    vx: mine.vx,
    vy: mine.vy,
    hits: mine.hits,
    grazes: mine.grazes,
    invuln: mine.invuln,
  };
  const fields: [SpadesState['fields'][0], SpadesState['fields'][1]] =
    side === 0 ? [field, seen.fields[1]] : [seen.fields[0], field];
  return { ...seen, fields };
}

export interface DelayedViewParams {
  /** 反應延遲（tick）。 */
  readonly delay: number;
  /** 每幾個 tick 決定一次，中間沿用。 */
  readonly decideEvery: number;
  /** 每次決定亂按的機率（從 `actions()` 均勻亂挑）。 */
  readonly epsilon: number;
}

export function delayedViewController(
  game: Game<SpadesState>,
  policy: Policy,
  params: DelayedViewParams,
  seed: number,
): Controller<SpadesState> {
  let history: SpadesState[] = [];
  let held: Buttons | null = null;
  let lastDecision = 0;
  let dice: RngState = rngStateFor(seed, 'delayed-view');
  return {
    decide(state: SpadesState, side: Side, tick: number): Buttons {
      if (tick === 0) {
        history = [];
        held = null;
        dice = rngStateFor(seed, 'delayed-view');
      }
      history.push(state);
      if (history.length > params.delay + 1) {
        history.shift();
      }
      if (held === null || tick - lastDecision >= params.decideEvery) {
        const seen = observeWithDelay(history[0] as SpadesState, state, side);
        let pressed: Buttons | null = null;
        if (params.epsilon > 0) {
          const [roll, afterRoll] = nextFrom(dice);
          dice = afterRoll;
          if (roll < params.epsilon) {
            const actions = game.actions(seen, side);
            const [index, afterPick] = intFrom(dice, actions.length);
            dice = afterPick;
            pressed = actions[index] as Buttons;
          }
        }
        held = copyButtons(pressed ?? policy.decide(game, seen, side, tick, { depth: 1, seed }));
        lastDecision = tick;
      }
      return copyButtons(held);
    },
  };
}

/** 對手是等級 10 的這張牌預設性格；偶數種子坐 0 號邊；平手算半場。與 `winRate` 同一套座位。 */
export function delayedViewWinRate(
  game: Game<SpadesState>,
  policy: Policy,
  params: DelayedViewParams,
  seeds: readonly number[],
  config: GameConfig = { maxTicks: 3600, params: {} },
  opponent: Policy = precise,
): number {
  let points = 0;
  for (const seed of seeds) {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const mine = delayedViewController(game, policy, params, seed);
    const other = levelController(game, opponent, 10, seed + 1_000_003);
    const result =
      side === 0
        ? playMatch(game, seed, config, mine, other)
        : playMatch(game, seed, config, other, mine);
    points += result.winner === null ? 0.5 : result.winner === side ? 1 : 0;
  }
  return points / seeds.length;
}
