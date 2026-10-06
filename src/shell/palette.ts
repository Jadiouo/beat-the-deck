/**
 * 16 色像素風色盤（SPEC 8.4）。所有牌只能用這 16 色，契約測試 R2 會逐字比對。
 *
 * 格式統一是小寫 `#rrggbb`。刻意不放純黑 `#000000`：canvas 的預設顏色就是它，
 * 如果它在色盤裡，忘了設 fillStyle 的牌就抓不到。
 * 色相思路參考 PICO-8／Sweetie 16（深色背景、飽和的主色各配一個暗色），但數值是自己挑的。
 */
export const COLOR = {
  /** 背景：偏紫的近黑 */
  bg: '#1a1423',
  /** 暗色：面板、格線、陰影 */
  dark: '#3b3055',
  /** 中灰：停用、次要文字 */
  mid: '#7a7390',
  /** 亮色：高光、邊框、次要前景 */
  light: '#c9c3d9',
  /** 前景：主要文字與線條 */
  fg: '#f6f1e7',

  /** ♣ 梅花主色：綠 */
  clubs: '#3fbf5a',
  /** ♣ 梅花暗色（蛇身陰影、牆） */
  clubsDark: '#1f6b3a',
  /** ♠ 黑桃主色：藍 */
  spades: '#4f8cff',
  /** ♠ 黑桃暗色 */
  spadesDark: '#2a4a9e',
  /** ♦ 方塊主色：黃 */
  diamonds: '#ffd23f',
  /** ♦ 方塊暗色（金色的陰影） */
  diamondsDark: '#b07a14',
  /** ♥ 紅心主色：紅 */
  hearts: '#ff4d6d',
  /** ♥ 紅心暗色 */
  heartsDark: '#9e1f3d',

  /** 警告：橘（預告、倒數） */
  warning: '#ff8c42',
  /** AI 與強調：青 */
  accent: '#4fe0e0',
  /** 鬼牌與特殊：紫 */
  joker: '#b06cff',
} as const;

/** 16 色，順序固定：中性色、四花色（主色在前）、強調色。 */
export const PALETTE: readonly string[] = [
  COLOR.bg,
  COLOR.dark,
  COLOR.mid,
  COLOR.light,
  COLOR.fg,
  COLOR.clubs,
  COLOR.clubsDark,
  COLOR.spades,
  COLOR.spadesDark,
  COLOR.diamonds,
  COLOR.diamondsDark,
  COLOR.hearts,
  COLOR.heartsDark,
  COLOR.warning,
  COLOR.accent,
  COLOR.joker,
];

/** 是不是色盤裡的顏色（逐字比對）。 */
export function isPaletteColor(value: string): boolean {
  return PALETTE.includes(value);
}
