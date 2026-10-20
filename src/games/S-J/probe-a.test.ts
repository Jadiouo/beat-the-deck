import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { precise } from '../../ai/policies/precise';
import { playMatch } from '../../core/match';
import type { Side } from '../../core/types';
import { compareBC, outcomeOf } from '../../../tests/ai/probe-a.shared';
import { deepFreeze } from '../../../tests/contract/freeze';
import { sJGame } from './logic';
import type { SJState } from './logic';
import {
  B_FAMILY,
  CELLS,
  CONFIG,
  C_FAMILY,
  MEASURE_FROM,
  TRAIN_FROM,
  chooseGoal,
  isPoint,
  makePlayer,
  playCell,
  selectBest,
  sjSpec,
  trainTable,
} from './probe-a.test-helpers';

/**
 * S-J 探針 A（`docs/cards/S-J.md`「完整探針 A」）的工具測試。
 * 只測量測工具本身：族的定義、(b) 不讀射手的狀態、(c) 真的讀了、核心夠強、純度與來源掃描、種子不重疊。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const firstCell = (): (typeof CELLS)[number] => {
  const cell = CELLS[0];
  if (cell === undefined) {
    throw new Error('CELLS 是空的');
  }
  return cell;
};

interface Sample {
  readonly state: SJState;
  readonly side: Side;
  readonly tick: number;
}

/** 躲的那個回合的局面：用 (b) 的 b-y62 打幾場真的對局，每 `every` 個 tick 取一個，只留玩家在躲的。 */
function dodgerSamples(every = 7): Sample[] {
  const out: Sample[] = [];
  for (const seed of [1, 2, 3, 4]) {
    const me = makePlayer('b-y62', 'T0', seed);
    const ai = levelController(sJGame, precise, 10, seed + 1_000_003);
    const recorded = {
      decide(state: SJState, side: Side, tick: number) {
        if (tick % every === 0 && state.shooter !== side) {
          out.push({ state, side, tick });
        }
        return me.decide(state, side, tick);
      },
    };
    if (seed % 2 === 0) {
      playMatch(sJGame, seed, CONFIG, recorded, ai);
    } else {
      playMatch(sJGame, seed, CONFIG, ai, recorded);
    }
  }
  return out;
}

/** 把「射手」（對手）公開的承諾與分數整個換掉。 */
function perturbShooter(s: SJState, side: Side, variant: number): SJState {
  const opp: Side = side === 0 ? 1 : 0;
  const hits = [s.hits[0], s.hits[1]] as [number, number];
  const zone = [s.zone[0], s.zone[1]] as [number, number];
  switch (variant) {
    case 0:
      return { ...s, cursor: s.px, ammo: 5, cooldown: 0 };
    case 1:
      return { ...s, cursor: 140, ammo: 0, regen: 10, cooldown: 0 };
    case 2:
      return { ...s, cursor: s.px + 6, ammo: 1, cooldown: 15, regen: 80 };
    case 3:
      hits[opp] = hits[opp] + 4;
      zone[opp] = zone[opp] + 300;
      return { ...s, hits, zone, cursor: 10, ammo: 3 };
    default:
      return { ...s, cursor: 75, ammo: 2, cooldown: 3, regen: 40 };
  }
}

