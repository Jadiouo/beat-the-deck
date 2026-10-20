import { describe, expect, it } from 'vitest';

import { findEntry } from '../games/registry';
import type { RegistryEntry } from '../games/types';
import { headlineKind, outcomeOf, showScoresOf } from './outcome';

function entryOf(id: string): RegistryEntry {
  const entry = findEntry(id);
  if (entry === undefined) {
    throw new Error(`登記表裡沒有 ${id}`);
  }
  return entry;
}

/** 同一張牌，但 `winner` 固定回傳指定的結果。 */
function withWinner(entry: RegistryEntry, winner: 0 | 1 | null): RegistryEntry {
  return { ...entry, game: { ...entry.game, winner: () => winner } };
}

describe('結算：沒有勝負的牌由牌自己宣告（meta.noWinner），不是外殼用 id 前綴猜', () => {
  it('只有 JK-R 宣告 noWinner；JK-B 有勝負，不宣告', () => {
    expect(entryOf('JK-R').meta.noWinner).toBe(true);
    expect(entryOf('JK-B').meta.noWinner).not.toBe(true);
  });

  it('JK-B 輸了，outcomeOf 回 loss，不是 win', () => {
    expect(outcomeOf(withWinner(entryOf('JK-B'), 1), {})).toBe('loss');
  });

  it('JK-B 贏了回 win、平手回 draw', () => {
    expect(outcomeOf(withWinner(entryOf('JK-B'), 0), {})).toBe('win');
    expect(outcomeOf(withWinner(entryOf('JK-B'), null), {})).toBe('draw');
  });

  it('JK-R 沒有勝負：玩完就算贏', () => {
    expect(outcomeOf(entryOf('JK-R'), {})).toBe('win');
  });

  it('JK-B 輸的結算標題是「AI 贏了」，不是「畫完了」；JK-R 是「畫完了」', () => {
    const jkb = entryOf('JK-B');
    expect(headlineKind(jkb, 'loss')).toBe('aiWins');
    expect(headlineKind(jkb, 'win')).toBe('youWin');
    expect(headlineKind(jkb, 'draw')).toBe('draw');
    expect(headlineKind(entryOf('JK-R'), 'win')).toBe('jokerDone');
  });

  it('結算頁：JK-B 要顯示分數，JK-R 不顯示，一般的牌顯示', () => {
    expect(showScoresOf(entryOf('JK-B'))).toBe(true);
    expect(showScoresOf(entryOf('JK-R'))).toBe(false);
    expect(showScoresOf(entryOf('C-A'))).toBe(true);
  });
});
