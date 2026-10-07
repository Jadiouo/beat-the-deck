import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';
import { counterGame } from '../../../tests/fixtures/counter-game';
import type { CounterState } from '../../../tests/fixtures/counter-game';
import { HUMAN_PARAMS, humanModel } from '../human-model';
import { gambler } from './gambler';
import { greedy } from './greedy';
import { pathfinder } from './pathfinder';
import { precise } from './precise';
import { random } from './random';
import type { Policy, PolicyParams } from '../types';

/**
 * 四種性格、random 與人類模型的單元測試。
 *
 * 用兩個假遊戲，不依賴任何真的牌（性格本來就不該知道自己在玩哪一張）：
 * - 選單遊戲：每個動作有固定的 gain、danger，一步見分曉，用來驗證各性格的取捨。
 * - 鏈遊戲：先蓄力再放，要往前看兩步才看得出來，用來驗證搜尋型真的在搜尋。
 */

const KEYS = ['up', 'down', 'left', 'right'] as const;

function press(index: number): Buttons {
  const buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
  const key = KEYS[index];
  if (key !== undefined) {
    buttons[key] = true;
  }
  return buttons;
}

function indexOf(buttons: Buttons): number {
  return KEYS.findIndex((key) => buttons[key]);
}

interface Row {
  readonly gain: number;
  readonly danger: number;
}

interface MenuState {
  readonly tick: number;
  readonly base: number;
  /** 兩邊上一個 tick 選的動作編號，-1 代表還沒選過。 */
  readonly picked: readonly [number, number];
}

/** 一步見分曉：evaluate 直接查表（表的列就是上一個 tick 選的動作）。 */
function menuGame(table: readonly Row[]): Game<MenuState> {
  return {
    id: 'menu',
    init: (_seed: number, config: GameConfig): MenuState => ({
      tick: 0,
      base: config.params['base'] ?? 0,
      picked: [-1, -1],
    }),
    step: (state: MenuState, inputs: Inputs): MenuState => ({
      ...state,
      tick: state.tick + 1,
      picked: [indexOf(inputs[0]), indexOf(inputs[1])],
    }),
    isOver: (state: MenuState): boolean => state.tick >= 50,
    score: (): readonly [number, number] => [0, 0],
    winner: (): Side | null => null,
    actions: (): readonly Buttons[] => table.map((_row, i) => press(i)),
    evaluate: (state: MenuState, side: Side): Row => {
      const row = table[state.picked[side]];
      return row === undefined
        ? { gain: state.base, danger: 0 }
        : { gain: row.gain + state.base, danger: row.danger };
    },
  };
}

function menuStart(table: readonly Row[], base = 0): { game: Game<MenuState>; state: MenuState } {
  const game = menuGame(table);
  return { game, state: game.init(0, { maxTicks: 100, params: { base } }) };
}

const PARAMS: PolicyParams = { depth: 1, seed: 1 };

/** 鏈遊戲：選 1 是蓄力（這步 0 分），蓄力之後選 0 得 10 分，平常選 0 只得 1 分。 */
interface ChainState {
  readonly tick: number;
  readonly gain: number;
  readonly charged: boolean;
}

const chainGame: Game<ChainState> = {
  id: 'chain',
  init: (): ChainState => ({ tick: 0, gain: 0, charged: false }),
  step: (state: ChainState, inputs: Inputs): ChainState => {
    const choice = indexOf(inputs[0]);
    return {
      tick: state.tick + 1,
      charged: choice === 1,
      gain: state.gain + (choice === 0 ? (state.charged ? 10 : 1) : 0),
    };
  },
  isOver: (state: ChainState): boolean => state.tick >= 20,
  score: (state: ChainState): readonly [number, number] => [state.gain, 0],
  winner: (): Side | null => null,
  actions: (): readonly Buttons[] => [press(0), press(1)],
  evaluate: (state: ChainState, side: Side): Row =>
    side === 0 ? { gain: state.gain, danger: 0 } : { gain: 0, danger: 0 },
};

describe('greedy 貪心型：只看一步的 gain，不看 danger', () => {
  it('選下一個 tick gain 最高的動作，就算那個動作很危險', () => {
    const { game, state } = menuStart([
      { gain: 1, danger: 0 },
      { gain: 5, danger: 0.95 },
      { gain: 3, danger: 0 },
    ]);
    expect(indexOf(greedy.decide(game, state, 0, 0, PARAMS))).toBe(1);
  });

  it('平手取 actions() 裡索引最小的', () => {
    const { game, state } = menuStart([
      { gain: 2, danger: 0.9 },
      { gain: 2, danger: 0 },
      { gain: 2, danger: 0.5 },
    ]);
    expect(indexOf(greedy.decide(game, state, 0, 0, PARAMS))).toBe(0);
  });
});

