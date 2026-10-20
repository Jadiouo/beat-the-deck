import type { Side } from '../../../src/core/types';
import { setAt } from './engine';
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
  /** 允許沒有蛇身（沒有蛇的那一邊，例如 C-J 的設計師）。 */
  readonly allowEmpty?: boolean;
  /** 允許蛇已死（一局接一局的牌，局與局之間凍結的畫面）。 */
  readonly allowDead?: boolean;
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
    if (opts.allowEmpty === true && snake.body.length === 0) {
      continue;
    }
    if (!Array.isArray(snake.body) || snake.body.length < minLen) {
      return '蛇太短';
    }
    if (!world.over && opts.allowDead !== true && !snake.alive) {
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

/** 蛇的破壞版本（合法性檢查必須全部擋下）：對手的蛇頭疊到我的蛇頭、出界、不連續、食物壓在對手蛇身上。 */
export function snakeTeeth<W extends SnakeWorld>(
  s: W,
  ai: Side,
): readonly { name: string; state: W }[] {
  const o = ai === 0 ? 1 : 0;
  const mine = s.snakes[ai] as SnakeLike;
  const theirs = s.snakes[o] as SnakeLike;
  const out: { name: string; state: W }[] = [
    { name: '蛇身重疊', state: setAt(s, `snakes.${o}.body.0`, mine.body[0] as number) },
    { name: '蛇身出界', state: setAt(s, `snakes.${o}.body.0`, -1) },
  ];
  if (theirs.body.length >= 2) {
    out.push({
      name: '蛇身不連續',
      state: setAt(s, `snakes.${o}.body.1`, ((theirs.body[0] as number) + 5) % CELLS),
    });
  }
  if (s.foods.length > 0) {
    out.push({ name: '食物壓在蛇身上', state: setAt(s, 'foods.0', theirs.body[0] as number) });
  }
  return out;
}

type Clubs = SnakeWorld;

const snakeLegalMin3 = (s: Clubs, _ai: Side): string | null => snakesLegal(s, { minLen: 3 });

export const C_A: CardSpec = defineSpec<Clubs>('C-A', {
  comp: sideOf('snakes'),
  legal: snakeLegalMin3,
  teeth: snakeTeeth,
});

// C-2 旋轉的房間：規則與 C-A 完全相同，多的 viewRotation／warning 由 tick 算出，不屬於任何一邊。
export const C_2: CardSpec = defineSpec<Clubs>('C-2', {
  comp: sideOf('snakes'),
  legal: snakeLegalMin3,
  teeth: snakeTeeth,
});

// C-3 紅藍食物：食物有顏色（foodColors 與 foods 一一對應，共用環境）；分數可以是負的（吃錯 −2）。
interface C3World extends Clubs {
  readonly foodColors: readonly number[];
}
export const C_3: CardSpec = defineSpec<C3World>('C-3', {
  comp: sideOf('snakes'),
  teeth: (s: C3World, ai: Side) => [
    ...snakeTeeth(s, ai),
    { name: '顏色數不一致', state: setAt(s, 'foodColors', [] as number[]) },
  ],
  legal: (s: C3World, _ai: Side) => {
    if (s.foodColors.length !== s.foods.length) {
      return '食物顏色數與食物數不一致';
    }
    return snakesLegal(s, { minLen: 3 });
  },
});

// C-5 會動的牆：牆是共用環境（bars，硬牆）；被壓死的次數 crushed 是各邊自己的紀錄。
interface C5World extends Clubs {
  readonly bars: readonly (readonly number[])[];
  readonly crushed: readonly number[];
}
export const C_5: CardSpec = defineSpec<C5World>('C-5', {
  comp: sideOf('snakes', 'crushed'),
  teeth: (s: C5World, ai: Side) => [
    ...snakeTeeth(s, ai),
    {
      name: '蛇身在牆上',
      state: setAt(
        s,
        `snakes.${ai === 0 ? 1 : 0}.body.0`,
        (s.bars[0] as readonly number[])[0] as number,
      ),
    },
  ],
  legal: (s: C5World, _ai: Side) =>
    snakesLegal(s, { minLen: 3, blocked: s.bars.flat() }) ??
    (s.crushed.some((n) => !Number.isInteger(n) || n < 0) ? '壓死次數無效' : null),
});

// C-8 光軌：一局接一局，蛇身是永遠不消失的軌跡。對手的元件只有蛇（軌跡與本局勝場數）。
// 同一個 tick、不同 run 的局數與局內進度常常不同，所以捐贈者必須在同一局、同一個局內 tick。
interface C8World extends Clubs {
  readonly round: number;
  readonly roundTick: number;
  readonly pause: number;
  readonly outcome: string | null;
}
export const C_8: CardSpec = defineSpec<C8World>('C-8', {
  comp: sideOf('snakes'),
  teeth: snakeTeeth,
  farDonors: true,
  sample: { every: 10 },
  donorOk: (q: C8World, d: C8World) =>
    q.round === d.round && q.roundTick === d.roundTick && d.pause === 0 && d.outcome === null,
  legal: (s: C8World, _ai: Side) => {
    const base = snakesLegal(s, { minLen: 1, allowDead: s.pause > 0 || s.outcome !== null });
    if (base !== null) {
      return base;
    }
    // 光軌沒有食物，蛇每走一格長一格：局內 tick 決定軌跡的長度（開局不動的時間 roundTick 是負的）。
    const moves = Math.max(0, Math.floor(s.roundTick / 10));
    return s.snakes.every((sn) => sn.body.length === 1 + moves || s.pause > 0 || !sn.alive)
      ? null
      : '軌跡長度與局內 tick 不一致';
  },
});

// C-10 追與逃：一邊逃（長 4）、一邊追（長 1），兩局交換角色。
interface C10World extends Clubs {
  readonly round: number;
  readonly runner: number;
  readonly roundTick: number;
  readonly pause: number;
  readonly outcome: string | null;
}
export const C_10: CardSpec = defineSpec<C10World>('C-10', {
  comp: sideOf('snakes', 'runnerTicks'),
  teeth: snakeTeeth,
  farDonors: true,
  sample: { every: 10 },
  donorOk: (q: C10World, d: C10World) =>
    q.round === d.round && q.runner === d.runner && d.pause === 0 && d.outcome === null,
  legal: (s: C10World, _ai: Side) => {
    const base = snakesLegal(s, { minLen: 1, allowDead: s.pause > 0 || s.outcome !== null });
    if (base !== null) {
      return base;
    }
    const chaser = s.runner === 0 ? 1 : 0;
    if ((s.snakes[s.runner] as SnakeLike).body.length !== 4) {
      return '逃的蛇長度不是 4';
    }
    if ((s.snakes[chaser] as SnakeLike).body.length !== 1) {
      return '追的蛇長度不是 1';
    }
    return null;
  },
});

// C-J 關卡設計師：一邊控蛇、一邊當設計師（蓋牆），兩局交換。
// 設計師的「狀態」就是它蓋的牆（共用環境），所以 AI 當蛇的那一半，對手(設計師)與環境不可分，沒有可擾動的元件；
// AI 當設計師的那一半，對手是蛇（snakes[蛇的那一邊]）。
interface CJWorld extends Clubs {
  readonly snakeSide: number;
  readonly round: number;
  readonly roundTick: number;
  readonly foodIndex: number;
  readonly phase: string;
  readonly pause: number;
  readonly walls: readonly { readonly cells: readonly number[] }[];
}
export const C_J: CardSpec = defineSpec<CJWorld>('C-J', {
  comp: (side: Side, s?: CJWorld) =>
    s !== undefined && s.snakeSide === side ? [`snakes.${side}`] : [],
  teeth: snakeTeeth,
  donorOk: (q: CJWorld, d: CJWorld) =>
    q.round === d.round &&
    q.snakeSide === d.snakeSide &&
    q.roundTick === d.roundTick &&
    q.foodIndex === d.foodIndex &&
    q.phase === d.phase &&
    d.pause === 0,
  legal: (s: CJWorld, _ai: Side) =>
    snakesLegal(s, { minLen: 1, allowEmpty: true, blocked: s.walls.flatMap((w) => w.cells) }),
});

// C-4 霧：AI 只讀自己的 memory（記得的食物、各格最後看見的 tick、最近一次掃視看到的對手蛇身與蛇頭），
// 不讀 state 裡真的對手（小規格與 logic.ts 開頭明文）。對手的資訊經由「自己的 memory」進來，而 memory 是 AI 自己的狀態，
// 按定義不動；所以乾淨擾動只剩下兩種：對手在 AI 看不到的地方（AI 的 memory 本來就說沒看到它），
// 以及對手只差一步的位置（memory 最多落後一次走格）。其餘位置會讓 AI 的 memory 與真實矛盾，不合法。
// 搜尋型往前模擬時 `step` 會用真實的對手更新模擬裡的 memory，這是唯一剩下的洩漏管道。
interface FogWorld extends Clubs {
  readonly tick: number;
  readonly endAt: number;
  readonly memory: readonly { readonly rivalHead: number }[];
}
const manhattan = (a: number, b: number): number =>
  Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
export const C_4: CardSpec = defineSpec<FogWorld>('C-4', {
  comp: sideOf('snakes', 'memory', 'prevDir', 'ateAt'),
  teeth: (s: FogWorld, ai: Side) => [
    ...snakeTeeth(s, ai),
    // 蛇頭貼在 AI 蛇頭旁邊、而 AI 的 memory 說沒看到：矛盾。
    {
      name: '對手在視野內但 AI 的 memory 說沒看到',
      state: setAt(
        setAt(s, `memory.${ai}.rivalHead`, -1),
        `snakes.${ai === 0 ? 1 : 0}.body.0`,
        (s.snakes[ai] as SnakeLike).body[0] === 0
          ? 1
          : ((s.snakes[ai] as SnakeLike).body[0] as number) - 1,
      ),
    },
  ],
  legal: (s: FogWorld, ai: Side) => {
    const base = snakesLegal(s, { minLen: 3, allowDead: s.endAt >= 0 });
    if (base !== null) {
      return base;
    }
    const mine = (s.snakes[ai] as SnakeLike).body[0] as number;
    const theirs = (s.snakes[ai === 0 ? 1 : 0] as SnakeLike).body[0] as number;
    const seen = (s.memory[ai] as { rivalHead: number }).rivalHead;
    // 掃視發生在走格的那個 tick、用走格之前的位置（視野半徑 4）：沒看到＝當時距離 ≥ 5，之後兩邊各走一格，距離至少還有 3。
    if (seen < 0 && manhattan(mine, theirs) <= 2) {
      return '對手在視野內但 AI 的 memory 說沒看到';
    }
    if (seen >= 0 && manhattan(seen, theirs) > 2) {
      return 'AI 記得的對手位置離真實位置太遠';
    }
    return null;
  },
  notScreenable:
    'AI 只讀自己的 memory；對手的資訊經由 AI 自己的狀態（memory）進來，按定義不動，所以乾淨擾動只剩視野外與一步內的位置',
});

export const CLUBS_SPECS: readonly CardSpec[] = [C_A, C_2, C_3, C_4, C_5, C_8, C_10, C_J];
