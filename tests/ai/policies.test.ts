import { describe, expect, it } from 'vitest';

import { levelController } from '../../src/ai/level';
import { greedy } from '../../src/ai/policies/greedy';
import { pathfinder } from '../../src/ai/policies/pathfinder';
import type { Policy } from '../../src/ai/types';
import { cAGame } from '../../src/games/C-A/logic';
import type { ClubsState } from '../../src/games/_clubs/logic';
import { seedList, winRate } from './harness';

/**
 * TEST_PLAN 5.2｜性格真的不一樣。
 *
 * 這五條要用到還不存在的牌（S-A、H-2、C-A、D-A），所以先寫成 `it.todo`。
 * 做那張牌的人：把牌登記進 `src/games/registry.ts` 之後，把對應的 todo 換成真的測試，
 * 用 `tests/ai/harness.ts` 的 `winRate`（種子固定為 `seedList(200)` 即 0..199）
 * 與 `src/ai/policies/*`、`levelController` 組出各邊的控制器。
 * 門檻寫在描述裡，不可以為了讓測試過而放寬；過不了就回報實際數字。
 */

/**
 * P3 的「死亡率」：同一種性格、等級 5，兩邊都用它自我對弈（兩邊的亂數各自獨立，與 harness 同一個做法），
 * 打完一場看兩條蛇有幾條「在對局結束時已經死掉」，除以蛇的總數（每場 2 條）。
 * 選自我對弈而不是對 random，是因為對 random 時對手常常自己先撞死、對局提早結束，
 * 會把「這種性格自己會不會死」的訊號洗掉。
 */
function deathRate(policy: Policy, seeds: readonly number[]): number {
  let dead = 0;
  for (const seed of seeds) {
    const c0 = levelController(cAGame, policy, 5, seed);
    const c1 = levelController(cAGame, policy, 5, seed + 1_000_003);
    let state: ClubsState = cAGame.init(seed, { maxTicks: 3600, params: {} });
    for (let tick = 0; !cAGame.isOver(state); tick += 1) {
      state = cAGame.step(state, [c0.decide(state, 0, tick), c1.decide(state, 1, tick)]);
    }
    dead += state.snakes.filter((snake) => !snake.alive).length;
  }
  return dead / (seeds.length * 2);
}

describe('5.2 性格真的不一樣', () => {
  it.todo(
    'P1（S-A 落雨）精準型比賭徒型少挨打：兩種性格各打 200 場（種子 0..199）對 random，精準型的平均命中數要低於賭徒型',
  );
  it.todo(
    'P2（H-2 引信）賭徒型的分數起伏大：兩種性格各打 200 場（種子 0..199），賭徒型總分的標準差要高於精準型',
  );
  it('P3（C-A 貪食蛇對決）貪心型不看危險：等級 5，200 場（種子 0..199），貪心型的死亡率要高於搜尋型', () => {
    const seeds = seedList(200);
    const greedyDeaths = deathRate(greedy, seeds);
    const pathfinderDeaths = deathRate(pathfinder, seeds);
    // 把實際數字印出來，回報要用。
    console.log(
      `P3 死亡率（自我對弈，等級 5，200 場、400 條蛇）：貪心型 ${(greedyDeaths * 100).toFixed(1)}%，搜尋型 ${(pathfinderDeaths * 100).toFixed(1)}%`,
    );
    expect(greedyDeaths).toBeGreaterThan(pathfinderDeaths);
  }, 120_000);
  it('P4（C-A 貪食蛇對決）搜尋型在迷宮佔優：搜尋型對貪心型，同為等級 5，200 場（種子 0..199），搜尋型勝率至少 55%（平手算半場）', () => {
    const rate = winRate(cAGame, pathfinder, 5, greedy, 5, seedList(200));
    console.log(`P4 搜尋型對貪心型（等級 5，200 場）：搜尋型勝率 ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeGreaterThanOrEqual(0.55);
  }, 120_000);
  it.todo(
    'P5（D-A 搶金幣）貪心型在開闊地不吃虧：貪心型對搜尋型，同為等級 5，200 場（種子 0..199），貪心型勝率在 45% 到 65% 之間（平手算半場）',
  );
});
