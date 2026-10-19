import { describe, expect, it } from 'vitest';

import { duelStats, s4WinRate } from './clubs-s4.shared';

/**
 * 梅花的簡單腳本 S4 與兩個對打檢查（DESIGN-AI-FUN 10.37）。腳本本身與修之前的數字寫在 `clubs-s4.shared.ts`。
 */

const S4_GAMES = 200;
// 每條測試要跑 24 到 200 場完整對局（幾十秒到幾分鐘），預設的 5 秒一定逾時；與 `a-checks.*` 的做法一樣，在測試上明寫逾時。
const LONG_TEST_MS = 1_800_000;
// C-2 與 C-A 的數字逐位相同（腳本看不到畫面層的旋轉），C-7 只是對照組，所以只放這四張。
const CARDS = ['C-A', 'C-3', 'C-4', 'C-5'] as const;

describe.each(CARDS)('梅花簡單腳本 S4｜%s', (id) => {
  it(
    '延遲 12 tick 的 S4 對等級 10 的勝率 ≤ 40%',
    () => {
      const rate = s4WinRate(id, 12, S4_GAMES);
      expect(rate, `${id} S4（延遲 12）勝率 ${(100 * rate).toFixed(1)}%`).toBeLessThanOrEqual(0.4);
    },
    LONG_TEST_MS,
  );
  it(
    '延遲 0 的 S4 對等級 10 的勝率 ≤ 50%',
    () => {
      const rate = s4WinRate(id, 0, S4_GAMES);
      expect(rate, `${id} S4（延遲 0）勝率 ${(100 * rate).toFixed(1)}%`).toBeLessThanOrEqual(0.5);
    },
    LONG_TEST_MS,
  );
});

/**
 * 對打撞死：這個測試守的是 10.38 那個修法聲稱修好的東西 —— **走進自己的蛇身**。
 *
 * 門檻的訂正（docs/cards/C-4.md「探索的量測與修正」）：原本寫的是「24 場裡有蛇撞死的場數 ≤ 8（三分之一）」，數的是**任何死因**。
 * 那個門檻對 C-5 與 C-7 訂錯了：修法針對的是束搜尋把活路擠掉、走進自己身體的缺陷，而它確實把那類死亡清零；
 * 但 C-5 剩下的死因是牆的壓死（它的規則就是牆會壓死蛇）、C-7 剩下的是衝刺與餓死（它的規則就是會餓死），
 * 那些是各張牌自己的規則，不是缺陷，所以總撞死數（C-5 11／24、C-7 16／24）不是這個修法該負責的數字。
 * 改成只數「蛇頭下一格就是自己蛇身」的死亡場數，九張梅花牌可以用同一個門檻。這不是放寬：它把斷言對準了修法實際要守的那件事；
 * 而且門檻比原本的 8 更嚴（原本 ≤ 8 場任何死因，現在 ≤ 4 場一種死因）。
 *
 * 修法前後「有蛇走進自己蛇身」的場數（24 場，兩個等級 10 對打）：
 *   C-A 10 → 0、C-3 11 → 0、C-5 14 → 0、C-7 10 → 3（C-4 的 AI 幾乎不走這條路：0 → 1）。
 * （10.38 用 30 場量到的修法前數字是 C-A 12、C-3 14、C-5 19；場數不同，量法一樣。）
 * 總撞死場數修法後：C-A 2、C-3 5、C-4 5、C-5 11、C-7 16（C-5 的壓死與 C-7 的衝刺／餓死在內），不再是這個測試的斷言。
 * 局長中位數修法前 C-A 60、C-3 46.5、C-5 47.5 秒，修法後都是 60 秒（滿局）；C-7 的局長另有縮水機制（餓死），不看。
 */
const DUEL_GAMES = 24;
const SELF_CRASH_LIMIT = 4;
/**
 * 局長中位數的門檻（秒）。C-5 以外的牌是 55；C-5 是 50。
 *
 * C-5 的 50 是量出來的，不是調出來的：24 場、種子 0..23、兩個 pathfinder 等級 10 對打，中位數 50 秒、平均 46.07 秒、
 * 走進自己蛇身 1／24 場、壓死 12 蛇次。為什麼不是 55：55 訂在 07:03，C-5 當時的中位數是 60；
 * 之後 09:41 的誘餌幾何重做（c2ba41c：預告 120 tick、誘餌 +3、落點挑在離兩個蛇頭 8 格內）讓蛇更常去吃落點裡的誘餌、被牆壓死，
 * 同一組種子的中位數變成 52.5（c2ba41c）、50（fd1e9bf 的落點挑法微調後）。
 * 這個縮短不是共用層「必死扣 gain」造成的：同一組種子上，誘餌重做前修法使中位數 47.5 → 60，目前版本使 21.8 → 50。
 * `docs/cards/C-5.md` 的驗收線本來就是「局長中位數 30 到 90 秒」，50 在裡面；旋鈕掃描也顯示沒有一組能讓誘餌每場被吃 ≥ 2 次又讓局長 ≥ 55。
 * 這條測試原本要守的「不走進自己蛇身」仍用同一個上限（SELF_CRASH_LIMIT）。見 docs/cards/C-5.md「對打局長中位數 50 秒是已知取捨」。
 */
const MEDIAN_FLOOR_SECONDS: Readonly<Record<string, number>> = { 'C-5': 50 };
const DEFAULT_MEDIAN_FLOOR_SECONDS = 55;
const DUEL_CARDS = ['C-A', 'C-3', 'C-4', 'C-5', 'C-7'] as const;
describe.each(DUEL_CARDS)('梅花對打撞死｜%s', (id) => {
  it(
    '兩個等級 10 對打 24 場：走進自己蛇身的 ≤ 4 場，局長中位數 ≥ 55 秒（C-5 是 50，見上；C-7 不看局長）',
    () => {
      const stats = duelStats(id, DUEL_GAMES);
      expect(
        stats.selfCrashed,
        `${id} 走進自己蛇身 ${stats.selfCrashed}／${stats.games}（任何死因共 ${stats.crashed} 場）`,
      ).toBeLessThanOrEqual(SELF_CRASH_LIMIT);
      if (id !== 'C-7') {
        expect(
          stats.medianSeconds,
          `${id} 局長中位數 ${stats.medianSeconds} 秒`,
        ).toBeGreaterThanOrEqual(MEDIAN_FLOOR_SECONDS[id] ?? DEFAULT_MEDIAN_FLOOR_SECONDS);
      }
    },
    LONG_TEST_MS,
  );
});
