import type { Side } from '../../../src/core/types';
import { setAt } from './engine';
import type { CardSpec } from './engine';
import { defineSpec, sideOf } from './specs.shared';

/**
 * 紅心（回合制、隱藏資訊、歷史紀錄）。
 *
 * 每張牌把對手的欄位分成兩層：
 * - 乾淨層 `comp`：真的只屬於對手、換掉不影響共用環境的（它的私人累計、這回合鎖定的動作、隱藏的骰子／暗牌）；
 * - 糾纏層 `entangled`：公開的歷史、現金／籌碼／預算、分數——它們和共用的價格偏移、牌堆、勝負紀錄、
 *   雙方現金（零和）彼此約束，換掉對手那一邊就不再是「只動對手」。這一層只在放寬模式換（不保證跨欄位一致，
 *   只保證單一欄位自己有效），數字永遠與乾淨模式分開報。
 * AI 讀的如果是糾纏層，乾淨模式量不到，判定就是「無法乾淨篩檢」，附放寬模式的改變率當指標。
 */

const other = (side: Side): Side => (side === 0 ? 1 : 0);

/**
 * 回合制的牌決策點稀疏、各局的節奏因對局而異（同一個 tick 不同 run 常常在不同階段）：
 * 取樣更密、只留有決策可做的 tick，而且捐贈者不限同一個 tick（對手的元件不綁時鐘；跨欄位的時鐘約束由 legal 擋）。
 * 相容性（同一局、同一階段、同一手……）由各牌的 donorOk 保證。
 */
const TURN_BASED = { farDonors: true, sample: { every: 12, decisionsOnly: true } } as const;
const sumOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

// --- H-A 貪心骰 -------------------------------------------------------------
// 輪流擲骰累積，先到 50 贏。對手的元件是它的總分 totals[o] 與按鍵邊緣狀態 held[o]；這回合的累積 acc 屬於輪到的人。
interface GreedWorld {
  readonly turn: number;
  readonly phase: string;
  readonly finalTurn: boolean;
  readonly totals: readonly number[];
  readonly held: readonly { readonly a: boolean; readonly b: boolean }[];
}
export const H_A: CardSpec = defineSpec<GreedWorld>('H-A', {
  ...TURN_BASED,
  comp: sideOf('totals', 'held'),
  donorOk: (q: GreedWorld, d: GreedWorld) =>
    q.turn === d.turn && q.phase === d.phase && q.finalTurn === d.finalTurn,
  legal: (s: GreedWorld, _ai: Side) => {
    if (s.totals.some((n) => !Number.isInteger(n) || n < 0)) {
      return '總分無效';
    }
    // 人（0 號邊）先動：人到 50 之後 AI 打最後一個回合；AI 到 50 局就結束。
    if ((s.totals[0] as number) >= 50 !== s.finalTurn) {
      return '總分與 finalTurn 不一致';
    }
    if ((s.totals[1] as number) >= 50) {
      return 'AI 已到 50 但局沒結束';
    }
    return null;
  },
  teeth: (s: GreedWorld, ai: Side) => [
    { name: '總分無效', state: setAt(s, `totals.${other(ai)}`, -5) },
    { name: 'AI 已到 50 但局沒結束', state: setAt(s, 'totals.1', 60) },
  ],
  // 特殊狀態：對手剛起步／逼近終點（可達但罕見：一回合內連擲很多次沒爆）。
  special: (s: GreedWorld, ai: Side) => {
    const o = other(ai);
    return o === 1
      ? [0, 25, 45].map((v) => ({ name: `opp-total-${v}`, state: setAt(s, `totals.${o}`, v) }))
      : [0, 25].map((v) => ({ name: `opp-total-${v}`, state: setAt(s, `totals.${o}`, v) }));
  },
});

