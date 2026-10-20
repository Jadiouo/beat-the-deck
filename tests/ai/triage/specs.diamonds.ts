import type { Side } from '../../../src/core/types';
import { graft, setAt } from './engine';
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

// ---------------------------------------------------------------------------
// 目標牌：D-2、D-3、D-4、D-7、D-8、D-J、D-Q
// ---------------------------------------------------------------------------

const other = (side: Side): Side => (side === 0 ? 1 : 0);

// D-2 背包上限：每邊背包裡的金幣數 bags[side]（0 到 3）。
interface BagWorld extends CoinWorld {
  readonly bags: readonly number[];
}
const bagLegal = (s: BagWorld, _ai: Side): string | null => {
  const base = walkersLegal(s, s.coins);
  if (base !== null) {
    return base;
  }
  if (s.bags.some((n) => !Number.isInteger(n) || n < 0 || n > 3)) {
    return '背包數無效';
  }
  return null;
};
const bagTeeth = <W extends BagWorld>(s: W, ai: Side): readonly { name: string; state: W }[] => [
  ...walkerTeeth(s, ai),
  { name: '背包數無效', state: setAt(s, `bags.${other(ai)}`, 9) },
];

export const D_2: CardSpec = defineSpec<BagWorld>('D-2', {
  comp: sideOf('players', 'bags'),
  legal: bagLegal,
  teeth: bagTeeth,
  farDonors: true,
});

// D-J 小偷：D-2 加偷竊倒數 lurk 與累計偷到的分數 stolen。
interface ThiefWorld extends BagWorld {
  readonly lurk: readonly number[];
  readonly stolen: readonly number[];
}
export const D_J: CardSpec = defineSpec<ThiefWorld>('D-J', {
  comp: sideOf('players', 'bags', 'lurk', 'stolen'),
  legal: (s: ThiefWorld, ai: Side) => {
    const base = bagLegal(s, ai);
    if (base !== null) {
      return base;
    }
    if (s.lurk.some((n) => !Number.isInteger(n) || n < 0 || n > 60)) {
      return '偷竊倒數無效';
    }
    return null;
  },
  teeth: (s: ThiefWorld, ai: Side) => [
    ...bagTeeth(s, ai),
    { name: '偷竊倒數無效', state: setAt(s, `lurk.${other(ai)}`, 999) },
  ],
  farDonors: true,
});

// D-3 會貶值的寶石：寶石的出生 tick 不能在未來、也不能超過壽命 600。
interface GemWorld extends WalkWorld {
  readonly tick: number;
  readonly gems: readonly { readonly cell: number; readonly born: number }[];
}
export const D_3: CardSpec = defineSpec<GemWorld>('D-3', {
  comp: sideOf('players'),
  legal: (s: GemWorld, _ai: Side) => {
    const base = walkersLegal(
      s,
      s.gems.map((g) => g.cell),
    );
    if (base !== null) {
      return base;
    }
    if (s.gems.some((g) => g.born > s.tick || s.tick - g.born > 600)) {
      return '寶石的年齡無效';
    }
    return null;
  },
  teeth: (s: GemWorld, ai: Side) => [
    ...walkerTeeth(s, ai),
    {
      name: '寶石壓在人腳下',
      state: setAt(s, 'gems.0.cell', (s.players[other(ai)] as Walker).cell),
    },
  ],
  farDonors: true,
});

// D-Q 唯一的礦：身上還沒走出礦坑的礦石 carried、累計作廢 lost。礦、下一個礦、開挖次數是共用的。
interface MineWorld extends WalkWorld {
  readonly carried: readonly number[];
  readonly lost: readonly number[];
}
export const D_Q: CardSpec = defineSpec<MineWorld>('D-Q', {
  comp: sideOf('players', 'carried', 'lost'),
  legal: (s: MineWorld, _ai: Side) => {
    const base = walkersLegal(s);
    if (base !== null) {
      return base;
    }
    if (s.carried.some((n) => !Number.isInteger(n) || n < 0) || s.lost.some((n) => n < 0)) {
      return '礦石數無效';
    }
    return null;
  },
  teeth: (s: MineWorld, ai: Side) => [
    ...walkerTeeth(s, ai),
    { name: '礦石數無效', state: setAt(s, `carried.${other(ai)}`, -4) },
  ],
  farDonors: true,
});

