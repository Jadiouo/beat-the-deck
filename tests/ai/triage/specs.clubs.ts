import type { Side } from '../../../src/core/types';
import type { CardSpec } from './engine';
import { CELLS, cellX, cellY, defineSpec, isCell, sideOf } from './specs.shared';

/**
 * 梅花（蛇）。對手的元件是 `snakes[o]`（再加各牌自己的每邊欄位）。
 * 共通的合法性：蛇身每格在地圖內、相鄰兩格相距 1、行進方向與蛇頭／第二格一致、
 * 兩條蛇與牆（blocked）互不重疊、食物不壓在蛇身或牆上、沒結束的局兩條都活著。
 */

export interface SnakeLike {
  readonly body: readonly number[];
  readonly dir: number;
  readonly turn: number;
  readonly alive: boolean;
  readonly score: number;
}

export interface SnakeWorld {
  readonly snakes: readonly SnakeLike[];
  readonly foods: readonly number[];
  readonly over: boolean;
}

export interface SnakeOpts {
  readonly minLen?: number;
  /** 硬牆格（蛇身與食物都不能在上面）。 */
  readonly blocked?: readonly number[];
  /** 跳過「相鄰格相距 1」（有傳送門之類的牌）。 */
  readonly skipContiguous?: boolean;
  /** 跳過「dir 與蛇頭到第二格的方向一致」。 */
  readonly skipDirCheck?: boolean;
}

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

export function snakesLegal(world: SnakeWorld, opts: SnakeOpts = {}): string | null {
  const minLen = opts.minLen ?? 1;
  const blocked = new Set(opts.blocked ?? []);
  const used = new Map<number, number>();
  for (const [index, snake] of world.snakes.entries()) {
    if (!Array.isArray(snake.body) || snake.body.length < minLen) {
      return '蛇太短';
    }
    if (!world.over && !snake.alive) {
      return '局沒結束但蛇死了';
    }
    for (const c of snake.body) {
      if (!isCell(c)) {
        return '蛇身出界';
      }
      if (blocked.has(c)) {
        return '蛇身在牆上';
      }
      if (used.has(c)) {
        return '蛇身重疊';
      }
      used.set(c, index);
    }
    if (opts.skipContiguous !== true) {
      for (let i = 1; i < snake.body.length; i += 1) {
        const a = snake.body[i - 1] as number;
        const b = snake.body[i] as number;
        if (Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b)) !== 1) {
          return '蛇身不連續';
        }
      }
    }
    if (![0, 1, 2, 3].includes(snake.dir) || ![0, 1, 2, 3].includes(snake.turn)) {
      return '方向無效';
    }
    if (snake.turn === (snake.dir + 2) % 4) {
      return '鎖定了反方向';
    }
    if (opts.skipDirCheck !== true && snake.body.length >= 2) {
      const h = snake.body[0] as number;
      const n = snake.body[1] as number;
      if (cellX(h) - cellX(n) !== DX[snake.dir] || cellY(h) - cellY(n) !== DY[snake.dir]) {
        return '行進方向與蛇身不一致';
      }
    }
  }
  const seen = new Set<number>();
  for (const f of world.foods) {
    if (!isCell(f) || f >= CELLS) {
      return '食物出界';
    }
    if (seen.has(f)) {
      return '食物重複';
    }
    seen.add(f);
    if (used.has(f)) {
      return '食物壓在蛇身上';
    }
    if (blocked.has(f)) {
      return '食物在牆上';
    }
  }
  return null;
}

type Clubs = SnakeWorld;

export const C_A: CardSpec = defineSpec<Clubs>('C-A', {
  comp: sideOf('snakes'),
  legal: (s: Clubs, _ai: Side) => snakesLegal(s, { minLen: 3 }),
});

export const CLUBS_SPECS: readonly CardSpec[] = [C_A];