// --- H-2 引信 ---------------------------------------------------------------
interface FuseWorld {
  readonly round: number;
  readonly phase: string;
  readonly revealed: boolean;
  readonly roundTick: number;
  readonly fuse: number;
  readonly players: readonly { readonly status: string; readonly acc: number }[];
  readonly totals: readonly number[];
  readonly roundScores: readonly (readonly number[])[];
}
export const H_2: CardSpec = defineSpec<FuseWorld>('H-2', {
  ...TURN_BASED,
  comp: sideOf('players', 'totals', 'roundScores'),
  donorOk: (q: FuseWorld, d: FuseWorld) =>
    q.round === d.round && q.phase === d.phase && q.revealed === d.revealed,
  legal: (s: FuseWorld, _ai: Side) => {
    for (const side of [0, 1] as const) {
      const p = s.players[side] as { status: string; acc: number };
      if (!['idle', 'holding', 'banked', 'boom', 'late'].includes(p.status)) {
        return '狀態無效';
      }
      if (p.status === 'holding' && !(p.acc >= 1 && p.acc < s.fuse && p.acc <= s.roundTick)) {
        return '按住的累積不合理';
      }
      if (p.status === 'idle' && (p.acc !== 0 || s.roundTick >= 60)) {
        return '還沒按卻超過起手時限';
      }
      if (p.status === 'banked' && !(p.acc >= 1 && p.acc <= s.roundTick)) {
        return '入袋的分數不合理';
      }
      if (['boom', 'late'].includes(p.status) && p.acc !== 0) {
        return '爆炸或太晚的累積不是 0';
      }
      const scores = s.roundScores[side] as readonly number[];
      const banked = p.status === 'banked' && !s.revealed ? p.acc : 0;
      if (s.totals[side] !== sumOf(scores) + banked) {
        return '總分與各局得分不一致';
      }
    }
    return null;
  },
  teeth: (s: FuseWorld, ai: Side) => [
    { name: '狀態無效', state: setAt(s, `players.${other(ai)}.status`, 'zzz') },
    {
      name: '按住的累積不合理',
      state: setAt(s, `players.${other(ai)}`, { status: 'holding', acc: s.fuse + 5 }),
    },
    { name: '總分與各局得分不一致', state: setAt(s, `totals.${other(ai)}`, 12345) },
  ],
});

// --- H-3 懸崖 ---------------------------------------------------------------
interface CliffWorld {
  readonly round: number;
  readonly phase: string;
  readonly roundTick: number;
  readonly v0: number;
  readonly runners: readonly {
    readonly status: string;
    readonly pos: number;
    readonly speed: number;
    readonly age: number;
  }[];
  readonly totals: readonly number[];
  readonly roundScores: readonly (readonly number[])[];
}
export const H_3: CardSpec = defineSpec<CliffWorld>('H-3', {
  ...TURN_BASED,
  comp: sideOf('runners', 'totals', 'roundScores'),
  donorOk: (q: CliffWorld, d: CliffWorld) => q.round === d.round && q.phase === d.phase,
  legal: (s: CliffWorld, _ai: Side) => {
    for (const side of [0, 1] as const) {
      const r = s.runners[side] as { status: string; pos: number; speed: number; age: number };
      if (!['running', 'braking', 'stopped', 'fallen'].includes(r.status)) {
        return '狀態無效';
      }
      if (r.age > s.roundTick || r.age < 0) {
        return '年齡超過這一局的 tick 數';
      }
      if (r.status === 'running' && r.speed !== s.v0 + 100 * Math.floor(r.age / 30)) {
        return '跑步中的速度與年齡不一致';
      }
      if (r.status !== 'fallen' && r.pos > 300000) {
        return '沒掉下去卻超過跑道';
      }
      if (r.status === 'fallen' && r.pos <= 300000) {
        return '掉下去卻在跑道內';
      }
      if (r.status === 'stopped' && r.speed !== 0) {
        return '停下來的速度不是 0';
      }
      if ((s.totals[side] as number) < sumOf(s.roundScores[side] as readonly number[])) {
        return '總分少於各局得分';
      }
    }
    return null;
  },
  teeth: (s: CliffWorld, ai: Side) => [
    { name: '狀態無效', state: setAt(s, `runners.${other(ai)}.status`, 'zzz') },
    {
      name: '年齡超過這一局的 tick 數',
      state: setAt(s, `runners.${other(ai)}.age`, s.roundTick + 99),
    },
    { name: '總分少於各局得分', state: setAt(s, `totals.${other(ai)}`, -1) },
  ],
});

