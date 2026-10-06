import { COLOR } from './palette';

/**
 * 像素風的小零件：手繪的點陣花色圖案與 3×5 的點數字型。
 * 點數與花色用點陣（不依賴系統字型有沒有 ♣♠♦♥ 這幾個字）；中文用系統字型（見 `text.ts`）。
 */

export type Bitmap = readonly string[];

export const PIPS: Readonly<Record<'C' | 'S' | 'D' | 'H' | 'JK', Bitmap>> = {
  C: ['..XXX..', '.XXXXX.', '..XXX..', 'XX.X.XX', 'XXXXXXX', '...X...', '..XXX..'],
  S: ['...X...', '..XXX..', '.XXXXX.', 'XXXXXXX', 'XXXXXXX', 'XX.X.XX', '..XXX..'],
  D: ['...X...', '..XXX..', '.XXXXX.', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'],
  H: ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'],
  JK: ['...X...', '...X...', 'XXXXXXX', '.XXXXX.', '..XXX..', '.XX.XX.', 'XX...XX'],
};

const GLYPHS: Readonly<Record<string, Bitmap>> = {
  A: ['.X.', 'X.X', 'XXX', 'X.X', 'X.X'],
  '0': ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'],
  '1': ['.X.', 'XX.', '.X.', '.X.', 'XXX'],
  '2': ['XX.', '..X', '.X.', 'X..', 'XXX'],
  '3': ['XX.', '..X', '.X.', '..X', 'XX.'],
  '4': ['X.X', 'X.X', 'XXX', '..X', '..X'],
  '5': ['XXX', 'X..', 'XX.', '..X', 'XX.'],
  '6': ['.XX', 'X..', 'XXX', 'X.X', 'XXX'],
  '7': ['XXX', '..X', '.X.', '.X.', '.X.'],
  '8': ['XXX', 'X.X', 'XXX', 'X.X', 'XXX'],
  '9': ['XXX', 'X.X', 'XXX', '..X', 'XX.'],
  J: ['..X', '..X', '..X', 'X.X', '.X.'],
  Q: ['XXX', 'X.X', 'X.X', 'XXX', '..X'],
  K: ['X.X', 'X.X', 'XX.', 'X.X', 'X.X'],
  R: ['XX.', 'X.X', 'XX.', 'X.X', 'X.X'],
  B: ['XX.', 'X.X', 'XX.', 'X.X', 'XX.'],
};

export const GLYPH_HEIGHT = 5;
const GLYPH_ADVANCE = 4;

/** 把點陣畫在 (x, y)，`scale` 是每個點的邊長（整數）。 */
export function drawBitmap(
  ctx: CanvasRenderingContext2D,
  bitmap: Bitmap,
  x: number,
  y: number,
  color: string,
  scale = 1,
): void {
  ctx.fillStyle = color;
  bitmap.forEach((row, rowIndex) => {
    for (let column = 0; column < row.length; column += 1) {
      if (row[column] === 'X') {
        ctx.fillRect(x + column * scale, y + rowIndex * scale, scale, scale);
      }
    }
  });
}

/** 點數字型的寬度（像素）。 */
export function glyphTextWidth(text: string, scale = 1): number {
  return Math.max(0, text.length * GLYPH_ADVANCE - 1) * scale;
}

/** 用 3×5 的字型畫點數（A、2–10、J、Q、K、R、B）。 */
export function drawGlyphs(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  scale = 1,
): void {
  [...text].forEach((character, index) => {
    const glyph = GLYPHS[character];
    if (glyph !== undefined) {
      drawBitmap(ctx, glyph, x + index * GLYPH_ADVANCE * scale, y, color, scale);
    }
  });
}

/** 花色的主色與暗色。 */
export function suitColors(suit: string): { main: string; dark: string } {
  switch (suit) {
    case 'C':
      return { main: COLOR.clubs, dark: COLOR.clubsDark };
    case 'S':
      return { main: COLOR.spades, dark: COLOR.spadesDark };
    case 'D':
      return { main: COLOR.diamonds, dark: COLOR.diamondsDark };
    case 'H':
      return { main: COLOR.hearts, dark: COLOR.heartsDark };
    default:
      return { main: COLOR.joker, dark: COLOR.dark };
  }
}

/** 牌 id（`C-A`、`JK-R`）拆成花色與點數。 */
export function splitId(id: string): { suit: 'C' | 'S' | 'D' | 'H' | 'JK'; rank: string } {
  const [suit = 'JK', rank = ''] = id.split('-');
  const known = suit === 'C' || suit === 'S' || suit === 'D' || suit === 'H' ? suit : 'JK';
  return { suit: known, rank };
}
