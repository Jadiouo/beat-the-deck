import { describe, expect, it } from 'vitest';

import type { Buttons, Game } from '../../core/types';
import { precise } from '../../ai/policies/precise';
import {
  delayedViewController,
  delayedViewWinRate,
  observeWithDelay,
} from './delayed-view.test-helpers';
import type { SpadesState, StateOverrides } from './logic';

/**
 * 黑桃「自己場地、同一串子彈」的牌（S-A、S-2）共用的「真人觀察模型」測試。
 *
 * 真人的觀察：畫面上看得到的東西是 d tick 以前的，自己在哪是現在的，
 * 而那 d 個 tick 內才出現的子彈他看不到。`wrapPolicy` 用 `game.step` 把舊畫面重播到現在，
 * 會把那 d 個 tick 內才生成的子彈也一起算出來（DESIGN-AI-FUN 9.8），所以延遲在這類牌上等於零；
 * 這個模型不重播、不外推，是讓延遲真的有作用的那一個。
 * 檔名不是 `*.test.ts`，由各張牌的 `logic.test.ts` 呼叫。
 */

export interface DelayedViewSuite {
  readonly label: string;
  readonly game: Game<SpadesState>;
  readonly makeState: (overrides?: StateOverrides) => SpadesState;
}

const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

export function describeDelayedView(suite: DelayedViewSuite): void {
  const { game, label } = suite;
  const config = { maxTicks: 3600, params: {} };

  function history(seed: number, ticks: number): SpadesState[] {
    const states = [game.init(seed, config)];
    for (let i = 0; i < ticks; i += 1) {
      states.push(game.step(states[i] as SpadesState, [{ ...NONE, left: i % 7 < 3 }, NONE]));
    }
    return states;
  }

  describe(`${label}｜真人觀察模型（舊畫面、現在的自己、不外推）`, () => {
    it('餵給性格的 state：子彈是舊的（同一份清單），自己的位置與狀態是現在的', () => {
      const states = history(5, 120);
      const seen = states[100] as SpadesState;
      const now = states[120] as SpadesState;
      const fed = observeWithDelay(seen, now, 0);
      expect(fed.tick).toBe(seen.tick);
      expect(fed.fields[0].bullets).toBe(seen.fields[0].bullets);
      expect(fed.fields[0].px).toBe(now.fields[0].px);
      expect(fed.fields[0].py).toBe(now.fields[0].py);
      expect(fed.fields[0].vx).toBe(now.fields[0].vx);
      expect(fed.fields[0].hits).toBe(now.fields[0].hits);
      expect(fed.fields[0].invuln).toBe(now.fields[0].invuln);
    });

    it('看不到那 d 個 tick 內新生成的子彈：餵進去的子彈每一顆都在舊 state 裡', () => {
      const states = history(9, 200);
      const seen = states[170] as SpadesState;
      const now = states[200] as SpadesState;
      expect(now.fields[0].bullets.length).toBeGreaterThan(0);
      const fed = observeWithDelay(seen, now, 0);
      for (const bullet of fed.fields[0].bullets) {
        expect(seen.fields[0].bullets).toContain(bullet);
      }
      // 現在場上最新的那顆子彈（這 30 個 tick 內生成的）不在餵進去的清單裡
      const newest = now.fields[0].bullets[now.fields[0].bullets.length - 1];
      expect(fed.fields[0].bullets).not.toContain(newest);
    });

    it('不改動傳進來的 state', () => {
      const states = history(3, 60);
      const seen = states[40] as SpadesState;
      const now = states[60] as SpadesState;
      const before = structuredClone([seen, now]);
      observeWithDelay(seen, now, 1);
      expect([seen, now]).toEqual(before);
    });

    it('延遲 0、每 tick 決定、不亂按：和性格直接看現在的 state 做的決定一樣', () => {
      const states = history(11, 150);
      const controller = delayedViewController(
        game,
        precise,
        { delay: 0, decideEvery: 1, epsilon: 0 },
        11,
      );
      for (let t = 0; t <= 150; t += 1) {
        const state = states[t] as SpadesState;
        const pressed = controller.decide(state, 0, t);
        if (t % 10 === 0) {
          expect(pressed).toEqual(precise.decide(game, state, 0, t, { depth: 1, seed: 11 }));
        }
      }
    });

    it('延遲真的有作用：同一個玩家，延遲 0 的勝率明顯高於延遲 18（wrapPolicy 做不到這件事）', () => {
      const seeds = Array.from({ length: 10 }, (_v, i) => i);
      const short = { maxTicks: 600, params: {} };
      const fast = delayedViewWinRate(
        game,
        precise,
        { delay: 0, decideEvery: 2, epsilon: 0.02 },
        seeds,
        short,
      );
      const slow = delayedViewWinRate(
        game,
        precise,
        { delay: 18, decideEvery: 2, epsilon: 0.02 },
        seeds,
        short,
      );
      expect(fast - slow).toBeGreaterThanOrEqual(0.1);
    });
  });
}