// --- H-4 比大小 -------------------------------------------------------------
// 對手的總分與「這邊看過桌上牌嗎」是乾淨的；公開紀錄 history 裡屬於對手的那幾筆（猜法、對錯、連對數、蓋牌點數）
// 和共用牌堆（counts）、雙方回合順序糾纏。
interface HiLoWorld {
  readonly turn: number;
  readonly phase: string;
  readonly totals: readonly number[];
  readonly tableSeen: readonly boolean[];
  readonly history: readonly { readonly side: number }[];
}
export const H_4: CardSpec = defineSpec<HiLoWorld>('H-4', {
  ...TURN_BASED,
  comp: sideOf('totals', 'tableSeen'),
  entangled: (side: Side, s?: HiLoWorld) => {
    const paths: string[] = [];
    s?.history.forEach((h, i) => {
      if (h.side === side) {
        paths.push(`history.${i}.act`, `history.${i}.ok`, `history.${i}.c`, `history.${i}.card`);
      }
    });
    return paths;
  },
  donorOk: (q: HiLoWorld, d: HiLoWorld) => q.turn === d.turn && q.phase === d.phase,
  donorOkRelaxed: (q: HiLoWorld, d: HiLoWorld) =>
    q.history.length === d.history.length &&
    q.history.every((h, i) => h.side === (d.history[i] as { side: number }).side),
  legal: (s: HiLoWorld, _ai: Side) => {
    if (s.totals.some((n) => !Number.isInteger(n) || n >= 15)) {
      return '總分無效';
    }
    return null;
  },
  teeth: (s: HiLoWorld, ai: Side) => [
    { name: '總分無效', state: setAt(s, `totals.${other(ai)}`, 1.5) },
    { name: '總分無效', state: setAt(s, `totals.${other(ai)}`, 99) },
  ],
});

// --- H-5 二十一點 -----------------------------------------------------------
// 乾淨：對手的比分 scores[o]、它最近幾手攤牌後的紀錄 past[o]（AI 用來估它的停牌門檻 θ）。
// 糾纏：它的暗牌／明牌（和共用牌堆 pool 守恆）、停牌／選擇／這輪領到的牌（和 log、incoming 耦合）。
// 另有兩個「守恆同步」的特殊擾動：把對手的暗牌或第一張明牌換成牌堆裡另一個點數，牌堆對應地調整
// （共用環境只動到守恆所要求的最小量），標成 special。
interface BlackjackWorld {
  readonly pool: readonly number[];
  readonly hole: readonly number[];
  readonly up: readonly (readonly number[])[];
  readonly incoming: readonly (number | null)[];
  readonly scores: readonly number[];
  readonly past: readonly (readonly { readonly total: number; readonly move: number }[])[];
  readonly phase: string;
  readonly hand: number;
  readonly round: number;
  readonly stood: readonly boolean[];
}
export const H_5: CardSpec = defineSpec<BlackjackWorld>('H-5', {
  ...TURN_BASED,
  comp: sideOf('scores', 'past'),
  entangled: (side: Side, s?: BlackjackWorld) => {
    const paths = [
      `hole.${side}`,
      `up.${side}`,
      `stood.${side}`,
      `pending.${side}`,
      `incoming.${side}`,
    ];
    if (s !== undefined) {
      paths.push(`log.${0}.${side}`);
    }
    return paths.filter((p) => !p.startsWith('log.'));
  },
  donorOk: (q: BlackjackWorld, d: BlackjackWorld) =>
    q.hand === d.hand &&
    q.past.every((p, i) => p.length === (d.past[i] as readonly unknown[]).length),
  donorOkRelaxed: (q: BlackjackWorld, d: BlackjackWorld) =>
    q.round === d.round && q.phase === d.phase,
  legal: (s: BlackjackWorld, _ai: Side) => {
    if (s.scores.some((n) => !Number.isInteger(n))) {
      return '比分無效';
    }
    if (s.hole.some((c) => !(Number.isInteger(c) && c >= 1 && c <= 10))) {
      return '暗牌無效';
    }
    if (s.up.some((u) => u.length < 1 || u.length > 3 || u.some((c) => !(c >= 1 && c <= 10)))) {
      return '明牌無效';
    }
    const left = Array.from({ length: 10 }, () => 4);
    for (const c of [...s.hole, ...s.up[0]!, ...s.up[1]!]) {
      left[c - 1] = (left[c - 1] as number) - 1;
    }
    if (s.pool.some((n, i) => n !== left[i])) {
      return '牌堆與已發出的牌不守恆';
    }
    return null;
  },
  special: (s: BlackjackWorld, ai: Side) => {
    const o = other(ai);
    const out: { name: string; state: BlackjackWorld }[] = [];
    const swapTo = (
      oldCard: number,
      newCard: number,
      set: (st: BlackjackWorld) => BlackjackWorld,
    ) => {
      if (newCard === oldCard) {
        return null;
      }
      const incomingRanks = s.incoming.filter((c): c is number => c !== null);
      const reserved = incomingRanks.filter((c) => c === newCard).length;
      if ((s.pool[newCard - 1] as number) - reserved < 1) {
        return null;
      }
      const pool = s.pool.slice();
      pool[oldCard - 1] = (pool[oldCard - 1] as number) + 1;
      pool[newCard - 1] = (pool[newCard - 1] as number) - 1;
      return setAt(set(s), 'pool', pool);
    };
    for (const newCard of [1, 6, 10]) {
      const hole = swapTo(s.hole[o] as number, newCard, (st) => setAt(st, `hole.${o}`, newCard));
      if (hole !== null) {
        out.push({ name: `opp-hole-${newCard}`, state: hole });
      }
      const first = (s.up[o] as readonly number[])[0] as number;
      const up = swapTo(first, newCard, (st) => setAt(st, `up.${o}.0`, newCard));
      if (up !== null) {
        out.push({ name: `opp-up-${newCard}`, state: up });
      }
    }
    return out;
  },
  teeth: (s: BlackjackWorld, ai: Side) => [
    { name: '暗牌無效', state: setAt(s, `hole.${other(ai)}`, 99) },
    {
      name: '牌堆與已發出的牌不守恆',
      state: setAt(
        s,
        'pool',
        s.pool.map((n) => n + 1),
      ),
    },
    { name: '比分無效', state: setAt(s, `scores.${other(ai)}`, 1.5) },
  ],
});

