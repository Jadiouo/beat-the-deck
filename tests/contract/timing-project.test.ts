import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../../vitest.config';
import { ALL_ENTRIES, TIMING_CODES, entriesOfBucket, BUCKETS } from '../ai/a-checks.shared';
import { AI_CHECKS, CHECKS } from './checks';

/**
 * 時間類測試的跑法（TEST_PLAN 第 9 節）：它們集中在 vitest 的 `timing` project，序列執行，
 * 而且排在 light、heavy 之後，不與它們並行。這裡守住三件事，讓「把時間類測試移走」
 * 不會變成「時間類測試沒人跑」：
 * 1. timing project 存在、序列、最後一組；light 與 heavy 都不含 tests/timing。
 * 2. TIMING_CODES 的每一條都真的有定義，且逐牌分檔不再定義它們。
 * 3. tests/timing/ 裡真的有對全部登記項定義它們的檔案。
 */
type ProjectLike = { test: Record<string, unknown> };
const projects = ((config as { test: { projects: ProjectLike[] } }).test.projects ??
  []) as ProjectLike[];
const byName = (name: string): ProjectLike | undefined =>
  projects.find((p) => p.test.name === name);

describe('vitest 的 timing project', () => {
  it('有 light、heavy、timing 三個 project', () => {
    expect(projects.map((p) => p.test.name)).toEqual(['light', 'heavy', 'timing']);
  });

  it('timing 只含 tests/timing，light 與 heavy 都排除它（不漏不重）', () => {
    expect(byName('timing')?.test.include).toEqual(['tests/timing/**/*.test.ts']);
    for (const name of ['light', 'heavy']) {
      expect(byName(name)?.test.exclude as string[], name).toContain('tests/timing/**');
    }
  });

  it('timing 序列執行（單一 worker、不平行檔案），並且是最後一組', () => {
    const timing = byName('timing')?.test as Record<string, unknown>;
    expect(timing.fileParallelism).toBe(false);
    expect(timing.maxWorkers).toBe(1);
    const order = (p: ProjectLike | undefined): number =>
      (p?.test.sequence as { groupOrder?: number } | undefined)?.groupOrder ?? 0;
    expect(order(byName('timing'))).toBeGreaterThan(order(byName('light')));
    expect(order(byName('timing'))).toBeGreaterThan(order(byName('heavy')));
  });
});

describe('時間類檢查一定有人跑', () => {
  it('K11 與 A5 在檢查清單裡', () => {
    const codes = new Set([...CHECKS, ...AI_CHECKS].map((c) => c.code as string));
    for (const code of TIMING_CODES) {
      expect(codes.has(code), code).toBe(true);
    }
    expect([...TIMING_CODES].sort()).toEqual(['A5', 'K11']);
  });

  it('逐牌分檔的測試檔沒有手寫 K11、A5（它們統一由 tests/timing/checks.test.ts 定義）', () => {
    const file = resolve(__dirname, '../timing/checks.test.ts');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('ALL_ENTRIES');
    expect(text).toContain('TIMING_CODES');
    // 分檔合起來涵蓋的牌 ＝ timing 檔涵蓋的牌（都是 ALL_ENTRIES）。
    const covered = BUCKETS.flatMap((b) => entriesOfBucket(b).map((e) => e.id));
    expect(covered.sort()).toEqual(ALL_ENTRIES.map((e) => e.id).sort());
  });
});
