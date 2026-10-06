import type { Buttons } from '../core/types';
import { emptyButtons, shouldShowTouchControls } from './input';
import { strings } from './strings';

/**
 * 觸控：畫面寬度小於 640 像素時，在畫布下面出現虛擬方向鍵與兩顆按鈕（SPEC 8.2）。
 * 每個按鈕用 pointer 事件追蹤，可以多指同時按（例如方向加 a）。
 */

/** 虛擬按鍵區預留的高度（像素），畫布放大時要扣掉。 */
export const TOUCH_AREA_HEIGHT = 128;

type ButtonName = keyof Buttons;

export interface TouchControls {
  /** 依視窗寬度顯示或隱藏；回傳目前是否顯示。 */
  refresh(width: number): boolean;
}

export function createTouchControls(
  parent: HTMLElement,
  onChange: (buttons: Buttons) => void,
): TouchControls {
  const area = document.createElement('div');
  area.className = 'touch-area';
  area.dataset['testid'] = 'touch-controls';
  area.style.display = 'none';
  parent.append(area);

  const pressed = new Map<number, ButtonName>();
  const emit = (): void => {
    const buttons = emptyButtons();
    for (const name of pressed.values()) {
      buttons[name] = true;
    }
    onChange(buttons);
  };

  const make = (name: ButtonName, label: string, className: string): HTMLElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `touch-button ${className}`;
    button.textContent = label;
    button.dataset['button'] = name;
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      pressed.set(event.pointerId, name);
      emit();
    });
    const release = (event: PointerEvent): void => {
      pressed.delete(event.pointerId);
      emit();
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    return button;
  };

  const pad = document.createElement('div');
  pad.className = 'touch-pad';
  pad.append(
    make('up', strings.touch.up, 'up'),
    make('left', strings.touch.left, 'left'),
    make('right', strings.touch.right, 'right'),
    make('down', strings.touch.down, 'down'),
  );
  const actions = document.createElement('div');
  actions.className = 'touch-actions';
  actions.append(make('b', strings.touch.b, 'b'), make('a', strings.touch.a, 'a'));
  area.append(pad, actions);

  return {
    refresh(width: number): boolean {
      const show = shouldShowTouchControls(width);
      area.style.display = show ? 'flex' : 'none';
      if (!show && pressed.size > 0) {
        pressed.clear();
        emit();
      }
      return show;
    },
  };
}
