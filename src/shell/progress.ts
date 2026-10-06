import { effectiveLevel, globalLevel } from '../ai/level';
import { CARD_IDS } from '../games/registry';

/**
 * 進度（SPEC 8.3）：存在 localStorage，鍵 `btd.v1`，格式有版本號。
 * 讀到壞掉的 JSON、不認得的版本、或根本沒有 localStorage，都當成沒有存檔，不丟錯。
 * 等級的兩個純函式（`globalLevel`、`effectiveLevel`）在 `src/ai/level.ts`，這裡直接用。
 */

export const STORAGE_KEY = 'btd.v1';
export const PROGRESS_VERSION = 1;

/** 翻開幾張之後鬼牌開放（SPEC 8.1）。 */
const JOKER_R_REQUIRES = 13;
const JOKER_B_REQUIRES = 40;

export interface CardRecord {
  /** 人在這張牌上的最佳分數。 */
  readonly best: number;
  /** 贏過嗎（贏過就翻開）。 */
  readonly won: boolean;
}

export interface Settings {
  /** 掃描線效果。 */
  readonly scanlines: boolean;
  /**
   * 音效（SPEC 8.4「預設靜音，要玩家按過一次鍵才啟動」）：字面解讀是第一次互動之後就是開的，所以預設開。
   * 舊存檔沒有這個欄位算開；存檔裡明確寫 false 的玩家照舊關著。
   */
  readonly sound: boolean;
}

export interface Progress {
  readonly version: typeof PROGRESS_VERSION;
  readonly cards: Readonly<Record<string, CardRecord>>;
  /** 全域 AI 等級（由翻開張數算出來，存下來是為了讓人看得到、也方便偵測「升級了」）。 */
  readonly globalLevel: number;
  /** 人目前連輸幾場（輸 +1，贏或平手歸零）。給「你連輸三場」的台詞用。 */
  readonly lossStreak: number;
  readonly settings: Settings;
}

/** `localStorage` 的最小形狀，測試用假的。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Outcome = 'win' | 'loss' | 'draw';

export function defaultProgress(): Progress {
  return {
    version: PROGRESS_VERSION,
    cards: {},
    globalLevel: 1,
    lossStreak: 0,
    settings: { scanlines: false, sound: true },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解讀存檔文字。壞掉的、版本不認得的回傳預設值；個別壞掉的欄位丟掉、其餘保留。 */
export function parseProgress(text: string | null): Progress {
  if (text === null) {
    return defaultProgress();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return defaultProgress();
  }
  if (!isRecord(raw) || raw['version'] !== PROGRESS_VERSION) {
    return defaultProgress();
  }

  const cards: Record<string, CardRecord> = {};
  const rawCards = raw['cards'];
  if (isRecord(rawCards)) {
    for (const [id, entry] of Object.entries(rawCards)) {
      if (
        isRecord(entry) &&
        typeof entry['best'] === 'number' &&
        Number.isFinite(entry['best']) &&
        typeof entry['won'] === 'boolean'
      ) {
        cards[id] = { best: entry['best'], won: entry['won'] };
      }
    }
  }

  const rawSettings = raw['settings'];
  const scanlines = isRecord(rawSettings) && rawSettings['scanlines'] === true;
  // 只有明確的 false 才算關；沒有欄位或壞掉的值退回預設的開。
  const sound = !(isRecord(rawSettings) && rawSettings['sound'] === false);
  const rawStreak = raw['lossStreak'];
  const lossStreak =
    typeof rawStreak === 'number' && Number.isInteger(rawStreak) && rawStreak > 0 ? rawStreak : 0;

  const progress: Progress = {
    version: PROGRESS_VERSION,
    cards,
    globalLevel: 1,
    lossStreak,
    settings: { scanlines, sound },
  };
  // 全域等級永遠由翻開張數重算，不信存檔裡的數字。
  return { ...progress, globalLevel: currentGlobalLevel(progress) };
}

export function loadProgress(storage: StorageLike | null): Progress {
  if (storage === null) {
    return defaultProgress();
  }
  try {
    return parseProgress(storage.getItem(STORAGE_KEY));
  } catch {
    return defaultProgress();
  }
}

