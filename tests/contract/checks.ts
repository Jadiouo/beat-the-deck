/**
 * 契約檢查（TEST_PLAN 第 4 節）的實作，K1–K13、R1–R3、meta。
 *
 * 這個檔案是「唯一一份」檢查邏輯：`all-games.test.ts` 對登記表裡每一張牌跑它，
 * `bad-games.test.ts` 對故意違約的假遊戲跑同一份，證明它真的抓得到問題。
 *
 * 每個檢查失敗就丟 `ContractViolation`（帶檢查編號）。遊戲自己丟出的任何錯誤
 * （例如 step 對凍結的 state 寫入）也會被包成對應檢查的失敗，不會讓測試亂掉。
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashState } from '../../src/core/hash';
import { copyButtons, playMatch } from '../../src/core/match';
import { replay } from '../../src/core/replay';
import { createRng } from '../../src/core/rng';
import { levelController, policyByName } from '../../src/ai/level';
import { HUMAN_PARAMS, humanPolicy } from '../../src/ai/human-model';
import { random as randomPolicy } from '../../src/ai/policies/random';
import type { Policy } from '../../src/ai/types';
import type { Buttons, Controller, Game, GameConfig, Inputs, Side } from '../../src/core/types';
import { CARD_IDS } from '../../src/games/registry';
import type { CardMeta, RegistryEntry } from '../../src/games/types';
import { PALETTE } from '../../src/shell/palette';
import { asRenderingContext, createFakeContext, LOGIC_HEIGHT, LOGIC_WIDTH } from './fake-context';
import type { FakeContext } from './fake-context';
import { deepFreeze } from './freeze';
import { measureDecideTimes, seedList, winRate } from '../ai/harness';
import { AI_SEEDS } from '../ai/seeds';
import type { DecideTimes } from '../ai/harness';

// ---------------------------------------------------------------------------
// 共用常數
// ---------------------------------------------------------------------------

export type CheckCode =
  | 'K1'
  | 'K2'
  | 'K3'
  | 'K4'
  | 'K5'
  | 'K6'
  | 'K7'
  | 'K8'
  | 'K9'
  | 'K10'
  | 'K11'
  | 'K12'
  | 'K13'
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'A5'
  | 'R1'
  | 'R2'
  | 'R3'
  | 'META';

/** 種子 0 到 19。 */
export const CONTRACT_SEEDS: readonly number[] = Array.from({ length: 20 }, (_, i) => i);
/** K12 用 200 個種子。 */
export const SYMMETRY_SEEDS: readonly number[] = Array.from({ length: 200 }, (_, i) => i);
/** SPEC 第 9 節：除非小規格另外寫，一局 3600 tick。 */
export const CONTRACT_CONFIG: GameConfig = { maxTicks: 3600, params: {} };

/** A1–A5 的種子（TEST_PLAN 5.1），固定為 0..N-1；N 是 `tests/ai/seeds.ts` 的 `AI_SEED_COUNT`（目前 200）。 */
export { AI_SEEDS };
/** A5 量 decide() 用的種子數：夠多場、又不要太慢。 */
const SPEED_SEEDS: readonly number[] = seedList(5);
/** human-model 的四個參數，A3、A4 用它當 `winRate` 的「等級」。 */
const HUMAN_LEVEL = HUMAN_PARAMS;
/** K11、K12 用的等級：兩邊都是預設性格、等級 5。 */
const CONTRACT_LEVEL = 5;

/** K11：一場完整對局的時間上限（毫秒）。 */
export const SPEED_LIMIT_MS = 2000;
/** K1、K2 比對雜湊的間隔。 */
const HASH_INTERVAL = 60;
/** K6：結束後再多走幾步。 */
const AFTER_OVER_STEPS = 60;
/** R3：容許超出畫布的像素數。 */
export const BOUNDS_TOLERANCE = 8;
/** R1–R3 每隔幾個 tick 取一個畫面來測。 */
const RENDER_SAMPLE_INTERVAL = 150;

export class ContractViolation extends Error {
  readonly code: CheckCode;
  constructor(code: CheckCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'ContractViolation';
    this.code = code;
  }
}

