import type { Side } from '../../../src/core/types';
import { setAt } from './engine';
import type { CardSpec } from './engine';
import { CELLS, defineSpec, isCell, sideOf } from './specs.shared';

/**
 * 方塊（走格子撿東西）。對手的元件是 `players[o]`（cell、pending、score）加各牌自己的每邊欄位。
 * 共通的合法性：格子在地圖內、不在牆上、待走方向在 −1..3、撿得到的東西（金幣等）不壓在人腳下（走到就撿走了）。
 */

export interface Walker {
  readonly cell: number;
  readonly pending: number;
  readonly score: number;
}

export interface WalkWorld {
  readonly walls: readonly number[];
  readonly players: readonly Walker[];
  readonly over: boolean;
}

export function walkersLegal(world: WalkWorld, pickups: readonly number[] = []): string | null {
  if (world.walls.length !== CELLS) {
    return '牆的長度不對';
  }
  for (const p of world.players) {
    if (!isCell(p.cell)) {
      return '角色出界';
    }
    if (world.walls[p.cell] !== 0) {
      return '角色站在牆上';
    }
    if (!Number.isInteger(p.pending) || p.pending < -1 || p.pending > 3) {
      return '待走方向無效';
    }
    if (!Number.isInteger(p.score)) {
      return '分數不是整數';
    }
  }
  const seen = new Set<number>();
  for (const c of pickups) {
    if (!isCell(c)) {
      return '撿取物出界';
    }
    if (world.walls[c] !== 0) {
      return '撿取物在牆上';
    }
    if (seen.has(c)) {
      return '撿取物重複';
    }
    seen.add(c);
    if (world.players.some((p) => p.cell === c)) {
      return '撿取物壓在角色腳下';
    }
  }
  return null;
}

interface CoinWorld extends WalkWorld {
  readonly coins: readonly number[];
}

/** 走格子的破壞版本：對手站在牆上、出界、待走方向無效。 */
export function walkerTeeth<W extends WalkWorld>(
  s: W,
  ai: Side,
): readonly { name: string; state: W }[] {
  const o = ai === 0 ? 1 : 0;
  const wall = s.walls.indexOf(1);
  const out: { name: string; state: W }[] = [
    { name: '出界', state: setAt(s, `players.${o}.cell`, CELLS + 5) },
    { name: '待走方向無效', state: setAt(s, `players.${o}.pending`, 9) },
  ];
  if (wall >= 0) {
    out.push({ name: '站在牆上', state: setAt(s, `players.${o}.cell`, wall) });
  }
  return out;
}

export const D_A: CardSpec = defineSpec<CoinWorld>('D-A', {
  comp: sideOf('players'),
  legal: (s: CoinWorld, _ai: Side) => walkersLegal(s, s.coins),
  teeth: (s: CoinWorld, ai: Side) => [
    ...walkerTeeth(s, ai),
    {
      name: '金幣壓在人腳下',
      state: setAt(s, 'coins.0', (s.players[ai === 0 ? 1 : 0] as Walker).cell),
    },
  ],
  farDonors: true,
});

export const DIAMONDS_SPECS: readonly CardSpec[] = [D_A];

// ---------------------------------------------------------------------------
// 對照組：D-5、D-10（有互動）與 D-6（市場，見下）
// ---------------------------------------------------------------------------

interface ParcelWorld extends WalkWorld {
  readonly parcels: readonly { readonly cell: number; readonly colour: number }[];
  readonly carry: readonly ({ readonly colour: number; readonly worth: number } | null)[];
  readonly delivered: readonly number[];
  readonly waited: readonly number[];
}

export const D_5: CardSpec = defineSpec<ParcelWorld>('D-5', {
  comp: sideOf('players', 'carry', 'delivered', 'waited'),
  teeth: (s: ParcelWorld, ai: Side) => [
    ...walkerTeeth(s, ai),
    { name: '背的貨無效', state: setAt(s, `carry.${ai === 0 ? 1 : 0}`, { colour: 7, worth: 1 }) },
  ],
  legal: (s: ParcelWorld, _ai: Side) => {
    // 空手站上包裹會撿起來，所以只有背著貨的人才可能站在包裹上。
    const base = walkersLegal(
      s,
      s.parcels
        .map((p) => p.cell)
        .filter((c) => !s.players.some((pl, i) => pl.cell === c && s.carry[i] !== null)),
    );
    if (base !== null) {
      return base;
    }
    for (const c of s.carry) {
      if (c !== null && (![0, 1, 2].includes(c.colour) || !(c.worth >= 1))) {
        return '背的貨無效';
      }
    }
    if (s.delivered.some((n) => !Number.isInteger(n) || n < 0)) {
      return '送達數無效';
    }
    return null;
  },
  farDonors: true,
});

