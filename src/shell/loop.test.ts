import { describe, expect, it } from 'vitest';

import { MAX_TICKS_PER_FRAME, createLoop } from './loop';

/** 假時鐘：真實時間是參數，測試自己決定每一幀過了多久。 */
function setup(): {
  ticks: () => number;
  renders: () => number;
  loop: ReturnType<typeof createLoop>;
  at: (ms: number) => number;
} {
  let tickCount = 0;
  let renderCount = 0;
  const loop = createLoop({
    onTick: () => {
      tickCount += 1;
    },
    onRender: () => {
      renderCount += 1;
    },
  });
  loop.frame(0);
  return {
    ticks: () => tickCount,
    renders: () => renderCount,
    loop,
    at: (ms: number) => loop.frame(ms),
  };
}

describe('shell/loop（TEST_PLAN 3.4）', () => {
  it('經過 1000 毫秒：剛好推進 60 個 tick', () => {
    const { ticks, at } = setup();
    // 一幀 1000 毫秒會被「一幀最多 5 個」截斷，所以用 100 幀、每幀 10 毫秒（0.6 tick）。
    let total = 0;
    for (let i = 1; i <= 100; i += 1) {
      total += at(i * 10);
    }
    expect(total).toBe(60);
    expect(ticks()).toBe(60);
  });

  it('經過 1000 毫秒：60 幀、每幀 1000/60 毫秒，不因浮點誤差少一個 tick', () => {
    const { ticks, at } = setup();
    for (let i = 1; i <= 60; i += 1) {
      at((i * 1000) / 60);
    }
    // 浮點誤差可能讓最後一個 tick 晚一幀才補上，所以再多給一個極小的時間。
    at(1000 + 1e-6);
    expect(ticks()).toBe(60);
  });

  it('一幀 16.67 毫秒推進 1 個 tick', () => {
    const { ticks, at } = setup();
    expect(at(16.67)).toBe(1);
    expect(ticks()).toBe(1);
  });

  it('一幀 8 毫秒推進 0 個，下一幀補上', () => {
    const { ticks, at } = setup();
    expect(at(8)).toBe(0);
    expect(ticks()).toBe(0);
    // 再 8 毫秒：累計 16 毫秒，還不到 16.67。
    expect(at(16)).toBe(0);
    // 再 8 毫秒：累計 24 毫秒，補上 1 個，剩下的餘數留給之後。
    expect(at(24)).toBe(1);
    expect(ticks()).toBe(1);
    // 餘數 7.33 毫秒 + 10 毫秒 = 17.33 毫秒，又是 1 個。
    expect(at(34)).toBe(1);
    expect(ticks()).toBe(2);
  });

  it('一幀 5000 毫秒（分頁切回來）：最多推進 5 個 tick，多的丟掉', () => {
    const { ticks, at } = setup();
    expect(at(5000)).toBe(MAX_TICKS_PER_FRAME);
    expect(MAX_TICKS_PER_FRAME).toBe(5);
    expect(ticks()).toBe(5);
    // 多的被丟掉，不會在之後的幀裡補回來。
    expect(at(5000 + 8)).toBe(0);
    expect(at(5000 + 16.67)).toBe(1);
    expect(ticks()).toBe(6);
  });

  it('暫停時不推進；繼續之後不爆衝', () => {
    const { ticks, renders, loop, at } = setup();
    at(16.67);
    expect(ticks()).toBe(1);
    loop.pause();
    expect(loop.isPaused()).toBe(true);
    expect(at(2000)).toBe(0);
    expect(at(4000)).toBe(0);
    expect(ticks()).toBe(1);
    // 暫停中畫面仍然要畫（要畫「暫停」的字樣）。
    expect(renders()).toBe(4);
    loop.resume();
    expect(loop.isPaused()).toBe(false);
    // 暫停的時間不算：繼續後的第一幀只算這一幀自己的 16.67 毫秒。
    expect(at(4016.67)).toBe(1);
    expect(ticks()).toBe(2);
  });

  it('每一幀畫一次，而且畫在 tick 之後', () => {
    const order: string[] = [];
    const loop = createLoop({
      onTick: () => order.push('tick'),
      onRender: () => order.push('render'),
    });
    loop.frame(0);
    loop.frame(34);
    expect(order).toEqual(['render', 'tick', 'tick', 'render']);
  });

  it('時間倒退或不是數字：當成 0，不推進也不丟錯', () => {
    const { ticks, at } = setup();
    at(100);
    const before = ticks();
    expect(at(50)).toBe(0);
    expect(at(Number.NaN)).toBe(0);
    expect(ticks()).toBe(before);
  });

  it('加速：自動遊玩用，每幀上限跟著放大', () => {
    const { ticks, loop, at } = setup();
    loop.setSpeed(10);
    expect(at(50)).toBe(30);
    expect(ticks()).toBe(30);
    expect(at(5050)).toBe(50);
  });
});
