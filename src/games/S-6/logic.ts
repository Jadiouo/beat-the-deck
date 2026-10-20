import { intFrom, nextFrom, rngStateFor } from '../../core/rng';
import type { RngState } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';

/**
 * S-6 節拍（小規格 `docs/cards/S-6.md`）：對奏。
 *
 * 每回合三段：編曲 96 tick（雙方同時各編一段 2 到 4 個音給對方，互相看不到）、對打 168 tick
 * （各打對方編的那一段，長音重疊計分）、停頓 30 tick。十回合 2940 tick（49 秒）。
 *
 * 軌道 0 到 3 對應 left、down、up、right；按鍵遮罩 `1 << 軌道`。
 * `phrases[s]` 是 s 編的曲子，s 的對手打它；`hits[s][i]` 是 s 打的第 i 個音（對手曲子的第 i 個音）被按住的 tick 數。
 *
 * 選用的「共用拍位」（`config.params.sharedBeat = 1`，預設關；小規格第 11 節的提案，量測結果見小規格）：
 * 兩邊的曲子放在同一條 8 格的軸上，同一格兩邊都有音就「撞拍」，撞拍的格要同時按兩條軌道。
 *
 * 純模擬層：沒有時鐘、沒有全域亂數；亂數只來自 state 裡的 `rng`，時間只有 tick。
 */

export const ROUNDS = 10;
export const COMPOSE_TICKS = 96;
export const PLAY_TICKS = 168;
export const REST_TICKS = 30;
export const ROUND_TICKS = COMPOSE_TICKS + PLAY_TICKS + REST_TICKS;
export const TOTAL_TICKS = ROUNDS * ROUND_TICKS;
/** 長音的長度：音符通過線的 tick 數。 */
export const NOTE_TICKS = 24;
/** 音符從出現到線的 tick 數：第 0 格的音在對打階段第 60 tick 到線。 */
export const DROP_TICKS = 60;
/** 編曲的一格有多少 tick（游標每 12 tick 掃過一格）。 */
export const SLOT_TICKS = 12;
export const SLOTS = 8;
/** 音與音的起點至少隔幾格。 */
export const MIN_SLOT_GAP = 2;
export const MIN_NOTES = 2;
export const HISTORY_ROUNDS = 5;
/** evaluate 的 gain 單位：一分 ＝ SCORE_UNIT。 */
export const SCORE_UNIT = 1;
/** 每 12 個多按的 tick 扣 1 分。 */
export const OVER_PER_POINT = 12;

/** 先驗：每個類別各加兩筆「平均準度 1.5」的樣本，零分機率 0.35。 */
export const PRIOR_COUNT = 2;
export const PRIOR_E = 1.5;
export const PRIOR_ZERO = 0.35;
/** 貪心型搶拍：音符開始前這麼多 tick 內按著那一軌，gain 加一點。 */
export const ANTICIPATE_TICKS = 12;
export const ANTICIPATE_GAIN = 0.1;
/**
 * 按一條沒有音符的軌道的 danger（每條 1，上限 1）：這一個 tick 一定被記一筆多按，是確定的小損失，
 * 不是不確定的風險。設成 1 之後賭徒型（偏好風險）會把它整個排除，而不是當成誘因去按
 * （試過 0.5：落後時賭徒型 r 升到 4，整個對打階段都按著錯的軌道，每回合扣 12 分）。
 */
export const WRONG_LANE_DANGER = 1;
/** 自己的口味（種子決定）只用來在沒有差別的軌道之間分高下。 */
const TASTE_WEIGHT = 0.01;
/** 越早放的音折得越少：同樣價值的計畫，AI 選比較早的格子。 */
export const SLOT_DISCOUNT = 0.98;

export interface Note {
  readonly lane: number;
  readonly slot: number;
}

