import type { Buttons, Controller, Side } from '../../core/types';
import { bfsDistances, stepTarget } from '../_diamonds/logic';
import type { Dir } from '../_diamonds/logic';
import { CAP } from './logic';
import type { D4State } from './logic';

/**
 * D-4 探針 A（完整版）的族成員（`docs/cards/D-4.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.54、10.59、10.61）。
 * 只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。
 *
 * - (b)：知道對手存在（站會被占、金幣會被搶：偵測被擋、較早去充），但不讀對手的狀態。
 * - (c)：(b) 的基底加讀對手公開狀態的規則（free、contest、squeeze）。
 * 成員**不用 AI 的任何估價函式或預測函式**，不拿 AI 的控制器當成員，也不用現成的劇本玩家（有測試掃這個檔案的原始碼）。
 *
 * 對手的狀態的邊界（小規格第 2 節）：`players[opp]`、`battery[opp]`、`trickle[opp]`、`stuck[opp]`、`holder[i] === opp`。
 * `holder` 是兩邊混在一起的共用陣列，所以 (b) 對它**完全不讀**（連 `=== side` 也不需要）；(c) 的 free 才讀。
 * 延遲 D：對手相關的讀取看 `tick − D` 的舊畫面；自己的位置、電量、金幣、牆用即時的。
 */

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

export const B_FAMILY = [
  'b-thr8',
  'b-thr12',
  'b-thr16',
  'b-thr20',
  'b-thr12-det',
  'b-thr20-det',
  'b-thr16-to30',
  'b-plan-m2',
  'b-plan-m4',
  'b-plan-m8',
  'b-plan-m4-det',
] as const;

export const C_FAMILY = [
  'c-free-thr12',
  'c-free-thr20',
  'c-contest-thr12',
  'c-squeeze-thr12',
  'c-free-squeeze-thr20',
  'c-calc',
  'c-all',
] as const;

type Mode =
  | { readonly kind: 'thr'; readonly level: number; readonly chargeTo: number }
  | { readonly kind: 'plan'; readonly margin: number };

interface Config {
  readonly mode: Mode;
  /** 偵測被擋（只用自己的電量與位置）。 */
  readonly detect: boolean;
  /** 讀對手：避開被占的站。 */
  readonly free: boolean;
  /** 讀對手：不爭對手更近的金幣。 */
  readonly contest: boolean;
  /** 讀對手：擠它。 */
  readonly squeeze: boolean;
}

const thr = (level: number, chargeTo = CAP): Mode => ({ kind: 'thr', level, chargeTo });
const plan = (margin: number): Mode => ({ kind: 'plan', margin });
const B_ONLY = { free: false, contest: false, squeeze: false };

const CONFIGS: Readonly<Record<string, Config>> = {
  'b-thr8': { mode: thr(8), detect: false, ...B_ONLY },
  'b-thr12': { mode: thr(12), detect: false, ...B_ONLY },
  'b-thr16': { mode: thr(16), detect: false, ...B_ONLY },
  'b-thr20': { mode: thr(20), detect: false, ...B_ONLY },
  'b-thr12-det': { mode: thr(12), detect: true, ...B_ONLY },
  'b-thr20-det': { mode: thr(20), detect: true, ...B_ONLY },
  'b-thr16-to30': { mode: thr(16, 30), detect: false, ...B_ONLY },
  'b-plan-m2': { mode: plan(2), detect: false, ...B_ONLY },
  'b-plan-m4': { mode: plan(4), detect: false, ...B_ONLY },
  'b-plan-m8': { mode: plan(8), detect: false, ...B_ONLY },
  'b-plan-m4-det': { mode: plan(4), detect: true, ...B_ONLY },
  'c-free-thr12': { mode: thr(12), detect: false, free: true, contest: false, squeeze: false },
  'c-free-thr20': { mode: thr(20), detect: false, free: true, contest: false, squeeze: false },
  'c-contest-thr12': { mode: thr(12), detect: false, free: false, contest: true, squeeze: false },
  'c-squeeze-thr12': { mode: thr(12), detect: false, free: false, contest: false, squeeze: true },
  'c-free-squeeze-thr20': {
    mode: thr(20),
    detect: false,
    free: true,
    contest: false,
    squeeze: true,
  },
  'c-calc': { mode: plan(4), detect: false, free: true, contest: true, squeeze: false },
  'c-all': { mode: plan(4), detect: true, free: true, contest: true, squeeze: true },
};

