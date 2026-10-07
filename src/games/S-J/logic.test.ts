import { describe, expect, it } from 'vitest';
import { policyByName } from '../../ai/level';
import type { Buttons, Inputs, Side } from '../../core/types';
import { sJGame, makeState } from './logic';
import type { SJState } from './logic';

/**
 * S-J 射手與靶的規則測試。全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 0 號邊是人、1 號邊是 AI；第一局 0 號邊射、1 號邊躲，第二局交換。
 */
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];
const press = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const CONFIG = { maxTicks: 3600, params: {} };

function run(state: SJState, count: number, inputs: Inputs = IDLE): SJState {
  let s = state;
  for (let i = 0; i < count; i += 1) {
    s = sJGame.step(s, inputs);
  }
  return s;
}

const FIRE: Inputs = [press({ a: true }), NONE];

describe('S-J 射手與靶｜規則', () => {
  it('1. 初始：第一局、0 號邊射、彈藥 5、沒有子彈、一局 1500 tick、分數 0 比 0', () => {
    const s = sJGame.init(3, CONFIG);
    expect([s.round, s.shooter, s.ammo, s.bullets.length, s.roundTicks]).toEqual([
      0, 0, 5, 0, 1500,
    ]);
    expect(sJGame.score(s)).toEqual([0, 0]);
    expect(sJGame.isOver(s)).toBe(false);
  });

  it('2. 射手的游標：左右每 tick 2.5 像素；（邊界）夾在 [2, 148]', () => {
    const s = makeState({ cursor: 75 });
    expect(sJGame.step(s, [press({ right: true }), NONE]).cursor).toBe(77.5);
    expect(sJGame.step(s, [press({ left: true }), NONE]).cursor).toBe(72.5);
    expect(run(makeState({ cursor: 146 }), 5, [press({ right: true }), NONE]).cursor).toBe(148);
    expect(run(makeState({ cursor: 4 }), 5, [press({ left: true }), NONE]).cursor).toBe(2);
  });

  it('3. 開火：子彈出現在游標 x（抖動不超過 ±4）、y 是 0、往下每 tick 2；彈藥少 1、冷卻 20', () => {
    const s = sJGame.step(makeState({ cursor: 75 }), FIRE);
    expect(s.bullets).toHaveLength(1);
    expect(Math.abs((s.bullets[0] as { x: number }).x - 75)).toBeLessThanOrEqual(4);
    expect((s.bullets[0] as { y: number }).y).toBe(0);
    expect([s.ammo, s.cooldown]).toEqual([4, 20]);
    expect((sJGame.step(s, IDLE).bullets[0] as { y: number }).y).toBe(2);
  });

  it('4.（邊界）沒有彈藥：按 a 沒有子彈；躲的人按 a 只是慢速，不會射', () => {
    expect(sJGame.step(makeState({ ammo: 0 }), FIRE).bullets).toHaveLength(0);
    expect(sJGame.step(makeState({ ammo: 3 }), [NONE, press({ a: true })]).bullets).toHaveLength(0);
  });

  it('5. 冷卻 20 tick：按住 a，第 1 與第 22 個 tick 各一發（21 個 tick 只有 1 發）', () => {
    expect(run(makeState({}), 21, FIRE).ammo).toBe(4);
    expect(run(makeState({}), 22, FIRE).ammo).toBe(3);
  });

  it('6. 補彈：每 90 tick 補 1 發；（邊界）滿了不超過上限 5', () => {
    const s = sJGame.step(makeState({ ammo: 2, regen: 1 }), IDLE);
    expect([s.ammo, s.regen]).toEqual([3, 90]);
    expect(run(makeState({ ammo: 5, regen: 1 }), 3).ammo).toBe(5);
    expect(sJGame.step(makeState({ ammo: 2, regen: 5 }), IDLE).regen).toBe(4);
  });

  it('7. 躲的人：八方向 1.5、按住 a 是 0.6、夾在場地內；射手的方向鍵不會移動躲的人', () => {
    const s = makeState({ px: 75, py: 100 });
    const moved = sJGame.step(s, [NONE, press({ right: true, up: true })]);
    expect(Math.hypot(moved.px - 75, moved.py - 100)).toBeCloseTo(1.5, 10);
    expect(sJGame.step(s, [NONE, press({ right: true, a: true })]).px).toBeCloseTo(75.6, 10);
    expect(
      run(makeState({ px: 147, py: 217 }), 9, [NONE, press({ right: true, down: true })]).px,
    ).toBe(147);
    expect(sJGame.step(s, [press({ right: true, down: true }), NONE]).px).toBe(75);
  });

  it('8. 命中：距離小於 5，射手 +1 命中（10 分），子彈消失，躲的人無敵 60 tick', () => {
    const s = sJGame.step(makeState({ px: 75, py: 100, bullets: [{ x: 75, y: 95 }] }), IDLE);
    expect(s.hits).toEqual([1, 0]);
    expect(s.bullets).toHaveLength(0);
    expect(s.invuln).toBe(60);
    expect(sJGame.score(s)[0]).toBe(10);
  });

  it('9.（邊界）距離剛好 5 不算命中；無敵中子彈穿過不算、也不消失', () => {
    // 子彈 y 93 移動後 95，距離剛好 5
    const edge = sJGame.step(makeState({ px: 75, py: 100, bullets: [{ x: 75, y: 93 }] }), IDLE);
    expect(edge.hits).toEqual([0, 0]);
    const guarded = sJGame.step(
      makeState({ px: 75, py: 100, invuln: 30, bullets: [{ x: 75, y: 98 }] }),
      IDLE,
    );
    expect(guarded.hits).toEqual([0, 0]);
    expect(guarded.bullets).toHaveLength(1);
    expect(guarded.invuln).toBe(29);
  });

  it('10. 上半場得分：躲的人在 y < 80 每 10 個 tick 得 1 分；（邊界）y 剛好 80 不算', () => {
    const inZone = run(makeState({ px: 75, py: 79.9 }), 10);
    expect(sJGame.score(inZone)).toEqual([0, 1]);
    expect(sJGame.score(run(makeState({ px: 75, py: 79.9 }), 9))).toEqual([0, 0]);
    expect(sJGame.score(run(makeState({ px: 75, py: 80 }), 20))).toEqual([0, 0]);
  });

  it('11. 子彈離開下緣就移除', () => {
    const s = sJGame.step(makeState({ px: 10, py: 10, bullets: [{ x: 140, y: 221 }] }), IDLE);
    expect(s.bullets).toHaveLength(0);
  });

  it('12. 兩局交換：第 1500 tick 進第二局，1 號邊變射手、彈藥回到 5、子彈清空、分數保留、位置鏡射', () => {
    const before = makeState({
      tick: 1499,
      cursor: 40,
      px: 100,
      hits: [2, 0],
      ammo: 1,
      bullets: [{ x: 5, y: 5 }],
    });
    const s = sJGame.step(before, IDLE);
    expect([s.round, s.shooter, s.ammo, s.bullets.length, s.hits]).toEqual([1, 1, 5, 0, [2, 0]]);
    const init = sJGame.init(1, CONFIG);
    const second = run(init, 1500);
    expect(second.round).toBe(1);
    expect(second.cursor).toBe(150 - init.cursor);
    expect(second.px).toBe(150 - init.px);
  });

  it('13. 第二局角色對調：actions 射手 6 個、躲的人 17 個，兩局互換', () => {
    const r0 = makeState({});
    const r1 = makeState({ tick: 1500, round: 1 });
    expect([sJGame.actions(r0, 0).length, sJGame.actions(r0, 1).length]).toEqual([6, 17]);
    expect([sJGame.actions(r1, 0).length, sJGame.actions(r1, 1).length]).toEqual([17, 6]);
    expect(sJGame.step(r1, [NONE, FIRE[0]]).bullets).toHaveLength(1);
  });

  it('14. 結束：第 3000 tick isOver，兩局加總高的贏，同分平手；結束後 step 原樣回傳', () => {
    const end = (hits: [number, number], zone: [number, number]): SJState =>
      sJGame.step(makeState({ tick: 2999, round: 1, hits, zone }), IDLE);
    const a = end([2, 1], [0, 0]);
    expect(sJGame.isOver(a)).toBe(true);
    expect(sJGame.score(a)).toEqual([20, 10]);
    expect(sJGame.winner(a)).toBe(0);
    expect(sJGame.winner(end([1, 1], [30, 30]))).toBeNull();
    expect(sJGame.winner(end([0, 1], [200, 0]))).toBe(0);
    expect(sJGame.step(a, IDLE)).toBe(a);
    expect(sJGame.winner(makeState({ tick: 2000, round: 1 }))).toBeNull();
  });

  it('15. maxTicks 比 3000 小：一局是 maxTicks 的一半', () => {
    const s = sJGame.init(0, { maxTicks: 1000, params: {} });
    expect(s.roundTicks).toBe(500);
    expect(sJGame.isOver(run(s, 1000))).toBe(true);
  });

  it('16. 隨機：起始位置與子彈抖動都由種子決定，十個種子不全相同；連續兩發的抖動不同；新的亂數狀態寫回 state', () => {
    const inits = Array.from({ length: 10 }, (_, i) => sJGame.init(i, CONFIG));
    expect(new Set(inits.map((s) => `${s.cursor}|${s.px}`)).size).toBeGreaterThan(5);
    const first = sJGame.step(makeState({ cursor: 75 }), FIRE);
    const second = run(first, 21, FIRE);
    const xs = second.bullets.filter((b) => b.y === 0).map((b) => b.x);
    expect(xs[0]).not.toBe((first.bullets[0] as { x: number }).x);
    expect(first.rng).not.toBe(makeState({}).rng);
    expect(second.rng).not.toBe(first.rng);
  });

  it('17. step 不改動傳進來的 state（凍結也能 step），JSON 來回不變', () => {
    const deep = (o: unknown): void => {
      if (typeof o === 'object' && o !== null) {
        Object.freeze(o);
        Object.values(o).forEach(deep);
      }
    };
    const s = makeState({ bullets: [{ x: 75, y: 50 }], ammo: 3 });
    deep(s);
    expect(() => sJGame.step(s, FIRE)).not.toThrow();
    const next = sJGame.step(s, FIRE);
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });
});

