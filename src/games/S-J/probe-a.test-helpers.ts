import { HUMAN_PARAMS } from '../../ai/human-model';
import { wrapPolicy } from '../../ai/level';
import type { LevelParams, Policy, PolicyParams } from '../../ai/types';
import { playMatch } from '../../core/match';
import type { Buttons, Controller, Game, Side } from '../../core/types';
import { outcomeOf } from '../../../tests/ai/probe-a.shared';
import type { IsPoint, MatchOutcome, ProbeSpec } from '../../../tests/ai/probe-a.shared';
import { FIELD_H, FIELD_W, HIT_DIST, PLAYER_R, SLOW_SPEED, SPEED } from '../_spades/logic';
import { BULLET_V, actions, sJGame } from './logic';
import type { SJState } from './logic';
import { makeAi } from './probe-a.rival.test-helpers';

/**
 * S-J 射手與靶的完整探針 A：(b) 族、(c) 族、格子、決策點（`docs/cards/S-J.md`「完整探針 A」；
 * DESIGN-AI-FUN 10.35、10.54、10.59、10.61）。這個檔案只給測試與量測腳本用，不在 `logic.ts` 的純度掃描範圍。
 *
 * **量的是哪一條管道：玩家在「躲」的那個回合，讀不讀 AI 射手公開的承諾（游標、彈藥、補充倒數、冷卻）。**
 * 玩家在「射」的那個回合，所有成員用同一個固定的射手（`shootConstant`），所以 (b)(c) 的差只來自躲的回合。
 * 射手回合為什麼不當成員的維度：射手的目標就是對手的位置，不讀對手就無法瞄準，(b) 沒有合理的成員；
 * 在那個回合量 (c)−(b) 量到的是「瞄準」，不是互動。
 *
 * 躲的核心（所有成員共用）：往前看 22 個 tick，只選預測不會被子彈打到（距離 ≥ 命中距離 ＋ 2.5）的動作，
 * 其中離「想去的地方」最近的；全都危險就選最遠的。成員只差「想去的地方」：
 * - (b)：知道有射手（所以有深度與左右的選擇），但不讀它的游標、彈藥、補充倒數、冷卻、命中數與分數；
 *   只讀飛行中的子彈（那是場上的危險物，不是射手的狀態）、自己的位置、時間。
 * - (c)：讀射手公開的承諾：游標在哪、還有幾發、冷卻。
 * 不 import 評估函式與對手預測函式，也不拿 AI 控制器當成員（來源掃描在 `probe-a.test.ts`）。
 */

export const CONFIG = { maxTicks: 3000, params: {} };

/** 訓練種子與量測種子的起點。量測 0..N−1、訓練 TRAIN_FROM..；兩段不重疊（測試檢查）。 */
export const MEASURE_FROM = 0;
export const TRAIN_FROM = 20_000;

export const B_FAMILY = [
  'b-y45',
  'b-y55',
  'b-y62',
  'b-y70',
  'b-y74',
  'b-wander62',
  'b-wander70',
  'b-pulse',
] as const;

export const C_FAMILY = [
  'c-offcol10',
  'c-offcol14',
  'c-imminent',
  'c-imminent74',
  'c-regen-depth',
] as const;

export type MemberName = (typeof B_FAMILY)[number] | (typeof C_FAMILY)[number];

// ---------------------------------------------------------------------------
// 格子（節奏 × 等級）
// ---------------------------------------------------------------------------

export type TempoName = 'T0' | 'G12' | 'T12';

/**
 * 玩家的節奏。T0＝零延遲（每個 tick 都決定、不亂按）；T12＝人類模型的參數（`HUMAN_PARAMS`：延遲 12、
 * 每 6 tick 決定、8% 亂按）；G12＝延遲 12 但勤快（每 3 tick 決定、2% 亂按，S-J 小規格的「好人類」）。
 */
export const TEMPOS: Readonly<Record<TempoName, LevelParams>> = {
  T0: { reactionTicks: 0, decideEvery: 1, depth: 1, epsilon: 0 },
  G12: { reactionTicks: 12, decideEvery: 3, depth: 1, epsilon: 0.02 },
  T12: HUMAN_PARAMS,
};

export interface Cell {
  readonly id: string;
  readonly tempo: TempoName;
  /** 被測的 AI（預設性格＝精準型）的等級。 */
  readonly level: number;
}

/** 掃描（只用 (b) 族）後選出的格子；選的理由在小規格。第一個是主格。 */
export const CELLS: readonly Cell[] = [
  { id: 'T12-L10', tempo: 'T12', level: 10 },
  { id: 'G12-L10', tempo: 'G12', level: 10 },
  { id: 'T0-L10', tempo: 'T0', level: 10 },
];

// ---------------------------------------------------------------------------
// 躲的核心與固定的射手
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const R: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

