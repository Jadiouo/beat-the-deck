import { describe, expect, it } from 'vitest';

import { levelController } from '../../ai/level';
import { greedy } from '../../ai/policies/greedy';
import { precise } from '../../ai/policies/precise';
import { advance, lookOneStep } from '../../ai/policies/shared';
import { copyButtons } from '../../core/match';
import type { Buttons, Side } from '../../core/types';
import { cell, START_CELLS } from '../_diamonds/logic';
import { NONE, PRESS_LEFT, PRESS_RIGHT } from '../_diamonds/shared-rules.test-helpers';
import { CONFIG, dKGame, makeState } from './logic';
import type { DKState } from './logic';

/**
 * D-K 的 `actions`／`evaluate` 測試：三條連結要進得了 AI 的決定、`actions` 的排序要和 `evaluate` 的偏好一致、
 * 過場與結束的 `evaluate` 要可用。全部用 `makeState` 直接構造局面。
 */

const BASE_0 = START_CELLS[0];
const BASE_1 = START_CELLS[1];

function same(a: Buttons, b: Buttons): boolean {
  return (
    a.up === b.up && a.down === b.down && a.left === b.left && a.right === b.right && a.a === b.a
  );
}

describe('D-K｜actions', () => {
  it('每一段都是 5 個動作（上右下左與全放開），全放開永遠最後；結束的局也是', () => {
    const cases: DKState[] = [
      makeState({ tick: 100 }),
      makeState({ tick: 1200, gems: [{ cell: cell(10, 10), born: 1140 }] }),
      makeState({ tick: 2700, coins: [cell(10, 10)] }),
    ];
    for (const state of cases) {
      for (const side of [0, 1] as const) {
        const actions = dKGame.actions(state, side);
        expect(actions.length).toBe(5);
        expect(same(actions[4] as Buttons, NONE)).toBe(true);
      }
    }
  });

  it('第 2 段：兩顆價值相同、一樣遠的寶石，一顆在自己的顏色上（連結 1 的紅利），actions 把往那顆的方向排最前面', () => {
    const me = cell(10, 10);
    const turfGem = cell(15, 10);
    const plainGem = cell(5, 10);
    const state = makeState({
      tick: 1200,
      players: [{ cell: me }, { cell: cell(20, 20) }],
      paint0: [turfGem],
      gems: [
        { cell: plainGem, born: 1140 },
        { cell: turfGem, born: 1140 },
      ],
    });
    expect(same(dKGame.actions(state, 0)[0] as Buttons, PRESS_RIGHT)).toBe(true);
    // 顏色對調（紅利在左邊那顆）：方向也對調
    const flipped = makeState({
      tick: 1200,
      players: [{ cell: me }, { cell: cell(20, 20) }],
      paint0: [plainGem],
      gems: [
        { cell: plainGem, born: 1140 },
        { cell: turfGem, born: 1140 },
      ],
    });
    expect(same(dKGame.actions(flipped, 0)[0] as Buttons, PRESS_LEFT)).toBe(true);
  });

  it('第 2 段：紅利壓過價值：左邊無主、到手時價值 8，右邊在自己顏色上、到手時價值 6 + 紅利 3 = 9，actions 往右', () => {
    const me = cell(10, 10);
    const state = makeState({
      tick: 1200,
      players: [{ cell: me }, { cell: cell(20, 20) }],
      paint0: [cell(15, 10)],
      gems: [
        { cell: cell(5, 10), born: 1140 },
        { cell: cell(15, 10), born: 1020 },
      ],
    });
    expect(same(dKGame.actions(state, 0)[0] as Buttons, PRESS_RIGHT)).toBe(true);
    // 沒有紅利（右邊那格不是我的顏色）：價值 8 > 6，往左
    const plain = makeState({
      tick: 1200,
      players: [{ cell: me }, { cell: cell(20, 20) }],
      gems: [
        { cell: cell(5, 10), born: 1140 },
        { cell: cell(15, 10), born: 1020 },
      ],
    });
    expect(same(dKGame.actions(plain, 0)[0] as Buttons, PRESS_LEFT)).toBe(true);
  });
});

