import { COLOR } from './palette';

/**
 * 中文用系統字型，並盡量關掉平滑（SPEC 8.4）。
 * 畫布本身只有 320×240 個像素，再用 `image-rendering: pixelated` 放大，所以字的邊緣是方方正正的像素；
 * 瀏覽器仍然會對字型做自己的反鋸齒，`textRendering = 'optimizeSpeed'` 與 `fontKerning = 'none'` 是能做的上限。
 */
const FONT_FAMILY =
  '"Noto Sans CJK TC","Noto Sans TC","PingFang TC","Microsoft JhengHei","WenQuanYi Zen Hei",sans-serif';

export interface TextOptions {
  readonly color?: string;
  readonly size?: number;
  readonly align?: CanvasTextAlign;
  readonly bold?: boolean;
}

export function prepareContext(ctx: CanvasRenderingContext2D): void {
  ctx.imageSmoothingEnabled = false;
  ctx.textRendering = 'optimizeSpeed';
  ctx.fontKerning = 'none';
  ctx.textBaseline = 'top';
}

/** 在 (x, y)（文字的左上角；`align` 不是 left 時 x 是對齊點）畫一行字。 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: TextOptions = {},
): void {
  ctx.font = `${options.bold === true ? 'bold ' : ''}${options.size ?? 12}px ${FONT_FAMILY}`;
  ctx.fillStyle = options.color ?? COLOR.fg;
  ctx.textAlign = options.align ?? 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(text, Math.round(x), Math.round(y));
}

/** 依寬度斷行（中文逐字、英文遇到空白也可以斷）。回傳每一行的文字。 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size = 12,
): string[] {
  ctx.font = `${size}px ${FONT_FAMILY}`;
  const lines: string[] = [];
  let line = '';
  for (const character of text) {
    if (character === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    if (ctx.measureText(line + character).width > maxWidth && line !== '') {
      lines.push(line);
      line = character === ' ' ? '' : character;
    } else {
      line += character;
    }
  }
  if (line !== '') {
    lines.push(line);
  }
  return lines;
}