interface BeltWorld extends WalkWorld {
  readonly bag: readonly (readonly { readonly w: number; readonly v: number }[])[];
  readonly ship: readonly number[];
}

export const D_10: CardSpec = defineSpec<BeltWorld>('D-10', {
  comp: sideOf('players', 'bag', 'ship', 'taken', 'takenW', 'takenV', 'ships'),
  teeth: (s: BeltWorld, ai: Side) => [
    ...walkerTeeth(s, ai),
    { name: '出貨倒數無效', state: setAt(s, `ship.${ai === 0 ? 1 : 0}`, 999) },
  ],
  legal: (s: BeltWorld, _ai: Side) => {
    const base = walkersLegal(s);
    if (base !== null) {
      return base;
    }
    for (const bag of s.bag) {
      if (bag.length > 8) {
        return '背包超過上限';
      }
      if (bag.some((it) => !(it.w >= 1 && it.w <= 4 && it.v >= 1 && it.v <= 9))) {
        return '背包物品無效';
      }
    }
    if (s.ship.some((n) => !Number.isInteger(n) || n < 0 || n > 60)) {
      return '出貨倒數無效';
    }
    return null;
  },
  // 背包重量、出貨倒數與時鐘（出貨 60 tick）有關，只用同 tick 的捐贈者。
});

// D-6 市場：對手的現金／存貨／歷史與共用的價格偏移（dev）及自己的現金不可分
// （過去每一筆買賣都留下價格偏移，兩邊的現金是在那些價格下成交的）。把對手的歷史換掉，就得連價格偏移
// 與自己的現金一起重算，那就不是「只動對手」。所以正式的規格宣告無法乾淨篩檢；
// 另有一份 'D-6~relaxed' 只用在對照組：放寬這個一致性（標明不是合法可達的局面），
// 只為了證明方法在這張牌上「看得見 AI 讀對手的歷史」。
interface MarketWorld {
  readonly round: number;
  readonly phase: string;
  readonly cash: readonly number[];
  readonly inv: readonly (readonly number[])[];
  readonly pending: readonly (number | null)[];
  readonly history: readonly (readonly number[])[];
  readonly last: { readonly trades: readonly number[]; readonly delta: readonly number[] } | null;
}

const marketComp = (side: Side, s?: MarketWorld): readonly string[] => {
  const paths = [`cash.${side}`, `inv.${side}`, `pending.${side}`];
  if (s !== undefined) {
    for (let i = 0; i < s.history.length; i += 1) {
      paths.push(`history.${i}.${side}`);
    }
    if (s.last !== null) {
      paths.push(`last.trades.${side}`, `last.delta.${side}`);
    }
  }
  return paths;
};

const marketLegal = (s: MarketWorld, _ai: Side): string | null => {
  if (s.cash.some((c) => !Number.isInteger(c) || c < 0)) {
    return '現金無效';
  }
  if (s.inv.some((row) => row.some((n) => !Number.isInteger(n) || n < 0))) {
    return '存貨無效';
  }
  if (s.pending.some((p) => p !== null && !(Number.isInteger(p) && p >= 0 && p <= 6))) {
    return '鎖定的動作無效';
  }
  if (s.history.some((pair) => pair.some((t) => !(Number.isInteger(t) && t >= 0 && t <= 6)))) {
    return '歷史的動作無效';
  }
  return null;
};

const marketTeeth = (s: MarketWorld, ai: Side): readonly { name: string; state: MarketWorld }[] => [
  { name: '現金為負', state: setAt(s, `cash.${ai === 0 ? 1 : 0}`, -3) },
  { name: '鎖定的動作無效', state: setAt(s, `pending.${ai === 0 ? 1 : 0}`, 9) },
];

const marketDonorOk = (q: MarketWorld, d: MarketWorld): boolean =>
  q.round === d.round && q.phase === d.phase && q.history.length === d.history.length;

export const D_6: CardSpec = defineSpec<MarketWorld>('D-6', {
  comp: marketComp,
  legal: marketLegal,
  teeth: marketTeeth,
  donorOk: marketDonorOk,
  notScreenable:
    '對手的現金、存貨與歷史和共用的價格偏移（dev）以及自己的現金不可分；換掉就得連共用環境一起改',
});

export const D_6_RELAXED: CardSpec = defineSpec<MarketWorld>(
  'D-6',
  { comp: marketComp, legal: marketLegal, teeth: marketTeeth, donorOk: marketDonorOk },
  'D-6~relaxed',
);

export const CONTROL_DIAMONDS: readonly CardSpec[] = [D_5, D_10, D_6, D_6_RELAXED];
