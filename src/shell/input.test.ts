import { describe, expect, it } from 'vitest';

import type { Buttons } from '../core/types';
import {
  createKeyboardState,
  emptyButtons,
  mergeButtons,
  newPresses,
  readPad,
  rotateButtons,
  shouldShowTouchControls,
} from './input';

const DIRECTIONS = ['up', 'right', 'down', 'left'] as const;

function only(name: keyof Buttons): Buttons {
  return { ...emptyButtons(), [name]: true };
}

describe('shell/input：鍵盤（TEST_PLAN 3.5）', () => {
  it('方向鍵與 WASD 對應到相同的抽象鍵', () => {
    const pairs: readonly [string, string, keyof Buttons][] = [
      ['ArrowUp', 'KeyW', 'up'],
      ['ArrowDown', 'KeyS', 'down'],
      ['ArrowLeft', 'KeyA', 'left'],
      ['ArrowRight', 'KeyD', 'right'],
    ];
    for (const [arrow, wasd, name] of pairs) {
      const viaArrow = createKeyboardState();
      viaArrow.keyDown(arrow);
      const viaWasd = createKeyboardState();
      viaWasd.keyDown(wasd);
      expect(viaArrow.buttons()).toEqual(only(name));
      expect(viaWasd.buttons()).toEqual(only(name));
    }
  });

  it('a 是 Z 或空白鍵，b 是 X（SPEC 8.2）', () => {
    for (const code of ['KeyZ', 'Space']) {
      const keys = createKeyboardState();
      keys.keyDown(code);
      expect(keys.buttons()).toEqual(only('a'));
    }
    const keys = createKeyboardState();
    keys.keyDown('KeyX');
    expect(keys.buttons()).toEqual(only('b'));
  });

  it('同時按左與右：兩個都是 true（由遊戲自己決定怎麼處理）', () => {
    const keys = createKeyboardState();
    keys.keyDown('ArrowLeft');
    keys.keyDown('ArrowRight');
    expect(keys.buttons().left).toBe(true);
    expect(keys.buttons().right).toBe(true);
    // 同一個抽象鍵由兩個實體鍵按著：放開其中一個還是按著。
    keys.keyDown('KeyA');
    keys.keyUp('ArrowLeft');
    expect(keys.buttons().left).toBe(true);
    keys.keyUp('KeyA');
    expect(keys.buttons().left).toBe(false);
  });

  it('視窗失去焦點：所有鍵變成放開', () => {
    const keys = createKeyboardState();
    for (const code of ['ArrowUp', 'KeyD', 'KeyZ', 'KeyX', 'Escape', 'Enter']) {
      keys.keyDown(code);
    }
    expect(keys.buttons()).not.toEqual(emptyButtons());
    keys.blur();
    expect(keys.buttons()).toEqual(emptyButtons());
    expect(keys.pause()).toBe(false);
    expect(keys.confirm()).toBe(false);
  });

  it('Esc 是暫停；Enter 只在選單裡當確認，不是遊戲裡的 a', () => {
    const keys = createKeyboardState();
    keys.keyDown('Escape');
    expect(keys.pause()).toBe(true);
    keys.keyUp('Escape');
    keys.keyDown('Enter');
    expect(keys.confirm()).toBe(true);
    expect(keys.buttons().a).toBe(false);
    keys.keyUp('Enter');
    keys.keyDown('KeyZ');
    expect(keys.confirm()).toBe(true);
  });

  it('不認得的鍵不影響任何東西', () => {
    const keys = createKeyboardState();
    keys.keyDown('KeyQ');
    keys.keyUp('KeyQ');
    expect(keys.buttons()).toEqual(emptyButtons());
  });
});

