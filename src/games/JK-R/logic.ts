import { intFrom, rngStateFor } from '../../core/rng';
import type { Buttons, Game, GameConfig, Inputs, Side } from '../../core/types';

/**
 * JK-R 一起亂畫（SPEC 第 11 節；小規格 `docs/cards/JK-R.md`）。
 * 沒有輸贏：人和三支 AI 筆（跟隨者、填充者、唱反調的）在同一張 320×240 的畫布上一起畫。
 * 畫布是 state 的一部分，所以同一個種子加同一串輸入會畫出同一張圖。
 *
 * 畫布怎麼存：240 個字串（每列一個），每列用「連續同色段」的長度編碼（run-length），一個字元是一段：
 * 色號 4 位元、長度 9 位元（見 `RUN_BASE`）。空白的一列只有 1 個字元，畫滿線條的一列也只有幾十個字元。
 * 這樣 state 仍是可以 JSON 來回的純資料，雜湊與凍結的成本正比於「有幾段」而不是 76,800 個像素；
 * 編碼是唯一的（相鄰同色一定合併），所以畫面相同則字串相同；
 * 改像素只重建被改到的那幾列，沒有任何像素改變的 tick 直接沿用同一個陣列。
 */

export const WIDTH = 320;
export const HEIGHT = 240;
/** 這張牌的長度：90 秒。實際結束於 `min(config.maxTicks, DURATION_TICKS)`。 */
export const DURATION_TICKS = 5400;
/** 跟隨者的延遲：1 秒。 */
export const FOLLOW_DELAY = 60;
/** 人沒有任何輸入超過這麼多 tick 之後，三支 AI 筆停下來。 */
export const STOP_TICKS = 180;
/** 人沒有輸入的前這麼多 tick，AI 還是全速；之後線性降到 0。 */
export const FADE_START_TICKS = 60;
/** 筆色是 1 到 15；0 是空白。 */
export const FIRST_COLOR = 1;
export const LAST_COLOR = 15;

const INITIAL_COLOR = 9;
const HUMAN_SPEED = 2;
const FULL_SPEED = 2000;
const STEP_MILLI = 1000;
const RETARGET_EVERY = 30;
const SAMPLE_STRIDE = 4;
const SAMPLE_OFFSET = 2;
const FLOW_CELL = 16;
const FLOW_COLS = WIDTH / FLOW_CELL;
const FLOW_ROWS = HEIGHT / FLOW_CELL;
const HISTORY_LENGTH = FOLLOW_DELAY + 1;

/** 一段 = 一個字元，字元碼 = `RUN_BASE + 色號 × 512 + (長度 − 1)`。0x100 到 0x20FF：沒有控制字元、引號、反斜線、代理對。 */
const RUN_BASE = 0x100;
const RUN_COLOR_UNIT = 512;
/** 流場用的字元基底。 */
const CHAR_BASE = 0x100;
const BLANK_ROW = String.fromCharCode(RUN_BASE + WIDTH - 1);

/** 八個方向：0 上，順時針每次 45 度。 */
const DIRS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];
/** 填充者嘗試方向的順序（與流場方向的差）。 */
const TURN_ORDER: readonly number[] = [0, 1, -1, 2, -2, 3, -3, 4];

/** 與人當下顏色互補的顏色（小規格的表）。索引 0 不用。 */
export const COMPLEMENT: readonly number[] = [0, 4, 3, 2, 1, 11, 12, 13, 10, 15, 8, 5, 6, 7, 11, 9];

export interface HumanPen {
  readonly x: number;
  readonly y: number;
  readonly color: number;
  readonly down: boolean;
  /** b 上一個 tick 是不是按著（邊緣觸發用）。 */
  readonly bHeld: boolean;
}

export interface FollowerPen {
  readonly x: number;
  readonly y: number;
  readonly color: number;
  readonly down: boolean;
}

export interface FillerPen {
  readonly x: number;
  readonly y: number;
  readonly color: number;
  /** 不足一步的餘量（千分之步）。 */
  readonly acc: number;
  /** 這個 tick 用的速度（千分之步／tick）。 */
  readonly speed: number;
}

export interface ContrarianPen extends FillerPen {
  readonly tx: number;
  readonly ty: number;
}

