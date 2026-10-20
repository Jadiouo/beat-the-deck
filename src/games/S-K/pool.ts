import type { Game } from '../../core/types';
import { s3Game } from '../S-3/logic';
import { s4Game } from '../S-4/logic';
import { s5Game } from '../S-5/logic';
import { s7Game } from '../S-7/logic';
import { s8Game } from '../S-8/logic';
import { s9Game } from '../S-9/logic';
import { sJGame } from '../S-J/logic';
import { sQGame } from '../S-Q/logic';

/**
 * S-K 的牌池（小規格 `docs/cards/S-K.md`「依賴哪幾張牌」）。加牌只改 `POOL` 的一行。
 * 這個檔案是純資料：被包的牌只被讀與呼叫，一個字都不改它們。
 */

export type Family = 'dodge' | 'duel' | 'role' | 'brick' | 'zone' | 'rally';

export interface PoolEntry {
  readonly id: string;
  /** 被包的牌的 Game（型別抹掉：state 只經由它自己的方法來回）。 */
  readonly game: Game<unknown>;
  /** 衝刺長度（tick）：傳給被包的牌的 `maxTicks`（步調小於 1 時按比例縮短）。 */
  readonly sprintTicks: number;
  /** 被包的牌能接受的最短 `maxTicks`（沒寫就是 1）。 */
  readonly minTicks?: number;
  /** 分數差的標度：`m = clamp(差 / scale, −1, 1)`。起始值是「人類模型對等級 5 精準型各 100 場、|分數差| 的第 80 百分位」。 */
  readonly scale: number;
  /** 家族：「針對你」看的是你在哪一類牌上輸得多。 */
  readonly family: Family;
  /** 變異（0 到 1）：挑這張牌的 `danger`。精準型的門檻是 0.3，所以 ≤ 0.3 是「穩」。 */
  readonly sigma: number;
  /** 「大贏機會」先驗：期望的 `0.1 × upside` 項，冷啟動時決定貪心型挑什麼。 */
  readonly upside: number;
  /** 傳給被包的牌的 `params`。 */
  readonly params?: Readonly<Record<string, number>>;
}

function erase<S>(game: Game<S>): Game<unknown> {
  return game as unknown as Game<unknown>;
}

/** 前 4 段的候選牌池。 */
export const POOL: readonly PoolEntry[] = [
  {
    id: 'S-3',
    game: erase(s3Game),
    sprintTicks: 660,
    scale: 7,
    family: 'dodge',
    sigma: 0.25,
    upside: 0.1,
  },
  {
    id: 'S-Q',
    game: erase(sQGame),
    sprintTicks: 660,
    scale: 7,
    family: 'dodge',
    sigma: 0.25,
    upside: 0.1,
  },
  {
    id: 'S-7',
    game: erase(s7Game),
    sprintTicks: 780,
    scale: 3,
    family: 'duel',
    sigma: 0.8,
    upside: 0.3,
  },
  {
    id: 'S-J',
    game: erase(sJGame),
    sprintTicks: 660,
    scale: 11,
    family: 'role',
    sigma: 0.5,
    upside: 0.2,
  },
  {
    id: 'S-4',
    game: erase(s4Game),
    sprintTicks: 720,
    minTicks: 600,
    scale: 10,
    family: 'brick',
    sigma: 0.4,
    upside: 0.1,
  },
  {
    id: 'S-8',
    game: erase(s8Game),
    sprintTicks: 720,
    minTicks: 600,
    scale: 61,
    family: 'zone',
    sigma: 0.4,
    upside: 0.1,
  },
  {
    id: 'S-9',
    game: erase(s9Game),
    sprintTicks: 720,
    minTicks: 600,
    scale: 2,
    family: 'zone',
    sigma: 0.6,
    upside: 0.2,
  },
];

/** 決勝段：固定是 S-5 乒乓（先得 3 分），權重 2；不進候選牌池。標度的最低值取 2（分數是整數，1 會讓任何領先都滿格）。 */
export const FINAL: PoolEntry = {
  id: 'S-5',
  game: erase(s5Game),
  sprintTicks: 1200,
  minTicks: 600,
  scale: 2,
  family: 'rally',
  sigma: 0.5,
  upside: 0,
  params: { target: 3 },
};

/** 用 id 找牌池項目（含決勝的 S-5）。找不到丟錯。 */
export function poolEntry(id: string): PoolEntry {
  if (id === FINAL.id) {
    return FINAL;
  }
  const found = POOL.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`S-K 的牌池裡沒有 ${id}`);
  }
  return found;
}

export type SigmaLabel = 'stable' | 'mid' | 'risky';

/** 畫面上的「穩／中／險」標記：≤ 0.3 穩、≤ 0.55 中、其餘險。 */
export function sigmaLabel(sigma: number): SigmaLabel {
  if (sigma <= 0.3) {
    return 'stable';
  }
  return sigma <= 0.55 ? 'mid' : 'risky';
}
