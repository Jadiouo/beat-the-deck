import { describe, expect, it } from 'vitest';

import { CARD_IDS } from '../games/registry';
import { cellAt, cellRect, cellState, moveCursor } from './deck-view';
import { defaultProgress, recordResult } from './progress';

const LOGICAL_WIDTH = 320;
const LOGICAL_HEIGHT = 240;

describe('shell/deck-view：54 個格子', () => {
  it('54 個格子都在 320×240 之內、彼此不重疊', () => {
    expect(CARD_IDS).toHaveLength(54);
    const rects = CARD_IDS.map((_id, index) => cellRect(index));
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(LOGICAL_WIDTH);
      expect(rect.y + rect.h).toBeLessThanOrEqual(LOGICAL_HEIGHT);
    }
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        if (a === undefined || b === undefined) {
          throw new Error('unreachable');
        }
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${i} 與 ${j} 重疊`).toBe(false);
      }
    }
  });

  it('排列：4 列 13 張＋最後一列 2 張鬼牌', () => {
    const ys = new Set(CARD_IDS.slice(0, 52).map((_id, i) => cellRect(i).y));
    expect(ys.size).toBe(4);
    expect(cellRect(52).y).toBeGreaterThan(cellRect(51).y);
    expect(cellRect(53).y).toBe(cellRect(52).y);
    // 同一列從左到右依序。
    expect(cellRect(1).x).toBeGreaterThan(cellRect(0).x);
    expect(cellRect(13).x).toBe(cellRect(0).x);
  });

  it('cellAt：格子中心點回傳自己；格子之間的縫與畫面外回傳 null', () => {
    for (let index = 0; index < 54; index += 1) {
      const rect = cellRect(index);
      expect(cellAt(rect.x + rect.w / 2, rect.y + rect.h / 2)).toBe(index);
    }
    expect(cellAt(-5, 10)).toBeNull();
    expect(cellAt(1000, 1000)).toBeNull();
    expect(cellAt(0, LOGICAL_HEIGHT - 1)).toBeNull();
  });

  it('moveCursor：上下左右在格子間移動，邊界不繞出去', () => {
    expect(moveCursor(0, 'right')).toBe(1);
    expect(moveCursor(0, 'left')).toBe(0);
    expect(moveCursor(0, 'up')).toBe(0);
    expect(moveCursor(0, 'down')).toBe(13);
    expect(moveCursor(12, 'right')).toBe(12);
    expect(moveCursor(51, 'down')).toBe(53); // 第 13 欄往下是鬼牌列（靠右的那張）
    expect(moveCursor(39, 'down')).toBe(52); // 第 1 欄往下是 JK-R
    expect(moveCursor(52, 'right')).toBe(53);
    expect(moveCursor(53, 'right')).toBe(53);
    expect(moveCursor(52, 'up')).toBe(39);
    expect(moveCursor(53, 'up')).toBe(40);
    expect(moveCursor(53, 'down')).toBe(53);
  });

  it('moveCursor：從任何格子開始、往任何方向走，永遠停在 0 到 53', () => {
    for (let index = 0; index < 54; index += 1) {
      for (const direction of ['up', 'down', 'left', 'right'] as const) {
        const next = moveCursor(index, direction);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThanOrEqual(53);
      }
    }
  });
});

describe('shell/deck-view：格子的狀態', () => {
  it('翻開（贏過）> 尚未開放（牌還沒做）> 可玩（解鎖了）> 鎖住', () => {
    const fresh = defaultProgress();
    expect(cellState(fresh, 'C-A', true)).toBe('playable');
    expect(cellState(fresh, 'S-A', false)).toBe('unimplemented');
    expect(cellState(fresh, 'C-2', true)).toBe('locked');
    const won = recordResult(fresh, 'C-A', 9, 'win');
    expect(cellState(won, 'C-A', true)).toBe('revealed');
    expect(cellState(won, 'C-2', true)).toBe('playable');
    expect(cellState(won, 'C-3', true)).toBe('locked');
    // 翻開優先：就算之後登記表拿掉了這張牌，贏過的還是翻開。
    expect(cellState(won, 'C-A', false)).toBe('revealed');
  });

  it('鬼牌：已實作的牌湊不到 13 張時，翻開全部已實作的牌就可玩', () => {
    const suits = CARD_IDS.filter((id) => !id.startsWith('JK'));
    const twelve = suits.slice(0, 12);
    const implemented = [...twelve, 'JK-R'];
    let progress = defaultProgress();
    for (const id of twelve) {
      progress = recordResult(progress, id, 1, 'win');
    }
    expect(cellState(progress, 'JK-R', true)).toBe('locked'); // 不傳清單：SPEC 字面
    expect(cellState(progress, 'JK-R', true, implemented)).toBe('playable');
    expect(cellState(defaultProgress(), 'JK-R', true, implemented)).toBe('locked');
  });
});
