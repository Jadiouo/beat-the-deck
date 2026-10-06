import type { Side } from '../core/types';
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from './canvas';
import { drawCards, drawLights } from './deck-view';
import type { DeckView } from './deck-view';
import { COLOR } from './palette';
import { PIPS, drawBitmap, suitColors } from './pixel';
import { pickTaunt, situationOf } from './taunts';
import type { TauntPersonality } from './taunts';
import { strings } from './strings';
import { drawText, wrapText } from './text';

/** 各個畫面（標題、牌桌、說明頁、結算、進化）的畫法。只畫，不做任何決定。 */

const CENTER = LOGICAL_WIDTH / 2;

function clear(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
}

/** 選單的游標（一個小三角形）。 */
function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = COLOR.accent;
  for (let i = 0; i < 4; i += 1) {
    ctx.fillRect(x + i, y + i, 1, 8 - i * 2);
  }
}

export const TITLE_MENU_Y = [152, 172, 192] as const;

export function drawTitle(
  ctx: CanvasRenderingContext2D,
  state: { cursor: number; scanlines: boolean; sound: boolean },
): void {
  clear(ctx);
  drawText(ctx, strings.title, CENTER, 46, { size: 30, bold: true, align: 'center' });
  drawText(ctx, strings.tagline, CENTER, 88, { size: 12, color: COLOR.light, align: 'center' });

  const suits = ['C', 'S', 'D', 'H'] as const;
  suits.forEach((suit, index) => {
    drawBitmap(ctx, PIPS[suit], 103 + index * 31, 114, suitColors(suit).main, 3);
  });

  const labels = [
    strings.titleScreen.start,
    `${strings.titleScreen.scanlines}：${state.scanlines ? strings.titleScreen.on : strings.titleScreen.off}`,
    `${strings.titleScreen.sound}：${state.sound ? strings.titleScreen.on : strings.titleScreen.off}`,
  ];
  labels.forEach((label, index) => {
    const y = TITLE_MENU_Y[index] ?? 152;
    const active = index === state.cursor;
    drawText(ctx, label, CENTER, y, {
      size: 14,
      align: 'center',
      color: active ? COLOR.fg : COLOR.mid,
    });
    if (active) {
      drawMarker(ctx, 100, y + 3);
    }
  });
  drawText(ctx, strings.titleScreen.hint, CENTER, 222, {
    size: 11,
    color: COLOR.mid,
    align: 'center',
  });
}

export interface TableInfo {
  readonly line1: string;
  readonly line2: string;
}

export function drawTable(ctx: CanvasRenderingContext2D, view: DeckView, info: TableInfo): void {
  clear(ctx);
  drawLights(ctx, view);
  drawCards(ctx, view);
  drawText(ctx, info.line1, 6, 199, { size: 12, color: COLOR.fg });
  drawText(ctx, info.line2, 6, 214, { size: 11, color: COLOR.light });
  drawText(ctx, strings.table.hint, 6, 227, { size: 11, color: COLOR.mid });
}

export interface InfoData {
  readonly suit: 'C' | 'S' | 'D' | 'H' | 'JK';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly controls: string;
  readonly personality: string;
  readonly blurb: string;
  readonly level: number;
  readonly best: number | null;
}

export function drawInfo(ctx: CanvasRenderingContext2D, data: InfoData): void {
  clear(ctx);
  const colors = suitColors(data.suit);
  drawBitmap(ctx, PIPS[data.suit], 12, 12, colors.main, 2);
  drawText(ctx, data.name, 36, 10, { size: 16, bold: true, color: colors.main });
  drawText(ctx, data.id, 308, 14, { size: 11, color: COLOR.mid, align: 'right' });

  const section = (label: string, body: string, y: number, maxLines: number): number => {
    drawText(ctx, label, 12, y, { size: 11, color: COLOR.accent });
    let next = y + 14;
    for (const line of wrapText(ctx, body, 296, 12).slice(0, maxLines)) {
      drawText(ctx, line, 12, next, { size: 12 });
      next += 15;
    }
    return next;
  };

  let y = section(strings.info.rules, data.description, 38, 3);
  y = section(strings.info.controls, data.controls, y + 6, 2);

  drawText(ctx, strings.info.opponent, 12, y + 6, { size: 11, color: COLOR.accent });
  drawText(ctx, strings.info.opponentLine(data.personality, data.level), 12, y + 20, { size: 12 });
  drawText(ctx, data.blurb, 12, y + 35, { size: 11, color: COLOR.light });
  drawText(
    ctx,
    data.best === null ? strings.info.noBestScore : strings.info.bestScore(data.best),
    12,
    y + 50,
    { size: 11, color: COLOR.mid },
  );
  drawText(ctx, strings.info.hint, CENTER, 224, { size: 11, color: COLOR.mid, align: 'center' });
}

