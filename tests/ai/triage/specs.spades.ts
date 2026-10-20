import type { Side } from '../../../src/core/types';
import type { CardSpec } from './engine';
import { setAt } from './engine';
import { defineSpec, sideOf } from './specs.shared';

/**
 * 黑桃（場地、子彈、站位）。
 * 對照組：S-8（有互動）、S-6 與 S-10（已知無互動）。
 */

const FIELD_W = 150;
const FIELD_H = 220;
const PLAYER_R = 3;
const BODY_DIST = 9;
const INVULN_TICKS = 45;

// --- S-8 掃射 ---------------------------------------------------------------

interface S8Player {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly invuln: number;
  readonly hits: number;
  readonly pts: number;
  readonly lane: number;
  readonly hold: number;
  readonly bumpAt: number;
}
interface S8World {
  readonly tick: number;
  readonly players: readonly S8Player[];
}

export const S_8: CardSpec = defineSpec<S8World>('S-8', {
  comp: sideOf('players'),
  teeth: (s: S8World, ai: Side) => {
    const o = ai === 0 ? 1 : 0;
    const mine = s.players[ai] as S8Player;
    return [
      { name: '玩家出界', state: setAt(s, `players.${o}.x`, -5) },
      { name: 'hold 不在 0 到 1', state: setAt(s, `players.${o}.hold`, 2) },
      { name: 'bumpAt 在未來', state: setAt(s, `players.${o}.bumpAt`, s.tick + 50) },
      {
        name: '兩個玩家重疊',
        state: setAt(setAt(s, `players.${o}.x`, mine.x), `players.${o}.y`, mine.y),
      },
    ];
  },
  legal: (s: S8World, _ai: Side) => {
    for (const p of s.players) {
      if (!(
        p.x >= PLAYER_R &&
        p.x <= FIELD_W - PLAYER_R &&
        p.y >= PLAYER_R &&
        p.y <= FIELD_H - PLAYER_R
      )) {
        return '玩家出界';
      }
      if (!(p.invuln >= 0 && p.invuln <= INVULN_TICKS)) {
        return '無敵倒數無效';
      }
      if (!(Number.isInteger(p.hits) && p.hits >= 0)) {
        return '被打中次數無效';
      }
      if (!(p.hold >= 0 && p.hold <= 1)) {
        return 'hold 不在 0 到 1';
      }
      if (!(p.lane >= 10 && p.lane <= 90)) {
        return 'lane 不在縫的範圍';
      }
      if (!(p.bumpAt >= -1 && p.bumpAt <= s.tick)) {
        return 'bumpAt 在未來';
      }
      if (!(p.pts >= 0)) {
        return '得分為負';
      }
    }
    const a = s.players[0] as S8Player;
    const b = s.players[1] as S8Player;
    // 兩人是實心的，重疊會被推開到 BODY_DIST；被牆夾住時可能略小，容許 1 像素。
    if (Math.hypot(a.x - b.x, a.y - b.y) < BODY_DIST - 1) {
      return '兩個玩家重疊';
    }
    return null;
  },
  farDonors: false,
});

// --- S-10 彈幕 --------------------------------------------------------------

interface S10Player {
  readonly x: number;
  readonly y: number;
  readonly invuln: number;
  readonly hits: number;
}
interface S10World {
  readonly players: readonly S10Player[];
  readonly lock: readonly number[];
  readonly cleared: readonly number[];
  readonly exposure: readonly number[];
}

