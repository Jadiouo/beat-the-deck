import { describe, expect, it } from 'vitest';

import { levelController } from '../../src/ai/level';
import { gambler } from '../../src/ai/policies/gambler';
import { greedy } from '../../src/ai/policies/greedy';
import { pathfinder } from '../../src/ai/policies/pathfinder';
import { precise } from '../../src/ai/policies/precise';
import { random } from '../../src/ai/policies/random';
import type { Policy } from '../../src/ai/types';
import { cAGame } from '../../src/games/C-A/logic';
import type { ClubsState } from '../../src/games/_clubs/logic';
import { sAGame } from '../../src/games/S-A/logic';
import type { SpadesState } from '../../src/games/S-A/logic';
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
 * P3 的「死亡率」：被測的性格（等級 5）對某個對手打 `seeds.length` 場，
 * 看被測的那條蛇有幾場「在對局結束時已經死掉」（兩條同時死、頭對頭，也算它死了）。
 * 坐哪一邊由種子的奇偶決定（與 harness 的 `winRate` 同一個做法），兩邊的亂數各自獨立。
 */
function deathRate(
  policy: Policy,
  opponent: Policy,
  opponentLevel: number,
  seeds: readonly number[],
): number {
  let dead = 0;
  for (const seed of seeds) {
    const mine: 0 | 1 = seed % 2 === 0 ? 0 : 1;
    const a = levelController(cAGame, policy, 5, seed);
    const b = levelController(cAGame, opponent, opponentLevel, seed + 1_000_003);
    const [c0, c1] = mine === 0 ? [a, b] : [b, a];
    let state: ClubsState = cAGame.init(seed, { maxTicks: 3600, params: {} });
    for (let tick = 0; !cAGame.isOver(state); tick += 1) {
      state = cAGame.step(state, [c0.decide(state, 0, tick), c1.decide(state, 1, tick)]);
    }
    dead += state.snakes[mine].alive ? 0 : 1;
  }
  return dead / seeds.length;
}

/**
 * P1 的「平均命中數」：被測的性格（等級 5）對 random（等級 10）打 `seeds.length` 場 S-A，
 * 看被測的那一邊平均被打中幾次。坐哪一邊由種子的奇偶決定（與 harness 的 `winRate` 同一個做法）。
 */
function meanHits(policy: Policy, seeds: readonly number[]): number {
  let total = 0;
  for (const seed of seeds) {
    const mine: 0 | 1 = seed % 2 === 0 ? 0 : 1;
    const a = levelController(sAGame, policy, 5, seed);
    const b = levelController(sAGame, random, 10, seed + 1_000_003);
    const [c0, c1] = mine === 0 ? [a, b] : [b, a];
    let state: SpadesState = sAGame.init(seed, { maxTicks: 3600, params: {} });
    for (let tick = 0; !sAGame.isOver(state); tick += 1) {
      state = sAGame.step(state, [c0.decide(state, 0, tick), c1.decide(state, 1, tick)]);
    }
    total += state.fields[mine].hits;
  }
  return total / seeds.length;
}

describe('5.2 性格真的不一樣', () => {
  it('P1（S-A 落雨）精準型比賭徒型少挨打：兩種性格各打 200 場（種子 0..199）對 random，精準型的平均命中數要低於賭徒型', () => {
    const seeds = seedList(200);
    const preciseHits = meanHits(precise, seeds);
    const gamblerHits = meanHits(gambler, seeds);
    console.log(
      `P1 平均命中數（等級 5 對 random，200 場）：精準型 ${preciseHits.toFixed(2)}，賭徒型 ${gamblerHits.toFixed(2)}`,
    );
    expect(preciseHits).toBeLessThan(gamblerHits);
  }, 120_000);
  it.todo(
    'P2（H-2 引信）賭徒型的分數起伏大：兩種性格各打 200 場（種子 0..199），賭徒型總分的標準差要高於精準型',
  );
  it('P3（C-A 貪食蛇對決）貪心型不看危險：等級 5，200 場（種子 0..199），貪心型的死亡率要高於搜尋型', () => {
    const seeds = seedList(200);
    const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
    // 主要的量法：兩種性格各自對同一個對手（random，等級 10）打 200 場，看自己的蛇死了幾場。
    const greedyVsRandom = deathRate(greedy, random, 10, seeds);
    const pathfinderVsRandom = deathRate(pathfinder, random, 10, seeds);
    // 輔助的量法：兩種性格互打（就是 P4 的那 200 場），看各自的蛇死了幾場。
    const greedyVsPathfinder = deathRate(greedy, pathfinder, 5, seeds);
    const pathfinderVsGreedy = deathRate(pathfinder, greedy, 5, seeds);
    // 參考用，不斷言：各自跟自己打。兩條同種性格的蛇常常頭對頭一起死，把「自己會不會死」的訊號蓋掉。
    const greedySelf = deathRate(greedy, greedy, 5, seeds);
    const pathfinderSelf = deathRate(pathfinder, pathfinder, 5, seeds);
    console.log(
      [
        `P3 死亡率（等級 5，200 場）`,
        `對 random：貪心型 ${pct(greedyVsRandom)}，搜尋型 ${pct(pathfinderVsRandom)}`,
        `互打：貪心型 ${pct(greedyVsPathfinder)}，搜尋型 ${pct(pathfinderVsGreedy)}`,
        `自我對弈（參考）：貪心型 ${pct(greedySelf)}，搜尋型 ${pct(pathfinderSelf)}`,
      ].join('｜'),
    );
    expect(greedyVsRandom).toBeGreaterThan(pathfinderVsRandom);
    expect(greedyVsPathfinder).toBeGreaterThan(pathfinderVsGreedy);
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