function violation(code: CheckCode, message: string): never {
  throw new ContractViolation(code, message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// 跑遊戲用的輔助
// ---------------------------------------------------------------------------

const RELEASED: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

/**
 * 隨機控制器：從遊戲自己的 `actions()` 裡亂挑一個。
 *
 * 亂數由「種子＋邊」推導（`fork`），所以兩邊彼此對稱、同一個種子永遠同一串。
 * 其他檢查都用它：它們要的是廣泛的輸入，不是聰明的。K11、K12 與 A1–A5 改用預設性格
 * （見 `contractController`）。
 *
 * `actions()` 回傳空陣列時退回「全放開」，讓 K8 去報告它，而不是讓每個檢查都爆。
 */
export function randomController<S>(game: Game<S>, seed: number, side: Side): Controller<S> {
  const rng = createRng(seed).fork(`contract-random-${side}`);
  return {
    decide(state: S, who: Side): Buttons {
      const actions = game.actions(state, who);
      return actions.length === 0 ? RELEASED : actions[rng.int(actions.length)];
    },
  };
}

export function randomPair<S>(game: Game<S>, seed: number): [Controller<S>, Controller<S>] {
  return [randomController(game, seed, 0), randomController(game, seed, 1)];
}

/** 這張牌的預設性格；沒有（替身牌、還沒指定的牌）是 null。 */
function defaultPolicyOf(meta: CardMeta): Policy | null {
  return meta.defaultPolicy === null ? null : policyByName(meta.defaultPolicy);
}

/**
 * K11、K12 用的控制器：這張牌的預設性格、指定的等級；沒有預設性格的牌退回隨機控制器
 * （T2 的行為，替身牌與故意違約的假遊戲都走這條）。
 * 亂數由「種子＋邊」推導，所以兩邊彼此對稱、同一個種子永遠同一串。
 */
export function contractController<S>(
  entry: RegistryEntry<S>,
  seed: number,
  side: Side,
  level: number = CONTRACT_LEVEL,
): Controller<S> {
  const policy = defaultPolicyOf(entry.meta);
  if (policy === null) {
    return randomController(entry.game, seed, side);
  }
  return levelController(entry.game, policy, level, seed * 2 + side);
}

interface RunResult<S> {
  state: S;
  ticks: number;
  over: boolean;
}

/**
 * 手動推進一場對局（不用 `playMatch`，因為檢查要在每個 tick 之間插手）。
 * `observe` 在初始 state 與每次 `step` 之後被呼叫。
 */
function runGame<S>(
  game: Game<S>,
  seed: number,
  config: GameConfig,
  pick: (state: S, tick: number) => Inputs,
  observe?: (state: S, tick: number) => void,
): RunResult<S> {
  let state = game.init(seed, config);
  let tick = 0;
  observe?.(state, tick);
  while (!game.isOver(state) && tick < config.maxTicks) {
    state = game.step(state, pick(state, tick));
    tick += 1;
    observe?.(state, tick);
  }
  return { state, ticks: tick, over: game.isOver(state) };
}

/** 用隨機控制器產生輸入。 */
function randomPicker<S>(game: Game<S>, seed: number): (state: S, tick: number) => Inputs {
  const [c0, c1] = randomPair(game, seed);
  return (state, tick) => [
    copyButtons(c0.decide(state, 0, tick)),
    copyButtons(c1.decide(state, 1, tick)),
  ];
}

/** 雜湊，但遇到不能雜湊的東西不丟錯，改回傳錯誤訊息（讓各檢查彼此獨立）。 */
function softHash(value: unknown): string {
  try {
    return hashState(value);
  } catch (error) {
    return `不可雜湊（${errorText(error)}）`;
  }
}

function scoresOf<S>(game: Game<S>, state: S): [number, number] {
  const score = game.score(state);
  return [score[0], score[1]]; // 複製，避免之後被改動
}

// ---------------------------------------------------------------------------
// K1–K12
// ---------------------------------------------------------------------------

/** K1 決定性：同種子、同一串輸入跑兩次，每 60 tick 與結尾的雜湊都相同。 */
export function checkDeterminism<S>(game: Game<S>, seed: number, config: GameConfig): void {
  const recorded: Inputs[] = [];
  const first: string[] = [];
  const pick = randomPicker(game, seed);
  const a = runGame(
    game,
    seed,
    config,
    (state, tick) => {
      const inputs = pick(state, tick);
      // 存一份副本：就算 step 事後改動它拿到的輸入，「同一串輸入」也不會跟著變。
      recorded.push([copyButtons(inputs[0]), copyButtons(inputs[1])]);
      return inputs;
    },
    (state, tick) => {
      if (tick % HASH_INTERVAL === 0) {
        first.push(softHash(state));
      }
    },
  );
  first.push(softHash(a.state));

  const second: string[] = [];
  const b = runGame(
    game,
    seed,
    config,
    (_state, tick) => recorded[tick] ?? [RELEASED, RELEASED],
    (state, tick) => {
      if (tick % HASH_INTERVAL === 0) {
        second.push(softHash(state));
      }
    },
  );
  second.push(softHash(b.state));

  if (a.ticks !== b.ticks) {
    violation('K1', `同樣的種子與輸入，第一次走了 ${a.ticks} 個 tick 結束，第二次是 ${b.ticks}`);
  }
  for (let i = 0; i < first.length; i += 1) {
    if (first[i] !== second[i]) {
      const where =
        i === first.length - 1 ? `結尾（tick ${a.ticks}）` : `tick ${i * HASH_INTERVAL}`;
      violation('K1', `${where} 的雜湊不同：${first[i]} 與 ${second[i]}`);
    }
  }
}

/** K2 可序列化：每 60 tick 做 JSON 來回，雜湊不變，而且從復原的 state 繼續走結果相同。 */
export function checkSerializable<S>(game: Game<S>, seed: number, config: GameConfig): void {
  let stepCount = 0;
  const check = (state: S, label: string): S => {
    const revived = JSON.parse(JSON.stringify(state)) as S;
    const before = softHash(state);
    const after = softHash(revived);
    if (before !== after) {
      violation('K2', `${label}：JSON 來回之後雜湊改變（${before} → ${after}）`);
    }
    return revived;
  };
  const guarded: Game<S> = {
    ...game,
    step(state: S, inputs: Inputs): S {
      if (stepCount % HASH_INTERVAL === 0) {
        const revived = check(state, `tick ${stepCount}`);
        const next = game.step(state, inputs);
        const nextFromRevived = game.step(revived, inputs);
        if (softHash(next) !== softHash(nextFromRevived)) {
          violation('K2', `tick ${stepCount}：從 JSON 復原的 state 繼續走，結果與原本不同`);
        }
        stepCount += 1;
        return next;
      }
      stepCount += 1;
      return game.step(state, inputs);
    },
  };
  const result = runGame(guarded, seed, config, randomPicker(game, seed));
  check(result.state, `結尾（tick ${result.ticks}）`);
}

/** 找出 state 裡第一個壞掉的數字（NaN、Infinity、undefined），回傳路徑與原因。 */
export function findBadValue(
  value: unknown,
  path = 'state',
  ancestors: object[] = [],
): string | null {
  if (value === undefined) {
    return `${path} 是 undefined`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return `${path} 是 ${String(value)}`;
  }
  if (typeof value !== 'object' || value === null || ancestors.includes(value)) {
    return null;
  }
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const found = findBadValue(value[i], `${path}[${i}]`, ancestors);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    for (const key of Object.keys(value)) {
      const found = findBadValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors,
      );
      if (found !== null) {
        return found;
      }
    }
    return null;
  } finally {
    ancestors.pop();
  }
}