const decide = (
  name: 'precise' | 'greedy' | 'gambler' | 'pathfinder',
  s: SJState,
  side: Side,
  depth = 1,
): Buttons => policyByName(name).decide(sJGame, s, side, 0, { depth, seed: 1 });

describe('S-J 射手與靶｜AI 的選擇', () => {
  it('A. 躲的人看彈藥：射手沒彈藥時精準型衝進上半場（往上），有彈藥又在游標那一欄時不進去', () => {
    const base = { px: 75, py: 85, cursor: 75 };
    expect(decide('precise', makeState({ ...base, ammo: 0 }), 1).up).toBe(true);
    expect(decide('precise', makeState({ ...base, ammo: 5 }), 1).up).toBe(false);
  });

  it('B. 射手留彈藥：躲的人遠在下面、游標也沒對準時不開火；對準了而且躲的人往這邊走時開火', () => {
    const calm = makeState({ cursor: 20, px: 120, py: 200, ammo: 5 });
    expect(decide('precise', calm, 0).a).toBe(false);
    const target = makeState({ cursor: 75, px: 75, py: 120, ammo: 5 });
    expect(decide('precise', target, 0).a).toBe(true);
  });

  it('C. 射手會把游標移向躲的人：躲的人在右邊，游標往右', () => {
    const s = makeState({ cursor: 30, px: 120, py: 120, ammo: 5 });
    expect(decide('precise', s, 0).right).toBe(true);
  });

  it('D. 彈藥公開而且 evaluate 會看它：同一個局面，射手有彈藥的 gain 比沒彈藥高', () => {
    const a = sJGame.evaluate(makeState({ ammo: 4 }), 0).gain;
    const b = sJGame.evaluate(makeState({ ammo: 0 }), 0).gain;
    expect(a).toBeGreaterThan(b);
    expect(sJGame.evaluate(makeState({ ammo: 4 }), 0).danger).toBe(0);
  });

  it('E. 導演不看分差：兩邊分數對調（射手領先或落後），射手的選擇不變', () => {
    const lead = makeState({ cursor: 30, px: 120, py: 120, hits: [3, 0] });
    const trail = makeState({ cursor: 30, px: 120, py: 120, hits: [0, 3] });
    expect(decide('precise', lead, 0)).toEqual(decide('precise', trail, 0));
  });

  it('F. 留一發：同一個「有點準但不夠準」的局面（躲的人站在旁邊 16 像素），只剩 1 發的射手不開火，還有 3 發的射手開火', () => {
    const base = { cursor: 59, px: 75, py: 100 };
    expect(decide('precise', makeState({ ...base, ammo: 1 }), 0).a).toBe(false);
    expect(decide('precise', makeState({ ...base, ammo: 3 }), 0).a).toBe(true);
  });

  it('G. 彈藥是躲的人的窗口：射手還有 3 發，精準型不進游標那一欄的上半場；只剩 1 發就敢進去', () => {
    const base = { px: 75, py: 85, cursor: 75 };
    expect(decide('precise', makeState({ ...base, ammo: 3 }), 1).up).toBe(false);
    expect(decide('precise', makeState({ ...base, ammo: 1 }), 1).up).toBe(true);
  });
});