describe('D-K｜evaluate', () => {
  it('連結 1 進了評估：第 2 段站上自己顏色的寶石（下一步）的 gain，高於站上同價值的無主寶石', () => {
    // 人在 (10,10)，pending 往右，下一步是走格 tick；右邊 (11,10) 和左邊 (9,10) 各有一顆價值相同的寶石。
    const make = (turfSide: 'right' | 'left', press: 'right' | 'left'): number => {
      const state = makeState({
        tick: 1199,
        players: [{ cell: cell(10, 10) }, { cell: cell(25, 20) }],
        paint0: [turfSide === 'right' ? cell(11, 10) : cell(9, 10)],
        gems: [
          { cell: cell(11, 10), born: 1140 },
          { cell: cell(9, 10), born: 1140 },
        ],
      });
      const next = advance(dKGame, state, 0, press === 'right' ? PRESS_RIGHT : PRESS_LEFT);
      return dKGame.evaluate(next, 0).gain;
    };
    // 同一個局面：往有紅利的那顆走，gain 比往無主的那顆走高
    expect(make('right', 'right')).toBeGreaterThan(make('right', 'left'));
    expect(make('left', 'left')).toBeGreaterThan(make('left', 'right'));
  });

  it('連結 2 進了評估（偷的一方）：對手站在它自己顏色上時偷不了，所以「去偷」的 gain 比對手站在無主格上低', () => {
    const make = (onTurf: boolean): number => {
      const state = makeState({
        tick: 2700,
        players: [
          { cell: cell(25, 3), score: 100 },
          { cell: cell(10, 10), score: 100 },
        ],
        paint1: onTurf ? [cell(10, 10)] : [],
        coins: [],
      });
      return dKGame.evaluate(state, 0).gain;
    };
    const diff = make(false) - make(true);
    // 差的是「去偷」這一項（約 20 多），不是對手分數那 100 分（分數差兩種情況都要照實算）
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThan(100);
  });

  it('連結 2 進了評估（被偷的一方）：我站在自己顏色上時被偷的 danger 是 0；站在無主格上、對手已在我的基地旁待了 30 tick，danger 超過精準型的門檻 0.3', () => {
    const make = (onTurf: boolean): number => {
      const state = makeState({
        tick: 2700,
        players: [
          { cell: cell(12, 18), score: 100 },
          { cell: cell(1, 23), score: 100 },
        ],
        lurk: [0, 30],
        paint0: onTurf ? [cell(12, 18)] : [],
        coins: [],
      });
      return dKGame.evaluate(state, 0).danger;
    };
    expect(make(false)).toBeGreaterThan(0.3);
    expect(make(true)).toBe(0);
  });

  it('連結 3 進了評估：第 3 段的 gain 看的是累計分數差（第 1、2 段的分數也算），分數差 +1 枚金幣以上就比較高', () => {
    const lead = makeState({ tick: 2700, players: [{ score: 140 }, { score: 100 }] });
    const behind = makeState({ tick: 2700, players: [{ score: 100 }, { score: 140 }] });
    expect(dKGame.evaluate(lead, 0).gain).toBeGreaterThan(dKGame.evaluate(behind, 0).gain);
  });

  it('第 1 段：家附近的地盤進了 gain（同樣的格數，在家附近的比在遠處的高）', () => {
    const nearHome = makeState({
      tick: 300,
      paint0: [
        BASE_0,
        cell(1, 23),
        cell(2, 23),
        cell(3, 23),
        cell(4, 23),
        cell(0, 22),
        cell(0, 21),
        cell(1, 22),
      ],
    });
    const farAway = makeState({
      tick: 300,
      paint0: [
        cell(15, 10),
        cell(16, 10),
        cell(17, 10),
        cell(18, 10),
        cell(19, 10),
        cell(20, 10),
        cell(21, 10),
        cell(22, 10),
      ],
    });
    expect(dKGame.evaluate(nearHome, 0).gain).toBeGreaterThan(dKGame.evaluate(farAway, 0).gain);
  });

  it('第 1 段：越接近第 1 段結束、家附近越空，danger 越高；家附近鋪滿就是 0', () => {
    const farPaint = [cell(15, 10), cell(16, 10)];
    const early = makeState({
      tick: 100,
      paint0: farPaint,
      players: [{ cell: cell(15, 10) }, { cell: cell(31, 0) }],
    });
    const late = makeState({
      tick: 1000,
      paint0: farPaint,
      players: [{ cell: cell(15, 10) }, { cell: cell(31, 0) }],
    });
    expect(dKGame.evaluate(late, 0).danger).toBeGreaterThan(0.3);
    expect(dKGame.evaluate(early, 0).danger).toBeLessThan(0.3);
    const homeFull: number[] = [];
    for (let x = 0; x <= 6; x += 1) {
      for (let y = 23; y >= 18; y -= 1) {
        homeFull.push(cell(x, y));
      }
    }
    const filled = makeState({
      tick: 1000,
      paint0: homeFull,
      players: [{ cell: cell(15, 10) }, { cell: cell(31, 0) }],
    });
    expect(dKGame.evaluate(filled, 0).danger).toBeLessThan(0.05);
  });

  it('過場、結束：evaluate 是有限的數字、danger 是 0；結束的局贏的人 gain 遠大於輸的人', () => {
    for (const tick of [0, 1100, 2550]) {
      const state = makeState({ tick });
      for (const side of [0, 1] as const) {
        const { gain, danger } = dKGame.evaluate(state, side);
        expect(Number.isFinite(gain)).toBe(true);
        expect(danger).toBe(0);
      }
    }
    const done = dKGame.step(makeState({ tick: 3599, players: [{ score: 300 }, { score: 250 }] }), [
      NONE,
      NONE,
    ]);
    expect(done.over).toBe(true);
    expect(dKGame.evaluate(done, 0).gain).toBeGreaterThan(
      dKGame.evaluate(done, 1).gain + 1_000_000,
    );
  });

  it('不是橡皮筋：兩邊分數對調，同一個局面（左右鏡像）的選擇不變——第 2 段，同一顆寶石對兩邊的評估一樣', () => {
    // 人在左下、AI 在右上，各自距離同一類寶石一樣遠（180 度旋轉）；兩邊分數相同。
    const a = makeState({
      tick: 1200,
      players: [
        { cell: cell(5, 20), score: 150 },
        { cell: cell(26, 3), score: 150 },
      ],
      gems: [
        { cell: cell(8, 20), born: 1140 },
        { cell: cell(23, 3), born: 1140 },
      ],
    });
    const g0 = dKGame.evaluate(a, 0).gain;
    const g1 = dKGame.evaluate(a, 1).gain;
    expect(Math.abs(g0 - g1)).toBeLessThan(1e-6);
  });
});