// D-4 電池：4 個充電站，一次只有一個人能占；holder[i] 是占著第 i 個站的人（−1 沒人）。
// holder 是兩邊混在一起的共用陣列：換掉對手的元件時，只改動 holder 裡「屬於對手」的格子。
interface BatteryWorld extends WalkWorld {
  readonly coins: readonly number[];
  readonly battery: readonly number[];
  readonly stations: readonly number[];
  readonly holder: readonly number[];
  readonly trickle: readonly number[];
  readonly stuck: readonly number[];
}
const batteryComp = sideOf('players', 'battery', 'trickle', 'stuck');
export const D_4: CardSpec = defineSpec<BatteryWorld>('D-4', {
  comp: batteryComp,
  mixed: ['holder'],
  mixedOk: (before: BatteryWorld, after: BatteryWorld, preserved: Side) =>
    before.holder.every((h, i) => (h === preserved) === (after.holder[i] === preserved)),
  graftSide: (q: BatteryWorld, d: BatteryWorld, _ai: Side, side: Side) => {
    const grafted = graft(q, d, batteryComp(side));
    if (grafted === null) {
      return null;
    }
    const holder = q.holder.slice();
    for (let i = 0; i < holder.length; i += 1) {
      const theirs = d.holder[i];
      if (theirs === side) {
        if (q.holder[i] === other(side)) {
          return null;
        }
        holder[i] = side;
      } else if (q.holder[i] === side) {
        holder[i] = -1;
      }
    }
    return setAt(grafted, 'holder', holder);
  },
  legal: (s: BatteryWorld, _ai: Side) => {
    const base = walkersLegal(s, s.coins);
    if (base !== null) {
      return base;
    }
    if (s.battery.some((n) => !Number.isInteger(n) || n < 0 || n > 40)) {
      return '電量無效';
    }
    for (let i = 0; i < s.holder.length; i += 1) {
      const h = s.holder[i] as number;
      if (![-1, 0, 1].includes(h)) {
        return 'holder 無效';
      }
      if (h !== -1 && (s.players[h] as Walker).cell !== s.stations[i]) {
        return '占著站的人不在站上';
      }
    }
    return null;
  },
  teeth: (s: BatteryWorld, ai: Side) => [
    ...walkerTeeth(s, ai),
    { name: '電量無效', state: setAt(s, `battery.${other(ai)}`, 99) },
    {
      name: '占著站的人不在站上',
      state: setAt(
        setAt(s, 'holder.0', other(ai)),
        `players.${other(ai)}.cell`,
        s.stations[0] === (s.players[other(ai)] as Walker).cell
          ? s.stations[1]
          : (s.stations[1] as number),
      ),
    },
  ],
  farDonors: true,
});

// D-7 挖礦：岩石／礦藏／誰鑿穿的都是共用地圖；對手的元件只有人、背包、累計數。
interface DigWorld extends WalkWorld {
  readonly rock: readonly number[];
  readonly bag: readonly (readonly number[])[];
}
export const D_7: CardSpec = defineSpec<DigWorld>('D-7', {
  comp: sideOf('players', 'bag', 'dug', 'rode'),
  legal: (s: DigWorld, _ai: Side) => {
    const base = walkersLegal(s);
    if (base !== null) {
      return base;
    }
    if (s.players.some((p) => (s.rock[p.cell] as number) > 0)) {
      return '人站在岩石裡';
    }
    if (s.bag.some((b) => b.length > 4 || b.some((v) => !(v >= 1 && v <= 10)))) {
      return '背包無效';
    }
    return null;
  },
  teeth: (s: DigWorld, ai: Side) => {
    const rocky = s.rock.findIndex((hp) => hp > 0);
    return [
      ...walkerTeeth(s, ai),
      { name: '人站在岩石裡', state: setAt(s, `players.${other(ai)}.cell`, rocky) },
      { name: '背包無效', state: setAt(s, `bag.${other(ai)}`, [1, 1, 1, 1, 1]) },
    ];
  },
  farDonors: true,
});

// D-8 塗地：paint（每格的顏色 0／1／2）與 stamp（最後換色的 tick）是兩邊混在一起的共用格子；
// 每個人的分數＝他的顏色格子數（規則保證）。換掉對手的元件時：我的顏色格子與時間戳原封不動，
// 其餘格子照捐贈者的對手顏色重畫（捐贈者那邊屬於我的格子在這裡留白），對手的分數隨之重算。
interface PaintWorld extends WalkWorld {
  readonly paint: readonly number[];
  readonly stamp: readonly number[];
  readonly heading: readonly number[];
}
const LONG_AGO = -1_000_000;
const paintComp = sideOf('players', 'heading');
const countOf = (paint: readonly number[], colour: number): number =>
  paint.reduce((n, p) => n + (p === colour ? 1 : 0), 0);
