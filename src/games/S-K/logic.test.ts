import { describe, expect, it, vi } from 'vitest';

import { levelController, wrapPolicy } from '../../ai/level';
import { gambler } from '../../ai/policies/gambler';
import { greedy } from '../../ai/policies/greedy';
import { pathfinder } from '../../ai/policies/pathfinder';
import { precise } from '../../ai/policies/precise';
import type { Policy } from '../../ai/types';
import { copyButtons, playMatch } from '../../core/match';
import type { Buttons, Inputs, Side } from '../../core/types';
import {
  asRenderingContext,
  createFakeContext,
  LOGIC_HEIGHT,
  LOGIC_WIDTH,
} from '../../../tests/contract/fake-context';
import { deepFreeze } from '../../../tests/contract/freeze';
import { COLOR } from '../../shell/palette';
import { makeState as makeS3 } from '../S-3/logic';
import {
  FINAL_WEIGHT,
  FULL_TICKS,
  MIN_MAX_TICKS,
  PICK_TICKS,
  REST_TICKS,
  SEGMENTS,
  SHOW_TICKS,
  marginMilli,
  makeState,
  segmentSeed,
  skGame,
} from './logic';
import type { SKLedgerEntry, SKState } from './logic';
import { skMeta } from './meta';
import { FINAL, POOL, poolEntry, sigmaLabel } from './pool';
import { skRender } from './render';

/**
 * S-K 黑桃馬拉松的規則測試（小規格 `docs/cards/S-K.md`）。
 *
 * S-K 是變化牌（DESIGN-AI-FUN 10.27）：選牌層自己沒有 AI 互動，互動借自被包的牌。這裡的測試釘住的是
 * 「包裝」本身：賽程、選牌、委派、結算（每一段只結算一次、之後不被重算）、純度與不可變、
 * evaluate 只算目前這一段（A5 的成本不疊加），以及選牌的 evaluate／actions 排序一致。
 *
 * `CONFIG.maxTicks = 5400`（`meta.defaultMaxTicks`）≥ `FULL_TICKS`，所以步調是 1，每一段都是完整長度。
 */

const CONFIG = { maxTicks: 5400, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];
const KEYS = ['up', 'down', 'left', 'right'] as const;

function press(index: number): Buttons {
  return { ...NONE, [KEYS[index] as string]: true };
}

/** 讓 `side` 按第 `index` 個候選牌的鍵，另一邊不按。 */
function pickInputs(side: Side, index: number): Inputs {
  return side === 0 ? [press(index), NONE] : [NONE, press(index)];
}

function run(state: SKState, ticks: number, inputs: Inputs = IDLE): SKState {
  let current = state;
  for (let i = 0; i < ticks; i += 1) {
    current = skGame.step(current, inputs);
  }
  return current;
}

/** 一直走到 `phase` 變成 `target`（不超過 `limit` 個 tick）。 */
function runUntil(
  state: SKState,
  done: (s: SKState) => boolean,
  inputs: Inputs = IDLE,
  limit = 6000,
): SKState {
  let current = state;
  for (let i = 0; i < limit && !done(current); i += 1) {
    current = skGame.step(current, inputs);
  }
  return current;
}

/** 打完一整場：挑牌人每次按第 `index` 個鍵，遊戲階段誰都不按。回傳每個 tick 後的狀態快照（只留階段切換時）。 */
function playAll(seed: number, index = 0): { final: SKState; snapshots: SKState[] } {
  let state = skGame.init(seed, CONFIG);
  const snapshots: SKState[] = [state];
  let guard = 0;
  while (!skGame.isOver(state) && guard < 7000) {
    const before = state;
    const inputs: Inputs =
      state.phase === 'pick' && state.picker !== null && state.armed
        ? pickInputs(state.picker, index)
        : IDLE;
    state = skGame.step(state, inputs);
    if (state.phase !== before.phase) {
      snapshots.push(state);
    }
    guard += 1;
  }
  return { final: state, snapshots };
}

/** 固定的偽隨機輸入（與遊戲無關）。 */
function randomInputs(seed: number, length: number): Inputs[] {
  let x = (seed + 1) * 2654435761;
  const next = (): number => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return x / 4294967296;
  };
  const one = (): Buttons => ({
    up: next() < 0.35,
    down: next() < 0.35,
    left: next() < 0.35,
    right: next() < 0.35,
    a: next() < 0.35,
    b: next() < 0.35,
  });
  return Array.from({ length }, () => [one(), one()] as const);
}

