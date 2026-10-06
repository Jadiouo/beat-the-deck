import { describe, expect, it } from 'vitest';

import { EVOLUTION_GAMES, MATCH_CONFIG, evolutionReport } from '../ai/evolution';
import { policyByName } from '../ai/level';
import { cAGame } from '../games/C-A/logic';
import { counterGame } from '../../tests/fixtures/counter-game';
import { createEvolutionRun } from './evolve';

describe('shell/evolve：AI 進化畫面的數字是真的（SPEC 7.5）', () => {
  it('一次只跑一場：呼叫 runNext 一次，場數加 1，沒有一次把 20 場跑完', () => {
    const run = createEvolutionRun(cAGame, policyByName('pathfinder'), 1, 2, 5);
    expect(run.total).toBe(EVOLUTION_GAMES);
    expect(run.played()).toBe(0);
    expect(run.done()).toBe(false);
    run.runNext();
    expect(run.played()).toBe(1);
    expect(run.done()).toBe(false);
    run.runNext();
    expect(run.played()).toBe(2);
  });

  it('20 場跑完的勝率，與 evolutionReport 逐位相同（C-A，1 級 → 2 級）', () => {
    const policy = policyByName('pathfinder');
    const run = createEvolutionRun(cAGame, policy, 1, 2, 11);
    while (!run.done()) {
      run.runNext();
    }
    expect(run.played()).toBe(20);
    expect(run.rate()).toBe(evolutionReport(cAGame, 1, 2, 11, policy, MATCH_CONFIG));
  });

  it('同樣的結果也出現在 counter-game 與別的種子、別的等級', () => {
    const policy = policyByName('greedy');
    for (const [oldLevel, newLevel, seed] of [
      [1, 4, 0],
      [3, 9, 100],
    ] as const) {
      const run = createEvolutionRun(counterGame, policy, oldLevel, newLevel, seed);
      while (!run.done()) {
        run.runNext();
      }
      expect(run.rate()).toBe(evolutionReport(counterGame, oldLevel, newLevel, seed, policy));
    }
  });

  it('跑到一半的勝率是「已經打完的那幾場」的平均；還沒打時是 0；跑完後再呼叫 runNext 不會多打', () => {
    const run = createEvolutionRun(counterGame, policyByName('greedy'), 1, 10, 3);
    expect(run.rate()).toBe(0);
    run.runNext();
    expect(run.points()).toBeGreaterThanOrEqual(0);
    expect(run.points()).toBeLessThanOrEqual(1);
    expect(run.rate()).toBe(run.points() / 1);
    while (!run.done()) {
      run.runNext();
    }
    const finalRate = run.rate();
    run.runNext();
    expect(run.played()).toBe(20);
    expect(run.rate()).toBe(finalRate);
  });
});