/**
 * 結算頁的 AI 台詞（SPEC 7.4：分「AI 贏／AI 輸／平手／你連輸三場」四個情境）。
 * 沒有 AI 性格的牌（`defaultPolicy` 是 null，也就是鬼牌）沒有勝負，不屬於任何情境，所以沒有台詞（null）。
 */
export function resultTaunt(
  personality: TauntPersonality | null,
  winner: Side | null,
  lossStreak: number,
  seed: number,
): string | null {
  if (personality === null) {
    return null;
  }
  return pickTaunt(personality, situationOf(winner, lossStreak), seed);
}

export interface ResultData {
  readonly headline: string;
  readonly headlineColor: string;
  readonly scores: readonly [number, number];
  /** 沒有勝負的牌（鬼牌）不顯示雙方分數。 */
  readonly showScores: boolean;
  readonly seed: number;
  /** AI 的台詞；沒有 AI 性格的牌（鬼牌）是 null，結算頁就不畫台詞區。 */
  readonly taunt: string | null;
  readonly personality: string;
  readonly notes: readonly string[];
  /** 選單的文字，3 項或 4 項（JK-R 多一個「存成圖片」）。 */
  readonly menu: readonly string[];
  readonly cursor: number;
}

const RESULT_MENU_TOPS: Readonly<Record<number, readonly number[]>> = {
  3: [174, 190, 206],
  4: [170, 184, 198, 212],
};

/** 結算頁選單每一項的上緣 y。項數只支援 3 或 4。 */
export function resultMenuTops(count: number): readonly number[] {
  return RESULT_MENU_TOPS[count] ?? (RESULT_MENU_TOPS[3] as readonly number[]);
}

/** 點擊的 y（邏輯座標）落在哪一項；都不是回傳 -1。每一項的範圍從上緣上方 3 像素起、高度等於項距。 */
export function resultMenuHit(count: number, y: number): number {
  const tops = resultMenuTops(count);
  const spacing = (tops[1] as number) - (tops[0] as number);
  return tops.findIndex((top) => y >= top - 3 && y < top - 3 + spacing);
}

export function drawResult(ctx: CanvasRenderingContext2D, data: ResultData): void {
  clear(ctx);
  drawText(ctx, data.headline, CENTER, 12, {
    size: 20,
    bold: true,
    color: data.headlineColor,
    align: 'center',
  });

  if (data.showScores) {
    drawText(ctx, strings.result.scoreYou, 80, 44, {
      size: 12,
      color: COLOR.light,
      align: 'center',
    });
    drawText(ctx, String(data.scores[0]), 80, 58, { size: 26, bold: true, align: 'center' });
    drawText(ctx, strings.result.scoreAi, 240, 44, {
      size: 12,
      color: COLOR.accent,
      align: 'center',
    });
    drawText(ctx, String(data.scores[1]), 240, 58, {
      size: 26,
      bold: true,
      color: COLOR.accent,
      align: 'center',
    });
  }
  drawText(ctx, strings.result.seed(data.seed), CENTER, 92, {
    size: 10,
    color: COLOR.mid,
    align: 'center',
  });
  if (data.notes.length > 0) {
    drawText(ctx, data.notes.join('\u3000'), CENTER, 104, {
      size: 11,
      color: COLOR.diamonds,
      align: 'center',
    });
  }

  // AI 的台詞（沒有 AI 性格的牌沒有）。
  if (data.taunt !== null) {
    ctx.fillStyle = COLOR.accent;
    ctx.fillRect(12, 120, 296, 1);
    drawText(ctx, data.personality, 14, 124, { size: 10, color: COLOR.accent });
    wrapText(ctx, data.taunt, 290, 12)
      .slice(0, 2)
      .forEach((line, index) => {
        drawText(ctx, line, 14, 138 + index * 15, { size: 12 });
      });
    ctx.fillStyle = COLOR.accent;
    ctx.fillRect(12, 168, 296, 1);
  }

  const tops = resultMenuTops(data.menu.length);
  data.menu.forEach((label, index) => {
    const y = tops[index] ?? 174;
    const active = index === data.cursor;
    drawText(ctx, label, CENTER, y, {
      size: 13,
      align: 'center',
      color: active ? COLOR.fg : COLOR.mid,
    });
    if (active) {
      drawMarker(ctx, 112, y + 3);
    }
  });
  drawText(ctx, strings.result.hint, CENTER, data.menu.length > 3 ? 228 : 226, {
    size: 10,
    color: COLOR.mid,
    align: 'center',
  });
}

