import { describe, expect, it } from 'vitest';

import { LOGICAL_HEIGHT, LOGICAL_WIDTH, integerScale } from './canvas';

describe('shell/canvas：320×240 整數倍放大（SPEC 第 3 節）', () => {
  it('邏輯解析度固定 320×240', () => {
    expect(LOGICAL_WIDTH).toBe(320);
    expect(LOGICAL_HEIGHT).toBe(240);
  });

  it('放大倍率是整數，取寬高都放得下的最大值', () => {
    expect(integerScale(1280, 720)).toBe(3);
    expect(integerScale(1920, 1080)).toBe(4);
    expect(integerScale(640, 480)).toBe(2);
    expect(integerScale(960, 480)).toBe(2);
    expect(integerScale(3840, 2160)).toBe(9);
  });

  it('放不下也至少是 1 倍（不縮小成非整數）', () => {
    expect(integerScale(300, 200)).toBe(1);
    expect(integerScale(0, 0)).toBe(1);
    expect(integerScale(375, 667)).toBe(1);
  });

  it('預留高度（手機的虛擬按鍵）要扣掉', () => {
    expect(integerScale(1280, 720, 0)).toBe(3);
    expect(integerScale(1280, 720, 120)).toBe(2);
  });
});