/** K3 沒有壞數字：前 60 個 tick 每個都掃，之後每 10 個 tick 掃一次，結尾再掃一次。 */
export function checkNoBadNumbers<S>(game: Game<S>, seed: number, config: GameConfig): void {
  const scan = (state: S, tick: number): void => {
    const found = findBadValue(state);
    if (found !== null) {
      violation('K3', `tick ${tick}：${found}`);
    }
  };
  const result = runGame(game, seed, config, randomPicker(game, seed), (state, tick) => {
    if (tick < 60 || tick % 10 === 0) {
      scan(state, tick);
    }
  });
  scan(result.state, result.ticks);
}

/** K4 step 是純的：先深度凍結 state（與這個 tick 的輸入），step 不可以丟錯，呼叫前後原 state 的雜湊相同。 */
export function checkStepPure<S>(game: Game<S>, seed: number, config: GameConfig): void {
  let stepCount = 0;
  const guarded: Game<S> = {
    ...game,
    step(state: S, inputs: Inputs): S {
      const tick = stepCount;
      stepCount += 1;
      // 輸入也一併凍結：step 不可以改動 state，也不可以改動拿到的輸入。
      deepFreeze(state);
      deepFreeze(inputs);
      const before = softHash(state);
      let next: S;
      try {
        next = game.step(state, inputs);
      } catch (error) {
        return violation('K4', `tick ${tick}：step 對凍結的 state 丟出錯誤（${errorText(error)}）`);
      }
      const after = softHash(state);
      if (before !== after) {
        violation('K4', `tick ${tick}：step 之後傳進去的 state 雜湊改變了`);
      }
      return next;
    },
  };
  runGame(guarded, seed, config, randomPicker(game, seed));
}

/** K5 會結束：兩個隨機控制器，在 maxTicks 之內 isOver 變成 true。 */
export function checkTerminates<S>(game: Game<S>, seed: number, config: GameConfig): void {
  const result = runGame(game, seed, config, randomPicker(game, seed));
  if (!result.over) {
    violation('K5', `走了 maxTicks（${config.maxTicks}）個 tick，isOver 仍然是 false`);
  }
}

/** 跑到結束；沒結束就當成該檢查失敗（K5 才是主要的報告者，這裡只是說明為什麼測不下去）。 */
function playToEnd<S>(
  code: CheckCode,
  game: Game<S>,
  seed: number,
  config: GameConfig,
): RunResult<S> {
  const result = runGame(game, seed, config, randomPicker(game, seed));
  if (!result.over) {
    violation(code, `在 maxTicks（${config.maxTicks}）之內沒有結束，無法檢查（見 K5）`);
  }
  return result;
}

/** K6 結束後穩定：isOver 之後再 step 60 次，score、winner 與 isOver 都不變。 */
export function checkStableAfterOver<S>(game: Game<S>, seed: number, config: GameConfig): void {
  const end = playToEnd('K6', game, seed, config);
  let state = end.state;
  const score = scoresOf(game, state);
  const winner = game.winner(state);
  const pick = randomPicker(game, seed + 1000);
  for (let i = 0; i < AFTER_OVER_STEPS; i += 1) {
    state = game.step(state, pick(state, end.ticks + i));
    const nowScore = scoresOf(game, state);
    if (nowScore[0] !== score[0] || nowScore[1] !== score[1]) {
      violation(
        'K6',
        `結束後第 ${i + 1} 次 step，score 從 [${score.join(', ')}] 變成 [${nowScore.join(', ')}]`,
      );
    }
    if (game.winner(state) !== winner) {
      violation(
        'K6',
        `結束後第 ${i + 1} 次 step，winner 從 ${String(winner)} 變成 ${String(game.winner(state))}`,
      );
    }
    if (!game.isOver(state)) {
      violation('K6', `結束後第 ${i + 1} 次 step，isOver 變回 false`);
    }
  }
}

/** K7 分數一致：winner 不是 null 時，那一邊的分數不低於另一邊（`winnerNotByScore` 的牌跳過）。 */
export function checkWinnerMatchesScore<S>(
  game: Game<S>,
  seed: number,
  config: GameConfig,
  options: { winnerNotByScore?: boolean } = {},
): void {
  const end = playToEnd('K7', game, seed, config);
  const score = game.score(end.state);
  const winner = game.winner(end.state);
  if (winner !== null && winner !== 0 && winner !== 1) {
    violation('K7', `winner 必須是 0、1 或 null，收到 ${String(winner)}`);
  }
  if (!Number.isFinite(score[0]) || !Number.isFinite(score[1])) {
    violation('K7', `score 不是有限的數：[${score.join(', ')}]`);
  }
  if (options.winnerNotByScore === true || winner === null) {
    return;
  }
  const other: Side = winner === 0 ? 1 : 0;
  if (score[winner] < score[other]) {
    violation('K7', `winner 是 ${winner}，但分數是 [${score.join(', ')}]，贏家分數比較低`);
  }
}

function isButtons(value: unknown): value is Buttons {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return ['up', 'down', 'left', 'right', 'a', 'b'].every((key) => typeof record[key] === 'boolean');
}

