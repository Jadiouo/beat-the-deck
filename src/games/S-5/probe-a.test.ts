import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { playMatch } from '../../core/match';
import type { Side } from '../../core/types';
import { compareBC, outcomeOf } from '../../../tests/ai/probe-a.shared';
import { deepFreeze } from '../../../tests/contract/freeze';
import { levelController } from '../../ai/level';
import { precise } from '../../ai/policies/precise';
import { s5Game } from './logic';
import type { S5State } from './logic';
import {
  B_FAMILY,
  CELLS,
  CONFIG,
  C_FAMILY,
  MEASURE_FROM,
  TRAIN_FROM,
  chooseLanding,
  isPoint,
  makePlayer,
  playCell,
  s5Spec,
} from './probe-a.test-helpers';

/**
 * S-5 探針 A（`docs/cards/S-5.md`「完整探針 A」）的工具測試。
 * 只測量測工具本身：族的定義、(b) 不讀對手、(c) 真的讀了對手、核心夠強、純度與來源掃描、種子不重疊。
 * 大場次的量測在 `measure.test.ts`（預設場數很小，用環境變數開大）。
 */

const firstCell = (): (typeof CELLS)[number] => {
  const cell = CELLS[0];
  if (cell === undefined) {
    throw new Error('CELLS 是空的');
  }
  return cell;
};

/** 用 (b) 的直打成員打幾場真的對局，每 `every` 個 tick 取一個局面（兩邊都取，飛行中的居多）。 */
function sampleStates(every = 11): { state: S5State; side: Side; tick: number }[] {
  const out: { state: S5State; side: Side; tick: number }[] = [];
  for (const seed of [1, 2, 3, 4]) {
    const me = makePlayer('b-straight', 'T0', seed);
    const ai = levelController(s5Game, precise, 5, seed + 1_000_003);
    // 包一層記錄局面的控制器：只記，不改回答。
    const recordedMe = {
      decide(state: S5State, side: Side, tick: number) {
        if (tick % every === 0) {
          out.push({ state, side, tick });
        }
        return me.decide(state, side, tick);
      },
    };
    if (seed % 2 === 0) {
      playMatch(s5Game, seed, CONFIG, recordedMe, ai);
    } else {
      playMatch(s5Game, seed, CONFIG, ai, recordedMe);
    }
  }
  return out;
}

/** 把「對手」那一邊的公開狀態整個換掉。 */
function perturbOpponent(s: S5State, side: Side, variant: number): S5State {
  const opp: Side = side === 0 ? 1 : 0;
  const paddles = [s.paddles[0], s.paddles[1]] as [S5State['paddles'][0], S5State['paddles'][1]];
  const habit = [s.habit[0], s.habit[1]] as [readonly number[], readonly number[]];
  const points = [s.points[0], s.points[1]] as [number, number];
  switch (variant) {
    case 0:
      paddles[opp] = { x: 20, vx: -2.4, target: -2.4 };
      break;
    case 1:
      paddles[opp] = { x: 130, vx: 2.4, target: 2.4 };
      break;
    case 2:
      paddles[opp] = { x: 75, vx: 0, target: 0 };
      habit[opp] = [20, 22, 25, 21, 24];
      break;
    case 3:
      habit[opp] = [130, 128, 126, 131, 129];
      points[opp] = Math.min(5, points[opp] + 3);
      break;
    default:
      paddles[opp] = { x: 45, vx: 1.2, target: 1.0 };
      habit[opp] = [75, 75, 75];
      points[opp] = 0;
  }
  return { ...s, paddles, habit, points };
}