/** 一個人一回合「打」的準度（公開，畫面畫成準度條）。間隔：0 ＝ 短（24 tick），1 ＝ 長。 */
export interface Skill {
  /** 以下四個欄位只在共用拍位開啟時才有：這個人自己編的曲子放在哪幾格（0／1）。 */
  readonly placed?: readonly number[];
  /** 這個人打「難的撞拍」（兩條軌道不同）的音：E 的總和、個數、零分個數。 */
  readonly chordE?: number;
  readonly chordN?: number;
  readonly chordZ?: number;
  readonly laneE: readonly number[];
  readonly laneN: readonly number[];
  readonly laneZ: readonly number[];
  readonly gapE: readonly number[];
  readonly gapN: readonly number[];
  readonly gapZ: readonly number[];
  readonly zeros: number;
  readonly notes: number;
}

/** 上一回合的結算。`e[s]` 是 s 打的每個音的 E，`bonus[s]` 是 s 的曲子被零分的音符數 × 2。 */
export interface Settled {
  readonly e: readonly [readonly number[], readonly number[]];
  readonly penalty: readonly [number, number];
  readonly bonus: readonly [number, number];
}

export type Phase = 'compose' | 'play' | 'rest' | 'over';

export interface S6State {
  /** 共用拍位（選項，預設關）。 */
  readonly sharedBeat: boolean;
  readonly tick: number;
  readonly maxTicks: number;
  readonly round: number;
  readonly phase: Phase;
  readonly phaseTick: number;
  readonly phrases: readonly [readonly Note[], readonly Note[]];
  readonly composing: readonly [readonly Note[], readonly Note[]];
  /** 上一個 tick 按住的軌道遮罩。 */
  readonly held: readonly [number, number];
  readonly hits: readonly [readonly number[], readonly number[]];
  /** 這一回合在沒有音符通過的 tick 按住的軌道數（每條軌道每 tick 算一次）。 */
  readonly over: readonly [number, number];
  readonly points: readonly [number, number];
  readonly history: readonly [readonly Skill[], readonly Skill[]];
  readonly last: Settled | null;
  /** 各邊自己的軌道口味（0 到 1）。 */
  readonly taste: readonly [readonly number[], readonly number[]];
  readonly rng: RngState;
}

const NONE: Buttons = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
});

const ACTIONS: readonly Buttons[] = Object.freeze([
  NONE,
  Object.freeze({ ...NONE, left: true }),
  Object.freeze({ ...NONE, down: true }),
  Object.freeze({ ...NONE, up: true }),
  Object.freeze({ ...NONE, right: true }),
]);
const REST_ACTIONS: readonly Buttons[] = Object.freeze([NONE]);
/** 共用拍位的對打階段多的六個動作：兩條軌道一起按（撞拍的格要用）。接在原本五個後面。 */
const PAIR_ACTIONS: readonly Buttons[] = Object.freeze(
  [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ].map(([a, b]) => {
    const keys = ['left', 'down', 'up', 'right'] as const;
    return Object.freeze({
      ...NONE,
      [keys[a as number] as string]: true,
      [keys[b as number] as string]: true,
    });
  }),
);
const SHARED_PLAY_ACTIONS: readonly Buttons[] = Object.freeze([...ACTIONS, ...PAIR_ACTIONS]);

function maskOf(b: Buttons): number {
  return (b.left ? 1 : 0) | (b.down ? 2 : 0) | (b.up ? 4 : 0) | (b.right ? 8 : 0);
}

/** 最左邊的軌道（← ↓ ↑ → 的順序），沒有按就是 -1。 */
function leftmost(mask: number): number {
  for (let l = 0; l < 4; l += 1) {
    if ((mask & (1 << l)) !== 0) {
      return l;
    }
  }
  return -1;
}

/** 長音的得分：E = round(3 × h / 24)。 */
export function noteScore(h: number): number {
  return Math.round((3 * h) / NOTE_TICKS);
}

/** 每個音的間隔種類：0 ＝ 短（和前一個音隔 2 格），1 ＝ 長；第一個音算長。 */
export function gapKinds(notes: readonly Note[]): number[] {
  return notes.map((n, i) => {
    const before = notes[i - 1];
    return before !== undefined && n.slot - before.slot === MIN_SLOT_GAP ? 0 : 1;
  });
}

function noteStart(n: Note): number {
  return DROP_TICKS + SLOT_TICKS * n.slot;
}