/** K8 動作合法：每個 tick 兩邊的 actions() 都至少一個，而且都是完整的 Buttons。 */
export function checkActionsLegal<S>(game: Game<S>, seed: number, config: GameConfig): void {
  runGame(game, seed, config, randomPicker(game, seed), (state, tick) => {
    for (const side of [0, 1] as const) {
      const actions = game.actions(state, side);
      if (!Array.isArray(actions) || actions.length === 0) {
        violation('K8', `tick ${tick}：actions(state, ${side}) 沒有回傳任何動作`);
      }
      if (!actions.every(isButtons)) {
        violation('K8', `tick ${tick}：actions(state, ${side}) 回傳的不全是完整的 Buttons`);
      }
    }
  });
}

/** K9 評估可用：danger 在 0 到 1 之間，gain 是有限的數。 */
export function checkEvaluateUsable<S>(game: Game<S>, seed: number, config: GameConfig): void {
  runGame(game, seed, config, randomPicker(game, seed), (state, tick) => {
    for (const side of [0, 1] as const) {
      const { gain, danger } = game.evaluate(state, side);
      if (!Number.isFinite(gain)) {
        violation(
          'K9',
          `tick ${tick}：evaluate(state, ${side}).gain 不是有限的數（${String(gain)}）`,
        );
      }
      if (!Number.isFinite(danger) || danger < 0 || danger > 1) {
        violation(
          'K9',
          `tick ${tick}：evaluate(state, ${side}).danger 必須在 0 到 1 之間（${String(danger)}）`,
        );
      }
    }
  });
}

/** K10 重播：playMatch 的結果用 replay 重跑，finalHash（與贏家、分數、tick 數）相同。 */
export function checkReplay<S>(game: Game<S>, seed: number, config: GameConfig): void {
  const [c0, c1] = randomPair(game, seed);
  const result = playMatch(game, seed, config, c0, c1);
  const again = replay(game, seed, config, result.inputs);
  if (again.finalHash !== result.finalHash) {
    violation('K10', `重播的 finalHash 不同：${result.finalHash} 與 ${again.finalHash}`);
  }
  if (
    again.winner !== result.winner ||
    again.ticks !== result.ticks ||
    again.score[0] !== result.score[0] ||
    again.score[1] !== result.score[1]
  ) {
    violation('K10', '重播的 winner、score 或 ticks 與原本的對局不同');
  }
}

/**
 * K11 夠快：不開畫面跑一場完整對局要少於 2 秒。
 * 兩邊是這張牌的預設性格、等級 5；沒有預設性格的牌用隨機控制器。
 */
export function checkSpeed<S>(
  entry: RegistryEntry<S>,
  seed: number,
  config: GameConfig,
  limitMs: number = SPEED_LIMIT_MS,
): void {
  const c0 = contractController(entry, seed, 0);
  const c1 = contractController(entry, seed, 1);
  const started = performance.now();
  playMatch(entry.game, seed, config, c0, c1);
  const elapsed = performance.now() - started;
  if (elapsed >= limitMs) {
    violation('K11', `一場對局花了 ${elapsed.toFixed(0)} 毫秒，上限是 ${limitMs} 毫秒`);
  }
}

/**
 * K12 對稱（只對 `meta.symmetric` 的牌）：兩邊用同一種控制器，200 個種子，
 * 任一邊的勝率（平手算半場）在 40% 到 60% 之間。
 * 控制器是這張牌的預設性格、同一個等級 5；沒有預設性格的牌用隨機控制器。
 */
export function checkSymmetry<S>(
  entry: RegistryEntry<S>,
  seeds: readonly number[],
  config: GameConfig,
): void {
  let points = 0;
  for (const seed of seeds) {
    const c0 = contractController(entry, seed, 0);
    const c1 = contractController(entry, seed, 1);
    const { winner } = playMatch(entry.game, seed, config, c0, c1);
    points += winner === 0 ? 1 : winner === null ? 0.5 : 0;
  }
  const rate = points / seeds.length;
  if (rate < 0.4 || rate > 0.6) {
    violation(
      'K12',
      `${seeds.length} 個種子，0 號邊的勝率是 ${(rate * 100).toFixed(1)}%，應該在 40% 到 60% 之間`,
    );
  }
}

/** K13 用的種子：0 到 9。 */
export const SEED_MATTERS_SEEDS: readonly number[] = Array.from({ length: 10 }, (_, i) => i);
/** K13 用的固定輸入串的亂數種子（與遊戲、遊戲的種子都無關）。 */
const SEED_MATTERS_INPUT_SEED = 0x13;

/** 一串與遊戲、種子都無關的輸入：每個 tick 六個鍵各以 35% 的機率按下。 */
function fixedInputs(length: number): Inputs[] {
  const rng = createRng(SEED_MATTERS_INPUT_SEED);
  const press = (): Buttons => ({
    up: rng.next() < 0.35,
    down: rng.next() < 0.35,
    left: rng.next() < 0.35,
    right: rng.next() < 0.35,
    a: rng.next() < 0.35,
    b: rng.next() < 0.35,
  });
  return Array.from({ length }, () => [press(), press()] as const);
}

/**
 * K13 種子有效：用同一串輸入、不同的種子（預設 0 到 9）跑完整對局，終局雜湊不可以全部相同。
 *
 * 為什麼需要它：牌的作者忘記把 `nextFrom` 回傳的新 `RngState` 寫回新 state 時，遊戲會變得
 * 「更」決定性（每次都拿到同一個亂數），K1 只比「同種子兩次一樣」，抓不到。
 * 與種子完全無關的牌（`meta.seedIndependent: true`）跳過這一條。
 *
 * state 不能雜湊（NaN、函式……）或遊戲自己丟錯時，這一條不報告（K2、K3、K4 會報告），
 * 免得同一個問題被多條檢查重複回報。
 */
