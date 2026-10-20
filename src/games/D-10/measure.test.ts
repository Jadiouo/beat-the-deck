import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { greedy } from '../../ai/policies/greedy';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { Side } from '../../core/types';
import { compareBC, formatProbeA, outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { ProbeSpec } from '../../../tests/ai/probe-a.shared';
import { d10Game } from './logic';
import type { D10State } from './logic';
import { probe } from './players.test-helpers';

/**
 * D-10 的量測型測試：探針 A 的決策分歧率與 (c)−(b)（DESIGN-AI-FUN 10.35、10.59；`docs/cards/D-10.md`「探針 A」）。
 * 腳本是目前取回的版本，不保證是最早的那一份。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   D10_PROBE_N（場數，預設 4）、D10_PROBE_FROM（起始種子，預設 0）、D10_PROBE_VERBOSE（印出一行報告）。
 * (b) ＝ `probe('aware')`（知道有人會搶、不看它）、(c) ＝ `probe('reads')`（讀它最想攔的那一件）。
 * 對等級 10 的精準型與貪心型，AI 種子 ＝ 玩家種子 ＋ 1,000,003，玩家邊由種子奇偶輪流。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const N = Math.max(1, Number(process.env['D10_PROBE_N'] ?? '4'));
const FROM = Number(process.env['D10_PROBE_FROM'] ?? '0');
const seeds = Array.from({ length: N }, (_v, i) => FROM + i);

const specAgainst = (policy: Policy): ProbeSpec<D10State> => ({
  makeB: () => probe('aware'),
  makeC: () => probe('reads'),
  seeds,
  play: (seed, ctl) => {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const ai = levelController(d10Game, policy, 10, seed + 1_000_003);
    const result =
      side === 0
        ? playMatch(d10Game, seed, CONFIG, ctl, ai)
        : playMatch(d10Game, seed, CONFIG, ai, ctl);
    return outcomeOf(result, side);
  },
});

describe('D-10 探針 A：(b) aware 對 (c) reads 的分歧率與勝率差（共用 tests/ai/probe-a.shared.ts）', () => {
  it.each([
    ['precise', precise],
    ['greedy', greedy],
  ] as const)(
    '對 %s 等級 10：勝率差不超過場級分歧率；影子不影響對局（驅動者單獨跑的結果相同）',
    (name, policy) => {
      const spec = specAgainst(policy);
      const r = compareBC(spec);
      if (process.env['D10_PROBE_VERBOSE'] !== undefined) {
        console.log(
          formatProbeA(`D-10 ${name} L10 seeds ${String(FROM)}..${String(FROM + N - 1)}`, r),
        );
      }
      expect(r.n).toBe(N);
      expect(r.winBoundHolds).toBe(true);
      expect(r.inconsistentSeeds).toEqual([]);
      const alone = seeds.map((seed) => spec.play(seed, spec.makeB(seed)));
      expect(r.win.b).toBe(alone.reduce((a, o) => a + o.win, 0) / N);
      expect(r.margin.b.mean).toBe(alone.reduce((a, o) => a + o.margin, 0) / N);
    },
    3_600_000,
  );
});
