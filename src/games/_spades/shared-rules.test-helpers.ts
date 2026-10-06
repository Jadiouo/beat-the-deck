import { describe, expect, it } from 'vitest';

import type { Buttons, Game, Inputs } from '../../core/types';
import type { SpadesState, StateOverrides } from './logic';

/**
 * 黑桃三張牌共用的規則測試。
 * TEST_PLAN 第 6 節 S-2 的第 7 條：「S-A 的 2 到 7、9 成立」；S-3 的子彈同 S-2，所以三張牌共用同一組。
 * （S-A 的第 1、8、10 條與種子測試是落雨自己的，留在 `S-A/logic.test.ts`。）
 *
 * 每個 `describe` 函式收一個 `SpadesSuite`：牌的 game、`makeState`、名稱。
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 * 這個檔案不叫 `*.test.ts`，所以 vitest 不會單獨跑它；由各張牌的 `logic.test.ts` 呼叫。
 */

export interface SpadesSuite {
  /** 測試標題的前綴，例如 `S-A 落雨`。 */
  readonly label: string;
  readonly game: Game<SpadesState>;
  readonly makeState: (overrides?: StateOverrides) => SpadesState;
  /** 沒有擦彈、被打中 `hits` 次時的分數。預設是 `0 - hits`（S-A、S-2）；S-3 是 `0 - 5 × hits`。 */
  readonly scoreOfHits?: (hits: number) => number;
  /** 整場跑完（站著不動）場上最多子彈數的合理範圍（開區間）。預設 (20, 50)。 */
  readonly busy?: { readonly min: number; readonly max: number };
}

const CONFIG = { maxTicks: 3600, params: {} };
const NONE: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };
const IDLE: Inputs = [NONE, NONE];
const pressing = (keys: Partial<Buttons>): Buttons => ({ ...NONE, ...keys });
const both = (buttons: Buttons): Inputs => [buttons, buttons];