function entryOf(cardId: string, mm: number, extra: Partial<SKLedgerEntry> = {}): SKLedgerEntry {
  const card = poolEntry(cardId);
  return {
    cardId,
    family: card.family,
    picker: 0,
    weight: 1,
    mm,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// init 與賽程
// ---------------------------------------------------------------------------

describe('S-K 黑桃馬拉松｜init 與賽程', () => {
  it('常數：5 段、決勝權重 2、決勝是 S-5、最壞總長不超過 meta 的預設長度 5400', () => {
    expect(SEGMENTS).toBe(5);
    expect(FINAL_WEIGHT).toBe(2);
    expect(FINAL.id).toBe('S-5');
    expect(FINAL.params).toEqual({ target: 3 });
    expect(FULL_TICKS).toBeLessThanOrEqual(skMeta.defaultMaxTicks as number);
    expect(MIN_MAX_TICKS).toBeLessThan(3600);
  });

  it('牌池：只有已實作而且對稱的黑桃牌；S-5 不在池裡；S-A、S-2、S-10、S-6 不在池裡；至少 7 張', () => {
    const ids = POOL.map((p) => p.id);
    expect(ids).not.toContain('S-5');
    for (const dead of ['S-A', 'S-2', 'S-10', 'S-6', 'S-K']) {
      expect(ids).not.toContain(dead);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(7);
    for (const p of POOL) {
      expect(p.id).toMatch(/^S-/);
      expect(p.game.id).toBe(p.id);
      expect(p.sprintTicks).toBeGreaterThan(0);
      expect(p.scale).toBeGreaterThanOrEqual(1);
      expect(p.sigma).toBeGreaterThanOrEqual(0);
      expect(p.sigma).toBeLessThanOrEqual(1);
    }
  });

  it('開局：第 0 段、挑牌階段、tick 0、有 4 張候選牌（不重複、都在池裡）、ledger 是空的、沒有 cardId', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const s = skGame.init(seed, CONFIG);
      expect(s.phase).toBe('pick');
      expect(s.seg).toBe(0);
      expect(s.tick).toBe(0);
      expect(s.phaseTick).toBe(0);
      expect(s.cardId).toBeNull();
      expect(s.inner).toBeNull();
      expect(s.ledger).toEqual([]);
      expect(s.offer).toHaveLength(4);
      expect(new Set(s.offer).size).toBe(4);
      for (const id of s.offer) {
        expect(POOL.map((p) => p.id)).toContain(id);
      }
      expect([0, 1]).toContain(s.picker);
    }
  });

  it('第一個挑牌人由種子決定、但不是種子的奇偶（否則 A 類檢查裡被測的那一邊永遠先挑）；兩種都會出現', () => {
    const firsts = Array.from({ length: 40 }, (_v, seed) => skGame.init(seed, CONFIG).picker);
    expect(new Set(firsts).size).toBe(2);
    const sameAsParity = firsts.filter((p, seed) => p === seed % 2).length;
    expect(sameAsParity).toBeGreaterThan(8);
    expect(sameAsParity).toBeLessThan(32);
  });

  it('不同種子的候選牌不全相同（種子有效）', () => {
    const offers = new Set(
      Array.from({ length: 20 }, (_v, seed) => skGame.init(seed, CONFIG).offer.join(',')),
    );
    expect(offers.size).toBeGreaterThan(3);
  });

  it('maxTicks 小於 MIN_MAX_TICKS 丟 RangeError；剛好等於不丟', () => {
    expect(() => skGame.init(0, { maxTicks: MIN_MAX_TICKS - 1, params: {} })).toThrow(RangeError);
    expect(() => skGame.init(0, { maxTicks: MIN_MAX_TICKS, params: {} })).not.toThrow();
    expect(() => skGame.init(0, { maxTicks: Number.NaN, params: {} })).toThrow(RangeError);
  });

  it('maxTicks 3600（契約測試的長度）：步調小於 1，一場一定在 3600 內結束', () => {
    const config = { maxTicks: 3600, params: {} };
    const s0 = skGame.init(3, config);
    expect(s0.pace).toBeLessThan(1);
    expect(s0.pace).toBeGreaterThan(0.5);
    let state = s0;
    for (let i = 0; i < 3600 && !skGame.isOver(state); i += 1) {
      state = skGame.step(
        state,
        state.phase === 'pick' && state.picker !== null ? pickInputs(state.picker, 0) : IDLE,
      );
    }
    expect(skGame.isOver(state)).toBe(true);
    expect(state.tick).toBeLessThanOrEqual(3600);
  });
});

// ---------------------------------------------------------------------------
// 選牌階段
// ---------------------------------------------------------------------------

describe('S-K 黑桃馬拉松｜選牌階段', () => {
  const start = (seed = 0): SKState => skGame.init(seed, CONFIG);

  it('非挑牌人的輸入被忽略：不管按什麼，state 和沒按一樣（除了 tick 往前）', () => {
    const s = start();
    const other: Side = s.picker === 0 ? 1 : 0;
    const spam: Buttons = { up: true, down: true, left: true, right: true, a: true, b: true };
    const inputs: Inputs = other === 0 ? [spam, NONE] : [NONE, spam];
    expect(skGame.step(s, inputs)).toEqual(skGame.step(s, IDLE));
  });

  it('挑牌人按 ↑↓←→ 分別鎖定第 0、1、2、3 張候選牌，進入 show 階段、cardId 公開', () => {
    for (let index = 0; index < 4; index += 1) {
      const s = start(2);
      const picked = skGame.step(s, pickInputs(s.picker as Side, index));
      expect(picked.phase).toBe('show');
      expect(picked.cardId).toBe(s.offer[index]);
      expect(picked.phaseTick).toBe(0);
    }
  });

  it('沒按鍵就繼續等；逾時（PICK_TICKS）自動鎖定第 0 張', () => {
    let s = start(4);
    s = run(s, PICK_TICKS - 1);
    expect(s.phase).toBe('pick');
    s = skGame.step(s, IDLE);
    expect(s.phase).toBe('show');
    expect(s.cardId).toBe(start(4).offer[0]);
  });

  it('同時按多個鍵：取 ↑↓←→ 順序最前面的那個', () => {
    const s = start();
    const both: Buttons = { ...NONE, down: true, left: true };
    const picked = skGame.step(s, s.picker === 0 ? [both, NONE] : [NONE, both]);
    expect(picked.cardId).toBe(s.offer[1]);
  });

  it('只按 a、b 不算挑牌', () => {
    const s = start();
    const ab: Buttons = { ...NONE, a: true, b: true };
    expect(skGame.step(s, s.picker === 0 ? [ab, NONE] : [NONE, ab]).phase).toBe('pick');
  });

  it('開局的第一次挑牌可以立刻按；之後的挑牌階段一開始是「還沒放開」，上一段按著的鍵不會直接鎖定', () => {
    const first = skGame.init(1, CONFIG);
    expect(first.armed).toBe(true);
    // 第二次挑牌：上一段的 rest 結束、進入 pick
    const done = makeState({
      first: 0,
      phase: 'rest',
      seg: 0,
      phaseTick: REST_TICKS - 1,
      ledger: [entryOf('S-3', 0)],
      cardId: 'S-3',
    });
    const next = skGame.step(done, IDLE);
    expect(next.phase).toBe('pick');
    expect(next.armed).toBe(false);
    const picker = next.picker as Side;
    // 一直按著 ↓：不鎖定
    const held = run(next, 20, pickInputs(picker, 1));
    expect(held.phase).toBe('pick');
    expect(held.armed).toBe(false);
    // 放開一個 tick 之後再按：鎖定
    const released = skGame.step(held, IDLE);
    expect(released.armed).toBe(true);
    expect(released.phase).toBe('pick');
    const locked = skGame.step(released, pickInputs(picker, 1));
    expect(locked.phase).toBe('show');
    expect(locked.cardId).toBe(next.offer[1]);
  });

  it('一直按著不放：逾時照樣自動鎖定第 0 張（一場一定結束）', () => {
    const done = makeState({
      first: 0,
      phase: 'rest',
      seg: 0,
      phaseTick: REST_TICKS - 1,
      ledger: [entryOf('S-3', 0)],
      cardId: 'S-3',
    });
    const next = skGame.step(done, IDLE);
    const held = run(next, PICK_TICKS, pickInputs(next.picker as Side, 2));
    expect(held.phase).toBe('show');
    expect(held.cardId).toBe(next.offer[0]);
  });

  it('候選牌少於 4 張時，按到沒有的鍵不算挑牌', () => {
    const s = makeState({ offer: ['S-3', 'S-7'] });
    expect(skGame.step(s, pickInputs(s.picker as Side, 3)).phase).toBe('pick');
    expect(skGame.step(s, pickInputs(s.picker as Side, 1)).cardId).toBe('S-7');
  });

  it('show 階段雙方都不能動（輸入被忽略）；SHOW_TICKS 之後進入 play，inner 是那張牌用段種子開的新局', () => {
    const s0 = start(5);
    const locked = skGame.step(s0, pickInputs(s0.picker as Side, 2));
    const spam: Buttons = { up: true, down: true, left: true, right: true, a: true, b: true };
    expect(run(locked, 3, [spam, spam])).toEqual(run(locked, 3, IDLE));
    const playing = run(locked, SHOW_TICKS);
    expect(playing.phase).toBe('play');
    const card = poolEntry(playing.cardId as string);
    expect(playing.inner).toEqual(
      card.game.init(segmentSeed(5, 0), { maxTicks: playing.segMax, params: card.params ?? {} }),
    );
    expect(playing.segMax).toBe(card.sprintTicks);
  });

  it('挑牌人輪流：第 1、3 段是 first，第 2、4 段是另一邊；每人各挑 2 次；第 5 段（決勝）沒有挑牌人', () => {
    const { snapshots } = playAll(7);
    const pickers = snapshots.filter((s) => s.phase === 'pick').map((s) => s.picker);
    expect(pickers).toHaveLength(4);
    const first = pickers[0] as Side;
    expect(pickers).toEqual([first, 1 - first, first, 1 - first]);
    const finalShow = snapshots.filter((s) => s.phase === 'show' && s.seg === 4);
    expect(finalShow).toHaveLength(1);
    expect(finalShow[0]?.picker).toBeNull();
    expect(finalShow[0]?.cardId).toBe('S-5');
  });

  it('候選牌每次都來自還沒打過的牌；打過的不會再出現；種子 0..39 全部檢查', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const { snapshots, final } = playAll(seed, seed % 4);
      const played: string[] = [];
      for (const s of snapshots) {
        if (s.phase === 'pick') {
          for (const id of s.offer) {
            expect(played, `種子 ${seed} 第 ${s.seg} 段`).not.toContain(id);
          }
          expect(new Set(s.offer).size).toBe(s.offer.length);
        }
        if (s.phase === 'show' && s.cardId !== null && s.seg < 4) {
          played.push(s.cardId);
        }
      }
      expect(new Set(played).size).toBe(4);
      expect(final.ledger.map((e) => e.cardId).slice(0, 4)).toEqual(played);
    }
  });

  it('候選牌的張數：前 3 次 4 張；牌池 7 張時第 4 次還有 4 張可挑（剩 4 張全給）', () => {
    const { snapshots } = playAll(1);
    const sizes = snapshots.filter((s) => s.phase === 'pick').map((s) => s.offer.length);
    expect(sizes).toEqual([4, 4, 4, 4]);
  });
});

