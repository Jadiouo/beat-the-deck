import { describe, expect, it } from 'vitest';

import { rngStateFor } from '../../core/rng';
import type { Buttons, Game, Inputs } from '../../core/types';
import {
  CELLS,
  cell,
  cellX,
  cellY,
  generateWalls,
  HEIGHT,
  MAX_WALL_SETS,
  MOVE_EVERY,
  START_CELLS,
  WIDTH,
} from './logic';
import type { BaseOverrides, DiamondsBase } from './logic';

/**
 * 方塊三張牌（D-A、D-2、D-3）共用的規則測試。
 * TEST_PLAN 第 6 節：D-2「D-A 的 1 到 3、6、7 成立」、D-3「D-A 的 1 到 3、6 成立」，
 * 對應到這裡的 `describeSharedDiamondsRules`（地圖、牆、走格、重疊、補東西）。
 *
 * 每一個 `describe` 函式收一個 `DiamondsSuite`：牌的 game、`makeState`、場上的「撿拾物」（金幣或寶石）怎麼讀、怎麼放。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 這個檔案不叫 `*.test.ts`，所以 vitest 不會單獨跑它；由各張牌的 `logic.test.ts` 呼叫。
 */

export interface DiamondsSuite<S extends DiamondsBase> {
  /** 測試標題的前綴，例如 `D-A 搶金幣`。 */
  readonly label: string;
  readonly game: Game<S>;
  readonly makeState: (overrides?: BaseOverrides & Record<string, unknown>) => S;
  /** 場上撿拾物（金幣或寶石）所在的格子。 */
  readonly pickupCells: (state: S) => readonly number[];
  /** 把撿拾物放在這些格子的 overrides（寶石的出生 tick 由牌自己決定）。 */
  readonly withPickups: (cells: readonly number[]) => Record<string, unknown>;
  /** 場上隨時維持的撿拾物數量（金幣 6、寶石 5）。 */
  readonly count: number;
}

export const CONFIG = { maxTicks: 3600, params: {} };

export const NONE: Buttons = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
};
export const PRESS_UP: Buttons = { ...NONE, up: true };
export const PRESS_DOWN: Buttons = { ...NONE, down: true };
export const PRESS_LEFT: Buttons = { ...NONE, left: true };
export const PRESS_RIGHT: Buttons = { ...NONE, right: true };
export const IDLE: Inputs = [NONE, NONE];

/** 讓「下一次 step」剛好是走格的那一次。 */
export const BEFORE_MOVE = MOVE_EVERY - 1;

/** 走 n 個 tick，每個 tick 都給同一組輸入。 */
export function run<S extends DiamondsBase>(
  game: Game<S>,
  state: S,
  count: number,
  inputs: Inputs = IDLE,
): S {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = game.step(current, inputs);
  }
  return current;
}

/** 測試自己的洪水填充（不用被測的程式碼）：所有非牆的格子是否連成一塊。 */
export function openCellsConnected(walls: readonly number[]): boolean {
  const open: number[] = [];
  for (let i = 0; i < CELLS; i += 1) {
    if (walls[i] === 0) {
      open.push(i);
    }
  }
  if (open.length === 0) {
    return true;
  }
  const seen = new Set<number>([open[0] as number]);
  const queue = [open[0] as number];
  while (queue.length > 0) {
    const current = queue.pop() as number;
    const x = cellX(current);
    const y = cellY(current);
    const around: [number, number][] = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of around) {
      if (nx < 0 || ny < 0 || nx >= WIDTH || ny >= HEIGHT) {
        continue;
      }
      const index = cell(nx, ny);
      if (walls[index] === 0 && !seen.has(index)) {
        seen.add(index);
        queue.push(index);
      }
    }
  }
  return seen.size === open.length;
}

/** 除了 `open` 之外全是牆的「牆格清單」。 */
export function wallsExcept(open: readonly number[]): number[] {
  const keep = new Set(open);
  const walls: number[] = [];
  for (let i = 0; i < CELLS; i += 1) {
    if (!keep.has(i)) {
      walls.push(i);
    }
  }
  return walls;
}