/** 在對打的第 `p` 個 tick 正在通過線的音符的索引，沒有就是 -1。 */
function passingIndex(phrase: readonly Note[], p: number): number {
  for (let i = 0; i < phrase.length; i += 1) {
    const start = noteStart(phrase[i] as Note);
    if (p >= start && p < start + NOTE_TICKS) {
      return i;
    }
  }
  return -1;
}

function popcount(mask: number): number {
  let n = 0;
  for (let m = mask; m !== 0; m &= m - 1) {
    n += 1;
  }
  return n;
}

/** s 自己編的曲子在第 `slot` 格的音（撞拍用），沒有是 undefined。 */
function noteAt(phrase: readonly Note[], slot: number): Note | undefined {
  return phrase.find((n) => n.slot === slot);
}

/**
 * `side` 打對手曲子的第 `idx` 個音時，要同時按住的軌道遮罩：那個音的軌道；
 * 共用拍位開啟而且自己的曲子在同一格也有音時，再加上自己那個音的軌道。
 */
function requiredMask(state: S6State, side: Side, idx: number): number {
  const opp: Side = side === 0 ? 1 : 0;
  const n = state.phrases[opp][idx] as Note;
  let mask = 1 << n.lane;
  if (state.sharedBeat) {
    const own = noteAt(state.phrases[side], n.slot);
    if (own !== undefined) {
      mask |= 1 << own.lane;
    }
  }
  return mask;
}

const EMPTY_SKILL_SIDE: readonly Skill[] = [];

/** 測試用：直接構造局面。 */
export function makeState(overrides: Partial<S6State> = {}): S6State {
  return {
    sharedBeat: false,
    tick: 0,
    maxTicks: 3300,
    round: 0,
    phase: 'compose',
    phaseTick: 0,
    phrases: [[], []],
    composing: [[], []],
    held: [0, 0],
    hits: [[], []],
    over: [0, 0],
    points: [0, 0],
    history: [EMPTY_SKILL_SIDE, EMPTY_SKILL_SIDE],
    last: null,
    taste: [
      [0.5, 0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5, 0.5],
    ],
    rng: 12345,
    ...overrides,
  };
}

function composeStep(state: S6State, masks: readonly [number, number]): S6State['composing'] {
  const slot = Math.floor(state.phaseTick / SLOT_TICKS);
  const next: [readonly Note[], readonly Note[]] = [state.composing[0], state.composing[1]];
  for (const side of [0, 1] as const) {
    const lane = leftmost(masks[side]);
    if (lane < 0 || lane === leftmost(state.held[side])) {
      continue;
    }
    const draft = state.composing[side];
    const before = draft[draft.length - 1];
    if (before === undefined || slot - before.slot >= MIN_SLOT_GAP) {
      next[side] = [...draft, { lane, slot }];
    }
  }
  return next;
}

/** 把亂數狀態往前推固定的 `count` 次。 */
function advanceRng(rng: RngState, count: number): RngState {
  let state = rng;
  for (let i = 0; i < count; i += 1) {
    state = nextFrom(state)[1];
  }
  return state;
}

/** 補音每邊最多用掉 4 次亂數（兩個音 × 格與軌道）。 */
const FILL_DRAWS = 4;

/**
 * 編曲結束：不足 2 個音的由種子補在空格。兩邊各用自己的亂數串（第二邊從固定的位置開始），
 * 所以我這一邊補成什麼樣子，與對手編了幾個音無關（不然對手的草稿會經由亂數漏進我的評估）。
 */
function fillPhrases(
  drafts: readonly [readonly Note[], readonly Note[]],
  rng: RngState,
): { phrases: [readonly Note[], readonly Note[]]; rng: RngState } {
  const out: [readonly Note[], readonly Note[]] = [drafts[0], drafts[1]];
  for (const side of [0, 1] as const) {
    let state = side === 0 ? rng : advanceRng(rng, FILL_DRAWS);
    let notes: Note[] = [...drafts[side]];
    while (notes.length < MIN_NOTES) {
      const free: number[] = [];
      for (let s = 0; s < SLOTS; s += 1) {
        if (notes.every((n) => Math.abs(n.slot - s) >= MIN_SLOT_GAP)) {
          free.push(s);
        }
      }
      const [pickSlot, afterSlot] = intFrom(state, free.length);
      const [pickLane, afterLane] = intFrom(afterSlot, 4);
      state = afterLane;
      notes = [...notes, { lane: pickLane, slot: free[pickSlot] as number }];
    }
    out[side] = notes.sort((a, b) => a.slot - b.slot);
  }
  return { phrases: out, rng: advanceRng(rng, 2 * FILL_DRAWS) };
}

