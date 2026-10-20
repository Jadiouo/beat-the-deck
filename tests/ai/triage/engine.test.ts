import { describe, expect, it } from 'vitest';

import { deepFreeze } from '../../contract/freeze';
import {
  CLASSIFY,
  Det,
  MATCHUPS,
  classify,
  collectCorpus,
  decideAs,
  donorsFor,
  getAt,
  measureCard,
  perturbOpponent,
  perturbRelaxed,
  perturbSelf,
  pickQueries,
  sameOutside,
  setAt,
  stripPaths,
  wilson,
} from './engine';
import type { CardMeasure, Corpus, Query } from './engine';
import { specFor } from './specs';

/**
 * 探針 A 篩檢工具的測試（docs/PROBE-A-TRIAGE.md 第二節「擾動方法」）。
 *
 * 這一檔蓋四件事（任務書要求）：
 * 1. 擾動真的只動了對手的元件，自己的元件與共用的環境逐位元不變（用 deepFreeze 的輸入，寫入會丟錯）；
 * 2. 擾動後的 state 通過該牌的合法性檢查，而且合法性檢查本身有牙齒（被破壞的 state 會被擋）；
 * 3. 取樣是真實對局（決定性、tick 對齊、第 0 個 tick 就是 init）；
 * 4. 方法看得見東西：把「自己的元件」換掉時，AI 的動作會變（正對照）；對手的元件原封不動換回去時不會變（負對照）。
 * 對照組（D-5、D-6、D-10、S-8 對 S-6、S-10）放在 controls.test.ts，因為它們比較慢。
 */

const CORPUS_SEEDS = [6000, 6001];
const SMALL_MATCHUPS = MATCHUPS.slice(0, 4);

function smallCorpus(id: string): { corpus: Corpus<never>; spec: ReturnType<typeof specFor> } {
  const spec = specFor(id);
  const corpus = collectCorpus(spec.game, {
    seeds: CORPUS_SEEDS,
    matchups: SMALL_MATCHUPS,
    every: 60,
    config: { maxTicks: 900, params: {} },
  }) as unknown as Corpus<never>;
  return { corpus, spec };
}

describe('路徑工具', () => {
  it('getAt 讀巢狀路徑，數字段當陣列索引', () => {
    const obj = { a: { b: [1, { c: 2 }] }, d: [10, 20] };
    expect(getAt(obj, 'a.b.1.c')).toBe(2);
    expect(getAt(obj, 'd.1')).toBe(20);
    expect(getAt(obj, 'a.x.y')).toBeUndefined();
  });

  it('setAt 回傳新物件，原物件逐位元不變，沒動的分支共用參考', () => {
    const obj = deepFreeze({ a: { b: [1, { c: 2 }] }, d: [10, 20] });
    const next = setAt(obj, 'a.b.1.c', 9);
    expect(getAt(next, 'a.b.1.c')).toBe(9);
    expect(getAt(obj, 'a.b.1.c')).toBe(2);
    expect(next.d).toBe(obj.d);
    expect(JSON.stringify(obj)).toBe('{"a":{"b":[1,{"c":2}]},"d":[10,20]}');
  });

  it('stripPaths 刪掉指定路徑、其餘保留；sameOutside 只比路徑以外的部分', () => {
    const a = { x: [1, 2], y: 3 };
    expect(JSON.stringify(stripPaths(a, ['x.1']))).toBe('{"x":[1,null],"y":3}');
    expect(sameOutside(a, { x: [1, 99], y: 3 }, ['x.1'])).toBe(true);
    expect(sameOutside(a, { x: [1, 99], y: 4 }, ['x.1'])).toBe(false);
    expect(sameOutside(a, { x: [7, 2], y: 3 }, ['x.1'])).toBe(false);
  });
});

describe('Det（只靠種子的亂數）', () => {
  it('同種子同標籤同序列，不同標籤不同序列', () => {
    const a = new Det(1, 'x');
    const b = new Det(1, 'x');
    const c = new Det(1, 'y');
    const sa = [a.next(), a.next(), a.int(100)];
    const sb = [b.next(), b.next(), b.int(100)];
    const sc = [c.next(), c.next(), c.int(100)];
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });
});