/** 想去的地方：位置，以及兩個方向各佔多重的權重（越大越要先到）。 */
export interface DodgeGoal {
  readonly x: number;
  readonly y: number;
  readonly wx: number;
  readonly wy: number;
}

const HORIZON = 22;
const SAFE_MARGIN = 2.5;

function velocityOf(a: Buttons): { vx: number; vy: number } {
  const dx = (a.right ? 1 : 0) - (a.left ? 1 : 0);
  const dy = (a.down ? 1 : 0) - (a.up ? 1 : 0);
  const speed = a.a ? SLOW_SPEED : SPEED;
  const along = dx !== 0 && dy !== 0 ? speed * Math.SQRT1_2 : speed;
  return { vx: dx * along, vy: dy * along };
}

function dodgeTo(s: SJState, side: Side, goal: DodgeGoal): Buttons {
  const acts = actions(s, side);
  let best = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  let bestSafe = false;
  let bestMin = -1;
  acts.forEach((a, i) => {
    const v = velocityOf(a);
    let minD = Number.POSITIVE_INFINITY;
    let px = s.px;
    let py = s.py;
    for (let t = 1; t <= HORIZON; t += 1) {
      px = clamp(px + v.vx, PLAYER_R, FIELD_W - PLAYER_R);
      py = clamp(py + v.vy, PLAYER_R, FIELD_H - PLAYER_R);
      if (t <= s.invuln) {
        continue;
      }
      for (const b of s.bullets) {
        const ex = b.x - px;
        const ey = b.y + BULLET_V * t - py;
        minD = Math.min(minD, Math.sqrt(ex * ex + ey * ey));
      }
    }
    const safe = minD >= HIT_DIST + SAFE_MARGIN;
    const cost = goal.wx * Math.abs(px - goal.x) + goal.wy * Math.abs(py - goal.y);
    if (safe) {
      if (!bestSafe || cost < bestCost - 1e-9) {
        best = i;
        bestCost = cost;
        bestSafe = true;
      }
    } else if (!bestSafe && minD > bestMin) {
      best = i;
      bestMin = minD;
    }
  });
  return acts[best] ?? R;
}

/**
 * 射的回合：所有成員共用的固定射手。游標追對手（靶）現在的 x，對準了（差 4 以內）、有彈藥、
 * 不在冷卻、對手不在剛被打中的無敵期（30 tick 以上）就開火。這是常數：(b)(c) 在射的回合做一模一樣的事。
 */
export function shootConstant(s: SJState): Buttons {
  const d = s.px - s.cursor;
  const fire = Math.abs(d) <= 4 && s.ammo > 0 && s.cooldown === 0 && s.invuln < 30;
  return { ...R, left: d < -2.5, right: d > 2.5, a: fire };
}

// ---------------------------------------------------------------------------
// 成員：躲的時候想去哪
// ---------------------------------------------------------------------------

/** 三角波 −1 到 1，週期 150 tick。 */
const wave = (tick: number): number => {
  const ph = (tick % 150) / 150;
  return ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
};

const LEFT_EDGE = 10;
const RIGHT_EDGE = FIELD_W - 10;

/**
 * 射手「隨時會開火」：有彈藥時看冷卻（≤ 6 tick 內能再開），沒彈藥時看補充倒數（≤ 15 tick 就補上一發）。
 * 這個等級的 AI 射手一有彈藥就開火，所以彈藥幾乎總是 0；真正的資訊是補充倒數這個時鐘。
 */
export const shotImminent = (s: SJState): boolean => (s.ammo > 0 ? s.cooldown <= 6 : s.regen <= 15);

/**
 * 成員在 `side` 躲的回合「想去哪」。
 * (b) 成員只讀：自己的位置、時間（`tick`）、飛行中的子彈。
 * (c) 成員另外讀射手的游標 `cursor`、彈藥 `ammo`、補充倒數 `regen`、冷卻 `cooldown`。
 */
