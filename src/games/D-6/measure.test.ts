import { describe, expect, it } from 'vitest';

import { wrapPolicy } from '../../ai/level';
import { pathfinder } from '../../ai/policies/pathfinder';
import { winRate } from '../../ai/evolution';
import { humanModel } from '../../ai/human-model';
import { levelController } from '../../ai/level';
import { playMatch } from '../../core/match';
import type { Controller, GameConfig } from '../../core/types';
import { BUY, PASS, SELL, d6Game } from './logic';
import type { D6State } from './logic';
import {
  CONFIG,
  H0,
  HUMAN,
  L10,
  alwaysBuyCloth,
  batch,
  curve,
  engine,
  follower,
  oracle,
  pump,
  pumpDumpCycle,
  roundTrip,
  S,
  sameButtons,
  seeds,
  uniform,
  withFeint,
} from './players.test-helpers';

/**
 * D-6 的量測（小規格「實作與量測」）：探針 A、探針 B、劇本玩家、餵了再破的第二欄與第四欄、局長、反應速度、等級曲線。
 * 都是真實規則、真實 AI、固定種子，所以數字是確定的；斷言寫在量到的值附近（不是目標值），
 * 萬一誰改了 `evaluate` 或規則，這些量測會跟著變，而不是悄悄漂掉。
 * 場數比小規格的量測少（那邊 200 到 400 場，在 session 的 scratchpad 跑）；設 `D6_VERBOSE=1` 會把量到的數字印出來。
 */

const LONG = 3_600_000;

function report(text: string): void {
  if (process.env['D6_VERBOSE'] !== undefined) {
    console.log(text);
  }
}

const cfg = (params: Record<string, number>): GameConfig => ({ maxTicks: 3600, params });

describe('D-6 探針 A｜讀對手的存貨值多少（對等級 10，邊輪流，平手半場）', () => {
  it(
    '(a) 不知道有對手 0%；(b) 知道價格共用、不讀它 0%；(c) 讀它（AI 自己的引擎，鏡像）一場場平手 → 50%',
    () => {
      const s = seeds(30);
      const a = batch(S(oracle), L10, s);
      const b = batch(engine('noModel'), L10, s);
      const c = batch(L10, L10, s);
      report(
        `探針 A：(a) ${a.rate}（現金 ${a.cashA.toFixed(1)} 對 ${a.cashB.toFixed(1)}）(b) ${b.rate}（${b.cashA.toFixed(1)} 對 ${b.cashB.toFixed(1)}）(c) ${c.rate}`,
      );
      expect(a.rate).toBeLessThanOrEqual(0.1);
      expect(b.rate).toBeLessThanOrEqual(0.1);
      expect(c.rate).toBe(0.5);
      expect(c.ties).toBe(s.length);
      // (c) − (b) 大，是因為 (c) 就是 AI 自己：讀對手是 AI 的強度。
      expect(b.cashB - b.cashA).toBeGreaterThan(3);
    },
    LONG,
  );

  it(
    '讀的是對手的存貨，不是它的習慣：拿掉歷史，一場場平手（決定完全一樣）；拿掉存貨，輸',
    () => {
      const s = seeds(30);
      const noHistory = batch(engine('hideHistory'), L10, s);
      const noStock = batch(engine('hideStock'), L10, s);
      report(
        `拿掉歷史 ${noHistory.rate}（平手 ${noHistory.ties}）；拿掉存貨 ${noStock.rate}（${noStock.diff.toFixed(2)}）`,
      );
      expect(noHistory.rate).toBe(0.5);
      expect(noHistory.ties).toBe(s.length);
      expect(noStock.rate).toBeLessThanOrEqual(0.05);
    },
    LONG,
  );
});