export const S_10: CardSpec = defineSpec<S10World>('S-10', {
  comp: sideOf('players', 'lock', 'cleared', 'exposure'),
  teeth: (s: S10World, ai: Side) => {
    const o = ai === 0 ? 1 : 0;
    return [
      { name: '險度不在 0 到 1', state: setAt(s, `exposure.${o}`, 2) },
      { name: '鎖定倒數無效', state: setAt(s, `lock.${o}`, -1) },
      { name: '玩家出界', state: setAt(s, `players.${o}.y`, 999) },
    ];
  },
  legal: (s: S10World, _ai: Side) => {
    for (const p of s.players) {
      if (!(
        p.x >= PLAYER_R &&
        p.x <= FIELD_W - PLAYER_R &&
        p.y >= PLAYER_R &&
        p.y <= FIELD_H - PLAYER_R
      )) {
        return '玩家出界';
      }
      if (!(p.invuln >= 0 && p.invuln <= 60)) {
        return '無敵倒數無效';
      }
      if (!(Number.isInteger(p.hits) && p.hits >= 0)) {
        return '被打中次數無效';
      }
    }
    if (s.lock.some((n) => !(Number.isInteger(n) && n >= 0 && n <= 120))) {
      return '鎖定倒數無效';
    }
    if (s.cleared.some((n) => !(Number.isInteger(n) && n >= 0))) {
      return '清場得分無效';
    }
    if (s.exposure.some((n) => !(n >= 0 && n <= 1))) {
      return '險度不在 0 到 1';
    }
    return null;
  },
  // 特殊狀態：險度是 0 到 1 的移動平均，真實對局裡幾乎都貼著 0（10.63：平均 0.00011、最大 0.0164）；
  // 對手持續貼著子彈幾十個 tick 就會到 0.05 以上，所以 0.05 與 0.3 是「可達但罕見」的值。
  // 對手被鎖（按太早）與無敵中也是真實會出現的狀態。
  special: (s, ai) => {
    const o = ai === 0 ? 1 : 0;
    const out: { name: string; state: S10World }[] = [];
    for (const v of [0, 0.05, 0.3]) {
      out.push({ name: `opp-exposure-${v}`, state: setAt(s, `exposure.${o}`, v) });
    }
    for (const v of [0, 60, 120]) {
      out.push({ name: `opp-lock-${v}`, state: setAt(s, `lock.${o}`, v) });
    }
    for (const v of [0, 60]) {
      out.push({ name: `opp-invuln-${v}`, state: setAt(s, `players.${o}.invuln`, v) });
    }
    return out;
  },
});

// --- S-6 節拍 ---------------------------------------------------------------
// 對手編的曲子（phrases[o]）是 AI 要打的「題目」，不是對手的狀態，不擾動；
// 擾動的是對手的技術紀錄（history）、分數、正在編的曲子、按住的軌道、口味、上一回合的結算。

interface S6Note {
  readonly lane: number;
  readonly slot: number;
}
interface S6World {
  readonly round: number;
  readonly phase: string;
  readonly phrases: readonly (readonly S6Note[])[];
  readonly composing: readonly (readonly S6Note[])[];
  readonly hits: readonly (readonly number[])[];
  readonly points: readonly number[];
  readonly history: readonly (readonly unknown[])[];
  readonly last: { readonly e: unknown; readonly penalty: unknown; readonly bonus: unknown } | null;
}

export const S_6: CardSpec = defineSpec<S6World>('S-6', {
  minTicks: 2940,
  teeth: (s: S6World, ai: Side) => {
    const o = ai === 0 ? 1 : 0;
    return [
      { name: '音軌無效', state: setAt(s, `composing.${o}`, [{ lane: 9, slot: 0 }]) },
      {
        name: '音符的格子無效',
        state: setAt(s, `composing.${o}`, [
          { lane: 0, slot: 0 },
          { lane: 1, slot: 1 },
        ]),
      },
    ];
  },
  comp: (side: Side, s?: S6World) => {
    const paths = [
      `composing.${side}`,
      `held.${side}`,
      `over.${side}`,
      `points.${side}`,
      `history.${side}`,
      `taste.${side}`,
      `hits.${side}`,
    ];
    if (s !== undefined && s.last !== null) {
      paths.push(`last.e.${side}`, `last.penalty.${side}`, `last.bonus.${side}`);
    }
    return paths;
  },
  donorOk: (q: S6World, d: S6World) =>
    q.round === d.round &&
    q.phase === d.phase &&
    (d.last === null) === (q.last === null) &&
    q.history[0]?.length === d.history[0]?.length &&
    q.history[1]?.length === d.history[1]?.length,
  legal: (s: S6World, ai: Side) => {
    const o = ai === 0 ? 1 : 0;
    for (const notes of s.composing) {
      let prev = -10;
      for (const n of notes) {
        if (!(Number.isInteger(n.lane) && n.lane >= 0 && n.lane <= 3)) {
          return '音軌無效';
        }
        if (!(Number.isInteger(n.slot) && n.slot >= 0 && n.slot <= 7 && n.slot - prev >= 2)) {
          return '音符的格子無效';
        }
        prev = n.slot;
      }
    }
    // 對手打我編的曲子：它的 hits 長度要等於我的曲子的音符數（或回合剛開始還是空的）。
    const mine = s.phrases[ai] ?? [];
    const theirHits = s.hits[o] ?? [];
    if (theirHits.length !== 0 && theirHits.length !== mine.length) {
      return '對手的命中數與我的曲子長度不一致';
    }
    if (s.points.some((n) => !Number.isFinite(n))) {
      return '分數無效';
    }
    return null;
  },
});

