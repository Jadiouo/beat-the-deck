import type { Buttons } from '../core/types';

/**
 * 輸入（SPEC 8.2）：鍵盤、手把、觸控都轉成抽象的 `Buttons`。
 * 這個檔案前半是純的（可以在沒有瀏覽器的環境測試）；`attachBrowserInput` 才碰 `window`。
 */

export function emptyButtons(): Buttons {
  return { up: false, down: false, left: false, right: false, a: false, b: false };
}

type Direction = 'up' | 'right' | 'down' | 'left';
/** 順時針的順序。 */
const CLOCKWISE: readonly Direction[] = ['up', 'right', 'down', 'left'];

/**
 * 把「畫面上的方向」轉回「世界方向」（C-2 用）。
 *
 * `r` 是畫面順時針轉了幾個 90 度（C-2 state 的 `viewRotation`）。
 * 世界順時針轉 r 次之後才是玩家看到的畫面，所以玩家按的方向要逆時針轉 r 次才是世界方向：
 * r = 1 時，畫面上的「右」是世界的「上」，畫面上的「上」是世界的「左」。
 * a 與 b 不受影響。轉四次回到原樣。
 */
export function rotateButtons(buttons: Buttons, r: number): Buttons {
  const turns = ((Math.trunc(r) % 4) + 4) % 4;
  const result = emptyButtons();
  result.a = buttons.a;
  result.b = buttons.b;
  CLOCKWISE.forEach((direction, index) => {
    if (buttons[direction]) {
      const target = CLOCKWISE[(index - turns + 4) % 4] as Direction;
      result[target] = true;
    }
  });
  return result;
}

/** 任何一個來源按著就算按著。 */
export function mergeButtons(...all: readonly Buttons[]): Buttons {
  const merged = emptyButtons();
  for (const buttons of all) {
    merged.up ||= buttons.up;
    merged.down ||= buttons.down;
    merged.left ||= buttons.left;
    merged.right ||= buttons.right;
    merged.a ||= buttons.a;
    merged.b ||= buttons.b;
  }
  return merged;
}

const KEY_MAP: Readonly<Record<string, keyof Buttons>> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  KeyZ: 'a',
  Space: 'a',
  KeyX: 'b',
};

export interface KeyboardState {
  keyDown(code: string): void;
  keyUp(code: string): void;
  /** 視窗失去焦點：所有鍵放開（不然 keyup 永遠收不到，鍵會卡住）。 */
  blur(): void;
  buttons(): Buttons;
  /** Esc 按著。 */
  pause(): boolean;
  /** 選單的確認：a（Z、空白）或 Enter。Enter 在遊戲裡不是 a。 */
  confirm(): boolean;
  /**
   * 自從上次呼叫以來按下過的鍵（就算已經放開了）。主迴圈每一幀才讀一次輸入，
   * 如果一次很短的按放剛好落在兩幀之間，只看「現在按著嗎」會漏掉；讀過就清掉。
   */
  takeTaps(): { buttons: Buttons; pause: boolean; confirm: boolean };
}

/** 用實體鍵的 `code` 追蹤按著的鍵。同一個抽象鍵可以由兩個實體鍵按著（左方向鍵與 A）。 */
export function createKeyboardState(): KeyboardState {
  const held = new Set<string>();
  const tapped = new Set<string>();
  const anyOf = (codes: ReadonlySet<string>, name: keyof Buttons): boolean =>
    [...codes].some((code) => KEY_MAP[code] === name);
  const anyHeld = (name: keyof Buttons): boolean => anyOf(held, name);

  return {
    keyDown(code: string): void {
      held.add(code);
      tapped.add(code);
    },
    keyUp(code: string): void {
      held.delete(code);
    },
    blur(): void {
      held.clear();
      tapped.clear();
    },
    buttons(): Buttons {
      return {
        up: anyHeld('up'),
        down: anyHeld('down'),
        left: anyHeld('left'),
        right: anyHeld('right'),
        a: anyHeld('a'),
        b: anyHeld('b'),
      };
    },
    pause(): boolean {
      return held.has('Escape');
    },
    confirm(): boolean {
      return anyHeld('a') || held.has('Enter');
    },
    takeTaps(): { buttons: Buttons; pause: boolean; confirm: boolean } {
      const taps = {
        buttons: {
          up: anyOf(tapped, 'up'),
          down: anyOf(tapped, 'down'),
          left: anyOf(tapped, 'left'),
          right: anyOf(tapped, 'right'),
          a: anyOf(tapped, 'a'),
          b: anyOf(tapped, 'b'),
        },
        pause: tapped.has('Escape'),
        confirm: anyOf(tapped, 'a') || tapped.has('Enter'),
      };
      tapped.clear();
      return taps;
    },
  };
}

/** Gamepad API 的最小形狀（`Gamepad` 滿足它）。 */
export interface PadLike {
  readonly buttons: readonly { readonly pressed: boolean }[];
  readonly axes: readonly number[];
}

export interface PadSnapshot {
  readonly buttons: Buttons;
  readonly pause: boolean;
}

const STICK_DEADZONE = 0.5;

