import { createRng } from '../../core/rng';
import type { Buttons, Controller, Side } from '../../core/types';
import { FAKE_TICKS, FEINTS, TWITCH_AFTER, TWITCH_PER_ROUND } from './logic';
import type { S7State } from './logic';

/**
 * S-7 探針 A（完整版）的族成員（`docs/cards/S-7.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.54、10.59、10.61）。
 * 只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。
 *
 * - (b)：知道有對手存在（守則、少量假動作），但不讀對手的狀態。
 * - (c)：(b) 的基底加一條讀對手公開狀態的規則（最小對照）。
 * 成員**不用 AI 的任何估價函式或預測函式**，也不拿 AI 的控制器當成員（有測試掃這個檔案的原始碼）。
 *
 * 能讀什麼（小規格第 2 節）：隱藏欄位任何成員都不讀。
 * 對手的狀態＝歷史裡對手那一欄、對手的 `spent`、對手的 `press`（槍聲）、對手的 `wins`；
 * 自己的＝歷史裡自己那一欄、自己的 `spent`／`twitches`／`press`、自己抽的光；共用的＝經過 tick、光有沒有亮與亮了多久。
 * 延遲 D：光與對手欄位看的是 `tick − D` 的舊畫面，自己的動作與自己的光用即時的。
 */

const IDLE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const PRESS: Buttons = { ...IDLE, a: true };
const FEINT: Buttons = { ...IDLE, b: true };

export const B_FAMILY = [
  'b-reflex',
  'b-wait30',
  'b-wait15',
  'b-guard105',
  'b-guard130',
  'b-guard105-f1',
  'b-guard105-f2',
  'b-guard105-f4',
  'b-wait30-f2',
  'b-reflex-f2',
  'b-guard105-fix',
  'b-guard160-f2',
  'b-guard105-k8-f2',
] as const;

export const C_FAMILY = [
  'c-hist-nof',
  'c-hist-f2',
  'c-quota',
  'c-baited',
  'c-gunshot',
  'c-lead',
  'c-combo',
  'c-hist-wait',
] as const;

type Feint = { kind: 'none' } | { kind: 'p'; p: number } | { kind: 'fix90' };

interface Config {
  /** 沒有守則、沒有可疑時，舊畫面裡光亮了幾 tick 就按。 */
  readonly k: number;
  /** 守則：光在這一輪第幾 tick 之前亮起，要等亮滿 30（0 ＝ 沒有守則）。 */
  readonly guard: number;
  readonly feint: Feint;
  /** 讀對手的規則（(b) 全部是 false）。 */
  readonly hist: boolean;
  /** hist 判為不可疑時的 k（預設用 `k`）。 */
  readonly kUnsuspicious?: number;
  readonly quota: boolean;
  readonly baited: boolean;
  readonly gunshot: boolean;
  readonly lead: boolean;
}

const NO_READ = { hist: false, quota: false, baited: false, gunshot: false, lead: false };