describe('D-K｜actions 的排序和 evaluate 的偏好一致', () => {
  /**
   * 這個病在專案裡出現過五次（DESIGN-AI-FUN 10.54）：`actions()[0]` 不是 `evaluate` 偏好的動作，
   * 搜尋型平手時就選錯。這裡跑「兩個精準型對打」的真實局面，在每一段各取走格前一拍，看 `actions()[0]`
   * 是不是（或平手於）一步前瞻 gain 最高的動作。門檻是守門用的範圍（見 measure.test.ts 的實測值）。
   */
  it('第 1、2、3 段：actions()[0] 是（或不輸於）一步前瞻 gain 最高動作的比例 ≥ 70%', () => {
    const hits = [0, 0, 0];
    const total = [0, 0, 0];
    for (const seed of [0, 1, 2, 3]) {
      const c0 = levelController(dKGame, precise, 10, seed);
      const c1 = levelController(dKGame, precise, 10, seed + 77);
      let state = dKGame.init(seed, CONFIG);
      while (!dKGame.isOver(state)) {
        const tick = state.tick;
        const stage =
          tick >= 2580 ? 3 : tick >= 1140 && tick < 2520 ? 2 : tick >= 60 && tick < 1080 ? 1 : 0;
        if (stage > 0 && tick % 5 === 4 && tick % 20 === 4) {
          for (const side of [0, 1] as Side[]) {
            const scored = lookOneStep(dKGame, state, side);
            const best = Math.max(...scored.map((s) => s.gain));
            total[stage - 1] = (total[stage - 1] as number) + 1;
            if ((scored[0] as { gain: number }).gain >= best - 1e-9) {
              hits[stage - 1] = (hits[stage - 1] as number) + 1;
            }
          }
        }
        state = dKGame.step(state, [
          copyButtons(c0.decide(state, 0, tick)),
          copyButtons(c1.decide(state, 1, tick)),
        ]);
      }
    }
    for (let i = 0; i < 3; i += 1) {
      expect(total[i] as number).toBeGreaterThan(20);
      expect((hits[i] as number) / (total[i] as number), `第 ${i + 1} 段`).toBeGreaterThanOrEqual(
        0.7,
      );
    }
  }, 120_000);

  it('貪心型兩邊對打一場不會丟錯、會結束（evaluate 與 actions 在每一段都可用）', () => {
    const c0 = levelController(dKGame, greedy, 10, 5);
    const c1 = levelController(dKGame, greedy, 10, 6);
    let state = dKGame.init(5, CONFIG);
    for (let i = 0; i < 3600; i += 1) {
      state = dKGame.step(state, [
        copyButtons(c0.decide(state, 0, i)),
        copyButtons(c1.decide(state, 1, i)),
      ]);
    }
    expect(state.over).toBe(true);
    expect(BASE_1).not.toBe(BASE_0);
  });
});
