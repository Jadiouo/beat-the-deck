/**
 * 假的 2D context（TEST_PLAN R1–R3）。
 *
 * 所有繪圖方法都是 no-op，但會記錄兩樣東西：
 *
 * - `colors`：每一次 `fillStyle`／`strokeStyle`／`shadowColor` 被「設定」的值，
 *   以及每一次繪圖呼叫「實際用到」的顏色（所以忘了設顏色、吃到瀏覽器預設的
 *   `#000000` 也會被 R2 抓到）。
 * - `points`：所有繪圖呼叫的座標，已經套過目前的 transform（translate／scale／
 *   rotate／setTransform），所以 `translate(300, 0)` 之後畫在 x=50 也會被抓到。
 *
 * 型別的處理：`FakeContext` 是一個自己定義的 class，用
 * `implements Partial<Omit<CanvasRenderingContext2D, 'canvas'>>` 讓編譯器核對
 * 每個我實作的成員簽名與真的 `CanvasRenderingContext2D` 一致（不用 `any`）。
 * 它沒有實作全部的成員，所以要交給 `render(ctx, state)` 時只在
 * `asRenderingContext` 這一個地方做一次 `as unknown as CanvasRenderingContext2D`。
 * 遊戲呼叫了這裡沒實作的方法，會得到 `ctx.xxx is not a function`，
 * 這時請到這個檔案補上，不要在遊戲裡繞開。
 */

export const LOGIC_WIDTH = 320;
export const LOGIC_HEIGHT = 240;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type ColorProperty = 'fillStyle' | 'strokeStyle' | 'shadowColor';

export interface ColorRecord {
  readonly property: ColorProperty;
  /** `set` 是被指定的值；`used` 是繪圖呼叫當下實際生效的值。 */
  readonly via: 'set' | 'used';
  /** 原樣記錄（可能是漸層物件，R2 會因此失敗）。 */
  readonly value: unknown;
  /** 只有 `used` 有：是哪個繪圖方法用到的。 */
  readonly method?: string;
}

export interface PointRecord extends Point {
  readonly method: string;
}

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** 真的 canvas 的預設值。 */
const DEFAULT_COLOR = '#000000';

interface SavedState {
  matrix: Matrix;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  shadowColor: string;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
}

/** 乘法：`a` 套在 `b` 之後（與 canvas 的 transform() 一致）。 */
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

class FakeGradient {
  readonly stops: { offset: number; color: string }[] = [];
  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color });
  }
}

export class FakeContext implements Partial<Omit<CanvasRenderingContext2D, 'canvas'>> {
  /** 真的 canvas 元素的替身：只有牌可能會讀的寬高。 */
  readonly canvas = { width: LOGIC_WIDTH, height: LOGIC_HEIGHT };

  readonly colors: ColorRecord[] = [];
  readonly points: PointRecord[] = [];
  /** 每個被呼叫過的方法名稱（含沒有座標的），給輔助工具的測試用。 */
  readonly calls: string[] = [];

