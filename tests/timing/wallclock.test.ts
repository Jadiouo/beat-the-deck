import { describe, expect, it } from 'vitest';

import { evolutionReport as evolutionReportCA } from '../../src/ai/evolution';
import { policyByName } from '../../src/ai/level';
import { cAGame } from '../../src/games/C-A/logic';
import { cAMeta } from '../../src/games/C-A/meta';
import { counterEntry, counterMeta } from '../fixtures/counter-entry';
import { counterGame } from '../fixtures/counter-game';
import type { CounterState } from '../fixtures/counter-game';
import { defineEntry } from '../../src/games/types';
import type { RegistryEntry } from '../../src/games/types';
import { evolutionReport } from '../ai/harness';
import { AI_CHECKS, CHECKS, measureA5, runCheck } from '../contract/checks';
import { withLoadNote } from './load';

/**
 * 其餘用牆鐘做門檻的單元測試，原本散在 light project 裡，現在集中到 timing project（序列、不與其他 project 並行）。
 * 內容與門檻從原處原封不動搬過來（原處：src/ai/evolution.test.ts、tests/ai/harness.test.ts、
 * tests/ai/contract-ai.test.ts），沒有放寬，也沒有跳過。
 */

function greedyCounter(overrides: { symmetric?: boolean } = {}): RegistryEntry {
  return defineEntry<CounterState>({
    id: counterEntry.id,
    kind: 'fixture',
    game: counterGame,
    render: counterEntry.render as (ctx: CanvasRenderingContext2D, state: CounterState) => void,
    meta: { ...counterMeta, defaultPolicy: 'greedy', ...overrides },
  });
}

describe('進化畫面的數字夠快（TEST_PLAN 5.3 第二條）', () => {
  it('對 C-A 跑一次少於 1 秒', () => {
    const policy = policyByName(cAMeta.defaultPolicy ?? 'pathfinder');
    withLoadNote(() => {
      const started = performance.now();
      evolutionReportCA(cAGame, 4, 5, 0, policy);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  it('對 counter-game 跑一次要少於 1 秒', () => {
    withLoadNote(() => {
      const started = performance.now();
      evolutionReport(counterGame, 3, 4, 0);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1000);
    });
  });
});

describe('用臨時登記項（counter-game ＋ 預設性格 greedy）跑時間類的檢查', () => {
  it('A5 的數字：平均 < 1 毫秒、p99.9 < 8 毫秒，runCheck 的 A5 通過', () => {
    const entry = greedyCounter();
    withLoadNote(() => {
      const a5 = measureA5(entry);
      expect(a5.meanMs).toBeLessThan(1);
      expect(a5.p999Ms).toBeLessThan(8);
      const check = AI_CHECKS.find((c) => c.code === 'A5');
      expect(runCheck(check as NonNullable<typeof check>, entry)).toBe('pass');
    });
  });

  it('K11 在臨時登記項上照樣通過', () => {
    const entry = greedyCounter({ symmetric: true });
    const check = CHECKS.find((c) => c.code === 'K11');
    withLoadNote(() => {
      expect(runCheck(check as NonNullable<typeof check>, entry)).toBe('pass');
    });
  });
});