describe('precise 精準型：先排除危險的，剩下的選 gain 最高', () => {
  it('danger 超過門檻的動作被排除，即使它 gain 最高', () => {
    const { game, state } = menuStart([
      { gain: 1, danger: 0 },
      { gain: 5, danger: 0.9 },
      { gain: 3, danger: 0.1 },
    ]);
    expect(indexOf(precise.decide(game, state, 0, 0, PARAMS))).toBe(2);
  });

  it('門檻以內的動作之間，選 gain 最高的', () => {
    const { game, state } = menuStart([
      { gain: 1, danger: 0.05 },
      { gain: 4, danger: 0.2 },
      { gain: 3, danger: 0 },
    ]);
    expect(indexOf(precise.decide(game, state, 0, 0, PARAMS))).toBe(1);
  });

  it('全部都超過門檻時，退而選最不危險的', () => {
    const { game, state } = menuStart([
      { gain: 9, danger: 0.9 },
      { gain: 1, danger: 0.6 },
      { gain: 5, danger: 0.7 },
    ]);
    expect(indexOf(precise.decide(game, state, 0, 0, PARAMS))).toBe(1);
  });
});

describe('gambler 賭徒型：偏好風險，落後越多越敢賭', () => {
  const table: readonly Row[] = [
    { gain: 10, danger: 0 },
    { gain: 9, danger: 0.5 },
  ];

  it('不落後的時候：差一點點的 gain 贏過風險的加成（選穩的）', () => {
    const { game, state } = menuStart(table, 0);
    expect(indexOf(gambler.decide(game, state, 0, 0, PARAMS))).toBe(0);
  });

  it('落後很多的時候：同一張表，改選危險的那個', () => {
    const { game, state } = menuStart(table, -100);
    expect(indexOf(gambler.decide(game, state, 0, 0, PARAMS))).toBe(1);
  });

  it('比 greedy 愛冒險：gain 差不多時選 danger 較高的', () => {
    const { game, state } = menuStart(
      [
        { gain: 10, danger: 0 },
        { gain: 10, danger: 0.8 },
      ],
      -50,
    );
    // greedy 平手取索引小的（0）；賭徒偏好風險，選 1。
    expect(indexOf(greedy.decide(game, state, 0, 0, PARAMS))).toBe(0);
    expect(indexOf(gambler.decide(game, state, 0, 0, PARAMS))).toBe(1);
  });
});

describe('pathfinder 搜尋型：往前模擬 depth 步，選終點 gain − w·danger 最高的第一步', () => {
  it('depth 1 只看一步：選眼前 gain 高的（不蓄力）', () => {
    const state = chainGame.init(0, { maxTicks: 100, params: {} });
    expect(indexOf(pathfinder.decide(chainGame, state, 0, 0, { depth: 1, seed: 1 }))).toBe(0);
  });

  it('depth 2 看得到蓄力之後的 10 分：第一步選蓄力', () => {
    const state = chainGame.init(0, { maxTicks: 100, params: {} });
    expect(indexOf(pathfinder.decide(chainGame, state, 0, 0, { depth: 2, seed: 1 }))).toBe(1);
  });

  it('depth 6 一樣看得到（越深不會變笨）', () => {
    const state = chainGame.init(0, { maxTicks: 100, params: {} });
    expect(indexOf(pathfinder.decide(chainGame, state, 0, 0, { depth: 6, seed: 1 }))).toBe(1);
  });

  it('危險的路徑要被扣分：gain 5 但 danger 1 輸給 gain 3 且安全', () => {
    const { game, state } = menuStart([
      { gain: 3, danger: 0 },
      { gain: 5, danger: 1 },
    ]);
    expect(indexOf(pathfinder.decide(game, state, 0, 0, PARAMS))).toBe(0);
  });

  it('危險不大的時候，高 gain 贏（不是膽小鬼）', () => {
    const { game, state } = menuStart([
      { gain: 3, danger: 0 },
      { gain: 5, danger: 0.05 },
    ]);
    expect(indexOf(pathfinder.decide(game, state, 0, 0, PARAMS))).toBe(1);
  });

  it('遊戲在搜尋途中結束也不會出錯（終局的 state 直接當終點）', () => {
    let state = chainGame.init(0, { maxTicks: 100, params: {} });
    for (let i = 0; i < 19; i += 1) {
      state = chainGame.step(state, [press(0), press(0)]);
    }
    expect(() => pathfinder.decide(chainGame, state, 0, 19, { depth: 6, seed: 1 })).not.toThrow();
  });
});