const CONFIGS: Readonly<Record<string, Config>> = {
  'b-reflex': { k: 0, guard: 0, feint: { kind: 'none' }, ...NO_READ },
  'b-wait30': { k: 30, guard: 0, feint: { kind: 'none' }, ...NO_READ },
  'b-wait15': { k: 15, guard: 0, feint: { kind: 'none' }, ...NO_READ },
  'b-guard105': { k: 0, guard: 105, feint: { kind: 'none' }, ...NO_READ },
  'b-guard130': { k: 0, guard: 130, feint: { kind: 'none' }, ...NO_READ },
  'b-guard105-f1': { k: 0, guard: 105, feint: { kind: 'p', p: 0.01 }, ...NO_READ },
  'b-guard105-f2': { k: 0, guard: 105, feint: { kind: 'p', p: 0.02 }, ...NO_READ },
  'b-guard105-f4': { k: 0, guard: 105, feint: { kind: 'p', p: 0.04 }, ...NO_READ },
  'b-wait30-f2': { k: 30, guard: 0, feint: { kind: 'p', p: 0.02 }, ...NO_READ },
  'b-reflex-f2': { k: 0, guard: 0, feint: { kind: 'p', p: 0.02 }, ...NO_READ },
  'b-guard105-fix': { k: 0, guard: 105, feint: { kind: 'fix90' }, ...NO_READ },
  'b-guard160-f2': { k: 0, guard: 160, feint: { kind: 'p', p: 0.02 }, ...NO_READ },
  'b-guard105-k8-f2': { k: 8, guard: 105, feint: { kind: 'p', p: 0.02 }, ...NO_READ },
  'c-hist-nof': { k: 0, guard: 105, feint: { kind: 'none' }, ...NO_READ, hist: true },
  'c-hist-f2': { k: 0, guard: 105, feint: { kind: 'p', p: 0.02 }, ...NO_READ, hist: true },
  'c-quota': { k: 0, guard: 105, feint: { kind: 'p', p: 0.02 }, ...NO_READ, quota: true },
  'c-baited': { k: 0, guard: 105, feint: { kind: 'p', p: 0.01 }, ...NO_READ, baited: true },
  'c-gunshot': { k: 0, guard: 105, feint: { kind: 'p', p: 0.02 }, ...NO_READ, gunshot: true },
  'c-lead': { k: 0, guard: 105, feint: { kind: 'p', p: 0.02 }, ...NO_READ, lead: true },
  'c-combo': {
    k: 0,
    guard: 105,
    feint: { kind: 'p', p: 0.01 },
    hist: true,
    quota: true,
    baited: true,
    gunshot: true,
    lead: false,
  },
  'c-hist-wait': {
    k: 30,
    guard: 0,
    feint: { kind: 'p', p: 0.02 },
    ...NO_READ,
    hist: true,
    kUnsuspicious: 8,
  },
};

/** 讀對手過去的假光亮起時間的窗口（±這麼多 tick 內算可疑）。 */
const SUSPECT_HALF = 20;
/** 對手被騙的次數（窗口內）≥ 這個數，c-baited 就多抽。 */
const BAITED_AT = 2;
const P_HIGH = 0.04;

const other = (side: Side): Side => (side === 0 ? 1 : 0);

/** 這一道光在這一輪第幾 tick 亮起（舊畫面）。 */
function startOf(view: S7State): number {
  return view.elapsed - (view.flash === null ? 0 : view.flash.age);
}

/** 對手過去（歷史窗口內）的假光有沒有在 `start` 的 ±SUSPECT_HALF 內亮起。歷史是空的回傳 null（沒有資料）。 */
function suspectByHistory(view: S7State, side: Side, start: number): boolean | null {
  if (view.history.length === 0) {
    return null;
  }
  const opp = other(side);
  for (const r of view.history) {
    for (const t of r.twitchAt[opp]) {
      // twitchAt 記的是按下 b 那個 tick 的 elapsed，假光在下一個 tick 亮起。
      if (Math.abs(start - (t + 1)) <= SUSPECT_HALF) {
        return true;
      }
    }
  }
  return false;
}

function baitedCount(view: S7State, side: Side): number {
  const opp = other(side);
  return view.history.reduce((n, r) => n + r.baited[opp], 0);
}

/** 這個舊畫面裡看到的光，要亮了幾 tick 才按。Infinity ＝ 這個畫面不按。 */
function needSeen(cfg: Config, view: S7State, side: Side): number {
  const opp = other(side);
  const start = startOf(view);
  if (cfg.gunshot && view.press[opp] !== null) {
    // 槍聲：對手已經按了。光亮滿 30 tick（所以是真的）才跟著按（把輸變平手）；沒滿就等。
    return FAKE_TICKS;
  }
  if (cfg.quota && view.spent[opp] >= FEINTS) {
    // 對手的假動作用完了，所有的光都是真的。
    return cfg.k;
  }
  if (cfg.hist) {
    const sus = suspectByHistory(view, side, start);
    if (sus === null) {
      return cfg.guard > 0 && start < cfg.guard ? FAKE_TICKS : cfg.k;
    }
    return sus ? FAKE_TICKS : (cfg.kUnsuspicious ?? cfg.k);
  }
  return cfg.guard > 0 && start < cfg.guard ? FAKE_TICKS : cfg.k;
}