describe('取樣是真實對局', () => {
  it('同樣的設定取兩次，逐位元相同；第 0 個 tick 就是 init；tick 對齊 every', () => {
    const spec = specFor('C-A');
    const opts = { seeds: [6000], matchups: SMALL_MATCHUPS, every: 60 };
    const a = collectCorpus(spec.game, opts);
    const b = collectCorpus(spec.game, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const samples = a.seeds[0]?.samples ?? [];
    expect(samples.length).toBeGreaterThan(20);
    expect(samples.every((s) => s.tick % 60 === 0)).toBe(true);
    const first = samples.find((s) => s.tick === 0);
    expect(JSON.stringify(first?.state)).toBe(
      JSON.stringify(spec.game.init(6000, { maxTicks: 3600, params: {} })),
    );
    // 同一個 tick 有好幾個 run 的 state（這就是「同 tick 的捐贈者」的來源）。
    const atTick = samples.filter((s) => s.tick === 300);
    expect(new Set(atTick.map((s) => s.run)).size).toBeGreaterThanOrEqual(2);
  });
});

describe('合法性檢查有牙齒（C-A，蛇）', { timeout: 60_000 }, () => {
  const { corpus, spec } = smallCorpus('C-A');
  const real = corpus.seeds.flatMap((s) => s.samples).filter((s) => !spec.game.isOver(s.state));

  it('所有真實取樣的 state 都通過', () => {
    expect(real.length).toBeGreaterThan(40);
    for (const s of real) {
      expect(spec.legal(s.state, 1)).toBeNull();
    }
  });

  it('被破壞的 state 會被擋：蛇身重疊、出界、不連續、食物壓在蛇身上', () => {
    const base = real.find((s) => s.tick >= 300)?.state as unknown as {
      snakes: { body: number[] }[];
      foods: number[];
    };
    expect(base).toBeDefined();
    const mine = base.snakes[1]?.body ?? [];
    const theirs = base.snakes[0]?.body ?? [];
    const overlap = setAt(base, 'snakes.0.body.0', mine[1] as number);
    const outside = setAt(base, 'snakes.0.body.0', -1);
    const broken = setAt(base, 'snakes.0.body.1', ((theirs[0] as number) + 5) % 768);
    const foodOnBody = setAt(base, 'foods.0', theirs[0] as number);
    for (const bad of [overlap, outside, broken, foodOnBody]) {
      expect(spec.legal(bad as never, 1)).not.toBeNull();
    }
    expect(spec.legal(base as never, 1)).toBeNull();
  });
});

describe('擾動只動對手（C-A 與 D-A）', { timeout: 60_000 }, () => {
  for (const id of ['C-A', 'D-A']) {
    const { corpus, spec } = smallCorpus(id);
    const det = new Det(7, `perturb-${id}`);

    it(`${id}：每個擾動只改了對手的元件，自己與共用環境逐位元不變，且通過合法性檢查`, () => {
      let total = 0;
      for (const seedCorpus of corpus.seeds) {
        const queries = pickQueries(spec.game, seedCorpus, 12, det);
        expect(queries.length).toBeGreaterThan(3);
        for (const q of queries) {
          deepFreeze(q.state);
          const donors = donorsFor(seedCorpus, q);
          const before = JSON.stringify(q.state);
          const out = perturbOpponent(spec, q, donors, det, 6);
          expect(JSON.stringify(q.state)).toBe(before); // 輸入沒被改
          const oppPaths = [...spec.comp(q.ai === 0 ? 1 : 0, q.state), ...(spec.mixed ?? [])];
          const ownPaths = spec.comp(q.ai, q.state);
          for (const p of out.list) {
            total += 1;
            expect(sameOutside(p.state, q.state, oppPaths)).toBe(true);
            expect(spec.mixedOk?.(q.state, p.state, q.ai) ?? true).toBe(true);
            for (const path of ownPaths) {
              expect(JSON.stringify(getAt(p.state, path))).toBe(
                JSON.stringify(getAt(q.state, path)),
              );
            }
            expect(JSON.stringify(p.state)).not.toBe(before); // 真的不同
            expect(spec.legal(p.state as never, q.ai)).toBeNull();
          }
          expect(out.stats.accepted).toBe(
            out.list.filter((p) => !p.kind.startsWith('special')).length,
          );
        }
      }
      expect(total).toBeGreaterThan(10);
    });

    it(`${id}：換掉「自己」的元件則動到的是自己的路徑，對手的元件不變（perturbSelf 的對偶）`, () => {
      const seedCorpus = corpus.seeds[0] as (typeof corpus.seeds)[number];
      const queries = pickQueries(spec.game, seedCorpus, 10, det);
      let total = 0;
      for (const q of queries) {
        const out = perturbSelf(spec, q, donorsFor(seedCorpus, q), det, 4);
        for (const p of out.list) {
          total += 1;
          expect(
            sameOutside(p.state, q.state, [...spec.comp(q.ai, q.state), ...(spec.mixed ?? [])]),
          ).toBe(true);
        }
      }
      expect(total).toBeGreaterThan(3);
    });
  }

  it('leadFlip 標籤與 game.score 的領先符號變化一致', () => {
    const { corpus, spec } = smallCorpus('C-A');
    const det = new Det(9, 'flip');
    let flips = 0;
    for (const seedCorpus of corpus.seeds) {
      for (const q of pickQueries(spec.game, seedCorpus, 20, det)) {
        const o = q.ai === 0 ? 1 : 0;
        const margin = (s: unknown): number => {
          const sc = spec.game.score(s as never);
          return (sc[o] as number) - (sc[q.ai] as number);
        };
        for (const p of perturbOpponent(spec, q, donorsFor(seedCorpus, q), det, 8).list) {
          const m0 = margin(q.state);
          const m1 = margin(p.state);
          const flipped = (m0 < 0 && m1 > 0) || (m0 > 0 && m1 < 0);
          expect(p.leadFlip).toBe(flipped);
          if (flipped) flips += 1;
        }
      }
    }
    expect(flips).toBeGreaterThanOrEqual(0);
  });
});

describe('放寬模式（D-6：對手的歷史與現金和共用價格偏移糾纏）', { timeout: 60_000 }, () => {
  const { corpus, spec } = smallCorpus('D-6');
  const det = new Det(31, 'relaxed');

  it('乾淨模式只動 pending；放寬模式另外動糾纏欄位，其餘逐位元不變，且標成 relaxed', () => {
    let relaxedTotal = 0;
    for (const seedCorpus of corpus.seeds) {
      for (const q of pickQueries(spec.game, seedCorpus, 20, det)) {
        const o = q.ai === 0 ? 1 : 0;
        const donors = donorsFor(seedCorpus, q);
        const clean = perturbOpponent(spec, q, donors, det, 4);
        for (const p of clean.list) {
          expect(sameOutside(p.state, q.state, spec.comp(o, q.state))).toBe(true);
        }
        const relaxed = perturbRelaxed(spec, q, donors, det, 4);
        const allowed = [...spec.comp(o, q.state), ...(spec.entangled?.(o, q.state) ?? [])];
        for (const p of relaxed.list) {
          relaxedTotal += 1;
          expect(p.kind.startsWith('relaxed')).toBe(true);
          expect(sameOutside(p.state, q.state, allowed)).toBe(true);
          // 自己的現金、存貨、歷史裡自己的那一格都不動。
          for (const path of [`cash.${q.ai}`, `inv.${q.ai}`]) {
            expect(JSON.stringify(getAt(p.state, path))).toBe(JSON.stringify(getAt(q.state, path)));
          }
        }
      }
    }
    expect(relaxedTotal).toBeGreaterThan(0);
  });

  it('沒有宣告 entangled 的牌，放寬模式不產生任何擾動', () => {
    const c = smallCorpus('C-A');
    const q = pickQueries(
      c.spec.game,
      c.corpus.seeds[0] as (typeof c.corpus.seeds)[number],
      3,
      det,
    )[0];
    expect(q).toBeDefined();
    const out = perturbRelaxed(c.spec, q as Query<never>, { sameTick: [], otherTick: [] }, det, 4);
    expect(out.list.length).toBe(0);
  });
});

describe('AI 決策與正負對照', { timeout: 60_000 }, () => {
  const { corpus, spec } = smallCorpus('C-A');
  const det = new Det(11, 'decide');
  const seedCorpus = corpus.seeds[0] as (typeof corpus.seeds)[number];
  const queries: Query<never>[] = pickQueries(spec.game, seedCorpus, 30, det) as Query<never>[];

  it('decideAs 是決定性的：同一個 state、同一個種子，兩次動作相同', () => {
    for (const q of queries) {
      const a = decideAs(spec.game, 'pathfinder', 10, 5, q.state, q.ai);
      const b = decideAs(spec.game, 'pathfinder', 10, 5, q.state, q.ai);
      expect(a).toEqual(b);
    }
  });

  it('負對照：把對手的元件換成「自己現在的值」（等於沒換），動作改變率恰好是 0', () => {
    for (const q of queries) {
      const o = q.ai === 0 ? 1 : 0;
      let same = q.state;
      for (const path of spec.comp(o)) {
        same = setAt(same, path, getAt(q.state, path));
      }
      expect(decideAs(spec.game, 'precise', 10, 3, same, q.ai)).toEqual(
        decideAs(spec.game, 'precise', 10, 3, q.state, q.ai),
      );
    }
  });

  it('正對照：把「自己」的元件換成別人的，AI 的動作會變（方法看得見東西，蛇的自我改變率 > 20%）', () => {
    const m = measureCard(spec, corpus, {
      policies: ['precise'],
      levels: [10],
      queries: 60,
      maxPerts: 4,
      maxSelf: 3,
      seed: 21,
    });
    const cell = m.cells.find((c) => c.policy === 'precise' && c.level === 10);
    expect(cell).toBeDefined();
    expect((cell?.self.changed ?? 0) / Math.max(1, cell?.self.queries ?? 1)).toBeGreaterThan(0.2);
  });
});

describe('measureCard 的帳', { timeout: 60_000 }, () => {
  it('每個 (性格, 等級) 一格；分母 = 查詢數；改變數 ≤ 分母；null 對照全是 0', () => {
    const { corpus, spec } = smallCorpus('D-A');
    const m = measureCard(spec, corpus, {
      policies: ['precise', 'greedy'],
      levels: [10, 5],
      queries: 30,
      maxPerts: 3,
      maxSelf: 2,
      seed: 3,
    });
    expect(m.cells.length).toBe(4);
    expect(m.states).toBeGreaterThan(5);
    for (const c of m.cells) {
      expect(c.queries).toBe(m.perturbations);
      expect(c.changed).toBeLessThanOrEqual(c.queries);
      expect(c.flip.queries + c.noflip.queries).toBe(c.queries);
      expect(c.statesAny).toBeLessThanOrEqual(m.states);
      expect(c.nullChanged).toBe(0);
    }
  });
});

describe('Wilson 區間與分類門檻（量之前固定，10.54）', () => {
  it('wilson 區間包住觀察值、0 與 n 的邊界合理', () => {
    const [lo, hi] = wilson(10, 100);
    expect(lo).toBeLessThan(0.1);
    expect(hi).toBeGreaterThan(0.1);
    expect(wilson(0, 100)[0]).toBe(0);
    expect(wilson(0, 100)[1]).toBeGreaterThan(0);
    expect(wilson(100, 100)[1]).toBe(1);
  });

  it('門檻常數就是任務書寫下的：≤1% 結構零、≥5% 值得排、自我正對照 ≥5%', () => {
    expect(CLASSIFY.zeroMax).toBe(0.01);
    expect(CLASSIFY.worthMin).toBe(0.05);
    expect(CLASSIFY.selfMin).toBe(0.05);
  });

  function fake(
    rates: Record<string, number>,
    selfRate: number,
    defaultPolicy = 'precise',
  ): CardMeasure {
    const cells = Object.entries(rates).map(([key, rate]) => {
      const [policy, level] = key.split('@');
      return {
        policy: policy as 'precise',
        level: Number(level),
        queries: 1000,
        changed: Math.round(rate * 1000),
        statesAny: 0,
        flip: { queries: 0, changed: 0 },
        noflip: { queries: 1000, changed: Math.round(rate * 1000) },
        byKind: {},
        byPath: {},
        relaxed: { queries: 0, changed: 0 },
        world: { queries: 0, changed: 0 },
        self: { queries: 1000, changed: Math.round(selfRate * 1000) },
        nullChanged: 0,
      };
    });
    return {
      id: 'X',
      defaultPolicy,
      states: 100,
      perturbations: 1000,
      attempted: 1200,
      illegal: {},
      identical: 0,
      cells,
    };
  }

  it('分類：零 / 值得排 / 灰色 / 常數策略', () => {
    const zero = classify(fake({ 'precise@10': 0, 'precise@5': 0, 'pathfinder@10': 0.004 }, 0.5));
    expect(zero.verdict).toBe('structural-zero');
    expect(zero.rDefault).toBe(0);
    const worth = classify(fake({ 'precise@10': 0.2, 'pathfinder@10': 0.01 }, 0.5));
    expect(worth.verdict).toBe('worth-probe-a');
    expect(worth.rDefault).toBeCloseTo(0.2); // 預設性格是 precise
    const offDefault = classify(fake({ 'precise@10': 0.001, 'pathfinder@10': 0.3 }, 0.5));
    expect(offDefault.verdict).toBe('worth-probe-a'); // 判定類別照原規則（三個性格取最大）
    expect(offDefault.rDefault).toBeCloseTo(0.001); // 但預設性格的改變率另外報
    const grey = classify(fake({ 'precise@10': 0.03, 'pathfinder@10': 0.02 }, 0.5));
    expect(grey.verdict).toBe('grey');
    const constant = classify(fake({ 'precise@10': 0, 'pathfinder@10': 0 }, 0));
    expect(constant.verdict).toBe('constant-policy');
    // 自我為 0 但整個世界一換決策就變：AI 只讀共用環境，是結構零，不是常數策略。
    const readsWorld = fake({ 'precise@10': 0, 'pathfinder@10': 0 }, 0);
    const withWorld = {
      ...readsWorld,
      cells: readsWorld.cells.map((c) => ({ ...c, world: { queries: 100, changed: 60 } })),
    };
    expect(classify(withWorld).verdict).toBe('structural-zero');
    expect(classify(withWorld).wMax).toBeCloseTo(0.6);
  });

  it('分類：乾淨為零但放寬很高 → 無法乾淨篩檢（AI 讀的是糾纏欄位）；放寬也低 → 結構零', () => {
    const base = fake({ 'precise@10': 0, 'pathfinder@10': 0 }, 0.5);
    const withRelaxed = (rate: number): CardMeasure => ({
      ...base,
      cells: base.cells.map((c) => ({
        ...c,
        relaxed: { queries: 1000, changed: Math.round(rate * 1000) },
      })),
    });
    const entangled = classify(withRelaxed(0.2));
    expect(entangled.verdict).toBe('not-screenable');
    expect(entangled.rRelaxed).toBeCloseTo(0.2);
    expect(classify(withRelaxed(0.003)).verdict).toBe('structural-zero');
  });

  it('分類：規格宣告 notScreenable 就是無法乾淨篩檢，附理由', () => {
    const m = { ...fake({ 'precise@10': 0.3 }, 0.5), notScreenable: '沒有對手概念' };
    const c = classify(m);
    expect(c.verdict).toBe('not-screenable');
    expect(c.reason).toContain('沒有對手概念');
  });
});
