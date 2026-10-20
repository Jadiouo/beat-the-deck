import { levelController, policyByName } from '../../../src/ai/level';
import type { PolicyKey } from '../../../src/ai/types';
import { copyButtons } from '../../../src/core/match';
import { intFrom, nextFrom, rngStateFor } from '../../../src/core/rng';
import type { RngState } from '../../../src/core/rng';
import type { Buttons, Game, GameConfig, Side } from '../../../src/core/types';

/**
 * 探針 A 篩檢工具（docs/PROBE-A-TRIAGE.md 第二、三節）。
 *
 * 問題：固定 AI 自己的狀態、只擾動對手的狀態，AI 的動作會不會改變？
 * 做法：從真實對局取 state，把「對手的元件」換成同一個種子、同一個 tick、別的 run 的真實對手
 * （玩得不一樣，所以位置／進度／分數／持有物都是真實的另一種歷史），其餘逐位元不動，
 * 通過該牌的 `legal` 才算數；再問 AI 在原 state 與擾動後 state 的動作是否不同。
 *
 * 這個檔案在 tests/ai/（不是模擬層），不受純度掃描管；但仍然不用時鐘與 `Math` 的亂數：
 * 亂數只用 `Det`（種子 + 標籤）。
 */

// ---------------------------------------------------------------------------
// 路徑工具：state 是純 JSON，路徑用點分隔，數字段是陣列索引（`players.1.cell`）。
// ---------------------------------------------------------------------------

export type Path = string;

/** 讀路徑；中途斷掉回傳 undefined。空路徑是根。 */
export function getAt(root: unknown, path: Path): unknown {
  if (path === '') {
    return root;
  }
  let node: unknown = root;
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object') {
      return undefined;
    }
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** 回傳新物件，路徑上的節點淺拷貝，沒動的分支共用參考；不改動 root。 */
export function setAt<T>(root: T, path: Path, value: unknown): T {
  const segs = path.split('.');
  const rec = (node: unknown, i: number): unknown => {
    if (i === segs.length) {
      return value;
    }
    const key = segs[i] as string;
    const copy: unknown = Array.isArray(node) ? node.slice() : { ...(node as object) };
    (copy as Record<string, unknown>)[key] = rec((node as Record<string, unknown>)?.[key], i + 1);
    return copy;
  };
  return rec(root, 0) as T;
}