function playStep(
  state: S6State,
  masks: readonly [number, number],
): Pick<S6State, 'hits' | 'over'> {
  const p = state.phaseTick;
  const hits: [readonly number[], readonly number[]] = [state.hits[0], state.hits[1]];
  const over: [number, number] = [state.over[0], state.over[1]];
  for (const side of [0, 1] as const) {
    const phrase = state.phrases[side === 0 ? 1 : 0];
    const idx = passingIndex(phrase, p);
    const required = idx >= 0 ? requiredMask(state, side, idx) : 0;
    if (idx >= 0 && (masks[side] & required) === required) {
      hits[side] = state.hits[side].map((h, i) => (i === idx ? h + 1 : h));
    }
    over[side] += popcount(masks[side] & ~required);
  }
  return { hits, over };
}

function skillOf(
  played: readonly Note[],
  e: readonly number[],
  shared?: { own: readonly Note[] },
): Skill {
  const kinds = gapKinds(played);
  const laneE = [0, 0, 0, 0];
  const laneN = [0, 0, 0, 0];
  const laneZ = [0, 0, 0, 0];
  const gapE = [0, 0];
  const gapN = [0, 0];
  const gapZ = [0, 0];
  let zeros = 0;
  played.forEach((n, i) => {
    const score = e[i] as number;
    const kind = kinds[i] as number;
    const zero = score === 0 ? 1 : 0;
    laneE[n.lane] = (laneE[n.lane] as number) + score;
    laneN[n.lane] = (laneN[n.lane] as number) + 1;
    laneZ[n.lane] = (laneZ[n.lane] as number) + zero;
    gapE[kind] = (gapE[kind] as number) + score;
    gapN[kind] = (gapN[kind] as number) + 1;
    gapZ[kind] = (gapZ[kind] as number) + zero;
    zeros += zero;
  });
  const base = { laneE, laneN, laneZ, gapE, gapN, gapZ, zeros, notes: played.length };
  if (shared === undefined) {
    return base;
  }
  // 共用拍位：記下自己編的曲子放在哪幾格，以及「難的撞拍」（兩條軌道不同）打得怎麼樣。
  const placed = Array.from({ length: SLOTS }, () => 0);
  for (const n of shared.own) {
    placed[n.slot] = 1;
  }
  let chordE = 0;
  let chordN = 0;
  let chordZ = 0;
  played.forEach((n, i) => {
    const mine = noteAt(shared.own, n.slot);
    if (mine !== undefined && mine.lane !== n.lane) {
      chordN += 1;
      chordE += e[i] as number;
      chordZ += (e[i] as number) === 0 ? 1 : 0;
    }
  });
  return { ...base, placed, chordE, chordN, chordZ };
}

function settle(state: S6State): S6State {
  const e: [number[], number[]] = [state.hits[0].map(noteScore), state.hits[1].map(noteScore)];
  const penalty: [number, number] = [
    Math.floor(state.over[0] / OVER_PER_POINT),
    Math.floor(state.over[1] / OVER_PER_POINT),
  ];
  // s 的曲子是 1 − s 打的：對方 E = 0 的音符每個給 s 兩分。
  const bonus: [number, number] = [
    2 * e[1].filter((x) => x === 0).length,
    2 * e[0].filter((x) => x === 0).length,
  ];
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
  const points: [number, number] = [
    state.points[0] + sum(e[0]) - penalty[0] + bonus[0],
    state.points[1] + sum(e[1]) - penalty[1] + bonus[1],
  ];
  const skills: [Skill, Skill] = state.sharedBeat
    ? [
        skillOf(state.phrases[1], e[0], { own: state.phrases[0] }),
        skillOf(state.phrases[0], e[1], { own: state.phrases[1] }),
      ]
    : [skillOf(state.phrases[1], e[0]), skillOf(state.phrases[0], e[1])];
  const history: [readonly Skill[], readonly Skill[]] = [
    [...state.history[0], skills[0]].slice(-HISTORY_ROUNDS),
    [...state.history[1], skills[1]].slice(-HISTORY_ROUNDS),
  ];
  return {
    ...state,
    phase: 'rest',
    phaseTick: 0,
    points,
    history,
    last: { e, penalty, bonus },
  };
}

