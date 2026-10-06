import { afterEnd } from './after-end';
import { asymmetric } from './asymmetric';
import { badDanger } from './bad-danger';
import { emptyActions } from './empty-actions';
import { endless } from './endless';
import { functionInState } from './function-in-state';
import { impure } from './impure';
import type { BadGame } from './make';
import { mutating } from './mutating';
import { mutatingInputs } from './mutating-inputs';
import { nan } from './nan';
import { renderBounds } from './render-bounds';
import { renderColor } from './render-color';
import { renderForgotColor } from './render-forgot-color';
import { renderMutates } from './render-mutates';
import { renderTransform } from './render-transform';
import { seedIgnored } from './seed-ignored';
import { slow } from './slow';
import { wrongWinner } from './wrong-winner';

/** 故意違約的假遊戲。每個只違反一條，bad-games.test.ts 證明契約檢查抓得到它們。 */
export const BAD_GAMES: readonly BadGame[] = [
  impure,
  mutating,
  mutatingInputs,
  endless,
  nan,
  functionInState,
  afterEnd,
  wrongWinner,
  emptyActions,
  badDanger,
  slow,
  asymmetric,
  seedIgnored,
  renderColor,
  renderForgotColor,
  renderBounds,
  renderTransform,
  renderMutates,
];