// ---------------------------------------------------------------------------
// 委派
// ---------------------------------------------------------------------------

describe('S-K 黑桃馬拉松｜遊戲階段轉發給被包的牌', () => {
  function toPlay(seed: number, index: number): SKState {
    const s0 = skGame.init(seed, CONFIG);
    const locked = skGame.step(s0, pickInputs(s0.picker as Side, index));
    return run(locked, SHOW_TICKS);
  }

  it('inner 與直接跑那張牌的 step 一致（每張池裡的牌各一次，輸入是固定的偽隨機）', () => {
    for (const card of POOL) {
      // 找到一個能挑到這張牌的種子與鍵
      let found: { seed: number; index: number } | null = null;
      for (let seed = 0; seed < 60 && found === null; seed += 1) {
        const index = skGame.init(seed, CONFIG).offer.indexOf(card.id);
        if (index >= 0) {
          found = { seed, index };
        }
      }
      expect(found, card.id).not.toBeNull();
      const { seed, index } = found as { seed: number; index: number };
      let wrapped = toPlay(seed, index);
      let direct = card.game.init(segmentSeed(seed, 0), {
        maxTicks: wrapped.segMax,
        params: card.params ?? {},
      });
      const inputs = randomInputs(seed, 200);
      for (const input of inputs) {
        wrapped = skGame.step(wrapped, input);
        direct = card.game.step(direct, input);
        expect(wrapped.inner).toEqual(direct);
      }
    }
  });

  it('actions 與 evaluate 在遊戲階段逐字等於被包的牌（沒有 S-K 自己的項）', () => {
    for (let seed = 0; seed < 12; seed += 1) {
      const s = run(toPlay(seed, seed % 4), 90, [press(seed % 4), press((seed + 1) % 4)]);
      expect(s.phase).toBe('play');
      const card = poolEntry(s.cardId as string);
      for (const side of [0, 1] as const) {
        expect(skGame.actions(s, side)).toEqual(card.game.actions(s.inner as never, side));
        expect(skGame.evaluate(s, side)).toEqual(card.game.evaluate(s.inner as never, side));
      }
    }
  });

  it('evaluate 與 actions 不讀 ledger、offer、first（遊戲階段只差這些欄位的兩個 state 相等）', () => {
    const base = toPlay(3, 0);
    const other: SKState = {
      ...base,
      ledger: [entryOf('S-9', 900)],
      offer: ['S-7'],
      first: base.first === 0 ? 1 : 0,
    };
    for (const side of [0, 1] as const) {
      expect(skGame.evaluate(other, side)).toEqual(skGame.evaluate(base, side));
      expect(skGame.actions(other, side)).toEqual(skGame.actions(base, side));
    }
  });

  it('A5 的成本：遊戲階段的 evaluate 只呼叫「目前這一段」那張牌的 evaluate 一次，其他牌 0 次', () => {
    const s = toPlay(2, 1);
    const spies = POOL.map((p) => ({ id: p.id, spy: vi.spyOn(p.game, 'evaluate') }));
    try {
      skGame.evaluate(s, 0);
      for (const { id, spy } of spies) {
        expect(spy, id).toHaveBeenCalledTimes(id === s.cardId ? 1 : 0);
      }
    } finally {
      for (const { spy } of spies) {
        spy.mockRestore();
      }
    }
  });

  it('A5 的成本：挑牌階段與 show 階段的 evaluate 完全不呼叫被包的牌（選牌的 evaluate 只讀 ledger）', () => {
    const picking = skGame.init(1, CONFIG);
    const showing = skGame.step(picking, pickInputs(picking.picker as Side, 0));
    const spies = POOL.map((p) => vi.spyOn(p.game, 'evaluate'));
    try {
      skGame.evaluate(picking, 0);
      skGame.evaluate(picking, 1);
      skGame.evaluate(showing, 0);
      skGame.evaluate(showing, 1);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 結算與計分
// ---------------------------------------------------------------------------

describe('S-K 黑桃馬拉松｜每段結算與總分', () => {
  /** 一個 S-3 段，只差一個 tick 就結束，分數是 [3, 0]（人擦彈 3 次）。 */
  function nearlyDone(overrides: Partial<SKState> = {}): SKState {
    const inner = makeS3({
      tick: 659,
      maxTicks: 660,
      fields: [{ grazes: 3 }, { grazes: 0 }],
    });
    return makeState({
      phase: 'play',
      seg: 0,
      cardId: 'S-3',
      first: 0,
      picker: 0,
      offer: ['S-3', 'S-7', 'S-Q', 'S-4'],
      inner,
      segMax: 660,
      ...overrides,
    });
  }

  it('marginMilli：差距除以標度、夾在 ±1、千分位且是偶數（所以兩邊的分數是整數）', () => {
    expect(marginMilli(3, 7)).toBe(428);
    expect(marginMilli(-3, 7)).toBe(-428);
    expect(marginMilli(70, 7)).toBe(1000);
    expect(marginMilli(-70, 7)).toBe(-1000);
    expect(marginMilli(0, 7)).toBe(0);
    for (const diff of [1, 2, 5, 9, 13, 100]) {
      for (const scale of [2, 3, 7, 10, 61]) {
        expect(Math.abs(marginMilli(diff, scale)) % 2).toBe(0);
      }
    }
  });

  it('段結束那一個 tick 結算：ledger 多一筆 { cardId, family, picker, weight 1, mm }、進入 rest；mm 用該牌的標度', () => {
    const s = skGame.step(nearlyDone(), IDLE);
    expect(s.phase).toBe('rest');
    expect(s.ledger).toHaveLength(1);
    const entry = s.ledger[0] as SKLedgerEntry;
    expect(entry.cardId).toBe('S-3');
    expect(entry.family).toBe(poolEntry('S-3').family);
    expect(entry.picker).toBe(0);
    expect(entry.weight).toBe(1);
    expect(entry.mm).toBe(marginMilli(3, poolEntry('S-3').scale));
    expect(entry.mm).toBeGreaterThan(0);
  });

  it('score：每段是 weight × (1000 ± mm) / 2，兩邊加起來是 1000 × 權重和；S-3 贏 3 分的那邊多拿', () => {
    const s = skGame.step(nearlyDone(), IDLE);
    const mm = (s.ledger[0] as SKLedgerEntry).mm;
    expect(skGame.score(s)).toEqual([(1000 + mm) / 2, (1000 - mm) / 2]);
    const [a, b] = skGame.score(s);
    expect(a + b).toBe(1000);
    expect(Number.isInteger(a)).toBe(true);
  });

  it('決勝段權重 2：同樣的 mm，決勝段貢獻的分數是一般段的兩倍', () => {
    const ledger = [entryOf('S-3', 500), entryOf('S-7', 0), entryOf('S-Q', 0), entryOf('S-4', 0)];
    const final = entryOf('S-5', 500, { weight: 2, picker: null });
    const normal = makeState({ phase: 'over', seg: 4, ledger: [entryOf('S-3', 500)] });
    const withFinal = makeState({ phase: 'over', seg: 4, ledger: [...ledger, final] });
    expect(skGame.score(normal)[0]).toBe(750);
    // 前 4 段：750 + 500×3 = 2250；決勝：2 × 750 = 1500
    expect(skGame.score(withFinal)[0]).toBe(750 + 500 * 3 + 1500);
    expect(skGame.score(withFinal)[0] + skGame.score(withFinal)[1]).toBe(6000);
  });

  it('score 只由 ledger 決定：被包的牌自己後來怎麼變、inner 的分數是多少，都不會改變已結算的段', () => {
    const s = skGame.step(nearlyDone(), IDLE);
    const before = skGame.score(s);
    const tampered: SKState = {
      ...s,
      inner: makeS3({ tick: 660, maxTicks: 660, fields: [{ grazes: 0, hits: 9 }, { grazes: 50 }] }),
    };
    expect(skGame.score(tampered)).toEqual(before);
  });

  it('贏家：總分高的贏、同分是 null；對 0 號邊與 1 號邊對稱', () => {
    const plus = makeState({ phase: 'over', ledger: [entryOf('S-3', 200)] });
    const minus = makeState({ phase: 'over', ledger: [entryOf('S-3', -200)] });
    const even = makeState({ phase: 'over', ledger: [entryOf('S-3', 200), entryOf('S-Q', -200)] });
    expect(skGame.winner(plus)).toBe(0);
    expect(skGame.winner(minus)).toBe(1);
    expect(skGame.winner(even)).toBeNull();
  });

  it('每段只結算一次：跑完整場，ledger 裡每一筆在它被寫入之後，到終局為止逐位元不變', () => {
    for (const seed of [0, 1, 2, 3]) {
      let state = skGame.init(seed, CONFIG);
      let seen: SKLedgerEntry[] = [];
      let guard = 0;
      while (!skGame.isOver(state) && guard < 7000) {
        state = skGame.step(
          state,
          state.phase === 'pick' && state.picker !== null
            ? pickInputs(state.picker, seed % 4)
            : IDLE,
        );
        // 之前記下的每一筆都還在、一模一樣；ledger 只會尾端多一筆
        for (let i = 0; i < seen.length; i += 1) {
          expect(state.ledger[i]).toEqual(seen[i]);
        }
        expect(state.ledger.length).toBeGreaterThanOrEqual(seen.length);
        expect(state.ledger.length - seen.length).toBeLessThanOrEqual(1);
        seen = [...state.ledger];
        guard += 1;
      }
      expect(state.ledger).toHaveLength(5);
      expect(state.ledger.map((e) => e.weight)).toEqual([1, 1, 1, 1, 2]);
      const w = state.ledger.reduce((sum, e) => sum + e.weight, 0);
      const [a, b] = skGame.score(state);
      expect(a + b).toBe(1000 * w);
      // 總分等於把 ledger 重新加一遍，沒有任何別的來源
      expect(a).toBe(state.ledger.reduce((sum, e) => sum + (e.weight * (1000 + e.mm)) / 2, 0));
    }
  });

  it('rest 階段停 REST_TICKS，然後進入下一段的挑牌（挑牌人換邊、phaseTick 歸零、新的候選牌）', () => {
    const done = skGame.step(nearlyDone(), IDLE);
    const next = run(done, REST_TICKS);
    expect(next.phase).toBe('pick');
    expect(next.seg).toBe(1);
    expect(next.picker).toBe(done.picker === 0 ? 1 : 0);
    expect(next.phaseTick).toBe(0);
    expect(next.inner).toBeNull();
    expect(next.cardId).toBeNull();
    expect(next.offer).not.toContain('S-3');
  });

  it('第 5 段（決勝）：進入時 phase 是 show、cardId S-5、picker null；play 時 inner 是 target 3 的 S-5，結算權重 2', () => {
    const state = makeState({
      phase: 'rest',
      seg: 3,
      phaseTick: REST_TICKS - 1,
      ledger: [entryOf('S-3', 0), entryOf('S-7', 0), entryOf('S-Q', 0), entryOf('S-4', 0)],
    });
    const show = skGame.step(state, IDLE);
    expect(show.phase).toBe('show');
    expect(show.seg).toBe(4);
    expect(show.cardId).toBe('S-5');
    expect(show.picker).toBeNull();
    const play = run(show, SHOW_TICKS);
    expect(play.phase).toBe('play');
    expect((play.inner as { target: number }).target).toBe(3);
    const over = runUntil(play, (s) => s.phase !== 'play');
    expect(over.ledger).toHaveLength(5);
    expect(over.ledger[4]?.weight).toBe(2);
    expect(over.ledger[4]?.cardId).toBe('S-5');
    expect(skGame.isOver(over)).toBe(true);
  });

  it('isOver 之後 step 不動：score、winner、state 都不變', () => {
    const { final } = playAll(9);
    expect(skGame.isOver(final)).toBe(true);
    expect(skGame.step(final, IDLE)).toEqual(final);
    expect(run(final, 60, [press(0), press(1)])).toEqual(final);
  });

  it('時間到：maxTicks 用完時整場結束（即使還在段的中間）', () => {
    const config = { maxTicks: MIN_MAX_TICKS, params: {} };
    let state = skGame.init(0, config);
    let ticks = 0;
    while (!skGame.isOver(state) && ticks < MIN_MAX_TICKS + 10) {
      state = skGame.step(state, state.picker === null ? IDLE : pickInputs(state.picker, 0));
      ticks += 1;
    }
    expect(skGame.isOver(state)).toBe(true);
    expect(state.tick).toBeLessThanOrEqual(MIN_MAX_TICKS);
  });

  it('一場長度：兩個等級 10 的精準型對打，整場不超過 meta.defaultMaxTicks（種子 0..5）', () => {
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const result = playMatch(
        skGame,
        seed,
        CONFIG,
        levelController(skGame, precise, 10, seed),
        levelController(skGame, precise, 10, seed + 1_000_003),
      );
      expect(result.ticks).toBeLessThanOrEqual(CONFIG.maxTicks);
      expect(result.ticks).toBeGreaterThan(1500);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 純度、不可變、可序列化
// ---------------------------------------------------------------------------

describe('S-K 黑桃馬拉松｜step 是純的、state 可序列化（遞迴成立：包裝層與被包的牌都要）', () => {
  it('把 state 深度凍結後整場照樣走完（step 不改傳入的 state，包括 inner、ledger、offer）', () => {
    for (const seed of [0, 1]) {
      let state = deepFreeze(skGame.init(seed, CONFIG));
      const inputs = randomInputs(seed, 6000);
      for (let i = 0; i < 6000 && !skGame.isOver(state); i += 1) {
        const picker = state.phase === 'pick' ? state.picker : null;
        const input = picker !== null && i % 40 === 0 ? pickInputs(picker, i % 4) : inputs[i];
        state = deepFreeze(skGame.step(state, input as Inputs));
      }
      expect(skGame.isOver(state)).toBe(true);
    }
  });

  it('JSON 往返之後 state 逐位元相同，而且往返後的 state 與原 state 往後走得一模一樣（每個階段各一次）', () => {
    const seen = new Set<string>();
    let state = skGame.init(11, CONFIG);
    const inputs = randomInputs(11, 6000);
    for (let i = 0; i < 6000 && !skGame.isOver(state); i += 1) {
      if (!seen.has(state.phase) || i % 500 === 0) {
        seen.add(state.phase);
        const round = JSON.parse(JSON.stringify(state)) as SKState;
        expect(round).toEqual(state);
        const input = inputs[i] as Inputs;
        expect(skGame.step(round, input)).toEqual(skGame.step(state, input));
      }
      state = skGame.step(
        state,
        state.phase === 'pick' && state.picker !== null && i % 30 === 0
          ? pickInputs(state.picker, i % 4)
          : (inputs[i] as Inputs),
      );
    }
    seen.add(state.phase);
    expect([...seen].sort()).toEqual(['over', 'pick', 'play', 'rest', 'show'].sort());
  });

  it('同樣的種子與輸入，兩次跑出來的整場逐 tick 相同（決定性）', () => {
    const a = playAll(21, 2);
    const b = playAll(21, 2);
    expect(b.final).toEqual(a.final);
    expect(b.snapshots).toEqual(a.snapshots);
  });
});

// ---------------------------------------------------------------------------
// 選牌的 evaluate 與 actions（讀 ledger；冷啟動由性格決定）
// ---------------------------------------------------------------------------

/** 挑牌人（`side`）鎖定第 `index` 張後的 evaluate（就是性格比較用的東西）。 */
function lockedValue(state: SKState, side: Side, index: number): { gain: number; danger: number } {
  const picker = state.picker as Side;
  const inputs: Inputs = picker === 0 ? [press(index), NONE] : [NONE, press(index)];
  return skGame.evaluate(skGame.step(state, inputs), side);
}

describe('S-K 黑桃馬拉松｜選牌的 evaluate 與 actions', () => {
  const offer = ['S-3', 'S-7', 'S-Q', 'S-4'];

  it('sigmaLabel：S-3、S-Q 是「穩」，S-J、S-4 是「中」，S-7 是「險」；門檻 0.3／0.55', () => {
    expect(sigmaLabel(poolEntry('S-3').sigma)).toBe('stable');
    expect(sigmaLabel(poolEntry('S-Q').sigma)).toBe('stable');
    expect(sigmaLabel(poolEntry('S-J').sigma)).toBe('mid');
    expect(sigmaLabel(poolEntry('S-7').sigma)).toBe('risky');
    expect(sigmaLabel(0.3)).toBe('stable');
    expect(sigmaLabel(0.31)).toBe('mid');
    expect(sigmaLabel(0.55)).toBe('mid');
    expect(sigmaLabel(0.56)).toBe('risky');
  });

  it('挑牌人鎖定第 i 張之後的 danger 就是那張牌的 sigma（精準型的門檻因此看得到穩／險）', () => {
    const s = makeState({ offer, picker: 0 });
    offer.forEach((id, i) => {
      expect(lockedValue(s, 0, i).danger).toBe(poolEntry(id).sigma);
    });
  });

  it('沒鎖定（等著）的 danger 是 1（逾時會被強制鎖定第一張，是失去選擇的損失；精準型的門檻因此不會把等著當成「安全」），gain 嚴格低於任何一個鎖定（拖延不是平手，不是靠 actions 排序決勝）', () => {
    for (const ledger of [
      [],
      [entryOf('S-9', 700)],
      [entryOf('S-9', -700), entryOf('S-8', -300)],
    ]) {
      for (const side of [0, 1] as const) {
        const s = makeState({ offer, picker: side, ledger });
        const wait = skGame.evaluate(s, side);
        expect(wait.danger).toBe(1);
        for (let i = 0; i < offer.length; i += 1) {
          expect(lockedValue(s, side, i).gain).toBeGreaterThan(wait.gain);
        }
      }
    }
  });

  it('actions 的順序和 evaluate 的偏好一致：最前面的是 gain 最高的鎖定，等著（全放開）排在最後；非挑牌人只有全放開', () => {
    const ledgers: SKLedgerEntry[][] = [
      [],
      [entryOf('S-9', 600), entryOf('S-8', 300)],
      [entryOf('S-9', -800), entryOf('S-8', -200), entryOf('S-J', 400)],
    ];
    for (const ledger of ledgers) {
      for (const side of [0, 1] as const) {
        const s = makeState({ offer, picker: side, ledger });
        const actions = skGame.actions(s, side);
        expect(actions).toHaveLength(offer.length + 1);
        const last = actions[actions.length - 1] as Buttons;
        expect(Object.values(last).every((v) => v === false)).toBe(true);
        const gains = actions.map((a) =>
          skGame.evaluate(skGame.step(s, side === 0 ? [a, NONE] : [NONE, a]), side),
        );
        for (let i = 1; i < actions.length; i += 1) {
          expect((gains[i - 1] as { gain: number }).gain).toBeGreaterThanOrEqual(
            (gains[i] as { gain: number }).gain,
          );
        }
        const other: Side = side === 0 ? 1 : 0;
        expect(skGame.actions(s, other)).toEqual([NONE]);
      }
    }
  });

  it('四個性格、深度 1 和 6：挑牌人在第一個可以決定的 tick 就鎖定（不拖延）', () => {
    const policies: [string, Policy][] = [
      ['precise', precise],
      ['greedy', greedy],
      ['gambler', gambler],
      ['pathfinder', pathfinder],
    ];
    for (const [name, policy] of policies) {
      for (const depth of [1, 6]) {
        for (const [name2, offered, ledger] of [
          ['有穩的牌、空 ledger', offer, []],
          ['有穩的牌、落後', offer, [entryOf('S-9', -600)]],
          ['有穩的牌、領先', offer, [entryOf('S-9', 600)]],
          // 候選牌全是「中」或「險」：精準型的 danger 門檻 0.3 把每一張鎖定都判成不安全，
          // 這時「等著」不可以因為 danger 低而贏（C-Q 的放僚機是同一個病：排在最後、平手時永遠拖延）。
          ['全是險或中、空 ledger', ['S-7', 'S-J', 'S-9', 'S-8'], []],
          ['全是險或中、落後', ['S-7', 'S-J', 'S-9', 'S-4'], [entryOf('S-3', -600)]],
        ] as [string, string[], SKLedgerEntry[]][]) {
          const s = makeState({ offer: offered, picker: 1, ledger });
          const controller = wrapPolicy(
            skGame,
            policy,
            { reactionTicks: 0, decideEvery: 1, depth, epsilon: 0 },
            3,
          );
          const pressed = controller.decide(s, 1, 0);
          const locked = KEYS.some((k) => pressed[k]);
          expect(locked, `${name} 深度 ${depth} ${name2}`).toBe(true);
        }
      }
    }
  });

  it('等級 10 的整場裡，挑牌人從挑牌階段開始 24 tick 內就鎖定（反應延遲 12 tick 之內決定）', () => {
    for (const seed of [0, 1, 2]) {
      const c0 = levelController(skGame, precise, 10, seed);
      const c1 = levelController(skGame, precise, 10, seed + 1_000_003);
      let state = skGame.init(seed, CONFIG);
      let tick = 0;
      let pickStart = 0;
      const waits: number[] = [];
      while (!skGame.isOver(state) && tick < 7000) {
        const before = state;
        state = skGame.step(state, [
          copyButtons(c0.decide(state, 0, tick)),
          copyButtons(c1.decide(state, 1, tick)),
        ]);
        tick += 1;
        if (before.phase !== 'pick' && state.phase === 'pick') {
          pickStart = tick;
        }
        if (before.phase === 'pick' && state.phase === 'show') {
          waits.push(tick - pickStart);
        }
      }
      expect(waits).toHaveLength(4);
      for (const w of waits) {
        expect(w).toBeLessThanOrEqual(24);
      }
    }
  });

  it('冷啟動（空 ledger）：貪心型挑期望最高的（S-7，其次 S-J）；精準型挑「穩」的牌；兩者不同', () => {
    const s = makeState({ offer: ['S-4', 'S-7', 'S-3', 'S-Q'], picker: 0 });
    const params = { depth: 1, seed: 0 };
    const g = greedy.decide(skGame, s, 0, 0, params);
    const p = precise.decide(skGame, s, 0, 0, params);
    expect(g).toEqual(press(1)); // S-7
    expect(sigmaLabel(poolEntry(s.offer[KEYS.findIndex((k) => p[k])] as string).sigma)).toBe(
      'stable',
    );
    expect(p).not.toEqual(g);
    const s2 = makeState({ offer: ['S-4', 'S-J', 'S-3', 'S-Q'], picker: 0 });
    expect(greedy.decide(skGame, s2, 0, 0, params)).toEqual(press(1)); // S-J
  });

  it('剝削測試：我在某家族贏得多，該家族的候選牌 gain 嚴格較大；對手（輸得多的那邊）看到的剛好相反', () => {
    // 閃避家族的 S-Q 還在候選裡；S-3（閃避）已經打過，0 號邊贏了 700。
    const ledger = [entryOf('S-3', 700, { picker: 1 })];
    const s = makeState({ seg: 1, offer: ['S-Q', 'S-7', 'S-J', 'S-4'], picker: 0, ledger });
    const dodge = lockedValue(s, 0, 0).gain;
    for (const i of [1, 2, 3]) {
      expect(dodge).toBeGreaterThan(lockedValue(s, 0, i).gain);
    }
    const t = makeState({ seg: 1, offer: ['S-Q', 'S-7', 'S-J', 'S-4'], picker: 1, ledger });
    const dodge1 = lockedValue(t, 1, 0).gain;
    for (const i of [1, 2, 3]) {
      expect(dodge1).toBeLessThan(lockedValue(t, 1, i).gain);
    }
    // 貪心型照此選擇
    const params = { depth: 1, seed: 0 };
    expect(greedy.decide(skGame, s, 0, 0, params)).toEqual(press(0));
    expect(greedy.decide(skGame, t, 1, 0, params)).not.toEqual(press(0));
  });

  it('E 的 n/(n+1) 權重：同一家族打過兩段比打過一段更有說服力', () => {
    const one = makeState({
      seg: 1,
      picker: 0,
      offer: ['S-Q', 'S-7'],
      ledger: [entryOf('S-3', 600)],
    });
    const two = makeState({
      seg: 2,
      picker: 0,
      offer: ['S-Q', 'S-7'],
      ledger: [entryOf('S-3', 600), entryOf('S-8', 0, { family: poolEntry('S-3').family })],
    });
    // 兩段的平均是 300，n=2：2/3 × 0.3 = 0.2；一段：1/2 × 0.6 = 0.3。n/(n+1) 讓「只看過一次」不被放大成確定。
    const g1 = lockedValue(one, 0, 0).gain - lockedValue(one, 0, 1).gain;
    const g2 = lockedValue(two, 0, 0).gain - lockedValue(two, 0, 1).gain;
    expect(g1).toBeGreaterThan(g2);
    expect(g2).toBeGreaterThan(0);
  });

  it('賭徒型落後時挑高變異牌（險）的比例，高於領先時（性格，不是橡皮筋：靠的是 gain 的符號）', () => {
    const pool = ['S-3', 'S-Q', 'S-7', 'S-J'];
    let riskyBehind = 0;
    let riskyAhead = 0;
    const trials = 60;
    for (let t = 0; t < trials; t += 1) {
      // 偽隨機的家族成績（固定種子），差別只在整體的領先或落後
      const wobble = ((t * 37) % 21) - 10; // -10..10
      const mk = (shift: number): SKState =>
        makeState({
          seg: 2,
          offer: pool,
          picker: 0,
          ledger: [
            entryOf('S-4', shift + wobble * 8),
            entryOf('S-9', shift - wobble * 8, { picker: 1 }),
          ],
        });
      const pick = (s: SKState): string => {
        const b = gambler.decide(skGame, s, 0, 0, { depth: 1, seed: 0 });
        return pool[KEYS.findIndex((k) => b[k])] as string;
      };
      if (poolEntry(pick(mk(-900))).sigma >= 0.5) {
        riskyBehind += 1;
      }
      if (poolEntry(pick(mk(900))).sigma >= 0.5) {
        riskyAhead += 1;
      }
    }
    expect(riskyBehind).toBeGreaterThanOrEqual(riskyAhead);
  });
});

// ---------------------------------------------------------------------------
// meta、畫面
// ---------------------------------------------------------------------------

describe('S-K 黑桃馬拉松｜meta', () => {
  it('meta：黑桃 K、預設精準型、baseLevel 4、對稱、defaultMaxTicks 5400、不標 reflexOnly／simpleStrategyViable、不宣告 selfFromPresent', () => {
    expect(skMeta.id).toBe('S-K');
    expect(skMeta.suit).toBe('S');
    expect(skMeta.rank).toBe('K');
    expect(skMeta.defaultPolicy).toBe('precise');
    expect(skMeta.baseLevel).toBe(4);
    expect(skMeta.symmetric).toBe(true);
    expect(skMeta.defaultMaxTicks).toBe(5400);
    expect(skMeta.reflexOnly).toBeUndefined();
    expect(skMeta.simpleStrategyViable).toBeUndefined();
    expect(skMeta.winnerNotByScore).toBeUndefined();
    expect('selfFromPresent' in skGame).toBe(false);
  });

  it('meta 的說明誠實講明：這是包裝牌，互動借自被包的牌', () => {
    expect(skMeta.description).toContain('被包的牌');
  });
});

describe('S-K 黑桃馬拉松｜render', () => {
  it('每個階段（挑牌、show、play 的每一張池裡的牌、rest、over）：不丟錯、不改 state、只用色盤、畫在 320×240 之內', () => {
    const states: SKState[] = [];
    for (let seed = 0; seed < 8; seed += 1) {
      let s = skGame.init(seed, CONFIG);
      const inputs = randomInputs(seed, 6000);
      for (let i = 0; i < 6000 && !skGame.isOver(s); i += 1) {
        if (i % 97 === 0) {
          states.push(s);
        }
        s = skGame.step(
          s,
          s.phase === 'pick' && s.picker !== null && i % 11 === 0
            ? pickInputs(s.picker, (i + seed) % 4)
            : (inputs[i] as Inputs),
        );
      }
      states.push(s);
    }
    const palette = new Set<string>(Object.values(COLOR).map((c) => c.toLowerCase()));
    expect(new Set(states.map((s) => s.phase)).size).toBe(5);
    for (const state of states) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(state)) as SKState);
      const context = createFakeContext();
      expect(() => skRender(asRenderingContext(context), frozen)).not.toThrow();
      for (const record of context.colors) {
        if (typeof record.value === 'string') {
          expect(palette.has(record.value.toLowerCase())).toBe(true);
        }
      }
      for (const point of context.points) {
        expect(point.x).toBeGreaterThanOrEqual(-8);
        expect(point.x).toBeLessThanOrEqual(LOGIC_WIDTH + 8);
        expect(point.y).toBeGreaterThanOrEqual(-8);
        expect(point.y).toBeLessThanOrEqual(LOGIC_HEIGHT + 8);
      }
    }
  });
});