export const CONTROL_SPADES: readonly CardSpec[] = [S_8, S_10, S_6];

// ---------------------------------------------------------------------------
// 目標牌：S-A、S-2、S-3、S-Q（各自獨立的場地）、S-5（乒乓）、S-7（拔槍）、S-J（射手與靶）
// ---------------------------------------------------------------------------

const other = (side: Side): Side => (side === 0 ? 1 : 0);

// S-A、S-2、S-3、S-Q：兩個人各自在自己的場地裡躲自己的子彈（fields[side] 含玩家、子彈、命中數），
// 兩邊唯一的耦合是 score 的差（領先）。對手的元件就是整個 fields[o]。
interface Bullet {
  readonly x: number;
  readonly y: number;
}
interface Field {
  readonly px: number;
  readonly py: number;
  readonly invuln: number;
  readonly hits: number;
  readonly grazes: number;
  readonly bullets: readonly Bullet[];
}
interface FieldWorld {
  readonly fields: readonly Field[];
}

const fieldLegal = (s: FieldWorld, _ai: Side): string | null => {
  for (const f of s.fields) {
    if (!(
      f.px >= PLAYER_R &&
      f.px <= FIELD_W - PLAYER_R &&
      f.py >= PLAYER_R &&
      f.py <= FIELD_H - PLAYER_R
    )) {
      return '玩家出界';
    }
    if (!(f.invuln >= 0 && f.invuln <= 60)) {
      return '無敵倒數無效';
    }
    if (!(Number.isInteger(f.hits) && f.hits >= 0 && Number.isInteger(f.grazes) && f.grazes >= 0)) {
      return '命中或擦彈數無效';
    }
    if (
      f.bullets.some((b) => !(b.x >= -2 && b.x <= FIELD_W + 2 && b.y >= 0 && b.y <= FIELD_H + 2))
    ) {
      return '子彈在場地外';
    }
  }
  return null;
};

const fieldTeeth = <W extends FieldWorld>(
  s: W,
  ai: Side,
): readonly { name: string; state: W }[] => {
  const o = other(ai);
  return [
    { name: '玩家出界', state: setAt(s, `fields.${o}.px`, -9) },
    { name: '無敵倒數無效', state: setAt(s, `fields.${o}.invuln`, 999) },
    { name: '命中數無效', state: setAt(s, `fields.${o}.hits`, -1) },
    { name: '子彈在場地外', state: setAt(s, `fields.${o}.bullets`, [{ x: 999, y: 5 }]) },
  ];
};

// 特殊狀態：對手無敵中、對手多被打中 3 次（領先反轉）。
const fieldSpecial = <W extends FieldWorld>(
  s: W,
  ai: Side,
): readonly { name: string; state: W }[] => {
  const o = other(ai);
  const f = s.fields[o] as Field;
  return [
    { name: 'opp-invuln-60', state: setAt(s, `fields.${o}.invuln`, 60) },
    { name: 'opp-invuln-0', state: setAt(s, `fields.${o}.invuln`, 0) },
    { name: 'opp-hits+3', state: setAt(s, `fields.${o}.hits`, f.hits + 3) },
  ];
};

const fieldSpec = (id: string): CardSpec =>
  defineSpec<FieldWorld>(id, {
    comp: sideOf('fields'),
    legal: fieldLegal,
    teeth: fieldTeeth,
    special: fieldSpecial,
  });

export const S_A: CardSpec = fieldSpec('S-A');
export const S_2: CardSpec = fieldSpec('S-2');
export const S_3: CardSpec = fieldSpec('S-3');