/** 這一輪的假動作機率（讀對手的規則在這裡調整）。 */
function feintP(cfg: Config, view: S7State, side: Side, base: number): number {
  if (cfg.baited) {
    return baitedCount(view, side) >= BAITED_AT ? P_HIGH : base;
  }
  if (cfg.lead) {
    return view.wins[other(side)] > view.wins[side] ? P_HIGH : base;
  }
  return base;
}

/**
 * 做一個成員。`delay` 是看舊畫面的 tick 數（0 或 12）。
 * 亂數只在「可以假動作的 tick」各抽一次，所以 (b) 與它的 (c) 變體在同一串局面上抽到同樣的數。
 */
export function makeMember(name: string, seed: number, delay: number): Controller<S7State> {
  const cfg = CONFIGS[name];
  if (cfg === undefined) {
    throw new RangeError(`不認得的成員 ${name}`);
  }
  return controllerOf(cfg, seed, delay);
}

/**
 * 診斷用（**不是族的成員**，不進 (b\*)／(c\*) 的選擇）：自訂 k、守則、假動作機率的 (b) 型玩家。
 * 給「等待曲線」這種掃描用——量等待的代價，結果標「敏感度分析」。
 */
export function makeSweepMember(
  spec: { readonly k: number; readonly guard: number; readonly p: number },
  seed: number,
  delay: number,
): Controller<S7State> {
  return controllerOf(
    {
      k: spec.k,
      guard: spec.guard,
      feint: spec.p > 0 ? { kind: 'p', p: spec.p } : { kind: 'none' },
      ...NO_READ,
    },
    seed,
    delay,
  );
}

function controllerOf(cfg: Config, seed: number, delay: number): Controller<S7State> {
  const rng = createRng(seed).fork('s7-probe-a');
  const views: S7State[] = [];
  return {
    decide(live: S7State, side: Side, tick: number): Buttons {
      views[tick] = live;
      if (live.phase !== 'wait' || live.press[side] !== null || live.done) {
        return IDLE;
      }
      const view = views[Math.max(0, tick - delay)] ?? live;

      // 假動作的抽籤：沒有光、這一輪過了 90 tick、自己的額度還有（都是自己知道或共用的資訊）。
      // 只要符合就抽一次（不論這個 tick 按不按），所以亂數的消耗只看現在的局面。
      let feint = false;
      if (
        live.flash === null &&
        live.elapsed >= TWITCH_AFTER &&
        live.twitches[side] < TWITCH_PER_ROUND &&
        live.spent[side] + live.twitches[side] < FEINTS &&
        !live.heldB[side]
      ) {
        if (cfg.feint.kind === 'fix90') {
          feint = live.elapsed === TWITCH_AFTER;
        } else if (cfg.feint.kind === 'p') {
          feint = rng.next() < feintP(cfg, view, side, cfg.feint.p);
        }
      }

      // 按：舊畫面裡有光、不是自己還沒亮滿的假光。舊畫面的光現在可能已經熄了（假光），那是延遲的代價，照按。
      const ownFake = live.flash !== null && live.flash.makers[side] && live.flash.age < FAKE_TICKS;
      if (
        view.phase === 'wait' &&
        view.flash !== null &&
        !live.heldA[side] &&
        !ownFake &&
        view.flash.age >= needSeen(cfg, view, side)
      ) {
        return PRESS;
      }
      return feint ? FEINT : IDLE;
    },
  };
}
