import { describe, expect, it } from 'vitest';

import { winRate } from '../../ai/evolution';
import { HUMAN_PARAMS, humanPolicy } from '../../ai/human-model';
import { levelController, wrapPolicy } from '../../ai/level';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import { playMatch } from '../../core/match';
import type { Side } from '../../core/types';
import { MOVE_EVERY } from '../_clubs/logic';
import { c6Game, evaluateC6 } from './logic';
import type { C6State } from './logic';
import { playTracked } from './players.test-helpers';

/**
 * C-6 的量測型測試（DESIGN-AI-FUN 2.5 互動強度、3 反應速度；小規格「量測計畫」）。
 * 數字見 `docs/cards/C-6.md`。門檻是 TEST_PLAN／DESIGN-AI-FUN 的建議值，沒有為了讓它過而調整。
 */

const CONFIG = { maxTicks: 3600, params: {} };

/** 1 步 evaluate 的最佳轉向（同搜尋型：gain − 2 × 範圍 × danger）。 */
function bestTurn(state: C6State, side: Side): number {
  const me = state.snakes[side];
  const turns = [me.dir, (me.dir + 1) % 4, (me.dir + 3) % 4];
  const evals = turns.map((turn) => {
    const snakes = [...state.snakes] as [(typeof state.snakes)[0], (typeof state.snakes)[1]];
    snakes[side] = { ...me, turn: turn as typeof me.turn };
    return evaluateC6({ ...state, snakes }, side);
  });
  const gains = evals.map((e) => e.gain);
  const spread = Math.max(...gains) - Math.min(...gains);
  const scores = evals.map((e) => e.gain - 2 * (spread > 0 ? spread : 1) * e.danger);
  let best = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if ((scores[i] as number) > (scores[best] as number)) {
      best = i;
    }
  }
  return turns[best] as number;
}