describe('D-6 探針 B｜換掉對手的歷史與存貨，AI 的最佳動作改變幾個', () => {
  it(
    '換掉人的歷史：不到 5% 的局面改變；人的存貨清成 0：一成以上改變（AI 看的是存貨）',
    () => {
      const samples: D6State[] = [];
      for (let seed = 0; seed < 15; seed += 1) {
        const ai = levelController(d6Game, pathfinder, 10, seed);
        const human = humanModel(d6Game, seed + 77);
        const tap: Controller<D6State> = {
          decide(state, side, tick) {
            if (
              state.phase === 'choose' &&
              state.pending[1] === null &&
              state.idle === 0 &&
              state.round >= 1
            ) {
              samples.push(state);
            }
            return ai.decide(state, side, tick);
          },
        };
        playMatch(d6Game, seed, CONFIG, human, tap);
      }
      const decide = (state: D6State): number => {
        const c = wrapPolicy(
          d6Game,
          pathfinder,
          { reactionTicks: 0, decideEvery: 1, depth: 6, epsilon: 0 },
          7,
        );
        const press = c.decide(state, 1, 0);
        return d6Game.actions(state, 1).findIndex((a) => sameButtons(a, press));
      };
      const base = samples.map(decide);
      const changed = (tweak: (s: D6State) => D6State): number =>
        samples.filter((s, i) => decide(tweak(s)) !== base[i]).length / samples.length;
      const swapped = changed((s) => ({
        ...s,
        history: s.history.map((h) => [BUY(0), h[1]] as const),
      }));
      const sells = changed((s) => ({
        ...s,
        history: s.history.map((h) => [SELL(0), h[1]] as const),
      }));
      const empty = changed((s) => ({ ...s, history: [] }));
      const noStock = changed((s) => ({ ...s, inv: [[0, 0, 0], s.inv[1] as readonly number[]] }));
      report(
        `探針 B（${samples.length} 個局面）：人一直買穀 ${swapped}；一直賣穀 ${sells}；歷史清空 ${empty}；人的存貨清成 0 ${noStock}`,
      );
      expect(samples.length).toBeGreaterThan(200);
      expect(Math.max(swapped, sells, empty)).toBeLessThan(0.05);
      expect(noStock).toBeGreaterThan(0.1);
    },
    LONG,
  );
});

describe('D-6 劇本玩家對等級 10（衝擊 2，邊輪流）', () => {
  it(
    '亂選、不動、來回買賣、永遠買布、跟風、照曲線、單人最佳規劃、抬價再出貨：勝率都不超過 10%（沒有支配策略；> 90% 才是）',
    () => {
      const s = seeds(20);
      const players: readonly (readonly [string, ReturnType<typeof S>])[] = [
        ['uniform', uniform],
        ['pass', S(() => PASS)],
        ['roundTrip', S(roundTrip)],
        ['alwaysBuyCloth', S(alwaysBuyCloth)],
        ['follower', S(follower)],
        ['curve', S(curve)],
        ['oracle', S(oracle)],
        ['pump2', S(pump(2))],
        ['pump5', S(pump(5))],
        ['cycle2', S(pumpDumpCycle(2))],
        ['cycle3', S(pumpDumpCycle(3))],
        ['人類模型', HUMAN],
      ];
      for (const [name, make] of players) {
        const r = batch(make, L10, s);
        report(
          `劇本 ${name} 對 L10：勝率 ${r.rate}，現金 ${r.cashA.toFixed(1)} 對 ${r.cashB.toFixed(1)}`,
        );
        expect(r.rate, name).toBeLessThanOrEqual(0.1);
      }
    },
    LONG,
  );

  it(
    '衝擊調到 6：來回買賣對等級 10 反而贏（小規格說的「衝擊調大就出現自己抬價套利」是真的）',
    () => {
      const r = batch(S(roundTrip), L10, seeds(16), cfg({ impact: 6 }));
      report(
        `衝擊 6：來回買賣對 L10 勝率 ${r.rate}，現金 ${r.cashA.toFixed(1)} 對 ${r.cashB.toFixed(1)}`,
      );
      expect(r.rate).toBeGreaterThanOrEqual(0.9);
    },
    LONG,
  );
});

