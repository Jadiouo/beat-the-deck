import type { CardMeta } from '../types';

/** S-7 拔槍的 meta（SPEC 第 9 節，方向依 DESIGN-AI-FUN 7.3 改過；小規格 `docs/cards/S-7.md`）。 */
export const s7Meta: CardMeta = {
  id: 'S-7',
  name: '拔槍',
  description:
    '中間的光亮起來而且一直亮著才是真訊號，先按的贏；訊號前亂按、或按了一閃即逝的假光就輸。每人有假動作，九戰五勝。',
  controls:
    'a（Z 或空白鍵）拔槍；b（X）假動作：中間會亮一道假光，0.5 秒就熄。真光亮了就不會熄：要等它亮滿 0.5 秒才確定，但等的人會慢。下方是最近幾輪雙方各假動作幾次（上面是你、下面是對手），打叉的是被騙的那一邊。',
  suit: 'S',
  rank: '7',
  defaultPolicy: 'greedy',
  baseLevel: 3,
  symmetric: true,
};
