import type { Buttons, Controller, Side } from '../../core/types';
import { IDLE, PRESS_A } from '../_hearts/logic';
import { FUSE_MIN } from './logic';
import type { H2State, Racer } from './logic';

/**
 * H-2 探針 A（完整版）的 (b)(c) 兩族（`docs/cards/H-2.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61）。
 * 只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。**兩族與雙胞胎在量之前寫進小規格並 push，量完不改。**
 *
 * 這個檔案不准碰 AI 的任何東西（沒有引擎的評估函數、沒有控制器、沒有各性格）：(c) 不是 AI（10.61 第二個陷阱），
 * `probe-a.test.ts` 掃這個檔案的原始碼擋住。對局的接線（需要 AI 當對手）在 `probe-a.test-helpers.ts`。
 * 也不准讀 state 裡藏著的引信長度（玩家看不到）：測試用兩個不同的引信長度驗證。
 *
 * 所有成員共用同一套打法：這一局到 `start` 個 tick 才按下 a，累積到 `stopAt` 就放開。差別只在 `stopAt` 怎麼定：
 * - (b) 族：`stopAt` ＝ 門檻 T（固定）。**只准讀自己的狀態、tick、局數、自己的總分**；不讀對手的任何東西。
 * - (c) 族：同一個 T，加上讀對手公開的畫面（兩邊的條都畫在畫面上）：
 *   - 對手還按著、累積 a：引信至少是 a + 1（下限 `lb`）；
 *   - 對手入袋在 X：引信至少是 X + 2；
 *   - 對手炸了：炸的前一刻看到的累積是 a，引信剛好是 a + 1（精確 `known`）。
 *   `boom`：知道精確引信就在「引信 − 2」放開（這是保險：對手替我試了引信）；
 *   `cover`：只在下限之下免費多撐（`stopAt` ＝ max(T, lb − 2)）；
 *   `both`：兩者；`lead`：只讀總分差（領先 100 以上鎖分、落後 100 以上多撐 40），不讀引信的線索。
 */

export const START_EARLY = 0;
/** 晚按：第 58 個 tick 才按（第 60 個 tick 之前還算數，留 2 個 tick 的餘裕）。 */
export const START_LATE = 58;
export const THRESHOLDS = [118, 200, 240, 270, 300, 340] as const;
/** 引信至少 120，累積 118 放開必入袋。 */
export const LOCK_IN = 118;
export const LEAD_GAP = 100;
export const LEAD_EXTRA = 40;

const STARTS = ['early', 'late'] as const;
const READS = ['', '-boom', '-cover', '-lead'] as const;

export const B_FAMILY: readonly string[] = [
  'b-idle',
  ...STARTS.flatMap((s) => THRESHOLDS.map((t) => `b-${s}-${String(t)}`)),
];

export const C_FAMILY: readonly string[] = STARTS.flatMap((s) =>
  THRESHOLDS.flatMap((t) => READS.map((r) => `c-${s}-${String(t)}${r}`)),
);

/**
 * 雙胞胎（量之前固定）：每個 (b)（b-idle 除外）都有四個 (c) 雙胞胎，機器完全一樣、只差讀什麼：
 * 全讀（`c-…`，這一對是「主」雙胞胎）、只讀炸（`-boom`）、只讀下限（`-cover`）、只讀總分（`-lead`）。
 * 所以不論訓練種子上誰是 (b\*)，它都有對應的 (c) 版本（10.68 第六小節）。
 */
export const TWINS: readonly (readonly [string, string])[] = STARTS.flatMap((s) =>
  THRESHOLDS.flatMap((t) =>
    READS.map((r): readonly [string, string] => [`b-${s}-${String(t)}`, `c-${s}-${String(t)}${r}`]),
  ),
);

interface MemberSpec {
  readonly start: number;
  readonly threshold: number;
  readonly boom: boolean;
  readonly cover: boolean;
  readonly lead: boolean;
}

