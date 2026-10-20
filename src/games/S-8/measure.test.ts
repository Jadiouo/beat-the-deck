import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { precise } from '../../ai/policies/precise';
import { playMatch } from '../../core/match';
import type { Side } from '../../core/types';
import { compareBC, formatProbeA, outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { ProbeSpec } from '../../../tests/ai/probe-a.shared';
import { s8Game } from './logic';
import type { S8State } from './logic';
import { scripted } from './players.test-helpers';

/**
 * S-8 的量測型測試：探針 A 的決策分歧率與 (c)−(b)（DESIGN-AI-FUN 10.35、10.59；`docs/cards/S-8.md`「探針 A」）。
 * 腳本是目前取回的版本，不保證是最早的那一份。
 * 預設場數很小（只驗工具串得起來）；正式量測用環境變數開大：
 *   S8_PROBE_N（場數，預設 4）、S8_PROBE_FROM（起始種子，預設 0）、S8_PROBE_VERBOSE（印出一行報告）。
 * (b) ＝ `scripted('b')`（被撞過就退內側 20 像素 60 tick，不讀對手）、(c) ＝ `scripted('c')`（讀 lane／hold），
 * 零延遲，對精準型等級 10，AI 種子 ＝ 玩家種子 ＋ 1,000,003，玩家邊由種子奇偶輪流。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const N = Math.max(1, Number(process.env['S8_PROBE_N'] ?? '4'));
const FROM = Number(process.env['S8_PROBE_FROM'] ?? '0');
const seeds = Array.from({ length: N }, (_v, i) => FROM + i);

const spec: ProbeSpec<S8State> = {
  makeB: () => scripted('b'),
  makeC: () => scripted('c'),
  seeds,
  play: (seed, ctl) => {
    const side: Side = seed % 2 === 0 ? 0 : 1;
    const ai = levelController(s8Game, precise, 10, seed + 1_000_003);
    const result =
      side === 0
        ? playMatch(s8Game, seed, CONFIG, ctl, ai)
        : playMatch(s8Game, seed, CONFIG, ai, ctl);
    return outcomeOf(result, side);
  },
};

describe('S-8 探針 A：(b) 對 (c) 的分歧率與勝率差（共用 tests/ai/probe-a.shared.ts）', () => {
  it('(b)(c) 各驅動一遍；勝率差不超過場級分歧率；影子不影響對局（驅動者單獨跑的結果相同）', () => {
    const r = compareBC(spec);
    if (process.env['S8_PROBE_VERBOSE'] !== undefined) {
      console.log(
        formatProbeA(`S-8 precise L10 seeds ${String(FROM)}..${String(FROM + N - 1)}`, r),
      );
    }
    expect(r.n).toBe(N);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
    const alone = seeds.map((seed) => spec.play(seed, spec.makeB(seed)));
    expect(r.win.b).toBe(alone.reduce((a, o) => a + o.win, 0) / N);
    expect(r.margin.b.mean).toBe(alone.reduce((a, o) => a + o.margin, 0) / N);
  }, 3_600_000);
});
