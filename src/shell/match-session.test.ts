import { describe, expect, it } from 'vitest';

import { humanModel } from '../ai/human-model';
import { levelController, policyByName } from '../ai/level';
import { MATCH_CONFIG } from '../ai/evolution';
import { playMatch } from '../core/match';
import { replay } from '../core/replay';
import type { Buttons, Controller } from '../core/types';
import { c2Game, makeState as makeC2State } from '../games/C-2/logic';
import { cAGame } from '../games/C-A/logic';
import { cAMeta } from '../games/C-A/meta';
import { jkrGame } from '../games/JK-R/logic';
import { jkrMeta } from '../games/JK-R/meta';
import { counterGame } from '../../tests/fixtures/counter-game';
import { emptyButtons } from './input';
import {
  createMatchSession,
  createReplaySession,
  matchConfigFor,
  screenController,
  viewRotationOf,
} from './match-session';

const PRESS_A: Controller<unknown> = { decide: () => ({ ...emptyButtons(), a: true }) };
const IDLE: Controller<unknown> = { decide: () => emptyButtons() };

describe('shell/match-session：主迴圈與 playMatch 做同一件事（SPEC 第 6 節）', () => {
  it('counter-game：一個 tick 一個 tick 推進，結果與 playMatch 完全一樣', () => {
    const config = { maxTicks: 3600, params: {} };
    const expected = playMatch(counterGame, 7, config, PRESS_A, IDLE);
    const session = createMatchSession(counterGame, 7, config, PRESS_A, IDLE);
    while (!session.isOver()) {
      session.advance();
    }
    expect(session.tick()).toBe(expected.ticks);
    expect(session.inputs()).toEqual(expected.inputs);
    const replayed = replay(counterGame, 7, config, session.inputs());
    expect(replayed.finalHash).toBe(expected.finalHash);
    expect(replayed.score).toEqual(expected.score);
  });

  it('C-A：人類模型對 1 級搜尋型，逐 tick 推進的結果與 playMatch 的雜湊一致', () => {
    const seed = 3;
    const human = (): Controller<never> => humanModel(cAGame, seed);
    const ai = (): Controller<never> =>
      levelController(cAGame, policyByName('pathfinder'), 1, seed);
    const expected = playMatch(cAGame, seed, MATCH_CONFIG, human(), ai());
    const session = createMatchSession(cAGame, seed, MATCH_CONFIG, human(), ai());
    while (!session.isOver()) {
      session.advance();
    }
    const replayed = createReplaySession(cAGame, seed, MATCH_CONFIG, session.inputs());
    while (!replayed.isOver()) {
      replayed.advance();
    }
    expect(replayed.hash()).toBe(expected.finalHash);
    expect(replayed.tick()).toBe(expected.ticks);
  });

  it('遊戲結束之後再 advance 不會多跑（也不會丟錯）', () => {
    const config = { maxTicks: 3600, params: { length: 5 } };
    const session = createMatchSession(counterGame, 1, config, PRESS_A, IDLE);
    for (let i = 0; i < 20; i += 1) {
      session.advance();
    }
    expect(session.isOver()).toBe(true);
    expect(session.tick()).toBe(5);
    expect(session.inputs()).toHaveLength(5);
  });

  it('紀錄的是按鍵的副本，控制器之後改動回傳的物件不會污染紀錄', () => {
    const shared: Buttons = { ...emptyButtons(), a: true };
    const config = { maxTicks: 3600, params: { length: 3 } };
    const session = createMatchSession(counterGame, 1, config, { decide: () => shared }, IDLE);
    session.advance();
    shared.a = false;
    session.advance();
    expect(session.inputs()[0]?.[0].a).toBe(true);
    expect(session.inputs()[1]?.[0].a).toBe(false);
  });

  it('重播：紀錄用完遊戲就結束；重播不讀任何控制器', () => {
    const config = { maxTicks: 3600, params: {} };
    const original = createMatchSession(counterGame, 9, config, PRESS_A, IDLE);
    while (!original.isOver()) {
      original.advance();
    }
    const replayed = createReplaySession(counterGame, 9, config, original.inputs());
    expect(replayed.isOver()).toBe(false);
    while (!replayed.isOver()) {
      replayed.advance();
    }
    expect(replayed.tick()).toBe(original.tick());
    expect(replayed.state()).toEqual(original.state());
  });
});

