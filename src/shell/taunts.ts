import type { Side } from '../core/types';

export type Situation = 'aiWins' | 'aiLoses' | 'draw' | 'streak';
export type TauntPersonality = 'pathfinder' | 'precise' | 'greedy' | 'gambler';

export const SITUATIONS: readonly Situation[] = ['aiWins', 'aiLoses', 'draw', 'streak'];
export const PERSONALITIES: readonly TauntPersonality[] = [
  'pathfinder',
  'precise',
  'greedy',
  'gambler',
];

export const TAUNTS: Readonly<
  Record<TauntPersonality, Readonly<Record<Situation, readonly string[]>>>
> = {
  pathfinder: { aiWins: [], aiLoses: [], draw: [], streak: [] },
  precise: { aiWins: [], aiLoses: [], draw: [], streak: [] },
  greedy: { aiWins: [], aiLoses: [], draw: [], streak: [] },
  gambler: { aiWins: [], aiLoses: [], draw: [], streak: [] },
};

export function situationOf(_winner: Side | null, _lossStreak: number): Situation {
  throw new Error('not implemented');
}

export function pickTaunt(
  _personality: TauntPersonality,
  _situation: Situation,
  _seed: number,
): string {
  throw new Error('not implemented');
}
