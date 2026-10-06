import { describe, expect, it } from 'vitest';

import type { RegistryEntry } from '../../src/games/types';
import { PALETTE } from '../../src/shell/palette';
import { BAD_GAMES } from './bad-games';
import { makeBadEntry } from './bad-games/make';
import type { CheckCode } from './checks';
import { CHECKS, checkMeta, ContractViolation, failingCodes, findBadValue } from './checks';
import { asRenderingContext, createFakeContext } from './fake-context';
import { deepFreeze, isDeepFrozen } from './freeze';

/**
 * 契約檢查本身的測試：用故意違約的假遊戲，證明 `checks.ts` 真的抓得到問題。
 *
 * 每個假遊戲（`bad-games/*.ts`）從 counter-game 出發、只違反一條。這裡實際跑
 * 契約檢查（與 all-games.test.ts 同一份 `CHECKS`），要求：
 *
 * 1. 設計上該抓它的那一條（primary）失敗了；
 * 2. 失敗的檢查「剛好」是 primary ＋ 文件裡寫明的連帶失敗，不多不少。
 *    連帶失敗不是誤報，是同一個問題的必然後果（見各檔案的註解）。
 *
 * 另外有一個對照組：沒有違約的 counter-game 不能被任何一條誤判。
 */

const SORT = (codes: readonly CheckCode[]): CheckCode[] => [...codes].sort();

describe('對照組：守規矩的遊戲全部通過', () => {
  it('沒有任何一條檢查失敗', () => {
    expect(failingCodes(makeBadEntry({}), { seeds: [0, 1, 2] })).toEqual([]);
  });
});