// ---------------------------------------------------------------------------
// 評估
// ---------------------------------------------------------------------------

interface Pool {
  readonly laneE: readonly number[];
  readonly laneN: readonly number[];
  readonly laneZ: readonly number[];
  readonly gapE: readonly number[];
  readonly gapN: readonly number[];
  readonly gapZ: readonly number[];
  readonly e: number;
  readonly n: number;
  readonly z: number;
  /** 共用拍位：對手每一格放過音的回合數、有 `placed` 紀錄的回合數、難的撞拍的準度。 */
  readonly placed: readonly number[];
  readonly rounds: number;
  readonly chordE: number;
  readonly chordN: number;
  readonly chordZ: number;
}

function pool(history: readonly Skill[]): Pool {
  const laneE = [0, 0, 0, 0];
  const laneN = [0, 0, 0, 0];
  const laneZ = [0, 0, 0, 0];
  const gapE = [0, 0];
  const gapN = [0, 0];
  const gapZ = [0, 0];
  let e = 0;
  let n = 0;
  let z = 0;
  const placed = Array.from({ length: SLOTS }, () => 0);
  let rounds = 0;
  let chordE = 0;
  let chordN = 0;
  let chordZ = 0;
  for (const h of history) {
    if (h.placed !== undefined) {
      rounds += 1;
      h.placed.forEach((x, k) => {
        placed[k] = (placed[k] as number) + x;
      });
      chordE += h.chordE ?? 0;
      chordN += h.chordN ?? 0;
      chordZ += h.chordZ ?? 0;
    }
    for (let l = 0; l < 4; l += 1) {
      laneE[l] = (laneE[l] as number) + (h.laneE[l] as number);
      laneN[l] = (laneN[l] as number) + (h.laneN[l] as number);
      laneZ[l] = (laneZ[l] as number) + (h.laneZ[l] as number);
    }
    for (let k = 0; k < 2; k += 1) {
      gapE[k] = (gapE[k] as number) + (h.gapE[k] as number);
      gapN[k] = (gapN[k] as number) + (h.gapN[k] as number);
      gapZ[k] = (gapZ[k] as number) + (h.gapZ[k] as number);
    }
    e += h.laneE.reduce((a, b) => a + b, 0);
    n += h.notes;
    z += h.zeros;
  }
  return { laneE, laneN, laneZ, gapE, gapN, gapZ, e, n, z, placed, rounds, chordE, chordN, chordZ };
}

function smoothedE(sum: number, count: number): number {
  return (sum + PRIOR_COUNT * PRIOR_E) / (count + PRIOR_COUNT);
}

function smoothedZ(sum: number, count: number): number {
  return (sum + PRIOR_COUNT * PRIOR_ZERO) / (count + PRIOR_COUNT);
}

/**
 * 對手在「軌道 l、間隔 k」的音上的預期得分 E 與零分機率 P0。
 * 軌道的估計乘上間隔相對整體的比例（先驗各加兩筆）。
 */
export function estimateNote(p: Pool, lane: number, kind: number): { e: number; z: number } {
  const eAll = smoothedE(p.e, p.n);
  const zAll = smoothedZ(p.z, p.n);
  const e =
    (smoothedE(p.laneE[lane] as number, p.laneN[lane] as number) *
      smoothedE(p.gapE[kind] as number, p.gapN[kind] as number)) /
    eAll;
  const z =
    (smoothedZ(p.laneZ[lane] as number, p.laneN[lane] as number) *
      smoothedZ(p.gapZ[kind] as number, p.gapN[kind] as number)) /
    zAll;
  return { e: Math.min(3, Math.max(0, e)), z: Math.min(1, Math.max(0, z)) };
}