// S-Q 鏡像：S-3 加上每邊的鏡像計時器 mirror[side]（pending → active → immune，同一時間最多一個非零）與觸發次數 triggers。
interface MirrorWorld extends FieldWorld {
  readonly mirror: readonly {
    readonly pending: number;
    readonly active: number;
    readonly immune: number;
  }[];
  readonly triggers: readonly number[];
}
export const S_Q: CardSpec = defineSpec<MirrorWorld>('S-Q', {
  comp: sideOf('fields', 'mirror', 'triggers'),
  legal: (s: MirrorWorld, ai: Side) => {
    const base = fieldLegal(s, ai);
    if (base !== null) {
      return base;
    }
    for (const m of s.mirror) {
      const live = [m.pending, m.active, m.immune].filter((n) => n > 0).length;
      if (live > 1 || [m.pending, m.active, m.immune].some((n) => !Number.isInteger(n) || n < 0)) {
        return '鏡像計時器無效';
      }
    }
    return null;
  },
  teeth: (s: MirrorWorld, ai: Side) => [
    ...fieldTeeth(s, ai),
    {
      name: '鏡像計時器無效',
      state: setAt(s, `mirror.${other(ai)}`, { pending: 5, active: 5, immune: 0 }),
    },
  ],
  special: (s: MirrorWorld, ai: Side) => {
    const o = other(ai);
    return [
      ...fieldSpecial(s, ai),
      {
        name: 'opp-mirror-pending',
        state: setAt(s, `mirror.${o}`, { pending: 30, active: 0, immune: 0 }),
      },
      {
        name: 'opp-mirror-active',
        state: setAt(s, `mirror.${o}`, { pending: 0, active: 120, immune: 0 }),
      },
      {
        name: 'opp-mirror-immune',
        state: setAt(s, `mirror.${o}`, { pending: 0, active: 0, immune: 120 }),
      },
      {
        name: 'opp-mirror-calm',
        state: setAt(s, `mirror.${o}`, { pending: 0, active: 0, immune: 0 }),
      },
    ];
  },
});

// S-5 乒乓：兩塊板子（paddles[side]：x、vx、target）、各自最近 5 次回球的落點 habit[side]（公開，AI 讀它猜對方回哪）、
// 比分 points[side]。球與發球方是共用的。發球方每得一分輪替，所以換對手的分數時要保持「總分的奇偶」不變，
// 才不會讓發球方與比分矛盾。
interface PongWorld {
  readonly phase: string;
  readonly server: number;
  readonly target: number;
  readonly paddles: readonly { readonly x: number; readonly vx: number; readonly target: number }[];
  readonly habit: readonly (readonly number[])[];
  readonly points: readonly number[];
}
export const S_5: CardSpec = defineSpec<PongWorld>('S-5', {
  comp: sideOf('paddles', 'habit', 'points'),
  donorOk: (q: PongWorld, d: PongWorld, ai: Side) =>
    q.phase === d.phase &&
    q.server === d.server &&
    ((q.points[other(ai)] as number) - (d.points[other(ai)] as number)) % 2 === 0,
  legal: (s: PongWorld, _ai: Side) => {
    for (const p of s.paddles) {
      if (!(p.x >= 15 && p.x <= FIELD_W - 15) || Math.abs(p.vx) > 2.4 + 1e-9) {
        return '板子位置或速度無效';
      }
      if (![0, 1, -1, 2.4, -2.4].some((t) => Math.abs(p.target - t) < 1e-9)) {
        return '板子的目標速度無效';
      }
    }
    if (s.habit.some((h) => h.length > 5 || h.some((x) => !(x >= 0 && x <= FIELD_W)))) {
      return '回球習慣無效';
    }
    if (s.points.some((n) => !Number.isInteger(n) || n < 0 || n >= s.target)) {
      return '比分無效';
    }
    return null;
  },
  teeth: (s: PongWorld, ai: Side) => [
    { name: '板子位置無效', state: setAt(s, `paddles.${other(ai)}.x`, -20) },
    { name: '回球習慣無效', state: setAt(s, `habit.${other(ai)}`, [1, 2, 3, 4, 5, 6]) },
    { name: '比分無效', state: setAt(s, `points.${other(ai)}`, 99) },
  ],
});

