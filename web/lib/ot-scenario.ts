import type { GameState } from './types';
import type { BotGame } from './live-types';
import { predictFinalTie } from './ot-model';
export type OTStage = 'opening' | 'response' | 'sudden_death';
export function overtimeScenario(state: GameState, stage: OTStage): { game: BotGame; error?: string; finalTie: number | null } {
  const offense = state.possession, defense = offense === 'home' ? 'away' : 'home';
  const completed = { home: stage === 'sudden_death' ? 1 : 0, away: stage === 'sudden_death' ? 1 : 0 };
  if (stage === 'response') completed[defense] = 1;
  const game: BotGame = { ...state, quarter: 5, isLive: true, source: 'demo', fieldStateReliable: true,
    overtime: { completed, firstPossession: stage === 'response' ? defense : offense, source: 'scenario' } };
  const deficit = offense === 'home' ? state.awayScore - state.homeScore : state.homeScore - state.awayScore;
  let error: string | undefined;
  if (state.phase !== 'scrimmage') error = 'Choose a normal snap after the conversion is complete.';
  else if (![state.homeScore, state.awayScore].every(n => Number.isInteger(n) && n >= 0 && n <= 200)) error = 'Enter valid scores.';
  else if (state.clockSeconds <= 0 || state.clockSeconds > (state.overtimeRules === 'postseason' ? 900 : 600)) error = 'Choose a time with a play still to begin in overtime.';
  else if (stage !== 'response' && deficit !== 0) error = 'Opening possession and sudden death require tied scores. Choose the response stage for a team trailing.';
  else if (stage === 'response' && ![0, 3, 6, 7, 8].includes(deficit)) error = 'The responding team with the ball must be tied or trailing by 3, 6, 7 or 8.';
  else if (stage === 'response' && state.overtimeRules === 'legacy_regular' && deficit >= 6) error = 'Under the old rules, an opening touchdown already ended the game.';
  return { game, error, finalTie: error ? null : predictFinalTie(game) };
}