describe('族的定義', () => {
  it('(b) 族至少 5 個、(c) 族至少 4 個，名字不重複', () => {
    expect(B_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(C_FAMILY.length).toBeGreaterThanOrEqual(4);
    expect(new Set([...B_FAMILY, ...C_FAMILY]).size).toBe(B_FAMILY.length + C_FAMILY.length);
    for (const n of B_FAMILY) expect(n.startsWith('b-')).toBe(true);
    for (const n of C_FAMILY) expect(n.startsWith('c-')).toBe(true);
  });

  it('格子的 id 不重複，等級在 1 到 10', () => {
    expect(new Set(CELLS.map((c) => c.id)).size).toBe(CELLS.length);
    for (const c of CELLS) {
      expect(c.level).toBeGreaterThanOrEqual(1);
      expect(c.level).toBeLessThanOrEqual(10);
    }
  });

  it('訓練種子與量測種子不重疊（各取 1000 場的範圍檢查）', () => {
    const train = new Set(Array.from({ length: 1000 }, (_v, i) => TRAIN_FROM + i));
    for (let i = 0; i < 1000; i += 1) {
      expect(train.has(MEASURE_FROM + i)).toBe(false);
    }
  });
});

describe('(b) 不讀射手的任何狀態（游標、彈藥、補充倒數、冷卻、命中與分數）', () => {
  const samples = dodgerSamples();
  it('取樣到足夠多的躲的局面', () => {
    expect(samples.length).toBeGreaterThan(100);
  });

  it.each(B_FAMILY.map((name) => [name]))('%s：換掉射手的公開狀態，想去的地方不變', (name) => {
    for (const { state, side, tick } of samples) {
      const plain = chooseGoal(name, state, side, tick);
      for (let variant = 0; variant < 5; variant += 1) {
        expect(chooseGoal(name, perturbShooter(state, side, variant), side, tick)).toEqual(plain);
      }
    }
  });
});

describe('(c) 真的讀了射手（換掉它讀的東西，想去的地方會變）', () => {
  const samples = dodgerSamples();
  it.each(C_FAMILY.map((name) => [name]))(
    '%s：至少有一個局面、一種擾動會改變想去的地方',
    (name) => {
      let changed = 0;
      for (const { state, side, tick } of samples) {
        const plain = chooseGoal(name, state, side, tick);
        for (let variant = 0; variant < 5; variant += 1) {
          const moved = chooseGoal(name, perturbShooter(state, side, variant), side, tick);
          if (JSON.stringify(moved) !== JSON.stringify(plain)) {
            changed += 1;
          }
        }
      }
      expect(changed).toBeGreaterThan(0);
    },
  );
});

describe('成員是決定性的、不改動傳進來的 state', () => {
  it.each([...B_FAMILY, ...C_FAMILY].map((name) => [name]))(
    '%s：同一個種子跑兩次結果相同；深度凍結的 state 不丟錯',
    (name) => {
      const run = (): ReturnType<typeof playCell> => {
        const base = makePlayer(name, 'T12', 5);
        const frozen = {
          decide: (s: SJState, side: Side, tick: number) => base.decide(deepFreeze(s), side, tick),
        };
        return playCell(5, frozen, firstCell());
      };
      expect(run()).toEqual(run());
    },
    120_000,
  );
});

describe('核心夠強（零延遲下 (b) 的 b-y62 贏得了低等級 AI）', () => {
  it('b-y62（T0）對等級 3 精準型 12 場至少贏 11 場', () => {
    let wins = 0;
    for (let seed = 0; seed < 12; seed += 1) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const me = makePlayer('b-y62', 'T0', seed);
      const ai = levelController(sJGame, precise, 3, seed + 1_000_003);
      const r =
        side === 0
          ? playMatch(sJGame, seed, CONFIG, me, ai)
          : playMatch(sJGame, seed, CONFIG, ai, me);
      wins += outcomeOf(r, side).win;
    }
    expect(wins).toBeGreaterThanOrEqual(11);
  }, 120_000);
});

describe('決策點與探針串接', () => {
  it('isPoint 只在玩家在躲、射手有彈藥且不在冷卻、而且游標離我 20 以內時成立', () => {
    const samples = dodgerSamples(1);
    const points = samples.filter(({ state, side, tick }) => isPoint(state, side, tick));
    expect(points.length).toBeGreaterThan(0);
    for (const { state } of points) {
      expect(state.ammo).toBeGreaterThan(0);
      expect(state.cooldown).toBe(0);
      expect(Math.abs(state.px - state.cursor)).toBeLessThanOrEqual(20);
    }
    // 射手的回合不算決策點。
    const asShooter = { ...firstSample(samples).state };
    expect(isPoint(asShooter, asShooter.shooter, 0)).toBe(false);
  });

  it('compareBC 串得起來：勝率差不超過場級分歧率、沒有一致性違規', () => {
    const spec = sjSpec('b-y62', 'c-offcol10', firstCell(), [0, 1, 2, 3]);
    const r = compareBC(spec);
    expect(r.n).toBe(4);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
  }, 120_000);
});

function firstSample(samples: readonly Sample[]): Sample {
  const s = samples[0];
  if (s === undefined) {
    throw new Error('沒有取到局面');
  }
  return s;
}

describe('來源掃描：(c) 不借用 AI 的評估或對手預測，也不拿 AI 控制器當成員', () => {
  const source = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
  const code = source
    .split('\n')
    .filter(
      (line) =>
        !line.trim().startsWith('//') &&
        !line.trim().startsWith('*') &&
        !line.trim().startsWith('/*'),
    )
    .join('\n');
  it.each([
    ['evaluate', /\bevaluate\b/],
    ['predictOpponent', /predictOpponent/],
    ['levelController', /levelController/],
    ['policyByName', /policyByName/],
    ['性格檔', /ai\/policies\//],
    ['Math.random', /Math\.random/],
    ['Date.now', /Date\.now/],
  ])('工具檔的程式（不含註解）沒有 %s', (_label, pattern) => {
    expect(pattern.test(code)).toBe(false);
  });
});

describe('選 (b*)、(c*)', () => {
  it('勝率高者；同勝率取分差高；再同取表序在前', () => {
    const row = (name: string, win: number, margin: number) => ({ name, win, margin });
    expect(selectBest([row('x', 50, 1), row('y', 60, -9)])).toBe('y');
    expect(selectBest([row('x', 50, 1), row('y', 50, 2)])).toBe('y');
    expect(selectBest([row('x', 50, 1), row('y', 50, 1)])).toBe('x');
  });

  it('trainTable：每個成員一列，勝率是 0 到 100 的百分點，只用給定的種子', () => {
    const cell = firstCell();
    const rows = trainTable(['b-y62', 'b-y74'], cell, [TRAIN_FROM, TRAIN_FROM + 1]);
    expect(rows.map((r) => r.name)).toEqual(['b-y62', 'b-y74']);
    for (const r of rows) {
      expect(r.win).toBeGreaterThanOrEqual(0);
      expect(r.win).toBeLessThanOrEqual(100);
      expect(Number.isFinite(r.margin)).toBe(true);
    }
  }, 120_000);
});