export function checkSeedMatters<S>(
  game: Game<S>,
  seeds: readonly number[],
  config: GameConfig,
): void {
  if (seeds.length < 2) {
    return;
  }
  const inputs = fixedInputs(config.maxTicks);
  const hashes = new Set<string>();
  for (const seed of seeds) {
    try {
      const result = runGame(
        game,
        seed,
        config,
        (_state, tick) => inputs[tick] ?? [RELEASED, RELEASED],
      );
      hashes.add(hashState(result.state));
    } catch {
      return;
    }
  }
  if (hashes.size === 1) {
    violation(
      'K13',
      `種子 ${seeds.join('、')} 用同一串輸入，終局雜湊全部相同：種子沒有影響到遊戲（忘了把新的 RngState 寫回 state，或是 init 忽略了種子？）`,
    );
  }
}

// ---------------------------------------------------------------------------
// A1–A5：AI 行為（TEST_PLAN 5.1）
// ---------------------------------------------------------------------------

export interface AiThresholds {
  readonly a1: number;
  readonly a2: number;
  readonly a3: number;
  readonly a4: number;
}

/** 門檻（TEST_PLAN 5.1）。運氣成分高的牌（`meta.luckHeavy`，紅心）A1 降為 60%、A2 降為 55%。 */
export function aiThresholds(meta: CardMeta): AiThresholds {
  const lucky = meta.luckHeavy === true;
  return { a1: lucky ? 0.6 : 0.75, a2: lucky ? 0.55 : 0.6, a3: 0.45, a4: 0.35 };
}

/** A1–A5 的前提：有預設性格、而且不是鬼牌（鬼牌不跑 5.1）。 */
export function runsAiChecks(entry: RegistryEntry): boolean {
  return entry.meta.defaultPolicy !== null && entry.meta.suit !== 'JK';
}

function requirePolicy(entry: RegistryEntry): Policy {
  const policy = defaultPolicyOf(entry.meta);
  if (policy === null) {
    throw new Error(`${entry.id} 沒有預設性格，不該跑 A1–A5`);
  }
  return policy;
}

/** A1 的數字：預設性格等級 5 對 random 的勝率。 */
export function measureA1(entry: RegistryEntry, seeds: readonly number[] = AI_SEEDS): number {
  return winRate(entry.game, requirePolicy(entry), 5, randomPolicy, 10, seeds);
}

/** A2 的數字：預設性格等級 9 對等級 2 的勝率。 */
export function measureA2(entry: RegistryEntry, seeds: readonly number[] = AI_SEEDS): number {
  const policy = requirePolicy(entry);
  return winRate(entry.game, policy, 9, policy, 2, seeds);
}

/** A3 的數字：human-model 對預設性格等級 1 的勝率。 */
export function measureA3(entry: RegistryEntry, seeds: readonly number[] = AI_SEEDS): number {
  return winRate(entry.game, humanPolicy, HUMAN_LEVEL, requirePolicy(entry), 1, seeds);
}

/** A4 的數字：human-model 對預設性格等級 10 的勝率。 */
export function measureA4(entry: RegistryEntry, seeds: readonly number[] = AI_SEEDS): number {
  return winRate(entry.game, humanPolicy, HUMAN_LEVEL, requirePolicy(entry), 10, seeds);
}