/** 標準對照（Standard Gamepad）：十字鍵 12–15、下方按鈕 0、右方按鈕 1、Start 9、左類比軸 0 與 1。 */
export function readPad(pad: PadLike | null): PadSnapshot {
  if (pad === null) {
    return { buttons: emptyButtons(), pause: false };
  }
  const pressed = (index: number): boolean => pad.buttons[index]?.pressed === true;
  const x = pad.axes[0] ?? 0;
  const y = pad.axes[1] ?? 0;
  return {
    buttons: {
      up: pressed(12) || y < -STICK_DEADZONE,
      down: pressed(13) || y > STICK_DEADZONE,
      left: pressed(14) || x < -STICK_DEADZONE,
      right: pressed(15) || x > STICK_DEADZONE,
      a: pressed(0),
      b: pressed(1),
    },
    pause: pressed(9),
  };
}

/** 畫面寬度小於這個像素數，就顯示虛擬方向鍵與按鈕（SPEC 8.2）。 */
export const TOUCH_MAX_WIDTH = 640;

export function shouldShowTouchControls(width: number): boolean {
  return width < TOUCH_MAX_WIDTH;
}

/** 一幀讀到的輸入（三個來源合併後）。 */
export interface InputSnapshot {
  readonly buttons: Buttons;
  readonly confirm: boolean;
  readonly pause: boolean;
}

/** 這一幀才按下的鍵（上一幀沒按、這一幀按著）。選單用，按住不會連發。 */
export function newPresses(previous: InputSnapshot, current: InputSnapshot): InputSnapshot {
  const fresh = (before: boolean, now: boolean): boolean => now && !before;
  return {
    buttons: {
      up: fresh(previous.buttons.up, current.buttons.up),
      down: fresh(previous.buttons.down, current.buttons.down),
      left: fresh(previous.buttons.left, current.buttons.left),
      right: fresh(previous.buttons.right, current.buttons.right),
      a: fresh(previous.buttons.a, current.buttons.a),
      b: fresh(previous.buttons.b, current.buttons.b),
    },
    confirm: fresh(previous.confirm, current.confirm),
    pause: fresh(previous.pause, current.pause),
  };
}

/**
 * 選單用的「這一幀的按下」：邊緣偵測（上一幀沒按著、這一幀按著）再加上這一幀的 tap。
 *
 * 為什麼要加 tap：`read()` 合併了「按著」與「tap」（兩幀之間按下又放開）。如果只拿合併後的快照做邊緣偵測，
 * 兩下很短的按放落在連續兩幀時，第二幀的快照跟上一幀一樣都是 true，會被誤當成「一直按著」而漏掉。
 * 負載高、幀間隔拉長時，測試或手快的玩家就會碰到（e2e 第 2 條的偶發失敗就是這個）。
 * 任何一個 tap 本身就是一次新的按下，不受上一幀影響。
 */
export function framePresses(
  previousHeld: InputSnapshot,
  held: InputSnapshot,
  taps: InputSnapshot,
): InputSnapshot {
  const edge = newPresses(previousHeld, held);
  return {
    buttons: mergeButtons(edge.buttons, taps.buttons),
    confirm: edge.confirm || taps.confirm,
    pause: edge.pause || taps.pause,
  };
}

/** 一幀的輸入：合併後的快照（遊戲用）、只有按著的（邊緣偵測用）、只有 tap 的。 */
export interface FrameInput {
  readonly current: InputSnapshot;
  readonly held: InputSnapshot;
  readonly taps: InputSnapshot;
}

/** 瀏覽器端的輸入來源：鍵盤事件、手把輪詢、觸控按鈕。`read()` 每一幀呼叫一次。 */
export interface BrowserInput {
  read(): FrameInput;
  /** 觸控虛擬按鍵（由 touch.ts 設定）。 */
  setTouch(buttons: Buttons): void;
}

export function attachBrowserInput(target: Window): BrowserInput {
  const keyboard = createKeyboardState();
  let touch = emptyButtons();

  target.addEventListener('keydown', (event: KeyboardEvent) => {
    keyboard.keyDown(event.code);
    // 方向鍵與空白鍵不要讓頁面捲動。
    if (event.code in KEY_MAP) {
      event.preventDefault();
    }
  });
  target.addEventListener('keyup', (event: KeyboardEvent) => {
    keyboard.keyUp(event.code);
  });
  target.addEventListener('blur', () => {
    keyboard.blur();
    touch = emptyButtons();
  });
  target.document.addEventListener('visibilitychange', () => {
    if (target.document.hidden) {
      keyboard.blur();
    }
  });

  return {
    read(): FrameInput {
      const pads = target.navigator.getGamepads?.() ?? [];
      const pad = pads.find((candidate) => candidate !== null && candidate.connected) ?? null;
      const padSnapshot = readPad(pad);
      const taps = keyboard.takeTaps();
      const buttons = mergeButtons(keyboard.buttons(), taps.buttons, padSnapshot.buttons, touch);
      const heldButtons = mergeButtons(keyboard.buttons(), padSnapshot.buttons, touch);
      return {
        current: {
          buttons,
          confirm: keyboard.confirm() || taps.confirm || padSnapshot.buttons.a || touch.a,
          pause: keyboard.pause() || taps.pause || padSnapshot.pause,
        },
        held: {
          buttons: heldButtons,
          confirm: keyboard.confirm() || padSnapshot.buttons.a || touch.a,
          pause: keyboard.pause() || padSnapshot.pause,
        },
        taps: { buttons: taps.buttons, confirm: taps.confirm, pause: taps.pause },
      };
    },
    setTouch(buttons: Buttons): void {
      touch = buttons;
    },
  };
}
