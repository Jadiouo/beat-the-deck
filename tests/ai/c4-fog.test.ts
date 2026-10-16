import { describe, expect, it } from 'vitest';

import { MATCH_CONFIG } from '../../src/ai/evolution';
import { levelController } from '../../src/ai/level';
import { pathfinder } from '../../src/ai/policies/pathfinder';
import { c4Game, explorationTarget, makeState } from '../../src/games/C-4/logic';
import type { C4State } from '../../src/games/C-4/logic';
import { CELLS, cellX, cellY } from '../../src/games/_clubs/logic';
import { measureA4 } from '../contract/checks';
import { findEntry } from '../../src/games/registry';
import { blockSeeds } from '../../src/games/_clubs/ai-blocks.test-helpers';

/**
 * C-4 霧的探索（DESIGN-AI-FUN 10.38 第 7 節、docs/cards/C-4.md「探索的量測」）。
 *
 * 量到的問題（40 場「S4 腳本對 AI」與 40 場 AI 對打，修之前）：
 * - AI 沒有可追的食物時，**每一次走格有 92% 在轉向**（S4 腳本是 7%）：探索目標永遠是離蛇頭最近的「沒看過」的格子，
 *   那一格總是在視野邊緣、又偏一格，所以它走成階梯（右、下、右、下……），淨前進速度只有直走的一半。
 * - 結果是視野覆蓋率：tick 600 時 AI 只看過 44% 的地圖，S4 腳本是 77%；tick 1200 是 59% 對 93%。
 *
 * 這裡守的是行為（轉向率、覆蓋率）與結果（A4 的兩個沒用過的種子區塊）。S4 腳本的勝率門檻在 `clubs-s4.test.ts`
 * （C-4 延遲 0 ≤ 50%、延遲 12 ≤ 40%），修之前是 92.0／66.5。
 */

const ENTRY = findEntry('C-4');

describe('C-4 探索目標', () => {
  it('朝右走、前面有沒看過的格子：目標在蛇頭的同一列（直走，不是階梯）', () => {
    const state = makeState({
      snakes: [
        { body: [cellAt(8, 10), cellAt(7, 10), cellAt(6, 10)], dir: 1 },
        { body: [cellAt(26, 11), cellAt(27, 11), cellAt(28, 11)], dir: 3 },
      ],
    });
    const head = state.snakes[0].body[0] as number;
    const target = explorationTarget(state.memory[0].seen, head, 1, state.tick);
    expect(cellY(target), `目標 (${cellX(target)},${cellY(target)})`).toBe(cellY(head));
    expect(cellX(target)).toBeGreaterThan(cellX(head));
  });
});

function cellAt(x: number, y: number): number {
  return y * 32 + x;
}

interface Behaviour {
  /** 沒有記得的食物時，走格方向和上一格不同的比例。 */
  readonly blindTurnRate: number;
  /** tick 600 時兩邊記憶裡「看過」的格子比例的平均。 */
  readonly coverage600: number;
}

function behaviour(games: number): Behaviour {
  let blindMoves = 0;
  let blindTurns = 0;
  let covered = 0;
  let sides = 0;
  for (let seed = 0; seed < games; seed += 1) {
    const controllers = [
      levelController(c4Game, pathfinder, 10, seed + 1),
      levelController(c4Game, pathfinder, 10, seed + 1_000_003),
    ] as const;
    let state: C4State = c4Game.init(seed, MATCH_CONFIG);
    const lastDir = [-1, -1];
    while (!c4Game.isOver(state) && state.tick < 600) {
      const prev = state;
      state = c4Game.step(state, [
        controllers[0].decide(state, 0, state.tick),
        controllers[1].decide(state, 1, state.tick),
      ]);
      if (state.tick % 6 === 0) {
        for (const side of [0, 1] as const) {
          const dir = prev.snakes[side].dir;
          if (prev.memory[side].foods.length === 0) {
            blindMoves += 1;
            if (lastDir[side] !== -1 && lastDir[side] !== dir) {
              blindTurns += 1;
            }
          }
          lastDir[side] = dir;
        }
      }
    }
    for (const side of [0, 1] as const) {
      covered += state.memory[side].seen.filter((t) => t >= 0).length / CELLS;
      sides += 1;
    }
  }
  return { blindTurnRate: blindTurns / Math.max(1, blindMoves), coverage600: covered / sides };
}

describe('C-4 探索行為（兩個等級 10 對打，前 600 tick，12 場）', () => {
  const result = behaviour(12);
  it('沒有食物可追時，走格轉向的比例 ≤ 50%（修之前 92%）', () => {
    expect(
      result.blindTurnRate,
      `轉向率 ${(100 * result.blindTurnRate).toFixed(1)}%`,
    ).toBeLessThanOrEqual(0.5);
  });
  it('tick 600 的視野覆蓋率 ≥ 55%（修之前 44%，S4 腳本 77%）', () => {
    expect(
      result.coverage600,
      `覆蓋率 ${(100 * result.coverage600).toFixed(1)}%`,
    ).toBeGreaterThanOrEqual(0.55);
  });
});

/**
 * A4 的兩個沒用過的種子區塊（各 200 場，標準誤約 3）。官方 100 種子由 `a-checks.*.test.ts` 守。
 * 修之前 C-4：官方 51.5、200..399 44.0、400..599 49.8。
 */
describe('C-4 A4（人類模型對等級 10）', () => {
  it.each([200, 400])(
    '種子 %i..+199 的勝率 ≤ 35%',
    (start) => {
      const rate = measureA4(ENTRY!, blockSeeds(start));
      expect(rate, `A4 ${start}..${start + 199}：${(100 * rate).toFixed(1)}%`).toBeLessThanOrEqual(
        0.35,
      );
    },
    600_000,
  );
});
