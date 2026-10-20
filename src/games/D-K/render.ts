import { COLOR } from '../../shell/palette';
import { strings } from '../../shell/strings';
import { drawArena, drawDisc, drawScores } from '../_diamonds/draw';
import { CELL_SIZE, CELLS, cellX, cellY, START_CELLS } from '../_diamonds/logic';
import { BAG_LIMIT } from '../D-2/logic';
import { gemValue, LIFETIME } from '../D-3/logic';
import { PROTECT_TICKS } from '../D-8/logic';
import { STEAL_TICKS } from '../D-J/logic';
import {
  INTRO_TICKS,
  STAGE1_END,
  STAGE1_START,
  STAGE2_END,
  STAGE2_START,
  STAGE3_START,
  stageOf,
} from './logic';
import type { DKState } from './logic';

/** 價值越高越大、越亮（同 D-3）。 */
function gemLook(value: number): { radius: number; color: string } {
  if (value >= 7) {
    return { radius: 4.5, color: COLOR.diamonds };
  }
  if (value >= 4) {
    return { radius: 3.5, color: COLOR.warning };
  }
  return { radius: 2.5, color: COLOR.diamondsDark };
}

/** 現在這一段（或過場接下來那一段）的名稱與離這一段結束（或開始）還有幾秒。 */
function banner(state: DKState): string {
  const names = strings.diamondsMarathon.stages;
  const stage = stageOf(state.tick);
  const t = state.tick;
  let name: string;
  let end: number;
  if (stage === 1) {
    name = names[1] as string;
    end = STAGE1_END;
  } else if (stage === 2) {
    name = names[2] as string;
    end = STAGE2_END;
  } else if (stage === 3) {
    name = names[3] as string;
    end = state.maxTicks;
  } else {
    const next = t < STAGE1_START ? 1 : t < STAGE2_START ? 2 : 3;
    name = strings.diamondsMarathon.upNext(names[next] as string);
    end = next === 1 ? STAGE1_START : next === 2 ? STAGE2_START : STAGE3_START;
  }
  const seconds = Math.max(0, Math.ceil((end - t) / 60));
  return `${name} ${strings.diamondsMarathon.clock(seconds)}`;
}

/**
 * D-K 的畫面：D-8 的顏色格子（三段都留著，因為連結 1、2 要看），第 2 段的寶石，第 3 段的金幣、基地方框、背包與偷竊倒數；
 * 上方中間是段落名稱與倒數（過場時是「接下來：下一段」）。全部是公開資訊。
 */
export function dKRender(ctx: CanvasRenderingContext2D, state: DKState): void {
  drawArena(ctx, state);
  const standing = new Set<number>([state.players[0].cell, state.players[1].cell]);
  for (let i = 0; i < CELLS; i += 1) {
    const p = state.paint[i];
    if (p === 0 || p === undefined || standing.has(i)) {
      continue;
    }
    const fresh = state.tick - (state.stamp[i] as number) < PROTECT_TICKS;
    ctx.fillStyle =
      p === 1 ? (fresh ? COLOR.clubs : COLOR.clubsDark) : fresh ? COLOR.accent : COLOR.spadesDark;
    ctx.fillRect(cellX(i) * CELL_SIZE + 1, cellY(i) * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2);
  }
  for (const gem of state.gems) {
    if (state.tick - gem.born >= LIFETIME - 60 && Math.floor(state.tick / 10) % 2 === 1) {
      continue;
    }
    const { radius, color } = gemLook(gemValue(state.tick, gem.born));
    const cx = cellX(gem.cell) * CELL_SIZE + CELL_SIZE / 2;
    const cy = cellY(gem.cell) * CELL_SIZE + CELL_SIZE / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx + radius, cy);
    ctx.lineTo(cx, cy + radius);
    ctx.lineTo(cx - radius, cy);
    ctx.closePath();
    ctx.fill();
  }
  for (const coin of state.coins) {
    drawDisc(ctx, coin, 4, COLOR.diamonds);
  }
  if (stageOf(state.tick) === 3 || state.tick >= STAGE3_START - INTRO_TICKS) {
    const colors = [COLOR.clubs, COLOR.accent] as const;
    START_CELLS.forEach((base, side) => {
      ctx.strokeStyle = colors[side as 0 | 1];
      ctx.lineWidth = 1;
      ctx.strokeRect(
        cellX(base) * CELL_SIZE + 0.5,
        cellY(base) * CELL_SIZE + 0.5,
        CELL_SIZE - 1,
        CELL_SIZE - 1,
      );
    });
  }
  for (const thief of [0, 1] as const) {
    const lurk = state.lurk[thief];
    if (lurk > 0) {
      const victimBase = START_CELLS[thief === 0 ? 1 : 0];
      const width = Math.round((lurk / STEAL_TICKS) * 3 * CELL_SIZE);
      const x = Math.max(0, Math.min(320 - 3 * CELL_SIZE, (cellX(victimBase) - 1) * CELL_SIZE));
      const y = Math.max(
        0,
        Math.min(
          240 - 3,
          (cellY(victimBase) + (cellY(victimBase) < 12 ? 1 : -1)) * CELL_SIZE + CELL_SIZE / 2,
        ),
      );
      ctx.fillStyle = COLOR.warning;
      ctx.fillRect(x, y, width, 3);
    }
  }
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillStyle = COLOR.fg;
  ctx.fillText(banner(state), 160, 4);
  const label = (bag: number): string => (bag > 0 ? ` +${bag}${bag >= BAG_LIMIT ? '!' : ''}` : '');
  drawScores(ctx, state, [label(state.bags[0]), label(state.bags[1])]);
}