export const D_8: CardSpec = defineSpec<PaintWorld>('D-8', {
  comp: paintComp,
  mixed: ['paint', 'stamp'],
  mixedOk: (before: PaintWorld, after: PaintWorld, preserved: Side) =>
    before.paint.every(
      (p, c) =>
        (p === preserved + 1) === (after.paint[c] === preserved + 1) &&
        (p !== preserved + 1 || before.stamp[c] === after.stamp[c]),
    ),
  graftSide: (q: PaintWorld, d: PaintWorld, _ai: Side, side: Side) => {
    const colour = side + 1;
    const grafted = graft(q, d, paintComp(side));
    if (grafted === null) {
      return null;
    }
    const paint = q.paint.slice();
    const stamp = q.stamp.slice();
    for (let c = 0; c < paint.length; c += 1) {
      if (q.paint[c] === other(side) + 1) {
        continue;
      }
      if (d.paint[c] === colour) {
        paint[c] = colour;
        stamp[c] = d.stamp[c] as number;
      } else {
        paint[c] = 0;
        stamp[c] = LONG_AGO;
      }
    }
    const score = countOf(paint, colour);
    return setAt(
      setAt(setAt(grafted, 'paint', paint), 'stamp', stamp),
      `players.${side}.score`,
      score,
    );
  },
  legal: (s: PaintWorld, _ai: Side) => {
    const base = walkersLegal(s);
    if (base !== null) {
      return base;
    }
    if (s.paint.length !== CELLS || s.stamp.length !== CELLS) {
      return '格子表長度不對';
    }
    if (s.paint.some((p) => ![0, 1, 2].includes(p))) {
      return '顏色無效';
    }
    for (const side of [0, 1] as const) {
      if ((s.players[side] as Walker).score !== countOf(s.paint, side + 1)) {
        return '分數與顏色格子數不一致';
      }
    }
    if (s.heading.some((h) => !Number.isInteger(h) || h < -1 || h > 3)) {
      return '方向無效';
    }
    return null;
  },
  teeth: (s: PaintWorld, ai: Side) => [
    ...walkerTeeth(s, ai),
    { name: '分數與顏色格子數不一致', state: setAt(s, `players.${other(ai)}.score`, 9999) },
    { name: '顏色無效', state: setAt(s, 'paint.5', 7) },
  ],
  farDonors: true,
});

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

// D-6 市場：對手的現金、存貨與歷史和共用的價格偏移（dev）以及自己的現金不可分
// （過去每一筆買賣都留下價格偏移，兩邊的現金是在那些價格下成交的）。把它們換掉，就得連價格偏移與自己的現金
// 一起重算，那就不是「只動對手」。所以乾淨模式只能換對手「這回合鎖定的動作」（pending，AI 的 evaluate 明文不讀）；
// 糾纏的欄位只在放寬模式換，只為了讓對照組證明方法「看得見 AI 讀對手的歷史」，那不是合法可達的局面。
interface MarketWorld {
  readonly round: number;
  readonly phase: string;
  readonly cash: readonly number[];
  readonly inv: readonly (readonly number[])[];
  readonly pending: readonly (number | null)[];
  readonly history: readonly (readonly number[])[];
  readonly last: { readonly trades: readonly number[]; readonly delta: readonly number[] } | null;
}

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
  { name: '現金為負', state: setAt(s, `cash.${other(ai)}`, -3) },
  { name: '鎖定的動作無效', state: setAt(s, `pending.${other(ai)}`, 9) },
];

export const D_6: CardSpec = defineSpec<MarketWorld>('D-6', {
  comp: sideOf('pending'),
  farDonors: true,
  sample: { every: 12, decisionsOnly: true },
  entangled: (side: Side, s?: MarketWorld) => {
    const paths = [`cash.${side}`, `inv.${side}`];
    if (s !== undefined) {
      for (let i = 0; i < s.history.length; i += 1) {
        paths.push(`history.${i}.${side}`);
      }
      if (s.last !== null) {
        paths.push(`last.trades.${side}`, `last.delta.${side}`);
      }
    }
    return paths;
  },
  legal: marketLegal,
  teeth: marketTeeth,
  donorOk: (q: MarketWorld, d: MarketWorld) => q.round === d.round && q.phase === d.phase,
  donorOkRelaxed: (q: MarketWorld, d: MarketWorld) => q.history.length === d.history.length,
  notScreenable:
    '對手的現金、存貨與歷史和共用的價格偏移（dev）以及自己的現金不可分；乾淨模式只剩 pending（AI 明文不讀）',
});

export const CONTROL_DIAMONDS: readonly CardSpec[] = [D_5, D_10, D_6];

export const DIAMONDS_SPECS: readonly CardSpec[] = [D_A, D_2, D_3, D_4, D_7, D_8, D_J, D_Q];