// --- H-6 地雷區 -------------------------------------------------------------
// 乾淨：對手手上沒存的分 carry、總分 totals、這回合鎖定的動作 pending（AI 明文不讀）。
// 糾纏：它在第幾排 row、每排「它到過沒」claimed（和公開格子 known 耦合）、歷史動作類型 history（和勝負耦合）。
interface MineWorld {
  readonly round: number;
  readonly phase: string;
  readonly carry: readonly number[];
  readonly totals: readonly number[];
  readonly pending: readonly (number | null)[];
  readonly row: readonly number[];
  readonly history: readonly unknown[];
}
export const H_6: CardSpec = defineSpec<MineWorld>('H-6', {
  ...TURN_BASED,
  comp: sideOf('carry', 'totals', 'pending'),
  entangled: (side: Side, s?: MineWorld) => {
    const paths = [`row.${side}`];
    for (let r = 0; r < 6; r += 1) {
      paths.push(`claimed.${r}.${side}`);
    }
    s?.history.forEach((_h, i) => paths.push(`history.${i}.${side}`));
    return paths;
  },
  donorOk: (q: MineWorld, d: MineWorld) => q.round === d.round && q.phase === d.phase,
  donorOkRelaxed: (q: MineWorld, d: MineWorld) => q.history.length === d.history.length,
  legal: (s: MineWorld, _ai: Side) => {
    if (
      s.carry.some((n) => !Number.isInteger(n) || n < 0) ||
      s.totals.some((n) => !Number.isInteger(n))
    ) {
      return '分數無效';
    }
    if (s.row.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) {
      return '排數無效';
    }
    if (s.pending.some((p) => p !== null && !(Number.isInteger(p) && p >= 0 && p <= 5))) {
      return '鎖定的動作無效';
    }
    return null;
  },
  teeth: (s: MineWorld, ai: Side) => [
    { name: '分數無效', state: setAt(s, `carry.${other(ai)}`, -3) },
    { name: '鎖定的動作無效', state: setAt(s, `pending.${other(ai)}`, 9) },
  ],
});