describe('shell/input：rotateButtons（C-2 的方向轉換）', () => {
  // r 是畫面順時針轉了幾個 90 度；畫面上的方向要轉回世界方向（逆時針轉 r 次）。
  const EXPECTED: Readonly<Record<number, Readonly<Record<string, string>>>> = {
    0: { up: 'up', right: 'right', down: 'down', left: 'left' },
    1: { up: 'left', right: 'up', down: 'right', left: 'down' },
    2: { up: 'down', right: 'left', down: 'up', left: 'right' },
    3: { up: 'right', right: 'down', down: 'left', left: 'up' },
  };

  it.each([0, 1, 2, 3])('r = %i：四個方向各自對到正確的世界方向', (r) => {
    for (const direction of DIRECTIONS) {
      const rotated = rotateButtons(only(direction), r);
      const target = EXPECTED[r]?.[direction] as keyof Buttons;
      expect(rotated).toEqual(only(target));
    }
  });

  it.each([0, 1, 2, 3])('r = %i：a 與 b 不受影響', (r) => {
    const rotated = rotateButtons({ ...only('up'), a: true, b: true }, r);
    expect(rotated.a).toBe(true);
    expect(rotated.b).toBe(true);
    const plain = rotateButtons({ ...emptyButtons(), a: true }, r);
    expect(plain).toEqual({ ...emptyButtons(), a: true });
    expect(rotateButtons({ ...emptyButtons(), b: true }, r)).toEqual({
      ...emptyButtons(),
      b: true,
    });
  });

  it('同時按著的兩個方向一起轉', () => {
    const both = { ...emptyButtons(), left: true, right: true };
    expect(rotateButtons(both, 1)).toEqual({ ...emptyButtons(), down: true, up: true });
    const diagonal = { ...emptyButtons(), up: true, right: true };
    expect(rotateButtons(diagonal, 1)).toEqual({ ...emptyButtons(), left: true, up: true });
  });

  it('轉四次回到原樣（對每一種按鍵組合）', () => {
    for (let mask = 0; mask < 64; mask += 1) {
      const buttons: Buttons = {
        up: (mask & 1) !== 0,
        down: (mask & 2) !== 0,
        left: (mask & 4) !== 0,
        right: (mask & 8) !== 0,
        a: (mask & 16) !== 0,
        b: (mask & 32) !== 0,
      };
      for (const r of [1, 2, 3]) {
        let turned = buttons;
        for (let i = 0; i < 4; i += 1) {
          turned = rotateButtons(turned, r);
        }
        expect(turned).toEqual(buttons);
      }
      expect(rotateButtons(rotateButtons(buttons, 1), 3)).toEqual(buttons);
      expect(rotateButtons(rotateButtons(buttons, 2), 2)).toEqual(buttons);
      expect(rotateButtons(buttons, 0)).toEqual(buttons);
    }
  });

  it('不改動傳進來的物件', () => {
    const buttons = Object.freeze(only('up'));
    expect(() => rotateButtons(buttons, 1)).not.toThrow();
    expect(buttons).toEqual(only('up'));
  });
});

describe('shell/input：手把、觸控、合併', () => {
  const padWith = (
    pressed: readonly number[],
    axes: readonly number[] = [0, 0],
  ): Parameters<typeof readPad>[0] => ({
    buttons: Array.from({ length: 17 }, (_v, i) => ({ pressed: pressed.includes(i) })),
    axes,
  });

  it('十字鍵（12–15）、下方按鈕（0）→ a、右方按鈕（1）→ b、Start（9）→ 暫停', () => {
    expect(readPad(padWith([12])).buttons).toEqual(only('up'));
    expect(readPad(padWith([13])).buttons).toEqual(only('down'));
    expect(readPad(padWith([14])).buttons).toEqual(only('left'));
    expect(readPad(padWith([15])).buttons).toEqual(only('right'));
    expect(readPad(padWith([0])).buttons).toEqual(only('a'));
    expect(readPad(padWith([1])).buttons).toEqual(only('b'));
    expect(readPad(padWith([9])).pause).toBe(true);
    expect(readPad(padWith([])).pause).toBe(false);
  });

  it('左類比超過 0.5 才算，小幅度晃動不算；沒有手把回傳全放開', () => {
    expect(readPad(padWith([], [-0.9, 0])).buttons).toEqual(only('left'));
    expect(readPad(padWith([], [0.9, 0])).buttons).toEqual(only('right'));
    expect(readPad(padWith([], [0, -0.9])).buttons).toEqual(only('up'));
    expect(readPad(padWith([], [0, 0.9])).buttons).toEqual(only('down'));
    expect(readPad(padWith([], [0.3, -0.3])).buttons).toEqual(emptyButtons());
    expect(readPad(null)).toEqual({ buttons: emptyButtons(), pause: false });
  });

  it('觸控：寬度小於 640 像素才顯示虛擬按鍵', () => {
    expect(shouldShowTouchControls(639)).toBe(true);
    expect(shouldShowTouchControls(320)).toBe(true);
    expect(shouldShowTouchControls(640)).toBe(false);
    expect(shouldShowTouchControls(1280)).toBe(false);
  });

  it('mergeButtons：任何一個來源按著就算按著', () => {
    expect(mergeButtons(only('up'), only('a'))).toEqual({ ...emptyButtons(), up: true, a: true });
    expect(mergeButtons()).toEqual(emptyButtons());
  });

  it('newPresses：只回傳這一幀才按下的鍵（選單用，按住不會連發）', () => {
    const idle = { buttons: emptyButtons(), confirm: false, pause: false };
    const left = { buttons: only('left'), confirm: false, pause: false };
    const leftAndConfirm = { buttons: only('left'), confirm: true, pause: false };
    expect(newPresses(idle, left).buttons).toEqual(only('left'));
    expect(newPresses(left, left).buttons).toEqual(emptyButtons());
    expect(newPresses(left, leftAndConfirm)).toEqual({
      buttons: emptyButtons(),
      confirm: true,
      pause: false,
    });
    expect(newPresses(leftAndConfirm, idle)).toEqual(idle);
  });
});
