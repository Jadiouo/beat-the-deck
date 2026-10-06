import { COLOR } from '../../shell/palette';
import { drawArena, drawScores } from '../_diamonds/draw';
import { CELL_SIZE, cellX, cellY } from '../_diamonds/logic';
import { gemValue, LIFETIME } from './logic';
import type { D3State } from './logic';

/** 價值越高越大、越亮：9 到 7 最大（亮黃），6 到 4 中等（橘），3 到 1 小（暗黃）。 */
function gemLook(value: number): { radius: number; color: string } {
  if (value >= 7) {
    return { radius: 4.5, color: COLOR.diamonds };
  }
  if (value >= 4) {
    return { radius: 3.5, color: COLOR.warning };
  }
  return { radius: 2.5, color: COLOR.diamondsDark };
}

/** D-3 的畫面：整張地圖對兩邊都是完整資訊；寶石畫成菱形，大小與顏色看得出價值。 */
export function d3Render(ctx: CanvasRenderingContext2D, state: D3State): void {
  drawArena(ctx, state);
  for (const gem of state.gems) {
    const age = state.tick - gem.born;
    // 最後 60 tick 快消失了：每 10 個 tick 閃一次。
    if (age >= LIFETIME - 60 && Math.floor(state.tick / 10) % 2 === 1) {
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
  drawScores(ctx, state);
}
