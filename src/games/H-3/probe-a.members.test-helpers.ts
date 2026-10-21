import type { Buttons, Controller, Side } from '../../core/types';
import { IDLE, PRESS_A, ROUNDS } from '../_hearts/logic';
import { TRACK, brakeDistance, h3Game } from './logic';
import type { H3State, Runner } from './logic';

/**
 * H-3 探針 A（完整版）的 (b)(c) 兩族（`docs/cards/H-3.md`「探針 A（完整版）」；DESIGN-AI-FUN 10.35、10.54、10.59、10.61）。
 * 只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。**兩族與雙胞胎在量之前寫進小規格並 push，量完不改。**
 *
 * 這個檔案不准碰 AI 的任何東西（沒有引擎的評估函數、沒有控制器、沒有各性格）：(c) 不是 AI（10.61 第二個陷阱），
 * `probe-a.test.ts` 掃這個檔案的原始碼擋住。對局的接線（需要 AI 當對手）在 `probe-a.test-helpers.ts`。
 *
 * 這張牌每一局只有一個決定：什麼時候煞車。成員分兩種：
 * - `exact-M`：知道煞車距離的解析式（`brakeDistance`），在「再等一個 tick 就會停過 300 − M 像素」的最後一刻煞車；
 *   M ＝ 0 是精確煞在邊緣（沒有任何不確定性時，這是最佳打法）。
 * - `pos-P`：位置到 P 像素就煞車（人類常用的粗打法，停點隨起始速度變）。
 * - (b) 只准讀：自己的跑者、局數、自己的總分。**不准讀**對手的跑者與總分。
 * - (c) 讀對手公開的東西（兩邊的跑者與總分都畫在畫面上）：`lead` 讀總分差（領先 100 以上就更保險：邊距加 24 像素
 *   〔pos 是早 15 像素〕；落後 100 以上就更敢：邊距減 16 像素、不低於 0〔pos 是晚 15 像素〕）；
 *   `last` 只在最後一局、對手這一局的結果已經決定時讀〔停下、掉下去、或正在煞車：煞車中的結果由煞車距離決定，畫面上看得到〕（領先就保險，必輸〔落後超過 300〕就孤注一擲）。
 */

export const MARGINS = [0, 4, 8, 16, 24, 32, 48] as const;
export const POSITIONS = [200, 240, 270, 285] as const;
export const LEAD_GAP = 100;
/** 領先時多留的邊距（像素）；pos 成員提早的像素。 */
export const SAFER = 24;
/** 落後時減掉的邊距（像素）；pos 成員延後的像素。 */
export const DARE = 16;
const POS_SHIFT = 15;

const BASES: readonly string[] = [
  ...MARGINS.map((m) => `exact-${String(m)}`),
  ...POSITIONS.map((p) => `pos-${String(p)}`),
];

export const B_FAMILY: readonly string[] = [...BASES.map((b) => `b-${b}`), 'b-never'];

export const C_FAMILY: readonly string[] = BASES.flatMap((b) => [`c-${b}-lead`, `c-${b}-last`]);

/**
 * need 讀法（**量測後加的附錄**，不在 `C_FAMILY` 與 `TWINS` 裡，不影響已經量過的 (c\\*) 選法）：
 * 最後一局、對手這一局的結果已經決定時，算出「要贏至少要停在幾分」＝ 對手最終總分 − 我的總分；
 * 煞車點取「基底的煞車點」與「煞車後的停點 ≥ 需要 ＋ 1 ＋ `NEED_PAD` 像素」兩者較早的那個
 * （需要 < 0 ＝ 怎麼停都贏，一開始就煞車）。意思是：已經夠贏就不要再冒險靠近邊緣。
 */
export const NEED_PAD = 10;

export const NEED_FAMILY: readonly string[] = BASES.map((b) => `c-${b}-need`);

export const NEED_TWINS: readonly (readonly [string, string])[] = BASES.map(
  (b) => [`b-${b}`, `c-${b}-need`] as const,
);

/**
 * 雙胞胎（量之前固定）：每個 (b)（b-never 除外）都有 lead 與 last 兩個 (c) 雙胞胎，機器完全一樣、只差讀什麼。
 * 所以不論訓練種子上誰是 (b\*)，它都有對應的 (c) 版本（10.68 第六小節）。
 */
export const TWINS: readonly (readonly [string, string])[] = BASES.flatMap((b) => [
  [`b-${b}`, `c-${b}-lead`] as const,
  [`b-${b}`, `c-${b}-last`] as const,
]);

interface MemberSpec {
  readonly kind: 'exact' | 'pos';
  readonly value: number;
  readonly lead: boolean;
  readonly last: boolean;
  readonly need: boolean;
}

function specOf(name: string): MemberSpec | 'never' {
  if (name === 'b-never') {
    return 'never';
  }
  const m = /^([bc])-(exact|pos)-(\d+)(-lead|-last|-need)?$/.exec(name);
  const value = Number(m?.[3]);
  const ok =
    m !== null &&
    (m[2] === 'exact'
      ? (MARGINS as readonly number[]).includes(value)
      : (POSITIONS as readonly number[]).includes(value));
  if (m === null || !ok || (m[1] === 'b') !== (m[4] === undefined)) {
    throw new Error(`不是族裡的成員：${name}`);
  }
  return {
    kind: m[2] as 'exact' | 'pos',
    value,
    lead: m[4] === '-lead',
    last: m[4] === '-last',
    need: m[4] === '-need',
  };
}