export function chooseGoal(name: MemberName, s: SJState, _side: Side, tick: number): DodgeGoal {
  const home = (y: number): DodgeGoal => ({ x: FIELD_W / 2, y, wx: 0.2, wy: 1 });
  switch (name) {
    case 'b-y45':
      return home(45);
    case 'b-y55':
      return home(55);
    case 'b-y62':
      return home(62);
    case 'b-y70':
      return home(70);
    case 'b-y74':
      return home(74);
    case 'b-wander62':
      return { x: FIELD_W / 2 + 40 * wave(tick), y: 62, wx: 0.6, wy: 1 };
    case 'b-wander70':
      return { x: FIELD_W / 2 + 40 * wave(tick), y: 70, wx: 0.6, wy: 1 };
    case 'b-pulse':
      // 場上有子彈就退到上半場邊緣（有時間躲），沒有就站 62。
      return home(s.bullets.length > 0 ? 74 : 62);
    case 'c-offcol10':
    case 'c-offcol14': {
      const keep = name === 'c-offcol10' ? 10 : 14;
      if (!shotImminent(s)) {
        return home(62);
      }
      if (Math.abs(s.px - s.cursor) >= keep) {
        return { x: s.px, y: 62, wx: 1.2, wy: 1 };
      }
      const x = clamp(
        s.cursor + (s.px >= s.cursor ? keep + 2 : -(keep + 2)),
        LEFT_EDGE,
        RIGHT_EDGE,
      );
      return { x, y: 62, wx: 1.2, wy: 1 };
    }
    case 'c-imminent':
    case 'c-imminent74': {
      const y = name === 'c-imminent' ? 62 : 74;
      if (shotImminent(s) && Math.abs(s.px - s.cursor) <= 14) {
        const x = clamp(s.cursor + (s.px >= s.cursor ? 16 : -16), LEFT_EDGE, RIGHT_EDGE);
        return { x, y, wx: 2, wy: 1 };
      }
      return home(y);
    }
    case 'c-regen-depth':
      return home(shotImminent(s) ? 74 : 55);
  }
}

/** 成員做成性格（給 `wrapPolicy`）。射的回合用固定的射手。 */
export function memberPolicy(name: MemberName): Policy {
  return {
    name,
    decide<S>(_game: Game<S>, state: S, side: Side, tick: number, _params: PolicyParams): Buttons {
      const s = state as unknown as SJState;
      if (s.shooter === side) {
        return shootConstant(s);
      }
      return dodgeTo(s, side, chooseGoal(name, s, side, tick));
    },
  };
}

export function makePlayer(name: MemberName, tempo: TempoName, seed: number): Controller<SJState> {
  return wrapPolicy(sJGame, memberPolicy(name), TEMPOS[tempo], seed);
}

// ---------------------------------------------------------------------------
// 對局與探針規格
// ---------------------------------------------------------------------------

/** 玩家邊由種子奇偶輪流；AI 種子 ＝ 玩家種子 ＋ 1,000,003；回傳玩家這一邊的勝負與分差。 */
export function playCell(seed: number, ctl: Controller<SJState>, cell: Cell): MatchOutcome {
  const side: Side = seed % 2 === 0 ? 0 : 1;
  const ai = makeAi(cell.level, seed + 1_000_003);
  const result =
    side === 0
      ? playMatch(sJGame, seed, CONFIG, ctl, ai)
      : playMatch(sJGame, seed, CONFIG, ai, ctl);
  return outcomeOf(result, side);
}

/**
 * 決策點：玩家在躲、射手隨時會開火（`shotImminent`）、游標離我 20 以內。
 * 這是「讀射手的承諾」可能改變走位的時刻；點級分歧率比的是這一刻的按鍵。
 */
export const isPoint: IsPoint<SJState> = (state, side) =>
  state.shooter !== side && shotImminent(state) && Math.abs(state.px - state.cursor) <= 20;

export function sjSpec(
  b: MemberName,
  c: MemberName,
  cell: Cell,
  seeds: readonly number[],
): ProbeSpec<SJState> {
  return {
    makeB: (seed) => makePlayer(b, cell.tempo, seed),
    makeC: (seed) => makePlayer(c, cell.tempo, seed),
    seeds,
    play: (seed, ctl) => playCell(seed, ctl, cell),
    isPoint,
  };
}

// ---------------------------------------------------------------------------
// 訓練與選法（10.54、10.61：(b\*)、(c\*) 在訓練種子上選，量測種子不碰）
// ---------------------------------------------------------------------------

export interface TrainingRow {
  readonly name: string;
  /** 勝率，百分點（和局算半場）。 */
  readonly win: number;
  /** 分差（我方 − 對方）的平均。 */
  readonly margin: number;
}

/** 每個成員單獨當玩家打這一格，在給定的種子上的勝率與分差。 */
export function trainTable(
  names: readonly MemberName[],
  cell: Cell,
  seeds: readonly number[],
): TrainingRow[] {
  return names.map((name) => {
    const outcomes = seeds.map((seed) => playCell(seed, makePlayer(name, cell.tempo, seed), cell));
    const n = Math.max(1, outcomes.length);
    return {
      name,
      win: (100 * outcomes.reduce((p, o) => p + o.win, 0)) / n,
      margin: outcomes.reduce((p, o) => p + o.margin, 0) / n,
    };
  });
}

/** 勝率高者；同勝率取分差高；再同取排在前面的。 */
export function selectBest(rows: readonly TrainingRow[]): string {
  let best = rows[0];
  if (best === undefined) {
    throw new Error('selectBest：沒有任何成員');
  }
  for (const row of rows.slice(1)) {
    const dw = row.win - best.win;
    if (dw > 1e-9 || (Math.abs(dw) <= 1e-9 && row.margin - best.margin > 1e-9)) {
      best = row;
    }
  }
  return best.name;
}