/** 方塊共同規則（TEST_PLAN 第 6 節 D-A 的 1、2、3、6、7，外加邊界情況與種子）。 */
export function describeSharedDiamondsRules<S extends DiamondsBase>(suite: DiamondsSuite<S>): void {
  const { label, game, makeState, pickupCells, withPickups, count } = suite;

  describe(`${label}｜方塊共同規則（D-A 的 1 到 3、6、7）`, () => {
    it('1. 牆的生成：同一個種子同一組牆；不同的種子不全是同一組', () => {
      for (const seed of [0, 1, 7, 42, 99]) {
        const a = game.init(seed, CONFIG);
        const b = game.init(seed, CONFIG);
        expect(a.walls).toEqual(b.walls);
        expect(a.walls).toEqual(generateWalls(seed).walls);
      }
      const layouts = new Set<string>();
      for (let seed = 0; seed < 10; seed += 1) {
        layouts.add(game.init(seed, CONFIG).walls.join(''));
      }
      expect(layouts.size).toBeGreaterThan(5);
    });

    it('1. 牆的生成：種子 0 到 99，所有空格連通（洪水填充），牆格數在 20 道 × 2 到 5 格之內', () => {
      for (let seed = 0; seed < 100; seed += 1) {
        const state = game.init(seed, CONFIG);
        expect(state.walls).toHaveLength(CELLS);
        expect(openCellsConnected(state.walls), `種子 ${seed} 的空格不連通`).toBe(true);
        const wallCells = state.walls.filter((w) => w === 1).length;
        expect(wallCells, `種子 ${seed}`).toBeGreaterThanOrEqual(40);
        expect(wallCells, `種子 ${seed}`).toBeLessThanOrEqual(100);
        const generated = generateWalls(seed);
        expect(generated.fallback, `種子 ${seed} 退回了沒有牆`).toBe(false);
        expect(generated.attempts).toBeLessThanOrEqual(MAX_WALL_SETS);
      }
    });

    it('2. 兩個起始格都不是牆：人在左下角、AI 在右上角（種子 0 到 99）', () => {
      expect(START_CELLS).toEqual([cell(0, HEIGHT - 1), cell(WIDTH - 1, 0)]);
      for (let seed = 0; seed < 100; seed += 1) {
        const state = game.init(seed, CONFIG);
        expect(state.players[0].cell).toBe(START_CELLS[0]);
        expect(state.players[1].cell).toBe(START_CELLS[1]);
        expect(state.walls[START_CELLS[0]]).toBe(0);
        expect(state.walls[START_CELLS[1]]).toBe(0);
        expect(state.players[0].score).toBe(0);
        expect(state.players[1].score).toBe(0);
        expect(state.tick).toBe(0);
        expect(game.isOver(state)).toBe(false);
      }
    });

    it('3. 每 5 個 tick 最多走一格：一直按右，第 1 到 4 個 tick 不動，第 5 個 tick 走一格，第 9 個還是一格，第 10 個兩格', () => {
      let state = makeState({ players: [{ cell: cell(5, 5) }, { cell: cell(20, 20) }] });
      const press: Inputs = [PRESS_RIGHT, NONE];
      for (let t = 1; t <= 4; t += 1) {
        state = game.step(state, press);
        expect(state.players[0].cell, `第 ${t} 個 tick`).toBe(cell(5, 5));
      }
      state = game.step(state, press);
      expect(state.players[0].cell).toBe(cell(6, 5));
      state = run(game, state, 4, press);
      expect(state.players[0].cell).toBe(cell(6, 5));
      state = game.step(state, press);
      expect(state.players[0].cell).toBe(cell(7, 5));
      expect(state.players[1].cell).toBe(cell(20, 20));
    });

    it('3. 四個方向都走得動：上、右、下、左各走一格', () => {
      const cases: [Buttons, number][] = [
        [PRESS_UP, cell(10, 9)],
        [PRESS_RIGHT, cell(11, 10)],
        [PRESS_DOWN, cell(10, 11)],
        [PRESS_LEFT, cell(9, 10)],
      ];
      for (const [button, expected] of cases) {
        const state = makeState({ players: [{ cell: cell(10, 10) }, { cell: cell(20, 20) }] });
        const next = run(game, state, MOVE_EVERY, [button, NONE]);
        expect(next.players[0].cell).toBe(expected);
      }
    });

    it('3. 朝牆走：不動（邊界：朝格子外面走也不動）', () => {
      const state = makeState({
        walls: [cell(6, 5)],
        players: [{ cell: cell(5, 5) }, { cell: cell(0, 0) }],
      });
      const bump = run(game, state, MOVE_EVERY * 2, [PRESS_RIGHT, PRESS_LEFT]);
      expect(bump.players[0].cell).toBe(cell(5, 5));
      // 1 號角色在左上角 (0, 0) 朝左：出界，不動。
      expect(bump.players[1].cell).toBe(cell(0, 0));
      const up = run(game, state, MOVE_EVERY, [NONE, PRESS_UP]);
      expect(up.players[1].cell).toBe(cell(0, 0));
    });

    it('3. 待走方向：週期裡按了就算，按完放開照樣在第 5 個 tick 走；沒按就不動', () => {
      const state = makeState({ players: [{ cell: cell(5, 5) }, { cell: cell(20, 20) }] });
      let s = game.step(state, [PRESS_RIGHT, NONE]);
      s = run(game, s, 3, IDLE);
      expect(s.players[0].cell).toBe(cell(5, 5));
      s = game.step(s, IDLE); // 第 5 個 tick
      expect(s.players[0].cell).toBe(cell(6, 5));
      // 下一個週期完全沒按：不動。
      s = run(game, s, MOVE_EVERY, IDLE);
      expect(s.players[0].cell).toBe(cell(6, 5));
    });

    it('3. 待走方向：同一個週期裡最後按的算（先按上、再按左 → 往左），走格之後歸零，下一個週期可以改方向', () => {
      const state = makeState({ players: [{ cell: cell(5, 5) }, { cell: cell(20, 20) }] });
      let s = game.step(state, [PRESS_UP, NONE]);
      expect(s.players[0].pending).toBe(0);
      s = game.step(s, [PRESS_LEFT, NONE]);
      expect(s.players[0].pending).toBe(3);
      s = run(game, s, 3, IDLE);
      expect(s.players[0].cell).toBe(cell(4, 5));
      expect(s.players[0].pending).toBe(-1);
      s = run(game, s, MOVE_EVERY, [PRESS_UP, NONE]);
      expect(s.players[0].cell).toBe(cell(4, 4));
    });

    it('3. 同一個 tick 同時按了好幾個方向：依「上、右、下、左」取第一個', () => {
      const state = makeState({ players: [{ cell: cell(5, 5) }, { cell: cell(20, 20) }] });
      const both: Buttons = { ...NONE, left: true, up: true };
      expect(game.step(state, [both, NONE]).players[0].pending).toBe(0);
      const rightDown: Buttons = { ...NONE, down: true, right: true };
      expect(game.step(state, [rightDown, NONE]).players[0].pending).toBe(1);
      const downLeft: Buttons = { ...NONE, down: true, left: true };
      expect(game.step(state, [downLeft, NONE]).players[0].pending).toBe(2);
    });

    it('3. 走格那個 tick 的按鍵也算在這個週期裡；走完之後待走方向歸零', () => {
      const state = makeState({
        tick: BEFORE_MOVE,
        players: [{ cell: cell(5, 5) }, { cell: cell(20, 20) }],
      });
      const s = game.step(state, [PRESS_DOWN, NONE]);
      expect(s.players[0].cell).toBe(cell(5, 6));
      expect(s.players[0].pending).toBe(-1);
    });

    it('6. 兩個角色可以站在同一格：走進同一格、再待著，都不會被擋或被推開', () => {
      const state = makeState({
        tick: BEFORE_MOVE,
        players: [{ cell: cell(5, 5) }, { cell: cell(7, 5) }],
      });
      let s = game.step(state, [PRESS_RIGHT, PRESS_LEFT]);
      expect(s.players[0].cell).toBe(cell(6, 5));
      expect(s.players[1].cell).toBe(cell(6, 5));
      s = run(game, s, MOVE_EVERY * 2, IDLE);
      expect(s.players[0].cell).toBe(cell(6, 5));
      expect(s.players[1].cell).toBe(cell(6, 5));
    });

    it('6. 兩個角色可以互換位置（頭穿過頭也不阻擋）', () => {
      const state = makeState({
        tick: BEFORE_MOVE,
        players: [{ cell: cell(5, 5) }, { cell: cell(6, 5) }],
      });
      const s = game.step(state, [PRESS_RIGHT, PRESS_LEFT]);
      expect(s.players[0].cell).toBe(cell(6, 5));
      expect(s.players[1].cell).toBe(cell(5, 5));
    });

    it('7. 補的不會出現在牆上，也不會出現在已經有的撿拾物或角色的格子（只剩一條 14 格的走廊可以放）', () => {
      const row = Array.from({ length: 14 }, (_v, x) => cell(x, 23));
      const state = makeState({
        tick: BEFORE_MOVE,
        walls: wallsExcept(row),
        players: [{ cell: cell(0, 23) }, { cell: cell(13, 23) }],
        ...withPickups([cell(1, 23)]),
      });
      const s = game.step(state, [PRESS_RIGHT, NONE]);
      const picked = pickupCells(s);
      expect(picked).toHaveLength(count);
      expect(new Set(picked).size).toBe(count);
      for (const c of picked) {
        expect(row, `撿拾物出現在走廊外 ${c}`).toContain(c);
        expect(s.walls[c]).toBe(0);
        expect(c).not.toBe(s.players[0].cell);
        expect(c).not.toBe(s.players[1].cell);
      }
    });

    it('7. 補的數量足夠時永遠維持：隨機亂按 5 個種子各 700 個 tick，撿拾物不在牆上、不重複、數量不變', () => {
      for (let seed = 0; seed < 5; seed += 1) {
        let state = game.init(seed, CONFIG);
        for (let t = 0; t < 700; t += 1) {
          const buttons = [NONE, PRESS_UP, PRESS_RIGHT, PRESS_DOWN, PRESS_LEFT];
          const a = buttons[(seed * 7 + t * 3 + (t >> 2)) % 5] as Buttons;
          const b = buttons[(seed * 5 + t * 11 + (t >> 1)) % 5] as Buttons;
          state = game.step(state, [a, b]);
          const cells = pickupCells(state);
          expect(cells, `種子 ${seed} tick ${t}`).toHaveLength(count);
          expect(new Set(cells).size).toBe(count);
          for (const c of cells) {
            expect(state.walls[c]).toBe(0);
          }
        }
      }
    });

    it('種子有效：10 個不同的種子，初始的撿拾物位置不全相同', () => {
      const layouts = new Set<string>();
      for (let seed = 0; seed < 10; seed += 1) {
        layouts.add([...pickupCells(game.init(seed, CONFIG))].sort((x, y) => x - y).join(','));
      }
      expect(layouts.size).toBeGreaterThan(5);
    });

    it('種子有效：補的位置會隨亂數狀態變，而且新的亂數狀態有寫回 state（不是每次補同一格）', () => {
      const refillAt = (seed: number) => {
        const state = makeState({
          tick: BEFORE_MOVE,
          rng: rngStateFor(seed, 'refill-test'),
          players: [{ cell: cell(5, 5) }, { cell: cell(25, 20) }],
          ...withPickups([cell(6, 5), cell(15, 10), cell(16, 10), cell(17, 10), cell(18, 10)]),
        });
        const next = game.step(state, [PRESS_RIGHT, NONE]);
        return { state, next };
      };
      const spots = new Set<number>();
      for (let seed = 0; seed < 10; seed += 1) {
        const { state, next } = refillAt(seed);
        expect(next.rng, `種子 ${seed}：補了東西，亂數狀態必須改變`).not.toBe(state.rng);
        const fresh = pickupCells(next).filter(
          (c) => ![cell(15, 10), cell(16, 10), cell(17, 10), cell(18, 10)].includes(c),
        );
        for (const c of fresh) {
          spots.add(c);
        }
      }
      expect(spots.size).toBeGreaterThan(5);
    });

    it('step 不改動傳進來的 state（深度凍結後呼叫不丟錯，雜湊不變）', () => {
      const state = makeState({
        tick: BEFORE_MOVE,
        players: [{ cell: cell(5, 5) }, { cell: cell(25, 20) }],
        ...withPickups([cell(6, 5), cell(15, 10), cell(16, 10)]),
      });
      const before = JSON.stringify(state);
      const frozen = deepFreeze(JSON.parse(before) as S);
      expect(() => game.step(frozen, [PRESS_RIGHT, PRESS_LEFT])).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(before);
    });
  });
}

/** 深度凍結（測試用）。 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