/** A5 的數字：預設性格等級 10 的 decide() 每次花幾毫秒。 */
export function measureA5(
  entry: RegistryEntry,
  seeds: readonly number[] = SPEED_SEEDS,
): DecideTimes {
  return measureDecideTimes(entry.game, requirePolicy(entry), 10, seeds);
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** A1 AI 比亂按強：預設性格等級 5 對 random，勝率至少 75%（luckHeavy 60%）。 */
export function checkAiBeatsRandom(
  entry: RegistryEntry,
  seeds: readonly number[] = AI_SEEDS,
): void {
  const need = aiThresholds(entry.meta).a1;
  const rate = measureA1(entry, seeds);
  if (!(rate >= need)) {
    violation(
      'A1',
      `${seeds.length} 場，勝率 ${pct(rate)}，至少要 ${pct(need)}（等級 5 對 random）`,
    );
  }
}

/** A2 等級有意義：預設性格等級 9 對等級 2，勝率至少 60%（luckHeavy 55%）。 */
export function checkLevelMatters(entry: RegistryEntry, seeds: readonly number[] = AI_SEEDS): void {
  const need = aiThresholds(entry.meta).a2;
  const rate = measureA2(entry, seeds);
  if (!(rate >= need)) {
    violation(
      'A2',
      `${seeds.length} 場，勝率 ${pct(rate)}，至少要 ${pct(need)}（等級 9 對等級 2）`,
    );
  }
}

/** A3 人打得贏第一級：human-model 對預設性格等級 1，勝率至少 45%。 */
export function checkHumanBeatsLevel1(
  entry: RegistryEntry,
  seeds: readonly number[] = AI_SEEDS,
): void {
  const need = aiThresholds(entry.meta).a3;
  const rate = measureA3(entry, seeds);
  if (!(rate >= need)) {
    violation(
      'A3',
      `${seeds.length} 場，human-model 的勝率 ${pct(rate)}，至少要 ${pct(need)}（對等級 1）`,
    );
  }
}

/** A4 人打不太贏第十級：human-model 對預設性格等級 10，勝率最多 35%。 */
export function checkHumanLosesToLevel10(
  entry: RegistryEntry,
  seeds: readonly number[] = AI_SEEDS,
): void {
  const limit = aiThresholds(entry.meta).a4;
  const rate = measureA4(entry, seeds);
  if (!(rate <= limit)) {
    violation(
      'A4',
      `${seeds.length} 場，human-model 的勝率 ${pct(rate)}，最多只能 ${pct(limit)}（對等級 10）`,
    );
  }
}

/** A5 決策夠快：預設性格等級 10 的 decide()，平均少於 1 毫秒、最慢少於 8 毫秒。 */
export function checkDecisionSpeed(
  entry: RegistryEntry,
  seeds: readonly number[] = SPEED_SEEDS,
): void {
  const { samples, meanMs, maxMs } = measureA5(entry, seeds);
  if (!(meanMs < 1)) {
    violation('A5', `${samples} 次 decide()，平均 ${meanMs.toFixed(3)} 毫秒，要少於 1 毫秒`);
  }
  if (!(maxMs < 8)) {
    violation('A5', `${samples} 次 decide()，最慢 ${maxMs.toFixed(3)} 毫秒，要少於 8 毫秒`);
  }
}

// ---------------------------------------------------------------------------
// R1–R3：render
// ---------------------------------------------------------------------------

interface RenderSample {
  readonly tick: number;
  readonly context: FakeContext;
  /** render 丟出的錯誤（R1 負責報告；R2、R3 照樣檢查丟錯之前畫了什麼）。 */
  readonly error: unknown;
  readonly hashBefore: string;
  readonly hashAfter: string;
}

/**
 * 跑一場隨機對局，在開頭、每隔一段 tick 與結尾各取一個 state，
 * 複製之後深度凍結，再對假的 context 呼叫 `render`。
 * 用複製的是為了不讓 step 的問題（K4）牽連到 render 的檢查。
 */
function sampleRenders<S>(
  entry: RegistryEntry<S>,
  seed: number,
  config: GameConfig,
): RenderSample[] {
  const samples: RenderSample[] = [];
  const take = (state: S, tick: number): void => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(state)) as S);
    const context = createFakeContext();
    const hashBefore = softHash(frozen);
    let error: unknown = null;
    try {
      entry.render(asRenderingContext(context), frozen);
    } catch (caught) {
      error = caught;
    }
    samples.push({ tick, context, error, hashBefore, hashAfter: softHash(frozen) });
  };
  const result = runGame(
    entry.game,
    seed,
    config,
    randomPicker(entry.game, seed),
    (state, tick) => {
      if (tick % RENDER_SAMPLE_INTERVAL === 0) {
        take(state, tick);
      }
    },
  );
  take(result.state, result.ticks);
  return samples;
}

/** R1 不改 state：對凍結的 state 呼叫 render 不丟錯，state 的雜湊不變。 */
export function checkRenderPure<S>(
  entry: RegistryEntry<S>,
  seed: number,
  config: GameConfig,
): void {
  for (const sample of sampleRenders(entry, seed, config)) {
    if (sample.error !== null) {
      violation(
        'R1',
        `tick ${sample.tick}：render 對凍結的 state 丟出錯誤（${errorText(sample.error)}）`,
      );
    }
    if (sample.hashBefore !== sample.hashAfter) {
      violation('R1', `tick ${sample.tick}：render 之後 state 的雜湊改變了`);
    }
  }
}

/** R2 只用色盤：所有設定過與實際用到的顏色都在 16 色色盤裡。 */
export function checkRenderPalette<S>(
  entry: RegistryEntry<S>,
  seed: number,
  config: GameConfig,
): void {
  const allowed = new Set<string>(PALETTE);
  for (const sample of sampleRenders(entry, seed, config)) {
    for (const record of sample.context.colors) {
      if (typeof record.value !== 'string' || !allowed.has(record.value)) {
        const how =
          record.via === 'set'
            ? `設定 ${record.property}`
            : `用 ${record.method ?? '?'} 畫圖時的 ${record.property}`;
        violation(
          'R2',
          `tick ${sample.tick}：${how}是 ${describeValue(record.value)}，不在 16 色色盤裡`,
        );
      }
    }
  }
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : `一個 ${typeof value}（不是色盤字串）`;
}