  // ---- 狀態屬性（setter 會記錄顏色）----
  private _fillStyle: string | CanvasGradient | CanvasPattern = DEFAULT_COLOR;
  private _strokeStyle: string | CanvasGradient | CanvasPattern = DEFAULT_COLOR;
  private _shadowColor = 'rgba(0, 0, 0, 0)';

  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this._fillStyle;
  }
  set fillStyle(value: string | CanvasGradient | CanvasPattern) {
    this._fillStyle = value;
    this.colors.push({ property: 'fillStyle', via: 'set', value });
  }

  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this._strokeStyle;
  }
  set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
    this._strokeStyle = value;
    this.colors.push({ property: 'strokeStyle', via: 'set', value });
  }

  get shadowColor(): string {
    return this._shadowColor;
  }
  set shadowColor(value: string) {
    this._shadowColor = value;
    this.colors.push({ property: 'shadowColor', via: 'set', value });
  }

  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  miterLimit = 10;
  lineDashOffset = 0;
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  imageSmoothingEnabled = true;
  imageSmoothingQuality: ImageSmoothingQuality = 'low';
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  direction: CanvasDirection = 'inherit';
  filter = 'none';

  // ---- transform 與 save／restore ----
  private matrix: Matrix = IDENTITY;
  private readonly stack: SavedState[] = [];
  private lineDash: number[] = [];

  save(): void {
    this.calls.push('save');
    this.stack.push({
      matrix: this.matrix,
      fillStyle: this._fillStyle,
      strokeStyle: this._strokeStyle,
      shadowColor: this._shadowColor,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
  }

  restore(): void {
    this.calls.push('restore');
    const saved = this.stack.pop();
    if (saved === undefined) {
      return;
    }
    this.matrix = saved.matrix;
    // 還原不是「設定」，不記錄；之後繪圖用到時才記錄。
    this._fillStyle = saved.fillStyle;
    this._strokeStyle = saved.strokeStyle;
    this._shadowColor = saved.shadowColor;
    this.lineWidth = saved.lineWidth;
    this.globalAlpha = saved.globalAlpha;
    this.font = saved.font;
    this.textAlign = saved.textAlign;
    this.textBaseline = saved.textBaseline;
  }

  translate(x: number, y: number): void {
    this.calls.push('translate');
    this.matrix = multiply(this.matrix, [1, 0, 0, 1, x, y]);
  }

  scale(x: number, y: number): void {
    this.calls.push('scale');
    this.matrix = multiply(this.matrix, [x, 0, 0, y, 0, 0]);
  }

  rotate(angle: number): void {
    this.calls.push('rotate');
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.matrix = multiply(this.matrix, [cos, sin, -sin, cos, 0, 0]);
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.calls.push('transform');
    this.matrix = multiply(this.matrix, [a, b, c, d, e, f]);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setTransform(transform?: DOMMatrix2DInit): void;
  setTransform(a?: number | DOMMatrix2DInit, b = 0, c = 0, d = 1, e = 0, f = 0): void {
    this.calls.push('setTransform');
    if (typeof a === 'number') {
      // 與真的 API 一致：六個參數是 (a, b, c, d, e, f)。
      this.matrix = [a, b, c, d, e, f];
    } else if (a === undefined) {
      this.matrix = IDENTITY;
    } else {
      this.matrix = [a.a ?? 1, a.b ?? 0, a.c ?? 0, a.d ?? 1, a.e ?? 0, a.f ?? 0];
    }
  }

  resetTransform(): void {
    this.calls.push('resetTransform');
    this.matrix = IDENTITY;
  }

  // ---- 座標與顏色的記錄 ----
  private point(method: string, x: number, y: number): void {
    const m = this.matrix;
    this.points.push({
      method,
      x: m[0] * x + m[2] * y + m[4],
      y: m[1] * x + m[3] * y + m[5],
    });
  }

  /** 矩形的四個角（套了 transform 之後可能不是正矩形）。 */
  private rectPoints(method: string, x: number, y: number, w: number, h: number): void {
    this.point(method, x, y);
    this.point(method, x + w, y);
    this.point(method, x, y + h);
    this.point(method, x + w, y + h);
  }

  private useFill(method: string): void {
    this.colors.push({ property: 'fillStyle', via: 'used', value: this._fillStyle, method });
  }

  private useStroke(method: string): void {
    this.colors.push({ property: 'strokeStyle', via: 'used', value: this._strokeStyle, method });
  }

  // ---- 矩形 ----
  clearRect(x: number, y: number, w: number, h: number): void {
    this.calls.push('clearRect');
    this.rectPoints('clearRect', x, y, w, h);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.calls.push('fillRect');
    this.rectPoints('fillRect', x, y, w, h);
    this.useFill('fillRect');
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.calls.push('strokeRect');
    this.rectPoints('strokeRect', x, y, w, h);
    this.useStroke('strokeRect');
  }

  // ---- 路徑 ----
  beginPath(): void {
    this.calls.push('beginPath');
  }

  closePath(): void {
    this.calls.push('closePath');
  }

  moveTo(x: number, y: number): void {
    this.calls.push('moveTo');
    this.point('moveTo', x, y);
  }

  lineTo(x: number, y: number): void {
    this.calls.push('lineTo');
    this.point('lineTo', x, y);
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    this.calls.push('bezierCurveTo');
    this.point('bezierCurveTo', c1x, c1y);
    this.point('bezierCurveTo', c2x, c2y);
    this.point('bezierCurveTo', x, y);
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.calls.push('quadraticCurveTo');
    this.point('quadraticCurveTo', cx, cy);
    this.point('quadraticCurveTo', x, y);
  }

  arc(x: number, y: number, radius: number, _start: number, _end: number): void {
    this.calls.push('arc');
    this.rectPoints('arc', x - radius, y - radius, radius * 2, radius * 2);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, _radius: number): void {
    this.calls.push('arcTo');
    this.point('arcTo', x1, y1);
    this.point('arcTo', x2, y2);
  }

  ellipse(x: number, y: number, rx: number, ry: number): void {
    this.calls.push('ellipse');
    this.rectPoints('ellipse', x - rx, y - ry, rx * 2, ry * 2);
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.calls.push('rect');
    this.rectPoints('rect', x, y, w, h);
  }

  roundRect(x: number, y: number, w: number, h: number): void {
    this.calls.push('roundRect');
    this.rectPoints('roundRect', x, y, w, h);
  }

  fill(fillRule?: CanvasFillRule): void;
  fill(path: Path2D, fillRule?: CanvasFillRule): void;
  fill(_a?: unknown, _b?: unknown): void {
    this.calls.push('fill');
    this.useFill('fill');
  }

  stroke(path?: Path2D): void;
  stroke(_path?: unknown): void {
    this.calls.push('stroke');
    this.useStroke('stroke');
  }

  clip(fillRule?: CanvasFillRule): void;
  clip(path: Path2D, fillRule?: CanvasFillRule): void;
  clip(_a?: unknown, _b?: unknown): void {
    this.calls.push('clip');
  }

  // ---- 文字 ----
  fillText(_text: string, x: number, y: number, _maxWidth?: number): void {
    this.calls.push('fillText');
    this.point('fillText', x, y);
    this.useFill('fillText');
  }

  strokeText(_text: string, x: number, y: number, _maxWidth?: number): void {
    this.calls.push('strokeText');
    this.point('strokeText', x, y);
    this.useStroke('strokeText');
  }

  measureText(text: string): TextMetrics {
    this.calls.push('measureText');
    // 假的寬度：每個字 8 像素。牌只該拿來排版，不該依賴真值。
    const width = text.length * 8;
    return {
      width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 0,
      fontBoundingBoxAscent: 8,
      fontBoundingBoxDescent: 2,
      emHeightAscent: 8,
      emHeightDescent: 2,
      hangingBaseline: 8,
      alphabeticBaseline: 0,
      ideographicBaseline: -2,
    };
  }

  // ---- 圖像 ----
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  drawImage(_image: CanvasImageSource, ...args: number[]): void {
    this.calls.push('drawImage');
    if (args.length === 8) {
      this.rectPoints('drawImage', args[4], args[5], args[6], args[7]);
    } else if (args.length === 4) {
      this.rectPoints('drawImage', args[0], args[1], args[2], args[3]);
    } else {
      // 只有左上角；寬高要看圖，假的不知道。
      this.point('drawImage', args[0], args[1]);
    }
  }

  createImageData(sw: number, sh: number, settings?: ImageDataSettings): ImageData;
  createImageData(imageData: ImageData): ImageData;
  createImageData(a: number | ImageData, b = 0): ImageData {
    this.calls.push('createImageData');
    const width = typeof a === 'number' ? a : a.width;
    const height = typeof a === 'number' ? b : a.height;
    return { data: new Uint8ClampedArray(width * height * 4), width, height, colorSpace: 'srgb' };
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData {
    this.calls.push('getImageData');
    this.rectPoints('getImageData', sx, sy, sw, sh);
    return { data: new Uint8ClampedArray(sw * sh * 4), width: sw, height: sh, colorSpace: 'srgb' };
  }

  putImageData(data: ImageData, dx: number, dy: number): void {
    this.calls.push('putImageData');
    this.rectPoints('putImageData', dx, dy, data.width, data.height);
  }

  // ---- 漸層、圖樣、虛線 ----
  createLinearGradient(_x0: number, _y0: number, _x1: number, _y1: number): CanvasGradient {
    this.calls.push('createLinearGradient');
    return new FakeGradient() as unknown as CanvasGradient;
  }

  createRadialGradient(
    _x0: number,
    _y0: number,
    _r0: number,
    _x1: number,
    _y1: number,
    _r1: number,
  ): CanvasGradient {
    this.calls.push('createRadialGradient');
    return new FakeGradient() as unknown as CanvasGradient;
  }

  createConicGradient(_angle: number, _x: number, _y: number): CanvasGradient {
    this.calls.push('createConicGradient');
    return new FakeGradient() as unknown as CanvasGradient;
  }

  setLineDash(segments: number[]): void {
    this.calls.push('setLineDash');
    this.lineDash = [...segments];
  }

  getLineDash(): number[] {
    this.calls.push('getLineDash');
    return [...this.lineDash];
  }
}

/** 建立一個新的假 context。 */
export function createFakeContext(): FakeContext {
  return new FakeContext();
}

/**
 * 交給 `render(ctx, state)` 用。這是整個測試裡唯一的型別轉換：
 * 假的 context 只實作了牌會用到的子集，不是完整的 CanvasRenderingContext2D。
 */
export function asRenderingContext(fake: FakeContext): CanvasRenderingContext2D {
  return fake as unknown as CanvasRenderingContext2D;
}