describe('shell/match-session：C-2 的輸入轉換（外殼把畫面方向轉回世界方向）', () => {
  const press = (name: keyof Buttons): Buttons => ({ ...emptyButtons(), [name]: true });

  it('viewRotationOf：C-2 的 state 讀 viewRotation，其他牌一律是 0', () => {
    for (const r of [0, 1, 2, 3] as const) {
      expect(viewRotationOf(makeC2State({ viewRotation: r }))).toBe(r);
    }
    expect(viewRotationOf(counterGame.init(1, MATCH_CONFIG))).toBe(0);
    expect(viewRotationOf(cAGame.init(1, MATCH_CONFIG))).toBe(0);
    expect(viewRotationOf(null)).toBe(0);
  });

  it('screenController：viewRotation = 0 時按鍵原樣交出去', () => {
    const controller = screenController<unknown>(() => press('up'));
    expect(controller.decide(makeC2State({ viewRotation: 0 }), 0, 0)).toEqual(press('up'));
  });

  it('screenController：畫面轉了 1 次，按「畫面上的右」＝ 世界的上', () => {
    const controller = screenController<unknown>(() => press('right'));
    expect(controller.decide(makeC2State({ viewRotation: 1 }), 0, 0)).toEqual(press('up'));
  });

  it('screenController：每一種 viewRotation 下，按「畫面上的上」會讓蛇往畫面上方走', () => {
    // 世界方向轉 r 次之後出現在畫面上；把轉換後的輸入交給 step，再看世界裡蛇頭的移動方向。
    const expectedWorld = { 0: 'up', 1: 'left', 2: 'down', 3: 'right' } as const;
    for (const r of [0, 1, 2, 3] as const) {
      const state = makeC2State({ viewRotation: r, tick: r * 600 });
      const world = screenController<unknown>(() => press('up')).decide(state, 0, 0);
      expect(world).toEqual(press(expectedWorld[r]));
    }
  });

  it('接上 C-2 的 step：按著「畫面上的右」，viewRotation = 1 時蛇在世界裡轉向上', () => {
    const state = makeC2State({ viewRotation: 1, tick: 600 });
    const controller = screenController<unknown>(() => press('right'));
    const world = controller.decide(state, 0, 600);
    const next = c2Game.step(state, [world, emptyButtons()]);
    const direct = c2Game.step(state, [press('up'), emptyButtons()]);
    expect(next.snakes[0]).toEqual(direct.snakes[0]);
  });
});

describe('shell/match-session：每張牌的對局長度（JK-R 要 90 秒，SPEC 第 11 節）', () => {
  it('JK-R 的 meta.defaultMaxTicks 是 5400（90 秒 × 60 tick）', () => {
    expect(jkrMeta.defaultMaxTicks).toBe(5400);
  });

  it('外殼算出來的設定：JK-R 是 5400，沒有指定的牌（C-A）是共同設定的 3600', () => {
    expect(matchConfigFor(jkrMeta).maxTicks).toBe(5400);
    expect(cAMeta.defaultMaxTicks).toBeUndefined();
    expect(matchConfigFor(cAMeta).maxTicks).toBe(3600);
    expect(matchConfigFor(cAMeta)).toEqual(MATCH_CONFIG);
  });

  it('JK-R 照外殼的設定真的跑滿 5400 個 tick（不是 3600）才結束', () => {
    const session = createMatchSession(jkrGame, 1, matchConfigFor(jkrMeta), IDLE, IDLE);
    for (let i = 0; i < 3600; i += 1) {
      session.advance();
    }
    expect(session.isOver()).toBe(false);
    while (!session.isOver()) {
      session.advance();
    }
    expect(session.tick()).toBe(5400);
    expect(session.inputs()).toHaveLength(5400);
  });

  it('契約測試用的 3600 設定跑 JK-R 仍然在 3600 結束（logic 取 min）', () => {
    const session = createMatchSession(jkrGame, 1, MATCH_CONFIG, IDLE, IDLE);
    while (!session.isOver()) {
      session.advance();
    }
    expect(session.tick()).toBe(3600);
  });
});
