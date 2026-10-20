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
  /** 某一邊的元件在 state 裡的路徑清單。對手的元件是 `comp(1 − ai)`，自己的是 `comp(ai)`。 */
  readonly comp: (side: Side) => readonly Path[];
  /** 合法性檢查：回傳 null（合法）或一個簡短的類別原因（會被計數，所以不要放數字）。 */
  readonly legal: (state: S, ai: Side) => string | null;
  /** 這張牌特有的合法擾動（無敵、冷卻、被鎖……），不需要捐贈者。 */
  readonly special?: (state: S, ai: Side, det: Det) => readonly SpecialPerturbation<S>[];
  /** 對手的元件不綁時鐘時，也從同一種子別的 tick 取捐贈者。 */
  readonly farDonors?: boolean;
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
        if (tick % opts.every === 0) {
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
  /** 同一個種子、tick 相差 ≥ FAR_TICKS 的任何 run。 */
  readonly otherTick: readonly S[];
}

export const FAR_TICKS = 120;

export function donorsFor<S>(seedCorpus: SeedCorpus<S>, q: Query<S>): Donors<S> {
  const sameTick: S[] = [];
  const otherTick: S[] = [];
  for (const s of seedCorpus.samples) {
    if (s.tick === q.tick && s.run !== q.run) {
      sameTick.push(s.state);
    } else if (Math.abs(s.tick - q.tick) >= FAR_TICKS) {
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

/** 把 `donor` 在 `paths` 上的值整個換進 `state`；路徑在捐贈者身上不存在就丟錯（規格寫錯）。 */
export function graft<S>(state: S, donor: S, paths: readonly Path[]): S {
  let out = state;
  for (const path of paths) {
    const value = getAt(donor, path);
    if (value === undefined) {
      throw new Error(`規格的路徑 ${path} 在捐贈者的 state 裡不存在`);
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
): PerturbResult<S> {
  const paths = spec.comp(target);
  const base = canon(q.state);
  const marginBefore = marginOf(spec.game, q.state, q.ai);
  const tagged: { donor: S; kind: string }[] = det
    .shuffle(donors.sameTick)
    .map((donor) => ({ donor, kind: 'donor-same-tick' }));
  if (spec.farDonors === true) {
    for (const donor of det.shuffle(donors.otherTick).slice(0, FAR_SAMPLE)) {
      tagged.push({ donor, kind: 'donor-far' });
    }
  }
  const legalList: Perturbation<S>[] = [];
  const illegal: Record<string, number> = {};
  let attempted = 0;
  let identical = 0;
  for (const { donor, kind } of tagged.slice(0, MAX_TRIES)) {
    attempted += 1;
    const state = graft(q.state, donor, paths);
    if (canon(state) === base) {
      identical += 1;
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
  readonly opp: readonly Perturbation<S>[];
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
      const self = perturbSelf(spec, q, donors, det, cfg.maxSelf);
      attempted += opp.stats.attempted;
      identical += opp.stats.identical;
      for (const [k, v] of Object.entries(opp.stats.illegal)) {
        illegal[k] = (illegal[k] ?? 0) + v;
      }
      if (opp.list.length === 0 && self.list.length === 0) {
        continue;
      }
      // 負對照：把對手的元件換成「自己現在的值」（內容相同的新物件）。
      let identity = q.state;
      for (const path of spec.comp(q.ai === 0 ? 1 : 0)) {
        identity = setAt(identity, path, JSON.parse(JSON.stringify(getAt(q.state, path))));
      }
      prepared.push({ q, opp: opp.list, self: self.list, identity });
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
  readonly rMax: number;
  readonly sMax: number;
}

const rate = (t: Tally): number => (t.queries === 0 ? 0 : t.changed / t.queries);

export function classify(m: CardMeasure): Classification {
  const primary = new Set<string>(['precise', 'pathfinder', m.defaultPolicy]);
  const primaryCells = m.cells.filter((c) => primary.has(c.policy) && c.queries > 0);
  const rMax = primaryCells.reduce((x, c) => Math.max(x, c.changed / c.queries), 0);
  const sMax = m.cells.reduce((x, c) => Math.max(x, rate(c.self)), 0);
  if (m.notScreenable !== undefined) {
    return { verdict: 'not-screenable', reason: m.notScreenable, rMax, sMax };
  }
  if (m.perturbations === 0) {
    return { verdict: 'not-screenable', reason: '沒有任何合法擾動', rMax, sMax };
  }
  if (rMax >= CLASSIFY.worthMin) {
    return {
      verdict: 'worth-probe-a',
      reason: `主格最大改變率 ${(100 * rMax).toFixed(1)}%`,
      rMax,
      sMax,
    };
  }
  if (rMax <= CLASSIFY.zeroMax) {
    if (sMax >= CLASSIFY.selfMin) {
      return { verdict: 'structural-zero', reason: 'AI 讀自己、不讀對手', rMax, sMax };
    }
    return { verdict: 'constant-policy', reason: 'AI 對整個局面近似常數', rMax, sMax };
  }
  return { verdict: 'grey', reason: `主格最大改變率 ${(100 * rMax).toFixed(1)}%`, rMax, sMax };
}
