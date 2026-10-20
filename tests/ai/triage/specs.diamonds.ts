import type { Side } from '../../../src/core/types';
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

export const D_A: CardSpec = defineSpec<CoinWorld>('D-A', {
  comp: sideOf('players'),
  legal: (s: CoinWorld, _ai: Side) => walkersLegal(s, s.coins),
  farDonors: true,
});

export const DIAMONDS_SPECS: readonly CardSpec[] = [D_A];
