import { COLOR } from '../../shell/palette';
import { strings } from '../../shell/strings';
import { s3Meta } from '../S-3/meta';
import { s3Render } from '../S-3/render';
import { s4Meta } from '../S-4/meta';
import { s4Render } from '../S-4/render';
import { s5Meta } from '../S-5/meta';
import { s5Render } from '../S-5/render';
import { s7Meta } from '../S-7/meta';
import { s7Render } from '../S-7/render';
import { s8Meta } from '../S-8/meta';
import { s8Render } from '../S-8/render';
import { s9Meta } from '../S-9/meta';
import { s9Render } from '../S-9/render';
import { sJMeta } from '../S-J/meta';
import { sJRender } from '../S-J/render';
import { sQMeta } from '../S-Q/meta';
import { sQRender } from '../S-Q/render';
import { SEGMENTS, FINAL_WEIGHT } from './logic';
import type { SKState } from './logic';
import { poolEntry, sigmaLabel } from './pool';

/**
 * S-K 黑桃馬拉松的畫面。挑牌與公開階段是自己的畫面（四張候選牌排成十字，對應 ↑↓←→）；
 * 遊戲階段直接用被包的那張牌的 render，只在最上面疊一條段數列。完整資訊，不畫 AI 的任何推論。
 * 只讀 state，只用色盤裡的顏色。
 */

type InnerRender = (ctx: CanvasRenderingContext2D, inner: never) => void;

const RENDERS: Readonly<Record<string, { name: string; render: InnerRender }>> = {
  'S-3': { name: s3Meta.name, render: s3Render as InnerRender },
  'S-Q': { name: sQMeta.name, render: sQRender as InnerRender },
  'S-7': { name: s7Meta.name, render: s7Render as InnerRender },
  'S-J': { name: sJMeta.name, render: sJRender as InnerRender },
  'S-4': { name: s4Meta.name, render: s4Render as InnerRender },
  'S-8': { name: s8Meta.name, render: s8Render as InnerRender },
  'S-9': { name: s9Meta.name, render: s9Render as InnerRender },
  'S-5': { name: s5Meta.name, render: s5Render as InnerRender },
};

const HUMAN = COLOR.spades;
const AI = COLOR.accent;

function text(
  ctx: CanvasRenderingContext2D,
  value: string | number,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'left',
): void {
  ctx.font = `${size}px monospace`;
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(String(value), x, y);
}

function nameOf(id: string): string {
  return RENDERS[id]?.name ?? id;
}

function sigmaColor(label: ReturnType<typeof sigmaLabel>): string {
  return label === 'stable' ? COLOR.clubs : label === 'mid' ? COLOR.diamonds : COLOR.hearts;
}

/** 最上面一列：五個小方塊（贏的邊的顏色、決勝較寬）、目前這一段的名稱。 */
function drawStrip(ctx: CanvasRenderingContext2D, state: SKState): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 11);
  for (let i = 0; i < SEGMENTS; i += 1) {
    const entry = state.ledger[i];
    const x = 6 + i * 14 + (i === SEGMENTS - 1 ? 2 : 0);
    ctx.fillStyle =
      entry === undefined
        ? i === state.seg
          ? COLOR.light
          : COLOR.dark
        : entry.mm > 0
          ? HUMAN
          : entry.mm < 0
            ? AI
            : COLOR.mid;
    ctx.fillRect(x, 2, i === SEGMENTS - 1 ? 12 : 10, 7);
  }
  if (state.cardId !== null) {
    text(ctx, `${state.cardId} ${nameOf(state.cardId)}`, 314, 1, 8, COLOR.light, 'right');
  }
}