/** 對手在第 k 格放音的先驗機率（平均 2.5 個音 ÷ 8 格），強度兩回合。 */
export const CLASH_PRIOR = 0.3125;
export const CLASH_PRIOR_COUNT = 2;
/** 兩條軌道不同的機率（對手的軌道事先不知道，均勻時是 3/4）：撞拍時只有這個比例是「難的撞拍」。 */
export const HARD_CHORD_SHARE = 0.75;

function estimateSharedFrom(
  p: Pool,
  slot: number,
  lane: number,
  kind: number,
): { e: number; z: number; clash: number } {
  const base = estimateNote(p, lane, kind);
  const clash =
    ((p.placed[slot] as number) + CLASH_PRIOR_COUNT * CLASH_PRIOR) / (p.rounds + CLASH_PRIOR_COUNT);
  const hard = clash * HARD_CHORD_SHARE;
  const eChord = smoothedE(p.chordE, p.chordN);
  const zChord = smoothedZ(p.chordZ, p.chordN);
  return {
    e: Math.min(3, Math.max(0, (1 - hard) * base.e + hard * eChord)),
    z: Math.min(1, Math.max(0, (1 - hard) * base.z + hard * zChord)),
    clash,
  };
}

/**
 * 共用拍位：我把一個音放在第 `slot` 格、軌道 `lane`、間隔 `kind`，對手打它的預期得分 E 與零分機率 P0。
 * 對手放同一格的機率 `clash` 由它最近 5 回合放過的格子估（先驗兩回合）；撞拍時它打的是難的撞拍，
 * 用它最近難的撞拍的準度估；沒撞拍時和原本一樣（軌道與間隔）。
 */
export function estimateShared(
  history: readonly Skill[],
  slot: number,
  lane: number,
  kind: number,
): { e: number; z: number; clash: number } {
  return estimateSharedFrom(pool(history), slot, lane, kind);
}

interface NoteTable {
  /** 共用拍位：依格子的 gain／danger／最大 gain（`[slot][kind][lane]`、`[slot][kind]`）。 */
  readonly slotGain?: readonly (readonly (readonly number[])[])[];
  readonly slotDanger?: readonly (readonly (readonly number[])[])[];
  readonly slotBest?: readonly (readonly number[])[];
  /** gain[kind][lane]：放這個音預期從零分獎勵拿到的分數（加一點口味）。 */
  readonly gain: readonly (readonly number[])[];
  /** danger[kind][lane]：對手預期拿到的準度比例（E ÷ 3）。 */
  readonly danger: readonly (readonly number[])[];
  /** 每種間隔的最大 gain。 */
  readonly best: readonly number[];
}

function sharedTable(p: Pool, taste: readonly number[]): NoteTable {
  const slotGain: number[][][] = [];
  const slotDanger: number[][][] = [];
  const slotBest: number[][] = [];
  for (let slot = 0; slot < SLOTS; slot += 1) {
    const gain: number[][] = [[], []];
    const danger: number[][] = [[], []];
    for (let k = 0; k < 2; k += 1) {
      for (let l = 0; l < 4; l += 1) {
        const est = estimateSharedFrom(p, slot, l, k);
        (gain[k] as number[])[l] = 2 * est.z + TASTE_WEIGHT * (taste[l] as number);
        (danger[k] as number[])[l] = est.e / 3;
      }
    }
    slotGain.push(gain);
    slotDanger.push(danger);
    slotBest.push(gain.map((row) => Math.max(...row)));
  }
  return {
    gain: slotGain[0] as number[][],
    danger: slotDanger[0] as number[][],
    best: slotBest[0] as number[],
    slotGain,
    slotDanger,
    slotBest,
  };
}