describe('D-6 餵了再破（小規格第 10.3 節的第二欄與第四欄，衝擊 2）', () => {
  it(
    '八種時機：第二欄（對不讀的 AI 少賺多少）平均大於第四欄（AI 因為讀而多賠），而且沒有一種時機贏得了讀對手的 AI',
    () => {
      const s = seeds(20);
      const on = cfg({});
      const off = cfg({ model: 0 });
      const reader = L10;
      const baseOn = batch(H0, reader, s, on);
      const baseOff = batch(H0, reader, s, off);
      let col2 = 0;
      let col4 = 0;
      let count = 0;
      for (const k of [1, 2]) {
        for (const dump of [false, true]) {
          for (const from of [3, 9]) {
            const player = withFeint(H0, from, k, dump);
            const vsOff = batch(player, reader, s, off);
            const vsOn = batch(player, reader, s, on);
            col2 += baseOff.diff - vsOff.diff;
            col4 += vsOn.diff - baseOn.diff - (vsOff.diff - baseOff.diff);
            count += 1;
            expect(vsOn.rate, `k=${k} dump=${String(dump)} from=${from}`).toBeLessThanOrEqual(0.1);
          }
        }
      }
      report(
        `餵了再破：第二欄平均 ${(col2 / count).toFixed(2)}，第四欄平均 ${(col4 / count).toFixed(2)}`,
      );
      expect(col2 / count).toBeGreaterThan(col4 / count);
      expect(col2 / count).toBeGreaterThan(1);
    },
    LONG,
  );
});

describe('D-6 局長與反應速度', () => {
  it(
    '局長（四個情境：L10 對 L10、人類模型對 L10／L2／L1）：每一場都在 30 到 60 秒',
    () => {
      const s = seeds(10);
      const scenarios: readonly (readonly [
        string,
        ReturnType<typeof engine>,
        ReturnType<typeof engine>,
      ])[] = [
        ['L10 對 L10', L10, L10],
        ['人類模型對 L10', HUMAN, L10],
        ['人類模型對 L2', HUMAN, engine('reads', 2)],
        ['人類模型對 L1', HUMAN, engine('reads', 1)],
      ];
      for (const [name, a, b] of scenarios) {
        const ticks = [...batch(a, b, s).ticks].sort((x, y) => x - y);
        report(
          `局長 ${name}：最短 ${((ticks[0] as number) / 60).toFixed(1)} 秒，中位數 ${((ticks[ticks.length >> 1] as number) / 60).toFixed(1)} 秒，最長 ${((ticks[ticks.length - 1] as number) / 60).toFixed(1)} 秒`,
        );
        expect(ticks[0] as number, name).toBeGreaterThanOrEqual(1800);
        expect(ticks[ticks.length - 1] as number, name).toBeLessThanOrEqual(3600);
      }
    },
    LONG,
  );

  it(
    '反應速度四格（搜尋型，其餘維度固定在反應 12、每 tick 決定、深度 1）：不是純反應競速——只差反應延遲與決定頻率是 50%，只差深度與合併值是 0%',
    () => {
      const s = seeds(30);
      const P = (reaction: number, every: number, depth: number) => ({
        reactionTicks: reaction,
        decideEvery: every,
        depth,
        epsilon: 0,
      });
      const pf = (a: ReturnType<typeof P>, b: ReturnType<typeof P>): number =>
        winRate(d6Game, pathfinder, a, pathfinder, b, s);
      const combined = pf(P(3, 1, 1), P(18, 12, 6));
      const onlyReaction = pf(P(3, 1, 1), P(18, 1, 1));
      const onlyFrequency = pf(P(12, 1, 1), P(12, 12, 1));
      const onlyDepth = pf(P(12, 1, 1), P(12, 1, 6));
      report(
        `反應速度：合併 ${combined}，只差反應 ${onlyReaction}，只差頻率 ${onlyFrequency}，只差深度 ${onlyDepth}`,
      );
      expect(combined).toBeLessThan(0.9);
      expect(onlyDepth).toBeLessThanOrEqual(0.1);
      expect(Math.abs(onlyReaction - 0.5)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(onlyFrequency - 0.5)).toBeLessThanOrEqual(0.1);
    },
    LONG,
  );

  it(
    '等級曲線單調：等級 1 到 9 對等級 10 的勝率不下降（容許 0.05 的雜訊），等級 1 是 0%、等級 9 超過三成',
    () => {
      const s = seeds(30);
      const rates = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
        (lv) => batch(engine('reads', lv), L10, s).rate,
      );
      report(`等級曲線（對 L10）：${rates.join('、')}`);
      for (let i = 1; i < rates.length; i += 1) {
        expect(rates[i] as number).toBeGreaterThanOrEqual((rates[i - 1] as number) - 0.05);
      }
      expect(rates[0]).toBe(0);
      expect(rates[8] as number).toBeGreaterThan(0.3);
    },
    LONG,
  );
});