function drawPick(ctx: CanvasRenderingContext2D, state: SKState): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  drawStrip(ctx, state);
  const t = strings.spadesMarathon;
  const youPick = state.picker === 0;
  text(ctx, t.segment(state.seg + 1, SEGMENTS), 160, 18, 10, COLOR.light, 'center');
  text(ctx, youPick ? t.youPick : t.aiPick, 160, 32, 12, youPick ? HUMAN : AI, 'center');
  if (!youPick && state.picker !== null) {
    // 前兩次沒有資料，是性格；ledger 有兩段以上才是看你的成績。
    text(
      ctx,
      state.ledger.length >= 2 ? t.targetTag : t.styleTag,
      160,
      48,
      8,
      COLOR.warning,
      'center',
    );
  }
  // 十字：↑ 上、↓ 下、← 左、→ 右
  const slots: readonly (readonly [number, number])[] = [
    [160, 78],
    [160, 170],
    [64, 124],
    [256, 124],
  ];
  state.offer.forEach((id, i) => {
    const [cx, cy] = slots[i] as readonly [number, number];
    const label = sigmaLabel(poolEntry(id).sigma);
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(cx - 44, cy - 16, 88, 34);
    ctx.fillStyle = sigmaColor(label);
    ctx.fillRect(cx - 44, cy - 16, 4, 34);
    text(ctx, t.keys[i] as string, cx - 36, cy - 12, 10, COLOR.light);
    text(ctx, id, cx + 38, cy - 12, 8, COLOR.mid, 'right');
    text(ctx, nameOf(id), cx, cy + 2, 10, COLOR.fg, 'center');
    text(ctx, t.sigma[label], cx + 38, cy + 6, 10, sigmaColor(label), 'right');
  });
  const pickBar = 1 - state.phaseTick / 120;
  ctx.fillStyle = COLOR.dark;
  ctx.fillRect(80, 222, 160, 4);
  ctx.fillStyle = COLOR.warning;
  ctx.fillRect(80, 222, Math.max(0, Math.round(160 * pickBar)), 4);
  text(ctx, t.wrapperNote, 160, 230, 8, COLOR.mid, 'center');
}

function drawShow(ctx: CanvasRenderingContext2D, state: SKState): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  drawStrip(ctx, state);
  const t = strings.spadesMarathon;
  const id = state.cardId as string;
  const label = sigmaLabel(poolEntry(id).sigma);
  text(ctx, t.segment(state.seg + 1, SEGMENTS), 160, 60, 10, COLOR.light, 'center');
  if (state.seg === SEGMENTS - 1) {
    text(ctx, t.finalName, 160, 78, 14, COLOR.warning, 'center');
    text(ctx, `${t.finalDouble} ×${FINAL_WEIGHT}`, 160, 98, 10, COLOR.warning, 'center');
  } else if (state.picker !== null) {
    text(
      ctx,
      state.picker === 0 ? t.you : t.ai,
      160,
      80,
      12,
      state.picker === 0 ? HUMAN : AI,
      'center',
    );
  }
  text(ctx, nameOf(id), 160, 124, 16, COLOR.fg, 'center');
  text(ctx, t.sigma[label], 160, 150, 14, sigmaColor(label), 'center');
}

function drawOver(ctx: CanvasRenderingContext2D, state: SKState): void {
  const t = strings.spadesMarathon;
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, 320, 240);
  drawStrip(ctx, state);
  text(ctx, t.total, 160, 40, 12, COLOR.light, 'center');
  let a = 0;
  let b = 0;
  for (const entry of state.ledger) {
    a += (entry.weight * (1000 + entry.mm)) / 20;
    b += (entry.weight * (1000 - entry.mm)) / 20;
  }
  text(ctx, `${t.you} ${Math.round(a)}`, 100, 70, 14, HUMAN, 'center');
  text(ctx, `${t.ai} ${Math.round(b)}`, 220, 70, 14, AI, 'center');
  state.ledger.forEach((entry, i) => {
    const y = 100 + i * 16;
    text(ctx, nameOf(entry.cardId), 40, y, 8, COLOR.light);
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(140, y + 1, 140, 6);
    ctx.fillStyle = entry.mm >= 0 ? HUMAN : AI;
    const half = Math.round((Math.abs(entry.mm) / 1000) * 70);
    ctx.fillRect(entry.mm >= 0 ? 210 : 210 - half, y + 1, half, 6);
  });
}

export function skRender(ctx: CanvasRenderingContext2D, state: SKState): void {
  if (state.phase === 'pick') {
    drawPick(ctx, state);
    return;
  }
  if (state.phase === 'show') {
    drawShow(ctx, state);
    return;
  }
  if (state.inner !== null && state.cardId !== null && state.phase !== 'over') {
    (RENDERS[state.cardId] as { render: InnerRender }).render(ctx, state.inner as never);
    drawStrip(ctx, state);
    if (state.phase === 'rest') {
      const entry = state.ledger[state.ledger.length - 1];
      const t = strings.spadesMarathon;
      if (entry !== undefined) {
        const label = entry.mm > 0 ? t.youWin : entry.mm < 0 ? t.aiWin : t.drawSegment;
        ctx.fillStyle = COLOR.bg;
        ctx.fillRect(80, 100, 160, 30);
        text(
          ctx,
          label,
          160,
          108,
          12,
          entry.mm > 0 ? HUMAN : entry.mm < 0 ? AI : COLOR.light,
          'center',
        );
      }
    }
    return;
  }
  drawOver(ctx, state);
}