function noteTable(history: readonly Skill[], taste: readonly number[], shared = false): NoteTable {
  const p = pool(history);
  if (shared) {
    return sharedTable(p, taste);
  }
  const gain: number[][] = [[], []];
  const danger: number[][] = [[], []];
  for (let k = 0; k < 2; k += 1) {
    for (let l = 0; l < 4; l += 1) {
      const est = estimateNote(p, l, k);
      (gain[k] as number[])[l] = 2 * est.z + TASTE_WEIGHT * (taste[l] as number);
      (danger[k] as number[])[l] = est.e / 3;
    }
  }
  return { gain, danger, best: gain.map((row) => Math.max(...row)) };
}

/** 從 `from` 格起、前一個音在 `prev` 格（沒有是 -1）時，剩下的格子最多還能再拿多少 gain。 */
function futureGain(table: NoteTable, prev: number, from: number): number {
  let best = 0;
  for (let s = Math.max(from, prev < 0 ? 0 : prev + MIN_SLOT_GAP); s < SLOTS; s += 1) {
    const kind = prev >= 0 && s - prev === MIN_SLOT_GAP ? 0 : 1;
    const top =
      table.slotBest === undefined ? table.best : (table.slotBest[s] as readonly number[]);
    const g = SLOT_DISCOUNT ** s * (top[kind] as number) + futureGain(table, s, s + MIN_SLOT_GAP);
    if (g > best) {
      best = g;
    }
  }
  return best;
}

/** 一組已經放下的音（草稿或編好的曲子）在對手的歷史之下的 gain 與 danger。 */
function composedValue(notes: readonly Note[], table: NoteTable): { gain: number; danger: number } {
  const kinds = gapKinds(notes);
  let gain = 0;
  let danger = 0;
  notes.forEach((n, i) => {
    const kind = kinds[i] as number;
    const gains =
      table.slotGain === undefined ? table.gain : (table.slotGain[n.slot] as NoteTable['gain']);
    const dangers =
      table.slotDanger === undefined
        ? table.danger
        : (table.slotDanger[n.slot] as NoteTable['danger']);
    gain += SLOT_DISCOUNT ** n.slot * ((gains[kind] as readonly number[])[n.lane] as number);
    danger = Math.max(danger, (dangers[kind] as readonly number[])[n.lane] as number);
  });
  return { gain, danger: Math.min(1, danger) };
}

function evaluateCompose(state: S6State, side: Side): { gain: number; danger: number } {
  const opp: Side = side === 0 ? 1 : 0;
  const table = noteTable(
    state.history[opp],
    state.taste[side] as readonly number[],
    state.sharedBeat,
  );
  const draft = state.composing[side];
  const value = composedValue(draft, table);
  const prev = draft.length === 0 ? -1 : (draft[draft.length - 1] as Note).slot;
  return {
    gain: value.gain + futureGain(table, prev, Math.floor(state.phaseTick / SLOT_TICKS)),
    danger: value.danger,
  };
}

function evaluatePlay(state: S6State, side: Side): { gain: number; danger: number } {
  const opp: Side = side === 0 ? 1 : 0;
  const phrase = state.phrases[opp];
  const mask = state.held[side];
  let running = 0;
  for (const h of state.hits[side]) {
    running += (3 * h) / NOTE_TICKS;
  }
  let gain = running - state.over[side] / OVER_PER_POINT;
  // 剛走完的那個 tick 上，哪一軌有音符通過；按著其他軌道就是多按。
  const q = state.phaseTick - 1;
  const idx = q >= 0 ? passingIndex(phrase, q) : -1;
  const wrong = popcount(mask & ~(idx >= 0 ? requiredMask(state, side, idx) : 0));
  // 搶拍：音符快到線（還沒開始）時按著那一軌，貪心型會被誘惑；精準型被 danger 擋下。
  if (idx < 0 && q >= 0) {
    for (const n of phrase) {
      const ahead = noteStart(n) - q;
      if (ahead > 0 && ahead <= ANTICIPATE_TICKS && (mask & (1 << n.lane)) !== 0) {
        gain += ANTICIPATE_GAIN;
      }
    }
  }
  gain += (state.points[side] - state.points[opp]) * SCORE_UNIT;
  let danger = Math.min(1, WRONG_LANE_DANGER * wrong);
  if (state.phaseTick === 0) {
    // 編曲剛結束的那一個 tick：最後一格的決定（第 95 個 tick）要看得到自己編的曲子，
    // 否則編曲階段最後一個 tick 的按放在評估裡沒有價值。只讀自己編的曲子與公開的歷史。
    const table = noteTable(
      state.history[opp],
      state.taste[side] as readonly number[],
      state.sharedBeat,
    );
    const value = composedValue(state.phrases[side], table);
    gain += value.gain;
    danger = Math.max(danger, value.danger);
  }
  return { gain, danger };
}

