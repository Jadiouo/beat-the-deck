import { describe, expect, it } from 'vitest';

import type { Buttons } from '../../core/types';
import { c6Game, evaluateC6 } from './logic';
import type { C6State } from './logic';

/**
 * `evaluateC6` 的黃金值：只改寫法（查表、少算幾次）的重構不可以讓任何一個局面的 gain／danger 差一個位元。
 *
 * 局面來自一個不依賴 AI 的走法（線性同餘亂數 + `actions()` 的第一個選項偏多，所以會走到傳送門），
 * 所以共用的 AI 改了不會讓這個摘要變。每個局面問兩邊、四個轉向，把 gain 與 danger 的 64 位元原樣
 * 丟進 FNV-1a。摘要變了 ＝ evaluate 的輸出變了；如果是有意改評估，把新摘要貼進來，並在小規格寫為什麼。
 */

const CONFIG = { maxTicks: 3600, params: {} };

function pickAction(actions: readonly Buttons[], r: number): Buttons {
  // 4 次有 3 次走第一個（`actionsC6` 把「離食物近」的排前面），其餘亂選一個。
  return r % 4 !== 0 ? (actions[0] as Buttons) : (actions[(r >>> 2) % actions.length] as Buttons);
}

function digest(): { hash: string; states: number; transit: number; withExit: number } {
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  let h = 0x811c9dc5;
  const mix = (x: number): void => {
    f64[0] = x;
    for (const word of u32) {
      h = Math.imul(h ^ word, 0x01000193) >>> 0;
    }
  };
  let states = 0;
  let transit = 0;
  let withExit = 0;
  for (let seed = 0; seed < 16; seed += 1) {
    let lcg = (seed * 2654435761 + 12345) >>> 0;
    const next = (): number => {
      lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
      return lcg >>> 8;
    };
    let state: C6State = c6Game.init(seed, CONFIG);
    while (!state.over && state.tick < 1500) {
      if (state.tick % 3 === 0) {
        for (const side of [0, 1] as const) {
          const me = state.snakes[side];
          for (const turn of [0, 1, 2, 3] as const) {
            const snakes = [...state.snakes] as [C6State['snakes'][0], C6State['snakes'][1]];
            snakes[side] = { ...me, turn };
            const e = evaluateC6({ ...state, snakes }, side);
            mix(e.gain);
            mix(e.danger);
            states += 1;
          }
        }
        if (state.transit[0] !== null || state.transit[1] !== null) {
          transit += 1;
        }
      }
      const a0 = pickAction(c6Game.actions(state, 0), next());
      const a1 = pickAction(c6Game.actions(state, 1), next());
      state = c6Game.step(state, [a0, a1]);
    }
    withExit += state.portalUses[0] + state.portalUses[1];
  }
  return { hash: h.toString(16), states, transit, withExit };
}

describe('C-6 evaluate｜黃金值', () => {
  it('固定局面的 gain／danger 逐位元不變（含傳送中、下一步踩門口的局面）', () => {
    const r = digest();
    // 局面要夠多、要真的走到傳送門，否則這個摘要什麼都沒守住。
    expect(r.states).toBeGreaterThan(5000);
    expect(r.transit).toBeGreaterThan(50);
    expect(r.withExit).toBeGreaterThan(5);
    expect(r.hash).toBe('65c0cb5');
  });
});
