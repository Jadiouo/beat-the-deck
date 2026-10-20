import { levelController, wrapPolicy } from '../../ai/level';
import { HUMAN_PARAMS } from '../../ai/human-model';
import { pathfinder } from '../../ai/policies/pathfinder';
import type { Policy } from '../../ai/types';
import type { Buttons, Controller, Side } from '../../core/types';
import { DROP_TICKS, NOTE_TICKS, SLOT_TICKS, s6Game } from './logic';
import type { Note, S6State } from './logic';

/**
 * S-6 的劇本玩家與量測工具（DESIGN-AI-FUN 10.7、10.19、10.40、10.54）。都是 Controller／Game 的包裝，
 * 只讀完整的 state，不是 `logic.ts`，不在純度掃描範圍。
 * 劇本玩家「編曲」照腳本、「對打」完美地按通過線的音（或交給人類模型的對打），所以玩家之間只差編曲怎麼決定。
 */

export const CONTRACT_CONFIG = { maxTicks: 3600, params: {} };
export const NONE: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};
const KEYS = ['left', 'down', 'up', 'right'] as const;
export const lane = (l: number): Buttons => ({ ...NONE, [KEYS[l] as string]: true });

export type Make = (seed: number, side: Side) => Controller<S6State>;

/** 某個性格、某個等級的 AI。種子與邊都進亂數，讓兩邊的骰子不同。 */
export const ai =
  (policy: Policy, level: number): Make =>
  (seed, side) =>
    levelController(s6Game, policy, level, seed * 2 + side + 7);

/** 人類模型（SPEC 7.3：反應 12、每 6 tick 決定、8% 亂按、深度 1）。 */
export const human: Make = (seed, side) =>
  wrapPolicy(s6Game, pathfinder, HUMAN_PARAMS, seed * 2 + side + 7);

/** 強玩家：人類模型的節奏，但不亂按。 */
export const strongHuman: Make = (seed, side) =>
  wrapPolicy(s6Game, pathfinder, { ...HUMAN_PARAMS, epsilon: 0 }, seed * 2 + side + 7);

/**
 * 劇本：編曲照 `plan`（在該格的第一個 tick 按），對打時完美地按著通過線的音；
 * `skip` 回傳 true 的音故意漏掉（藏拙、固定的弱點）。
 */
export function scripted(opts: {
  plan: (state: S6State, side: Side) => readonly Note[];
  skip?: (state: S6State, side: Side, laneOfNote: number) => boolean;
}): Controller<S6State> {
  return {
    decide(s, side) {
      if (s.phase === 'compose') {
        const hit = opts.plan(s, side).find((n) => n.slot * SLOT_TICKS === s.phaseTick);
        return hit === undefined ? NONE : lane(hit.lane);
      }
      if (s.phase === 'play') {
        for (const n of s.phrases[side === 0 ? 1 : 0]) {
          const start = DROP_TICKS + SLOT_TICKS * n.slot;
          if (s.phaseTick >= start && s.phaseTick < start + NOTE_TICKS) {
            return opts.skip?.(s, side, n.lane) === true ? NONE : lane(n.lane);
          }
        }
      }
      return NONE;
    },
  };
}

/** 永遠不編曲（只用自動補的 2 個音）、完美對打。 */
export const idle: Make = () => scripted({ plan: () => [] });

/** 固定的曲子、完美對打。 */
export const fixedPhrase =
  (notes: readonly Note[]): Make =>
  () =>
    scripted({ plan: () => notes });

/** 一條軌道有弱點：那條軌道的音機率 `pct`％漏掉（100 ＝ 永遠漏），其他完美。 */
export const weakLane =
  (weak: number, pct = 100): Make =>
  (seed) =>
    scripted({
      plan: () => [],
      skip: (s, _side, l) =>
        l === weak &&
        (s.round * 31 + seed * 13 + Math.floor(s.phaseTick / SLOT_TICKS) * 7) % 100 < pct,
    });

/** 藏拙：前 `rounds` 回合把（所有／第一個見到的軌道的）音故意漏掉，之後完美，從不編曲。 */
export const sandbag =
  (rounds: number, onlyFirstLane = false): Make =>
  () => {
    let weak = -1;
    return scripted({
      plan: () => [],
      skip: (s, _side, l) => {
        if (s.round >= rounds) {
          return false;
        }
        if (!onlyFirstLane) {
          return true;
        }
        if (weak < 0) {
          weak = l;
        }
        return l === weak;
      },
    });
  };

/** 編曲交給 `composer`、對打交給 `exec`；兩個控制器每個 tick 都被問，各自的內部狀態才不會斷。 */
export function mix(composer: Make, exec: Make): Make {
  return (seed, side) => {
    const c = composer(seed, side);
    const e = exec(seed, side);
    return {
      decide(s, who, tick) {
        const a = c.decide(s, who, tick);
        const b = e.decide(s, who, tick);
        return s.phase === 'compose' ? a : b;
      },
    };
  };
}

export interface RoundRecord {
  /** 這回合雙方編的曲子（編曲結束那個 tick 的樣子）。 */
  readonly phrases: readonly [readonly Note[], readonly Note[]];
  readonly e: readonly [readonly number[], readonly number[]];
  readonly penalty: readonly [number, number];
  readonly bonus: readonly [number, number];
  /** 多按的 tick 數（每條軌道每 tick 算一次）。 */
  readonly over: readonly [number, number];
}

export interface MatchRecord {
  readonly points: readonly [number, number];
  readonly rounds: readonly RoundRecord[];
  readonly ticks: number;
  readonly winner: Side | null;
}

export function playRecorded(
  seed: number,
  first: Make,
  second: Make,
  config = CONTRACT_CONFIG,
): MatchRecord {
  let s = s6Game.init(seed, config);
  const c0 = first(seed, 0);
  const c1 = second(seed, 1);
  const rounds: RoundRecord[] = [];
  let phrases: readonly [readonly Note[], readonly Note[]] = [[], []];
  while (!s6Game.isOver(s)) {
    const before = s.phase;
    s = s6Game.step(s, [c0.decide(s, 0, s.tick), c1.decide(s, 1, s.tick)]);
    if (before === 'compose' && s.phase === 'play') {
      phrases = s.phrases;
    }
    if (before === 'play' && s.phase === 'rest' && s.last !== null) {
      rounds.push({
        phrases,
        e: s.last.e,
        penalty: s.last.penalty,
        bonus: s.last.bonus,
        over: s.over,
      });
    }
  }
  return { points: s.points, rounds, ticks: s.tick, winner: s6Game.winner(s) };
}

/** A 的單位勝率（平手半場）。偶數種子 A 坐 0 邊，奇數種子換邊。 */
export function winPercent(a: Make, b: Make, seeds: readonly number[]): number {
  let total = 0;
  for (const seed of seeds) {
    const flip = seed % 2 === 1;
    const r = flip ? playRecorded(seed, b, a) : playRecorded(seed, a, b);
    total += r.winner === null ? 0.5 : r.winner === (flip ? 1 : 0) ? 1 : 0;
  }
  return (total / seeds.length) * 100;
}

/** A 的平均分差（A − B），邊輪流。 */
export function meanDiff(a: Make, b: Make, seeds: readonly number[]): number {
  let total = 0;
  for (const seed of seeds) {
    const flip = seed % 2 === 1;
    const r = flip ? playRecorded(seed, b, a) : playRecorded(seed, a, b);
    total += flip ? r.points[1] - r.points[0] : r.points[0] - r.points[1];
  }
  return total / seeds.length;
}

export function quantile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}