describe('族的定義', () => {
  it('(b) 族至少 5 個、(c) 族至少 4 個，名字不重複', () => {
    expect(B_FAMILY.length).toBeGreaterThanOrEqual(5);
    expect(C_FAMILY.length).toBeGreaterThanOrEqual(4);
    expect(new Set([...B_FAMILY, ...C_FAMILY]).size).toBe(B_FAMILY.length + C_FAMILY.length);
    for (const n of B_FAMILY) expect(n.startsWith('b-')).toBe(true);
    for (const n of C_FAMILY) expect(n.startsWith('c-')).toBe(true);
  });

  it('格子的 id 不重複，等級在 1 到 10，每格都有名字', () => {
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

describe('(b) 不讀對手的任何狀態（板子位置、速度、按鍵、回球習慣、分數）', () => {
  const states = sampleStates();
  it('取樣到足夠多的飛向我的局面', () => {
    const toward = states.filter(
      ({ state, side }) => state.phase === 'play' && (side === 0 ? state.ball.vy > 0 : state.ball.vy < 0),
    );
    expect(toward.length).toBeGreaterThan(20);
  });

  it.each(B_FAMILY.map((name) => [name]))('%s：換掉對手的整個公開狀態，想落的位置不變', (name) => {
    for (const { state, side } of states) {
      const plain = chooseLanding(name, state, side, 7);
      for (let variant = 0; variant < 5; variant += 1) {
        expect(chooseLanding(name, perturbOpponent(state, side, variant), side, 7)).toBe(plain);
      }
    }
  });
});

describe('(c) 真的讀了對手（換掉它讀的東西，想落的位置會變）', () => {
  const states = sampleStates().filter(
    ({ state, side }) => state.phase === 'play' && (side === 0 ? state.ball.vy > 0 : state.ball.vy < 0),
  );
  it.each(C_FAMILY.map((name) => [name]))('%s：至少有一個局面、一種擾動會改變想落的位置', (name) => {
    let changed = 0;
    for (const { state, side } of states) {
      const plain = chooseLanding(name, state, side, 7);
      for (let variant = 0; variant < 5; variant += 1) {
        if (chooseLanding(name, perturbOpponent(state, side, variant), side, 7) !== plain) {
          changed += 1;
        }
      }
    }
    expect(changed).toBeGreaterThan(0);
  });
});

describe('成員是決定性的、不改動傳進來的 state、按鍵合法', () => {
  it.each([...B_FAMILY, ...C_FAMILY].map((name) => [name]))(
    '%s：同一個種子跑兩次結果相同；深度凍結的 state 不丟錯',
    (name) => {
      const run = (): ReturnType<typeof playCell> => {
        const base = makePlayer(name, 'T12', 5);
        const frozenMe = { decide: (s: S5State, side: Side, tick: number) => base.decide(deepFreeze(s), side, tick) };
        return playCell(5, frozenMe, firstCell());
      };
      const a = run();
      const b = run();
      expect(a).toEqual(b);
    },
  );
});

describe('核心夠強（(b) 的直打成員在零延遲下贏得了低等級 AI）', () => {
  it('b-straight（T0）對等級 1 精準型 12 場至少贏 11 場', () => {
    let wins = 0;
    for (let seed = 0; seed < 12; seed += 1) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const me = makePlayer('b-straight', 'T0', seed);
      const ai = levelController(s5Game, precise, 1, seed + 1_000_003);
      const r =
        side === 0
          ? playMatch(s5Game, seed, CONFIG, me, ai)
          : playMatch(s5Game, seed, CONFIG, ai, me);
      wins += outcomeOf(r, side).win;
    }
    expect(wins).toBeGreaterThanOrEqual(11);
  });
});

describe('決策點與探針串接', () => {
  it('isPoint 在每一次「球飛向我、還有 14 個 tick 到線」只算一次', () => {
    const states = sampleStates(1).filter(({ side }) => side === 0);
    const hits = states.filter(({ state, side, tick }) => isPoint(state, side, tick));
    expect(hits.length).toBeGreaterThan(0);
    // 每一球最多一個 tick 剛好 14：連續兩個點之間至少隔 14 個 tick。
    for (let i = 1; i < hits.length; i += 1) {
      expect((hits[i]?.tick ?? 0) - (hits[i - 1]?.tick ?? 0)).toBeGreaterThanOrEqual(14);
    }
  });

  it('compareBC 串得起來：勝率差不超過場級分歧率、沒有一致性違規', () => {
    const spec = s5Spec('b-straight', 'c-away', firstCell(), [0, 1, 2, 3]);
    const r = compareBC(spec);
    expect(r.n).toBe(4);
    expect(r.winBoundHolds).toBe(true);
    expect(r.inconsistentSeeds).toEqual([]);
  });
});

describe('來源掃描：(c) 不借用 AI 的評估或對手預測，也不拿 AI 控制器當成員', () => {
  const source = readFileSync(new URL('./probe-a.test-helpers.ts', import.meta.url), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
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
