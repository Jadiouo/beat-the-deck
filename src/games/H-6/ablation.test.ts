import { describe, expect, it } from 'vitest';

import {
  aiController,
  feedThenBreakChooser,
  noisyChooser,
  oneStepChooser,
  playSeeds,
  scripted,
  strongChooser,
  uniformChooser,
} from './players.test-helpers';
import type { Chooser } from './players.test-helpers';

/**
 * H-6 地雷區的「對局層」量測（DESIGN-AI-FUN 10.4：三列劇本玩家表加消融）。
 * `logic.test.ts` 只檢查開關改變了單元層的數字或選擇；這裡把劇本玩家放進真的對局，對手是等級 10 的搜尋型，量結果。
 *
 * 兩組：
 * - 一直跑的（幾秒）：消融開關在對局層到底有沒有作用。小樣本就看得出來的是「完全相同」與「幾乎每場都不同」這兩種極端，
 *   所以用少數種子；勝率的差距要靠下面那組。
 * - 要量的（200 場一格，約 1 到 3 分鐘）：三列表與消融的勝率。用 `H6_MEASURE=1 npx vitest run src/games/H-6/ablation.test.ts`
 *   開；平常不跑，數字寫在 `docs/cards/H-6.md`「誠實的判斷」。
 */

const SHORT = Array.from({ length: 12 }, (_, i) => i);
const FULL = Array.from({ length: 200 }, (_, i) => i);
const MEASURE = process.env['H6_MEASURE'] === '1';

const PLAYERS: readonly (readonly [string, Chooser])[] = [
  ['強', strongChooser],
  ['人類型（15% 亂選）', noisyChooser(0.15)],
  ['弱（均勻亂選）', uniformChooser],
];

describe('H-6 地雷區｜消融在對局層的作用', () => {
  for (const [name, chooser] of PLAYERS) {
    it(`model = 0：${name}玩家對等級 10，每一場的輸入序列與比分都跟全開一模一樣（讀對手的模型是裝飾品）`, () => {
      const on = playSeeds((s) => scripted(chooser, s), aiController(10), SHORT, {});
      const off = playSeeds((s) => scripted(chooser, s), aiController(10), SHORT, { model: 0 });
      expect(off.signatures).toEqual(on.signatures);
    }, 120_000);
  }

  it('half = 0（後到也拿全額）：幾乎每一場的結果都不同（這條規則在對局裡真的有作用）', () => {
    const on = playSeeds((s) => scripted(strongChooser, s), aiController(10), SHORT, {});
    const off = playSeeds((s) => scripted(strongChooser, s), aiController(10), SHORT, { half: 0 });
    const same = on.signatures.filter((sig, i) => sig === off.signatures[i]).length;
    expect(same).toBeLessThanOrEqual(SHORT.length / 2);
  }, 120_000);

  it('decay = 0（等不縮水）：對局結果改變（流失這條規則在對局裡真的有作用）', () => {
    const on = playSeeds((s) => scripted(strongChooser, s), aiController(10), SHORT, {});
    const off = playSeeds((s) => scripted(strongChooser, s), aiController(10), SHORT, { decay: 0 });
    const same = on.signatures.filter((sig, i) => sig === off.signatures[i]).length;
    expect(same).toBeLessThan(SHORT.length);
  }, 120_000);
});

describe.skipIf(!MEASURE)('H-6 地雷區｜三列劇本玩家表（種子 0 到 199、平手算半場）', () => {
  it('強 > 人類型 > 弱，而且弱玩家明顯輸', () => {
    const rate = (chooser: Chooser): number =>
      playSeeds((s) => scripted(chooser, s), aiController(10), FULL, {}).rate;
    const strong = rate(strongChooser);
    const human = rate(noisyChooser(0.15));
    const oneStep = rate(oneStepChooser);
    const weak = rate(uniformChooser);
    const feed = rate(feedThenBreakChooser(4, 5));
    console.log(
      `H-6 三列表（對等級 10）：強 ${strong}　人類型（15% 亂選）${human}　人類型（只看一步）${oneStep}　弱 ${weak}　餵了再破 ${feed}`,
    );
    expect(strong).toBeGreaterThan(human);
    expect(human).toBeGreaterThan(weak);
    expect(weak).toBeLessThan(0.1);
  }, 3_600_000);
});
