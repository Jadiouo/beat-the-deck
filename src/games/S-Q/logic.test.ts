import { describe, expect, it } from 'vitest';
import { policyByName } from '../../ai/level';
import { humanModel } from '../../ai/human-model';
import type { Buttons, Inputs } from '../../core/types';
import { describeSharedSpadesRules } from '../_spades/shared-rules.test-helpers';
import { sQGame, makeState, ACTIVE_TICKS, IMMUNE_TICKS, PENDING_TICKS } from './logic';
import type { SQState } from './logic';

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];
const press = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const GRAZE_FIELD = { px: 75, py: 100, bullets: [{ x: 83, y: 100, vx: 0, vy: 0 }] };

function run(s: SQState, n: number, inputs: Inputs = IDLE): SQState {
  let cur = s;
  for (let i = 0; i < n; i += 1) {
    cur = sQGame.step(cur, inputs);
  }
  return cur;
}

describeSharedSpadesRules({
  label: 'S-Q 鏡像',
  game: sQGame,
  makeState,
  scoreOfHits: (hits) => 0 - 5 * hits,
  busy: { min: 8, max: 50 },
});

describe('S-Q 鏡像｜規則', () => {
  it('1. 初始：沒有人被反轉、觸發數 0、擦彈模式', () => {
    const s = sQGame.init(2, CONFIG);
    expect(s.mirror).toEqual([
      { pending: 0, active: 0, immune: 0 },
      { pending: 0, active: 0, immune: 0 },
    ]);
    expect(s.triggers).toEqual([0, 0]);
    expect(s.mode).toBe('graze');
  });

  it('2. 反轉中：左鍵往右走、右鍵往左走；只有被反轉的那一邊，上下與慢速不變', () => {
    const s = makeState({ mirror: [{ active: 10 }, {}] });
    const next = sQGame.step(s, [press({ left: true }), press({ left: true })]);
    expect(next.fields[0].px).toBe(76.5);
    expect(next.fields[1].px).toBe(73.5);
    const up = sQGame.step(s, [press({ up: true, a: true }), NONE]);
    expect(up.fields[0].py).toBeCloseTo(190 - 0.6, 10);
  });

  it('3. 玩家擦彈：AI 進入預告（30 tick）、玩家的觸發數 +1；玩家自己不會被反轉', () => {
    const s = sQGame.step(makeState({ fields: [GRAZE_FIELD, {}] }), IDLE);
    expect(s.fields[0].grazes).toBe(1);
    expect(s.mirror[1]).toEqual({ pending: PENDING_TICKS, active: 0, immune: 0 });
    expect(s.mirror[0]).toEqual({ pending: 0, active: 0, immune: 0 });
    expect(s.triggers).toEqual([1, 0]);
  });

  it('4. AI 擦彈：玩家進入預告（雙方都能觸發，規則對稱）', () => {
    const s = sQGame.step(makeState({ fields: [{}, GRAZE_FIELD] }), IDLE);
    expect(s.mirror[0].pending).toBe(PENDING_TICKS);
    expect(s.mirror[1].pending).toBe(0);
    expect(s.triggers).toEqual([0, 1]);
  });

  it('5. 預告期按鍵還是正常的；（邊界）預告只剩 1 tick 時 step 之後變成反轉 120 tick，下一步才反過來', () => {
    const warning = makeState({ mirror: [{ pending: 5 }, {}] });
    expect(sQGame.step(warning, [press({ left: true }), NONE]).fields[0].px).toBe(73.5);
    const edge = sQGame.step(makeState({ mirror: [{ pending: 1 }, {}] }), IDLE);
    expect(edge.mirror[0]).toEqual({ pending: 0, active: ACTIVE_TICKS, immune: 0 });
    expect(sQGame.step(edge, [press({ left: true }), NONE]).fields[0].px).toBe(76.5);
  });

  it('6.（邊界）反轉剩 1 tick：這一步還是反的，之後進入免疫 120 tick；免疫倒數完才能再被觸發', () => {
    const last = makeState({ mirror: [{ active: 1 }, {}] });
    const next = sQGame.step(last, [press({ left: true }), NONE]);
    expect(next.fields[0].px).toBe(76.5);
    expect(next.mirror[0]).toEqual({ pending: 0, active: 0, immune: IMMUNE_TICKS });
    expect(run(makeState({ mirror: [{ immune: 3 }, {}] }), 3).mirror[0].immune).toBe(0);
  });

  it('7. 已經在預告、反轉或免疫：再擦彈也不會重新觸發、不疊加、不延長，觸發數不增加', () => {
    for (const m of [{ pending: 10 }, { active: 10 }, { immune: 10 }]) {
      const s = sQGame.step(makeState({ fields: [GRAZE_FIELD, {}], mirror: [{}, m] }), IDLE);
      expect(s.fields[0].grazes).toBe(1);
      expect(s.triggers).toEqual([0, 0]);
      const key = Object.keys(m)[0] as 'pending' | 'active' | 'immune';
      expect(s.mirror[1][key]).toBe(9);
    }
  });

  it('8. 同一個 tick 兩邊都擦彈：兩邊都進入預告', () => {
    const s = sQGame.step(makeState({ fields: [GRAZE_FIELD, GRAZE_FIELD] }), IDLE);
    expect(s.mirror[0].pending).toBe(PENDING_TICKS);
    expect(s.mirror[1].pending).toBe(PENDING_TICKS);
    expect(s.triggers).toEqual([1, 1]);
  });

  it('9. 無敵期間的子彈不算擦彈，所以也不觸發', () => {
    const s = sQGame.step(makeState({ fields: [{ ...GRAZE_FIELD, invuln: 20 }, {}] }), IDLE);
    expect(s.fields[0].grazes).toBe(0);
    expect(s.mirror[1].pending).toBe(0);
  });

  it('10. 隨機：不同種子的子彈位置不全相同；step 不改動凍結的 state；JSON 來回不變', () => {
    const xs = Array.from({ length: 10 }, (_, i) => run(sQGame.init(i, CONFIG), 15).fields[0].bullets[0]?.x);
    expect(new Set(xs).size).toBeGreaterThan(5);
    const deep = (o: unknown): void => {
      if (typeof o === 'object' && o !== null) {
        Object.freeze(o);
        Object.values(o).forEach(deep);
      }
    };
    const s = makeState({ fields: [GRAZE_FIELD, {}], mirror: [{ active: 5 }, {}] });
    deep(s);
    const next = sQGame.step(s, IDLE);
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });
});

