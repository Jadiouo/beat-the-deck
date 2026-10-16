import { describe, expect, it } from 'vitest';

import { HUMAN_PARAMS, humanPolicy } from '../../ai/human-model';
import { levelParams, wrapPolicy } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { playMatch } from '../../core/match';
import type { Controller, Side } from '../../core/types';
import type { LevelParams } from '../../ai/types';
import { CALL, h9Game, makeState } from './logic';
import type { H9Bid } from './logic';

/**
 * H-9 的座位公平與深度軸（DESIGN-AI-FUN 10.49 第二個發現，與 `docs/cards/H-9.md` 的「座位與深度軸」一節）。
 *
 * 10.49 量到：人類模型坐 0 號邊 59.1%、坐 1 號邊 37.4%，等級 10 自我對打 0 號邊 72%。
 * 診斷把原因歸給「0 號邊在第 1、3、5 回合先喊」，但實際的原因是 `evaluate` 的一個 bug：
 * AI 坐 1 號邊、喊價之後，模擬裡對手（0 號邊，沒有 AI 的 45 tick 等待）立刻輪到、維持第一個動作（加 1），
 * 搜尋深度 ≥ 6 就走回「我的回合」，把「再抓一次」當成免費的好處、`danger = 0`，於是 AI 在該抓的時候繼續加價。
 * 這只發生在 1 號邊（0 號邊喊價之後對手要先等 45 tick），所以是座位偏差；也只發生在深度 6，所以深度軸壞了。
 * 修好之後，先喊的人的回合勝率是 50%（600 場，見小規格），規則不用改。
 *
 * 這裡的對局全部固定座位（不依種子奇偶換邊），因為真實遊戲裡人永遠坐 0 號邊。
 */

const CONFIG = { maxTicks: 3600, params: {} };
const SEEDS = Array.from({ length: 200 }, (_, i) => i);

function bid(side: Side, S: number): H9Bid {
  return { side, S };
}

function controller(params: LevelParams, seed: number): Controller<ReturnType<typeof h9Game.init>> {
  return wrapPolicy(h9Game, pathfinder, params, seed);
}

/** 固定座位：`a` 坐 `sideA`；回傳 a 的得分（平手算半場）。 */
function points(a: LevelParams, b: LevelParams, sideA: Side, seeds: readonly number[], policyA = pathfinder): number {
  let total = 0;
  for (const seed of seeds) {
    const ca = wrapPolicy(h9Game, policyA, a, seed);
    const cb = controller(b, seed + 1_000_003);
    const result =
      sideA === 0 ? playMatch(h9Game, seed, CONFIG, ca, cb) : playMatch(h9Game, seed, CONFIG, cb, ca);
    total += result.winner === null ? 0.5 : result.winner === sideA ? 1 : 0;
  }
  return total / seeds.length;
}

const L10 = levelParams(10);

describe('H-9 吹牛骰｜座位公平與深度軸', () => {
  it('1. 機制：AI 坐 1 號邊、對方的喊價明顯是假的（自己 6 點，喊 18 要對方 12 點）時，深度 5 與深度 6 都抓', () => {
    // 對方（0 號邊）從 9 喊到 15 再喊到 18；AI 的兩顆骰子總和 6，所以 18 要對方 12（1/36），幾乎一定是假的。
    const state = makeState({
      round: 1,
      first: 0,
      turn: 1,
      phase: 'choose',
      S: 18,
      bidder: 0,
      bids: [bid(0, 9), bid(1, 12), bid(0, 15), bid(1, 16), bid(0, 18)],
      dice: [
        [3, 4],
        [4, 2],
      ],
    });
    const at = (depth: number) => pathfinder.decide(h9Game, state, 1, 0, { depth, seed: 0, stalled: false });
    expect(at(5)).toEqual(CALL);
    expect(at(6)).toEqual(CALL);
  });

  it('2. 等級 10 自我對打，固定 A 坐 0 號邊（200 場，種子 0 到 199）：0 號邊的勝率在 40% 到 60%', () => {
    const rate = points(L10, L10, 0, SEEDS);
    expect(rate).toBeGreaterThanOrEqual(0.4);
    expect(rate).toBeLessThanOrEqual(0.6);
  }, 120_000);

  it('3. 人類模型對等級 10（各 200 場）：人坐 0 號邊與坐 1 號邊的勝率差不超過 15 個百分點，而且坐 0 號邊（真實遊戲的座位）不超過 45%', () => {
    const seat0 = points(HUMAN_PARAMS, L10, 0, SEEDS, humanPolicy);
    const seat1 = points(HUMAN_PARAMS, L10, 1, SEEDS, humanPolicy);
    expect(Math.abs(seat0 - seat1)).toBeLessThanOrEqual(0.15);
    expect(seat0).toBeLessThanOrEqual(0.45);
  }, 180_000);

  it('4. 深度軸：等級 10 的深度 6 不輸給深度 3（100 場，種子奇偶換邊，勝率至少 45%）', () => {
    const seeds = SEEDS.slice(0, 100);
    let total = 0;
    for (const seed of seeds) {
      const sideA: Side = seed % 2 === 0 ? 0 : 1;
      const deep = controller({ ...L10, depth: 6 }, seed);
      const shallow = controller({ ...L10, depth: 3 }, seed + 1_000_003);
      const result =
        sideA === 0
          ? playMatch(h9Game, seed, CONFIG, deep, shallow)
          : playMatch(h9Game, seed, CONFIG, shallow, deep);
      total += result.winner === null ? 0.5 : result.winner === sideA ? 1 : 0;
    }
    expect(total / seeds.length).toBeGreaterThanOrEqual(0.45);
  }, 120_000);
});