/** 共用規則：移動、邊界、命中、無敵、離場、結束與分數。 */
export function describeSharedSpadesRules(suite: SpadesSuite): void {
  const { label, game, makeState } = suite;
  const scoreOf = suite.scoreOfHits ?? ((hits: number): number => 0 - hits);
  const busy = suite.busy ?? { min: 20, max: 50 };
  /** 跑 n 個 tick，每個 tick 都給同一組輸入。 */
  const run = (state: SpadesState, count: number, inputs: Inputs = IDLE): SpadesState => {
    let current = state;
    for (let i = 0; i < count; i += 1) {
      current = game.step(current, inputs);
    }
    return current;
  };

  describe(`${label}｜共用規則（TEST_PLAN S-A 第 2–7、9 條）`, () => {
    it('2. 按右：每 tick x 加 1.5；同時按右與上：斜向移動，速度仍是 1.5（不是 1.5×√2）', () => {
      const start = makeState();
      const right = game.step(start, both(pressing({ right: true })));
      expect(right.fields[0].px - start.fields[0].px).toBeCloseTo(1.5, 10);
      expect(right.fields[0].py).toBe(start.fields[0].py);

      const diagonal = game.step(start, both(pressing({ right: true, up: true })));
      const dx = diagonal.fields[0].px - start.fields[0].px;
      const dy = diagonal.fields[0].py - start.fields[0].py;
      expect(dx).toBeGreaterThan(0);
      expect(dy).toBeLessThan(0);
      expect(Math.hypot(dx, dy)).toBeCloseTo(1.5, 10);
      expect(Math.hypot(dx, dy)).not.toBeCloseTo(1.5 * Math.SQRT2, 3);
    });

    it('2b. 八個方向的合速度都是 1.5；同時按相反的兩個方向互相抵消', () => {
      const start = makeState();
      const dirs: Partial<Buttons>[] = [
        { up: true },
        { down: true },
        { left: true },
        { right: true },
        { up: true, left: true },
        { up: true, right: true },
        { down: true, left: true },
        { down: true, right: true },
      ];
      for (const dir of dirs) {
        const next = game.step(start, both(pressing(dir)));
        const moved = Math.hypot(
          next.fields[0].px - start.fields[0].px,
          next.fields[0].py - start.fields[0].py,
        );
        expect(moved).toBeCloseTo(1.5, 10);
      }
      const cancelled = game.step(start, both(pressing({ left: true, right: true })));
      expect(cancelled.fields[0].px).toBe(start.fields[0].px);
      const cancelledDiagonal = game.step(
        start,
        both(pressing({ left: true, right: true, up: true })),
      );
      expect(start.fields[0].py - cancelledDiagonal.fields[0].py).toBeCloseTo(1.5, 10);
      expect(cancelledDiagonal.fields[0].px).toBe(start.fields[0].px);
    });

    it('3. 按住 a：速度變成 0.6（斜向也是 0.6）', () => {
      const start = makeState();
      const slow = game.step(start, both(pressing({ right: true, a: true })));
      expect(slow.fields[0].px - start.fields[0].px).toBeCloseTo(0.6, 10);
      const diagonal = game.step(start, both(pressing({ left: true, down: true, a: true })));
      const moved = Math.hypot(
        diagonal.fields[0].px - start.fields[0].px,
        diagonal.fields[0].py - start.fields[0].py,
      );
      expect(moved).toBeCloseTo(0.6, 10);
      // 只按 a 不動。
      const still = game.step(start, both(pressing({ a: true })));
      expect(still.fields[0].px).toBe(start.fields[0].px);
      expect(still.fields[0].py).toBe(start.fields[0].py);
    });

    it('4. 走到場地邊緣：停在邊緣，不出界（玩家的圓整個在 150×220 之內）', () => {
      const edge = makeState({
        fields: [
          { px: 147, py: 217 },
          { px: 3, py: 3 },
        ],
      });
      const pushed = run(edge, 20, [
        pressing({ right: true, down: true }),
        pressing({ left: true, up: true }),
      ]);
      expect(pushed.fields[0].px).toBe(147);
      expect(pushed.fields[0].py).toBe(217);
      expect(pushed.fields[1].px).toBe(3);
      expect(pushed.fields[1].py).toBe(3);
    });

    it('4b. 邊界：離邊緣不到一步時夾在邊緣上（不是停在原地、也不是出界）；貼牆時另一軸照常滑行', () => {
      const near = makeState({ fields: [{ px: 146.5, py: 100 }, {}] });
      const next = game.step(near, both(pressing({ right: true })));
      expect(next.fields[0].px).toBe(147);
      // 貼著右牆按「右＋上」：x 停在牆上，y 以斜向分量（1.5/√2）往上走。
      const wall = makeState({ fields: [{ px: 147, py: 100 }, {}] });
      const slid = game.step(wall, both(pressing({ right: true, up: true })));
      expect(slid.fields[0].px).toBe(147);
      expect(100 - slid.fields[0].py).toBeCloseTo(1.5 * Math.SQRT1_2, 10);
      // 四個邊都試一次。
      const corners = makeState({
        fields: [
          { px: 3, py: 217 },
          { px: 147, py: 3 },
        ],
      });
      const out = run(corners, 5, [
        pressing({ left: true, down: true }),
        pressing({ right: true, up: true }),
      ]);
      expect([out.fields[0].px, out.fields[0].py]).toEqual([3, 217]);
      expect([out.fields[1].px, out.fields[1].py]).toEqual([147, 3]);
    });

    it('5. 子彈與玩家的中心距離小於 5（3＋2）：命中數加 1，那顆子彈消失，並且無敵 60 tick', () => {
      const state = makeState({
        fields: [
          { px: 75, py: 100, bullets: [{ x: 75, y: 96, vy: 0 }] },
          { px: 75, py: 100, bullets: [{ x: 75, y: 90, vy: 0 }] },
        ],
      });
      const next = game.step(state, IDLE);
      expect(next.fields[0].hits).toBe(1);
      expect(next.fields[0].bullets).toHaveLength(0);
      expect(next.fields[0].invuln).toBe(60);
      // 距離 10：沒有命中，子彈還在。
      expect(next.fields[1].hits).toBe(0);
      expect(next.fields[1].bullets).toHaveLength(1);
    });

    it('5b. 邊界：距離剛好 5 不算命中；4.999 算', () => {
      const exact = makeState({
        fields: [{ px: 75, py: 100, bullets: [{ x: 80, y: 100, vx: 0, vy: 0 }] }, {}],
      });
      const miss = game.step(exact, IDLE);
      expect(miss.fields[0].hits).toBe(0);
      expect(miss.fields[0].bullets).toHaveLength(1);

      const inside = makeState({
        fields: [{ px: 75, py: 100, bullets: [{ x: 79.999, y: 100, vx: 0, vy: 0 }] }, {}],
      });
      expect(game.step(inside, IDLE).fields[0].hits).toBe(1);
    });

    it('5c. 命中是用「這個 tick 移動之後」的位置判定：迎面飛來的子彈在這個 tick 就打到', () => {
      // 子彈在 y=96.5，下一個 tick 移到 97.7，距離 2.3；玩家站著。
      const state = makeState({
        fields: [{ px: 75, py: 100, bullets: [{ x: 75, y: 96.5 }] }, {}],
      });
      expect(game.step(state, IDLE).fields[0].hits).toBe(1);
    });

    it('6. 命中後 60 tick 內再碰到子彈：不算，子彈也不消失；第 61 個 tick 才又會被打中', () => {
      // 一顆不動的子彈壓在玩家身上，玩家剛被打中（invuln = 60）。落雨照常生成新子彈，所以只看壓在玩家身上的那一顆。
      const onPlayer = (b: { x: number; y: number }): boolean => b.x === 75 && b.y === 100;
      let state = makeState({
        fields: [{ px: 75, py: 100, hits: 1, invuln: 60, bullets: [{ x: 75, y: 100, vy: 0 }] }, {}],
      });
      for (let t = 1; t <= 60; t += 1) {
        state = game.step(state, IDLE);
        expect(state.fields[0].hits).toBe(1);
        expect(state.fields[0].bullets.some(onPlayer)).toBe(true);
      }
      expect(state.fields[0].invuln).toBe(0);
      state = game.step(state, IDLE);
      expect(state.fields[0].hits).toBe(2);
      expect(state.fields[0].bullets.some(onPlayer)).toBe(false);
      expect(state.fields[0].invuln).toBe(60);
    });

    it('6b. 邊界：invuln 剩 1 還是無敵、剩 0 就會被打中', () => {
      const hit = (invuln: number): SpadesState =>
        game.step(
          makeState({
            fields: [{ px: 75, py: 100, invuln, bullets: [{ x: 75, y: 100, vy: 0 }] }, {}],
          }),
          IDLE,
        );
      expect(hit(1).fields[0].hits).toBe(0);
      expect(hit(1).fields[0].invuln).toBe(0);
      expect(hit(0).fields[0].hits).toBe(1);
    });

    it('6c. 邊界：同一個 tick 同時碰到兩顆：只算一次命中，依陣列順序第一顆消失、第二顆留著', () => {
      const state = makeState({
        fields: [
          {
            px: 75,
            py: 100,
            bullets: [
              { x: 73, y: 100, vy: 0 },
              { x: 77, y: 100, vy: 0 },
            ],
          },
          {},
        ],
      });
      const next = game.step(state, IDLE);
      expect(next.fields[0].hits).toBe(1);
      expect(next.fields[0].bullets).toEqual([expect.objectContaining({ x: 77 })]);
    });

    it('7. 子彈離開下緣：從 state 移除（陣列不會無限長）', () => {
      const state = makeState({
        fields: [
          {
            px: 10,
            py: 10,
            bullets: [
              { x: 100, y: 221 }, // 下一個 tick 到 222.2，整顆都出了下緣
              { x: 100, y: 200 }, // 還在場內
            ],
          },
          {},
        ],
      });
      const next = game.step(state, IDLE);
      expect(next.fields[0].bullets).toHaveLength(1);
      expect(next.fields[0].bullets[0]?.y).toBeCloseTo(201.2, 10);
    });

    it('7b. 整場跑完：任何時刻場上的子彈數都有上限、而且都在場內', () => {
      let state = game.init(3, CONFIG);
      let most = 0;
      for (let t = 0; t < 3600; t += 1) {
        state = game.step(state, IDLE);
        for (const field of state.fields) {
          most = Math.max(most, field.bullets.length);
          for (const b of field.bullets) {
            expect(b.y).toBeLessThanOrEqual(222);
          }
        }
      }
      // 一顆子彈在場內最多 ~185 個 tick：場上的子彈數有上限（不會無限長），也不是空轉。
      expect(most).toBeGreaterThan(busy.min);
      expect(most).toBeLessThan(busy.max);
    });

    it('9. 分數隨命中數遞減；命中數少的贏，一樣多是平手', () => {
      const last = (hits0: number, hits1: number): SpadesState =>
        game.step(makeState({ tick: 3599, fields: [{ hits: hits0 }, { hits: hits1 }] }), IDLE);
      const lose = last(3, 1);
      expect(game.isOver(lose)).toBe(true);
      expect(game.score(lose)).toEqual([scoreOf(3), scoreOf(1)]);
      expect(game.winner(lose)).toBe(1);
      const win = last(0, 2);
      expect(game.score(win)).toEqual([scoreOf(0), scoreOf(2)]);
      expect(game.winner(win)).toBe(0);
      const draw = last(2, 2);
      expect(game.winner(draw)).toBeNull();
      // 0 分是最高分：沒被打中的贏過被打中的。
      expect(game.winner(last(1, 0))).toBe(1);
    });

    it('9b. 邊界：第 3599 個 tick 還沒結束，第 3600 個 tick 結束；結束後 step 不改變任何東西', () => {
      const before = makeState({ tick: 3598 });
      const middle = game.step(before, IDLE);
      expect(middle.tick).toBe(3599);
      expect(game.isOver(middle)).toBe(false);
      expect(game.winner(middle)).toBeNull();
      const end = game.step(middle, IDLE);
      expect(game.isOver(end)).toBe(true);
      expect(game.step(end, both(pressing({ left: true })))).toBe(end);
    });
  });
}