/** 偵測被擋：站上連續這麼多 tick 電量沒有上升。 */
const BLOCKED_AFTER = 10;
/** 偵測到被擋之後，這個站標成不能用多久。 */
const BAN_TICKS = 120;
/** 擠它：對手電量 ≤ 這個數才去擠。 */
const SQUEEZE_BELOW = 10;
/** 擠它：對手電量回到這個數就放手。 */
const SQUEEZE_RELEASE = 16;
/** 擠它：我的電量要 ≥ 到站的步數 ＋ 這麼多；低於 `SQUEEZE_SELF_FLOOR` 就放手。 */
const SQUEEZE_RESERVE = 6;
const SQUEEZE_SELF_FLOOR = 6;
/** 擠它：對手離它最近的站至少要這麼遠才擠。 */
const SQUEEZE_MIN_OPP_DISTANCE = 2;
/** 擠它：最多站這麼久，之後冷卻同樣久（防僵局）。 */
const SQUEEZE_MAX_TICKS = 100;

const DIRS: readonly Dir[] = [0, 1, 2, 3];

function press(dir: Dir): Buttons {
  return { ...NONE, up: dir === 0, right: dir === 1, down: dir === 2, left: dir === 3 };
}

/** 往 `target` 走一步的方向（沒有更近的走法就全放開）。 */
function toward(state: D4State, from: number, target: number | null): Buttons {
  if (target === null || from === target) {
    return NONE;
  }
  const field = bfsDistances(state.walls, target);
  let best: Dir | null = null;
  let bestDistance = field[from] as number;
  for (const dir of DIRS) {
    const next = stepTarget(state.walls, from, dir);
    if (next !== from && (field[next] as number) < bestDistance) {
      bestDistance = field[next] as number;
      best = dir;
    }
  }
  return best === null ? NONE : press(best);
}

/** 離 `from` 最近的格子（`cells` 裡），平手取排在前面的。 */
function nearest(state: D4State, from: number, cells: readonly number[]): number | null {
  const field = bfsDistances(state.walls, from);
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const c of cells) {
    if ((field[c] as number) < bestDistance) {
      bestDistance = field[c] as number;
      best = c;
    }
  }
  return best;
}

/**
 * 做一個成員。`delay` 是對手相關的讀取看舊畫面的 tick 數（0 或 12）。
 * 成員有內部狀態（偵測被擋的計時、擠它的計時），每一場要用全新的。
 */