export const s6Game: Game<S6State> = {
  id: 'S-6',

  init(seed: number, config: GameConfig): S6State {
    if (config.maxTicks < TOTAL_TICKS) {
      throw new RangeError(`S-6 至少需要 ${TOTAL_TICKS} 個 tick，收到 ${config.maxTicks}`);
    }
    let rng = rngStateFor(seed, 's6');
    const taste: [number[], number[]] = [[], []];
    for (const side of [0, 1] as const) {
      for (let l = 0; l < 4; l += 1) {
        const [value, after] = nextFrom(rng);
        rng = after;
        (taste[side] as number[]).push(value);
      }
    }
    return makeState({
      sharedBeat: (config.params.sharedBeat ?? 0) !== 0,
      maxTicks: config.maxTicks,
      taste,
      rng,
    });
  },

  step(state: S6State, inputs: Inputs): S6State {
    if (state.phase === 'over') {
      return state;
    }
    const masks: [number, number] = [maskOf(inputs[0]), maskOf(inputs[1])];
    const tick = state.tick + 1;
    const held: [number, number] = masks;

    if (state.phase === 'compose') {
      const composing = composeStep(state, masks);
      if (state.phaseTick + 1 < COMPOSE_TICKS) {
        return { ...state, tick, held, composing, phaseTick: state.phaseTick + 1 };
      }
      const filled = fillPhrases(composing, state.rng);
      return {
        ...state,
        tick,
        held,
        composing: [[], []],
        phrases: filled.phrases,
        rng: filled.rng,
        hits: [filled.phrases[1].map(() => 0), filled.phrases[0].map(() => 0)],
        over: [0, 0],
        phase: 'play',
        phaseTick: 0,
      };
    }

    if (state.phase === 'play') {
      const moved = playStep(state, masks);
      const next: S6State = { ...state, tick, held, ...moved, phaseTick: state.phaseTick + 1 };
      return next.phaseTick < PLAY_TICKS ? next : settle(next);
    }

    // rest
    if (state.phaseTick + 1 < REST_TICKS) {
      return { ...state, tick, held, phaseTick: state.phaseTick + 1 };
    }
    const round = state.round + 1;
    return {
      ...state,
      tick,
      held,
      round,
      phase: round >= ROUNDS ? 'over' : 'compose',
      phaseTick: 0,
      phrases: [[], []],
      hits: [[], []],
      over: [0, 0],
    };
  },

  isOver(state: S6State): boolean {
    return state.phase === 'over';
  },

  score(state: S6State): readonly [number, number] {
    return state.points;
  },

  winner(state: S6State): Side | null {
    if (state.points[0] === state.points[1]) {
      return null;
    }
    return state.points[0] > state.points[1] ? 0 : 1;
  },

  actions(state: S6State, _side: Side): readonly Buttons[] {
    if (state.phase === 'play' && state.sharedBeat) {
      return SHARED_PLAY_ACTIONS;
    }
    return state.phase === 'compose' || state.phase === 'play' ? ACTIONS : REST_ACTIONS;
  },

  evaluate(state: S6State, side: Side): { gain: number; danger: number } {
    if (state.phase === 'compose') {
      const e = evaluateCompose(state, side);
      const opp: Side = side === 0 ? 1 : 0;
      return {
        gain: e.gain + (state.points[side] - state.points[opp]) * SCORE_UNIT,
        danger: e.danger,
      };
    }
    if (state.phase === 'play') {
      return evaluatePlay(state, side);
    }
    const opp: Side = side === 0 ? 1 : 0;
    return { gain: (state.points[side] - state.points[opp]) * SCORE_UNIT, danger: 0 };
  },
};