// --- H-9 吹牛骰 -------------------------------------------------------------
// 乾淨：對手藏著的骰子 dice[o]（AI 明文不讀）。糾纏：它的勝場（和 past 的勝負耦合）、它這回合的喊價
// （和 S 單調上升耦合）、已結束回合裡它的骰子與喊價（公開紀錄）。
interface LiarWorld {
  readonly round: number;
  readonly phase: string;
  readonly first: number;
  readonly turn: number;
  readonly dice: readonly (readonly number[])[];
  readonly bids: readonly { readonly side: number; readonly S: number }[];
  readonly past: readonly { readonly bids: readonly { readonly side: number }[] }[];
}
export const H_9: CardSpec = defineSpec<LiarWorld>('H-9', {
  ...TURN_BASED,
  comp: (side: Side) => [`dice.${side}`],
  entangled: (side: Side, s?: LiarWorld) => {
    const paths = [`wins.${side}`];
    s?.bids.forEach((b, i) => {
      if (b.side === side) {
        paths.push(`bids.${i}.S`);
      }
    });
    s?.past.forEach((p, i) => {
      paths.push(`past.${i}.dice.${side}`);
      p.bids.forEach((b, j) => {
        if (b.side === side) {
          paths.push(`past.${i}.bids.${j}.S`);
        }
      });
    });
    return paths;
  },
  donorOkRelaxed: (q: LiarWorld, d: LiarWorld) =>
    q.round === d.round &&
    q.phase === d.phase &&
    q.first === d.first &&
    q.turn === d.turn &&
    q.bids.length === d.bids.length &&
    q.past.length === d.past.length &&
    q.bids.every((b, i) => b.side === (d.bids[i] as { side: number }).side) &&
    q.past.every(
      (p, i) =>
        p.bids.length === (d.past[i] as { bids: readonly unknown[] }).bids.length &&
        p.bids.every(
          (b, j) => b.side === (d.past[i] as { bids: readonly { side: number }[] }).bids[j]?.side,
        ),
    ),
  legal: (s: LiarWorld, _ai: Side) => {
    if (
      s.dice.some(
        (pair) => pair.length !== 2 || pair.some((v) => !(Number.isInteger(v) && v >= 1 && v <= 6)),
      )
    ) {
      return '骰子無效';
    }
    if (s.bids.some((b) => !(Number.isInteger(b.S) && b.S >= 4 && b.S <= 24))) {
      return '喊價無效';
    }
    return null;
  },
  teeth: (s: LiarWorld, ai: Side) => [
    { name: '骰子無效', state: setAt(s, `dice.${other(ai)}`, [9, 9]) },
    { name: '骰子無效', state: setAt(s, `dice.${other(ai)}`, [3]) },
  ],
});

// --- H-10 暗標 --------------------------------------------------------------
// 乾淨：對手這件鎖定的檔位 pending（AI 明文不讀）。糾纏：預算、已入帳價值（和勝負紀錄耦合）、
// 已入帳每一件的檔位與出價（和預算耦合）。
interface AuctionWorld {
  readonly item: number;
  readonly phase: string;
  readonly pending: readonly (number | null)[];
  readonly budget: readonly number[];
  readonly got: readonly number[];
  readonly history: readonly unknown[];
}
export const H_10: CardSpec = defineSpec<AuctionWorld>('H-10', {
  ...TURN_BASED,
  comp: sideOf('pending'),
  entangled: (side: Side, s?: AuctionWorld) => {
    const paths = [`budget.${side}`, `got.${side}`];
    s?.history.forEach((_h, i) =>
      paths.push(`history.${i}.levels.${side}`, `history.${i}.bids.${side}`),
    );
    return paths;
  },
  donorOk: (q: AuctionWorld, d: AuctionWorld) => q.item === d.item && q.phase === d.phase,
  donorOkRelaxed: (q: AuctionWorld, d: AuctionWorld) => q.history.length === d.history.length,
  legal: (s: AuctionWorld, _ai: Side) => {
    if (s.pending.some((p) => p !== null && !(Number.isInteger(p) && p >= 0 && p <= 5))) {
      return '鎖定的檔位無效';
    }
    if (s.budget.some((b) => !Number.isInteger(b) || b < 0 || b > 100)) {
      return '預算無效';
    }
    if (s.got.some((g) => !Number.isInteger(g) || g < 0)) {
      return '已入帳價值無效';
    }
    return null;
  },
  teeth: (s: AuctionWorld, ai: Side) => [
    { name: '鎖定的檔位無效', state: setAt(s, `pending.${other(ai)}`, 9) },
    { name: '預算無效', state: setAt(s, `budget.${other(ai)}`, -1) },
  ],
});