const other = (side: Side): Side => (side === 0 ? 1 : 0);
/**
 * 對手這一局的結果（分）：停下來是位置的整數部分，掉下去是 0；正在煞車的，結果已經由煞車距離決定
 * （畫面上看得到它的位置與速度），照會停的位置算；還在跑的結果還沒決定，回傳 null。
 */
function settledScore(r: Runner): number | null {
  if (r.status === 'fallen') {
    return 0;
  }
  if (r.status === 'stopped') {
    return Math.floor(r.pos / 1000);
  }
  if (r.status === 'braking') {
    const stop = r.pos + brakeDistance(r.speed);
    return stop > TRACK ? 0 : Math.floor(stop / 1000);
  }
  return null;
}

/** 一個成員的控制器（每次呼叫都是全新的；沒有內部狀態，所以同一個 state 永遠同一個答案）。 */
export function member(name: string): Controller<H3State> {
  const m = specOf(name);
  return {
    decide(state: H3State, side: Side): Buttons {
      if (m === 'never' || state.over || state.phase !== 'run') {
        return IDLE;
      }
      const me = state.runners[side];
      if (me.status !== 'running') {
        return IDLE;
      }
      // 讀對手：+1 ＝ 更保險，−1 ＝ 更敢，0 ＝ 照原樣。
      let mood = 0;
      const diff = state.totals[side] - state.totals[other(side)];
      if (m.lead) {
        mood = diff >= LEAD_GAP ? 1 : diff <= -LEAD_GAP ? -1 : 0;
      } else if (m.last && state.round === ROUNDS - 1) {
        // 對手的結果已經決定（停下、掉下去、或正在煞車）：算「這一局結束時」的總分差。
        // 停下與掉下去的得分已經在總分裡；正在煞車的還沒進總分，加上它會停的分數。
        const opp = state.runners[other(side)];
        const settled = settledScore(opp);
        if (settled !== null) {
          const gap = opp.status === 'braking' ? diff - settled : diff;
          mood = gap > 0 ? 1 : gap <= -TRACK / 1000 ? -1 : 0;
        }
      }
      // need：夠贏就煞（停點 ≥ 需要 ＋ 1 ＋ 餘裕）；需要 < 0 ＝ 怎麼停都贏。
      let needStop = Number.POSITIVE_INFINITY;
      if (m.need && state.round === ROUNDS - 1) {
        const opp = state.runners[other(side)];
        const settled = settledScore(opp);
        if (settled !== null) {
          const oppFinal = state.totals[other(side)] + (opp.status === 'braking' ? settled : 0);
          const need = oppFinal - state.totals[side];
          needStop = need < 0 ? Number.NEGATIVE_INFINITY : (need + 1 + NEED_PAD) * 1000;
        }
      }
      if (me.pos + brakeDistance(me.speed) >= needStop) {
        return PRESS_A;
      }
      if (m.kind === 'pos') {
        const target = m.value + (mood > 0 ? -POS_SHIFT : mood < 0 ? POS_SHIFT : 0);
        return me.pos >= target * 1000 ? PRESS_A : IDLE;
      }
      const margin = mood > 0 ? m.value + SAFER : mood < 0 ? Math.max(0, m.value - DARE) : m.value;
      // 再等一個 tick（自己不按）之後，如果這時才煞車會停過 300 − margin，現在就煞。
      const next = h3Game.step(state, [IDLE, IDLE]).runners[side];
      if (next.status === 'fallen') {
        return PRESS_A;
      }
      return next.pos + brakeDistance(next.speed) > TRACK - margin * 1000 ? PRESS_A : IDLE;
    },
  };
}

// ---------------------------------------------------------------------------
// 反應延遲
// ---------------------------------------------------------------------------

/**
 * 反應延遲：世界（對手的跑者與總分）是 `delay` 個 tick 前的；自己的跑者、總分與時間是現在的。
 * 延遲看到的若是上一局的對手（局數不同），當作對手還在這一局的起跑線。
 */
export function withDelay(inner: Controller<H3State>, delay: number): Controller<H3State> {
  if (delay <= 0) {
    return inner;
  }
  const seen = new Map<number, H3State>();
  return {
    decide(state: H3State, side: Side, tick: number): Buttons {
      seen.set(tick, state);
      seen.delete(tick - delay - 1);
      const old = seen.get(tick - delay) ?? seen.get(Math.max(0, tick - delay)) ?? state;
      const opp = other(side);
      const runners: [Runner, Runner] = [state.runners[0], state.runners[1]];
      runners[opp] =
        old.round === state.round
          ? old.runners[opp]
          : { status: 'running', pos: 0, speed: state.v0, age: 0 };
      const totals: [number, number] = [state.totals[0], state.totals[1]];
      totals[opp] = old.totals[opp];
      return inner.decide({ ...state, runners, totals }, side, tick);
    },
  };
}
