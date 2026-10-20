import type { RegistryEntry } from '../games/types';
import type { Outcome } from './progress';

/** 結算頁標題的種類，對應 `strings.result` 的四個鍵。 */
export type HeadlineKind = 'jokerDone' | 'youWin' | 'aiWins' | 'draw';

/** 一場對局的結果（從人這一邊看）。鬼牌沒有勝負，玩完就算贏（SPEC 第 11 節：玩過一次就算翻開）。 */
export function outcomeOf(entry: RegistryEntry, state: unknown): Outcome {
  if (entry.meta.noWinner === true) {
    return 'win';
  }
  const winner = entry.game.winner(state);
  return winner === 0 ? 'win' : winner === 1 ? 'loss' : 'draw';
}

/** 結算頁標題是哪一種。 */
export function headlineKind(entry: RegistryEntry, outcome: Outcome): HeadlineKind {
  if (entry.meta.noWinner === true) {
    return 'jokerDone';
  }
  return outcome === 'win' ? 'youWin' : outcome === 'loss' ? 'aiWins' : 'draw';
}

/** 結算頁要不要顯示分數。 */
export function showScoresOf(entry: RegistryEntry): boolean {
  return entry.meta.noWinner !== true;
}
