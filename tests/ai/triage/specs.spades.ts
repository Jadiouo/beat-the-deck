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
