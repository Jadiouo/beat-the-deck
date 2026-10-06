import { describe, expect, it } from 'vitest';

import { CARD_IDS } from '../games/registry';
import {
  STORAGE_KEY,
  cardLevel,
  currentGlobalLevel,
  defaultProgress,
  isUnlocked,
  jokerRequirement,
  loadProgress,
  parseProgress,
  recordResult,
  revealedCount,
  saveProgress,
  withSettings,
} from './progress';
import { strings } from './strings';
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

  // 解讀依據：SPEC 8.4 原文「音效……預設靜音，要玩家按過一次鍵才啟動」。
  // 「預設靜音」指的是瀏覽器不准沒互動就發聲（audio.ts 在第一次互動前不建立任何節點）；
  // 「按過一次鍵才啟動」就是第一次按鍵、點擊或觸控之後音效是開的。所以設定的預設值是「開」，
  // 標題選單的開關仍在，玩家可以關掉。舊存檔明確寫了 sound: false 的，照舊關著，不會被改回開。
  it('音效設定：預設是開（第一次互動之後就有聲音）；舊存檔沒有這個欄位算開，其他欄位照舊', () => {
    expect(defaultProgress().settings.sound).toBe(true);
    const legacy = JSON.stringify({
      version: 1,
      cards: { 'C-A': { best: 5, won: true } },
      globalLevel: 1,
      lossStreak: 2,
      settings: { scanlines: true },
    });
    const progress = parseProgress(legacy);
    expect(progress.settings).toEqual({ scanlines: true, sound: true });
    expect(progress.cards['C-A']).toEqual({ best: 5, won: true });
    expect(progress.lossStreak).toBe(2);
    // 連 settings 都沒有的舊存檔也算開。
    expect(parseProgress(JSON.stringify({ version: 1 })).settings.sound).toBe(true);
  });

  it('音效設定：存檔裡明確寫 sound: false 的玩家，讀回來仍是關（不會被改回開）', () => {
    const storage = fakeStorage();
    saveProgress(storage, withSettings(defaultProgress(), { sound: false }));
    expect(loadProgress(storage).settings.sound).toBe(false);
    expect(
      parseProgress(JSON.stringify({ version: 1, settings: { sound: false, scanlines: true } }))
        .settings,
    ).toEqual({ scanlines: true, sound: false });
  });

  it('音效設定：只有 false 才算關；壞掉的值（字串、數字）退回預設的開；存了再讀一樣；版本號仍是 1', () => {
    expect(
      parseProgress(JSON.stringify({ version: 1, settings: { sound: 'no' } })).settings.sound,
    ).toBe(true);
    expect(
      parseProgress(JSON.stringify({ version: 1, settings: { sound: 0 } })).settings.sound,
    ).toBe(true);
    const storage = fakeStorage();
    const off = withSettings(defaultProgress(), { sound: false });
    expect(off.settings).toEqual({ scanlines: false, sound: false });
    saveProgress(storage, off);
    expect(JSON.parse(storage.data['btd.v1'] as string).version).toBe(1);
    expect(loadProgress(storage).settings.sound).toBe(false);
    // 不認得的版本照舊當成沒有存檔（回到預設）。
    expect(parseProgress(JSON.stringify({ version: 2, settings: { sound: false } }))).toEqual(
      defaultProgress(),
    );
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

  describe('鬼牌門檻：已實作的牌湊不到 SPEC 的 13 張時，不要把玩家卡死（SPEC 8.1 的數字不變）', () => {
    const suits = CARD_IDS.filter((id) => !id.startsWith('JK'));
    // 目前的現實：12 張一般牌 ＋ JK-R 做好了，JK-B 還沒。
    const twelveNormals = suits.slice(0, 12);
    const implemented = [...twelveNormals, 'JK-R'];

    it('不傳「已實作的牌」時就是 SPEC 的字面：13 與 40', () => {
      expect(jokerRequirement('JK-R')).toBe(13);
      expect(jokerRequirement('JK-B')).toBe(40);
      expect(isUnlocked(withWins(twelveNormals), 'JK-R')).toBe(false);
    });

    it('JK-R：只實作了 12 張一般牌時，門檻是 12；翻開 11 張還不行，12 張就開放', () => {
      expect(jokerRequirement('JK-R', implemented)).toBe(12);
      expect(isUnlocked(withWins(twelveNormals.slice(0, 11)), 'JK-R', implemented)).toBe(false);
      expect(isUnlocked(withWins(twelveNormals), 'JK-R', implemented)).toBe(true);
    });

    it('JK-R 自己不算在 JK-R 的門檻裡（不會自己等自己）；JK-B 的門檻不超過它前面做好的張數', () => {
      expect(jokerRequirement('JK-R', ['JK-R', 'JK-B', ...twelveNormals])).toBe(12);
      expect(jokerRequirement('JK-B', implemented)).toBe(13);
      expect(isUnlocked(withWins(implemented), 'JK-B', implemented)).toBe(true);
      expect(isUnlocked(withWins(twelveNormals), 'JK-B', implemented)).toBe(false);
    });

    it('已實作的一般牌有 13 張以上時，與 SPEC 完全一樣（上限就是 13／40）', () => {
      const many = suits.slice(0, 30);
      expect(jokerRequirement('JK-R', many)).toBe(13);
      expect(isUnlocked(withWins(suits.slice(0, 12)), 'JK-R', many)).toBe(false);
      expect(isUnlocked(withWins(suits.slice(0, 13)), 'JK-R', many)).toBe(true);
      expect(jokerRequirement('JK-B', CARD_IDS)).toBe(40);
      expect(jokerRequirement('JK-B', [...suits.slice(0, 20), 'JK-R'])).toBe(21);
    });

    it('一般牌的解鎖規則不受影響', () => {
      expect(isUnlocked(defaultProgress(), 'C-2', implemented)).toBe(false);
      expect(isUnlocked(defaultProgress(), 'C-A', implemented)).toBe(true);
    });

    it('畫面文字：說明還差幾張；門檻被已實作張數壓低時要講明白', () => {
      expect(strings.table.lockedJoker(13, 12, false)).toBe('未解鎖：先翻開 13 張牌（目前 12）');
      const capped = strings.table.lockedJoker(12, 11, true);
      expect(capped).toContain('12');
      expect(capped).toContain('11');
      expect(capped).toContain('已開放');
    });
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
