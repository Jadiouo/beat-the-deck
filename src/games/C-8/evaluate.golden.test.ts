import { describe, expect, it } from 'vitest';

import { humanModel } from '../../ai/human-model';
import { levelController, policyByName } from '../../ai/level';
import { playMatch } from '../../core/match';
import type { Buttons, Inputs, Side } from '../../core/types';
import { c8Game } from './logic';
import type { C8State } from './logic';

/**
 * C-8 `evaluate`／`actions` 的黃金值：只改寫法（查表、快取、少算幾次）的重構不可以讓任何一個局面的
 * gain／danger／動作順序差一個位元，也不可以讓 AI 在整場對局裡的任何一個 tick 做不同的決定。
 * 作法同 C-6（`src/games/C-6/evaluate.golden.test.ts`）。
 *
 * 一、固定局面：局面來自一個不依賴 AI 的走法（線性同餘亂數挑 `actions()` 的選項），所以共用的 AI 改了不會讓
 *     這個摘要變。每個局面問兩邊、四個轉向（含倒車的），把 gain 與 danger 的 64 位元原樣丟進 FNV-1a；
 *     另外把「對手已出局」的假局面也問一遍。
 * 二、與呼叫順序無關：同一批局面用另一個順序（洗牌）再問一次，每一筆答案都要逐位元相同
 *     （快取不可以讓答案依賴「上一次問了什麼」）。
 * 三、整場：兩種對手各打兩場，每個 tick 兩邊的決定（按鍵）與終局雜湊丟進摘要。
 * 摘要變了 ＝ 輸出變了；如果是有意改評估，把新摘要貼進來，並在小規格寫為什麼。
 */

const CONFIG = { maxTicks: 3600, params: {} };

function buttonsMask(b: Buttons): number {
  return (b.up ? 1 : 0) | (b.down ? 2 : 0) | (b.left ? 4 : 0) | (b.right ? 8 : 0);
}

interface Case {
  readonly state: C8State;
  readonly side: Side;
}

function collect(): { cases: Case[]; frozen: number; crashes: number; rounds: number } {
  const cases: Case[] = [];
  let frozen = 0;
  let crashes = 0;
  let rounds = 0;
  for (let seed = 0; seed < 14; seed += 1) {
    let lcg = (seed * 2654435761 + 12345) >>> 0;
    const next = (): number => {
      lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
      return lcg >>> 8;
    };
    let state: C8State = c8Game.init(seed, CONFIG);
    while (!state.over && state.tick < 2400) {
      if (state.tick % 4 === 0) {
        for (const side of [0, 1] as const) {
          for (const turn of [0, 1, 2, 3] as const) {
            const snakes = [...state.snakes] as [C8State['snakes'][0], C8State['snakes'][1]];
            snakes[side] = { ...snakes[side], turn };
            cases.push({ state: { ...state, snakes }, side });
          }
        }
        // 對手已出局（但畫面沒凍結）：自然不會出現，評估還是要有同樣的答案。
        const dead = [...state.snakes] as [C8State['snakes'][0], C8State['snakes'][1]];
        dead[1] = { ...dead[1], alive: false };
        cases.push({ state: { ...state, snakes: dead }, side: 0 });
        if (state.pause > 0 || state.outcome !== null) {
          frozen += 1;
        }
        if (state.snakes.some((s) => !s.alive)) {
          crashes += 1;
        }
      }
      rounds = Math.max(rounds, state.round);
      const pick = (side: Side): Buttons => {
        const options = c8Game.actions(state, side);
        return options[next() % options.length] as Buttons;
      };
      const inputs: Inputs = [pick(0), pick(1)];
      state = c8Game.step(state, inputs);
    }
  }
  return { cases, frozen, crashes, rounds };
}

function fnv(): { mix: (x: number) => void; hex: () => string } {
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  let h = 0x811c9dc5;
  return {
    mix(x: number): void {
      f64[0] = x;
      for (const word of u32) {
        h = Math.imul(h ^ word, 0x01000193) >>> 0;
      }
    },
    hex: () => h.toString(16),
  };
}

function answer(c: Case): [number, number, number] {
  const e = c8Game.evaluate(c.state, c.side);
  const actions = c8Game.actions(c.state, c.side);
  // 動作清單：順序與內容（按鍵組合）都要一樣。
  let code = actions.length;
  for (const a of actions) {
    code = code * 17 + buttonsMask(a);
  }
  return [e.gain, e.danger, code];
}

describe('C-8 evaluate｜黃金值', () => {
  it('固定局面的 gain／danger／動作順序逐位元不變，而且與問的順序無關', () => {
    const { cases, frozen, crashes, rounds } = collect();
    // 局面要夠多、要有凍結的、有撞死的、要打到很多局，否則這個摘要什麼都沒守住。
    expect(cases.length).toBeGreaterThan(10_000);
    expect(frozen).toBeGreaterThan(40);
    expect(crashes).toBeGreaterThan(40);
    expect(rounds).toBeGreaterThan(10);

    const h = fnv();
    const first = cases.map((c) => {
      const a = answer(c);
      h.mix(a[0]);
      h.mix(a[1]);
      h.mix(a[2]);
      return a;
    });

    // 洗牌後再問一次（Fisher–Yates，固定亂數）：快取不可以讓答案依賴呼叫順序。
    const order = cases.map((_, i) => i);
    let lcg = 0x9e3779b9;
    for (let i = order.length - 1; i > 0; i -= 1) {
      lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
      const j = lcg % (i + 1);
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    for (const i of order) {
      const a = answer(cases[i] as Case);
      const b = first[i] as [number, number, number];
      expect(Object.is(a[0], b[0]) && Object.is(a[1], b[1]) && a[2] === b[2], `局面 ${i}`).toBe(
        true,
      );
    }
    expect(h.hex()).toBe('ca3a0a33');
  });

  it('整場對局的每個 tick 兩邊的決定與終局雜湊逐位元不變', () => {
    const h = fnv();
    const pathfinder = policyByName('pathfinder');
    for (const [seed, who] of [
      [0, 'level10'],
      [1, 'level10'],
      [2, 'human'],
      [3, 'human'],
    ] as const) {
      const c0 =
        who === 'human' ? humanModel(c8Game, seed) : levelController(c8Game, pathfinder, 10, seed);
      const c1 = levelController(c8Game, pathfinder, 10, seed + 1_000_003);
      const m = playMatch(c8Game, seed, CONFIG, c0, c1);
      for (const [a, b] of m.inputs) {
        h.mix(buttonsMask(a) * 16 + buttonsMask(b));
      }
      h.mix(m.ticks);
      h.mix(m.score[0] * 1000 + m.score[1]);
      for (const ch of m.finalHash) {
        h.mix(ch.charCodeAt(0));
      }
    }
    expect(h.hex()).toBe('695ae105');
  }, 120_000);
});