function specOf(name: string): MemberSpec | 'idle' {
  if (name === 'b-idle') {
    return 'idle';
  }
  const m = /^([bc])-(early|late)-(\d+)(-boom|-cover|-lead)?$/.exec(name);
  if (m === null || !(THRESHOLDS as readonly number[]).includes(Number(m[3]))) {
    throw new Error(`不是族裡的成員：${name}`);
  }
  const reads = m[1] === 'c';
  const suffix = m[4] ?? '';
  return {
    start: m[2] === 'early' ? START_EARLY : START_LATE,
    threshold: Number(m[3]),
    boom: reads && (suffix === '' || suffix === '-boom'),
    cover: reads && (suffix === '' || suffix === '-cover'),
    lead: reads && suffix === '-lead',
  };
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);

/** 一個成員的控制器（每次呼叫都是全新的，有自己的內部狀態：這一局對手的線索）。 */
export function member(name: string): Controller<H2State> {
  const m = specOf(name);
  if (m === 'idle') {
    return { decide: (): Buttons => IDLE };
  }
  const reads = m.boom || m.cover;
  let round = -1;
  /** 引信至少是多少。 */
  let lb = FUSE_MIN;
  /** 精確的引信（看到對手炸了才知道），-1 ＝ 不知道。 */
  let known = -1;
  /** 對手最後一次被看到按著時的累積。 */
  let oppLast = 0;
  return {
    decide(state: H2State, side: Side): Buttons {
      if (state.over || state.phase === 'pause') {
        return IDLE;
      }
      if (state.round !== round) {
        round = state.round;
        lb = FUSE_MIN;
        known = -1;
        oppLast = 0;
      }
      if (reads) {
        const opp: Racer = state.players[other(side)];
        if (opp.status === 'holding') {
          lb = Math.max(lb, opp.acc + 1);
          oppLast = opp.acc;
        } else if (opp.status === 'banked') {
          lb = Math.max(lb, opp.acc + 2);
        } else if (opp.status === 'boom' && known < 0 && oppLast > 0) {
          known = oppLast + 1;
        }
      }
      const me = state.players[side];
      if (me.status === 'idle') {
        return state.roundTick >= m.start ? PRESS_A : IDLE;
      }
      if (me.status !== 'holding') {
        return IDLE;
      }
      let stopAt = m.threshold;
      if (m.lead) {
        const diff = state.totals[side] - state.totals[other(side)];
        if (diff >= LEAD_GAP) {
          stopAt = LOCK_IN;
        } else if (diff <= -LEAD_GAP) {
          stopAt = m.threshold + LEAD_EXTRA;
        }
      }
      if (m.boom && known >= 0) {
        stopAt = known - 2;
      } else if (m.cover) {
        stopAt = Math.max(stopAt, lb - 2);
      }
      return me.acc < stopAt ? PRESS_A : IDLE;
    },
  };
}

// ---------------------------------------------------------------------------
// 反應延遲
// ---------------------------------------------------------------------------

const WAITING: Racer = { status: 'idle', acc: 0 };

/**
 * 反應延遲：世界（對手的狀態與總分）是 `delay` 個 tick 前的；自己的狀態、總分、時間是現在的。
 * 延遲看到的若是上一局的對手（局數不同），當作對手還沒動（不拿上一局的入袋或炸掉當這一局的資訊）。
 */
export function withDelay(inner: Controller<H2State>, delay: number): Controller<H2State> {
  if (delay <= 0) {
    return inner;
  }
  const seen = new Map<number, H2State>();
  return {
    decide(state: H2State, side: Side, tick: number): Buttons {
      seen.set(tick, state);
      seen.delete(tick - delay - 1);
      const old = seen.get(tick - delay) ?? seen.get(Math.max(0, tick - delay)) ?? state;
      const opp = other(side);
      const players: [Racer, Racer] = [state.players[0], state.players[1]];
      players[opp] = old.round === state.round ? old.players[opp] : WAITING;
      const totals: [number, number] = [state.totals[0], state.totals[1]];
      totals[opp] = old.totals[opp];
      return inner.decide({ ...state, players, totals }, side, tick);
    },
  };
}
