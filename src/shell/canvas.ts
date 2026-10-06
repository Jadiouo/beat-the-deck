/**
 * 畫布：邏輯解析度固定 320×240（SPEC 第 3 節），放大的時候只放整數倍並保持像素銳利。
 * 畫布本身永遠是 320×240 個像素，放大由 CSS 做（`image-rendering: pixelated`），
 * 所以不會有半個像素，也不用管 devicePixelRatio。
 */

export const LOGICAL_WIDTH = 320;
export const LOGICAL_HEIGHT = 240;

/** 放得下的最大整數倍；放不下也至少是 1。`reservedHeight` 是要留給別的東西（虛擬按鍵）的高度。 */
export function integerScale(width: number, height: number, reservedHeight = 0): number {
  const byWidth = Math.floor(width / LOGICAL_WIDTH);
  const byHeight = Math.floor((height - reservedHeight) / LOGICAL_HEIGHT);
  const scale = Math.min(byWidth, byHeight);
  return Number.isFinite(scale) ? Math.max(1, scale) : 1;
}

export interface ScreenCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** 依視窗大小重新決定倍率。 */
  refit(reservedHeight: number): void;
  /** 滑鼠或觸控的座標（視窗座標）→ 邏輯座標。 */
  toLogical(clientX: number, clientY: number): { x: number; y: number };
}

export function createScreenCanvas(parent: HTMLElement): ScreenCanvas {
  const canvas = document.createElement('canvas');
  canvas.width = LOGICAL_WIDTH;
  canvas.height = LOGICAL_HEIGHT;
  canvas.dataset['testid'] = 'screen';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.imageRendering = 'pixelated';
  canvas.style.display = 'block';
  parent.append(canvas);

  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('這個瀏覽器不支援 Canvas 2D');
  }
  ctx.imageSmoothingEnabled = false;

  return {
    canvas,
    ctx,
    refit(reservedHeight: number): void {
      const scale = integerScale(window.innerWidth, window.innerHeight, reservedHeight);
      canvas.style.width = `${LOGICAL_WIDTH * scale}px`;
      canvas.style.height = `${LOGICAL_HEIGHT * scale}px`;
    },
    toLogical(clientX: number, clientY: number): { x: number; y: number } {
      const box = canvas.getBoundingClientRect();
      return {
        x: ((clientX - box.left) / box.width) * LOGICAL_WIDTH,
        y: ((clientY - box.top) / box.height) * LOGICAL_HEIGHT,
      };
    },
  };
}