/** 鍵排序後的 JSON：比較兩個 state 是否「內容相同」，不受鍵的建立順序影響。 */
export function canon(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(norm);
    }
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        out[k] = norm((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** 刪掉指定路徑後的深拷貝（陣列元素改成 null 以保留索引）；用來比對「路徑以外」。 */
export function stripPaths<T>(root: T, paths: readonly Path[]): unknown {
  const clone = JSON.parse(JSON.stringify(root)) as unknown;
  for (const path of paths) {
    const segs = path.split('.');
    const last = segs.pop() as string;
    const parent = getAt(clone, segs.join('.'));
    if (parent !== null && typeof parent === 'object') {
      if (Array.isArray(parent)) {
        parent[Number(last)] = null;
      } else {
        delete (parent as Record<string, unknown>)[last];
      }
    }
  }
  return clone;
}

/** 兩個 state 在 `paths` 以外是否逐位元（內容）相同。 */
export function sameOutside(a: unknown, b: unknown, paths: readonly Path[]): boolean {
  return canon(stripPaths(a, paths)) === canon(stripPaths(b, paths));
}

// ---------------------------------------------------------------------------
// 只靠種子的亂數
// ---------------------------------------------------------------------------

export class Det {
  private state: RngState;

  constructor(seed: number, label: string) {
    this.state = rngStateFor(seed, label);
  }

  next(): number {
    const [value, following] = nextFrom(this.state);
    this.state = following;
    return value;
  }

  int(n: number): number {
    const [value, following] = intFrom(this.state, n);
    this.state = following;
    return value;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 每張牌的規格
// ---------------------------------------------------------------------------

export interface SpecialPerturbation<S> {
  readonly name: string;
  readonly state: S;
}

export interface CardSpec<S = never> {
  readonly id: string;
  readonly game: Game<S>;
  /** 這張牌預設的性格（`meta.defaultPolicy`；沒有就用 pathfinder）。判準的主格會包含它。 */
  readonly defaultPolicy: PolicyKey;
  /**
   * 某一邊的元件在 state 裡的路徑清單。對手的元件是 `comp(1 − ai)`，自己的是 `comp(ai)`。
   * 路徑隨 state 變的牌（例如歷史清單的長度）會收到 `state`；沒給 `state` 時回傳靜態的那幾條。
   */
  readonly comp: (side: Side, state?: S) => readonly Path[];
  /**
   * 兩邊共用的混合欄位（例如 D-4 的 holder 陣列、D-8 的 paint 格子）：一個陣列裡同時放著兩邊的資料。
   * 這些路徑不算任何一邊的元件，但 `graftSide` 會改動其中「屬於被換掉那一邊」的格子。
   */
  readonly mixed?: readonly Path[];
  /** 混合欄位裡「被保留的那一邊」的格子是否逐位元不變；有 `mixed` 就必須給。 */
  readonly mixedOk?: (before: S, after: S, preserved: Side) => boolean;
  /**
   * 自訂的換元件做法（有混合欄位時用）：把 `donor` 裡 `side` 那一邊的元件換進 `query`，
   * 同時把混合欄位裡屬於 `side` 的格子一起換掉（另一邊的格子不動）。回傳 null 表示做不到（衝突）。
   * 沒給就用 `comp(side)` 的路徑逐條換。
   */
  readonly graftSide?: (query: S, donor: S, ai: Side, side: Side) => S | null;
  /**
   * 與環境糾纏、換掉就不再「只動對手」的對手欄位（例如 D-6 的歷史與現金：過去每筆買賣都留下價格偏移）。
   * 乾淨模式（`comp`）不碰它們；放寬模式另外把它們也換掉，只保證單一欄位自己有效、不保證跨欄位一致。
   * 放寬模式的數字只能當作「AI 有沒有讀這些欄位」的指標，不是合法局面上的量測，報告裡永遠分開列。
   */
  readonly entangled?: (side: Side, state?: S) => readonly Path[];
  /** 放寬模式（糾纏欄位）額外要求的相容性（例如歷史清單同樣長、同一個位置的紀錄屬於同一邊）。 */
  readonly donorOkRelaxed?: (query: S, donor: S, ai: Side) => boolean;
  /** 捐贈者與查詢的 state 是否相容（同一回合、同一階段……）；沒給就都相容。 */
  readonly donorOk?: (query: S, donor: S, ai: Side) => boolean;
  /** 合法性檢查：回傳 null（合法）或一個簡短的類別原因（會被計數，所以不要放數字）。 */
  readonly legal: (state: S, ai: Side) => string | null;
  /**
   * 刻意破壞的 state（重疊、出界、守恆被破壞……）：`legal` 必須全部擋下。證明合法性檢查有牙齒（測試用）。
   */
  readonly teeth?: (state: S, ai: Side) => readonly SpecialPerturbation<S>[];
  /** 這張牌特有的合法擾動（無敵、冷卻、被鎖……），不需要捐贈者。 */
  readonly special?: (state: S, ai: Side, det: Det) => readonly SpecialPerturbation<S>[];
  /** 對手的元件不綁時鐘時，也從同一種子別的 tick 取捐贈者。 */
  readonly farDonors?: boolean;
  /** 取樣方式：回合制的牌決策點稀疏，要更密地取、而且只留有決策可做的 tick。 */
  readonly sample?: { readonly every?: number; readonly decisionsOnly?: boolean };
  /** 這張牌的 init 要求的最短局長（S-6 要 2940）；測試用較短的局時取 max。 */
  readonly minTicks?: number;
  /** 這張牌無法乾淨篩檢的理由（沒有對手概念、對手狀態與環境／AI 自己的感知不可分……）。 */
  readonly notScreenable?: string;
}

// ---------------------------------------------------------------------------
// 真實對局取樣
// ---------------------------------------------------------------------------

export interface Matchup {
  readonly a: PolicyKey;
  readonly la: number;
  readonly b: PolicyKey;
  readonly lb: number;
  /** true：a 坐 1 號邊。 */
  readonly swap: boolean;
}

/** 每個種子打這 7 場。性格與等級混搭，含亂按的 random，讓同一個 tick 有七種不同的對手歷史。 */
export const MATCHUPS: readonly Matchup[] = [
  { a: 'precise', la: 10, b: 'pathfinder', lb: 10, swap: false },
  { a: 'pathfinder', la: 10, b: 'greedy', lb: 10, swap: true },
  { a: 'gambler', la: 10, b: 'precise', lb: 5, swap: false },
  { a: 'pathfinder', la: 5, b: 'pathfinder', lb: 10, swap: true },
  { a: 'greedy', la: 10, b: 'gambler', lb: 10, swap: false },
  { a: 'precise', la: 10, b: 'precise', lb: 10, swap: true },
  { a: 'random', la: 10, b: 'pathfinder', lb: 10, swap: false },
];

export interface Sample<S> {
  readonly run: number;
  readonly tick: number;
  readonly state: S;
}

export interface SeedCorpus<S> {
  readonly seed: number;
  readonly samples: readonly Sample<S>[];
}

export interface Corpus<S> {
  readonly seeds: readonly SeedCorpus<S>[];
}

export interface CorpusOptions {
  readonly seeds: readonly number[];
  readonly matchups: readonly Matchup[];
  /** 每隔幾個 tick 取一次樣。 */
  readonly every: number;
  /** true：只留至少一邊有 ≥ 2 個動作可選的 tick（回合制的牌）。 */
  readonly decisionsOnly?: boolean;
  readonly config?: GameConfig;
}

export const DEFAULT_CONFIG: GameConfig = { maxTicks: 3600, params: {} };

/** 每個種子、每個 matchup 打一場完整對局，沿途每 `every` 個 tick 取一次沒結束的 state。 */
export function collectCorpus<S>(game: Game<S>, opts: CorpusOptions): Corpus<S> {
  const config = opts.config ?? DEFAULT_CONFIG;
  const seeds: SeedCorpus<S>[] = [];
  for (const seed of opts.seeds) {
    const samples: Sample<S>[] = [];
    opts.matchups.forEach((m, run) => {
      const first = levelController(game, policyByName(m.a), m.la, seed * 64 + run * 2);
      const second = levelController(game, policyByName(m.b), m.lb, seed * 64 + run * 2 + 1);
      const c0 = m.swap ? second : first;
      const c1 = m.swap ? first : second;
      let state = game.init(seed, config);
      for (let tick = 0; !game.isOver(state) && tick < config.maxTicks; tick += 1) {
        if (
          tick % opts.every === 0 &&
          (opts.decisionsOnly !== true ||
            game.actions(state, 0).length >= 2 ||
            game.actions(state, 1).length >= 2)
        ) {
          samples.push({ run, tick, state });
        }
        state = game.step(state, [
          copyButtons(c0.decide(state, 0, tick)),
          copyButtons(c1.decide(state, 1, tick)),
        ]);
      }
    });
    seeds.push({ seed, samples });
  }
  return { seeds };
}

export interface Query<S> {
  readonly seed: number;
  readonly run: number;
  readonly tick: number;
  /** 被問的那一邊。 */
  readonly ai: Side;
  readonly state: S;
}

/**
 * 從一個種子的取樣裡挑 `n` 個決策點：沒結束、被問的那一邊有 ≥ 2 個動作。
 * 兩邊都符合時隨機挑一邊。挑法只靠 `det`，所以可重現。
 */
export function pickQueries<S>(
  game: Game<S>,
  seedCorpus: SeedCorpus<S>,
  n: number,
  det: Det,
): Query<S>[] {
  const candidates: Query<S>[] = [];
  for (const sample of seedCorpus.samples) {
    if (game.isOver(sample.state)) {
      continue;
    }
    const sides = ([0, 1] as const).filter((side) => game.actions(sample.state, side).length >= 2);
    if (sides.length === 0) {
      continue;
    }
    candidates.push({
      seed: seedCorpus.seed,
      run: sample.run,
      tick: sample.tick,
      ai: sides.length === 1 ? (sides[0] as Side) : (det.pick(sides) as Side),
      state: sample.state,
    });
  }
  const chosen = det.shuffle(candidates).slice(0, n);
  chosen.sort((x, y) => x.tick - y.tick || x.run - y.run);
  return chosen;
}

export interface Donors<S> {
  /** 同一個種子、同一個 tick、別的 run。 */
  readonly sameTick: readonly S[];
  /** 同一個種子、tick 不同的任何 run（含同一場對局的別的時刻）。 */
  readonly otherTick: readonly S[];
}

export function donorsFor<S>(seedCorpus: SeedCorpus<S>, q: Query<S>): Donors<S> {
  const sameTick: S[] = [];
  const otherTick: S[] = [];
  for (const s of seedCorpus.samples) {
    if (s.tick === q.tick && s.run !== q.run) {
      sameTick.push(s.state);
    } else if (s.tick !== q.tick) {
      otherTick.push(s.state);
    }
  }
  return { sameTick, otherTick };
}

// ---------------------------------------------------------------------------
// 擾動
// ---------------------------------------------------------------------------

export interface Perturbation<S> {
  /** `donor-same-tick`、`donor-far` 或 `special:<名字>`。 */
  readonly kind: string;
  readonly state: S;
  /** 對手減自己的領先符號翻轉了（用 `game.score`）。 */
  readonly leadFlip: boolean;
  readonly scoreChanged: boolean;
}

export interface PerturbStats {
  readonly attempted: number;
  /** 通過合法性、與原 state 不同的捐贈者擾動數（不含 special）。 */
  readonly accepted: number;
  readonly identical: number;
  readonly illegal: Readonly<Record<string, number>>;
}

export interface PerturbResult<S> {
  readonly list: readonly Perturbation<S>[];
  readonly stats: PerturbStats;
}

const IDLE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

function hasNonFinite(value: unknown): boolean {
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasNonFinite);
  }
  return false;
}

/** 牌的 `legal`，再加上通用的煙霧檢查：數字有限、step 一次不丟錯。 */
export function legalOrReason<S>(spec: CardSpec<S>, state: S, ai: Side): string | null {
  const reason = spec.legal(state, ai);
  if (reason !== null) {
    return reason;
  }
  if (hasNonFinite(state)) {
    return '非有限數';
  }
  try {
    const next = spec.game.step(state, [IDLE, IDLE]);
    if (hasNonFinite(next)) {
      return 'step 後出現非有限數';
    }
  } catch {
    return 'step 丟錯';
  }
  return null;
}

/** 把 `donor` 在 `paths` 上的值整個換進 `state`；捐贈者缺其中一條路徑就回傳 null。 */
export function graft<S>(state: S, donor: S, paths: readonly Path[]): S | null {
  let out = state;
  for (const path of paths) {
    const value = getAt(donor, path);
    if (value === undefined) {
      return null;
    }
    out = setAt(out, path, value);
  }
  return out;
}

const MAX_TRIES = 40;
const FAR_SAMPLE = 12;

function marginOf<S>(game: Game<S>, state: S, ai: Side): number {
  const score = game.score(state);
  return (score[ai === 0 ? 1 : 0] as number) - (score[ai] as number);
}

function flipped(before: number, after: number): boolean {
  return (before < 0 && after > 0) || (before > 0 && after < 0);
}

function sameScore<S>(game: Game<S>, a: S, b: S): boolean {
  const x = game.score(a);
  const y = game.score(b);
  return x[0] === y[0] && x[1] === y[1];
}

function perturbGraft<S>(
  spec: CardSpec<S>,
  q: Query<S>,
  donors: Donors<S>,
  det: Det,
  max: number,
  target: Side,
  withSpecial: boolean,
  extraPaths: readonly Path[] = [],
): PerturbResult<S> {
  const relaxed = extraPaths.length > 0;
  const paths = [...spec.comp(target, q.state), ...extraPaths];
  const base = canon(q.state);
  const marginBefore = marginOf(spec.game, q.state, q.ai);
  // 先用 donorOk 過濾（相容的才進候選），不相容的只計數，不浪費嘗試次數。
  const compatible = (d: S): boolean =>
    (spec.donorOk === undefined || spec.donorOk(q.state, d, q.ai)) &&
    (!relaxed || spec.donorOkRelaxed === undefined || spec.donorOkRelaxed(q.state, d, q.ai));
  const sameList = donors.sameTick.filter(compatible);
  let skipped = donors.sameTick.length - sameList.length;
  const tagged: { donor: S; kind: string }[] = det
    .shuffle(sameList)
    .map((donor) => ({ donor, kind: relaxed ? 'relaxed-same-tick' : 'donor-same-tick' }));
  if (spec.farDonors === true) {
    const farList = donors.otherTick.filter(compatible);
    skipped += donors.otherTick.length - farList.length;
    for (const donor of det.shuffle(farList).slice(0, FAR_SAMPLE)) {
      tagged.push({ donor, kind: relaxed ? 'relaxed-far' : 'donor-far' });
    }
  }
  const legalList: Perturbation<S>[] = [];
  const illegal: Record<string, number> = {};
  if (skipped > 0) {
    illegal['捐贈者不相容（已略過，不算嘗試）'] = skipped;
  }
  let attempted = 0;
  let identical = 0;
  for (const { donor, kind } of tagged.slice(0, MAX_TRIES)) {
    attempted += 1;
    const customised =
      spec.graftSide === undefined ? null : spec.graftSide(q.state, donor, q.ai, target);
    const state =
      spec.graftSide === undefined
        ? graft(q.state, donor, paths)
        : customised === null || !relaxed
          ? customised
          : graft(customised, donor, extraPaths);
    if (state === null) {
      illegal['捐贈者缺路徑或衝突'] = (illegal['捐贈者缺路徑或衝突'] ?? 0) + 1;
      continue;
    }
    if (canon(state) === base) {
      identical += 1;
      continue;
    }
    if (
      spec.mixedOk !== undefined &&
      !spec.mixedOk(q.state, state, target === q.ai ? (q.ai === 0 ? 1 : 0) : q.ai)
    ) {
      illegal['混合欄位的另一邊被動到'] = (illegal['混合欄位的另一邊被動到'] ?? 0) + 1;
      continue;
    }
    const reason = legalOrReason(spec, state, q.ai);
    if (reason !== null) {
      illegal[reason] = (illegal[reason] ?? 0) + 1;
      continue;
    }
    legalList.push({
      kind,
      state,
      leadFlip: flipped(marginBefore, marginOf(spec.game, state, q.ai)),
      scoreChanged: !sameScore(spec.game, q.state, state),
    });
  }
  // 領先反轉的優先留，至少留一半名額（有的話）；其餘依序。
  const flips = legalList.filter((p) => p.leadFlip);
  const rest = legalList.filter((p) => !p.leadFlip);
  const keepFlips = flips.slice(0, Math.max(1, Math.ceil(max / 2)));
  const chosen = [...keepFlips, ...rest.slice(0, Math.max(0, max - keepFlips.length))];
  const accepted = chosen.length;
  const list: Perturbation<S>[] = chosen.slice();
  if (withSpecial && spec.special !== undefined) {
    for (const sp of spec.special(q.state, q.ai, det)) {
      if (canon(sp.state) === base) {
        continue;
      }
      const reason = legalOrReason(spec, sp.state, q.ai);
      if (reason !== null) {
        illegal[`special:${sp.name}:${reason}`] =
          (illegal[`special:${sp.name}:${reason}`] ?? 0) + 1;
        continue;
      }
      list.push({
        kind: `special:${sp.name}`,
        state: sp.state,
        leadFlip: flipped(marginBefore, marginOf(spec.game, sp.state, q.ai)),
        scoreChanged: !sameScore(spec.game, q.state, sp.state),
      });
    }
  }
  return { list, stats: { attempted, accepted, identical, illegal } };
}

/** 把對手的元件換成別的真實對手的（加上這張牌特有的 special）。 */
export function perturbOpponent<S>(
  spec: CardSpec<S>,
  q: Query<S>,
  donors: Donors<S>,
  det: Det,
  max: number,
): PerturbResult<S> {
  return perturbGraft(spec, q, donors, det, max, q.ai === 0 ? 1 : 0, true);
}

/** 放寬模式：連同與環境糾纏的欄位一起換掉（只有宣告 `entangled` 的牌有）；沒有就回傳空的。 */
export function perturbRelaxed<S>(
  spec: CardSpec<S>,
  q: Query<S>,
  donors: Donors<S>,
  det: Det,
  max: number,
): PerturbResult<S> {
  const opp: Side = q.ai === 0 ? 1 : 0;
  const extra = spec.entangled === undefined ? [] : spec.entangled(opp, q.state);
  if (extra.length === 0) {
    return { list: [], stats: { attempted: 0, accepted: 0, identical: 0, illegal: {} } };
  }
  return perturbGraft(spec, q, donors, det, max, opp, false, extra);
}

/**
 * 世界對照：整個 state 換成同種子、同 tick、別的 run 的真實 state（一定合法）。AI 的決策若連這個都不變，
 * 它就是對整個局面的常數函數；有變，而自我／對手都不變，AI 讀的就是共用的環境。
 */
export function perturbWorld<S>(
  q: Query<S>,
  donors: Donors<S>,
  det: Det,
  max: number,
): readonly Perturbation<S>[] {
  // 同 tick 的捐贈者優先；回合制的牌各局節奏不同、同一個 tick 常常沒有別的 run，就用別的時刻的真實 state。
  const pool = [...det.shuffle(donors.sameTick), ...det.shuffle(donors.otherTick)];
  return pool
    .filter((d) => canon(d) !== canon(q.state))
    .slice(0, max)
    .map((state) => ({ kind: 'world', state, leadFlip: false, scoreChanged: false }));
}

/** 正對照：把「自己」的元件換成別人的。 */
export function perturbSelf<S>(
  spec: CardSpec<S>,
  q: Query<S>,
  donors: Donors<S>,
  det: Det,
  max: number,
): PerturbResult<S> {
  return perturbGraft(spec, q, donors, det, max, q.ai, false);
}

/**
 * 正對照的放寬版：有糾纏欄位的牌，把自己的糾纏欄位（H-5 的暗牌這種 AI 最依賴的欄位）也一起換。
 * 沒有糾纏欄位的牌回傳空的。
 */
export function perturbSelfRelaxed<S>(
  spec: CardSpec<S>,
  q: Query<S>,
  donors: Donors<S>,
  det: Det,
  max: number,
): PerturbResult<S> {
  const extra = spec.entangled === undefined ? [] : spec.entangled(q.ai, q.state);
  if (extra.length === 0) {
    return { list: [], stats: { attempted: 0, accepted: 0, identical: 0, illegal: {} } };
  }
  return perturbGraft(spec, q, donors, det, max, q.ai, false, extra);
}

export interface PathPerturbation<S> {
  /** 路徑的樣板：數字索引換成 `*`，對手那一邊換成 `o`（例如 `history.*.o`）。 */
  readonly label: string;
  readonly state: S;
}

export function pathLabel(path: Path, opp: Side): string {
  const segs = path.split('.');
  return segs
    .map((seg, i) => {
      if (!/^\d+$/.test(seg)) {
        return seg;
      }
      if (i === segs.length - 1) {
        return Number(seg) === opp ? 'o' : seg;
      }
      return '*';
    })
    .join('.');
}

/** 機制：一次只換對手元件裡的一條路徑，看 AI 讀的是哪一條。每條路徑最多 `perPath` 個合法擾動。 */
export function perturbByPath<S>(
  spec: CardSpec<S>,
  q: Query<S>,
  donors: Donors<S>,
  det: Det,
  perPath: number,
): readonly PathPerturbation<S>[] {
  const opp: Side = q.ai === 0 ? 1 : 0;
  const compatible = (d: S): boolean =>
    spec.donorOk === undefined || spec.donorOk(q.state, d, q.ai);
  const pool = [
    ...det.shuffle(donors.sameTick.filter(compatible)),
    ...(spec.farDonors === true
      ? det.shuffle(donors.otherTick.filter(compatible)).slice(0, FAR_SAMPLE)
      : []),
  ];
  const out: PathPerturbation<S>[] = [];
  for (const path of spec.comp(opp, q.state)) {
    const mine = canon(getAt(q.state, path));
    let taken = 0;
    for (const donor of pool.slice(0, MAX_TRIES)) {
      if (taken >= perPath) {
        break;
      }
      const value = getAt(donor, path);
      if (value === undefined || canon(value) === mine) {
        continue;
      }
      const state = setAt(q.state, path, value);
      if (legalOrReason(spec, state, q.ai) !== null) {
        continue;
      }
      out.push({ label: pathLabel(path, opp), state });
      taken += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// AI 的動作
// ---------------------------------------------------------------------------

export function sameButtons(a: Buttons, b: Buttons): boolean {
  return (
    a.up === b.up &&
    a.down === b.down &&
    a.left === b.left &&
    a.right === b.right &&
    a.a === b.a &&
    a.b === b.b
  );
}

/** 新建一個控制器，在這個 state 上做第一次決定（無歷史，所以沒有反應延遲的重播）。 */
export function decideAs<S>(
  game: Game<S>,
  policy: PolicyKey,
  level: number,
  seed: number,
  state: S,
  side: Side,
): Buttons {
  const tick = (state as { tick?: number }).tick ?? 0;
  return levelController(game, policyByName(policy), level, seed).decide(state, side, tick);
}

// ---------------------------------------------------------------------------
// 量測與分類
// ---------------------------------------------------------------------------

export interface Tally {
  queries: number;
  changed: number;
}

export interface CellMeasure {
  readonly policy: PolicyKey;
  readonly level: number;
  /** 分母：這一格問了幾個（決策點 × 擾動）。 */
  queries: number;
  changed: number;
  /** 至少一個擾動改變了動作的決策點數。 */
  statesAny: number;
  flip: Tally;
  noflip: Tally;
  byKind: Record<string, Tally>;
  /** 機制：一次只換一條路徑時，各路徑的改變率。 */
  byPath: Record<string, Tally>;
  /** 世界對照：整個 state 換成別的真實 state（見 `perturbWorld`）。 */
  world: Tally;
  /** 放寬模式（連糾纏欄位一起換，不保證跨欄位一致）：只有宣告 `entangled` 的牌有。永遠與乾淨模式分開報。 */
  relaxed: Tally;
  /** 正對照：自己的元件被換掉。 */
  self: Tally;
  /** 負對照：對手的元件換成自己現在的值，必須是 0。 */
  nullChanged: number;
}

export interface CardMeasure {
  readonly id: string;
  readonly defaultPolicy: string;
  /** 有 ≥ 1 個擾動的決策點數。 */
  readonly states: number;
  /** 實際接受的對手擾動總數（每格的分母）。 */
  readonly perturbations: number;
  readonly attempted: number;
  readonly illegal: Readonly<Record<string, number>>;
  readonly identical: number;
  readonly cells: readonly CellMeasure[];
  readonly notScreenable?: string | undefined;
}

export interface MeasureConfig {
  readonly policies: readonly PolicyKey[];
  readonly levels: readonly number[];
  /** 決策點數上限（平均分給種子）。 */
  readonly queries: number;
  readonly maxPerts: number;
  readonly maxSelf: number;
  readonly seed: number;
}

export const DEFAULT_POLICIES: readonly PolicyKey[] = [
  'precise',
  'pathfinder',
  'greedy',
  'gambler',
];
export const DEFAULT_LEVELS: readonly number[] = [10, 5];

interface Prepared<S> {
  readonly q: Query<S>;
  readonly byPath: readonly PathPerturbation<S>[];
  readonly opp: readonly Perturbation<S>[];
  readonly relaxed: readonly Perturbation<S>[];
  readonly world: readonly Perturbation<S>[];
  readonly self: readonly Perturbation<S>[];
  readonly identity: S;
}

export function measureCard<S>(
  spec: CardSpec<S>,
  corpus: Corpus<S>,
  cfg: MeasureConfig,
): CardMeasure {
  const det = new Det(cfg.seed, `measure:${spec.id}`);
  const perSeed = Math.ceil(cfg.queries / Math.max(1, corpus.seeds.length));
  const prepared: Prepared<S>[] = [];
  let attempted = 0;
  let identical = 0;
  const illegal: Record<string, number> = {};
  for (const seedCorpus of corpus.seeds) {
    for (const q of pickQueries(spec.game, seedCorpus, perSeed, det)) {
      const donors = donorsFor(seedCorpus, q);
      const opp = perturbOpponent(spec, q, donors, det, cfg.maxPerts);
      const selfClean = perturbSelf(spec, q, donors, det, cfg.maxSelf);
      const selfRelaxed = perturbSelfRelaxed(spec, q, donors, det, cfg.maxSelf);
      const self = { list: [...selfClean.list, ...selfRelaxed.list] };
      attempted += opp.stats.attempted;
      identical += opp.stats.identical;
      for (const [k, v] of Object.entries(opp.stats.illegal)) {
        illegal[k] = (illegal[k] ?? 0) + v;
      }
      const relaxedList = perturbRelaxed(spec, q, donors, det, 4);
      const worldList = perturbWorld(q, donors, det, 3);
      if (
        opp.list.length === 0 &&
        self.list.length === 0 &&
        relaxedList.list.length === 0 &&
        worldList.length === 0
      ) {
        continue;
      }
      // 負對照：把對手的元件換成「自己現在的值」（內容相同的新物件）。
      let identity = q.state;
      for (const path of spec.comp(q.ai === 0 ? 1 : 0, q.state)) {
        identity = setAt(identity, path, JSON.parse(JSON.stringify(getAt(q.state, path))));
      }
      const byPath = perturbByPath(spec, q, donors, det, 2);
      prepared.push({
        q,
        byPath,
        opp: opp.list,
        relaxed: relaxedList.list,
        world: worldList,
        self: self.list,
        identity,
      });
    }
  }
  const states = prepared.filter((p) => p.opp.length > 0).length;
  const perturbations = prepared.reduce((n, p) => n + p.opp.length, 0);
  const cells: CellMeasure[] = [];
  for (const policy of cfg.policies) {
    for (const level of cfg.levels) {
      const cell: CellMeasure = {
        policy,
        level,
        queries: 0,
        changed: 0,
        statesAny: 0,
        flip: { queries: 0, changed: 0 },
        noflip: { queries: 0, changed: 0 },
        byKind: {},
        byPath: {},
        relaxed: { queries: 0, changed: 0 },
        world: { queries: 0, changed: 0 },
        self: { queries: 0, changed: 0 },
        nullChanged: 0,
      };
      prepared.forEach((p, index) => {
        const seed = 1000 + index;
        const base = decideAs(spec.game, policy, level, seed, p.q.state, p.q.ai);
        if (!sameButtons(base, decideAs(spec.game, policy, level, seed, p.identity, p.q.ai))) {
          cell.nullChanged += 1;
        }
        let any = false;
        for (const pert of p.opp) {
          const moved = !sameButtons(
            base,
            decideAs(spec.game, policy, level, seed, pert.state, p.q.ai),
          );
          cell.queries += 1;
          const bucket = pert.leadFlip ? cell.flip : cell.noflip;
          bucket.queries += 1;
          const kind = (cell.byKind[pert.kind] ??= { queries: 0, changed: 0 });
          kind.queries += 1;
          if (moved) {
            cell.changed += 1;
            bucket.changed += 1;
            kind.changed += 1;
            any = true;
          }
        }
        if (any) {
          cell.statesAny += 1;
        }
        for (const pert of p.world) {
          cell.world.queries += 1;
          if (!sameButtons(base, decideAs(spec.game, policy, level, seed, pert.state, p.q.ai))) {
            cell.world.changed += 1;
          }
        }
        for (const pert of p.relaxed) {
          cell.relaxed.queries += 1;
          if (!sameButtons(base, decideAs(spec.game, policy, level, seed, pert.state, p.q.ai))) {
            cell.relaxed.changed += 1;
          }
        }
        for (const pp of p.byPath) {
          const tally = (cell.byPath[pp.label] ??= { queries: 0, changed: 0 });
          tally.queries += 1;
          if (!sameButtons(base, decideAs(spec.game, policy, level, seed, pp.state, p.q.ai))) {
            tally.changed += 1;
          }
        }
        for (const pert of p.self) {
          cell.self.queries += 1;
          if (!sameButtons(base, decideAs(spec.game, policy, level, seed, pert.state, p.q.ai))) {
            cell.self.changed += 1;
          }
        }
      });
      cells.push(cell);
    }
  }
  return {
    id: spec.id,
    defaultPolicy: spec.defaultPolicy,
    states,
    perturbations,
    attempted,
    illegal,
    identical,
    cells,
    notScreenable: spec.notScreenable,
  };
}

/** Wilson 95% 區間（k 次、n 個）。 */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) {
    return [0, 1];
  }
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [k === 0 ? 0 : Math.max(0, centre - margin), k === n ? 1 : Math.min(1, centre + margin)];
}

/** 判準（量之前固定，docs/PROBE-A-TRIAGE.md 第三節）。 */
export const CLASSIFY = { zeroMax: 0.01, worthMin: 0.05, selfMin: 0.05 } as const;

export type Verdict =
  'structural-zero' | 'worth-probe-a' | 'grey' | 'constant-policy' | 'not-screenable';

export interface Classification {
  readonly verdict: Verdict;
  readonly reason: string;
  /** 乾淨模式：主格的最大改變率。 */
  readonly rMax: number;
  /** 自我改變率（正對照）的最大值。 */
  readonly sMax: number;
  /** 世界對照（整個 state 換成別的真實 state）的最大改變率。 */
  readonly wMax: number;
  /** 乾淨模式：這張牌預設性格（實際上線的那個 AI）的最大改變率。判定類別不用它，排序用它。 */
  readonly rDefault: number;
  /** 放寬模式：主格的最大改變率；沒有放寬模式是 null。 */
  readonly rRelaxed: number | null;
}

const rate = (t: Tally): number => (t.queries === 0 ? 0 : t.changed / t.queries);

export function classify(m: CardMeasure): Classification {
  const primary = new Set<string>(['precise', 'pathfinder', m.defaultPolicy]);
  const primaryCells = m.cells.filter((c) => primary.has(c.policy));
  const rMax = primaryCells.reduce((x, c) => Math.max(x, rate(c)), 0);
  const sMax = m.cells.reduce((x, c) => Math.max(x, rate(c.self)), 0);
  const wMax = m.cells.reduce((x, c) => Math.max(x, rate(c.world)), 0);
  const rDefault = m.cells
    .filter((c) => c.policy === m.defaultPolicy)
    .reduce((x, c) => Math.max(x, rate(c)), 0);
  const hasRelaxed = primaryCells.some((c) => c.relaxed.queries > 0);
  const rRelaxed = hasRelaxed
    ? primaryCells.reduce((x, c) => Math.max(x, rate(c.relaxed)), 0)
    : null;
  const pctText = (x: number): string => `${(100 * x).toFixed(1)}%`;
  const out = (verdict: Verdict, reason: string): Classification => ({
    verdict,
    reason,
    rMax,
    sMax,
    wMax,
    rDefault,
    rRelaxed,
  });
  if (m.notScreenable !== undefined) {
    const hint =
      rRelaxed === null ? '' : `；放寬模式的最大改變率 ${pctText(rRelaxed)}（不是合法局面）`;
    return out('not-screenable', `${m.notScreenable}${hint}`);
  }
  if (m.perturbations === 0) {
    const hint = rRelaxed === null ? '' : `；放寬模式的最大改變率 ${pctText(rRelaxed)}`;
    return out('not-screenable', `沒有任何合法擾動${hint}`);
  }
  if (rMax >= CLASSIFY.worthMin) {
    return out('worth-probe-a', `主格最大改變率 ${pctText(rMax)}`);
  }
  if (rMax <= CLASSIFY.zeroMax) {
    if (rRelaxed !== null && rRelaxed >= CLASSIFY.worthMin) {
      return out(
        'not-screenable',
        `乾淨擾動量不到（${pctText(rMax)}），但放寬模式（連糾纏欄位一起換）${pctText(rRelaxed)}：AI 讀的是與環境糾纏的欄位`,
      );
    }
    if (sMax >= CLASSIFY.selfMin || wMax >= CLASSIFY.selfMin) {
      const reads =
        sMax >= CLASSIFY.selfMin ? 'AI 讀自己、不讀對手' : 'AI 只讀共用環境、不讀雙方的元件';
      return out(
        'structural-zero',
        rRelaxed === null ? reads : `${reads}（放寬模式也只有 ${pctText(rRelaxed)}）`,
      );
    }
    return out('constant-policy', 'AI 對整個局面近似常數');
  }
  return out('grey', `主格最大改變率 ${pctText(rMax)}`);
}

/** 一張牌的人讀報告（量測 driver 用）。 */
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

export function formatMeasure(m: CardMeasure, c: Classification): string {
  const lines: string[] = [];
  lines.push(
    `${m.id}  判定=${c.verdict}（${c.reason}）  R_max=${pct(c.rMax)}  預設性格=${m.defaultPolicy}:${pct(c.rDefault)}  S_max=${pct(c.sMax)}  W_max=${pct(c.wMax)}  放寬=${c.rRelaxed === null ? 'n/a' : pct(c.rRelaxed)}`,
  );
  lines.push(
    `  決策點=${m.states}  擾動=${m.perturbations}（嘗試 ${m.attempted}，與原本相同 ${m.identical}）  拒絕=${JSON.stringify(m.illegal)}`,
  );
  for (const cell of m.cells) {
    const [lo, hi] = wilson(cell.changed, cell.queries);
    const flip = cell.flip.queries === 0 ? 'n/a' : `${cell.flip.changed}/${cell.flip.queries}`;
    const kinds = Object.entries(cell.byKind)
      .map(([k, t]) => `${k}:${t.changed}/${t.queries}`)
      .join(' ');
    const paths = Object.entries(cell.byPath)
      .map(([k, t]) => `${k}:${t.changed}/${t.queries}`)
      .join(' ');
    lines.push(
      `  ${cell.policy.padEnd(10)} L${String(cell.level).padEnd(2)} 改變=${cell.changed}/${cell.queries}=${pct(cell.queries === 0 ? 0 : cell.changed / cell.queries)} [${pct(lo)},${pct(hi)}]  有改變的決策點=${cell.statesAny}/${m.states}  領先反轉=${flip}  自我=${cell.self.changed}/${cell.self.queries}  世界=${cell.world.changed}/${cell.world.queries}  放寬=${cell.relaxed.changed}/${cell.relaxed.queries}  null=${cell.nullChanged}  ${kinds}  路徑[${paths}]`,
    );
  }
  return lines.join('\n');
}