describe('S-Q 鏡像｜AI', () => {
  const decide = (name: 'precise' | 'greedy', s: SQState, side: 0 | 1): Buttons =>
    policyByName(name).decide(sQGame, s, side, 0, { depth: 1, seed: 1 });

  it('A. 被反轉的 AI 會改按另一邊的鍵：實際走的方向仍然是遠離子彈', () => {
    // 子彈從正上方偏左飛來，玩家要往右躲。
    const field = { px: 75, py: 100, bullets: [{ x: 72, y: 85, vx: 0, vy: 1.2 }] };
    const normal = makeState({ fields: [{}, field] });
    const mirrored = makeState({ fields: [{}, field], mirror: [{}, { active: 50 }] });
    const n = sQGame.step(normal, [NONE, decide('precise', normal, 1)]);
    const m = sQGame.step(mirrored, [NONE, decide('precise', mirrored, 1)]);
    expect(n.fields[1].px).toBeGreaterThan(75);
    expect(m.fields[1].px).toBeGreaterThan(75);
    expect(decide('precise', mirrored, 1).left).toBe(true);
  });

  it('B. 對方可以被觸發時，預測會擦彈的 evaluate 的 gain 比較高（反轉是 AI 追求的武器）；對方在免疫期就沒有這一項', () => {
    const field = { px: 75, py: 100, bullets: [{ x: 83, y: 100, vx: 0, vy: 0 }], vx: 0 };
    const open = sQGame.evaluate(makeState({ fields: [{}, field] }), 1).gain;
    const immune = sQGame.evaluate(makeState({ fields: [{}, field], mirror: [{ immune: 50 }, {}] }), 1).gain;
    expect(open).toBeGreaterThan(immune + 30);
  });

  it('C. 雙方都用過、而且玩家主動觸發不是零：人類模型對精準型等級 5，6 場裡人類的觸發數與 AI 的觸發數都大於 0', () => {
    let human = 0;
    let ai = 0;
    for (let seed = 0; seed < 6; seed += 1) {
      let s = sQGame.init(seed, CONFIG);
      const h = humanModel(sQGame, seed);
      let t = 0;
      while (!sQGame.isOver(s)) {
        s = sQGame.step(s, [h.decide(s, 0, t), policyByName('precise').decide(sQGame, s, 1, t, { depth: 1, seed })]);
        t += 1;
      }
      human += s.triggers[0];
      ai += s.triggers[1];
    }
    expect(human).toBeGreaterThan(0);
    expect(ai).toBeGreaterThan(0);
  }, 60000);
});