export function makeMember(name: string, _seed: number, delay: number): Controller<D4State> {
  const cfg = CONFIGS[name];
  if (cfg === undefined) {
    throw new RangeError(`不認得的成員 ${name}`);
  }
  const views: D4State[] = [];
  // 偵測被擋用（只用自己的電量與位置）。
  let previousBattery: number | null = null;
  let lastRise = Number.NEGATIVE_INFINITY;
  let standingOn = -1;
  let arrivedAt = 0;
  const bannedUntil = [0, 0, 0, 0];
  // 擠它用。
  let camp: { station: number; start: number } | null = null;
  let cooldownUntil = 0;

  return {
    decide(live: D4State, side: Side, tick: number): Buttons {
      views[tick] = live;
      const oppSide: Side = side === 0 ? 1 : 0;
      const view = views[Math.max(0, tick - delay)] ?? live;
      const me = live.players[side];
      const battery = live.battery[side] as number;
      const stationIndex = live.stations.indexOf(me.cell);

      // 自己的偵測計時：電量上升的時刻、站上的到達時刻。
      if (previousBattery !== null && battery > previousBattery) {
        lastRise = tick;
      }
      previousBattery = battery;
      if (stationIndex !== standingOn) {
        standingOn = stationIndex;
        arrivedAt = tick;
      }
      if (
        cfg.detect &&
        stationIndex >= 0 &&
        battery < CAP &&
        tick - Math.max(arrivedAt, lastRise) >= BLOCKED_AFTER
      ) {
        bannedUntil[stationIndex] = tick + BAN_TICKS;
        arrivedAt = tick;
      }

      // 能用的站：沒被標成被擋的；(c) 的 free 再去掉對手占著或正站在上面的。
      let usable: readonly number[] = live.stations.filter(
        (_s, i) => !cfg.detect || (bannedUntil[i] as number) <= tick,
      );
      if (cfg.free) {
        const taken = (i: number): boolean =>
          view.holder[i] === oppSide || view.players[oppSide].cell === live.stations[i];
        usable = usable.filter((s) => !taken(live.stations.indexOf(s)));
      }
      if (usable.length === 0) {
        usable = live.stations;
      }

      // 擠它（讀對手的電量與位置）。
      if (cfg.squeeze) {
        const oppCell = view.players[oppSide].cell;
        const oppBattery = view.battery[oppSide] as number;
        if (camp !== null) {
          if (
            tick - camp.start >= SQUEEZE_MAX_TICKS ||
            oppBattery >= SQUEEZE_RELEASE ||
            battery < SQUEEZE_SELF_FLOOR
          ) {
            camp = null;
            cooldownUntil = tick + SQUEEZE_MAX_TICKS;
          }
        } else if (tick >= cooldownUntil && oppBattery <= SQUEEZE_BELOW) {
          const target = nearest(live, oppCell, live.stations);
          if (target !== null) {
            const oppField = bfsDistances(live.walls, oppCell);
            const meField = bfsDistances(live.walls, me.cell);
            const dOpp = oppField[target] as number;
            const dMe = meField[target] as number;
            if (
              dOpp >= SQUEEZE_MIN_OPP_DISTANCE &&
              dMe < dOpp &&
              battery >= dMe + SQUEEZE_RESERVE
            ) {
              camp = { station: target, start: tick };
            }
          }
        }
        if (camp !== null) {
          return camp.station === me.cell ? NONE : toward(live, me.cell, camp.station);
        }
      }

      const mode = cfg.mode;
      const onUsable = stationIndex >= 0 && usable.includes(me.cell);

      // 金幣：(c) 的 contest 去掉對手比我近的（全部都被爭就不去掉）。
      const mine = bfsDistances(live.walls, me.cell);
      let coins: readonly number[] = live.coins;
      if (cfg.contest) {
        const theirs = bfsDistances(live.walls, view.players[oppSide].cell);
        const open = coins.filter((c) => (theirs[c] as number) >= (mine[c] as number));
        if (open.length > 0) {
          coins = open;
        }
      }

      if (mode.kind === 'thr') {
        if (onUsable && battery < mode.chargeTo) {
          return NONE;
        }
        if (battery <= mode.level) {
          return toward(live, me.cell, nearest(live, me.cell, usable));
        }
        return toward(live, me.cell, nearest(live, me.cell, coins));
      }

      // plan：撿得到、回得了站（餘裕 m）的金幣裡最近的；沒有就去最近的站（滿電了就去最近的金幣）。
      if (onUsable && battery < CAP) {
        return NONE;
      }
      const feasible = coins.filter((c) => {
        let home = Number.POSITIVE_INFINITY;
        for (const s of usable) {
          home = Math.min(home, bfsDistances(live.walls, s)[c] as number);
        }
        return battery >= (mine[c] as number) + home + mode.margin;
      });
      if (feasible.length > 0) {
        return toward(live, me.cell, nearest(live, me.cell, feasible));
      }
      if (battery >= CAP) {
        return toward(live, me.cell, nearest(live, me.cell, coins));
      }
      return toward(live, me.cell, nearest(live, me.cell, usable));
    },
  };
}