// --- H-J 三張牌撲克 ---------------------------------------------------------
// 乾淨：對手的暗牌 cards[o]（不能和我的同一張）、它的均衡抽籤 eqDraw[o]（私人，AI 明文只讀自己那欄）。
// 糾纏：籌碼（兩邊總和守恆）、公開的歷史手牌裡它亮出的牌與它的動作。
interface PokerWorld {
  readonly hand: number;
  readonly phase: string;
  readonly first: number;
  readonly turn: number;
  readonly acts: readonly number[];
  readonly cards: readonly number[];
  readonly eqDraw: readonly number[];
  readonly hands: readonly { readonly first: number; readonly acts: readonly number[] }[];
}
export const H_J: CardSpec = defineSpec<PokerWorld>('H-J', {
  ...TURN_BASED,
  comp: sideOf('cards', 'eqDraw'),
  entangled: (side: Side, s?: PokerWorld) => {
    const paths = [`chips.${side}`];
    s?.hands.forEach((h, i) => {
      paths.push(`hands.${i}.shown.${side}`);
      h.acts.forEach((_a, j) => {
        const actor = j % 2 === 0 ? h.first : other(h.first as Side);
        if (actor === side) {
          paths.push(`hands.${i}.acts.${j}`);
        }
      });
    });
    return paths;
  },
  donorOkRelaxed: (q: PokerWorld, d: PokerWorld) =>
    q.hand === d.hand &&
    q.phase === d.phase &&
    q.first === d.first &&
    q.turn === d.turn &&
    q.acts.length === d.acts.length &&
    q.hands.length === d.hands.length &&
    q.hands.every(
      (h, i) =>
        h.first === (d.hands[i] as { first: number }).first &&
        h.acts.length === (d.hands[i] as { acts: readonly number[] }).acts.length,
    ),
  legal: (s: PokerWorld, _ai: Side) => {
    if (s.cards.some((c) => ![0, 1, 2].includes(c)) || s.cards[0] === s.cards[1]) {
      return '暗牌無效或兩邊同一張';
    }
    if (s.eqDraw.some((n) => !Number.isInteger(n) || n < 0 || n > 9999)) {
      return '均衡抽籤無效';
    }
    return null;
  },
  teeth: (s: PokerWorld, ai: Side) => [
    { name: '暗牌無效或兩邊同一張', state: setAt(s, `cards.${other(ai)}`, s.cards[ai] as number) },
    { name: '均衡抽籤無效', state: setAt(s, `eqDraw.${other(ai)}`, 99999) },
  ],
});

// --- H-Q 加碼 ---------------------------------------------------------------
// 乾淨：對手這回合的出手 pending、有沒有加碼 raised（要和 pending 一致：沒出手就不可能加碼）、是否因超時棄牌 timedOut。
// 糾纏：籌碼（和歷史的籌碼變化耦合）與已入帳每回合它的出手／加碼／回應（公開歷史）。
interface RaiseWorld {
  readonly round: number;
  readonly phase: string;
  readonly pending: readonly (number | null)[];
  readonly raised: readonly boolean[];
  readonly history: readonly unknown[];
}
export const H_Q: CardSpec = defineSpec<RaiseWorld>('H-Q', {
  ...TURN_BASED,
  comp: sideOf('pending', 'raised', 'timedOut'),
  entangled: (side: Side, s?: RaiseWorld) => {
    const paths = [`chips.${side}`];
    s?.history.forEach((_h, i) =>
      paths.push(`history.${i}.${side}`, `raises.${i}.${side}`, `replies.${i}.${side}`),
    );
    return paths;
  },
  donorOk: (q: RaiseWorld, d: RaiseWorld) => q.round === d.round && q.phase === d.phase,
  donorOkRelaxed: (q: RaiseWorld, d: RaiseWorld) => q.history.length === d.history.length,
  legal: (s: RaiseWorld, _ai: Side) => {
    if (s.pending.some((p) => p !== null && !(Number.isInteger(p) && p >= 0 && p <= 3))) {
      return '出手無效';
    }
    for (const side of [0, 1] as const) {
      const p = s.pending[side];
      // 只有出拳（0 到 2）才可能加碼；沒出手或棄牌不能加碼。
      if (s.raised[side] === true && (p === null || p === 3)) {
        return '沒出拳卻加碼';
      }
    }
    return null;
  },
  teeth: (s: RaiseWorld, ai: Side) => [
    { name: '出手無效', state: setAt(s, `pending.${other(ai)}`, 9) },
    {
      name: '沒出拳卻加碼',
      state: setAt(setAt(s, `pending.${other(ai)}`, null), `raised.${other(ai)}`, true),
    },
  ],
});

export const HEARTS_SPECS: readonly CardSpec[] = [
  H_A,
  H_2,
  H_3,
  H_4,
  H_5,
  H_6,
  H_9,
  H_10,
  H_J,
  H_Q,
];