describe('random 基準線', () => {
  it('回傳 actions() 裡的某一個，三個動作大致均勻', () => {
    const { game, state } = menuStart([
      { gain: 0, danger: 0 },
      { gain: 0, danger: 0 },
      { gain: 0, danger: 0 },
    ]);
    const counts = [0, 0, 0];
    for (let tick = 0; tick < 3000; tick += 1) {
      const chosen = indexOf(random.decide(game, state, 0, tick, { depth: 1, seed: 4 }));
      expect(chosen).toBeGreaterThanOrEqual(0);
      counts[chosen] = (counts[chosen] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });

  it('同樣的種子與 tick 永遠同一個答案；不同種子不全相同', () => {
    const { game, state } = menuStart(Array.from({ length: 4 }, () => ({ gain: 0, danger: 0 })));
    const run = (seed: number): number[] =>
      Array.from({ length: 40 }, (_v, tick) =>
        indexOf(random.decide(game, state, 1, tick, { depth: 1, seed })),
      );
    expect(run(8)).toEqual(run(8));
    expect(run(8)).not.toEqual(run(9));
  });
});

describe('每一種性格都是純的、而且不認得牌', () => {
  const policies: readonly Policy[] = [pathfinder, precise, greedy, gambler, random];

  it.each(policies.map((policy) => [policy.name, policy] as const))(
    '%s：同樣的輸入同樣的輸出，而且不改動傳進來的 state',
    (_name, policy) => {
      const { game, state } = menuStart([
        { gain: 2, danger: 0.4 },
        { gain: 3, danger: 0.7 },
        { gain: 1, danger: 0 },
      ]);
      const before = JSON.stringify(state);
      const a = policy.decide(game, state, 1, 17, { depth: 3, seed: 5 });
      const b = policy.decide(game, state, 1, 17, { depth: 3, seed: 5 });
      expect(a).toEqual(b);
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  it.each(policies.map((policy) => [policy.name, policy] as const))(
    '%s：在 counter-game 上永遠回傳 actions() 裡的某一個，兩邊都行',
    (_name, policy) => {
      let state: CounterState = counterGame.init(1, { maxTicks: 100, params: {} });
      for (let tick = 0; tick < 30; tick += 1) {
        for (const side of [0, 1] as const) {
          const chosen = policy.decide(counterGame, state, side, tick, { depth: 4, seed: 2 });
          expect(counterGame.actions(state, side)).toContainEqual(chosen);
        }
        state = counterGame.step(state, [press(0), press(0)]);
      }
    },
  );

  it('原始碼裡沒有任何「看是哪張牌」的東西：不讀 game.id、不讀 meta、不 switch 在牌上', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/\.id\b/);
      expect(text, file).not.toMatch(/\bmeta\b/);
      expect(text, file).not.toMatch(/registry/);
      expect(text, file).not.toMatch(/from ['"][^'"]*games\//);
    }
  });
});

describe('在 counter-game 上實際打得動', () => {
  it.each([pathfinder, precise, greedy, gambler].map((p) => [p.name, p] as const))(
    '%s 一直按 A（這是這個遊戲唯一合理的做法）',
    (_name, policy) => {
      const state = counterGame.init(1, { maxTicks: 100, params: {} });
      const decided = policy.decide(counterGame, state, 0, 0, { depth: 4, seed: 2 });
      expect(decided.a).toBe(true);
    },
  );
});

describe('human-model 人類模型（SPEC 7.3）', () => {
  it('參數：12 tick 反應、每 6 個 tick 才換動作、8% 按錯、只看一步', () => {
    expect(HUMAN_PARAMS).toEqual({ reactionTicks: 12, decideEvery: 6, depth: 1, epsilon: 0.08 });
  });

  it('同一個種子完全決定性', () => {
    const run = (): Buttons[] => {
      const controller = humanModel(counterGame, 31);
      let state = counterGame.init(1, { maxTicks: 100, params: {} });
      const out: Buttons[] = [];
      for (let t = 0; t < 100; t += 1) {
        const pressed = controller.decide(state, 0, t);
        out.push(pressed);
        state = counterGame.step(state, [pressed, pressed]);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

// ---------------------------------------------------------------------------
// 前瞻（depth）：precise、greedy、gambler 也讀 depth，只改「看多遠」、不改「偏好什麼」
// ---------------------------------------------------------------------------

/**
 * 「第一個選擇鎖定整張表」的選單：第一次選的動作決定之後每個 tick 的 gain 與 danger，
 * 之後選什麼都一樣。所以任何深度看到的表都與一步看到的相同，
 * 用來驗證三種性格在 depth 6 的偏好沒有被改掉。
 */
interface LockedState {
  readonly tick: number;
  readonly base: number;
  readonly first: number;
}

function lockedMenu(
  table: readonly Row[],
  base = 0,
): { game: Game<LockedState>; state: LockedState } {
  const game: Game<LockedState> = {
    id: 'locked-menu',
    init: (_seed: number, config: GameConfig): LockedState => ({
      tick: 0,
      base: config.params['base'] ?? 0,
      first: -1,
    }),
    step: (state: LockedState, inputs: Inputs): LockedState => ({
      ...state,
      tick: state.tick + 1,
      first: state.first >= 0 ? state.first : indexOf(inputs[0]),
    }),
    isOver: (state: LockedState): boolean => state.tick >= 50,
    score: (): readonly [number, number] => [0, 0],
    winner: (): Side | null => null,
    actions: (): readonly Buttons[] => table.map((_row, i) => press(i)),
    evaluate: (state: LockedState): Row => {
      const row = table[state.first];
      return row === undefined
        ? { gain: state.base, danger: 0 }
        : { gain: row.gain + state.base, danger: row.danger };
    },
  };
  return { game, state: game.init(0, { maxTicks: 100, params: { base } }) };
}

/**
 * 陷阱遊戲：階段 0 選動作 0 得 1 分並進入階段 1；階段 1 不管選什麼都進入階段 2，階段 2 的 danger 是 1。
 * 一步看不出陷阱（動作 0 眼前 gain 1、danger 0），兩步才看得到。
 */
interface TrapState {
  readonly tick: number;
  readonly stage: 0 | 1 | 2;
  readonly gain: number;
}

const trapGame: Game<TrapState> = {
  id: 'trap',
  init: (): TrapState => ({ tick: 0, stage: 0, gain: 0 }),
  step: (state: TrapState, inputs: Inputs): TrapState => {
    const choice = indexOf(inputs[0]);
    if (state.stage === 0) {
      return choice === 0
        ? { tick: state.tick + 1, stage: 1, gain: state.gain + 1 }
        : { tick: state.tick + 1, stage: 0, gain: state.gain };
    }
    return { tick: state.tick + 1, stage: 2, gain: state.gain };
  },
  isOver: (state: TrapState): boolean => state.tick >= 20,
  score: (state: TrapState): readonly [number, number] => [state.gain, 0],
  winner: (): Side | null => null,
  actions: (): readonly Buttons[] => [press(0), press(1)],
  evaluate: (state: TrapState, side: Side): Row =>
    side === 0 ? { gain: state.gain, danger: state.stage === 2 ? 1 : 0 } : { gain: 0, danger: 0 },
};

describe('depth 對 precise、greedy、gambler 也有作用', () => {
  const chainStart = (): ChainState => chainGame.init(0, { maxTicks: 100, params: {} });
  const trapStart = (): TrapState => trapGame.init(0, { maxTicks: 100, params: {} });

  it('greedy：depth 1 眼前 gain 高的，depth 2 看到蓄力之後的 10 分', () => {
    expect(indexOf(greedy.decide(chainGame, chainStart(), 0, 0, { depth: 1, seed: 1 }))).toBe(0);
    expect(indexOf(greedy.decide(chainGame, chainStart(), 0, 0, { depth: 2, seed: 1 }))).toBe(1);
    expect(indexOf(greedy.decide(chainGame, chainStart(), 0, 0, { depth: 6, seed: 1 }))).toBe(1);
  });

  it('gambler：depth 1 眼前 gain 高的，depth 2 看到蓄力之後的 10 分', () => {
    expect(indexOf(gambler.decide(chainGame, chainStart(), 0, 0, { depth: 1, seed: 1 }))).toBe(0);
    expect(indexOf(gambler.decide(chainGame, chainStart(), 0, 0, { depth: 2, seed: 1 }))).toBe(1);
  });

  it('precise：depth 1 看不出陷阱（選動作 0），depth 2 看到無路可逃的危險，改選 1', () => {
    expect(indexOf(precise.decide(trapGame, trapStart(), 0, 0, { depth: 1, seed: 1 }))).toBe(0);
    expect(indexOf(precise.decide(trapGame, trapStart(), 0, 0, { depth: 2, seed: 1 }))).toBe(1);
    expect(indexOf(precise.decide(trapGame, trapStart(), 0, 0, { depth: 6, seed: 1 }))).toBe(1);
  });

  it('greedy 不看 danger：同一個陷阱，depth 6 仍然一頭栽進去', () => {
    expect(indexOf(greedy.decide(trapGame, trapStart(), 0, 0, { depth: 6, seed: 1 }))).toBe(0);
  });

  const deep: PolicyParams = { depth: 6, seed: 1 };

  it('depth 6 時偏好沒變：greedy 仍選 gain 最高的、不看 danger', () => {
    const { game, state } = lockedMenu([
      { gain: 1, danger: 0 },
      { gain: 5, danger: 0.95 },
      { gain: 3, danger: 0 },
    ]);
    expect(indexOf(greedy.decide(game, state, 0, 0, deep))).toBe(1);
  });

  it('depth 6 時偏好沒變：precise 仍排除危險的、再選 gain 最高的', () => {
    const { game, state } = lockedMenu([
      { gain: 1, danger: 0 },
      { gain: 5, danger: 0.9 },
      { gain: 3, danger: 0.1 },
    ]);
    expect(indexOf(precise.decide(game, state, 0, 0, deep))).toBe(2);
    const allBad = lockedMenu([
      { gain: 9, danger: 0.9 },
      { gain: 1, danger: 0.6 },
      { gain: 5, danger: 0.7 },
    ]);
    expect(indexOf(precise.decide(allBad.game, allBad.state, 0, 0, deep))).toBe(1);
  });

  it('depth 6 時偏好沒變：gambler 落後才賭，不落後選穩的', () => {
    const table: readonly Row[] = [
      { gain: 10, danger: 0 },
      { gain: 9, danger: 0.5 },
    ];
    const even = lockedMenu(table, 0);
    const behind = lockedMenu(table, -100);
    expect(indexOf(gambler.decide(even.game, even.state, 0, 0, deep))).toBe(0);
    expect(indexOf(gambler.decide(behind.game, behind.state, 0, 0, deep))).toBe(1);
  });

  it('depth 1 與舊的一步版完全相同：三種性格在選單遊戲上對每個 depth 1 的輸入給同樣的答案', () => {
    const tables: readonly (readonly Row[])[] = [
      [
        { gain: 2, danger: 0.9 },
        { gain: 2, danger: 0 },
        { gain: 2, danger: 0.5 },
      ],
      [
        { gain: 9, danger: 0.9 },
        { gain: 1, danger: 0.6 },
        { gain: 5, danger: 0.7 },
      ],
      [
        { gain: 1, danger: 0.05 },
        { gain: 4, danger: 0.2 },
        { gain: 3, danger: 0 },
      ],
    ];
    for (const table of tables) {
      const { game, state } = menuStart(table);
      const locked = lockedMenu(table);
      for (const policy of [precise, greedy, gambler]) {
        expect(
          indexOf(policy.decide(locked.game, locked.state, 0, 0, { depth: 1, seed: 1 })),
          policy.name,
        ).toBe(indexOf(policy.decide(game, state, 0, 0, PARAMS)));
      }
    }
  });

  it.each([precise, greedy, gambler].map((p) => [p.name, p] as const))(
    '%s：前瞻不改動傳進來的 state，遊戲在途中結束也不會出錯',
    (_name, policy) => {
      let state = chainGame.init(0, { maxTicks: 100, params: {} });
      for (let i = 0; i < 19; i += 1) {
        state = chainGame.step(state, [press(0), press(0)]);
      }
      const before = JSON.stringify(state);
      expect(() => policy.decide(chainGame, state, 0, 19, { depth: 6, seed: 1 })).not.toThrow();
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  it('depth 6 的成本有上限：每次 decide 呼叫 step 的次數不超過 b · max(b, 4) · d', () => {
    let calls = 0;
    const counting: Game<TrapState> = {
      ...trapGame,
      step: (state, inputs) => {
        calls += 1;
        return trapGame.step(state, inputs);
      },
    };
    for (const policy of [precise, greedy, gambler, pathfinder]) {
      calls = 0;
      policy.decide(counting, trapStart(), 0, 0, { depth: 6, seed: 1 });
      expect(calls, policy.name).toBeLessThanOrEqual(2 * 4 * 6);
    }
  });
});