export interface JkrState {
  readonly seed: number;
  readonly tick: number;
  readonly maxTicks: number;
  readonly canvas: readonly string[];
  readonly human: HumanPen;
  /** 人連續沒有任何輸入的 tick 數。 */
  readonly idle: number;
  /** 人最近 61 個 tick 的樣本（最舊在前），打包成整數。 */
  readonly hist: readonly number[];
  readonly follower: FollowerPen;
  readonly filler: FillerPen;
  readonly contrarian: ContrarianPen;
  /** 流場：每格一個字元，`CHAR_BASE + 方向 × 16 + 色號`。 */
  readonly flow: string;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 對畫布中心（159.5, 119.5）鏡射 = 點對稱。 */
export function mirrorPoint(x: number, y: number): [number, number] {
  return [WIDTH - 1 - x, HEIGHT - 1 - y];
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function sign(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/** 下一色：15 的下一色是 1。 */
function nextColor(color: number): number {
  return (color % LAST_COLOR) + FIRST_COLOR;
}

/** 速度（千分之步／tick）：idle ≤ 60 全速、61 到 179 線性降低、≥ 180 是 0。 */
export function aiSpeed(idle: number): number {
  if (idle <= FADE_START_TICKS) {
    return FULL_SPEED;
  }
  if (idle >= STOP_TICKS) {
    return 0;
  }
  return Math.floor(((STOP_TICKS - idle) * 50) / 3);
}

function packSample(pen: { x: number; y: number; down: boolean; color: number }): number {
  return pen.x | (pen.y << 9) | ((pen.down ? 1 : 0) << 17) | (pen.color << 18);
}

function unpackSample(sample: number): FollowerPen {
  return {
    x: sample & 511,
    y: (sample >> 9) & 255,
    down: ((sample >> 17) & 1) === 1,
    color: (sample >> 18) & 15,
  };
}

// ---------------------------------------------------------------------------
// 畫布
// ---------------------------------------------------------------------------

/** 讀一個像素（座標在畫布外回傳 -1）。 */
export function getPixel(
  state: { readonly canvas: readonly string[] },
  x: number,
  y: number,
): number {
  if (!inBounds(x, y)) {
    return -1;
  }
  return readPixel(state.canvas, x, y);
}

function readPixel(rows: readonly string[], x: number, y: number): number {
  const row = rows[y] as string;
  let end = 0;
  for (let i = 0; i < row.length; i += 1) {
    const code = row.charCodeAt(i) - RUN_BASE;
    end += (code % RUN_COLOR_UNIT) + 1;
    if (x < end) {
      return (code / RUN_COLOR_UNIT) | 0;
    }
  }
  return 0;
}

/** 對畫布的寫入：第一次真的改到像素時才複製列陣列，改到的列重建，其餘列共用。 */
interface Editor {
  rows: readonly string[];
  copied: boolean;
}

/**
 * 把第 y 列的 x0 到 x1（含）塗成 `color`；`blankOnly` 時只塗原本是空白的像素。
 * 重新編碼整列（段數很少），相鄰同色合併，結果與原本相同就不動任何東西。
 */
function paintSpan(
  editor: Editor,
  y: number,
  x0: number,
  x1: number,
  color: number,
  blankOnly: boolean,
): void {
  const row = editor.rows[y] as string;
  let text = '';
  let lastColor = -1;
  let lastLength = 0;
  const push = (runColor: number, length: number): void => {
    if (length <= 0) {
      return;
    }
    if (runColor === lastColor) {
      lastLength += length;
      return;
    }
    if (lastColor >= 0) {
      text += String.fromCharCode(RUN_BASE + lastColor * RUN_COLOR_UNIT + lastLength - 1);
    }
    lastColor = runColor;
    lastLength = length;
  };
  let start = 0;
  for (let i = 0; i < row.length; i += 1) {
    const code = row.charCodeAt(i) - RUN_BASE;
    const runColor = (code / RUN_COLOR_UNIT) | 0;
    const length = (code % RUN_COLOR_UNIT) + 1;
    const last = start + length - 1;
    if (last < x0 || start > x1) {
      push(runColor, length);
    } else {
      const from = Math.max(start, x0);
      const to = Math.min(last, x1);
      push(runColor, from - start);
      push(blankOnly && runColor !== 0 ? runColor : color, to - from + 1);
      push(runColor, last - to);
    }
    start += length;
  }
  text += String.fromCharCode(RUN_BASE + lastColor * RUN_COLOR_UNIT + lastLength - 1);
  if (text === row) {
    return;
  }
  if (!editor.copied) {
    editor.rows = editor.rows.slice();
    editor.copied = true;
  }
  (editor.rows as string[])[y] = text;
}

function writePixel(editor: Editor, x: number, y: number, color: number): void {
  if (inBounds(x, y)) {
    paintSpan(editor, y, x, x, color, false);
  }
}

/** 以 (cx, cy) 為中心的 3×3 筆刷，裁在畫布內。`blankOnly` 時只畫空白像素。 */
function brush(editor: Editor, cx: number, cy: number, color: number, blankOnly: boolean): void {
  const x0 = Math.max(0, cx - 1);
  const x1 = Math.min(WIDTH - 1, cx + 1);
  for (let y = Math.max(0, cy - 1); y <= Math.min(HEIGHT - 1, cy + 1); y += 1) {
    paintSpan(editor, y, x0, x1, color, blankOnly);
  }
}

/** 畫布轉成色號陣列（0 到 15，列優先，長度 320×240）。給存 PNG 與畫面用。純函式。 */
export function canvasToPixels(state: { readonly canvas: readonly string[] }): {
  width: number;
  height: number;
  pixels: Uint8Array;
} {
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = state.canvas[y] as string;
    let x = 0;
    for (let i = 0; i < row.length; i += 1) {
      const code = row.charCodeAt(i) - RUN_BASE;
      const color = (code / RUN_COLOR_UNIT) | 0;
      const end = x + (code % RUN_COLOR_UNIT) + 1;
      if (color !== 0) {
        pixels.fill(color, y * WIDTH + x, y * WIDTH + end);
      }
      x = end;
    }
  }
  return { width: WIDTH, height: HEIGHT, pixels };
}

/** 存 PNG 的檔名，帶種子。 */
export function pngFileName(state: { readonly seed: number }): string {
  return `JK-R-seed-${state.seed}.png`;
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

function flowChar(dir: number, color: number): string {
  return String.fromCharCode(CHAR_BASE + dir * 16 + color);
}

function makeFlow(seed: number): string {
  let rng = rngStateFor(seed, 'flow');
  const dirs: number[] = [];
  let text = '';
  for (let i = 0; i < FLOW_COLS * FLOW_ROWS; i += 1) {
    let dir: number;
    if (i === 0) {
      [dir, rng] = intFrom(rng, 8);
    } else {
      const [delta, afterDelta] = intFrom(rng, 3);
      rng = afterDelta;
      const base = dirs[i % FLOW_COLS === 0 ? i - FLOW_COLS : i - 1] as number;
      dir = (base + delta + 7) % 8;
    }
    dirs.push(dir);
    const [color, afterColor] = intFrom(rng, LAST_COLOR);
    rng = afterColor;
    text += flowChar(dir, color + FIRST_COLOR);
  }
  return text;
}

function flowAt(flow: string, x: number, y: number): { dir: number; color: number } {
  const cell = Math.floor(y / FLOW_CELL) * FLOW_COLS + Math.floor(x / FLOW_CELL);
  const code = flow.charCodeAt(cell) - CHAR_BASE;
  return { dir: code >> 4, color: code & 15 };
}

const HUMAN_START = { x: 160, y: 120 };

function init(seed: number, config: GameConfig): JkrState {
  const [fx, r1] = intFrom(rngStateFor(seed, 'starts'), WIDTH);
  const [fy, r2] = intFrom(r1, HEIGHT);
  const [cx, r3] = intFrom(r2, WIDTH);
  const [cy] = intFrom(r3, HEIGHT);
  const human: HumanPen = { ...HUMAN_START, color: INITIAL_COLOR, down: false, bHeld: false };
  const [mx, my] = mirrorPoint(human.x, human.y);
  return {
    seed,
    tick: 0,
    maxTicks: Math.min(config.maxTicks, DURATION_TICKS),
    canvas: Array.from({ length: HEIGHT }, () => BLANK_ROW),
    human,
    idle: 0,
    hist: [packSample(human)],
    follower: { x: mx, y: my, color: human.color, down: false },
    filler: { x: fx, y: fy, color: FIRST_COLOR, acc: 0, speed: FULL_SPEED },
    contrarian: { x: cx, y: cy, color: FIRST_COLOR, acc: 0, speed: FULL_SPEED, tx: cx, ty: cy },
    flow: makeFlow(seed),
  };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

function anyPressed(buttons: Buttons): boolean {
  return buttons.up || buttons.down || buttons.left || buttons.right || buttons.a || buttons.b;
}

function stepHuman(human: HumanPen, buttons: Buttons): HumanPen {
  const dx = (buttons.right ? 1 : 0) - (buttons.left ? 1 : 0);
  const dy = (buttons.down ? 1 : 0) - (buttons.up ? 1 : 0);
  const color = buttons.b && !human.bHeld ? nextColor(human.color) : human.color;
  return {
    x: clamp(human.x + dx * HUMAN_SPEED, 0, WIDTH - 1),
    y: clamp(human.y + dy * HUMAN_SPEED, 0, HEIGHT - 1),
    color,
    down: buttons.a,
    bHeld: buttons.b,
  };
}

/**
 * 填充者走一步：依流場方向走；「前方 2 像素」（筆刷的前緣，筆刷半徑是 1）已經有顏色、或在畫布外，就轉彎。
 * 看 2 像素而不是 1 像素，是因為 1 像素之內永遠是自己剛畫的筆刷。被圍住（每個方向前方都有顏色）才改成
 * 「只要目標在畫布內就走」，走過有色的地方，之後遇到空白再繼續填。
 */
function fillerStep(editor: Editor, flow: string, x: number, y: number): [number, number] {
  const { dir } = flowAt(flow, x, y);
  for (const turn of TURN_ORDER) {
    const [dx, dy] = DIRS[(dir + turn + 8) % 8] as readonly [number, number];
    if (
      inBounds(x + dx, y + dy) &&
      inBounds(x + 2 * dx, y + 2 * dy) &&
      readPixel(editor.rows, x + 2 * dx, y + 2 * dy) === 0
    ) {
      return [x + dx, y + dy];
    }
  }
  for (const turn of TURN_ORDER) {
    const [dx, dy] = DIRS[(dir + turn + 8) % 8] as readonly [number, number];
    if (inBounds(x + dx, y + dy)) {
      return [x + dx, y + dy];
    }
  }
  return [x, y];
}

/** 唱反調的挑目標：離人最遠的空白取樣點；沒有空白就原地不動。 */
function pickTarget(
  editor: Editor,
  hx: number,
  hy: number,
  fallback: readonly [number, number],
): [number, number] {
  let best: [number, number] = [fallback[0], fallback[1]];
  let bestDistance = -1;
  for (let y = SAMPLE_OFFSET; y < HEIGHT; y += SAMPLE_STRIDE) {
    const row = editor.rows[y] as string;
    let index = 0;
    let end = 0; // 目前這一段的結尾（不含）
    let runColor = 0;
    for (let x = SAMPLE_OFFSET; x < WIDTH; x += SAMPLE_STRIDE) {
      while (x >= end && index < row.length) {
        const code = row.charCodeAt(index) - RUN_BASE;
        runColor = (code / RUN_COLOR_UNIT) | 0;
        end += (code % RUN_COLOR_UNIT) + 1;
        index += 1;
      }
      if (runColor === 0) {
        const distance = (x - hx) * (x - hx) + (y - hy) * (y - hy);
        if (distance > bestDistance) {
          bestDistance = distance;
          best = [x, y];
        }
      }
    }
  }
  return best;
}

function takeSteps(acc: number, speed: number): { steps: number; acc: number } {
  const total = acc + speed;
  const steps = Math.floor(total / STEP_MILLI);
  return { steps, acc: total - steps * STEP_MILLI };
}

function step(state: JkrState, inputs: Inputs): JkrState {
  if (state.tick >= state.maxTicks) {
    return state;
  }
  const buttons = inputs[0];
  const editor: Editor = { rows: state.canvas, copied: false };

  // 人
  const human = stepHuman(state.human, buttons);
  const idle = anyPressed(buttons) ? 0 : state.idle + 1;
  if (human.down) {
    brush(editor, human.x, human.y, human.color, false);
  }
  const hist = state.hist.length >= HISTORY_LENGTH ? state.hist.slice(1) : state.hist.slice();
  hist.push(packSample(human));

  // 跟隨者：人 60 個 tick 之前的筆，對畫布中心鏡射。
  const past = unpackSample(hist[0] as number);
  const [fx, fy] = mirrorPoint(past.x, past.y);
  const follower: FollowerPen = { x: fx, y: fy, color: past.color, down: past.down };
  if (follower.down) {
    brush(editor, follower.x, follower.y, follower.color, false);
  }

  const speed = aiSpeed(idle);

  // 填充者
  const fillerColorRaw = flowAt(state.flow, state.filler.x, state.filler.y).color;
  const fillerTaken = takeSteps(state.filler.acc, speed);
  let [px, py] = [state.filler.x, state.filler.y];
  for (let i = 0; i < fillerTaken.steps; i += 1) {
    [px, py] = fillerStep(editor, state.flow, px, py);
    const raw = flowAt(state.flow, px, py).color;
    brush(editor, px, py, raw === human.color ? nextColor(raw) : raw, true);
  }
  const filler: FillerPen = {
    x: px,
    y: py,
    color: fillerColorRaw === human.color ? nextColor(fillerColorRaw) : fillerColorRaw,
    acc: fillerTaken.acc,
    speed,
  };

  // 唱反調的
  const contrarianTaken = takeSteps(state.contrarian.acc, speed);
  let { x: qx, y: qy, tx, ty } = state.contrarian;
  if (
    contrarianTaken.steps > 0 &&
    (state.tick % RETARGET_EVERY === 0 || (qx === tx && qy === ty))
  ) {
    [tx, ty] = pickTarget(editor, human.x, human.y, [qx, qy]);
  }
  const contrarianColor = COMPLEMENT[human.color] as number;
  for (let i = 0; i < contrarianTaken.steps; i += 1) {
    if (qx === tx && qy === ty) {
      break;
    }
    qx += sign(tx - qx);
    qy += sign(ty - qy);
    brush(editor, qx, qy, contrarianColor, false);
  }
  const contrarian: ContrarianPen = {
    x: qx,
    y: qy,
    color: contrarianColor,
    acc: contrarianTaken.acc,
    speed,
    tx,
    ty,
  };

  return {
    seed: state.seed,
    tick: state.tick + 1,
    maxTicks: state.maxTicks,
    canvas: editor.rows,
    human,
    idle,
    hist,
    follower,
    filler,
    contrarian,
    flow: state.flow,
  };
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

const RELEASED: Buttons = { up: false, down: false, left: false, right: false, a: false, b: false };

/** 0 號邊的動作：全放開、只按 a、只按 b、八個方向（不按 a、按 a）。 */
const HUMAN_ACTIONS: readonly Buttons[] = [
  RELEASED,
  { ...RELEASED, a: true },
  { ...RELEASED, b: true },
  ...[false, true].flatMap((a) =>
    DIRS.map(([dx, dy]): Buttons => ({
      up: dy < 0,
      down: dy > 0,
      left: dx < 0,
      right: dx > 0,
      a,
      b: false,
    })),
  ),
];
const NO_ACTION: readonly Buttons[] = [RELEASED];

export const jkrGame: Game<JkrState> = {
  id: 'JK-R',
  init,
  step,
  isOver: (state) => state.tick >= state.maxTicks,
  score: () => [0, 0],
  winner: () => null,
  actions: (_state: JkrState, side: Side) => (side === 0 ? HUMAN_ACTIONS : NO_ACTION),
  evaluate: () => ({ gain: 0, danger: 0 }),
};

// ---------------------------------------------------------------------------
// 測試輔助
// ---------------------------------------------------------------------------

export interface StateOverrides {
  readonly seed?: number;
  readonly tick?: number;
  readonly maxTicks?: number;
  readonly idle?: number;
  readonly human?: Partial<HumanPen>;
  readonly follower?: Partial<FollowerPen>;
  readonly filler?: Partial<FillerPen>;
  readonly contrarian?: Partial<ContrarianPen>;
  /** 整張流場都是同一個方向與色號。 */
  readonly flowAll?: { readonly dir: number; readonly color: number };
  /** 先在畫布上畫這些像素。 */
  readonly paint?: readonly { readonly x: number; readonly y: number; readonly color: number }[];
}

/** 測試輔助：從種子 `seed`（預設 0）的初始局面出發，用 overrides 覆蓋。 */
export function makeState(overrides: StateOverrides = {}): JkrState {
  const base = init(overrides.seed ?? 0, {
    maxTicks: overrides.maxTicks ?? DURATION_TICKS,
    params: {},
  });
  const human: HumanPen = { ...base.human, ...overrides.human };
  const [mx, my] = mirrorPoint(human.x, human.y);
  const filler: FillerPen = { ...base.filler, ...overrides.filler };
  const contrarian: ContrarianPen = {
    ...base.contrarian,
    tx: overrides.contrarian?.x ?? base.contrarian.x,
    ty: overrides.contrarian?.y ?? base.contrarian.y,
    ...overrides.contrarian,
  };
  const editor: Editor = { rows: base.canvas, copied: false };
  for (const pixel of overrides.paint ?? []) {
    writePixel(editor, pixel.x, pixel.y, pixel.color);
  }
  const flowAll = overrides.flowAll;
  return {
    ...base,
    tick: overrides.tick ?? 0,
    idle: overrides.idle ?? 0,
    canvas: editor.rows,
    human,
    hist: [packSample(human)],
    follower: { x: mx, y: my, color: human.color, down: false, ...overrides.follower },
    filler,
    contrarian,
    flow:
      flowAll === undefined
        ? base.flow
        : flowChar(flowAll.dir, flowAll.color).repeat(FLOW_COLS * FLOW_ROWS),
  };
}
