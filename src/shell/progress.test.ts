import { describe, expect, it } from 'vitest';

import { CARD_IDS } from '../games/registry';
import {
  STORAGE_KEY,
  cardLevel,
  currentGlobalLevel,
  defaultProgress,
  isUnlocked,
  loadProgress,
  parseProgress,
  recordResult,
  revealedCount,
  saveProgress,
  withSettings,
} from './progress';
import type { Progress, StorageLike } from './progress';

function fakeStorage(
  initial: Record<string, string> = {},
): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

/** 贏下前 n 張牌（依 CARD_IDS 的順序）。 */
function withWins(ids: readonly string[]): Progress {
  let progress = defaultProgress();
  for (const id of ids) {
    progress = recordResult(progress, id, 10, 'win');
  }
  return progress;
}

describe('shell/progress（TEST_PLAN 3.6）', () => {
  it('沒有存檔：回傳預設值（全部沒翻開、等級 1）', () => {
    const progress = loadProgress(fakeStorage());
    expect(progress).toEqual(defaultProgress());
    expect(revealedCount(progress)).toBe(0);
    expect(currentGlobalLevel(progress)).toBe(1);
    expect(progress.settings.scanlines).toBe(false);
    expect(parseProgress(null)).toEqual(defaultProgress());
  });

  it('沒有 localStorage（隱私模式、被擋）：回傳預設值，存檔也不丟錯', () => {
    expect(loadProgress(null)).toEqual(defaultProgress());
    expect(() => saveProgress(null, defaultProgress())).not.toThrow();
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadProgress(throwing)).toEqual(defaultProgress());
    expect(() => saveProgress(throwing, defaultProgress())).not.toThrow();
  });

  it('壞掉的 JSON：回傳預設值，不丟錯', () => {
    for (const text of ['{', 'not json', '', 'null', '[]', '42', '"btd"']) {
      expect(loadProgress(fakeStorage({ [STORAGE_KEY]: text }))).toEqual(defaultProgress());
    }
  });

  it('版本號不認得（或沒有）：回傳預設值，不丟錯', () => {
    const good = recordResult(defaultProgress(), 'C-A', 5, 'win');
    for (const version of [0, 2, 99, '1', null]) {
      const text = JSON.stringify({ ...good, version });
      expect(loadProgress(fakeStorage({ [STORAGE_KEY]: text }))).toEqual(defaultProgress());
    }
    const noVersion: Record<string, unknown> = { ...good };
    delete noVersion['version'];
    expect(parseProgress(JSON.stringify(noVersion))).toEqual(defaultProgress());
  });

  it('欄位壞掉：壞的那一筆丟掉，其他保留，不丟錯', () => {
    const text = JSON.stringify({
      version: 1,
      cards: {
        'C-A': { best: 12, won: true },
        'C-2': { best: 'many', won: true },
        'C-3': 'oops',
      },
      settings: { scanlines: 'yes' },
    });
    const progress = parseProgress(text);
    expect(progress.cards['C-A']).toEqual({ best: 12, won: true });
    expect(progress.cards['C-2']).toBeUndefined();
    expect(progress.cards['C-3']).toBeUndefined();
    expect(progress.settings.scanlines).toBe(false);
  });

  it('存了再讀：內容一樣（鍵是 btd.v1，有版本號）', () => {
    const storage = fakeStorage();
    let progress = recordResult(defaultProgress(), 'C-A', 17, 'win');
    progress = withSettings(progress, { scanlines: true });
    saveProgress(storage, progress);
    expect(Object.keys(storage.data)).toEqual(['btd.v1']);
    expect(JSON.parse(storage.data['btd.v1'] as string).version).toBe(1);
    expect(loadProgress(storage)).toEqual(progress);
  });

  it('解鎖：四張 A 一開始開放', () => {
    const progress = defaultProgress();
    for (const id of ['C-A', 'S-A', 'D-A', 'H-A']) {
      expect(isUnlocked(progress, id)).toBe(true);
    }
    for (const id of ['C-2', 'S-2', 'D-K', 'H-3', 'JK-R', 'JK-B']) {
      expect(isUnlocked(progress, id)).toBe(false);
    }
  });

  it('解鎖：贏了 C-A 之後 C-2 開放、C-3 還沒；輸或平手不算', () => {
    const lost = recordResult(defaultProgress(), 'C-A', 3, 'loss');
    expect(isUnlocked(lost, 'C-2')).toBe(false);
    const drew = recordResult(defaultProgress(), 'C-A', 3, 'draw');
    expect(isUnlocked(drew, 'C-2')).toBe(false);
    const won = recordResult(defaultProgress(), 'C-A', 3, 'win');
    expect(isUnlocked(won, 'C-2')).toBe(true);
    expect(isUnlocked(won, 'C-3')).toBe(false);
    // 別的花色不受影響。
    expect(isUnlocked(won, 'S-2')).toBe(false);
  });

  it('解鎖：翻開 13 張後 JK-R 開放（12 張還沒）；翻開 40 張後 JK-B 開放（39 張還沒）', () => {
    const suits = CARD_IDS.filter((id) => !id.startsWith('JK'));
    const twelve = withWins(suits.slice(0, 12));
    expect(revealedCount(twelve)).toBe(12);
    expect(isUnlocked(twelve, 'JK-R')).toBe(false);
    const thirteen = withWins(suits.slice(0, 13));
    expect(isUnlocked(thirteen, 'JK-R')).toBe(true);
    expect(isUnlocked(thirteen, 'JK-B')).toBe(false);

    const thirtyNine = withWins(suits.slice(0, 39));
    expect(isUnlocked(thirtyNine, 'JK-B')).toBe(false);
    const forty = withWins(suits.slice(0, 40));
    expect(revealedCount(forty)).toBe(40);
    expect(isUnlocked(forty, 'JK-B')).toBe(true);
  });

  it('全域等級：翻開 0、1、2 張是 1；3 張是 2；27 張以上是 10', () => {
    const ids = CARD_IDS;
    expect(currentGlobalLevel(withWins(ids.slice(0, 0)))).toBe(1);
    expect(currentGlobalLevel(withWins(ids.slice(0, 1)))).toBe(1);
    expect(currentGlobalLevel(withWins(ids.slice(0, 2)))).toBe(1);
    expect(currentGlobalLevel(withWins(ids.slice(0, 3)))).toBe(2);
    expect(currentGlobalLevel(withWins(ids.slice(0, 26)))).toBe(9);
    expect(currentGlobalLevel(withWins(ids.slice(0, 27)))).toBe(10);
    expect(currentGlobalLevel(withWins(ids))).toBe(10);
  });

  it('某張牌的實際等級 ＝ 夾在 1 到 10 的（全域等級 ＋ 基礎等級 − 1）', () => {
    const level1 = defaultProgress();
    expect(cardLevel(level1, 1)).toBe(1);
    expect(cardLevel(level1, 4)).toBe(4);
    const level2 = withWins(CARD_IDS.slice(0, 3));
    expect(currentGlobalLevel(level2)).toBe(2);
    expect(cardLevel(level2, 1)).toBe(2);
    expect(cardLevel(level2, 3)).toBe(4);
    const level10 = withWins(CARD_IDS.slice(0, 27));
    expect(cardLevel(level10, 1)).toBe(10);
    expect(cardLevel(level10, 4)).toBe(10); // 10 + 4 − 1 = 13，夾在 10
  });

  it('recordResult：最佳分數取最大；贏過就一直是贏過；不改動傳進來的物件', () => {
    const start = defaultProgress();
    const frozen = JSON.stringify(start);
    const first = recordResult(start, 'C-A', 10, 'win');
    expect(JSON.stringify(start)).toBe(frozen);
    expect(first.cards['C-A']).toEqual({ best: 10, won: true });
    const second = recordResult(first, 'C-A', 4, 'loss');
    expect(second.cards['C-A']).toEqual({ best: 10, won: true });
    const third = recordResult(second, 'C-A', 25, 'loss');
    expect(third.cards['C-A']).toEqual({ best: 25, won: true });
  });

  it('recordResult：全域等級欄位跟著更新；連輸次數：輸 +1、贏或平手歸零', () => {
    let progress = defaultProgress();
    progress = recordResult(progress, 'C-A', 1, 'loss');
    progress = recordResult(progress, 'C-A', 1, 'loss');
    expect(progress.lossStreak).toBe(2);
    progress = recordResult(progress, 'C-A', 1, 'draw');
    expect(progress.lossStreak).toBe(0);
    progress = recordResult(progress, 'C-A', 1, 'loss');
    progress = recordResult(progress, 'C-A', 9, 'win');
    expect(progress.lossStreak).toBe(0);
    const three = withWins(CARD_IDS.slice(0, 3));
    expect(three.globalLevel).toBe(2);
  });
});
