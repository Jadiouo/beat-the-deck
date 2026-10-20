import { describe, expect, it } from 'vitest';

import { MATCHUPS, collectCorpus, getAt } from './engine';
import type { CardSpec, Corpus } from './engine';
import { ALL_SPECS } from './specs';

/**
 * 每張牌的篩檢規格自己的測試（任務書：「擾動後的狀態通過該牌的合法性檢查」）：
 * 1. 所有真實取樣的 state（沒結束的）都通過 `legal`，不會誤殺；
 * 2. `comp` 列出的路徑在真實 state 裡都存在（路徑寫錯就不會偷偷變成空擾動）；
 * 3. 刻意破壞的 state（`teeth`）全部被 `legal` 擋下 —— 合法性檢查有牙齒；
 * 4. 沒有宣告 `notScreenable` 的牌，兩邊的元件至少有一條路徑。
 * 取樣很小（1 個種子、3 組對局、局長 1200 tick），只為了蓋到真實局面，不是量測。
 */

const corpora = new Map<string, Corpus<never>>();
function corpusOf(spec: CardSpec): Corpus<never> {
  let corpus = corpora.get(spec.id);
  if (corpus === undefined) {
    corpus = collectCorpus(spec.game, {
      seeds: [6100],
      matchups: MATCHUPS.slice(0, 3),
      every: 100,
      config: { maxTicks: Math.max(1200, spec.minTicks ?? 0), params: {} },
    }) as unknown as Corpus<never>;
    corpora.set(spec.id, corpus);
  }
  return corpus;
}

describe.each(ALL_SPECS.map((s) => [s.id, s] as const))(
  '規格 %s',
  { timeout: 120_000 },
  (_id, spec) => {
    const samples = (): { tick: number; state: never }[] =>
      corpusOf(spec)
        .seeds.flatMap((s) => s.samples)
        .filter((s) => !spec.game.isOver(s.state));

    it('真實取樣的 state 全部通過 legal', () => {
      const all = samples();
      expect(all.length).toBeGreaterThan(5);
      for (const s of all) {
        for (const ai of [0, 1] as const) {
          expect(spec.legal(s.state, ai), `tick ${s.tick} ai ${ai}`).toBeNull();
        }
      }
    });

    it('comp 的路徑在真實 state 裡都存在，而且每邊至少有一條（除非宣告 notScreenable）', () => {
      let nonEmpty = 0;
      for (const s of samples()) {
        for (const side of [0, 1] as const) {
          const paths = spec.comp(side, s.state);
          if (paths.length > 0) {
            nonEmpty += 1;
          }
          for (const path of paths) {
            expect(getAt(s.state, path), `路徑 ${path} @ tick ${s.tick}`).not.toBeUndefined();
          }
        }
      }
      if (spec.notScreenable === undefined) {
        expect(nonEmpty).toBeGreaterThan(0);
      }
    });

    it('teeth：刻意破壞的 state 全部被擋，而且至少有一種被實際測到', () => {
      expect(spec.teeth, '每份規格都要有 teeth').toBeDefined();
      let tested = 0;
      const picks = samples().filter((s) => s.tick >= 300);
      for (const s of picks.slice(0, 6)) {
        for (const ai of [0, 1] as const) {
          for (const tooth of spec.teeth?.(s.state, ai) ?? []) {
            if (JSON.stringify(tooth.state) === JSON.stringify(s.state)) {
              continue;
            }
            tested += 1;
            expect(
              spec.legal(tooth.state, ai),
              `${tooth.name} @ tick ${s.tick} ai ${ai}`,
            ).not.toBeNull();
          }
        }
      }
      expect(tested).toBeGreaterThan(0);
    });
  },
);