/** R3 不畫出界：所有繪圖座標在 0..320 × 0..240 之內，容許 8 像素。 */
export function checkRenderBounds<S>(
  entry: RegistryEntry<S>,
  seed: number,
  config: GameConfig,
): void {
  const min = -BOUNDS_TOLERANCE;
  const maxX = LOGIC_WIDTH + BOUNDS_TOLERANCE;
  const maxY = LOGIC_HEIGHT + BOUNDS_TOLERANCE;
  for (const sample of sampleRenders(entry, seed, config)) {
    for (const p of sample.context.points) {
      const finite = Number.isFinite(p.x) && Number.isFinite(p.y);
      if (!finite || p.x < min || p.x > maxX || p.y < min || p.y > maxY) {
        violation(
          'R3',
          `tick ${sample.tick}：${p.method} 的座標 (${p.x}, ${p.y}) 超出 ${LOGIC_WIDTH}×${LOGIC_HEIGHT}（容許 ${BOUNDS_TOLERANCE} 像素）`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const BASE_LEVEL_BY_RANK: Readonly<Record<string, number>> = {
  A: 1,
  '2': 1,
  '3': 1,
  '4': 2,
  '5': 2,
  '6': 2,
  '7': 3,
  '8': 3,
  '9': 3,
  '10': 3,
  J: 4,
  Q: 4,
  K: 4,
};

const POLICY_NAMES: readonly string[] = ['pathfinder', 'precise', 'greedy', 'gambler'];

/** 說明只能是「一句」：不換行、不太長。 */
const DESCRIPTION_MAX = 80;

/** 蒐集所有 meta 問題一次丟出，這樣一張牌有三個問題不用修三輪。 */
export function checkMeta(entry: RegistryEntry): void {
  const problems: string[] = [];
  const { id, meta } = entry;

  if (meta.id !== id) {
    problems.push(`meta.id（${meta.id}）與登記表的 id（${id}）不一致`);
  }
  if (typeof meta.name !== 'string' || !/[一-鿿]/.test(meta.name)) {
    problems.push('meta.name 必須是繁體中文名稱');
  }
  if (
    typeof meta.description !== 'string' ||
    meta.description.trim() === '' ||
    /[\r\n]/.test(meta.description) ||
    meta.description.length > DESCRIPTION_MAX
  ) {
    problems.push(`meta.description 必須是一句說明（非空、不換行、至多 ${DESCRIPTION_MAX} 字）`);
  }
  if (typeof meta.controls !== 'string' || meta.controls.trim() === '') {
    problems.push('meta.controls（操作說明）不可以是空的');
  }
  if (meta.defaultPolicy !== null && !POLICY_NAMES.includes(meta.defaultPolicy)) {
    problems.push(`meta.defaultPolicy（${String(meta.defaultPolicy)}）不是已知的性格`);
  }
  if (!Number.isInteger(meta.baseLevel) || meta.baseLevel < 1 || meta.baseLevel > 4) {
    problems.push(`meta.baseLevel（${meta.baseLevel}）必須是 1 到 4 的整數`);
  }

  const specPath = resolve(REPO_ROOT, 'docs', 'cards', `${id}.md`);
  if (!existsSync(specPath) || statSync(specPath).size === 0) {
    problems.push(`docs/cards/${id}.md 不存在或是空的`);
  }

  if (entry.kind === 'card') {
    if (!CARD_IDS.includes(id)) {
      problems.push(`id（${id}）不是 54 張牌的其中一個`);
    }
    if (`${String(meta.suit)}-${String(meta.rank)}` !== id) {
      problems.push(`花色與點數（${String(meta.suit)}、${String(meta.rank)}）與 id（${id}）不一致`);
    }
    if (entry.game.id !== id) {
      problems.push(`game.id（${entry.game.id}）與登記表的 id（${id}）不一致`);
    }
    const folder = resolve(REPO_ROOT, 'src', 'games', id);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      problems.push(`資料夾 src/games/${id}/ 不存在`);
    }
    const expectedBase = BASE_LEVEL_BY_RANK[String(meta.rank)];
    if (expectedBase !== undefined && meta.baseLevel !== expectedBase) {
      problems.push(
        `meta.baseLevel 是 ${meta.baseLevel}，SPEC 7.2 規定點數 ${String(meta.rank)} 是 ${expectedBase}`,
      );
    }
  } else {
    // 替身牌（fixture）：不是撲克牌，花色與點數必須明確標為 null，id 也不能撞到真的牌。
    if (meta.suit !== null || meta.rank !== null) {
      problems.push('替身牌（kind: "fixture"）的 suit 與 rank 必須是 null');
    }
    if (CARD_IDS.includes(id)) {
      problems.push(`替身牌的 id（${id}）撞到真的牌`);
    }
  }

  if (problems.length > 0) {
    violation('META', `${id}：\n  - ${problems.join('\n  - ')}`);
  }
}

// ---------------------------------------------------------------------------
// 檢查清單：all-games.test.ts 與 bad-games.test.ts 共用
// ---------------------------------------------------------------------------

export interface CheckDef {
  readonly code: CheckCode;
  readonly title: string;
  /** 這張牌需不需要跑這一條（K12 只對 `meta.symmetric`）。 */
  applies(entry: RegistryEntry): boolean;
  /** 對給定的種子清單跑；失敗丟 `ContractViolation`。 */
  run(entry: RegistryEntry, seeds: readonly number[]): void;
}

/** 對每個種子跑一次，把任何錯誤（含遊戲自己丟的）包成帶編號與種子的 ContractViolation。 */
function perSeed(
  code: CheckCode,
  fn: (entry: RegistryEntry, seed: number) => void,
): (entry: RegistryEntry, seeds: readonly number[]) => void {
  return (entry, seeds) => {
    for (const seed of seeds) {
      try {
        fn(entry, seed);
      } catch (error) {
        if (error instanceof ContractViolation && error.code === code) {
          throw new ContractViolation(
            code,
            `種子 ${seed}｜${error.message.slice(code.length + 3)}`,
          );
        }
        throw new ContractViolation(code, `種子 ${seed}｜遊戲丟出錯誤：${errorText(error)}`);
      }
    }
  };
}

const GAME_CHECKS: readonly {
  code: CheckCode;
  title: string;
  fn: (game: Game<unknown>, seed: number, config: GameConfig, entry: RegistryEntry) => void;
}[] = [
  { code: 'K1', title: '決定性', fn: (g, s, c) => checkDeterminism(g, s, c) },
  { code: 'K2', title: '可序列化', fn: (g, s, c) => checkSerializable(g, s, c) },
  { code: 'K3', title: '沒有壞數字', fn: (g, s, c) => checkNoBadNumbers(g, s, c) },
  { code: 'K4', title: 'step 是純的', fn: (g, s, c) => checkStepPure(g, s, c) },
  { code: 'K5', title: '會結束', fn: (g, s, c) => checkTerminates(g, s, c) },
  { code: 'K6', title: '結束後穩定', fn: (g, s, c) => checkStableAfterOver(g, s, c) },
  {
    code: 'K7',
    title: '分數一致',
    fn: (g, s, c, e) =>
      checkWinnerMatchesScore(g, s, c, { winnerNotByScore: e.meta.winnerNotByScore === true }),
  },
  { code: 'K8', title: '動作合法', fn: (g, s, c) => checkActionsLegal(g, s, c) },
  { code: 'K9', title: '評估可用', fn: (g, s, c) => checkEvaluateUsable(g, s, c) },
  { code: 'K10', title: '重播', fn: (g, s, c) => checkReplay(g, s, c) },
  { code: 'K11', title: '夠快', fn: (_g, s, c, e) => checkSpeed(e, s, c) },
];

/** A1–A5：種子數是檢查的一部分（200 個，TEST_PLAN 5.1），不理會呼叫者給的清單。 */
function aiDefs(): CheckDef[] {
  const defs: readonly {
    code: CheckCode;
    title: string;
    fn: (entry: RegistryEntry) => void;
  }[] = [
    { code: 'A1', title: 'AI 比亂按強', fn: (e) => checkAiBeatsRandom(e) },
    { code: 'A2', title: '等級有意義', fn: (e) => checkLevelMatters(e) },
    { code: 'A3', title: '人打得贏第一級', fn: (e) => checkHumanBeatsLevel1(e) },
    { code: 'A4', title: '人打不太贏第十級', fn: (e) => checkHumanLosesToLevel10(e) },
    { code: 'A5', title: '決策夠快', fn: (e) => checkDecisionSpeed(e) },
  ];
  return defs.map(({ code, title, fn }) => ({
    code,
    title,
    applies: runsAiChecks,
    run(entry: RegistryEntry, seeds: readonly number[]): void {
      void seeds;
      try {
        fn(entry);
      } catch (error) {
        if (error instanceof ContractViolation) {
          throw error;
        }
        throw new ContractViolation(code, `遊戲丟出錯誤：${errorText(error)}`);
      }
    },
  }));
}

/**
 * A1–A5。與 `CHECKS`（K1–K12、R1–R3、META）分開放：`bad-games.test.ts` 要求 `CHECKS` 裡每一條
 * 都有一個專門抓它的故意違約假遊戲，而 A1–A5 是統計門檻，不是契約違規；
 * 它們的「抓得到壞的」證明在 `tests/ai/contract-ai.test.ts`。
 * `all-games.test.ts` 對 `[...CHECKS, ...AI_CHECKS]` 跑同一個迴圈。
 */
export const AI_CHECKS: readonly CheckDef[] = aiDefs();

export const CHECKS: readonly CheckDef[] = [
  ...GAME_CHECKS.map(({ code, title, fn }): CheckDef => ({
    code,
    title,
    applies: () => true,
    run: perSeed(code, (entry, seed) => fn(entry.game, seed, CONTRACT_CONFIG, entry)),
  })),
  {
    code: 'K12',
    title: '對稱',
    applies: (entry) => entry.meta.symmetric === true,
    run(entry: RegistryEntry, seeds: readonly number[]): void {
      // K12 的種子數是檢查的一部分（200 個），不理會呼叫者給的清單長度。
      void seeds;
      try {
        checkSymmetry(entry, SYMMETRY_SEEDS, CONTRACT_CONFIG);
      } catch (error) {
        if (error instanceof ContractViolation) {
          throw error;
        }
        throw new ContractViolation('K12', `遊戲丟出錯誤：${errorText(error)}`);
      }
    },
  },
  {
    code: 'K13',
    title: '種子有效',
    applies: (entry) => entry.meta.seedIndependent !== true,
    run(entry: RegistryEntry, seeds: readonly number[]): void {
      // K13 的種子數是檢查的一部分（0 到 9），不理會呼叫者給的清單。
      void seeds;
      checkSeedMatters(entry.game, SEED_MATTERS_SEEDS, CONTRACT_CONFIG);
    },
  },
  {
    code: 'R1',
    title: 'render 不改 state',
    applies: () => true,
    run: perSeed('R1', (entry, seed) => checkRenderPure(entry, seed, CONTRACT_CONFIG)),
  },
  {
    code: 'R2',
    title: 'render 只用色盤',
    applies: () => true,
    run: perSeed('R2', (entry, seed) => checkRenderPalette(entry, seed, CONTRACT_CONFIG)),
  },
  {
    code: 'R3',
    title: 'render 不畫出界',
    applies: () => true,
    run: perSeed('R3', (entry, seed) => checkRenderBounds(entry, seed, CONTRACT_CONFIG)),
  },
  {
    code: 'META',
    title: 'meta 與文件',
    applies: () => true,
    run(entry: RegistryEntry): void {
      checkMeta(entry);
    },
  },
];

export type CheckOutcome = 'pass' | 'skip' | { fail: string };

/** 跑一條檢查，回傳結果而不是丟錯，給 bad-games 測試彙整用。 */
export function runCheck(
  def: CheckDef,
  entry: RegistryEntry,
  seeds: readonly number[] = CONTRACT_SEEDS,
): CheckOutcome {
  if (!def.applies(entry)) {
    return 'skip';
  }
  try {
    def.run(entry, seeds);
    return 'pass';
  } catch (error) {
    return { fail: errorText(error) };
  }
}

/** 對一張牌跑全部檢查（或只跑 `only` 指定的），回傳「失敗的編號」。 */
export function failingCodes(
  entry: RegistryEntry,
  options: { seeds?: readonly number[]; only?: readonly CheckCode[] } = {},
): CheckCode[] {
  const failed: CheckCode[] = [];
  for (const def of CHECKS) {
    if (options.only !== undefined && !options.only.includes(def.code)) {
      continue;
    }
    const outcome = runCheck(def, entry, options.seeds ?? CONTRACT_SEEDS);
    if (typeof outcome === 'object') {
      failed.push(def.code);
    }
  }
  return failed;
}