// S-7 拔槍：對手的公開紀錄 spent（用掉的假動作）與歷史裡它的假動作次數／時間／上當次數。
// 隱藏的當前輪資訊（twitches、flash.makers、press）與勝負歷史不換（它們和共用的 flash、wins 耦合）。
interface DrawWorld {
  readonly round: number;
  readonly phase: string;
  readonly spent: readonly number[];
  readonly twitches: readonly number[];
  readonly flash: unknown;
  readonly press: readonly unknown[];
  readonly history: readonly {
    readonly twitches: readonly number[];
    readonly twitchAt: readonly (readonly number[])[];
    readonly baited: readonly number[];
  }[];
}
export const S_7: CardSpec = defineSpec<DrawWorld>('S-7', {
  farDonors: true,
  sample: { every: 10, decisionsOnly: true },
  comp: (side: Side, s?: DrawWorld) => {
    const paths = [`spent.${side}`];
    if (s !== undefined) {
      for (let i = 0; i < s.history.length; i += 1) {
        paths.push(
          `history.${i}.twitches.${side}`,
          `history.${i}.twitchAt.${side}`,
          `history.${i}.baited.${side}`,
        );
      }
    }
    return paths;
  },
  donorOk: (q: DrawWorld, d: DrawWorld) =>
    q.round === d.round &&
    q.phase === d.phase &&
    q.history.length === d.history.length &&
    (q.flash === null) === (d.flash === null) &&
    q.press.every((p, i) => (p === null) === (d.press[i] === null)),
  legal: (s: DrawWorld, _ai: Side) => {
    for (const side of [0, 1] as const) {
      const seen = s.history.reduce((n, r) => n + (r.twitches[side] as number), 0);
      if ((s.spent[side] as number) < seen) {
        return '用掉的假動作少於歷史裡的次數';
      }
      // 結算階段 spent 已經把這一輪的 twitches 加進去、twitches 還留著到下一輪才歸零，所以只在等待階段檢查總和。
      if (
        (s.spent[side] as number) > 6 ||
        (s.phase === 'wait' && (s.spent[side] as number) + (s.twitches[side] as number) > 6)
      ) {
        return '假動作超過上限 6';
      }
      for (const r of s.history) {
        if ((r.twitchAt[side] as readonly number[]).length !== r.twitches[side]) {
          return '假動作次數與時間數量不一致';
        }
        if ((r.baited[side] as number) < 0 || (r.baited[side] as number) > 1) {
          return '上當次數無效';
        }
      }
    }
    return null;
  },
  teeth: (s: DrawWorld, ai: Side) => [
    { name: '用掉的假動作少於歷史裡的次數', state: setAt(s, `spent.${other(ai)}`, -1) },
    { name: '假動作超過上限 6', state: setAt(s, `spent.${other(ai)}`, 7) },
  ],
});

// S-J 射手與靶：兩局交換角色。射手有游標、冷卻、公開的彈藥；靶有位置速度與無敵。兩個角色的元件都在 state 的頂層
// （不分邊），所以「某一邊的元件」依這一局誰是射手而定。子彈是共用環境。
interface ShootWorld {
  readonly shooter: number;
  readonly round: number;
  readonly cursor: number;
  readonly cooldown: number;
  readonly ammo: number;
  readonly regen: number;
  readonly px: number;
  readonly py: number;
  readonly invuln: number;
  readonly bullets: readonly Bullet[];
}
export const S_J: CardSpec = defineSpec<ShootWorld>('S-J', {
  comp: (side: Side, s?: ShootWorld) => {
    const common = [`hits.${side}`, `zone.${side}`];
    if (s === undefined) {
      return common;
    }
    return s.shooter === side
      ? [...common, 'cursor', 'cooldown', 'ammo', 'regen']
      : [...common, 'px', 'py', 'vx', 'vy', 'invuln'];
  },
  donorOk: (q: ShootWorld, d: ShootWorld) => q.round === d.round && q.shooter === d.shooter,
  legal: (s: ShootWorld, _ai: Side) => {
    if (!(s.cursor >= 2 && s.cursor <= FIELD_W - 2)) {
      return '游標出界';
    }
    if (!(Number.isInteger(s.ammo) && s.ammo >= 0 && s.ammo <= 5)) {
      return '彈藥無效';
    }
    if (!(s.cooldown >= 0 && s.cooldown <= 20 && s.regen >= 0 && s.regen <= 90)) {
      return '冷卻或補充倒數無效';
    }
    if (!(
      s.px >= PLAYER_R &&
      s.px <= FIELD_W - PLAYER_R &&
      s.py >= PLAYER_R &&
      s.py <= FIELD_H - PLAYER_R
    )) {
      return '靶出界';
    }
    if (!(s.invuln >= 0 && s.invuln <= 45)) {
      return '無敵倒數無效';
    }
    // 沒有無敵的靶不可能和子彈重疊（重疊的那個 tick 就被打中、進入無敵）。
    if (s.invuln === 0 && s.bullets.some((b) => Math.hypot(b.x - s.px, b.y - s.py) < 5 - 1e-9)) {
      return '沒有無敵的靶壓在子彈上';
    }
    return null;
  },
  teeth: (s: ShootWorld) => [
    { name: '彈藥無效', state: setAt(s, 'ammo', 99) },
    { name: '靶出界', state: setAt(s, 'px', -50) },
    {
      name: '沒有無敵的靶壓在子彈上',
      state: setAt(setAt(setAt(s, 'invuln', 0), 'bullets', [{ x: s.px, y: s.py }]), 'py', s.py),
    },
  ],
});

export const SPADES_SPECS: readonly CardSpec[] = [S_A, S_2, S_3, S_Q, S_5, S_7, S_J];
