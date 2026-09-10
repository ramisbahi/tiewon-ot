import { modelSummary, predictRegulationTie } from './model';
import { OT_MODEL_VERSION, predictFinalTie } from './ot-model';
import type { BotGame } from './live-types';

export const LIVE_MODEL_VERSION = `${modelSummary.version}+${OT_MODEL_VERSION}`;
export interface Probabilities { overtime: number | null; finalTie: number | null }
const kickoffRates = new Map<string, number>();
export function liveProbabilities(game: BotGame, runs = 10000): Probabilities {
  if (!game.isLive && game.source !== 'demo') return { overtime: game.quarter > 4 ? 1 : 0, finalTie: game.homeScore === game.awayScore && game.seasonType !== 'postseason' ? 1 : 0 };
  if (game.quarter > 4) return { overtime: 1, finalTie: predictFinalTie(game, runs) };
  if (game.fieldStateReliable === false || game.quarter === 4 && game.clockSeconds <= 0 && game.phase !== 'pending_try') return { overtime: null, finalTie: game.seasonType === 'postseason' ? 0 : null };
  const overtime = predictRegulationTie(game);
  if (game.seasonType === 'postseason') return { overtime, finalTie: 0 };
  const key = `${game.overtimeRules}:${runs}`;
  if (!kickoffRates.has(key)) {
    const start: BotGame = { ...game, id: 'ot-start-baseline', homeScore: 0, awayScore: 0, quarter: 5, clockSeconds: 600,
      possession: 'home', down: 1, distance: 10, yardlineOwn: 30, timeoutsHome: 2, timeoutsAway: 2,
      isLive: true, source: 'live', phase: 'scrimmage', fieldStateReliable: true,
      overtime: { completed: { home: 0, away: 0 }, firstPossession: 'home', source: 'espn-drives' } };
    kickoffRates.set(key, predictFinalTie(start, runs)!);
  }
  // P(final tie) = P(reach OT) * P(final tie | a fresh OT). Team-neutral approximation.
  return { overtime, finalTie: overtime * kickoffRates.get(key)! };
}
