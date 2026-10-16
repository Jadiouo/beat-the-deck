import { describe, expect, it } from 'vitest';

import { gambler } from '../../src/ai/policies/gambler';
import type { PolicyParams } from '../../src/ai/types';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../src/core/types';

/**
 * 賭徒型與「必死」（DESIGN-AI-FUN 10.46）。
 *
 * 選單遊戲：每個動作有固定的 gain、danger，一步見分曉（與 policies.test.ts 同一個做法，不依賴真的牌）。
 * danger = 1 代表下一步必死（SPEC 5.1：「接下來會不會死」的估計，1 是確定）。
 */

const KEYS = ['up', 'down', 'left', 'right'] as const;
const PARAMS: PolicyParams = { depth: 1, seed: 1 };

interface Row {
  readonly gain: number;
  readonly danger: number;
}
interface MenuState {
  readonly tick: number;
  readonly base: number;
  readonly picked: number;
}

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

function menu(table: readonly Row[], base = 0): { game: Game<MenuState>; state: MenuState } {
  const game: Game<MenuState> = {
    id: 'menu',
    init: (_seed: number, config: GameConfig): MenuState => ({
      tick: 0,
      base: config.params['base'] ?? 0,
      picked: -1,
    }),
    step: (state: MenuState, inputs: Inputs): MenuState => ({
      ...state,
      tick: state.tick + 1,
      picked: indexOf(inputs[0]),
    }),
    isOver: (state: MenuState): boolean => state.tick >= 50,
    score: (): readonly [number, number] => [0, 0],
    winner: (): Side | null => null,
    actions: (): readonly Buttons[] => table.map((_row, i) => press(i)),
    evaluate: (state: MenuState): Row => {
      const row = table[state.picked];
      return row === undefined
        ? { gain: state.base, danger: 0 }
        : { gain: row.gain + state.base, danger: row.danger };
    },
  };
  return { game, state: game.init(0, { maxTicks: 100, params: { base } }) };
}

function choose(table: readonly Row[], base = 0): number {
  const { game, state } = menu(table, base);
  return indexOf(gambler.decide(game, state, 0, 0, PARAMS));
}

describe('賭徒型：必死不是風險，是確定的損失', () => {
  it('一個必死、一個安全：不選必死的（必死的 gain 比較高也一樣）', () => {
    expect(
      choose([
        { gain: 50, danger: 1 },
        { gain: 10, danger: 0 },
      ]),
    ).toBe(1);
  });

  it('落後很多的時候也不選必死的', () => {
    expect(
      choose(
        [
          { gain: 50, danger: 1 },
          { gain: 10, danger: 0 },
        ],
        -500,
      ),
    ).toBe(1);
  });

  it('必死的 gain 被大幅扣掉（梅花 DEATH_GAIN_PENALTY 的形狀）也不選它', () => {
    expect(
      choose([
        { gain: 10 - 10_000, danger: 1 },
        { gain: 10, danger: 0 },
        { gain: 9, danger: 0.3 },
      ]),
    ).not.toBe(0);
  });

  it('必死的排在最前面或最後面都一樣', () => {
    const safe = { gain: 10, danger: 0 };
    const dead = { gain: 80, danger: 1 };
    expect(choose([dead, safe])).toBe(1);
    expect(choose([safe, dead])).toBe(0);
  });

  it('只要有一個不必死的，就不會選到任何必死的（含 danger 0.99 的對照）', () => {
    const picked = choose([
      { gain: 100, danger: 1 },
      { gain: 100, danger: 1 },
      { gain: 1, danger: 0.99 },
    ]);
    expect(picked).toBe(2);
  });

  it('全部都必死：不丟錯，選 gain 最高的', () => {
    expect(
      choose([
        { gain: 3, danger: 1 },
        { gain: 9, danger: 1 },
        { gain: 5, danger: 1 },
      ]),
    ).toBe(1);
  });
});

describe('賭徒型仍然是賭徒型：偏好「不確定」', () => {
  it('兩個都不必死：gain 差不多時選 danger 較高（不確定）的那個', () => {
    expect(
      choose(
        [
          { gain: 10, danger: 0 },
          { gain: 10, danger: 0.8 },
        ],
        -50,
      ),
    ).toBe(1);
  });

  it('兩個都不必死：領先時 danger 0.5、gain 只差一點的，仍然被風險加成蓋過', () => {
    expect(
      choose([
        { gain: 10, danger: 0 },
        { gain: 9.5, danger: 0.5 },
        { gain: 0, danger: 0 },
      ]),
    ).toBe(1);
  });

  it('旁邊有一個必死的，不影響剩下兩個之間「選不確定的」', () => {
    expect(
      choose([
        { gain: 10, danger: 0 },
        { gain: 9.5, danger: 0.5 },
        { gain: 0, danger: 0 },
        { gain: 99, danger: 1 },
      ]),
    ).toBe(1);
  });

  it('旁邊有一個 gain 被扣到 −10000 的必死動作，也不影響範圍（不會把另外兩個的差距壓成零）', () => {
    // 若範圍還包含必死那個，兩個存活動作的 gain 差 1 相對於 10000 的範圍小到不計，
    // 效用比的就只剩 (1 + r·danger)，結果同樣選 1；這裡改用「gain 差大、danger 差小」確認取捨還在。
    expect(
      choose([
        { gain: 100, danger: 0 },
        { gain: 0, danger: 0.1 },
        { gain: -10_000, danger: 1 },
      ]),
    ).toBe(0);
  });

  it('沒有必死動作時，行為與舊公式完全相同（不該變的地方沒變）', () => {
    const tables: readonly (readonly Row[])[] = [
      [
        { gain: 10, danger: 0 },
        { gain: 9, danger: 0.5 },
      ],
      [
        { gain: 3, danger: 0.2 },
        { gain: 7, danger: 0.9 },
        { gain: 5, danger: 0.99 },
      ],
      [
        { gain: -4, danger: 0.1 },
        { gain: -9, danger: 0.7 },
      ],
      [
        { gain: 1, danger: 0 },
        { gain: 1, danger: 0 },
      ],
    ];
    for (const base of [0, -3, -100, 40]) {
      for (const table of tables) {
        expect(choose(table, base)).toBe(legacyChoice(table, base));
      }
    }
  });
});

describe('可重播', () => {
  it('同一個局面問兩次，答案相同', () => {
    const table: readonly Row[] = [
      { gain: 5, danger: 1 },
      { gain: 4, danger: 0.4 },
      { gain: 6, danger: 0.1 },
    ];
    const { game, state } = menu(table, -7);
    const first = gambler.decide(game, state, 0, 0, PARAMS);
    const second = gambler.decide(game, state, 0, 99, PARAMS);
    expect(second).toEqual(first);
  });
});

/** 舊公式（沒有必死過濾）的複本，只用來證明「沒有必死動作時結果不變」。 */
function legacyChoice(table: readonly Row[], base: number): number {
  const gains = table.map((row) => row.gain + base);
  const spread = Math.max(...gains) - Math.min(...gains);
  const scale = spread > 0 ? spread : 1;
  const floor = Math.min(...gains);
  const behind = Math.max(0, -base);
  const r = 1 + (3 * behind) / (behind + scale);
  let best = 0;
  let bestUtility = Number.NEGATIVE_INFINITY;
  table.forEach((row, i) => {
    const utility = ((gains[i] as number) - floor + scale) * (1 + r * row.danger);
    if (utility > bestUtility) {
      best = i;
      bestUtility = utility;
    }
  });
  return best;
}