export interface EvolutionData {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly total: number;
  readonly played: number;
  readonly rate: number;
  readonly done: boolean;
  readonly canContinue: boolean;
}

export function drawEvolution(ctx: CanvasRenderingContext2D, data: EvolutionData): void {
  clear(ctx);
  drawText(ctx, strings.evolution.heading, CENTER, 16, {
    size: 22,
    bold: true,
    color: COLOR.accent,
    align: 'center',
  });
  drawText(ctx, strings.evolution.subtitle(data.name, data.from, data.to), CENTER, 50, {
    size: 13,
    align: 'center',
  });
  drawText(ctx, strings.evolution.explain(data.total), CENTER, 70, {
    size: 11,
    color: COLOR.light,
    align: 'center',
  });

  // 進度：20 場，每場一格，打完一場亮一格。
  const segment = 12;
  const left = CENTER - (data.total * segment) / 2;
  for (let i = 0; i < data.total; i += 1) {
    ctx.fillStyle = i < data.played ? COLOR.accent : COLOR.dark;
    ctx.fillRect(left + i * segment, 94, segment - 2, 10);
  }
  drawText(ctx, strings.evolution.played(data.played, data.total), CENTER, 110, {
    size: 11,
    color: COLOR.light,
    align: 'center',
  });

  const percent = Math.round(data.rate * 100);
  drawText(ctx, strings.evolution.winRate(percent), CENTER, 134, {
    size: 24,
    bold: true,
    align: 'center',
  });

  // 勝率條：中間的刻度是 50%。
  const barLeft = 40;
  const barWidth = 240;
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(barLeft, 172, barWidth, 12);
  ctx.fillStyle = data.rate >= 0.5 ? COLOR.clubs : COLOR.hearts;
  ctx.fillRect(barLeft, 172, Math.round(barWidth * data.rate), 12);
  ctx.fillStyle = COLOR.fg;
  ctx.fillRect(barLeft + barWidth / 2 - 1, 168, 2, 20);

  drawText(
    ctx,
    data.canContinue ? strings.evolution.hint : strings.evolution.running,
    CENTER,
    214,
    { size: 11, color: COLOR.mid, align: 'center' },
  );
}

/** 對局畫面上的置中橫幅（準備、暫停、重播）。 */
export function drawBanner(ctx: CanvasRenderingContext2D, title: string, subtitle?: string): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(40, 20, 240, subtitle === undefined ? 40 : 58);
  ctx.strokeStyle = COLOR.accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(40.5, 20.5, 239, subtitle === undefined ? 39 : 57);
  drawText(ctx, title, CENTER, 30, { size: 20, bold: true, align: 'center' });
  if (subtitle !== undefined) {
    drawText(ctx, subtitle, CENTER, 60, { size: 11, color: COLOR.light, align: 'center' });
  }
}

/** 掃描線：每隔一列蓋一層半透明的背景色。 */
export function drawScanlines(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = COLOR.bg;
  for (let y = 1; y < LOGICAL_HEIGHT; y += 2) {
    ctx.fillRect(0, y, LOGICAL_WIDTH, 1);
  }
  ctx.restore();
}