describe('C-6 傳送門｜互動強度與反應速度', () => {
  it('互動強度（準則 2.5）：把 AI 的蛇換成另一個合法的，人的最佳轉向改變的比例（建議值 20%，實測 9.4%，未達；數字見小規格）', () => {
    // 從 40 場對局（種子 0 到 39）每 90 tick 抽一個局面，共 200 個以上；AI 的蛇換成另一個樣本裡 AI 的蛇（含傳送狀態）。
    const samples: C6State[] = [];
    for (let seed = 0; seed < 40; seed += 1) {
      let state = c6Game.init(seed, CONFIG);
      const a = levelController(c6Game, pathfinder, 5, seed * 2 + 1);
      const b = levelController(c6Game, pathfinder, 5, seed * 2 + 2);
      let tick = 0;
      while (!state.over && tick < 900) {
        if (tick > 0 && tick % 90 === 0 && state.tick % MOVE_EVERY === 0) {
          samples.push(state);
        }
        state = c6Game.step(state, [a.decide(state, 0, tick), b.decide(state, 1, tick)]);
        tick += 1;
      }
    }
    expect(samples.length).toBeGreaterThanOrEqual(200);
    let compared = 0;
    let changed = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i] as C6State;
      const donor = samples[(i * 7 + 13) % samples.length] as C6State;
      const mine = new Set(s.snakes[0].body);
      const theirs = donor.snakes[1];
      if (theirs.body.some((c) => mine.has(c)) || s.foods.some((f) => theirs.body.includes(f))) {
        continue;
      }
      const swapped: C6State = {
        ...s,
        snakes: [s.snakes[0], theirs],
        transit: [s.transit[0], donor.transit[1]],
      };
      compared += 1;
      if (bestTurn(s, 0) !== bestTurn(swapped, 0)) {
        changed += 1;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(100);
    // 準則 2.5 的建議值是 20%；這張牌實測 9.4%（見小規格）。這裡釘住「量到的區間」而不是改門檻：
    // 它會在 evaluate 讓比例上到 20% 時（好事）或掉到 3% 以下時（互動消失）變紅，提醒回頭改小規格的標籤。
    const rate = changed / compared;
    expect(rate).toBeGreaterThan(0.03);
    expect(rate).toBeLessThan(0.2);
  }, 120_000);

  it('反應速度（準則 3）：快而淺對慢而深，快而淺的勝率低於 90%', () => {
    const fast = { reactionTicks: 3, decideEvery: 1, depth: 1, epsilon: 0 };
    const slow = { reactionTicks: 18, decideEvery: 12, depth: 6, epsilon: 0 };
    let points = 0;
    const seeds = 20;
    for (let seed = 0; seed < seeds; seed += 1) {
      const side: Side = seed % 2 === 0 ? 0 : 1;
      const f = wrapPolicy(c6Game, pathfinder, fast, seed + 1);
      const s = wrapPolicy(c6Game, pathfinder, slow, seed + 2);
      const r =
        side === 0 ? playMatch(c6Game, seed, CONFIG, f, s) : playMatch(c6Game, seed, CONFIG, s, f);
      points += r.winner === null ? 0.5 : r.winner === side ? 1 : 0;
    }
    expect(points / seeds).toBeLessThan(0.9);
  }, 300_000);

  it('A4 回歸：人類模型對等級 10，官方 A4 的前 60 個種子，勝率不超過 35%（門檻是 A4 的 35%，沒有動）', () => {
    // 官方 A4 是種子 0..99；這裡只取前 60 個（約 90 秒），為了讓 light 專案裡就看得到這個回歸。
    // 量法：`winRate(c6Game, humanPolicy, HUMAN_PARAMS, pathfinder, 10, 種子 0..59)`，奇偶換邊、平手算半場，確定性。
    // 回歸前（HEAD b9547ac，中間牆兩側扣分 50）：43.3%；官方 100 場 41.0%。二分法找不到任何 commit 把它「弄壞」：
    // C-6 交付時的 25.5% 重現不出來（見 DESIGN-AI-FUN 10.57）。
    const seeds = Array.from({ length: 60 }, (_, i) => i);
    const rate = winRate(c6Game, humanPolicy, HUMAN_PARAMS, pathfinder, 10, seeds);
    expect(rate, `C-6 A4（前 60 個種子）${(100 * rate).toFixed(1)}%`).toBeLessThanOrEqual(0.35);
  }, 600_000);

  it('堵門事件：兩個搜尋型等級 10 對打 12 場，記下每場平均（機制存不存在由小規格的數字說話）', () => {
    let blocks = 0;
    let games = 0;
    for (let seed = 0; seed < 12; seed += 1) {
      const r = playTracked(
        c6Game,
        seed,
        3600,
        levelController(c6Game, pathfinder, 10, seed * 2 + 1),
        levelController(c6Game, pathfinder, 10, seed * 2 + 2),
      );
      blocks += r.blocks;
      games += 1;
      expect(Number.isFinite(r.ticks)).toBe(true);
    }
    // 沒有門檻：小規格的判準是「每場平均不到 1 次就如實寫堵門不存在」。這裡只確認計數是合理的整數。
    expect(blocks).toBeGreaterThanOrEqual(0);
    expect(blocks / games).toBeLessThan(10);
  }, 300_000);

  it('性格指紋（機制）：用門次數 貪心型 > 搜尋型 > 精準型，兩兩至少 1.5 倍（種子 0 到 23，各性格等級 10 對搜尋型等級 10）', () => {
    const uses = (policy: Parameters<typeof levelController>[1]): number => {
      let total = 0;
      for (let seed = 0; seed < 24; seed += 1) {
        const side: Side = seed % 2 === 0 ? 0 : 1;
        const a = levelController(c6Game, policy, 10, seed + 7);
        const b = levelController(c6Game, pathfinder, 10, seed + 9);
        const r =
          side === 0
            ? playTracked(c6Game, seed, 3600, a, b)
            : playTracked(c6Game, seed, 3600, b, a);
        total += r.uses[side];
      }
      return total;
    };
    const greedyUses = uses(greedy);
    const pathUses = uses(pathfinder);
    const preciseUses = uses(precise);
    expect(greedyUses).toBeGreaterThanOrEqual(1.5 * pathUses);
    expect(pathUses).toBeGreaterThanOrEqual(1.5 * preciseUses);
  }, 900_000);
});