describe('故意違約的假遊戲會被契約檢查抓到', () => {
  it.each(BAD_GAMES)(
    '$name：$violates',
    (bad) => {
      const failed = failingCodes(bad.entry, { seeds: bad.seeds ?? [0, 1, 2], only: bad.only });
      expect(failed, `${bad.name} 該被 ${bad.primary} 抓到`).toContain(bad.primary);
      expect(SORT(failed)).toEqual(SORT([bad.primary, ...bad.collateral]));
    },
    30_000,
  );

  it('至少有 4 個假遊戲，而且 K1、K3、K4、K5 各有一個專門抓它的', () => {
    expect(BAD_GAMES.length).toBeGreaterThanOrEqual(4);
    const primaries = BAD_GAMES.map((bad) => bad.primary);
    for (const code of ['K1', 'K3', 'K4', 'K5'] as const) {
      expect(primaries).toContain(code);
    }
  });

  it('K1–K12、R1–R3 每一條都至少有一個假遊戲專門抓它', () => {
    const covered = new Set(BAD_GAMES.map((bad) => bad.primary));
    const missing = CHECKS.map((check) => check.code).filter(
      (code) => code !== 'META' && !covered.has(code),
    );
    expect(missing).toEqual([]);
  });

  it('檢查失敗的訊息帶有編號與種子，讓人知道哪裡壞了', () => {
    const impure = BAD_GAMES.find((bad) => bad.name === 'impure');
    const k1 = CHECKS.find((check) => check.code === 'K1');
    expect(impure).toBeDefined();
    expect(k1).toBeDefined();
    expect(() => k1?.run(impure?.entry as RegistryEntry, [7])).toThrow(/\[K1\] 種子 7｜.*雜湊不同/);
  });

  it('遊戲自己丟的錯會被包成該檢查的失敗，不是讓測試崩潰', () => {
    const mutating = BAD_GAMES.find((bad) => bad.name === 'mutating');
    const k4 = CHECKS.find((check) => check.code === 'K4');
    let caught: unknown = null;
    try {
      k4?.run(mutating?.entry as RegistryEntry, [0]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContractViolation);
    expect((caught as ContractViolation).code).toBe('K4');
    expect((caught as ContractViolation).message).toMatch(/凍結/);
  });
});

describe('meta 檢查抓得到什麼', () => {
  const good = makeBadEntry({});

  function metaMessage(entry: RegistryEntry): string {
    try {
      checkMeta(entry);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return '';
  }

  it('對照組：好的替身牌沒有問題', () => {
    expect(metaMessage(good)).toBe('');
  });

  it.each([
    ['名稱是空的', { name: '' }, /meta\.name/],
    ['名稱不是中文', { name: 'Counter' }, /meta\.name/],
    ['說明是空的', { description: '  ' }, /meta\.description/],
    ['說明有兩行', { description: '第一句。\n第二句。' }, /meta\.description/],
    ['沒有操作說明', { controls: '' }, /meta\.controls/],
    ['meta.id 與登記表不一致', { id: 'other' }, /meta\.id/],
    ['基礎等級超出範圍', { baseLevel: 5 }, /baseLevel/],
  ] as const)('%s', (_label, patch, pattern) => {
    expect(metaMessage({ ...good, meta: { ...good.meta, ...patch } })).toMatch(pattern);
  });

  it('docs/cards/<id>.md 不存在', () => {
    const entry: RegistryEntry = {
      ...good,
      id: 'no-such-spec',
      meta: { ...good.meta, id: 'no-such-spec' },
    };
    expect(metaMessage(entry)).toMatch(/docs\/cards\/no-such-spec\.md/);
  });

  it('真的牌：花色與點數必須與 id 一致', () => {
    const entry: RegistryEntry = {
      ...good,
      id: 'C-A',
      kind: 'card',
      game: { ...good.game, id: 'C-A' },
      meta: { ...good.meta, id: 'C-A', suit: 'S', rank: 'A', baseLevel: 1 },
    };
    expect(metaMessage(entry)).toMatch(/花色與點數/);
  });

  it('真的牌：id 不在 54 張牌裡、點數對不上基礎等級都會被抓', () => {
    const entry: RegistryEntry = {
      ...good,
      id: 'C-99',
      kind: 'card',
      meta: { ...good.meta, id: 'C-99', suit: 'C', rank: 'A', baseLevel: 3 },
    };
    expect(metaMessage(entry)).toMatch(/不是 54 張牌/);
  });

  it('替身牌不可以有花色與點數，也不可以撞到真的牌的 id', () => {
    const withSuit: RegistryEntry = { ...good, meta: { ...good.meta, suit: 'C' } };
    expect(metaMessage(withSuit)).toMatch(/suit 與 rank 必須是 null/);
    const clash: RegistryEntry = { ...good, id: 'C-A', meta: { ...good.meta, id: 'C-A' } };
    expect(metaMessage(clash)).toMatch(/撞到真的牌/);
  });
});

describe('輔助工具本身', () => {
  describe('deepFreeze', () => {
    it('連最深的物件與陣列都凍結，而且回傳同一個參考', () => {
      const state = { a: { b: [{ c: 1 }] }, d: [1, 2] };
      const frozen = deepFreeze(state);
      expect(frozen).toBe(state);
      expect(isDeepFrozen(state)).toBe(true);
      expect(() => {
        state.a.b[0].c = 2;
      }).toThrow(TypeError);
      expect(() => {
        state.d.push(3);
      }).toThrow(TypeError);
    });

    it('循環參照不會無限遞迴', () => {
      const loop: { self?: unknown } = {};
      loop.self = loop;
      expect(() => deepFreeze(loop)).not.toThrow();
      expect(Object.isFrozen(loop)).toBe(true);
    });

    it('沒凍結的東西 isDeepFrozen 回報 false', () => {
      expect(isDeepFrozen({ a: { b: 1 } })).toBe(false);
      expect(isDeepFrozen(Object.freeze({ a: { b: 1 } }))).toBe(false);
    });
  });

  describe('findBadValue（K3）', () => {
    it('找到 NaN、Infinity、-Infinity、undefined，並指出路徑', () => {
      expect(findBadValue({ x: 1, y: { z: [0, Number.NaN] } })).toBe('state.y.z[1] 是 NaN');
      expect(findBadValue({ x: Infinity })).toBe('state.x 是 Infinity');
      expect(findBadValue({ x: [-Infinity] })).toBe('state.x[0] 是 -Infinity');
      expect(findBadValue({ x: undefined })).toBe('state.x 是 undefined');
    });

    it('正常的 state 回傳 null，包含 0、-0、null、字串、布林', () => {
      expect(findBadValue({ a: 0, b: -0, c: null, d: 'x', e: true, f: [1, { g: 2 }] })).toBeNull();
    });

    it('循環參照不會無限遞迴', () => {
      const loop: { self?: unknown } = {};
      loop.self = loop;
      expect(findBadValue(loop)).toBeNull();
    });
  });

  describe('假的 2D context', () => {
    it('記錄 fillStyle、strokeStyle 的設定值，與繪圖當下實際生效的顏色', () => {
      const fake = createFakeContext();
      const ctx = asRenderingContext(fake);
      ctx.fillStyle = PALETTE[1];
      ctx.fillRect(0, 0, 10, 10);
      ctx.strokeStyle = PALETTE[2];
      ctx.strokeRect(5, 5, 10, 10);
      const set = fake.colors.filter((c) => c.via === 'set').map((c) => c.value);
      const used = fake.colors.filter((c) => c.via === 'used').map((c) => c.value);
      expect(set).toEqual([PALETTE[1], PALETTE[2]]);
      expect(used).toEqual([PALETTE[1], PALETTE[2]]);
    });

    it('沒設顏色就畫，記錄到瀏覽器預設的 #000000', () => {
      const fake = createFakeContext();
      asRenderingContext(fake).fillRect(0, 0, 1, 1);
      expect(fake.colors.map((c) => c.value)).toEqual(['#000000']);
    });

    it('save／restore 會還原顏色與 transform', () => {
      const fake = createFakeContext();
      const ctx = asRenderingContext(fake);
      ctx.fillStyle = PALETTE[3];
      ctx.save();
      ctx.fillStyle = PALETTE[4];
      ctx.translate(100, 0);
      ctx.restore();
      ctx.fillRect(1, 2, 3, 4);
      expect(fake.colors.at(-1)?.value).toBe(PALETTE[3]);
      expect(fake.points[0]).toMatchObject({ x: 1, y: 2 });
    });

    it('座標會套用 translate、scale、rotate 與 setTransform', () => {
      const fake = createFakeContext();
      const ctx = asRenderingContext(fake);
      ctx.translate(10, 20);
      ctx.scale(2, 2);
      ctx.moveTo(5, 5);
      expect(fake.points.at(-1)).toMatchObject({ x: 20, y: 30 });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.moveTo(5, 5);
      expect(fake.points.at(-1)).toMatchObject({ x: 5, y: 5 });
      ctx.rotate(Math.PI / 2);
      ctx.moveTo(10, 0);
      const p = fake.points.at(-1);
      expect(p?.x).toBeCloseTo(0);
      expect(p?.y).toBeCloseTo(10);
      ctx.resetTransform();
      ctx.moveTo(1, 1);
      expect(fake.points.at(-1)).toMatchObject({ x: 1, y: 1 });
    });

    it('arc、drawImage、fillText 也有座標記錄', () => {
      const fake = createFakeContext();
      const ctx = asRenderingContext(fake);
      ctx.arc(50, 60, 10, 0, Math.PI * 2);
      expect(fake.points.map((p) => [p.x, p.y])).toContainEqual([40, 50]);
      expect(fake.points.map((p) => [p.x, p.y])).toContainEqual([60, 70]);
      ctx.fillText('x', 7, 8);
      expect(fake.points.at(-1)).toMatchObject({ method: 'fillText', x: 7, y: 8 });
      const before = fake.points.length;
      ctx.drawImage({} as CanvasImageSource, 0, 0, 16, 16, 100, 110, 32, 32);
      expect(fake.points.slice(before).map((p) => [p.x, p.y])).toContainEqual([132, 142]);
    });

    it('漸層物件指定給 fillStyle 會被記成非字串（R2 會因此失敗）', () => {
      const fake = createFakeContext();
      const ctx = asRenderingContext(fake);
      ctx.fillStyle = ctx.createLinearGradient(0, 0, 10, 0);
      expect(typeof fake.colors[0].value).not.toBe('string');
    });
  });
});
