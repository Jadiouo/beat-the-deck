import { describe, expect, it } from 'vitest';

import { parseLaunch } from './launch';

describe('shell/launch：網址參數（TEST_PLAN 第 7 節）', () => {
  it('開發與測試建置：?card=C-A&seed=1&autoplay=human-model 直接開一局，人由人類模型代打', () => {
    expect(parseLaunch('?card=C-A&seed=1&autoplay=human-model', true)).toEqual({
      card: 'C-A',
      seed: 1,
      autoplay: 'human-model',
      speed: 30,
    });
  });

  it('正式建置：autoplay 與 card 一律無效', () => {
    expect(parseLaunch('?card=C-A&seed=1&autoplay=human-model', false)).toBeNull();
    expect(parseLaunch('?card=C-A', false)).toBeNull();
  });

  it('沒有 card：不是啟動參數', () => {
    expect(parseLaunch('', true)).toBeNull();
    expect(parseLaunch('?seed=3&autoplay=human-model', true)).toBeNull();
  });

  it('只有 card：種子預設 1，人自己玩（不加速）', () => {
    expect(parseLaunch('?card=C-2', true)).toEqual({
      card: 'C-2',
      seed: 1,
      autoplay: null,
      speed: 1,
    });
  });

  it('壞的種子（不是整數）用預設；不認得的 autoplay 當成沒有；speed 可以指定', () => {
    expect(parseLaunch('?card=C-A&seed=abc', true)?.seed).toBe(1);
    expect(parseLaunch('?card=C-A&seed=1.5', true)?.seed).toBe(1);
    expect(parseLaunch('?card=C-A&seed=-7', true)?.seed).toBe(-7);
    expect(parseLaunch('?card=C-A&autoplay=cheat', true)?.autoplay).toBeNull();
    expect(parseLaunch('?card=C-A&autoplay=human-model&speed=60', true)?.speed).toBe(60);
    expect(parseLaunch('?card=C-A&autoplay=human-model&speed=0', true)?.speed).toBe(30);
  });
});
