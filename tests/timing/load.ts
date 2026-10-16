import { cpus, loadavg } from 'node:os';

/**
 * 機器當下的負載，只用來讓失敗訊息更清楚（區分「真的慢」與「機器忙」）。
 * 絕不可以用它來跳過或放寬任何斷言：timing project 就是設計成序列、獨佔機器地跑，
 * 這裡印出來的 loadavg 若遠高於 1，代表有別的東西（別的 agent、另一個 vitest）同時在跑，
 * 該重跑而不是改門檻。
 */
export function loadNote(): string {
  const [one = 0, five = 0] = loadavg();
  return `量測當下 loadavg 1 分鐘 ${one.toFixed(2)}、5 分鐘 ${five.toFixed(2)}，${cpus().length} 核；timing project 應該獨佔機器，loadavg 遠高於 1 就是別人在跑，請等機器空下來重跑，不要放寬門檻`;
}

/** 失敗時把負載附在訊息後面（原本的訊息與例外型別的判讀不變），過關時什麼都不做。 */
export function withLoadNote<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(`${text}\n（${loadNote()}）`, { cause: error });
  }
}