/** 存檔失敗（空間滿了、被擋）不丟錯：進度只是少存一次。 */
export function saveProgress(storage: StorageLike | null, progress: Progress): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // 忽略。
  }
}

/** 翻開了幾張（贏過的牌）。 */
export function revealedCount(progress: Progress): number {
  return Object.values(progress.cards).filter((record) => record.won).length;
}

function isWon(progress: Progress, id: string): boolean {
  return progress.cards[id]?.won === true;
}

/**
 * 鬼牌要翻開幾張才開放。
 *
 * SPEC 8.1 的數字是 13（JK-R）與 40（JK-B），不傳 `implementedIds` 時就是這兩個數字。
 * 傳了「目前登記表裡做好的牌」時，門檻取 min(SPEC 的數字, 其他已實作的牌數)：
 * 41 張牌還沒做完的時候，能翻開的牌少於 13 張，照字面永遠湊不到，JK-R 就永遠鎖住（玩家被卡死）。
 * 做到 13 張一般牌以上，這個上限就不再起作用，行為與 SPEC 完全一樣。
 * 計算時不算牌本身；JK-R 的門檻也不算 JK-B（JK-B 要先有 JK-R 才解得開，算進去會自己等自己）。
 */
export function jokerRequirement(
  id: 'JK-R' | 'JK-B',
  implementedIds: readonly string[] = CARD_IDS,
): number {
  const spec = id === 'JK-R' ? JOKER_R_REQUIRES : JOKER_B_REQUIRES;
  const reachable = implementedIds.filter(
    (other) => other !== id && !(id === 'JK-R' && other === 'JK-B'),
  ).length;
  return Math.min(spec, reachable);
}

/**
 * 解鎖規則（SPEC 8.1）：四個花色的 A 一開始開放；其餘每張要先贏同花色的前一張；
 * 翻開 13 張後 JK-R 開放，翻開 40 張後 JK-B 開放（門檻的上限見 `jokerRequirement`）。
 */
export function isUnlocked(
  progress: Progress,
  id: string,
  implementedIds: readonly string[] = CARD_IDS,
): boolean {
  if (id === 'JK-R' || id === 'JK-B') {
    return revealedCount(progress) >= jokerRequirement(id, implementedIds);
  }
  const index = CARD_IDS.indexOf(id);
  if (index < 0) {
    return false;
  }
  // 每個花色 13 張，A 是每 13 張的第一張。
  if (index % 13 === 0) {
    return true;
  }
  return isWon(progress, CARD_IDS[index - 1] as string);
}

/** 全域 AI 等級（每翻開 3 張加 1，上限 10）。 */
export function currentGlobalLevel(progress: Progress): number {
  return globalLevel(revealedCount(progress));
}

/** 某張牌的實際等級 ＝ 夾在 1 到 10 的（全域等級 ＋ 基礎等級 − 1）。 */
export function cardLevel(progress: Progress, baseLevel: number): number {
  return effectiveLevel(currentGlobalLevel(progress), baseLevel);
}

/** 記一場結果：最佳分數取最大，贏過就一直是贏過，更新連輸次數與全域等級。不改動傳進來的物件。 */
export function recordResult(
  progress: Progress,
  id: string,
  score: number,
  outcome: Outcome,
): Progress {
  const before = progress.cards[id];
  const record: CardRecord = {
    best: Math.max(before?.best ?? Number.NEGATIVE_INFINITY, score),
    won: before?.won === true || outcome === 'win',
  };
  const next: Progress = {
    ...progress,
    cards: { ...progress.cards, [id]: record },
    lossStreak: outcome === 'loss' ? progress.lossStreak + 1 : 0,
  };
  return { ...next, globalLevel: currentGlobalLevel(next) };
}

/** 改設定：只給要改的欄位，其餘保留。 */
export function withSettings(progress: Progress, settings: Partial<Settings>): Progress {
  return { ...progress, settings: { ...progress.settings, ...settings } };
}
